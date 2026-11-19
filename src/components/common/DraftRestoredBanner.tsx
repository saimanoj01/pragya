import React from 'react';
import { RotateCcw } from 'lucide-react';

export interface DraftRestoredBannerProps {
  visible: boolean;
  onDiscard: () => void;
  message?: string;
}

export const DraftRestoredBanner: React.FC<DraftRestoredBannerProps> = ({
  visible,
  onDiscard,
  message = 'Draft restored from earlier session',
}) => {
  if (!visible) return null;
  return (
    <div
      data-testid="draft-restored-banner"
      className="mb-4 px-3 py-2 rounded-[10px] bg-surface2 border border-border flex items-center justify-between gap-2 text-label"
    >
      <span className="text-foreground">{message}</span>
      <button
        type="button"
        data-testid="draft-discard-btn"
        onClick={onDiscard}
        className="min-h-11 sm:min-h-0 px-2 sm:px-0 inline-flex items-center gap-1 font-semibold text-muted-foreground hover:text-foreground"
      >
        <RotateCcw className="w-3 h-3" />
        <span>Discard</span>
      </button>
    </div>
  );
};
