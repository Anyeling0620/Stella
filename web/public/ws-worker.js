/**
 * Stella SharedWorker — guarantees exactly ONE WebSocket connection per browser,
 * shared by every tab.
 *
 * It wraps the shared realtime engine (see realtime-engine.js) and adds:
 *   - port (tab) registry and message fan-out
 *   - preemptive single-active-tab election (newest window wins)
 *
 * Note: workers have no access to localStorage, so the access token is always
 * pushed in by a tab. Without a token the engine refuses to connect.
 */
/* global StellaRealtime */
importScripts('/realtime-engine.js');

const LEADER_STALE_MS = 10000;
const SWEEP_INTERVAL_MS = 3000;

/** port -> { tabId, lastSeen } */
const ports = new Map();
let leaderTabId = null;
let token = null;
let engineStarted = false;

function broadcast(message) {
  for (const port of ports.keys()) {
    try {
      port.postMessage(message);
    } catch {
      /* port closed; the sweep will drop it */
    }
  }
}

function reply(port, message) {
  try {
    port.postMessage(message);
  } catch {
    /* ignore */
  }
}

const engine = StellaRealtime.createRealtimeEngine({
  getToken: () => token,
  emit(event) {
    // 'need-token' is the one event that must reach a tab so it can refresh.
    broadcast(event);
  },
  log(...args) {
    console.log('[stella-worker]', ...args);
  },
});

function snapshot() {
  return engine.snapshot();
}

function announceLeader() {
  for (const [port, meta] of ports) {
    reply(port, {
      type: 'leader',
      leaderTabId,
      tabId: meta.tabId,
      isLeader: meta.tabId === leaderTabId,
    });
  }
}

function claimLeadership(tabId) {
  if (!tabId) return;
  leaderTabId = tabId;
  console.log('[stella-worker] leader =', tabId);
  announceLeader();
}

// ---------------------------------------------------------------------------
// Tab message handling
// ---------------------------------------------------------------------------
function handleConnect(message) {
  const tokenChanged = typeof message.token === 'string' && message.token !== token;
  if (typeof message.token === 'string') token = message.token;

  if (message.wsUrl || message.pollUrl) {
    engine.configure({ wsUrl: message.wsUrl, pollUrl: message.pollUrl });
  }
  if (!token) return;

  const snap = snapshot();

  if (!engineStarted) {
    engineStarted = true;
    engine.start();
    return;
  }

  if (snap.connected) {
    // Session already live: just extend its server-side expiry.
    if (tokenChanged) engine.send({ type: 'auth:refresh', accessToken: token });
    return;
  }

  engine.retryNow();
}

function handleMessage(port, message) {
  if (!message || typeof message.type !== 'string') return;
  const meta = ports.get(port);
  if (meta) meta.lastSeen = Date.now();

  switch (message.type) {
    case 'attach': {
      ports.set(port, { tabId: message.tabId, lastSeen: Date.now() });
      // Preemptive single-instance: a newly opened window takes over.
      claimLeadership(message.tabId);
      reply(port, {
        type: 'attached',
        tabId: message.tabId,
        snapshot: snapshot(),
        leaderTabId,
        isLeader: message.tabId === leaderTabId,
      });
      return;
    }

    case 'detach': {
      ports.delete(port);
      if (ports.size === 0 && engineStarted) {
        engine.stop(true);
        engineStarted = false;
        token = null;
        leaderTabId = null;
      } else if (message.tabId === leaderTabId) {
        const next = [...ports.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];
        claimLeadership(next ? next.tabId : null);
      }
      return;
    }

    case 'connect':
      handleConnect(message);
      return;

    case 'disconnect':
      token = null;
      engineStarted = false;
      engine.stop(true);
      return;

    case 'send':
      engine.send(message.frame);
      return;

    case 'set-cursor':
      engine.setCursor({ messageId: message.messageId, noticeId: message.noticeId });
      return;

    case 'claim-leader':
      claimLeadership(message.tabId);
      return;

    case 'snapshot':
      reply(port, { type: 'snapshot', snapshot: snapshot(), leaderTabId });
      return;

    case 'ping':
      reply(port, { type: 'pong', serverTime: Date.now() });
      return;

    default:
      return;
  }
}

self.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = (msgEvent) => handleMessage(port, msgEvent.data);
  port.start();
};

// ---------------------------------------------------------------------------
// Liveness sweep: if the leader tab disappears without a clean detach, promote
// the most recently active remaining tab.
// ---------------------------------------------------------------------------
setInterval(() => {
  const cutoff = Date.now() - LEADER_STALE_MS;
  let newest = null;
  for (const meta of ports.values()) {
    if (meta.lastSeen < cutoff) continue;
    if (!newest || meta.lastSeen > newest.lastSeen) newest = meta;
  }
  if (!newest) return;

  if (!leaderTabId) {
    claimLeadership(newest.tabId);
    return;
  }
  const leader = [...ports.values()].find((m) => m.tabId === leaderTabId);
  if (!leader || leader.lastSeen < cutoff) claimLeadership(newest.tabId);
}, SWEEP_INTERVAL_MS);
