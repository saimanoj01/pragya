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

export function isNoteSpoiler(note: Note, book?: Book | null): boolean {
  if (!book || book.status === 'finished') {
    return false;
  }
  if (book.totalPos > 0 || book.posUnit === 'percent') {
    return note.normalizedPos > book.normalizedPos;
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
