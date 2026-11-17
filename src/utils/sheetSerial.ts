/**
 * Google Sheets serial-date math (days since 1899-12-30), shared by the row codecs
 * (sheetCodecs.ts) and the pre-write conflict guard (conflictGuard.ts).
 * Parity: `_to_sheet_serial` / `decode_sheet_*` / `_to_epoch_ms` in scripts/pragya_cli.py.
 */

/** Exclusive upper bound for Sheets serial dates (10000-01-01). */
export const SHEET_SERIAL_MAX = 2_958_466;
/** 1970-01-01 as days since 1899-12-30. */
export const SHEET_SERIAL_UNIX_EPOCH = 25569;
export const MS_PER_DAY = 86_400_000;
/** ASCII-only five-digit serial (optionally fractional) in a string cell. */
export const SHEET_SERIAL_STRING_RE = /^[0-9]{5}(\.[0-9]+)?$/;

/** True for a finite number inside the Sheets serial range (0, SHEET_SERIAL_MAX). */
export function isSheetSerialNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < SHEET_SERIAL_MAX;
}

/** Numeric cell or five-digit string → serial; anything else → null. */
export function toSheetSerial(v: unknown): number | null {
  if (typeof v === 'number') return isSheetSerialNumber(v) ? v : null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!SHEET_SERIAL_STRING_RE.test(trimmed)) return null;
    const n = Number(trimmed);
    return isSheetSerialNumber(n) ? n : null;
  }
  return null;
}

/** Serial (possibly fractional) → epoch milliseconds, rounded half-up like Math.round. */
export function sheetSerialToMillis(serial: number): number {
  return Math.round((serial - SHEET_SERIAL_UNIX_EPOCH) * MS_PER_DAY);
}

/** Serial → UTC calendar day (fraction dropped) in epoch milliseconds. */
export function sheetSerialToUtcDayMillis(serial: number): number {
  return (Math.floor(serial) - SHEET_SERIAL_UNIX_EPOCH) * MS_PER_DAY;
}
