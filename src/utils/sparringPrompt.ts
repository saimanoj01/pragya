import type { Book, Note } from '../types/pragya';
import { formatChapterPos } from './chapterFormat';
import { formatPosDisplay, isUnlockedPrediction } from './spoilerMath';
import { isShielded } from './noteVisibility';

/**
 * CD C4.1 / C4.2 (ux_spec_cd C.4.4): zero-AI "Copy Sparring Prompt". Pure string assembly —
 * no network, no LLM. Only THIS note's own text goes in; for an unfinished fiction book
 * the prompt states the reader's bookmark as a spoiler ceiling. A spoiler-shielded note
 * (ahead of the bookmark, not revealed) never yields a prompt.
 */
export const SPARRING_COPY_SUCCESS_MESSAGE = 'Sparring prompt copied. Paste it into your assistant.';

/** NoteDetailView shows the button for these statuses (hidden for atomic). */
export function canCopySparringPrompt(note: Note): boolean {
  return note.status === 'saved' || note.status === 'inbox' || note.status === 'in-reflection';
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function socraticList(note: Note): string[] {
  const qs = note.meta?.socraticQuestions;
  return Array.isArray(qs) ? qs.map(clean).filter(Boolean) : [];
}

function predictionOutcomeText(note: Note): string {
  const po = note.meta?.predictionOutcome;
  return po && typeof po === 'object' ? clean((po as { text?: unknown }).text) : '';
}

/**
 * Exact ux_spec_cd C.4.4 template. Returns null when the note is shielded (`revealed`
 * false and ahead of the bookmark) or has no book. An unlocked prediction (finished
 * fiction) gets the "how did my prediction compare" variant (C4.2).
 */
export function buildSparringPrompt(
  note: Note,
  book: Book | null | undefined,
  options: { revealed?: boolean } = {}
): string | null {
  if (!book) return null;
  if (isShielded(note, book, Boolean(options.revealed))) return null;
  const fiction = book.kind === 'fiction';
  const where = formatChapterPos(note.meta?.chapter, Number(note.pos) || 0, book.posUnit);
  const quote = clean(note.quote);
  const takeaway = clean(note.takeaway);

  if (isUnlockedPrediction(note, book)) {
    const outcome = predictionOutcomeText(note);
    const lines = [
      `Help me reflect on a prediction I made while reading "${book.title}" by ${book.author} (Fiction), at ${where}.`,
      '',
      ...(takeaway ? [`My prediction: ${takeaway}`] : []),
      ...(quote ? [`Quote I was reacting to: "${quote}"`] : []),
      ...(outcome ? [`What actually happened, in my words: ${outcome}`] : []),
      '',
      "I've finished the book now. Ask me 2 short questions about how my prediction compared with what happened — what I read correctly, and what the author did that I didn't see coming. Then wait for my answers. Don't summarize the book or answer for me.",
    ];
    return lines.join('\n');
  }

  const questions = socraticList(note);
  const lens = fiction
    ? 'what the author is doing here, and why it landed for me'
    : 'where it would fail, and where I could actually use it';
  const lines = [
    `Help me think through a note from "${book.title}" by ${book.author} (${fiction ? 'Fiction' : 'Non-fiction'}), from ${where} in my reading.`,
    '',
    ...(quote ? [`Quote: "${quote}"`] : []),
    // R2#3: a quote-only note has no takeaway line (no dangling "My takeaway: ").
    ...(takeaway ? [`My takeaway: ${takeaway}`] : []),
    ...(questions.length ? [`Questions I've already been asked: ${questions.join(' / ')}`] : []),
    '',
    `Ask me 2 short Socratic questions ${takeaway ? 'that test this idea' : 'about this passage'} — ${lens}. Then wait for my answers. Don't summarize the book or answer for me.`,
    ...(fiction && book.status !== 'finished'
      ? [
          // R1 nit 5: a revealed note ahead of the bookmark raises the ceiling to the note.
          `I'm only at ${formatPosDisplay(
            Math.max(Number(book.currentPos) || 0, Number(note.pos) || 0),
            book.posUnit
          )}. Don't mention anything that happens after that point.`,
        ]
      : []),
    `When we're done, help me phrase it as: a one-line takeaway, how it works, where it breaks${
      fiction ? '' : ', and one "WHEN … → DO …" habit'
    }.`,
  ];
  return lines.join('\n');
}
