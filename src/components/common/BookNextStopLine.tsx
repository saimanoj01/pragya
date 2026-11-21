import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Flag, Plus } from 'lucide-react';
import type { Book } from '../../types/pragya';
import { usePragyaActions, usePragyaData } from '../../context/PragyaContext';
import { describeSyncError } from '../../utils/apiErrors';
import { isArchived } from '../../utils/archive';
import {
  BOOK_NEXT_STOP_MAX,
  BOOK_NEXT_STOP_OWNED_META_KEYS,
  getBookMetaString,
} from '../../utils/metaCodecs';
import {
  computeSittingPace,
  normalizeBookContextValue,
  withBookContextField,
} from '../../utils/readingMomentum';
import { showToast } from '../../utils/toast';
import { BTN_SECONDARY, BTN_TERTIARY } from './uiClasses';

export interface BookNextStopLineProps {
  book: Book;
}

/**
 * v2: quiet single-line optional Next Stopping Point editor + calm median sitting-pace caption
 * inside BookDetailView's progress block.
 */
export const BookNextStopLine: React.FC<BookNextStopLineProps> = ({ book }) => {
  const { sessions } = usePragyaData();
  const { updateBook } = usePragyaActions();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  const nextStop = getBookMetaString(book.meta, 'nextStop');
  const pace = useMemo(() => computeSittingPace(book, sessions), [book, sessions]);

  useEffect(() => {
    setEditing(false);
  }, [book.id]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [editing]);

  const startEdit = () => {
    setDraft(nextStop);
    setEditing(true);
  };

  const cancelEdit = () => {
    restoreFocusRef.current = true;
    setEditing(false);
  };

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (saving) return;
    if (normalizeBookContextValue('nextStop', draft) === nextStop) {
      cancelEdit();
      return;
    }
    setSaving(true);
    try {
      await updateBook(
        { ...book, meta: withBookContextField(book.meta, 'nextStop', draft) },
        {
          expectedBaseUpdatedAt: book.meta?.updatedAt,
          ownedMetaKeys: BOOK_NEXT_STOP_OWNED_META_KEYS,
          baseMeta: book.meta,
        }
      );
      showToast(draft.trim() ? 'Stopping point updated.' : 'Stopping point cleared.', 'success');
      restoreFocusRef.current = true;
      setEditing(false);
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to update stopping point'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (book.status === 'finished') return null;

  return (
    <div className="space-y-1.5">
      {pace && (
        <p data-testid="book-sitting-pace" className="text-label text-muted-foreground num">
          {pace.label}
        </p>
      )}

      {editing ? (
        <form
          onSubmit={e => void handleSave(e)}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancelEdit();
            }
          }}
          data-testid="book-next-stop-form"
          className="print:hidden flex flex-wrap items-center gap-2"
        >
          <input
            ref={inputRef}
            type="text"
            enterKeyHint="done"
            data-testid="book-next-stop-input"
            aria-label="Next stopping point"
            maxLength={BOOK_NEXT_STOP_MAX}
            autoComplete="off"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="e.g. Finish Part II · p. 180"
            className="h-11 sm:h-9 w-full sm:w-64 px-3 rounded-[8px] bg-background border border-input text-base sm:text-label text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <button
            type="submit"
            data-testid="book-next-stop-save-btn"
            disabled={saving}
            className={BTN_SECONDARY}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={cancelEdit} className={BTN_TERTIARY}>
            Cancel
          </button>
        </form>
      ) : nextStop ? (
        <div
          data-testid="book-next-stop-line"
          className="flex items-center gap-2 text-label text-muted-foreground min-w-0"
        >
          <Flag className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span className="shrink-0">Next stop</span>
          <span className="min-w-0 flex-initial text-foreground font-medium truncate max-w-[280px]" title={nextStop}>
            {nextStop}
          </span>
          {!isArchived(book) && (
            <button
              ref={triggerRef}
              type="button"
              data-testid="book-next-stop-edit-btn"
              onClick={startEdit}
              className={`${BTN_TERTIARY} print:hidden shrink-0`}
            >
              Change
            </button>
          )}
        </div>
      ) : book.status === 'reading' && !isArchived(book) ? (
        <div className="print:hidden flex items-center gap-2 text-label text-muted-foreground">
          <button
            ref={triggerRef}
            type="button"
            data-testid="book-next-stop-edit-btn"
            onClick={startEdit}
            className={BTN_TERTIARY}
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Set a next stopping point</span>
          </button>
        </div>
      ) : null}
    </div>
  );
};
