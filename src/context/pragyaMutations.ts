import type {
  Attachment,
  Book,
  BookFormat,
  BookKind,
  BookStatus,
  Note,
  PosUnit,
  ReadingSession,
} from '../types/pragya';
import type { BatchMutationOp } from '../utils/batchPlan';
import { countOtherActiveDeltas } from '../utils/archive';
import { normalizeChapterInput } from '../utils/chapterFormat';
import { resolveExpectedBase } from '../utils/conflictGuard';
import { normalizeDeltaAction, normalizeDeltaTrigger } from '../utils/deltaFormat';
import {
  BOOK_EDITOR_OWNED_META_KEYS,
  NOTE_EDITOR_OWNED_META_KEYS,
  findOverriddenMetaKeys,
  getRenderableAttachments,
  mergeUnknownMetaKeys,
} from '../utils/metaCodecs';
import { clampNotePos } from '../utils/positionClamp';
import {
  applyBookmarkAdvance,
  createUuid,
  upsertCoalescedSession,
} from '../utils/sessionCoalesce';
import { normalizeTagList } from '../utils/sheetCodecs';
import { computeNormalizedPos } from '../utils/spoilerMath';
import { addSlugAlias, generateUniqueSlug, takenSlugs } from '../utils/wikilinks';
import { normalizeBookContextValue } from '../utils/readingMomentum';
import {
  ensureVocabularyTag,
  normalizeWordLexicon,
  type WordLexiconInput,
} from '../utils/lexicon';

/**
 * Pure, Node-testable mutation planners extracted from PragyaContext (CD Batch 7 D3.2).
 * Every planner computes the exact row payloads, conflict-guard bases, unknown-key merges,
 * and N1 dev-warning metadata without performing I/O or touching React state.
 */

export interface AddBookInput {
  title: string;
  author: string;
  format: BookFormat;
  kind: BookKind;
  status: BookStatus;
  currentPos: number;
  totalPos: number;
  posUnit: PosUnit;
  docUrl?: string;
  /** CD C2.6: optional https cover (validated by the form). */
  coverUrl?: string;
  /** v2: optional curiosity spark when queued. */
  whyQueued?: string;
  /** v2: optional guilt-free context when paused. */
  pauseNote?: string;
  /** v2: optional gentle landmark while reading. */
  nextStop?: string;
}

export interface QuickCaptureInput {
  bookId: string;
  pos: number;
  title?: string;
  quote?: string;
  takeaway: string;
  tags: string[];
  sparLater?: boolean;
  isPrediction?: boolean;
  attachments?: Attachment[];
  /** A3.3: note chapter / story (trimmed, ≤ 80 chars; empty → key omitted). */
  chapter?: string;
  /** CD C3.3: capture for a missing `[[slug]]` — the note takes this slug when it's free. */
  slug?: string;
  /** v2 Lexicon: when `'word'`, creates a contextual vocabulary note row. */
  entryKind?: 'word';
  /** v2 Lexicon: structured lexicon fields when `entryKind === 'word'`. */
  lexicon?: WordLexiconInput;
}

export interface UpdateNoteOptions {
  /** Keep `note.updatedAt` as-is (e.g. Mark Reviewed only touches meta.lastReviewedAt). */
  preserveUpdatedAt?: boolean;
  /** Override the conflict-guard base; defaults to the loaded note's updatedAt. */
  expectedBaseUpdatedAt?: string;
  /** Meta keys this call site may set/delete (default NOTE_EDITOR_OWNED_META_KEYS). */
  ownedMetaKeys?: readonly string[];
  /**
   * R2 N1 (dev warning only): the meta snapshot this edit started from. A non-owned key
   * is reported only when the editor changed it relative to this base; no base → no
   * warning (a key another device changed is never reported).
   */
  baseMeta?: object;
}

export interface ReplaceWorkspaceOptions {
  /** Save current workspace to pragya_pre_import_backup_v1 first (default true). */
  backup?: boolean;
}

export type BookmarkSessionUndoAction =
  | { mode: 'created'; sessionId: string }
  | { mode: 'updated'; prevSession: ReadingSession };

export interface BookmarkAdvanceUndo {
  prevBook: Book;
  sessionAction: BookmarkSessionUndoAction;
  /** B4.1: `meta.updatedAt` of the book this advance saved — the undo's conflict base. */
  appliedUpdatedAt?: string;
}

export interface BookWriteOptions {
  /**
   * B4.1: conflict-guard base captured when the edit started (modal open / undo
   * payload). Wins over the currently loaded book — even `""` — so a background sync
   * can't silently advance the base and let a stale edit overwrite a newer row.
   */
  expectedBaseUpdatedAt?: string;
  /** Meta keys this call site may set/delete (default BOOK_EDITOR_OWNED_META_KEYS). */
  ownedMetaKeys?: readonly string[];
  /**
   * R2 N1 (dev warning only): the meta snapshot this edit started from. A non-owned key
   * is reported only when the editor changed it relative to this base; no base → no
   * warning (a key another device changed is never reported).
   */
  baseMeta?: object;
}

export interface BookmarkAdvanceResult {
  book: Book;
  changed: boolean;
  rejectedBackward: boolean;
  undo?: BookmarkAdvanceUndo;
  /** CD C2.3: the (coalesced) session this advance wrote — for "+ Add a note to this session". */
  sessionId?: string;
}

export function upsertList<T extends { id: string }>(items: readonly T[], item: T): T[] {
  const idx = items.findIndex(x => x.id === item.id);
  if (idx >= 0) {
    const next = [...items];
    next[idx] = item;
    return next;
  }
  return [...items, item];
}

export function planNewBook(
  input: AddBookInput,
  nowIso: string = new Date().toISOString(),
  id: string = createUuid()
): Book {
  const totalPos = Math.max(0, Number(input.totalPos) || 0);
  const currentPos = Math.max(0, Number(input.currentPos) || 0);
  const normalizedPos =
    input.status === 'finished'
      ? 1
      : computeNormalizedPos(currentPos, totalPos, input.posUnit);

  const whyQueued = input.whyQueued ? normalizeBookContextValue('whyQueued', input.whyQueued) : '';
  const pauseNote = input.pauseNote ? normalizeBookContextValue('pauseNote', input.pauseNote) : '';
  const nextStop = input.nextStop ? normalizeBookContextValue('nextStop', input.nextStop) : '';

  return {
    id,
    title: input.title.trim(),
    author: input.author.trim(),
    format: input.format,
    kind: input.kind,
    status: input.status,
    currentPos,
    totalPos,
    posUnit: input.posUnit,
    normalizedPos,
    docUrl: (input.docUrl || '').trim(),
    meta: {
      ...(input.status === 'reading' || input.status === 'finished'
        ? { startedAt: nowIso }
        : {}),
      ...(input.status === 'finished' ? { finishedAt: nowIso } : {}),
      ...(input.coverUrl?.trim() ? { coverUrl: input.coverUrl.trim() } : {}),
      ...(whyQueued ? { whyQueued } : {}),
      ...(pauseNote ? { pauseNote } : {}),
      ...(nextStop ? { nextStop } : {}),
      updatedAt: nowIso,
    },
  };
}

export interface PlannedBookWrite {
  nextBook: Book;
  expectedBaseUpdatedAt: string | undefined;
  overriddenMetaKeys: string[];
}

export function planUpdatedBook(
  book: Book,
  loaded: Book | undefined,
  options: BookWriteOptions = {},
  nowIso: string = new Date().toISOString()
): PlannedBookWrite {
  const owned = options.ownedMetaKeys ?? BOOK_EDITOR_OWNED_META_KEYS;
  const overriddenMetaKeys = options.baseMeta
    ? findOverriddenMetaKeys(book.meta, options.baseMeta, loaded?.meta, owned)
    : [];

  const nextBook: Book = {
    ...book,
    normalizedPos:
      book.status === 'finished'
        ? 1
        : computeNormalizedPos(book.currentPos, book.totalPos, book.posUnit),
    meta: {
      // R2#1: re-merge non-editor keys a stale modal snapshot may lack.
      ...mergeUnknownMetaKeys(book.meta, loaded?.meta, owned),
      // CD 3 fix-up R1#2: leaving "finished" by any edit marks a re-read (OQ-7). Undo
      // of Mark Finished goes through restoreBook and is NOT a re-read.
      ...(loaded?.status === 'finished' && book.status !== 'finished'
        ? { everFinished: true }
        : {}),
      updatedAt: nowIso,
    },
  };

  return {
    nextBook,
    expectedBaseUpdatedAt: resolveExpectedBase(
      options.expectedBaseUpdatedAt,
      loaded?.meta?.updatedAt
    ),
    overriddenMetaKeys,
  };
}

export function planRestoredBook(
  prevBook: Book,
  loaded: Book | undefined,
  options: BookWriteOptions = {},
  nowIso: string = new Date().toISOString()
): { nextBook: Book; expectedBaseUpdatedAt: string | undefined } {
  const owned = options.ownedMetaKeys ?? BOOK_EDITOR_OWNED_META_KEYS;
  const nextBook: Book = {
    ...prevBook,
    meta: {
      ...mergeUnknownMetaKeys(prevBook.meta, loaded?.meta, owned),
      updatedAt: nowIso,
    },
  };
  return {
    nextBook,
    expectedBaseUpdatedAt: resolveExpectedBase(
      options.expectedBaseUpdatedAt,
      loaded?.meta?.updatedAt
    ),
  };
}

export function planStartReadingBook(
  existing: Book,
  nowIso: string = new Date().toISOString()
): { nextBook: Book; expectedBaseUpdatedAt: string | undefined } {
  return {
    nextBook: {
      ...existing,
      status: 'reading',
      meta: {
        ...existing.meta,
        startedAt: existing.meta.startedAt || nowIso,
        updatedAt: nowIso,
      },
    },
    expectedBaseUpdatedAt: existing.meta?.updatedAt,
  };
}

export function planMarkBookFinished(
  existing: Book,
  nowIso: string = new Date().toISOString()
): { nextBook: Book; expectedBaseUpdatedAt: string | undefined } {
  const finalPos = existing.totalPos > 0 ? existing.totalPos : existing.currentPos;
  return {
    nextBook: {
      ...existing,
      status: 'finished',
      currentPos: finalPos,
      normalizedPos: 1,
      meta: {
        ...existing.meta,
        startedAt: existing.meta.startedAt || nowIso,
        finishedAt: nowIso,
        updatedAt: nowIso,
      },
    },
    expectedBaseUpdatedAt: existing.meta?.updatedAt,
  };
}

export function planStartReread(
  loaded: Book,
  nowIso: string = new Date().toISOString()
): { nextBook: Book; expectedBaseUpdatedAt: string | undefined } {
  const owned = ['everFinished', 'startedAt', 'updatedAt'];
  return {
    nextBook: {
      ...loaded,
      status: 'reading',
      currentPos: 0,
      normalizedPos: 0,
      meta: {
        ...mergeUnknownMetaKeys(
          { ...loaded.meta, everFinished: true, startedAt: nowIso },
          loaded.meta,
          owned
        ),
        updatedAt: nowIso,
      },
    },
    expectedBaseUpdatedAt: loaded.meta?.updatedAt,
  };
}

export type PlannedBookmarkAdvance =
  | { changed: false; rejectedBackward: boolean; book: Book }
  | {
      changed: true;
      rejectedBackward: false;
      updatedBook: Book;
      expectedBaseUpdatedAt: string | undefined;
      sessionToSave: ReadingSession;
      sessionAction: BookmarkSessionUndoAction;
      ops: BatchMutationOp[];
    };

export function planBookmarkAdvance(
  existing: Book,
  sessions: readonly ReadingSession[],
  incomingPos: number,
  options: { manualOverride?: boolean; sessionNote?: string; nowIso?: string } = {}
): PlannedBookmarkAdvance {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const res = applyBookmarkAdvance(existing, incomingPos, {
    manualOverride: options.manualOverride,
    nowIso,
  });

  if (res.rejectedBackward) {
    return { changed: false, rejectedBackward: true, book: existing };
  }
  if (!res.changed) {
    return { changed: false, rejectedBackward: false, book: existing };
  }

  const sessionRes = upsertCoalescedSession([...sessions], {
    bookId: existing.id,
    prevPos: res.prevPos,
    nextPos: res.nextPos,
    nowIso,
    note: options.sessionNote,
    manualOverride: options.manualOverride,
  });

  const prevSession = sessionRes.isNew
    ? undefined
    : sessions.find(s => s.id === sessionRes.upserted.id);
  const sessionAction: BookmarkSessionUndoAction =
    !sessionRes.isNew && prevSession
      ? { mode: 'updated', prevSession }
      : { mode: 'created', sessionId: sessionRes.upserted.id };

  const expectedBaseUpdatedAt = existing.meta?.updatedAt;
  return {
    changed: true,
    rejectedBackward: false,
    updatedBook: res.updatedBook,
    expectedBaseUpdatedAt,
    sessionToSave: sessionRes.upserted,
    sessionAction,
    ops: [
      { kind: 'book', book: res.updatedBook, expectedBaseUpdatedAt, mode: 'update' },
      {
        kind: 'session',
        session: sessionRes.upserted,
        mode: sessionRes.isNew ? 'insert' : 'update',
      },
    ],
  };
}

export function planQuickCaptureNote(
  input: QuickCaptureInput,
  book: Book,
  existingNotes: readonly Note[],
  nowIso: string = new Date().toISOString(),
  id: string = createUuid()
): Note {
  // M4.9: clamp into [0, totalPos] / [0, 100] for parity with pragya_cli.py
  const pos = clampNotePos(input.pos, book);
  const normalizedPos = computeNormalizedPos(pos, book.totalPos, book.posUnit);
  const attachments = (input.attachments || []).slice(0, 3);
  const links = attachments
    .filter((a): a is Extract<Attachment, { type: 'link' | 'doc' }> => a.type !== 'image')
    .map(a => a.url);

  const isWord = input.entryKind === 'word';
  const normalizedLexicon = isWord && input.lexicon
    ? normalizeWordLexicon(input.lexicon)
    : undefined;

  const effectiveTitle = isWord
    ? normalizedLexicon?.word || (input.title || '').trim()
    : (input.title || '').trim();
  const effectiveTakeaway = isWord
    ? input.takeaway.trim() ||
      normalizedLexicon?.transferExample ||
      normalizedLexicon?.definition ||
      ''
    : input.takeaway.trim();

  const slugSource =
    effectiveTitle ||
    effectiveTakeaway.split(/\s+/).slice(0, 6).join(' ') ||
    (input.quote || '').trim().split(/\s+/).slice(0, 6).join(' ') ||
    `${book.title} p${pos}`;

  // CD C3.2: other notes' aliases count as taken, so an old [[link]] never retargets.
  const slug = generateUniqueSlug(
    (input.slug || '').trim() || slugSource,
    takenSlugs([...existingNotes])
  );
  const chapter = normalizeChapterInput(input.chapter);
  const baseTags = normalizeTagList(input.tags || []);
  const tags = isWord ? ensureVocabularyTag(baseTags) : baseTags;

  return {
    id,
    slug,
    bookId: book.id,
    createdAt: nowIso,
    updatedAt: nowIso,
    pos,
    normalizedPos,
    status: isWord ? 'saved' : input.sparLater ? 'inbox' : 'saved',
    source: 'app',
    tags,
    quote: (input.quote || '').trim(),
    takeaway: effectiveTakeaway,
    contextMechanism: '',
    critique: '',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none',
    meta: {
      ...(effectiveTitle ? { title: effectiveTitle } : {}),
      attachments,
      links,
      ...(!isWord && book.kind === 'fiction' && input.isPrediction
        ? { isPrediction: true }
        : {}),
      ...(chapter ? { chapter } : {}),
      ...(isWord && normalizedLexicon
        ? { entryKind: 'word' as const, lexicon: normalizedLexicon }
        : {}),
    },
  };
}

export interface PlannedCaptureBatch {
  newNote: Note;
  advance: Extract<PlannedBookmarkAdvance, { changed: true }> | null;
  ops: BatchMutationOp[];
}

/**
 * Plan a QuickCapture write — coalescing Note + Book + Session into a single
 * `BatchMutationOp[]` when the note's clamped position advances the book bookmark.
 * Placing the guarded Book op in the same batch guarantees a Book conflict aborts
 * BEFORE any Note or Session row is written.
 */
export function planCaptureWithAdvance(
  input: QuickCaptureInput,
  book: Book,
  existingNotes: readonly Note[],
  existingSessions: readonly ReadingSession[],
  nowIso: string = new Date().toISOString(),
  noteId: string = createUuid()
): PlannedCaptureBatch {
  const newNote = planQuickCaptureNote(input, book, existingNotes, nowIso, noteId);
  if (newNote.pos > book.currentPos) {
    const adv = planBookmarkAdvance(book, existingSessions, newNote.pos, { nowIso });
    if (adv.changed) {
      return {
        newNote,
        advance: adv,
        ops: [
          {
            kind: 'book',
            book: adv.updatedBook,
            expectedBaseUpdatedAt: adv.expectedBaseUpdatedAt,
            mode: 'update',
          },
          { kind: 'note', note: newNote, mode: 'insert' },
          {
            kind: 'session',
            session: adv.sessionToSave,
            mode: adv.sessionAction.mode === 'updated' ? 'update' : 'insert',
          },
        ],
      };
    }
  }
  return {
    newNote,
    advance: null,
    ops: [{ kind: 'note', note: newNote, mode: 'insert' }],
  };
}

export interface PlannedNoteWrite {
  nextNote: Note;
  expectedBaseUpdatedAt: string | undefined;
  overriddenMetaKeys: string[];
}

export function planUpdatedNote(
  note: Note,
  existingNote: Note | undefined,
  book: Book | undefined,
  allNotes: readonly Note[],
  options: UpdateNoteOptions = {},
  nowIso: string = new Date().toISOString()
): PlannedNoteWrite {
  if (note.deltaStatus === 'active') {
    const otherActiveCount = countOtherActiveDeltas([...allNotes], note.id);
    if (otherActiveCount >= 5) {
      throw new Error(
        'Active Behavioral Delta cap (5/5) reached. Graduate or pause an active delta first.'
      );
    }
  }

  // Stored attachments round-trip verbatim (unknown entries / beyond 3 included);
  // the 3-cap is enforced at creation time in the capture/edit UIs.
  const attachments = Array.isArray(note.meta?.attachments) ? note.meta.attachments : [];
  const newAttachmentUrls = getRenderableAttachments(note.meta)
    .filter((a): a is Extract<Attachment, { type: 'link' | 'doc' }> => a.type !== 'image')
    .map(a => a.url);
  const oldAttachmentUrls = new Set(
    getRenderableAttachments(existingNote?.meta)
      .filter((a): a is Extract<Attachment, { type: 'link' | 'doc' }> => a.type !== 'image')
      .map(a => a.url)
  );
  const newAttachmentUrlSet = new Set(newAttachmentUrls);
  const preservedStandaloneLinks = (note.meta?.links || []).filter(
    url => !oldAttachmentUrls.has(url) || newAttachmentUrlSet.has(url)
  );
  const mergedLinks = Array.from(new Set([...preservedStandaloneLinks, ...newAttachmentUrls]));

  // M4.9: clamp pos only when it actually changed (never rewrite legacy values silently).
  const posChanged = !existingNote || Number(existingNote.pos) !== Number(note.pos);
  const nextPos = posChanged && book ? clampNotePos(note.pos, book) : note.pos;
  const nextNormalizedPos =
    posChanged && book
      ? computeNormalizedPos(nextPos, book.totalPos, book.posUnit)
      : note.normalizedPos;

  const owned = options.ownedMetaKeys ?? NOTE_EDITOR_OWNED_META_KEYS;
  const overriddenMetaKeys = options.baseMeta
    ? findOverriddenMetaKeys(note.meta, options.baseMeta, existingNote?.meta, owned)
    : [];

  const mergedMeta = mergeUnknownMetaKeys(note.meta, existingNote?.meta, owned);
  const nextAttachments = owned.includes('attachments')
    ? attachments
    : Array.isArray(mergedMeta.attachments)
      ? mergedMeta.attachments
      : [];
  const nextLinks = owned.includes('links')
    ? mergedLinks
    : Array.isArray(mergedMeta.links)
      ? mergedMeta.links
      : [];

  const updated: Note = {
    ...note,
    pos: nextPos,
    normalizedPos: nextNormalizedPos,
    tags: normalizeTagList(note.tags || []),
    deltaTrigger: normalizeDeltaTrigger(note.deltaTrigger),
    deltaAction: normalizeDeltaAction(note.deltaAction),
    meta: {
      ...mergedMeta,
      attachments: nextAttachments,
      links: nextLinks,
    },
    updatedAt: options.preserveUpdatedAt ? note.updatedAt : nowIso,
  };

  // CD C3.2 (decisions OQ-6, alias-only): a slug change keeps the old slug resolving
  // via meta.aliases (no rewrite of other rows' [[links]]).
  if (existingNote && existingNote.slug !== updated.slug) {
    updated.meta = {
      ...updated.meta,
      aliases: addSlugAlias(existingNote.meta?.aliases, existingNote.slug, updated.slug),
    };
  }

  return {
    nextNote: updated,
    expectedBaseUpdatedAt: resolveExpectedBase(
      options.expectedBaseUpdatedAt,
      existingNote?.updatedAt
    ),
    overriddenMetaKeys,
  };
}
