import React, { useMemo, useState } from 'react';
import { BookOpenText, Copy, Eye, Lock, Plus, Search, Volume2, X } from 'lucide-react';
import { usePragyaData } from '../../context/PragyaContext';
import { useCopyPrompt } from '../../hooks/useCopyPrompt';
import { withoutArchived } from '../../utils/archive';
import { buildWordLookupPrompt, groupWordsByLemma } from '../../utils/lexicon';
import { navigateTo } from '../../utils/navigation';
import { ChapterPosChip } from '../common/ChapterPosChip';
import { PromptFallbackModal } from '../common/PromptFallbackModal';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  INPUT,
} from '../common/uiClasses';

const FILTER_PILL =
  'min-h-11 sm:min-h-0 px-3 py-1 rounded-full text-label font-medium border transition-colors';
const FILTER_PILL_ACTIVE = 'bg-primary text-primary-foreground border-primary';
const FILTER_PILL_IDLE =
  'bg-surface2/60 text-muted-foreground border-border hover:text-foreground';

export interface LexiconViewProps {
  onOpenWordCapture: () => void;
}

export const LexiconView: React.FC<LexiconViewProps> = ({ onOpenWordCapture }) => {
  const { books, notes } = usePragyaData();
  const [query, setQuery] = useState('');
  const [bookFilter, setBookFilter] = useState('');
  const [sort, setSort] = useState<'az' | 'recent'>('az');
  const [revealedNoteIds, setRevealedNoteIds] = useState<Set<string>>(new Set());

  const { copyPrompt, fallbackModalProps } = useCopyPrompt({
    successMessage: 'Lookup prompt copied',
    fallbackTitle: 'Copy Word Lookup Prompt',
    fallbackTestId: 'lexicon-lookup-fallback-modal',
    fallbackPromptLabel: 'Word lookup prompt',
  });

  const activeBooks = useMemo(
    () => withoutArchived(books).slice().sort((a, b) => a.title.localeCompare(b.title)),
    [books]
  );

  const allGroups = useMemo(
    () => groupWordsByLemma(notes, books, { revealedNoteIds }),
    [books, notes, revealedNoteIds]
  );

  const booksWithWords = useMemo(() => {
    const bookIds = new Set<string>();
    for (const g of allGroups) {
      for (const enc of g.encounters) {
        if (enc.book) bookIds.add(enc.book.id);
      }
    }
    return activeBooks.filter(b => bookIds.has(b.id));
  }, [activeBooks, allGroups]);

  const groups = useMemo(
    () =>
      groupWordsByLemma(notes, books, {
        bookId: bookFilter || undefined,
        query,
        sort,
        revealedNoteIds,
      }),
    [bookFilter, books, notes, query, revealedNoteIds, sort]
  );

  const revealEncounter = (noteId: string) => {
    setRevealedNoteIds(prev => {
      const next = new Set(prev);
      next.add(noteId);
      return next;
    });
  };

  return (
    <div data-testid="lexicon-view" className="py-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display-l text-foreground tracking-tight">Lexicon</h1>
          <p className="text-body text-muted-foreground mt-1">
            Words met in books, anchored to the scene where you noticed them.
          </p>
        </div>

        <button
          type="button"
          data-testid="lexicon-capture-word-btn"
          onClick={onOpenWordCapture}
          className={BTN_PRIMARY}
        >
          <Plus className="w-4 h-4" />
          <span>Capture Word</span>
        </button>
      </div>

      {/* Search, Book Filter & Sort */}
      <section className={`${CARD} space-y-3`}>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              data-testid="lexicon-search-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search words, meanings, etymologies, passages..."
              className={`${INPUT} pl-9 pr-8`}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="w-7 h-7 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-foreground absolute right-1.5 top-1/2 -translate-y-1/2"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div
            role="group"
            aria-label="Sort vocabulary"
            className="inline-flex items-center gap-1 self-start sm:self-auto"
          >
            <button
              type="button"
              data-testid="lexicon-sort-az"
              onClick={() => setSort('az')}
              className={`${FILTER_PILL} ${sort === 'az' ? FILTER_PILL_ACTIVE : FILTER_PILL_IDLE}`}
            >
              A–Z
            </button>
            <button
              type="button"
              data-testid="lexicon-sort-recent"
              onClick={() => setSort('recent')}
              className={`${FILTER_PILL} ${sort === 'recent' ? FILTER_PILL_ACTIVE : FILTER_PILL_IDLE}`}
            >
              Recent
            </button>
          </div>
        </div>

        {booksWithWords.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by book">
            <button
              type="button"
              data-testid="lexicon-book-all"
              onClick={() => setBookFilter('')}
              className={`${FILTER_PILL} ${bookFilter === '' ? FILTER_PILL_ACTIVE : FILTER_PILL_IDLE}`}
            >
              All books
            </button>
            {booksWithWords.map(b => (
              <button
                key={b.id}
                type="button"
                data-testid={`lexicon-book-filter-${b.id}`}
                onClick={() => setBookFilter(prev => (prev === b.id ? '' : b.id))}
                className={`${FILTER_PILL} max-w-[220px] truncate ${
                  bookFilter === b.id ? FILTER_PILL_ACTIVE : FILTER_PILL_IDLE
                }`}
              >
                {b.title}
              </button>
            ))}
          </div>
        )}
      </section>

      {groups.length === 0 ? (
        <div
          data-testid="lexicon-empty-state"
          className="bg-card border border-border rounded-[14px] p-8 text-center space-y-4"
        >
          <div className="w-10 h-10 rounded-full bg-surface2 border border-border mx-auto flex items-center justify-center text-muted-foreground">
            <BookOpenText className="w-5 h-5" />
          </div>
          <div className="space-y-1 max-w-md mx-auto">
            <p className="text-heading text-foreground">
              {allGroups.length === 0
                ? 'Your personal lexicon is open'
                : 'No matching words'}
            </p>
            <p className="text-body text-muted-foreground">
              {allGroups.length === 0
                ? 'Save unfamiliar or resonant words straight from Quick Capture (switch to Word) and Pragya keeps the passage and page with them.'
                : 'Try clearing your search or choosing another book.'}
            </p>
          </div>
          {allGroups.length === 0 ? (
            <button
              type="button"
              data-testid="lexicon-empty-capture-btn"
              onClick={onOpenWordCapture}
              className={BTN_PRIMARY}
            >
              <Plus className="w-4 h-4" />
              <span>Capture a Word</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setBookFilter('');
              }}
              className={BTN_SECONDARY}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {groups.map((group, groupIdx) => {
            if (group.allShielded) {
              const firstEnc = group.encounters[0];
              return (
                <article
                  key={`shielded-${firstEnc.note.id}`}
                  data-testid={`lexicon-card-shielded-${firstEnc.note.id}`}
                  className={`${CARD} space-y-3 bg-surface2/40`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="inline-flex items-center gap-2 text-label font-semibold text-foreground">
                      <Lock className="w-4 h-4 text-warning" />
                      <span>
                        Shielded word · {firstEnc.book?.title || 'Book'} · {firstEnc.posLabel}
                      </span>
                    </div>
                    <button
                      type="button"
                      data-testid={`lexicon-reveal-btn-${firstEnc.note.id}`}
                      onClick={() => revealEncounter(firstEnc.note.id)}
                      className={BTN_SECONDARY}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>Reveal</span>
                    </button>
                  </div>
                  <p className="text-label text-muted-foreground">
                    Ahead of your current bookmark — kept hidden until you reach {firstEnc.posLabel} or reveal it here.
                  </p>
                </article>
              );
            }

            const primaryEnc = group.encounters.find(e => !e.shielded) || group.encounters[0];
            return (
              <article
                key={group.lemma || `group-${groupIdx}`}
                data-testid={`lexicon-card-${group.lemma}`}
                className={`${CARD} space-y-3`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2.5">
                      <h2 className="text-title text-foreground font-semibold">{group.word}</h2>
                      {group.pronunciation && (
                        <span className="inline-flex items-center gap-1 text-label font-mono text-muted-foreground">
                          <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>{group.pronunciation}</span>
                        </span>
                      )}
                      {group.partOfSpeech && (
                        <span className="px-2 py-0.5 text-[11px] rounded-md bg-surface2 border border-border text-muted-foreground">
                          {group.partOfSpeech}
                        </span>
                      )}
                    </div>
                  </div>

                  {group.needsDefinition && (
                    <button
                      type="button"
                      data-testid={`lexicon-copy-prompt-${group.lemma}`}
                      onClick={() => {
                        void copyPrompt(
                          buildWordLookupPrompt({
                            word: group.word,
                            bookTitle: primaryEnc.book?.title,
                            author: primaryEnc.book?.author,
                            chapter: primaryEnc.note.meta?.chapter,
                            posLabel: primaryEnc.posLabel,
                            quote: primaryEnc.quote || undefined,
                          })
                        );
                      }}
                      className={BTN_SECONDARY}
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy lookup prompt</span>
                    </button>
                  )}
                </div>

                {group.definition && (
                  <p className="text-body text-foreground leading-relaxed">{group.definition}</p>
                )}

                {group.etymology && (
                  <p className="text-label text-muted-foreground">
                    <span className="font-semibold text-foreground/80">Origin:</span>{' '}
                    {group.etymology}
                  </p>
                )}

                {group.transferExample && (
                  <p className="text-body text-foreground/90 rounded-[10px] bg-surface2/60 border border-border/70 px-3 py-2">
                    <span className="text-label uppercase tracking-wide text-muted-foreground mr-2">
                      In practice
                    </span>
                    {group.transferExample}
                  </p>
                )}

                <div className="pt-2 border-t border-border/60 space-y-2.5">
                  {group.encounters.map(enc => {
                    if (enc.shielded) {
                      return (
                        <div
                          key={enc.note.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-surface2/60 border border-border px-3 py-2 text-label text-muted-foreground"
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <Lock className="w-3.5 h-3.5 text-warning" />
                            <span>
                              Shielded encounter · {enc.book?.title || 'Book'} · {enc.posLabel}
                            </span>
                          </span>
                          <button
                            type="button"
                            data-testid={`lexicon-reveal-btn-${enc.note.id}`}
                            onClick={() => revealEncounter(enc.note.id)}
                            className="font-semibold text-foreground hover:underline"
                          >
                            Reveal
                          </button>
                        </div>
                      );
                    }

                    const book = enc.book;
                    return (
                      <div key={enc.note.id} className="space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-label">
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            {book ? (
                              <button
                                type="button"
                                data-testid={`lexicon-encounter-book-${enc.note.id}`}
                                onClick={() =>
                                  navigateTo(
                                    `#/book/${encodeURIComponent(book.id)}?note=${encodeURIComponent(enc.note.id)}`
                                  )
                                }
                                className="font-semibold text-foreground hover:underline text-left"
                              >
                                {book.title}
                              </button>
                            ) : (
                              <span className="font-semibold text-foreground">Book</span>
                            )}
                            <ChapterPosChip
                              testIdKey={`lex-${enc.note.slug}`}
                              chapter={enc.note.meta?.chapter}
                              pos={enc.note.pos}
                              posUnit={book?.posUnit || 'page'}
                            />
                          </div>

                          <button
                            type="button"
                            data-testid={`lexicon-open-note-${enc.note.slug}`}
                            onClick={() => navigateTo(`#/note/${encodeURIComponent(enc.note.slug)}`)}
                            className="text-label font-medium text-muted-foreground hover:text-foreground whitespace-nowrap"
                          >
                            Open note ↗
                          </button>
                        </div>

                        {enc.quote && (
                          <blockquote className="pl-3 border-l-2 border-border italic text-body text-muted-foreground">
                            &ldquo;{enc.quote}&rdquo;
                          </blockquote>
                        )}
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <PromptFallbackModal {...fallbackModalProps} />
    </div>
  );
};
