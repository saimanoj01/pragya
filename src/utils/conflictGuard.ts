/**
 * Lightweight pre-write row-level conflict guard (M4.9).
 *
 * Before overwriting an existing row we compare the remote row's timestamp with the
 * `updatedAt` this device loaded. If the remote row is strictly newer, another device
 * (or the pragya-companion CLI) wrote it after we loaded → abort instead of clobbering.
 */
import { isSheetSerialNumber, sheetSerialToMillis } from './sheetSerial';

export const CONFLICT_ERROR_MESSAGE = 'Updated on another device — run Sync Now before saving';
export const ROW_MOVED_ERROR_MESSAGE = 'Row moved — run Sync Now before saving';

export class RowConflictError extends Error {
  readonly code = 'ROW_CONFLICT';
  remoteUpdatedAt: string;
  expectedBaseUpdatedAt: string;

  constructor(remoteUpdatedAt: string, expectedBaseUpdatedAt: string) {
    super(CONFLICT_ERROR_MESSAGE);
    this.name = 'RowConflictError';
    this.remoteUpdatedAt = remoteUpdatedAt;
    this.expectedBaseUpdatedAt = expectedBaseUpdatedAt;
  }
}

export function isRowConflictError(err: unknown): err is RowConflictError {
  return (
    err instanceof RowConflictError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'ROW_CONFLICT')
  );
}

function toMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Sheets UNFORMATTED_VALUE may surface serial dates (days since 1899-12-30).
    if (isSheetSerialNumber(value)) {
      return sheetSerialToMillis(value);
    }
    return value;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True only when the remote timestamp is parseable AND strictly newer than the
 * expected base. Missing/unparseable values never block a write (fail-open keeps
 * legacy rows writable; the guard is a safety net, not a lock).
 */
export function isRemoteNewer(remoteUpdatedAt: unknown, expectedBaseUpdatedAt: unknown): boolean {
  const remote = toMillis(remoteUpdatedAt);
  const base = toMillis(expectedBaseUpdatedAt);
  if (remote === null || base === null) return false;
  return remote > base;
}

/** Extracts `updatedAt` from a Books!L `metaJson` cell. */
export function extractMetaUpdatedAt(metaJsonCell: unknown): string {
  if (typeof metaJsonCell !== 'string' || !metaJsonCell.trim()) return '';
  try {
    const parsed = JSON.parse(metaJsonCell) as { updatedAt?: unknown };
    return typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : '';
  } catch {
    return '';
  }
}

/**
 * B4.1: the conflict-guard base for a write. An explicit base (captured when a modal
 * opened, or the `updatedAt` an undo payload applied) always wins — even `""`, which
 * deliberately disables the guard — so a background sync that refreshed the loaded
 * entity can no longer silently move the base forward.
 */
export function resolveExpectedBase(
  explicit: string | undefined,
  loaded: string | undefined
): string | undefined {
  return explicit !== undefined ? explicit : loaded;
}

/** B4.3: the UUID was not at the resolved row (twice) — never write blind. */
export class RowMovedError extends Error {
  readonly code = 'ROW_MOVED';

  constructor(message: string = ROW_MOVED_ERROR_MESSAGE) {
    super(message);
    this.name = 'RowMovedError';
  }
}
