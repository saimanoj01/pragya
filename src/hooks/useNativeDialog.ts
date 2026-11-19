import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  claimDialogOrder,
  getTopmostOpenDialog,
  isBackdropHit,
  isTopmostOpenDialog,
  shouldAcceptDialogCancel,
  shouldCloseOnBackdrop,
  shouldRestoreFocusOnClose,
  supportsDialogClosedBy,
} from '../utils/dialogOverlay';
import { isInsideToastLayer, syncToastLayerContainer } from '../utils/toastLayer';

export interface UseNativeDialogOptions {
  dialogRef: RefObject<HTMLDialogElement | null>;
  isOpen: boolean;
  onClose: () => void;
  /** True only for view-only dialogs (`closedby="any"`). Forms & confirms stay `false`. */
  dismissOnBackdrop: boolean;
  /** When true (e.g. a `busy` destructive `ConfirmDialog`), suppresses Escape / CloseWatcher closes. */
  disableCloseRequest?: boolean;
  /** Runs synchronously after `.showModal()` to focus the intended control. */
  focusInitial?: () => void;
}

/**
 * Opens `dialog` in the Top Layer via `.showModal()` safely (guards disconnected nodes and
 * catches `InvalidStateError`, cleaning up `data-dialog-order` on failure).
 */
function openNativeModal(dialog: HTMLDialogElement): boolean {
  if (!dialog.isConnected) return false;
  if (dialog.open) return true;
  if (typeof dialog.showModal !== 'function') return false;

  const order = claimDialogOrder();
  dialog.dataset.dialogOrder = String(order);
  try {
    dialog.showModal();
    return true;
  } catch {
    delete dialog.dataset.dialogOrder;
    return false;
  }
}

/**
 * CD Batch 6 (D2.4 + Fix-up QA-44/QA-45/R1/R2): Shared lifecycle hook for native `<dialog>` overlays.
 *
 * - Opens safely via `.showModal()` in `useLayoutEffect` (never `.show()`) and closes cleanly on unmount.
 * - Attaches imperative `cancel` & `close` listeners (React 18 does not wire JSX `onCancel`/`onClose`).
 * - Reparents the persistent `popover="manual"` toast layer into the topmost open `<dialog>` (and
 *   rescues it back to the next open dialog or `document.body` BEFORE unmount) so toasts stay non-inert.
 * - Re-syncs `dialog.showModal()` if a browser CloseWatcher force-closes while React still holds
 *   `isOpen === true` (e.g. a `busy` `ConfirmDialog`).
 * - Gates Safari / Chromium<134 `pointerdown`+`click` backdrop fallback listeners on
 *   `!supportsDialogClosedBy()` (zero forced `getBoundingClientRect()` reads in Chrome 134+/Firefox 141+).
 * - Restores focus to the prior invoker safely without stealing focus from a newly opened dialog.
 */
export function useNativeDialog({
  dialogRef,
  isOpen,
  onClose,
  dismissOnBackdrop,
  disableCloseRequest = false,
  focusInitial,
}: UseNativeDialogOptions): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const pointerDownOnBackdropRef = useRef(false);
  const closingFromReactRef = useRef(false);
  const closeRequestedRef = useRef(false);

  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissOnBackdropRef = useRef(dismissOnBackdrop);
  dismissOnBackdropRef.current = dismissOnBackdrop;
  const disableCloseRequestRef = useRef(disableCloseRequest);
  disableCloseRequestRef.current = disableCloseRequest;
  const focusInitialRef = useRef(focusInitial);
  focusInitialRef.current = focusInitial;

  useLayoutEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    closingFromReactRef.current = false;
    closeRequestedRef.current = false;
    pointerDownOnBackdropRef.current = false;
    let resyncTimer: number | null = null;

    // Capture prior focus BEFORE showModal() moves focus inside the dialog.
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const opened = openNativeModal(dialog);

    // Focus the intended control BEFORE reparenting the toast layer inside `<dialog>`.
    focusInitialRef.current?.();

    // QA-44 / R1#1: reparent the persistent `popover="manual"` toast host into the topmost open
    // `<dialog>` so toasts render above `::backdrop` AND stay non-inert / genuinely clickable.
    if (opened) {
      syncToastLayerContainer(document);
    }

    const requestClose = () => {
      if (closeRequestedRef.current) return;
      closeRequestedRef.current = true;
      onCloseRef.current();
      queueMicrotask(() => {
        closeRequestedRef.current = false;
      });
    };

    const resyncIfStillOpen = () => {
      if (
        isOpenRef.current &&
        !closingFromReactRef.current &&
        dialog.isConnected &&
        !dialog.open
      ) {
        if (openNativeModal(dialog)) {
          syncToastLayerContainer(document);
        }
      }
    };

    const handleCancel = (e: Event) => {
      // React owns the unmount so useModalDraft flushes synchronously and busy confirms stay open.
      e.preventDefault();
      const accepted = shouldAcceptDialogCancel({
        hasInnerPopover: Boolean(dialog.querySelector('[data-popover="true"]')),
        isTopmost: isTopmostOpenDialog(dialog, document),
        disableCloseRequest: disableCloseRequestRef.current,
      });
      if (!accepted) return;
      requestClose();
    };

    const handleClose = () => {
      // Ignore stale queued `close` events (e.g. from React StrictMode cleanup's `dialog.close()`)
      // arriving after remount already re-opened the dialog (`dialog.open === true`).
      if (dialog.open || closingFromReactRef.current) return;

      if (!disableCloseRequestRef.current && !closeRequestedRef.current) {
        requestClose();
      }

      // QA-45 / R1#2: if the browser force-closed `<dialog>` while React vetoed closing (e.g.
      // busy ConfirmDialog), re-open it so DOM `dialog.open` can never silently desync from React.
      if (disableCloseRequestRef.current) {
        queueMicrotask(resyncIfStillOpen);
      } else {
        if (resyncTimer !== null) window.clearTimeout(resyncTimer);
        resyncTimer = window.setTimeout(() => {
          resyncTimer = null;
          resyncIfStillOpen();
        }, 0);
      }
    };

    dialog.addEventListener('cancel', handleCancel);
    dialog.addEventListener('close', handleClose);

    // R2-4: only attach pointerdown/click backdrop fallback listeners when native `closedBy` is absent.
    const useBackdropFallback = !supportsDialogClosedBy();

    const handlePointerDown = (e: PointerEvent) => {
      // R1-N2: ignore non-primary mouse buttons (right/middle click) and events inside toast-layer.
      if (
        !dismissOnBackdropRef.current ||
        disableCloseRequestRef.current ||
        (e.pointerType !== 'touch' && e.button !== 0) ||
        isInsideToastLayer(e.target)
      ) {
        pointerDownOnBackdropRef.current = false;
        return;
      }
      const rect = dialog.getBoundingClientRect();
      pointerDownOnBackdropRef.current = isBackdropHit(
        e.target,
        dialog,
        e.clientX,
        e.clientY,
        rect
      );
    };

    const handlePointerCancel = () => {
      pointerDownOnBackdropRef.current = false;
    };

    const handleClick = (e: MouseEvent) => {
      const wasDownOnBackdrop = pointerDownOnBackdropRef.current;
      pointerDownOnBackdropRef.current = false;
      if (
        !dismissOnBackdropRef.current ||
        disableCloseRequestRef.current ||
        isInsideToastLayer(e.target)
      ) {
        return;
      }
      const rect = dialog.getBoundingClientRect();
      const clickOnBackdrop = isBackdropHit(e.target, dialog, e.clientX, e.clientY, rect);
      if (
        shouldCloseOnBackdrop({
          dismissOnBackdrop: dismissOnBackdropRef.current,
          pointerDownOnBackdrop: wasDownOnBackdrop,
          clickOnBackdrop,
          detail: e.detail,
          nativeClosedBySupported: false,
        })
      ) {
        requestClose();
      }
    };

    if (useBackdropFallback) {
      dialog.addEventListener('pointerdown', handlePointerDown);
      dialog.addEventListener('pointercancel', handlePointerCancel);
      dialog.addEventListener('click', handleClick);
    }

    return () => {
      if (resyncTimer !== null) {
        window.clearTimeout(resyncTimer);
        resyncTimer = null;
      }
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('close', handleClose);
      if (useBackdropFallback) {
        dialog.removeEventListener('pointerdown', handlePointerDown);
        dialog.removeEventListener('pointercancel', handlePointerCancel);
        dialog.removeEventListener('click', handleClick);
      }

      closingFromReactRef.current = true;
      delete dialog.dataset.dialogOrder;
      if (dialog.open && typeof dialog.close === 'function') {
        dialog.close();
      }

      // QA-44: rescue the persistent toast-layer out of this closing `<dialog>` into the next
      // topmost open `<dialog>` (or `document.body`) BEFORE React removes `<dialog>` from the DOM.
      syncToastLayerContainer(document, undefined, dialog);

      const prev = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      const topDialog = getTopmostOpenDialog(document, dialog);
      if (
        prev &&
        shouldRestoreFocusOnClose({
          previousElConnected: prev.isConnected,
          topmostOpenDialog: topDialog,
          previousEl: prev,
        })
      ) {
        if (document.activeElement !== prev) {
          prev.focus?.();
        }
      }
    };
  }, [dialogRef, isOpen]);
}
