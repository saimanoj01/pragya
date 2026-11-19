import { useId, useRef } from 'react';
import { Modal } from './Modal';
import { HELPER } from './uiClasses';

export interface PromptFallbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  prompt: string;
  title?: string;
  dataTestId?: string;
  promptLabel?: string;
}

/**
 * ux_spec A.5 / CD C4.1: shared select-and-copy clipboard fallback (zero network, zero AI).
 * Consolidates the capstone, sparring, and prediction copy-prompt fallback dialogs.
 */
export function PromptFallbackModal({
  isOpen,
  onClose,
  prompt,
  title = 'Copy Capstone Prompt',
  dataTestId = 'capstone-prompt-fallback-modal',
  promptLabel = 'Capstone prompt',
}: PromptFallbackModalProps) {
  const headingId = useId();
  const helperId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      headingId={headingId}
      dataTestId={dataTestId}
      initialFocusRef={textareaRef}
    >
      <div className="space-y-3">
        <h2 id={headingId} className="text-title text-foreground">
          {title}
        </h2>
        <textarea
          ref={textareaRef}
          readOnly
          rows={12}
          value={prompt}
          aria-label={promptLabel}
          aria-describedby={helperId}
          onFocus={e => e.currentTarget.select()}
          className="w-full p-3 rounded-[10px] bg-background border border-input font-mono text-base sm:text-label text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 resize-y"
        />
        <p id={helperId} className={HELPER}>
          Select all and copy (⌘C / Ctrl+C).
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-11 sm:h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
