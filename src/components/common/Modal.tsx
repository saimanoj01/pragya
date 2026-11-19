import React, { useCallback, useRef } from 'react';
import { useNativeDialog } from '../../hooks/useNativeDialog';
import { dialogClosedByValue } from '../../utils/dialogOverlay';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  ariaLabel?: string;
  /** Id of the visible heading element inside the dialog; bound via aria-labelledby. */
  headingId?: string;
  /** Id of the dialog's body text; bound via aria-describedby (ConfirmDialog). */
  describedById?: string;
  /** Explicit ARIA role: `'dialog'` (default) or `'alertdialog'` (ConfirmDialog). */
  role?: 'dialog' | 'alertdialog';
  /**
   * True only for view-only dialogs (`closedby="any"` + pointerdown-safe backdrop fallback).
   * Defaults to `false` (`closedby="closerequest"`) so forms and confirms never lose work on
   * a stray backdrop tap or text-selection drag (ux_spec_cd §D.2.1).
   */
  dismissOnBackdrop?: boolean;
  /**
   * When true (e.g. a `busy` destructive `ConfirmDialog`), sets `closedby="none"` and blocks
   * Escape / CloseWatcher closes so an in-flight destructive action cannot desync `<dialog>`.
   */
  disableCloseRequest?: boolean;
  dataTestId?: string;
  variant?: 'dialog' | 'sheet';
  /** When true (and variant='dialog'), docks as a full-width bottom sheet on <640px mobile. */
  mobileSheet?: boolean;
  /** Optional explicit control to focus on open instead of the first form field. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  maxWidth?: string;
  className?: string;
  overlayClassName?: string;
}

const SM_MAX_WIDTH: Record<string, string> = {
  'max-w-sm': 'sm:max-w-sm',
  'max-w-md': 'sm:max-w-md',
  'max-w-lg': 'sm:max-w-lg',
  'max-w-xl': 'sm:max-w-xl',
  'max-w-2xl': 'sm:max-w-2xl',
};

function isFocusableModalChild(el: HTMLElement): boolean {
  // Exclude reparented top-layer toast buttons/items from modal initial-focus selection.
  if (el.closest('[data-testid="toast-layer"]')) return false;
  if (el.offsetParent !== null) return true;
  return typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
}

export function Modal({
  isOpen,
  onClose,
  title,
  ariaLabel,
  headingId,
  describedById,
  role = 'dialog',
  dismissOnBackdrop = false,
  disableCloseRequest = false,
  dataTestId,
  variant = 'dialog',
  mobileSheet = false,
  initialFocusRef,
  children,
  maxWidth = 'max-w-lg',
  className = '',
  overlayClassName = '',
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const initialFocusRefHolder = useRef(initialFocusRef);
  initialFocusRefHolder.current = initialFocusRef;

  const focusInitial = useCallback(() => {
    const container = dialogRef.current;
    if (!container) return;

    const explicitTarget = initialFocusRefHolder.current?.current;
    if (explicitTarget && container.contains(explicitTarget) && isFocusableModalChild(explicitTarget)) {
      explicitTarget.focus();
      return;
    }

    // Note: React 18 strips JSX `autoFocus` from the DOM attribute; prefer `initialFocusRef` for
    // React-managed elements. This query still catches raw/imperatively-set `[autofocus]`.
    const autoFocusTarget = Array.from(
      container.querySelectorAll<HTMLElement>('[autofocus]:not([disabled])')
    ).find(isFocusableModalChild);
    if (autoFocusTarget) {
      autoFocusTarget.focus();
      return;
    }

    const formControls = Array.from(
      container.querySelectorAll<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])'
      )
    ).filter(el => !el.closest('[data-testid="toast-layer"]'));
    const preferredForm = formControls.find(isFocusableModalChild) || formControls[0];
    if (preferredForm) {
      preferredForm.focus();
      return;
    }

    const nonCloseControls = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([aria-label^="Close"]), [href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter(el => !el.closest('[data-testid="toast-layer"]'));
    const preferredAction = nonCloseControls.find(isFocusableModalChild) || nonCloseControls[0];
    if (preferredAction) {
      preferredAction.focus();
      return;
    }

    const allFocusables = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(el => !el.closest('[data-testid="toast-layer"]'));
    const fallback = allFocusables.find(isFocusableModalChild) || allFocusables[0];
    if (fallback) {
      fallback.focus();
    } else {
      container.focus();
    }
  }, []);

  useNativeDialog({
    dialogRef,
    isOpen,
    onClose,
    dismissOnBackdrop,
    disableCloseRequest,
    focusInitial,
  });

  if (!isOpen) return null;

  const isSheet = variant === 'sheet';
  const smMaxWidth = SM_MAX_WIDTH[maxWidth] || maxWidth;

  const dialogClassName = isSheet
    ? `pragya-dialog pragya-dialog--sheet m-0 mt-auto mb-0 sm:mt-0 sm:ml-auto sm:mr-0 w-full sm:w-[440px] sm:h-full max-h-[90dvh] sm:max-h-[100dvh] ${overlayClassName}`
    : mobileSheet
      ? `pragya-dialog pragya-dialog--mobile-sheet m-0 mt-auto mb-0 w-full max-w-full sm:m-auto sm:w-[calc(100%-2rem)] ${smMaxWidth} ${overlayClassName}`
      : `pragya-dialog m-auto w-[calc(100%-2rem)] ${maxWidth} ${overlayClassName}`;

  const panelClassName = isSheet
    ? `w-full h-full max-h-[90dvh] sm:max-h-[100dvh] rounded-t-[18px] sm:rounded-none sm:border-l border-t sm:border-t-0 border-border bg-popover text-popover-foreground pt-6 pb-[max(env(safe-area-inset-bottom),1.5rem)] sm:pb-6 pl-[max(env(safe-area-inset-left),1.5rem)] pr-[max(env(safe-area-inset-right),1.5rem)] sm:pl-6 shadow-2xl relative overflow-y-auto overscroll-contain custom-scrollbar ${className}`
    : mobileSheet
      ? `bg-popover text-popover-foreground w-full max-h-[92dvh] sm:max-h-[90vh] rounded-t-[18px] sm:rounded-[14px] pt-4 pb-[max(env(safe-area-inset-bottom),1rem)] pl-[max(env(safe-area-inset-left),1rem)] pr-[max(env(safe-area-inset-right),1rem)] sm:p-6 shadow-2xl border-t sm:border border-border relative overflow-y-auto overscroll-contain custom-scrollbar ${className}`
      : `bg-popover text-popover-foreground w-full max-h-[90vh] rounded-[14px] p-6 shadow-2xl border border-border relative overflow-y-auto overscroll-contain custom-scrollbar ${className}`;

  return (
    <dialog
      ref={dialogRef}
      role={role}
      aria-modal="true"
      aria-labelledby={headingId || undefined}
      aria-describedby={describedById || undefined}
      aria-label={headingId ? undefined : ariaLabel || title || 'Dialog'}
      data-testid={dataTestId}
      tabIndex={-1}
      {...({
        closedby: dialogClosedByValue(dismissOnBackdrop, disableCloseRequest),
      } as Record<string, string>)}
      className={dialogClassName.trim()}
    >
      <div className={panelClassName.trim()}>{children}</div>
    </dialog>
  );
}
