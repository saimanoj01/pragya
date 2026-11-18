import type { Book, Note } from '../types/pragya';
import type { PragyaRoute } from './navigation';
import { isArchived } from './archive';
import { resolveNoteRef } from './noteVisibility';

/**
 * CD C4.3 (ux_spec_cd C.4.1 "Keep current book"): global capture (Sidebar `+ Capture`,
 * mobile FAB, CommandPalette, `N`) preselects the book you're looking at — the book on
 * `#/book/:id`, or the open note's book on `#/note/:slugOrId`. Archived books are never
 * preselected (they aren't offered for capture). Everywhere else → null (no preselect,
 * so `capture-book-select` stays first in focus order).
 */
export function resolveCaptureBookId(
  route: Pick<PragyaRoute, 'view' | 'bookId' | 'noteSlug'>,
  notes: Note[],
  books: Book[]
): string | null {
  let bookId: string | null = null;
  if (route.view === 'book' && route.bookId) {
    bookId = route.bookId;
  } else if (route.view === 'note' && route.noteSlug) {
    bookId = resolveNoteRef(notes, route.noteSlug)?.bookId || null;
  }
  if (!bookId) return null;
  const book = books.find(b => b.id === bookId);
  return book && !isArchived(book) ? bookId : null;
}
