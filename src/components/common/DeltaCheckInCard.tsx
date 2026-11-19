import React from 'react';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import type { Book, DeltaLog, DeltaOutcome, Note } from '../../types/pragya';
import { noteCardAriaLabel } from '../../utils/cardFocus';
import {
  DELTA_HISTORY_LIMIT,
  DELTA_OUTCOME_LABELS,
  DELTA_REFLECTION_PLACEHOLDERS,
  deltaHistorySummary,
  recentDeltaHistory,
} from '../../utils/deltaCheckIn';
import { formatWhenDoDisplay } from '../../utils/deltaFormat';
import { navigateTo } from '../../utils/navigation';
import { noteHref, shieldedNoteLabel } from '../../utils/noteVisibility';
import { formatPosDisplay } from '../../utils/spoilerMath';
import { BTN_SECONDARY, BTN_TERTIARY, EYEBROW, HELPER, INPUT } from './uiClasses';

export interface DeltaCheckInCardProps {
  note: Note;
  book?: Book;
  idx: number;
  isFocused: boolean;
  shielded: boolean;
  todayLog: DeltaLog | null;
  historyCount: number;
  deltaLogs: DeltaLog[];
  isEditingTrigger: boolean;
  triggerDraft: string;
  actionDraft: string;
  onTriggerDraftChange: (next: string) => void;
  onActionDraftChange: (next: string) => void;
  onDismissRefine: () => void;
  onSaveRefinedDelta: (note: Note) => void;
  isEditingReflection: boolean;
  reflectionDraft: string;
  onReflectionDraftChange: (next: string) => void;
  onSaveReflection: (note: Note) => void;
  onCloseReflection: (noteId: string) => void;
  onStartEditReflection: (noteId: string, initialText: string) => void;
  onFocusCard: (idx: number) => void;
  onRevealDelta: (noteId: string) => void;
  onCheckIn: (note: Note, outcome: DeltaOutcome) => void;
  onTransitionStatus: (note: Note, next: 'active' | 'paused' | 'graduated') => void;
}

const CHECK_IN_BUTTONS = [
  {
    outcome: 'applied' as const,
    testIdPrefix: 'delta-apply-btn-',
    label: 'Applied (1)',
    base: 'bg-positive/15 hover:bg-positive/25 border border-positive/30 font-semibold text-positive',
    pressed: 'bg-positive/25 border border-positive/50 font-semibold text-positive',
  },
  {
    outcome: 'missed' as const,
    testIdPrefix: 'delta-missed-btn-',
    label: 'Missed Trigger (2)',
    base: 'bg-warning/15 hover:bg-warning/25 border border-warning/30 font-semibold text-warning',
    pressed: 'bg-warning/25 border border-warning/50 font-semibold text-warning',
  },
  {
    outcome: 'no-trigger' as const,
    testIdPrefix: 'delta-notrigger-btn-',
    label: "Didn't Come Up (3)",
    base: 'bg-surface2 hover:bg-secondary border border-border font-medium text-muted-foreground hover:text-foreground',
    pressed: 'bg-secondary border border-foreground/30 font-semibold text-foreground',
  },
] as const;

/**
 * CD Batch 5 (decisions.md R2#2): active Behavioral Delta card extracted from PracticeView,
 * preserving spoiler shield, inline WHEN/DO refinement, same-day reflection row, 1/2/3 check-ins,
 * Graduate/Pause actions, and collapsible check-in history.
 */
export const DeltaCheckInCard: React.FC<DeltaCheckInCardProps> = ({
  note,
  book,
  idx,
  isFocused,
  shielded,
  todayLog,
  historyCount,
  deltaLogs,
  isEditingTrigger,
  triggerDraft,
  actionDraft,
  onTriggerDraftChange,
  onActionDraftChange,
  onDismissRefine,
  onSaveRefinedDelta,
  isEditingReflection,
  reflectionDraft,
  onReflectionDraftChange,
  onSaveReflection,
  onCloseReflection,
  onStartEditReflection,
  onFocusCard,
  onRevealDelta,
  onCheckIn,
  onTransitionStatus,
}) => {
  const display = formatWhenDoDisplay(note.deltaTrigger, note.deltaAction);

  return (
    <article
      data-testid={`delta-card-${note.id}`}
      data-focused={isFocused ? 'true' : undefined}
      data-jk-focused={isFocused ? 'true' : undefined}
      data-jk-card={idx}
      tabIndex={-1}
      aria-label={noteCardAriaLabel({
        bookTitle: book?.title,
        posLabel: formatPosDisplay(note.pos, book?.posUnit || 'page'),
        title: note.meta?.title || note.slug,
        shielded,
      })}
      onFocus={e => {
        if (e.target === e.currentTarget) onFocusCard(idx);
      }}
      className={`bg-card border rounded-[14px] p-5 space-y-3 transition-colors focus:outline-none focus-visible:border-foreground/40 focus-visible:ring-1 focus-visible:ring-ring/40 ${
        isFocused ? 'border-foreground/40 ring-1 ring-ring/40' : 'border-border'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <button
            type="button"
            data-print-keep="true"
            onClick={() => navigateTo(noteHref(note, book, !shielded))}
            className="min-h-11 sm:min-h-0 inline-flex items-center font-mono text-label font-semibold text-foreground hover:underline truncate"
          >
            {shielded ? shieldedNoteLabel(note, book) : `[[${note.meta.title || note.slug}]]`}
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

      {shielded ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-surface2/70 border border-border px-3 py-2">
          <span className="text-label text-muted-foreground">
            Ahead of your bookmark — reveal to see this delta.
          </span>
          <button
            type="button"
            data-testid={`delta-reveal-btn-${note.id}`}
            onClick={() => onRevealDelta(note.id)}
            className="h-11 sm:h-8 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold whitespace-nowrap"
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

      {isEditingTrigger && !shielded && (
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
                enterKeyHint="done"
                data-testid={`delta-trigger-edit-input-${note.id}`}
                value={triggerDraft}
                onChange={e => onTriggerDraftChange(e.target.value)}
                placeholder="When this situation happens..."
                className={`${INPUT} h-11 sm:h-9`}
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
                enterKeyHint="done"
                data-testid={`delta-action-edit-input-${note.id}`}
                value={actionDraft}
                onChange={e => onActionDraftChange(e.target.value)}
                placeholder="Do this concrete thing..."
                className={`${INPUT} h-11 sm:h-9`}
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onDismissRefine}
              className="h-11 sm:h-9 min-w-11 sm:min-w-0 px-2.5 rounded-[8px] text-label text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
            <button
              type="button"
              data-testid={`delta-trigger-save-btn-${note.id}`}
              onClick={() => onSaveRefinedDelta(note)}
              className="h-11 sm:h-9 px-3 rounded-[8px] bg-primary text-primary-foreground text-label font-semibold whitespace-nowrap"
            >
              Save Changes
            </button>
          </div>
        </div>
      )}

      {!shielded && todayLog && isEditingReflection && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <input
            type="text"
            enterKeyHint="done"
            aria-label="Check-in reflection"
            data-testid={`delta-reflection-input-${note.id}`}
            value={reflectionDraft}
            placeholder={DELTA_REFLECTION_PLACEHOLDERS[todayLog.outcome]}
            onChange={e => onReflectionDraftChange(e.target.value)}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                onSaveReflection(note);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onCloseReflection(note.id);
              }
            }}
            className={`${INPUT} h-11 sm:h-9 flex-1`}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid={`delta-reflection-save-btn-${note.id}`}
              onClick={() => onSaveReflection(note)}
              className={BTN_SECONDARY}
            >
              Save
            </button>
            <button
              type="button"
              data-testid={`delta-reflection-skip-btn-${note.id}`}
              onClick={() => onCloseReflection(note.id)}
              className={BTN_TERTIARY}
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {!shielded && todayLog && !isEditingReflection && todayLog.reflection && (
        <p
          data-testid={`delta-reflection-saved-${note.id}`}
          className={`${HELPER} flex items-baseline gap-2`}
        >
          <span className="min-w-0 truncate">&ldquo;{todayLog.reflection}&rdquo;</span>
          <button
            type="button"
            data-testid={`delta-reflection-edit-btn-${note.id}`}
            onClick={() => onStartEditReflection(note.id, todayLog.reflection)}
            className={BTN_TERTIARY}
          >
            Edit
          </button>
        </p>
      )}

      <div className="pt-2 border-t border-border/60 flex flex-wrap items-center justify-between gap-2">
        {!shielded ? (
          <div
            role="group"
            aria-label="Today's check-in"
            className="flex flex-wrap items-center gap-2 sm:gap-1.5"
          >
            {CHECK_IN_BUTTONS.map(btn => {
              const isPressed = todayLog?.outcome === btn.outcome;
              return (
                <button
                  key={btn.outcome}
                  type="button"
                  data-testid={`${btn.testIdPrefix}${note.id}`}
                  aria-pressed={isPressed}
                  onClick={() => onCheckIn(note, btn.outcome)}
                  className={`h-11 sm:h-8 min-w-11 sm:min-w-0 px-3 sm:px-2.5 rounded-[8px] text-label whitespace-nowrap inline-flex items-center justify-center gap-1 ${
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

        <div className="flex flex-wrap items-center gap-2 sm:gap-1.5">
          <button
            type="button"
            data-testid={`delta-graduate-btn-${note.id}`}
            onClick={() => onTransitionStatus(note, 'graduated')}
            className="h-11 sm:h-8 min-w-11 sm:min-w-0 px-3 sm:px-2.5 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-medium text-foreground inline-flex items-center justify-center whitespace-nowrap"
          >
            Graduate
          </button>
          <button
            type="button"
            data-testid={`delta-pause-btn-${note.id}`}
            onClick={() => onTransitionStatus(note, 'paused')}
            className="h-11 sm:h-8 min-w-11 sm:min-w-0 px-3 sm:px-2.5 rounded-[8px] bg-surface2 hover:bg-secondary border border-border text-label font-medium text-muted-foreground hover:text-foreground inline-flex items-center justify-center whitespace-nowrap"
          >
            Pause
          </button>
        </div>
      </div>

      {!shielded && historyCount > 0 && (
        <details data-testid={`delta-history-${note.id}`} className="group">
          <summary className="min-h-11 sm:min-h-0 flex items-center justify-between gap-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
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
};
