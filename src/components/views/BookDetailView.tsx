import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Edit3, ExternalLink, Plus } from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { usePragyaData } from '../../context/PragyaContext';
import { useArchiveActions } from '../../hooks/useArchiveActions';
import { useDeleteForever } from '../../hooks/useDeleteForever';
import { isEditableElement } from '../../hooks/useKeyboardShortcuts';
import { archivedDateLabel, isArchived } from '../../utils/archive';
import {
  getFilledCapstone,
  hideCapstonePromptForBook,
  readHiddenCapstoneBooks,
} from '../../utils/capstonePrompt';
import { focusCard, focusedCardIndex } from '../../utils/cardFocus';
import { computeChapterDividers } from '../../utils/chapterFormat';
import { hasOpenDialog } from '../../utils/dialogOverlay';
import { isSafeHttpUrl, navigateTo } from '../../utils/navigation';
import { noteHref } from '../../utils/noteVisibility';
import {
  computePercentDisplay,
  formatPosDisplay,
  isEverFinished,
  isNoteSpoiler,
} from '../../utils/spoilerMath';
import { showToast } from '../../utils/toast';
import { ArchivedBanner } from '../common/ArchivedBanner';
import { BookBookmarkBar } from '../common/BookBookmarkBar';
import { BookChapterLine } from '../common/BookChapterLine';
import { BookCover, REREADING_BADGE } from '../common/BookCover';
import { BookNoteCard } from '../common/BookNoteCard';
import { CapstoneSection } from '../common/CapstoneSection';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { SessionsTrail } from '../common/SessionsTrail';
import { BTN_PRIMARY, BTN_SECONDARY, BTN_TERTIARY_NEGATIVE, CARD } from '../common/uiClasses';
import { CapstoneModal } from '../modals/CapstoneModal';

export interface BookDetailViewProps {
  bookId: string;
  onEditBook: (book: Book) => void;
  onOpenCaptureForBook: (bookId: string) => void;
  /** CD D2.1 (Q6): `E` edits the focused note card; `D` deepens the J/K-focused note. */
  onEditNote?: (note: Note) => void;
  onDeepenNote?: (note: Note) => void;
}

export const BookDetailView: React.FC<BookDetailViewProps> = ({
  bookId,
  onEditBook,
  onOpenCaptureForBook,
  onEditNote,
  onDeepenNote,
}) => {
  const { books, booksById, notes } = usePragyaData();

  const book = booksById.get(bookId) || null;
  const bookNotes = useMemo(
    () =>
      notes
        .filter(n => n.bookId === bookId && !isArchived(n))
        .sort((a, b) => a.pos - b.pos || a.createdAt.localeCompare(b.createdAt)),
    [bookId, notes]
  );

  const [revealedSlugs, setRevealedSlugs] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const jkMovedRef = useRef(false);
  const [jkTick, setJkTick] = useState(0);
  const [capstoneOpen, setCapstoneOpen] = useState<boolean>(false);
  const [capstoneHidden, setCapstoneHidden] = useState<boolean>(false);

  const { restoreBookFromArchive } = useArchiveActions();
  const { requestDeleteBook, dialogProps: deleteDialogProps } = useDeleteForever();

  useEffect(() => {
    setFocusedIndex(0);
    setCapstoneHidden(readHiddenCapstoneBooks().includes(bookId));
  }, [bookId]);

  useEffect(() => {
    if (focusedIndex >= bookNotes.length && bookNotes.length > 0) {
      setFocusedIndex(bookNotes.length - 1);
    }
  }, [bookNotes.length, focusedIndex]);

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
      if (
        hasOpenDialog(document) ||
        document.querySelector('[data-popover="true"]')
      ) {
        return;
      }
      if (isEditableElement(e.target)) return;
      const target = e.target as HTMLElement | null;

      const key = e.key.toLowerCase();
      if (key === 'e') {
        const cardIdx = e.shiftKey ? null : focusedCardIndex(document.activeElement);
        const cardNote = cardIdx === null ? undefined : bookNotes[cardIdx];
        if (cardNote && onEditNote) {
          e.preventDefault();
          if (!(isNoteSpoiler(cardNote, book) && !revealedSlugs.has(cardNote.slug))) {
            onEditNote(cardNote);
          }
          return;
        }
        e.preventDefault();
        onEditBook(book);
        return;
      }
      if (key === 'd' && onDeepenNote) {
        const active = bookNotes[focusedIndex];
        if (active && !(isNoteSpoiler(active, book) && !revealedSlugs.has(active.slug))) {
          e.preventDefault();
          onDeepenNote(active);
        }
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
        jkMovedRef.current = true;
        setFocusedIndex(prev => Math.min(bookNotes.length - 1, prev + 1));
        setJkTick(t => t + 1);
      } else if (key === 'k') {
        e.preventDefault();
        jkMovedRef.current = true;
        setFocusedIndex(prev => Math.max(0, prev - 1));
        setJkTick(t => t + 1);
      } else if (e.key === ' ') {
        if (target?.closest('button, a, summary, [role="button"]')) return;
        const active = bookNotes[focusedIndex];
        if (active && isNoteSpoiler(active, book) && !revealedSlugs.has(active.slug)) {
          e.preventDefault();
          revealSlug(active.slug);
        }
      } else if (e.key === 'Enter') {
        if (target?.closest('button, a, summary, [role="button"]')) return;
        const active = bookNotes[focusedIndex];
        if (active) {
          e.preventDefault();
          navigateTo(noteHref(active, book, revealedSlugs.has(active.slug)));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    book,
    bookNotes,
    canOpenCapstone,
    focusedIndex,
    onDeepenNote,
    onEditBook,
    onEditNote,
    revealedSlugs,
  ]);

  useEffect(() => {
    if (!jkMovedRef.current) return;
    jkMovedRef.current = false;
    focusCard(
      document.querySelector<HTMLElement>(
        `[data-testid="book-detail-view"] [data-jk-card="${focusedIndex}"]`
      )
    );
  }, [focusedIndex, jkTick]);

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
          className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center gap-1.5 text-label text-muted-foreground hover:text-foreground print:hidden"
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

  const handleHideCapstone = () => {
    try {
      hideCapstonePromptForBook(book.id);
    } catch {
      // Storage unavailable: still hide for this session.
    }
    setCapstoneHidden(true);
    showToast('Hidden. You can add it anytime from the Finished line above.', 'info');
  };

  return (
    <div data-testid="book-detail-view" className="py-6 space-y-6">
      <button
        type="button"
        data-testid="back-to-shelf-btn"
        onClick={() => navigateTo('#/shelf')}
        className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center gap-1.5 text-label text-muted-foreground hover:text-foreground print:hidden"
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
      <section className={`${CARD} space-y-5`}>
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

          <div className="print:hidden flex flex-wrap items-center gap-2 shrink-0">
            {isSafeHttpUrl(book.docUrl) && (
              <a
                href={book.docUrl.trim()}
                target="_blank"
                rel="noopener noreferrer"
                className={BTN_SECONDARY}
              >
                <span>Book Doc</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            <button type="button" onClick={() => onEditBook(book)} className={BTN_SECONDARY}>
              <Edit3 className="w-3.5 h-3.5" />
              <span>Edit (E)</span>
            </button>
            {!isArchived(book) && (
              <button
                type="button"
                onClick={() => onOpenCaptureForBook(book.id)}
                className={BTN_PRIMARY}
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

        <BookChapterLine book={book} />

        <BookBookmarkBar
          book={book}
          hasCapstone={Boolean(capstone)}
          capstoneHidden={capstoneHidden}
          onOpenCapstone={() => setCapstoneOpen(true)}
        />
      </section>

      <CapstoneSection
        book={book}
        notes={notes}
        capstone={capstone}
        capstoneHidden={capstoneHidden}
        onOpenEditor={() => setCapstoneOpen(true)}
        onHide={handleHideCapstone}
      />

      <SessionsTrail book={book} />

      {/* Book Notes */}
      <section className="space-y-3">
        <h2 className="text-heading text-foreground num">Captured Notes ({bookNotes.length})</h2>

        {bookNotes.length === 0 ? (
          <div className="bg-card border border-border rounded-[14px] p-6 text-center text-body text-muted-foreground">
            No notes captured for this book yet.
          </div>
        ) : (
          <div className="space-y-3">
            {bookNotes.map((note, idx) => {
              const revealed = revealedSlugs.has(note.slug);
              const spoiler = isNoteSpoiler(note, book) && !revealed;
              return (
                <BookNoteCard
                  key={note.id}
                  note={note}
                  book={book}
                  idx={idx}
                  isFocused={idx === focusedIndex}
                  spoiler={spoiler}
                  revealed={revealed}
                  divider={chapterDividers.get(idx)}
                  hasChapterDividers={chapterDividers.size > 0}
                  allNotes={notes}
                  allBooks={books}
                  onFocusCard={setFocusedIndex}
                  onRevealSlug={revealSlug}
                />
              );
            })}
          </div>
        )}
      </section>

      <ConfirmDialog {...deleteDialogProps} />
      <CapstoneModal isOpen={capstoneOpen} onClose={() => setCapstoneOpen(false)} book={book} />
    </div>
  );
};
