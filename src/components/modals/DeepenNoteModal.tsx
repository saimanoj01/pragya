import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  Link2,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import type { Attachment, DeltaStatus, Note } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { NOTE_CHAPTER_EDITOR_OWNED_META_KEYS, getRenderableAttachments } from '../../utils/metaCodecs';
import { CHAPTER_MAX_LENGTH, deepenChapterSuggestion, withChapterKey } from '../../utils/chapterFormat';
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
import { isSafeHttpUrl } from '../../utils/navigation';
import { normalizeSlugInput, resolveSlugEdit, takenSlugs } from '../../utils/wikilinks';
import { showToast } from '../../utils/toast';
import { isSubmitShortcut } from '../../utils/keyboard';
import { DriveImage } from '../common/DriveImage';
import { Modal } from '../common/Modal';
import { WikilinkAutocomplete } from '../common/WikilinkAutocomplete';
import { ImageLightbox } from './ImageLightbox';
import { describeSyncError } from '../../utils/apiErrors';
import { countOtherActiveDeltas } from '../../utils/archive';
import { parseTagsCsv } from '../../utils/sheetCodecs';
import { SAVE_NEXT_DONE_MESSAGE, isToSpar, nextInboxNote } from '../../utils/deepenFlow';

export interface DeepenNoteModalProps {
  note: Note | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved?: (savedNote: Note) => void;
  /** CD C4.5 "Save & Next": open Deepen on the next To Spar note (modal stays open). */
  onOpenNext?: (next: Note) => void;
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
  const triggerId = `${baseId}-trigger`;
  const actionId = `${baseId}-action`;
  const deltaStatusId = `${baseId}-delta-status`;
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
  // CD C4.5: fiction notes keep the Behavioral Delta collapsed unless one already exists
  // (initial state per note; the <details> is uncontrolled afterwards).
  const [deltaOpen, setDeltaOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState('');
  const [showSourceRef, setShowSourceRef] = useState(true);
  const [lightboxAtt, setLightboxAtt] = useState<Extract<Attachment, { type: 'image' }> | null>(
    null
  );

  const [takeawayCursor, setTakeawayCursor] = useState<number | null>(null);
  const [contextCursor, setContextCursor] = useState<number | null>(null);
  const [critiqueCursor, setCritiqueCursor] = useState<number | null>(null);

  const takeawayRef = useRef<HTMLTextAreaElement>(null);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  const critiqueRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

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
    chapter: '',
    tagsRaw: '',
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
      critique !== c.critique ||
      chapter !== c.chapter ||
      tagsRaw !== c.tagsRaw
    );
  }, [title, slug, takeaway, contextMechanism, deltaTrigger, deltaAction, deltaStatus, critique, chapter, tagsRaw]);

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
      chapter: '',
      tagsRaw: '',
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
      chapter,
      tagsRaw,
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
    // CD C4.5 Save & Next swaps the note while the modal stays open.
    const swapping = wasOpenRef.current && initializedIdRef.current !== null;
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
      chapter: typeof note.meta?.chapter === 'string' ? note.meta.chapter : '',
      tagsRaw: Array.isArray(note.tags) ? note.tags.join(', ') : '',
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
        validDraft.critique !== canonical.critique ||
        (validDraft.chapter ?? canonical.chapter) !== canonical.chapter ||
        (validDraft.tagsRaw ?? canonical.tagsRaw) !== canonical.tagsRaw);

    if (validDraft && draftHasEdits) {
      setTitle(validDraft.title);
      setSlug(validDraft.slug);
      setTakeaway(validDraft.takeaway);
      setContextMechanism(validDraft.contextMechanism);
      setDeltaTrigger(validDraft.deltaTrigger);
      setDeltaAction(validDraft.deltaAction);
      setDeltaStatus(validDraft.deltaStatus || 'none');
      setCritique(validDraft.critique);
      setChapter(validDraft.chapter ?? canonical.chapter);
      setTagsRaw(validDraft.tagsRaw ?? canonical.tagsRaw);
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
      setChapter(canonical.chapter);
      setTagsRaw(canonical.tagsRaw);
      setDraftRestored(false);
    }

    const noteBook = books.find(b => b.id === note.bookId);
    setDeltaOpen(
      noteBook?.kind !== 'fiction' ||
        Boolean(formattedDelta.triggerBody || formattedDelta.actionBody) ||
        (note.deltaStatus || 'none') !== 'none'
    );
    setTakeawayCursor(null);
    setSlugError(null);
    setContextCursor(null);
    setCritiqueCursor(null);
    setSubmitting(false);
    setShowSourceRef(true);
    setLightboxAtt(null);
    // Save & Next: focus the first field of the next note.
    if (swapping) requestAnimationFrame(() => titleRef.current?.focus());
  }, [isOpen, note, books]);

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
    chapter,
    tagsRaw,
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
    setChapter(c.chapter);
    setTagsRaw(c.tagsRaw);
    setDraftRestored(false);
  };

  const book = useMemo(
    () => (note ? books.find(b => b.id === note.bookId) || null : null),
    [books, note]
  );
  // B.2: Deepen is deliberate — suggest the bookmark chapter, never auto-fill it.
  const chapterSuggestion = note ? deepenChapterSuggestion(note, book) : null;

  const otherActiveCount = useMemo(() => {
    if (!note) return 0;
    return countOtherActiveDeltas(notes, note.id);
  }, [note, notes]);

  const capReached = otherActiveCount >= 5;
  const isDeltaCapViolation = capReached && deltaStatus === 'active';

  const persistDeepen = async (mode: 'draft' | 'atomic', options: { next?: boolean } = {}) => {
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
      // CD 3 fix-up R2#1: explicit slug edits are validated (no silent -2 suffix).
      const slugEdit = resolveSlugEdit({
        rawSlug: slug,
        title,
        originalSlug: note.slug,
        taken: takenSlugs(notes, note.id), // CD C3.2: other notes' aliases are taken too
      });
      if (slugEdit.error) {
        setSlugError(slugEdit.error);
        setSubmitting(false);
        return;
      }
      const nextSlug = slugEdit.slug;

      const saved = await updateNote(
        {
          ...note,
          slug: nextSlug,
          status: mode === 'atomic' ? 'atomic' : note.status,
          takeaway: takeaway.trim(),
          contextMechanism: contextMechanism.trim(),
          critique: critique.trim(),
          deltaTrigger: normalizedTrigger,
          deltaAction: normalizedAction,
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

      submittedOrDiscardedRef.current = true;
      clearDraft(getDeepenDraftKey(note.id));
      setDraftRestored(false);
      onSaved?.(saved);
      if (options.next) {
        // CD C4.5: next To Spar note, oldest first, skipping shielded/archived ones.
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await persistDeepen('atomic');
  };

  if (!note) return null;

  const socraticQuestions = note.meta?.socraticQuestions;
  const isFiction = book?.kind === 'fiction';
  const canSaveNext = Boolean(onOpenNext) && isToSpar(note) && nextInboxNote(notes, books, note.id) !== null;
  const sourceAttachments = getRenderableAttachments(note.meta);
  const hasSourceReference = Boolean(note.quote?.trim()) || sourceAttachments.length > 0;

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
          className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 p-1.5 rounded-[8px] inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface2 shrink-0"
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
            className="min-h-11 sm:min-h-0 px-2 sm:px-0 inline-flex items-center gap-1 font-semibold text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Discard</span>
          </button>
        </div>
      )}

      {hasSourceReference && (
        <div
          data-testid="deepen-source-reference"
          className="mb-4 rounded-[12px] bg-surface2/50 border border-border overflow-hidden"
        >
          <button
            type="button"
            data-testid="deepen-source-toggle"
            aria-expanded={showSourceRef}
            onClick={() => setShowSourceRef(prev => !prev)}
            className="w-full min-h-11 px-4 py-2.5 flex items-center justify-between gap-2 text-left text-eyebrow uppercase text-muted-foreground hover:text-foreground transition-colors"
          >
            <span>
              Source Passage{sourceAttachments.length > 0 ? ` & Attachments (${sourceAttachments.length})` : ''}
            </span>
            {showSourceRef ? (
              <ChevronUp className="w-4 h-4 shrink-0" />
            ) : (
              <ChevronDown className="w-4 h-4 shrink-0" />
            )}
          </button>

          {showSourceRef && (
            <div className="px-4 pb-3.5 pt-1 space-y-3 border-t border-border/50">
              {note.quote?.trim() && (
                <blockquote
                  data-testid="deepen-source-quote"
                  className="pl-3 border-l-2 border-border italic text-body text-muted-foreground whitespace-pre-wrap"
                >
                  &ldquo;{note.quote}&rdquo;
                </blockquote>
              )}

              {sourceAttachments.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {sourceAttachments.map(att =>
                    att.type === 'image' ? (
                      <button
                        key={att.id}
                        type="button"
                        data-testid={`deepen-attachment-image-${att.id}`}
                        aria-label={`Preview ${att.fileName}`}
                        onClick={() => setLightboxAtt(att)}
                        className="rounded-[8px] border border-border overflow-hidden hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring/50"
                      >
                        <DriveImage
                          attachment={att}
                          alt={att.fileName}
                          className="w-16 h-16 object-cover"
                        />
                      </button>
                    ) : isSafeHttpUrl(att.url) ? (
                      <a
                        key={att.id}
                        href={att.url.trim()}
                        data-print-href={att.url.trim()}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-11 sm:min-h-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] bg-background border border-border text-label text-foreground hover:bg-surface2"
                      >
                        {att.type === 'doc' ? (
                          <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        ) : (
                          <Link2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        )}
                        <span className="truncate max-w-[180px]">{att.title}</span>
                      </a>
                    ) : (
                      <span
                        key={att.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] bg-background border border-border text-label text-muted-foreground"
                      >
                        <Link2 className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate max-w-[180px]">{att.title}</span>
                      </span>
                    )
                  )}
                </div>
              )}
            </div>
          )}
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

      <form
        onSubmit={e => void handleSubmit(e)}
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
            <label
              htmlFor={titleId}
              className="block text-eyebrow uppercase text-muted-foreground"
            >
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
              className="w-full h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
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
              <p id={`${slugId}-error`} role="alert" data-testid="deepen-slug-error" className="text-label text-negative">
                {slugError}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={tagsId} className="block text-eyebrow uppercase text-muted-foreground">
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
            className="w-full h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor={chapterId} className="block text-eyebrow uppercase text-muted-foreground">
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
            className="w-full h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
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
            className="w-full p-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          />
          <WikilinkAutocomplete
            textareaRef={takeawayRef}
            value={takeaway}
            cursorPos={takeawayCursor}
            notes={notes}
            books={books}
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
            className="w-full p-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          />
          <WikilinkAutocomplete
            textareaRef={contextRef}
            value={contextMechanism}
            cursorPos={contextCursor}
            notes={notes}
            books={books}
            excludeNoteId={note.id}
            excludeSlug={note.slug}
            onSelect={(nextVal, nextCursor) => {
              setContextMechanism(nextVal);
              setContextCursor(nextCursor);
            }}
          />
        </div>

        {/* Behavioral Delta Section */}
        {isFiction ? (
          <details
            // Uncontrolled after mount: remount when the per-note initial state is computed.
            key={`${note.id}-${deltaOpen ? 'open' : 'closed'}`}
            data-testid="deepen-delta-details"
            open={deltaOpen || undefined}
            className="group rounded-[12px] bg-surface2/50 border border-border p-4 space-y-3"
          >
            <summary className="min-h-11 sm:min-h-0 flex flex-wrap items-center justify-between gap-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <span className="inline-flex items-center gap-1.5 text-eyebrow uppercase text-muted-foreground">
                <ChevronRight
                  className="w-4 h-4 transition-transform group-open:rotate-90"
                  aria-hidden="true"
                />
                Behavioral Delta (optional for fiction)
              </span>
              <span className="text-[11px] text-muted-foreground num">
                Active slots used: {otherActiveCount}/5
              </span>
            </summary>
            <div className="space-y-3 pt-3">
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
                className="w-full h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
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
                className="w-full h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
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
                className="w-full h-11 sm:h-10 px-2.5 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
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
          </details>
        ) : (
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
                className="w-full h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
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
                className="w-full h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
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
                className="w-full h-11 sm:h-10 px-2.5 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
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
        )}

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
            className="w-full p-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
          />
          <WikilinkAutocomplete
            textareaRef={critiqueRef}
            value={critique}
            cursorPos={critiqueCursor}
            notes={notes}
            books={books}
            excludeNoteId={note.id}
            excludeSlug={note.slug}
            onSelect={(nextVal, nextCursor) => {
              setCritique(nextVal);
              setCritiqueCursor(nextCursor);
            }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-11 sm:h-10 px-4 rounded-[10px] text-body font-medium text-muted-foreground hover:text-foreground hover:bg-surface2"
          >
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

      <ImageLightbox attachment={lightboxAtt} onClose={() => setLightboxAtt(null)} />
    </Modal>
  );
};
