/**
 * Pure service-worker update logic (no React / toast imports) so it is unit-testable in
 * node (R2#1). `swUpdate.ts` wires it to the real toast.
 */

/** ux_spec D.2 / H: optional new-version toast copy. */
export const NEW_VERSION_TOAST = 'A new version of Pragya is ready.';
export const NEW_VERSION_ACTION = 'Reload';
/** R1#6: a long-lived (hash-routed, never navigating) tab checks for a new worker at most this often. */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

type QueryRoot = Pick<Document, 'querySelector'>;

/** True while any modal dialog is open (the toast must not interrupt it). */
export function isDialogOpen(doc: QueryRoot): boolean {
  return Boolean(doc.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]'));
}

/**
 * A controller change is a *new version* only when this page was already controlled by
 * an older worker; the very first install (no previous controller) is not announced.
 */
export function isUpdateControllerChange(hadController: boolean, alreadyNotified: boolean): boolean {
  return hadController && !alreadyNotified;
}

export interface AnnounceDeps {
  isDialogOpen: () => boolean;
  notify: () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  retryMs?: number;
}

/** Show the toast once no dialog is open, re-checking every `retryMs` (default 2s). */
export function announceWhenIdle(deps: AnnounceDeps): void {
  if (deps.isDialogOpen()) {
    deps.setTimeout(() => announceWhenIdle(deps), deps.retryMs ?? 2000);
    return;
  }
  deps.notify();
}

export interface UpdateContainer {
  readonly controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

/**
 * Listen for a new service worker taking control of this page and call `announce` once.
 * The controller is tracked live: the first-ever install claims an uncontrolled page (not
 * an update), while a later swap in the same tab (old worker → new worker) is announced.
 */
export function watchControllerChanges(container: UpdateContainer, announce: () => void): void {
  let hadController = Boolean(container.controller);
  let notified = false;
  container.addEventListener('controllerchange', () => {
    const isUpdate = isUpdateControllerChange(hadController, notified);
    hadController = true;
    if (!isUpdate) return;
    notified = true;
    announce();
  });
}

/**
 * R1#6: returns a function that triggers `check` at most once per `intervalMs`. Call it on
 * `visibilitychange → visible`.
 */
export function createThrottledUpdateCheck(
  check: () => void,
  now: () => number,
  intervalMs = UPDATE_CHECK_INTERVAL_MS
): () => boolean {
  let last = now();
  return () => {
    const t = now();
    if (t - last < intervalMs) return false;
    last = t;
    check();
    return true;
  };
}
