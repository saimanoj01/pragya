import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Download,
  RefreshCw,
  Shuffle,
  Sparkles,
  Unlock,
  Upload,
} from 'lucide-react';
import type { Book, DeltaOutcome, Note, PragyaSnapshot } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { isEditableElement } from '../../hooks/useKeyboardShortcuts';
import { formatWhenDoDisplay, normalizeDeltaTrigger } from '../../utils/deltaFormat';
import { navigateTo } from '../../utils/navigation';
import { getLocalDateString } from '../../utils/sessionCoalesce';
import { buildSnapshot, validateSnapshotPayload } from '../../utils/snapshot';
import { formatPosDisplay, isUnlockedPrediction } from '../../utils/spoilerMath';
import { selectTakeawayShuffle } from '../../utils/takeawayShuffle';
import { showToast } from '../../utils/toast';
import { ImportConfirmModal } from '../modals/ImportConfirmModal';

export const PracticeView: React.FC = () => {
  const {
    books,
    notes,
    sessions,
    deltaLogs,
    updateNote,
    logDeltaOutcome,
    replaceWorkspaceFromSnapshot,
  } = usePragya();

  const [focusedDeltaIdx, setFocusedDeltaIdx] = useState<number>(0);
  const [editingTriggerNoteId, setEditingTriggerNoteId] = useState<string | null>(null);
  const [triggerDraft, setTriggerDraft] = useState<string>('');
  const [reactivateCapWarning, setReactivateCapWarning] = useState<boolean>(false);
  const [pendingSnapshot, setPendingSnapshot] = useState<PragyaSnapshot | null>(null);

  const importInputRef = useRef<HTMLInputElement>(null);
  const todayDate = getLocalDateString();

  const bookMap = useMemo(() => {
    const map = new Map<string, Book>();
    books.forEach(b => map.set(b.id, b));
    return map;
  }, [books]);

  const activeDeltas = useMemo(
    () => notes.filter(n => n.deltaStatus === 'active'),
    [notes]
  );

  const archivedDeltas = useMemo(
    () => notes.filter(n => n.deltaStatus === 'paused' || n.deltaStatus === 'graduated'),
    [notes]
  );

  const shuffleCandidates = useMemo(
    () => selectTakeawayShuffle(notes, books, todayDate, 3),
    [books, notes, todayDate]
  );

  const unlockedPredictions = useMemo(
    () => notes.filter(n => isUnlockedPrediction(n, bookMap.get(n.bookId))),
    [bookMap, notes]
  );

  const deltaStatsByNoteId = useMemo(() => {
    const map = new Map<string, { applied: number; missed: number; noTrigger: number }>();
    for (const log of deltaLogs) {
      const curr = map.get(log.noteId) || { applied: 0, missed: 0, noTrigger: 0 };
      if (log.outcome === 'applied') curr.applied += 1;
      else if (log.outcome === 'missed') curr.missed += 1;
      else if (log.outcome === 'no-trigger') curr.noTrigger += 1;
      map.set(log.noteId, curr);
    }
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

  const handleCheckIn = useCallback(
    async (note: Note, outcome: DeltaOutcome) => {
      try {
        await logDeltaOutcome(note.id, outcome);
        if (outcome === 'missed') {
          const formatted = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);
          setEditingTriggerNoteId(note.id);
          setTriggerDraft(formatted.triggerBody);
          showToast('Logged missed trigger — refine WHEN trigger below if needed', 'info');
        } else if (outcome === 'applied') {
          showToast('Logged Applied!', 'success');
        } else {
          showToast("Logged Didn't Come Up", 'info');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to log check-in', 'error');
      }
    },
    [logDeltaOutcome]
  );

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
        if (active) {
          e.preventDefault();
          void handleCheckIn(active, 'applied');
        }
      } else if (key === '2') {
        const active = activeDeltas[focusedDeltaIdx];
        if (active) {
          e.preventDefault();
          void handleCheckIn(active, 'missed');
        }
      } else if (key === '3') {
        const active = activeDeltas[focusedDeltaIdx];
        if (active) {
          e.preventDefault();
          void handleCheckIn(active, 'no-trigger');
        }
      } else if (e.key === 'Enter') {
        const target = e.target as HTMLElement | null;
        if (target && target.closest('button, a, [role="button"]')) return;
        const active = activeDeltas[focusedDeltaIdx];
        if (active) {
          e.preventDefault();
          navigateTo(`#/note/${encodeURIComponent(active.slug)}`);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeDeltas, focusedDeltaIdx, handleCheckIn]);

  const handleSaveRefinedTrigger = async (note: Note) => {
    const normalized = normalizeDeltaTrigger(triggerDraft);
    if (!normalized) {
      showToast('Trigger condition cannot be empty', 'error');
      return;
    }
    try {
      await updateNote({
        ...note,
        deltaTrigger: normalized,
      });
      setEditingTriggerNoteId(null);
      setTriggerDraft('');
      showToast('Updated WHEN trigger condition', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update trigger', 'error');
    }
  };

  const handleTransitionDeltaStatus = async (
    note: Note,
    nextStatus: 'active' | 'paused' | 'graduated'
  ) => {
    try {
      await updateNote({
        ...note,
        deltaStatus: nextStatus,
      });
      setReactivateCapWarning(false);
      if (nextStatus === 'graduated') {
        showToast('Behavioral Delta graduated!', 'success');
      } else if (nextStatus === 'paused') {
        showToast('Behavioral Delta paused', 'info');
      } else {
        showToast('Behavioral Delta reactivated', 'success');
      }
    } catch (err) {
      if (nextStatus === 'active') {
        setReactivateCapWarning(true);
      }
      showToast(err instanceof Error ? err.message : 'Failed to update delta status', 'error');
    }
  };

  const handleMarkReviewed = async (note: Note) => {
    try {
      await updateNote(
        {
          ...note,
          meta: {
            ...note.meta,
            lastReviewedAt: todayDate,
          },
        },
        // Reviewing is not editing: keep Notes!E updatedAt untouched.
        { preserveUpdatedAt: true }
      );
      showToast('Marked reviewed for today', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to mark reviewed', 'error');
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
              const stats = deltaStatsByNoteId.get(note.id) || {
                applied: 0,
                missed: 0,
                noTrigger: 0,
              };
              const isFocused = idx === focusedDeltaIdx;
              const isEditingTrigger = editingTriggerNoteId === note.id;

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
                        onClick={() => navigateTo(`#/note/${encodeURIComponent(note.slug)}`)}
                        className="font-mono text-label font-semibold text-foreground hover:underline truncate"
                      >
                        [[{note.meta.title || note.slug}]]
                      </button>
                      <span className="px-2 py-0.5 text-[11px] rounded bg-surface2 border border-border text-muted-foreground truncate max-w-[220px]">
                        {book?.title || 'Book'}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground num shrink-0">
                      <span>{stats.applied} applied</span>
                      <span>·</span>
                      <span>{stats.missed} missed</span>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <p className="text-body text-foreground">
                      <strong className="font-semibold">WHEN</strong> {display.triggerBody}
                    </p>
                    <p className="text-body text-foreground font-mono text-[13px]">
                      <strong className="font-semibold">DO</strong> {display.actionBody}
                    </p>
                  </div>

                  {isEditingTrigger && (
                    <div className="rounded-[10px] bg-surface2/70 border border-border p-3 space-y-2">
                      <div className="text-[11px] font-semibold uppercase text-warning">
                        Refine WHEN Trigger Condition
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          aria-label="Refine WHEN trigger condition"
                          data-testid={`delta-trigger-edit-input-${note.id}`}
                          value={triggerDraft}
                          onChange={e => setTriggerDraft(e.target.value)}
                          placeholder="When this situation happens..."
                          className="flex-1 h-9 px-3 rounded-[8px] bg-background border border-input text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            data-testid={`delta-trigger-save-btn-${note.id}`}
                            onClick={() => void handleSaveRefinedTrigger(note)}
                            className="h-9 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold whitespace-nowrap"
                          >
                            Save Trigger
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingTriggerNoteId(null)}
                            className="h-9 px-2.5 rounded-[8px] text-label text-muted-foreground hover:text-foreground"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Check-in & Lifecycle Actions */}
                  <div className="pt-2 border-t border-border/60 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        data-testid={`delta-apply-btn-${note.id}`}
                        onClick={() => void handleCheckIn(note, 'applied')}
                        className="h-8 px-2.5 rounded-[8px] bg-positive/15 hover:bg-positive/25 border border-positive/30 text-label font-semibold text-positive whitespace-nowrap"
                      >
                        Applied (1)
                      </button>

                      <button
                        type="button"
                        data-testid={`delta-missed-btn-${note.id}`}
                        onClick={() => void handleCheckIn(note, 'missed')}
                        className="h-8 px-2.5 rounded-[8px] bg-warning/15 hover:bg-warning/25 border border-warning/30 text-label font-semibold text-warning whitespace-nowrap"
                      >
                        Missed Trigger (2)
                      </button>

                      <button
                        type="button"
                        data-testid={`delta-notrigger-btn-${note.id}`}
                        onClick={() => void handleCheckIn(note, 'no-trigger')}
                        className="h-8 px-2.5 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-medium text-muted-foreground hover:text-foreground whitespace-nowrap"
                      >
                        Didn&apos;t Come Up (3)
                      </button>
                    </div>

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
              return (
                <article
                  key={note.id}
                  className="bg-card border border-border rounded-[14px] p-4 flex flex-col justify-between gap-3"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => navigateTo(`#/note/${encodeURIComponent(note.slug)}`)}
                        className="font-mono text-label font-semibold text-foreground hover:underline truncate"
                      >
                        [[{note.meta.title || note.slug}]]
                      </button>
                      <span className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-surface2 border border-border text-muted-foreground shrink-0">
                        {note.deltaStatus}
                      </span>
                    </div>
                    {display.triggerBody && (
                      <p className="text-label text-muted-foreground">
                        <strong className="text-foreground">WHEN</strong> {display.triggerBody}
                      </p>
                    )}
                    {display.actionBody && (
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
          <div className="bg-card border border-border rounded-[14px] p-6 text-center text-body text-muted-foreground">
            All eligible takeaways have been reviewed for today!
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
                      <span className="num shrink-0">
                        {formatPosDisplay(note.pos, book?.posUnit || 'page')}
                      </span>
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
                </article>
              );
            })}
          </div>
        </section>
      )}

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
