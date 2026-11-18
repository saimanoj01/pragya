import type { DeltaLog, DeltaOutcome } from '../types/pragya';
import { toLocalDateKey } from './takeawayShuffle';

/**
 * CD C2.1 (ux_spec_cd C.2.4, decisions OQ-5): delta check-ins coalesce per note per local
 * day. The first check-in of the day appends a DeltaLogs row; a later check-in the same
 * day UPDATES that row's outcome (reflection kept); pressing the outcome that's already
 * logged does nothing. Python mirror: `plan_delta_checkin` in scripts/pragya_cli.py.
 * Pure + erasable TS so Node tests can import it.
 */

export type DeltaCheckInPlan =
  | { kind: 'append'; log: DeltaLog }
  | { kind: 'update'; log: DeltaLog; previous: DeltaLog }
  | { kind: 'unchanged'; log: DeltaLog };

export const DELTA_OUTCOME_LABELS: Record<DeltaOutcome, string> = {
  applied: 'Applied',
  missed: 'Missed trigger',
  'no-trigger': "Didn't come up",
};

export const DELTA_REFLECTION_PLACEHOLDERS: Record<DeltaOutcome, string> = {
  applied: 'What made it work? (optional)',
  missed: 'What got in the way? (optional)',
  'no-trigger': 'Anything worth noting? (optional)',
};

export const DELTA_HISTORY_LIMIT = 10;

/** R1#4: the LOCAL day of a stored date (C5.1 `toLocalDateKey`; Python `to_local_date_key`). */
function dateKey(value: unknown): string {
  return toLocalDateKey(value) || '';
}

/** Today's log for this note (the LAST one if legacy duplicates exist), or null. */
export function todaysDeltaLog(logs: DeltaLog[], noteId: string, today: string): DeltaLog | null {
  let found: DeltaLog | null = null;
  for (const log of logs) {
    if (log.noteId === noteId && dateKey(log.date) === today) found = log;
  }
  return found;
}

export function planDeltaCheckIn(
  logs: DeltaLog[],
  noteId: string,
  today: string,
  outcome: DeltaOutcome,
  newId: string
): DeltaCheckInPlan {
  const existing = todaysDeltaLog(logs, noteId, today);
  if (!existing) {
    return { kind: 'append', log: { id: newId, noteId, date: today, outcome, reflection: '' } };
  }
  if (existing.outcome === outcome) return { kind: 'unchanged', log: existing };
  return { kind: 'update', log: { ...existing, outcome }, previous: existing };
}

/** ux_spec_cd H: `Logged: Applied.` / `Updated today's check-in to Applied.` (null = no toast). */
export function checkInToastMessage(plan: DeltaCheckInPlan): string | null {
  const label = DELTA_OUTCOME_LABELS[plan.log.outcome];
  if (plan.kind === 'append') return `Logged: ${label}.`;
  if (plan.kind === 'update') return `Updated today's check-in to ${label}.`;
  return null;
}

/** Last `n` logs of a note, newest first (date desc; same date → later row first). */
/**
 * R1#2: field-level change against the FRESH row (re-read inside the write queue): only
 * the edited field moves, so another writer's outcome/reflection is never reverted.
 */
export function applyDeltaLogPatch(
  fresh: DeltaLog,
  patch: { outcome?: DeltaOutcome; reflection?: string }
): DeltaLog {
  return {
    ...fresh,
    ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
    ...(patch.reflection !== undefined ? { reflection: patch.reflection.trim() } : {}),
  };
}

/** `History (3) · 2 applied · 1 missed` (counts only — never a rate; R2 nit, calm retention). */
export function deltaHistorySummary(logs: DeltaLog[], noteId: string): string {
  let total = 0;
  let applied = 0;
  let missed = 0;
  for (const log of logs) {
    if (log.noteId !== noteId) continue;
    total += 1;
    if (log.outcome === 'applied') applied += 1;
    else if (log.outcome === 'missed') missed += 1;
  }
  return `History (${total}) · ${applied} applied · ${missed} missed`;
}

export function recentDeltaHistory(logs: DeltaLog[], noteId: string, n = DELTA_HISTORY_LIMIT): DeltaLog[] {
  return logs
    .map((log, idx) => ({ log, idx }))
    .filter(x => x.log.noteId === noteId)
    .sort((a, b) => {
      const da = dateKey(a.log.date);
      const db = dateKey(b.log.date);
      if (da !== db) return da < db ? 1 : -1;
      return b.idx - a.idx;
    })
    .slice(0, Math.max(0, n))
    .map(x => x.log);
}
