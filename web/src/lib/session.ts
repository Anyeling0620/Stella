import { STORAGE_KEYS } from '../config';
import { readJSON, writeJSON, removeKey, uid } from './storage';
import type { SessionPayload, StoredSession, User } from '../types';

/**
 * Global session manager.
 *
 * Security model (chapter 15 of the checklist):
 *   - The **refresh token** lives in an HttpOnly cookie owned by the server and
 *     is never visible to JavaScript.
 *   - The **access token** lives in a module-level variable (memory only) — it
 *     is never written to localStorage, so an XSS cannot exfiltrate it.
 *   - localStorage keeps only a **user hint** (`{ user }`) so a reload knows to
 *     attempt a silent refresh instead of flashing the login page.
 *
 * Cross-tab "one logout logs out every tab" still works via a StorageEvent.
 */
let hint: StoredSession | null | undefined;
let accessToken: string | null = null;
let accessExpiresAt = 0;

function loadHint(): StoredSession | null {
  if (hint !== undefined) return hint;
  const stored = readJSON<StoredSession | null>(STORAGE_KEYS.session, null);
  hint = stored && stored.user ? stored : null;
  return hint;
}

export const session = {
  getUser(): User | null {
    return loadHint()?.user ?? null;
  },

  /** True when a persisted login hint exists (used to trigger a boot refresh). */
  hasUserHint(): boolean {
    return !!loadHint()?.user;
  },

  /**
   * Routing convenience: a hint OR a live access token.
   * Real authority always comes from the server (a 401 triggers a refresh or a
   * logout) — this only decides whether to render the shell or the login form.
   */
  isAuthenticated(): boolean {
    return !!accessToken || !!loadHint()?.user;
  },

  getAccessToken(): string | null {
    return accessToken;
  },

  /** Persists a brand new login/registration payload (access token stays in memory). */
  set(payload: SessionPayload): StoredSession {
    accessToken = payload.accessToken;
    accessExpiresAt = Date.now() + payload.expiresIn * 1000;
    const next: StoredSession = { user: payload.user };
    hint = next;
    writeJSON(STORAGE_KEYS.session, next);
    return next;
  },

  /** Applies a silently-refreshed access token without touching the user hint. */
  setAccessToken(token: string, expiresIn: number): void {
    accessToken = token;
    accessExpiresAt = Date.now() + expiresIn * 1000;
  },

  clear(): void {
    hint = null;
    accessToken = null;
    accessExpiresAt = 0;
    removeKey(STORAGE_KEYS.session);
  },

  /**
   * Merges a partial profile into the persisted user hint (nickname / avatar /
   * bio edits). Kept separate from `set()` because that one requires a token.
   */
  updateUser(patch: Partial<User>): User | null {
    const current = loadHint();
    if (!current) return null;
    const next: StoredSession = { ...current, user: { ...current.user, ...patch } };
    hint = next;
    writeJSON(STORAGE_KEYS.session, next);
    return next.user;
  },

  /** True when the access token is missing, expired, or about to expire. */
  isAccessExpiring(skewMs = 15_000): boolean {
    if (!accessToken) return true;
    return Date.now() >= accessExpiresAt - skewMs;
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
