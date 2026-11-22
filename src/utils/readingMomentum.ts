import type { Book, BookMetaJson, Note, ReadingQuestion, ReadingSession } from '../types/pragya';
import { isArchived, withoutArchived } from './archive';
import { bookSessionsNewestFirst } from './bookSurfaces';
import { formatChapterPos } from './chapterFormat';
import {
  BOOK_CONTEXT_NOTE_MAX,
  BOOK_NEXT_STOP_MAX,
  MAX_OPEN_READING_QUESTIONS,
  READING_ANSWER_MAX,
  READING_QUESTION_MAX,
  getBookMetaString,
  getBookReadingQuestions,
  isPlainObject,
  type BookContextMetaKey,
} from './metaCodecs';
import { createUuid } from './sessionCoalesce';
import { formatPosDisplay, isNoteSpoiler, isSealedPrediction } from './spoilerMath';
import { toLocalDateKey } from './takeawayShuffle';

export const REENTRY_COPY_SUCCESS_MESSAGE =
  'Re-entry prompt copied. Paste it into your assistant for a spoiler-safe catch-up.';

const GENERIC_MATCH_TAGS = new Set([
  '#favorite',
  '#favorites',
  '#fiction',
  '#nonfiction',
  '#prediction',
  '#quote',
  '#book',
  '#reading',
]);

function clampText(value: string, maxLen: number): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  const points = Array.from(trimmed);
  return points.length <= maxLen ? trimmed : points.slice(0, maxLen).join('').trim();
}

export function normalizeBookContextValue(key: BookContextMetaKey, value: string): string {
  const limit = key === 'nextStop' ? BOOK_NEXT_STOP_MAX : BOOK_CONTEXT_NOTE_MAX;
  return clampText(value, limit);
}

/** Sets or clears `whyQueued`, `pauseNote`, or `nextStop` on book meta without touching other keys. */
export function withBookContextField(
  meta: BookMetaJson,
  key: BookContextMetaKey,
  value: string
): BookMetaJson {
  const next: BookMetaJson = { ...meta };
  const cleaned = normalizeBookContextValue(key, value);
  if (cleaned) next[key] = cleaned;
  else delete next[key];
  return next;
}

/** Short, race-safe id (`q_<8hex>`) for reading questions. */
export function createReadingQuestionId(): string {
  const hex = createUuid().replace(/-/g, '').slice(0, 8);
  return `q_${hex}`;
}

function resolveRawQuestionIndex(rawList: unknown[], idOrPrefix: string): number {
  const needle = (idOrPrefix || '').trim();
  if (!needle) return -1;
  const exactIdx = rawList.findIndex(
    item => isPlainObject(item) && typeof item.id === 'string' && item.id.trim() === needle
  );
  if (exactIdx >= 0) return exactIdx;
  const prefixMatches: number[] = [];
  rawList.forEach((item, idx) => {
    if (isPlainObject(item) && typeof item.id === 'string' && item.id.trim().startsWith(needle)) {
      prefixMatches.push(idx);
    }
  });
  return prefixMatches.length === 1 ? prefixMatches[0] : -1;
}

/**
 * Adds a new open reading question while preserving unknown raw entries verbatim.
 * Enforces the locked invariant: <= 5 open questions per book.
 */
export function addReadingQuestion(
  existingRaw: unknown,
  questionText: string,
  nowIso: string = new Date().toISOString(),
  id?: string
): unknown[] {
  const cleaned = clampText(questionText, READING_QUESTION_MAX);
  if (!cleaned) {
    throw new Error('Reading question cannot be empty.');
  }
  const existing = Array.isArray(existingRaw) ? [...existingRaw] : [];
  const parsed = getBookReadingQuestions({ readingQuestions: existing });
  const openCount = parsed.filter(q => q.status === 'open').length;
  if (openCount >= MAX_OPEN_READING_QUESTIONS) {
    throw new Error(
      `Open reading question limit (${MAX_OPEN_READING_QUESTIONS}) reached for this book. Answer or remove one first.`
    );
  }
  const takenIds = new Set(parsed.map(q => q.id));
  let resolvedId = (id || '').trim() || createReadingQuestionId();
  while (takenIds.has(resolvedId)) {
    resolvedId = createReadingQuestionId();
  }
  const entry: ReadingQuestion = {
    id: resolvedId,
    question: cleaned,
    status: 'open',
    createdAt: nowIso,
  };
  return [...existing, entry];
}

export function editReadingQuestion(
  existingRaw: unknown,
  idOrPrefix: string,
  questionText: string
): unknown[] {
  const cleaned = clampText(questionText, READING_QUESTION_MAX);
  if (!cleaned) {
    throw new Error('Reading question cannot be empty.');
  }
  const existing = Array.isArray(existingRaw) ? [...existingRaw] : [];
  const idx = resolveRawQuestionIndex(existing, idOrPrefix);
  if (idx < 0) {
    throw new Error(`Reading question "${idOrPrefix}" not found.`);
  }
  const current = existing[idx] as Record<string, unknown>;
  existing[idx] = { ...current, question: cleaned };
  return existing;
}

export function answerReadingQuestion(
  existingRaw: unknown,
  idOrPrefix: string,
  patch: { answer?: string; noteId?: string },
  nowIso: string = new Date().toISOString()
): unknown[] {
  const existing = Array.isArray(existingRaw) ? [...existingRaw] : [];
  const idx = resolveRawQuestionIndex(existing, idOrPrefix);
  if (idx < 0) {
    throw new Error(`Reading question "${idOrPrefix}" not found.`);
  }
  const current = existing[idx] as Record<string, unknown>;
  const next: Record<string, unknown> = {
    ...current,
    status: 'answered',
    answeredAt:
      typeof current.answeredAt === 'string' && current.answeredAt.trim()
        ? current.answeredAt
        : nowIso,
  };
  if (patch.answer !== undefined) {
    const cleanedAnswer = clampText(patch.answer, READING_ANSWER_MAX);
    if (cleanedAnswer) next.answer = cleanedAnswer;
    else delete next.answer;
  }
  if (patch.noteId !== undefined) {
    const cleanedNoteId = patch.noteId.trim();
    if (cleanedNoteId) next.noteId = cleanedNoteId;
    else delete next.noteId;
  }
  existing[idx] = next;
  return existing;
}

export function reopenReadingQuestion(existingRaw: unknown, idOrPrefix: string): unknown[] {
  const existing = Array.isArray(existingRaw) ? [...existingRaw] : [];
  const idx = resolveRawQuestionIndex(existing, idOrPrefix);
  if (idx < 0) {
    throw new Error(`Reading question "${idOrPrefix}" not found.`);
  }
  const openCount = getBookReadingQuestions({ readingQuestions: existing }).filter(
    q => q.status === 'open'
  ).length;
  const current = existing[idx] as Record<string, unknown>;
  if (current.status === 'answered' && openCount >= MAX_OPEN_READING_QUESTIONS) {
    throw new Error(
      `Open reading question limit (${MAX_OPEN_READING_QUESTIONS}) reached for this book.`
    );
  }
  const next: Record<string, unknown> = { ...current, status: 'open' };
  delete next.answeredAt;
  existing[idx] = next;
  return existing;
}

export function removeReadingQuestion(
  existingRaw: unknown,
  idOrPrefix: string
): unknown[] | undefined {
  const existing = Array.isArray(existingRaw) ? [...existingRaw] : [];
  const idx = resolveRawQuestionIndex(existing, idOrPrefix);
  if (idx < 0) {
    throw new Error(`Reading question "${idOrPrefix}" not found.`);
  }
  existing.splice(idx, 1);
  return existing.length > 0 ? existing : undefined;
}

export interface SittingPaceEstimate {
  medianDelta: number;
  sittingsLeft: number;
  sessionCount: number;
  label: string;
}

const HAS_TZ_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function parseIsoUtcMs(raw: string): number {
  const s = (raw || '').trim();
  if (!s || !s.includes('T')) return Number.NaN;
  return Date.parse(HAS_TZ_RE.test(s) ? s : `${s}Z`);
}

function sessionBelongsToCurrentRead(session: ReadingSession, startedAt: string | undefined): boolean {
  if (!startedAt || !startedAt.trim()) return true;
  const startedMs = parseIsoUtcMs(startedAt);
  const sessionUpdatedMs = parseIsoUtcMs(session.updatedAt || '');
  // When both full timestamps parse, compare directly with a 60 s clock-skew tolerance so
  // a same-day re-read excludes sessions from Read #1 earlier that day.
  if (Number.isFinite(startedMs) && Number.isFinite(sessionUpdatedMs)) {
    return sessionUpdatedMs >= startedMs - 60_000;
  }
  const startDay = toLocalDateKey(startedAt);
  const sessDay = toLocalDateKey(session.date);
  if (startDay && sessDay) return sessDay >= startDay;
  return true;
}

function formatPaceUnit(delta: number, posUnit: Book['posUnit']): string {
  if (posUnit === 'percent') {
    const rounded = Math.max(0.1, Math.round(delta * 10) / 10);
    return `${rounded}%`;
  }
  const rounded = Math.max(1, Math.round(delta));
  if (posUnit === 'loc') return `${rounded} ${rounded === 1 ? 'loc' : 'locs'}`;
  return `${rounded} ${rounded === 1 ? 'page' : 'pages'}`;
}

/**
 * Calm sitting-pace hint for an actively reading book.
 * Returns null unless:
 * - book.status === 'reading'
 * - effectiveTotal > 0 (100 for percent, else book.totalPos) and currentPos < effectiveTotal
 * - >= 2 positive-progress sessions exist since book.meta.startedAt (re-read safe)
 */
export function computeSittingPace(
  book: Book,
  sessions: readonly ReadingSession[]
): SittingPaceEstimate | null {
  if (book.status !== 'reading') return null;
  const effectiveTotal = book.posUnit === 'percent' ? 100 : book.totalPos;
  if (!Number.isFinite(effectiveTotal) || effectiveTotal <= 0) return null;
  const current = Math.max(0, Number(book.currentPos) || 0);
  if (current >= effectiveTotal) return null;

  const startedAt = typeof book.meta?.startedAt === 'string' ? book.meta.startedAt : undefined;
  const deltas: number[] = [];
  for (const s of sessions) {
    if (s.bookId !== book.id) continue;
    if (!sessionBelongsToCurrentRead(s, startedAt)) continue;
    const d = (Number(s.endPos) || 0) - (Number(s.startPos) || 0);
    if (Number.isFinite(d) && d > 0) deltas.push(d);
  }
  if (deltas.length < 2) return null;

  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const medianDelta =
    deltas.length % 2 === 1 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
  if (!Number.isFinite(medianDelta) || medianDelta <= 0) return null;

  const remaining = effectiveTotal - current;
  const sittingsLeft = Math.max(1, Math.ceil(remaining / medianDelta));
  const unitLabel = formatPaceUnit(medianDelta, book.posUnit);
  const sittingLabel = sittingsLeft === 1 ? 'about 1 sitting left' : `about ${sittingsLeft} sittings left`;
  return {
    medianDelta,
    sittingsLeft,
    sessionCount: deltas.length,
    label: `~${unitLabel} a sitting · ${sittingLabel}`,
  };
}

export interface NextReadCandidate {
  book: Book;
  role: 'contrast' | 'short' | 'spark';
  reason: string;
}

function wordTokens(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .split(/[^a-z0-9-]+/i)
      .map(t => t.trim())
      .filter(Boolean)
  );
}

/**
 * Picks up to 3 non-archived queued books contrasted calmly by genre texture, length,
 * and thematic/whyQueued spark.
 */
export function pickNextReadCandidates(
  books: readonly Book[],
  notes: readonly Note[],
  referenceBook?: Book | null
): NextReadCandidate[] {
  const allBooksById = new Map(books.map(b => [b.id, b] as const));
  const liveBooks = withoutArchived([...books]);
  const queued = liveBooks.filter(b => b.status === 'queued');
  if (queued.length === 0) return [];

  const activeReading = liveBooks.filter(b => b.status === 'reading');
  const refKind = referenceBook?.kind ?? activeReading[0]?.kind ?? null;

  // Gather recent specific tags and authors from unshielded notes belonging to LIVE books only.
  const recentTags = new Set<string>();
  const recentAuthors = new Set<string>();
  const sortedNotes = [...notes]
    .filter(n => {
      if (isArchived(n)) return false;
      const b = allBooksById.get(n.bookId);
      if (!b || isArchived(b)) return false;
      return !isNoteSpoiler(n, b) && !isSealedPrediction(n, b);
    })
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 15);
  for (const n of sortedNotes) {
    for (const tag of n.tags || []) {
      const lower = tag.trim().toLowerCase();
      if (lower && !GENERIC_MATCH_TAGS.has(lower)) recentTags.add(lower.replace(/^#/, ''));
    }
    const nb = allBooksById.get(n.bookId);
    if (nb?.author && nb.author.trim().toLowerCase() !== 'unknown author') {
      recentAuthors.add(nb.author.trim().toLowerCase());
    }
  }

  const picked: NextReadCandidate[] = [];
  const usedIds = new Set<string>();

  const take = (book: Book | undefined, role: NextReadCandidate['role'], reason: string) => {
    if (!book || usedIds.has(book.id)) return;
    usedIds.add(book.id);
    picked.push({ book, role, reason });
  };

  // 1. Different texture (opposite kind from just-finished or active book).
  if (refKind) {
    const opposite = queued
      .filter(b => b.kind !== refKind)
      .sort((a, b) => {
        const aSpark = getBookMetaString(a.meta, 'whyQueued') ? 1 : 0;
        const bSpark = getBookMetaString(b.meta, 'whyQueued') ? 1 : 0;
        if (aSpark !== bSpark) return bSpark - aSpark;
        return a.title.localeCompare(b.title);
      })[0];
    if (opposite) {
      take(
        opposite,
        'contrast',
        opposite.kind === 'fiction' ? 'Change of pace · Fiction' : 'Change of pace · Non-fiction'
      );
    }
  }

  // 2. Shorter read (smallest known totalPos > 0 among remaining queued books).
  const shortest = queued
    .filter(b => !usedIds.has(b.id) && b.totalPos > 0 && b.posUnit !== 'percent')
    .sort((a, b) => {
      if (a.posUnit !== b.posUnit) return a.posUnit === 'page' ? -1 : 1;
      return a.totalPos - b.totalPos || a.title.localeCompare(b.title);
    })[0];
  if (shortest) {
    take(
      shortest,
      'short',
      `Shorter read · ${shortest.totalPos} ${shortest.posUnit === 'loc' ? 'locs' : 'pages'}`
    );
  }

  // 3. Connected thread (author or token-matched tag) or whyQueued spark.
  const remaining = queued.filter(b => !usedIds.has(b.id));
  const scoredSpark = remaining
    .map(b => {
      const why = getBookMetaString(b.meta, 'whyQueued');
      const tokens = wordTokens(`${b.title} ${b.author} ${why}`);
      let score = why ? 2 : 0;
      let matchedTag = '';
      const authorMatched = recentAuthors.has(b.author.trim().toLowerCase());
      if (authorMatched) score += 3;
      for (const t of recentTags) {
        if (t.length >= 4 && tokens.has(t)) {
          score += 2;
          if (!matchedTag) matchedTag = `#${t}`;
        }
      }
      return { book: b, score, why, matchedTag, authorMatched };
    })
    .sort((a, b) => b.score - a.score || a.book.title.localeCompare(b.book.title))[0];

  if (scoredSpark) {
    const reason = scoredSpark.matchedTag
      ? `Echoes ${scoredSpark.matchedTag}`
      : scoredSpark.authorMatched
        ? `Same author · ${scoredSpark.book.author}`
        : scoredSpark.why
          ? 'Your spark note'
          : 'In your queue';
    take(scoredSpark.book, 'spark', reason);
  }

  // Fill up to 3 deterministically if slots remain.
  const fallbackSorted = [...queued].sort((a, b) => {
    const aSpark = getBookMetaString(a.meta, 'whyQueued') ? 1 : 0;
    const bSpark = getBookMetaString(b.meta, 'whyQueued') ? 1 : 0;
    if (aSpark !== bSpark) return bSpark - aSpark;
    return a.title.localeCompare(b.title);
  });
  for (const b of fallbackSorted) {
    if (picked.length >= 3) break;
    take(b, 'spark', getBookMetaString(b.meta, 'whyQueued') ? 'Your spark note' : 'In your queue');
  }

  return picked;
}

/**
 * Zero-AI Re-Entry Prompt for picking a book back up via an external assistant.
 * Strictly spoiler-safe: excludes notes > bookmark and redacts sealed prediction text
 * (count + positions only).
 */
export function buildReEntryPrompt(
  book: Book,
  notes: readonly Note[],
  sessions: readonly ReadingSession[]
): string {
  const where = formatChapterPos(book.meta?.currentChapter, Number(book.currentPos) || 0, book.posUnit);
  const nextStop = getBookMetaString(book.meta, 'nextStop');

  const safeNotes = notes
    .filter(
      n =>
        n.bookId === book.id &&
        n.meta?.entryKind !== 'word' &&
        !isArchived(n) &&
        !isNoteSpoiler(n, book) &&
        !isSealedPrediction(n, book) &&
        Boolean(n.takeaway?.trim() || n.quote?.trim())
    )
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 3)
    .sort((a, b) => Number(a.pos) - Number(b.pos) || a.createdAt.localeCompare(b.createdAt));

  const sealedPredictions = notes
    .filter(n => n.bookId === book.id && !isArchived(n) && isSealedPrediction(n, book))
    .sort((a, b) => Number(a.pos) - Number(b.pos));

  const openQuestions = getBookReadingQuestions(book.meta).filter(q => q.status === 'open');
  const latestSession = bookSessionsNewestFirst([...sessions], book.id)[0];

  const lines: string[] = [
    `Help me pick "${book.title}" by ${book.author} (${book.kind === 'fiction' ? 'Fiction' : 'Non-fiction'}) back up smoothly.`,
    `I'm currently at ${where}${book.totalPos > 0 ? ` of ${book.totalPos}` : ''}.`,
  ];

  if (nextStop) {
    lines.push(`My next stopping point: ${nextStop}`);
  }
  if (latestSession?.note?.trim()) {
    lines.push(`Last session note (${latestSession.date}): ${latestSession.note.trim()}`);
  }

  if (openQuestions.length > 0) {
    lines.push('');
    lines.push('Open questions I am reading to answer:');
    for (const q of openQuestions) {
      lines.push(`- ${q.question}`);
    }
  }

  if (safeNotes.length > 0) {
    lines.push('');
    lines.push('My recent notes so far:');
    for (const n of safeNotes) {
      const posLabel = formatChapterPos(n.meta?.chapter, Number(n.pos) || 0, book.posUnit);
      const body = (n.takeaway || n.quote || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
      lines.push(`- [${posLabel}] ${body}`);
    }
  }

  if (sealedPredictions.length > 0) {
    const positions = sealedPredictions
      .map(p => formatPosDisplay(Number(p.pos) || 0, book.posUnit))
      .join(', ');
    lines.push('');
    lines.push(
      `Sealed predictions waiting until I finish: ${sealedPredictions.length} (logged at ${positions}).`
    );
  }

  lines.push('');
  lines.push(
    book.status === 'finished'
      ? 'Give me a brief 3-4 line refresher grounded in my own notes above so I can jump back in.'
      : `Give me a brief 3-4 line spoiler-safe refresher strictly up to ${formatPosDisplay(
          Number(book.currentPos) || 0,
          book.posUnit
        )} — do NOT mention any plot points, chapters, or arguments after that point.`
  );

  return lines.join('\n');
}
