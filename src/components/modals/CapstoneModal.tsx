import React, { useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Book } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { useCopyPrompt } from '../../hooks/useCopyPrompt';
import { useModalDraft } from '../../hooks/useModalDraft';
import { describeSyncError } from '../../utils/apiErrors';
import {
  CAPSTONE_COPY_SUCCESS_MESSAGE,
  MAX_SOFT_LEARNINGS,
  buildCapstoneForSave,
  buildCapstonePrompt,
  countCapstoneEligibleNotes,
  hasCapstoneContent,
  parseLearningsInput,
  type ParsedCapstoneReply,
} from '../../utils/capstonePrompt';
import { getCapstoneDraftKey, type CapstoneDraft } from '../../utils/draftStorage';
import { isSubmitShortcut } from '../../utils/keyboard';
import { CAPSTONE_OWNED_META_KEYS, getBookCapstone } from '../../utils/metaCodecs';
import { showToast } from '../../utils/toast';
import { CapstonePasteHelper } from '../common/CapstonePasteHelper';
import { DraftRestoredBanner } from '../common/DraftRestoredBanner';
import { Modal } from '../common/Modal';
import { PromptFallbackModal } from '../common/PromptFallbackModal';
import {
  BTN_GHOST_LG,
  FIELD_LABEL,
  HELPER,
  MODAL_CLOSE_BTN,
  TEXTAREA,
} from '../common/uiClasses';

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

function draftToFields(draft: CapstoneDraft): CapstoneFields {
  return {
    arcOrThesis: String(draft.arcOrThesis ?? ''),
    learningsText: String(draft.learningsText ?? ''),
    perspectiveShift: String(draft.perspectiveShift ?? ''),
  };
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
  const [submitting, setSubmitting] = useState(false);

  const arcRef = useRef<HTMLTextAreaElement>(null);
  const learningsRef = useRef<HTMLTextAreaElement>(null);
  const shiftRef = useRef<HTMLTextAreaElement>(null);
  const baseUpdatedAtRef = useRef<string>('');
  const canonicalRef = useRef<CapstoneFields>(EMPTY_FIELDS);

  const { copyPrompt, fallbackModalProps } = useCopyPrompt({
    successMessage: CAPSTONE_COPY_SUCCESS_MESSAGE,
  });

  const isDirty = !sameFields(fields, canonicalRef.current);

  const draftPayload = useMemo<CapstoneDraft>(
    () => ({
      baseUpdatedAt: baseUpdatedAtRef.current || book?.meta?.updatedAt || '',
      ...fields,
      savedAt: new Date().toISOString(),
    }),
    [book?.meta?.updatedAt, fields]
  );

  const { draftRestored, markSubmitted, discardDraft } = useModalDraft<CapstoneDraft>({
    isOpen: isOpen && Boolean(book),
    sessionId: book?.id ?? null,
    draftKey: book ? getCapstoneDraftKey(book.id) : '',
    isDirty,
    payload: draftPayload,
    currentUpdatedAt: book?.meta?.updatedAt,
    getBaseUpdatedAt: d => d.baseUpdatedAt,
    canRestore: d => !sameFields(draftToFields(d), canonicalFields(book)),
    onRestore: d => {
      baseUpdatedAtRef.current = book?.meta?.updatedAt || '';
      canonicalRef.current = canonicalFields(book);
      setFields(draftToFields(d));
      setSubmitting(false);
    },
    onInitCanonical: () => {
      baseUpdatedAtRef.current = book?.meta?.updatedAt || '';
      const canonical = canonicalFields(book);
      canonicalRef.current = canonical;
      setFields(canonical);
      setSubmitting(false);
    },
    onDiscard: () => {
      setFields(canonicalRef.current);
    },
  });

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

  const handleApplyParsed = (parsed: ParsedCapstoneReply): boolean => {
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
    if (!first) return false;
    setFields(next);
    const target = first;
    window.setTimeout(() => target.current?.focus(), 0);
    return true;
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
      markSubmitted();
      showToast('Saved your Whole-Book Picture.', 'success');
      onClose();
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to save Whole-Book Picture'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (isSubmitShortcut(e.nativeEvent)) {
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
          <button type="button" onClick={onClose} aria-label="Close" className={MODAL_CLOSE_BTN}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <DraftRestoredBanner visible={draftRestored} onDiscard={discardDraft} />

        <form
          onSubmit={e => void handleSubmit(e)}
          onKeyDown={handleFormKeyDown}
          className="space-y-4"
        >
          <CapstonePasteHelper
            resetKey={`${isOpen}-${book.id}`}
            eligibleCount={eligibleCount}
            onCopyPrompt={() => void copyPrompt(buildCapstonePrompt(book, notes))}
            onApplyParsed={handleApplyParsed}
          />

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
            <button type="button" onClick={onClose} className={BTN_GHOST_LG}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={!hasAnyText || submitting}
              data-testid="capstone-save-btn"
              className="h-11 sm:h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Save Picture'}
            </button>
          </div>
        </form>
      </Modal>
      <PromptFallbackModal {...fallbackModalProps} />
    </>
  );
}
