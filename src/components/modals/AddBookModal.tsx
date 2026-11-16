import React, { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import type { BookFormat, BookKind, BookStatus, PosUnit } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { showToast } from '../../utils/toast';
import { Modal } from '../common/Modal';

export interface AddBookModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AddBookModal: React.FC<AddBookModalProps> = ({ isOpen, onClose }) => {
  const { addBook } = usePragya();
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [format, setFormat] = useState<BookFormat>('physical');
  const [kind, setKind] = useState<BookKind>('nonfiction');
  const [status, setStatus] = useState<BookStatus>('reading');
  const [currentPos, setCurrentPos] = useState('0');
  const [totalPos, setTotalPos] = useState('');
  const [posUnit, setPosUnit] = useState<PosUnit>('page');
  const [docUrl, setDocUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setTitle('');
    setAuthor('');
    setFormat('physical');
    setKind('nonfiction');
    setStatus('reading');
    setCurrentPos('0');
    setTotalPos('');
    setPosUnit('page');
    setDocUrl('');
    setSubmitting(false);
  }, [isOpen]);

  const handleUnitChange = (nextUnit: PosUnit) => {
    setPosUnit(nextUnit);
    if (nextUnit === 'percent' && !totalPos) {
      setTotalPos('100');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      showToast('Please enter a book title', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const parsedCurrent = Math.max(0, Number(currentPos) || 0);
      const parsedTotal =
        posUnit === 'percent' && !totalPos
          ? 100
          : Math.max(0, Number(totalPos) || 0);
      await addBook({
        title,
        author: author.trim() || 'Unknown Author',
        format,
        kind,
        status,
        currentPos: parsedCurrent,
        totalPos: parsedTotal,
        posUnit,
        docUrl,
      });
      showToast(`Added "${title.trim()}"`, 'success');
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to add book', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      dataTestId="add-book-modal"
      title="Add Book"
      headingId={fid('heading')}
    >
      <div className="flex items-center justify-between mb-4">
        <h2 id={fid('heading')} className="text-title text-foreground">
          Add Book
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
            data-testid="book-title-input"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Designing Data-Intensive Applications"
            className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
            required
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor={fid('author')} className="block text-eyebrow uppercase text-muted-foreground">Author</label>
          <input
            id={fid('author')}
            type="text"
            data-testid="book-author-input"
            value={author}
            onChange={e => setAuthor(e.target.value)}
            placeholder="e.g. Martin Kleppmann"
            className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label htmlFor={fid('format')} className="block text-eyebrow uppercase text-muted-foreground">Format</label>
            <select
              id={fid('format')}
              data-testid="book-format-select"
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
              data-testid="book-kind-select"
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
              data-testid="book-status-select"
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
              data-testid="book-pos-input"
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
              data-testid="book-total-input"
              value={totalPos}
              onChange={e => setTotalPos(e.target.value)}
              placeholder="e.g. 320"
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground num placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={fid('unit')} className="block text-eyebrow uppercase text-muted-foreground">Unit</label>
            <select
              id={fid('unit')}
              data-testid="book-unit-select"
              value={posUnit}
              onChange={e => handleUnitChange(e.target.value as PosUnit)}
              className="w-full h-10 px-2.5 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              <option value="page">Page</option>
              <option value="percent">Percent (%)</option>
              <option value="loc">Kindle Loc</option>
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={fid('docurl')} className="block text-eyebrow uppercase text-muted-foreground">
            Companion Google Doc URL (Optional)
          </label>
          <input
            id={fid('docurl')}
            type="url"
            data-testid="book-docurl-input"
            value={docUrl}
            onChange={e => setDocUrl(e.target.value)}
            placeholder="https://docs.google.com/document/d/..."
            className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
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
            data-testid="book-submit-btn"
            className="h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {submitting ? 'Adding…' : 'Add Book'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
