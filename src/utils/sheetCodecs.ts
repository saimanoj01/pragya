import type {
  Book,
  BookKind,
  BookStatus,
  DeltaLog,
  DeltaOutcome,
  DeltaStatus,
  Note,
  NoteStatus,
  PosUnit,
  ReadingSession,
} from '../types/pragya';
import { normalizeDeltaAction, normalizeDeltaTrigger } from './deltaFormat';
import {
  normalizeBookFormat,
  normalizeBookMeta,
  normalizeNoteMeta,
  normalizeNoteSource,
} from './metaCodecs';
import { computeNormalizedPos } from './spoilerMath';

export const BOOKS_HEADERS = [
  'id',
  'title',
  'author',
  'format',
  'kind',
  'status',
  'currentPos',
  'totalPos',
  'posUnit',
  'normalizedPos',
  'docUrl',
  'metaJson',
] as const;

export const NOTES_HEADERS = [
  'id',
  'slug',
  'bookId',
  'createdAt',
  'updatedAt',
  'pos',
  'normalizedPos',
  'status',
  'source',
  'tags',
  'quote',
  'takeaway',
  'contextMechanism',
  'critique',
  'deltaTrigger',
  'deltaAction',
  'deltaStatus',
  'metaJson',
] as const;

export const SESSIONS_HEADERS = [
  'id',
  'bookId',
  'date',
  'startPos',
  'endPos',
  'updatedAt',
  'note',
] as const;

export const DELTA_LOGS_HEADERS = [
  'id',
  'noteId',
  'date',
  'outcome',
  'reflection',
] as const;

export function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function parseTagsCsv(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return normalizeTagList(raw.map(item => String(item ?? '')));
  }
  if (typeof raw !== 'string') return [];
  return normalizeTagList(raw.split(','));
}

export function normalizeTagList(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokens) {
    const trimmed = raw.trim().replace(/^#+/, '').trim();
    if (!trimmed) continue;
    const normalized = `#${trimmed.toLowerCase().replace(/\s+/g, '-')}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export function serializeTagsCsv(tags: string[]): string {
  return normalizeTagList(tags).join(', ');
}

function asString(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val);
}

function asNumber(val: unknown, fallback = 0): number {
  if (typeof val === 'number') return Number.isFinite(val) ? val : fallback;
  const parsed = Number(val);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Exclusive upper bound for Sheets serial dates (10000-01-01). Mirrors conflictGuard.ts. */
const SHEET_SERIAL_MAX = 2_958_466;
const SHEET_SERIAL_STRING_RE = /^\d{5}(\.\d+)?$/;
const SHEET_SERIAL_UNIX_EPOCH = 25569; // 1970-01-01 as days since 1899-12-30
const MS_PER_DAY = 86_400_000;

function toSheetSerial(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v > 0 && v < SHEET_SERIAL_MAX ? v : null;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!SHEET_SERIAL_STRING_RE.test(trimmed)) return null;
    const n = Number(trimmed);
    return n > 0 && n < SHEET_SERIAL_MAX ? n : null;
  }
  return null;
}

/**
 * Decodes a Sheets serial date (days since 1899-12-30, as surfaced by
 * UNFORMATTED_VALUE after a USER_ENTERED write) into a UTC `YYYY-MM-DD`.
 * Anything else is returned as a trimmed string. Parity: `decode_sheet_date`.
 */
export function decodeSheetDate(v: unknown): string {
  const serial = toSheetSerial(v);
  if (serial === null) return asString(v).trim();
  const ms = (Math.floor(serial) - SHEET_SERIAL_UNIX_EPOCH) * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Same as {@link decodeSheetDate} for timestamp columns: a serial becomes a full
 * ISO-8601 UTC string (same math as conflictGuard.ts). Parity: `decode_sheet_timestamp`.
 */
export function decodeSheetTimestamp(v: unknown): string {
  const serial = toSheetSerial(v);
  if (serial === null) return asString(v).trim();
  const ms = Math.round((serial - SHEET_SERIAL_UNIX_EPOCH) * MS_PER_DAY);
  return new Date(ms).toISOString();
}

const VALID_KINDS: BookKind[] = ['nonfiction', 'fiction'];
const VALID_BOOK_STATUSES: BookStatus[] = ['reading', 'queued', 'finished', 'paused'];
const VALID_POS_UNITS: PosUnit[] = ['page', 'percent', 'loc'];
const VALID_NOTE_STATUSES: NoteStatus[] = ['saved', 'inbox', 'in-reflection', 'atomic'];
const VALID_DELTA_STATUSES: DeltaStatus[] = ['none', 'active', 'graduated', 'paused'];
const VALID_DELTA_OUTCOMES: DeltaOutcome[] = ['applied', 'missed', 'no-trigger'];

export function bookToRow(book: Book): (string | number)[] {
  return [
    book.id,
    book.title,
    book.author,
    book.format,
    book.kind,
    book.status,
    book.currentPos,
    book.totalPos,
    book.posUnit,
    Number(book.normalizedPos.toFixed(6)),
    book.docUrl || '',
    JSON.stringify(
      book.meta != null ? normalizeBookMeta(book.meta) : { updatedAt: new Date().toISOString() }
    ),
  ];
}

export function rowToBook(row: unknown[]): Book | null {
  if (!Array.isArray(row)) return null;
  const id = asString(row[0]).trim();
  if (!id || id === 'id') return null;

  const kindRaw = asString(row[4]).trim() as BookKind;
  const statusRaw = asString(row[5]).trim() as BookStatus;
  const posUnitRaw = asString(row[8]).trim() as PosUnit;

  const format = normalizeBookFormat(row[3]);
  const kind: BookKind = VALID_KINDS.includes(kindRaw) ? kindRaw : 'nonfiction';
  const status: BookStatus = VALID_BOOK_STATUSES.includes(statusRaw) ? statusRaw : 'reading';
  const posUnit: PosUnit = VALID_POS_UNITS.includes(posUnitRaw) ? posUnitRaw : 'page';

  const currentPos = asNumber(row[6], 0);
  const totalPos = asNumber(row[7], 0);
  const normalizedRaw = row[9] !== undefined && row[9] !== '' ? asNumber(row[9], NaN) : NaN;
  const normalizedPos = Number.isFinite(normalizedRaw)
    ? Math.min(1, Math.max(0, normalizedRaw))
    : status === 'finished'
      ? 1
      : computeNormalizedPos(currentPos, totalPos, posUnit);

  // Unknown keys pass through; missing updatedAt reads as '' (conflict guards fail open).
  const meta = normalizeBookMeta(row[11]);

  return {
    id,
    title: asString(row[1]),
    author: asString(row[2]),
    format,
    kind,
    status,
    currentPos,
    totalPos,
    posUnit,
    normalizedPos,
    docUrl: asString(row[10]),
    meta,
  };
}

export function noteToRow(note: Note): (string | number)[] {
  const trigger = normalizeDeltaTrigger(note.deltaTrigger);
  const action = normalizeDeltaAction(note.deltaAction);
  // Canonical write: unknown keys kept, legacy q1/q2 dropped, attachments stored verbatim.
  const meta = normalizeNoteMeta(note.meta);
  return [
    note.id,
    note.slug,
    note.bookId,
    note.createdAt,
    note.updatedAt,
    note.pos,
    Number(note.normalizedPos.toFixed(6)),
    note.status,
    note.source,
    serializeTagsCsv(note.tags || []),
    note.quote || '',
    note.takeaway || '',
    note.contextMechanism || '',
    note.critique || '',
    trigger,
    action,
    note.deltaStatus,
    JSON.stringify(meta),
  ];
}

export function rowToNote(row: unknown[]): Note | null {
  if (!Array.isArray(row)) return null;
  const id = asString(row[0]).trim();
  if (!id || id === 'id') return null;

  const statusRaw = asString(row[7]).trim() as NoteStatus;
  const deltaStatusRaw = asString(row[16]).trim() as DeltaStatus;

  const status: NoteStatus = VALID_NOTE_STATUSES.includes(statusRaw) ? statusRaw : 'saved';
  const source = normalizeNoteSource(row[8]);
  const deltaStatus: DeltaStatus = VALID_DELTA_STATUSES.includes(deltaStatusRaw)
    ? deltaStatusRaw
    : 'none';

  const pos = asNumber(row[5], 0);
  const normalizedPos = Math.min(1, Math.max(0, asNumber(row[6], 0)));
  // Unknown keys pass through; legacy q1/q2 → socraticQuestions (1–3 kept).
  const meta = normalizeNoteMeta(row[17]);

  return {
    id,
    slug: asString(row[1]).trim() || id,
    bookId: asString(row[2]).trim(),
    createdAt: decodeSheetTimestamp(row[3]),
    updatedAt: decodeSheetTimestamp(row[4]),
    pos,
    normalizedPos,
    status,
    source,
    tags: parseTagsCsv(row[9]),
    quote: asString(row[10]),
    takeaway: asString(row[11]),
    contextMechanism: asString(row[12]),
    critique: asString(row[13]),
    deltaTrigger: normalizeDeltaTrigger(asString(row[14])),
    deltaAction: normalizeDeltaAction(asString(row[15])),
    deltaStatus,
    meta,
  };
}

export function sessionToRow(session: ReadingSession): (string | number)[] {
  return [
    session.id,
    session.bookId,
    session.date,
    session.startPos,
    session.endPos,
    session.updatedAt,
    session.note || '',
  ];
}

export function rowToSession(row: unknown[]): ReadingSession | null {
  if (!Array.isArray(row)) return null;
  const id = asString(row[0]).trim();
  if (!id || id === 'id') return null;
  return {
    id,
    bookId: asString(row[1]).trim(),
    date: decodeSheetDate(row[2]),
    startPos: asNumber(row[3], 0),
    endPos: asNumber(row[4], 0),
    updatedAt: decodeSheetTimestamp(row[5]),
    note: asString(row[6]),
  };
}

export function deltaLogToRow(log: DeltaLog): (string | number)[] {
  return [log.id, log.noteId, log.date, log.outcome, log.reflection || ''];
}

export function rowToDeltaLog(row: unknown[]): DeltaLog | null {
  if (!Array.isArray(row)) return null;
  const id = asString(row[0]).trim();
  if (!id || id === 'id') return null;
  const outcomeRaw = asString(row[3]).trim() as DeltaOutcome;
  const outcome: DeltaOutcome = VALID_DELTA_OUTCOMES.includes(outcomeRaw)
    ? outcomeRaw
    : 'no-trigger';
  return {
    id,
    noteId: asString(row[1]).trim(),
    date: decodeSheetDate(row[2]),
    outcome,
    reflection: asString(row[4]),
  };
}
