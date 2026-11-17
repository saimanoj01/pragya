import type { Book, Note } from '../types/pragya';
import { formatPosDisplay, isNoteSpoiler } from './spoilerMath';

/**
 * Spoiler-safe search & discovery (ux_spec C.3). For a shielded, unrevealed note only
 * its tags and the book title/author are searchable or displayable; title, slug, quote,
 * takeaway, chapter and Layer 2 fields never reach a search index, palette or picker.
 */
export const SPOILER_SEARCH_FOOTNOTE = 'Notes ahead of your bookmark are searched by tag and book only.';
export const SHIELDED_NOTE_TITLE = 'Shielded note';
export const REVEAL_TO_EDIT_TOOLTIP = 'Reveal the note to edit';
export const NOTE_REVEALED_ANNOUNCEMENT = 'Note revealed.';

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function tagList(note: Note): string[] {
  return Array.isArray(note.tags) ? note.tags.map(str) : [];
}

/** True when the note's content must stay hidden right now. */
export function isShielded(note: Note, book: Book | null | undefined, revealed = false): boolean {
  return !revealed && isNoteSpoiler(note, book);
}

/** `Shielded note · p. 250` (position label only — never title/slug). */
export function shieldedNoteLabel(note: Note, book: Book | null | undefined): string {
  return `${SHIELDED_NOTE_TITLE} · ${formatPosDisplay(Number(note.pos) || 0, book?.posUnit || 'page')}`;
}

/**
 * Batch 4 decision (R1#4 / R2#2): a shielded note is navigated by its opaque id so its
 * title-derived slug never reaches the address bar or history. Visible notes keep slugs.
 */
export function noteHref(note: Note, book: Book | null | undefined, revealed = false): string {
  const ref = isShielded(note, book, revealed) ? note.id : note.slug;
  return `#/note/${encodeURIComponent(ref)}`;
}

/** Resolve a `#/note/<ref>` segment: slug first (canonical), then note id. */
export function resolveNoteRef(notes: Note[], ref: string): Note | undefined {
  if (!ref) return undefined;
  return notes.find(n => n.slug === ref) || notes.find(n => n.id === ref);
}

export interface PracticeDeltaLists {
  active: Note[];
  archived: Note[];
  /** Ids whose WHEN/DO, title and slug must stay hidden (shielded and not revealed). */
  shieldedIds: Set<string>;
}

/**
 * R1#1: Practice delta lists keep every delta (so the 5-cap, Pause/Graduate/Reactivate keep
 * working) but a shielded note renders as `Shielded note · {pos}` + Reveal — never its
 * WHEN/DO, title or slug. The CLI filters these out of recall/shuffle output instead.
 */
export function getPracticeDeltaLists(
  notes: Note[],
  bookMap: Map<string, Book>,
  revealedIds: ReadonlySet<string> = new Set()
): PracticeDeltaLists {
  const out: PracticeDeltaLists = { active: [], archived: [], shieldedIds: new Set() };
  for (const n of notes) {
    const isActive = n.deltaStatus === 'active';
    const isArchived = n.deltaStatus === 'paused' || n.deltaStatus === 'graduated';
    if (!isActive && !isArchived) continue;
    if (isShielded(n, bookMap.get(n.bookId), revealedIds.has(n.id))) out.shieldedIds.add(n.id);
    (isActive ? out.active : out.archived).push(n);
  }
  return out;
}

/** Lower-cased haystack for NotesView/CommandPalette search. */
export function buildNoteSearchHaystack(
  note: Note,
  book: Book | null | undefined,
  options: { revealed?: boolean } = {}
): string {
  const safe = [...tagList(note), str(book?.title), str(book?.author)];
  const parts = isShielded(note, book, options.revealed)
    ? safe
    : [
        str(note.meta?.title),
        str(note.slug),
        str(note.meta?.chapter),
        str(note.quote),
        str(note.takeaway),
        str(note.contextMechanism),
        str(note.critique),
        ...safe,
      ];
  return parts.join(' ').toLowerCase();
}

/**
 * B2.3: `[[` autocomplete candidates. Shielded notes are excluded entirely — inserting
 * their slug would leak it (OQ-11). Matching is on slug, title and takeaway, as before.
 */
export function filterWikilinkCandidates(
  notes: Note[],
  books: Book[] | undefined,
  query: string,
  exclude: { noteId?: string; slug?: string } = {},
  limit = 6
): Note[] {
  const bookMap = new Map((books || []).map(b => [b.id, b] as const));
  const q = query.trim().toLowerCase();
  const out: Note[] = [];
  for (const n of notes) {
    if (exclude.noteId && n.id === exclude.noteId) continue;
    if (exclude.slug && n.slug === exclude.slug) continue;
    if (books && isNoteSpoiler(n, bookMap.get(n.bookId))) continue;
    if (
      q &&
      !(
        str(n.slug).toLowerCase().includes(q) ||
        str(n.meta?.title).toLowerCase().includes(q) ||
        str(n.takeaway).toLowerCase().includes(q)
      )
    ) {
      continue;
    }
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

export interface NoteDetailVisibility {
  shielded: boolean;
  /** `h1` text: the real title, or "Shielded note". */
  heading: string;
  /** Content sections (slug line, banner, quote, takeaway, Layer 2, attachments, tags, wikilinks). */
  showContent: boolean;
  showBacklinks: boolean;
  /** Chapter belongs to the content (ux_spec C.2: chip gains chapter after reveal). */
  showChapter: boolean;
  editDisabled: boolean;
  editTooltip?: string;
}

/** B2.1: pure visibility model for NoteDetailView (ux_spec C.2). */
export function getNoteDetailVisibility(
  note: Note,
  book: Book | null | undefined,
  revealed: boolean
): NoteDetailVisibility {
  const shielded = isShielded(note, book, revealed);
  if (shielded) {
    return {
      shielded,
      heading: SHIELDED_NOTE_TITLE,
      showContent: false,
      showBacklinks: false,
      showChapter: false,
      editDisabled: true,
      editTooltip: REVEAL_TO_EDIT_TOOLTIP,
    };
  }
  return {
    shielded,
    heading: str(note.meta?.title) || str(note.slug),
    showContent: true,
    showBacklinks: true,
    showChapter: true,
    editDisabled: false,
  };
}
