import React, { useId, useMemo, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import type { DeltaStatus, Note } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { useModalDraft } from '../../hooks/useModalDraft';
import { describeSyncError } from '../../utils/apiErrors';
import { countOtherActiveDeltas } from '../../utils/archive';
import {
  CHAPTER_MAX_LENGTH,
  deepenChapterSuggestion,
  withChapterKey,
} from '../../utils/chapterFormat';
import { SAVE_NEXT_DONE_MESSAGE, isToSpar, nextInboxNote } from '../../utils/deepenFlow';
import {
  formatWhenDoDisplay,
  shouldDefaultOpenDeltaDetails,
  validateDeltaForSave,
} from '../../utils/deltaFormat';
import { getDeepenDraftKey, type DeepenDraft } from '../../utils/draftStorage';
import { isSubmitShortcut } from '../../utils/keyboard';
import { NOTE_CHAPTER_EDITOR_OWNED_META_KEYS } from '../../utils/metaCodecs';
import { parseTagsCsv } from '../../utils/sheetCodecs';
import { showToast } from '../../utils/toast';
import { normalizeSlugInput, resolveSlugEdit, takenSlugs } from '../../utils/wikilinks';
import { DeepenSourceReference } from '../common/DeepenSourceReference';
import { DeltaFieldsSection } from '../common/DeltaFieldsSection';
import { DraftRestoredBanner } from '../common/DraftRestoredBanner';
import { Modal } from '../common/Modal';
import { BTN_GHOST_LG, FIELD_LABEL, INPUT, MODAL_CLOSE_BTN } from '../common/uiClasses';
import { WikilinkTextarea } from '../common/WikilinkTextarea';

export interface DeepenNoteModalProps {
  note: Note | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (savedNote: Note) => void;
  /** CD C4.5 "Save & Next": open Deepen on the next To Spar note (modal stays open). */
  onOpenNext?: (next: Note) => void;
}

interface DeepenCanonical {
  title: string;
  slug: string;
  takeaway: string;
  contextMechanism: string;
  deltaTrigger: string;
  deltaAction: string;
  deltaStatus: DeltaStatus;
  critique: string;
  chapter: string;
  tagsRaw: string;
}

function buildCanonical(note: Note): DeepenCanonical {
  const formattedDelta = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);
  return {
    title: note.meta?.title || '',
    slug: note.slug,
    takeaway: note.takeaway || '',
    contextMechanism: note.contextMechanism || '',
    deltaTrigger: formattedDelta.triggerBody,
    deltaAction: formattedDelta.actionBody,
    deltaStatus: (note.deltaStatus || 'none') as DeltaStatus,
    critique: note.critique || '',
    chapter: typeof note.meta?.chapter === 'string' ? note.meta.chapter : '',
    tagsRaw: Array.isArray(note.tags) ? note.tags.join(', ') : '',
  };
}

export const DeepenNoteModal: React.FC<DeepenNoteModalProps> = ({
  note,
  isOpen,
  onClose,
  onSaved,
  onOpenNext,
}) => {
  const { books, notes, updateNote } = usePragya();
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const titleId = `${baseId}-title`;
  const slugId = `${baseId}-slug`;
  const takeawayId = `${baseId}-takeaway`;
  const contextId = `${baseId}-context`;
  const critiqueId = `${baseId}-critique`;
  const chapterId = `${baseId}-chapter`;
  const tagsId = `${baseId}-tags`;

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugError, setSlugError] = useState<string | null>(null);
  const [takeaway, setTakeaway] = useState('');
  const [contextMechanism, setContextMechanism] = useState('');
  const [deltaTrigger, setDeltaTrigger] = useState('');
  const [deltaAction, setDeltaAction] = useState('');
  const [deltaStatus, setDeltaStatus] = useState<DeltaStatus>('none');
  const [critique, setCritique] = useState('');
  const [chapter, setChapter] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [deltaOpen, setDeltaOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState('');
  const [resetTick, setResetTick] = useState(0);

  const titleRef = useRef<HTMLInputElement>(null);
  const canonicalRef = useRef<DeepenCanonical>({
    title: '',
    slug: '',
    takeaway: '',
    contextMechanism: '',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none',
    critique: '',
    chapter: '',
    tagsRaw: '',
  });

  const applyFields = (vals: DeepenCanonical) => {
    setTitle(vals.title);
    setSlug(vals.slug);
    setTakeaway(vals.takeaway);
    setContextMechanism(vals.contextMechanism);
    setDeltaTrigger(vals.deltaTrigger);
    setDeltaAction(vals.deltaAction);
    setDeltaStatus(vals.deltaStatus);
    setCritique(vals.critique);
    setChapter(vals.chapter);
    setTagsRaw(vals.tagsRaw);
  };

  const c = canonicalRef.current;
  const isDirty =
    title !== c.title ||
    slug !== c.slug ||
    takeaway !== c.takeaway ||
    contextMechanism !== c.contextMechanism ||
    deltaTrigger !== c.deltaTrigger ||
    deltaAction !== c.deltaAction ||
    deltaStatus !== c.deltaStatus ||
    critique !== c.critique ||
    chapter !== c.chapter ||
    tagsRaw !== c.tagsRaw;

  const draftPayload = useMemo<DeepenDraft>(
    () => ({
      baseUpdatedAt: baseUpdatedAt || note?.updatedAt || '',
      title,
      slug,
      takeaway,
      contextMechanism,
      deltaTrigger,
      deltaAction,
      deltaStatus,
      critique,
      chapter,
      tagsRaw,
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
      note?.updatedAt,
      slug,
      tagsRaw,
      takeaway,
      title,
    ]
  );

  const finishSessionSetup = (
    currentNote: Note,
    activeFields: DeepenCanonical,
    swapping: boolean
  ) => {
    const noteBook = books.find(b => b.id === currentNote.bookId);
    setDeltaOpen(
      shouldDefaultOpenDeltaDetails({
        bookKind: noteBook?.kind,
        triggerBody: activeFields.deltaTrigger,
        actionBody: activeFields.deltaAction,
        deltaStatus: activeFields.deltaStatus,
      })
    );
    setSlugError(null);
    setSubmitting(false);
    setResetTick(t => t + 1);
    if (swapping) requestAnimationFrame(() => titleRef.current?.focus());
  };

  const { draftRestored, markSubmitted, discardDraft } = useModalDraft<DeepenDraft>({
    isOpen: isOpen && Boolean(note),
    sessionId: note?.id ?? null,
    draftKey: note ? getDeepenDraftKey(note.id) : '',
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
        validDraft.takeaway !== c.takeaway ||
        validDraft.contextMechanism !== c.contextMechanism ||
        validDraft.deltaTrigger !== c.deltaTrigger ||
        validDraft.deltaAction !== c.deltaAction ||
        validDraft.deltaStatus !== c.deltaStatus ||
        validDraft.critique !== c.critique ||
        (validDraft.chapter ?? c.chapter) !== c.chapter ||
        (validDraft.tagsRaw ?? c.tagsRaw) !== c.tagsRaw
      );
    },
    onRestore: (validDraft, { swapping }) => {
      if (!note) return;
      const c = buildCanonical(note);
      canonicalRef.current = c;
      setBaseUpdatedAt(note.updatedAt);
      const restoredFields: DeepenCanonical = {
        title: validDraft.title,
        slug: validDraft.slug,
        takeaway: validDraft.takeaway,
        contextMechanism: validDraft.contextMechanism,
        deltaTrigger: validDraft.deltaTrigger,
        deltaAction: validDraft.deltaAction,
        deltaStatus: validDraft.deltaStatus || 'none',
        critique: validDraft.critique,
        chapter: validDraft.chapter ?? c.chapter,
        tagsRaw: validDraft.tagsRaw ?? c.tagsRaw,
      };
      applyFields(restoredFields);
      finishSessionSetup(note, restoredFields, swapping);
    },
    onInitCanonical: ({ swapping }) => {
      if (!note) return;
      const c = buildCanonical(note);
      canonicalRef.current = c;
      setBaseUpdatedAt(note.updatedAt);
      applyFields(c);
      finishSessionSetup(note, c, swapping);
    },
    onDiscard: () => {
      const canon = canonicalRef.current;
      applyFields(canon);
      const noteBook = note ? books.find(b => b.id === note.bookId) : undefined;
      setDeltaOpen(
        shouldDefaultOpenDeltaDetails({
          bookKind: noteBook?.kind,
          triggerBody: canon.deltaTrigger,
          actionBody: canon.deltaAction,
          deltaStatus: canon.deltaStatus,
        })
      );
      setSlugError(null);
      setResetTick(t => t + 1);
    },
  });

  const book = useMemo(
    () => (note ? books.find(b => b.id === note.bookId) || null : null),
    [books, note]
  );
  const chapterSuggestion = note ? deepenChapterSuggestion(note, book) : null;

  const otherActiveCount = useMemo(
    () => (note ? countOtherActiveDeltas(notes, note.id) : 0),
    [note, notes]
  );

  const persistDeepen = async (mode: 'draft' | 'atomic', options: { next?: boolean } = {}) => {
    if (!note) return;

    const deltaCheck = validateDeltaForSave({
      deltaTrigger,
      deltaAction,
      deltaStatus,
      otherActiveCount,
      emptyActiveMessage: 'Add a WHEN trigger or DO action to activate this Behavioral Delta',
    });
    if (!deltaCheck.ok) {
      showToast(deltaCheck.error, 'error');
      return;
    }

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
          status: mode === 'atomic' ? 'atomic' : note.status,
          takeaway: takeaway.trim(),
          contextMechanism: contextMechanism.trim(),
          critique: critique.trim(),
          deltaTrigger: deltaCheck.normalizedTrigger,
          deltaAction: deltaCheck.normalizedAction,
          deltaStatus,
          tags: parseTagsCsv(tagsRaw),
          meta: {
            ...withChapterKey(note.meta, 'chapter', chapter),
            ...(title.trim() ? { title: title.trim() } : { title: undefined }),
          },
        },
        {
          expectedBaseUpdatedAt: baseUpdatedAt || note.updatedAt,
          ownedMetaKeys: NOTE_CHAPTER_EDITOR_OWNED_META_KEYS,
          baseMeta: note.meta,
        }
      );

      markSubmitted();
      onSaved?.(saved);
      if (options.next) {
        const next = nextInboxNote(
          notes.map(n => (n.id === saved.id ? saved : n)),
          books,
          saved.id
        );
        if (next && onOpenNext) {
          showToast('Note deepened to Atomic', 'success');
          onOpenNext(next);
          return;
        }
        showToast(SAVE_NEXT_DONE_MESSAGE, 'success');
        onClose();
        return;
      }
      showToast(
        mode === 'atomic' ? 'Note deepened to Atomic' : 'Deepening draft saved',
        mode === 'atomic' ? 'success' : 'info'
      );
      onClose();
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to deepen note'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!note) return null;

  const socraticQuestions = note.meta?.socraticQuestions;
  const isFiction = book?.kind === 'fiction';
  const canSaveNext =
    Boolean(onOpenNext) && isToSpar(note) && nextInboxNote(notes, books, note.id) !== null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      dataTestId="deepen-note-modal"
      title="Deepen to Atomic Note"
      headingId={headingId}
      maxWidth="max-w-2xl"
    >
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 id={headingId} className="text-title text-foreground">
            Deepen to Atomic Note
          </h2>
          {book && (
            <p className="text-label text-muted-foreground truncate">
              {book.title} · {book.kind === 'fiction' ? 'Fiction Lens' : 'Non-Fiction Lens'}
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className={MODAL_CLOSE_BTN}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <DraftRestoredBanner visible={draftRestored} onDiscard={discardDraft} />

      <DeepenSourceReference note={note} />

      {note.status === 'in-reflection' && socraticQuestions && socraticQuestions.length > 0 && (
        <div className="mb-4 rounded-[12px] bg-surface2 border border-border p-4 space-y-2">
          <div className="flex items-center gap-1.5 text-label font-semibold text-warning uppercase tracking-wide">
            <Sparkles className="w-4 h-4 shrink-0" />
            <span>Saved Socratic Questions</span>
          </div>
          <ul className="list-disc pl-5 space-y-1 text-body text-foreground">
            {socraticQuestions.map((q, idx) => (
              <li key={idx}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      <form
        onSubmit={e => {
          e.preventDefault();
          void persistDeepen('atomic');
        }}
        onKeyDown={e => {
          if (isSubmitShortcut(e.nativeEvent)) {
            e.preventDefault();
            if (!submitting) e.currentTarget.requestSubmit();
          }
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor={titleId} className={FIELD_LABEL}>
              Concept Title
            </label>
            <input
              id={titleId}
              type="text"
              ref={titleRef}
              data-testid="deepen-title-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Distilled concept title..."
              className={INPUT}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={slugId} className={FIELD_LABEL}>
              Wikilink Slug
            </label>
            <input
              id={slugId}
              type="text"
              data-testid="deepen-slug-input"
              value={slug}
              onChange={e => {
                setSlug(e.target.value);
                setSlugError(null);
              }}
              onBlur={e => setSlug(normalizeSlugInput(e.target.value))}
              aria-invalid={Boolean(slugError)}
              aria-describedby={slugError ? `${slugId}-error` : undefined}
              placeholder="concept-slug"
              className="w-full h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input font-mono text-base sm:text-label text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
            {slugError && (
              <p
                id={`${slugId}-error`}
                role="alert"
                data-testid="deepen-slug-error"
                className="text-label text-negative"
              >
                {slugError}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={tagsId} className={FIELD_LABEL}>
            Tags
          </label>
          <input
            id={tagsId}
            type="text"
            autoComplete="off"
            data-testid="deepen-tags-input"
            value={tagsRaw}
            onChange={e => setTagsRaw(e.target.value)}
            placeholder="#craft, #subtext"
            className={INPUT}
          />
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
            data-testid="deepen-chapter-input"
            value={chapter}
            onChange={e => setChapter(e.target.value)}
            placeholder="e.g. Ch. 3: Run · or a story title"
            className={INPUT}
          />
          {chapterSuggestion && !chapter.trim() && (
            <button
              type="button"
              data-testid="deepen-chapter-suggestion-btn"
              onClick={() => setChapter(chapterSuggestion)}
              className="min-h-11 sm:min-h-0 px-3 sm:px-2.5 py-1 rounded-[8px] bg-surface2 border border-border text-label text-foreground hover:bg-secondary inline-flex items-center"
            >
              Use &quot;{chapterSuggestion}&quot;
            </button>
          )}
        </div>

        <WikilinkTextarea
          id={takeawayId}
          rows={3}
          dataTestId="deepen-takeaway-input"
          label="Core Takeaway / Own Words (supports [[wikilinks]])"
          value={takeaway}
          onValueChange={setTakeaway}
          notes={notes}
          books={books}
          excludeNoteId={note.id}
          excludeSlug={note.slug}
          resetKey={resetTick}
          placeholder="Distill the core idea in your own words. Type [[ to link concepts..."
        />

        <WikilinkTextarea
          id={contextId}
          rows={3}
          dataTestId="deepen-context-input"
          label="Context & Mechanism (supports [[wikilinks]])"
          value={contextMechanism}
          onValueChange={setContextMechanism}
          notes={notes}
          books={books}
          excludeNoteId={note.id}
          excludeSlug={note.slug}
          resetKey={resetTick}
          placeholder={
            isFiction
              ? 'Scene craft, subtext, character tension, or thematic echo...'
              : 'How the mechanism works in the author’s model...'
          }
        />

        <DeltaFieldsSection
          variant="deepen"
          deltaTrigger={deltaTrigger}
          onTriggerChange={setDeltaTrigger}
          deltaAction={deltaAction}
          onActionChange={setDeltaAction}
          deltaStatus={deltaStatus}
          onStatusChange={setDeltaStatus}
          otherActiveCount={otherActiveCount}
          collapsible={isFiction}
          defaultOpen={deltaOpen}
          collapseKey={`${note.id}-${resetTick}-${deltaOpen ? 'open' : 'closed'}`}
        />

        <WikilinkTextarea
          id={critiqueId}
          rows={2}
          dataTestId="deepen-critique-input"
          label="Socratic Critique & Boundary Conditions (supports [[wikilinks]])"
          value={critique}
          onValueChange={setCritique}
          notes={notes}
          books={books}
          excludeNoteId={note.id}
          excludeSlug={note.slug}
          resetKey={resetTick}
          placeholder="Where does this model fail or break down?"
        />

        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={BTN_GHOST_LG}>
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            data-testid="deepen-save-draft-btn"
            onClick={() => void persistDeepen('draft')}
            className="h-11 sm:h-10 px-4 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-body font-semibold text-foreground disabled:opacity-50"
          >
            Save Draft
          </button>
          {canSaveNext && (
            <button
              type="button"
              disabled={submitting}
              data-testid="deepen-save-next-btn"
              onClick={() => void persistDeepen('atomic', { next: true })}
              className="h-11 sm:h-10 px-4 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-body font-semibold text-foreground disabled:opacity-50"
            >
              Save &amp; Next
            </button>
          )}
          <button
            type="submit"
            disabled={submitting}
            data-testid="deepen-submit-btn"
            className="h-11 sm:h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save Atomic Note'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
