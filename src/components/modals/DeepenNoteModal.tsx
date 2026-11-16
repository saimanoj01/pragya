import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RotateCcw, Sparkles, X } from 'lucide-react';
import type { DeltaStatus, Note } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import {
  formatWhenDoDisplay,
  normalizeDeltaAction,
  normalizeDeltaTrigger,
} from '../../utils/deltaFormat';
import {
  clearDraft,
  getDeepenDraftKey,
  isNoteDraftStale,
  readDraft,
  writeDraft,
  type DeepenDraft,
} from '../../utils/draftStorage';
import { generateUniqueSlug } from '../../utils/wikilinks';
import { showToast } from '../../utils/toast';
import { Modal } from '../common/Modal';
import { WikilinkAutocomplete } from '../common/WikilinkAutocomplete';

export interface DeepenNoteModalProps {
  note: Note | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (savedNote: Note) => void;
}

export const DeepenNoteModal: React.FC<DeepenNoteModalProps> = ({
  note,
  isOpen,
  onClose,
  onSaved,
}) => {
  const { books, notes, updateNote } = usePragya();
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const titleId = `${baseId}-title`;
  const slugId = `${baseId}-slug`;
  const takeawayId = `${baseId}-takeaway`;
  const contextId = `${baseId}-context`;
  const triggerId = `${baseId}-trigger`;
  const actionId = `${baseId}-action`;
  const deltaStatusId = `${baseId}-delta-status`;
  const critiqueId = `${baseId}-critique`;

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [takeaway, setTakeaway] = useState('');
  const [contextMechanism, setContextMechanism] = useState('');
  const [deltaTrigger, setDeltaTrigger] = useState('');
  const [deltaAction, setDeltaAction] = useState('');
  const [deltaStatus, setDeltaStatus] = useState<DeltaStatus>('none');
  const [critique, setCritique] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState('');

  const [takeawayCursor, setTakeawayCursor] = useState<number | null>(null);
  const [contextCursor, setContextCursor] = useState<number | null>(null);
  const [critiqueCursor, setCritiqueCursor] = useState<number | null>(null);

  const takeawayRef = useRef<HTMLTextAreaElement>(null);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  const critiqueRef = useRef<HTMLTextAreaElement>(null);

  const wasOpenRef = useRef(false);
  const initializedIdRef = useRef<string | null>(null);
  const submittedOrDiscardedRef = useRef(false);
  const canonicalRef = useRef({
    title: '',
    slug: '',
    takeaway: '',
    contextMechanism: '',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none' as DeltaStatus,
    critique: '',
  });

  const isDirty = useMemo(() => {
    const c = canonicalRef.current;
    return (
      title !== c.title ||
      slug !== c.slug ||
      takeaway !== c.takeaway ||
      contextMechanism !== c.contextMechanism ||
      deltaTrigger !== c.deltaTrigger ||
      deltaAction !== c.deltaAction ||
      deltaStatus !== c.deltaStatus ||
      critique !== c.critique
    );
  }, [title, slug, takeaway, contextMechanism, deltaTrigger, deltaAction, deltaStatus, critique]);

  const draftStateRef = useRef<{
    key: string;
    isDirty: boolean;
    payload: DeepenDraft;
  }>({
    key: '',
    isDirty: false,
    payload: {
      baseUpdatedAt: '',
      title: '',
      slug: '',
      takeaway: '',
      contextMechanism: '',
      deltaTrigger: '',
      deltaAction: '',
      deltaStatus: 'none',
      critique: '',
      savedAt: '',
    },
  });
  draftStateRef.current = {
    key: note ? getDeepenDraftKey(note.id) : '',
    isDirty,
    payload: {
      baseUpdatedAt: baseUpdatedAt || note?.updatedAt || '',
      title,
      slug,
      takeaway,
      contextMechanism,
      deltaTrigger,
      deltaAction,
      deltaStatus,
      critique,
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
      takeaway: note.takeaway || '',
      contextMechanism: note.contextMechanism || '',
      deltaTrigger: formattedDelta.triggerBody,
      deltaAction: formattedDelta.actionBody,
      deltaStatus: (note.deltaStatus || 'none') as DeltaStatus,
      critique: note.critique || '',
    };
    canonicalRef.current = canonical;
    setBaseUpdatedAt(note.updatedAt);

    const draftKey = getDeepenDraftKey(note.id);
    const savedDraft = readDraft<DeepenDraft>(draftKey);
    if (savedDraft && isNoteDraftStale(savedDraft.baseUpdatedAt, note.updatedAt)) {
      clearDraft(draftKey);
    }

    const validDraft =
      savedDraft && !isNoteDraftStale(savedDraft.baseUpdatedAt, note.updatedAt) ? savedDraft : null;
    const draftHasEdits =
      validDraft &&
      (validDraft.title !== canonical.title ||
        validDraft.slug !== canonical.slug ||
        validDraft.takeaway !== canonical.takeaway ||
        validDraft.contextMechanism !== canonical.contextMechanism ||
        validDraft.deltaTrigger !== canonical.deltaTrigger ||
        validDraft.deltaAction !== canonical.deltaAction ||
        validDraft.deltaStatus !== canonical.deltaStatus ||
        validDraft.critique !== canonical.critique);

    if (validDraft && draftHasEdits) {
      setTitle(validDraft.title);
      setSlug(validDraft.slug);
      setTakeaway(validDraft.takeaway);
      setContextMechanism(validDraft.contextMechanism);
      setDeltaTrigger(validDraft.deltaTrigger);
      setDeltaAction(validDraft.deltaAction);
      setDeltaStatus(validDraft.deltaStatus || 'none');
      setCritique(validDraft.critique);
      setDraftRestored(true);
    } else {
      setTitle(canonical.title);
      setSlug(canonical.slug);
      setTakeaway(canonical.takeaway);
      setContextMechanism(canonical.contextMechanism);
      setDeltaTrigger(canonical.deltaTrigger);
      setDeltaAction(canonical.deltaAction);
      setDeltaStatus(canonical.deltaStatus);
      setCritique(canonical.critique);
      setDraftRestored(false);
    }

    setTakeawayCursor(null);
    setContextCursor(null);
    setCritiqueCursor(null);
    setSubmitting(false);
  }, [isOpen, note]);

  // Debounced (250ms) draft autosave
  useEffect(() => {
    if (!isOpen || !note || !wasOpenRef.current) return;
    if (isDirty) {
      submittedOrDiscardedRef.current = false;
    }
    const key = getDeepenDraftKey(note.id);
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
    takeaway,
    contextMechanism,
    deltaTrigger,
    deltaAction,
    deltaStatus,
    critique,
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
    clearDraft(getDeepenDraftKey(note.id));
    const c = canonicalRef.current;
    setTitle(c.title);
    setSlug(c.slug);
    setTakeaway(c.takeaway);
    setContextMechanism(c.contextMechanism);
    setDeltaTrigger(c.deltaTrigger);
    setDeltaAction(c.deltaAction);
    setDeltaStatus(c.deltaStatus);
    setCritique(c.critique);
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

  const capReached = otherActiveCount >= 5;
  const isDeltaCapViolation = capReached && deltaStatus === 'active';

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
      showToast('Add a WHEN trigger or DO action to activate this Behavioral Delta', 'error');
      return;
    }

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
          status: 'atomic',
          takeaway: takeaway.trim(),
          contextMechanism: contextMechanism.trim(),
          critique: critique.trim(),
          deltaTrigger: normalizedTrigger,
          deltaAction: normalizedAction,
          deltaStatus,
          meta: {
            ...note.meta,
            ...(title.trim() ? { title: title.trim() } : { title: undefined }),
          },
        },
        { expectedBaseUpdatedAt: baseUpdatedAt || note.updatedAt }
      );

      submittedOrDiscardedRef.current = true;
      clearDraft(getDeepenDraftKey(note.id));
      setDraftRestored(false);
      showToast('Note deepened to Atomic', 'success');
      onSaved?.(saved);
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to deepen note', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (!note) return null;

  const socraticQuestions = note.meta?.socraticQuestions;

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

      <form onSubmit={e => void handleSubmit(e)} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label
              htmlFor={titleId}
              className="block text-eyebrow uppercase text-muted-foreground"
            >
              Concept Title
            </label>
            <input
              id={titleId}
              type="text"
              data-testid="deepen-title-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Distilled concept title..."
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={slugId} className="block text-eyebrow uppercase text-muted-foreground">
              Wikilink Slug
            </label>
            <input
              id={slugId}
              type="text"
              data-testid="deepen-slug-input"
              value={slug}
              onChange={e => setSlug(e.target.value)}
              placeholder="concept-slug"
              className="w-full h-10 px-3 rounded-[10px] bg-background border border-input font-mono text-label text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>
        </div>

        <div className="space-y-1.5 relative">
          <label
            htmlFor={takeawayId}
            className="block text-eyebrow uppercase text-muted-foreground"
          >
            Core Takeaway / Own Words (supports [[wikilinks]])
          </label>
          <textarea
            id={takeawayId}
            ref={takeawayRef}
            rows={3}
            data-testid="deepen-takeaway-input"
            value={takeaway}
            onChange={e => {
              setTakeaway(e.target.value);
              setTakeawayCursor(e.target.selectionStart);
            }}
            onClick={e => setTakeawayCursor(e.currentTarget.selectionStart)}
            onKeyUp={e => setTakeawayCursor(e.currentTarget.selectionStart)}
            onBlur={() => setTakeawayCursor(null)}
            placeholder="Distill the core idea in your own words. Type [[ to link concepts..."
            className="w-full p-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
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
            rows={3}
            data-testid="deepen-context-input"
            value={contextMechanism}
            onChange={e => {
              setContextMechanism(e.target.value);
              setContextCursor(e.target.selectionStart);
            }}
            onClick={e => setContextCursor(e.currentTarget.selectionStart)}
            onKeyUp={e => setContextCursor(e.currentTarget.selectionStart)}
            onBlur={() => setContextCursor(null)}
            placeholder={
              book?.kind === 'fiction'
                ? 'Scene craft, subtext, character tension, or thematic echo...'
                : 'How the mechanism works in the author’s model...'
            }
            className="w-full p-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
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

        {/* Behavioral Delta Section */}
        <div className="rounded-[12px] bg-surface2/50 border border-border p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-eyebrow uppercase text-muted-foreground">
              Behavioral Delta (Optional)
            </span>
            <span className="text-[11px] text-muted-foreground num">
              Active slots used: {otherActiveCount}/5
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label
                htmlFor={triggerId}
                className="block text-[11px] font-semibold uppercase text-muted-foreground"
              >
                WHEN (Trigger Condition)
              </label>
              <input
                id={triggerId}
                type="text"
                data-testid="deepen-trigger-input"
                value={deltaTrigger}
                onChange={e => setDeltaTrigger(e.target.value)}
                placeholder="e.g. a dashboard metric spikes unexpectedly"
                className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor={actionId}
                className="block text-[11px] font-semibold uppercase text-muted-foreground"
              >
                DO (Concrete Action)
              </label>
              <input
                id={actionId}
                type="text"
                data-testid="deepen-action-input"
                value={deltaAction}
                onChange={e => setDeltaAction(e.target.value)}
                placeholder="e.g. observe the delay window before changing knobs"
                className="w-full h-10 px-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="sm:w-56 space-y-1">
              <label
                htmlFor={deltaStatusId}
                className="block text-[11px] font-semibold uppercase text-muted-foreground"
              >
                Delta Status
              </label>
              <select
                id={deltaStatusId}
                data-testid="deepen-delta-status-select"
                value={deltaStatus}
                onChange={e => setDeltaStatus(e.target.value as DeltaStatus)}
                className="w-full h-10 px-2.5 rounded-[10px] bg-background border border-input text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
              >
                <option value="none">None</option>
                <option value="active">Active (Practice)</option>
                <option value="paused">Paused</option>
                <option value="graduated">Graduated</option>
              </select>
            </div>

            {capReached && deltaStatus !== 'active' && (
              <p className="text-label text-muted-foreground sm:pt-5">
                5/5 active delta slots are full; graduate or pause an active delta in Practice
                before activating another.
              </p>
            )}
          </div>

          {isDeltaCapViolation && (
            <div
              data-testid="deepen-delta-cap-warning"
              className="rounded-[10px] bg-negative/10 border border-negative/30 px-3 py-2.5 flex items-start gap-2 text-label text-negative"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Active Behavioral Delta cap (5/5) reached. Select Paused/None or graduate an active
                delta in Practice first.
              </span>
            </div>
          )}
        </div>

        <div className="space-y-1.5 relative">
          <label
            htmlFor={critiqueId}
            className="block text-eyebrow uppercase text-muted-foreground"
          >
            Socratic Critique &amp; Boundary Conditions (supports [[wikilinks]])
          </label>
          <textarea
            id={critiqueId}
            ref={critiqueRef}
            rows={2}
            data-testid="deepen-critique-input"
            value={critique}
            onChange={e => {
              setCritique(e.target.value);
              setCritiqueCursor(e.target.selectionStart);
            }}
            onClick={e => setCritiqueCursor(e.currentTarget.selectionStart)}
            onKeyUp={e => setCritiqueCursor(e.currentTarget.selectionStart)}
            onBlur={() => setCritiqueCursor(null)}
            placeholder="Where does this model fail or break down?"
            className="w-full p-3 rounded-[10px] bg-background border border-input text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
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
            disabled={submitting}
            data-testid="deepen-submit-btn"
            className="h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save Atomic Note'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
