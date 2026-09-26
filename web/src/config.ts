/**
 * Runtime configuration.
 *
 * `VITE_API_BASE` can be provided through `web/.env.local` to point at a
 * different backend; everything else is derived so there is one source of truth.
 */
const env = import.meta.env;

const API_BASE = ((env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');

export const API = {
  base: API_BASE,
  ws: (env.VITE_WS_URL as string | undefined) ?? `${API_BASE.replace(/^http/, 'ws')}/ws`,
  poll: `${API_BASE}/api/messages/poll`,
} as const;

/** Endpoints that must never trigger the silent 401-refresh flow. */
export const AUTH_FREE_PATHS = ['/api/auth/login', '/api/auth/register', '/api/auth/refresh'];

export const STORAGE_KEYS = {
  /** The persisted session (access + refresh token). */
  session: 'stella.im.session',
  /** Cross-tab logout signal (StorageEvent). */
  logoutSignal: 'stella.im.logout',
  /** Cross-tab message bus used only in the no-SharedWorker fallback. */
  bus: 'stella.im.bus',
  /** Device-local colour theme. */
  theme: 'stella.im.theme',
} as const;

/** Enterprise request-governance tuning. */
export const REQUEST_POLICY = {
  /** Max simultaneously in-flight requests (browser connection budget). */
  maxConcurrent: 6,
  /** Retries for network errors / 5xx only. */
  retryMax: 2,
  retryBaseMs: 300,
  retryMaxMs: 4000,
  jitter: 0.5,
  /** Window in which an identical mutation is merged onto the in-flight one. */
  dedupWindowMs: 1200,
} as const;

/** Single-active-tab election tuning (StorageEvent fallback mode). */
export const TAB_POLICY = {
  heartbeatMs: 2000,
  staleMs: 6000,
} as const;
