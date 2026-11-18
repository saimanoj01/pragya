import type { Book, Note } from '../types/pragya';
import { buildNoteSearchHaystack } from './noteVisibility';

/**
 * CD C3.4 (ux_spec_cd C.3.5): NotesView query state, URL sync and tokenized AND search.
 * Pure + erasable TS (Node-testable). Shield rules come from `buildNoteSearchHaystack`: an
 * unrevealed spoiler matches only on tags + book title/author.
 */

export const NOTES_FILTERS = ['all', 'to-spar', 'atomic', 'media', 'concepts', 'archived'] as const;
export type NotesFilter = (typeof NOTES_FILTERS)[number];
export const NOTES_SORTS = ['recent', 'newest', 'reading'] as const;
export type NotesSort = (typeof NOTES_SORTS)[number];

export interface NotesQueryState {
  q: string;
  /** Normalized `#tag` values (lower-case, with `#`). Multiple = AND. */
  tags: string[];
  /** Book id, or '' for all books. */
  book: string;
  filter: NotesFilter;
  sort: NotesSort;
}

export const DEFAULT_NOTES_QUERY: NotesQueryState = { q: '', tags: [], book: '', filter: 'all', sort: 'recent' };

export const NOTES_SORT_LABELS: Record<NotesSort, string> = {
  recent: 'Recently updated',
  newest: 'Newest first',
  reading: 'Reading order',
};

export function normalizeTagToken(raw: string): string {
  const t = (raw || '').trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-');
  return t ? `#${t}` : '';
}

/** `#/notes?q=…&tag=systems&tag=delays&book=…&filter=atomic&sort=reading` → state (unknown → defaults). */
export function parseNotesQuery(hash: string): NotesQueryState {
  const raw = hash || '';
  const qIndex = raw.indexOf('?');
  if (qIndex < 0) return { ...DEFAULT_NOTES_QUERY, tags: [] };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw.slice(qIndex + 1));
  } catch {
    return { ...DEFAULT_NOTES_QUERY, tags: [] };
  }
  const tags: string[] = [];
  for (const t of params.getAll('tag')) {
    const n = normalizeTagToken(t);
    if (n && !tags.includes(n)) tags.push(n);
  }
  const filter = params.get('filter') || '';
  const sort = params.get('sort') || '';
  return {
    q: params.get('q') || '',
    tags,
    book: params.get('book') || '',
    filter: (NOTES_FILTERS as readonly string[]).includes(filter) ? (filter as NotesFilter) : 'all',
    sort: (NOTES_SORTS as readonly string[]).includes(sort) ? (sort as NotesSort) : 'recent',
  };
}

/** State → `#/notes[?…]` with defaults omitted (round-trips with `parseNotesQuery`). */
export function buildNotesHash(state: NotesQueryState): string {
  const params = new URLSearchParams();
  if (state.q.trim()) params.set('q', state.q);
  for (const t of state.tags) {
    const n = normalizeTagToken(t);
    if (n) params.append('tag', n.slice(1));
  }
  if (state.book) params.set('book', state.book);
  if (state.filter !== 'all') params.set('filter', state.filter);
  if (state.sort !== 'recent') params.set('sort', state.sort);
  const qs = params.toString();
  return qs ? `#/notes?${qs}` : '#/notes';
}

/** Case- and diacritic-insensitive comparison form. */
export function foldForSearch(value: string): string {
  return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export type QueryToken = { kind: 'word' | 'phrase'; value: string } | { kind: 'tag'; value: string };

/** Whitespace tokens; `"quoted phrase"` stays one token; `#tag` matches tags exactly. */
export function tokenizeSearchQuery(q: string): QueryToken[] {
  const out: QueryToken[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q || '')) !== null) {
    if (m[1] !== undefined) {
      const phrase = foldForSearch(m[1]).trim();
      if (phrase) out.push({ kind: 'phrase', value: phrase });
    } else if (m[2].startsWith('#') && m[2].length > 1) {
      out.push({ kind: 'tag', value: normalizeTagToken(m[2]) });
    } else {
      out.push({ kind: 'word', value: foldForSearch(m[2]) });
    }
  }
  return out;
}

/** Every token must match (AND). Shielded notes only expose tags + book title/author. */
export function matchesNoteQuery(
  note: Note,
  book: Book | null | undefined,
  q: string,
  options: { revealed?: boolean } = {}
): boolean {
  const tokens = tokenizeSearchQuery(q);
  if (tokens.length === 0) return true;
  const haystack = foldForSearch(buildNoteSearchHaystack(note, book, options));
  const tags = (Array.isArray(note.tags) ? note.tags : []).map(t => normalizeTagToken(String(t)));
  return tokens.every(t => (t.kind === 'tag' ? tags.includes(t.value) : haystack.includes(t.value)));
}

/** All selected `#tag` filters present (AND). */
export function matchesTagFilters(note: Note, tags: string[]): boolean {
  if (tags.length === 0) return true;
  const own = (Array.isArray(note.tags) ? note.tags : []).map(t => normalizeTagToken(String(t)));
  return tags.every(t => own.includes(t));
}

/**
 * Sort: recent = updatedAt desc; newest = createdAt desc; reading = book title A–Z then
 * position. The To Spar filter keeps its oldest-first order (QA-35) under the default sort.
 */
export function sortNotesForView(
  notes: Note[],
  sort: NotesSort,
  filter: NotesFilter,
  bookMap: Map<string, Book>
): Note[] {
  const byId = (a: Note, b: Note) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const out = [...notes];
  if (sort === 'recent' && filter === 'to-spar') {
    return out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || byId(a, b));
  }
  if (sort === 'newest') {
    return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || byId(a, b));
  }
  if (sort === 'reading') {
    return out.sort((a, b) => {
      const ta = (bookMap.get(a.bookId)?.title || '').toLowerCase();
      const tb = (bookMap.get(b.bookId)?.title || '').toLowerCase();
      if (ta !== tb) return ta < tb ? -1 : 1;
      return (Number(a.pos) || 0) - (Number(b.pos) || 0) || byId(a, b);
    });
  }
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || byId(a, b));
}

/** True when a filter other than the defaults is active (shows "Filtered by" / Clear all). */
export function hasActiveNotesFilters(state: NotesQueryState): boolean {
  return Boolean(state.q.trim() || state.tags.length || state.book || state.filter !== 'all' || state.sort !== 'recent');
}

