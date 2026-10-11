/**
 * Runtime configuration.
 *
 * `VITE_API_BASE` can be provided through `web/.env.local` to point at a
 * different backend; everything else is derived so there is one source of truth.
 */
const env = import.meta.env;

/**
 * API origin. Empty by default ⇒ same-origin: in dev the Vite server proxies
 * `/api` and `/ws` to the backend (see `vite.config.ts`), and in production the
 * SPA and API are served from one origin. Set `VITE_API_BASE` only when the
 * backend genuinely lives on a different origin.
 *
 * Same-origin matters for security: it lets the HttpOnly refresh cookie be a
 * first-party `SameSite=Lax` cookie (cross-site dev hosts like
 * `localhost:5173` → `127.0.0.1:3001` would drop it).
 */
const API_BASE = ((env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '');

/** Absolute ws(s):// base when the API is same-origin. */
const wsDefault = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

export const API = {
  base: API_BASE,
  ws: (env.VITE_WS_URL as string | undefined) ?? (API_BASE ? `${API_BASE.replace(/^http/, 'ws')}/ws` : wsDefault),
  poll: `${API_BASE}/api/messages/poll`,
} as const;

/** Endpoints that must never trigger the silent 401-refresh flow. */
export const AUTH_FREE_PATHS = ['/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/api/auth/restore'];

/** Non-HttpOnly double-submit CSRF cookie set alongside the refresh cookie. */
export const CSRF_COOKIE = 'stella_csrf';

export const STORAGE_KEYS = {
  /** The persisted session (access + refresh token). */
  session: 'stella.im.session',
  /** Cross-tab logout signal (StorageEvent). */
  logoutSignal: 'stella.im.logout',
  /** Cross-tab message bus used only in the no-SharedWorker fallback. */
  bus: 'stella.im.bus',
  /** Device-local colour theme. */
  theme: 'stella.im.theme',
  /** Device-local transport strategy: 'auto' (WS-first) or 'poll' (WS disabled). */
  transport: 'stella.im.transport',
  /** Device-local transport host: 'auto' | 'shared-worker' | 'in-tab'. */
  transportHost: 'stella.im.transport-host',
  /** Device-local sidebar width (px) set by the draggable splitter. */
  sidebarWidth: 'stella.im.sidebar-w',
  /** Device-local composer height (px) set by dragging its top edge. */
  composerHeight: 'stella.im.composer-h',
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
