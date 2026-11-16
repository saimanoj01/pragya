import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FileText,
  Image as ImageIcon,
  Link2,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react';
import type { Attachment, DeltaStatus, Note, NoteStatus } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import {
  formatWhenDoDisplay,
  normalizeDeltaAction,
  normalizeDeltaTrigger,
} from '../../utils/deltaFormat';
import {
  clearDraft,
  getEditNoteDraftKey,
  isNoteDraftStale,
  readDraft,
  writeDraft,
  type EditNoteDraft,
} from '../../utils/draftStorage';
import { clampNotePos } from '../../utils/positionClamp';
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
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const titleId = `${baseId}-title`;
  const slugId = `${baseId}-slug`;
  const posId = `${baseId}-pos`;
  const statusId = `${baseId}-status`;
  const tagsId = `${baseId}-tags`;
  const predictionId = `${baseId}-prediction`;
  const quoteId = `${baseId}-quote`;
  const takeawayId = `${baseId}-takeaway`;
  const contextId = `${baseId}-context`;
  const triggerId = `${baseId}-trigger`;
  const actionId = `${baseId}-action`;
  const deltaStatusId = `${baseId}-delta-status`;
  const critiqueId = `${baseId}-critique`;

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
  const [draftRestored, setDraftRestored] = useState(false);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState('');

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
  const submittedOrDiscardedRef = useRef(false);
  const canonicalRef = useRef({
    title: '',
    slug: '',
    pos: '0',
    status: 'saved' as NoteStatus,
    quote: '',
    takeaway: '',
    tagsRaw: '',
    isPrediction: false,
    contextMechanism: '',
    critique: '',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none' as DeltaStatus,
  });

  const isDirty = useMemo(() => {
    const c = canonicalRef.current;
    return (
      title !== c.title ||
      slug !== c.slug ||
      pos !== c.pos ||
      status !== c.status ||
      quote !== c.quote ||
      takeaway !== c.takeaway ||
      tagsRaw !== c.tagsRaw ||
      isPrediction !== c.isPrediction ||
      contextMechanism !== c.contextMechanism ||
      critique !== c.critique ||
      deltaTrigger !== c.deltaTrigger ||
      deltaAction !== c.deltaAction ||
      deltaStatus !== c.deltaStatus
    );
  }, [
    title,
    slug,
    pos,
    status,
    quote,
    takeaway,
    tagsRaw,
    isPrediction,
    contextMechanism,
    critique,
    deltaTrigger,
    deltaAction,
    deltaStatus,
  ]);

  const draftStateRef = useRef<{
    key: string;
    isDirty: boolean;
    payload: EditNoteDraft;
  }>({
    key: '',
    isDirty: false,
    payload: {
      baseUpdatedAt: '',
      title: '',
      slug: '',
      pos: '0',
      status: 'saved',
      quote: '',
      takeaway: '',
      tagsRaw: '',
      isPrediction: false,
      contextMechanism: '',
      critique: '',
      deltaTrigger: '',
      deltaAction: '',
      deltaStatus: 'none',
      savedAt: '',
    },
  });
  draftStateRef.current = {
    key: note ? getEditNoteDraftKey(note.id) : '',
    isDirty,
    payload: {
      baseUpdatedAt: baseUpdatedAt || note?.updatedAt || '',
      title,
      slug,
      pos,
      status,
      quote,
      takeaway,
      tagsRaw,
      isPrediction,
      contextMechanism,
      critique,
      deltaTrigger,
      deltaAction,
      deltaStatus,
      savedAt: new Date().toISOString(),
    },
  };

  useEffect(() => {
    if (!isOpen || !note) {
      if (wasOpenRef.current && draftStateRef.current.key && !submittedOrDiscardedRef.current) {
        if (draftStateRef.current.isDirty) {
          writeDraft(draftStateRef.current.key, draftStateRef.current.payload);
        } else {
          clearDraft(draftStateRef.current.key);
        }
      }
      wasOpenRef.current = false;
      initializedIdRef.current = null;
      submittedOrDiscardedRef.current = false;
      return;
    }
    if (wasOpenRef.current && initializedIdRef.current === note.id) {
      return;
    }
    wasOpenRef.current = true;
    initializedIdRef.current = note.id;
    submittedOrDiscardedRef.current = false;

    const formattedDelta = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);
    const canonical = {
      title: note.meta?.title || '',
      slug: note.slug,
      pos: String(note.pos),
      status: note.status,
      quote: note.quote || '',
      takeaway: note.takeaway || '',
      tagsRaw: serializeTagsCsv(note.tags || []),
      isPrediction: Boolean(note.meta?.isPrediction),
      contextMechanism: note.contextMechanism || '',
      critique: note.critique || '',
      deltaTrigger: formattedDelta.triggerBody,
      deltaAction: formattedDelta.actionBody,
      deltaStatus: (note.deltaStatus || 'none') as DeltaStatus,
    };
    canonicalRef.current = canonical;
    setBaseUpdatedAt(note.updatedAt);

    const draftKey = getEditNoteDraftKey(note.id);
    const savedDraft = readDraft<EditNoteDraft>(draftKey);
    if (savedDraft && isNoteDraftStale(savedDraft.baseUpdatedAt, note.updatedAt)) {
      clearDraft(draftKey);
    }

    const validDraft =
      savedDraft && !isNoteDraftStale(savedDraft.baseUpdatedAt, note.updatedAt) ? savedDraft : null;
    const draftHasEdits =
      validDraft &&
      (validDraft.title !== canonical.title ||
        validDraft.slug !== canonical.slug ||
        validDraft.pos !== canonical.pos ||
        validDraft.status !== canonical.status ||
        validDraft.quote !== canonical.quote ||
        validDraft.takeaway !== canonical.takeaway ||
        validDraft.tagsRaw !== canonical.tagsRaw ||
        validDraft.isPrediction !== canonical.isPrediction ||
        validDraft.contextMechanism !== canonical.contextMechanism ||
        validDraft.critique !== canonical.critique ||
        validDraft.deltaTrigger !== canonical.deltaTrigger ||
        validDraft.deltaAction !== canonical.deltaAction ||
        validDraft.deltaStatus !== canonical.deltaStatus);

    if (validDraft && draftHasEdits) {
      setTitle(validDraft.title);
      setSlug(validDraft.slug);
      setPos(validDraft.pos);
      setStatus(validDraft.status);
      setQuote(validDraft.quote);
      setTakeaway(validDraft.takeaway);
      setTagsRaw(validDraft.tagsRaw);
      setIsPrediction(Boolean(validDraft.isPrediction));
      setContextMechanism(validDraft.contextMechanism);
      setCritique(validDraft.critique);
      setDeltaTrigger(validDraft.deltaTrigger);
      setDeltaAction(validDraft.deltaAction);
      setDeltaStatus(validDraft.deltaStatus || 'none');
      setDraftRestored(true);
    } else {
      setTitle(canonical.title);
      setSlug(canonical.slug);
      setPos(canonical.pos);
      setStatus(canonical.status);
      setQuote(canonical.quote);
      setTakeaway(canonical.takeaway);
      setTagsRaw(canonical.tagsRaw);
      setIsPrediction(canonical.isPrediction);
      setContextMechanism(canonical.contextMechanism);
      setCritique(canonical.critique);
      setDeltaTrigger(canonical.deltaTrigger);
      setDeltaAction(canonical.deltaAction);
      setDeltaStatus(canonical.deltaStatus);
      setDraftRestored(false);
    }

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

  // Debounced (250ms) draft autosave
  useEffect(() => {
    if (!isOpen || !note || !wasOpenRef.current) return;
    if (isDirty) {
      submittedOrDiscardedRef.current = false;
    }
    const key = getEditNoteDraftKey(note.id);
    const timer = window.setTimeout(() => {
      if (draftStateRef.current.isDirty) {
        writeDraft(key, draftStateRef.current.payload);
      } else {
        clearDraft(key);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    isOpen,
    note,
    isDirty,
    title,
    slug,
    pos,
    status,
    quote,
    takeaway,
    tagsRaw,
    isPrediction,
    contextMechanism,
    critique,
    deltaTrigger,
    deltaAction,
    deltaStatus,
  ]);

  useEffect(() => {
    if (!isOpen || !isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (draftStateRef.current.key && draftStateRef.current.isDirty) {
        writeDraft(draftStateRef.current.key, draftStateRef.current.payload);
      }
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isOpen, isDirty]);

  const handleDiscardDraft = () => {
    if (!note) return;
    submittedOrDiscardedRef.current = true;
    clearDraft(getEditNoteDraftKey(note.id));
    const c = canonicalRef.current;
    setTitle(c.title);
    setSlug(c.slug);
    setPos(c.pos);
    setStatus(c.status);
    setQuote(c.quote);
    setTakeaway(c.takeaway);
    setTagsRaw(c.tagsRaw);
    setIsPrediction(c.isPrediction);
    setContextMechanism(c.contextMechanism);
    setCritique(c.critique);
    setDeltaTrigger(c.deltaTrigger);
    setDeltaAction(c.deltaAction);
    setDeltaStatus(c.deltaStatus);
    setDraftRestored(false);
  };

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

    const posChanged = Number(pos) !== Number(note.pos);
    const parsedPos = posChanged && book ? clampNotePos(pos, book) : Math.max(0, Number(pos) || 0);
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

      const saved = await updateNote(
        {
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
        },
        { expectedBaseUpdatedAt: baseUpdatedAt || note.updatedAt }
      );

      submittedOrDiscardedRef.current = true;
      clearDraft(getEditNoteDraftKey(note.id));
      setDraftRestored(false);
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
      headingId={headingId}
      maxWidth="max-w-2xl"
    >
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 id={headingId} className="text-title text-foreground">
            Edit Note
          </h2>
          {book && <p className="text-label text-muted-foreground truncate">{book.title}</p>}
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

      {draftRestored && (
        <div
          data-testid="draft-restored-banner"
          className="mb-4 px-3 py-2 rounded-[10px] bg-surface2 border border-border flex items-center justify-between gap-2 text-label"
        >
          <span className="text-foreground">Draft restored from earlier session</span>
          <button
            type="button"
            data-testid="draft-discard-btn"
            onClick={handleDiscardDraft}
            className="inline-flex items-center gap-1 font-semibold text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Discard</span>
          </button>
        </div>
      )}

      <form onSubmit={e => void handleSubmit(e)} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor={titleId} className="block text-eyebrow uppercase text-muted-foreground">
              Title
            </label>
            <input
              id={titleId}
              type="text"
              data-testid="edit-note-title-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Optional note title..."
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={slugId} className="block text-eyebrow uppercase text-muted-foreground">
              Slug
            </label>
            <input
              id={slugId}
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
            <label htmlFor={posId} className="block text-eyebrow uppercase text-muted-foreground">
              Position ({(book?.posUnit || 'page').toUpperCase()})
            </label>
            <input
              id={posId}
              type="number"
              min="0"
              data-testid="edit-note-pos-input"
              value={pos}
              onChange={e => setPos(e.target.value)}
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground num focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={statusId}
              className="block text-eyebrow uppercase text-muted-foreground"
            >
              Status
            </label>
            <select
              id={statusId}
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
            <label htmlFor={tagsId} className="block text-eyebrow uppercase text-muted-foreground">
              Tags (CSV)
            </label>
            <input
              id={tagsId}
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
          <label
            htmlFor={predictionId}
            className="inline-flex items-center gap-2 text-body text-foreground cursor-pointer select-none"
          >
            <input
              id={predictionId}
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
          <label htmlFor={quoteId} className="block text-eyebrow uppercase text-muted-foreground">
            Verbatim Quote
          </label>
          <textarea
            id={quoteId}
            rows={2}
            data-testid="edit-note-quote-input"
            value={quote}
            onChange={e => setQuote(e.target.value)}
            className="w-full p-3 rounded-[10px] bg-surface2/50 border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          />
        </div>

        <div className="space-y-1.5 relative">
          <label
            htmlFor={takeawayId}
            className="block text-eyebrow uppercase text-muted-foreground"
          >
            Core Takeaway / Why I Liked It (supports [[wikilinks]])
          </label>
          <textarea
            id={takeawayId}
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
          <label
            htmlFor={contextId}
            className="block text-eyebrow uppercase text-muted-foreground"
          >
            Context &amp; Mechanism (supports [[wikilinks]])
          </label>
          <textarea
            id={contextId}
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
              <label
                htmlFor={triggerId}
                className="block text-[11px] font-semibold uppercase text-muted-foreground"
              >
                WHEN Trigger
              </label>
              <input
                id={triggerId}
                type="text"
                data-testid="edit-note-trigger-input"
                value={deltaTrigger}
                onChange={e => setDeltaTrigger(e.target.value)}
                className="w-full h-9 px-3 rounded-[8px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor={actionId}
                className="block text-[11px] font-semibold uppercase text-muted-foreground"
              >
                DO Action
              </label>
              <input
                id={actionId}
                type="text"
                data-testid="edit-note-action-input"
                value={deltaAction}
                onChange={e => setDeltaAction(e.target.value)}
                className="w-full h-9 px-3 rounded-[8px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor={deltaStatusId} className="sr-only">
              Delta Status
            </label>
            <select
              id={deltaStatusId}
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
          <label
            htmlFor={critiqueId}
            className="block text-eyebrow uppercase text-muted-foreground"
          >
            Critique &amp; Boundary Conditions (supports [[wikilinks]])
          </label>
          <textarea
            id={critiqueId}
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
                aria-label="Upload image attachment"
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
                aria-label="Attachment URL"
                value={draftUrl}
                onChange={e => setDraftUrl(e.target.value)}
                placeholder="https://..."
                className="flex-1 h-9 px-3 rounded-[8px] bg-background border border-input text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              <input
                type="text"
                aria-label="Attachment title"
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
