import type { Book, Note } from '../types/pragya';
import { getLocalDateString } from './sessionCoalesce';
import { isNoteSpoiler, isSealedPrediction } from './spoilerMath';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDateOnlyUtcMs(dateStr: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((dateStr || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return Date.UTC(year, month - 1, day);
}

export function getCalendarDaysBetween(fromIsoOrDate: string, toDateStr: string): number {
  const fromMs = parseDateOnlyUtcMs(fromIsoOrDate);
  const toMs = parseDateOnlyUtcMs(toDateStr);
  if (fromMs === null || toMs === null) return 0;
  return Math.floor((toMs - fromMs) / MS_PER_DAY);
}

export function isFavoriteNote(note: Note): boolean {
  return (note.tags || []).some(tag => {
    const lower = tag.trim().toLowerCase();
    return lower === '#favorite' || lower === '#favorites' || lower === 'favorite' || lower === 'favorites';
  });
}

function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function isStructurallyEligibleForShuffle(
  note: Note,
  book: Book | undefined,
  todayDate: string
): boolean {
  if (isNoteSpoiler(note, book)) return false;
  if (isSealedPrediction(note, book)) return false;
  if (!note.takeaway?.trim() && !note.quote?.trim()) return false;
  if (isFavoriteNote(note)) return true;
  return getCalendarDaysBetween(note.createdAt, todayDate) >= 14;
}

export function isEligibleForShuffle(
  note: Note,
  book: Book | undefined,
  todayDate: string
): boolean {
  if (!isStructurallyEligibleForShuffle(note, book, todayDate)) return false;
  const lastReviewed = note.meta?.lastReviewedAt;
  if (lastReviewed) {
    if (lastReviewed.includes('T')) {
      const parsed = new Date(lastReviewed);
      if (
        !Number.isNaN(parsed.getTime())
          ? getLocalDateString(parsed) === todayDate || lastReviewed.slice(0, 10) === todayDate
          : lastReviewed.slice(0, 10) === todayDate
      ) {
        return false;
      }
    } else if (lastReviewed.slice(0, 10) === todayDate) {
      return false;
    }
  }
  return true;
}

export function getShuffleEmptyReason(
  notes: Note[],
  books: Book[],
  todayDate: string = getLocalDateString()
): 'all-reviewed-today' | 'none-eligible' {
  const bookMap = new Map<string, Book>();
  for (const b of books) {
    bookMap.set(b.id, b);
  }
  const hasAnyStructural = notes.some(n =>
    isStructurallyEligibleForShuffle(n, bookMap.get(n.bookId), todayDate)
  );
  return hasAnyStructural ? 'all-reviewed-today' : 'none-eligible';
}

export function selectTakeawayShuffle(
  notes: Note[],
  books: Book[],
  todayDate: string = getLocalDateString(),
  limit = 3
): Note[] {
  const bookMap = new Map<string, Book>();
  for (const b of books) {
    bookMap.set(b.id, b);
  }

  const eligible = notes.filter(n => isEligibleForShuffle(n, bookMap.get(n.bookId), todayDate));
  eligible.sort((a, b) => {
    const ha = fnv1aHash(`${todayDate}:${a.id}`);
    const hb = fnv1aHash(`${todayDate}:${b.id}`);
    if (ha !== hb) return ha - hb;
    return a.id.localeCompare(b.id);
  });

  return eligible.slice(0, Math.max(0, limit));
}
