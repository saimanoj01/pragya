import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookOpen, FileText, Image as ImageIcon, Link2, Loader2, Plus, RotateCcw, Sparkles, X } from 'lucide-react';
import type { Attachment } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import {
  CAPTURE_DRAFT_KEY,
  clearDraft,
  draftAttachments,
  readDraft,
  writeDraft,
  type CaptureDraft,
} from '../../utils/draftStorage';
import {
  kindleUnitMismatchCopy,
  pickCitationHint,
  stripKindleBoilerplate,
  type KindleHintResult,
} from '../../utils/kindlePaste';
import { isSubmitShortcut, submitShortcutModifierLabel } from '../../utils/keyboard';
import { WikilinkAutocomplete } from '../common/WikilinkAutocomplete';
import {
  CAPTURE_CHAPTER_HINTS,
  CHAPTER_MAX_LENGTH,
  resolveCaptureChapter,
} from '../../utils/chapterFormat';
import { navigateTo } from '../../utils/navigation';
import { withoutArchived } from '../../utils/archive';
import { createUuid } from '../../utils/sessionCoalesce';
import { parseTagsCsv } from '../../utils/sheetCodecs';
import { showToast } from '../../utils/toast';
import { DriveImage } from '../common/DriveImage';
import { Modal } from '../common/Modal';
import { describeSyncError } from '../../utils/apiErrors';

export interface QuickCaptureModalProps {
  isOpen: boolean;
  initialBookId?: string | null;
  /**
   * CD C4.3: 'route' = soft preselect from the page you're on (global capture). A saved
   * draft for another book still restores; 'explicit' (default) = a book's own Capture
   * button, which only restores a draft for that book.
   */
  initialBookSource?: 'explicit' | 'route';
  onClose: () => void;
  onOpenAddBook?: () => void;
}

const DOC_URL_REGEX = /https?:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/i;
const HTTP_URL_REGEX = /^https?:\/\/\S+$/i;

export const QuickCaptureModal: React.FC<QuickCaptureModalProps> = ({
  isOpen,
  initialBookId,
  initialBookSource = 'explicit',
  onClose,
  onOpenAddBook,
}) => {
  const { books: allBooks, notes, captureNote, uploadImageAttachment, resolveDocTitle } = usePragya();
  // C1.1: archived books aren't offered for capture (the CLI refuses them too).
  const books = useMemo(() => withoutArchived(allBooks), [allBooks]);
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const bookFieldId = `${baseId}-book`;
  const posFieldId = `${baseId}-pos`;
  const quoteFieldId = `${baseId}-quote`;
  const takeawayFieldId = `${baseId}-takeaway`;
  const tagsFieldId = `${baseId}-tags`;
  const sparFieldId = `${baseId}-spar`;
  const predFieldId = `${baseId}-pred`;
  const chapterFieldId = `${baseId}-chapter`;
  const titleFieldId = `${baseId}-title`;

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
  // A3.3: chapter inherits the book's currentChapter at the bookmark until typed in.
  const [chapterInput, setChapterInput] = useState('');
  const [chapterTouched, setChapterTouched] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [kindleHint, setKindleHint] = useState<KindleHintResult>(null);
  const [title, setTitle] = useState('');
  const [takeawayCursor, setTakeawayCursor] = useState<number | null>(null);
  // CD C4.4: last cleaned Kindle paste → `Undo` restores the raw paste in that field.
  const [kindleClean, setKindleClean] = useState<{ field: 'quote' | 'takeaway'; rawValue: string } | null>(
    null
  );

  const [attachMode, setAttachMode] = useState<'none' | 'doc' | 'link'>('none');
  const [draftUrl, setDraftUrl] = useState('');
  const [draftTitle, setDraftTitle] = useState('');

  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const takeawayInputRef = useRef<HTMLTextAreaElement>(null);
  const dismissedHintRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);
  const submittedOrDiscardedRef = useRef(false);

  const isDirty = useMemo(
    () =>
      quote.trim() !== '' ||
      takeaway.trim() !== '' ||
      title.trim() !== '' ||
      tagsRaw.trim() !== '' ||
      sparLater ||
      isPrediction ||
      attachments.length > 0 ||
      (chapterTouched && chapterInput.trim() !== ''),
    [attachments.length, chapterInput, chapterTouched, isPrediction, quote, sparLater, tagsRaw, takeaway, title]
  );

  const draftSnapshotRef = useRef<{ isDirty: boolean; payload: CaptureDraft }>({
    isDirty: false,
    payload: {
      bookId: '',
      pos: '0',
      quote: '',
      takeaway: '',
      tagsRaw: '',
      sparLater: false,
      isPrediction: false,
      chapter: '',
      chapterTouched: false,
      title: '',
      attachments: [],
      updatedAt: '',
    },
  });
  draftSnapshotRef.current = {
    isDirty,
    payload: {
      bookId,
      pos,
      quote,
      takeaway,
      tagsRaw,
      sparLater,
      isPrediction,
      chapter: chapterInput,
      chapterTouched,
      title,
      // CD C4.3: references only (Drive file ids / URLs), never blobs.
      attachments,
      updatedAt: new Date().toISOString(),
    },
  };

  useEffect(() => {
    if (!isOpen) {
      if (wasOpenRef.current && !submittedOrDiscardedRef.current) {
        if (draftSnapshotRef.current.isDirty) {
          writeDraft(CAPTURE_DRAFT_KEY, draftSnapshotRef.current.payload);
        } else {
          clearDraft(CAPTURE_DRAFT_KEY);
        }
      }
      wasOpenRef.current = false;
      submittedOrDiscardedRef.current = false;
      return;
    }
    if (wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = true;
    submittedOrDiscardedRef.current = false;

    const chosenId = defaultBookId;
    const chosenBook = books.find(b => b.id === chosenId);
    const savedDraft = readDraft<CaptureDraft>(CAPTURE_DRAFT_KEY);
    const canRestoreDraft =
      savedDraft &&
      (savedDraft.quote.trim() !== '' ||
        savedDraft.takeaway.trim() !== '' ||
        savedDraft.tagsRaw.trim() !== '' ||
        savedDraft.sparLater ||
        savedDraft.isPrediction ||
        (savedDraft.title || '').trim() !== '' ||
        draftAttachments(savedDraft).length > 0 ||
        Boolean(savedDraft.chapterTouched && (savedDraft.chapter || '').trim())) &&
      (!initialBookId || initialBookSource === 'route' || savedDraft.bookId === initialBookId);

    if (canRestoreDraft && savedDraft) {
      const resolvedBookId = books.some(b => b.id === savedDraft.bookId)
        ? savedDraft.bookId
        : chosenId;
      const resolvedBook = books.find(b => b.id === resolvedBookId);
      setBookId(resolvedBookId);
      setPos(savedDraft.pos || (resolvedBook ? String(resolvedBook.currentPos) : '0'));
      setQuote(savedDraft.quote || '');
      setTakeaway(savedDraft.takeaway || '');
      setTagsRaw(savedDraft.tagsRaw || '');
      setSparLater(Boolean(savedDraft.sparLater));
      setIsPrediction(
        resolvedBook?.kind === 'fiction' ? Boolean(savedDraft.isPrediction) : false
      );
      setChapterInput(savedDraft.chapter || '');
      setChapterTouched(Boolean(savedDraft.chapterTouched));
      setTitle(savedDraft.title || '');
      setAttachments(draftAttachments(savedDraft));
      setDraftRestored(true);
    } else {
      setBookId(chosenId);
      setPos(chosenBook ? String(chosenBook.currentPos) : '0');
      setQuote('');
      setTakeaway('');
      setTagsRaw('');
      setSparLater(false);
      setIsPrediction(false);
      setChapterInput('');
      setChapterTouched(false);
      setTitle('');
      setAttachments([]);
      setDraftRestored(false);
    }

    setAttachMode('none');
    setDraftUrl('');
    setDraftTitle('');
    setUploadingImage(false);
    setSubmitting(false);
    setKindleHint(null);
    setKindleClean(null);
    setTakeawayCursor(null);
    dismissedHintRef.current = null;
  }, [isOpen, defaultBookId, books, initialBookId, initialBookSource]);

  useEffect(() => {
    if (isOpen && !bookId && defaultBookId) {
      const chosenBook = books.find(b => b.id === defaultBookId);
      setBookId(defaultBookId);
      if (chosenBook) {
        setPos(prev => (prev === '0' ? String(chosenBook.currentPos) : prev));
      }
    }
  }, [isOpen, bookId, defaultBookId, books]);

  // Debounced (250ms) silent draft autosave
  useEffect(() => {
    if (!isOpen || !wasOpenRef.current) return;
    if (isDirty) {
      submittedOrDiscardedRef.current = false;
    }
    const timer = window.setTimeout(() => {
      if (draftSnapshotRef.current.isDirty) {
        writeDraft(CAPTURE_DRAFT_KEY, draftSnapshotRef.current.payload);
      } else {
        clearDraft(CAPTURE_DRAFT_KEY);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isOpen, isDirty, bookId, pos, quote, takeaway, title, tagsRaw, sparLater, isPrediction, chapterInput, chapterTouched, attachments]);

  // Warn only when open with unpersisted/unsaved dirty input
  useEffect(() => {
    if (!isOpen || !isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (draftSnapshotRef.current.isDirty) {
        writeDraft(CAPTURE_DRAFT_KEY, draftSnapshotRef.current.payload);
      }
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isOpen, isDirty]);

  const selectedBook = useMemo(() => books.find(b => b.id === bookId) || null, [books, bookId]);
  const chapterState = resolveCaptureChapter({
    bookChapter: selectedBook?.meta?.currentChapter,
    pos: pos.trim() === '' ? null : Number(pos),
    currentPos: selectedBook?.currentPos ?? 0,
    touched: chapterTouched,
    value: chapterInput,
    clampTo: selectedBook,
  });

  const handleBookChange = (nextId: string) => {
    setBookId(nextId);
    setKindleHint(null);
    dismissedHintRef.current = null;
    const nextBook = books.find(b => b.id === nextId);
    setChapterInput('');
    setChapterTouched(false);
    if (nextBook) {
      setPos(String(nextBook.currentPos));
      if (nextBook.kind !== 'fiction') {
        setIsPrediction(false);
      }
    }
  };

  // CD C4.4: unit-guarded hint — % only from citation lines; a hint in another unit shows
  // the mismatch chip (no Apply).
  const detectKindleHint = useCallback(
    (rawText: string, currentPosStr: string) => {
      const result = pickCitationHint(rawText, selectedBook?.posUnit || 'page');
      if (!result || result.hint.label === dismissedHintRef.current) {
        setKindleHint(null);
      } else if (result.kind === 'match' && String(result.hint.pos) === currentPosStr.trim()) {
        setKindleHint(null);
      } else {
        setKindleHint(result);
      }
    },
    [selectedBook?.posUnit]
  );

  /** Paste into Quote/Takeaway: strip Kindle citation boilerplate (Undo restores raw). */
  const handleTextPaste = (
    e: React.ClipboardEvent<HTMLTextAreaElement>,
    field: 'quote' | 'takeaway',
    detectHint: boolean
  ) => {
    const pasted = e.clipboardData?.getData('text/plain') || '';
    if (!pasted) return;
    if (detectHint) detectKindleHint(pasted, pos);
    const { text: cleanedText, cleaned } = stripKindleBoilerplate(pasted);
    if (!cleaned) return;
    e.preventDefault();
    const el = e.currentTarget;
    const current = el.value;
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const setter = field === 'quote' ? setQuote : setTakeaway;
    setter(`${before}${cleanedText}${after}`);
    setKindleClean({ field, rawValue: `${before}${pasted}${after}` });
  };

  const handleDiscardDraft = () => {
    submittedOrDiscardedRef.current = true;
    clearDraft(CAPTURE_DRAFT_KEY);
    const chosenBook = books.find(b => b.id === defaultBookId);
    setBookId(defaultBookId);
    setPos(chosenBook ? String(chosenBook.currentPos) : '0');
    setQuote('');
    setTakeaway('');
    setTagsRaw('');
    setSparLater(false);
    setIsPrediction(false);
    setChapterInput('');
    setChapterTouched(false);
    setTitle('');
    // Discard clears the refs only; uploaded files stay in `Pragya Media/` (no Drive DELETE).
    setAttachments([]);
    setDraftRestored(false);
    setKindleHint(null);
    setKindleClean(null);
    dismissedHintRef.current = null;
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
        showToast(describeSyncError(err, 'Failed to compress/attach image'), 'error');
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
        title: title.trim() || undefined,
        tags: parseTagsCsv(tagsRaw),
        sparLater,
        isPrediction: selectedBook?.kind === 'fiction' ? isPrediction : false,
        attachments,
        chapter: chapterState.value,
      });
      submittedOrDiscardedRef.current = true;
      clearDraft(CAPTURE_DRAFT_KEY);
      setDraftRestored(false);
      showToast(sparLater ? 'Captured to Sparring Inbox' : 'Note captured', 'success');
      onClose();
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to save note'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const atLimit = attachments.length >= 3;
  const hasBooks = books.length > 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      dataTestId="quick-capture-modal"
      title="Quick Capture"
      headingId={headingId}
      maxWidth="max-w-xl"
      mobileSheet
      initialFocusRef={initialBookId && hasBooks ? takeawayInputRef : undefined}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-lg leading-none" aria-hidden="true">
            🪷
          </span>
          <h2 id={headingId} className="text-title text-foreground">
            Quick Capture
          </h2>
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

      {!hasBooks ? (
        <div
          data-testid="capture-empty-shelf"
          className="rounded-[12px] bg-surface2/50 border border-border p-6 text-center space-y-4"
        >
          <div className="w-10 h-10 rounded-full bg-surface2 border border-border mx-auto flex items-center justify-center text-muted-foreground">
            <BookOpen className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <p className="text-heading text-foreground">No books on your shelf yet</p>
            <p className="text-body text-muted-foreground">
              Add your first book so Pragya can attach page progress, spoiler shields, and notes.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-[10px] text-body font-medium text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="capture-empty-add-book-btn"
              onClick={() => {
                onClose();
                if (onOpenAddBook) {
                  onOpenAddBook();
                } else {
                  navigateTo('#/shelf');
                }
              }}
              className="h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Add Your First Book</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          {draftRestored && (
            <div
              data-testid="draft-restored-banner"
              className="mb-4 px-3 py-2 rounded-[10px] bg-surface2 border border-border flex items-center justify-between gap-2 text-label"
            >
              <span className="text-foreground">
                Restored your unsaved draft
                {attachments.length > 0
                  ? ` (with ${attachments.length} attachment${attachments.length === 1 ? '' : 's'})`
                  : ''}
                .
              </span>
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

          <form
            ref={formRef}
            onSubmit={handleSubmit}
            onKeyDown={e => {
              // CD C4.3: ⌘/Ctrl+Enter submits from any field (IME-safe).
              if (isSubmitShortcut(e.nativeEvent)) {
                e.preventDefault();
                if (!submitting && !uploadingImage) formRef.current?.requestSubmit();
              }
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2 space-y-1.5">
                <label
                  htmlFor={bookFieldId}
                  className="block text-eyebrow uppercase text-muted-foreground"
                >
                  Book
                </label>
                <select
                  id={bookFieldId}
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
                <label
                  htmlFor={posFieldId}
                  className="block text-eyebrow uppercase text-muted-foreground"
                >
                  Position ({(selectedBook?.posUnit || 'page').toUpperCase()})
                </label>
                <input
                  id={posFieldId}
                  type="number"
                  min="0"
                  data-testid="capture-pos-input"
                  value={pos}
                  onFocus={e => e.currentTarget.select()}
                  onChange={e => {
                    const nextVal = e.target.value;
                    setPos(nextVal);
                    if (
                      kindleHint?.kind === 'match' &&
                      String(kindleHint.hint.pos) === nextVal.trim()
                    ) {
                      setKindleHint(null);
                    }
                  }}
                  className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground num focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
              </div>
            </div>

            {kindleHint?.kind === 'match' && (
              <div
                data-testid="kindle-pos-chip"
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 rounded-[10px] bg-surface2 border border-border text-label"
              >
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Sparkles className="w-3.5 h-3.5 text-foreground shrink-0" />
                  <span>
                    Detected{' '}
                    <strong className="text-foreground num">{kindleHint.hint.label}</strong>
                  </span>
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="kindle-pos-apply-btn"
                    onClick={() => {
                      setPos(String(kindleHint.hint.pos));
                      setKindleHint(null);
                    }}
                    className="px-2.5 py-1 rounded-[8px] bg-primary text-primary-foreground text-[11px] font-semibold hover:opacity-90"
                  >
                    Apply {kindleHint.hint.pos}
                  </button>
                  <button
                    type="button"
                    aria-label="Dismiss detected position"
                    onClick={() => {
                      dismissedHintRef.current = kindleHint.hint.label;
                      setKindleHint(null);
                    }}
                    className="p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {kindleHint?.kind === 'mismatch' && (
              <div
                data-testid="kindle-unit-mismatch-chip"
                className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-[10px] bg-surface2 border border-border text-label"
              >
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Sparkles className="w-3.5 h-3.5 text-foreground shrink-0" />
                  <span>{kindleUnitMismatchCopy(kindleHint.hint, selectedBook?.posUnit || 'page')}</span>
                </span>
                <button
                  type="button"
                  aria-label="Dismiss detected position"
                  onClick={() => {
                    dismissedHintRef.current = kindleHint.hint.label;
                    setKindleHint(null);
                  }}
                  className="p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {kindleClean && (
              <div
                data-testid="kindle-clean-chip"
                className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-[10px] bg-surface2 border border-border text-label"
              >
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Sparkles className="w-3.5 h-3.5 text-foreground shrink-0" />
                  <span>Cleaned Kindle citation</span>
                </span>
                <button
                  type="button"
                  data-testid="kindle-clean-undo-btn"
                  onClick={() => {
                    if (kindleClean.field === 'quote') setQuote(kindleClean.rawValue);
                    else setTakeaway(kindleClean.rawValue);
                    setKindleClean(null);
                  }}
                  className="inline-flex items-center gap-1 text-label font-medium text-muted-foreground hover:text-foreground"
                >
                  Undo
                </button>
              </div>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor={chapterFieldId}
                className="block text-eyebrow uppercase text-muted-foreground"
              >
                Chapter / Story (Optional)
              </label>
              <input
                id={chapterFieldId}
                type="text"
                maxLength={CHAPTER_MAX_LENGTH}
                autoComplete="off"
                data-testid="capture-chapter-input"
                value={chapterState.value}
                placeholder="e.g. Ch. 3: Run · or a story title"
                aria-describedby={chapterState.hint ? `${chapterFieldId}-hint` : undefined}
                onChange={e => {
                  setChapterInput(e.target.value);
                  setChapterTouched(true);
                }}
                className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              {chapterState.hint && (
                <p
                  id={`${chapterFieldId}-hint`}
                  data-testid="capture-chapter-hint"
                  className="text-label text-faint"
                >
                  {CAPTURE_CHAPTER_HINTS[chapterState.hint]}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor={titleFieldId} className="block text-eyebrow uppercase text-muted-foreground">
                Title (Optional)
              </label>
              <input
                id={titleFieldId}
                type="text"
                maxLength={120}
                autoComplete="off"
                data-testid="capture-title-input"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="A few words you'll recognize later"
                className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor={quoteFieldId}
                className="block text-eyebrow uppercase text-muted-foreground"
              >
                Verbatim Quote (Optional)
              </label>
              <textarea
                id={quoteFieldId}
                rows={2}
                data-testid="capture-quote-input"
                value={quote}
                onPaste={e => handleTextPaste(e, 'quote', true)}
                onChange={e => {
                  const next = e.target.value;
                  setQuote(next);
                  if (kindleClean?.field === 'quote') setKindleClean(null);
                  detectKindleHint(next, pos);
                }}
                placeholder="Quotation, excerpt, or dictation..."
                className="w-full p-3 rounded-[10px] bg-surface2/50 border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
              />
            </div>

            <div className="space-y-1.5 relative">
              <label
                htmlFor={takeawayFieldId}
                className="block text-eyebrow uppercase text-muted-foreground"
              >
                Why I Liked It / Core Takeaway (supports [[wikilinks]]){' '}
                <span className="text-negative">*</span>
              </label>
              <textarea
                id={takeawayFieldId}
                ref={takeawayInputRef}
                rows={3}
                data-testid="capture-takeaway-input"
                value={takeaway}
                onPaste={e => handleTextPaste(e, 'takeaway', !quote.trim())}
                onChange={e => {
                  const next = e.target.value;
                  setTakeaway(next);
                  setTakeawayCursor(e.target.selectionStart);
                  if (kindleClean?.field === 'takeaway') setKindleClean(null);
                  if (!quote.trim()) detectKindleHint(next, pos);
                }}
                onClick={e => setTakeawayCursor(e.currentTarget.selectionStart)}
                onKeyUp={e => setTakeawayCursor(e.currentTarget.selectionStart)}
                onBlur={() => setTakeawayCursor(null)}
                placeholder="Why this matters, core resonance, or concrete realization in your own words..."
                className="w-full p-3 rounded-[10px] bg-background border border-foreground/30 text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/50 resize-y"
              />
              <WikilinkAutocomplete
                textareaRef={takeawayInputRef}
                value={takeaway}
                cursorPos={takeawayCursor}
                notes={notes}
                books={allBooks}
                onSelect={(nextVal, nextCursor) => {
                  setTakeaway(nextVal);
                  setTakeawayCursor(nextCursor);
                }}
              />
            </div>

            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1 space-y-1.5">
                <label
                  htmlFor={tagsFieldId}
                  className="block text-eyebrow uppercase text-muted-foreground"
                >
                  Tags (CSV)
                </label>
                <input
                  id={tagsFieldId}
                  type="text"
                  data-testid="capture-tags-input"
                  value={tagsRaw}
                  onChange={e => setTagsRaw(e.target.value)}
                  placeholder="#systems, #heuristics, #favorites"
                  className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
              </div>

              <div className="flex flex-wrap items-center gap-4 pb-2">
                <label
                  htmlFor={sparFieldId}
                  className="inline-flex items-center gap-2 text-body text-foreground cursor-pointer select-none"
                >
                  <input
                    id={sparFieldId}
                    type="checkbox"
                    data-testid="capture-spar-checkbox"
                    checked={sparLater}
                    onChange={e => setSparLater(e.target.checked)}
                    className="w-4 h-4 rounded border-input accent-primary"
                  />
                  <span>Spar w/ AI later</span>
                </label>

                {selectedBook?.kind === 'fiction' && (
                  <label
                    htmlFor={predFieldId}
                    className="inline-flex items-center gap-2 text-body text-foreground cursor-pointer select-none"
                  >
                    <input
                      id={predFieldId}
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
                    aria-label="Upload image attachment"
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
                    className="h-9 sm:h-8 px-2.5 rounded-[8px] border border-border bg-surface2/60 hover:bg-surface2 text-label font-medium text-foreground inline-flex items-center gap-1.5 disabled:opacity-40 transition-colors"
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
                    className="h-9 sm:h-8 px-2.5 rounded-[8px] border border-border bg-surface2/60 hover:bg-surface2 text-label font-medium text-foreground inline-flex items-center gap-1.5 disabled:opacity-40 transition-colors"
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
                    className="h-9 sm:h-8 px-2.5 rounded-[8px] border border-border bg-surface2/60 hover:bg-surface2 text-label font-medium text-foreground inline-flex items-center gap-1.5 disabled:opacity-40 transition-colors"
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
                      aria-label="Attachment URL"
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
                      aria-label="Attachment title"
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

            <div
              data-testid="capture-sticky-footer"
              className="sticky bottom-0 -mx-4 px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] sm:static sm:mx-0 sm:px-0 sm:py-0 sm:pt-2 bg-popover/95 backdrop-blur-sm border-t border-border/70 sm:border-t-0 flex items-center justify-end gap-2 z-10"
            >
              <span
                data-testid="capture-submit-hint"
                className="hidden sm:[@media(any-pointer:fine)]:inline-flex items-center gap-1 mr-auto text-label text-muted-foreground"
              >
                <kbd className="px-1.5 py-0.5 rounded-[6px] bg-surface2 border border-border font-mono text-[11px] text-muted-foreground">
                  {submitShortcutModifierLabel(
                    typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent
                  )}
                </kbd>
                <kbd className="px-1.5 py-0.5 rounded-[6px] bg-surface2 border border-border font-mono text-[11px] text-muted-foreground">
                  ↵
                </kbd>
                <span>to save</span>
              </span>
              <button
                type="button"
                onClick={onClose}
                className="h-11 sm:h-10 px-4 rounded-[10px] text-body font-medium text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || uploadingImage}
                data-testid="capture-submit-btn"
                className="h-11 sm:h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {submitting ? 'Saving…' : 'Save Note'}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
};
