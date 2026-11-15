import type {
  Attachment,
  Book,
  DeltaLog,
  Note,
  PragyaSnapshot,
  ReadingSession,
  WorkspaceState,
} from '../types/pragya';
import { createDemoSeed } from '../data/demoSeed';
import { createUuid } from '../utils/sessionCoalesce';
import { clearDemoMedia, saveDemoMediaBlob } from './demoMediaDb';
import type { StorageAdapter } from './storage';

export const DEMO_STATE_STORAGE_KEY = 'pragya_demo_state_v1';

function readDemoState(): WorkspaceState | null {
  try {
    const raw = localStorage.getItem(DEMO_STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkspaceState>;
    if (
      Array.isArray(parsed.books) &&
      Array.isArray(parsed.notes) &&
      Array.isArray(parsed.sessions) &&
      Array.isArray(parsed.deltaLogs)
    ) {
      return {
        books: parsed.books,
        notes: parsed.notes,
        sessions: parsed.sessions,
        deltaLogs: parsed.deltaLogs,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeDemoState(state: WorkspaceState): void {
  localStorage.setItem(
    DEMO_STATE_STORAGE_KEY,
    JSON.stringify({
      books: state.books,
      notes: state.notes,
      sessions: state.sessions,
      deltaLogs: state.deltaLogs,
    })
  );
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const idx = items.findIndex(item => item.id === next.id);
  if (idx >= 0) {
    const copy = [...items];
    copy[idx] = next;
    return copy;
  }
  return [...items, next];
}

export class DemoStorageAdapter implements StorageAdapter {
  private ensureState(): WorkspaceState {
    const existing = readDemoState();
    if (existing) return existing;
    const seeded = createDemoSeed();
    writeDemoState(seeded);
    return seeded;
  }

  async loadWorkspace(): Promise<WorkspaceState> {
    return this.ensureState();
  }

  async saveBook(book: Book): Promise<Book> {
    const state = this.ensureState();
    state.books = upsertById(state.books, book);
    writeDemoState(state);
    return book;
  }

  async saveNote(note: Note): Promise<Note> {
    const state = this.ensureState();
    state.notes = upsertById(state.notes, note);
    writeDemoState(state);
    return note;
  }

  async saveSession(session: ReadingSession): Promise<ReadingSession> {
    const state = this.ensureState();
    state.sessions = upsertById(state.sessions, session);
    writeDemoState(state);
    return session;
  }

  async saveDeltaLog(log: DeltaLog): Promise<DeltaLog> {
    const state = this.ensureState();
    state.deltaLogs = upsertById(state.deltaLogs, log);
    writeDemoState(state);
    return log;
  }

  async replaceWorkspace(snapshot: PragyaSnapshot): Promise<WorkspaceState> {
    const next: WorkspaceState = {
      books: [...snapshot.books],
      notes: [...snapshot.notes],
      sessions: [...snapshot.sessions],
      deltaLogs: [...snapshot.deltaLogs],
    };
    writeDemoState(next);
    return next;
  }

  async uploadImage(
    blob: Blob,
    fileName: string,
    mimeType: string,
    width?: number,
    height?: number
  ): Promise<Attachment> {
    const demoMediaId = createUuid();
    await saveDemoMediaBlob(demoMediaId, blob);
    return {
      id: createUuid(),
      type: 'image',
      demoMediaId,
      fileName,
      mimeType,
      width,
      height,
    };
  }

  async resetDemoData(): Promise<WorkspaceState> {
    await clearDemoMedia();
    const fresh = createDemoSeed();
    writeDemoState(fresh);
    return fresh;
  }
}
