import type { Book, BookCapstone, Note } from '../types/pragya';
import { formatWhenDoDisplay } from './deltaFormat';
import { formatChapterBadge } from './chapterFormat';
import { effectiveNoteNorm, isNoteSpoiler, isSealedPrediction } from './spoilerMath';
import { getBookCapstone, getBookReadingQuestions } from './metaCodecs';
import { isArchived } from './archive';

/**
 * A2.3 / ux_spec A.5–A.6: zero-AI capstone helpers. Pure string work — no network, no
 * LLM. Selection/truncation mirror the CLI `notesSummary` contract (Batch 5 fix-up).
 */
export const CAPSTONE_PROMPT_MAX_NOTES = 60;
export const CAPSTONE_TEXT_LIMIT = 280;
export const CAPSTONE_HIDDEN_KEY = 'pragya_capstone_prompt_hidden_v1';
export const MAX_SOFT_LEARNINGS = 7;
export const CAPSTONE_COPY_SUCCESS_MESSAGE =
  'Capstone prompt copied. Paste it into your assistant, then bring the reply back with "Write It Myself".';

/** Clipboard write with no throw: false → caller shows the select-and-copy fallback. */
export async function tryCopyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * QA-22 / R1#1: saved + atomic notes of this book that are safe to put on the clipboard.
 * For a book that isn't finished (a capstone kept after a re-read, an undo of
 * mark-finished, a CLI `--allow-unfinished` capstone) notes ahead of the bookmark and
 * sealed predictions are left out — same shield as the Doc/MD timelines.
 */
export function capstoneEligibleNotes(book: Book, notes: Note[]): Note[] {
  const finished = book.status === 'finished';
  return notes.filter(
    n =>
      n.bookId === book.id &&
      !isArchived(n) && // QA-27 / R1#2: CLI build_notes_summary parity
      (n.status === 'saved' || n.status === 'atomic') &&
      (finished || !(isNoteSpoiler(n, book) || isSealedPrediction(n, book)))
  );
}

/** Count of notes eligible for the prompt. */
export function countCapstoneEligibleNotes(book: Book, notes: Note[]): number {
  return capstoneEligibleNotes(book, notes).length;
}

/** A capstone "exists" when at least one field has content (CLI `has_book_capstone`). */
export function hasCapstoneContent(capstone: BookCapstone | undefined): capstone is BookCapstone {
  return Boolean(
    capstone &&
      (capstone.arcOrThesis.trim() || capstone.keyLearnings.length || capstone.perspectiveShift.trim())
  );
}

export function getFilledCapstone(book: Book): BookCapstone | undefined {
  const cap = getBookCapstone(book.meta);
  return hasCapstoneContent(cap) ? cap : undefined;
}

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
}

/**
 * R1#2 / QA-23: cap at 280 *code points* ending in `…` (CLI `_truncate_summary_text`
 * parity — never splits a surrogate pair). Applied to the raw stored text, exactly like
 * the CLI; the prompt collapses newlines afterwards for display.
 */
export function truncateCapstoneText(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  const points = Array.from(text);
  return points.length <= CAPSTONE_TEXT_LIMIT
    ? text
    : `${points.slice(0, CAPSTONE_TEXT_LIMIT - 1).join('')}…`;
}

export const UNTITLED_NOTE_LABEL = 'Quick Note';
const TITLE_WORDS = 8;

/**
 * R1#2: the note's heading line, matching the Companion Doc / CLI `_saved_title_info`:
 * meta.title → first 8 takeaway words (one trailing "." dropped, "…" when cut) → Quick Note.
 */
export function capstoneNoteLabel(note: Note): string {
  const title = oneLine(note.meta?.title);
  if (title) return title;
  const words = oneLine(note.takeaway).split(/\s+/).filter(Boolean);
  if (!words.length) return UNTITLED_NOTE_LABEL;
  const head = words.slice(0, TITLE_WORDS).join(' ');
  const stripped = head.endsWith('.') && head.length > 1 ? head.slice(0, -1) : head;
  return words.length > TITLE_WORDS ? `${stripped}…` : stripped;
}

function readingKey(note: Note, book: Book): [number, number, string] {
  return [effectiveNoteNorm(note, book), Number(note.pos) || 0, String(note.createdAt || '')];
}

function compareReading(a: Note, b: Note, book: Book): number {
  const ka = readingKey(a, book);
  const kb = readingKey(b, book);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
}

/**
 * saved + atomic notes of the book in reading order; over the cap keep all atomic first
 * (most recent if even those overflow), then the most recent saved; re-sorted.
 */
export function selectCapstoneNotes(book: Book, notes: Note[]): { notes: Note[]; omitted: number } {
  const picked = capstoneEligibleNotes(book, notes);
  let kept = picked;
  let omitted = 0;
  if (picked.length > CAPSTONE_PROMPT_MAX_NOTES) {
    const recentFirst = (list: Note[]) =>
      [...list].sort((a, b) => (String(b.createdAt) > String(a.createdAt) ? 1 : String(b.createdAt) < String(a.createdAt) ? -1 : 0));
    const atomic = recentFirst(picked.filter(n => n.status === 'atomic'));
    const saved = recentFirst(picked.filter(n => n.status === 'saved'));
    kept = [...atomic, ...saved].slice(0, CAPSTONE_PROMPT_MAX_NOTES);
    omitted = picked.length - kept.length;
  }
  return { notes: [...kept].sort((a, b) => compareReading(a, b, book)), omitted };
}

/** R1#2: accurate whatever was trimmed (atomic overflow, least-recent saved notes). */
export function formatOmittedLine(omitted: number): string {
  return `(+${omitted} more ${omitted === 1 ? 'note' : 'notes'} left out for length)`;
}

/** ux_spec A.5.1 exact template. */
export function buildCapstonePrompt(book: Book, notes: Note[]): string {
  const fiction = book.kind === 'fiction';
  const { notes: picked, omitted } = selectCapstoneNotes(book, notes);
  const head = [
    `I just finished reading "${book.title}" by ${book.author} (${fiction ? 'Fiction' : 'Non-fiction'}). I'd like a short Whole-Book Picture for my reading journal, built only from my own notes below.`,
    '',
    "Please keep my voice. Don't invent ideas I didn't express, and don't add facts, quotes, or plot details that aren't in my notes.",
    '',
    'Reply in exactly this format so I can paste it back:',
    '',
    `${fiction ? 'ARC' : 'THESIS'}: <2–3 sentences — ${
      fiction ? "the story's arc and what it was really about for me" : "the book's core argument as I understood it"
    }>`,
    'KEY LEARNINGS:',
    '- <3 to 5 one-line learnings, in my words>',
    'HOW MY THINKING SHIFTED: <1–2 sentences on what I now believe or notice differently>',
    '',
    'Give the draft first. After it, you may ask me at most one optional question if something important seems missing.',
    '',
    `My notes (${picked.length} total, in reading order):`,
  ];
  const blocks = picked.map(note => {
    const lines = [`${formatChapterBadge(note.meta?.chapter, Number(note.pos), book.posUnit)} ${capstoneNoteLabel(note)}`];
    const quote = oneLine(truncateCapstoneText(note.quote));
    const takeaway = oneLine(truncateCapstoneText(note.takeaway));
    if (quote) lines.push(`Quote: "${quote}"`);
    if (takeaway) lines.push(`Takeaway: ${takeaway}`);
    // CLI `_summary_delta` parity: atomic notes OR any note whose delta isn't `none`.
    if (note.status === 'atomic' || (note.deltaStatus || 'none') !== 'none') {
      const delta = formatWhenDoDisplay(oneLine(note.deltaTrigger), oneLine(note.deltaAction));
      if (delta.triggerBody || delta.actionBody) {
        lines.push(`Delta: WHEN ${delta.triggerBody} → DO ${delta.actionBody}`);
      }
    }
    return lines.join('\n');
  });
  const parts = [head.join('\n')];
  for (const block of blocks) parts.push(block);
  if (omitted > 0) parts.push(formatOmittedLine(omitted));

  const answeredQuestions = getBookReadingQuestions(book.meta).filter(q => q.status === 'answered');
  if (answeredQuestions.length > 0) {
    const finished = book.status === 'finished';
    const noteById = new Map(notes.map(n => [n.id, n] as const));
    const qLines = ['Reading questions I answered along the way:'];
    for (const q of answeredQuestions) {
      const qText = oneLine(q.question);
      const aText = oneLine(q.answer);
      const linked = q.noteId ? noteById.get(q.noteId) : undefined;
      const safeLinked =
        linked &&
        linked.bookId === book.id &&
        !isArchived(linked) &&
        (finished || !(isNoteSpoiler(linked, book) || isSealedPrediction(linked, book)))
          ? linked
          : undefined;
      const refSuffix = safeLinked ? ` (from: ${capstoneNoteLabel(safeLinked)})` : '';
      qLines.push(`- Q: ${qText}${refSuffix}`);
      if (aText) qLines.push(`  A: ${aText}`);
    }
    parts.push(qLines.join('\n'));
  }

  return parts.join('\n\n');
}

const BULLET_PREFIX = /^\s*(?:[-•*]|\d+[.)])\s*/;

/** One learning per line; strips `-`, `•`, `*`, `1.` / `1)` prefixes; drops empties. */
export function parseLearningsInput(text: string): string[] {
  return (text || '')
    .split(/\r?\n/)
    .map(line => line.replace(BULLET_PREFIX, '').trim())
    .filter(Boolean);
}

export interface ParsedCapstoneReply {
  arcOrThesis?: string;
  keyLearnings?: string[];
  perspectiveShift?: string;
}

const HEADER_RE = /^\s*(arc or thesis|arc|thesis|key learnings|how my thinking shifted)\s*:\s*(.*)$/i;

/**
 * ux_spec A.6 paste-back parser (zero AI): case-insensitive `ARC:` | `THESIS:` |
 * `ARC OR THESIS:`, `KEY LEARNINGS:`, `HOW MY THINKING SHIFTED:`. Returns only the fields
 * it found (callers never clear the others).
 */
export function parseCapstoneReply(text: string): ParsedCapstoneReply {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  // A blank line after content ends a section, so the assistant's optional closing
  // question (asked after the draft) never lands in a field. Learnings may continue
  // past a blank line only with another bullet/numbered line.
  let afterBlank = false;
  for (const raw of (text || '').split(/\r?\n/)) {
    const m = HEADER_RE.exec(raw.replace(/^\s*[*_#>]+\s*/, '').replace(/\*\*/g, ''));
    if (m) {
      const name = m[1].toLowerCase();
      current = name === 'arc' || name === 'thesis' || name === 'arc or thesis' ? 'arc' : name;
      sections[current] = sections[current] || [];
      if (m[2].trim()) sections[current].push(m[2].trim());
      afterBlank = false;
      continue;
    }
    if (!current) continue;
    const hasContent = sections[current].some(line => line.trim());
    if (!raw.trim()) {
      if (hasContent) afterBlank = true;
      continue;
    }
    if (afterBlank) {
      if (current === 'key learnings' && BULLET_PREFIX.test(raw)) {
        afterBlank = false;
      } else {
        current = null;
        afterBlank = false;
        continue;
      }
    }
    sections[current].push(raw);
  }
  const out: ParsedCapstoneReply = {};
  const join = (lines: string[] | undefined) => (lines || []).join('\n').trim();
  const arc = join(sections.arc);
  if (arc) out.arcOrThesis = arc.replace(/\s*\n\s*/g, ' ');
  const learnings = parseLearningsInput(join(sections['key learnings']));
  if (learnings.length) out.keyLearnings = learnings;
  // QA-24: the assistant's optional closing question may follow on the very next line.
  // A last paragraph line ending in "?" after earlier content is that question, not
  // part of the shift (a shift that is itself one question is kept).
  const shiftLines = (sections['how my thinking shifted'] || []).filter(line => line.trim());
  if (shiftLines.length > 1 && /\?\s*$/.test(shiftLines[shiftLines.length - 1])) shiftLines.pop();
  const shift = join(shiftLines);
  if (shift) out.perspectiveShift = shift.replace(/\s*\n\s*/g, ' ');
  return out;
}

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** An ISO-8601 date/timestamp the CLI's `parse_iso_utc` would also accept. */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return ISO_TIMESTAMP_RE.test(s) && Number.isFinite(Date.parse(s.replace(' ', 'T')));
}

/**
 * completedAt = now on first save; preserved on edit (raw unknown keys pass through).
 * R1#3: a stored completedAt that isn't a timestamp ("soon", 123) is repaired to now,
 * like CLI `book-capstone` (QA-15). Partial capstones stay allowed here on purpose
 * (user-authored); the CLI stays strict for agent-generated ones.
 */
export function buildCapstoneForSave(
  existingRaw: unknown,
  fields: { arcOrThesis: string; learningsText: string; perspectiveShift: string },
  nowIso: string
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)
      ? { ...(existingRaw as Record<string, unknown>) }
      : {};
  const previous = isIsoTimestamp(base.completedAt) ? base.completedAt.trim() : '';
  return {
    ...base,
    arcOrThesis: fields.arcOrThesis.trim(),
    keyLearnings: parseLearningsInput(fields.learningsText),
    perspectiveShift: fields.perspectiveShift.trim(),
    completedAt: previous || nowIso,
  };
}

export function readHiddenCapstoneBooks(storage: Pick<Storage, 'getItem'> = localStorage): string[] {
  try {
    const parsed = JSON.parse(storage.getItem(CAPSTONE_HIDDEN_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function hideCapstonePromptForBook(
  bookId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage
): void {
  const ids = readHiddenCapstoneBooks(storage);
  if (!ids.includes(bookId)) ids.push(bookId);
  storage.setItem(CAPSTONE_HIDDEN_KEY, JSON.stringify(ids));
}
