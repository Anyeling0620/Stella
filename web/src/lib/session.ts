import { STORAGE_KEYS } from '../config';
import { readJSON, writeJSON, removeKey, uid } from './storage';
import type { SessionPayload, StoredSession, User } from '../types';

/**
 * Global session manager.
 *
 * Owns the single source of truth for the persisted session and implements
 * "one logout logs out every tab" via a StorageEvent signal.
 */
let cache: StoredSession | null | undefined;

function load(): StoredSession | null {
  if (cache !== undefined) return cache;
  const stored = readJSON<StoredSession | null>(STORAGE_KEYS.session, null);
  if (!stored || typeof stored.accessToken !== 'string' || !stored.user) {
    cache = null;
    return cache;
  }
  cache = stored;
  return cache;
}

export const session = {
  get(): StoredSession | null {
    return load();
  },

  getUser(): User | null {
    return load()?.user ?? null;
  },

  isAuthenticated(): boolean {
    const current = load();
    return !!current?.accessToken && !!current?.refreshToken;
  },

  /** Persists a brand new login/registration payload. */
  set(payload: SessionPayload): StoredSession {
    const next: StoredSession = {
      user: payload.user,
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      accessExpiresAt: Date.now() + payload.expiresIn * 1000,
    };
    cache = next;
    writeJSON(STORAGE_KEYS.session, next);
    return next;
  },

  clear(): void {
    cache = null;
    removeKey(STORAGE_KEYS.session);
  },

  /**
   * Merges a partial profile into the persisted user (nickname / avatar edits).
   * Kept separate from `set()` because that one requires a fresh token pair.
   */
  updateUser(patch: Partial<User>): User | null {
    const current = load();
    if (!current) return null;
    const next: StoredSession = { ...current, user: { ...current.user, ...patch } };
    cache = next;
    writeJSON(STORAGE_KEYS.session, next);
    return next.user;
  },

  getAccessToken(): string | null {
    return load()?.accessToken ?? null;
  },

  getRefreshToken(): string | null {
    return load()?.refreshToken ?? null;
  },

  /** True when the access token is expired or about to expire. */
  isAccessExpiring(skewMs = 15_000): boolean {
    const current = load();
    if (!current) return true;
    return Date.now() >= current.accessExpiresAt - skewMs;
  },
};

// ---------------------------------------------------------------------------
// Cross-tab global logout
// ---------------------------------------------------------------------------
interface LogoutSignal {
  at: number;
  by: string;
  nonce: string;
}

/**
 * Publishes the logout signal. Every *other* tab reacts and goes offline too.
 * A unique nonce is written so the storage event always fires.
 */
export function broadcastLogout(): void {
  writeJSON(STORAGE_KEYS.logoutSignal, { at: Date.now(), by: uid(), nonce: uid() } satisfies LogoutSignal);
}

/** Subscribes to logout signals produced by sibling tabs. */
export function initCrossTabLogout(onLogout: (signal: LogoutSignal) => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEYS.logoutSignal || !event.newValue) return;
    try {
      onLogout(JSON.parse(event.newValue) as LogoutSignal);
    } catch {
      onLogout({ at: Date.now(), by: 'unknown', nonce: '' });
    }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
