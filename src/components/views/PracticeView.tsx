import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Copy,
  Download,
  RefreshCw,
  Shuffle,
  Sparkles,
  Unlock,
  Upload,
} from 'lucide-react';
import type { Book, DeltaLog, DeltaOutcome, Note, PragyaSnapshot } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { useCopyPrompt } from '../../hooks/useCopyPrompt';
import { isEditableElement } from '../../hooks/useKeyboardShortcuts';
import { describeSyncError } from '../../utils/apiErrors';
import { isArchived } from '../../utils/archive';
import { focusCard } from '../../utils/cardFocus';
import {
  DELTA_OUTCOME_LABELS,
  checkInToastMessage,
  todaysDeltaLog,
  type DeltaCheckInPlan,
} from '../../utils/deltaCheckIn';
import {
  formatWhenDoDisplay,
  normalizeDeltaAction,
  normalizeDeltaTrigger,
} from '../../utils/deltaFormat';
import { hasOpenDialog } from '../../utils/dialogOverlay';
import { getRenderableAttachments } from '../../utils/metaCodecs';
import { navigateTo } from '../../utils/navigation';
import { getPracticeDeltaLists, noteHref, shieldedNoteLabel } from '../../utils/noteVisibility';
import { getLocalDateString } from '../../utils/sessionCoalesce';
import { buildSnapshot, validateSnapshotPayload } from '../../utils/snapshot';
import { buildSparringPrompt, SPARRING_COPY_SUCCESS_MESSAGE } from '../../utils/sparringPrompt';
import { isNoteSpoiler, isUnlockedPrediction } from '../../utils/spoilerMath';
import {
  getShuffleEmptyReason,
  selectTakeawayShuffle,
  shuffleProvenanceLabel,
} from '../../utils/takeawayShuffle';
import { showToast } from '../../utils/toast';
import { ChapterPosChip } from '../common/ChapterPosChip';
import { DeltaCheckInCard } from '../common/DeltaCheckInCard';
import { PromptFallbackModal } from '../common/PromptFallbackModal';
import { StreamThumbnail } from '../common/StreamThumbnail';
import { BTN_SECONDARY, BTN_TERTIARY } from '../common/uiClasses';
import { ImportConfirmModal } from '../modals/ImportConfirmModal';
import { PredictionOutcomeModal } from '../modals/PredictionOutcomeModal';

export const PracticeView: React.FC = () => {
  const {
    books,
    notes,
    sessions,
    deltaLogs,
    updateNote,
    checkInDelta,
    updateDeltaLogFields,
    deleteDeltaLog,
    replaceWorkspaceFromSnapshot,
  } = usePragya();

  const [focusedDeltaIdx, setFocusedDeltaIdx] = useState<number>(0);
  const jkMovedRef = useRef(false);
  const [jkTick, setJkTick] = useState(0);
  const [editingTriggerNoteId, setEditingTriggerNoteId] = useState<string | null>(null);
  const [triggerDraft, setTriggerDraft] = useState<string>('');
  const [actionDraft, setActionDraft] = useState<string>('');
  const [reflectionUi, setReflectionUi] = useState<Record<string, 'edit'>>({});
  const [reflectionDrafts, setReflectionDrafts] = useState<Record<string, string>>({});
  const [outcomeNoteId, setOutcomeNoteId] = useState<string | null>(null);
  const [checkInStatus, setCheckInStatus] = useState('');
  const [reactivateCapWarning, setReactivateCapWarning] = useState<boolean>(false);
  const [pendingSnapshot, setPendingSnapshot] = useState<PragyaSnapshot | null>(null);

  const { copyPrompt, fallbackModalProps } = useCopyPrompt({
    successMessage: SPARRING_COPY_SUCCESS_MESSAGE,
    fallbackTitle: 'Copy Sparring Prompt',
    fallbackTestId: 'sparring-prompt-fallback-modal',
    fallbackPromptLabel: 'Sparring prompt',
  });

  const importInputRef = useRef<HTMLInputElement>(null);
  const todayDate = getLocalDateString();

  const bookMap = useMemo(() => {
    const map = new Map<string, Book>();
    books.forEach(b => map.set(b.id, b));
    return map;
  }, [books]);

  const [revealedDeltaIds, setRevealedDeltaIds] = useState<Set<string>>(() => new Set());
  const revealDelta = useCallback((id: string) => {
    setRevealedDeltaIds(prev => new Set(prev).add(id));
  }, []);
  const deltaLists = useMemo(
    () => getPracticeDeltaLists(notes, bookMap, revealedDeltaIds),
    [bookMap, notes, revealedDeltaIds]
  );
  const activeDeltas = deltaLists.active;
  const archivedDeltas = deltaLists.archived;
  const shieldedDeltaIds = deltaLists.shieldedIds;

  const shuffleCandidates = useMemo(
    () => selectTakeawayShuffle(notes, books, todayDate, 3),
    [books, notes, todayDate]
  );

  const shuffleEmptyReason = useMemo(
    () => getShuffleEmptyReason(notes, books, todayDate),
    [books, notes, todayDate]
  );

  const unlockedPredictions = useMemo(
    () => notes.filter(n => !isArchived(n) && isUnlockedPrediction(n, bookMap.get(n.bookId))),
    [bookMap, notes]
  );

  const todayLogByNoteId = useMemo(() => {
    const map = new Map<string, DeltaLog>();
    for (const log of deltaLogs) {
      const found = todaysDeltaLog([log], log.noteId, todayDate);
      if (found) map.set(log.noteId, found);
    }
    return map;
  }, [deltaLogs, todayDate]);

  const historyCountByNoteId = useMemo(() => {
    const map = new Map<string, number>();
    for (const log of deltaLogs) map.set(log.noteId, (map.get(log.noteId) || 0) + 1);
    return map;
  }, [deltaLogs]);

  useEffect(() => {
    if (activeDeltas.length < 5) {
      setReactivateCapWarning(false);
    }
    if (focusedDeltaIdx >= activeDeltas.length && activeDeltas.length > 0) {
      setFocusedDeltaIdx(activeDeltas.length - 1);
    }
  }, [activeDeltas.length, focusedDeltaIdx]);

  const editingTriggerRef = useRef<string | null>(null);
  editingTriggerRef.current = editingTriggerNoteId;
  const openRefinePanel = useCallback((note: Note) => {
    if (editingTriggerRef.current !== note.id) {
      const formatted = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);
      setTriggerDraft(formatted.triggerBody);
      setActionDraft(formatted.actionBody);
    }
    setEditingTriggerNoteId(note.id);
  }, []);

  const closeReflection = useCallback((noteId: string) => {
    setReflectionUi(prev => {
      const next = { ...prev };
      delete next[noteId];
      return next;
    });
  }, []);

  const undoCheckIn = useCallback(
    (plan: DeltaCheckInPlan) => {
      if (plan.kind === 'unchanged') return;
      const run =
        plan.kind === 'append'
          ? deleteDeltaLog(plan.log.id).then(() => closeReflection(plan.log.noteId))
          : updateDeltaLogFields(plan.log.id, { outcome: plan.previous.outcome }).then(
              () => undefined
            );
      void run
        .then(() => showToast('Check-in undone.', 'info', { id: `checkin-${plan.log.noteId}` }))
        .catch(err => showToast(describeSyncError(err, 'Failed to undo check-in'), 'error'));
    },
    [closeReflection, deleteDeltaLog, updateDeltaLogFields]
  );

  const handleCheckIn = useCallback(
    async (note: Note, outcome: DeltaOutcome) => {
      try {
        const plan = await checkInDelta(note.id, outcome);
        if (outcome === 'missed') openRefinePanel(note);
        const message = checkInToastMessage(plan);
        if (!message) {
          setCheckInStatus(`Already logged today: ${DELTA_OUTCOME_LABELS[plan.log.outcome]}.`);
          return;
        }
        setCheckInStatus('');
        setReflectionDrafts(prev => ({ ...prev, [note.id]: plan.log.reflection || '' }));
        setReflectionUi(prev => ({ ...prev, [note.id]: 'edit' }));
        showToast(message, outcome === 'applied' ? 'success' : 'info', {
          id: `checkin-${note.id}`,
          duration: 8000,
          action: { label: 'Undo', testId: 'toast-undo-btn', onClick: () => undoCheckIn(plan) },
        });
      } catch (err) {
        showToast(describeSyncError(err, 'Failed to log check-in'), 'error');
      }
    },
    [checkInDelta, openRefinePanel, undoCheckIn]
  );

  const handleSaveReflection = async (note: Note) => {
    const log = todayLogByNoteId.get(note.id);
    if (!log) return;
    try {
      await updateDeltaLogFields(log.id, { reflection: reflectionDrafts[note.id] || '' });
      closeReflection(note.id);
      showToast('Reflection saved.', 'success');
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to save reflection'), 'error');
    }
  };

  const handleCopyPredictionPrompt = (note: Note) => {
    void copyPrompt(buildSparringPrompt(note, bookMap.get(note.bookId)));
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        hasOpenDialog(document) ||
        document.querySelector('[data-popover="true"]')
      ) {
        return;
      }
      if (isEditableElement(e.target)) return;
      if (activeDeltas.length === 0) return;

      const key = e.key.toLowerCase();
      if (key === 'j') {
        e.preventDefault();
        jkMovedRef.current = true;
        setFocusedDeltaIdx(prev => Math.min(activeDeltas.length - 1, prev + 1));
        setJkTick(t => t + 1);
      } else if (key === 'k') {
        e.preventDefault();
        jkMovedRef.current = true;
        setFocusedDeltaIdx(prev => Math.max(0, prev - 1));
        setJkTick(t => t + 1);
      } else if (key === '1') {
        const active = activeDeltas[focusedDeltaIdx];
        if (active && !shieldedDeltaIds.has(active.id)) {
          e.preventDefault();
          void handleCheckIn(active, 'applied');
        }
      } else if (key === '2') {
        const active = activeDeltas[focusedDeltaIdx];
        if (active && !shieldedDeltaIds.has(active.id)) {
          e.preventDefault();
          void handleCheckIn(active, 'missed');
        }
      } else if (key === '3') {
        const active = activeDeltas[focusedDeltaIdx];
        if (active && !shieldedDeltaIds.has(active.id)) {
          e.preventDefault();
          void handleCheckIn(active, 'no-trigger');
        }
      } else if (e.key === 'Enter') {
        const target = e.target as HTMLElement | null;
        if (target && target.closest('button, a, summary, [role="button"]')) return;
        const active = activeDeltas[focusedDeltaIdx];
        if (active) {
          e.preventDefault();
          navigateTo(
            noteHref(active, bookMap.get(active.bookId), !shieldedDeltaIds.has(active.id))
          );
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeDeltas, bookMap, focusedDeltaIdx, handleCheckIn, shieldedDeltaIds]);

  useEffect(() => {
    if (!jkMovedRef.current) return;
    jkMovedRef.current = false;
    focusCard(
      document.querySelector<HTMLElement>(
        `[data-testid="active-deltas-section"] [data-jk-card="${focusedDeltaIdx}"]`
      )
    );
  }, [focusedDeltaIdx, jkTick]);

  const handleSaveRefinedDelta = async (note: Note) => {
    const normalized = normalizeDeltaTrigger(triggerDraft);
    if (!normalized) {
      showToast('Trigger condition cannot be empty', 'error');
      return;
    }
    const normalizedAction = normalizeDeltaAction(actionDraft);
    if (!normalizedAction && normalizeDeltaAction(note.deltaAction)) {
      showToast('DO action cannot be empty', 'error');
      return;
    }
    try {
      await updateNote(
        {
          ...note,
          deltaTrigger: normalized,
          deltaAction: normalizedAction,
        },
        { expectedBaseUpdatedAt: note.updatedAt }
      );
      setEditingTriggerNoteId(null);
      setTriggerDraft('');
      setActionDraft('');
      showToast('Delta refined.', 'success');
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to update trigger'), 'error');
    }
  };

  const handleTransitionDeltaStatus = async (
    note: Note,
    nextStatus: 'active' | 'paused' | 'graduated'
  ) => {
    const prevStatus = note.deltaStatus;
    try {
      const saved = await updateNote(
        {
          ...note,
          deltaStatus: nextStatus,
        },
        { expectedBaseUpdatedAt: note.updatedAt }
      );
      setReactivateCapWarning(false);
      if (nextStatus === 'graduated' || nextStatus === 'paused') {
        const msg =
          nextStatus === 'graduated' ? 'Behavioral Delta graduated!' : 'Behavioral Delta paused';
        showToast(msg, nextStatus === 'graduated' ? 'success' : 'info', {
          action: {
            label: 'Undo',
            testId: 'toast-undo-btn',
            onClick: () => {
              void updateNote(
                {
                  ...saved,
                  deltaStatus: prevStatus,
                },
                { expectedBaseUpdatedAt: saved.updatedAt }
              )
                .then(() => showToast('Restored Behavioral Delta status', 'info'))
                .catch(err =>
                  showToast(describeSyncError(err, 'Failed to undo delta transition'), 'error')
                );
            },
          },
        });
      } else {
        showToast('Behavioral Delta reactivated', 'success');
      }
    } catch (err) {
      if (nextStatus === 'active') {
        setReactivateCapWarning(true);
      }
      showToast(describeSyncError(err, 'Failed to update delta status'), 'error');
    }
  };

  const handleMarkReviewed = async (note: Note) => {
    const prevLastReviewedAt = note.meta?.lastReviewedAt;
    try {
      const saved = await updateNote(
        {
          ...note,
          meta: {
            ...note.meta,
            lastReviewedAt: todayDate,
          },
        },
        { preserveUpdatedAt: true, expectedBaseUpdatedAt: note.updatedAt }
      );
      showToast('Marked reviewed for today', 'success', {
        action: {
          label: 'Undo',
          testId: 'toast-undo-btn',
          onClick: () => {
            const nextMeta = { ...saved.meta };
            if (prevLastReviewedAt) {
              nextMeta.lastReviewedAt = prevLastReviewedAt;
            } else {
              delete nextMeta.lastReviewedAt;
            }
            void updateNote(
              {
                ...saved,
                meta: nextMeta,
              },
              { preserveUpdatedAt: true, expectedBaseUpdatedAt: saved.updatedAt }
            )
              .then(() => showToast('Restored takeaway to Today Shuffle', 'info'))
              .catch(err => showToast(describeSyncError(err, 'Failed to undo review'), 'error'));
          },
        },
      });
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to mark reviewed'), 'error');
    }
  };

  const handleExportJson = () => {
    const snapshot = buildSnapshot({ books, notes, sessions, deltaLogs });
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pragya-snapshot-${todayDate}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported Pragya JSON snapshot', 'success');
  };

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const result = validateSnapshotPayload(text);
      if (!result.ok) {
        showToast(`Invalid snapshot JSON: ${result.error}`, 'error');
        return;
      }
      setPendingSnapshot(result.snapshot);
    } catch {
      showToast('Failed to read JSON file', 'error');
    }
  };

  return (
    <div data-testid="practice-view" className="py-6 space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display-l text-foreground tracking-tight">Practice</h1>
          <p className="text-body text-muted-foreground mt-1">
            Active Behavioral Deltas, zero-guilt Takeaway Shuffle, and portable JSON backups.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            data-testid="export-json-btn"
            onClick={handleExportJson}
            className={BTN_SECONDARY}
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export JSON</span>
          </button>

          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            data-testid="import-json-input"
            onChange={e => void handleImportFileChange(e)}
            className="hidden"
          />
          <button
            type="button"
            data-testid="import-json-btn"
            onClick={() => importInputRef.current?.click()}
            className={BTN_SECONDARY}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import JSON</span>
          </button>
        </div>
      </div>

      {/* Active Behavioral Deltas (N/5) */}
      <section data-testid="active-deltas-section" className="space-y-3">
        <span
          role="status"
          aria-live="polite"
          className="sr-only"
          data-testid="delta-checkin-status"
        >
          {checkInStatus}
        </span>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-eyebrow uppercase text-muted-foreground tracking-wider">
            Active Behavioral Deltas (
            <span data-testid="active-deltas-count" className="num text-foreground">
              {activeDeltas.length}/5
            </span>
            )
          </h2>
          <span className="text-[11px] text-muted-foreground hidden sm:inline">
            Keys: J/K select · 1 Applied · 2 Missed · 3 Didn&apos;t Come Up
          </span>
        </div>

        {activeDeltas.length === 0 ? (
          <div className="bg-card border border-border rounded-[14px] p-6 text-center text-body text-muted-foreground">
            No active Behavioral Deltas right now. Deepen an atomic note or reactivate an archived
            delta below.
          </div>
        ) : (
          <div className="space-y-3">
            {activeDeltas.map((note, idx) => (
              <DeltaCheckInCard
                key={note.id}
                note={note}
                book={bookMap.get(note.bookId)}
                idx={idx}
                isFocused={idx === focusedDeltaIdx}
                shielded={shieldedDeltaIds.has(note.id)}
                todayLog={todayLogByNoteId.get(note.id) || null}
                historyCount={historyCountByNoteId.get(note.id) || 0}
                deltaLogs={deltaLogs}
                isEditingTrigger={editingTriggerNoteId === note.id}
                triggerDraft={triggerDraft}
                actionDraft={actionDraft}
                onTriggerDraftChange={setTriggerDraft}
                onActionDraftChange={setActionDraft}
                onDismissRefine={() => setEditingTriggerNoteId(null)}
                onSaveRefinedDelta={n => void handleSaveRefinedDelta(n)}
                isEditingReflection={reflectionUi[note.id] === 'edit'}
                reflectionDraft={reflectionDrafts[note.id] ?? ''}
                onReflectionDraftChange={val =>
                  setReflectionDrafts(prev => ({ ...prev, [note.id]: val }))
                }
                onSaveReflection={n => void handleSaveReflection(n)}
                onCloseReflection={closeReflection}
                onStartEditReflection={(id, initialText) => {
                  setReflectionDrafts(prev => ({ ...prev, [id]: initialText }));
                  setReflectionUi(prev => ({ ...prev, [id]: 'edit' }));
                }}
                onFocusCard={setFocusedDeltaIdx}
                onRevealDelta={revealDelta}
                onCheckIn={(n, outcome) => void handleCheckIn(n, outcome)}
                onTransitionStatus={(n, next) => void handleTransitionDeltaStatus(n, next)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Paused & Graduated Deltas */}
      {archivedDeltas.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-eyebrow uppercase text-muted-foreground tracking-wider">
            <Archive className="w-3.5 h-3.5" />
            <span>Paused &amp; Graduated Deltas ({archivedDeltas.length})</span>
          </div>

          {reactivateCapWarning && (
            <div
              data-testid="deepen-delta-cap-warning"
              className="rounded-[10px] bg-negative/10 border border-negative/30 px-3.5 py-2.5 flex items-start gap-2 text-label text-negative"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Active Behavioral Delta cap (5/5) reached. Graduate or pause an active delta before
                reactivating another.
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {archivedDeltas.map(note => {
              const display = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);
              const archivedBook = bookMap.get(note.bookId);
              const deltaShielded = shieldedDeltaIds.has(note.id);
              return (
                <article
                  key={note.id}
                  className="bg-card border border-border rounded-[14px] p-4 flex flex-col justify-between gap-3"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        data-print-keep="true"
                        onClick={() => navigateTo(noteHref(note, archivedBook, !deltaShielded))}
                        className="min-h-11 sm:min-h-0 inline-flex items-center font-mono text-label font-semibold text-foreground hover:underline truncate"
                      >
                        {deltaShielded
                          ? shieldedNoteLabel(note, archivedBook)
                          : `[[${note.meta.title || note.slug}]]`}
                      </button>
                      <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-surface2 border border-border text-muted-foreground shrink-0">
                        {note.deltaStatus}
                      </span>
                    </div>
                    {deltaShielded && (
                      <button
                        type="button"
                        data-testid={`delta-reveal-btn-${note.id}`}
                        onClick={() => revealDelta(note.id)}
                        className="h-11 sm:h-7 px-3 sm:px-2.5 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-semibold text-foreground"
                      >
                        Reveal Note
                      </button>
                    )}
                    {!deltaShielded && display.triggerBody && (
                      <p className="text-label text-muted-foreground">
                        <strong className="text-foreground">WHEN</strong> {display.triggerBody}
                      </p>
                    )}
                    {!deltaShielded && display.actionBody && (
                      <p className="text-label text-muted-foreground font-mono">
                        <strong className="text-foreground">DO</strong> {display.actionBody}
                      </p>
                    )}
                  </div>

                  <div className="pt-2 border-t border-border/50 flex justify-end">
                    <button
                      type="button"
                      data-testid={`delta-reactivate-btn-${note.id}`}
                      onClick={() => void handleTransitionDeltaStatus(note, 'active')}
                      className="h-11 sm:h-8 min-w-11 sm:min-w-0 px-3 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-semibold text-foreground inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Reactivate</span>
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* Takeaway Shuffle */}
      <section data-testid="takeaway-shuffle-section" className="space-y-3">
        <div className="flex items-center gap-2 text-eyebrow uppercase text-muted-foreground tracking-wider">
          <Shuffle className="w-3.5 h-3.5" />
          <span>Daily Takeaway Shuffle ({todayDate})</span>
        </div>

        {shuffleCandidates.length === 0 ? (
          <div
            data-testid="shuffle-empty-state"
            className="bg-card border border-border rounded-[14px] p-6 text-center text-body text-muted-foreground"
          >
            {shuffleEmptyReason === 'all-reviewed-today'
              ? 'All eligible takeaways reviewed for today!'
              : 'No eligible notes yet — notes qualify once 14 days old or tagged #favorite (and unlocked from spoilers).'}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {shuffleCandidates.map(note => {
              const book = bookMap.get(note.bookId);
              const shuffleImages = getRenderableAttachments(note.meta).filter(
                (a): a is Extract<typeof a, { type: 'image' }> => a.type === 'image'
              );
              return (
                <article
                  key={note.id}
                  data-testid={`shuffle-card-${note.slug}`}
                  className="bg-card border border-border rounded-[14px] p-4 flex flex-col justify-between gap-3"
                >
                  <div className="space-y-2">
                    <div className="text-label text-muted-foreground flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-foreground">
                        {book?.title || 'Book'}
                      </span>
                      <ChapterPosChip
                        testIdKey={note.slug}
                        chapter={note.meta?.chapter}
                        pos={note.pos}
                        posUnit={book?.posUnit || 'page'}
                        positionOnly={book ? isNoteSpoiler(note, book) : false}
                        className="shrink-0"
                      />
                    </div>

                    {note.meta.title && (
                      <h3 className="text-heading text-foreground">{note.meta.title}</h3>
                    )}

                    {note.quote && (
                      <blockquote className="pl-2.5 border-l-2 border-border italic text-label text-muted-foreground line-clamp-3">
                        &ldquo;{note.quote}&rdquo;
                      </blockquote>
                    )}

                    {note.takeaway && (
                      <p className="text-body text-foreground line-clamp-4">{note.takeaway}</p>
                    )}

                    {shuffleImages.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {shuffleImages.map(att => (
                          <StreamThumbnail
                            key={att.id}
                            attachment={att}
                            className="w-12 h-12 rounded-[8px] object-cover border border-border"
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="pt-2 border-t border-border/50 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => navigateTo(`#/note/${encodeURIComponent(note.slug)}`)}
                      className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 px-1 sm:px-0 inline-flex items-center text-label text-muted-foreground hover:text-foreground whitespace-nowrap"
                    >
                      Open ↗
                    </button>

                    <span
                      data-testid={`shuffle-provenance-${note.slug}`}
                      className="text-label text-muted-foreground num truncate min-w-0"
                    >
                      {shuffleProvenanceLabel(note, todayDate)}
                    </span>

                    <button
                      type="button"
                      data-testid={`shuffle-review-btn-${note.slug}`}
                      onClick={() => void handleMarkReviewed(note)}
                      className="h-11 sm:h-8 px-3 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-semibold text-foreground inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 text-positive" />
                      <span>Mark Reviewed</span>
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Unlocked Fiction Predictions */}
      {unlockedPredictions.length > 0 && (
        <section data-testid="unlocked-predictions-section" className="space-y-3">
          <div className="flex items-center gap-2 text-eyebrow uppercase text-muted-foreground tracking-wider">
            <Unlock className="w-3.5 h-3.5 text-positive" />
            <span>Unlocked Fiction Predictions ({unlockedPredictions.length})</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {unlockedPredictions.map(note => {
              const book = bookMap.get(note.bookId);
              return (
                <article
                  key={note.id}
                  className="bg-card border border-border rounded-[14px] p-4 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 text-label">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-positive">
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{book?.title || 'Fiction'}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => navigateTo(`#/note/${encodeURIComponent(note.slug)}`)}
                      className="min-h-11 sm:min-h-0 inline-flex items-center text-foreground hover:underline font-medium"
                    >
                      View Note →
                    </button>
                  </div>
                  {note.quote && (
                    <blockquote className="pl-3 border-l-2 border-border italic text-label text-muted-foreground">
                      &ldquo;{note.quote}&rdquo;
                    </blockquote>
                  )}
                  <p className="text-body text-foreground">{note.takeaway}</p>
                  <div className="pt-2 border-t border-border/50 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid={`reflect-outcome-btn-${note.id}`}
                      onClick={() => setOutcomeNoteId(note.id)}
                      className={BTN_SECONDARY}
                    >
                      {note.meta?.predictionOutcome?.text ? 'Edit Reflection' : 'Reflect on Outcome'}
                    </button>
                    <button
                      type="button"
                      data-testid={`copy-prediction-prompt-btn-${note.id}`}
                      onClick={() => handleCopyPredictionPrompt(note)}
                      className={BTN_TERTIARY}
                    >
                      <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Copy Sparring Prompt</span>
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <PredictionOutcomeModal
        note={notes.find(n => n.id === outcomeNoteId) || null}
        book={bookMap.get(notes.find(n => n.id === outcomeNoteId)?.bookId || '') || null}
        isOpen={outcomeNoteId !== null}
        onClose={() => setOutcomeNoteId(null)}
      />
      <PromptFallbackModal {...fallbackModalProps} />

      <ImportConfirmModal
        snapshot={pendingSnapshot}
        onClose={() => setPendingSnapshot(null)}
        onConfirm={async snap => {
          await replaceWorkspaceFromSnapshot(snap);
          showToast('Workspace restored from snapshot', 'success');
        }}
      />
    </div>
  );
};
