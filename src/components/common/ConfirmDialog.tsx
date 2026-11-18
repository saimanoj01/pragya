import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './Modal';
import { BTN_DESTRUCTIVE, BTN_PRIMARY, BTN_SECONDARY, BTN_SIZE_LG, BTN_TERTIARY } from './uiClasses';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** `destructive` (default) uses the negative style; `default` uses BTN_PRIMARY. */
  tone?: 'destructive' | 'default';
  /** Optional secondary action (e.g. "Discard drafts and log out"). */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Style of the secondary action; `destructive` when IT is the data-losing choice. */
  secondaryTone?: 'destructive' | 'default';
  /** Optional inline "Download a backup first" link; the dialog stays open. */
  onDownloadBackup?: () => void;
  busy?: boolean;
}

/**
 * ux_spec_cd §0.1 shared confirmation. Built on the current Modal (role="dialog" so the
 * existing shortcut / Escape guards still see it; `alertdialog` arrives with the native
 * <dialog> migration in CD Batch 6). Cancel has initial focus, Escape = Cancel, and the
 * backdrop never answers for the user.
 */
export function ConfirmDialog({
  isOpen,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  tone = 'destructive',
  secondaryLabel,
  onSecondary,
  secondaryTone = 'default',
  onDownloadBackup,
  busy = false,
}: ConfirmDialogProps) {
  const headingId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (!isOpen) return null;
  // Portaled to <body> so it is never trapped inside a parent modal's transformed box,
  // and is the last [role="dialog"] in the DOM (Modal's Escape layering picks it first).
  return createPortal(
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      headingId={headingId}
      describedById={bodyId}
      dataTestId="confirm-dialog"
      initialFocusRef={cancelRef}
      dismissOnBackdrop={false}
      maxWidth="max-w-md"
    >
      <div className="space-y-4">
        <h2 id={headingId} className="text-title text-foreground">
          {title}
        </h2>
        <div id={bodyId} className="text-body text-muted-foreground space-y-2">
          {body}
        </div>
        {onDownloadBackup && (
          <button
            type="button"
            data-testid="confirm-dialog-backup-btn"
            onClick={onDownloadBackup}
            className={BTN_TERTIARY}
          >
            Download a backup first
          </button>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            data-testid="confirm-dialog-cancel-btn"
            onClick={onCancel}
            className={`${BTN_SECONDARY} ${BTN_SIZE_LG}`}
          >
            Cancel
          </button>
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              data-testid="confirm-dialog-secondary-btn"
              onClick={onSecondary}
              disabled={busy}
              className={secondaryTone === 'destructive' ? BTN_DESTRUCTIVE : `${BTN_SECONDARY} ${BTN_SIZE_LG}`}
            >
              {secondaryLabel}
            </button>
          )}
          <button
            type="button"
            data-testid="confirm-dialog-confirm-btn"
            onClick={onConfirm}
            disabled={busy}
            className={tone === 'destructive' ? BTN_DESTRUCTIVE : `${BTN_PRIMARY} ${BTN_SIZE_LG}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>,
    document.body
  );
}
