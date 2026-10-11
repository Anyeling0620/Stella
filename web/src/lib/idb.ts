/**
 * Minimal IndexedDB key/value cache (chapter 13).
 *
 * Web local storage is NOT reliable as a source of truth — browsers may evict it
 * under pressure. It is used only as a best-effort cache for a fast first paint;
 * the server remains authoritative. Every write therefore swallows / reports
 * `QuotaExceededError` instead of breaking the caller.
 */
const DB_NAME = 'stella-im';
const STORE = 'kv';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Best-effort write. Returns false when the write failed (e.g. quota). */
export async function idbPut(key: string, value: unknown): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(value, key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export const idbGet = <T>(key: string): Promise<T | null> => tx<T>('readonly', (store) => store.get(key) as IDBRequest<T>);

export async function idbDelete(key: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(key) as IDBRequest<undefined>);
}

export async function idbClear(): Promise<void> {
  await tx('readwrite', (store) => store.clear() as IDBRequest<undefined>);
}

/** navigator.storage.estimate() wrapped (null when unsupported). */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
