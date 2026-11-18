import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Compass,
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  Link2,
  Lock,
  Plus,
  RotateCcw,
  Sparkles,
  Unlock,
} from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { isEditableElement } from '../../hooks/useKeyboardShortcuts';
import { BOOK_DETAIL_CHAPTER_OWNED_META_KEYS, getRenderableAttachments } from '../../utils/metaCodecs';
import { isSafeHttpUrl, navigateTo } from '../../utils/navigation';
import {
  computePercentDisplay,
  formatPosDisplay,
  getQuickAdvanceSpec,
  isNoteSpoiler,
  isEverFinished,
  isSealedPrediction,
  isUnlockedPrediction,
} from '../../utils/spoilerMath';
import { showToast } from '../../utils/toast';
import { DriveImage } from '../common/DriveImage';
import { describeSyncError } from '../../utils/apiErrors';
import { noteHref } from '../../utils/noteVisibility';
import {
  CHAPTER_MAX_LENGTH,
  chapterDividerLabel,
  computeChapterDividers,
  normalizeChapterInput,
  withChapterKey,
} from '../../utils/chapterFormat';
import {
  CAPSTONE_COPY_SUCCESS_MESSAGE,
  buildCapstonePrompt,
  countCapstoneEligibleNotes,
  getFilledCapstone,
  hideCapstonePromptForBook,
  isIsoTimestamp,
  readHiddenCapstoneBooks,
  tryCopyText,
} from '../../utils/capstonePrompt';
import { ChapterPosChip } from '../common/ChapterPosChip';
import { ArchivedBanner } from '../common/ArchivedBanner';
import { useArchiveActions } from '../../hooks/useArchiveActions';
import { useDeleteForever } from '../../hooks/useDeleteForever';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { BTN_TERTIARY_NEGATIVE } from '../common/uiClasses';
import { archivedDateLabel, isArchived } from '../../utils/archive';
import { CapstoneModal, CapstonePromptFallbackModal } from '../modals/CapstoneModal';
import { BookCover, REREADING_BADGE } from '../common/BookCover';
import { SessionNoteEditor, SessionsTrail } from '../common/SessionsTrail';
import { WikiText } from '../common/WikiText';
import { sessionDateLabel } from '../../utils/bookSurfaces';
import { getLocalDateString } from '../../utils/sessionCoalesce';

const BTN_SECONDARY =
  'h-9 px-3 rounded-[10px] bg-surface2 border border-border text-label font-medium text-foreground hover:bg-secondary inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50';
const BTN_TERTIARY =
  'inline-flex items-center gap-1 text-label font-medium text-muted-foreground hover:text-foreground';
const EYEBROW = 'text-eyebrow uppercase text-muted-foreground';

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
  const {
    books,
    notes,
    sessions,
    advanceBookPosition,
    revertBookmarkAdvance,
    markBookFinished,
    restoreBook,
    updateBook,
    startReread,
  } = usePragya();

  const book = useMemo(() => books.find(b => b.id === bookId) || null, [books, bookId]);
  const bookNotes = useMemo(
    () =>
      notes
        // QA-26: archived notes leave the book's Captured Notes too (direct links still work).
        .filter(n => n.bookId === bookId && !isArchived(n))
        .sort((a, b) => a.pos - b.pos || a.createdAt.localeCompare(b.createdAt)),
    [bookId, notes]
  );

  const [exactInput, setExactInput] = useState<string>('');
  const [manualOverride, setManualOverride] = useState<boolean>(false);
  const [revealedSlugs, setRevealedSlugs] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const [editingChapter, setEditingChapter] = useState<boolean>(false);
  const [chapterDraft, setChapterDraft] = useState<string>('');
  const [savingChapter, setSavingChapter] = useState<boolean>(false);
  const chapterTriggerRef = useRef<HTMLButtonElement>(null);
  const chapterInputRef = useRef<HTMLInputElement>(null);
  const restoreChapterFocusRef = useRef<boolean>(false);
  const [capstoneOpen, setCapstoneOpen] = useState<boolean>(false);
  const [capstoneHidden, setCapstoneHidden] = useState<boolean>(false);
  const [fallbackPrompt, setFallbackPrompt] = useState<string | null>(null);
  // CD C2.3: the session the last +N / Advance wrote → "+ Add a note to this session".
  const [postAdvanceSessionId, setPostAdvanceSessionId] = useState<string | null>(null);
  const [postAdvanceEditing, setPostAdvanceEditing] = useState(false);
  const [rereadConfirmOpen, setRereadConfirmOpen] = useState(false);
  const [rereadBusy, setRereadBusy] = useState(false);
  const capstoneHeadingId = useId();
  const { restoreBookFromArchive } = useArchiveActions();
  const { requestDeleteBook, dialogProps: deleteDialogProps } = useDeleteForever();

  useEffect(() => {
    setExactInput(book ? String(book.currentPos) : '0');
  }, [book]);

  useEffect(() => {
    setFocusedIndex(0);
    setEditingChapter(false);
    setPostAdvanceSessionId(null);
    setPostAdvanceEditing(false);
    setCapstoneHidden(readHiddenCapstoneBooks().includes(bookId));
  }, [bookId]);

  useEffect(() => {
    if (editingChapter) {
      chapterInputRef.current?.focus();
    } else if (restoreChapterFocusRef.current) {
      restoreChapterFocusRef.current = false;
      chapterTriggerRef.current?.focus();
    }
  }, [editingChapter]);

  const capstone = book ? getFilledCapstone(book) : undefined;
  const canOpenCapstone = Boolean(book && (book.status === 'finished' || capstone));

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
      if (key === 'c' && canOpenCapstone) {
        e.preventDefault();
        setCapstoneOpen(true);
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
          navigateTo(noteHref(active, book, revealedSlugs.has(active.slug)));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [book, bookNotes, canOpenCapstone, focusedIndex, onEditBook, revealedSlugs]);

  // ux_spec B.4: chapter dividers over contiguous runs; shielded runs never name a chapter.
  const chapterDividers = useMemo(
    () =>
      book
        ? computeChapterDividers(
            bookNotes,
            note => isNoteSpoiler(note, book) && !revealedSlugs.has(note.slug)
          )
        : new Map(),
    [book, bookNotes, revealedSlugs]
  );

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
        setPostAdvanceSessionId(res.sessionId || null);
        setPostAdvanceEditing(false);
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
        setPostAdvanceSessionId(res.sessionId || null);
        setPostAdvanceEditing(false);
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

  const handleMarkFinished = async () => {
    const prevBook = book;
    try {
      const finished = await markBookFinished(book.id);
      showToast(`"${book.title}" marked finished — predictions unlocked!`, 'success', {
        action: {
          label: 'Undo',
          testId: 'toast-undo-btn',
          onClick: () => {
            // B4.1: undo is guarded against the row this mark-finished wrote.
            void restoreBook(prevBook, { expectedBaseUpdatedAt: finished?.meta?.updatedAt })
              .then(() => showToast(`Restored "${prevBook.title}" to ${prevBook.status}`, 'info'))
              .catch(err =>
                showToast(
                  describeSyncError(err, 'Failed to undo mark finished'),
                  'error'
                )
              );
          },
        },
      });
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to mark finished'), 'error');
    }
  };

  const currentChapter = normalizeChapterInput(
    typeof book.meta?.currentChapter === 'string' ? book.meta.currentChapter : undefined
  );

  const startChapterEdit = () => {
    setChapterDraft(currentChapter || '');
    setEditingChapter(true);
  };

  const cancelChapterEdit = () => {
    restoreChapterFocusRef.current = true;
    setEditingChapter(false);
  };

  const handleSaveChapter = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (savingChapter) return;
    if ((normalizeChapterInput(chapterDraft) || '') === (currentChapter || '')) {
      cancelChapterEdit();
      return;
    }
    setSavingChapter(true);
    try {
      // Writes only meta.currentChapter (+ updatedAt), guarded on the row as rendered.
      await updateBook(
        { ...book, meta: withChapterKey(book.meta, 'currentChapter', chapterDraft) },
        {
          expectedBaseUpdatedAt: book.meta?.updatedAt,
          ownedMetaKeys: BOOK_DETAIL_CHAPTER_OWNED_META_KEYS,
          baseMeta: book.meta,
        }
      );
      showToast('Chapter updated.', 'success');
      restoreChapterFocusRef.current = true;
      setEditingChapter(false);
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to update chapter'), 'error');
    } finally {
      setSavingChapter(false);
    }
  };

  const eligibleCapstoneNotes = countCapstoneEligibleNotes(book, notes);
  const postAdvanceSession = postAdvanceSessionId
    ? sessions.find(sx => sx.id === postAdvanceSessionId) || null
    : null;

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

  const handleCopyCapstonePrompt = async () => {
    const prompt = buildCapstonePrompt(book, notes);
    if (await tryCopyText(prompt)) {
      showToast(CAPSTONE_COPY_SUCCESS_MESSAGE, 'success');
    } else {
      setFallbackPrompt(prompt);
    }
  };

  const handleHideCapstone = () => {
    try {
      hideCapstonePromptForBook(book.id);
    } catch {
      // Storage unavailable: still hide for this session.
    }
    setCapstoneHidden(true);
    showToast('Hidden. You can add it anytime from the Finished line above.', 'info');
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

      {isArchived(book) && (
        <ArchivedBanner
          kind="book"
          date={archivedDateLabel(book)}
          onRestore={() => void restoreBookFromArchive(book)}
        >
            <button
              type="button"
              data-testid="delete-forever-btn"
              onClick={() => requestDeleteBook(book)}
              className={BTN_TERTIARY_NEGATIVE}
            >
              Delete Forever…
            </button>
        </ArchivedBanner>
      )}

      {/* Book Header Card */}
      <section className="bg-card border border-border rounded-[14px] p-5 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
          <BookCover
            book={book}
            className="w-14 h-20 rounded-[8px] object-cover border border-border shrink-0"
          />
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
              {isEverFinished(book) && (
                <span data-testid="rereading-badge" className={REREADING_BADGE}>
                  Re-reading
                </span>
              )}
            </div>
            <h1 className="text-display-l text-foreground tracking-tight">{book.title}</h1>
            <p className="text-body text-muted-foreground">by {book.author}</p>
          </div>
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
            {!isArchived(book) && (
            <button
              type="button"
              onClick={() => onOpenCaptureForBook(book.id)}
              className="h-9 px-3.5 rounded-[10px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Note</span>
            </button>
            )}
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

        {/* A3.4 Current chapter (bookmark area) */}
        {editingChapter ? (
          <form
            onSubmit={e => void handleSaveChapter(e)}
            className="flex flex-wrap items-center gap-2"
            data-testid="book-detail-chapter-form"
          >
            <input
              ref={chapterInputRef}
              type="text"
              data-testid="book-detail-chapter-input"
              aria-label="Current chapter or story"
              maxLength={CHAPTER_MAX_LENGTH}
              autoComplete="off"
              value={chapterDraft}
              onChange={e => setChapterDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelChapterEdit();
                }
              }}
              placeholder="e.g. Ch. 3: Run · or a story title"
              className="h-11 sm:h-9 w-full sm:w-64 px-3 rounded-[8px] bg-background border border-input text-label text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
            <button
              type="submit"
              data-testid="book-detail-chapter-save-btn"
              disabled={savingChapter}
              className={BTN_SECONDARY}
            >
              {savingChapter ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={cancelChapterEdit} className={BTN_TERTIARY}>
              Cancel
            </button>
          </form>
        ) : currentChapter ? (
          <div
            data-testid="book-detail-chapter-line"
            className="flex items-center gap-2 text-label text-muted-foreground min-w-0"
          >
            <BookOpen className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="shrink-0">Now in</span>
            <span className="text-foreground font-medium truncate max-w-[280px]" title={currentChapter}>
              {currentChapter}
            </span>
            <button
              ref={chapterTriggerRef}
              type="button"
              data-testid="book-detail-chapter-change-btn"
              onClick={startChapterEdit}
              className={`${BTN_TERTIARY} shrink-0`}
            >
              Change
            </button>
          </div>
        ) : book.status !== 'finished' ? (
          <div className="flex items-center gap-2 text-label text-muted-foreground min-w-0">
            <button
              ref={chapterTriggerRef}
              type="button"
              data-testid="book-detail-chapter-change-btn"
              onClick={startChapterEdit}
              className={BTN_TERTIARY}
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Add chapter</span>
            </button>
          </div>
        ) : null}

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

            {/* CD C2.3: one quiet tertiary action after an advance (no auto-focus, no toast). */}
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
              className="h-9 px-4 rounded-[10px] bg-positive/15 hover:bg-positive/25 border border-positive/30 text-label font-semibold text-positive inline-flex items-center gap-1.5 whitespace-nowrap self-start lg:self-center"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Mark as Finished</span>
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex items-center gap-1.5 text-label font-medium text-positive">
                <CheckCircle2 className="w-4 h-4" />
                <span>Finished{book.meta.finishedAt ? ` · ${book.meta.finishedAt.slice(0, 10)}` : ''}</span>
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
              {!capstone && capstoneHidden && (
                <button
                  type="button"
                  data-testid="capstone-add-link"
                  onClick={() => setCapstoneOpen(true)}
                  className={BTN_TERTIARY}
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Add Whole-Book Picture</span>
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* A2 Whole-Book Picture (capstone) */}
      {capstone ? (
        <section
          aria-labelledby={capstoneHeadingId}
          data-testid="capstone-card"
          className="bg-card border border-border rounded-[14px] p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 id={capstoneHeadingId} className={`flex items-center gap-1.5 ${EYEBROW}`}>
              <Compass className="w-4 h-4" aria-hidden="true" />
              <span>Whole-Book Picture</span>
            </h2>
            <button
              type="button"
              data-testid="capstone-edit-btn"
              aria-label="Edit Whole-Book Picture"
              onClick={() => setCapstoneOpen(true)}
              className={BTN_SECONDARY}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Edit (C)</span>
            </button>
          </div>
          {capstone.arcOrThesis.trim() && (
            <div className="space-y-1">
              <h3 className={EYEBROW}>{book.kind === 'fiction' ? 'The Arc' : 'The Thesis'}</h3>
              <p className="text-body text-foreground whitespace-pre-wrap">{capstone.arcOrThesis}</p>
            </div>
          )}
          {capstone.keyLearnings.length > 0 && (
            <div className="space-y-1">
              <h3 className={EYEBROW}>Key Learnings</h3>
              <ol className="list-decimal pl-5 space-y-1 text-body text-foreground num">
                {capstone.keyLearnings.map((learning, i) => (
                  <li key={`${i}-${learning}`}>{learning}</li>
                ))}
              </ol>
            </div>
          )}
          {capstone.perspectiveShift.trim() && (
            <div className="pl-4 border-l-2 border-foreground/40 space-y-1">
              <h3 className={EYEBROW}>How My Thinking Shifted</h3>
              <p className="text-body text-foreground whitespace-pre-wrap">{capstone.perspectiveShift}</p>
            </div>
          )}
          {isIsoTimestamp(capstone.completedAt) && (
            <p className="text-label text-faint num">Written {capstone.completedAt.slice(0, 10)}</p>
          )}
        </section>
      ) : book.status === 'finished' && !capstoneHidden ? (
        <section
          aria-labelledby={capstoneHeadingId}
          data-testid="capstone-empty-state"
          className="bg-card border border-dashed border-border rounded-[14px] p-5 space-y-3"
        >
          <h2 id={capstoneHeadingId} className={`flex items-center gap-1.5 ${EYEBROW}`}>
            <Compass className="w-4 h-4" aria-hidden="true" />
            <span>Whole-Book Picture</span>
          </h2>
          <p className="text-body text-muted-foreground">
            {eligibleCapstoneNotes > 0
              ? "While it's fresh, you can capture the shape of this book in a few lines. Entirely optional."
              : 'Capture the shape of this book in a few lines, whenever you like. Entirely optional.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {eligibleCapstoneNotes > 0 && (
              <button
                type="button"
                data-testid="copy-capstone-prompt-btn"
                onClick={() => void handleCopyCapstonePrompt()}
                className={BTN_SECONDARY}
              >
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Capstone Prompt</span>
              </button>
            )}
            <button
              type="button"
              data-testid="capstone-write-btn"
              onClick={() => setCapstoneOpen(true)}
              className={BTN_SECONDARY}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Write It Myself</span>
            </button>
            <button
              type="button"
              data-testid="capstone-hide-btn"
              aria-label="Hide Whole-Book Picture suggestion for this book"
              onClick={handleHideCapstone}
              className={`ml-auto ${BTN_TERTIARY}`}
            >
              Hide
            </button>
          </div>
        </section>
      ) : null}

      {/* CD C2.3: Recent Reading Sessions (between the Whole-Book Picture and the notes). */}
      <SessionsTrail book={book} />

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
              const divider = chapterDividers.get(idx);

              return (
                <React.Fragment key={note.id}>
                {divider && (
                  <h3
                    data-testid={`chapter-divider-${idx}`}
                    className="flex items-center gap-3 pt-2 text-eyebrow uppercase text-muted-foreground"
                  >
                    <span className="truncate">{chapterDividerLabel(divider)}</span>
                    <span className="num text-faint">{divider.count}</span>
                    <span aria-hidden="true" className="h-px flex-1 bg-border" />
                  </h3>
                )}
                <article
                  data-testid={`note-card-${note.slug}`}
                  data-focused={isFocused ? 'true' : undefined}
                  className={`bg-card border rounded-[14px] p-4 space-y-2.5 transition-colors ${
                    isFocused ? 'border-foreground/40 ring-1 ring-ring/40' : 'border-border'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-label text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-2">
                      <ChapterPosChip
                        testIdKey={note.slug}
                        chapter={note.meta?.chapter}
                        pos={note.pos}
                        posUnit={book.posUnit}
                        positionOnly={spoiler || chapterDividers.size > 0}
                      />
                      {renderNoteBadge(note)}
                    </div>
                    <button
                      type="button"
                      onClick={() => navigateTo(noteHref(note, book, revealedSlugs.has(note.slug)))}
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
                      {note.takeaway && (
                        <p className="text-body text-foreground">
                          <WikiText text={note.takeaway} notes={notes} books={books} />
                        </p>
                      )}
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
                </React.Fragment>
              );
            })}
          </div>
        )}
      </section>

      <ConfirmDialog {...deleteDialogProps} />
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
      <CapstoneModal isOpen={capstoneOpen} onClose={() => setCapstoneOpen(false)} book={book} />
      <CapstonePromptFallbackModal
        isOpen={fallbackPrompt !== null}
        onClose={() => setFallbackPrompt(null)}
        prompt={fallbackPrompt || ''}
      />
    </div>
  );
};
