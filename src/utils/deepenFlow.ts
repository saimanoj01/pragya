import type { Book, Note } from '../types/pragya';
import { isArchived } from './archive';
import { isShielded } from './noteVisibility';

/**
 * CD C4.5 (ux_spec_cd C.4.3 "Save & Next", Q.11): the next note to deepen after
 * `currentId`, in the To Spar order — `inbox` / `in-reflection`, oldest first by
 * `createdAt` (id as a stable tie-break). Archived and spoiler-shielded notes are
 * skipped (a shielded note's content must not open in an editor unrevealed).
 */
export const SAVE_NEXT_DONE_MESSAGE = "That's everything you'd marked to spar.";

export function isToSpar(note: Note): boolean {
  return note.status === 'inbox' || note.status === 'in-reflection';
}

export function nextInboxNote(notes: Note[], books: Book[], currentId: string): Note | null {
  const bookById = new Map(books.map(b => [b.id, b] as const));
  const candidates = notes
    .filter(
      n =>
        n.id !== currentId &&
        isToSpar(n) &&
        !isArchived(n) &&
        !isShielded(n, bookById.get(n.bookId) || null)
    )
    .sort((a, b) => {
      const ca = String(a.createdAt || '');
      const cb = String(b.createdAt || '');
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  return candidates[0] || null;
}
