import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  ariaLabel?: string;
  dataTestId?: string;
  variant?: 'dialog' | 'sheet';
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
  dataTestId,
  variant = 'dialog',
  children,
  maxWidth = 'max-w-lg',
  className = '',
  overlayClassName = '',
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocusedElementRef.current = document.activeElement as HTMLElement | null;

    const timer = setTimeout(() => {
      if (!modalRef.current) return;
      const focusables = modalRef.current.querySelectorAll<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        modalRef.current.focus();
      }
    }, 30);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== modalRef.current) {
          return;
        }
        // Respect inner popovers if any are open
        if (document.querySelector('[data-popover="true"]')) {
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
      clearTimeout(timer);
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
      aria-label={ariaLabel || title || 'Dialog'}
      data-testid={dataTestId}
      onClick={handleBackdropClick}
      tabIndex={-1}
      className={
        isSheet
          ? `fixed inset-0 z-50 flex items-end sm:items-stretch sm:justify-end bg-background/60 backdrop-blur-sm ${overlayClassName}`
          : `fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm overflow-y-auto ${overlayClassName}`
      }
    >
      <motion.div
        initial={isSheet ? { opacity: 0, x: 24 } : { opacity: 0, scale: 0.96, y: 8 }}
        animate={isSheet ? { opacity: 1, x: 0 } : { opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className={
          isSheet
            ? `w-full sm:w-[440px] sm:h-full max-h-[90vh] sm:max-h-screen rounded-t-[18px] sm:rounded-none sm:border-l border-t sm:border-t-0 border-border bg-popover p-6 shadow-2xl relative overflow-y-auto custom-scrollbar ${className}`
            : `bg-popover text-popover-foreground w-full ${maxWidth} max-h-[90vh] rounded-[14px] p-6 shadow-2xl border border-border relative overflow-y-auto custom-scrollbar ${className}`
        }
        onClick={e => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </div>
  );
}
