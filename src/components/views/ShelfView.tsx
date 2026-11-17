import React, { useMemo, useState } from 'react';
import {
  Calendar,
  Edit3,
  ExternalLink,
  Plus,
  ArrowRight,
  CheckCircle2,
  Play,
} from 'lucide-react';
import type { Book } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { isSafeHttpUrl, navigateTo } from '../../utils/navigation';
import { getLocalDateString } from '../../utils/sessionCoalesce';
import {
  computePercentDisplay,
  formatPosDisplay,
  getQuickAdvanceSpec,
  isNoteSpoiler,
} from '../../utils/spoilerMath';
import { showToast } from '../../utils/toast';
import { describeSyncError } from '../../utils/apiErrors';
import { normalizeChapterInput } from '../../utils/chapterFormat';

export interface ShelfViewProps {
  onOpenAddBook: () => void;
  onEditBook: (book: Book) => void;
  onOpenCaptureForBook: (bookId: string) => void;
}

export const ShelfView: React.FC<ShelfViewProps> = ({
  onOpenAddBook,
  onEditBook,
  onOpenCaptureForBook,
}) => {
  const { books, notes, sessions, advanceBookPosition, revertBookmarkAdvance, startReadingBook } =
    usePragya();
  const [exactInputs, setExactInputs] = useState<Record<string, string>>({});

  const readingBooks = useMemo(() => books.filter(b => b.status === 'reading'), [books]);
  const queuedBooks = useMemo(() => books.filter(b => b.status === 'queued'), [books]);
  const finishedBooks = useMemo(() => books.filter(b => b.status === 'finished'), [books]);
  const pausedBooks = useMemo(() => books.filter(b => b.status === 'paused'), [books]);

  // Build 30-day activity array (index 0 = 29 days ago, index 29 = today)
  const activityDays = useMemo(() => {
    const countsByDate = new Map<string, number>();
    for (const s of sessions) {
      countsByDate.set(s.date, (countsByDate.get(s.date) || 0) + 1);
    }
    const today = new Date();
    const list: Array<{ date: string; count: number }> = [];
    for (let offset = 29; offset >= 0; offset -= 1) {
      const d = new Date(today);
      d.setDate(d.getDate() - offset);
      const dateStr = getLocalDateString(d);
      list.push({ date: dateStr, count: countsByDate.get(dateStr) || 0 });
    }
    return list;
  }, [sessions]);

  const getReEntryContext = (book: Book) => {
    const bookSessions = sessions
      .filter(s => s.bookId === book.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const lastReadDate =
      bookSessions[0]?.date || book.meta.updatedAt?.slice(0, 10) || getLocalDateString();

    const bookNotes = notes
      .filter(n => n.bookId === book.id && !isNoteSpoiler(n, book))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const latestNote = bookNotes[0];
    const snippet = latestNote
      ? latestNote.takeaway || latestNote.quote || ''
      : bookSessions[0]?.note || 'Ready to pick up where you left off.';

    return { lastReadDate, snippet };
  };

  const clearExactInput = (bookId: string) => {
    setExactInputs(prev => {
      if (!(bookId in prev)) return prev;
      const next = { ...prev };
      delete next[bookId];
      return next;
    });
  };

  const handleAdvance10 = async (book: Book) => {
    const { step } = getQuickAdvanceSpec(book.posUnit);
    const maxPos =
      book.totalPos > 0 ? book.totalPos : book.posUnit === 'percent' ? 100 : Number.POSITIVE_INFINITY;
    const nextPos = Number.isFinite(maxPos)
      ? Math.min(maxPos, book.currentPos + step)
      : book.currentPos + step;
    try {
      const res = await advanceBookPosition(book.id, nextPos);
      if (res.changed) {
        clearExactInput(book.id);
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
                          describeSyncError(err, 'Failed to undo bookmark update'),
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
      showToast(describeSyncError(err, 'Failed to update position'), 'error');
    }
  };

  const handleExactSubmit = async (e: React.FormEvent, book: Book) => {
    e.preventDefault();
    const raw = exactInputs[book.id] ?? String(book.currentPos);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      showToast('Enter a valid position', 'error');
      return;
    }
    try {
      const res = await advanceBookPosition(book.id, parsed);
      if (res.rejectedBackward) {
        showToast(
          'Monotonic guard: use Book Detail Manual Override to move bookmark backward.',
          'error'
        );
        clearExactInput(book.id);
        return;
      }
      if (res.changed) {
        clearExactInput(book.id);
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
                          describeSyncError(err, 'Failed to undo bookmark update'),
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
      showToast(describeSyncError(err, 'Failed to update position'), 'error');
    }
  };

  const handleStartReading = async (bookId: string) => {
    try {
      await startReadingBook(bookId);
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to start reading book'), 'error');
    }
  };

  return (
    <div data-testid="shelf-view" className="py-6 space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display-l text-foreground tracking-tight">Shelf</h1>
          <p className="text-body text-muted-foreground mt-1">
            Your active reading queue and commonplace index.
          </p>
        </div>

        <button
          type="button"
          data-testid="add-book-btn"
          onClick={onOpenAddBook}
          className="h-10 px-4 rounded-full bg-primary text-primary-foreground text-body font-semibold hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
        >
          <span>Add Book</span>
        </button>
      </div>

      {/* 30-Day Reading Activity Card (responsive grid: 15x2 mobile, 30x1 sm+) */}
      <section className="bg-card border border-border rounded-[14px] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-label font-medium text-foreground">
            <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
            <span>Reading Activity (Last 30 Days)</span>
          </div>
          <span
            data-testid="activity-count"
            className="text-label text-muted-foreground num shrink-0"
          >
            {sessions.length} recorded session{sessions.length === 1 ? '' : 's'}
          </span>
        </div>

        <div
          data-testid="activity-dots"
          role="group"
          aria-label="Reading sessions over the last 30 days"
          className="grid grid-cols-15 sm:grid-cols-30 gap-1.5 w-full"
        >
          {activityDays.map((day, idx) => (
            <div
              key={day.date}
              data-testid={`activity-dot-${idx}`}
              role="img"
              aria-label={`${day.date}: ${day.count} session${day.count === 1 ? '' : 's'}`}
              title={`${day.date}: ${day.count} session${day.count === 1 ? '' : 's'}`}
              className={`w-full max-w-[14px] aspect-square rounded-full mx-auto transition-colors ${
                day.count >= 2
                  ? 'bg-foreground/90'
                  : day.count === 1
                    ? 'bg-foreground/50'
                    : 'bg-surface2 border border-border/70'
              }`}
            />
          ))}
        </div>
      </section>

      {/* Now Reading */}
      <section data-testid="now-reading-section" className="space-y-3">
        <h2 className="text-eyebrow uppercase text-muted-foreground tracking-wider">
          Now Reading ({readingBooks.length})
        </h2>

        {readingBooks.length === 0 ? (
          <div
            data-testid="empty-now-reading-cta"
            className="bg-card border border-border rounded-[14px] p-6 text-center space-y-4"
          >
            <p className="text-body text-muted-foreground">
              No active books right now. Add a new book or start reading one from your queue.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                data-testid="empty-shelf-add-book-btn"
                onClick={onOpenAddBook}
                className="h-10 px-4 rounded-full bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 transition-opacity inline-flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Add Book</span>
              </button>
              {[...queuedBooks, ...pausedBooks].slice(0, 3).map(b => (
                <button
                  key={b.id}
                  type="button"
                  data-testid={`empty-shelf-start-${b.id}`}
                  onClick={() => void handleStartReading(b.id)}
                  className="h-10 px-3.5 rounded-full bg-surface2 hover:bg-secondary border border-border text-label font-medium text-foreground inline-flex items-center gap-1.5"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span className="truncate max-w-[180px]">Start {b.title}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {readingBooks.map(book => {
              const pct = computePercentDisplay(book);
              const reEntry = getReEntryContext(book);
              const inputValue = exactInputs[book.id] ?? String(book.currentPos);
              const { label: stepLabel } = getQuickAdvanceSpec(book.posUnit);

              return (
                <article
                  key={book.id}
                  data-testid={`book-card-${book.id}`}
                  className="bg-card border border-border rounded-[14px] p-5 flex flex-col justify-between gap-4"
                >
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-md bg-surface2 border border-border text-muted-foreground">
                          {book.format}
                        </span>
                        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-md bg-surface2 border border-border text-muted-foreground">
                          {book.kind}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => onEditBook(book)}
                        aria-label={`Edit ${book.title}`}
                        className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 sm:p-1.5 rounded-[8px] text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors inline-flex items-center justify-center"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                    </div>

                    <div>
                      <button
                        type="button"
                        onClick={() => navigateTo(`#/book/${encodeURIComponent(book.id)}`)}
                        className="text-left text-title text-foreground hover:underline decoration-border underline-offset-4"
                      >
                        {book.title}
                      </button>
                      <p className="text-body text-muted-foreground mt-0.5">{book.author}</p>
                    </div>

                    {/* Progress */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 min-w-0 text-label num">
                        <span className="flex items-center gap-1.5 min-w-0 text-foreground font-medium">
                          <span className="shrink-0">
                            {formatPosDisplay(book.currentPos, book.posUnit)}
                            {book.totalPos > 0 ? ` / ${book.totalPos}` : ''}
                          </span>
                          {normalizeChapterInput(
                            typeof book.meta?.currentChapter === 'string' ? book.meta.currentChapter : undefined
                          ) && (
                            <>
                              <span aria-hidden="true" className="text-muted-foreground shrink-0">
                                ·
                              </span>
                              <span
                                data-testid={`shelf-chapter-${book.id}`}
                                title={String(book.meta.currentChapter).trim()}
                                className="text-muted-foreground font-normal truncate max-w-[160px] sm:max-w-[220px]"
                              >
                                {String(book.meta.currentChapter).trim()}
                              </span>
                            </>
                          )}
                        </span>
                        <span className="text-muted-foreground shrink-0">{pct}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-surface2 overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-300"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>

                    {/* Re-Entry Context */}
                    <div className="rounded-[10px] bg-surface2/60 border border-border px-3.5 py-2.5 space-y-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground num">
                        Re-Entry Context (Last Read {reEntry.lastReadDate})
                      </div>
                      <p className="text-label text-muted-foreground italic line-clamp-2">
                        &ldquo;{reEntry.snippet}&rdquo;
                      </p>
                    </div>
                  </div>

                  {/* Card Action Bar */}
                  <div className="pt-2 border-t border-border/60 flex flex-wrap items-center justify-between gap-2">
                    <form
                      onSubmit={e => void handleExactSubmit(e, book)}
                      className="flex items-center gap-1.5"
                    >
                      <button
                        type="button"
                        data-testid={`advance-10p-btn-${book.id}`}
                        onClick={() => void handleAdvance10(book)}
                        className="h-11 sm:h-8 px-3 sm:px-2.5 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-semibold text-foreground num transition-colors whitespace-nowrap"
                      >
                        {stepLabel}
                      </button>
                      <input
                        type="number"
                        min="0"
                        data-testid={`advance-exact-input-${book.id}`}
                        value={inputValue}
                        onFocus={e => e.currentTarget.select()}
                        onChange={e =>
                          setExactInputs(prev => ({ ...prev, [book.id]: e.target.value }))
                        }
                        aria-label={`Current position for ${book.title}`}
                        className="w-16 h-11 sm:h-8 px-2 rounded-[8px] bg-background border border-input text-label text-foreground num focus:outline-none focus:ring-2 focus:ring-ring/40"
                      />
                      <button
                        type="submit"
                        data-testid={`advance-exact-btn-${book.id}`}
                        aria-label={`Set position for ${book.title}`}
                        className="w-11 h-11 sm:w-8 sm:h-8 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-foreground inline-flex items-center justify-center transition-colors"
                      >
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </form>

                    <div className="flex items-center gap-2 ml-auto">
                      {isSafeHttpUrl(book.docUrl) && (
                        <a
                          href={book.docUrl.trim()}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="h-11 sm:h-8 px-2.5 rounded-[8px] text-label font-medium text-muted-foreground hover:text-foreground hover:bg-surface2 inline-flex items-center gap-1 transition-colors whitespace-nowrap"
                        >
                          <span>Book Doc</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      <button
                        type="button"
                        data-testid={`book-capture-btn-${book.id}`}
                        onClick={() => onOpenCaptureForBook(book.id)}
                        className="h-11 sm:h-8 px-3.5 sm:px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 transition-opacity inline-flex items-center gap-1 whitespace-nowrap"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Capture</span>
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Queued */}
      {queuedBooks.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-eyebrow uppercase text-muted-foreground tracking-wider">
            Queued ({queuedBooks.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {queuedBooks.map(book => (
              <article
                key={book.id}
                data-testid={`book-card-${book.id}`}
                className="bg-card border border-border rounded-[14px] p-4 flex flex-col justify-between gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <button
                      type="button"
                      onClick={() => navigateTo(`#/book/${encodeURIComponent(book.id)}`)}
                      className="text-left text-heading text-foreground hover:underline"
                    >
                      {book.title}
                    </button>
                    <p className="text-label text-muted-foreground">{book.author}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onEditBook(book)}
                    aria-label={`Edit ${book.title}`}
                    className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 p-2 sm:p-1 flex items-center justify-center rounded-[8px] text-muted-foreground hover:text-foreground hover:bg-surface2"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-border/50 text-label">
                  <span className="text-muted-foreground num">
                    {book.totalPos > 0 ? `${book.totalPos} ${book.posUnit}` : book.format}
                  </span>
                  <button
                    type="button"
                    data-testid={`book-start-btn-${book.id}`}
                    onClick={() => void handleStartReading(book.id)}
                    className="font-semibold text-foreground hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                  >
                    <span>Start Reading →</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Paused */}
      {pausedBooks.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-eyebrow uppercase text-muted-foreground tracking-wider">
            Paused ({pausedBooks.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pausedBooks.map(book => (
              <article
                key={book.id}
                data-testid={`book-card-${book.id}`}
                className="bg-card border border-border rounded-[14px] p-4 flex flex-col justify-between gap-3"
              >
                <div>
                  <button
                    type="button"
                    onClick={() => navigateTo(`#/book/${encodeURIComponent(book.id)}`)}
                    className="text-left text-heading text-foreground hover:underline"
                  >
                    {book.title}
                  </button>
                  <p className="text-label text-muted-foreground">{book.author}</p>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border/50 text-label">
                  <span className="text-muted-foreground num">
                    {formatPosDisplay(book.currentPos, book.posUnit)}
                  </span>
                  <button
                    type="button"
                    data-testid={`book-start-btn-${book.id}`}
                    onClick={() => void handleStartReading(book.id)}
                    className="font-semibold text-foreground hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                  >
                    <Play className="w-3 h-3" />
                    <span>Resume</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Finished */}
      {finishedBooks.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-eyebrow uppercase text-muted-foreground tracking-wider">
            Finished ({finishedBooks.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {finishedBooks.map(book => (
              <article
                key={book.id}
                data-testid={`book-card-${book.id}`}
                className="bg-card border border-border rounded-[14px] p-4 flex flex-col justify-between gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <button
                      type="button"
                      onClick={() => navigateTo(`#/book/${encodeURIComponent(book.id)}`)}
                      className="text-left text-heading text-foreground hover:underline"
                    >
                      {book.title}
                    </button>
                    <p className="text-label text-muted-foreground">{book.author}</p>
                  </div>
                  <CheckCircle2 className="w-4 h-4 text-positive shrink-0 mt-0.5" />
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-border/50 text-label">
                  <span className="text-foreground font-medium num">100% Completed</span>
                  {isSafeHttpUrl(book.docUrl) && (
                    <a
                      href={book.docUrl.trim()}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    >
                      <span>Doc ↗</span>
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
