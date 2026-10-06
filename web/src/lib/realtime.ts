import { API } from '../config';
import { TAB_POLICY } from '../config';
import { bus, BUS } from './bus';
import { uid } from './storage';
import type { TransportHost, TransportMode } from './transport';
import type { ChatMessage, RealtimeMode, RealtimeState, RealtimeStatus, ServerFrame, SystemNotice, TransportKind } from '../types';

/**
 * ============================================================================
 * Realtime client
 * ============================================================================
 * One facade over two transports with identical observables:
 *
 *   - `shared-worker`      : a SharedWorker owns the single browser-wide socket;
 *                            tabs talk to it over a MessagePort.
 *   - `in-tab-fallback`    : no SharedWorker support. Exactly one tab is elected
 *                            leader (BroadcastChannel/StorageEvent) and owns the
 *                            socket; frames are relayed to the other tabs.
 *
 * The consumer (React context) never knows which one is in use.
 */

// --- ambient types for the plain-JS engine in /public -----------------------
interface EngineSnapshot {
  state: RealtimeState;
  mode: RealtimeMode;
  attempt: number;
  lastError: string | null;
  cursor: { messageId: number; noticeId: number };
  pollIntervalMs: number;
  connected: boolean;
  everConnected: boolean;
}

interface RealtimeEngine {
  configure(cfg: { wsUrl?: string; pollUrl?: string }): void;
  start(): void;
  stop(graceful?: boolean): void;
  retryNow(): void;
  setTransportMode?(mode: string): void;
  send(frame: unknown): boolean;
  isOpen(): boolean;
  setCursor(cursor: { messageId?: number; noticeId?: number }): void;
  snapshot(): EngineSnapshot;
}

interface RealtimeEngineFactory {
  createRealtimeEngine(options: Record<string, unknown>): RealtimeEngine;
}

interface EngineEvent {
  type: 'state' | 'frame' | 'poll' | 'need-token' | 'session-invalid' | 'latency';
  state?: RealtimeState;
  mode?: RealtimeMode;
  attempt?: number;
  nextRetryMs?: number;
  lastError?: string | null;
  reason?: string;
  recovered?: boolean;
  code?: number;
  frame?: ServerFrame;
  messages?: ChatMessage[];
  notices?: SystemNotice[];
  serverTime?: string;
  rttMs?: number;
}

export interface PollPayload {
  messages: ChatMessage[];
  notices: SystemNotice[];
  serverTime?: string;
}

export interface RealtimeHandlers {
  onStatus: (status: RealtimeStatus, meta: { transport: TransportKind; recovered: boolean }) => void;
  onFrame: (frame: ServerFrame) => void;
  onPoll: (payload: PollPayload) => void;
  onNeedToken: (reason: string) => void;
  onSessionInvalid: (reason: string) => void;
  onLeaderChange: (isLeader: boolean) => void;
  /** Round-trip time of the periodic ping, in milliseconds. */
  onLatency: (rttMs: number) => void;
}

const IDLE_STATUS: RealtimeStatus = {
  state: 'idle',
  mode: 'none',
  attempt: 0,
  nextRetryMs: 0,
  lastError: null,
  connected: false,
};

/** Resolve against the app base so it works under a sub-path deployment too. */
const BASE_URL_FOR_ENGINE = (import.meta.env.BASE_URL as string | undefined) ?? '/';

function loadEngine(): Promise<RealtimeEngineFactory> {
  const existing = (globalThis as Record<string, unknown>).StellaRealtime as RealtimeEngineFactory | undefined;
  if (existing) return Promise.resolve(existing);
  // The engine is a plain static asset; importing it executes it and registers
  // the global. `@vite-ignore` keeps the specifier out of the bundler graph.
  return import(/* @vite-ignore */ `${BASE_URL_FOR_ENGINE}realtime-engine.js`).then(() => {
    const factory = (globalThis as Record<string, unknown>).StellaRealtime as RealtimeEngineFactory | undefined;
    if (!factory) throw new Error('realtime engine 未能注册');
    return factory;
  });
}

type BusMessage =
  | { kind: typeof BUS.FRAME; frame: ServerFrame }
  | { kind: typeof BUS.POLL; payload: PollPayload }
  | { kind: typeof BUS.STATUS; status: RealtimeStatus; recovered?: boolean }
  | { kind: typeof BUS.LEADER; tabId: string; at: number }
  | { kind: typeof BUS.LEADER_HEARTBEAT; tabId: string; at: number }
  | { kind: typeof BUS.SESSION_INVALID; reason: string };

/** Resolves the configured host preference to an actually usable transport. */
function resolveTransport(host: TransportHost): TransportKind {
  const sharedAvailable = typeof SharedWorker !== 'undefined';
  if (host === 'in-tab') return 'in-tab-fallback';
  // 'auto' and 'shared-worker' both prefer SharedWorker; if the browser cannot
  // provide one, only the in-tab fallback is possible.
  return sharedAvailable ? 'shared-worker' : 'in-tab-fallback';
}

export class RealtimeClient {
  readonly transport: TransportKind;
  readonly tabId = uid();

  private readonly handlers: RealtimeHandlers;

  // shared-worker mode
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private pingTimer: number | null = null;

  // in-tab fallback mode
  private engine: RealtimeEngine | null = null;
  private unsubscribeBus: (() => void) | null = null;
  private electionTimer: number | null = null;
  private leaderId: string | null = null;
  private leaderSeenAt = 0;

  private isLeader = false;
  private currentToken: string | null = null;
  private lastStatus: RealtimeStatus = IDLE_STATUS;
  private mode: TransportMode = 'auto';
  private disposed = false;

  constructor(handlers: RealtimeHandlers, host: TransportHost = 'auto') {
    this.handlers = handlers;
    this.transport = resolveTransport(host);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start(): void {
    if (this.transport === 'shared-worker') this.startWorker();
    else void this.startFallback();
  }

  private startWorker(): void {
    try {
      this.worker = new SharedWorker('/ws-worker.js');
      this.port = this.worker.port;
      this.port.onmessage = (event: MessageEvent) => this.handleWorkerMessage(event.data as Record<string, unknown>);
      this.port.start();
      this.port.postMessage({ type: 'attach', tabId: this.tabId });

      // Liveness ping: lets the worker promote a new leader if this tab dies.
      this.pingTimer = window.setInterval(() => {
        this.port?.postMessage({ type: 'ping', tabId: this.tabId });
      }, 3000);
      console.info('[realtime] transport = SharedWorker');
    } catch (error) {
      console.warn('[realtime] SharedWorker 启动失败，降级为页内连接', error);
      void this.startFallback();
    }
  }

  private async startFallback(): Promise<void> {
    try {
      const factory = await loadEngine();
      if (this.disposed) return;
      this.engine = factory.createRealtimeEngine({
        getToken: () => Promise.resolve(this.currentToken),
        emit: (event: EngineEvent) => this.handleEngineEvent(event),
        log: (...args: unknown[]) => console.debug('[realtime:engine]', ...args),
      });
      this.engine.configure({ wsUrl: API.ws, pollUrl: API.poll });
      this.unsubscribeBus = bus.subscribe((message) => this.handleBusMessage(message as BusMessage));
      this.startElection();
      console.info(`[realtime] transport = 页内降级（总线: ${bus.kind}）`);
    } catch (error) {
      console.error('[realtime] 降级链路初始化失败', error);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.port) {
      try {
        this.port.postMessage({ type: 'detach', tabId: this.tabId });
      } catch {
        /* ignore */
      }
    }
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    if (this.electionTimer !== null) window.clearInterval(this.electionTimer);
    this.unsubscribeBus?.();
    this.engine?.stop(true);
    this.engine = null;
    try {
      this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = null;
    this.worker = null;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------
  connect(token: string): void {
    this.currentToken = token;
    if (this.transport === 'shared-worker') {
      this.port?.postMessage({
        type: 'connect',
        token,
        wsUrl: API.ws,
        pollUrl: API.poll,
        transportMode: this.mode,
      });
      return;
    }
    this.engine?.setTransportMode?.(this.mode);
    if (this.isLeader) {
      // `start()` only begins a stopped engine; `retryNow()` forces an attempt
      // when it is already running but idle (e.g. it started before the token).
      this.engine?.start();
      this.engine?.retryNow();
    }
  }

  /** Switch the transport strategy at runtime (device preference). */
  setTransportMode(mode: TransportMode): void {
    this.mode = mode;
    if (this.transport === 'shared-worker') {
      this.port?.postMessage({ type: 'set-transport', mode });
      return;
    }
    this.engine?.setTransportMode?.(mode);
  }

  disconnect(): void {
    this.currentToken = null;
    if (this.transport === 'shared-worker') {
      this.port?.postMessage({ type: 'disconnect' });
      return;
    }
    this.engine?.stop(true);
  }

  send(frame: unknown): boolean {
    if (this.transport === 'shared-worker') {
      this.port?.postMessage({ type: 'send', frame });
      // The port API is fire-and-forget; the caller falls back to HTTP when the
      // link is not open (see isOpen()).
      return this.lastStatus.connected;
    }
    return this.engine?.send(frame) ?? false;
  }

  isOpen(): boolean {
    return this.lastStatus.connected;
  }

  /** Feeds the sync cursor so polling/resume never re-delivers old rows. */
  pushCursor(cursor: { messageId?: number; noticeId?: number }): void {
    if (!cursor.messageId && !cursor.noticeId) return;
    if (this.transport === 'shared-worker') {
      this.port?.postMessage({ type: 'set-cursor', messageId: cursor.messageId, noticeId: cursor.noticeId });
      return;
    }
    this.engine?.setCursor(cursor);
  }

  claimLeadership(): void {
    if (this.transport === 'shared-worker') {
      this.port?.postMessage({ type: 'claim-leader', tabId: this.tabId });
      return;
    }
    this.claimFallbackLeadership();
  }

  getStatus(): RealtimeStatus {
    return this.lastStatus;
  }

  // -------------------------------------------------------------------------
  // SharedWorker message handling
  // -------------------------------------------------------------------------
  private handleWorkerMessage(message: Record<string, unknown>): void {
    if (this.disposed) return;
    switch (message.type) {
      case 'attached':
        this.applyLeader(Boolean(message.isLeader));
        if (message.snapshot) this.applySnapshot(message.snapshot as EngineSnapshot);
        break;
      case 'leader':
        this.applyLeader(Boolean(message.isLeader));
        break;
      case 'state':
        this.emitStatus({
          state: (message.state as RealtimeState) ?? 'idle',
          mode: (message.mode as RealtimeMode) ?? 'none',
          attempt: Number(message.attempt) || 0,
          nextRetryMs: Number(message.nextRetryMs) || 0,
          lastError: (message.lastError as string | null) ?? null,
          connected: message.state === 'open',
        }, Boolean(message.recovered));
        break;
      case 'frame':
        this.handlers.onFrame(message.frame as ServerFrame);
        break;
      case 'poll':
        this.handlers.onPoll({
          messages: (message.messages as ChatMessage[]) ?? [],
          notices: (message.notices as SystemNotice[]) ?? [],
          serverTime: message.serverTime as string | undefined,
        });
        break;
      case 'need-token':
        this.handlers.onNeedToken((message.reason as string) ?? 'unknown');
        break;
      case 'session-invalid':
        this.handlers.onSessionInvalid((message.reason as string) ?? 'session-invalid');
        break;
      case 'snapshot':
        if (message.snapshot) this.applySnapshot(message.snapshot as EngineSnapshot);
        break;
      case 'latency':
        this.handlers.onLatency(Number(message.rttMs) || 0);
        break;
      default:
        break;
    }
  }

  private applySnapshot(snapshot: EngineSnapshot): void {
    this.emitStatus({
      state: snapshot.state,
      mode: snapshot.mode,
      attempt: snapshot.attempt,
      nextRetryMs: 0,
      lastError: snapshot.lastError,
      connected: snapshot.connected,
    }, false);
  }

  private emitStatus(status: RealtimeStatus, recovered: boolean): void {
    this.lastStatus = status;
    this.handlers.onStatus(status, { transport: this.transport, recovered });
  }

  private applyLeader(isLeader: boolean): void {
    if (this.isLeader === isLeader) return;
    this.isLeader = isLeader;
    this.handlers.onLeaderChange(isLeader);
    this.syncFallbackEngine();
  }

  /**
   * In the in-tab fallback only the elected leader runs the engine (and thus
   * owns the socket); every other tab keeps its engine stopped and consumes
   * frames relayed over the bus. Starting the engine here is what makes the
   * fallback actually connect — without it the leader had no link at all.
   */
  private syncFallbackEngine(): void {
    if (this.transport !== 'in-tab-fallback' || !this.engine) return;
    if (this.isLeader) {
      this.engine.setTransportMode?.(this.mode);
      this.engine.start();
      this.engine.retryNow();
    } else {
      this.engine.stop(true);
    }
  }

  // -------------------------------------------------------------------------
  // In-tab fallback: engine events
  // -------------------------------------------------------------------------
  private handleEngineEvent(event: EngineEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'state':
        this.emitStatus(
          {
            state: event.state ?? 'idle',
            mode: event.mode ?? 'none',
            attempt: event.attempt ?? 0,
            nextRetryMs: event.nextRetryMs ?? 0,
            lastError: event.lastError ?? null,
            connected: event.state === 'open',
          },
          Boolean(event.recovered)
        );
        if (this.isLeader) {
          bus.post({ kind: BUS.STATUS, status: this.lastStatus, recovered: Boolean(event.recovered) } satisfies BusMessage);
        }
        break;
      case 'frame':
        if (event.frame) {
          this.handlers.onFrame(event.frame);
          if (this.isLeader) bus.post({ kind: BUS.FRAME, frame: event.frame } satisfies BusMessage);
        }
        break;
      case 'poll':
        if (this.isLeader) {
          const payload: PollPayload = {
            messages: event.messages ?? [],
            notices: event.notices ?? [],
            serverTime: event.serverTime,
          };
          this.handlers.onPoll(payload);
          bus.post({ kind: BUS.POLL, payload } satisfies BusMessage);
        }
        break;
      case 'need-token':
        this.handlers.onNeedToken(event.reason ?? 'unknown');
        break;
      case 'session-invalid':
        this.handlers.onSessionInvalid(event.reason ?? 'session-invalid');
        if (this.isLeader) {
          bus.post({ kind: BUS.SESSION_INVALID, reason: event.reason ?? 'session-invalid' } satisfies BusMessage);
        }
        break;
      case 'latency':
        this.handlers.onLatency(event.rttMs ?? 0);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // In-tab fallback: leader election over the cross-tab bus
  // -------------------------------------------------------------------------
  private startElection(): void {
    this.claimFallbackLeadership();
    this.electionTimer = window.setInterval(() => {
      const stale = Date.now() - this.leaderSeenAt > TAB_POLICY.staleMs;
      if (this.isLeader) {
        bus.post({ kind: BUS.LEADER_HEARTBEAT, tabId: this.tabId, at: Date.now() } satisfies BusMessage);
        return;
      }
      if (stale || !this.leaderId) this.claimFallbackLeadership();
    }, TAB_POLICY.heartbeatMs);
  }

  private claimFallbackLeadership(): void {
    this.leaderId = this.tabId;
    this.leaderSeenAt = Date.now();
    this.applyLeader(true);
    bus.post({ kind: BUS.LEADER, tabId: this.tabId, at: Date.now() } satisfies BusMessage);
    // A fresh leader must (re)establish the connection.
    if (this.currentToken) this.engine?.retryNow();
  }

  private handleBusMessage(message: BusMessage): void {
    if (!message || typeof message.kind !== 'string') return;

    switch (message.kind) {
      case BUS.LEADER:
      case BUS.LEADER_HEARTBEAT: {
        // Newest claim wins — a newly opened window preempts the old one.
        this.leaderSeenAt = Math.max(this.leaderSeenAt, message.at);
        if (message.tabId !== this.leaderId && message.at >= this.leaderSeenAt) {
          this.leaderId = message.tabId;
          this.applyLeader(false);
        } else if (message.tabId === this.tabId) {
          this.applyLeader(true);
        }
        break;
      }
      case BUS.FRAME:
        this.handlers.onFrame(message.frame);
        break;
      case BUS.POLL:
        this.handlers.onPoll(message.payload);
        break;
      case BUS.STATUS:
        if (!this.isLeader) this.emitStatus(message.status, Boolean(message.recovered));
        break;
      case 'bus:session-invalid':
        if (!this.isLeader) this.handlers.onSessionInvalid((message as { reason: string }).reason);
        break;
      default:
        break;
    }
  }
}
