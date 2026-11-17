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
import {
  RowConflictError,
  RowMovedError,
  extractMetaUpdatedAt,
  isRemoteNewer,
} from '../utils/conflictGuard';
import { ApiError, classifyApiError } from '../utils/apiErrors';
import { planTrailingClearRanges, type ImportTabPlan } from '../utils/importSafety';
import { isNetworkError } from '../utils/offline';
import {
  ensureLocalStorage,
  type SaveOptions,
  type StorageAdapter,
  type StorageLoadOptions,
} from './storage';

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

/**
 * Bumped whenever the row codecs change what survives decoding. A cache decoded by an
 * older codec may have already dropped metaJson keys (e.g. `subgenre`, `sparStage`), so
 * serving it as a fast-reload hit and then saving would wipe those keys from the Sheet.
 * The storage key name stays `pragya_sheets_cache_v1` (SPEC-locked).
 */
export const SHEETS_CACHE_CODEC_VERSION = 2;

interface CachedSheetsPayload {
  spreadsheetId: string;
  modifiedTime: string;
  accountEmail?: string;
  mediaFolderId?: string;
  codecVersion?: number;
  state: {
    books: Book[];
    notes: Note[];
    sessions: ReadingSession[];
    deltaLogs: DeltaLog[];
  };
}

interface ReadSheetsCacheOptions {
  /**
   * Accept a cache written by an older codec. Only safe for the offline read-only
   * fallback, which never writes back to the Sheet.
   */
  allowStaleCodec?: boolean;
}

function readSheetsCache(options: ReadSheetsCacheOptions = {}): CachedSheetsPayload | null {
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
      if (parsed.codecVersion !== SHEETS_CACHE_CODEC_VERSION && !options.allowStaleCodec) {
        return null;
      }
      return parsed as CachedSheetsPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Always stamps the current {@link SHEETS_CACHE_CODEC_VERSION}.
 *
 * INVARIANT: only pass state decoded by the current codec (fresh `rowTo*` output or a
 * strict `readSheetsCache()` result). Never write back a payload obtained with
 * `allowStaleCodec: true` — that would promote legacy-decoded data (already missing
 * unknown metaJson keys) to v2 and re-open the A5.3 wipe hazard.
 */
function writeSheetsCache(payload: CachedSheetsPayload): void {
  try {
    localStorage.setItem(
      SHEETS_CACHE_STORAGE_KEY,
      JSON.stringify({ ...payload, codecVersion: SHEETS_CACHE_CODEC_VERSION })
    );
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

/** A5.6: at most 3 attempts for a rate-limited request, sleeping 0.5 s then 1 s. */
export const RATE_LIMIT_MAX_ATTEMPTS = 3;
export const RATE_LIMIT_BACKOFF_MS: readonly number[] = [500, 1000];

export interface GoogleSheetsAdapterOptions {
  /** Injectable backoff sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Column letters → 0-based index (A → 0, L → 11, AA → 26). */
function columnIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

export class GoogleSheetsAdapter implements StorageAdapter {
  private getToken: () => string | null;
  private onUnauthorized?: () => void;
  private accountEmail?: string;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private spreadsheetId: string | null = null;
  private mediaFolderId: string | null = null;

  private sleep: (ms: number) => Promise<void>;

  constructor(
    getToken: () => string | null,
    onUnauthorized?: () => void,
    accountEmail?: string,
    options: GoogleSheetsAdapterOptions = {}
  ) {
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized;
    this.accountEmail = accountEmail;
    this.sleep = options.sleep ?? defaultSleep;
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

    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, { ...options, headers });
      if (response.status === 401) {
        this.onUnauthorized?.();
        throw new Error('401 Unauthorized');
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const apiError = new ApiError(response.status, text);
        // B4.7/A5.6: genuine 429 / quota-403 responses were rejected server-side, so a
        // short backoff + retry is safe (even for writes). Everything else surfaces now.
        if (classifyApiError(apiError) === 'rate_limited' && attempt < RATE_LIMIT_MAX_ATTEMPTS) {
          await this.sleep(RATE_LIMIT_BACKOFF_MS[attempt - 1] ?? 1000);
          continue;
        }
        throw apiError;
      }
      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
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
        // Clear stale ID if deleted/not found/forbidden and rediscover. A rate-limited
        // 403/429 is not "forbidden": keep the ID and cache (B4.7).
        const kind = classifyApiError(err);
        if (kind === 'not_found' || kind === 'forbidden') {
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
    // A stale-codec cache is still read here for the account check and the offline
    // read-only fallback, but it never satisfies the fast-reload hit below (A5.3).
    let cached = readSheetsCache({ allowStaleCodec: true });
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

    const offlineFallback = (): WorkspaceState | null => {
      if (knownId && cached && cached.spreadsheetId === knownId && cached.state) {
        this.spreadsheetId = knownId;
        if (cached.mediaFolderId) this.mediaFolderId = cached.mediaFolderId;
        return {
          ...cached.state,
          spreadsheetId: knownId,
          modifiedTime: cached.modifiedTime,
          mediaFolderId: cached.mediaFolderId,
          isOfflineReadOnly: true,
        };
      }
      return null;
    };

    // Drive modifiedTime fast-reload cache check
    if (
      !forceRefresh &&
      knownId &&
      cached &&
      cached.codecVersion === SHEETS_CACHE_CODEC_VERSION &&
      cached.spreadsheetId === knownId &&
      cached.modifiedTime
    ) {
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
          cached = null;
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
        const kind = classifyApiError(err);
        if (kind === 'not_found' || kind === 'forbidden') {
          localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
          localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
          this.spreadsheetId = null;
          cached = null;
        } else if (kind === 'rate_limited' && cached) {
          // B4.7: Drive is throttling the modifiedTime check (retries exhausted). The
          // current-codec cache is the best data we have — keep it and serve it.
          this.spreadsheetId = knownId;
          if (cached.mediaFolderId) this.mediaFolderId = cached.mediaFolderId;
          return {
            ...cached.state,
            spreadsheetId: knownId,
            modifiedTime: cached.modifiedTime,
            mediaFolderId: cached.mediaFolderId,
            servedFromCacheDueToRateLimit: true,
          };
        } else if (isNetworkError(err)) {
          // M4.5: offline → serve last-known cache in read-only mode
          const offline = offlineFallback();
          if (offline) return offline;
        }
      }
    }

    try {
      return await this.loadWorkspaceFromSheets();
    } catch (err) {
      if (isNetworkError(err)) {
        const offline = offlineFallback();
        if (offline) return offline;
      }
      throw err;
    }
  }

  private async loadWorkspaceFromSheets(): Promise<WorkspaceState> {
    const { spreadsheetId, modifiedTime, createdNew } = await this.discoverOrCreateSpreadsheet();
    if (!createdNew) {
      await this.ensureSchemaAndRepair(spreadsheetId);
    }

    const dataRangesQuery = TAB_SPECS.map(
      spec => `ranges=${encodeURIComponent(`${spec.title}!A:${spec.lastCol}`)}`
    ).join('&');

    // UNFORMATTED_VALUE appended after ranges=... so numeric cells stay numbers.
    const batchRes = await this.fetchApi<{
      valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
    }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values:batchGet?${dataRangesQuery}&valueRenderOption=UNFORMATTED_VALUE`
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

  private async resolveRowIndex(
    spreadsheetId: string,
    tab: TabSchemaSpec['title'],
    id: string
  ): Promise<number> {
    const colARes = await this.fetchApi<{ values?: unknown[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(`${tab}!A:A`)}`
    );
    const rows = colARes.values || [];
    for (let i = 0; i < rows.length; i += 1) {
      const cell = String(rows[i]?.[0] ?? '').trim();
      if (cell === id && cell !== 'id') return i;
    }
    return -1;
  }

  /** One-cell UNFORMATTED_VALUE read of `${tab}!A{r}` (the row's UUID). */
  private async readIdCell(
    spreadsheetId: string,
    tab: TabSchemaSpec['title'],
    sheetRowNumber: number
  ): Promise<string> {
    const res = await this.fetchApi<{ values?: unknown[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(`${tab}!A${sheetRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE`
    );
    return String(res.values?.[0]?.[0] ?? '').trim();
  }

  /**
   * R1#2: confirm `id` still sits at 0-based `matchIndex` right before a write/delete.
   * On a mismatch re-resolve A:A once and re-verify; otherwise throw RowMovedError
   * (never write or delete by a stale index).
   */
  private async verifyRowIndex(
    spreadsheetId: string,
    tab: TabSchemaSpec['title'],
    id: string,
    matchIndex: number
  ): Promise<number> {
    if ((await this.readIdCell(spreadsheetId, tab, matchIndex + 1)) === id) return matchIndex;
    const relocated = await this.resolveRowIndex(spreadsheetId, tab, id);
    if (relocated < 0 || (await this.readIdCell(spreadsheetId, tab, relocated + 1)) !== id) {
      throw new RowMovedError();
    }
    return relocated;
  }

  /**
   * B4.3: one UNFORMATTED_VALUE read of `${tab}!A{r}:{tsCol}{r}` that both verifies the
   * row still holds `id` (column A) and returns the row's timestamp cell.
   */
  private async readGuardRow(
    spreadsheetId: string,
    tab: TabSchemaSpec['title'],
    sheetRowNumber: number,
    timestampCol: 'E' | 'L'
  ): Promise<unknown[]> {
    const range = `${tab}!A${sheetRowNumber}:${timestampCol}${sheetRowNumber}`;
    const res = await this.fetchApi<{ values?: unknown[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`
    );
    return res.values?.[0] || [];
  }

  private async upsertRowById(
    tab: TabSchemaSpec['title'],
    lastCol: string,
    id: string,
    rowValues: (string | number)[],
    conflictGuard?: { expectedBaseUpdatedAt?: string; timestampCol: 'E' | 'L' }
  ): Promise<void> {
    const spreadsheetId = await this.getActiveSpreadsheetId();
    let matchIndex = await this.resolveRowIndex(spreadsheetId, tab, id);

    if (matchIndex >= 0) {
      // M4.9: pre-write row-level conflict guard (targeted read of the row's timestamp
      // column, resolved fresh at write time — never cached).
      if (conflictGuard?.expectedBaseUpdatedAt) {
        const tsIdx = columnIndex(conflictGuard.timestampCol);
        let cells = await this.readGuardRow(
          spreadsheetId,
          tab,
          matchIndex + 1,
          conflictGuard.timestampCol
        );
        if (String(cells[0] ?? '').trim() !== id) {
          // B4.3: rows shifted between the A:A read and the guard read — re-resolve once.
          matchIndex = await this.resolveRowIndex(spreadsheetId, tab, id);
          cells =
            matchIndex >= 0
              ? await this.readGuardRow(spreadsheetId, tab, matchIndex + 1, conflictGuard.timestampCol)
              : [];
          if (matchIndex < 0 || String(cells[0] ?? '').trim() !== id) {
            throw new RowMovedError();
          }
        }
        const rawCell = cells[tsIdx];
        const remoteUpdatedAt =
          conflictGuard.timestampCol === 'L' ? extractMetaUpdatedAt(rawCell) : rawCell;
        if (isRemoteNewer(remoteUpdatedAt, conflictGuard.expectedBaseUpdatedAt)) {
          throw new RowConflictError(String(remoteUpdatedAt), conflictGuard.expectedBaseUpdatedAt);
        }
      } else {
        // R1#2: unguarded paths (empty base, Sessions, DeltaLogs) verify the id too.
        matchIndex = await this.verifyRowIndex(spreadsheetId, tab, id, matchIndex);
      }
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

  async saveBook(book: Book, options: SaveOptions = {}): Promise<Book> {
    return this.enqueueWrite(async () => {
      await this.upsertRowById('Books', 'L', book.id, bookToRow(book), {
        expectedBaseUpdatedAt: options.expectedBaseUpdatedAt,
        timestampCol: 'L',
      });
      await this.updateCacheAfterMutation(s => ({
        ...s,
        books: upsertInArray(s.books, book),
      }));
      return book;
    });
  }

  async saveNote(note: Note, options: SaveOptions = {}): Promise<Note> {
    return this.enqueueWrite(async () => {
      await this.upsertRowById('Notes', 'R', note.id, noteToRow(note), {
        expectedBaseUpdatedAt: options.expectedBaseUpdatedAt,
        timestampCol: 'E',
      });
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

  async deleteRowById(tab: TabSchemaSpec['title'], id: string): Promise<boolean> {
    const spreadsheetId = await this.getActiveSpreadsheetId();
    const colARes = await this.fetchApi<{ values?: unknown[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(`${tab}!A:A`)}`
    );

    const rows = colARes.values || [];
    let matchIndex = -1;
    for (let i = 1; i < rows.length; i += 1) {
      const cell = String(rows[i]?.[0] ?? '').trim();
      if (cell === id && cell !== 'id') {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex < 1) {
      return false;
    }

    const meta = await this.fetchApi<{
      sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
    }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}?fields=sheets.properties`
    );
    const sheetId = (meta.sheets || []).find(s => s.properties?.title === tab)?.properties
      ?.sheetId;
    if (typeof sheetId !== 'number') {
      return false;
    }

    // R1#2: re-verify the id immediately before the destructive deleteDimension, so a
    // row shifted by another device/CLI is never deleted by a stale index.
    // R2-a: a delete is idempotent — if the re-resolve finds no row with this id (another
    // device/CLI already deleted it) there is nothing to delete, so return false. An id
    // that is still listed but cannot be verified keeps throwing RowMovedError.
    if ((await this.readIdCell(spreadsheetId, tab, matchIndex + 1)) !== id) {
      const relocated = await this.resolveRowIndex(spreadsheetId, tab, id);
      if (relocated < 0) return false;
      matchIndex = await this.verifyRowIndex(spreadsheetId, tab, id, relocated);
    }
    if (matchIndex < 1) throw new RowMovedError();

    await this.fetchApi(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId,
                  dimension: 'ROWS',
                  startIndex: matchIndex,
                  endIndex: matchIndex + 1,
                },
              },
            },
          ],
        }),
      }
    );
    return true;
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.deleteRowById('Sessions', sessionId);
      await this.updateCacheAfterMutation(s => ({
        ...s,
        sessions: s.sessions.filter(x => x.id !== sessionId),
      }));
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

      // M4.8 step 1: snapshot current row counts (A:A) BEFORE mutating anything.
      const countRangesQuery = TAB_SPECS.map(
        spec => `ranges=${encodeURIComponent(`${spec.title}!A:A`)}`
      ).join('&');
      const countRes = await this.fetchApi<{
        valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
      }>(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values:batchGet?${countRangesQuery}&majorDimension=ROWS`
      );
      const countVrs = countRes.valueRanges || [];

      const rowsByTab: Record<TabSchemaSpec['title'], (string | number)[][]> = {
        Books: snapshot.books.map(bookToRow),
        Notes: snapshot.notes.map(noteToRow),
        Sessions: snapshot.sessions.map(sessionToRow),
        DeltaLogs: snapshot.deltaLogs.map(deltaLogToRow),
      };

      const plans: ImportTabPlan[] = TAB_SPECS.map((spec, idx) => {
        const vr =
          countVrs.find(r => r.range?.startsWith(`${spec.title}!`)) || countVrs[idx];
        return {
          tab: spec.title,
          lastCol: spec.lastCol,
          oldRowCount: vr?.values?.length || 0,
          newRowCount: 1 + rowsByTab[spec.title].length,
        };
      });

      // M4.8 step 2: write headers + all new rows from A1 FIRST. If this fails,
      // the existing sheet rows are untouched (zero blank-sheet wipe).
      const data = TAB_SPECS.map(spec => ({
        range: `${spec.title}!A1:${spec.lastCol}`,
        values: [[...spec.headers], ...rowsByTab[spec.title]],
      }));

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

      // M4.8 step 3: only clear trailing stale rows on tabs that shrank.
      const trailingRanges = planTrailingClearRanges(plans);
      if (trailingRanges.length > 0) {
        await this.fetchApi(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
            spreadsheetId
          )}/values:batchClear`,
          {
            method: 'POST',
            body: JSON.stringify({ ranges: trailingRanges }),
          }
        );
      }

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
        const kind = classifyApiError(err);
        if (kind === 'not_found' || kind === 'forbidden') {
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
