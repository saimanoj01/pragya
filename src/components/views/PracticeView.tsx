import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
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
import { isEditableElement } from '../../hooks/useKeyboardShortcuts';
import {
  formatWhenDoDisplay,
  normalizeDeltaAction,
  normalizeDeltaTrigger,
} from '../../utils/deltaFormat';
import {
  DELTA_HISTORY_LIMIT,
  DELTA_OUTCOME_LABELS,
  DELTA_REFLECTION_PLACEHOLDERS,
  checkInToastMessage,
  deltaHistorySummary,
  recentDeltaHistory,
  todaysDeltaLog,
  type DeltaCheckInPlan,
} from '../../utils/deltaCheckIn';
import { buildSparringPrompt, SPARRING_COPY_SUCCESS_MESSAGE } from '../../utils/sparringPrompt';
import { tryCopyText } from '../../utils/capstonePrompt';
import { CapstonePromptFallbackModal } from '../modals/CapstoneModal';
import { PredictionOutcomeModal } from '../modals/PredictionOutcomeModal';
import { BTN_SECONDARY, BTN_TERTIARY, EYEBROW, HELPER, INPUT } from '../common/uiClasses';
import { navigateTo } from '../../utils/navigation';
import { getLocalDateString } from '../../utils/sessionCoalesce';
import { buildSnapshot, validateSnapshotPayload } from '../../utils/snapshot';
import { isNoteSpoiler, isUnlockedPrediction } from '../../utils/spoilerMath';
import { ChapterPosChip } from '../common/ChapterPosChip';
import { isArchived } from '../../utils/archive';
import { getPracticeDeltaLists, noteHref, shieldedNoteLabel } from '../../utils/noteVisibility';
import {
  getShuffleEmptyReason,
  selectTakeawayShuffle,
  shuffleProvenanceLabel,
} from '../../utils/takeawayShuffle';
import { showToast } from '../../utils/toast';
import { ImportConfirmModal } from '../modals/ImportConfirmModal';
import { describeSyncError } from '../../utils/apiErrors';

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
  const [editingTriggerNoteId, setEditingTriggerNoteId] = useState<string | null>(null);
  const [triggerDraft, setTriggerDraft] = useState<string>('');
  const [actionDraft, setActionDraft] = useState<string>('');
  // CD C2.1: per-card reflection row — 'edit' shows the input, absent shows the saved line.
  const [reflectionUi, setReflectionUi] = useState<Record<string, 'edit'>>({});
  const [reflectionDrafts, setReflectionDrafts] = useState<Record<string, string>>({});
  const [outcomeNoteId, setOutcomeNoteId] = useState<string | null>(null);
  const [checkInStatus, setCheckInStatus] = useState('');
  const [fallbackPrompt, setFallbackPrompt] = useState<string | null>(null);
  const [reactivateCapWarning, setReactivateCapWarning] = useState<boolean>(false);
  const [pendingSnapshot, setPendingSnapshot] = useState<PragyaSnapshot | null>(null);

  const importInputRef = useRef<HTMLInputElement>(null);
  const todayDate = getLocalDateString();

  const bookMap = useMemo(() => {
    const map = new Map<string, Book>();
    books.forEach(b => map.set(b.id, b));
    return map;
  }, [books]);

  // R1#1: a delta on a note ahead of the bookmark renders as "Shielded note · {pos}" with
  // a Reveal action (local, per session) — never its WHEN/DO, title or slug.
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
  // Opening keeps any text already typed in this card's panel (a repeated Missed press).
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
          : // R1#3: restore only the outcome — a reflection saved meanwhile is kept.
            updateDeltaLogFields(plan.log.id, { outcome: plan.previous.outcome }).then(() => undefined);
      void run
        .then(() => showToast('Check-in undone.', 'info', { id: `checkin-${plan.log.noteId}` }))
        .catch(err => showToast(describeSyncError(err, 'Failed to undo check-in'), 'error'));
    },
    [closeReflection, deleteDeltaLog, updateDeltaLogFields]
  );

  // CD C2.1 (decisions OQ-5): same-day coalescing + Undo; pressing the logged outcome is a no-op.
  const handleCheckIn = useCallback(
    async (note: Note, outcome: DeltaOutcome) => {
      try {
        const plan = await checkInDelta(note.id, outcome);
        if (outcome === 'missed') openRefinePanel(note);
        const message = checkInToastMessage(plan);
        if (!message) {
          // R2 nit (a11y): re-pressing the logged outcome writes nothing; say so politely.
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

  const handleCopyPredictionPrompt = async (note: Note) => {
    const prompt = buildSparringPrompt(note, bookMap.get(note.bookId));
    if (!prompt) return;
    if (await tryCopyText(prompt)) showToast(SPARRING_COPY_SUCCESS_MESSAGE, 'success');
    else setFallbackPrompt(prompt);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"]') || document.querySelector('[data-popover="true"]')) {
        return;
      }
      if (isEditableElement(e.target)) return;
      if (activeDeltas.length === 0) return;

      const key = e.key.toLowerCase();
      if (key === 'j') {
        e.preventDefault();
        setFocusedDeltaIdx(prev => Math.min(activeDeltas.length - 1, prev + 1));
      } else if (key === 'k') {
        e.preventDefault();
        setFocusedDeltaIdx(prev => Math.max(0, prev - 1));
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
        if (target && target.closest('button, a, [role="button"]')) return;
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
      // R1#4: base = the note this card rendered, so a background sync can't hide a
      // newer remote edit behind the live loaded base.
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
                  showToast(
                    describeSyncError(err, 'Failed to undo delta transition'),
                    'error'
                  )
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
        // Reviewing is not editing: keep Notes!E updatedAt untouched. The explicit base
        // (R1#4) makes a remote edit since render a conflict instead of rolling
        // updatedAt backwards.
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
              .catch(err =>
                showToast(describeSyncError(err, 'Failed to undo review'), 'error')
              );
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
            className="h-9 px-3.5 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-label font-medium text-foreground inline-flex items-center gap-1.5 whitespace-nowrap"
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
            className="h-9 px-3.5 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-label font-medium text-foreground inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import JSON</span>
          </button>
        </div>
      </div>

      {/* Active Behavioral Deltas (N/5) */}
      <section data-testid="active-deltas-section" className="space-y-3">
        <span role="status" aria-live="polite" className="sr-only" data-testid="delta-checkin-status">
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
            No active Behavioral Deltas right now. Deepen an atomic note or reactivate an archived delta below.
          </div>
        ) : (
          <div className="space-y-3">
            {activeDeltas.map((note, idx) => {
              const book = bookMap.get(note.bookId);
              const display = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);
              const isFocused = idx === focusedDeltaIdx;
              const isEditingTrigger = editingTriggerNoteId === note.id;
              const deltaShielded = shieldedDeltaIds.has(note.id);
              const todayLog = todayLogByNoteId.get(note.id) || null;
              const historyCount = historyCountByNoteId.get(note.id) || 0;

              return (
                <article
                  key={note.id}
                  data-testid={`delta-card-${note.id}`}
                  data-focused={isFocused ? 'true' : undefined}
                  className={`bg-card border rounded-[14px] p-5 space-y-3 transition-colors ${
                    isFocused ? 'border-foreground/40 ring-1 ring-ring/40' : 'border-border'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <button
                        type="button"
                        onClick={() => navigateTo(noteHref(note, book, !deltaShielded))}
                        className="font-mono text-label font-semibold text-foreground hover:underline truncate"
                      >
                        {deltaShielded
                          ? shieldedNoteLabel(note, book)
                          : `[[${note.meta.title || note.slug}]]`}
                      </button>
                      <span className="px-2 py-0.5 text-[11px] rounded bg-surface2 border border-border text-muted-foreground truncate max-w-[220px]">
                        {book?.title || 'Book'}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground num shrink-0">
                      {todayLog && (
                        <span
                          data-testid={`delta-checked-today-${note.id}`}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-md bg-positive/15 border border-positive/30 text-positive font-sans"
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          <span>Checked in today</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {deltaShielded ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-surface2/70 border border-border px-3 py-2">
                      <span className="text-label text-muted-foreground">
                        Ahead of your bookmark — reveal to see this delta.
                      </span>
                      <button
                        type="button"
                        data-testid={`delta-reveal-btn-${note.id}`}
                        onClick={() => revealDelta(note.id)}
                        className="h-8 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold whitespace-nowrap"
                      >
                        Reveal Note
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <p className="text-body text-foreground">
                        <strong className="font-semibold">WHEN</strong> {display.triggerBody}
                      </p>
                      <p className="text-body text-foreground font-mono text-[13px]">
                        <strong className="font-semibold">DO</strong> {display.actionBody}
                      </p>
                    </div>
                  )}

                  {isEditingTrigger && !deltaShielded && (
                    <div className="rounded-[10px] bg-surface2/70 border border-border p-3 space-y-2">
                      <div className={EYEBROW}>Refine this delta</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label
                            htmlFor={`refine-when-${note.id}`}
                            className="block text-[11px] font-semibold uppercase text-muted-foreground"
                          >
                            WHEN
                          </label>
                          <input
                            id={`refine-when-${note.id}`}
                            type="text"
                            data-testid={`delta-trigger-edit-input-${note.id}`}
                            value={triggerDraft}
                            onChange={e => setTriggerDraft(e.target.value)}
                            placeholder="When this situation happens..."
                            className={`${INPUT} h-9 text-label`}
                          />
                        </div>
                        <div className="space-y-1">
                          <label
                            htmlFor={`refine-do-${note.id}`}
                            className="block text-[11px] font-semibold uppercase text-muted-foreground"
                          >
                            DO
                          </label>
                          <input
                            id={`refine-do-${note.id}`}
                            type="text"
                            data-testid={`delta-action-edit-input-${note.id}`}
                            value={actionDraft}
                            onChange={e => setActionDraft(e.target.value)}
                            placeholder="Do this concrete thing..."
                            className={`${INPUT} h-9 text-label`}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingTriggerNoteId(null)}
                          className="h-9 px-2.5 rounded-[8px] text-label text-muted-foreground hover:text-foreground"
                        >
                          Dismiss
                        </button>
                        <button
                          type="button"
                          data-testid={`delta-trigger-save-btn-${note.id}`}
                          onClick={() => void handleSaveRefinedDelta(note)}
                          className="h-9 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold whitespace-nowrap"
                        >
                          Save Changes
                        </button>
                      </div>
                    </div>
                  )}

                  {!deltaShielded && todayLog && reflectionUi[note.id] === 'edit' && (
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <input
                        type="text"
                        aria-label="Check-in reflection"
                        data-testid={`delta-reflection-input-${note.id}`}
                        value={reflectionDrafts[note.id] ?? ''}
                        placeholder={DELTA_REFLECTION_PLACEHOLDERS[todayLog.outcome]}
                        onChange={e =>
                          setReflectionDrafts(prev => ({ ...prev, [note.id]: e.target.value }))
                        }
                        onKeyDown={e => {
                          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleSaveReflection(note);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            closeReflection(note.id);
                          }
                        }}
                        className={`${INPUT} h-9 text-label flex-1`}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          data-testid={`delta-reflection-save-btn-${note.id}`}
                          onClick={() => void handleSaveReflection(note)}
                          className={BTN_SECONDARY}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          data-testid={`delta-reflection-skip-btn-${note.id}`}
                          onClick={() => closeReflection(note.id)}
                          className={BTN_TERTIARY}
                        >
                          Skip
                        </button>
                      </div>
                    </div>
                  )}

                  {!deltaShielded &&
                    todayLog &&
                    reflectionUi[note.id] !== 'edit' &&
                    todayLog.reflection && (
                      <p
                        data-testid={`delta-reflection-saved-${note.id}`}
                        className={`${HELPER} flex items-baseline gap-2`}
                      >
                        <span className="min-w-0 truncate">&ldquo;{todayLog.reflection}&rdquo;</span>
                        <button
                          type="button"
                          data-testid={`delta-reflection-edit-btn-${note.id}`}
                          onClick={() => {
                            setReflectionDrafts(prev => ({ ...prev, [note.id]: todayLog.reflection }));
                            setReflectionUi(prev => ({ ...prev, [note.id]: 'edit' }));
                          }}
                          className={BTN_TERTIARY}
                        >
                          Edit
                        </button>
                      </p>
                    )}

                  {/* Check-in & Lifecycle Actions */}
                  <div className="pt-2 border-t border-border/60 flex flex-wrap items-center justify-between gap-2">
                    {!deltaShielded ? (
                      <div
                        role="group"
                        aria-label="Today's check-in"
                        className="flex flex-wrap items-center gap-1.5"
                      >
                        {(
                          [
                            {
                              outcome: 'applied' as const,
                              testId: `delta-apply-btn-${note.id}`,
                              label: 'Applied (1)',
                              base: 'bg-positive/15 hover:bg-positive/25 border border-positive/30 font-semibold text-positive',
                              pressed: 'bg-positive/25 border border-positive/50 font-semibold text-positive',
                            },
                            {
                              outcome: 'missed' as const,
                              testId: `delta-missed-btn-${note.id}`,
                              label: 'Missed Trigger (2)',
                              base: 'bg-warning/15 hover:bg-warning/25 border border-warning/30 font-semibold text-warning',
                              pressed: 'bg-warning/25 border border-warning/50 font-semibold text-warning',
                            },
                            {
                              outcome: 'no-trigger' as const,
                              testId: `delta-notrigger-btn-${note.id}`,
                              label: "Didn't Come Up (3)",
                              base: 'bg-surface2 hover:bg-secondary border border-border font-medium text-muted-foreground hover:text-foreground',
                              pressed: 'bg-secondary border border-foreground/30 font-semibold text-foreground',
                            },
                          ]
                        ).map(btn => {
                          const isPressed = todayLog?.outcome === btn.outcome;
                          return (
                            <button
                              key={btn.outcome}
                              type="button"
                              data-testid={btn.testId}
                              aria-pressed={isPressed}
                              onClick={() => void handleCheckIn(note, btn.outcome)}
                              className={`h-8 px-2.5 rounded-[8px] text-label whitespace-nowrap inline-flex items-center gap-1 ${
                                isPressed ? btn.pressed : btn.base
                              }`}
                            >
                              {isPressed && <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />}
                              <span>{btn.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div />
                    )}

                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        data-testid={`delta-graduate-btn-${note.id}`}
                        onClick={() => void handleTransitionDeltaStatus(note, 'graduated')}
                        className="h-8 px-2.5 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-medium text-foreground whitespace-nowrap"
                      >
                        Graduate
                      </button>
                      <button
                        type="button"
                        data-testid={`delta-pause-btn-${note.id}`}
                        onClick={() => void handleTransitionDeltaStatus(note, 'paused')}
                        className="h-8 px-2.5 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-medium text-muted-foreground hover:text-foreground whitespace-nowrap"
                      >
                        Pause
                      </button>
                    </div>
                  </div>

                  {!deltaShielded && historyCount > 0 && (
                    <details data-testid={`delta-history-${note.id}`} className="group">
                      <summary className="flex items-center justify-between gap-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                        <span className={HELPER}>{deltaHistorySummary(deltaLogs, note.id)}</span>
                        <ChevronRight
                          className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-90"
                          aria-hidden="true"
                        />
                      </summary>
                      <ol className="mt-2 divide-y divide-border/60">
                        {recentDeltaHistory(deltaLogs, note.id, DELTA_HISTORY_LIMIT).map(log => (
                          <li
                            key={log.id}
                            data-testid={`delta-history-row-${log.id}`}
                            className="py-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                          >
                            <span className="num text-label text-foreground">{String(log.date)}</span>
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${
                                log.outcome === 'applied'
                                  ? 'bg-positive/15 border-positive/30 text-positive'
                                  : log.outcome === 'missed'
                                    ? 'bg-warning/15 border-warning/30 text-warning'
                                    : 'bg-surface2 border-border text-muted-foreground'
                              }`}
                            >
                              {DELTA_OUTCOME_LABELS[log.outcome] || log.outcome}
                            </span>
                            {log.reflection && (
                              <span className="text-label text-muted-foreground">{log.reflection}</span>
                            )}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </article>
              );
            })}
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
                Active Behavioral Delta cap (5/5) reached. Graduate or pause an active delta before reactivating another.
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
                        onClick={() => navigateTo(noteHref(note, archivedBook, !deltaShielded))}
                        className="font-mono text-label font-semibold text-foreground hover:underline truncate"
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
                        className="h-7 px-2.5 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-semibold text-foreground"
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
                      className="h-8 px-3 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-semibold text-foreground inline-flex items-center gap-1.5 whitespace-nowrap"
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
                  </div>

                  <div className="pt-2 border-t border-border/50 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => navigateTo(`#/note/${encodeURIComponent(note.slug)}`)}
                      className="text-label text-muted-foreground hover:text-foreground whitespace-nowrap"
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
                      className="h-8 px-3 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-semibold text-foreground inline-flex items-center gap-1.5 whitespace-nowrap"
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
                      className="text-foreground hover:underline font-medium"
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
                      onClick={() => void handleCopyPredictionPrompt(note)}
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
      <CapstonePromptFallbackModal
        isOpen={fallbackPrompt !== null}
        onClose={() => setFallbackPrompt(null)}
        prompt={fallbackPrompt || ''}
        title="Copy Sparring Prompt"
        dataTestId="sparring-prompt-fallback-modal"
        promptLabel="Sparring prompt"
      />

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
