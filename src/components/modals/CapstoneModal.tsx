import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, Copy, RotateCcw, X } from 'lucide-react';
import type { Book } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { Modal } from '../common/Modal';
import { showToast } from '../../utils/toast';
import { describeSyncError } from '../../utils/apiErrors';
import { CAPSTONE_OWNED_META_KEYS, getBookCapstone } from '../../utils/metaCodecs';
import {
  CAPSTONE_COPY_SUCCESS_MESSAGE,
  MAX_SOFT_LEARNINGS,
  buildCapstoneForSave,
  buildCapstonePrompt,
  countCapstoneEligibleNotes,
  hasCapstoneContent,
  parseCapstoneReply,
  parseLearningsInput,
  tryCopyText,
} from '../../utils/capstonePrompt';
import {
  clearDraft,
  getCapstoneDraftKey,
  isNoteDraftStale,
  readDraft,
  writeDraft,
  type CapstoneDraft,
} from '../../utils/draftStorage';

const FIELD_LABEL = 'block text-eyebrow uppercase text-muted-foreground';
const TEXTAREA =
  'w-full p-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y';
const BTN_SECONDARY =
  'h-9 px-3 rounded-[10px] bg-surface2 border border-border text-label font-medium text-foreground hover:bg-secondary inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50';
const BTN_TERTIARY =
  'inline-flex items-center gap-1 text-label font-medium text-muted-foreground hover:text-foreground';
const HELPER = 'text-label text-muted-foreground';

interface CapstoneFields {
  arcOrThesis: string;
  learningsText: string;
  perspectiveShift: string;
}

const EMPTY_FIELDS: CapstoneFields = { arcOrThesis: '', learningsText: '', perspectiveShift: '' };

function canonicalFields(book: Book | null): CapstoneFields {
  const cap = book ? getBookCapstone(book.meta) : undefined;
  if (!cap) return EMPTY_FIELDS;
  return {
    arcOrThesis: cap.arcOrThesis,
    learningsText: cap.keyLearnings.join('\n'),
    perspectiveShift: cap.perspectiveShift,
  };
}

function sameFields(a: CapstoneFields, b: CapstoneFields): boolean {
  return (
    a.arcOrThesis === b.arcOrThesis &&
    a.learningsText === b.learningsText &&
    a.perspectiveShift === b.perspectiveShift
  );
}

export interface CapstonePromptFallbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  prompt: string;
  /** CD C4.1: reused by "Copy Sparring Prompt" (defaults keep the capstone copy/test id). */
  title?: string;
  dataTestId?: string;
  promptLabel?: string;
}

/** ux_spec A.5: clipboard failed → select-and-copy fallback (no network). */
export function CapstonePromptFallbackModal({
  isOpen,
  onClose,
  prompt,
  title = 'Copy Capstone Prompt',
  dataTestId = 'capstone-prompt-fallback-modal',
  promptLabel = 'Capstone prompt',
}: CapstonePromptFallbackModalProps) {
  const headingId = useId();
  const helperId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      headingId={headingId}
      dataTestId={dataTestId}
      initialFocusRef={textareaRef}
    >
      <div className="space-y-3">
        <h2 id={headingId} className="text-title text-foreground">
          {title}
        </h2>
        <textarea
          ref={textareaRef}
          readOnly
          rows={12}
          value={prompt}
          aria-label={promptLabel}
          aria-describedby={helperId}
          onFocus={e => e.currentTarget.select()}
          className="w-full p-3 rounded-[10px] bg-background border border-input font-mono text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
        />
        <p id={helperId} className={HELPER}>
          Select all and copy (⌘C / Ctrl+C).
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

export interface CapstoneModalProps {
  isOpen: boolean;
  onClose: () => void;
  book: Book | null;
}

/** ux_spec A.6 Write / Edit Whole-Book Picture. Zero AI: only string assembly and parsing. */
export function CapstoneModal({ isOpen, onClose, book }: CapstoneModalProps) {
  const { notes, updateBook, isOfflineReadOnly } = usePragya();
  const headingId = useId();
  const arcId = useId();
  const learningsId = useId();
  const shiftId = useId();

  const [fields, setFields] = useState<CapstoneFields>(EMPTY_FIELDS);
  const [draftRestored, setDraftRestored] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteStatus, setPasteStatus] = useState('');
  const [fallbackPrompt, setFallbackPrompt] = useState<string | null>(null);

  const arcRef = useRef<HTMLTextAreaElement>(null);
  const learningsRef = useRef<HTMLTextAreaElement>(null);
  const shiftRef = useRef<HTMLTextAreaElement>(null);
  const baseUpdatedAtRef = useRef<string>('');
  const canonicalRef = useRef<CapstoneFields>(EMPTY_FIELDS);
  const initializedIdRef = useRef<string | null>(null);
  const savedRef = useRef(false);

  useEffect(() => {
    if (!isOpen || !book) {
      initializedIdRef.current = null;
      return;
    }
    if (initializedIdRef.current === book.id) return;
    initializedIdRef.current = book.id;
    savedRef.current = false;
    // B.4 conflict guard: the base is the row as it was when the modal opened.
    baseUpdatedAtRef.current = book.meta?.updatedAt || '';
    const canonical = canonicalFields(book);
    canonicalRef.current = canonical;
    setPasteOpen(false);
    setPasteText('');
    setPasteStatus('');

    const key = getCapstoneDraftKey(book.id);
    const draft = readDraft<CapstoneDraft>(key);
    const fresh = draft && !isNoteDraftStale(draft.baseUpdatedAt, book.meta?.updatedAt) ? draft : null;
    if (draft && !fresh) clearDraft(key);
    const restored: CapstoneFields | null = fresh
      ? {
          arcOrThesis: String(fresh.arcOrThesis ?? ''),
          learningsText: String(fresh.learningsText ?? ''),
          perspectiveShift: String(fresh.perspectiveShift ?? ''),
        }
      : null;
    if (restored && !sameFields(restored, canonical)) {
      setFields(restored);
      setDraftRestored(true);
    } else {
      setFields(canonical);
      setDraftRestored(false);
    }
  }, [book, isOpen]);

  const isDirty = !sameFields(fields, canonicalRef.current);

  // Draft autosave on every change while open (cleared once saved or back to canonical).
  useEffect(() => {
    if (!isOpen || !book || initializedIdRef.current !== book.id || savedRef.current) return;
    const key = getCapstoneDraftKey(book.id);
    if (isDirty) {
      writeDraft<CapstoneDraft>(key, {
        baseUpdatedAt: baseUpdatedAtRef.current,
        ...fields,
        savedAt: new Date().toISOString(),
      });
    } else {
      clearDraft(key);
    }
  }, [book, fields, isDirty, isOpen]);

  const eligibleCount = useMemo(
    () => (book ? countCapstoneEligibleNotes(book, notes) : 0),
    [book, notes]
  );

  if (!book) return null;

  const fiction = book.kind === 'fiction';
  const isEdit = hasCapstoneContent(getBookCapstone(book.meta));
  const learningCount = parseLearningsInput(fields.learningsText).length;
  const hasAnyText = Boolean(
    fields.arcOrThesis.trim() || learningCount > 0 || fields.perspectiveShift.trim()
  );

  const setField = (key: keyof CapstoneFields, value: string) =>
    setFields(prev => ({ ...prev, [key]: value }));

  const handleDiscardDraft = () => {
    clearDraft(getCapstoneDraftKey(book.id));
    setFields(canonicalRef.current);
    setDraftRestored(false);
  };

  const handleFill = () => {
    const parsed = parseCapstoneReply(pasteText);
    const next = { ...fields };
    let first: React.RefObject<HTMLTextAreaElement | null> | null = null;
    if (parsed.arcOrThesis !== undefined) {
      next.arcOrThesis = parsed.arcOrThesis;
      first = first || arcRef;
    }
    if (parsed.keyLearnings !== undefined) {
      next.learningsText = parsed.keyLearnings.join('\n');
      first = first || learningsRef;
    }
    if (parsed.perspectiveShift !== undefined) {
      next.perspectiveShift = parsed.perspectiveShift;
      first = first || shiftRef;
    }
    if (!first) {
      setPasteStatus("Couldn't find the expected headings. You can paste each part into the fields below.");
      return;
    }
    setFields(next);
    setPasteOpen(false);
    setPasteStatus('Filled from the reply. Edit anything you like.');
    const target = first;
    window.setTimeout(() => target.current?.focus(), 0);
  };

  const handleCopyPrompt = async () => {
    const prompt = buildCapstonePrompt(book, notes);
    if (await tryCopyText(prompt)) {
      showToast(CAPSTONE_COPY_SUCCESS_MESSAGE, 'success');
    } else {
      setFallbackPrompt(prompt);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!hasAnyText || submitting) return;
    setSubmitting(true);
    try {
      const capstone = buildCapstoneForSave(book.meta?.capstone, fields, new Date().toISOString());
      await updateBook(
        { ...book, meta: { ...book.meta, capstone } },
        {
          expectedBaseUpdatedAt: baseUpdatedAtRef.current || book.meta?.updatedAt,
          ownedMetaKeys: CAPSTONE_OWNED_META_KEYS,
          baseMeta: book.meta,
        }
      );
      savedRef.current = true;
      clearDraft(getCapstoneDraftKey(book.id));
      setDraftRestored(false);
      showToast('Saved your Whole-Book Picture.', 'success');
      onClose();
    } catch (err) {
      // Offline / conflict: modal stays open, the autosaved draft remains.
      showToast(describeSyncError(err, 'Failed to save Whole-Book Picture'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Whole-Book Picture"
        headingId={headingId}
        dataTestId="capstone-modal"
        maxWidth="max-w-2xl"
        mobileSheet
        initialFocusRef={arcRef}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h2 id={headingId} className="text-title text-foreground">
              Whole-Book Picture
            </h2>
            <p className="text-label text-muted-foreground truncate">{book.title} · Optional</p>
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

        <form onSubmit={e => void handleSubmit(e)} onKeyDown={handleFormKeyDown} className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <details
              open={pasteOpen}
              onToggle={e => setPasteOpen((e.currentTarget as HTMLDetailsElement).open)}
              className="flex-1 min-w-0 space-y-2"
            >
              <summary className={`${BTN_TERTIARY} cursor-pointer list-none h-9`}>
                <ChevronRight
                  className={`w-3.5 h-3.5 transition-transform ${pasteOpen ? 'rotate-90' : ''}`}
                  aria-hidden="true"
                />
                <span>Paste a reply from your assistant</span>
              </summary>
              <textarea
                rows={5}
                aria-label="Assistant reply"
                data-testid="capstone-paste-input"
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                placeholder="Paste the reply here…"
                className={TEXTAREA}
              />
              <button
                type="button"
                data-testid="capstone-fill-btn"
                onClick={handleFill}
                disabled={!pasteText.trim()}
                className={BTN_SECONDARY}
              >
                Fill Fields
              </button>
            </details>
            {eligibleCount > 0 && (
              <button
                type="button"
                data-testid="capstone-modal-copy-prompt-btn"
                onClick={() => void handleCopyPrompt()}
                className={BTN_SECONDARY}
              >
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Prompt</span>
              </button>
            )}
          </div>
          {pasteStatus && (
            <p role="status" data-testid="capstone-paste-status" className={HELPER}>
              {pasteStatus}
            </p>
          )}

          <div className="space-y-1.5">
            <label htmlFor={arcId} className={FIELD_LABEL}>
              {fiction ? 'The Arc' : 'The Thesis'}
            </label>
            <textarea
              id={arcId}
              ref={arcRef}
              rows={3}
              data-testid="capstone-arc-input"
              value={fields.arcOrThesis}
              onChange={e => setField('arcOrThesis', e.target.value)}
              placeholder={
                fiction
                  ? "2–3 sentences: the story's arc and what it was really about for you"
                  : "2–3 sentences: the book's core argument as you understood it"
              }
              className={TEXTAREA}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={learningsId} className={FIELD_LABEL}>
                Key Learnings · One per line
              </label>
              <span className={`${HELPER} num`}>
                {learningCount} {learningCount === 1 ? 'learning' : 'learnings'}
              </span>
            </div>
            <textarea
              id={learningsId}
              ref={learningsRef}
              rows={5}
              data-testid="capstone-learnings-input"
              value={fields.learningsText}
              onChange={e => setField('learningsText', e.target.value)}
              placeholder="One learning per line"
              className={TEXTAREA}
            />
            {learningCount > MAX_SOFT_LEARNINGS && (
              <p className={HELPER}>Tip: 3–5 tends to stay memorable.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor={shiftId} className={FIELD_LABEL}>
              How My Thinking Shifted
            </label>
            <textarea
              id={shiftId}
              ref={shiftRef}
              rows={2}
              data-testid="capstone-shift-input"
              value={fields.perspectiveShift}
              onChange={e => setField('perspectiveShift', e.target.value)}
              placeholder="What do you now believe or notice differently?"
              className={TEXTAREA}
            />
          </div>

          {isOfflineReadOnly && (
            <p className={HELPER} data-testid="capstone-offline-helper">
              You&apos;re offline. Your draft stays on this device until you reconnect.
            </p>
          )}

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
              disabled={!hasAnyText || submitting}
              data-testid="capstone-save-btn"
              className="h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Save Picture'}
            </button>
          </div>
        </form>
      </Modal>
      <CapstonePromptFallbackModal
        isOpen={fallbackPrompt !== null}
        onClose={() => setFallbackPrompt(null)}
        prompt={fallbackPrompt || ''}
      />
    </>
  );
}
