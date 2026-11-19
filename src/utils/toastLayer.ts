/**
 * CD Batch 6 (D2.4 + QA-44 / R1#1 / R2-3): Imperative Top-Layer Popover host for Sonner `<Toaster>`.
 *
 * Per the HTML Living Standard, while a modal `<dialog>` is open via `.showModal()`, every DOM
 * node outside that `<dialog>` subtree is marked `inert` — even a sibling `popover="manual"` in
 * the Top Layer. Hosting `<Toaster>` via `createPortal` inside a single persistent imperative
 * `<div data-testid="toast-layer" popover="manual">` and reparenting it into
 * `getTopmostOpenDialog(document) ?? document.body` (then calling `showPopover()`) ensures toasts
 * are simultaneously:
 * - visually above `<dialog>::backdrop` in the Top Layer,
 * - non-inert (Undo / click-to-dismiss buttons genuinely work; `role="alert"` stays in the AX tree),
 * - immune to click-through dismissal on `closedby="any"` dialogs, and
 * - rescued safely back to the next open dialog or `document.body` before a closing `<dialog>` unmounts.
 */

import { getTopmostOpenDialog, type QuerySelectorAllRoot } from './dialogOverlay';

export interface ToastHostParentLike {
  appendChild(child: never): unknown;
}

export interface PopoverHostLike {
  parentNode?: unknown;
  isConnected?: boolean;
  contains?(node: never): boolean;
  showPopover?: () => void;
  hidePopover?: () => void;
  matches?: (selector: string) => boolean;
}

export interface ToastLayerDocumentLike extends QuerySelectorAllRoot {
  body: ToastHostParentLike | null;
}

let toastHostEl: PopoverHostLike | null = null;

export function registerToastLayerHost(el: PopoverHostLike | null): void {
  toastHostEl = el;
}

export function getToastLayerHost(): PopoverHostLike | null {
  return toastHostEl;
}

/** True when `target` is the toast-layer host itself or a descendant inside it. */
export function isInsideToastLayer(
  target: unknown,
  host: PopoverHostLike | null = toastHostEl
): boolean {
  if (!host || !target) return false;
  if (target === host) return true;
  if (typeof host.contains !== 'function') return false;
  try {
    return (host.contains as (node: unknown) => boolean)(target);
  } catch {
    return false;
  }
}

/**
 * Resolves the non-inert DOM parent for the persistent `toast-layer` host:
 * the topmost open `<dialog>` (excluding any currently closing dialog), else `doc.body`.
 */
export function resolveToastLayerParent(
  doc: ToastLayerDocumentLike | null | undefined,
  excludeDialog?: unknown
): ToastHostParentLike | null {
  if (!doc) return null;
  const top = getTopmostOpenDialog(doc, excludeDialog);
  if (top && typeof (top as unknown as ToastHostParentLike).appendChild === 'function') {
    return top as unknown as ToastHostParentLike;
  }
  return doc.body;
}

function defaultDoc(): ToastLayerDocumentLike | null {
  return typeof document !== 'undefined'
    ? (document as unknown as ToastLayerDocumentLike)
    : null;
}

function reparentHost(targetParent: ToastHostParentLike, host: PopoverHostLike): boolean {
  try {
    (targetParent.appendChild as (child: PopoverHostLike) => unknown)(host);
    return true;
  } catch {
    return false;
  }
}

function openPopoverOnTop(host: PopoverHostLike): boolean {
  if (typeof host.showPopover !== 'function') return false;
  try {
    if (
      typeof host.hidePopover === 'function' &&
      typeof host.matches === 'function' &&
      host.matches(':popover-open')
    ) {
      host.hidePopover();
    }
    host.showPopover();
    return true;
  } catch {
    return false;
  }
}

/**
 * Reparents the registered toast host into `getTopmostOpenDialog(doc, excludeDialog) ?? doc.body`
 * and re-opens its `popover="manual"` on top of the browser Top Layer (reparenting an open popover
 * automatically hides it per HTML spec, so `showPopover()` is always re-invoked afterward).
 */
export function syncToastLayerContainer(
  doc: ToastLayerDocumentLike | null | undefined = defaultDoc(),
  host: PopoverHostLike | null = toastHostEl,
  excludeDialog?: unknown
): boolean {
  if (!host) return false;
  const targetParent = resolveToastLayerParent(doc, excludeDialog);
  if (targetParent && host.parentNode !== targetParent) {
    if (!reparentHost(targetParent, host)) return false;
  }
  return openPopoverOnTop(host);
}

/**
 * Ensures the registered toast host is parented inside the topmost open dialog (or `document.body`)
 * and promotes it to the top of the browser Top Layer.
 * Returns `true` when promoted via the Popover API, or `false` when unsupported / unavailable
 * (in which case CSS `position: fixed; z-index: 9999` acts as the fallback).
 */
export function promoteToastLayer(
  host: PopoverHostLike | null = toastHostEl,
  doc: ToastLayerDocumentLike | null | undefined = defaultDoc()
): boolean {
  if (!host) return false;
  if (doc) {
    const targetParent = resolveToastLayerParent(doc);
    if (targetParent && host.parentNode !== targetParent) {
      if (!reparentHost(targetParent, host)) return false;
    }
  }
  return openPopoverOnTop(host);
}
