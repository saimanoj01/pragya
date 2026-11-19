import React from 'react';
import { Sparkles, X } from 'lucide-react';
import type { PosUnit } from '../../types/pragya';
import { kindleUnitMismatchCopy, type KindleHintResult } from '../../utils/kindlePaste';
import type { KindleCleanState } from '../../hooks/useKindlePaste';

export interface KindlePasteChipsProps {
  kindleHint: KindleHintResult;
  kindleClean: KindleCleanState | null;
  posUnit: PosUnit;
  onApplyHint: () => void;
  onDismissHint: () => void;
  onUndoClean: () => void;
}

export const KindlePasteChips: React.FC<KindlePasteChipsProps> = ({
  kindleHint,
  kindleClean,
  posUnit,
  onApplyHint,
  onDismissHint,
  onUndoClean,
}) => (
  <>
    {kindleHint?.kind === 'match' && (
      <div
        data-testid="kindle-pos-chip"
        className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 rounded-[10px] bg-surface2 border border-border text-label"
      >
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Sparkles className="w-3.5 h-3.5 text-foreground shrink-0" />
          <span>
            Detected <strong className="text-foreground num">{kindleHint.hint.label}</strong>
          </span>
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="kindle-pos-apply-btn"
            onClick={onApplyHint}
            className="min-h-11 sm:min-h-0 px-3 sm:px-2.5 py-1 rounded-[8px] bg-primary text-primary-foreground text-[11px] font-semibold hover:opacity-90 inline-flex items-center"
          >
            Apply {kindleHint.hint.pos}
          </button>
          <button
            type="button"
            aria-label="Dismiss detected position"
            onClick={onDismissHint}
            className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 p-1 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    )}

    {kindleHint?.kind === 'mismatch' && (
      <div
        data-testid="kindle-unit-mismatch-chip"
        className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-[10px] bg-surface2 border border-border text-label"
      >
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Sparkles className="w-3.5 h-3.5 text-foreground shrink-0" />
          <span>{kindleUnitMismatchCopy(kindleHint.hint, posUnit)}</span>
        </span>
        <button
          type="button"
          aria-label="Dismiss detected position"
          onClick={onDismissHint}
          className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 p-1 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    )}

    {kindleClean && (
      <div
        data-testid="kindle-clean-chip"
        className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-[10px] bg-surface2 border border-border text-label"
      >
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Sparkles className="w-3.5 h-3.5 text-foreground shrink-0" />
          <span>Cleaned Kindle citation</span>
        </span>
        <button
          type="button"
          data-testid="kindle-clean-undo-btn"
          onClick={onUndoClean}
          className="min-h-11 sm:min-h-0 px-2 sm:px-0 inline-flex items-center gap-1 text-label font-medium text-muted-foreground hover:text-foreground"
        >
          Undo
        </button>
      </div>
    )}
  </>
);
