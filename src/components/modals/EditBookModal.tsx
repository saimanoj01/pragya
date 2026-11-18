import React, { useEffect, useId, useState } from 'react';
import { Archive, X } from 'lucide-react';
import type { Book, BookFormat, BookKind, BookStatus, PosUnit } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { showToast } from '../../utils/toast';
import { Modal } from '../common/Modal';
import { describeSyncError } from '../../utils/apiErrors';
import { BOOK_CHAPTER_EDITOR_OWNED_META_KEYS } from '../../utils/metaCodecs';
import { CHAPTER_MAX_LENGTH, withChapterKey } from '../../utils/chapterFormat';
import { isArchived } from '../../utils/archive';
import { navigateTo } from '../../utils/navigation';
import { useArchiveActions } from '../../hooks/useArchiveActions';
import { BTN_TERTIARY } from '../common/uiClasses';

export interface EditBookModalProps {
  book: Book | null;
  onClose: () => void;
}

export const EditBookModal: React.FC<EditBookModalProps> = ({ book, onClose }) => {
  const { updateBook } = usePragya();
  const { archiveBook } = useArchiveActions();
  const [archiving, setArchiving] = useState(false);

  // C1.1: archive the book as stored (unsaved form edits are discarded with the modal).
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
    setCurrentChapter(typeof book.meta?.currentChapter === 'string' ? book.meta.currentChapter : '');
    setSubmitting(false);
  }, [book]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!book) return;
    if (!title.trim()) {
      showToast('Title cannot be empty', 'error');
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
            updatedAt: nowIso,
          },
        },
        {
          // B4.1: the base is the snapshot taken when this modal opened, so a background
          // sync that loaded a newer remote row surfaces a conflict instead of a silent clobber.
          expectedBaseUpdatedAt: book.meta.updatedAt,
          ownedMetaKeys: BOOK_CHAPTER_EDITOR_OWNED_META_KEYS,
          baseMeta: book.meta,
        }
      );
      showToast(`Updated "${title.trim()}"`, 'success');
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? describeSyncError(err) : 'Failed to update book', 'error');
    } finally {
      setSubmitting(false);
    }
  };

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
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="p-1.5 rounded-[8px] text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor={fid('title')} className="block text-eyebrow uppercase text-muted-foreground">Title *</label>
          <input
            id={fid('title')}
            type="text"
            data-testid="edit-book-title-input"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            required
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor={fid('author')} className="block text-eyebrow uppercase text-muted-foreground">Author</label>
          <input
            id={fid('author')}
            type="text"
            data-testid="edit-book-author-input"
            value={author}
            onChange={e => setAuthor(e.target.value)}
            className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label htmlFor={fid('format')} className="block text-eyebrow uppercase text-muted-foreground">Format</label>
            <select
              id={fid('format')}
              value={format}
              onChange={e => setFormat(e.target.value as BookFormat)}
              className="w-full h-10 px-2.5 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              <option value="physical">Physical</option>
              <option value="kindle">Kindle</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={fid('kind')} className="block text-eyebrow uppercase text-muted-foreground">Kind</label>
            <select
              id={fid('kind')}
              value={kind}
              onChange={e => setKind(e.target.value as BookKind)}
              className="w-full h-10 px-2.5 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              <option value="nonfiction">Non-Fiction</option>
              <option value="fiction">Fiction</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={fid('status')} className="block text-eyebrow uppercase text-muted-foreground">Status</label>
            <select
              id={fid('status')}
              value={status}
              onChange={e => setStatus(e.target.value as BookStatus)}
              className="w-full h-10 px-2.5 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
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
            <label htmlFor={fid('pos')} className="block text-eyebrow uppercase text-muted-foreground">Current Pos</label>
            <input
              id={fid('pos')}
              type="number"
              min="0"
              value={currentPos}
              onChange={e => setCurrentPos(e.target.value)}
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground num focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={fid('total')} className="block text-eyebrow uppercase text-muted-foreground">Total Pos</label>
            <input
              id={fid('total')}
              type="number"
              min="0"
              value={totalPos}
              onChange={e => setTotalPos(e.target.value)}
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground num focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={fid('unit')} className="block text-eyebrow uppercase text-muted-foreground">Unit</label>
            <select
              id={fid('unit')}
              value={posUnit}
              onChange={e => setPosUnit(e.target.value as PosUnit)}
              className="w-full h-10 px-2.5 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              <option value="page">Page</option>
              <option value="percent">Percent (%)</option>
              <option value="loc">Kindle Loc</option>
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={fid('chapter')} className="block text-eyebrow uppercase text-muted-foreground">
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
            className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <p id={fid('chapter-help')} className="text-label text-faint">
            Shown on your Shelf and suggested for new notes at your bookmark.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={fid('docurl')} className="block text-eyebrow uppercase text-muted-foreground">
            Companion Google Doc URL
          </label>
          <input
            id={fid('docurl')}
            type="url"
            value={docUrl}
            onChange={e => setDocUrl(e.target.value)}
            placeholder="https://docs.google.com/document/d/..."
            className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>

        <div className="flex items-center justify-between gap-2 pt-2">
          <div>
            {!isArchived(book) && (
              <button
                type="button"
                data-testid="archive-book-btn"
                onClick={() => void handleArchive()}
                disabled={submitting || archiving}
                className={`${BTN_TERTIARY} h-10`}
              >
                <Archive className="w-4 h-4" aria-hidden="true" />
                <span>Archive Book</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-[10px] text-body font-medium text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            data-testid="edit-book-submit-btn"
            className="h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {submitting ? 'Saving…' : 'Save Changes'}
          </button>
          </div>
        </div>
      </form>
    </Modal>
  );
};
