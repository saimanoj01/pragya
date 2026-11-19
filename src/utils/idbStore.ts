/**
 * Lightweight IndexedDB key-value store for large local workspace caches and pre-import
 * backups (`pragya_sheets_cache_v1`, `pragya_pre_import_backup_v1`).
 *
 * Storage tiers & resilience:
 *  1. Browser with IndexedDB: `pragya-cache` (v1), object store `kv` (string values).
 *     One-time transparent migration copies any legacy `localStorage` entry into IDB
 *     verbatim and removes the `localStorage` key ONLY after the IDB write succeeds.
 *  2. IndexedDB unavailable / blocked / quota error (Node tests, Safari private mode):
 *     falls back to `localStorage`.
 *  3. Both IndexedDB and `localStorage` fail (quota exceeded): falls back to an in-memory
 *     Map so the app never crashes.
 *
 * All async operations serialize through a single FIFO queue so a fire-and-forget delete
 * (e.g. from synchronous account-switch cleanup) is guaranteed to finish before any
 * subsequent read from IndexedDB.
 */

export const IDB_CACHE_DB_NAME = 'pragya-cache';
export const IDB_CACHE_DB_VERSION = 1;
export const IDB_CACHE_STORE_NAME = 'kv';

export interface IdbFactoryLike {
  open(name: string, version?: number): IDBOpenDBRequest;
}

const memoryFallback = new Map<string, string>();
const fallbackLocalStorageKeys = new Set<string>();
let idbFactoryOverride: IdbFactoryLike | null | undefined = undefined;
let opQueue: Promise<unknown> = Promise.resolve();

function resolveIdbFactory(): IdbFactoryLike | null {
  if (idbFactoryOverride !== undefined) return idbFactoryOverride;
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB && typeof indexedDB.open === 'function') {
      return indexedDB;
    }
  } catch {
    // Accessing indexedDB in restricted iframes / Safari private contexts can throw.
  }
  return null;
}

/** Test hook: inject a fake IDBFactory, `null` (simulate blocked IDB), or `undefined` (restore). */
export function setIndexedDbForTests(factory: IdbFactoryLike | null | undefined): void {
  idbFactoryOverride = factory;
}

/** Test hook: clear in-memory fallback and reset queue/factory override. */
export function resetIdbStoreForTests(): void {
  memoryFallback.clear();
  fallbackLocalStorageKeys.clear();
  idbFactoryOverride = undefined;
  opQueue = Promise.resolve();
}

export function isIndexedDbAvailable(): boolean {
  return resolveIdbFactory() !== null;
}

function safeLocalStorageGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, value);
    fallbackLocalStorageKeys.add(key);
    return true;
  } catch {
    return false;
  }
}

function safeLocalStorageRemove(key: string): void {
  fallbackLocalStorageKeys.delete(key);
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  } catch {
    // Ignore restricted storage errors
  }
}

function clearTrackedFallbackLocalStorage(): void {
  if (fallbackLocalStorageKeys.size === 0) return;
  for (const key of Array.from(fallbackLocalStorageKeys)) {
    safeLocalStorageRemove(key);
  }
}

function enqueueOp<T>(task: () => Promise<T>): Promise<T> {
  const next = opQueue.catch(() => {}).then(task);
  opQueue = next;
  return next;
}

/** Wait until all previously enqueued IndexedDB reads/writes/deletes settle. */
export function flushIdbQueue(): Promise<void> {
  return opQueue.catch(() => {}).then(() => undefined);
}

function openCacheDb(factory: IdbFactoryLike): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(IDB_CACHE_DB_NAME, IDB_CACHE_DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to open IndexedDB'));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_CACHE_STORE_NAME)) {
        db.createObjectStore(IDB_CACHE_STORE_NAME);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          // Ignore close errors
        }
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

async function rawIdbGet(factory: IdbFactoryLike, key: string): Promise<string | null> {
  const db = await openCacheDb(factory);
  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
      fn();
    };
    try {
      const tx = db.transaction(IDB_CACHE_STORE_NAME, 'readonly');
      const req = tx.objectStore(IDB_CACHE_STORE_NAME).get(key);
      req.onsuccess = () => {
        const result = req.result;
        finish(() => resolve(typeof result === 'string' ? result : null));
      };
      req.onerror = () => finish(() => reject(req.error ?? new Error('Failed to read from IndexedDB')));
      tx.onerror = () => finish(() => reject(tx.error ?? new Error('IndexedDB read transaction error')));
      tx.onabort = () => finish(() => reject(tx.error ?? new Error('IndexedDB read transaction aborted')));
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error('Failed to start IndexedDB read')));
    }
  });
}

async function rawIdbPut(factory: IdbFactoryLike, key: string, value: string): Promise<void> {
  const db = await openCacheDb(factory);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
      fn();
    };
    try {
      const tx = db.transaction(IDB_CACHE_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_CACHE_STORE_NAME).put(value, key);
      tx.oncomplete = () => finish(() => resolve());
      tx.onerror = () => finish(() => reject(tx.error ?? new Error('Failed to write to IndexedDB')));
      tx.onabort = () => finish(() => reject(tx.error ?? new Error('IndexedDB write transaction aborted')));
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error('Failed to start IndexedDB write')));
    }
  });
}

async function rawIdbDelete(factory: IdbFactoryLike, key: string): Promise<void> {
  const db = await openCacheDb(factory);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
      fn();
    };
    try {
      const tx = db.transaction(IDB_CACHE_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_CACHE_STORE_NAME).delete(key);
      tx.oncomplete = () => finish(() => resolve());
      tx.onerror = () => finish(() => reject(tx.error ?? new Error('Failed to delete from IndexedDB')));
      tx.onabort = () => finish(() => reject(tx.error ?? new Error('IndexedDB delete transaction aborted')));
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error('Failed to start IndexedDB delete')));
    }
  });
}

async function rawIdbClear(factory: IdbFactoryLike): Promise<void> {
  const db = await openCacheDb(factory);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
      fn();
    };
    try {
      const tx = db.transaction(IDB_CACHE_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_CACHE_STORE_NAME).clear();
      tx.oncomplete = () => finish(() => resolve());
      tx.onerror = () => finish(() => reject(tx.error ?? new Error('Failed to clear IndexedDB')));
      tx.onabort = () => finish(() => reject(tx.error ?? new Error('IndexedDB clear transaction aborted')));
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error('Failed to start IndexedDB clear')));
    }
  });
}

/**
 * Read a string value from IndexedDB (falling back to `localStorage` / memory).
 * Prefer {@link idbGetWithMigration} for keys that previously lived in `localStorage`.
 */
export function idbGet(key: string): Promise<string | null> {
  return enqueueOp(async () => {
    if (memoryFallback.has(key)) return memoryFallback.get(key) ?? null;
    const lsVal = safeLocalStorageGet(key);
    if (lsVal !== null) return lsVal;
    const factory = resolveIdbFactory();
    if (factory) {
      try {
        return await rawIdbGet(factory, key);
      } catch {
        // Fall through to null
      }
    }
    return null;
  });
}

/**
 * Read a string value with automatic one-time migration from `localStorage` → IndexedDB.
 * If a legacy `localStorage` entry exists and IndexedDB is available, it is copied verbatim
 * into IndexedDB and removed from `localStorage` ONLY after the IDB write succeeds.
 */
export function idbGetWithMigration(key: string): Promise<string | null> {
  return enqueueOp(async () => {
    if (memoryFallback.has(key)) return memoryFallback.get(key) ?? null;

    const factory = resolveIdbFactory();
    const legacy = safeLocalStorageGet(key);

    if (factory) {
      if (legacy !== null) {
        try {
          await rawIdbPut(factory, key, legacy);
          safeLocalStorageRemove(key);
          memoryFallback.delete(key);
        } catch {
          // IDB unavailable/full: keep legacy in localStorage so nothing is lost.
        }
        return legacy;
      }
      try {
        return await rawIdbGet(factory, key);
      } catch {
        return null;
      }
    }

    return legacy;
  });
}

export interface IdbSetOptions {
  /**
   * Optional predicate re-checked right inside the serialized queue before committing to
   * IndexedDB / fallback storage (prevents late in-flight writes from resurrecting cache
   * after logout or account switch).
   */
  shouldWrite?: () => boolean;
}

/**
 * Write a string value to IndexedDB (removing any stale legacy `localStorage` copy on
 * success). Falls back to `localStorage`, and finally to in-memory storage on quota error.
 */
export function idbSet(
  key: string,
  value: string,
  options?: IdbSetOptions
): Promise<boolean> {
  return enqueueOp(async () => {
    if (options?.shouldWrite && !options.shouldWrite()) {
      return false;
    }
    const factory = resolveIdbFactory();
    if (factory) {
      try {
        await rawIdbPut(factory, key, value);
        safeLocalStorageRemove(key);
        memoryFallback.delete(key);
        return true;
      } catch {
        // IDB blocked or quota exceeded — fall through to localStorage / memory.
      }
    }
    if (options?.shouldWrite && !options.shouldWrite()) {
      return false;
    }
    if (safeLocalStorageSet(key, value)) {
      memoryFallback.delete(key);
      return true;
    }
    memoryFallback.set(key, value);
    return true;
  });
}

/**
 * Delete a key from all tiers (`localStorage` + memory synchronously, IndexedDB queued).
 */
export function idbDelete(key: string): Promise<void> {
  memoryFallback.delete(key);
  safeLocalStorageRemove(key);
  return enqueueOp(async () => {
    memoryFallback.delete(key);
    safeLocalStorageRemove(key);
    const factory = resolveIdbFactory();
    if (!factory) return;
    try {
      await rawIdbDelete(factory, key);
    } catch {
      // Ignore cleanup errors when IDB is blocked or unavailable
    }
  });
}

/**
 * Clear the entire IndexedDB `kv` store, tracked `localStorage` fallback keys, and in-memory fallback.
 */
export function idbClear(): Promise<void> {
  memoryFallback.clear();
  clearTrackedFallbackLocalStorage();
  return enqueueOp(async () => {
    memoryFallback.clear();
    clearTrackedFallbackLocalStorage();
    const factory = resolveIdbFactory();
    if (!factory) return;
    try {
      await rawIdbClear(factory);
    } catch {
      // Ignore cleanup errors
    }
  });
}
