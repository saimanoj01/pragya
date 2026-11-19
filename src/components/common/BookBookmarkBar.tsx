import React, { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Plus, RotateCcw } from 'lucide-react';
import type { Book } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { describeSyncError } from '../../utils/apiErrors';
import { isArchived } from '../../utils/archive';
import { sessionDateLabel } from '../../utils/bookSurfaces';
import { getLocalDateString } from '../../utils/sessionCoalesce';
import { formatPosDisplay, getQuickAdvanceSpec } from '../../utils/spoilerMath';
import { showToast } from '../../utils/toast';
import { ConfirmDialog } from './ConfirmDialog';
import { SessionNoteEditor } from './SessionsTrail';
import { BTN_TERTIARY } from './uiClasses';

export interface BookBookmarkBarProps {
  book: Book;
  hasCapstone: boolean;
  capstoneHidden: boolean;
  onOpenCapstone: () => void;
}

/**
 * Bookmark advance controls (+N, exact position, manual override, post-advance session note),
 * Mark as Finished (+ Undo), and Read Again (+ confirm) extracted from BookDetailView.
 */
export const BookBookmarkBar: React.FC<BookBookmarkBarProps> = ({
  book,
  hasCapstone,
  capstoneHidden,
  onOpenCapstone,
}) => {
  const {
    sessions,
    advanceBookPosition,
    revertBookmarkAdvance,
    markBookFinished,
    restoreBook,
    startReread,
  } = usePragya();

  const [exactInput, setExactInput] = useState(String(book.currentPos));
  const [manualOverride, setManualOverride] = useState(false);
  const [postAdvanceSessionId, setPostAdvanceSessionId] = useState<string | null>(null);
  const [postAdvanceEditing, setPostAdvanceEditing] = useState(false);
  const [rereadConfirmOpen, setRereadConfirmOpen] = useState(false);
  const [rereadBusy, setRereadBusy] = useState(false);

  useEffect(() => {
    setExactInput(String(book.currentPos));
  }, [book.currentPos, book.id]);

  useEffect(() => {
    setPostAdvanceSessionId(null);
    setPostAdvanceEditing(false);
  }, [book.id]);

  const { step, label: stepLabel } = getQuickAdvanceSpec(book.posUnit);
  const postAdvanceSession = postAdvanceSessionId
    ? sessions.find(sx => sx.id === postAdvanceSessionId) || null
    : null;

  const announceAdvanceSuccess = (
    nextCurrentPos: number,
    sessionId: string | undefined,
    undo: Parameters<typeof revertBookmarkAdvance>[0] | undefined
  ) => {
    setExactInput(String(nextCurrentPos));
    setPostAdvanceSessionId(sessionId || null);
    setPostAdvanceEditing(false);
    showToast(
      `Updated "${book.title}" to ${formatPosDisplay(nextCurrentPos, book.posUnit)}`,
      'success',
      undo
        ? {
            id: `bookmark-undo-${book.id}`,
            action: {
              label: 'Undo',
              testId: 'toast-undo-btn',
              onClick: () => {
                void revertBookmarkAdvance(undo)
                  .then(() => showToast('Reverted bookmark update', 'info'))
                  .catch(err =>
                    showToast(describeSyncError(err, 'Failed to undo bookmark update'), 'error')
                  );
              },
            },
          }
        : undefined
    );
  };

  const handleAdvanceStep = async () => {
    const maxPos =
      book.totalPos > 0
        ? book.totalPos
        : book.posUnit === 'percent'
          ? 100
          : Number.POSITIVE_INFINITY;
    const nextPos = Number.isFinite(maxPos)
      ? Math.min(maxPos, book.currentPos + step)
      : book.currentPos + step;
    try {
      const res = await advanceBookPosition(book.id, nextPos);
      if (res.changed) {
        announceAdvanceSuccess(res.book.currentPos, res.sessionId, res.undo);
      }
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to update position'), 'error');
    }
  };

  const handleAdvanceExact = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(exactInput);
    if (!Number.isFinite(parsed) || parsed < 0) {
      showToast('Enter a valid reading position', 'error');
      return;
    }
    try {
      const res = await advanceBookPosition(book.id, parsed, { manualOverride });
      if (res.rejectedBackward) {
        showToast(
          'Monotonic guard: check "Manual Bookmark Reset / Override" to move bookmark backward.',
          'error'
        );
        setExactInput(String(book.currentPos));
        return;
      }
      if (res.changed) {
        announceAdvanceSuccess(res.book.currentPos, res.sessionId, res.undo);
      }
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to update position'), 'error');
    }
  };

  const handleMarkFinished = async () => {
    const prevBook = book;
    try {
      const finished = await markBookFinished(book.id);
      showToast(`"${book.title}" marked finished — predictions unlocked!`, 'success', {
        action: {
          label: 'Undo',
          testId: 'toast-undo-btn',
          onClick: () => {
            void restoreBook(prevBook, { expectedBaseUpdatedAt: finished?.meta?.updatedAt })
              .then(() => showToast(`Restored "${prevBook.title}" to ${prevBook.status}`, 'info'))
              .catch(err =>
                showToast(describeSyncError(err, 'Failed to undo mark finished'), 'error')
              );
          },
        },
      });
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to mark finished'), 'error');
    }
  };

  const handleStartReread = async () => {
    setRereadBusy(true);
    try {
      await startReread(book.id);
      setRereadConfirmOpen(false);
      showToast(`Re-reading "${book.title}".`, 'info');
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to start re-read'), 'error');
    } finally {
      setRereadBusy(false);
    }
  };

  return (
    <>
      <div className="pt-3 border-t border-border/60 flex flex-col lg:flex-row lg:items-center justify-between gap-3 print:pt-2">
        <div className="print:hidden space-y-2">
          <form
            onSubmit={e => void handleAdvanceExact(e)}
            className="flex flex-wrap items-center gap-2"
          >
            <button
              type="button"
              data-testid={`advance-10p-btn-${book.id}`}
              onClick={() => void handleAdvanceStep()}
              className="h-11 sm:h-9 px-3 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-semibold text-foreground num whitespace-nowrap"
            >
              {stepLabel}
            </button>

            <input
              type="number"
              min="0"
              inputMode="numeric"
              enterKeyHint="done"
              data-testid="book-detail-advance-input"
              value={exactInput}
              onFocus={e => e.currentTarget.select()}
              onChange={e => setExactInput(e.target.value)}
              aria-label="Exact reading position"
              className="w-24 h-11 sm:h-9 px-3 rounded-[8px] bg-background border border-input text-base sm:text-label text-foreground num focus:outline-none focus:ring-2 focus:ring-ring/40"
            />

            <button
              type="submit"
              data-testid="book-detail-advance-btn"
              className="h-11 sm:h-9 px-3.5 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-semibold text-foreground inline-flex items-center gap-1 whitespace-nowrap"
            >
              <span>Advance</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </form>

          <label className="min-h-11 sm:min-h-0 inline-flex items-center gap-2 text-label text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="manual-pos-override-checkbox"
              checked={manualOverride}
              onChange={e => setManualOverride(e.target.checked)}
              className="w-4 h-4 rounded border-input accent-primary"
            />
            <span>Manual Bookmark Reset / Override</span>
          </label>

          {postAdvanceSession &&
            (postAdvanceEditing ? (
              <SessionNoteEditor
                session={postAdvanceSession}
                dateLabel={sessionDateLabel(postAdvanceSession.date, getLocalDateString())}
                onDone={() => {
                  setPostAdvanceEditing(false);
                  setPostAdvanceSessionId(null);
                }}
              />
            ) : (
              <button
                type="button"
                data-testid="post-advance-session-note-btn"
                onClick={() => setPostAdvanceEditing(true)}
                className={BTN_TERTIARY}
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Add a note to this session</span>
              </button>
            ))}
        </div>

        {book.status !== 'finished' ? (
          <button
            type="button"
            data-testid="mark-finished-btn"
            onClick={() => void handleMarkFinished()}
            className="print:hidden h-11 sm:h-9 px-4 rounded-[10px] bg-positive/15 hover:bg-positive/25 border border-positive/30 text-label font-semibold text-positive inline-flex items-center gap-1.5 whitespace-nowrap self-start lg:self-center"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>Mark as Finished</span>
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center gap-1.5 text-label font-medium text-positive">
              <CheckCircle2 className="w-4 h-4" />
              <span>
                Finished{book.meta.finishedAt ? ` · ${book.meta.finishedAt.slice(0, 10)}` : ''}
              </span>
            </div>
            {!isArchived(book) && (
              <button
                type="button"
                data-testid="read-again-btn"
                onClick={() => setRereadConfirmOpen(true)}
                className={BTN_TERTIARY}
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Read Again</span>
              </button>
            )}
            {!hasCapstone && capstoneHidden && (
              <button
                type="button"
                data-testid="capstone-add-link"
                onClick={onOpenCapstone}
                className={BTN_TERTIARY}
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Add Whole-Book Picture</span>
              </button>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={rereadConfirmOpen}
        tone="default"
        title={`Start "${book.title}" again?`}
        body="Your bookmark moves back to the start. Your notes, Whole-Book Picture, and finish date are kept."
        confirmLabel="Start Re-read"
        busy={rereadBusy}
        onCancel={() => setRereadConfirmOpen(false)}
        onConfirm={() => void handleStartReread()}
      />
    </>
  );
};
