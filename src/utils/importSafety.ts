import type { PragyaSnapshot } from '../types/pragya';
import { ensureLocalStorage } from '../services/storage';

ensureLocalStorage();

/**
 * Write-before-clear snapshot import planning + pre-import local backup (M4.8).
 */
export const PRE_IMPORT_BACKUP_KEY = 'pragya_pre_import_backup_v1';

export interface ImportTabPlan {
  tab: 'Books' | 'Notes' | 'Sessions' | 'DeltaLogs';
  lastCol: string;
  /** Header row + data rows currently present in the sheet (from `A:A`). */
  oldRowCount: number;
  /** Header row + data rows that will exist after the write. */
  newRowCount: number;
}

/**
 * Returns the trailing stale-row ranges to clear AFTER the new rows were written.
 * Only tabs that shrink get a clear; ranges never touch rows 1..newRowCount.
 * e.g. Notes shrinking 10 → 3 data rows (11 → 4 total) clears `Notes!A5:R11`.
 */
export function planTrailingClearRanges(plans: ImportTabPlan[]): string[] {
  const ranges: string[] = [];
  for (const p of plans) {
    const oldCount = Math.max(0, Math.floor(p.oldRowCount));
    const newCount = Math.max(1, Math.floor(p.newRowCount));
    if (oldCount > newCount) {
      ranges.push(`${p.tab}!A${newCount + 1}:${p.lastCol}${oldCount}`);
    }
  }
  return ranges;
}

export interface PreImportBackup {
  savedAt: string;
  snapshot: PragyaSnapshot;
}

export function savePreImportBackup(snapshot: PragyaSnapshot, nowIso?: string): boolean {
  try {
    const payload: PreImportBackup = {
      savedAt: nowIso ?? new Date().toISOString(),
      snapshot,
    };
    localStorage.setItem(PRE_IMPORT_BACKUP_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function readPreImportBackup(): PreImportBackup | null {
  try {
    const raw = localStorage.getItem(PRE_IMPORT_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PreImportBackup>;
    if (!parsed || typeof parsed.savedAt !== 'string' || !parsed.snapshot) return null;
    const snap = parsed.snapshot as Partial<PragyaSnapshot>;
    if (
      snap.version !== 1 ||
      !Array.isArray(snap.books) ||
      !Array.isArray(snap.notes) ||
      !Array.isArray(snap.sessions) ||
      !Array.isArray(snap.deltaLogs)
    ) {
      return null;
    }
    return parsed as PreImportBackup;
  } catch {
    return null;
  }
}

export function clearPreImportBackup(): void {
  try {
    localStorage.removeItem(PRE_IMPORT_BACKUP_KEY);
  } catch {
    // Ignore
  }
}
