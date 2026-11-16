/**
 * Offline cached read-only helpers (M4.5).
 */
export const OFFLINE_READONLY_MESSAGE =
  'Cloud sync is read-only while offline. Reconnect to save changes or try Demo Mode.';
export const OFFLINE_INFO_TOAST = 'Offline — viewing cached reading data';
export const STILL_OFFLINE_TOAST = 'Still offline — showing cached data';

export class OfflineReadOnlyError extends Error {
  readonly code = 'OFFLINE_READONLY';

  constructor(message: string = OFFLINE_READONLY_MESSAGE) {
    super(message);
    this.name = 'OfflineReadOnlyError';
  }
}

/**
 * True for transport-level failures (fetch rejected: DNS, offline, CORS abort),
 * false for HTTP responses (401/403/404/5xx surface as `API Error <status>` /
 * `401 Unauthorized`) and for auth errors, which must keep their existing paths.
 */
export function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/^API Error \d{3}/.test(msg) || msg.includes('401') || msg === 'Not authenticated') {
    return false;
  }
  if (err instanceof TypeError) return true;
  return /failed to fetch|networkerror|network request failed|load failed|internet disconnected|err_internet|offline/i.test(
    msg
  );
}

/** Whether a cloud write should be blocked right now. Demo Mode is always writable. */
export function shouldBlockCloudWrite(isMockMode: boolean, isOfflineReadOnly: boolean): boolean {
  return !isMockMode && isOfflineReadOnly;
}
