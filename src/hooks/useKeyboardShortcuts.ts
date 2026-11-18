import { useEffect, useRef } from 'react';
import { navigateTo, type PragyaRoute } from '../utils/navigation';
import { isHelpShortcut } from '../utils/keyboardShortcuts';

export function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

export interface UseKeyboardShortcutsOptions {
  isAuthenticated: boolean;
  route: PragyaRoute;
  hasOpenOverlay: boolean;
  isSessionExpiredOpen: boolean;
  onToggleCommandPalette: () => void;
  onOpenCapture: (bookId: string | null) => void;
  onSyncNow: () => void;
  /** CD D2.1: `?` opens the Keyboard Help modal. */
  onOpenKeyboardHelp?: () => void;
}

export function useKeyboardShortcuts({
  isAuthenticated,
  route,
  hasOpenOverlay,
  isSessionExpiredOpen,
  onToggleCommandPalette,
  onOpenCapture,
  onSyncNow,
  onOpenKeyboardHelp,
}: UseKeyboardShortcutsOptions): void {
  const gChordTimerRef = useRef<number | null>(null);
  const awaitingGTargetRef = useRef(false);

  const callbacksRef = useRef({
    onToggleCommandPalette,
    onOpenCapture,
    onSyncNow,
    onOpenKeyboardHelp,
  });
  callbacksRef.current = {
    onToggleCommandPalette,
    onOpenCapture,
    onSyncNow,
    onOpenKeyboardHelp,
  };

  useEffect(() => {
    if (!isAuthenticated) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (isSessionExpiredOpen) return;
        e.preventDefault();
        callbacksRef.current.onToggleCommandPalette();
        return;
      }

      if (e.key === 'Escape') {
        if (document.querySelector('[data-popover="true"]')) return;
        if (document.querySelector('[data-testid="image-lightbox"]')) return;
        if (hasOpenOverlay || isSessionExpiredOpen) return;
        if (route.view === 'book') {
          navigateTo('#/shelf');
        } else if (route.view === 'note') {
          navigateTo('#/notes');
        }
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableElement(e.target)) return;
      if (hasOpenOverlay || isSessionExpiredOpen) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (document.querySelector('[data-popover="true"]')) return;

      if (isHelpShortcut(e)) {
        if (callbacksRef.current.onOpenKeyboardHelp) {
          e.preventDefault();
          callbacksRef.current.onOpenKeyboardHelp();
        }
        return;
      }

      const key = e.key.toLowerCase();

      if (awaitingGTargetRef.current) {
        awaitingGTargetRef.current = false;
        if (gChordTimerRef.current) {
          window.clearTimeout(gChordTimerRef.current);
          gChordTimerRef.current = null;
        }
        if (key === 's') {
          e.preventDefault();
          navigateTo('#/shelf');
          return;
        }
        if (key === 'n') {
          e.preventDefault();
          navigateTo('#/notes');
          return;
        }
        if (key === 'p') {
          e.preventDefault();
          navigateTo('#/practice');
          return;
        }
      }

      if (key === 'g') {
        awaitingGTargetRef.current = true;
        if (gChordTimerRef.current) window.clearTimeout(gChordTimerRef.current);
        gChordTimerRef.current = window.setTimeout(() => {
          awaitingGTargetRef.current = false;
        }, 1000);
        return;
      }

      if (key === 'n') {
        e.preventDefault();
        callbacksRef.current.onOpenCapture(route.view === 'book' ? route.bookId || null : null);
        return;
      }

      if (key === 'r') {
        e.preventDefault();
        callbacksRef.current.onSyncNow();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (gChordTimerRef.current) window.clearTimeout(gChordTimerRef.current);
    };
  }, [hasOpenOverlay, isAuthenticated, isSessionExpiredOpen, route.bookId, route.view]);
}
