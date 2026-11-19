import type { Book, DeltaLog, Note, ReadingSession } from '../types/pragya';
import { RowConflictError, extractMetaUpdatedAt, isRemoteNewer } from './conflictGuard';
import { bookToRow, deltaLogToRow, noteToRow, sessionToRow } from './sheetCodecs';

/**
 * Pure, Node-testable planning & validation helpers for CD Batch 7 multi-tab batched
 * writes (`GoogleSheetsAdapter.batchCommitMutations` / `DemoStorageAdapter`).
 */

export type BatchTabName = 'Books' | 'Notes' | 'Sessions' | 'DeltaLogs';

/** Canonical parent-first write order: Books is always written before Sessions. */
export const BATCH_TAB_ORDER: readonly BatchTabName[] = [
  'Books',
  'Notes',
  'Sessions',
  'DeltaLogs',
];

export interface BatchTabMeta {
  lastCol: string;
  timestampCol: 'E' | 'L' | null;
}

export const BATCH_TAB_META: Readonly<Record<BatchTabName, BatchTabMeta>> = {
  Books: { lastCol: 'L', timestampCol: 'L' },
  Notes: { lastCol: 'R', timestampCol: 'E' },
  Sessions: { lastCol: 'G', timestampCol: null },
  DeltaLogs: { lastCol: 'E', timestampCol: null },
};

export type BatchMutationMode = 'update' | 'insert';

export type BatchMutationOp =
  | { kind: 'book'; book: Book; expectedBaseUpdatedAt?: string; mode?: BatchMutationMode }
  | { kind: 'note'; note: Note; expectedBaseUpdatedAt?: string; mode?: BatchMutationMode }
  | { kind: 'session'; session: ReadingSession; mode?: BatchMutationMode }
  | { kind: 'deltaLog'; deltaLog: DeltaLog; mode?: BatchMutationMode };

export interface BatchMutationResult {
  books: Book[];
  notes: Note[];
  sessions: ReadingSession[];
  deltaLogs: DeltaLog[];
}

/**
 * Thrown by `batchCommitMutations` when an earlier write in the batch (e.g. `values:batchUpdate`
 * or an earlier tab `:append`) succeeded on the server and a later `:append` failed.
 * Carries the exact rows already committed so callers can reconcile local state without
 * hitting phantom `RowConflictError`s or duplicating already-appended notes.
 */
export class PartialBatchCommitError extends Error {
  readonly code = 'PARTIAL_BATCH_COMMIT';
  readonly committed: BatchMutationResult;
  readonly cause: unknown;

  constructor(committed: BatchMutationResult, cause: unknown) {
    const msg =
      cause instanceof Error && cause.message
        ? cause.message
        : 'Batch write partially failed before all rows finished saving.';
    super(msg);
    this.name = 'PartialBatchCommitError';
    this.committed = committed;
    this.cause = cause;
  }
}

export interface NormalizedBatchOp {
  tab: BatchTabName;
  id: string;
  lastCol: string;
  timestampCol: 'E' | 'L' | null;
  expectedBaseUpdatedAt?: string;
  mode?: BatchMutationMode;
  rowValues: (string | number)[];
  op: BatchMutationOp;
}

/** Column letters → 0-based index (`A` → 0, `L` → 11, `AA` → 26). */
export function columnIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/**
 * Convert raw `BatchMutationOp[]` into canonical `BATCH_TAB_ORDER` (`Books` → `Notes` →
 * `Sessions` → `DeltaLogs`), deduplicating identical `(tab, id)` pairs (keeping the latest
 * payload and earliest non-empty conflict-guard base).
 */
export function normalizeBatchOps(ops: readonly BatchMutationOp[]): NormalizedBatchOp[] {
  const byKey = new Map<string, NormalizedBatchOp>();
  const keyOrder: string[] = [];

  for (const op of ops) {
    let normalized: NormalizedBatchOp;
    if (op.kind === 'book') {
      normalized = {
        tab: 'Books',
        id: op.book.id,
        lastCol: BATCH_TAB_META.Books.lastCol,
        timestampCol: BATCH_TAB_META.Books.timestampCol,
        expectedBaseUpdatedAt: op.expectedBaseUpdatedAt,
        mode: op.mode,
        rowValues: bookToRow(op.book),
        op,
      };
    } else if (op.kind === 'note') {
      normalized = {
        tab: 'Notes',
        id: op.note.id,
        lastCol: BATCH_TAB_META.Notes.lastCol,
        timestampCol: BATCH_TAB_META.Notes.timestampCol,
        expectedBaseUpdatedAt: op.expectedBaseUpdatedAt,
        mode: op.mode,
        rowValues: noteToRow(op.note),
        op,
      };
    } else if (op.kind === 'session') {
      normalized = {
        tab: 'Sessions',
        id: op.session.id,
        lastCol: BATCH_TAB_META.Sessions.lastCol,
        timestampCol: BATCH_TAB_META.Sessions.timestampCol,
        mode: op.mode,
        rowValues: sessionToRow(op.session),
        op,
      };
    } else {
      normalized = {
        tab: 'DeltaLogs',
        id: op.deltaLog.id,
        lastCol: BATCH_TAB_META.DeltaLogs.lastCol,
        timestampCol: BATCH_TAB_META.DeltaLogs.timestampCol,
        mode: op.mode,
        rowValues: deltaLogToRow(op.deltaLog),
        op,
      };
    }

    const key = `${normalized.tab}:${normalized.id}`;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...normalized,
        expectedBaseUpdatedAt: existing.expectedBaseUpdatedAt || normalized.expectedBaseUpdatedAt,
        mode: existing.mode === 'update' || normalized.mode === 'update' ? 'update' : normalized.mode ?? existing.mode,
      });
    } else {
      byKey.set(key, normalized);
      keyOrder.push(key);
    }
  }

  const ordered: NormalizedBatchOp[] = [];
  for (const tab of BATCH_TAB_ORDER) {
    for (const key of keyOrder) {
      const item = byKey.get(key);
      if (item && item.tab === tab) {
        ordered.push(item);
      }
    }
  }
  return ordered;
}

export interface PlannedPreReadOp {
  item: NormalizedBatchOp;
  /** 0-based hinted row index (>= 1), or null when no hint exists. */
  hintIndex: number | null;
  /** Exact targeted range queried for the hinted row, or null when unhinted. */
  hintRange: string | null;
}

export interface BatchPreReadPlan {
  ranges: string[];
  opPlans: PlannedPreReadOp[];
  /** Tabs whose full `A:A` column is requested in this batchGet. */
  colATabs: BatchTabName[];
}

/**
 * Plan the SINGLE coalesced `values:batchGet` pre-read for a batch of mutations.
 *
 * - Hinted rows query ONLY their targeted row (`Tab!A{r}:{ts}{r}` if guarded, `Tab!A{r}`
 *   if unguarded) to verify `A{r} === id` and fetch the live timestamp in minimal bytes.
 * - Unhinted rows (new appends or cold-cache updates) query `Tab!A:A` (+ `Tab!{ts}:{ts}`
 *   when guarded) in the exact same atomic `values:batchGet` snapshot.
 */
export function planBatchPreReadRanges(
  ops: readonly NormalizedBatchOp[],
  rowHints: ReadonlyMap<BatchTabName, ReadonlyMap<string, number>>
): BatchPreReadPlan {
  const ranges: string[] = [];
  const seenRanges = new Set<string>();
  const colATabs: BatchTabName[] = [];
  const seenColATabs = new Set<BatchTabName>();
  const opPlans: PlannedPreReadOp[] = [];

  const pushRange = (range: string) => {
    if (!seenRanges.has(range)) {
      seenRanges.add(range);
      ranges.push(range);
    }
  };

  for (const item of ops) {
    const hint = rowHints.get(item.tab)?.get(item.id);
    if (typeof hint === 'number' && Number.isInteger(hint) && hint >= 1) {
      const sheetRow = hint + 1;
      const hintRange =
        item.expectedBaseUpdatedAt && item.timestampCol
          ? `${item.tab}!A${sheetRow}:${item.timestampCol}${sheetRow}`
          : `${item.tab}!A${sheetRow}`;
      pushRange(hintRange);
      opPlans.push({ item, hintIndex: hint, hintRange });
    } else {
      pushRange(`${item.tab}!A:A`);
      if (!seenColATabs.has(item.tab)) {
        seenColATabs.add(item.tab);
        colATabs.push(item.tab);
      }
      if (item.expectedBaseUpdatedAt && item.timestampCol) {
        pushRange(`${item.tab}!${item.timestampCol}:${item.timestampCol}`);
      }
      opPlans.push({ item, hintIndex: null, hintRange: null });
    }
  }

  return { ranges, opPlans, colATabs };
}

interface ParsedRangeKey {
  tab: string;
  startCol: string;
  startRow: number | null;
  endCol: string | null;
  endRow: number | null;
}

function parseRangeKey(raw: string): ParsedRangeKey | null {
  const cleaned = raw.replace(/'/g, '').trim();
  const bangIdx = cleaned.indexOf('!');
  if (bangIdx < 1) return null;
  const tab = cleaned.slice(0, bangIdx);
  const a1 = cleaned.slice(bangIdx + 1);
  const m = /^([A-Za-z]+)(\d+)?(?::([A-Za-z]+)(\d+)?)?$/.exec(a1);
  if (!m) return { tab, startCol: '', startRow: null, endCol: null, endRow: null };
  return {
    tab,
    startCol: m[1].toUpperCase(),
    startRow: m[2] ? Number(m[2]) : null,
    endCol: m[3] ? m[3].toUpperCase() : null,
    endRow: m[4] ? Number(m[4]) : null,
  };
}

function isRangeCompatible(req: ParsedRangeKey | null, vr: ParsedRangeKey | null): boolean {
  if (!req || !vr) return false;
  if (req.tab !== vr.tab) return false;
  if (req.startCol && vr.startCol && req.startCol !== vr.startCol) return false;
  if (req.startRow !== null) {
    // Targeted row query (e.g. Books!A2:L2 or Sessions!A3)
    if (vr.startRow !== req.startRow) return false;
    if (req.endCol && vr.endCol && req.endCol !== vr.endCol) return false;
    return true;
  }
  // Whole-column query (e.g. Books!A:A or Books!L:L) — Sheets echoes Books!A1:A100
  if (vr.startRow !== null && vr.startRow !== 1) return false;
  if (req.endCol && vr.endCol && req.endCol !== vr.endCol) return false;
  return true;
}

/**
 * Match Google Sheets `values:batchGet` `valueRanges` back to the exact requested range
 * strings — safely handling multiple ranges on the SAME tab (e.g., `Books!A:A` + `Books!L:L`,
 * or `Books!A2:L2` + `Books!A5:L5`) and quoted sheet names echoed by Sheets (`'Books'!A1:A10`).
 */
export function matchBatchValueRanges(
  requestedRanges: readonly string[],
  valueRanges: ReadonlyArray<{ range?: string; values?: unknown[][] }>
): Map<string, unknown[][]> {
  const out = new Map<string, unknown[][]>();
  const usedIndices = new Set<number>();
  const sameLength = valueRanges.length === requestedRanges.length;

  requestedRanges.forEach((reqStr, idx) => {
    const reqParsed = parseRangeKey(reqStr);

    // 1. Positional match (Google Sheets API guarantees 1:1 order with requested ranges)
    if (sameLength && !usedIndices.has(idx)) {
      const candidate = valueRanges[idx];
      if (!candidate?.range || isRangeCompatible(reqParsed, parseRangeKey(candidate.range))) {
        usedIndices.add(idx);
        out.set(reqStr, candidate?.values || []);
        return;
      }
    }

    // 2. Semantic range match (handles out-of-order test mocks)
    const foundIdx = valueRanges.findIndex((vr, i) => {
      if (usedIndices.has(i) || !vr?.range) return false;
      return isRangeCompatible(reqParsed, parseRangeKey(vr.range));
    });
    if (foundIdx >= 0) {
      usedIndices.add(foundIdx);
      out.set(reqStr, valueRanges[foundIdx]?.values || []);
      return;
    }

    // 3. Fallback to positional slot if present
    out.set(reqStr, valueRanges[idx]?.values || []);
  });

  return out;
}

/** Locate a data row's 0-based index (`>= 1`) in a tab's `A:A` column (skipping header row 0). */
export function findRowIndexInColA(colA: readonly unknown[][], id: string): number {
  for (let i = 1; i < colA.length; i += 1) {
    const cell = String(colA[i]?.[0] ?? '').trim();
    if (cell === id && cell !== 'id') return i;
  }
  return -1;
}

/** Extract a 0-based row hint from a single-row Sheets `:append` `updatedRange` (e.g. `Sessions!A5:G5` → 4). */
export function parseAppendedRowIndex(updatedRange: string | undefined): number | null {
  if (!updatedRange) return null;
  const parsed = parseRangeKey(updatedRange);
  if (!parsed || parsed.startRow === null || parsed.startRow < 2) return null;
  if (parsed.endRow !== null && parsed.endRow !== parsed.startRow) return null;
  return parsed.startRow - 1;
}

/** Throw `RowConflictError` when the remote timestamp cell is strictly newer than the expected base. */
export function validateGuardTimestamp(
  timestampCol: 'E' | 'L',
  rawCell: unknown,
  expectedBaseUpdatedAt: string
): void {
  const remoteUpdatedAt = timestampCol === 'L' ? extractMetaUpdatedAt(rawCell) : rawCell;
  if (isRemoteNewer(remoteUpdatedAt, expectedBaseUpdatedAt)) {
    throw new RowConflictError(String(remoteUpdatedAt), expectedBaseUpdatedAt);
  }
}
