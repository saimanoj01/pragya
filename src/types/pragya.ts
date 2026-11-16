export type BookFormat = 'physical' | 'kindle';
export type BookKind = 'nonfiction' | 'fiction';
export type BookStatus = 'reading' | 'queued' | 'finished' | 'paused';
export type PosUnit = 'page' | 'percent' | 'loc';

export interface BookMetaJson {
  coverUrl?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
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
  attachments: Attachment[];
  links: string[];
  isPrediction?: boolean;
  socraticQuestions?: [string, string];
  ocrBackfilled?: boolean;
  exportedAt?: string;
  lastReviewedAt?: string;
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
}
