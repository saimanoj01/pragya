import React, { useId } from 'react';
import { Compass, Copy, Edit3 } from 'lucide-react';
import type { Book, BookCapstone, Note } from '../../types/pragya';
import { useCopyPrompt } from '../../hooks/useCopyPrompt';
import {
  CAPSTONE_COPY_SUCCESS_MESSAGE,
  buildCapstonePrompt,
  countCapstoneEligibleNotes,
  isIsoTimestamp,
} from '../../utils/capstonePrompt';
import { PromptFallbackModal } from './PromptFallbackModal';
import { BTN_SECONDARY, BTN_TERTIARY, CARD, EYEBROW } from './uiClasses';

export interface CapstoneSectionProps {
  book: Book;
  notes: Note[];
  capstone: BookCapstone | undefined;
  capstoneHidden: boolean;
  onOpenEditor: () => void;
  onHide: () => void;
}

/**
 * CD Batch 5 (D3.1 / decisions.md R2#1): Whole-Book Picture card & finished-book empty-state
 * prompt extracted from BookDetailView, wired to shared `useCopyPrompt` + `PromptFallbackModal`.
 */
export const CapstoneSection: React.FC<CapstoneSectionProps> = ({
  book,
  notes,
  capstone,
  capstoneHidden,
  onOpenEditor,
  onHide,
}) => {
  const headingId = useId();
  const { copyPrompt, fallbackModalProps } = useCopyPrompt({
    successMessage: CAPSTONE_COPY_SUCCESS_MESSAGE,
  });

  const eligibleCount = countCapstoneEligibleNotes(book, notes);

  const handleCopyPrompt = () => {
    void copyPrompt(buildCapstonePrompt(book, notes));
  };

  return (
    <>
      {capstone ? (
        <section aria-labelledby={headingId} data-testid="capstone-card" className={`${CARD} space-y-4`}>
          <div className="flex items-center justify-between gap-2">
            <h2 id={headingId} className={`flex items-center gap-1.5 ${EYEBROW}`}>
              <Compass className="w-4 h-4" aria-hidden="true" />
              <span>Whole-Book Picture</span>
            </h2>
            <button
              type="button"
              data-testid="capstone-edit-btn"
              aria-label="Edit Whole-Book Picture"
              onClick={onOpenEditor}
              className={BTN_SECONDARY}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Edit (C)</span>
            </button>
          </div>
          {capstone.arcOrThesis.trim() && (
            <div className="space-y-1">
              <h3 className={EYEBROW}>{book.kind === 'fiction' ? 'The Arc' : 'The Thesis'}</h3>
              <p className="text-body text-foreground whitespace-pre-wrap">
                {capstone.arcOrThesis}
              </p>
            </div>
          )}
          {capstone.keyLearnings.length > 0 && (
            <div className="space-y-1">
              <h3 className={EYEBROW}>Key Learnings</h3>
              <ol className="list-decimal pl-5 space-y-1 text-body text-foreground num">
                {capstone.keyLearnings.map((learning, i) => (
                  <li key={`${i}-${learning}`}>{learning}</li>
                ))}
              </ol>
            </div>
          )}
          {capstone.perspectiveShift.trim() && (
            <div className="pl-4 border-l-2 border-foreground/40 space-y-1">
              <h3 className={EYEBROW}>How My Thinking Shifted</h3>
              <p className="text-body text-foreground whitespace-pre-wrap">
                {capstone.perspectiveShift}
              </p>
            </div>
          )}
          {isIsoTimestamp(capstone.completedAt) && (
            <p className="text-label text-faint num">Written {capstone.completedAt.slice(0, 10)}</p>
          )}
        </section>
      ) : book.status === 'finished' && !capstoneHidden ? (
        <section
          aria-labelledby={headingId}
          data-testid="capstone-empty-state"
          className="print:hidden bg-card border border-dashed border-border rounded-[14px] p-5 space-y-3"
        >
          <h2 id={headingId} className={`flex items-center gap-1.5 ${EYEBROW}`}>
            <Compass className="w-4 h-4" aria-hidden="true" />
            <span>Whole-Book Picture</span>
          </h2>
          <p className="text-body text-muted-foreground">
            {eligibleCount > 0
              ? "While it's fresh, you can capture the shape of this book in a few lines. Entirely optional."
              : 'Capture the shape of this book in a few lines, whenever you like. Entirely optional.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {eligibleCount > 0 && (
              <button
                type="button"
                data-testid="copy-capstone-prompt-btn"
                onClick={handleCopyPrompt}
                className={BTN_SECONDARY}
              >
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Capstone Prompt</span>
              </button>
            )}
            <button
              type="button"
              data-testid="capstone-write-btn"
              onClick={onOpenEditor}
              className={BTN_SECONDARY}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Write It Myself</span>
            </button>
            <button
              type="button"
              data-testid="capstone-hide-btn"
              aria-label="Hide Whole-Book Picture suggestion for this book"
              onClick={onHide}
              className={`ml-auto ${BTN_TERTIARY}`}
            >
              Hide
            </button>
          </div>
        </section>
      ) : null}

      <PromptFallbackModal {...fallbackModalProps} />
    </>
  );
};
