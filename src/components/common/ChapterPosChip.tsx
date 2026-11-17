import React from 'react';
import type { PosUnit } from '../../types/pragya';
import { formatChapterPos } from '../../utils/chapterFormat';

export interface ChapterPosChipProps {
  /** Test-id suffix: the note slug on list cards, the note id on NoteDetailView (QA-14). */
  testIdKey: string;
  chapter: unknown;
  pos: number;
  posUnit: PosUnit;
  /** Shielded-and-unrevealed notes (chapter can be a spoiler) or grouped divider runs. */
  positionOnly?: boolean;
  className?: string;
}

/** ux_spec B.3 monochrome chip — the chip edge is the bracket. */
export const ChapterPosChip: React.FC<ChapterPosChipProps> = ({
  testIdKey,
  chapter,
  pos,
  posUnit,
  positionOnly = false,
  className = '',
}) => {
  const text = formatChapterPos(positionOnly ? undefined : chapter, pos, posUnit);
  return (
    <span
      data-testid={`chapter-pos-chip-${testIdKey}`}
      title={text}
      className={`inline-flex items-center max-w-[220px] px-2 py-0.5 rounded-md bg-surface2 border border-border text-[11px] font-medium text-foreground num ${className}`}
    >
      <span className="truncate">{text}</span>
    </span>
  );
};
