import React from 'react';
import { Archive } from 'lucide-react';
import { BTN_SECONDARY, INSET } from './uiClasses';

export interface ArchivedBannerProps {
  /** `YYYY-MM-DD` of the archive timestamp. */
  date: string;
  onRestore: () => void;
  busy?: boolean;
  /** R2#2: a book's notes are NOT hidden by archiving the book, so its copy differs. */
  kind?: 'book' | 'note';
  /** Compact variant for cards in the Notes `Archived` filter. */
  compact?: boolean;
  /** CD Batch 1b slots "Delete Forever…" here. */
  children?: React.ReactNode;
}

/** ux_spec_cd C.1.3 archived banner (BookDetailView / NoteDetailView / archived cards). */
export const ArchivedBanner: React.FC<ArchivedBannerProps> = ({
  date,
  kind = 'note',
  onRestore,
  busy = false,
  compact = false,
  children,
}) => (
  <div
    data-testid="archived-banner"
    className={`${INSET} flex flex-wrap items-center gap-x-3 gap-y-2 ${compact ? 'py-2' : ''}`}
  >
    <div className="flex items-center gap-2 min-w-0 flex-1 text-label text-muted-foreground">
      <Archive className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="num">
        {kind === 'book'
          ? `Archived ${date}. Hidden from your Shelf and search. Its notes stay in Notes.`
          : `Archived ${date}. Hidden from your Shelf, Notes, and search.`}
      </span>
    </div>
    <div className="flex items-center gap-3">
      <button
        type="button"
        data-testid="restore-btn"
        onClick={onRestore}
        disabled={busy}
        className={BTN_SECONDARY}
      >
        Restore
      </button>
      {children}
    </div>
  </div>
);
