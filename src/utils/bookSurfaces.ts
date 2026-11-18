import type { Book, Note, ReadingSession } from '../types/pragya';
import { getRenderableAttachments } from './metaCodecs';
import { toLocalDateKey } from './takeawayShuffle';

/**
 * CD Batch 3 book surfaces (pure, erasable TS): Shelf 30-day activity (C2.2), the Recent
 * Reading Sessions trail (C2.3), `note.meta.links` chips (C2.5) and https-only covers (C2.6).
 */

// ---- C2.2 Shelf activity ---------------------------------------------------------------

export interface ActivityDay {
  date: string;
  count: number;
  /** 0 = none … 3 = most (4 monochrome steps; no streaks, no "best week"). */
  level: 0 | 1 | 2 | 3;
  /** `Fri, Nov 14: 2 sessions, 24 pages` / `Fri, Nov 14: no reading logged`. */
  label: string;
}

function parseLocalDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function localKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function weekdayDateLabel(date: string): string {
  const d = parseLocalDate(date);
  if (!d) return date;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * 30 local days ending `today` (index 0 = 29 days ago). Per day: session count and a
 * level from Σ progress — fraction of the book (`(end − start) / totalPos`, percent unit
 * `/100`) and raw page/location delta; the larger of the two rules wins:
 * L1 < 2 % or < 10 pages · L2 2–6 % or 10–30 · L3 > 6 % or > 30.
 */
export function buildActivityDays(sessions: ReadingSession[], books: Book[], today: string): ActivityDay[] {
  const end = parseLocalDate(today) || new Date();
  const bookMap = new Map(books.map(b => [b.id, b] as const));
  const perDay = new Map<string, { count: number; fraction: number; raw: number; pages: number; locs: number; pct: number }>();
  for (const s of sessions) {
    const key = toLocalDateKey(s.date as unknown);
    if (!key) continue;
    const day = perDay.get(key) || { count: 0, fraction: 0, raw: 0, pages: 0, locs: 0, pct: 0 };
    day.count += 1;
    const delta = Math.max(0, (Number(s.endPos) || 0) - (Number(s.startPos) || 0));
    const book = bookMap.get(s.bookId);
    const unit = book?.posUnit || 'page';
    if (unit === 'percent') {
      day.fraction += delta / 100;
      day.pct += delta;
    } else {
      if (book && book.totalPos > 0) day.fraction += delta / book.totalPos;
      day.raw += delta;
      if (unit === 'loc') day.locs += delta;
      else day.pages += delta;
    }
    perDay.set(key, day);
  }
  const out: ActivityDay[] = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const d = new Date(end);
    d.setDate(d.getDate() - offset);
    const date = localKey(d);
    const day = perDay.get(date);
    if (!day || day.count === 0) {
      out.push({ date, count: 0, level: 0, label: `${weekdayDateLabel(date)}: no reading logged` });
      continue;
    }
    const f = day.fraction;
    const fractionLevel = f > 0.06 ? 3 : f >= 0.02 ? 2 : 1;
    const rawLevel = day.raw > 30 ? 3 : day.raw >= 10 ? 2 : 1;
    const level = Math.max(fractionLevel, rawLevel) as 1 | 2 | 3;
    const progress = [
      day.pages ? plural(day.pages, 'page', 'pages') : '',
      day.locs ? plural(day.locs, 'location', 'locations') : '',
      day.pct ? `${Math.round(day.pct * 100) / 100}%` : '',
    ].filter(Boolean);
    out.push({
      date,
      count: day.count,
      level,
      label: `${weekdayDateLabel(date)}: ${plural(day.count, 'session', 'sessions')}${
        progress.length ? `, ${progress.join(', ')}` : ''
      }`,
    });
  }
  return out;
}

/** `12 sessions in the last 30 days` / `No sessions in the last 30 days` (window only). */
export function activityCountLabel(days: ActivityDay[]): string {
  const n = days.reduce((acc, d) => acc + d.count, 0);
  return n === 0 ? 'No sessions in the last 30 days' : `${plural(n, 'session', 'sessions')} in the last 30 days`;
}

export const ACTIVITY_LEVEL_CLASSES: Record<0 | 1 | 2 | 3, string> = {
  0: 'bg-surface2 border border-border/70',
  1: 'bg-foreground/30',
  2: 'bg-foreground/60',
  3: 'bg-foreground/90',
};

// ---- C2.3 Recent Reading Sessions trail -----------------------------------------------

export const SESSIONS_TRAIL_LIMIT = 10;

/** The book's sessions, newest first (local date desc, then updatedAt desc). */
export function bookSessionsNewestFirst(sessions: ReadingSession[], bookId: string): ReadingSession[] {
  return sessions
    .filter(s => s.bookId === bookId)
    .map(s => ({ s, key: toLocalDateKey(s.date as unknown) || '' }))
    .sort((a, b) => (a.key !== b.key ? (a.key < b.key ? 1 : -1) : String(b.s.updatedAt || '').localeCompare(String(a.s.updatedAt || ''))))
    .map(x => x.s);
}

/** `Nov 14` (year added when it isn't the current year). */
export function sessionDateLabel(date: unknown, today: string): string {
  const key = toLocalDateKey(date) || '';
  const d = parseLocalDate(key);
  if (!d) return String(date ?? '');
  const sameYear = key.slice(0, 4) === (today || '').slice(0, 4);
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export const SESSION_NOTE_MAX = 280;

// ---- C2.5 meta.links chips ---------------------------------------------------------------

/** `fs.blog/mental-models…`: hostname (no `www.`) + path, max 32 chars. */
export function linkChipLabel(url: string): string {
  let label = (url || '').trim();
  try {
    const u = new URL(label);
    label = `${u.hostname.replace(/^www\./i, '')}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    // keep the raw text for unparseable values
  }
  return label.length > 32 ? `${label.slice(0, 31)}…` : label;
}

/** Standalone `meta.links` not already shown as a doc/link attachment (de-duplicated). */
export function standaloneNoteLinks(note: Pick<Note, 'meta'>): string[] {
  const attachmentUrls = new Set(
    getRenderableAttachments(note.meta)
      .filter((a): a is Extract<typeof a, { type: 'doc' | 'link' }> => a.type !== 'image')
      .map(a => a.url.trim())
  );
  const out: string[] = [];
  for (const raw of Array.isArray(note.meta?.links) ? note.meta.links : []) {
    if (typeof raw !== 'string') continue;
    const url = raw.trim();
    if (!url || attachmentUrls.has(url) || out.includes(url)) continue;
    out.push(url);
  }
  return out;
}

// ---- C2.6 cover ---------------------------------------------------------------------------

/** https-only cover URL (anything else → null: nothing is rendered). */
export function safeCoverUrl(book: Pick<Book, 'meta'> | null | undefined): string | null {
  const raw = book?.meta?.coverUrl;
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!/^https:\/\//i.test(url)) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Form validation for the cover field: '' (optional) or an https URL. */
export function coverUrlError(value: string): string | null {
  const v = (value || '').trim();
  if (!v) return null;
  return safeCoverUrl({ meta: { coverUrl: v, updatedAt: '' } }) ? null : 'Use an https:// image link.';
}
