import type { Book, Note } from '../types/pragya';
import { getLocalDateString } from './sessionCoalesce';
import { isNoteSpoiler, isSealedPrediction } from './spoilerMath';
import { isArchived } from './archive';

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

const DATE_ONLY_RE = /^(\d{4}-\d{2}-\d{2})/;
const HAS_TZ_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * C5.1: the user's LOCAL calendar date (`YYYY-MM-DD`) for a stored value. Date-only
 * strings pass through unchanged; ISO timestamps (with a `T`) convert to the local date.
 * A timestamp without an offset is read as UTC (CLI `parse_iso_utc` parity). Python
 * mirror: `to_local_date_key` in scripts/pragya_cli.py.
 */
export function toLocalDateKey(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return null;
  const dateOnly = DATE_ONLY_RE.exec(s);
  if (!s.includes('T')) return dateOnly ? dateOnly[1] : null;
  const parsed = new Date(HAS_TZ_RE.test(s) ? s : `${s}Z`);
  if (Number.isNaN(parsed.getTime())) return dateOnly ? dateOnly[1] : null;
  return getLocalDateString(parsed);
}

export function getCalendarDaysBetween(fromIsoOrDate: string, toDateStr: string): number {
  const fromMs = parseDateOnlyUtcMs(toLocalDateKey(fromIsoOrDate) || '');
  const toMs = parseDateOnlyUtcMs(toLocalDateKey(toDateStr) || '');
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
  if (isArchived(note)) return false;
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
  // C5.1: "reviewed today" means the user's local date (no UTC-slice shortcut).
  const reviewedKey = toLocalDateKey(note.meta?.lastReviewedAt);
  return reviewedKey !== todayDate;
}

/**
 * C5.2 staleness bucket (lower = shown first): 0 never reviewed, 1 reviewed > 30 days
 * ago, 2 reviewed 8–30 days ago, 3 reviewed ≤ 7 days ago. Python: `shuffle_staleness_bucket`.
 */
export function shuffleStalenessBucket(note: Note, todayDate: string): 0 | 1 | 2 | 3 {
  const reviewedKey = toLocalDateKey(note.meta?.lastReviewedAt);
  if (!reviewedKey) return 0;
  const days = getCalendarDaysBetween(reviewedKey, todayDate);
  if (days > 30) return 1;
  if (days >= 8) return 2;
  return 3;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * ux_spec_cd C.5 quiet provenance line: `First revisit · saved {MMM YYYY}` or
 * `Last revisited {MMM YYYY}` (`{MMM D}` within the current year). Never "days ago".
 */
export function shuffleProvenanceLabel(note: Note, todayDate: string): string {
  const reviewedKey = toLocalDateKey(note.meta?.lastReviewedAt);
  const fmt = (key: string, allowShort: boolean) => {
    const [y, m, d] = key.split('-').map(Number);
    const month = MONTHS[(m || 1) - 1] || '';
    return allowShort && key.slice(0, 4) === todayDate.slice(0, 4) ? `${month} ${d}` : `${month} ${y}`;
  };
  if (!reviewedKey) {
    const savedKey = toLocalDateKey(note.createdAt);
    return savedKey ? `First revisit · saved ${fmt(savedKey, false)}` : 'First revisit';
  }
  return `Last revisited ${fmt(reviewedKey, true)}`;
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
    const sa = shuffleStalenessBucket(a, todayDate);
    const sb = shuffleStalenessBucket(b, todayDate);
    if (sa !== sb) return sa - sb;
    const ha = fnv1aHash(`${todayDate}:${a.id}`);
    const hb = fnv1aHash(`${todayDate}:${b.id}`);
    if (ha !== hb) return ha - hb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return eligible.slice(0, Math.max(0, limit));
}
