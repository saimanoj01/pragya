import React, { useEffect, useId, useState } from 'react';
import { Archive, X } from 'lucide-react';
import type { Book, BookFormat, BookKind, BookStatus, PosUnit } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { useArchiveActions } from '../../hooks/useArchiveActions';
import { describeSyncError } from '../../utils/apiErrors';
import { isArchived } from '../../utils/archive';
import { coverUrlError } from '../../utils/bookSurfaces';
import { CHAPTER_MAX_LENGTH, withChapterKey } from '../../utils/chapterFormat';
import { isSubmitShortcut } from '../../utils/keyboard';
import { BOOK_CHAPTER_EDITOR_OWNED_META_KEYS } from '../../utils/metaCodecs';
import { navigateTo } from '../../utils/navigation';
import { showToast } from '../../utils/toast';
import { Modal } from '../common/Modal';
import {
  BTN_GHOST_LG,
  BTN_TERTIARY,
  FIELD_LABEL,
  INPUT,
  MODAL_CLOSE_BTN,
  SELECT,
} from '../common/uiClasses';

export interface EditBookModalProps {
  book: Book | null;
  onClose: () => void;
}

export const EditBookModal: React.FC<EditBookModalProps> = ({ book, onClose }) => {
  const { updateBook } = usePragya();
  const { archiveBook } = useArchiveActions();
  const [archiving, setArchiving] = useState(false);

  const handleArchive = async () => {
    if (!book) return;
    setArchiving(true);
    const saved = await archiveBook(book);
    setArchiving(false);
    if (!saved) return;
    onClose();
    if (window.location.hash.startsWith(`#/book/${encodeURIComponent(book.id)}`)) {
      navigateTo('#/shelf');
    }
  };
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [format, setFormat] = useState<BookFormat>('physical');
  const [kind, setKind] = useState<BookKind>('nonfiction');
  const [status, setStatus] = useState<BookStatus>('reading');
  const [currentPos, setCurrentPos] = useState('0');
  const [totalPos, setTotalPos] = useState('0');
  const [posUnit, setPosUnit] = useState<PosUnit>('page');
  const [docUrl, setDocUrl] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [currentChapter, setCurrentChapter] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!book) return;
    setTitle(book.title);
    setAuthor(book.author);
    setFormat(book.format);
    setKind(book.kind);
    setStatus(book.status);
    setCurrentPos(String(book.currentPos));
    setTotalPos(String(book.totalPos));
    setPosUnit(book.posUnit);
    setDocUrl(book.docUrl || '');
    setCoverUrl(typeof book.meta?.coverUrl === 'string' ? book.meta.coverUrl : '');
    setCurrentChapter(
      typeof book.meta?.currentChapter === 'string' ? book.meta.currentChapter : ''
    );
    setSubmitting(false);
  }, [book]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!book) return;
    if (!title.trim()) {
      showToast('Title cannot be empty', 'error');
      return;
    }
    const coverErr = coverUrlError(coverUrl);
    if (coverErr) {
      showToast(coverErr, 'error');
      return;
    }
    setSubmitting(true);
    try {
      const nextCurrent = Math.max(0, Number(currentPos) || 0);
      const nextTotal = Math.max(0, Number(totalPos) || 0);
      const nowIso = new Date().toISOString();

      await updateBook(
        {
          ...book,
          title: title.trim(),
          author: author.trim() || 'Unknown Author',
          format,
          kind,
          status,
          currentPos: status === 'finished' && nextTotal > 0 ? nextTotal : nextCurrent,
          totalPos: nextTotal,
          posUnit,
          docUrl: docUrl.trim(),
          meta: {
            ...withChapterKey(book.meta, 'currentChapter', currentChapter),
            ...(status === 'reading' && !book.meta.startedAt ? { startedAt: nowIso } : {}),
            ...(status === 'finished' && !book.meta.finishedAt ? { finishedAt: nowIso } : {}),
            coverUrl: coverUrl.trim() || undefined,
            updatedAt: nowIso,
          },
        },
        {
          expectedBaseUpdatedAt: book.meta.updatedAt,
          ownedMetaKeys: BOOK_CHAPTER_EDITOR_OWNED_META_KEYS,
          baseMeta: book.meta,
        }
      );
      showToast(`Updated "${title.trim()}"`, 'success');
      onClose();
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to update book'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const coverErr = coverUrlError(coverUrl);

  return (
    <Modal
      isOpen={Boolean(book)}
      onClose={onClose}
      dataTestId="edit-book-modal"
      title="Edit Book"
      headingId={fid('heading')}
    >
      <div className="flex items-center justify-between mb-4">
        <h2 id={fid('heading')} className="text-title text-foreground">
          Edit Book
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className={MODAL_CLOSE_BTN}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <form
        onSubmit={handleSubmit}
        onKeyDown={e => {
          if (isSubmitShortcut(e.nativeEvent)) {
            e.preventDefault();
            if (!submitting && !archiving) e.currentTarget.requestSubmit();
          }
        }}
        className="space-y-4"
      >
        <div className="space-y-1.5">
          <label htmlFor={fid('title')} className={FIELD_LABEL}>
            Title *
          </label>
          <input
            id={fid('title')}
            type="text"
            data-testid="edit-book-title-input"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className={INPUT}
            required
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor={fid('author')} className={FIELD_LABEL}>
            Author
          </label>
          <input
            id={fid('author')}
            type="text"
            data-testid="edit-book-author-input"
            value={author}
            onChange={e => setAuthor(e.target.value)}
            className={INPUT}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label htmlFor={fid('format')} className={FIELD_LABEL}>
              Format
            </label>
            <select
              id={fid('format')}
              value={format}
              onChange={e => setFormat(e.target.value as BookFormat)}
              className={SELECT}
            >
              <option value="physical">Physical</option>
              <option value="kindle">Kindle</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={fid('kind')} className={FIELD_LABEL}>
              Kind
            </label>
            <select
              id={fid('kind')}
              value={kind}
              onChange={e => setKind(e.target.value as BookKind)}
              className={SELECT}
            >
              <option value="nonfiction">Non-Fiction</option>
              <option value="fiction">Fiction</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={fid('status')} className={FIELD_LABEL}>
              Status
            </label>
            <select
              id={fid('status')}
              value={status}
              onChange={e => setStatus(e.target.value as BookStatus)}
              className={SELECT}
            >
              <option value="reading">Reading</option>
              <option value="queued">Queued</option>
              <option value="paused">Paused</option>
              <option value="finished">Finished</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label htmlFor={fid('pos')} className={FIELD_LABEL}>
              Current Pos
            </label>
            <input
              id={fid('pos')}
              type="number"
              inputMode="numeric"
              min="0"
              value={currentPos}
              onChange={e => setCurrentPos(e.target.value)}
              className={`${INPUT} num`}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={fid('total')} className={FIELD_LABEL}>
              Total Pos
            </label>
            <input
              id={fid('total')}
              type="number"
              inputMode="numeric"
              min="0"
              value={totalPos}
              onChange={e => setTotalPos(e.target.value)}
              className={`${INPUT} num`}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={fid('unit')} className={FIELD_LABEL}>
              Unit
            </label>
            <select
              id={fid('unit')}
              value={posUnit}
              onChange={e => setPosUnit(e.target.value as PosUnit)}
              className={SELECT}
            >
              <option value="page">Page</option>
              <option value="percent">Percent (%)</option>
              <option value="loc">Kindle Loc</option>
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={fid('chapter')} className={FIELD_LABEL}>
            Current Chapter / Story
          </label>
          <input
            id={fid('chapter')}
            type="text"
            maxLength={CHAPTER_MAX_LENGTH}
            autoComplete="off"
            data-testid="edit-book-chapter-input"
            value={currentChapter}
            onChange={e => setCurrentChapter(e.target.value)}
            placeholder="e.g. Ch. 3: Run · or a story title"
            aria-describedby={fid('chapter-help')}
            className={INPUT}
          />
          <p id={fid('chapter-help')} className="text-label text-faint">
            Shown on your Shelf and suggested for new notes at your bookmark.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={fid('docurl')} className={FIELD_LABEL}>
            Companion Google Doc URL
          </label>
          <input
            id={fid('docurl')}
            type="url"
            value={docUrl}
            onChange={e => setDocUrl(e.target.value)}
            placeholder="https://docs.google.com/document/d/..."
            className={INPUT}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor={fid('cover')} className={FIELD_LABEL}>
            Cover Image URL (Optional)
          </label>
          <input
            id={fid('cover')}
            type="url"
            data-testid="edit-book-cover-input"
            value={coverUrl}
            onChange={e => setCoverUrl(e.target.value)}
            placeholder="https://…"
            aria-describedby={fid('cover-help')}
            aria-invalid={Boolean(coverErr)}
            className={INPUT}
          />
          {coverErr ? (
            <p id={fid('cover-help')} role="alert" className="text-label text-negative">
              {coverErr}
            </p>
          ) : (
            <p id={fid('cover-help')} className="text-label text-faint">
              Shown small on your Shelf and book page.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <div>
            {!isArchived(book) && (
              <button
                type="button"
                data-testid="archive-book-btn"
                onClick={() => void handleArchive()}
                disabled={submitting || archiving}
                className={`${BTN_TERTIARY} h-11 sm:h-10`}
              >
                <Archive className="w-4 h-4" aria-hidden="true" />
                <span>Archive Book</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className={BTN_GHOST_LG}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              data-testid="edit-book-submit-btn"
              className="h-11 sm:h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {submitting ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
};
