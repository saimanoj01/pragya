import {
  MEDIA_FOLDER_ID_STORAGE_KEY,
  SHEETS_CACHE_STORAGE_KEY,
  SPREADSHEET_ID_STORAGE_KEY,
} from '../services/googleSheetsAdapter';
import { adoptLegacyDrafts, clearAllDrafts, dropLegacyDrafts } from './draftStorage';
import { CAPSTONE_HIDDEN_KEY } from './capstonePrompt';
import { COLLISION_SKIP_KEY } from './crossBookSynthesis';
import { LAST_DELETE_BACKUP_KEY } from './deletePlan';
import { flushIdbQueue, idbClear, idbDelete } from './idbStore';
import { clearPreImportBackup } from './importSafety';
import { GOOGLE_SEALED_REFRESH_KEY } from './oauthProxy';

/** Persisted Google profile (also read by AuthContext). */
export const GOOGLE_USER_STORAGE_KEY = 'pragya_google_user';
/**
 * R1#1 (privacy): the last Google account that signed in on this device. Unlike the
 * profile key it survives token expiry / session-expired cleanup and is cleared only
 * by an explicit logout, so an account switch after an expired session is detected.
 */
export const LAST_ACCOUNT_EMAIL_KEY = 'pragya_last_account_email';

/** B4.11 / CD7: per-account local & IndexedDB artifacts that must never leak to another account. */
export function clearPerAccountLocalData(): void {
  void idbDelete(SHEETS_CACHE_STORAGE_KEY);
  localStorage.removeItem(MEDIA_FOLDER_ID_STORAGE_KEY);
  localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
  localStorage.removeItem(GOOGLE_SEALED_REFRESH_KEY);
  clearAllDrafts();
  clearPreImportBackup();
  // CD7: also clear the entire IndexedDB cache kv store so no per-account cache/backup lingers.
  void idbClear();
  // CD C1.2: the previous account's last-deleted rows never outlive an account switch.
  localStorage.removeItem(LAST_DELETE_BACKUP_KEY);
  // R1 nit: the per-device capstone Hide list belongs to the previous account's books.
  localStorage.removeItem(CAPSTONE_HIDDEN_KEY);
  // v2: per-day collision skip state belongs to the previous account's notes.
  localStorage.removeItem(COLLISION_SKIP_KEY);
  if (typeof caches !== 'undefined') {
    caches.delete('pragya-media-v1').catch(() => {});
  }
}

/** Async wrapper that awaits all queued IndexedDB deletions triggered by clearPerAccountLocalData. */
export async function clearPerAccountLocalDataAsync(): Promise<void> {
  clearPerAccountLocalData();
  await flushIdbQueue();
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
  // R2-b: email addresses are compared case-insensitively.
  const switched = Boolean(previous) && (previous || '').toLowerCase() !== next.toLowerCase();
  if (switched) clearPerAccountLocalData();
  // QA-29: `previous` is captured BEFORE the marker is rewritten. With no previous
  // account, legacy unscoped drafts belong to no one we can name (e.g. a pre-scoping Demo
  // session), so they are dropped instead of being adopted into this account. A matching
  // previous account keeps them for adoptLegacyDraftsForAccount().
  else if (!previous) dropLegacyDrafts();
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

/**
 * CD 1a fix-up (R1#1): legacy unscoped drafts are adopted into the scope of the real
 * account that owns them — only when `email` matches the last-account marker. Demo
 * never calls this, so it can never read another account's legacy drafts.
 */
export function adoptLegacyDraftsForAccount(email: string): number {
  const next = (email || '').trim();
  const marker = (localStorage.getItem(LAST_ACCOUNT_EMAIL_KEY) || '').trim();
  if (!next || !marker || marker.toLowerCase() !== next.toLowerCase()) return 0;
  return adoptLegacyDrafts(next);
}
