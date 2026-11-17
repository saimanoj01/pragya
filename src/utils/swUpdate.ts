import { showToast } from './toast';
import {
  NEW_VERSION_ACTION,
  NEW_VERSION_TOAST,
  announceWhenIdle,
  createThrottledUpdateCheck,
  isDialogOpen,
  watchControllerChanges,
} from './swUpdateCore';

export { NEW_VERSION_ACTION, NEW_VERSION_TOAST };

function showNewVersionToast(): void {
  showToast(NEW_VERSION_TOAST, 'info', {
    id: 'sw-update',
    duration: Infinity,
    action: {
      label: NEW_VERSION_ACTION,
      testId: 'sw-update-reload-btn',
      onClick: () => window.location.reload(),
    },
  });
}

/**
 * Stale-bundle reload path (Batch 1 R1#5): a tab running an old bundle keeps its old
 * code until reloaded, so offer a Reload once a new worker takes control — deferred while
 * a dialog is open.
 */
export function announceNewVersionWhenIdle(retryMs = 2000): void {
  announceWhenIdle({
    isDialogOpen: () => isDialogOpen(document),
    notify: showNewVersionToast,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    retryMs,
  });
}

/** Listen for a new service worker taking control of this page. */
export function watchServiceWorkerUpdates(container: ServiceWorkerContainer): void {
  watchControllerChanges(container, () => announceNewVersionWhenIdle());

  // R1#6: a hash-routed tab never navigates, so ask for an update when it becomes
  // visible again (throttled to every 30 min).
  const checkForUpdate = createThrottledUpdateCheck(
    () => {
      container
        .getRegistration()
        .then(reg => reg?.update())
        .catch(() => {});
    },
    () => Date.now()
  );
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
}
