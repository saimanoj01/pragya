import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Link2, Loader2, X } from 'lucide-react';
import type { Attachment } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { createUuid } from '../../utils/sessionCoalesce';
import { parseTagsCsv } from '../../utils/sheetCodecs';
import { showToast } from '../../utils/toast';
import { DriveImage } from '../common/DriveImage';
import { Modal } from '../common/Modal';

export interface QuickCaptureModalProps {
  isOpen: boolean;
  initialBookId?: string | null;
  onClose: () => void;
}

const DOC_URL_REGEX = /https?:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/i;
const HTTP_URL_REGEX = /^https?:\/\/\S+$/i;

export const QuickCaptureModal: React.FC<QuickCaptureModalProps> = ({
  isOpen,
  initialBookId,
  onClose,
}) => {
  const { books, captureNote, uploadImageAttachment, resolveDocTitle } = usePragya();

  const defaultBookId = useMemo(() => {
    if (initialBookId && books.some(b => b.id === initialBookId)) return initialBookId;
    return books.find(b => b.status === 'reading')?.id || books[0]?.id || '';
  }, [books, initialBookId]);

  const [bookId, setBookId] = useState(defaultBookId);
  const [pos, setPos] = useState('0');
  const [quote, setQuote] = useState('');
  const [takeaway, setTakeaway] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [sparLater, setSparLater] = useState(false);
  const [isPrediction, setIsPrediction] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [attachMode, setAttachMode] = useState<'none' | 'doc' | 'link'>('none');
  const [draftUrl, setDraftUrl] = useState('');
  const [draftTitle, setDraftTitle] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = true;

    const chosenId = defaultBookId;
    const chosenBook = books.find(b => b.id === chosenId);
    setBookId(chosenId);
    setPos(chosenBook ? String(chosenBook.currentPos) : '0');
    setQuote('');
    setTakeaway('');
    setTagsRaw('');
    setSparLater(false);
    setIsPrediction(false);
    setAttachments([]);
    setAttachMode('none');
    setDraftUrl('');
    setDraftTitle('');
    setUploadingImage(false);
    setSubmitting(false);
  }, [isOpen, defaultBookId, books]);

  useEffect(() => {
    if (isOpen && !bookId && defaultBookId) {
      const chosenBook = books.find(b => b.id === defaultBookId);
      setBookId(defaultBookId);
      if (chosenBook) {
        setPos(prev => (prev === '0' ? String(chosenBook.currentPos) : prev));
      }
    }
  }, [isOpen, bookId, defaultBookId, books]);

  const selectedBook = useMemo(() => books.find(b => b.id === bookId) || null, [books, bookId]);

  const handleBookChange = (nextId: string) => {
    setBookId(nextId);
    const nextBook = books.find(b => b.id === nextId);
    if (nextBook) {
      setPos(String(nextBook.currentPos));
      if (nextBook.kind !== 'fiction') {
        setIsPrediction(false);
      }
    }
  };

  const attachUrl = useCallback(
    async (rawUrl: string, explicitTitle?: string) => {
      const trimmed = rawUrl.trim();
      if (!trimmed || !HTTP_URL_REGEX.test(trimmed)) {
        showToast('Enter a valid http(s) URL', 'error');
        return false;
      }
      if (attachments.length >= 3) {
        showToast('Maximum 3 attachments per note', 'error');
        return false;
      }

      const docMatch = trimmed.match(DOC_URL_REGEX);
      if (docMatch) {
        const docId = docMatch[1];
        const attId = createUuid();
        const initialTitle = explicitTitle?.trim() || 'Google Doc';
        setAttachments(prev => {
          if (prev.length >= 3) return prev;
          return [
            ...prev,
            {
              id: attId,
              type: 'doc',
              title: initialTitle,
              url: trimmed,
              docId,
            },
          ];
        });

        if (!explicitTitle?.trim()) {
          resolveDocTitle(docId)
            .then(resolved => {
              if (!resolved) return;
              setAttachments(prev =>
                prev.map(a => (a.id === attId && a.type === 'doc' ? { ...a, title: resolved } : a))
              );
            })
            .catch(() => {});
        }
        return true;
      }

      let fallbackTitle = explicitTitle?.trim() || '';
      if (!fallbackTitle) {
        try {
          fallbackTitle = new URL(trimmed).hostname;
        } catch {
          fallbackTitle = trimmed;
        }
      }

      setAttachments(prev => {
        if (prev.length >= 3) return prev;
        return [
          ...prev,
          {
            id: createUuid(),
            type: 'link',
            title: fallbackTitle,
            url: trimmed,
          },
        ];
      });
      return true;
    },
    [attachments.length, resolveDocTitle]
  );

  const handleImageFile = useCallback(
    async (file: File | Blob) => {
      if (attachments.length >= 3) {
        showToast('Maximum 3 attachments per note', 'error');
        return;
      }
      setUploadingImage(true);
      try {
        const uploaded = await uploadImageAttachment(file);
        setAttachments(prev => {
          if (prev.length >= 3) {
            showToast('Maximum 3 attachments per note', 'error');
            return prev;
          }
          return [...prev, uploaded];
        });
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to compress/attach image', 'error');
      } finally {
        setUploadingImage(false);
      }
    },
    [attachments.length, uploadImageAttachment]
  );

  // Global Cmd/Ctrl+V paste inside QuickCaptureModal
  useEffect(() => {
    if (!isOpen) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              void handleImageFile(file);
              return;
            }
          }
        }
      }

      const text = e.clipboardData?.getData('text/plain')?.trim() || '';
      if (text && HTTP_URL_REGEX.test(text)) {
        const active = document.activeElement as HTMLElement | null;
        const testId = active?.getAttribute('data-testid') || '';
        const shouldSkipIntercept =
          testId === 'capture-quote-input' ||
          testId === 'capture-takeaway-input' ||
          testId === 'capture-tags-input' ||
          testId === 'capture-attachment-url-input' ||
          testId === 'capture-attachment-title-input';
        if (!shouldSkipIntercept) {
          e.preventDefault();
          void attachUrl(text).then(ok => {
            if (ok) {
              setAttachMode('none');
              setDraftUrl('');
              setDraftTitle('');
            }
          });
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [attachUrl, handleImageFile, isOpen]);

  const handleAddUrlConfirm = async () => {
    const ok = await attachUrl(draftUrl, draftTitle);
    if (ok) {
      setAttachMode('none');
      setDraftUrl('');
      setDraftTitle('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bookId) {
      showToast('Please add a book first', 'error');
      return;
    }
    if (!takeaway.trim() && !quote.trim() && attachments.length === 0) {
      showToast('Add a personal takeaway, verbatim quote, or attachment', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await captureNote({
        bookId,
        pos: Math.max(0, Number(pos) || 0),
        quote,
        takeaway,
        tags: parseTagsCsv(tagsRaw),
        sparLater,
        isPrediction: selectedBook?.kind === 'fiction' ? isPrediction : false,
        attachments,
      });
      showToast(sparLater ? 'Captured to Sparring Inbox' : 'Note captured', 'success');
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save note', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const atLimit = attachments.length >= 3;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      dataTestId="quick-capture-modal"
      title="Quick Capture"
      maxWidth="max-w-xl"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-lg leading-none" aria-hidden="true">
            🪷
          </span>
          <h2 className="text-title text-foreground">Quick Capture</h2>
        </div>
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2 space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Book</label>
            <select
              data-testid="capture-book-select"
              value={bookId}
              onChange={e => handleBookChange(e.target.value)}
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              {books.map(b => (
                <option key={b.id} value={b.id}>
                  {b.title} ({b.author})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">
              Position ({(selectedBook?.posUnit || 'page').toUpperCase()})
            </label>
            <input
              type="number"
              min="0"
              data-testid="capture-pos-input"
              value={pos}
              onChange={e => setPos(e.target.value)}
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground num focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-eyebrow uppercase text-muted-foreground">
            Verbatim Quote (Optional)
          </label>
          <textarea
            rows={2}
            data-testid="capture-quote-input"
            value={quote}
            onChange={e => setQuote(e.target.value)}
            placeholder="Quotation, excerpt, or dictation..."
            className="w-full p-3 rounded-[10px] bg-surface2/50 border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-eyebrow uppercase text-muted-foreground">
            Why I Liked It / Core Takeaway <span className="text-negative">*</span>
          </label>
          <textarea
            rows={3}
            data-testid="capture-takeaway-input"
            value={takeaway}
            onChange={e => setTakeaway(e.target.value)}
            placeholder="Why this matters, core resonance, or concrete realization in your own words..."
            className="w-full p-3 rounded-[10px] bg-background border border-foreground/30 text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/50 resize-y"
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1 space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Tags (CSV)</label>
            <input
              type="text"
              data-testid="capture-tags-input"
              value={tagsRaw}
              onChange={e => setTagsRaw(e.target.value)}
              placeholder="#systems, #heuristics, #favorites"
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="flex flex-wrap items-center gap-4 pb-2">
            <label className="inline-flex items-center gap-2 text-body text-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="capture-spar-checkbox"
                checked={sparLater}
                onChange={e => setSparLater(e.target.checked)}
                className="w-4 h-4 rounded border-input accent-primary"
              />
              <span>Spar w/ AI later</span>
            </label>

            {selectedBook?.kind === 'fiction' && (
              <label className="inline-flex items-center gap-2 text-body text-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  data-testid="capture-prediction-checkbox"
                  checked={isPrediction}
                  onChange={e => setIsPrediction(e.target.checked)}
                  className="w-4 h-4 rounded border-input accent-primary"
                />
                <span>Fiction Prediction</span>
              </label>
            )}
          </div>
        </div>

        {/* Attachments Bar */}
        <div className="space-y-2 pt-1 border-t border-border/60">
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <span className="text-eyebrow uppercase text-muted-foreground num">
              Attachments ({attachments.length}/3)
            </span>

            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                data-testid="capture-photo-input"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) {
                    void handleImageFile(file);
                  }
                  e.target.value = '';
                }}
              />

              <button
                type="button"
                data-testid="capture-attach-photo-btn"
                disabled={atLimit || uploadingImage}
                onClick={() => fileInputRef.current?.click()}
                className="h-8 px-2.5 rounded-[8px] border border-border bg-surface2/60 hover:bg-surface2 text-label font-medium text-foreground inline-flex items-center gap-1.5 disabled:opacity-40 transition-colors"
              >
                {uploadingImage ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ImageIcon className="w-3.5 h-3.5" />
                )}
                <span>Photo</span>
              </button>

              <button
                type="button"
                data-testid="capture-attach-doc-btn"
                disabled={atLimit}
                onClick={() => {
                  setAttachMode(prev => (prev === 'doc' ? 'none' : 'doc'));
                  setDraftUrl('');
                  setDraftTitle('');
                }}
                className="h-8 px-2.5 rounded-[8px] border border-border bg-surface2/60 hover:bg-surface2 text-label font-medium text-foreground inline-flex items-center gap-1.5 disabled:opacity-40 transition-colors"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Doc</span>
              </button>

              <button
                type="button"
                data-testid="capture-attach-link-btn"
                disabled={atLimit}
                onClick={() => {
                  setAttachMode(prev => (prev === 'link' ? 'none' : 'link'));
                  setDraftUrl('');
                  setDraftTitle('');
                }}
                className="h-8 px-2.5 rounded-[8px] border border-border bg-surface2/60 hover:bg-surface2 text-label font-medium text-foreground inline-flex items-center gap-1.5 disabled:opacity-40 transition-colors"
              >
                <Link2 className="w-3.5 h-3.5" />
                <span>Link</span>
              </button>
            </div>
          </div>

          {attachMode !== 'none' && (
            <div className="p-3 rounded-[10px] bg-surface2/50 border border-border space-y-2">
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="url"
                  data-testid="capture-attachment-url-input"
                  value={draftUrl}
                  onChange={e => setDraftUrl(e.target.value)}
                  placeholder={
                    attachMode === 'doc'
                      ? 'Paste Google Doc URL (https://docs.google.com/document/d/...)'
                      : 'Paste reference URL (https://...)'
                  }
                  className="flex-1 h-9 px-3 rounded-[8px] bg-background border border-input text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
                <input
                  type="text"
                  data-testid="capture-attachment-title-input"
                  value={draftTitle}
                  onChange={e => setDraftTitle(e.target.value)}
                  placeholder="Title (optional)"
                  className="sm:w-40 h-9 px-3 rounded-[8px] bg-background border border-input text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
                <button
                  type="button"
                  data-testid="capture-attachment-confirm-btn"
                  onClick={() => void handleAddUrlConfirm()}
                  className="h-9 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold whitespace-nowrap"
                >
                  Attach
                </button>
              </div>
            </div>
          )}

          {/* Attached Items List */}
          <div data-testid="capture-attachment-list" className="space-y-1.5">
            {attachments.map(att => (
              <div
                key={att.id}
                className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[8px] bg-surface2 border border-border text-label"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {att.type === 'image' ? (
                    <DriveImage
                      attachment={att}
                      className="w-8 h-8 rounded object-cover shrink-0 border border-border"
                    />
                  ) : att.type === 'doc' ? (
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                  ) : (
                    <Link2 className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="truncate font-medium text-foreground">
                    {att.type === 'image' ? att.fileName : att.title}
                  </span>
                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-background text-muted-foreground border border-border shrink-0">
                    {att.type}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => setAttachments(prev => prev.filter(a => a.id !== att.id))}
                  className="p-1 text-muted-foreground hover:text-negative transition-colors shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
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
            disabled={submitting || uploadingImage}
            data-testid="capture-submit-btn"
            className="h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {submitting ? 'Saving…' : 'Save Note'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
