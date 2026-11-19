import React, { useId, useMemo, useRef, useState } from 'react';
import { Archive, X } from 'lucide-react';
import type { Attachment, DeltaStatus, Note, NoteStatus } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { useArchiveActions } from '../../hooks/useArchiveActions';
import { useModalDraft } from '../../hooks/useModalDraft';
import { describeSyncError } from '../../utils/apiErrors';
import { ARCHIVE_ACTIVE_DELTA_COPY, countOtherActiveDeltas, isArchived } from '../../utils/archive';
import { openEditableAttachments, saveEditedAttachments } from '../../utils/attachmentLimits';
import { CHAPTER_MAX_LENGTH, withChapterKey } from '../../utils/chapterFormat';
import { formatWhenDoDisplay, validateDeltaForSave } from '../../utils/deltaFormat';
import { getEditNoteDraftKey, type EditNoteDraft } from '../../utils/draftStorage';
import { isSubmitShortcut } from '../../utils/keyboard';
import { NOTE_CHAPTER_EDITOR_OWNED_META_KEYS } from '../../utils/metaCodecs';
import { navigateTo } from '../../utils/navigation';
import { clampNotePos } from '../../utils/positionClamp';
import { parseTagsCsv, serializeTagsCsv } from '../../utils/sheetCodecs';
import { computeNormalizedPos } from '../../utils/spoilerMath';
import { showToast } from '../../utils/toast';
import { normalizeSlugInput, resolveSlugEdit, takenSlugs } from '../../utils/wikilinks';
import { AttachmentManager } from '../common/AttachmentManager';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { DeltaFieldsSection } from '../common/DeltaFieldsSection';
import { DraftRestoredBanner } from '../common/DraftRestoredBanner';
import { Modal } from '../common/Modal';
import {
  BTN_GHOST_LG,
  BTN_TERTIARY,
  FIELD_LABEL,
  INPUT,
  MODAL_CLOSE_BTN,
  SELECT,
} from '../common/uiClasses';
import { WikilinkTextarea } from '../common/WikilinkTextarea';

export interface EditNoteModalProps {
  note: Note | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (savedNote: Note) => void;
}

interface EditNoteCanonical {
  title: string;
  slug: string;
  pos: string;
  status: NoteStatus;
  quote: string;
  takeaway: string;
  tagsRaw: string;
  isPrediction: boolean;
  contextMechanism: string;
  critique: string;
  deltaTrigger: string;
  deltaAction: string;
  deltaStatus: DeltaStatus;
  chapter: string;
}

function buildCanonical(note: Note): EditNoteCanonical {
  const formattedDelta = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);
  return {
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
    chapter: typeof note.meta?.chapter === 'string' ? note.meta.chapter : '',
  };
}

export const EditNoteModal: React.FC<EditNoteModalProps> = ({
  note,
  isOpen,
  onClose,
  onSaved,
}) => {
  const { books, notes, updateNote, uploadImageAttachment, resolveDocTitle } = usePragya();
  const { archiveNote } = useArchiveActions();
  const [archiving, setArchiving] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);

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
  const critiqueId = `${baseId}-critique`;
  const chapterId = `${baseId}-chapter`;

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugError, setSlugError] = useState<string | null>(null);
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
  const [chapter, setChapter] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resetTick, setResetTick] = useState(0);

  /** R-4: stored attachments captured when the modal opened (stable merge base on save). */
  const openedAttachmentsRef = useRef<unknown[]>([]);
  const canonicalRef = useRef<EditNoteCanonical>({
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
    chapter: '',
  });

  const applyFields = (vals: EditNoteCanonical) => {
    setTitle(vals.title);
    setSlug(vals.slug);
    setPos(vals.pos);
    setStatus(vals.status);
    setQuote(vals.quote);
    setTakeaway(vals.takeaway);
    setTagsRaw(vals.tagsRaw);
    setIsPrediction(vals.isPrediction);
    setContextMechanism(vals.contextMechanism);
    setCritique(vals.critique);
    setDeltaTrigger(vals.deltaTrigger);
    setDeltaAction(vals.deltaAction);
    setDeltaStatus(vals.deltaStatus);
    setChapter(vals.chapter);
  };

  const c = canonicalRef.current;
  const isDirty =
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
    deltaStatus !== c.deltaStatus ||
    chapter !== c.chapter;

  const draftPayload = useMemo<EditNoteDraft>(
    () => ({
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
      chapter,
      savedAt: new Date().toISOString(),
    }),
    [
      baseUpdatedAt,
      chapter,
      contextMechanism,
      critique,
      deltaAction,
      deltaStatus,
      deltaTrigger,
      isPrediction,
      note?.updatedAt,
      pos,
      quote,
      slug,
      status,
      tagsRaw,
      takeaway,
      title,
    ]
  );

  const resetSessionAttachments = (currentNote: Note) => {
    const split = openEditableAttachments(currentNote.meta?.attachments);
    openedAttachmentsRef.current = split.originalRaw;
    setAttachments(split.renderable);
    setSlugError(null);
    setSubmitting(false);
    setResetTick(t => t + 1);
  };

  const { draftRestored, markSubmitted, discardDraft } = useModalDraft<EditNoteDraft>({
    isOpen: isOpen && Boolean(note),
    sessionId: note?.id ?? null,
    draftKey: note ? getEditNoteDraftKey(note.id) : '',
    isDirty,
    payload: draftPayload,
    currentUpdatedAt: note?.updatedAt,
    getBaseUpdatedAt: d => d.baseUpdatedAt,
    canRestore: validDraft => {
      if (!note) return false;
      const c = buildCanonical(note);
      return (
        validDraft.title !== c.title ||
        validDraft.slug !== c.slug ||
        validDraft.pos !== c.pos ||
        validDraft.status !== c.status ||
        validDraft.quote !== c.quote ||
        validDraft.takeaway !== c.takeaway ||
        validDraft.tagsRaw !== c.tagsRaw ||
        validDraft.isPrediction !== c.isPrediction ||
        validDraft.contextMechanism !== c.contextMechanism ||
        validDraft.critique !== c.critique ||
        validDraft.deltaTrigger !== c.deltaTrigger ||
        validDraft.deltaAction !== c.deltaAction ||
        validDraft.deltaStatus !== c.deltaStatus ||
        (validDraft.chapter ?? c.chapter) !== c.chapter
      );
    },
    onRestore: validDraft => {
      if (!note) return;
      const c = buildCanonical(note);
      canonicalRef.current = c;
      setBaseUpdatedAt(note.updatedAt);
      applyFields({
        title: validDraft.title,
        slug: validDraft.slug,
        pos: validDraft.pos,
        status: validDraft.status,
        quote: validDraft.quote,
        takeaway: validDraft.takeaway,
        tagsRaw: validDraft.tagsRaw,
        isPrediction: Boolean(validDraft.isPrediction),
        contextMechanism: validDraft.contextMechanism,
        critique: validDraft.critique,
        deltaTrigger: validDraft.deltaTrigger,
        deltaAction: validDraft.deltaAction,
        deltaStatus: validDraft.deltaStatus || 'none',
        chapter: validDraft.chapter ?? c.chapter,
      });
      resetSessionAttachments(note);
    },
    onInitCanonical: () => {
      if (!note) return;
      const c = buildCanonical(note);
      canonicalRef.current = c;
      setBaseUpdatedAt(note.updatedAt);
      applyFields(c);
      resetSessionAttachments(note);
    },
    onDiscard: () => {
      applyFields(canonicalRef.current);
      setSlugError(null);
    },
  });

  const book = useMemo(
    () => (note ? books.find(b => b.id === note.bookId) || null : null),
    [books, note]
  );

  const otherActiveCount = useMemo(
    () => (note ? countOtherActiveDeltas(notes, note.id) : 0),
    [note, notes]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note) return;

    const deltaCheck = validateDeltaForSave({
      deltaTrigger,
      deltaAction,
      deltaStatus,
      otherActiveCount,
      emptyActiveMessage: 'Enter a WHEN trigger or DO action to keep a delta active.',
    });
    if (!deltaCheck.ok) {
      showToast(deltaCheck.error, 'error');
      return;
    }

    const posChanged = Number(pos) !== Number(note.pos);
    const parsedPos = posChanged && book ? clampNotePos(pos, book) : Math.max(0, Number(pos) || 0);
    const normalizedPos = book
      ? computeNormalizedPos(parsedPos, book.totalPos, book.posUnit)
      : note.normalizedPos;

    setSubmitting(true);
    try {
      const slugEdit = resolveSlugEdit({
        rawSlug: slug,
        title,
        originalSlug: note.slug,
        taken: takenSlugs(notes, note.id),
      });
      if (slugEdit.error) {
        setSlugError(slugEdit.error);
        setSubmitting(false);
        return;
      }

      const saved = await updateNote(
        {
          ...note,
          slug: slugEdit.slug,
          pos: parsedPos,
          normalizedPos,
          status,
          tags: parseTagsCsv(tagsRaw),
          quote: quote.trim(),
          takeaway: takeaway.trim(),
          contextMechanism: contextMechanism.trim(),
          critique: critique.trim(),
          deltaTrigger: deltaCheck.normalizedTrigger,
          deltaAction: deltaCheck.normalizedAction,
          deltaStatus,
          meta: {
            ...withChapterKey(note.meta, 'chapter', chapter),
            ...(title.trim() ? { title: title.trim() } : { title: undefined }),
            attachments: saveEditedAttachments(openedAttachmentsRef.current, attachments),
            ...(book?.kind === 'fiction' ? { isPrediction } : {}),
          },
        },
        {
          expectedBaseUpdatedAt: baseUpdatedAt || note.updatedAt,
          ownedMetaKeys: NOTE_CHAPTER_EDITOR_OWNED_META_KEYS,
          baseMeta: note.meta,
        }
      );

      markSubmitted();
      showToast(
        saved.slug !== note.slug
          ? `Renamed to [[${saved.slug}]]. [[${note.slug}]] still works.`
          : 'Note updated',
        'success'
      );
      onSaved?.(saved);
      onClose();
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to update note'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const runArchive = async () => {
    if (!note) return;
    setArchiving(true);
    const saved = await archiveNote(note);
    setArchiving(false);
    setArchiveConfirmOpen(false);
    if (!saved) return;
    markSubmitted();
    onClose();
    const hash = window.location.hash;
    if (
      hash.startsWith(`#/note/${encodeURIComponent(note.slug)}`) ||
      hash.startsWith(`#/note/${encodeURIComponent(note.id)}`)
    ) {
      navigateTo('#/notes');
    }
  };

  const requestArchive = () => {
    if (note?.deltaStatus === 'active') setArchiveConfirmOpen(true);
    else void runArchive();
  };

  if (!note) return null;

  return (
    <>
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
        <button type="button" onClick={onClose} aria-label="Close" className={MODAL_CLOSE_BTN}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <DraftRestoredBanner visible={draftRestored} onDiscard={discardDraft} />

      <form
        onSubmit={e => void handleSubmit(e)}
        onKeyDown={e => {
          if (isSubmitShortcut(e.nativeEvent)) {
            e.preventDefault();
            if (!submitting && !uploadingImage && !archiving) e.currentTarget.requestSubmit();
          }
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor={titleId} className={FIELD_LABEL}>
              Title
            </label>
            <input
              id={titleId}
              type="text"
              data-testid="edit-note-title-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Optional note title..."
              className={INPUT}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={slugId} className={FIELD_LABEL}>
              Slug
            </label>
            <input
              id={slugId}
              type="text"
              data-testid="edit-note-slug-input"
              value={slug}
              onChange={e => {
                setSlug(e.target.value);
                setSlugError(null);
              }}
              onBlur={e => setSlug(normalizeSlugInput(e.target.value))}
              aria-invalid={Boolean(slugError)}
              aria-describedby={slugError ? `${slugId}-error` : undefined}
              className="w-full h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input font-mono text-base sm:text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
            {slugError && (
              <p
                id={`${slugId}-error`}
                role="alert"
                data-testid="edit-note-slug-error"
                className="text-label text-negative"
              >
                {slugError}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label htmlFor={posId} className={FIELD_LABEL}>
              Position ({(book?.posUnit || 'page').toUpperCase()})
            </label>
            <input
              id={posId}
              type="number"
              inputMode="numeric"
              min="0"
              data-testid="edit-note-pos-input"
              value={pos}
              onChange={e => setPos(e.target.value)}
              className={`${INPUT} num`}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={statusId} className={FIELD_LABEL}>
              Status
            </label>
            <select
              id={statusId}
              data-testid="edit-note-status-select"
              value={status}
              onChange={e => setStatus(e.target.value as NoteStatus)}
              className={SELECT}
            >
              <option value="saved">Saved</option>
              <option value="inbox">Inbox (To Spar)</option>
              <option value="in-reflection">In Reflection</option>
              <option value="atomic">Atomic</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={tagsId} className={FIELD_LABEL}>
              Tags (CSV)
            </label>
            <input
              id={tagsId}
              type="text"
              data-testid="edit-note-tags-input"
              value={tagsRaw}
              onChange={e => setTagsRaw(e.target.value)}
              placeholder="#systems, #favorites"
              className={INPUT}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={chapterId} className={FIELD_LABEL}>
            Chapter / Story (Optional)
          </label>
          <input
            id={chapterId}
            type="text"
            maxLength={CHAPTER_MAX_LENGTH}
            autoComplete="off"
            data-testid="edit-note-chapter-input"
            value={chapter}
            onChange={e => setChapter(e.target.value)}
            placeholder="e.g. Ch. 3: Run · or a story title"
            className={INPUT}
          />
        </div>

        {book?.kind === 'fiction' && (
          <label
            htmlFor={predictionId}
            className="min-h-11 sm:min-h-0 inline-flex items-center gap-2 text-body text-foreground cursor-pointer select-none"
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
          <label htmlFor={quoteId} className={FIELD_LABEL}>
            Verbatim Quote
          </label>
          <textarea
            id={quoteId}
            rows={2}
            data-testid="edit-note-quote-input"
            value={quote}
            onChange={e => setQuote(e.target.value)}
            className="w-full p-3 rounded-[10px] bg-surface2/50 border border-input text-base sm:text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          />
        </div>

        <WikilinkTextarea
          id={takeawayId}
          rows={3}
          dataTestId="edit-note-takeaway-input"
          label="Core Takeaway / Why I Liked It (supports [[wikilinks]])"
          value={takeaway}
          onValueChange={setTakeaway}
          notes={notes}
          books={books}
          excludeNoteId={note.id}
          excludeSlug={note.slug}
          resetKey={resetTick}
        />

        <WikilinkTextarea
          id={contextId}
          rows={2}
          dataTestId="edit-note-context-input"
          label="Context & Mechanism (supports [[wikilinks]])"
          value={contextMechanism}
          onValueChange={setContextMechanism}
          notes={notes}
          books={books}
          excludeNoteId={note.id}
          excludeSlug={note.slug}
          resetKey={resetTick}
        />

        <DeltaFieldsSection
          variant="edit"
          deltaTrigger={deltaTrigger}
          onTriggerChange={setDeltaTrigger}
          deltaAction={deltaAction}
          onActionChange={setDeltaAction}
          deltaStatus={deltaStatus}
          onStatusChange={setDeltaStatus}
          otherActiveCount={otherActiveCount}
        />

        <WikilinkTextarea
          id={critiqueId}
          rows={2}
          dataTestId="edit-note-critique-input"
          label="Critique & Boundary Conditions (supports [[wikilinks]])"
          value={critique}
          onValueChange={setCritique}
          notes={notes}
          books={books}
          excludeNoteId={note.id}
          excludeSlug={note.slug}
          resetKey={resetTick}
        />

        <AttachmentManager
          isOpen={isOpen}
          attachments={attachments}
          onChange={setAttachments}
          uploadImageAttachment={uploadImageAttachment}
          resolveDocTitle={resolveDocTitle}
          onUploadingChange={setUploadingImage}
          resetKey={resetTick}
        />

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <div>
            {!isArchived(note) && (
              <button
                type="button"
                data-testid="archive-note-btn"
                onClick={requestArchive}
                disabled={submitting || uploadingImage || archiving}
                className={`${BTN_TERTIARY} h-11 sm:h-10`}
              >
                <Archive className="w-4 h-4" aria-hidden="true" />
                <span>Archive Note</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className={BTN_GHOST_LG}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || uploadingImage}
              data-testid="edit-note-submit-btn"
              className="h-11 sm:h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
    <ConfirmDialog
      isOpen={archiveConfirmOpen}
      tone="default"
      title={ARCHIVE_ACTIVE_DELTA_COPY.title}
      body={ARCHIVE_ACTIVE_DELTA_COPY.body}
      confirmLabel={ARCHIVE_ACTIVE_DELTA_COPY.confirm}
      busy={archiving}
      onCancel={() => setArchiveConfirmOpen(false)}
      onConfirm={() => void runArchive()}
    />
    </>
  );
};
