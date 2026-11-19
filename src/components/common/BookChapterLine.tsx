import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, Plus } from 'lucide-react';
import type { Book } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { describeSyncError } from '../../utils/apiErrors';
import {
  CHAPTER_MAX_LENGTH,
  normalizeChapterInput,
  withChapterKey,
} from '../../utils/chapterFormat';
import { BOOK_DETAIL_CHAPTER_OWNED_META_KEYS } from '../../utils/metaCodecs';
import { showToast } from '../../utils/toast';
import { BTN_SECONDARY, BTN_TERTIARY } from './uiClasses';

export interface BookChapterLineProps {
  book: Book;
}

/**
 * CD Batch 5 (D3.1 / decisions.md R2#1): inline current-chapter line & editor on BookDetailView,
 * preserving focus return, Escape cancel, and `BOOK_DETAIL_CHAPTER_OWNED_META_KEYS` conflict guard.
 */
export const BookChapterLine: React.FC<BookChapterLineProps> = ({ book }) => {
  const { updateBook } = usePragya();
  const [editingChapter, setEditingChapter] = useState(false);
  const [chapterDraft, setChapterDraft] = useState('');
  const [savingChapter, setSavingChapter] = useState(false);

  const chapterTriggerRef = useRef<HTMLButtonElement>(null);
  const chapterInputRef = useRef<HTMLInputElement>(null);
  const restoreChapterFocusRef = useRef(false);

  useEffect(() => {
    setEditingChapter(false);
  }, [book.id]);

  useEffect(() => {
    if (editingChapter) {
      chapterInputRef.current?.focus();
    } else if (restoreChapterFocusRef.current) {
      restoreChapterFocusRef.current = false;
      chapterTriggerRef.current?.focus();
    }
  }, [editingChapter]);

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

  if (editingChapter) {
    return (
      <form
        onSubmit={e => void handleSaveChapter(e)}
        className="print:hidden flex flex-wrap items-center gap-2"
        data-testid="book-detail-chapter-form"
      >
        <input
          ref={chapterInputRef}
          type="text"
          enterKeyHint="done"
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
          className="h-11 sm:h-9 w-full sm:w-64 px-3 rounded-[8px] bg-background border border-input text-base sm:text-label text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
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
    );
  }

  if (currentChapter) {
    return (
      <div
        data-testid="book-detail-chapter-line"
        className="flex items-center gap-2 text-label text-muted-foreground min-w-0"
      >
        <BookOpen className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="shrink-0">Now in</span>
        <span
          className="text-foreground font-medium truncate max-w-[280px]"
          title={currentChapter}
        >
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
    );
  }

  if (book.status !== 'finished') {
    return (
      <div className="print:hidden flex items-center gap-2 text-label text-muted-foreground min-w-0">
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
    );
  }

  return null;
};
