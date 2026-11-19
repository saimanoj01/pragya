/**
 * CD Batch 6 (D2.4): Pure native `<dialog>` top-layer helpers (erasable TS, Node-testable).
 *
 * Centralizes open-dialog detection (`dialog[open]`, `[role="dialog"]`, `[role="alertdialog"]`),
 * top-layer stacking order, pointerdown-safe backdrop light-dismiss checks, Escape priority,
 * and focus-restoration eligibility across Modal, ConfirmDialog, CommandPalette, ImageLightbox,
 * BottomNav More drawer, keyboard shortcut guards, paste guards, and SW update idle checks.
 */

/**
 * Matches any open native `<dialog>` (whether `role="dialog"`, `role="alertdialog"`, or default)
 * plus any legacy non-`<dialog>` element bearing `role="dialog"` or `role="alertdialog"`.
 * Deliberately excludes closed `<dialog role="dialog">` elements without `[open]`.
 */
export const OPEN_DIALOG_SELECTOR =
  'dialog[open], [role="dialog"]:not(dialog), [role="alertdialog"]:not(dialog)';

export interface QuerySelectorRoot {
  querySelector(selectors: string): unknown;
}

export interface QuerySelectorAllRoot {
  querySelectorAll(selectors: string): ArrayLike<ElementLike>;
}

export interface ElementLike {
  getAttribute?(name: string): string | null;
  contains?(node: unknown): boolean;
}

export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

let dialogOrderSeq = 0;

/** Monotonic top-layer open sequence stamped onto `dialog.dataset.dialogOrder`. */
export function claimDialogOrder(): number {
  dialogOrderSeq += 1;
  return dialogOrderSeq;
}

/** Test-only helper to reset the monotonic dialog stack counter. */
export function resetDialogOrderForTests(): void {
  dialogOrderSeq = 0;
}

/** True when any native `<dialog open>` or ARIA dialog/alertdialog is currently open. */
export function hasOpenDialog(doc: QuerySelectorRoot | null | undefined): boolean {
  if (!doc) return false;
  return Boolean(doc.querySelector(OPEN_DIALOG_SELECTOR));
}

/** Returns all currently open dialogs in DOM order. */
export function getOpenDialogs<T extends ElementLike = Element>(
  doc: QuerySelectorAllRoot | null | undefined
): T[] {
  if (!doc) return [];
  return Array.from(doc.querySelectorAll(OPEN_DIALOG_SELECTOR)) as T[];
}

function readDialogOrder(el: ElementLike): number | null {
  const raw = el.getAttribute?.('data-dialog-order');
  if (raw == null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Returns the topmost open dialog in the top layer (optionally excluding a closing dialog).
 * When dialogs carry `data-dialog-order` (stamped on `showModal()`), the highest order wins
 * regardless of DOM position; otherwise falls back to the last dialog in DOM order.
 */
export function getTopmostOpenDialog<T extends ElementLike = Element>(
  doc: QuerySelectorAllRoot | null | undefined,
  exclude?: unknown
): T | null {
  const dialogs = getOpenDialogs<T>(doc).filter(dlg => dlg !== exclude);
  if (dialogs.length === 0) return null;

  let best: T | null = null;
  let bestOrder = -Infinity;
  for (const dlg of dialogs) {
    const order = readDialogOrder(dlg);
    if (order !== null && order >= bestOrder) {
      bestOrder = order;
      best = dlg;
    }
  }
  return best ?? dialogs[dialogs.length - 1];
}

/** True when `el` is the topmost currently open dialog (or when no open dialog is found). */
export function isTopmostOpenDialog(
  el: ElementLike | null | undefined,
  doc: QuerySelectorAllRoot | null | undefined
): boolean {
  if (!el) return false;
  const top = getTopmostOpenDialog(doc);
  return top === null || top === el;
}

/**
 * Maps modal dismiss policy to the HTML `<dialog closedby>` attribute:
 * - `'none'` when closing is temporarily disabled (e.g. a `busy` destructive `ConfirmDialog`),
 *   preventing Chromium's CloseWatcher abuse-prevention from force-closing on repeated Escape;
 * - `'any'` for view-only light-dismiss dialogs;
 * - `'closerequest'` for forms and confirmations.
 */
export function dialogClosedByValue(
  dismissOnBackdrop: boolean,
  disableCloseRequest = false
): 'any' | 'closerequest' | 'none' {
  if (disableCloseRequest) return 'none';
  return dismissOnBackdrop ? 'any' : 'closerequest';
}

/** Feature detection for the native `<dialog closedby>` property (Chrome 134+, Firefox 141+). */
export function supportsDialogClosedBy(): boolean {
  return typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype;
}

/** True when viewport point `(clientX, clientY)` falls inside `rect` (inclusive of edges). */
export function isPointInsideRect(clientX: number, clientY: number, rect: RectLike): boolean {
  return (
    rect.top <= clientY &&
    clientY <= rect.top + rect.height &&
    rect.left <= clientX &&
    clientX <= rect.left + rect.width
  );
}

/**
 * True ONLY when an event directly targeted the `<dialog>` element itself (not a child inside it)
 * AND its pointer coordinates landed outside the dialog content box (i.e. on `::backdrop`).
 */
export function isBackdropHit(
  eventTarget: unknown,
  dialogEl: unknown,
  clientX: number,
  clientY: number,
  rect: RectLike
): boolean {
  if (!dialogEl || eventTarget !== dialogEl) return false;
  return !isPointInsideRect(clientX, clientY, rect);
}

export interface ShouldCloseOnBackdropOptions {
  /** Only true for view-only dialogs (`closedby="any"`). Forms and confirms are always false. */
  dismissOnBackdrop: boolean;
  /** True only when `pointerdown` started directly on the `<dialog>` backdrop outside its rect. */
  pointerDownOnBackdrop: boolean;
  /** True only when the `click` ended directly on the `<dialog>` backdrop outside its rect. */
  clickOnBackdrop: boolean;
  /** MouseEvent.detail (0 for keyboard-synthesized clicks). */
  detail?: number;
  /** True when the browser natively supports `HTMLDialogElement.prototype.closedBy`. */
  nativeClosedBySupported?: boolean;
}

/**
 * Fallback light-dismiss decision for browsers without native `<dialog closedby>` (e.g. Safari,
 * Chromium < 134). Requiring BOTH `pointerdown` and `click` on the backdrop guarantees that
 * dragging a text selection from inside a dialog out onto the backdrop never closes it.
 */
export function shouldCloseOnBackdrop(opts: ShouldCloseOnBackdropOptions): boolean {
  if (!opts.dismissOnBackdrop) return false;
  if (opts.nativeClosedBySupported) return false;
  if (opts.detail === 0) return false;
  return opts.pointerDownOnBackdrop && opts.clickOnBackdrop;
}

/**
 * Native `<dialog>` `cancel` event acceptance guard:
 * - Never closes while `disableCloseRequest` is true (e.g. a `busy` ConfirmDialog).
 * - Never closes a dialog while an inner `[data-popover="true"]` (e.g. WikilinkAutocomplete) is open.
 * - Only closes the topmost dialog in the top-layer stack.
 */
export function shouldAcceptDialogCancel(opts: {
  hasInnerPopover: boolean;
  isTopmost: boolean;
  disableCloseRequest?: boolean;
}): boolean {
  if (opts.disableCloseRequest) return false;
  if (opts.hasInnerPopover) return false;
  if (!opts.isTopmost) return false;
  return true;
}

export type EscapeTarget = 'popover' | 'dialog' | 'route-shelf' | 'route-notes' | 'none';

/**
 * Layered Escape priority (popover → open dialog/lightbox → detail route back):
 * ensures `useKeyboardShortcuts` never navigates away from a Book or Note page while
 * any popover, modal `<dialog>`, `ConfirmDialog`, `ImageLightbox`, or drawer is open.
 */
export function resolveEscapePriority(state: {
  hasPopover: boolean;
  hasOpenDialog: boolean;
  hasOverlayFlag?: boolean;
  routeView: string;
}): EscapeTarget {
  if (state.hasPopover) return 'popover';
  if (state.hasOpenDialog || state.hasOverlayFlag) return 'dialog';
  if (state.routeView === 'book') return 'route-shelf';
  if (state.routeView === 'note') return 'route-notes';
  return 'none';
}

/**
 * Restores focus to the previous invoker when a dialog closes ONLY if:
 * - the previous element is still connected in the DOM, and
 * - either no dialog remains open, OR the previous element lives inside the still-open topmost
 *   parent dialog (nested dialog close). Never steals focus from a newly opened sibling dialog.
 */
export function shouldRestoreFocusOnClose(opts: {
  previousElConnected: boolean;
  topmostOpenDialog: Pick<ElementLike, 'contains'> | null;
  previousEl: unknown;
}): boolean {
  if (!opts.previousElConnected || !opts.previousEl) return false;
  if (!opts.topmostOpenDialog) return true;
  return Boolean(opts.topmostOpenDialog.contains?.(opts.previousEl));
}
