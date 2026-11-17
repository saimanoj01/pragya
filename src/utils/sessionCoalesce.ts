import type { Book, ReadingSession } from '../types/pragya';
import { clamp01, computeNormalizedPos } from './spoilerMath';

export const COALESCE_WINDOW_MS = 30 * 60 * 1000;

export function createUuid(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getLocalDateString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface BookmarkAdvanceOptions {
  manualOverride?: boolean;
  nowIso?: string;
}

export interface BookmarkAdvanceResult {
  updatedBook: Book;
  prevPos: number;
  nextPos: number;
  changed: boolean;
  rejectedBackward: boolean;
}

export function applyBookmarkAdvance(
  book: Book,
  incomingPos: number,
  options: BookmarkAdvanceOptions = {}
): BookmarkAdvanceResult {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const safeIncoming = Number.isFinite(incomingPos) ? Math.max(0, incomingPos) : book.currentPos;
  const prevPos = book.currentPos;

  if (!options.manualOverride && safeIncoming < prevPos) {
    return {
      updatedBook: book,
      prevPos,
      nextPos: prevPos,
      changed: false,
      rejectedBackward: true,
    };
  }

  let nextPos: number;
  let nextNorm: number;
  const maxPos =
    book.totalPos > 0 ? book.totalPos : book.posUnit === 'percent' ? 100 : Number.POSITIVE_INFINITY;

  if (options.manualOverride) {
    nextPos = Number.isFinite(maxPos) ? Math.min(safeIncoming, maxPos) : safeIncoming;
    nextNorm = computeNormalizedPos(nextPos, book.totalPos, book.posUnit);
  } else {
    const monotonic = Math.max(prevPos, safeIncoming);
    nextPos = Number.isFinite(maxPos) ? Math.min(monotonic, maxPos) : monotonic;
    const computed =
      book.totalPos > 0
        ? clamp01(nextPos / book.totalPos)
        : computeNormalizedPos(nextPos, book.totalPos, book.posUnit);
    nextNorm = Math.max(book.normalizedPos, computed);
  }

  const changed = nextPos !== prevPos || nextNorm !== book.normalizedPos;
  if (!changed) {
    return {
      updatedBook: book,
      prevPos,
      nextPos,
      changed: false,
      rejectedBackward: false,
    };
  }

  const updatedBook: Book = {
    ...book,
    // Parity with pragya_cli.py: advancing a queued or paused book resumes reading.
    status: book.status === 'queued' || book.status === 'paused' ? 'reading' : book.status,
    currentPos: nextPos,
    normalizedPos: nextNorm,
    meta: {
      ...book.meta,
      startedAt: book.meta.startedAt || nowIso,
      updatedAt: nowIso,
    },
  };

  return {
    updatedBook,
    prevPos,
    nextPos,
    changed: true,
    rejectedBackward: false,
  };
}

export interface UpsertSessionParams {
  bookId: string;
  prevPos: number;
  nextPos: number;
  nowIso?: string;
  date?: string;
  note?: string;
  manualOverride?: boolean;
  generateId?: () => string;
}

export interface UpsertSessionResult {
  sessions: ReadingSession[];
  upserted: ReadingSession;
  isNew: boolean;
}

export function upsertCoalescedSession(
  sessions: ReadingSession[],
  params: UpsertSessionParams
): UpsertSessionResult {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const parsedNowMs = Date.parse(nowIso);
  const nowMs = Number.isFinite(parsedNowMs) ? parsedNowMs : Date.now();
  const today = params.date ?? getLocalDateString(new Date(nowMs));

  let candidate: ReadingSession | null = null;
  let candidateUpdatedMs = -Infinity;

  for (const s of sessions) {
    if (s.bookId !== params.bookId || s.date !== today) continue;
    const sUpdatedMs = Date.parse(s.updatedAt);
    if (!Number.isFinite(sUpdatedMs)) continue;
    const diff = nowMs - sUpdatedMs;
    if (diff >= -60_000 && diff <= COALESCE_WINDOW_MS && sUpdatedMs >= candidateUpdatedMs) {
      candidate = s;
      candidateUpdatedMs = sUpdatedMs;
    }
  }

  if (candidate) {
    const endPos = params.manualOverride
      ? params.nextPos
      : Math.max(candidate.endPos, params.nextPos);
    const updated: ReadingSession = {
      ...candidate,
      endPos,
      updatedAt: nowIso,
      note: params.note !== undefined && params.note !== '' ? params.note : candidate.note,
    };
    return {
      sessions: sessions.map(s => (s.id === candidate!.id ? updated : s)),
      upserted: updated,
      isNew: false,
    };
  }

  const idGen = params.generateId ?? createUuid;
  const created: ReadingSession = {
    id: idGen(),
    bookId: params.bookId,
    date: today,
    startPos: params.prevPos,
    endPos: params.nextPos,
    updatedAt: nowIso,
    note: params.note ?? '',
  };

  return {
    sessions: [...sessions, created],
    upserted: created,
    isNew: true,
  };
}
