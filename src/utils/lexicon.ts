import type { Book, Note, WordLexicon } from '../types/pragya';
import { isArchived } from './archive';
import { getRenderableAttachments, isPlainObject } from './metaCodecs';
import { formatPosDisplay, isNoteSpoiler, isSealedPrediction } from './spoilerMath';
import { fnv1aHash, getCalendarDaysBetween, toLocalDateKey } from './takeawayShuffle';

export interface WordLexiconInput {
  word: string;
  lemma?: string;
  pronunciation?: string;
  partOfSpeech?: string;
  definition?: string;
  etymology?: string;
  transferExample?: string;
}

export interface WordEncounter {
  note: Note;
  book: Book | undefined;
  lexicon: WordLexicon;
  shielded: boolean;
  sealedPrediction: boolean;
  word: string;
  quote: string;
  definition: string;
  etymology: string;
  transferExample: string;
  pronunciation: string;
  partOfSpeech: string;
  posLabel: string;
  createdAt: string;
  updatedAt: string;
}

export interface WordLemmaGroup {
  lemma: string;
  word: string;
  pronunciation?: string;
  partOfSpeech?: string;
  definition?: string;
  etymology?: string;
  transferExample?: string;
  encounters: WordEncounter[];
  allShielded: boolean;
  latestCreatedAt: string;
  needsDefinition: boolean;
}

export interface GroupWordsOptions {
  bookId?: string;
  query?: string;
  sort?: 'az' | 'recent';
  includeSpoilers?: boolean;
  revealedNoteIds?: ReadonlySet<string>;
}

export interface LexiconStrollPick {
  note: Note;
  book: Book;
  lexicon: WordLexicon;
  /** Group-enriched definition/etymology/POS/pronunciation merged across unshielded encounters of this lemma. */
  displayLexicon: WordLexicon;
  posLabel: string;
}

export function normalizeLemma(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function cleanOptionalText(value: unknown, maxLen?: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (maxLen && trimmed.length > maxLen) {
    return trimmed.slice(0, maxLen).trim() || undefined;
  }
  return trimmed;
}

export function normalizeWordLexicon(input: WordLexiconInput): WordLexicon {
  const word = String(input.word ?? '').trim();
  const lemmaSource = cleanOptionalText(input.lemma) ?? word;
  const out: WordLexicon = {
    word,
    lemma: normalizeLemma(lemmaSource),
  };
  const pronunciation = cleanOptionalText(input.pronunciation, 120);
  const partOfSpeech = cleanOptionalText(input.partOfSpeech, 80);
  const definition = cleanOptionalText(input.definition, 1200);
  const etymology = cleanOptionalText(input.etymology, 1200);
  const transferExample = cleanOptionalText(input.transferExample, 600);
  if (pronunciation) out.pronunciation = pronunciation;
  if (partOfSpeech) out.partOfSpeech = partOfSpeech;
  if (definition) out.definition = definition;
  if (etymology) out.etymology = etymology;
  if (transferExample) out.transferExample = transferExample;
  return out;
}

/**
 * Discriminator for contextual vocabulary notes stored in `Notes!A:R`.
 */
export function isWordNote(note: Pick<Note, 'meta'> | null | undefined): boolean {
  return note?.meta?.entryKind === 'word';
}

/**
 * Extracts normalized `WordLexicon` when `note` is a valid word entry (`meta.entryKind === 'word'`
 * and non-empty `meta.lexicon.word`). Returns `null` otherwise.
 */
export function getWordLexicon(note: Pick<Note, 'meta'> | null | undefined): WordLexicon | null {
  if (!isWordNote(note)) return null;
  const raw = note?.meta?.lexicon;
  if (!isPlainObject(raw)) return null;
  const word = typeof raw.word === 'string' ? raw.word.trim() : '';
  if (!word) return null;
  return normalizeWordLexicon({
    word,
    lemma: typeof raw.lemma === 'string' ? raw.lemma : undefined,
    pronunciation: typeof raw.pronunciation === 'string' ? raw.pronunciation : undefined,
    partOfSpeech: typeof raw.partOfSpeech === 'string' ? raw.partOfSpeech : undefined,
    definition: typeof raw.definition === 'string' ? raw.definition : undefined,
    etymology: typeof raw.etymology === 'string' ? raw.etymology : undefined,
    transferExample: typeof raw.transferExample === 'string' ? raw.transferExample : undefined,
  });
}

/**
 * Shared validity invariant: normal notes need takeaway, quote, or attachment;
 * word notes (`entryKind === 'word'`) are valid with `meta.lexicon.word` alone.
 */
export function noteHasValidContent(
  note: Pick<Note, 'quote' | 'takeaway' | 'meta'> | null | undefined
): boolean {
  if (!note) return false;
  if (isWordNote(note)) {
    return Boolean(getWordLexicon(note)?.word);
  }
  return Boolean(
    note.takeaway?.trim() || note.quote?.trim() || getRenderableAttachments(note.meta).length > 0
  );
}

/**
 * Deterministic canonical tag helper: ensures `#vocabulary` is present without duplicates.
 */
export function ensureVocabularyTag(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const trimmed = String(raw ?? '').trim().toLowerCase();
    if (!trimmed) continue;
    const canonical = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  if (!seen.has('#vocabulary')) {
    out.push('#vocabulary');
  }
  return out;
}

export function formatWordEncounterPos(note: Note, book: Book | undefined): string {
  if (!book) {
    return note.pos > 0 ? String(note.pos) : '';
  }
  return formatPosDisplay(note.pos, book.posUnit);
}

function richnessScore(lex: WordLexicon): number {
  let score = 0;
  if (lex.definition) score += 4;
  if (lex.etymology) score += 2;
  if (lex.pronunciation) score += 1;
  if (lex.partOfSpeech) score += 1;
  if (lex.transferExample) score += 1;
  return score;
}

/**
 * Groups non-archived word encounters by lowercase `lexicon.lemma`.
 * Spoiler-shielded encounters are redacted unless `includeSpoilers` is true or
 * the note ID is in `revealedNoteIds`. Shielded-only groups sort after visible groups
 * so alphabetical ordering never leaks the position of hidden future words.
 */
export function groupWordsByLemma(
  notes: readonly Note[],
  books: readonly Book[],
  options: GroupWordsOptions = {}
): WordLemmaGroup[] {
  const {
    bookId,
    query = '',
    sort = 'az',
    includeSpoilers = false,
    revealedNoteIds,
  } = options;
  const bookMap = new Map(books.map(b => [b.id, b]));
  const needle = query.trim().toLowerCase();

  const buckets = new Map<string, { allShielded: boolean; encounters: WordEncounter[] }>();

  for (const note of notes) {
    if (isArchived(note)) continue;
    if (!isWordNote(note)) continue;
    const lex = getWordLexicon(note);
    if (!lex) continue;
    const book = bookMap.get(note.bookId);
    if (book && isArchived(book)) continue;
    if (bookId && note.bookId !== bookId) continue;

    const noteSpoiler = book ? isNoteSpoiler(note, book) : false;
    const sealed = book ? isSealedPrediction(note, book) : false;
    const rawShielded = noteSpoiler || sealed;
    const isRevealed = Boolean(revealedNoteIds?.has(note.id));
    const redact = rawShielded && !includeSpoilers && !isRevealed;

    const posLabel = formatWordEncounterPos(note, book);
    const encounter: WordEncounter = {
      note,
      book,
      lexicon: lex,
      shielded: redact,
      sealedPrediction: sealed && redact,
      word: redact ? '' : lex.word,
      quote: redact ? '' : note.quote ?? '',
      definition: redact ? '' : lex.definition ?? '',
      etymology: redact ? '' : lex.etymology ?? '',
      transferExample: redact ? '' : lex.transferExample ?? '',
      pronunciation: redact ? '' : lex.pronunciation ?? '',
      partOfSpeech: redact ? '' : lex.partOfSpeech ?? '',
      posLabel,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };

    // Keep unshielded or multi-encounter visible lemmas grouped by lemma.
    // Redacted encounters still join their lemma if the user already met that lemma elsewhere;
    // if ALL encounters of a lemma are redacted, we collapse them safely with empty text.
    const bucketKey = lex.lemma;
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.encounters.push(encounter);
      if (!redact) existing.allShielded = false;
    } else {
      buckets.set(bucketKey, {
        allShielded: redact,
        encounters: [encounter],
      });
    }
  }

  const groups: WordLemmaGroup[] = [];

  for (const [lemma, bucket] of buckets.entries()) {
    const encounters = [...bucket.encounters].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    const visibleEncounters = encounters.filter(e => !e.shielded);
    const allShielded = visibleEncounters.length === 0;

    let rep: WordEncounter | undefined;
    if (!allShielded) {
      rep = [...visibleEncounters].sort((a, b) => {
        const diff = richnessScore(b.lexicon) - richnessScore(a.lexicon);
        if (diff !== 0) return diff;
        return b.createdAt.localeCompare(a.createdAt);
      })[0];
    }

    const firstWith = <K extends keyof WordLexicon>(key: K): string | undefined => {
      for (const e of visibleEncounters) {
        const val = e.lexicon[key];
        if (typeof val === 'string' && val.trim()) return val.trim();
      }
      return undefined;
    };

    const word = allShielded ? '' : rep?.word || visibleEncounters[0]?.word || '';
    const pronunciation = allShielded ? undefined : firstWith('pronunciation');
    const partOfSpeech = allShielded ? undefined : firstWith('partOfSpeech');
    const definition = allShielded ? undefined : firstWith('definition');
    const etymology = allShielded ? undefined : firstWith('etymology');
    const transferExample = allShielded ? undefined : firstWith('transferExample');
    const latestCreatedAt = encounters[0]?.createdAt ?? '';
    const needsDefinition = !allShielded && !definition;

    if (needle) {
      if (allShielded) {
        // Shielded-only cards never match text queries (no spoiler leakage through search).
        continue;
      }
      const haystackParts = [
        word,
        lemma,
        pronunciation ?? '',
        partOfSpeech ?? '',
        definition ?? '',
        etymology ?? '',
        transferExample ?? '',
      ];
      for (const e of visibleEncounters) {
        haystackParts.push(
          e.quote,
          e.book?.title ?? '',
          e.book?.author ?? '',
          e.note.meta?.chapter ?? ''
        );
      }
      const haystack = haystackParts.join(' ').toLowerCase();
      if (!haystack.includes(needle)) continue;
    }

    groups.push({
      lemma: allShielded ? '' : lemma,
      word,
      pronunciation,
      partOfSpeech,
      definition,
      etymology,
      transferExample,
      encounters,
      allShielded,
      latestCreatedAt,
      needsDefinition,
    });
  }

  groups.sort((a, b) => {
    if (sort === 'recent') {
      const cmp = b.latestCreatedAt.localeCompare(a.latestCreatedAt);
      if (cmp !== 0) return cmp;
      return a.word.localeCompare(b.word);
    }
    if (a.allShielded !== b.allShielded) {
      return a.allShielded ? 1 : -1;
    }
    const cmp = a.lemma.localeCompare(b.lemma);
    if (cmp !== 0) return cmp;
    return b.latestCreatedAt.localeCompare(a.latestCreatedAt);
  });

  return groups;
}

/**
 * Returns non-archived word notes for a single book, ordered by reading position then recency,
 * preserving spoiler-shielded placeholders so BookDetailView can show position chips safely.
 */
export function getWordEncountersForBook(
  book: Book,
  notes: readonly Note[]
): WordEncounter[] {
  const out: WordEncounter[] = [];
  for (const note of notes) {
    if (note.bookId !== book.id) continue;
    if (isArchived(note)) continue;
    const lex = getWordLexicon(note);
    if (!lex) continue;
    const shielded = isNoteSpoiler(note, book) || isSealedPrediction(note, book);
    out.push({
      note,
      book,
      lexicon: lex,
      shielded,
      sealedPrediction: isSealedPrediction(note, book),
      word: shielded ? '' : lex.word,
      quote: shielded ? '' : note.quote ?? '',
      definition: shielded ? '' : lex.definition ?? '',
      etymology: shielded ? '' : lex.etymology ?? '',
      transferExample: shielded ? '' : lex.transferExample ?? '',
      pronunciation: shielded ? '' : lex.pronunciation ?? '',
      partOfSpeech: shielded ? '' : lex.partOfSpeech ?? '',
      posLabel: formatPosDisplay(note.pos, book.posUnit),
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    });
  }
  out.sort((a, b) => {
    if (a.note.pos !== b.note.pos) return a.note.pos - b.note.pos;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return out;
}

/**
 * Deterministic daily Lexicon Stroll pick (PRD D9):
 * - 1-2 tap-to-reveal word cards per day from unshielded, non-archived word notes
 * - Eligible once at least 1 calendar day old (`getCalendarDaysBetween >= 1`)
 * - Skips notes already marked revisited today (`meta.lastReviewedAt === todayDate`)
 * - Deduplicates by lemma so the same word doesn't appear twice in one day
 * - Deterministic per calendar day via FNV-1a hashing
 */
export function selectLexiconStroll(
  notes: readonly Note[],
  books: readonly Book[],
  todayDate: string,
  limit = 2
): LexiconStrollPick[] {
  if (limit <= 0) return [];
  const bookMap = new Map(books.map(b => [b.id, b]));
  const unshieldedGroups = groupWordsByLemma(notes, books, {
    includeSpoilers: false,
  });
  const groupByLemma = new Map(
    unshieldedGroups.filter(g => !g.allShielded && g.lemma).map(g => [g.lemma, g])
  );

  const eligible: Array<{
    note: Note;
    book: Book;
    lexicon: WordLexicon;
    displayLexicon: WordLexicon;
    posLabel: string;
    hash: number;
  }> = [];

  for (const note of notes) {
    if (isArchived(note)) continue;
    if (!isWordNote(note)) continue;
    const lexicon = getWordLexicon(note);
    if (!lexicon) continue;
    const book = bookMap.get(note.bookId);
    if (!book || isArchived(book)) continue;
    if (isNoteSpoiler(note, book) || isSealedPrediction(note, book)) continue;
    if (getCalendarDaysBetween(note.createdAt, todayDate) < 1) continue;
    if (toLocalDateKey(note.meta?.lastReviewedAt) === todayDate) continue;

    const group = groupByLemma.get(lexicon.lemma);
    const displayLexicon: WordLexicon = {
      word: lexicon.word,
      lemma: lexicon.lemma,
      pronunciation: lexicon.pronunciation ?? group?.pronunciation,
      partOfSpeech: lexicon.partOfSpeech ?? group?.partOfSpeech,
      definition: lexicon.definition ?? group?.definition,
      etymology: lexicon.etymology ?? group?.etymology,
      transferExample: lexicon.transferExample ?? group?.transferExample,
    };

    eligible.push({
      note,
      book,
      lexicon,
      displayLexicon,
      posLabel: formatPosDisplay(note.pos, book.posUnit),
      hash: fnv1aHash(`${todayDate}:${note.id}`),
    });
  }

  eligible.sort((a, b) => {
    if (a.hash !== b.hash) return a.hash - b.hash;
    return a.note.id.localeCompare(b.note.id);
  });

  const picked: LexiconStrollPick[] = [];
  const seenLemmas = new Set<string>();
  for (const item of eligible) {
    if (seenLemmas.has(item.lexicon.lemma)) continue;
    seenLemmas.add(item.lexicon.lemma);
    picked.push({
      note: item.note,
      book: item.book,
      lexicon: item.lexicon,
      displayLexicon: item.displayLexicon,
      posLabel: item.posLabel,
    });
    if (picked.length >= limit) break;
  }
  return picked;
}

export interface LexiconStrollStatus {
  items: LexiconStrollPick[];
  /** Unshielded word notes >= 1 day old overall (ignoring whether revisited today). */
  totalPoolCount: number;
  /** Word notes captured today (< 1 day old). */
  freshTodayCount: number;
  /** Eligible word notes marked revisited today. */
  reviewedTodayCount: number;
}

export function getLexiconStrollStatus(
  notes: readonly Note[],
  books: readonly Book[],
  todayDate: string,
  limit = 2
): LexiconStrollStatus {
  const bookMap = new Map(books.map(b => [b.id, b]));
  let totalPoolCount = 0;
  let freshTodayCount = 0;
  let reviewedTodayCount = 0;

  for (const note of notes) {
    if (isArchived(note)) continue;
    const lex = getWordLexicon(note);
    if (!lex) continue;
    const book = bookMap.get(note.bookId);
    if (!book || isArchived(book)) continue;
    if (isNoteSpoiler(note, book) || isSealedPrediction(note, book)) continue;

    if (getCalendarDaysBetween(note.createdAt, todayDate) < 1) {
      freshTodayCount += 1;
      continue;
    }
    totalPoolCount += 1;
    if (toLocalDateKey(note.meta?.lastReviewedAt) === todayDate) {
      reviewedTodayCount += 1;
    }
  }

  return {
    items: selectLexiconStroll(notes, books, todayDate, limit),
    totalPoolCount,
    freshTodayCount,
    reviewedTodayCount,
  };
}

export interface WordLookupPromptInput {
  word: string;
  bookTitle?: string;
  author?: string;
  chapter?: string;
  posLabel?: string;
  quote?: string;
}

/**
 * Zero-AI contextual lookup prompt helper (PRD §4.1 / D5) for copying into an external LLM.
 */
export function buildWordLookupPrompt(input: WordLookupPromptInput): string {
  const word = input.word.trim();
  const lines: string[] = [];
  lines.push(`Look up the word "${word}" in context and return crisp companion-style Lexicon notes:`);
  if (input.bookTitle) {
    const locParts = [input.bookTitle];
    if (input.author) locParts.push(`by ${input.author}`);
    if (input.chapter) locParts.push(input.chapter);
    if (input.posLabel) locParts.push(input.posLabel);
    lines.push(`Book context: ${locParts.join(' · ')}`);
  }
  if (input.quote?.trim()) {
    lines.push(`Passage: "${input.quote.trim()}"`);
  }
  lines.push('');
  lines.push('Please give me:');
  lines.push('1. Pronunciation & part of speech');
  lines.push('2. Plain-English definition (especially the sense used in this passage)');
  lines.push('3. Brief etymology / root history (1-2 sentences)');
  lines.push('4. One fresh transfer example sentence in my own voice');
  return lines.join('\n');
}
