import React, { useMemo } from 'react';
import { ChevronRight, Copy, Lock } from 'lucide-react';
import type { Book, Note, ReadingSession } from '../../types/pragya';
import { useCopyPrompt } from '../../hooks/useCopyPrompt';
import { isArchived } from '../../utils/archive';
import { bookSessionsNewestFirst, sessionDateLabel } from '../../utils/bookSurfaces';
import { getBookMetaString, getBookReadingQuestions } from '../../utils/metaCodecs';
import {
  REENTRY_COPY_SUCCESS_MESSAGE,
  buildReEntryPrompt,
} from '../../utils/readingMomentum';
import { getLocalDateString } from '../../utils/sessionCoalesce';
import { formatPosDisplay, isNoteSpoiler, isSealedPrediction } from '../../utils/spoilerMath';
import { PromptFallbackModal } from './PromptFallbackModal';
import { BTN_SECONDARY, EYEBROW } from './uiClasses';

export interface BookReEntrySectionProps {
  book: Book;
  notes: readonly Note[];
  sessions: readonly ReadingSession[];
}

/**
 * v2: compact collapsible "Pick Back Up" re-entry briefing for reading/paused books,
 * paired with a zero-AI Copy Re-Entry Prompt button and PromptFallbackModal.
 */
export const BookReEntrySection: React.FC<BookReEntrySectionProps> = ({
  book,
  notes,
  sessions,
}) => {
  const { copyPrompt, fallbackModalProps } = useCopyPrompt({
    successMessage: REENTRY_COPY_SUCCESS_MESSAGE,
    fallbackTitle: 'Copy Re-Entry Prompt',
    fallbackTestId: 'reentry-prompt-fallback-modal',
    fallbackPromptLabel: 'Re-entry prompt',
  });

  const latestSession = useMemo(
    () => bookSessionsNewestFirst([...sessions], book.id)[0] || null,
    [book.id, sessions]
  );

  const recentNotes = useMemo(
    () =>
      notes
        .filter(
          n =>
            n.bookId === book.id &&
            !isArchived(n) &&
            !isNoteSpoiler(n, book) &&
            !isSealedPrediction(n, book) &&
            Boolean(n.takeaway?.trim() || n.quote?.trim())
        )
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, 2),
    [book, notes]
  );

  const sealedPredictionCount = useMemo(
    () =>
      notes.filter(n => n.bookId === book.id && !isArchived(n) && isSealedPrediction(n, book))
        .length,
    [book, notes]
  );

  const openQuestions = useMemo(
    () => getBookReadingQuestions(book.meta).filter(q => q.status === 'open'),
    [book.meta]
  );

  if (book.status !== 'reading' && book.status !== 'paused') {
    return null;
  }

  const pauseNote = getBookMetaString(book.meta, 'pauseNote');
  const today = getLocalDateString();

  return (
    <>
      <details
        data-testid="book-reentry-section"
        className="print:hidden group bg-card border border-border rounded-[14px] p-4"
      >
        <summary className="min-h-11 sm:min-h-0 flex items-center justify-between gap-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span className={EYEBROW}>Pick Back Up</span>
            {latestSession && (
              <span className="text-label text-muted-foreground num">
                · Last read {sessionDateLabel(latestSession.date, today)}
              </span>
            )}
          </div>
          <ChevronRight
            className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-90 shrink-0"
            aria-hidden="true"
          />
        </summary>

        <div className="mt-3 pt-3 border-t border-border/60 space-y-3">
          {book.status === 'paused' && pauseNote && (
            <p className="text-label text-muted-foreground">
              <strong className="text-foreground font-medium">Paused note:</strong> {pauseNote}
            </p>
          )}

          {latestSession?.note && (
            <p className="text-label text-muted-foreground">
              <strong className="text-foreground font-medium">Last session:</strong>{' '}
              {latestSession.note}
            </p>
          )}

          {recentNotes.length > 0 && (
            <ul className="space-y-1.5 text-label text-muted-foreground">
              {recentNotes.map(n => (
                <li key={n.id} className="line-clamp-2">
                  <span className="num text-foreground font-medium">
                    {formatPosDisplay(Number(n.pos) || 0, book.posUnit)}:
                  </span>{' '}
                  {n.takeaway || n.quote}
                </li>
              ))}
            </ul>
          )}

          {openQuestions.length > 0 && (
            <p className="text-label text-muted-foreground">
              <strong className="text-foreground font-medium">Open question:</strong>{' '}
              {openQuestions[0].question}
              {openQuestions.length > 1 ? ` (+${openQuestions.length - 1} more)` : ''}
            </p>
          )}

          {sealedPredictionCount > 0 && (
            <p className="inline-flex items-center gap-1.5 text-label text-muted-foreground num">
              <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>
                {sealedPredictionCount}{' '}
                {sealedPredictionCount === 1 ? 'sealed prediction' : 'sealed predictions'} waiting
                until you finish
              </span>
            </p>
          )}

          <div>
            <button
              type="button"
              data-testid="copy-reentry-prompt-btn"
              onClick={() => void copyPrompt(buildReEntryPrompt(book, notes, sessions))}
              className={BTN_SECONDARY}
            >
              <Copy className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Copy Re-Entry Prompt</span>
            </button>
          </div>
        </div>
      </details>

      <PromptFallbackModal {...fallbackModalProps} />
    </>
  );
};
