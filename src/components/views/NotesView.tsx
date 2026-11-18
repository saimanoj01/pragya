import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Eye,
  FileText,
  Link2,
  Lock,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { getRenderableAttachments } from '../../utils/metaCodecs';
import { isSafeHttpUrl, navigateTo, replaceHash } from '../../utils/navigation';
import { formatPosDisplay, isNoteSpoiler, isSealedPrediction } from '../../utils/spoilerMath';
import {
  SPOILER_SEARCH_FOOTNOTE,
  isShielded,
  noteHref,
} from '../../utils/noteVisibility';
import { extractNoteWikilinkKeys, extractNoteWikilinks, noteAliases, slugify } from '../../utils/wikilinks';
import {
  NOTES_SORT_LABELS,
  NOTES_SORTS,
  buildNotesHash,
  hasActiveNotesFilters,
  matchesNoteQuery,
  matchesTagFilters,
  normalizeTagToken,
  parseNotesQuery,
  sortNotesForView,
  type NotesFilter,
  type NotesQueryState,
  type NotesSort,
} from '../../utils/notesQuery';
import { linkChipLabel, standaloneNoteLinks } from '../../utils/bookSurfaces';
import { WikiText } from '../common/WikiText';
import { BTN_TERTIARY, FIELD_LABEL } from '../common/uiClasses';
import { StreamThumbnail } from '../common/StreamThumbnail';
import { focusCard, noteCardAriaLabel } from '../../utils/cardFocus';
import { ArchivedBanner } from '../common/ArchivedBanner';
import { useArchiveActions } from '../../hooks/useArchiveActions';
import { useDeleteForever } from '../../hooks/useDeleteForever';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { BTN_TERTIARY_NEGATIVE } from '../common/uiClasses';
import { archivedDateLabel, onlyArchived, withoutArchived } from '../../utils/archive';
import { ChapterPosChip } from '../common/ChapterPosChip';

/** CD C3.4: scroll + focused card per notes hash, restored on Back (sessionStorage). */
const NOTES_SCROLL_PREFIX = 'pragya_notes_scroll:';

function readHashState(): NotesQueryState {
  return parseNotesQuery(typeof window === 'undefined' ? '' : window.location.hash);
}

export interface NotesViewProps {
  onOpenCapture: () => void;
  onEditNote?: (note: Note) => void;
  onDeepenNote?: (note: Note) => void;
}

export const NotesView: React.FC<NotesViewProps> = ({
  onOpenCapture,
  onEditNote,
  onDeepenNote,
}) => {
  const { books, notes: allNotes } = usePragya();
  const { restoreNoteFromArchive } = useArchiveActions();
  const { requestDeleteNote, dialogProps: deleteDialogProps } = useDeleteForever();
  // C1.1: archived notes leave the stream, counts and search; they live behind the pill.
  const notes = useMemo(() => withoutArchived(allNotes), [allNotes]);
  const archivedNotes = useMemo(() => onlyArchived(allNotes), [allNotes]);

  // CD C3.4: state lives in the hash query (`#/notes?q=…&tag=…&book=…&filter=…&sort=…`).
  const [qs, setQs] = useState<NotesQueryState>(readHashState);
  const query = qs.q;
  const filter = qs.filter;
  const setQuery = (q: string) => setQs(prev => ({ ...prev, q }));
  const setFilter = (f: NotesFilter) => setQs(prev => ({ ...prev, filter: f }));
  const toggleTag = (tag: string) => {
    const t = normalizeTagToken(tag);
    if (!t) return;
    setQs(prev => ({ ...prev, tags: prev.tags.includes(t) ? prev.tags.filter(x => x !== t) : [...prev.tags, t] }));
  };
  const clearAll = () => setQs({ q: '', tags: [], book: '', filter: 'all', sort: 'recent' });
  const [revealedSlugs, setRevealedSlugs] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const jkMovedRef = useRef(false);
  const [jkTick, setJkTick] = useState(0);

  const bookMap = useMemo(() => {
    const map = new Map<string, Book>();
    books.forEach(b => map.set(b.id, b));
    return map;
  }, [books]);

  // Typing: replaceState debounced 300 ms; pills/selects: immediately. Never a history entry.
  const lastWrittenRef = useRef<string>('');
  useEffect(() => {
    const hash = buildNotesHash(qs);
    const write = () => {
      lastWrittenRef.current = hash;
      if (window.location.hash.startsWith('#/notes')) replaceHash(hash);
    };
    const prev = parseNotesQuery(window.location.hash);
    if (prev.q !== qs.q) {
      const t = window.setTimeout(write, 300);
      return () => window.clearTimeout(t);
    }
    write();
    return undefined;
  }, [qs]);
  // A real hash change (e.g. a link to #/notes?tag=…) re-hydrates the controls.
  useEffect(() => {
    const onHash = () => {
      if (!window.location.hash.startsWith('#/notes')) return;
      if (window.location.hash === lastWrittenRef.current) return;
      setQs(readHashState());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // C3.3/C3.4 hub notes: linked TO (slug or alias) by any live note, or linking out.
  const linkedSlugs = useMemo(() => {
    const set = new Set<string>();
    // R2-a: exact, new-slug and legacy-slug keys, so old ASCII slugs still count as hubs.
    for (const n of notes) for (const l of extractNoteWikilinkKeys(n)) set.add(l);
    return set;
  }, [notes]);
  const isConcept = useCallback(
    (n: Note) =>
      extractNoteWikilinks(n).length > 0 ||
      linkedSlugs.has(n.slug) ||
      linkedSlugs.has(slugify(n.slug)) ||
      noteAliases(n).some(a => linkedSlugs.has(a)),
    [linkedSlugs]
  );

  const counts = useMemo(() => {
    let toSpar = 0;
    let atomic = 0;
    let media = 0;
    let concepts = 0;

    for (const n of notes) {
      if (n.status === 'inbox' || n.status === 'in-reflection') toSpar += 1;
      if (n.status === 'atomic') atomic += 1;
      if (getRenderableAttachments(n.meta).length > 0 || (n.meta?.links?.length || 0) > 0) media += 1;
      if (isConcept(n)) concepts += 1;
    }

    return {
      all: notes.length,
      toSpar,
      atomic,
      media,
      concepts,
    };
  }, [isConcept, notes]);

  const filteredNotes = useMemo(() => {
    const q = query.trim();
    const matched = (filter === 'archived' ? archivedNotes : notes)
      .filter(n => {
        if (filter === 'to-spar' && n.status !== 'inbox' && n.status !== 'in-reflection') {
          return false;
        }
        if (filter === 'atomic' && n.status !== 'atomic') {
          return false;
        }
        if (
          filter === 'media' &&
          getRenderableAttachments(n.meta).length === 0 &&
          (n.meta?.links?.length || 0) === 0
        ) {
          return false;
        }
        if (filter === 'concepts' && !isConcept(n)) {
          return false;
        }
        if (qs.book && n.bookId !== qs.book) return false;
        if (!matchesTagFilters(n, qs.tags)) return false;

        if (!q) return true;
        // B2.2: an unrevealed spoiler is searchable by tags + book title/author only.
        // C3.4: AND of tokens, case/diacritic-insensitive, `#tag` exact, "phrases".
        return matchesNoteQuery(n, bookMap.get(n.bookId), q, { revealed: revealedSlugs.has(n.slug) });
      });
    // QA-35 / ux Q.11: To Spar keeps oldest-first under the default sort (Save & Next order).
    return sortNotesForView(matched, qs.sort, filter, bookMap);
  }, [archivedNotes, bookMap, filter, isConcept, notes, qs.book, qs.sort, qs.tags, query, revealedSlugs]);

  // Result count announced politely, debounced 400 ms.
  const [announcedCount, setAnnouncedCount] = useState(filteredNotes.length);
  useEffect(() => {
    const t = window.setTimeout(() => setAnnouncedCount(filteredNotes.length), 400);
    return () => window.clearTimeout(t);
  }, [filteredNotes.length]);

  const bookOptions = useMemo(
    () => withoutArchived(books).slice().sort((a, b) => a.title.localeCompare(b.title)),
    [books]
  );

  // C3.4 scroll & focus restoration on Back.
  const rememberPosition = useCallback(() => {
    try {
      const main = document.querySelector('main');
      sessionStorage.setItem(
        `${NOTES_SCROLL_PREFIX}${buildNotesHash(qs)}`,
        JSON.stringify({ scrollTop: main?.scrollTop || 0, focusedIndex })
      );
    } catch {
      // storage unavailable: nothing to restore later
    }
  }, [qs, focusedIndex]);
  const restoredRef = useRef(false);

  const showSpoilerSearchFootnote = useMemo(
    () =>
      query.trim() !== '' &&
      notes.some(n => isShielded(n, bookMap.get(n.bookId), revealedSlugs.has(n.slug))),
    [bookMap, notes, query, revealedSlugs]
  );

  const revealNote = (slug: string) => {
    setRevealedSlugs(prev => {
      const next = new Set(prev);
      next.add(slug);
      return next;
    });
  };

  const filterKey = `${filter}|${query}|${qs.book}|${qs.sort}|${qs.tags.join(',')}`;
  const firstFilterKeyRef = useRef(filterKey);
  React.useEffect(() => {
    if (filterKey === firstFilterKeyRef.current) return;
    firstFilterKeyRef.current = filterKey;
    setFocusedIndex(0);
  }, [filterKey]);

  useEffect(() => {
    if (restoredRef.current || filteredNotes.length === 0) return;
    restoredRef.current = true;
    let saved: { scrollTop?: number; focusedIndex?: number } | null = null;
    try {
      const key = `${NOTES_SCROLL_PREFIX}${buildNotesHash(qs)}`;
      saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      sessionStorage.removeItem(key); // one-shot: only the return trip restores
    } catch {
      saved = null;
    }
    if (!saved) return;
    const idx = Math.min(Math.max(0, Number(saved.focusedIndex) || 0), filteredNotes.length - 1);
    setFocusedIndex(idx);
    requestAnimationFrame(() => {
      const main = document.querySelector('main');
      if (main) main.scrollTop = Number(saved?.scrollTop) || 0;
      const card = document.querySelector<HTMLElement>(
        `[data-testid="note-card-${filteredNotes[idx]?.slug}"] [data-view-note="true"]`
      );
      card?.focus({ preventScroll: true });
    });
  }, [filteredNotes, qs]);

  useEffect(() => {
    if (focusedIndex >= filteredNotes.length && filteredNotes.length > 0) {
      setFocusedIndex(filteredNotes.length - 1);
    }
  }, [filteredNotes.length, focusedIndex]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (document.querySelector('[data-popover="true"]')) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable ||
          Boolean(target.closest('[contenteditable="true"]')))
      ) {
        return;
      }
      if (filteredNotes.length === 0) return;

      const key = e.key.toLowerCase();
      if (key === 'j') {
        e.preventDefault();
        jkMovedRef.current = true;
        setFocusedIndex(prev => Math.min(filteredNotes.length - 1, prev + 1));
        setJkTick(t => t + 1);
      } else if (key === 'k') {
        e.preventDefault();
        jkMovedRef.current = true;
        setFocusedIndex(prev => Math.max(0, prev - 1));
        setJkTick(t => t + 1);
      } else if (e.key === ' ') {
        if (target?.closest('button, a, summary, [role="button"]')) return;
        const active = filteredNotes[focusedIndex];
        if (
          active &&
          isNoteSpoiler(active, bookMap.get(active.bookId)) &&
          !revealedSlugs.has(active.slug)
        ) {
          e.preventDefault();
          revealNote(active.slug);
        }
      } else if (e.key === 'Enter') {
        if (target?.closest('button, a, summary, [role="button"]')) return;
        const active = filteredNotes[focusedIndex];
        if (active) {
          e.preventDefault();
          rememberPosition();
          navigateTo(noteHref(active, bookMap.get(active.bookId), revealedSlugs.has(active.slug)));
        }
      } else if (key === 'd' && onDeepenNote) {
        const active = filteredNotes[focusedIndex];
        if (active && !(isNoteSpoiler(active, bookMap.get(active.bookId)) && !revealedSlugs.has(active.slug))) {
          e.preventDefault();
          onDeepenNote(active);
        }
      } else if (key === 'e' && onEditNote) {
        const active = filteredNotes[focusedIndex];
        if (active && !(isNoteSpoiler(active, bookMap.get(active.bookId)) && !revealedSlugs.has(active.slug))) {
          e.preventDefault();
          onEditNote(active);
        }
      } else if (key === 'o') {
        const active = filteredNotes[focusedIndex];
        if (active && !(isNoteSpoiler(active, bookMap.get(active.bookId)) && !revealedSlugs.has(active.slug))) {
          const docOrLink = getRenderableAttachments(active.meta).find(
            (a): a is Extract<typeof a, { type: 'doc' | 'link' }> =>
              a.type !== 'image' && isSafeHttpUrl(a.url)
          );
          const url = docOrLink?.url || active.meta?.links?.find(l => isSafeHttpUrl(l));
          if (url && isSafeHttpUrl(url)) {
            e.preventDefault();
            window.open(url.trim(), '_blank', 'noopener,noreferrer');
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [bookMap, filteredNotes, focusedIndex, onDeepenNote, onEditNote, rememberPosition, revealedSlugs]);

  // CD D2.1: after J/K the focused card gets real DOM focus and is scrolled into view.
  useEffect(() => {
    if (!jkMovedRef.current) return;
    jkMovedRef.current = false;
    focusCard(document.querySelector<HTMLElement>(`[data-testid="notes-view"] [data-jk-card="${focusedIndex}"]`));
  }, [focusedIndex, jkTick]);

  const renderStatusBadge = (note: Note, book?: Book) => {
    if (isSealedPrediction(note, book)) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-md bg-surface2 border border-border text-foreground">
          <Lock className="w-3 h-3" />
          <span>Sealed Prediction</span>
        </span>
      );
    }
    if (note.status === 'inbox') {
      return (
        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-md bg-warning/15 border border-warning/30 text-warning">
          Inbox
        </span>
      );
    }
    if (note.status === 'in-reflection') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-md bg-warning/15 border border-warning/30 text-warning">
          <Sparkles className="w-3 h-3" />
          <span>In Reflection</span>
        </span>
      );
    }
    if (note.status === 'atomic') {
      return (
        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-md bg-positive/15 border border-positive/30 text-positive">
          Atomic
        </span>
      );
    }
    return null;
  };

  return (
    <div data-testid="notes-view" className="py-6 space-y-6">
      <ConfirmDialog {...deleteDialogProps} />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display-l text-foreground tracking-tight">Notes</h1>
          <p className="text-body text-muted-foreground mt-1">
            Commonplace quotes, personal takeaways, and distilled concepts.
          </p>
        </div>

        <button
          type="button"
          data-testid="notes-quick-capture-btn"
          onClick={onOpenCapture}
          className="h-11 sm:h-10 px-4 rounded-full bg-primary text-primary-foreground text-body font-semibold hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          <span>Quick Capture</span>
        </button>
      </div>

      {/* Search & Filters */}
      <div data-print-hide="true" className="space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            enterKeyHint="search"
            aria-label="Search notes"
            data-testid="notes-search-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search quotes, takeaways, #tags, or authors..."
            className="w-full h-11 pl-10 pr-4 rounded-full bg-card border border-border text-base sm:text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="notes-filter-all"
            onClick={() => setFilter('all')}
            className={`h-11 sm:h-8 min-w-11 sm:min-w-0 px-3 rounded-full text-label font-medium transition-colors num whitespace-nowrap ${
              filter === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface2 border border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            All ({counts.all})
          </button>

          <button
            type="button"
            data-testid="notes-filter-to-spar"
            onClick={() => setFilter('to-spar')}
            className={`h-11 sm:h-8 min-w-11 sm:min-w-0 px-3 rounded-full text-label font-medium transition-colors num inline-flex items-center gap-1.5 whitespace-nowrap ${
              filter === 'to-spar'
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface2 border border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>To Spar ({counts.toSpar})</span>
          </button>

          <button
            type="button"
            data-testid="notes-filter-atomic"
            onClick={() => setFilter('atomic')}
            className={`h-11 sm:h-8 min-w-11 sm:min-w-0 px-3 rounded-full text-label font-medium transition-colors num whitespace-nowrap ${
              filter === 'atomic'
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface2 border border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            Atomic ({counts.atomic})
          </button>

          <button
            type="button"
            data-testid="notes-filter-media"
            onClick={() => setFilter('media')}
            className={`h-11 sm:h-8 min-w-11 sm:min-w-0 px-3 rounded-full text-label font-medium transition-colors num whitespace-nowrap ${
              filter === 'media'
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface2 border border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            Has Media ({counts.media})
          </button>

          <button
            type="button"
            data-testid="notes-filter-concepts"
            onClick={() => setFilter('concepts')}
            className={`h-11 sm:h-8 min-w-11 sm:min-w-0 px-3 rounded-full text-label font-medium transition-colors num whitespace-nowrap ${
              filter === 'concepts'
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface2 border border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            [[Concepts]] ({counts.concepts})
          </button>

          {(archivedNotes.length > 0 || filter === 'archived') && (
            <button
              type="button"
              data-testid="notes-filter-archived"
              onClick={() => setFilter('archived')}
              className={`h-11 sm:h-8 min-w-11 sm:min-w-0 px-3 rounded-full text-label font-medium transition-colors num inline-flex items-center gap-1.5 whitespace-nowrap ${
                filter === 'archived'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface2 border border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              <Archive className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Archived ({archivedNotes.length})</span>
            </button>
          )}
        </div>

        {/* C3.4: book filter, sort, result count */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <span className={FIELD_LABEL}>Book</span>
            <select
              data-testid="notes-book-filter"
              value={qs.book}
              onChange={e => setQs(prev => ({ ...prev, book: e.target.value }))}
              className="h-11 sm:h-9 px-2.5 rounded-[10px] bg-background border border-input text-base sm:text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 max-w-[220px]"
            >
              <option value="">All books</option>
              {bookOptions.map(b => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className={FIELD_LABEL}>Sort</span>
            <select
              data-testid="notes-sort-select"
              value={qs.sort}
              onChange={e => setQs(prev => ({ ...prev, sort: e.target.value as NotesSort }))}
              className="h-11 sm:h-9 px-2.5 rounded-[10px] bg-background border border-input text-base sm:text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              {NOTES_SORTS.map(sv => (
                <option key={sv} value={sv}>
                  {NOTES_SORT_LABELS[sv]}
                </option>
              ))}
            </select>
          </label>
          <span
            data-testid="notes-result-count"
            role="status"
            aria-live="polite"
            className="ml-auto text-label text-muted-foreground num"
          >
            {announcedCount} {announcedCount === 1 ? 'note' : 'notes'}
          </span>
        </div>

        {(qs.tags.length > 0 || qs.book) && (
          <div data-testid="notes-active-filters" className="flex flex-wrap items-center gap-2">
            <span className="text-label text-muted-foreground">Filtered by:</span>
            {qs.tags.map(tag => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 pl-2.5 pr-1 sm:pr-2.5 py-1 rounded-full bg-surface2 border border-border text-label text-foreground"
              >
                {tag}
                <button
                  type="button"
                  aria-label={`Remove filter ${tag}`}
                  onClick={() => toggleTag(tag)}
                  className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 -my-2 -mr-1 sm:m-0 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              </span>
            ))}
            {qs.book && (
              <span className="inline-flex items-center gap-1 pl-2.5 pr-1 sm:pr-2.5 py-1 rounded-full bg-surface2 border border-border text-label text-foreground">
                {bookMap.get(qs.book)?.title || 'Book'}
                <button
                  type="button"
                  aria-label={`Remove filter ${bookMap.get(qs.book)?.title || 'Book'}`}
                  onClick={() => setQs(prev => ({ ...prev, book: '' }))}
                  className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 -my-2 -mr-1 sm:m-0 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              </span>
            )}
            <button type="button" data-testid="notes-clear-filters-btn" onClick={clearAll} className={BTN_TERTIARY}>
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Notes Stream */}
      {filteredNotes.length === 0 ? (
        <div className="bg-card border border-border rounded-[14px] p-8 text-center text-body text-muted-foreground space-y-3">
          <p>No notes match these filters.</p>
          {hasActiveNotesFilters(qs) && (
            <button type="button" onClick={clearAll} className={BTN_TERTIARY}>
              Clear all
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredNotes.map((note, idx) => {
            const book = bookMap.get(note.bookId);
            const spoiler = isNoteSpoiler(note, book);
            const isRevealed = revealedSlugs.has(note.slug);
            const showShield = spoiler && !isRevealed;
            const attachments = getRenderableAttachments(note.meta);
            const isFocused = idx === focusedIndex;

            return (
              <article
                key={note.id}
                data-testid={`note-card-${note.slug}`}
                data-focused={isFocused ? 'true' : undefined}
                data-jk-focused={isFocused ? 'true' : undefined}
                data-jk-card={idx}
                tabIndex={-1}
                aria-label={noteCardAriaLabel({
                  bookTitle: book?.title,
                  posLabel: formatPosDisplay(note.pos, book?.posUnit || 'page'),
                  title: note.meta?.title,
                  shielded: showShield,
                })}
                onFocus={() => setFocusedIndex(idx)}
                className={`bg-card border rounded-[14px] p-5 space-y-3 transition-colors focus:outline-none focus-visible:border-foreground/40 focus-visible:ring-1 focus-visible:ring-ring/40 ${
                  isFocused ? 'border-foreground/40 ring-1 ring-ring/40' : 'border-border'
                }`}
              >
                {/* Top Meta Line */}
                <div className="flex flex-wrap items-center gap-2 text-label text-muted-foreground">
                  <span className="font-medium text-foreground">{book?.title || 'Unknown Book'}</span>
                  <span>·</span>
                  <ChapterPosChip
                    testIdKey={note.slug}
                    chapter={note.meta?.chapter}
                    pos={note.pos}
                    posUnit={book?.posUnit || 'page'}
                    positionOnly={showShield}
                  />
                  {renderStatusBadge(note, book)}
                </div>

                {filter === 'archived' && (
                  <ArchivedBanner
                    compact
                    date={archivedDateLabel(note)}
                    onRestore={() => void restoreNoteFromArchive(note)}
                  >
                    {/* A shielded card never offers delete (its title/slug would surface). */}
                    {!showShield && (
                      <button
                        type="button"
                        data-testid="delete-forever-btn"
                        onClick={() => requestDeleteNote(note)}
                        className={BTN_TERTIARY_NEGATIVE}
                      >
                        Delete Forever…
                      </button>
                    )}
                  </ArchivedBanner>
                )}

                {/* Spoiler Shield OR Content */}
                {showShield ? (
                  <div
                    data-testid={`spoiler-shield-${note.slug}`}
                    className="rounded-[12px] bg-surface2/70 border border-border p-5 text-center space-y-2.5"
                  >
                    <div className="inline-flex items-center gap-1.5 text-body font-semibold text-foreground">
                      <AlertTriangle className="w-4 h-4 text-warning" />
                      <span>Spoiler Shield</span>
                    </div>
                    <p className="text-label text-muted-foreground num">
                      Page/Pos {note.pos} &gt; Current {book?.currentPos ?? 0} — Click or press Space to reveal
                    </p>
                    <button
                      type="button"
                      data-testid={`spoiler-reveal-btn-${note.slug}`}
                      onClick={() => revealNote(note.slug)}
                      className="h-11 sm:h-9 px-4 rounded-[10px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 transition-opacity inline-flex items-center gap-1.5"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>Reveal Quote (or Space)</span>
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {note.meta?.title && (
                      <h3 className="text-heading text-foreground">{note.meta.title}</h3>
                    )}

                    {note.quote && (
                      <blockquote className="pl-3.5 border-l-2 border-border text-body italic text-muted-foreground">
                        &ldquo;{note.quote}&rdquo;
                      </blockquote>
                    )}

                    {note.takeaway && (
                      <p className="text-body text-foreground">
                        <WikiText text={note.takeaway} notes={allNotes} books={books} onNavigate={rememberPosition} />
                      </p>
                    )}

                    {attachments.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {attachments.map(att =>
                          att.type === 'image' ? (
                            <StreamThumbnail
                              key={att.id}
                              attachment={att}
                              className="w-16 h-16 rounded-[8px] object-cover border border-border"
                            />
                          ) : isSafeHttpUrl(att.url) ? (
                            <a
                              key={att.id}
                              href={att.url.trim()}
                              data-print-href={att.url.trim()}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="min-h-11 sm:min-h-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-surface2 border border-border text-label text-foreground hover:bg-secondary transition-colors"
                            >
                              {att.type === 'doc' ? (
                                <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                              ) : (
                                <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
                              )}
                              <span className="truncate max-w-[180px]">{att.title}</span>
                            </a>
                          ) : (
                            <span
                              key={att.id}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-surface2 border border-border text-label text-muted-foreground"
                            >
                              {att.type === 'doc' ? (
                                <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                              ) : (
                                <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
                              )}
                              <span className="truncate max-w-[180px]">{att.title}</span>
                            </span>
                          )
                        )}
                      </div>
                    )}

                    {/* CD C2.5: standalone meta.links chips (deduped vs attachments). */}
                    {standaloneNoteLinks(note).length > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        {standaloneNoteLinks(note).map((url, linkIdx) =>
                          isSafeHttpUrl(url) ? (
                            <a
                              key={url}
                              href={url}
                              data-print-href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              data-testid={`note-link-chip-${linkIdx}`}
                              aria-label={`Open link ${url}`}
                              className="min-h-11 sm:min-h-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-surface2 border border-border text-label text-foreground hover:bg-secondary transition-colors"
                            >
                              <Link2 className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
                              <span className="truncate max-w-[220px]">{linkChipLabel(url)}</span>
                            </a>
                          ) : (
                            <span
                              key={url}
                              data-testid={`note-link-chip-${linkIdx}`}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-surface2 border border-border text-label text-muted-foreground"
                            >
                              <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                              <span className="truncate max-w-[220px]">{linkChipLabel(url)}</span>
                            </span>
                          )
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Bottom Row: Tags & View Note */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/50">
                  <div className="flex flex-wrap items-center gap-2 sm:gap-1.5">
                    {note.tags.map(tag => {
                      const t = normalizeTagToken(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          data-print-keep="true"
                          data-testid={`tag-pill-${t.slice(1)}`}
                          aria-pressed={qs.tags.includes(t)}
                          onClick={() => toggleTag(tag)}
                          className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 px-1.5 sm:px-0 inline-flex items-center justify-center text-label text-muted-foreground hover:text-foreground hover:underline"
                        >
                          {tag}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    data-view-note="true"
                    onClick={() => {
                      rememberPosition();
                      navigateTo(noteHref(note, book, isRevealed));
                    }}
                    className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 px-1 sm:px-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground inline-flex items-center justify-center gap-1 whitespace-nowrap"
                  >
                    <span>VIEW NOTE</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {showSpoilerSearchFootnote && (
        <p data-testid="notes-spoiler-search-footnote" className="text-label text-muted-foreground">
          {SPOILER_SEARCH_FOOTNOTE}
        </p>
      )}
    </div>
  );
};
