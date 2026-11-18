import type { Book, DeltaLog, Note, ReadingSession } from '../types/pragya';
import { buildSnapshot } from './snapshot';

/**
 * "Download a backup first" (ux_spec_cd §0.1): saves the current workspace as the same
 * JSON snapshot Settings → Export produces. No navigation; the caller's dialog stays open.
 */
export function downloadWorkspaceSnapshot(rows: {
  books: Book[];
  notes: Note[];
  sessions: ReadingSession[];
  deltaLogs: DeltaLog[];
}): void {
  const snapshot = buildSnapshot(rows);
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pragya-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
