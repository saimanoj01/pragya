import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  ariaLabel?: string;
  /** Id of the visible heading element inside the dialog; bound via aria-labelledby. */
  headingId?: string;
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

export function Modal({
  isOpen,
  onClose,
  title,
  ariaLabel,
  headingId,
  dataTestId,
  variant = 'dialog',
  mobileSheet = false,
  initialFocusRef,
  children,
  maxWidth = 'max-w-lg',
  className = '',
  overlayClassName = '',
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocusRefHolder = useRef(initialFocusRef);
  initialFocusRefHolder.current = initialFocusRef;

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocusedElementRef.current = document.activeElement as HTMLElement | null;

    const focusInitialElement = () => {
      const container = modalRef.current;
      if (!container) return;
      const explicitTarget = initialFocusRefHolder.current?.current;
      if (explicitTarget && container.contains(explicitTarget) && explicitTarget.offsetParent !== null) {
        explicitTarget.focus();
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      if (active && container.contains(active) && active !== container) {
        return;
      }

      const formControls = Array.from(
        container.querySelectorAll<HTMLElement>(
          'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])'
        )
      );
      const preferredForm = formControls.find(el => el.offsetParent !== null) || formControls[0];
      if (preferredForm) {
        preferredForm.focus();
        return;
      }

      const nonCloseControls = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([aria-label^="Close"]), [href], [tabindex]:not([tabindex="-1"])'
        )
      );
      const preferredAction =
        nonCloseControls.find(el => el.offsetParent !== null) || nonCloseControls[0];
      if (preferredAction) {
        preferredAction.focus();
        return;
      }

      const allFocusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      const fallback = allFocusables.find(el => el.offsetParent !== null) || allFocusables[0];
      if (fallback) {
        fallback.focus();
      } else {
        container.focus();
      }
    };

    focusInitialElement();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== modalRef.current) {
          return;
        }
        // Respect inner popovers if any are open inside this modal
        if (modalRef.current?.querySelector('[data-popover="true"]')) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (e.key === 'Tab' && modalRef.current) {
        const focusables = Array.from(
          modalRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter(el => el.offsetParent !== null);

        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            last.focus();
            e.preventDefault();
          }
        } else if (document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      previouslyFocusedElementRef.current?.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onCloseRef.current();
    }
  };

  const isSheet = variant === 'sheet';

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId || undefined}
      aria-label={headingId ? undefined : ariaLabel || title || 'Dialog'}
      data-testid={dataTestId}
      onClick={handleBackdropClick}
      tabIndex={-1}
      className={
        isSheet
          ? `fixed inset-0 z-50 flex items-end sm:items-stretch sm:justify-end bg-background/60 backdrop-blur-sm ${overlayClassName}`
          : mobileSheet
            ? `fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-background/80 backdrop-blur-sm overflow-y-auto ${overlayClassName}`
            : `fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm overflow-y-auto ${overlayClassName}`
      }
    >
      <motion.div
        initial={
          isSheet
            ? { opacity: 0, x: 24 }
            : mobileSheet
              ? { opacity: 0, y: 20 }
              : { opacity: 0, scale: 0.96, y: 8 }
        }
        animate={isSheet ? { opacity: 1, x: 0 } : { opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className={
          isSheet
            ? `w-full sm:w-[440px] sm:h-full max-h-[90vh] sm:max-h-screen rounded-t-[18px] sm:rounded-none sm:border-l border-t sm:border-t-0 border-border bg-popover p-6 shadow-2xl relative overflow-y-auto custom-scrollbar ${className}`
            : mobileSheet
              ? `bg-popover text-popover-foreground w-full ${maxWidth} max-h-[92dvh] sm:max-h-[90vh] rounded-t-[18px] sm:rounded-[14px] p-4 sm:p-6 shadow-2xl border-t sm:border border-border relative overflow-y-auto custom-scrollbar ${className}`
              : `bg-popover text-popover-foreground w-full ${maxWidth} max-h-[90vh] rounded-[14px] p-6 shadow-2xl border border-border relative overflow-y-auto custom-scrollbar ${className}`
        }
        onClick={e => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </div>
  );
}
