import type { Book } from '../types/pragya';

/**
 * Clamp a note position into the book's domain (M4.9, PWA↔CLI parity):
 * - percent books: [0, 100]
 * - books with a known totalPos: [0, totalPos]
 * - otherwise: [0, ∞)
 */
export function clampNotePos(
  rawPos: unknown,
  book: Pick<Book, 'posUnit' | 'totalPos'> | null | undefined
): number {
  const n = Number(rawPos);
  let pos = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (!book) return pos;
  if (book.posUnit === 'percent') {
    pos = Math.min(pos, 100);
  }
  if (Number.isFinite(book.totalPos) && book.totalPos > 0) {
    pos = Math.min(pos, book.totalPos);
  }
  return pos;
}
