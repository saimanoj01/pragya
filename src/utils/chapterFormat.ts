import type { Book, Note, PosUnit } from '../types/pragya';
import { formatPosDisplay } from './spoilerMath';
import { clampNotePos } from './positionClamp';

/**
 * A3.2 / ux_spec B.3 — one chapter formatter, two renderings. Parity with
 * `format_chapter_label` / `format_chapter_pos` / `format_chapter_badge` in
 * scripts/pragya_cli.py (QA's pinned table is mirrored in tests/unit/m6RecallUi.test.mjs).
 */
export const CHAPTER_MAX_LENGTH = 80;

function chapterText(chapter: unknown): string {
  if (typeof chapter === 'string') return chapter.trim();
  if (typeof chapter === 'number' && Number.isFinite(chapter)) return String(chapter);
  return '';
}

/** Purely ASCII-numeric (QA-17: `[0-9]`, never Unicode digits) → `Ch. N`; else verbatim. */
export function formatChapterLabel(chapter: unknown): string {
  const text = chapterText(chapter);
  if (!text) return '';
  return /^[0-9]+$/.test(text) ? `Ch. ${text}` : text;
}

/** `Ch. 3 · p. 42`, `Run · 10%`, or just the position (no brackets). */
export function formatChapterPos(chapter: unknown, pos: number, posUnit: PosUnit): string {
  const posLabel = formatPosDisplay(Number.isFinite(Number(pos)) ? Number(pos) : 0, posUnit);
  const label = formatChapterLabel(chapter);
  return label ? `${label} · ${posLabel}` : posLabel;
}

/** Plain-text rendering with literal brackets: `[Ch. 3 · p. 42]`, `[10%]`. */
export function formatChapterBadge(chapter: unknown, pos: number, posUnit: PosUnit): string {
  return `[${formatChapterPos(chapter, pos, posUnit)}]`;
}

/** Inputs: trim and cap at 80 chars; empty → undefined (key omitted). */
export function normalizeChapterInput(value: string | null | undefined): string | undefined {
  const trimmed = (value || '').trim().slice(0, CHAPTER_MAX_LENGTH).trim();
  return trimmed ? trimmed : undefined;
}

/** Set or delete `meta[key]` from a form value without touching other keys. */
export function withChapterKey<T extends Record<string, unknown>>(
  meta: T,
  key: 'chapter' | 'currentChapter',
  value: string | null | undefined
): T {
  const next: Record<string, unknown> = { ...meta };
  const normalized = normalizeChapterInput(value);
  if (normalized) next[key] = normalized;
  else delete next[key];
  return next as T;
}

export type CaptureChapterHint = 'inherited' | 'not-applied' | null;

export interface CaptureChapterState {
  value: string;
  hint: CaptureChapterHint;
}

/**
 * ux_spec B.2 QuickCapture: while the user hasn't typed in the field, the book's
 * `currentChapter` is prefilled only when the note sits at the bookmark (pos ==
 * currentPos, mirroring the CLI). Moving the position away clears it.
 */
export function resolveCaptureChapter(input: {
  bookChapter: string | undefined;
  pos: number | null;
  currentPos: number;
  touched: boolean;
  value: string;
  /** The book's position domain; the typed pos is clamped first, as the CLI does. */
  clampTo?: Pick<Book, 'posUnit' | 'totalPos'> | null;
}): CaptureChapterState {
  if (input.touched) return { value: input.value, hint: null };
  const bookChapter = normalizeChapterInput(input.bookChapter);
  if (!bookChapter) return { value: '', hint: null };
  const atBookmark =
    input.pos === null || clampNotePos(input.pos, input.clampTo) === Number(input.currentPos);
  return atBookmark ? { value: bookChapter, hint: 'inherited' } : { value: '', hint: 'not-applied' };
}

export const CAPTURE_CHAPTER_HINTS: Record<Exclude<CaptureChapterHint, null>, string> = {
  inherited: 'From your bookmark',
  'not-applied': 'Bookmark chapter not applied — this note is at a different position.',
};

/** Deepen shows a one-tap suggestion chip (never auto-fills) — ux_spec B.2. */
export function deepenChapterSuggestion(note: Note, book: Book | null | undefined): string | null {
  if (!book) return null;
  if (normalizeChapterInput(note.meta?.chapter)) return null;
  const current = normalizeChapterInput(book.meta?.currentChapter);
  if (!current) return null;
  return Number(note.pos) === Number(book.currentPos) ? current : null;
}

export type ChapterDivider =
  | { kind: 'chapter'; label: string; count: number }
  | { kind: 'none'; count: number }
  | { kind: 'shielded'; count: number };

export const NO_CHAPTER_LABEL = 'No chapter';
export const AHEAD_OF_BOOKMARK_LABEL = 'Ahead of your bookmark';

/**
 * ux_spec B.4: dividers mark the start of each contiguous run of the same chapter, only
 * when ≥ 2 distinct non-empty chapters exist among visible (unshielded) notes. A run made
 * only of unrevealed-shielded notes reads "Ahead of your bookmark" (chapter names can be
 * spoilers). Returns a sparse map: note index → divider shown before it.
 */
export function computeChapterDividers(
  notes: Note[],
  isShieldedAt: (note: Note, index: number) => boolean
): Map<number, ChapterDivider> {
  const out = new Map<number, ChapterDivider>();
  const keys = notes.map((n, i) =>
    isShieldedAt(n, i) ? '\u0000shielded' : normalizeChapterInput(n.meta?.chapter) || ''
  );
  const distinct = new Set(keys.filter(k => k && k !== '\u0000shielded'));
  if (distinct.size < 2) return out;
  let i = 0;
  while (i < keys.length) {
    let j = i + 1;
    while (j < keys.length && keys[j] === keys[i]) j += 1;
    const count = j - i;
    const key = keys[i];
    if (key === '\u0000shielded') out.set(i, { kind: 'shielded', count });
    else if (!key) out.set(i, { kind: 'none', count });
    else out.set(i, { kind: 'chapter', label: formatChapterLabel(key), count });
    i = j;
  }
  return out;
}

export function chapterDividerLabel(divider: ChapterDivider): string {
  if (divider.kind === 'chapter') return divider.label;
  return divider.kind === 'shielded' ? AHEAD_OF_BOOKMARK_LABEL : NO_CHAPTER_LABEL;
}
