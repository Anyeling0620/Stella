import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import { API, AUTH_FREE_PATHS, REQUEST_POLICY } from '../config';
import { session } from './session';
import type { SessionPayload } from '../types';

/**
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
function stableStringify(value: unknown): string {  // 这是一个将任意值转换为稳定的字符串表示的函数。它接收一个未知类型的值作为参数，并返回该值的字符串表示。函数会根据值的类型进行不同的处理：
  // - 如果值是undefined，返回字符串 "undefined"。
  // - 如果值是null或非对象类型，返回JSON字符串化后的结果。
  // - 如果值是数组，递归调用stableStringify对每个元素进行处理，并将结果拼接为一个数组字符串。
  // - 如果值是对象，获取对象的键并按字母顺序排序，然后递归调用stableStringify对每个键对应的值进行处理，并将结果拼接为一个对象字符串。
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
export function refreshAccessToken(): Promise<string> { // 这是一个用于刷新访问令牌的函数。它返回一个Promise，解析为新的访问令牌字符串。函数内部会检查是否已经有一个刷新请求正在进行，如果是，则返回该请求的Promise，以便并发调用者共享同一个网络请求和Promise，从而避免重复刷新。当没有正在进行的刷新请求时，它会调用 `performRefresh()` 函数执行实际的刷新操作，并在完成后将 `refreshInFlight` 重置为 null，以便下次调用可以触发新的刷新请求。
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
function jitterDelay(attempt: number): number { // 这是一个计算带有指数退避和随机抖动的延迟时间的函数。它接收当前尝试次数作为参数，并根据预定义的重试策略计算出一个延迟时间（毫秒）。该延迟时间在基础延迟和最大延迟之间随机分布，以避免多个并发请求在重试时同时发起，从而减轻服务器压力。
  const raw = Math.min(REQUEST_POLICY.retryMaxMs, REQUEST_POLICY.retryBaseMs * 2 ** attempt);
  const lower = raw * (1 - REQUEST_POLICY.jitter);
  return Math.round(lower + Math.random() * (raw - lower));
}

function sleep(ms: number, signal?: AxiosRequestConfig['signal']): Promise<void> { // 这是一个带有中断支持的异步延迟函数。它接收一个延迟时间（毫秒）和一个可选的AbortSignal对象作为参数，并返回一个Promise，在指定的延迟时间后解析。如果在延迟期间AbortSignal被触发，则Promise会被拒绝，并抛出一个DOMException，表示操作已中止。
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

async function executeWithRetry<T>(config: GovernedConfig, attempt: number): Promise<T> { // 这是一个执行带有重试机制的HTTP请求的函数。它接收一个Axios请求配置对象和当前尝试次数作为参数，并返回一个Promise，解析为请求的响应数据。函数内部会处理请求的发送、错误捕获、401状态码的刷新逻辑以及网络错误和5xx状态码的重试逻辑。
  try {
    return (await client.request(config)) as unknown as T;
  } catch (error) {
    if (isCancelError(error)) throw error;

    const status = statusOf(error);

    // --- 401: silent renewal then single replay ---------------------------
    const canRefresh = status === 401 && !config.__authRetried && !isAuthFree(config.url);  // 这是一个布尔值，表示是否可以尝试刷新访问令牌。它在以下条件下为真：
    // 1. 响应状态码为401（未授权），表示访问令牌可能已过期或无效。
    // 2. 请求配置对象中没有标记为已重试（`__authRetried`为false），以避免无限循环刷新。
    // 3. 请求的URL不在免认证路径列表中（`isAuthFree(config.url)`返回false），确保只有需要认证的请求才会触发刷新逻辑。
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

const inflight = new Map<string, InflightEntry>(); // 这是一个用于跟踪当前正在进行的HTTP请求的映射对象。它的键是请求的指纹（由请求方法、URL、参数和数据生成的唯一字符串），值是一个包含请求控制器、Promise对象和请求开始时间的对象。这个映射用于实现请求去重和取消功能，以避免重复发送相同的请求并管理并发请求。

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
    const release = await semaphore.acquire(); // 这是一个异步操作，用于获取并发控制器的许可。它会等待直到有可用的许可，然后返回一个释放函数（`release`），用于在请求完成后释放许可，以便其他请求可以继续执行。这个机制确保了同时进行的HTTP请求数量不会超过预定义的最大并发限制，从而保护浏览器的连接资源。
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

/**
 * Multipart upload with progress.
 *
 * Deliberately bypasses the governed `request()` path: its fingerprint-based
 * dedup would merge two rapid uploads (FormData serialises to an empty
 * fingerprint), and its JSON Content-Type default would clobber the multipart
 * boundary. Token injection, the 401 single-flight refresh, and error
 * normalisation are still reused so behaviour matches the rest of the app.
 */
export async function uploadFile<T = unknown>(
  url: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<T> {
  const post = (token: string | null) => {
    const form = new FormData();
    form.append('file', file);
    return axios.post(`${API.base}${url}`, form, {
      // No explicit Content-Type: the browser adds the multipart boundary.
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      onUploadProgress: (event) => {
        if (onProgress && event.total) onProgress(Math.round((event.loaded / event.total) * 100));
      },
      timeout: 120_000,
    });
  };

  const unwrap = (response: Awaited<ReturnType<typeof post>>): T => {
    const payload = response.data as { ok?: boolean; data?: T; code?: string; message?: string };
    if (payload && typeof payload === 'object' && payload.ok === false) {
      throw new ApiError(response.status, payload.code ?? 'ERROR', payload.message ?? '上传失败');
    }
    return payload.data as T;
  };

  try {
    return unwrap(await post(session.getAccessToken()));
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status === 401) {
      // One silent renewal, then a single replay (mirrors executeWithRetry).
      const token = await refreshAccessToken();
      return unwrap(await post(token));
    }
    throw normalizeError(error);
  }
}
