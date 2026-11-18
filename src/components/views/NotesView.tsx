import React, { useMemo, useState } from 'react';
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
} from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { getRenderableAttachments } from '../../utils/metaCodecs';
import { isSafeHttpUrl, navigateTo } from '../../utils/navigation';
import { isNoteSpoiler, isSealedPrediction } from '../../utils/spoilerMath';
import {
  SPOILER_SEARCH_FOOTNOTE,
  buildNoteSearchHaystack,
  isShielded,
  noteHref,
} from '../../utils/noteVisibility';
import { extractNoteWikilinks } from '../../utils/wikilinks';
import { DriveImage } from '../common/DriveImage';
import { ArchivedBanner } from '../common/ArchivedBanner';
import { useArchiveActions } from '../../hooks/useArchiveActions';
import { archivedDateLabel, onlyArchived, withoutArchived } from '../../utils/archive';
import { ChapterPosChip } from '../common/ChapterPosChip';

type NotesFilter = 'all' | 'to-spar' | 'atomic' | 'media' | 'concepts' | 'archived';

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
  // C1.1: archived notes leave the stream, counts and search; they live behind the pill.
  const notes = useMemo(() => withoutArchived(allNotes), [allNotes]);
  const archivedNotes = useMemo(() => onlyArchived(allNotes), [allNotes]);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<NotesFilter>('all');
  const [revealedSlugs, setRevealedSlugs] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState<number>(0);

  const bookMap = useMemo(() => {
    const map = new Map<string, Book>();
    books.forEach(b => map.set(b.id, b));
    return map;
  }, [books]);

  const counts = useMemo(() => {
    let toSpar = 0;
    let atomic = 0;
    let media = 0;
    let concepts = 0;

    for (const n of notes) {
      if (n.status === 'inbox' || n.status === 'in-reflection') toSpar += 1;
      if (n.status === 'atomic') atomic += 1;
      if (getRenderableAttachments(n.meta).length > 0 || (n.meta?.links?.length || 0) > 0) media += 1;
      if (extractNoteWikilinks(n).length > 0) concepts += 1;
    }

    return {
      all: notes.length,
      toSpar,
      atomic,
      media,
      concepts,
    };
  }, [notes]);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (filter === 'archived' ? archivedNotes : notes)
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
        if (filter === 'concepts' && extractNoteWikilinks(n).length === 0) {
          return false;
        }

        if (!q) return true;
        // B2.2: an unrevealed spoiler is searchable by tags + book title/author only.
        const haystack = buildNoteSearchHaystack(n, bookMap.get(n.bookId), {
          revealed: revealedSlugs.has(n.slug),
        });
        return haystack.includes(q);
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [archivedNotes, bookMap, filter, notes, query, revealedSlugs]);

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

  React.useEffect(() => {
    setFocusedIndex(0);
  }, [filter, query]);

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
          Boolean(target.closest('[contenteditable="true"]')) ||
          Boolean(target.closest('button, a, [role="button"]')))
      ) {
        return;
      }
      if (filteredNotes.length === 0) return;

      const key = e.key.toLowerCase();
      if (key === 'j') {
        e.preventDefault();
        setFocusedIndex(prev => Math.min(filteredNotes.length - 1, prev + 1));
      } else if (key === 'k') {
        e.preventDefault();
        setFocusedIndex(prev => Math.max(0, prev - 1));
      } else if (e.key === ' ') {
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
        const active = filteredNotes[focusedIndex];
        if (active) {
          e.preventDefault();
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
  }, [bookMap, filteredNotes, focusedIndex, onDeepenNote, onEditNote, revealedSlugs]);

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
          className="h-10 px-4 rounded-full bg-primary text-primary-foreground text-body font-semibold hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          <span>Quick Capture</span>
        </button>
      </div>

      {/* Search & Filters */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            aria-label="Search notes"
            data-testid="notes-search-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search quotes, takeaways, #tags, or authors..."
            className="w-full h-11 pl-10 pr-4 rounded-full bg-card border border-border text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="notes-filter-all"
            onClick={() => setFilter('all')}
            className={`h-8 px-3 rounded-full text-label font-medium transition-colors num whitespace-nowrap ${
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
            className={`h-8 px-3 rounded-full text-label font-medium transition-colors num inline-flex items-center gap-1.5 whitespace-nowrap ${
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
            className={`h-8 px-3 rounded-full text-label font-medium transition-colors num whitespace-nowrap ${
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
            className={`h-8 px-3 rounded-full text-label font-medium transition-colors num whitespace-nowrap ${
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
            className={`h-8 px-3 rounded-full text-label font-medium transition-colors num whitespace-nowrap ${
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
              className={`h-8 px-3 rounded-full text-label font-medium transition-colors num inline-flex items-center gap-1.5 whitespace-nowrap ${
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
      </div>

      {/* Notes Stream */}
      {filteredNotes.length === 0 ? (
        <div className="bg-card border border-border rounded-[14px] p-8 text-center text-body text-muted-foreground">
          No notes match this filter yet.
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
                className={`bg-card border rounded-[14px] p-5 space-y-3 transition-colors ${
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
                  />
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
                      className="h-9 px-4 rounded-[10px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 transition-opacity inline-flex items-center gap-1.5"
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
                      <p className="text-body text-foreground">{note.takeaway}</p>
                    )}

                    {attachments.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {attachments.map(att =>
                          att.type === 'image' ? (
                            <DriveImage
                              key={att.id}
                              attachment={att}
                              className="w-16 h-16 rounded-[8px] object-cover border border-border"
                            />
                          ) : isSafeHttpUrl(att.url) ? (
                            <a
                              key={att.id}
                              href={att.url.trim()}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-surface2 border border-border text-label text-foreground hover:bg-secondary transition-colors"
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
                  </div>
                )}

                {/* Bottom Row: Tags & View Note */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/50">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {note.tags.map(tag => (
                      <span
                        key={tag}
                        className="text-label text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => navigateTo(noteHref(note, book, isRevealed))}
                    className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground inline-flex items-center gap-1 whitespace-nowrap"
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
