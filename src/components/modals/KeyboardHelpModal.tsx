import React, { useId } from 'react';
import { X } from 'lucide-react';
import { Modal } from '../common/Modal';
import { EYEBROW, HELPER, KBD } from '../common/uiClasses';
import {
  KEYBOARD_HELP_SUBLINE,
  KEYBOARD_HELP_TITLE,
  KEYBOARD_SHORTCUTS,
  shortcutKeyLabel,
  shortcutKeysText,
} from '../../utils/keyboardShortcuts';

export interface KeyboardHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** CD D2.1 / ux_spec_cd §D.3.6: `?` Keyboard Help, rendered from KEYBOARD_SHORTCUTS only. */
export const KeyboardHelpModal: React.FC<KeyboardHelpModalProps> = ({ isOpen, onClose }) => {
  const headingId = useId();
  const platform = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : '';
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      headingId={headingId}
      dataTestId="keyboard-help-modal"
      dismissOnBackdrop={true}
      maxWidth="max-w-2xl"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 id={headingId} className="text-title text-foreground">
            {KEYBOARD_HELP_TITLE}
          </h2>
          <p className={HELPER}>{KEYBOARD_HELP_SUBLINE}</p>
        </div>
        <button
          type="button"
          aria-label="Close keyboard shortcuts"
          onClick={onClose}
          className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 sm:w-8 sm:h-8 rounded-[8px] inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-5 grid gap-6 sm:grid-cols-2">
        {KEYBOARD_SHORTCUTS.map(section => (
          <section key={section.id} data-testid={`keyboard-help-section-${section.id}`} className="space-y-2">
            <h3 className={EYEBROW}>{section.title}</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-baseline">
              {section.rows.map(row => (
                <React.Fragment key={`${section.id}:${shortcutKeysText(row.keys, platform)}`}>
                  <dt className="flex flex-wrap items-center gap-1 text-label text-muted-foreground">
                    {row.keys.map((tok, i) =>
                      'key' in tok ? (
                        <kbd key={i} className={KBD}>
                          {shortcutKeyLabel(tok.key, platform)}
                        </kbd>
                      ) : (
                        <span key={i}>{tok.text}</span>
                      )
                    )}
                  </dt>
                  <dd className="text-body text-foreground">{row.action}</dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
};
