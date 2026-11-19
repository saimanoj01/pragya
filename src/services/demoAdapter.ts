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
import type {
  BatchMutationOp,
  BatchMutationResult,
  DeleteCascadeOptions,
  RestoreRowsInput,
  StorageAdapter,
} from './storage';
import {
  NotArchivedError,
  type DeleteCascadeResult,
  type DeleteRowsPlan,
  type RestoreRowsResult,
} from '../utils/deletePlan';
import { isArchived } from '../utils/archive';
import { normalizeBatchOps } from '../utils/batchPlan';

export const DEMO_STATE_STORAGE_KEY = 'pragya_demo_state_v1';

/**
 * QA-10: hand-edited / corrupt demo state must not crash every route. Only the
 * collection fields that list/search/palette code iterates are made safe here; the
 * rest of the note is kept verbatim (deeper validation stays with the views).
 */
function sanitizeDemoNote(note: Note): Note {
  if (!note || typeof note !== 'object') return note;
  const rawTags = (note as { tags?: unknown }).tags;
  const tags = Array.isArray(rawTags) ? rawTags.filter((t): t is string => typeof t === 'string') : [];
  const rawMeta = (note as { meta?: unknown }).meta;
  const meta =
    rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
      ? (rawMeta as Note['meta'])
      : ({ attachments: [], links: [] } as Note['meta']);
  return {
    ...note,
    tags,
    meta: {
      ...meta,
      attachments: Array.isArray(meta.attachments) ? meta.attachments : [],
      links: Array.isArray(meta.links) ? meta.links.filter(l => typeof l === 'string') : [],
    },
  };
}

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
        notes: parsed.notes.map(sanitizeDemoNote),
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

  async batchCommitMutations(ops: BatchMutationOp[]): Promise<BatchMutationResult> {
    const result: BatchMutationResult = { books: [], notes: [], sessions: [], deltaLogs: [] };
    if (ops.length === 0) return result;
    const state = this.ensureState();
    for (const item of normalizeBatchOps(ops)) {
      const { op } = item;
      if (op.kind === 'book') {
        state.books = upsertById(state.books, op.book);
        result.books.push(op.book);
      } else if (op.kind === 'note') {
        state.notes = upsertById(state.notes, op.note);
        result.notes.push(op.note);
      } else if (op.kind === 'session') {
        state.sessions = upsertById(state.sessions, op.session);
        result.sessions.push(op.session);
      } else {
        state.deltaLogs = upsertById(state.deltaLogs, op.deltaLog);
        result.deltaLogs.push(op.deltaLog);
      }
    }
    writeDemoState(state);
    return result;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const state = this.ensureState();
    const next = state.sessions.filter(s => s.id !== sessionId);
    if (next.length !== state.sessions.length) {
      state.sessions = next;
      writeDemoState(state);
    }
  }

  async deleteRowsCascade(plan: DeleteRowsPlan, options: DeleteCascadeOptions = {}): Promise<DeleteCascadeResult> {
    const state = this.ensureState();
    // Parity with the Sheets adapter: the target must still be archived (QA-30), and the
    // whole cascade applies at once (a single state write).
    const target = options.target;
    if (target) {
      const row =
        target.kind === 'book'
          ? state.books.find(b => b.id === target.id)
          : state.notes.find(n => n.id === target.id);
      if (row && !isArchived(row)) throw new NotArchivedError(target.kind);
    }
    const drop = <T extends { id: string }>(list: T[], ids: string[]) => {
      const set = new Set(ids);
      return list.filter(x => !set.has(x.id));
    };
    state.deltaLogs = drop(state.deltaLogs, plan.deltaLogIds);
    state.sessions = drop(state.sessions, plan.sessionIds);
    state.notes = drop(state.notes, plan.noteIds);
    state.books = drop(state.books, plan.bookIds);
    writeDemoState(state);
    // Local state can't shift under us (no concurrent devices), so nothing to repair.
    return { repaired: 0, stillPresent: [] };
  }

  async appendRowsIfAbsent(rows: RestoreRowsInput): Promise<RestoreRowsResult> {
    const state = this.ensureState();
    const result: RestoreRowsResult = { restored: { books: [], notes: [], sessions: [], deltaLogs: [] }, skipped: 0 };
    const add = <T extends { id: string }>(list: T[], items: T[], key: keyof RestoreRowsResult['restored']) => {
      const present = new Set(list.map(x => x.id));
      const absent = items.filter(x => !present.has(x.id));
      result.skipped += items.length - absent.length;
      result.restored[key] = absent.map(x => x.id);
      return [...list, ...absent];
    };
    state.books = add(state.books, rows.books, 'books');
    state.notes = add(state.notes, rows.notes, 'notes');
    state.sessions = add(state.sessions, rows.sessions, 'sessions');
    state.deltaLogs = add(state.deltaLogs, rows.deltaLogs, 'deltaLogs');
    writeDemoState(state);
    return result;
  }

  async loadSessions(): Promise<ReadingSession[]> {
    return [...this.ensureState().sessions];
  }

  async loadDeltaLogs(): Promise<DeltaLog[]> {
    return [...this.ensureState().deltaLogs];
  }

  async deleteDeltaLog(logId: string): Promise<void> {
    const state = this.ensureState();
    const next = state.deltaLogs.filter(l => l.id !== logId);
    if (next.length !== state.deltaLogs.length) {
      state.deltaLogs = next;
      writeDemoState(state);
    }
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
