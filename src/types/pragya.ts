export type BookFormat = 'physical' | 'kindle';
export type BookKind = 'nonfiction' | 'fiction';
export type BookStatus = 'reading' | 'queued' | 'finished' | 'paused';
export type PosUnit = 'page' | 'percent' | 'loc';

export interface BookCapstone {
  arcOrThesis: string;
  keyLearnings: string[];
  perspectiveShift: string;
  completedAt: string;
}

export interface BookMetaJson {
  coverUrl?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  currentChapter?: string;
  /** C1.1 soft-archive timestamp (ISO). Present → hidden from default lists. */
  archivedAt?: string;
  /** Stored verbatim (agent-owned). Read via `getBookCapstone()` (utils/metaCodecs) for a typed view. */
  capstone?: unknown;
  /** Unknown keys (e.g. written by the CLI/skill) are preserved verbatim on round-trip. */
  [extraKey: string]: unknown;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  kind: BookKind;
  status: BookStatus;
  currentPos: number;
  totalPos: number;
  posUnit: PosUnit;
  normalizedPos: number;
  docUrl: string;
  meta: BookMetaJson;
}

export type NoteStatus = 'saved' | 'inbox' | 'in-reflection' | 'atomic';
export type NoteSource = 'app' | 'agent';
export type DeltaStatus = 'none' | 'active' | 'graduated' | 'paused';

export type Attachment =
  | {
      id: string;
      type: 'image';
      driveFileId?: string;
      demoMediaId?: string;
      fileName: string;
      mimeType: string;
      width?: number;
      height?: number;
    }
  | {
      id: string;
      type: 'doc';
      title: string;
      url: string;
      docId?: string;
    }
  | {
      id: string;
      type: 'link';
      title: string;
      url: string;
    };

export interface NoteMetaJson {
  title?: string;
  /**
   * Stored verbatim, including unknown/invalid entries and entries beyond 3.
   * Render via `getRenderableAttachments()` / edit via `splitAttachments()` +
   * `mergeEditedAttachments()` (utils/metaCodecs). Typed `unknown[]` on purpose so
   * every reader is forced through those validating helpers.
   */
  attachments: unknown[];
  links: string[];
  isPrediction?: boolean;
  /** 1–3 trimmed, non-empty questions. */
  socraticQuestions?: string[];
  ocrBackfilled?: boolean;
  exportedAt?: string;
  lastReviewedAt?: string;
  chapter?: string;
  /** C1.1 soft-archive timestamp (ISO). Present → hidden from default lists. */
  archivedAt?: string;
  /** C1.1: the delta status paused by archiving (restored on unarchive when under the cap). */
  archivedDeltaStatus?: unknown;
  /** Agent-owned spar progress marker; passed through verbatim (not validated). */
  sparStage?: unknown;
  /** Unknown keys (e.g. written by the CLI/skill) are preserved verbatim on round-trip. */
  [extraKey: string]: unknown;
}

export interface Note {
  id: string;
  slug: string;
  bookId: string;
  createdAt: string;
  updatedAt: string;
  pos: number;
  normalizedPos: number;
  status: NoteStatus;
  source: NoteSource;
  tags: string[];
  quote: string;
  takeaway: string;
  contextMechanism: string;
  critique: string;
  deltaTrigger: string;
  deltaAction: string;
  deltaStatus: DeltaStatus;
  meta: NoteMetaJson;
}

export interface ReadingSession {
  id: string;
  bookId: string;
  date: string; // YYYY-MM-DD
  startPos: number;
  endPos: number;
  updatedAt: string;
  note: string;
}

export type DeltaOutcome = 'applied' | 'missed' | 'no-trigger';

export interface DeltaLog {
  id: string;
  noteId: string;
  date: string; // YYYY-MM-DD
  outcome: DeltaOutcome;
  reflection: string;
}

export interface PragyaSnapshot {
  version: 1;
  exportedAt: string;
  books: Book[];
  notes: Note[];
  sessions: ReadingSession[];
  deltaLogs: DeltaLog[];
}

export interface WorkspaceState {
  books: Book[];
  notes: Note[];
  sessions: ReadingSession[];
  deltaLogs: DeltaLog[];
  spreadsheetId?: string;
  modifiedTime?: string;
  mediaFolderId?: string;
  /** True when served from pragya_sheets_cache_v1 because the network is unavailable. */
  isOfflineReadOnly?: boolean;
  /** True when the cache was served because Google rate-limited the freshness check. */
  servedFromCacheDueToRateLimit?: boolean;
}
