import type {
  Book,
  BookFormat,
  BookKind,
  BookStatus,
  DeltaLog,
  DeltaOutcome,
  DeltaStatus,
  Note,
  NoteStatus,
  PosUnit,
  PragyaSnapshot,
  ReadingSession,
} from '../types/pragya';
import { normalizeDeltaAction, normalizeDeltaTrigger } from './deltaFormat';
import { computeNormalizedPos } from './spoilerMath';

const BOOK_FORMATS: BookFormat[] = ['physical', 'kindle'];
const BOOK_KINDS: BookKind[] = ['nonfiction', 'fiction'];
const BOOK_STATUSES: BookStatus[] = ['reading', 'queued', 'finished', 'paused'];
const POS_UNITS: PosUnit[] = ['page', 'percent', 'loc'];
const NOTE_STATUSES: NoteStatus[] = ['saved', 'inbox', 'in-reflection', 'atomic'];
const DELTA_STATUSES: DeltaStatus[] = ['none', 'active', 'graduated', 'paused'];
const DELTA_OUTCOMES: DeltaOutcome[] = ['applied', 'missed', 'no-trigger'];

export function buildSnapshot(data: {
  books: Book[];
  notes: Note[];
  sessions: ReadingSession[];
  deltaLogs: DeltaLog[];
}): PragyaSnapshot {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    books: data.books,
    notes: data.notes,
    sessions: data.sessions,
    deltaLogs: data.deltaLogs,
  };
}

export type ValidateSnapshotResult =
  | {
      ok: true;
      snapshot: PragyaSnapshot;
      counts: {
        books: number;
        notes: number;
        sessions: number;
        deltaLogs: number;
      };
    }
  | {
      ok: false;
      error: string;
    };

export function validateSnapshotPayload(input: unknown): ValidateSnapshotResult {
  let parsed = input;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { ok: false, error: 'Invalid JSON syntax.' };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Snapshot must be a JSON object.' };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    return { ok: false, error: 'Unsupported snapshot version (expected version: 1).' };
  }

  if (
    !Array.isArray(obj.books) ||
    !Array.isArray(obj.notes) ||
    !Array.isArray(obj.sessions) ||
    !Array.isArray(obj.deltaLogs)
  ) {
    return {
      ok: false,
      error: 'Snapshot must contain books, notes, sessions, and deltaLogs arrays.',
    };
  }

  const books: Book[] = [];
  for (const raw of obj.books) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Invalid book entry in snapshot.' };
    }
    const b = raw as Record<string, unknown>;
    if (typeof b.id !== 'string' || !b.id.trim() || typeof b.title !== 'string') {
      return { ok: false, error: 'Each book must have a string id and title.' };
    }
    const format = BOOK_FORMATS.includes(b.format as BookFormat)
      ? (b.format as BookFormat)
      : 'physical';
    const kind = BOOK_KINDS.includes(b.kind as BookKind) ? (b.kind as BookKind) : 'nonfiction';
    const status = BOOK_STATUSES.includes(b.status as BookStatus)
      ? (b.status as BookStatus)
      : 'reading';
    const posUnit = POS_UNITS.includes(b.posUnit as PosUnit) ? (b.posUnit as PosUnit) : 'page';
    const currentPos = Number(b.currentPos) || 0;
    const totalPos = Number(b.totalPos) || 0;
    const normalizedPos =
      typeof b.normalizedPos === 'number' && Number.isFinite(b.normalizedPos)
        ? Math.min(1, Math.max(0, b.normalizedPos))
        : computeNormalizedPos(currentPos, totalPos, posUnit);

    const metaObj = (b.meta && typeof b.meta === 'object' ? b.meta : {}) as Record<string, unknown>;
    books.push({
      id: b.id.trim(),
      title: b.title,
      author: typeof b.author === 'string' ? b.author : '',
      format,
      kind,
      status,
      currentPos,
      totalPos,
      posUnit,
      normalizedPos,
      docUrl: typeof b.docUrl === 'string' ? b.docUrl : '',
      meta: {
        ...(typeof metaObj.coverUrl === 'string' ? { coverUrl: metaObj.coverUrl } : {}),
        ...(typeof metaObj.startedAt === 'string' ? { startedAt: metaObj.startedAt } : {}),
        ...(typeof metaObj.finishedAt === 'string' ? { finishedAt: metaObj.finishedAt } : {}),
        updatedAt:
          typeof metaObj.updatedAt === 'string'
            ? metaObj.updatedAt
            : new Date().toISOString(),
      },
    });
  }

  const notes: Note[] = [];
  for (const raw of obj.notes) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Invalid note entry in snapshot.' };
    }
    const n = raw as Record<string, unknown>;
    if (
      typeof n.id !== 'string' ||
      !n.id.trim() ||
      typeof n.bookId !== 'string' ||
      !n.bookId.trim()
    ) {
      return { ok: false, error: 'Each note must have a valid id and bookId.' };
    }
    const status = NOTE_STATUSES.includes(n.status as NoteStatus)
      ? (n.status as NoteStatus)
      : 'saved';
    const deltaStatus = DELTA_STATUSES.includes(n.deltaStatus as DeltaStatus)
      ? (n.deltaStatus as DeltaStatus)
      : 'none';
    const metaObj = (n.meta && typeof n.meta === 'object' ? n.meta : {}) as Record<string, unknown>;

    notes.push({
      id: n.id.trim(),
      slug: typeof n.slug === 'string' && n.slug.trim() ? n.slug.trim() : n.id.trim(),
      bookId: n.bookId.trim(),
      createdAt: typeof n.createdAt === 'string' ? n.createdAt : new Date().toISOString(),
      updatedAt: typeof n.updatedAt === 'string' ? n.updatedAt : new Date().toISOString(),
      pos: Number(n.pos) || 0,
      normalizedPos:
        typeof n.normalizedPos === 'number' && Number.isFinite(n.normalizedPos)
          ? Math.min(1, Math.max(0, n.normalizedPos))
          : 0,
      status,
      source: n.source === 'agent' ? 'agent' : 'app',
      tags: Array.isArray(n.tags) ? n.tags.map(t => String(t)) : [],
      quote: typeof n.quote === 'string' ? n.quote : '',
      takeaway: typeof n.takeaway === 'string' ? n.takeaway : '',
      contextMechanism: typeof n.contextMechanism === 'string' ? n.contextMechanism : '',
      critique: typeof n.critique === 'string' ? n.critique : '',
      deltaTrigger: normalizeDeltaTrigger(typeof n.deltaTrigger === 'string' ? n.deltaTrigger : ''),
      deltaAction: normalizeDeltaAction(typeof n.deltaAction === 'string' ? n.deltaAction : ''),
      deltaStatus,
      meta: {
        ...(typeof metaObj.title === 'string' ? { title: metaObj.title } : {}),
        attachments: Array.isArray(metaObj.attachments)
          ? (metaObj.attachments.slice(0, 3) as Note['meta']['attachments'])
          : [],
        links: Array.isArray(metaObj.links) ? metaObj.links.map(String) : [],
        ...(metaObj.isPrediction !== undefined ? { isPrediction: Boolean(metaObj.isPrediction) } : {}),
        ...(Array.isArray(metaObj.socraticQuestions) && metaObj.socraticQuestions.length === 2
          ? {
              socraticQuestions: [
                String(metaObj.socraticQuestions[0]),
                String(metaObj.socraticQuestions[1]),
              ],
            }
          : {}),
        ...(metaObj.ocrBackfilled !== undefined
          ? { ocrBackfilled: Boolean(metaObj.ocrBackfilled) }
          : {}),
        ...(typeof metaObj.exportedAt === 'string' ? { exportedAt: metaObj.exportedAt } : {}),
        ...(typeof metaObj.lastReviewedAt === 'string'
          ? { lastReviewedAt: metaObj.lastReviewedAt }
          : {}),
      },
    });
  }

  const sessions: ReadingSession[] = [];
  for (const raw of obj.sessions) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Invalid session entry in snapshot.' };
    }
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== 'string' || typeof s.bookId !== 'string' || typeof s.date !== 'string') {
      return { ok: false, error: 'Each session must have id, bookId, and date.' };
    }
    sessions.push({
      id: s.id,
      bookId: s.bookId,
      date: s.date,
      startPos: Number(s.startPos) || 0,
      endPos: Number(s.endPos) || 0,
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : new Date().toISOString(),
      note: typeof s.note === 'string' ? s.note : '',
    });
  }

  const deltaLogs: DeltaLog[] = [];
  for (const raw of obj.deltaLogs) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Invalid delta log entry in snapshot.' };
    }
    const d = raw as Record<string, unknown>;
    if (typeof d.id !== 'string' || typeof d.noteId !== 'string' || typeof d.date !== 'string') {
      return { ok: false, error: 'Each delta log must have id, noteId, and date.' };
    }
    const outcome = DELTA_OUTCOMES.includes(d.outcome as DeltaOutcome)
      ? (d.outcome as DeltaOutcome)
      : 'no-trigger';
    deltaLogs.push({
      id: d.id,
      noteId: d.noteId,
      date: d.date,
      outcome,
      reflection: typeof d.reflection === 'string' ? d.reflection : '',
    });
  }

  return {
    ok: true,
    snapshot: {
      version: 1,
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
      books,
      notes,
      sessions,
      deltaLogs,
    },
    counts: {
      books: books.length,
      notes: notes.length,
      sessions: sessions.length,
      deltaLogs: deltaLogs.length,
    },
  };
}
