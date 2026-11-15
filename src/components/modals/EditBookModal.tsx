import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Book, BookFormat, BookKind, BookStatus, PosUnit } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { showToast } from '../../utils/toast';
import { Modal } from '../common/Modal';

export interface EditBookModalProps {
  book: Book | null;
  onClose: () => void;
}

export const EditBookModal: React.FC<EditBookModalProps> = ({ book, onClose }) => {
  const { updateBook } = usePragya();

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [format, setFormat] = useState<BookFormat>('physical');
  const [kind, setKind] = useState<BookKind>('nonfiction');
  const [status, setStatus] = useState<BookStatus>('reading');
  const [currentPos, setCurrentPos] = useState('0');
  const [totalPos, setTotalPos] = useState('0');
  const [posUnit, setPosUnit] = useState<PosUnit>('page');
  const [docUrl, setDocUrl] = useState('');
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

      await updateBook({
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
          ...book.meta,
          ...(status === 'reading' && !book.meta.startedAt ? { startedAt: nowIso } : {}),
          ...(status === 'finished' && !book.meta.finishedAt ? { finishedAt: nowIso } : {}),
          updatedAt: nowIso,
        },
      });
      showToast(`Updated "${title.trim()}"`, 'success');
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update book', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={Boolean(book)} onClose={onClose} dataTestId="edit-book-modal" title="Edit Book">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-title text-foreground">Edit Book</h2>
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
          <label className="block text-eyebrow uppercase text-muted-foreground">Title *</label>
          <input
            type="text"
            data-testid="edit-book-title-input"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            required
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-eyebrow uppercase text-muted-foreground">Author</label>
          <input
            type="text"
            data-testid="edit-book-author-input"
            value={author}
            onChange={e => setAuthor(e.target.value)}
            className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Format</label>
            <select
              value={format}
              onChange={e => setFormat(e.target.value as BookFormat)}
              className="w-full h-10 px-2.5 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              <option value="physical">Physical</option>
              <option value="kindle">Kindle</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Kind</label>
            <select
              value={kind}
              onChange={e => setKind(e.target.value as BookKind)}
              className="w-full h-10 px-2.5 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              <option value="nonfiction">Non-Fiction</option>
              <option value="fiction">Fiction</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Status</label>
            <select
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

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Current Pos</label>
            <input
              type="number"
              min="0"
              value={currentPos}
              onChange={e => setCurrentPos(e.target.value)}
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground num focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Total Pos</label>
            <input
              type="number"
              min="0"
              value={totalPos}
              onChange={e => setTotalPos(e.target.value)}
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground num focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Unit</label>
            <select
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
          <label className="block text-eyebrow uppercase text-muted-foreground">
            Companion Google Doc URL
          </label>
          <input
            type="url"
            value={docUrl}
            onChange={e => setDocUrl(e.target.value)}
            placeholder="https://docs.google.com/document/d/..."
            className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
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
      </form>
    </Modal>
  );
};
