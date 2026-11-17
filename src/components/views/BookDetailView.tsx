import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  Link2,
  Lock,
  Plus,
  Sparkles,
  Unlock,
} from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { isEditableElement } from '../../hooks/useKeyboardShortcuts';
import { getRenderableAttachments } from '../../utils/metaCodecs';
import { isSafeHttpUrl, navigateTo } from '../../utils/navigation';
import {
  computePercentDisplay,
  formatPosDisplay,
  getQuickAdvanceSpec,
  isNoteSpoiler,
  isSealedPrediction,
  isUnlockedPrediction,
} from '../../utils/spoilerMath';
import { showToast } from '../../utils/toast';
import { DriveImage } from '../common/DriveImage';

export interface BookDetailViewProps {
  bookId: string;
  onEditBook: (book: Book) => void;
  onOpenCaptureForBook: (bookId: string) => void;
}

export const BookDetailView: React.FC<BookDetailViewProps> = ({
  bookId,
  onEditBook,
  onOpenCaptureForBook,
}) => {
  const { books, notes, advanceBookPosition, revertBookmarkAdvance, markBookFinished, restoreBook } =
    usePragya();

  const book = useMemo(() => books.find(b => b.id === bookId) || null, [books, bookId]);
  const bookNotes = useMemo(
    () =>
      notes
        .filter(n => n.bookId === bookId)
        .sort((a, b) => a.pos - b.pos || a.createdAt.localeCompare(b.createdAt)),
    [bookId, notes]
  );

  const [exactInput, setExactInput] = useState<string>('');
  const [manualOverride, setManualOverride] = useState<boolean>(false);
  const [revealedSlugs, setRevealedSlugs] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState<number>(0);

  useEffect(() => {
    setExactInput(book ? String(book.currentPos) : '0');
  }, [book]);

  useEffect(() => {
    setFocusedIndex(0);
  }, [bookId]);

  const revealSlug = (slug: string) => {
    setRevealedSlugs(prev => {
      const next = new Set(prev);
      next.add(slug);
      return next;
    });
  };

  useEffect(() => {
    if (!book) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"]') || document.querySelector('[data-popover="true"]')) {
        return;
      }
      if (isEditableElement(e.target)) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest('button, a, [role="button"]')) return;

      const key = e.key.toLowerCase();
      if (key === 'e') {
        e.preventDefault();
        onEditBook(book);
        return;
      }
      if (key === 'o' && isSafeHttpUrl(book.docUrl)) {
        e.preventDefault();
        window.open(book.docUrl.trim(), '_blank', 'noopener,noreferrer');
        return;
      }

      if (bookNotes.length === 0) return;

      if (key === 'j') {
        e.preventDefault();
        setFocusedIndex(prev => Math.min(bookNotes.length - 1, prev + 1));
      } else if (key === 'k') {
        e.preventDefault();
        setFocusedIndex(prev => Math.max(0, prev - 1));
      } else if (e.key === ' ') {
        const active = bookNotes[focusedIndex];
        if (active && isNoteSpoiler(active, book) && !revealedSlugs.has(active.slug)) {
          e.preventDefault();
          revealSlug(active.slug);
        }
      } else if (e.key === 'Enter') {
        const active = bookNotes[focusedIndex];
        if (active) {
          e.preventDefault();
          navigateTo(`#/note/${encodeURIComponent(active.slug)}`);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [book, bookNotes, focusedIndex, onEditBook, revealedSlugs]);

  if (!book) {
    return (
      <div data-testid="book-detail-view" className="py-8 space-y-4">
        <button
          type="button"
          data-testid="back-to-shelf-btn"
          onClick={() => navigateTo('#/shelf')}
          className="inline-flex items-center gap-1.5 text-label text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Shelf</span>
        </button>
        <div className="bg-card border border-border rounded-[14px] p-6 text-body text-muted-foreground">
          Book not found.
        </div>
      </div>
    );
  }

  const pct = computePercentDisplay(book);
  const { step, label: stepLabel } = getQuickAdvanceSpec(book.posUnit);

  const handleAdvance10 = async () => {
    const maxPos =
      book.totalPos > 0 ? book.totalPos : book.posUnit === 'percent' ? 100 : Number.POSITIVE_INFINITY;
    const nextPos = Number.isFinite(maxPos)
      ? Math.min(maxPos, book.currentPos + step)
      : book.currentPos + step;
    try {
      const res = await advanceBookPosition(book.id, nextPos);
      if (res.changed) {
        setExactInput(String(res.book.currentPos));
        showToast(
          `Updated "${book.title}" to ${formatPosDisplay(res.book.currentPos, book.posUnit)}`,
          'success',
          res.undo
            ? {
                id: `bookmark-undo-${book.id}`,
                action: {
                  label: 'Undo',
                  testId: 'toast-undo-btn',
                  onClick: () => {
                    void revertBookmarkAdvance(res.undo!)
                      .then(() => showToast('Reverted bookmark update', 'info'))
                      .catch(err =>
                        showToast(
                          err instanceof Error ? err.message : 'Failed to undo bookmark update',
                          'error'
                        )
                      );
                  },
                },
              }
            : undefined
        );
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update position', 'error');
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
        setExactInput(String(res.book.currentPos));
        showToast(
          `Updated "${book.title}" to ${formatPosDisplay(res.book.currentPos, book.posUnit)}`,
          'success',
          res.undo
            ? {
                id: `bookmark-undo-${book.id}`,
                action: {
                  label: 'Undo',
                  testId: 'toast-undo-btn',
                  onClick: () => {
                    void revertBookmarkAdvance(res.undo!)
                      .then(() => showToast('Reverted bookmark update', 'info'))
                      .catch(err =>
                        showToast(
                          err instanceof Error ? err.message : 'Failed to undo bookmark update',
                          'error'
                        )
                      );
                  },
                },
              }
            : undefined
        );
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update position', 'error');
    }
  };

  const handleMarkFinished = async () => {
    const prevBook = book;
    try {
      await markBookFinished(book.id);
      showToast(`"${book.title}" marked finished — predictions unlocked!`, 'success', {
        action: {
          label: 'Undo',
          testId: 'toast-undo-btn',
          onClick: () => {
            void restoreBook(prevBook)
              .then(() => showToast(`Restored "${prevBook.title}" to ${prevBook.status}`, 'info'))
              .catch(err =>
                showToast(
                  err instanceof Error ? err.message : 'Failed to undo mark finished',
                  'error'
                )
              );
          },
        },
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to mark finished', 'error');
    }
  };

  const renderNoteBadge = (note: Note) => {
    if (isSealedPrediction(note, book)) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-surface2 border border-border text-foreground">
          <Lock className="w-3 h-3" />
          <span>Sealed Prediction</span>
        </span>
      );
    }
    if (isUnlockedPrediction(note, book)) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-positive/15 border border-positive/30 text-positive">
          <Unlock className="w-3 h-3" />
          <span>Unlocked Prediction</span>
        </span>
      );
    }
    if (note.status === 'inbox') {
      return (
        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-warning/15 border border-warning/30 text-warning">
          Inbox
        </span>
      );
    }
    if (note.status === 'in-reflection') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-warning/15 border border-warning/30 text-warning">
          <Sparkles className="w-3 h-3" />
          <span>In Reflection</span>
        </span>
      );
    }
    if (note.status === 'atomic') {
      return (
        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-positive/15 border border-positive/30 text-positive">
          Atomic
        </span>
      );
    }
    return null;
  };

  return (
    <div data-testid="book-detail-view" className="py-6 space-y-6">
      <button
        type="button"
        data-testid="back-to-shelf-btn"
        onClick={() => navigateTo('#/shelf')}
        className="inline-flex items-center gap-1.5 text-label text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Shelf</span>
      </button>

      {/* Book Header Card */}
      <section className="bg-card border border-border rounded-[14px] p-5 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-surface2 border border-border text-muted-foreground">
                {book.format}
              </span>
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-surface2 border border-border text-muted-foreground">
                {book.kind}
              </span>
              <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded-md bg-surface2 border border-border text-foreground">
                {book.status}
              </span>
            </div>
            <h1 className="text-display-l text-foreground tracking-tight">{book.title}</h1>
            <p className="text-body text-muted-foreground">by {book.author}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {isSafeHttpUrl(book.docUrl) && (
              <a
                href={book.docUrl.trim()}
                target="_blank"
                rel="noopener noreferrer"
                className="h-9 px-3 rounded-[10px] bg-surface2 border border-border text-label font-medium text-foreground hover:bg-secondary inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <span>Book Doc</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            <button
              type="button"
              onClick={() => onEditBook(book)}
              className="h-9 px-3 rounded-[10px] bg-surface2 border border-border text-label font-medium text-foreground hover:bg-secondary inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Edit</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenCaptureForBook(book.id)}
              className="h-9 px-3.5 rounded-[10px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Note</span>
            </button>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-label num">
            <span className="font-medium text-foreground">
              {formatPosDisplay(book.currentPos, book.posUnit)}
              {book.totalPos > 0 ? ` / ${book.totalPos}` : ''}
            </span>
            <span className="text-muted-foreground">{pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-surface2 overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Monotonic / Override Bookmark Controls & Mark Finished */}
        <div className="pt-3 border-t border-border/60 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="space-y-2">
            <form
              onSubmit={e => void handleAdvanceExact(e)}
              className="flex flex-wrap items-center gap-2"
            >
              <button
                type="button"
                data-testid={`advance-10p-btn-${book.id}`}
                onClick={() => void handleAdvance10()}
                className="h-11 sm:h-9 px-3 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-semibold text-foreground num whitespace-nowrap"
              >
                {stepLabel}
              </button>

              <input
                type="number"
                min="0"
                data-testid="book-detail-advance-input"
                value={exactInput}
                onFocus={e => e.currentTarget.select()}
                onChange={e => setExactInput(e.target.value)}
                aria-label="Exact reading position"
                className="w-24 h-11 sm:h-9 px-3 rounded-[8px] bg-background border border-input text-label text-foreground num focus:outline-none focus:ring-2 focus:ring-ring/40"
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

            <label className="inline-flex items-center gap-2 text-label text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="manual-pos-override-checkbox"
                checked={manualOverride}
                onChange={e => setManualOverride(e.target.checked)}
                className="w-4 h-4 rounded border-input accent-primary"
              />
              <span>Manual Bookmark Reset / Override</span>
            </label>
          </div>

          {book.status !== 'finished' ? (
            <button
              type="button"
              data-testid="mark-finished-btn"
              onClick={() => void handleMarkFinished()}
              className="h-9 px-4 rounded-[10px] bg-positive/15 hover:bg-positive/25 border border-positive/30 text-label font-semibold text-positive inline-flex items-center gap-1.5 whitespace-nowrap self-start lg:self-center"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Mark as Finished</span>
            </button>
          ) : (
            <div className="inline-flex items-center gap-1.5 text-label font-medium text-positive">
              <CheckCircle2 className="w-4 h-4" />
              <span>Finished{book.meta.finishedAt ? ` · ${book.meta.finishedAt.slice(0, 10)}` : ''}</span>
            </div>
          )}
        </div>
      </section>

      {/* Book Notes */}
      <section className="space-y-3">
        <h2 className="text-heading text-foreground num">
          Captured Notes ({bookNotes.length})
        </h2>

        {bookNotes.length === 0 ? (
          <div className="bg-card border border-border rounded-[14px] p-6 text-center text-body text-muted-foreground">
            No notes captured for this book yet.
          </div>
        ) : (
          <div className="space-y-3">
            {bookNotes.map((note, idx) => {
              const spoiler = isNoteSpoiler(note, book) && !revealedSlugs.has(note.slug);
              const isFocused = idx === focusedIndex;
              const attachments = getRenderableAttachments(note.meta);

              return (
                <article
                  key={note.id}
                  data-testid={`note-card-${note.slug}`}
                  data-focused={isFocused ? 'true' : undefined}
                  className={`bg-card border rounded-[14px] p-4 space-y-2.5 transition-colors ${
                    isFocused ? 'border-foreground/40 ring-1 ring-ring/40' : 'border-border'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-label text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="num font-medium text-foreground">
                        {formatPosDisplay(note.pos, book.posUnit)}
                      </span>
                      {renderNoteBadge(note)}
                    </div>
                    <button
                      type="button"
                      onClick={() => navigateTo(`#/note/${encodeURIComponent(note.slug)}`)}
                      className="font-semibold text-foreground hover:underline whitespace-nowrap"
                    >
                      View Note ↗
                    </button>
                  </div>

                  {spoiler ? (
                    <div
                      data-testid={`spoiler-shield-${note.slug}`}
                      className="rounded-[10px] bg-surface2/70 border border-border p-4 text-center space-y-2"
                    >
                      <div className="inline-flex items-center gap-1.5 text-label font-semibold text-foreground">
                        <AlertTriangle className="w-4 h-4 text-warning" />
                        <span>Spoiler Shield (pos {note.pos} &gt; {book.currentPos})</span>
                      </div>
                      <div>
                        <button
                          type="button"
                          data-testid={`spoiler-reveal-btn-${note.slug}`}
                          onClick={() => revealSlug(note.slug)}
                          className="h-8 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold inline-flex items-center gap-1.5"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Reveal (or Space)</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {note.meta.title && (
                        <h3 className="text-heading text-foreground">{note.meta.title}</h3>
                      )}
                      {note.quote && (
                        <blockquote className="pl-3 border-l-2 border-border italic text-body text-muted-foreground">
                          &ldquo;{note.quote}&rdquo;
                        </blockquote>
                      )}
                      {note.takeaway && <p className="text-body text-foreground">{note.takeaway}</p>}
                      {attachments.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {attachments.map(att =>
                            att.type === 'image' ? (
                              <DriveImage
                                key={att.id}
                                attachment={att}
                                className="w-14 h-14 rounded-[8px] object-cover border border-border"
                              />
                            ) : isSafeHttpUrl(att.url) ? (
                              <a
                                key={att.id}
                                href={att.url.trim()}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-surface2 border border-border text-label text-foreground hover:bg-secondary"
                              >
                                {att.type === 'doc' ? (
                                  <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                                ) : (
                                  <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
                                )}
                                <span className="truncate max-w-[160px]">{att.title}</span>
                              </a>
                            ) : (
                              <span
                                key={att.id}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-surface2 border border-border text-label text-muted-foreground"
                              >
                                <Link2 className="w-3.5 h-3.5" />
                                <span className="truncate max-w-[160px]">{att.title}</span>
                              </span>
                            )
                          )}
                        </div>
                      )}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
