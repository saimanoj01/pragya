import {
  MEDIA_FOLDER_ID_STORAGE_KEY,
  SHEETS_CACHE_STORAGE_KEY,
  SPREADSHEET_ID_STORAGE_KEY,
} from '../services/googleSheetsAdapter';
import { clearAllDrafts } from './draftStorage';
import { clearPreImportBackup } from './importSafety';

/** Persisted Google profile (also read by AuthContext). */
export const GOOGLE_USER_STORAGE_KEY = 'pragya_google_user';
/**
 * R1#1 (privacy): the last Google account that signed in on this device. Unlike the
 * profile key it survives token expiry / session-expired cleanup and is cleared only
 * by an explicit logout, so an account switch after an expired session is detected.
 */
export const LAST_ACCOUNT_EMAIL_KEY = 'pragya_last_account_email';

/** B4.11: per-account local artifacts that must never leak to another account. */
export function clearPerAccountLocalData(): void {
  localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
  localStorage.removeItem(MEDIA_FOLDER_ID_STORAGE_KEY);
  localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
  clearAllDrafts();
  clearPreImportBackup();
  if (typeof caches !== 'undefined') {
    caches.delete('pragya-media-v1').catch(() => {});
  }
}

/** The previous account's email: the durable marker first, then the profile key. */
export function getPreviousAccountEmail(): string | null {
  const last = (localStorage.getItem(LAST_ACCOUNT_EMAIL_KEY) || '').trim();
  if (last) return last;
  const raw = localStorage.getItem(GOOGLE_USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    const email = (JSON.parse(raw) as { email?: unknown }).email;
    return typeof email === 'string' && email.trim() ? email.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Called after a successful sign-in. Clears the previous account's local data when the
 * email changed, then records the new email. Returns true when a switch was detected.
 */
export function applySignedInAccount(email: string): boolean {
  const next = (email || '').trim();
  if (!next) return false;
  const previous = getPreviousAccountEmail();
  const switched = Boolean(previous) && previous !== next;
  if (switched) clearPerAccountLocalData();
  localStorage.setItem(LAST_ACCOUNT_EMAIL_KEY, next);
  return switched;
}

/**
 * Upgrade path: devices signed in before this marker existed only have the profile key.
 * Copy its email into the durable marker before any expiry cleanup removes the profile.
 */
export function rememberCurrentAccount(): void {
  if ((localStorage.getItem(LAST_ACCOUNT_EMAIL_KEY) || '').trim()) return;
  const email = getPreviousAccountEmail();
  if (email) localStorage.setItem(LAST_ACCOUNT_EMAIL_KEY, email);
}

/** Explicit logout only. */
export function forgetLastAccount(): void {
  localStorage.removeItem(LAST_ACCOUNT_EMAIL_KEY);
}
