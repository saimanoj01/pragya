import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookOpen, Plus, X } from 'lucide-react';
import type { Attachment } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { useKindlePaste } from '../../hooks/useKindlePaste';
import { useModalDraft } from '../../hooks/useModalDraft';
import { PartialBatchCommitError } from '../../services/storage';
import { describeSyncError } from '../../utils/apiErrors';
import { withoutArchived } from '../../utils/archive';
import {
  CAPTURE_CHAPTER_HINTS,
  CHAPTER_MAX_LENGTH,
  resolveCaptureChapter,
} from '../../utils/chapterFormat';
import {
  CAPTURE_DRAFT_KEY,
  draftAttachments,
  type CaptureDraft,
} from '../../utils/draftStorage';
import { isSubmitShortcut, submitShortcutModifierLabel } from '../../utils/keyboard';
import { captureDraftRestoredMessage } from '../../utils/modalDraft';
import { navigateTo } from '../../utils/navigation';
import { parseTagsCsv } from '../../utils/sheetCodecs';
import { showToast } from '../../utils/toast';
import { AttachmentManager } from '../common/AttachmentManager';
import { DraftRestoredBanner } from '../common/DraftRestoredBanner';
import { KindlePasteChips } from '../common/KindlePasteChips';
import { Modal } from '../common/Modal';
import {
  BTN_GHOST_LG,
  FIELD_LABEL,
  HELPER,
  INPUT,
  KBD,
  MODAL_CLOSE_BTN,
} from '../common/uiClasses';
import { WikilinkTextarea } from '../common/WikilinkTextarea';

export interface QuickCaptureModalProps {
  isOpen: boolean;
  initialBookId?: string | null;
  /**
   * CD C4.3: 'route' = soft preselect from the page you're on (global capture). A saved
   * draft for another book still restores; 'explicit' (default) = a book's own Capture
   * button, which only restores a draft for that book.
   */
  initialBookSource?: 'explicit' | 'route';
  /** CD C3.3: capture for a missing `[[slug]]` — title pre-filled, the note takes this slug. */
  initialTitle?: string;
  initialSlug?: string;
  onClose: () => void;
  onOpenAddBook?: () => void;
}

export const QuickCaptureModal: React.FC<QuickCaptureModalProps> = ({
  isOpen,
  initialBookId,
  initialBookSource = 'explicit',
  initialTitle,
  initialSlug,
  onClose,
  onOpenAddBook,
}) => {
  const {
    books: allBooks,
    notes,
    captureNote,
    uploadImageAttachment,
    resolveDocTitle,
  } = usePragya();
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
  const [chapterInput, setChapterInput] = useState('');
  const [chapterTouched, setChapterTouched] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState('');
  const [resetTick, setResetTick] = useState(0);

  const formRef = useRef<HTMLFormElement>(null);
  const takeawayInputRef = useRef<HTMLTextAreaElement>(null);

  const selectedBook = useMemo(() => books.find(b => b.id === bookId) || null, [books, bookId]);

  const {
    kindleHint,
    kindleClean,
    detectKindleHint,
    handleTextPaste,
    clearHintIfMatchesPos,
    clearFieldClean,
    applyKindleHint,
    dismissKindleHint,
    undoKindleClean,
    resetKindleState,
  } = useKindlePaste({
    posUnit: selectedBook?.posUnit || 'page',
    pos,
    setPos,
    setQuote,
    setTakeaway,
  });

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
    [
      attachments.length,
      chapterInput,
      chapterTouched,
      isPrediction,
      quote,
      sparLater,
      tagsRaw,
      takeaway,
      title,
    ]
  );

  const draftPayload = useMemo<CaptureDraft>(
    () => ({
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
      attachments,
      updatedAt: new Date().toISOString(),
    }),
    [
      attachments,
      bookId,
      chapterInput,
      chapterTouched,
      isPrediction,
      pos,
      quote,
      sparLater,
      tagsRaw,
      takeaway,
      title,
    ]
  );

  const resetEmptyFields = (nextTitle = '') => {
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
    setTitle(nextTitle);
    setAttachments([]);
    setSubmitting(false);
    resetKindleState();
    setResetTick(t => t + 1);
  };

  const { draftRestored, markSubmitted, discardDraft } = useModalDraft<CaptureDraft>({
    isOpen,
    sessionId: isOpen ? 'capture' : null,
    draftKey: CAPTURE_DRAFT_KEY,
    disabled: Boolean(initialSlug),
    isDirty,
    payload: draftPayload,
    canRestore: savedDraft =>
      (savedDraft.quote.trim() !== '' ||
        savedDraft.takeaway.trim() !== '' ||
        savedDraft.tagsRaw.trim() !== '' ||
        savedDraft.sparLater ||
        savedDraft.isPrediction ||
        (savedDraft.title || '').trim() !== '' ||
        draftAttachments(savedDraft).length > 0 ||
        Boolean(savedDraft.chapterTouched && (savedDraft.chapter || '').trim())) &&
      (!initialBookId || initialBookSource === 'route' || savedDraft.bookId === initialBookId),
    onRestore: savedDraft => {
      const resolvedBookId = books.some(b => b.id === savedDraft.bookId)
        ? savedDraft.bookId
        : defaultBookId;
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
      setSubmitting(false);
      resetKindleState();
      setResetTick(t => t + 1);
    },
    onInitCanonical: () => {
      resetEmptyFields(initialSlug ? initialTitle || '' : '');
    },
    onDiscard: () => {
      resetEmptyFields('');
    },
  });

  useEffect(() => {
    if (isOpen && !bookId && defaultBookId) {
      const chosenBook = books.find(b => b.id === defaultBookId);
      setBookId(defaultBookId);
      if (chosenBook) {
        setPos(prev => (prev === '0' ? String(chosenBook.currentPos) : prev));
      }
    }
  }, [books, bookId, defaultBookId, isOpen]);

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
    resetKindleState(true);
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
        slug: initialSlug || undefined,
        tags: parseTagsCsv(tagsRaw),
        sparLater,
        isPrediction: selectedBook?.kind === 'fiction' ? isPrediction : false,
        attachments,
        chapter: chapterState.value,
      });
      markSubmitted();
      showToast(sparLater ? 'Captured to Sparring Inbox' : 'Note captured', 'success');
      onClose();
    } catch (err) {
      if (err instanceof PartialBatchCommitError && err.committed.notes.length > 0) {
        // R1#2: the Note already landed in Sheets (only reading-session logging failed).
        // Close + clear draft so retrying cannot append a duplicate Note row.
        markSubmitted();
        showToast(
          'Note saved, but your reading session could not be logged. Sync later to refresh.',
          'info'
        );
        onClose();
        return;
      }
      showToast(describeSyncError(err, 'Failed to save note'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

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
        <button type="button" onClick={onClose} aria-label="Close" className={MODAL_CLOSE_BTN}>
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
            <button type="button" onClick={onClose} className={BTN_GHOST_LG}>
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
              className="h-11 sm:h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Add Your First Book</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          <DraftRestoredBanner
            visible={draftRestored}
            onDiscard={discardDraft}
            message={captureDraftRestoredMessage(attachments.length)}
          />

          <form
            ref={formRef}
            onSubmit={handleSubmit}
            onKeyDown={e => {
              if (isSubmitShortcut(e.nativeEvent)) {
                e.preventDefault();
                if (!submitting && !uploadingImage) formRef.current?.requestSubmit();
              }
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2 space-y-1.5">
                <label htmlFor={bookFieldId} className={FIELD_LABEL}>
                  Book
                </label>
                <select
                  id={bookFieldId}
                  data-testid="capture-book-select"
                  value={bookId}
                  onChange={e => handleBookChange(e.target.value)}
                  className="w-full h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
                >
                  {books.map(b => (
                    <option key={b.id} value={b.id}>
                      {b.title} ({b.author})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor={posFieldId} className={FIELD_LABEL}>
                  Position ({(selectedBook?.posUnit || 'page').toUpperCase()})
                </label>
                <input
                  id={posFieldId}
                  type="number"
                  inputMode="numeric"
                  min="0"
                  data-testid="capture-pos-input"
                  value={pos}
                  onFocus={e => e.currentTarget.select()}
                  onChange={e => {
                    const nextVal = e.target.value;
                    setPos(nextVal);
                    clearHintIfMatchesPos(nextVal);
                  }}
                  className={`${INPUT} num`}
                />
              </div>
            </div>

            <KindlePasteChips
              kindleHint={kindleHint}
              kindleClean={kindleClean}
              posUnit={selectedBook?.posUnit || 'page'}
              onApplyHint={applyKindleHint}
              onDismissHint={dismissKindleHint}
              onUndoClean={undoKindleClean}
            />

            <div className="space-y-1.5">
              <label htmlFor={chapterFieldId} className={FIELD_LABEL}>
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
                className={INPUT}
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
              <label htmlFor={titleFieldId} className={FIELD_LABEL}>
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
                aria-describedby={initialSlug ? `${titleFieldId}-slug` : undefined}
                className={INPUT}
              />
              {initialSlug && (
                <p id={`${titleFieldId}-slug`} data-testid="capture-slug-hint" className={HELPER}>
                  This note will become <span className="font-mono">[[{initialSlug}]]</span>.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor={quoteFieldId} className={FIELD_LABEL}>
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
                  clearFieldClean('quote');
                  detectKindleHint(next, pos);
                }}
                placeholder="Quotation, excerpt, or dictation..."
                className="w-full p-3 rounded-[10px] bg-surface2/50 border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
              />
            </div>

            <WikilinkTextarea
              id={takeawayFieldId}
              ref={takeawayInputRef}
              rows={3}
              dataTestId="capture-takeaway-input"
              label={
                <>
                  Why I Liked It / Core Takeaway (supports [[wikilinks]]){' '}
                  <span className="text-negative">*</span>
                </>
              }
              value={takeaway}
              onPaste={e => handleTextPaste(e, 'takeaway', !quote.trim())}
              onValueChange={next => {
                setTakeaway(next);
                clearFieldClean('takeaway');
                if (!quote.trim()) detectKindleHint(next, pos);
              }}
              notes={notes}
              books={allBooks}
              resetKey={resetTick}
              placeholder="Why this matters, core resonance, or concrete realization in your own words..."
              textareaClassName="w-full p-3 rounded-[10px] bg-background border border-foreground/30 text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/50 resize-y"
            />

            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1 space-y-1.5">
                <label htmlFor={tagsFieldId} className={FIELD_LABEL}>
                  Tags (CSV)
                </label>
                <input
                  id={tagsFieldId}
                  type="text"
                  data-testid="capture-tags-input"
                  value={tagsRaw}
                  onChange={e => setTagsRaw(e.target.value)}
                  placeholder="#systems, #heuristics, #favorites"
                  className={INPUT}
                />
              </div>

              <div className="flex flex-wrap items-center gap-4 pb-2">
                <label
                  htmlFor={sparFieldId}
                  className="min-h-11 sm:min-h-0 inline-flex items-center gap-2 text-body text-foreground cursor-pointer select-none"
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
                    className="min-h-11 sm:min-h-0 inline-flex items-center gap-2 text-body text-foreground cursor-pointer select-none"
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

            <AttachmentManager
              isOpen={isOpen}
              attachments={attachments}
              onChange={setAttachments}
              uploadImageAttachment={uploadImageAttachment}
              resolveDocTitle={resolveDocTitle}
              onUploadingChange={setUploadingImage}
              testIdPrefix="capture"
              resetKey={resetTick}
            />

            <div
              data-testid="capture-sticky-footer"
              className="sticky bottom-0 -mx-4 px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] sm:static sm:mx-0 sm:px-0 sm:py-0 sm:pt-2 bg-popover/95 backdrop-blur-sm border-t border-border/70 sm:border-t-0 flex items-center justify-end gap-2 z-10"
            >
              <span
                data-testid="capture-submit-hint"
                className="hidden sm:[@media(any-pointer:fine)]:inline-flex items-center gap-1 mr-auto text-label text-muted-foreground"
              >
                <kbd className={KBD}>
                  {submitShortcutModifierLabel(
                    typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent
                  )}
                </kbd>
                <kbd className={KBD}>↵</kbd>
                <span>to save</span>
              </span>
              <button type="button" onClick={onClose} className={BTN_GHOST_LG}>
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
