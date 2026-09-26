import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import { API, AUTH_FREE_PATHS, REQUEST_POLICY } from '../config';
import { session } from './session';
import type { SessionPayload } from '../types';

/**
 * ============================================================================
 * Enterprise request governance
 * ============================================================================
 * Every HTTP call in the application goes through `api.*`. The layer provides:
 *
 *   1. unified token injection + response unwrapping (interceptors)
 *   2. request fingerprinting -> race cancellation for reads
 *   3. duplicate suppression -> identical mutations merged within a window
 *   4. a concurrency limiter protecting the browser connection budget
 *   5. silent 401 refresh: single-flight renewal, queued replay, global logout
 *      on failure
 *   6. automatic retry with exponential backoff + random jitter for network
 *      errors and 5xx only (never for 4xx business errors)
 *
 * It is completely standalone: it imports nothing from the UI or the realtime
 * layer except a tiny hook registry used to notify them of token changes.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const isCancelError = (error: unknown): boolean =>
  axios.isCancel(error) || (error instanceof DOMException && error.name === 'AbortError');

function statusOf(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status || undefined;
  if (axios.isAxiosError(error)) return error.response?.status;
  return undefined;
}

export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{ code?: string; message?: string; details?: unknown }>;
    const status = axiosError.response?.status ?? 0;
    const payload = axiosError.response?.data;
    const code =
      payload?.code ??
      (axiosError.code === 'ECONNABORTED'
        ? 'TIMEOUT'
        : status > 0
          ? `HTTP_${status}`
          : 'NETWORK_ERROR');
    const message =
      payload?.message ?? (status > 0 ? `请求失败（${status}）` : '网络异常，请检查网络连接后重试');
    return new ApiError(status, code, message, payload?.details);
  }
  if (error instanceof Error) return new ApiError(0, 'UNKNOWN', error.message);
  return new ApiError(0, 'UNKNOWN', '未知错误');
}

// ---------------------------------------------------------------------------
// Auth hooks — decouples this module from React
// ---------------------------------------------------------------------------
interface AuthHooks {
  onRefreshed?: (accessToken: string, session: SessionPayload | null) => void;
  onExpired?: (code: string) => void;
}

let authHooks: AuthHooks = {};

export function setAuthHooks(hooks: AuthHooks): void {
  authHooks = hooks;
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function fingerprint(config: AxiosRequestConfig): string {
  const method = (config.method ?? 'get').toLowerCase();
  return [method, config.url ?? '', stableStringify(config.params), stableStringify(config.data)].join('|');
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------
type Release = () => void;

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<Release> {
    return new Promise<Release>((resolve) => {
      const grant = () => {
        this.active += 1;
        resolve(() => {
          this.active -= 1;
          const next = this.waiters.shift();
          if (next) next();
        });
      };
      if (this.active < this.max) grant();
      else this.waiters.push(grant);
    });
  }
}

const semaphore = new Semaphore(REQUEST_POLICY.maxConcurrent);

// ---------------------------------------------------------------------------
// Axios instance
// ---------------------------------------------------------------------------
const isAuthFree = (url?: string): boolean =>
  !!url && AUTH_FREE_PATHS.some((path) => url.includes(path));

const client: AxiosInstance = axios.create({
  baseURL: API.base,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
  // We surface non-2xx ourselves so retry/refresh logic can inspect them.
  validateStatus: (status) => status >= 200 && status < 300,
});

client.interceptors.request.use((config) => {
  const token = session.getAccessToken();
  if (token && !isAuthFree(config.url)) {
    config.headers.set?.('Authorization', `Bearer ${token}`);
  }
  return config;
});

client.interceptors.response.use(
  (response) => {
    const payload = response.data;
    // Uniform { ok, data } envelope -> unwrap to `data`.
    if (payload && typeof payload === 'object' && 'ok' in payload) {
      const envelope = payload as { ok: boolean; data?: unknown; code?: string; message?: string; details?: unknown };
      if (envelope.ok === false) {
        throw new ApiError(response.status, envelope.code ?? 'ERROR', envelope.message ?? '请求失败', envelope.details);
      }
      return envelope.data as never;
    }
    return payload as never;
  },
  (error) => Promise.reject(error)
);

// ---------------------------------------------------------------------------
// Silent 401 refresh (single-flight)
// ---------------------------------------------------------------------------
const rawClient: AxiosInstance = axios.create({ baseURL: API.base, timeout: 15_000 });

let refreshInFlight: Promise<string> | null = null;

/**
 * Renews the access token. Concurrent callers share one network request and one
 * promise, so N parallel 401s trigger exactly one refresh and then replay.
 */
export function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function performRefresh(): Promise<string> {
  const refreshToken = session.getRefreshToken();
  if (!refreshToken) {
    expireSession('NO_REFRESH_TOKEN');
    throw new ApiError(401, 'NO_REFRESH_TOKEN', '登录状态已失效，请重新登录');
  }

  try {
    const response = await rawClient.post('/api/auth/refresh', { refreshToken });
    const payload = response.data as { ok: boolean; data?: SessionPayload; code?: string; message?: string };
    if (!payload?.ok || !payload.data) {
      throw new ApiError(401, payload?.code ?? 'REFRESH_FAILED', payload?.message ?? '刷新登录状态失败');
    }
    const next = payload.data;
    session.set(next);
    authHooks.onRefreshed?.(next.accessToken, next);
    return next.accessToken;
  } catch (error) {
    const normalized = normalizeError(error);
    expireSession(normalized.code);
    throw normalized;
  }
}

function expireSession(code: string): void {
  session.clear();
  authHooks.onExpired?.(code);
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff + jitter
// ---------------------------------------------------------------------------
function jitterDelay(attempt: number): number {
  const raw = Math.min(REQUEST_POLICY.retryMaxMs, REQUEST_POLICY.retryBaseMs * 2 ** attempt);
  const lower = raw * (1 - REQUEST_POLICY.jitter);
  return Math.round(lower + Math.random() * (raw - lower));
}

function sleep(ms: number, signal?: AxiosRequestConfig['signal']): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort);
  });
}

interface GovernedConfig extends AxiosRequestConfig {
  __authRetried?: boolean;
}

async function executeWithRetry<T>(config: GovernedConfig, attempt: number): Promise<T> {
  try {
    return (await client.request(config)) as unknown as T;
  } catch (error) {
    if (isCancelError(error)) throw error;

    const status = statusOf(error);

    // --- 401: silent renewal then single replay ---------------------------
    const canRefresh = status === 401 && !config.__authRetried && !isAuthFree(config.url);
    if (canRefresh) {
      config.__authRetried = true;
      const token = await refreshAccessToken();
      config.headers = {
        ...(config.headers as Record<string, unknown>),
        Authorization: `Bearer ${token}`,
      } as typeof config.headers;
      return executeWithRetry<T>(config, attempt);
    }

    // --- retryable? network failure or 5xx only ---------------------------
    const retriable = status === undefined || (status >= 500 && status <= 599);
    if (retriable && attempt < REQUEST_POLICY.retryMax) {
      await sleep(jitterDelay(attempt), config.signal);
      return executeWithRetry<T>(config, attempt + 1);
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Public request entry point
// ---------------------------------------------------------------------------
interface InflightEntry {
  controller: AbortController;
  promise: Promise<unknown>;
  startedAt: number;
}

const inflight = new Map<string, InflightEntry>();

function linkAbort(source: AxiosRequestConfig['signal'], controller: AbortController): void {
  if (!source) return;
  if (source.aborted) {
    controller.abort();
    return;
  }
  source.addEventListener?.('abort', () => controller.abort());
}

export function request<T = unknown>(config: AxiosRequestConfig): Promise<T> {
  const method = (config.method ?? 'get').toLowerCase();
  const isRead = method === 'get' || method === 'head';
  const key = fingerprint({ ...config, method });

  const existing = inflight.get(key);
  if (existing) {
    if (!isRead && Date.now() - existing.startedAt <= REQUEST_POLICY.dedupWindowMs) {
      // Duplicate mutation inside the window -> merge onto the in-flight call.
      return existing.promise as Promise<T>;
    }
    // Otherwise the previous attempt is superseded: cancel it (race elimination).
    existing.controller.abort();
  }

  const controller = new AbortController();
  linkAbort(config.signal, controller);

  const entry: InflightEntry = {
    controller,
    startedAt: Date.now(),
    promise: Promise.resolve() as Promise<unknown>,
  };

  entry.promise = (async () => {
    const release = await semaphore.acquire();
    try {
      return await executeWithRetry<T>(
        { ...config, method, signal: controller.signal } as GovernedConfig,
        0
      );
    } catch (error) {
      if (isCancelError(error)) throw error;
      throw normalizeError(error);
    } finally {
      release();
      if (inflight.get(key) === entry) inflight.delete(key);
    }
  })();

  inflight.set(key, entry);
  return entry.promise as Promise<T>;
}

export const api = {
  get: <T = unknown>(url: string, config: AxiosRequestConfig = {}) => request<T>({ ...config, url, method: 'get' }),
  post: <T = unknown>(url: string, data?: unknown, config: AxiosRequestConfig = {}) =>
    request<T>({ ...config, url, method: 'post', data }),
  patch: <T = unknown>(url: string, data?: unknown, config: AxiosRequestConfig = {}) =>
    request<T>({ ...config, url, method: 'patch', data }),
  del: <T = unknown>(url: string, config: AxiosRequestConfig = {}) =>
    request<T>({ ...config, url, method: 'delete' }),
};
