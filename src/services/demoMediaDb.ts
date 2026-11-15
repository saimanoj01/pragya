const DB_NAME = 'pragya-demo-media';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

const memoryBlobs = new Map<string, Blob>();

function openDemoMediaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

export async function saveDemoMediaBlob(id: string, blob: Blob): Promise<void> {
  memoryBlobs.set(id, blob);
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDemoMediaDb();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        db.close();
        fn();
      };
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(blob, id);
      tx.oncomplete = () => finish(() => resolve());
      tx.onerror = () => finish(() => reject(tx.error ?? new Error('Failed to store blob')));
      tx.onabort = () =>
        finish(() => reject(tx.error ?? new Error('Transaction aborted while storing blob')));
    });
  } catch {
    // Fallback to memoryBlobs already populated
  }
}

export async function getDemoMediaBlob(id: string): Promise<Blob | null> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openDemoMediaDb();
      const result = await new Promise<Blob | null>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          db.close();
          fn();
        };
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => finish(() => resolve((req.result as Blob | undefined) ?? null));
        req.onerror = () => finish(() => reject(req.error ?? new Error('Failed to read blob')));
        tx.onerror = () =>
          finish(() => reject(tx.error ?? new Error('Transaction error while reading blob')));
        tx.onabort = () =>
          finish(() => reject(tx.error ?? new Error('Transaction aborted while reading blob')));
      });
      if (result) return result;
    } catch {
      // Fallback to memoryBlobs
    }
  }
  return memoryBlobs.get(id) ?? null;
}

export async function clearDemoMedia(): Promise<void> {
  memoryBlobs.clear();
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDemoMediaDb();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        db.close();
        fn();
      };
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => finish(() => resolve());
      tx.onerror = () =>
        finish(() => reject(tx.error ?? new Error('Failed to clear IndexedDB')));
      tx.onabort = () =>
        finish(() => reject(tx.error ?? new Error('Transaction aborted while clearing IndexedDB')));
    });
  } catch {
    // Ignore cleanup errors
  }
}
