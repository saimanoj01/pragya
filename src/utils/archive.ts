import type { Book, DeltaStatus, Note } from '../types/pragya';

/**
 * C1.1 soft-archive (pure helpers). Archive state lives only in `meta.archivedAt` (ISO),
 * so no Sheet column changes. Python mirror: `is_archived` in scripts/pragya_cli.py.
 */
export const ACTIVE_DELTA_CAP = 5;

type Archivable = { meta?: { archivedAt?: unknown } | null } | null | undefined;

/** True when the entity carries a non-empty `meta.archivedAt`. */
export function isArchived(entity: Archivable): boolean {
  const value = entity?.meta?.archivedAt;
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * R1#3: active deltas on OTHER notes that count toward the 5-cap. Archived notes never
 * hold a slot (matches the Practice N/5 header and CLI `check_active_delta_cap`).
 */
export function countOtherActiveDeltas(
  notes: readonly { id: string; deltaStatus?: string; meta?: { archivedAt?: unknown } | null }[],
  noteId: string
): number {
  return notes.filter(n => n.id !== noteId && n.deltaStatus === 'active' && !isArchived(n)).length;
}

/** Default-list filter: drop archived entities. */
export function withoutArchived<T extends Archivable>(items: readonly T[]): T[] {
  return items.filter(item => !isArchived(item));
}

export function onlyArchived<T extends Archivable>(items: readonly T[]): T[] {
  return items.filter(item => isArchived(item));
}

/**
 * R2 nit: a readable name for toasts — meta.title, else the first 8 takeaway words (one
 * trailing "." dropped, "…" when cut; Companion Doc parity), else the slug.
 */
export function noteDisplayTitle(note: { slug?: string; takeaway?: string; meta?: { title?: unknown } | null }): string {
  const title = typeof note.meta?.title === 'string' ? note.meta.title.replace(/\s+/g, ' ').trim() : '';
  if (title) return title;
  const words = (note.takeaway || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length) {
    const head = words.slice(0, 8).join(' ');
    const stripped = head.endsWith('.') && head.length > 1 ? head.slice(0, -1) : head;
    return words.length > 8 ? `${stripped}…` : stripped;
  }
  return String(note.slug || 'Note');
}

/** `YYYY-MM-DD` of the archive timestamp (for the banner), or ''. */
export function archivedDateLabel(entity: Archivable): string {
  const value = entity?.meta?.archivedAt;
  return typeof value === 'string' ? value.trim().slice(0, 10) : '';
}

export function buildArchivedBook(book: Book, nowIso: string): Book {
  return { ...book, meta: { ...book.meta, archivedAt: nowIso } };
}

export function buildRestoredBook(book: Book): Book {
  const meta = { ...book.meta };
  delete meta.archivedAt;
  return { ...book, meta };
}

/**
 * Archiving a note with an ACTIVE delta pauses it (OQ-3 / ux Q3) and remembers the
 * previous status in `meta.archivedDeltaStatus` so Restore can bring it back.
 */
export function buildArchivedNote(note: Note, nowIso: string): { note: Note; pausedDelta: boolean } {
  const meta: Note['meta'] = { ...note.meta, archivedAt: nowIso };
  const pausedDelta = note.deltaStatus === 'active';
  if (pausedDelta) meta.archivedDeltaStatus = 'active';
  return { note: { ...note, deltaStatus: pausedDelta ? 'paused' : note.deltaStatus, meta }, pausedDelta };
}

/**
 * Restore: clears the archive keys and reactivates a delta that archiving paused, unless
 * that would exceed the 5-active cap (then it stays paused and `capped` is true).
 * `otherActiveCount` = active deltas on OTHER notes.
 */
export function buildRestoredNote(
  note: Note,
  otherActiveCount: number
): { note: Note; reactivated: boolean; capped: boolean } {
  const meta: Note['meta'] = { ...note.meta };
  const wanted = meta.archivedDeltaStatus === 'active' && note.deltaStatus === 'paused';
  delete meta.archivedAt;
  delete meta.archivedDeltaStatus;
  const capped = wanted && otherActiveCount >= ACTIVE_DELTA_CAP;
  const reactivated = wanted && !capped;
  const deltaStatus: DeltaStatus = reactivated ? 'active' : note.deltaStatus;
  return { note: { ...note, deltaStatus, meta }, reactivated, capped };
}

/** ux_spec_cd C.1.2 active-delta guard copy (non-destructive confirm). */
export const ARCHIVE_ACTIVE_DELTA_COPY = {
  title: 'Archive this note and pause its delta?',
  body: 'Its Behavioral Delta will move to Paused, freeing a slot in your 5. You can reactivate it after restoring.',
  confirm: 'Archive & Pause',
} as const;
