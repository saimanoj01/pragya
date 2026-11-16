import type {
  Attachment,
  Book,
  DeltaLog,
  Note,
  PragyaSnapshot,
  ReadingSession,
  WorkspaceState,
} from '../types/pragya';

export function ensureLocalStorage(): void {
  try {
    if (typeof globalThis !== 'undefined' && typeof globalThis.localStorage === 'undefined') {
      const mem = new Map<string, string>();
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          get length() {
            return mem.size;
          },
          clear() {
            mem.clear();
          },
          getItem(key: string) {
            return mem.has(key) ? mem.get(key)! : null;
          },
          key(index: number) {
            return Array.from(mem.keys())[index] ?? null;
          },
          removeItem(key: string) {
            mem.delete(key);
          },
          setItem(key: string, value: string) {
            mem.set(key, String(value));
          },
        },
        configurable: true,
        writable: true,
      });
    }
  } catch {
    // Ignore if globalThis restricts definition
  }
}

ensureLocalStorage();

export type { WorkspaceState };

export interface StorageLoadOptions {
  forceRefresh?: boolean;
}

export interface SaveOptions {
  /**
   * `updatedAt` of the row as loaded on this device. Cloud adapters abort the
   * overwrite when the remote row is strictly newer (M4.9 conflict guard).
   */
  expectedBaseUpdatedAt?: string;
}

export interface StorageAdapter {
  loadWorkspace(options?: StorageLoadOptions): Promise<WorkspaceState>;
  saveBook(book: Book, options?: SaveOptions): Promise<Book>;
  saveNote(note: Note, options?: SaveOptions): Promise<Note>;
  saveSession(session: ReadingSession): Promise<ReadingSession>;
  saveDeltaLog(log: DeltaLog): Promise<DeltaLog>;
  replaceWorkspace(snapshot: PragyaSnapshot): Promise<WorkspaceState>;
  uploadImage?(
    blob: Blob,
    fileName: string,
    mimeType: string,
    width?: number,
    height?: number
  ): Promise<Attachment>;
  resolveDocTitle?(docId: string): Promise<string | null>;
  resetDemoData?(): Promise<WorkspaceState>;
}
