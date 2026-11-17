import type { Book, Note, PosUnit } from '../types/pragya';

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function computeNormalizedPos(
  pos: number,
  totalPos: number,
  posUnit: PosUnit
): number {
  const safePos = Number.isFinite(pos) ? Math.max(0, pos) : 0;
  if (posUnit === 'percent') {
    return clamp01(safePos / 100);
  }
  if (Number.isFinite(totalPos) && totalPos > 0) {
    return clamp01(safePos / totalPos);
  }
  return 0;
}

/**
 * B2.4: the note's position normalized against the book's *current* scale. A stored
 * `normalizedPos` goes stale when `totalPos` is edited later (e.g. 0 → 300), so it is
 * recomputed whenever the book has a usable scale. Parity: `effective_note_norm` (CLI).
 */
export function effectiveNoteNorm(note: Note, book?: Book | null): number {
  if (book && (book.totalPos > 0 || book.posUnit === 'percent')) {
    return computeNormalizedPos(Number(note.pos) || 0, book.totalPos, book.posUnit);
  }
  return Number.isFinite(note.normalizedPos) ? note.normalizedPos : 0;
}

/**
 * normalizedPos is rounded to 6 decimals on every Sheet write (sheetCodecs toFixed(6) and
 * the CLI), so a note exactly at the bookmark must not read as ahead of it.
 * Parity: SPOILER_NORM_EPSILON in scripts/pragya_cli.py.
 */
export const SPOILER_NORM_EPSILON = 1e-6;

export function isNoteSpoiler(note: Note, book?: Book | null): boolean {
  if (!book || book.status === 'finished') {
    return false;
  }
  if (book.totalPos > 0 || book.posUnit === 'percent') {
    return effectiveNoteNorm(note, book) > book.normalizedPos + SPOILER_NORM_EPSILON;
  }
  return Number(note.pos) > book.currentPos;
}

export function isSealedPrediction(note: Note, book?: Book | null): boolean {
  return Boolean(
    note.meta?.isPrediction &&
      book &&
      book.kind === 'fiction' &&
      book.status !== 'finished'
  );
}

export function isUnlockedPrediction(note: Note, book?: Book | null): boolean {
  return Boolean(
    note.meta?.isPrediction &&
      book &&
      book.kind === 'fiction' &&
      book.status === 'finished'
  );
}

export function formatPosDisplay(pos: number, posUnit: PosUnit): string {
  const safe = Number.isFinite(pos) ? Math.round(pos * 100) / 100 : 0;
  if (posUnit === 'percent') return `${safe}%`;
  if (posUnit === 'loc') return `loc ${safe}`;
  return `p. ${safe}`;
}

export function computePercentDisplay(book: Book): number {
  if (book.status === 'finished') return 100;
  if (book.posUnit === 'percent') return Math.round(clamp01(book.currentPos / 100) * 100);
  if (book.totalPos > 0) return Math.round(clamp01(book.currentPos / book.totalPos) * 100);
  return Math.round(clamp01(book.normalizedPos) * 100);
}

export function getQuickAdvanceSpec(posUnit: PosUnit): { step: number; label: string } {
  if (posUnit === 'percent') return { step: 5, label: '+5%' };
  if (posUnit === 'loc') return { step: 50, label: '+50 loc' };
  return { step: 10, label: '+10p' };
}
