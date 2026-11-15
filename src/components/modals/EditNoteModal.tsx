import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FileText,
  Image as ImageIcon,
  Link2,
  Loader2,
  X,
} from 'lucide-react';
import type { Attachment, DeltaStatus, Note, NoteStatus } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import {
  formatWhenDoDisplay,
  normalizeDeltaAction,
  normalizeDeltaTrigger,
} from '../../utils/deltaFormat';
import { createUuid } from '../../utils/sessionCoalesce';
import { parseTagsCsv, serializeTagsCsv } from '../../utils/sheetCodecs';
import { computeNormalizedPos } from '../../utils/spoilerMath';
import { generateUniqueSlug } from '../../utils/wikilinks';
import { showToast } from '../../utils/toast';
import { DriveImage } from '../common/DriveImage';
import { Modal } from '../common/Modal';
import { WikilinkAutocomplete } from '../common/WikilinkAutocomplete';

export interface EditNoteModalProps {
  note: Note | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (savedNote: Note) => void;
}

const DOC_URL_REGEX = /https?:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/i;
const HTTP_URL_REGEX = /^https?:\/\/\S+$/i;

export const EditNoteModal: React.FC<EditNoteModalProps> = ({
  note,
  isOpen,
  onClose,
  onSaved,
}) => {
  const { books, notes, updateNote, uploadImageAttachment, resolveDocTitle } = usePragya();

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [pos, setPos] = useState('0');
  const [status, setStatus] = useState<NoteStatus>('saved');
  const [quote, setQuote] = useState('');
  const [takeaway, setTakeaway] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [isPrediction, setIsPrediction] = useState(false);
  const [contextMechanism, setContextMechanism] = useState('');
  const [critique, setCritique] = useState('');
  const [deltaTrigger, setDeltaTrigger] = useState('');
  const [deltaAction, setDeltaAction] = useState('');
  const [deltaStatus, setDeltaStatus] = useState<DeltaStatus>('none');
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const [attachMode, setAttachMode] = useState<'none' | 'doc' | 'link'>('none');
  const [draftUrl, setDraftUrl] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [takeawayCursor, setTakeawayCursor] = useState<number | null>(null);
  const [contextCursor, setContextCursor] = useState<number | null>(null);
  const [critiqueCursor, setCritiqueCursor] = useState<number | null>(null);

  const takeawayRef = useRef<HTMLTextAreaElement>(null);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  const critiqueRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const wasOpenRef = useRef(false);
  const initializedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen || !note) {
      wasOpenRef.current = false;
      initializedIdRef.current = null;
      return;
    }
    if (wasOpenRef.current && initializedIdRef.current === note.id) {
      return;
    }
    wasOpenRef.current = true;
    initializedIdRef.current = note.id;

    const formattedDelta = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);
    setTitle(note.meta?.title || '');
    setSlug(note.slug);
    setPos(String(note.pos));
    setStatus(note.status);
    setQuote(note.quote || '');
    setTakeaway(note.takeaway || '');
    setTagsRaw(serializeTagsCsv(note.tags || []));
    setIsPrediction(Boolean(note.meta?.isPrediction));
    setContextMechanism(note.contextMechanism || '');
    setCritique(note.critique || '');
    setDeltaTrigger(formattedDelta.triggerBody);
    setDeltaAction(formattedDelta.actionBody);
    setDeltaStatus(note.deltaStatus || 'none');
    setAttachments(note.meta?.attachments || []);
    setAttachMode('none');
    setDraftUrl('');
    setDraftTitle('');
    setTakeawayCursor(null);
    setContextCursor(null);
    setCritiqueCursor(null);
    setUploadingImage(false);
    setSubmitting(false);
  }, [isOpen, note]);

  const book = useMemo(
    () => (note ? books.find(b => b.id === note.bookId) || null : null),
    [books, note]
  );

  const otherActiveCount = useMemo(() => {
    if (!note) return 0;
    return notes.filter(n => n.id !== note.id && n.deltaStatus === 'active').length;
  }, [note, notes]);

  const isDeltaCapViolation = otherActiveCount >= 5 && deltaStatus === 'active';

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
        const isTypingInInput =
          active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
        if (!isTypingInInput) {
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note) return;

    if (isDeltaCapViolation) {
      showToast(
        'Active Behavioral Delta cap (5/5) reached. Graduate or pause an active delta first.',
        'error'
      );
      return;
    }

    const normalizedTrigger = normalizeDeltaTrigger(deltaTrigger);
    const normalizedAction = normalizeDeltaAction(deltaAction);
    if (deltaStatus === 'active' && !normalizedTrigger && !normalizedAction) {
      showToast('Enter a WHEN trigger or DO action to keep a delta active.', 'error');
      return;
    }

    const parsedPos = Math.max(0, Number(pos) || 0);
    const normalizedPos = book
      ? computeNormalizedPos(parsedPos, book.totalPos, book.posUnit)
      : note.normalizedPos;

    setSubmitting(true);
    try {
      const nextSlug = generateUniqueSlug(
        slug.trim() || title.trim() || note.slug,
        notes.map(n => n.slug),
        note.slug
      );

      const saved = await updateNote({
        ...note,
        slug: nextSlug,
        pos: parsedPos,
        normalizedPos,
        status,
        tags: parseTagsCsv(tagsRaw),
        quote: quote.trim(),
        takeaway: takeaway.trim(),
        contextMechanism: contextMechanism.trim(),
        critique: critique.trim(),
        deltaTrigger: normalizedTrigger,
        deltaAction: normalizedAction,
        deltaStatus,
        meta: {
          ...note.meta,
          ...(title.trim() ? { title: title.trim() } : { title: undefined }),
          attachments: attachments.slice(0, 3),
          ...(book?.kind === 'fiction' ? { isPrediction } : {}),
        },
      });

      showToast('Note updated', 'success');
      onSaved?.(saved);
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update note', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!note) return null;

  const atLimit = attachments.length >= 3;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      dataTestId="edit-note-modal"
      title="Edit Note"
      maxWidth="max-w-2xl"
    >
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-title text-foreground">Edit Note</h2>
          {book && (
            <p className="text-label text-muted-foreground truncate">{book.title}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="p-1.5 rounded-[8px] text-muted-foreground hover:text-foreground hover:bg-surface2 shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={e => void handleSubmit(e)} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Title</label>
            <input
              type="text"
              data-testid="edit-note-title-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Optional note title..."
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Slug</label>
            <input
              type="text"
              data-testid="edit-note-slug-input"
              value={slug}
              onChange={e => setSlug(e.target.value)}
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input font-mono text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">
              Position ({(book?.posUnit || 'page').toUpperCase()})
            </label>
            <input
              type="number"
              min="0"
              data-testid="edit-note-pos-input"
              value={pos}
              onChange={e => setPos(e.target.value)}
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground num focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Status</label>
            <select
              data-testid="edit-note-status-select"
              value={status}
              onChange={e => setStatus(e.target.value as NoteStatus)}
              className="w-full h-10 px-2.5 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              <option value="saved">Saved</option>
              <option value="inbox">Inbox (To Spar)</option>
              <option value="in-reflection">In Reflection</option>
              <option value="atomic">Atomic</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-eyebrow uppercase text-muted-foreground">Tags (CSV)</label>
            <input
              type="text"
              data-testid="edit-note-tags-input"
              value={tagsRaw}
              onChange={e => setTagsRaw(e.target.value)}
              placeholder="#systems, #favorites"
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>
        </div>

        {book?.kind === 'fiction' && (
          <label className="inline-flex items-center gap-2 text-body text-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="edit-note-prediction-checkbox"
              checked={isPrediction}
              onChange={e => setIsPrediction(e.target.checked)}
              className="w-4 h-4 rounded border-input accent-primary"
            />
            <span>Fiction Prediction</span>
          </label>
        )}

        <div className="space-y-1.5">
          <label className="block text-eyebrow uppercase text-muted-foreground">
            Verbatim Quote
          </label>
          <textarea
            rows={2}
            data-testid="edit-note-quote-input"
            value={quote}
            onChange={e => setQuote(e.target.value)}
            className="w-full p-3 rounded-[10px] bg-surface2/50 border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          />
        </div>

        <div className="space-y-1.5 relative">
          <label className="block text-eyebrow uppercase text-muted-foreground">
            Core Takeaway / Why I Liked It (supports [[wikilinks]])
          </label>
          <textarea
            ref={takeawayRef}
            rows={3}
            data-testid="edit-note-takeaway-input"
            value={takeaway}
            onChange={e => {
              setTakeaway(e.target.value);
              setTakeawayCursor(e.target.selectionStart);
            }}
            onClick={e => setTakeawayCursor(e.currentTarget.selectionStart)}
            onKeyUp={e => setTakeawayCursor(e.currentTarget.selectionStart)}
            onBlur={() => setTakeawayCursor(null)}
            className="w-full p-3 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          />
          <WikilinkAutocomplete
            textareaRef={takeawayRef}
            value={takeaway}
            cursorPos={takeawayCursor}
            notes={notes}
            excludeNoteId={note.id}
            excludeSlug={note.slug}
            onSelect={(nextVal, nextCursor) => {
              setTakeaway(nextVal);
              setTakeawayCursor(nextCursor);
            }}
          />
        </div>

        <div className="space-y-1.5 relative">
          <label className="block text-eyebrow uppercase text-muted-foreground">
            Context &amp; Mechanism (supports [[wikilinks]])
          </label>
          <textarea
            ref={contextRef}
            rows={2}
            data-testid="edit-note-context-input"
            value={contextMechanism}
            onChange={e => {
              setContextMechanism(e.target.value);
              setContextCursor(e.target.selectionStart);
            }}
            onClick={e => setContextCursor(e.currentTarget.selectionStart)}
            onKeyUp={e => setContextCursor(e.currentTarget.selectionStart)}
            onBlur={() => setContextCursor(null)}
            className="w-full p-3 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          />
          <WikilinkAutocomplete
            textareaRef={contextRef}
            value={contextMechanism}
            cursorPos={contextCursor}
            notes={notes}
            excludeNoteId={note.id}
            excludeSlug={note.slug}
            onSelect={(nextVal, nextCursor) => {
              setContextMechanism(nextVal);
              setContextCursor(nextCursor);
            }}
          />
        </div>

        {/* Delta Fields */}
        <div className="rounded-[12px] bg-surface2/50 border border-border p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-[11px] font-semibold uppercase text-muted-foreground">
                WHEN Trigger
              </label>
              <input
                type="text"
                data-testid="edit-note-trigger-input"
                value={deltaTrigger}
                onChange={e => setDeltaTrigger(e.target.value)}
                className="w-full h-9 px-3 rounded-[8px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[11px] font-semibold uppercase text-muted-foreground">
                DO Action
              </label>
              <input
                type="text"
                data-testid="edit-note-action-input"
                value={deltaAction}
                onChange={e => setDeltaAction(e.target.value)}
                className="w-full h-9 px-3 rounded-[8px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select
              data-testid="edit-note-delta-status-select"
              value={deltaStatus}
              onChange={e => setDeltaStatus(e.target.value as DeltaStatus)}
              className="h-9 px-2.5 rounded-[8px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              <option value="none">None</option>
              <option value="active">Active (Practice)</option>
              <option value="paused">Paused</option>
              <option value="graduated">Graduated</option>
            </select>
            <span className="text-[11px] text-muted-foreground num">
              Other active deltas: {otherActiveCount}/5
            </span>
          </div>

          {isDeltaCapViolation && (
            <div
              data-testid="deepen-delta-cap-warning"
              className="rounded-[10px] bg-negative/10 border border-negative/30 px-3 py-2 flex items-start gap-2 text-label text-negative"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Active Behavioral Delta cap (5/5) reached.</span>
            </div>
          )}
        </div>

        <div className="space-y-1.5 relative">
          <label className="block text-eyebrow uppercase text-muted-foreground">
            Critique &amp; Boundary Conditions (supports [[wikilinks]])
          </label>
          <textarea
            ref={critiqueRef}
            rows={2}
            data-testid="edit-note-critique-input"
            value={critique}
            onChange={e => {
              setCritique(e.target.value);
              setCritiqueCursor(e.target.selectionStart);
            }}
            onClick={e => setCritiqueCursor(e.currentTarget.selectionStart)}
            onKeyUp={e => setCritiqueCursor(e.currentTarget.selectionStart)}
            onBlur={() => setCritiqueCursor(null)}
            className="w-full p-3 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          />
          <WikilinkAutocomplete
            textareaRef={critiqueRef}
            value={critique}
            cursorPos={critiqueCursor}
            notes={notes}
            excludeNoteId={note.id}
            excludeSlug={note.slug}
            onSelect={(nextVal, nextCursor) => {
              setCritique(nextVal);
              setCritiqueCursor(nextCursor);
            }}
          />
        </div>

        {/* Attachments Manager */}
        <div className="space-y-2 pt-2 border-t border-border/60">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-eyebrow uppercase text-muted-foreground num">
              Attachments ({attachments.length}/3)
            </span>

            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) void handleImageFile(file);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                disabled={atLimit || uploadingImage}
                onClick={() => fileInputRef.current?.click()}
                className="h-8 px-2.5 rounded-[8px] border border-border bg-surface2/60 hover:bg-surface2 text-label font-medium text-foreground inline-flex items-center gap-1.5 disabled:opacity-40"
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
                disabled={atLimit}
                onClick={() => {
                  setAttachMode(prev => (prev === 'doc' ? 'none' : 'doc'));
                  setDraftUrl('');
                  setDraftTitle('');
                }}
                className="h-8 px-2.5 rounded-[8px] border border-border bg-surface2/60 hover:bg-surface2 text-label font-medium text-foreground inline-flex items-center gap-1.5 disabled:opacity-40"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Doc</span>
              </button>
              <button
                type="button"
                disabled={atLimit}
                onClick={() => {
                  setAttachMode(prev => (prev === 'link' ? 'none' : 'link'));
                  setDraftUrl('');
                  setDraftTitle('');
                }}
                className="h-8 px-2.5 rounded-[8px] border border-border bg-surface2/60 hover:bg-surface2 text-label font-medium text-foreground inline-flex items-center gap-1.5 disabled:opacity-40"
              >
                <Link2 className="w-3.5 h-3.5" />
                <span>Link</span>
              </button>
            </div>
          </div>

          {attachMode !== 'none' && (
            <div className="p-3 rounded-[10px] bg-surface2/50 border border-border flex flex-col sm:flex-row gap-2">
              <input
                type="url"
                value={draftUrl}
                onChange={e => setDraftUrl(e.target.value)}
                placeholder="https://..."
                className="flex-1 h-9 px-3 rounded-[8px] bg-background border border-input text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              <input
                type="text"
                value={draftTitle}
                onChange={e => setDraftTitle(e.target.value)}
                placeholder="Title (optional)"
                className="sm:w-36 h-9 px-3 rounded-[8px] bg-background border border-input text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              <button
                type="button"
                onClick={() => {
                  void attachUrl(draftUrl, draftTitle).then(ok => {
                    if (ok) {
                      setAttachMode('none');
                      setDraftUrl('');
                      setDraftTitle('');
                    }
                  });
                }}
                className="h-9 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold whitespace-nowrap"
              >
                Attach
              </button>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="space-y-1.5">
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
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${att.type === 'image' ? att.fileName : att.title}`}
                    onClick={() => setAttachments(prev => prev.filter(a => a.id !== att.id))}
                    className="p-1 text-muted-foreground hover:text-negative shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-[10px] text-body font-medium text-muted-foreground hover:text-foreground hover:bg-surface2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || uploadingImage}
            data-testid="edit-note-submit-btn"
            className="h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
