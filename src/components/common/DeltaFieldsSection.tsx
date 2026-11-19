import React, { useId } from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import type { DeltaStatus } from '../../types/pragya';
import { ACTIVE_DELTA_CAP } from '../../utils/deltaFormat';
import { EYEBROW, INPUT, SELECT } from './uiClasses';

export interface DeltaFieldsSectionProps {
  variant: 'deepen' | 'edit';
  deltaTrigger: string;
  onTriggerChange: (next: string) => void;
  deltaAction: string;
  onActionChange: (next: string) => void;
  deltaStatus: DeltaStatus;
  onStatusChange: (next: DeltaStatus) => void;
  otherActiveCount: number;
  /** Deepen fiction mode: wraps the section in `<details data-testid="deepen-delta-details">`. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  collapseKey?: string;
}

/**
 * CD Batch 5 (D3.1): shared Behavioral Delta editor for DeepenNoteModal and EditNoteModal,
 * preserving WHEN/DO inputs, status select, 5-active-delta cap warning, and fiction collapse.
 */
export const DeltaFieldsSection: React.FC<DeltaFieldsSectionProps> = ({
  variant,
  deltaTrigger,
  onTriggerChange,
  deltaAction,
  onActionChange,
  deltaStatus,
  onStatusChange,
  otherActiveCount,
  collapsible = false,
  defaultOpen = true,
  collapseKey,
}) => {
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const actionId = `${baseId}-action`;
  const statusId = `${baseId}-status`;

  const prefix = variant === 'deepen' ? 'deepen' : 'edit-note';
  const capReached = otherActiveCount >= ACTIVE_DELTA_CAP;
  const isCapViolation = capReached && deltaStatus === 'active';

  const fieldsBody =
    variant === 'deepen' ? (
      <>
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
              onChange={e => onTriggerChange(e.target.value)}
              placeholder="e.g. a dashboard metric spikes unexpectedly"
              className={INPUT}
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
              onChange={e => onActionChange(e.target.value)}
              placeholder="e.g. observe the delay window before changing knobs"
              className={INPUT}
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="sm:w-56 space-y-1">
            <label
              htmlFor={statusId}
              className="block text-[11px] font-semibold uppercase text-muted-foreground"
            >
              Delta Status
            </label>
            <select
              id={statusId}
              data-testid="deepen-delta-status-select"
              value={deltaStatus}
              onChange={e => onStatusChange(e.target.value as DeltaStatus)}
              className={SELECT}
            >
              <option value="none">None</option>
              <option value="active">Active (Practice)</option>
              <option value="paused">Paused</option>
              <option value="graduated">Graduated</option>
            </select>
          </div>

          {capReached && deltaStatus !== 'active' && (
            <p className="text-label text-muted-foreground sm:pt-5">
              5/5 active delta slots are full; graduate or pause an active delta in Practice before
              activating another.
            </p>
          )}
        </div>

        {isCapViolation && (
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
      </>
    ) : (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label
              htmlFor={triggerId}
              className="block text-[11px] font-semibold uppercase text-muted-foreground"
            >
              WHEN Trigger
            </label>
            <input
              id={triggerId}
              type="text"
              data-testid={`${prefix}-trigger-input`}
              value={deltaTrigger}
              onChange={e => onTriggerChange(e.target.value)}
              className="w-full h-11 sm:h-9 px-3 rounded-[8px] bg-background border border-input text-base sm:text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor={actionId}
              className="block text-[11px] font-semibold uppercase text-muted-foreground"
            >
              DO Action
            </label>
            <input
              id={actionId}
              type="text"
              data-testid={`${prefix}-action-input`}
              value={deltaAction}
              onChange={e => onActionChange(e.target.value)}
              className="w-full h-11 sm:h-9 px-3 rounded-[8px] bg-background border border-input text-base sm:text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={statusId} className="sr-only">
            Delta Status
          </label>
          <select
            id={statusId}
            data-testid={`${prefix}-delta-status-select`}
            value={deltaStatus}
            onChange={e => onStatusChange(e.target.value as DeltaStatus)}
            className="h-11 sm:h-9 px-2.5 rounded-[8px] bg-background border border-input text-base sm:text-body text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="none">None</option>
            <option value="active">Active (Practice)</option>
            <option value="paused">Paused</option>
            <option value="graduated">Graduated</option>
          </select>
          <span className="text-[11px] text-muted-foreground num">
            Other active deltas: {otherActiveCount}/{ACTIVE_DELTA_CAP}
          </span>
        </div>

        {isCapViolation && (
          <div
            data-testid="deepen-delta-cap-warning"
            className="rounded-[10px] bg-negative/10 border border-negative/30 px-3 py-2 flex items-start gap-2 text-label text-negative"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Active Behavioral Delta cap (5/5) reached.</span>
          </div>
        )}
      </>
    );

  if (variant === 'deepen' && collapsible) {
    return (
      <details
        key={collapseKey}
        data-testid="deepen-delta-details"
        open={defaultOpen || undefined}
        className="group rounded-[12px] bg-surface2/50 border border-border p-4 space-y-3"
      >
        <summary className="min-h-11 sm:min-h-0 flex flex-wrap items-center justify-between gap-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <span className={`inline-flex items-center gap-1.5 ${EYEBROW}`}>
            <ChevronRight
              className="w-4 h-4 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            Behavioral Delta (optional for fiction)
          </span>
          <span className="text-[11px] text-muted-foreground num">
            Active slots used: {otherActiveCount}/{ACTIVE_DELTA_CAP}
          </span>
        </summary>
        <div className="space-y-3 pt-3">{fieldsBody}</div>
      </details>
    );
  }

  return (
    <div className="rounded-[12px] bg-surface2/50 border border-border p-4 space-y-3">
      {variant === 'deepen' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={EYEBROW}>Behavioral Delta (Optional)</span>
          <span className="text-[11px] text-muted-foreground num">
            Active slots used: {otherActiveCount}/{ACTIVE_DELTA_CAP}
          </span>
        </div>
      )}
      {fieldsBody}
    </div>
  );
};
