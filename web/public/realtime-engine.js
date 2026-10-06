/**
 * Stella realtime engine — the single WebSocket state machine.
 *
 * Deliberately framework-free and dependency-free so the *same* implementation
 * runs in two very different hosts:
 *   1. inside a SharedWorker  (the normal path — one connection per browser)
 *   2. inside a tab           (the degradation path — no SharedWorker support)
 *
 * Responsibilities:
 *   - WebSocket handshake with a bearer token (never connects without a token)
 *   - application level heartbeat with a liveness watchdog
 *   - reconnect with exponential backoff + random jitter
 *   - automatic degradation to HTTP incremental polling
 *   - background recovery back to WebSocket, with gap backfill
 *   - monotonic sync cursor tracking
 *
 * Exposes `globalThis.StellaRealtime`.
 */
(function (global) {
  'use strict';

  const STATE = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    OPEN: 'open',
    RECONNECTING: 'reconnecting',
    POLLING: 'polling',
    CLOSED: 'closed',
  };

  const MODE = { NONE: 'none', WS: 'ws', POLL: 'poll' };

  const DEFAULTS = {
    // reconnect
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitter: 0.5,
    maxReconnectAttempts: 8,
    // heartbeat
    heartbeatIntervalMs: 25000,
    heartbeatTimeoutMs: 12000,
    heartbeatCheckMs: 5000,
    // polling fallback
    pollBaseIntervalMs: 3000,
    pollMaxIntervalMs: 15000,
    pollBackoffFactor: 1.6,
    pollLimit: 100,
    // background WebSocket recovery while degraded
    wsRecoveryIntervalMs: 30000,
  };

  /**
   * Exponential backoff with random jitter, capped.
   * `attempt` is 0-based: 1s, 2s, 4s, 8s ... capped, each ±jitter.
   */
  function computeBackoff(attempt, base, cap, jitter) {
    const raw = Math.min(cap, base * Math.pow(2, attempt));
    const lower = raw * (1 - jitter);
    return Math.round(lower + Math.random() * (raw - lower));
  }

  function createRealtimeEngine(userOptions) {
    const options = Object.assign({}, DEFAULTS, userOptions || {});
    const emit = typeof options.emit === 'function' ? options.emit : function () {};
    const getToken = typeof options.getToken === 'function' ? options.getToken : function () { return null; };
    const log = typeof options.log === 'function' ? options.log : function () {};
    const fetchImpl = options.fetch || (typeof global.fetch === 'function' ? global.fetch.bind(global) : null);
    const WebSocketImpl = options.WebSocket || global.WebSocket;
    const now = Date.now;

    let wsUrl = null;
    let pollUrl = null;

    let socket = null;
    let state = STATE.IDLE;
    let mode = MODE.NONE;
    let attempt = 0;
    let lastError = null;
    let running = false;
    let graceful = false;
    let everConnected = false;
    let pollingActive = false;
    /**
     * Transport strategy. `'auto'` prefers WebSocket and degrades to polling on
     * failure; `'poll'` disables WebSocket entirely (forced HTTP polling) — the
     * user-facing "连接策略" switch.
     */
    let transportMode = options.transportMode === 'poll' ? 'poll' : 'auto';
    /**
     * True between "we decided to open a socket" and "it opened / it closed".
     * Without this the engine could start a *second* socket while the first was
     * still CONNECTING (e.g. React StrictMode double-mount, or a fast
     * reconnect-now after a fresh token), leaking duplicate connections for the
     * same browser — the exact thing a global singleton must prevent.
     */
    let connecting = false;

    let reconnectTimer = null;
    let heartbeatTimer = null;
    let pollTimer = null;
    let recoveryTimer = null;

    let lastPingAt = 0;
    let pendingPingAt = 0;
    let pollIntervalMs = options.pollBaseIntervalMs;

    const cursor = { messageId: 0, noticeId: 0 };

    // -------------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------------
    const supportsWebSocket = () => typeof WebSocketImpl === 'function';

    function setState(next, extra) {
      state = next;
      emit(
        Object.assign(
          { type: 'state', state, mode, attempt, lastError, cursor: { ...cursor } },
          extra || {}
        )
      );
    }

    function bumpCursor(key, value) {
      const v = Number(value) || 0;
      if (v > cursor[key]) cursor[key] = v;
    }

    /** Keeps the cursor monotonic — it must never move backwards. */
    function setCursor(partial) {
      if (!partial) return;
      if (partial.messageId) bumpCursor('messageId', partial.messageId);
      if (partial.noticeId) bumpCursor('noticeId', partial.noticeId);
    }

    function absorbFrameCursor(frame) {
      if (!frame || typeof frame.type !== 'string') return;
      if (frame.type === 'chat:message' && frame.message) bumpCursor('messageId', frame.message.id);
      else if (frame.type === 'notice:system' && frame.notice) bumpCursor('noticeId', frame.notice.id);
    }

    const isOpen = () => !!socket && socket.readyState === 1;

    /** True when a link already exists or is being established. */
    function linkBusy() {
      if (connecting) return true;
      if (!socket) return false;
      // 0 = CONNECTING, 1 = OPEN. CLOSING/CLOSED may be superseded.
      return socket.readyState === 0 || socket.readyState === 1;
    }

    function clearTimer(name) {
      if (name === 'reconnect' && reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (name === 'poll' && pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (name === 'heartbeat' && heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (name === 'recovery' && recoveryTimer) {
        clearInterval(recoveryTimer);
        recoveryTimer = null;
      }
    }

    function clearAllTimers() {
      clearTimer('reconnect');
      clearTimer('poll');
      clearTimer('heartbeat');
      clearTimer('recovery');
    }

    // -------------------------------------------------------------------------
    // WebSocket lifecycle
    // -------------------------------------------------------------------------
    function connect() {
      if (!running || graceful) return Promise.resolve();
      // Forced polling: never open a socket.
      if (transportMode === 'poll') {
        startPolling('forced-poll');
        return Promise.resolve();
      }
      if (!supportsWebSocket()) {
        startPolling('websocket-unsupported');
        return Promise.resolve();
      }
      // Single-connection invariant: never race an existing/opening link.
      if (linkBusy()) {
        log('connect() ignored: a link is already open or being established');
        return Promise.resolve();
      }

      // Reserve the slot synchronously, before the async token lookup.
      connecting = true;

      return Promise.resolve()
        .then(getToken)
        .then((token) => {
          if (!running || graceful) {
            connecting = false;
            return;
          }
          if (!token) {
            connecting = false;
            mode = MODE.NONE;
            setState(STATE.IDLE, { reason: 'no-token' });
            emit({ type: 'need-token', reason: 'no-token' });
            return;
          }
          clearTimer('reconnect');
          setState(attempt === 0 ? STATE.CONNECTING : STATE.RECONNECTING, { nextRetryMs: 0 });
          const url =
            wsUrl + (wsUrl.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
          let next;
          try {
            next = new WebSocketImpl(url);
          } catch (err) {
            connecting = false;
            lastError = 'socket-create-failed';
            scheduleReconnect();
            return;
          }
          bindSocket(next);
        })
        .catch((err) => {
          connecting = false;
          lastError = String((err && err.message) || err);
          scheduleReconnect();
        });
    }

    function bindSocket(next) {
      socket = next;

      next.onopen = () => {
        if (socket !== next) return;
        connecting = false;
        const recovering = everConnected;
        attempt = 0;
        lastError = null;
        mode = MODE.WS;
        everConnected = true;
        stopPolling();
        stopRecovery();
        startHeartbeat();
        setState(STATE.OPEN, { connectedAt: now(), recovered: recovering });
        log('websocket open' + (recovering ? ' (recovered)' : ''));

        // Gap backfill: whatever happened while we were degraded/offline.
        if (recovering && (cursor.messageId > 0 || cursor.noticeId > 0)) {
          pollOnce({ kind: 'resume' });
        }
      };

      next.onmessage = (event) => {
        if (socket !== next) return;
        handleMessage(event.data);
      };

      next.onclose = (event) => {
        if (socket !== next) return;
        socket = null;
        connecting = false;
        handleClose(event);
      };

      next.onerror = () => {
        lastError = 'socket-error';
      };
    }

    function handleMessage(raw) {
      let frame;
      try {
        frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;

      // A pong closes the RTT sample opened when we sent the ping.
      if (frame.type === 'pong' && pendingPingAt) {
        emit({ type: 'latency', rttMs: Math.max(0, now() - pendingPingAt) });
      }

      // Any inbound traffic proves the link is alive.
      pendingPingAt = 0;

      if (frame.type === 'pong') return;

      if (frame.type === 'session:invalid') {
        emit({ type: 'session-invalid', reason: frame.reason || 'session invalid' });
        return;
      }

      absorbFrameCursor(frame);
      emit({ type: 'frame', frame });
    }

    function handleClose(event) {
      stopHeartbeat();
      const code = event && event.code;
      const reason = event && event.reason;

      if (!running || graceful) {
        mode = MODE.NONE;
        setState(STATE.CLOSED, { reason: graceful ? 'stopped' : 'not-running' });
        return;
      }

      // 4002 => the server revoked the session (logged out elsewhere). This is
      // terminal: never try to refresh or reconnect.
      if (code === 4002) {
        running = false;
        mode = MODE.NONE;
        stopPolling();
        stopRecovery();
        setState(STATE.CLOSED, { reason: reason || 'session-revoked', code });
        emit({ type: 'session-invalid', code, reason: reason || 'session-revoked' });
        return;
      }

      // 4001 => access token expired; the host must supply a fresh one.
      if (code === 4001) {
        lastError = 'token-expired';
        emit({ type: 'need-token', reason: 'token-expired' });
      }

      // A failed background recovery probe must not restart the reconnect loop;
      // polling is already running and will keep the app alive.
      if (pollingActive) {
        setState(STATE.POLLING, { reason: 'ws-recovery-failed' });
        return;
      }

      scheduleReconnect();
    }

    function scheduleReconnect() {
      if (!running || graceful) return;
      // In forced-poll mode polling already keeps the app alive; never reconnect.
      if (transportMode === 'poll') return;
      attempt += 1;

      if (attempt > options.maxReconnectAttempts) {
        lastError = 'max-reconnect-attempts';
        log(`giving up after ${options.maxReconnectAttempts} reconnect attempts, degrading to polling`);
        startPolling('max-reconnect-attempts');
        startRecovery();
        return;
      }

      const delay = computeBackoff(attempt - 1, options.baseDelayMs, options.maxDelayMs, options.jitter);
      setState(STATE.RECONNECTING, { attempt, nextRetryMs: delay });
      log(`reconnect #${attempt} in ${delay}ms`);
      clearTimer('reconnect');
      reconnectTimer = setTimeout(() => connect(), delay);
    }

    // -------------------------------------------------------------------------
    // HTTP incremental polling (degradation path)
    // -------------------------------------------------------------------------
    function startPolling(reason) {
      if (pollingActive) return;
      if (!fetchImpl) {
        mode = MODE.NONE;
        setState(STATE.CLOSED, { reason: 'no-fetch-available' });
        return;
      }
      pollingActive = true;
      mode = MODE.POLL;
      pollIntervalMs = options.pollBaseIntervalMs;
      setState(STATE.POLLING, { reason });
      log(`degraded to HTTP polling (${reason})`);
      pollOnce({ kind: 'enter' });
    }

    function scheduleNextPoll(delayMs) {
      clearTimer('poll');
      if (!pollingActive || !running || graceful) return;
      pollTimer = setTimeout(() => pollOnce({ kind: 'loop' }), delayMs);
    }

    function stopPolling() {
      pollingActive = false;
      clearTimer('poll');
      pollIntervalMs = options.pollBaseIntervalMs;
    }

    /**
     * One incremental poll. `kind` is 'enter' | 'loop' | 'resume'.
     * 'resume' is a one-shot backfill fired right after the WebSocket recovers.
     */
    function pollOnce({ kind }) {
      clearTimer('poll');
      if (!fetchImpl || !running || graceful) return;

      Promise.resolve()
        .then(getToken)
        .then((token) => {
          if (!running || graceful) return undefined;
          if (!token) {
            emit({ type: 'need-token', reason: 'no-token-for-poll' });
            if (pollingActive) scheduleNextPoll(5000);
            return undefined;
          }
          const url =
            `${pollUrl}?sinceId=${cursor.messageId}&noticeSinceId=${cursor.noticeId}` +
            `&limit=${options.pollLimit}`;

          return fetchImpl(url, { headers: { authorization: `Bearer ${token}` } })
            .then((res) => {
              if (res.status === 401) {
                emit({ type: 'need-token', reason: 'poll-unauthorized' });
                if (pollingActive) scheduleNextPoll(5000);
                return undefined;
              }
              if (!res.ok) throw new Error(`poll http ${res.status}`);
              return res.json();
            })
            .then((payload) => {
              if (!payload || !payload.ok) return;
              const data = payload.data || {};
              const messages = data.messages || [];
              const notices = data.notices || [];
              messages.forEach((m) => bumpCursor('messageId', m.id));
              notices.forEach((n) => bumpCursor('noticeId', n.id));

              const hasData = messages.length > 0 || notices.length > 0;
              if (hasData || kind === 'enter') {
                emit({
                  type: 'poll',
                  messages,
                  notices,
                  serverTime: data.serverTime,
                  cursor: { ...cursor },
                });
              }

              if (pollingActive) {
                // Adaptive cadence: tighten when there is traffic, relax when idle.
                pollIntervalMs = hasData
                  ? options.pollBaseIntervalMs
                  : Math.min(
                      options.pollMaxIntervalMs,
                      Math.round(pollIntervalMs * options.pollBackoffFactor)
                    );
                scheduleNextPoll(pollIntervalMs);
              }
            });
        })
        .catch((err) => {
          lastError = 'poll-failed';
          log(`poll failed: ${(err && err.message) || err}`);
          if (pollingActive) {
            scheduleNextPoll(
              Math.min(options.pollMaxIntervalMs, Math.round(pollIntervalMs * options.pollBackoffFactor))
            );
          }
        });
    }

    // -------------------------------------------------------------------------
    // Background WebSocket recovery while degraded
    // -------------------------------------------------------------------------
    function startRecovery() {
      if (transportMode === 'poll' || !supportsWebSocket() || recoveryTimer) return;
      recoveryTimer = setInterval(() => {
        if (!running || graceful || !pollingActive || socket) return;
        log('background WebSocket recovery probe');
        connect();
      }, options.wsRecoveryIntervalMs);
    }

    function stopRecovery() {
      clearTimer('recovery');
    }

    // -------------------------------------------------------------------------
    // Heartbeat / liveness watchdog
    // -------------------------------------------------------------------------
    function startHeartbeat() {
      clearTimer('heartbeat');
      lastPingAt = now();
      pendingPingAt = 0;

      heartbeatTimer = setInterval(() => {
        if (!isOpen()) return;
        const t = now();

        // A ping that never came back within the timeout => dead link.
        if (pendingPingAt && t - pendingPingAt > options.heartbeatTimeoutMs) {
          log('heartbeat timeout, forcing reconnect');
          pendingPingAt = 0;
          try {
            socket.close(4000, 'heartbeat timeout');
          } catch {
            /* ignore */
          }
          return;
        }

        if (t - lastPingAt >= options.heartbeatIntervalMs) {
          lastPingAt = t;
          pendingPingAt = t;
          try {
            socket.send(JSON.stringify({ type: 'ping' }));
          } catch {
            /* ignore */
          }
        }
      }, options.heartbeatCheckMs);
    }

    function stopHeartbeat() {
      clearTimer('heartbeat');
      pendingPingAt = 0;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    function configure(cfg) {
      if (cfg && cfg.wsUrl) wsUrl = cfg.wsUrl;
      if (cfg && cfg.pollUrl) pollUrl = cfg.pollUrl;
    }

    function start() {
      if (running) return;
      running = true;
      graceful = false;
      attempt = 0;
      log('engine starting');
      connect();
    }

    /** Graceful shutdown — used on logout. Never reconnects. */
    function stop(isGraceful) {
      running = false;
      graceful = isGraceful !== false;
      clearAllTimers();
      pollingActive = false;
      connecting = false;
      mode = MODE.NONE;
      if (socket) {
        const dying = socket;
        socket = null;
        try {
          dying.onclose = null;
          dying.onopen = null;
          dying.onmessage = null;
          dying.close(1000, 'client logout');
        } catch {
          /* ignore */
        }
      }
      attempt = 0;
      everConnected = false;
      setState(STATE.CLOSED, { reason: 'stopped' });
    }

    /** Immediately abandons any pending backoff and retries (e.g. after a fresh token). */
    function retryNow() {
      if (!running || graceful) return;
      clearTimer('reconnect');
      connect();
    }

    /**
     * Switches the transport strategy at runtime.
     *   'poll' -> close any socket and force HTTP polling;
     *   'auto' -> stop polling and (re)establish the WebSocket.
     */
    function setTransportMode(mode) {
      const next = mode === 'poll' ? 'poll' : 'auto';
      if (next === transportMode) return;
      transportMode = next;
      if (!running || graceful) return;

      if (transportMode === 'poll') {
        clearTimer('reconnect');
        stopHeartbeat();
        stopRecovery();
        if (socket) {
          const dying = socket;
          socket = null;
          connecting = false;
          // Detach handlers so the close does not trigger a reconnect.
          try {
            dying.onopen = null;
            dying.onmessage = null;
            dying.onerror = null;
            dying.onclose = null;
            dying.close(1000, 'transport switched to polling');
          } catch {
            /* ignore */
          }
        }
        startPolling('forced-poll');
        return;
      }

      // Back to auto: drop polling and reconnect the socket immediately.
      stopPolling();
      attempt = 0;
      connect();
    }

    function send(frame) {
      if (!isOpen()) return false;
      try {
        socket.send(JSON.stringify(frame));
        return true;
      } catch {
        return false;
      }
    }

    function snapshot() {
      return {
        state,
        mode,
        attempt,
        lastError,
        transportMode,
        cursor: { ...cursor },
        pollIntervalMs,
        connected: isOpen(),
        everConnected,
      };
    }

    return {
      configure,
      start,
      stop,
      retryNow,
      setTransportMode,
      send,
      isOpen,
      setCursor,
      snapshot,
      STATE,
      MODE,
    };
  }

  global.StellaRealtime = {
    createRealtimeEngine,
    computeBackoff,
    STATE,
    MODE,
    DEFAULTS,
  };
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
