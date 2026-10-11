import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { authApi, refreshAccessToken } from '../lib/api';
import { setAuthHooks } from '../lib/axiosClient';
import { STORAGE_KEYS } from '../config';
import { RealtimeClient } from '../lib/realtime';
import { broadcastLogout, initCrossTabLogout, session } from '../lib/session';
import { uid } from '../lib/storage';
import {
  readStoredTransportHost,
  readStoredTransportMode,
  writeStoredTransportHost,
  writeStoredTransportMode,
  type TransportHost,
  type TransportMode,
} from '../lib/transport';
import type {
  RealtimeStatus,
  ServerFrame,
  SessionPayload,
  SystemNotice,
  Toast,
  TransportKind,
  User,
} from '../types';

/**
 * ============================================================================
 * Global capability layer — deliberately split into four contexts
 * ============================================================================
 * Everything here is a *capability* (plus the small amount of genuinely global
 * state the architecture allows). Business data stays in the pages.
 *
 * The split exists for one reason: **re-render isolation**. A single context
 * object whose value changes would re-render every consumer, so a connection
 * status blip or an incoming toast used to re-render the whole message list. The
 * four slices change at very different rates, and consumers subscribe only to
 * the slice they actually read:
 *
 *   ActionsContext   never changes  -> stable callbacks, zero re-renders
 *   SessionContext   rarely         -> logged-in user, active conversation
 *   RealtimeContext  on transitions -> connection status, window role
 *   ToastsContext    per toast      -> the toast list only
 */

type FrameHandler = (frame: ServerFrame) => void;
type NoticeHandler = (notice: SystemNotice) => void;

export interface AppActions {
  signIn: (payload: SessionPayload) => void;
  signOut: () => Promise<void>;
  updateUser: (patch: Partial<User>) => void;
  claimLeadership: () => void;
  /** Returns false when the socket is not open (caller falls back to HTTP). */
  sendFrame: (frame: unknown) => boolean;
  subscribeFrames: (handler: FrameHandler) => () => void;
  subscribeNotices: (handler: NoticeHandler) => () => void;
  publishCursor: (cursor: { messageId?: number; noticeId?: number }) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  /** `d:<userId>` for 1:1, `g:<groupId>` for groups — see lib/conversation. */
  setActiveConversationId: (id: string | null) => void;
  /** Switches the transport strategy (auto WS / forced polling). */
  setTransportMode: (mode: TransportMode) => void;
  /** Switches the transport host (SharedWorker / in-tab single-instance). */
  setTransportHost: (host: TransportHost) => void;
}

export interface AppSession {
  user: User | null;
  isAuthenticated: boolean;
  /**
   * False until the boot-time silent refresh has resolved. Routing must wait on
   * this, otherwise a reload would flash the login page while the (memory-only)
   * access token is still being re-minted from the HttpOnly cookie.
   */
  authReady: boolean;
  activeConversationId: string | null;
}

export interface AppRealtime {
  status: RealtimeStatus;
  transport: TransportKind;
  isLeader: boolean;
  isFrozen: boolean;
  /** Device transport strategy: 'auto' (WS-first) or 'poll' (WS disabled). */
  transportMode: TransportMode;
  /** Device transport host preference: auto / shared-worker / in-tab. */
  transportHost: TransportHost;
  /** Latest ping round-trip time (ms); null until measured. */
  latencyMs: number | null;
}

const ActionsContext = createContext<AppActions | null>(null);
const SessionContext = createContext<AppSession | null>(null);
const RealtimeContext = createContext<AppRealtime | null>(null);
const ToastsContext = createContext<Toast[] | null>(null);

export const useAppActions = (): AppActions => {
  const value = useContext(ActionsContext);
  if (!value) throw new Error('useAppActions 必须在 AppProvider 内使用');
  return value;
};

export const useAppSession = (): AppSession => {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useAppSession 必须在 AppProvider 内使用');
  return value;
};

export const useAppRealtime = (): AppRealtime => {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useAppRealtime 必须在 AppProvider 内使用');
  return value;
};

export const useToasts = (): Toast[] => {
  const value = useContext(ToastsContext);
  if (!value) throw new Error('useToasts 必须在 AppProvider 内使用');
  return value;
};

const IDLE_STATUS: RealtimeStatus = {
  state: 'idle',
  mode: 'none',
  attempt: 0,
  nextRetryMs: 0,
  lastError: null,
  connected: false,
};

/** Field-wise comparison so an identical status update can be skipped entirely. */
const sameStatus = (a: RealtimeStatus, b: RealtimeStatus): boolean =>
  a.state === b.state &&
  a.mode === b.mode &&
  a.attempt === b.attempt &&
  a.nextRetryMs === b.nextRetryMs &&
  a.lastError === b.lastError &&
  a.connected === b.connected;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => session.getUser());
  const [status, setStatus] = useState<RealtimeStatus>(IDLE_STATUS);
  const [transport, setTransport] = useState<TransportKind>('shared-worker');
  const [isLeader, setIsLeader] = useState(true);
  const [activeConversationId, setActiveConversationIdState] = useState<string | null>(null);
  /** Routing gate: resolved once the boot refresh finishes (see bootstrap effect). */
  const [authReady, setAuthReady] = useState(false);
  const [transportMode, setTransportModeState] = useState<TransportMode>(() => readStoredTransportMode());
  const [transportHost, setTransportHostState] = useState<TransportHost>(() => readStoredTransportHost());
  /** Latest ping round-trip time (ms); null until the first sample. */
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const realtimeRef = useRef<RealtimeClient | null>(null);
  const frameHandlers = useRef(new Set<FrameHandler>());
  const noticeHandlers = useRef(new Set<NoticeHandler>());
  const toastTimers = useRef(new Map<string, number>());

  // -------------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------------
  const dismissToast = useCallback((id: string) => {
    setToasts((current) => {
      // Bail out when nothing actually changes (a stale timer firing late).
      if (!current.some((toast) => toast.id === id)) return current;
      return current.filter((toast) => toast.id !== id);
    });
    const timer = toastTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimers.current.delete(id);
    }
  }, []);

  const pushToast = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = uid();
      setToasts((current) => [...current.slice(-4), { ...toast, id }]);
      const ttl = toast.kind === 'notice' ? 8000 : 5200;
      toastTimers.current.set(id, window.setTimeout(() => dismissToast(id), ttl));
    },
    [dismissToast]
  );

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // -------------------------------------------------------------------------
  // Subscription buses — handlers live in pages, never in context state
  // -------------------------------------------------------------------------
  const subscribeFrames = useCallback((handler: FrameHandler) => {
    frameHandlers.current.add(handler);
    return () => {
      frameHandlers.current.delete(handler);
    };
  }, []);

  const subscribeNotices = useCallback((handler: NoticeHandler) => {
    noticeHandlers.current.add(handler);
    return () => {
      noticeHandlers.current.delete(handler);
    };
  }, []);

  const publishCursor = useCallback((cursor: { messageId?: number; noticeId?: number }) => {
    realtimeRef.current?.pushCursor(cursor);
  }, []);

  const dispatchFrame = useCallback((frame: ServerFrame) => {
    for (const handler of frameHandlers.current) {
      try {
        handler(frame);
      } catch (error) {
        console.error('[bus] frame handler failed', error);
      }
    }
  }, []);

  const dispatchNotice = useCallback((notice: SystemNotice) => {
    for (const handler of noticeHandlers.current) {
      try {
        handler(notice);
      } catch (error) {
        console.error('[bus] notice handler failed', error);
      }
    }
  }, []);

  // -------------------------------------------------------------------------
  // Session teardown / login
  // -------------------------------------------------------------------------
  const teardownLocalSession = useCallback(() => {
    session.clear();
    setUser(null);
    setActiveConversationIdState(null);
    setIsLeader(true);
    setLatencyMs(null);
    setAuthReady(true);
    realtimeRef.current?.disconnect();
  }, []);

  const signIn = useCallback((payload: SessionPayload) => {
    session.set(payload);
    setUser(payload.user);
    setAuthReady(true);
    realtimeRef.current?.connect(payload.accessToken);
  }, []);

  const signOut = useCallback(async () => {
    try {
      if (session.getAccessToken()) await authApi.logout();
    } catch {
      /* revocation may already have happened — local teardown still applies */
    }
    teardownLocalSession();
    // Tell every sibling tab to go offline as well.
    broadcastLogout();
  }, [teardownLocalSession]);

  const claimLeadership = useCallback(() => {
    setIsLeader(true);
    realtimeRef.current?.claimLeadership();
  }, []);

  const updateUser = useCallback((patch: Partial<User>) => {
    const next = session.updateUser(patch);
    if (next) setUser(next);
  }, []);

  const sendFrame = useCallback((frame: unknown) => {
    const client = realtimeRef.current;
    if (!client || !client.isOpen()) return false;
    return client.send(frame);
  }, []);

  const setActiveConversationId = useCallback((id: string | null) => {
    setActiveConversationIdState(id);
  }, []);

  const setTransportMode = useCallback((mode: TransportMode) => {
    writeStoredTransportMode(mode);
    setTransportModeState(mode);
    realtimeRef.current?.setTransportMode(mode);
  }, []);

  // Changing the host rebuilds the client (see the lifecycle effect below).
  const setTransportHost = useCallback((host: TransportHost) => {
    writeStoredTransportHost(host);
    setTransportHostState(host);
  }, []);

  // -------------------------------------------------------------------------
  // Realtime client lifecycle
  // -------------------------------------------------------------------------
  useEffect(() => {
    const client = new RealtimeClient({
      onStatus: (next, meta) => {
        setTransport(meta.transport);
        // Skip identical updates: the engine re-emits state on every transition,
        // and each one would otherwise re-render every realtime consumer.
        setStatus((previous) => (sameStatus(previous, next) ? previous : next));
      },
      onFrame: (frame) => {
        // Keep the sync cursor moving for every delivered push.
        if (frame.type === 'chat:message') {
          const message = frame.message as { id?: number } | undefined;
          if (message?.id) client.pushCursor({ messageId: message.id });
        } else if (frame.type === 'notice:system') {
          const notice = frame.notice as SystemNotice | undefined;
          if (notice?.id) client.pushCursor({ noticeId: notice.id });
          // A WS-pushed announcement must travel the *global notice* bus too,
          // otherwise it would only exist as an opaque frame the pages ignore.
          if (notice) dispatchNotice(notice);
        }
        dispatchFrame(frame);
      },
      onPoll: (payload) => {
        // Normalise incremental polls into the exact same frame shapes the pages
        // already handle, so there is a single code path.
        for (const message of payload.messages) {
          dispatchFrame({ type: 'chat:message', message, source: 'poll' });
        }
        for (const notice of payload.notices) {
          dispatchNotice(notice);
          dispatchFrame({ type: 'notice:system', notice, source: 'poll' });
        }
      },
      onNeedToken: () => {
        // A tab refresh triggers a push of the new token back into the engine.
        void refreshAccessToken()
          .then((token) => realtimeRef.current?.connect(token))
          .catch(() => {
            /* refresh failure already triggered the global logout path */
          });
      },
      onSessionInvalid: (reason) => {
        if (!session.getAccessToken()) return;
        teardownLocalSession();
        broadcastLogout();
        pushToast({ kind: 'warning', title: '登录状态已失效', body: reason || '请重新登录' });
      },
      onLeaderChange: (leader) => setIsLeader(leader),
      onLatency: (rttMs) => setLatencyMs(rttMs > 0 ? rttMs : null),
    }, transportHost);

    realtimeRef.current = client;
    client.start();
    // Apply the persisted transport strategy before the first connect.
    client.setTransportMode(readStoredTransportMode());

    // Re-attach an existing session (page reload / freshly opened tab).
    const token = session.getAccessToken();
    if (token) client.connect(token);

    return () => {
      client.dispose();
      if (realtimeRef.current === client) realtimeRef.current = null;
    };
  }, [dispatchFrame, dispatchNotice, pushToast, teardownLocalSession, transportHost]);

  // -------------------------------------------------------------------------
  // Boot: re-mint a memory-only access token from the HttpOnly refresh cookie.
  // The refresh token is never readable by JS, so a reload must ask the server
  // for a fresh access token before the shell can talk to the API.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (session.getAccessToken() || !session.hasUserHint()) {
        if (!cancelled) setAuthReady(true);
        return;
      }
      try {
        const token = await refreshAccessToken();
        if (cancelled) return;
        setUser(session.getUser());
        realtimeRef.current?.connect(token);
      } catch {
        // refreshAccessToken already cleared the session and fired onExpired.
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Cross-tab logout + axios auth hooks
  // -------------------------------------------------------------------------
  useEffect(() => {
    const stopLogoutListener = initCrossTabLogout(() => {
      // Another tab logged out: drop everything here too, without re-broadcasting.
      teardownLocalSession();
      pushToast({ kind: 'info', title: '已退出登录', body: '其他窗口已退出，本窗口同步下线' });
    });

    setAuthHooks({
      onRefreshed: (accessToken) => realtimeRef.current?.connect(accessToken),
      onExpired: (code) => {
        teardownLocalSession();
        broadcastLogout();
        pushToast({ kind: 'warning', title: '登录状态已过期', body: `请重新登录（${code}）` });
      },
    });

    return () => {
      stopLogoutListener();
      setAuthHooks({});
    };
  }, [teardownLocalSession, pushToast]);

  // -------------------------------------------------------------------------
  // Cross-tab transport preference sync (changed in another tab)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.transportHost) {
        const next: TransportHost =
          event.newValue === 'shared-worker' || event.newValue === 'in-tab' ? event.newValue : 'auto';
        // State change rebuilds the client on the new host (see lifecycle effect).
        setTransportHostState(next);
        return;
      }
      if (event.key !== STORAGE_KEYS.transport) return;
      const mode: TransportMode = event.newValue === 'poll' ? 'poll' : 'auto';
      setTransportModeState(mode);
      realtimeRef.current?.setTransportMode(mode);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // -------------------------------------------------------------------------
  // Proactive silent renewal (keeps the long connection's session alive)
  // -------------------------------------------------------------------------
  useEffect(() => {  
    if (!user) return undefined;
    const timer = window.setInterval(() => {
      if (!session.isAuthenticated() || !session.isAccessExpiring(60_000)) return;
      void refreshAccessToken().catch(() => {
        /* handled by the expiry hook */
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [user]);

  // -------------------------------------------------------------------------
  // Context values — one per change frequency
  // -------------------------------------------------------------------------
  const actions = useMemo<AppActions>(
    () => ({
      signIn,
      signOut,
      updateUser,
      claimLeadership,
      sendFrame,
      subscribeFrames,
      subscribeNotices,
      publishCursor,
      pushToast,
      dismissToast,
      setActiveConversationId,
      setTransportMode,
      setTransportHost,
    }),
    [
      signIn,
      signOut,
      updateUser,
      claimLeadership,
      sendFrame,
      subscribeFrames,
      subscribeNotices,
      publishCursor,
      pushToast,
      dismissToast,
      setActiveConversationId,
      setTransportMode,
      setTransportHost,
    ]
  );

  const sessionValue = useMemo<AppSession>(
    () => ({ user, isAuthenticated: !!user, authReady, activeConversationId }),
    [user, authReady, activeConversationId]
  );

  const isFrozen = !!user && !isLeader;

  const realtimeValue = useMemo<AppRealtime>(
    () => ({ status, transport, isLeader, isFrozen, transportMode, transportHost, latencyMs }),
    [status, transport, isLeader, isFrozen, transportMode, transportHost, latencyMs]
  );

  return (
    <ActionsContext.Provider value={actions}>
      <SessionContext.Provider value={sessionValue}>
        <RealtimeContext.Provider value={realtimeValue}>
          <ToastsContext.Provider value={toasts}>{children}</ToastsContext.Provider>
        </RealtimeContext.Provider>
      </SessionContext.Provider>
    </ActionsContext.Provider>
  );
}
