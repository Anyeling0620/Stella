import { STORAGE_KEYS } from '../config';

/**
 * Transport strategy — a *device* preference (like the theme), never sent to the
 * server:
 *   'auto' — prefer WebSocket; degrade to HTTP polling on failure (default).
 *   'poll' — disable WebSocket entirely; use HTTP incremental polling only.
 */
export type TransportMode = 'auto' | 'poll';

const coerce = (value: string | null | undefined): TransportMode => (value === 'poll' ? 'poll' : 'auto');

export function readStoredTransportMode(): TransportMode {
  try {
    return coerce(window.localStorage.getItem(STORAGE_KEYS.transport));
  } catch {
    return 'auto';
  }
}

export function writeStoredTransportMode(mode: TransportMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEYS.transport, mode);
  } catch {
    /* storage unavailable — the in-memory state still applies */
  }
}

/**
 * Transport *host* — who actually owns the single WebSocket:
 *   'auto'          — use SharedWorker when available, else the in-tab fallback.
 *   'shared-worker' — force one browser-wide SharedWorker to own the socket.
 *   'in-tab'        — force the preemptive single-active-tab (leader) mode; the
 *                     elected leader tab owns the socket and relays to the rest.
 */
export type TransportHost = 'auto' | 'shared-worker' | 'in-tab';

const coerceHost = (value: string | null | undefined): TransportHost =>
  value === 'shared-worker' || value === 'in-tab' ? value : 'auto';

export function readStoredTransportHost(): TransportHost {
  try {
    return coerceHost(window.localStorage.getItem(STORAGE_KEYS.transportHost));
  } catch {
    return 'auto';
  }
}

export function writeStoredTransportHost(host: TransportHost): void {
  try {
    window.localStorage.setItem(STORAGE_KEYS.transportHost, host);
  } catch {
    /* ignore */
  }
}
