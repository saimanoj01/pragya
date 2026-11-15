import type {
  Attachment,
  Book,
  DeltaLog,
  Note,
  PragyaSnapshot,
  ReadingSession,
  WorkspaceState,
} from '../types/pragya';
import { createUuid } from '../utils/sessionCoalesce';
import {
  BOOKS_HEADERS,
  DELTA_LOGS_HEADERS,
  NOTES_HEADERS,
  SESSIONS_HEADERS,
  bookToRow,
  deltaLogToRow,
  noteToRow,
  rowToBook,
  rowToDeltaLog,
  rowToNote,
  rowToSession,
  sessionToRow,
} from '../utils/sheetCodecs';
import { ensureLocalStorage, type StorageAdapter, type StorageLoadOptions } from './storage';

ensureLocalStorage();

export const SPREADSHEET_ID_STORAGE_KEY = 'pragya_spreadsheet_id';
export const SHEETS_CACHE_STORAGE_KEY = 'pragya_sheets_cache_v1';
export const MEDIA_FOLDER_ID_STORAGE_KEY = 'pragya_media_folder_id';
export const SPREADSHEET_TITLE = 'Pragya Commonplace';
export const MEDIA_FOLDER_NAME = 'Pragya Media';

interface TabSchemaSpec {
  title: 'Books' | 'Notes' | 'Sessions' | 'DeltaLogs';
  lastCol: string;
  headers: readonly string[];
}

const TAB_SPECS: TabSchemaSpec[] = [
  { title: 'Books', lastCol: 'L', headers: BOOKS_HEADERS },
  { title: 'Notes', lastCol: 'R', headers: NOTES_HEADERS },
  { title: 'Sessions', lastCol: 'G', headers: SESSIONS_HEADERS },
  { title: 'DeltaLogs', lastCol: 'E', headers: DELTA_LOGS_HEADERS },
];

interface CachedSheetsPayload {
  spreadsheetId: string;
  modifiedTime: string;
  accountEmail?: string;
  mediaFolderId?: string;
  state: {
    books: Book[];
    notes: Note[];
    sessions: ReadingSession[];
    deltaLogs: DeltaLog[];
  };
}

function readSheetsCache(): CachedSheetsPayload | null {
  try {
    const raw = localStorage.getItem(SHEETS_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedSheetsPayload>;
    if (
      parsed &&
      typeof parsed.spreadsheetId === 'string' &&
      typeof parsed.modifiedTime === 'string' &&
      parsed.state &&
      Array.isArray(parsed.state.books) &&
      Array.isArray(parsed.state.notes) &&
      Array.isArray(parsed.state.sessions) &&
      Array.isArray(parsed.state.deltaLogs)
    ) {
      return parsed as CachedSheetsPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function writeSheetsCache(payload: CachedSheetsPayload): void {
  try {
    localStorage.setItem(SHEETS_CACHE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota errors
  }
}

function headersEqual(actualRow: unknown[] | undefined, expected: readonly string[]): boolean {
  if (!Array.isArray(actualRow) || actualRow.length < expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (String(actualRow[i] ?? '').trim() !== expected[i]) return false;
  }
  return true;
}

function upsertInArray<T extends { id: string }>(arr: T[], item: T): T[] {
  const idx = arr.findIndex(x => x.id === item.id);
  if (idx >= 0) {
    const next = [...arr];
    next[idx] = item;
    return next;
  }
  return [...arr, item];
}

export class GoogleSheetsAdapter implements StorageAdapter {
  private getToken: () => string | null;
  private onUnauthorized?: () => void;
  private accountEmail?: string;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private spreadsheetId: string | null = null;
  private mediaFolderId: string | null = null;

  constructor(getToken: () => string | null, onUnauthorized?: () => void, accountEmail?: string) {
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized;
    this.accountEmail = accountEmail;
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.catch(() => {}).then(task);
    this.writeQueue = next;
    return next;
  }

  private async fetchApi<T = Record<string, unknown>>(
    url: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.getToken();
    if (!token) {
      this.onUnauthorized?.();
      throw new Error('Not authenticated');
    }

    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const isBlob = typeof Blob !== 'undefined' && options.body instanceof Blob;
    if (
      !headers.has('Content-Type') &&
      options.method &&
      options.method !== 'GET' &&
      !isFormData &&
      !isBlob
    ) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      this.onUnauthorized?.();
      throw new Error('401 Unauthorized');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`API Error ${response.status}: ${text}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async discoverOrCreateSpreadsheet(): Promise<{
    spreadsheetId: string;
    modifiedTime: string;
    createdNew: boolean;
  }> {
    const overrideId =
      this.spreadsheetId || localStorage.getItem(SPREADSHEET_ID_STORAGE_KEY) || '';
    if (overrideId) {
      try {
        const meta = await this.fetchApi<{
          id?: string;
          modifiedTime?: string;
          trashed?: boolean;
        }>(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
            overrideId
          )}?fields=id,name,modifiedTime,trashed`
        );
        if (meta.trashed) {
          localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
          localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
          this.spreadsheetId = null;
        } else {
          this.spreadsheetId = overrideId;
          return {
            spreadsheetId: overrideId,
            modifiedTime: meta.modifiedTime || '',
            createdNew: false,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('401')) throw err;
        // Clear stale ID if deleted/not found/forbidden and rediscover
        if (msg.includes('404') || msg.includes('403')) {
          localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
          localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
          this.spreadsheetId = null;
        } else {
          this.spreadsheetId = overrideId;
          return { spreadsheetId: overrideId, modifiedTime: '', createdNew: false };
        }
      }
    }

    const q = encodeURIComponent(
      `name = '${SPREADSHEET_TITLE}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`
    );
    const searchRes = await this.fetchApi<{
      files?: Array<{ id: string; name: string; modifiedTime?: string }>;
    }>(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&spaces=drive`
    );

    const existing = searchRes.files?.[0];
    if (existing?.id) {
      this.spreadsheetId = existing.id;
      localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, existing.id);
      return {
        spreadsheetId: existing.id,
        modifiedTime: existing.modifiedTime || '',
        createdNew: false,
      };
    }

    const created = await this.fetchApi<{ spreadsheetId: string }>(
      'https://sheets.googleapis.com/v4/spreadsheets',
      {
        method: 'POST',
        body: JSON.stringify({
          properties: { title: SPREADSHEET_TITLE },
          sheets: TAB_SPECS.map(spec => ({ properties: { title: spec.title } })),
        }),
      }
    );

    const spreadsheetId = created.spreadsheetId;
    this.spreadsheetId = spreadsheetId;
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, spreadsheetId);

    // Populate canonical headers
    await this.fetchApi(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: TAB_SPECS.map(spec => ({
            range: `${spec.title}!A1:${spec.lastCol}1`,
            values: [[...spec.headers]],
          })),
        }),
      }
    );

    let modifiedTime = '';
    try {
      const fileMeta = await this.fetchApi<{ modifiedTime?: string }>(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          spreadsheetId
        )}?fields=modifiedTime`
      );
      modifiedTime = fileMeta.modifiedTime || '';
    } catch (err) {
      if (err instanceof Error && err.message.includes('401')) throw err;
    }

    return { spreadsheetId, modifiedTime, createdNew: true };
  }

  async ensureSchemaAndRepair(spreadsheetId: string): Promise<void> {
    const meta = await this.fetchApi<{
      sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
    }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}?fields=sheets.properties`
    );

    const existingTitles = new Set(
      (meta.sheets || []).map(s => s.properties?.title).filter((t): t is string => Boolean(t))
    );

    const missingTabs = TAB_SPECS.filter(spec => !existingTitles.has(spec.title));
    if (missingTabs.length > 0) {
      await this.fetchApi(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}:batchUpdate`,
        {
          method: 'POST',
          body: JSON.stringify({
            requests: missingTabs.map(spec => ({
              addSheet: { properties: { title: spec.title } },
            })),
          }),
        }
      );
    }

    const headerRangesQuery = TAB_SPECS.map(
      spec => `ranges=${encodeURIComponent(`${spec.title}!A1:${spec.lastCol}1`)}`
    ).join('&');

    const headerRes = await this.fetchApi<{
      valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
    }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values:batchGet?${headerRangesQuery}`
    );

    const valueRanges = headerRes.valueRanges || [];
    const repairData: Array<{ range: string; values: string[][] }> = [];

    TAB_SPECS.forEach((spec, idx) => {
      const matched =
        valueRanges.find(vr => vr.range?.startsWith(`${spec.title}!`)) || valueRanges[idx];
      const firstRow = matched?.values?.[0];
      if (!headersEqual(firstRow, spec.headers)) {
        repairData.push({
          range: `${spec.title}!A1:${spec.lastCol}1`,
          values: [[...spec.headers]],
        });
      }
    });

    for (const repair of repairData) {
      await this.fetchApi(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values/${encodeURIComponent(repair.range)}?valueInputOption=RAW`,
        {
          method: 'PUT',
          body: JSON.stringify({ values: repair.values }),
        }
      );
    }
  }

  async loadWorkspace(options: StorageLoadOptions = {}): Promise<WorkspaceState> {
    const forceRefresh = Boolean(options.forceRefresh);
    let cached = readSheetsCache();
    if (
      cached &&
      this.accountEmail &&
      cached.accountEmail &&
      cached.accountEmail !== this.accountEmail
    ) {
      localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
      localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
      localStorage.removeItem(MEDIA_FOLDER_ID_STORAGE_KEY);
      this.spreadsheetId = null;
      this.mediaFolderId = null;
      cached = null;
    }
    const knownId =
      this.spreadsheetId ||
      localStorage.getItem(SPREADSHEET_ID_STORAGE_KEY) ||
      cached?.spreadsheetId ||
      '';

    // Drive modifiedTime fast-reload cache check
    if (!forceRefresh && knownId && cached && cached.spreadsheetId === knownId && cached.modifiedTime) {
      try {
        const remoteMeta = await this.fetchApi<{ modifiedTime?: string; trashed?: boolean }>(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
            knownId
          )}?fields=modifiedTime,trashed`
        );
        if (remoteMeta.trashed) {
          localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
          localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
          this.spreadsheetId = null;
        } else if (remoteMeta.modifiedTime && remoteMeta.modifiedTime === cached.modifiedTime) {
          this.spreadsheetId = knownId;
          if (cached.mediaFolderId) this.mediaFolderId = cached.mediaFolderId;
          return {
            ...cached.state,
            spreadsheetId: knownId,
            modifiedTime: cached.modifiedTime,
            mediaFolderId: cached.mediaFolderId,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('401')) throw err;
        if (msg.includes('404') || msg.includes('403')) {
          localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
          localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
          this.spreadsheetId = null;
        }
      }
    }

    const { spreadsheetId, modifiedTime, createdNew } = await this.discoverOrCreateSpreadsheet();
    if (!createdNew) {
      await this.ensureSchemaAndRepair(spreadsheetId);
    }

    const dataRangesQuery = TAB_SPECS.map(
      spec => `ranges=${encodeURIComponent(`${spec.title}!A:${spec.lastCol}`)}`
    ).join('&');

    const batchRes = await this.fetchApi<{
      valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
    }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values:batchGet?${dataRangesQuery}`
    );

    const vrs = batchRes.valueRanges || [];
    const getTabRows = (tabTitle: string, fallbackIndex: number): unknown[][] => {
      const vr = vrs.find(r => r.range?.startsWith(`${tabTitle}!`)) || vrs[fallbackIndex];
      return vr?.values || [];
    };

    const books = getTabRows('Books', 0)
      .slice(1)
      .map(rowToBook)
      .filter((b): b is Book => b !== null);
    const notes = getTabRows('Notes', 1)
      .slice(1)
      .map(rowToNote)
      .filter((n): n is Note => n !== null);
    const sessions = getTabRows('Sessions', 2)
      .slice(1)
      .map(rowToSession)
      .filter((s): s is ReadingSession => s !== null);
    const deltaLogs = getTabRows('DeltaLogs', 3)
      .slice(1)
      .map(rowToDeltaLog)
      .filter((d): d is DeltaLog => d !== null);

    let resolvedModifiedTime = modifiedTime;
    if (!resolvedModifiedTime) {
      try {
        const meta = await this.fetchApi<{ modifiedTime?: string }>(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
            spreadsheetId
          )}?fields=modifiedTime`
        );
        resolvedModifiedTime = meta.modifiedTime || '';
      } catch (err) {
        if (err instanceof Error && err.message.includes('401')) throw err;
      }
    }

    const mediaFolderId =
      this.mediaFolderId || localStorage.getItem(MEDIA_FOLDER_ID_STORAGE_KEY) || undefined;

    writeSheetsCache({
      spreadsheetId,
      modifiedTime: resolvedModifiedTime,
      accountEmail: this.accountEmail,
      mediaFolderId,
      state: { books, notes, sessions, deltaLogs },
    });

    return {
      books,
      notes,
      sessions,
      deltaLogs,
      spreadsheetId,
      modifiedTime: resolvedModifiedTime,
      mediaFolderId,
    };
  }

  private async getActiveSpreadsheetId(): Promise<string> {
    if (this.spreadsheetId) return this.spreadsheetId;
    const stored = localStorage.getItem(SPREADSHEET_ID_STORAGE_KEY);
    if (stored) {
      this.spreadsheetId = stored;
      return stored;
    }
    const { spreadsheetId } = await this.discoverOrCreateSpreadsheet();
    return spreadsheetId;
  }

  private async upsertRowById(
    tab: TabSchemaSpec['title'],
    lastCol: string,
    id: string,
    rowValues: (string | number)[]
  ): Promise<void> {
    const spreadsheetId = await this.getActiveSpreadsheetId();
    const colARes = await this.fetchApi<{ values?: unknown[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(`${tab}!A:A`)}`
    );

    const rows = colARes.values || [];
    let matchIndex = -1;
    for (let i = 0; i < rows.length; i += 1) {
      const cell = String(rows[i]?.[0] ?? '').trim();
      if (cell === id && cell !== 'id') {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex >= 0) {
      const sheetRowNumber = matchIndex + 1;
      const targetRange = `${tab}!A${sheetRowNumber}:${lastCol}${sheetRowNumber}`;
      await this.fetchApi(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values/${encodeURIComponent(targetRange)}?valueInputOption=RAW`,
        {
          method: 'PUT',
          body: JSON.stringify({ values: [rowValues] }),
        }
      );
    } else {
      await this.fetchApi(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values/${encodeURIComponent(
          `${tab}!A1`
        )}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        {
          method: 'POST',
          body: JSON.stringify({ values: [rowValues] }),
        }
      );
    }
  }

  private async updateCacheAfterMutation(
    mutator: (state: CachedSheetsPayload['state']) => CachedSheetsPayload['state']
  ): Promise<void> {
    const spreadsheetId = await this.getActiveSpreadsheetId();
    const cached = readSheetsCache();
    if (!cached || cached.spreadsheetId !== spreadsheetId) {
      localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
      return;
    }

    const nextState = mutator(cached.state);
    let nextModifiedTime = cached.modifiedTime || '';
    try {
      const meta = await this.fetchApi<{ modifiedTime?: string }>(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          spreadsheetId
        )}?fields=modifiedTime`
      );
      if (meta.modifiedTime) {
        nextModifiedTime = meta.modifiedTime;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('401')) throw err;
      localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
      return;
    }

    writeSheetsCache({
      spreadsheetId,
      modifiedTime: nextModifiedTime,
      accountEmail: this.accountEmail,
      mediaFolderId:
        this.mediaFolderId || localStorage.getItem(MEDIA_FOLDER_ID_STORAGE_KEY) || undefined,
      state: nextState,
    });
  }

  async saveBook(book: Book): Promise<Book> {
    return this.enqueueWrite(async () => {
      await this.upsertRowById('Books', 'L', book.id, bookToRow(book));
      await this.updateCacheAfterMutation(s => ({
        ...s,
        books: upsertInArray(s.books, book),
      }));
      return book;
    });
  }

  async saveNote(note: Note): Promise<Note> {
    return this.enqueueWrite(async () => {
      await this.upsertRowById('Notes', 'R', note.id, noteToRow(note));
      await this.updateCacheAfterMutation(s => ({
        ...s,
        notes: upsertInArray(s.notes, note),
      }));
      return note;
    });
  }

  async saveSession(session: ReadingSession): Promise<ReadingSession> {
    return this.enqueueWrite(async () => {
      await this.upsertRowById('Sessions', 'G', session.id, sessionToRow(session));
      await this.updateCacheAfterMutation(s => ({
        ...s,
        sessions: upsertInArray(s.sessions, session),
      }));
      return session;
    });
  }

  async saveDeltaLog(log: DeltaLog): Promise<DeltaLog> {
    return this.enqueueWrite(async () => {
      await this.upsertRowById('DeltaLogs', 'E', log.id, deltaLogToRow(log));
      await this.updateCacheAfterMutation(s => ({
        ...s,
        deltaLogs: upsertInArray(s.deltaLogs, log),
      }));
      return log;
    });
  }

  async replaceWorkspace(snapshot: PragyaSnapshot): Promise<WorkspaceState> {
    return this.enqueueWrite(async () => {
      const spreadsheetId = await this.getActiveSpreadsheetId();
      await this.ensureSchemaAndRepair(spreadsheetId);

      await this.fetchApi(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values:batchClear`,
        {
          method: 'POST',
          body: JSON.stringify({
            ranges: ['Books!A2:L', 'Notes!A2:R', 'Sessions!A2:G', 'DeltaLogs!A2:E'],
          }),
        }
      );

      const data = [
        { range: 'Books!A1:L', values: [[...BOOKS_HEADERS], ...snapshot.books.map(bookToRow)] },
        { range: 'Notes!A1:R', values: [[...NOTES_HEADERS], ...snapshot.notes.map(noteToRow)] },
        {
          range: 'Sessions!A1:G',
          values: [[...SESSIONS_HEADERS], ...snapshot.sessions.map(sessionToRow)],
        },
        {
          range: 'DeltaLogs!A1:E',
          values: [[...DELTA_LOGS_HEADERS], ...snapshot.deltaLogs.map(deltaLogToRow)],
        },
      ];

      await this.fetchApi(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values:batchUpdate`,
        {
          method: 'POST',
          body: JSON.stringify({
            valueInputOption: 'RAW',
            data,
          }),
        }
      );

      let modifiedTime = '';
      try {
        const meta = await this.fetchApi<{ modifiedTime?: string }>(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
            spreadsheetId
          )}?fields=modifiedTime`
        );
        modifiedTime = meta.modifiedTime || '';
      } catch (err) {
        if (err instanceof Error && err.message.includes('401')) throw err;
      }

      const nextState: WorkspaceState = {
        books: [...snapshot.books],
        notes: [...snapshot.notes],
        sessions: [...snapshot.sessions],
        deltaLogs: [...snapshot.deltaLogs],
        spreadsheetId,
        modifiedTime,
      };

      writeSheetsCache({
        spreadsheetId,
        modifiedTime,
        accountEmail: this.accountEmail,
        mediaFolderId:
          this.mediaFolderId || localStorage.getItem(MEDIA_FOLDER_ID_STORAGE_KEY) || undefined,
        state: {
          books: nextState.books,
          notes: nextState.notes,
          sessions: nextState.sessions,
          deltaLogs: nextState.deltaLogs,
        },
      });

      return nextState;
    });
  }

  private clearCachedMediaFolderId(): void {
    this.mediaFolderId = null;
    localStorage.removeItem(MEDIA_FOLDER_ID_STORAGE_KEY);
    const cached = readSheetsCache();
    if (cached && cached.mediaFolderId) {
      writeSheetsCache({
        ...cached,
        mediaFolderId: undefined,
      });
    }
  }

  private async ensureMediaFolder(): Promise<string> {
    const candidateId = this.mediaFolderId || localStorage.getItem(MEDIA_FOLDER_ID_STORAGE_KEY);
    if (candidateId) {
      try {
        const meta = await this.fetchApi<{ id?: string; trashed?: boolean }>(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
            candidateId
          )}?fields=id,trashed`
        );
        if (!meta.trashed) {
          this.mediaFolderId = candidateId;
          localStorage.setItem(MEDIA_FOLDER_ID_STORAGE_KEY, candidateId);
          return candidateId;
        }
        this.clearCachedMediaFolderId();
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('401')) throw err;
        if (msg.includes('404') || msg.includes('403')) {
          this.clearCachedMediaFolderId();
        } else {
          this.mediaFolderId = candidateId;
          return candidateId;
        }
      }
    }

    const q = encodeURIComponent(
      `name = '${MEDIA_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    );
    const searchRes = await this.fetchApi<{ files?: Array<{ id: string; name: string }> }>(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`
    );

    if (searchRes.files?.[0]?.id) {
      this.mediaFolderId = searchRes.files[0].id;
      localStorage.setItem(MEDIA_FOLDER_ID_STORAGE_KEY, this.mediaFolderId);
      return this.mediaFolderId;
    }

    const created = await this.fetchApi<{ id: string }>(
      'https://www.googleapis.com/drive/v3/files',
      {
        method: 'POST',
        body: JSON.stringify({
          name: MEDIA_FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder',
        }),
      }
    );

    this.mediaFolderId = created.id;
    localStorage.setItem(MEDIA_FOLDER_ID_STORAGE_KEY, created.id);
    return created.id;
  }

  private async uploadMultipartImage(
    folderId: string,
    blob: Blob,
    fileName: string,
    mimeType: string
  ): Promise<{ id: string; name?: string; mimeType?: string }> {
    const boundary = `pragya_${createUuid().replace(/-/g, '')}`;
    const metadataPart = JSON.stringify({
      name: fileName,
      parents: [folderId],
      mimeType,
    });

    const preamble = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataPart}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const epilogue = `\r\n--${boundary}--`;
    const bodyBlob = new Blob([preamble, blob, epilogue], {
      type: `multipart/related; boundary=${boundary}`,
    });

    return this.fetchApi<{ id: string; name?: string; mimeType?: string }>(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType',
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: bodyBlob,
      }
    );
  }

  async uploadImage(
    blob: Blob,
    fileName: string,
    mimeType: string,
    width?: number,
    height?: number
  ): Promise<Attachment> {
    let folderId = await this.ensureMediaFolder();
    let uploaded: { id: string; name?: string; mimeType?: string };
    try {
      uploaded = await this.uploadMultipartImage(folderId, blob, fileName, mimeType);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('404')) {
        this.clearCachedMediaFolderId();
        folderId = await this.ensureMediaFolder();
        uploaded = await this.uploadMultipartImage(folderId, blob, fileName, mimeType);
      } else {
        throw err;
      }
    }

    return {
      id: createUuid(),
      type: 'image',
      driveFileId: uploaded.id,
      fileName,
      mimeType,
      width,
      height,
    };
  }

  async resolveDocTitle(docId: string): Promise<string | null> {
    try {
      const res = await this.fetchApi<{ id?: string; name?: string }>(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}?fields=id,name`
      );
      return res.name || null;
    } catch (err) {
      if (err instanceof Error && err.message.includes('401')) throw err;
      return null;
    }
  }
}
