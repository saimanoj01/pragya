import type { Book, DeltaLog, Note, ReadingSession } from '../types/pragya';
import { isArchived, noteDisplayTitle } from './archive';

/**
 * CD C1.2 permanent delete (pure helpers). Only ARCHIVED books/notes can be deleted.
 * A book cascades to all its notes, their delta logs and its sessions (OQ-2 / ux Q1);
 * a note takes its delta logs. Deletes run children first and the parent row last, so a
 * partial failure leaves the parent visible and the delete retryable. Undo re-appends the
 * exact removed rows (same UUIDs) from the in-memory backup.
 */
export const LAST_DELETE_BACKUP_KEY = 'pragya_last_delete_backup_v1';
/** R1 nit 6: a support-only safety net never lingers on the device for long. */
export const LAST_DELETE_BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DELETE_UNDO_COPY = "You can undo this for a few seconds; after that it's permanent.";

export interface DeleteBackup {
  version: 1;
  /**
   * Set once the cascade succeeded. Only confirmed backups are cleared by the next
   * successful sync; anything older than LAST_DELETE_BACKUP_TTL_MS is expired on boot.
   */
  confirmed?: boolean;
  kind: 'book' | 'note';
  /** Id of the book or note the user chose to delete. */
  targetId: string;
  title: string;
  deletedAt: string;
  books: Book[];
  notes: Note[];
  sessions: ReadingSession[];
  deltaLogs: DeltaLog[];
}

/** Ids per tab, in the order rows must be deleted (children first, parent last). */
export interface DeleteRowsPlan {
  deltaLogIds: string[];
  sessionIds: string[];
  noteIds: string[];
  bookIds: string[];
}

export interface WorkspaceRows {
  books: Book[];
  notes: Note[];
  sessions: ReadingSession[];
  deltaLogs: DeltaLog[];
}

export class NotArchivedError extends Error {
  constructor(kind: 'book' | 'note') {
    super(`Only an archived ${kind} can be deleted forever. Archive it first.`);
    this.name = 'NotArchivedError';
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function planNoteDelete(note: Note, rows: WorkspaceRows, nowIso: string): DeleteBackup {
  if (!isArchived(note)) throw new NotArchivedError('note');
  return {
    version: 1,
    kind: 'note',
    targetId: note.id,
    title: noteDisplayTitle(note),
    deletedAt: nowIso,
    books: [],
    notes: [clone(note)],
    sessions: [],
    deltaLogs: clone(rows.deltaLogs.filter(l => l.noteId === note.id)),
  };
}

export function planBookDelete(book: Book, rows: WorkspaceRows, nowIso: string): DeleteBackup {
  if (!isArchived(book)) throw new NotArchivedError('book');
  const notes = rows.notes.filter(n => n.bookId === book.id);
  const noteIds = new Set(notes.map(n => n.id));
  return {
    version: 1,
    kind: 'book',
    targetId: book.id,
    title: book.title,
    deletedAt: nowIso,
    books: [clone(book)],
    notes: clone(notes),
    sessions: clone(rows.sessions.filter(s => s.bookId === book.id)),
    deltaLogs: clone(rows.deltaLogs.filter(l => noteIds.has(l.noteId))),
  };
}

export function toDeleteRowsPlan(backup: DeleteBackup): DeleteRowsPlan {
  return {
    deltaLogIds: backup.deltaLogs.map(l => l.id),
    sessionIds: backup.sessions.map(s => s.id),
    noteIds: backup.notes.map(n => n.id),
    bookIds: backup.books.map(b => b.id),
  };
}

/** Workspace rows with the backup's rows removed (local state after a delete). */
export function withoutDeleted<T extends WorkspaceRows>(rows: T, backup: DeleteBackup): T {
  const ids = (list: { id: string }[]) => new Set(list.map(x => x.id));
  const b = ids(backup.books);
  const n = ids(backup.notes);
  const s = ids(backup.sessions);
  const l = ids(backup.deltaLogs);
  return {
    ...rows,
    books: rows.books.filter(x => !b.has(x.id)),
    notes: rows.notes.filter(x => !n.has(x.id)),
    sessions: rows.sessions.filter(x => !s.has(x.id)),
    deltaLogs: rows.deltaLogs.filter(x => !l.has(x.id)),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * ux_spec_cd C.1.4 copy with EXACT cascade counts (decisions Q1) and the CD 1b undo
 * sentence. `where` is "your Google Sheet" (Cloud) or "this browser" (Demo).
 * `shielded`: a spoiler-shielded note never shows its slug.
 */
export function deleteDialogCopy(
  backup: DeleteBackup,
  options: { demo: boolean; shielded?: boolean }
): { title: string; body: string; confirm: string } {
  const where = options.demo ? 'this browser' : 'your Google Sheet';
  if (backup.kind === 'book') {
    // R2#1: say plainly that the cascade also removes notes still visible in Notes.
    const n = backup.notes.length;
    const live = backup.notes.filter(x => !isArchived(x)).length;
    let main = 'the book';
    if (n === 1) main = `the book and its 1 note${live ? " (even though it's still in your Notes)" : ''}`;
    else if (n > 1) main = `the book and all ${n} of its notes${live ? ' (including ones still in your Notes)' : ''}`;
    const extras: string[] = [];
    if (backup.deltaLogs.length) extras.push(plural(backup.deltaLogs.length, 'check-in', 'check-ins'));
    if (backup.sessions.length) extras.push(plural(backup.sessions.length, 'reading session', 'reading sessions'));
    const what = !extras.length
      ? main
      : n
        ? `${main}, plus ${joinList(extras)},`
        : `${main} and ${joinList(extras)}`;
    return {
      title: `Delete "${backup.title}" forever?`,
      body: `This removes ${what} from ${where}. ${DELETE_UNDO_COPY}`,
      confirm: 'Delete Book',
    };
  }
  const note = backup.notes[0];
  const logs = backup.deltaLogs.length;
  const what = logs ? `it and its ${plural(logs, 'check-in', 'check-ins')}` : 'it';
  const links =
    !options.shielded && note?.slug ? ` Notes linking to [[${note.slug}]] will show it as missing.` : '';
  return {
    title: 'Delete this note forever?',
    body: `This removes ${what} from ${where}.${links} ${DELETE_UNDO_COPY}`,
    confirm: 'Delete Note',
  };
}

export function writeLastDeleteBackup(backup: DeleteBackup): void {
  try {
    localStorage.setItem(LAST_DELETE_BACKUP_KEY, JSON.stringify(backup));
  } catch {
    // Quota / restricted storage: the in-memory Undo still works.
  }
}

export function readLastDeleteBackup(): DeleteBackup | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_DELETE_BACKUP_KEY) || 'null') as DeleteBackup | null;
    return parsed && parsed.version === 1 && Array.isArray(parsed.books) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearLastDeleteBackup(): void {
  try {
    localStorage.removeItem(LAST_DELETE_BACKUP_KEY);
  } catch {
    // Ignore storage errors
  }
}

/** R1 nit 6: on boot, drop a backup older than the TTL (or unreadable). Returns true if cleared. */
export function expireStaleDeleteBackup(nowMs: number = Date.now()): boolean {
  const raw = (() => {
    try {
      return localStorage.getItem(LAST_DELETE_BACKUP_KEY);
    } catch {
      return null;
    }
  })();
  if (raw === null) return false;
  const backup = readLastDeleteBackup();
  const at = backup ? Date.parse(backup.deletedAt) : NaN;
  if (!backup || !Number.isFinite(at) || nowMs - at > LAST_DELETE_BACKUP_TTL_MS) {
    clearLastDeleteBackup();
    return true;
  }
  return false;
}

/** Ids of the backup's rows per tab (for the append-if-absent Undo). */
export interface RestoreRowsResult {
  restored: { books: string[]; notes: string[]; sessions: string[]; deltaLogs: string[] };
  /** Rows left alone because a row with that id already exists (never overwritten). */
  skipped: number;
}

/**
 * CD 1b re-review: what the cascade actually did, verified by a post-write A:A re-read.
 * `repaired`: unrelated rows that vanished because another device shifted rows between
 * our read and write, re-appended from the pre-read snapshot (R2-b).
 * `stillPresent`: planned ids still in the Sheet after the write (left for a retry).
 */
export interface DeleteCascadeResult {
  repaired: number;
  stillPresent: string[];
}

/**
 * CD 1b re-review R2-a: the batchUpdate failed without an HTTP answer (network/timeout)
 * AND the follow-up re-read failed too, so we can't tell whether rows were deleted.
 * The backup is kept (unconfirmed) so support can still recover the rows.
 */
export class DeleteOutcomeUnknownError extends Error {
  constructor() {
    super("Couldn't confirm whether the delete went through.");
    this.name = 'DeleteOutcomeUnknownError';
  }
}

/** What PragyaContext's permanent delete returns: the (confirmed) backup + what happened. */
export interface PermanentDeleteResult {
  backup: DeleteBackup;
  outcome: DeleteCascadeResult;
}

/** The backup minus rows that are still in the Sheet (they weren't deleted). */
export function withoutIds(backup: DeleteBackup, ids: string[]): DeleteBackup {
  if (ids.length === 0) return backup;
  const keep = new Set(ids);
  const f = <T extends { id: string }>(list: T[]) => list.filter(x => !keep.has(x.id));
  return { ...backup, books: f(backup.books), notes: f(backup.notes), sessions: f(backup.sessions), deltaLogs: f(backup.deltaLogs) };
}

/** Calm follow-up copy for a cascade that had to repair or skip rows (re-review R2-b). */
export function deleteOutcomeNotice(outcome: DeleteCascadeResult): string | null {
  const parts: string[] = [];
  if (outcome.repaired > 0) {
    parts.push(
      `Another device changed this sheet during the delete; Pragya restored ${outcome.repaired} unrelated ${
        outcome.repaired === 1 ? 'row' : 'rows'
      }.`
    );
  }
  if (outcome.stillPresent.length > 0) {
    parts.push(`${outcome.stillPresent.length === 1 ? '1 row was' : `${outcome.stillPresent.length} rows were`} not deleted; try again.`);
  }
  return parts.length ? parts.join(' ') : null;
}
