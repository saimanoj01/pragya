import type { Book, Note } from '../types/pragya';
import { isArchived } from './archive';
import {
  BRIDGE_NOTE_MAX,
  getNoteBridgeNotes,
  getNoteRelatedSlugs,
} from './metaCodecs';
import { isNoteSpoiler, isSealedPrediction } from './spoilerMath';
import {
  NOTE_RELATED_SLUGS_CAP,
  extractNoteWikilinkKeys,
  noteAliases,
  resolveWikilinkTarget,
  slugify,
  slugifyOrNull,
} from './wikilinks';

export const COLLISION_SKIP_KEY = 'pragya_collision_skip_v1';

/** Non-thematic meta tags excluded from Cross-Book Echo tag matching. */
export const GENERIC_SYNTHESIS_TAGS: ReadonlySet<string> = new Set([
  '#favorite',
  '#favorites',
  '#fiction',
  '#nonfiction',
  '#prediction',
  '#quote',
  '#book',
  '#reading',
]);

function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function specificNoteTags(note: Pick<Note, 'tags'>): string[] {
  const out: string[] = [];
  for (const raw of note.tags || []) {
    const lower = String(raw || '').trim().toLowerCase();
    if (!lower || GENERIC_SYNTHESIS_TAGS.has(lower)) continue;
    const normalized = lower.startsWith('#') ? lower : `#${lower}`;
    if (!GENERIC_SYNTHESIS_TAGS.has(normalized) && !out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
}

function noteIdentityKeys(note: Note): Set<string> {
  const keys = new Set<string>([note.slug]);
  const canon = slugifyOrNull(note.slug);
  if (canon) keys.add(canon);
  for (const alias of noteAliases(note)) keys.add(alias);
  return keys;
}

/** True when `noteA` links to `noteB` (inline or `meta.relatedSlugs`, alias-aware) in either direction. */
export function areNotesLinked(noteA: Note, noteB: Note): boolean {
  if (noteA.id === noteB.id) return true;
  const aKeys = extractNoteWikilinkKeys(noteA);
  for (const k of noteIdentityKeys(noteB)) {
    if (aKeys.has(k)) return true;
  }
  const bKeys = extractNoteWikilinkKeys(noteB);
  for (const k of noteIdentityKeys(noteA)) {
    if (bKeys.has(k)) return true;
  }
  return false;
}

export interface CrossBookEcho {
  note: Note;
  book?: Book;
  score: number;
  linked: boolean;
  sharedTags: string[];
  reason: string;
}

/**
 * Surfaces up to `limit` (default 3) spoiler-safe, non-archived notes from OTHER books
 * that connect to `book`'s unshielded notes via direct links/aliases (weight 5) or
 * shared specific `#tags` (weight 2 each). Deterministic tie-breaker: updatedAt desc, id asc.
 */
export function findCrossBookEchoes(
  book: Book,
  allNotes: readonly Note[],
  allBooks: readonly Book[],
  limit = 3
): CrossBookEcho[] {
  const bookMap = new Map(allBooks.map(b => [b.id, b] as const));
  const bookNotes = allNotes.filter(
    n =>
      n.bookId === book.id &&
      !isArchived(n) &&
      !isNoteSpoiler(n, book) &&
      !isSealedPrediction(n, book)
  );
  if (bookNotes.length === 0) return [];

  const bookLinkKeys = new Set<string>();
  const bookSelfKeys = new Set<string>();
  const bookTags = new Set<string>();

  for (const n of bookNotes) {
    for (const k of extractNoteWikilinkKeys(n)) bookLinkKeys.add(k);
    for (const k of noteIdentityKeys(n)) bookSelfKeys.add(k);
    for (const t of specificNoteTags(n)) bookTags.add(t);
  }

  const echoes: CrossBookEcho[] = [];
  for (const cand of allNotes) {
    if (cand.bookId === book.id) continue;
    if (isArchived(cand)) continue;
    const candBook = bookMap.get(cand.bookId);
    if (!candBook || isArchived(candBook)) continue;
    if (isNoteSpoiler(cand, candBook) || isSealedPrediction(cand, candBook)) continue;
    if (!cand.takeaway?.trim() && !cand.quote?.trim()) continue;

    let linked = false;
    for (const k of noteIdentityKeys(cand)) {
      if (bookLinkKeys.has(k)) {
        linked = true;
        break;
      }
    }
    if (!linked) {
      const candLinks = extractNoteWikilinkKeys(cand);
      for (const k of bookSelfKeys) {
        if (candLinks.has(k)) {
          linked = true;
          break;
        }
      }
    }

    const sharedTags = specificNoteTags(cand).filter(t => bookTags.has(t));
    const score = (linked ? 5 : 0) + sharedTags.length * 2;
    if (score <= 0) continue;

    const reason = linked
      ? sharedTags.length > 0
        ? `Linked · shares ${sharedTags.slice(0, 2).join(', ')}`
        : 'Linked note'
      : `Shares ${sharedTags.slice(0, 2).join(', ')}`;

    echoes.push({
      note: cand,
      book: candBook,
      score,
      linked,
      sharedTags,
      reason,
    });
  }

  echoes.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ua = String(a.note.updatedAt || '');
    const ub = String(b.note.updatedAt || '');
    if (ua !== ub) return ub.localeCompare(ua);
    return a.note.id < b.note.id ? -1 : a.note.id > b.note.id ? 1 : 0;
  });

  return echoes.slice(0, Math.max(0, limit));
}

export function collisionPairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}::${idB}` : `${idB}::${idA}`;
}

export interface CollisionPair {
  noteA: Note;
  bookA: Book;
  noteB: Note;
  bookB: Book;
  pairKey: string;
  totalCandidates: number;
}

export interface SelectCollisionOptions {
  seedOffset?: number;
  skippedKeys?: ReadonlySet<string>;
}

/**
 * Deterministic daily pair of 2 non-archived, unshielded, non-sealed-prediction notes from
 * 2 DIFFERENT books that are not already linked (inline or `meta.relatedSlugs`).
 * Parity: `select_daily_collision_pair` in scripts/pragya_cli.py.
 */
export function selectDailyCollisionPair(
  notes: readonly Note[],
  books: readonly Book[],
  todayDate: string,
  options: SelectCollisionOptions = {}
): CollisionPair | null {
  const bookMap = new Map(books.map(b => [b.id, b] as const));
  const eligible = notes
    .filter(n => {
      if (isArchived(n)) return false;
      const b = bookMap.get(n.bookId);
      if (!b || isArchived(b)) return false;
      if (isNoteSpoiler(n, b) || isSealedPrediction(n, b)) return false;
      return Boolean(n.takeaway?.trim() || n.quote?.trim());
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (eligible.length < 2) return null;

  const skipped = options.skippedKeys ?? new Set<string>();
  const seedOffset = Math.max(0, Math.floor(options.seedOffset || 0));

  const pairs: Array<{ a: Note; b: Note; pairKey: string }> = [];
  for (let i = 0; i < eligible.length; i += 1) {
    for (let j = i + 1; j < eligible.length; j += 1) {
      const a = eligible[i];
      const b = eligible[j];
      if (a.bookId === b.bookId) continue;
      const key = collisionPairKey(a.id, b.id);
      if (skipped.has(key)) continue;
      if (areNotesLinked(a, b)) continue;
      pairs.push({ a, b, pairKey: key });
    }
  }

  if (pairs.length === 0) return null;

  pairs.sort((p1, p2) => {
    const h1 = fnv1aHash(`${todayDate}:${p1.pairKey}`);
    const h2 = fnv1aHash(`${todayDate}:${p2.pairKey}`);
    if (h1 !== h2) return h1 - h2;
    return p1.pairKey < p2.pairKey ? -1 : p1.pairKey > p2.pairKey ? 1 : 0;
  });

  const chosen = pairs[seedOffset % pairs.length];
  const bookA = bookMap.get(chosen.a.bookId)!;
  const bookB = bookMap.get(chosen.b.bookId)!;
  return {
    noteA: chosen.a,
    bookA,
    noteB: chosen.b,
    bookB,
    pairKey: chosen.pairKey,
    totalCandidates: pairs.length,
  };
}

interface CollisionSkipStorage {
  date: string;
  skipped: string[];
}

function defaultStorage(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

export function readSkippedCollisionKeys(
  todayDate: string,
  storage?: Pick<Storage, 'getItem' | 'removeItem'>
): Set<string> {
  try {
    const store = storage ?? defaultStorage();
    if (!store) return new Set();
    const raw = store.getItem(COLLISION_SKIP_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as Partial<CollisionSkipStorage>;
    if (!parsed || parsed.date !== todayDate || !Array.isArray(parsed.skipped)) {
      store.removeItem(COLLISION_SKIP_KEY);
      return new Set();
    }
    return new Set(parsed.skipped.filter((x): x is string => typeof x === 'string' && x.length > 0));
  } catch {
    return new Set();
  }
}

export function skipCollisionPairToday(
  pairKey: string,
  todayDate: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): Set<string> {
  const store = storage ?? defaultStorage();
  const next = readSkippedCollisionKeys(todayDate, store ?? undefined);
  if (pairKey) next.add(pairKey);
  try {
    store?.setItem(
      COLLISION_SKIP_KEY,
      JSON.stringify({ date: todayDate, skipped: Array.from(next) })
    );
  } catch {
    // Ignore storage quota errors
  }
  return next;
}

export function clearCollisionSkipState(
  storage?: Pick<Storage, 'removeItem'>
): void {
  try {
    const store = storage ?? defaultStorage();
    store?.removeItem(COLLISION_SKIP_KEY);
  } catch {
    // Ignore storage errors
  }
}

export interface NoteBridgeOptions {
  mode: 'link' | 'unlink';
  bidirectional?: boolean;
  why?: string;
  allowShielded?: boolean;
  nowIso?: string;
}

export interface PlannedNoteBridge {
  changed: boolean;
  prevNotes: Note[];
  nextNotes: Note[];
  expectedBaseById: Record<string, string>;
}

function trimBridgeWhy(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return '';
  const points = Array.from(trimmed);
  return points.length <= BRIDGE_NOTE_MAX ? trimmed : points.slice(0, BRIDGE_NOTE_MAX).join('').trim();
}

function applyDirectedBridge(
  source: Note,
  target: Note,
  allNotes: readonly Note[],
  mode: 'link' | 'unlink',
  why: string | undefined,
  nowIso: string
): { nextNote: Note; changed: boolean } {
  const targetSlug = (target.slug || '').trim() || slugify(target.slug);
  const existingSlugs = getNoteRelatedSlugs(source.meta);
  const existingBridgeNotes = getNoteBridgeNotes(source.meta);

  const pointsToTarget = (rawSlug: string): boolean => {
    const resolved = resolveWikilinkTarget([...allNotes], rawSlug);
    if (resolved) return resolved.id === target.id;
    return noteIdentityKeys(target).has(rawSlug);
  };

  let carriedWhy = '';
  const keptSlugs: string[] = [];
  let firstTargetIdx = -1;
  let hadTarget = false;
  for (const s of existingSlugs) {
    if (pointsToTarget(s)) {
      if (!hadTarget) firstTargetIdx = keptSlugs.length;
      hadTarget = true;
      if (!carriedWhy && existingBridgeNotes[s]) carriedWhy = existingBridgeNotes[s];
      continue;
    }
    if (!keptSlugs.includes(s)) keptSlugs.push(s);
  }

  const nextBridgeNotes: Record<string, string> = {};
  for (const [k, v] of Object.entries(existingBridgeNotes)) {
    if (pointsToTarget(k)) {
      if (!carriedWhy) carriedWhy = v;
      continue;
    }
    if (keptSlugs.includes(k)) {
      nextBridgeNotes[k] = v;
    }
  }

  let nextSlugs: string[];
  if (mode === 'link') {
    if (!hadTarget && keptSlugs.length >= NOTE_RELATED_SLUGS_CAP) {
      throw new Error(
        `A note can hold at most ${NOTE_RELATED_SLUGS_CAP} linked bridges. Unlink one first.`
      );
    }
    if (hadTarget && firstTargetIdx >= 0) {
      nextSlugs = [
        ...keptSlugs.slice(0, firstTargetIdx),
        targetSlug,
        ...keptSlugs.slice(firstTargetIdx),
      ];
    } else {
      nextSlugs = [...keptSlugs, targetSlug];
    }
    const resolvedWhy = why !== undefined ? why : carriedWhy;
    if (resolvedWhy) {
      nextBridgeNotes[targetSlug] = resolvedWhy;
    }
  } else {
    nextSlugs = keptSlugs;
  }

  const sameSlugs =
    nextSlugs.length === existingSlugs.length &&
    nextSlugs.every((s, idx) => s === existingSlugs[idx]);
  const prevKeys = Object.keys(existingBridgeNotes).sort();
  const nextKeys = Object.keys(nextBridgeNotes).sort();
  const sameNotes =
    prevKeys.length === nextKeys.length &&
    prevKeys.every((k, idx) => k === nextKeys[idx] && existingBridgeNotes[k] === nextBridgeNotes[k]);

  if (sameSlugs && sameNotes) {
    return { nextNote: source, changed: false };
  }

  const nextMeta: Note['meta'] = { ...source.meta };
  if (nextSlugs.length > 0) nextMeta.relatedSlugs = nextSlugs;
  else delete nextMeta.relatedSlugs;
  if (Object.keys(nextBridgeNotes).length > 0) nextMeta.bridgeNotes = nextBridgeNotes;
  else delete nextMeta.bridgeNotes;

  return {
    nextNote: {
      ...source,
      meta: nextMeta,
      updatedAt: nowIso,
    },
    changed: true,
  };
}

/**
 * Shared pure planner for linking or unlinking two notes via `meta.relatedSlugs` +
 * `meta.bridgeNotes` (preserving user takeaway prose verbatim). Resolves slug aliases,
 * rejects self/archived/shielded targets, and bumps `updatedAt` on modified rows.
 */
export function planNoteBridgeOps(
  noteA: Note,
  noteB: Note,
  allNotes: readonly Note[],
  books: readonly Book[],
  options: NoteBridgeOptions
): PlannedNoteBridge {
  if (noteA.id === noteB.id) {
    throw new Error('Cannot link a note to itself.');
  }
  if (isArchived(noteA) || isArchived(noteB)) {
    throw new Error('Cannot modify bridges on an archived note. Restore it first.');
  }
  const bookMap = new Map(books.map(b => [b.id, b] as const));
  const bookA = bookMap.get(noteA.bookId);
  const bookB = bookMap.get(noteB.bookId);
  if ((bookA && isArchived(bookA)) || (bookB && isArchived(bookB))) {
    throw new Error('Cannot modify bridges on a note belonging to an archived book. Restore the book first.');
  }
  if (!options.allowShielded) {
    if (
      isNoteSpoiler(noteA, bookA) ||
      isSealedPrediction(noteA, bookA) ||
      isNoteSpoiler(noteB, bookB) ||
      isSealedPrediction(noteB, bookB)
    ) {
      throw new Error('Cannot bridge a spoiler-shielded or sealed-prediction note.');
    }
  }

  const bidirectional = options.bidirectional !== false;
  const nowIso = options.nowIso ?? new Date().toISOString();
  const cleanedWhy = trimBridgeWhy(options.why);

  const prevNotes: Note[] = [];
  const nextNotes: Note[] = [];
  const expectedBaseById: Record<string, string> = {};

  const resA = applyDirectedBridge(noteA, noteB, allNotes, options.mode, cleanedWhy, nowIso);
  if (resA.changed) {
    prevNotes.push(noteA);
    nextNotes.push(resA.nextNote);
    expectedBaseById[noteA.id] = noteA.updatedAt;
  }

  if (bidirectional) {
    const resB = applyDirectedBridge(noteB, noteA, allNotes, options.mode, cleanedWhy, nowIso);
    if (resB.changed) {
      prevNotes.push(noteB);
      nextNotes.push(resB.nextNote);
      expectedBaseById[noteB.id] = noteB.updatedAt;
    }
  }

  return {
    changed: nextNotes.length > 0,
    prevNotes,
    nextNotes,
    expectedBaseById,
  };
}
