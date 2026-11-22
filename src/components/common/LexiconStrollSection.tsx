import React, { useState } from 'react';
import { BookOpenText, CheckCircle2, Sparkles } from 'lucide-react';
import { usePragyaActions } from '../../context/PragyaContext';
import type { Book, Note } from '../../types/pragya';
import { getLexiconStrollStatus } from '../../utils/lexicon';
import { navigateTo } from '../../utils/navigation';
import { showToast } from '../../utils/toast';
import { ChapterPosChip } from './ChapterPosChip';
import { BTN_SECONDARY } from './uiClasses';

export interface LexiconStrollSectionProps {
  notes: Note[];
  books: Book[];
  todayDate: string;
}

/**
 * Calm daily vocabulary stroll inside Practice (PRD D9):
 * 1-2 tap-to-reveal cards per day, eligible after >= 1 day, spoiler-shielded,
 * zero scores/streaks/counts.
 */
export const LexiconStrollSection: React.FC<LexiconStrollSectionProps> = ({
  notes,
  books,
  todayDate,
}) => {
  const { updateNote } = usePragyaActions();
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());

  const status = getLexiconStrollStatus(notes, books, todayDate, 2);

  // If the user has zero non-archived unshielded word notes at all, keep Practice calm & uncluttered.
  if (status.totalPoolCount === 0 && status.freshTodayCount === 0) {
    return null;
  }

  const toggleReveal = (noteId: string) => {
    setRevealedIds(prev => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  };

  const handleMarkRevisited = async (note: Note) => {
    const prevReviewedAt = note.meta?.lastReviewedAt;
    const nowIso = new Date().toISOString();
    try {
      await updateNote(
        {
          ...note,
          meta: {
            ...note.meta,
            lastReviewedAt: nowIso,
          },
        },
        {
          preserveUpdatedAt: true,
          expectedBaseUpdatedAt: note.updatedAt,
          ownedMetaKeys: ['lastReviewedAt'],
        }
      );

      showToast('Marked word revisited', 'info', {
        id: `lexicon-revisit-${note.id}`,
        duration: 6000,
        action: {
          label: 'Undo',
          testId: 'toast-undo-btn',
          onClick: () => {
            const nextMeta = { ...note.meta };
            if (prevReviewedAt) {
              nextMeta.lastReviewedAt = prevReviewedAt;
            } else {
              delete nextMeta.lastReviewedAt;
            }
            void updateNote(
              { ...note, meta: nextMeta },
              {
                preserveUpdatedAt: true,
                expectedBaseUpdatedAt: note.updatedAt,
                ownedMetaKeys: ['lastReviewedAt'],
              }
            );
          },
        },
      });
    } catch {
      showToast('Could not mark word revisited right now', 'error');
    }
  };

  return (
    <section data-testid="lexicon-stroll-section" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-eyebrow uppercase text-muted-foreground tracking-wider">
          <BookOpenText className="w-3.5 h-3.5" />
          <span>Lexicon Stroll</span>
        </div>
        <a
          href="#/lexicon"
          onClick={e => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            navigateTo('#/lexicon');
          }}
          className="text-label font-medium text-muted-foreground hover:text-foreground"
        >
          Open Lexicon →
        </a>
      </div>

      {status.items.length === 0 ? (
        <div className="bg-card border border-border rounded-[14px] p-5 text-body text-muted-foreground">
          {status.reviewedTodayCount > 0 && status.totalPoolCount <= status.reviewedTodayCount
            ? 'All saved words revisited for today.'
            : 'Words captured today settle in tomorrow for a quiet stroll.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {status.items.map(pick => {
            const { note, book, displayLexicon } = pick;
            const revealed = revealedIds.has(note.id);
            const hasRecallDetail = Boolean(
              displayLexicon.definition || displayLexicon.etymology || displayLexicon.transferExample
            );

            return (
              <article
                key={note.id}
                data-testid={`stroll-card-${note.slug}`}
                className="bg-card border border-border rounded-[14px] p-4 flex flex-col justify-between gap-3"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2 text-label text-muted-foreground">
                    <span className="truncate font-medium text-foreground">{book.title}</span>
                    <ChapterPosChip
                      testIdKey={`stroll-${note.slug}`}
                      chapter={note.meta?.chapter}
                      pos={note.pos}
                      posUnit={book.posUnit}
                      className="shrink-0"
                    />
                  </div>

                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className="text-title text-foreground font-semibold">
                      {displayLexicon.word}
                    </h3>
                    {displayLexicon.partOfSpeech && (
                      <span className="text-label text-muted-foreground">
                        {displayLexicon.partOfSpeech}
                      </span>
                    )}
                    {displayLexicon.pronunciation && (
                      <span className="text-label font-mono text-muted-foreground">
                        {displayLexicon.pronunciation}
                      </span>
                    )}
                  </div>

                  {note.quote && (
                    <blockquote className="pl-2.5 border-l-2 border-border italic text-label text-muted-foreground">
                      &ldquo;{note.quote}&rdquo;
                    </blockquote>
                  )}

                  {hasRecallDetail && (
                    revealed ? (
                      <div
                        data-testid={`stroll-revealed-${note.slug}`}
                        className="rounded-[10px] bg-surface2/60 border border-border/70 p-3 space-y-1.5 text-body text-foreground"
                      >
                        {displayLexicon.definition && <p>{displayLexicon.definition}</p>}
                        {displayLexicon.etymology && (
                          <p className="text-label text-muted-foreground">
                            <span className="font-semibold text-foreground/80">Origin:</span>{' '}
                            {displayLexicon.etymology}
                          </p>
                        )}
                        {displayLexicon.transferExample && (
                          <p className="text-label text-foreground/90 italic">
                            &ldquo;{displayLexicon.transferExample}&rdquo;
                          </p>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-testid={`stroll-reveal-btn-${note.slug}`}
                        onClick={() => toggleReveal(note.id)}
                        className={BTN_SECONDARY}
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Reveal meaning</span>
                      </button>
                    )
                  )}
                </div>

                <div className="pt-2 border-t border-border/50 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      navigateTo(
                        `#/book/${encodeURIComponent(book.id)}?note=${encodeURIComponent(note.id)}`
                      )
                    }
                    className="min-h-11 sm:min-h-0 text-label text-muted-foreground hover:text-foreground"
                  >
                    In book ↗
                  </button>

                  <button
                    type="button"
                    data-testid={`stroll-revisit-btn-${note.slug}`}
                    onClick={() => void handleMarkRevisited(note)}
                    className="h-11 sm:h-8 px-3 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-semibold text-foreground inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-positive" />
                    <span>Mark revisited</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};
