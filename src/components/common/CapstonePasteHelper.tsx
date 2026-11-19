import React, { useEffect, useState } from 'react';
import { ChevronRight, Copy } from 'lucide-react';
import { parseCapstoneReply, type ParsedCapstoneReply } from '../../utils/capstonePrompt';
import { BTN_SECONDARY, BTN_TERTIARY, HELPER, TEXTAREA } from './uiClasses';

export interface CapstonePasteHelperProps {
  resetKey: string;
  eligibleCount: number;
  onCopyPrompt: () => void;
  /** Returns true when at least one field was populated from `parsed`. */
  onApplyParsed: (parsed: ParsedCapstoneReply) => boolean;
}

/**
 * CD Batch 5 (D3.1 / decisions.md R2#1): extracted assistant-reply paste disclosure +
 * Copy Prompt companion row for CapstoneModal.
 */
export const CapstonePasteHelper: React.FC<CapstonePasteHelperProps> = ({
  resetKey,
  eligibleCount,
  onCopyPrompt,
  onApplyParsed,
}) => {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteStatus, setPasteStatus] = useState('');

  useEffect(() => {
    setPasteOpen(false);
    setPasteText('');
    setPasteStatus('');
  }, [resetKey]);

  const handleFill = () => {
    const parsed = parseCapstoneReply(pasteText);
    const applied = onApplyParsed(parsed);
    if (!applied) {
      setPasteStatus(
        "Couldn't find the expected headings. You can paste each part into the fields below."
      );
      return;
    }
    setPasteOpen(false);
    setPasteStatus('Filled from the reply. Edit anything you like.');
  };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <details
          open={pasteOpen}
          onToggle={e => setPasteOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="flex-1 min-w-0 space-y-2"
        >
          <summary
            className={`${BTN_TERTIARY} cursor-pointer list-none h-11 sm:h-9 [&::-webkit-details-marker]:hidden`}
          >
            <ChevronRight
              className={`w-3.5 h-3.5 transition-transform ${pasteOpen ? 'rotate-90' : ''}`}
              aria-hidden="true"
            />
            <span>Paste a reply from your assistant</span>
          </summary>
          <textarea
            rows={5}
            aria-label="Assistant reply"
            data-testid="capstone-paste-input"
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            placeholder="Paste the reply here…"
            className={TEXTAREA}
          />
          <button
            type="button"
            data-testid="capstone-fill-btn"
            onClick={handleFill}
            disabled={!pasteText.trim()}
            className={BTN_SECONDARY}
          >
            Fill Fields
          </button>
        </details>
        {eligibleCount > 0 && (
          <button
            type="button"
            data-testid="capstone-modal-copy-prompt-btn"
            onClick={onCopyPrompt}
            className={BTN_SECONDARY}
          >
            <Copy className="w-3.5 h-3.5" />
            <span>Copy Prompt</span>
          </button>
        )}
      </div>
      {pasteStatus && (
        <p role="status" data-testid="capstone-paste-status" className={HELPER}>
          {pasteStatus}
        </p>
      )}
    </>
  );
};
