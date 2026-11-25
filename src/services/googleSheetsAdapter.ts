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
import {
  DeleteOutcomeUnknownError,
  NotArchivedError,
  type DeleteCascadeResult,
  type DeleteRowsPlan,
  type RestoreRowsResult,
} from '../utils/deletePlan';
import { isArchived } from '../utils/archive';
import { idbDelete, idbGetWithMigration, idbSet } from '../utils/idbStore';
import {
  BATCH_TAB_ORDER,
  PartialBatchCommitError,
  columnIndex,
  findRowIndexInColA,
  matchBatchValueRanges,
  normalizeBatchOps,
  parseAppendedRowIndex,
  planBatchPreReadRanges,
  validateGuardTimestamp,
  type BatchMutationOp,
  type BatchMutationResult,
  type BatchTabName,
  type NormalizedBatchOp,
} from '../utils/batchPlan';
import type { DeleteCascadeOptions, RestoreRowsInput } from './storage';

export { PartialBatchCommitError };

/**
 * CD 1b re-review R2-a: did a write fail WITHOUT a server verdict? An HTTP error (ApiError,
 * incl. 429 after retries) or 401 / missing token means the write was rejected or never
 * sent. Anything else (fetch TypeError, AbortError/timeout, unreadable body) is ambiguous:
 * the server may have applied it.
 */
export function isAmbiguousWriteError(err: unknown): boolean {
  if (err instanceof ApiError) return false;
  if (err instanceof Error && /^(Not authenticated|401 Unauthorized)$/.test(err.message)) return false;
  return true;
}

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

async function readSheetsCache(
  options: ReadSheetsCacheOptions = {}
): Promise<CachedSheetsPayload | null> {
  try {
    const raw = await idbGetWithMigration(SHEETS_CACHE_STORAGE_KEY);
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
async function writeSheetsCache(
  payload: CachedSheetsPayload,
  shouldWrite?: () => boolean
): Promise<void> {
  try {
    await idbSet(
      SHEETS_CACHE_STORAGE_KEY,
      JSON.stringify({ ...payload, codecVersion: SHEETS_CACHE_CODEC_VERSION }),
      shouldWrite ? { shouldWrite } : undefined
    );
  } catch {
    // Ignore storage quota errors
  }
}

async function clearSheetsCache(): Promise<void> {
  await idbDelete(SHEETS_CACHE_STORAGE_KEY);
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
  /** CD Batch 8 (B4.12): optional silent GIS token refresh attempted once before onUnauthorized. */
  refreshToken?: () => Promise<string | null>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class GoogleSheetsAdapter implements StorageAdapter {
  private getToken: () => string | null;
  private onUnauthorized?: () => void;
  private refreshToken?: () => Promise<string | null>;
  private accountEmail?: string;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private spreadsheetId: string | null = null;
  private mediaFolderId: string | null = null;
  /**
   * Untrusted soft row-index hints (`tab -> id -> 0-based rowIndex >= 1`), strictly scoped
   * to `rowHintsSheetId`. Every hinted row is ALWAYS live-verified against `A{row} === id`
   * on the server before any write; mismatches trigger a full A:A re-resolve.
   */
  private rowHints = new Map<BatchTabName, Map<string, number>>();
  private rowHintsSheetId: string | null = null;

  private sleep: (ms: number) => Promise<void>;

  constructor(
    getToken: () => string | null,
    onUnauthorized?: () => void,
    accountEmail?: string,
    options: GoogleSheetsAdapterOptions = {}
  ) {
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized;
    this.refreshToken = options.refreshToken;
    this.accountEmail = accountEmail;
    this.sleep = options.sleep ?? defaultSleep;
  }

  private syncRowHintsScope(spreadsheetId: string): void {
    if (this.rowHintsSheetId !== spreadsheetId) {
      this.rowHints.clear();
      this.rowHintsSheetId = spreadsheetId;
    }
  }

  private clearRowHints(tab?: BatchTabName): void {
    if (tab) {
      this.rowHints.delete(tab);
    } else {
      this.rowHints.clear();
    }
  }

  private recordRowHintsFromRows(
    spreadsheetId: string,
    tab: BatchTabName,
    rows: readonly unknown[][]
  ): void {
    this.syncRowHintsScope(spreadsheetId);
    const tabMap = new Map<string, number>();
    for (let i = 1; i < rows.length; i += 1) {
      const cell = String(rows[i]?.[0] ?? '').trim();
      if (cell && cell !== 'id') {
        tabMap.set(cell, i);
      }
    }
    this.rowHints.set(tab, tabMap);
  }

  private setRowHint(
    spreadsheetId: string,
    tab: BatchTabName,
    id: string,
    rowIndex: number
  ): void {
    if (!id || !Number.isInteger(rowIndex) || rowIndex < 1) return;
    this.syncRowHintsScope(spreadsheetId);
    let tabMap = this.rowHints.get(tab);
    if (!tabMap) {
      tabMap = new Map<string, number>();
      this.rowHints.set(tab, tabMap);
    }
    tabMap.set(id, rowIndex);
  }

  /**
   * QA-47 / R1#1: verify this adapter's session is still active before persisting or wiping
   * shared IndexedDB/localStorage artifacts (prevents an in-flight Account A fetch settling
   * after logout, Demo switch, or Account A→B switch from resurrecting or clobbering cache).
   */
  private isSessionStillActive(): boolean {
    if (!this.getToken()) return false;
    try {
      if (localStorage.getItem('pragya_mock_mode') === 'true') return false;
    } catch {
      // Ignore restricted storage
    }
    if (this.accountEmail) {
      const expected = this.accountEmail.trim().toLowerCase();
      try {
        const lastEmail = (localStorage.getItem('pragya_last_account_email') || '')
          .trim()
          .toLowerCase();
        if (lastEmail && lastEmail !== expected) return false;
        const rawUser = localStorage.getItem('pragya_google_user');
        if (rawUser) {
          const parsed = JSON.parse(rawUser) as { email?: unknown };
          const activeEmail =
            typeof parsed?.email === 'string' ? parsed.email.trim().toLowerCase() : '';
          if (activeEmail && activeEmail !== expected) return false;
        }
      } catch {
        // Ignore restricted/malformed storage
      }
    }
    return true;
  }

  private async persistSheetsCache(payload: CachedSheetsPayload): Promise<void> {
    if (!this.isSessionStillActive()) return;
    await writeSheetsCache(payload, () => this.isSessionStillActive());
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
    let token = this.getToken();
    let refreshedOnce = false;
    if (!token && this.refreshToken) {
      refreshedOnce = true;
      token = await this.refreshToken();
    }
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
        if (!refreshedOnce && this.refreshToken) {
          refreshedOnce = true;
          const refreshed = await this.refreshToken();
          if (refreshed && refreshed !== token) {
            token = refreshed;
            headers.set('Authorization', `Bearer ${token}`);
            continue;
          }
        }
        this.onUnauthorized?.();
        throw new Error('401 Unauthorized');
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const apiError = new ApiError(response.status, text);
        // B4.7/A5.6: genuine 429 / quota-403 responses were rejected server-side before
        // applying, so a short backoff + retry is safe (even for writes). Ambiguous
        // failures (network drops, 5xx) are NOT classified as rate_limited and never retry,
        // preventing duplicate non-idempotent appends.
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
          if (this.isSessionStillActive()) {
            await clearSheetsCache();
            localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
          }
          this.spreadsheetId = null;
          this.clearRowHints();
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
          if (this.isSessionStillActive()) {
            await clearSheetsCache();
            localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
          }
          this.spreadsheetId = null;
          this.clearRowHints();
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
      if (this.isSessionStillActive()) {
        localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, existing.id);
      }
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
    if (this.isSessionStillActive()) {
      localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, spreadsheetId);
    }

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
    let cached = await readSheetsCache({ allowStaleCodec: true });
    if (
      cached &&
      this.accountEmail &&
      cached.accountEmail &&
      cached.accountEmail.trim().toLowerCase() !== this.accountEmail.trim().toLowerCase()
    ) {
      if (this.isSessionStillActive()) {
        await clearSheetsCache();
        localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
        localStorage.removeItem(MEDIA_FOLDER_ID_STORAGE_KEY);
      }
      this.spreadsheetId = null;
      this.mediaFolderId = null;
      this.clearRowHints();
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

    // Offline cached-boot short-circuit: serve the IndexedDB cache immediately without
    // attempting token refresh or network calls (so an expired 1-hour access token on a
    // flight/subway stays readable instead of firing onUnauthorized).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const offline = offlineFallback();
      if (offline) return offline;
    }

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
          if (this.isSessionStillActive()) {
            await clearSheetsCache();
            localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
          }
          this.spreadsheetId = null;
          this.clearRowHints();
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
          if (this.isSessionStillActive()) {
            await clearSheetsCache();
            localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
          }
          this.spreadsheetId = null;
          this.clearRowHints();
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

    const rawBooks = getTabRows('Books', 0);
    const rawNotes = getTabRows('Notes', 1);
    const rawSessions = getTabRows('Sessions', 2);
    const rawDeltaLogs = getTabRows('DeltaLogs', 3);

    this.recordRowHintsFromRows(spreadsheetId, 'Books', rawBooks);
    this.recordRowHintsFromRows(spreadsheetId, 'Notes', rawNotes);
    this.recordRowHintsFromRows(spreadsheetId, 'Sessions', rawSessions);
    this.recordRowHintsFromRows(spreadsheetId, 'DeltaLogs', rawDeltaLogs);

    const books = rawBooks
      .slice(1)
      .map(rowToBook)
      .filter((b): b is Book => b !== null);
    const notes = rawNotes
      .slice(1)
      .map(rowToNote)
      .filter((n): n is Note => n !== null);
    const sessions = rawSessions
      .slice(1)
      .map(rowToSession)
      .filter((s): s is ReadingSession => s !== null);
    const deltaLogs = rawDeltaLogs
      .slice(1)
      .map(rowToDeltaLog)
      .filter((d): d is DeltaLog => d !== null);

    let resolvedModifiedTime = modifiedTime;
    if (!resolvedModifiedTime && this.isSessionStillActive()) {
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

    await this.persistSheetsCache({
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
      this.setRowHint(spreadsheetId, tab, id, matchIndex);
    } else {
      const appendRes = await this.fetchApi<{ updates?: { updatedRange?: string } }>(
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
      const appendedIdx = parseAppendedRowIndex(appendRes.updates?.updatedRange);
      if (appendedIdx !== null) {
        this.setRowHint(spreadsheetId, tab, id, appendedIdx);
      }
    }
  }

  private async updateCacheAfterMutation(
    mutator: (state: CachedSheetsPayload['state']) => CachedSheetsPayload['state']
  ): Promise<void> {
    if (!this.isSessionStillActive()) return;
    const spreadsheetId = await this.getActiveSpreadsheetId();
    if (!this.isSessionStillActive()) return;
    const cached = await readSheetsCache();
    if (!this.isSessionStillActive()) return;
    if (!cached || cached.spreadsheetId !== spreadsheetId) {
      await clearSheetsCache();
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
      if (!this.isSessionStillActive()) return;
      if (classifyApiError(err) === 'rate_limited') {
        // B4.7 / CD7: never wipe a valid v2 cache on 429; persist updated state with the
        // previous modifiedTime so the next online loadWorkspace still detects remote drift.
        await this.persistSheetsCache({
          spreadsheetId,
          modifiedTime: cached.modifiedTime,
          accountEmail: this.accountEmail,
          mediaFolderId:
            this.mediaFolderId || localStorage.getItem(MEDIA_FOLDER_ID_STORAGE_KEY) || undefined,
          state: nextState,
        });
        return;
      }
      await clearSheetsCache();
      return;
    }

    await this.persistSheetsCache({
      spreadsheetId,
      modifiedTime: nextModifiedTime,
      accountEmail: this.accountEmail,
      mediaFolderId:
        this.mediaFolderId || localStorage.getItem(MEDIA_FOLDER_ID_STORAGE_KEY) || undefined,
      state: nextState,
    });
  }

  /**
   * CD Batch 7 (OQ-12): commit multiple row mutations across tabs in a single coalesced cycle:
   *  1. ONE `values:batchGet` pre-read for all touched rows / tabs.
   *  2. Verify every update's `A{row} === id` (re-resolving once on shift, or throwing
   *     `RowMovedError`) and validate every conflict guard BEFORE issuing any write.
   *     Any conflict, missing update target (`QA-46`), or unverified move aborts the entire
   *     batch with ZERO writes.
   *  3. ONE `values:batchUpdate` (`valueInputOption=RAW`) for all updates (Books before Sessions).
   *  4. Grouped `:append` (`valueInputOption=RAW&insertDataOption=INSERT_ROWS`), at most one
   *     per tab with appends (Books → Notes → Sessions → DeltaLogs). On partial failure after
   *     earlier writes succeeded (`R1#2`), throws `PartialBatchCommitError` carrying the exact
   *     `committed` rows so callers can reconcile state without phantom conflicts or duplicate
   *     notes.
   *  5. ONE Drive `modifiedTime` check + v2 cache update at the end.
   */
  async batchCommitMutations(ops: BatchMutationOp[]): Promise<BatchMutationResult> {
    return this.enqueueWrite(async () => {
      const empty: BatchMutationResult = { books: [], notes: [], sessions: [], deltaLogs: [] };
      const normalized = normalizeBatchOps(ops);
      if (normalized.length === 0) return empty;

      const spreadsheetId = await this.getActiveSpreadsheetId();
      this.syncRowHintsScope(spreadsheetId);

      // Step 1: ONE coalesced pre-read for every touched row / tab.
      const preRead = planBatchPreReadRanges(normalized, this.rowHints);
      const readMap = await this.batchReadColumns(spreadsheetId, preRead.ranges);

      for (const tab of preRead.colATabs) {
        this.recordRowHintsFromRows(spreadsheetId, tab, readMap.get(`${tab}!A:A`) || []);
      }

      // Step 2: Validate every row-ID and conflict guard BEFORE any write.
      const updates: Array<{ item: NormalizedBatchOp; rowIndex: number }> = [];
      const appends: NormalizedBatchOp[] = [];
      const mismatchedHints: NormalizedBatchOp[] = [];

      for (const plan of preRead.opPlans) {
        const { item, hintIndex, hintRange } = plan;
        if (hintIndex !== null && hintRange !== null) {
          const cells = readMap.get(hintRange)?.[0] || [];
          if (String(cells[0] ?? '').trim() !== item.id) {
            mismatchedHints.push(item);
            continue;
          }
          if (item.expectedBaseUpdatedAt && item.timestampCol) {
            validateGuardTimestamp(
              item.timestampCol,
              cells[columnIndex(item.timestampCol)],
              item.expectedBaseUpdatedAt
            );
          }
          updates.push({ item, rowIndex: hintIndex });
        } else {
          const colA = readMap.get(`${item.tab}!A:A`) || [];
          const matchIdx = findRowIndexInColA(colA, item.id);
          if (matchIdx >= 1) {
            // Confirm id cell matches in the same atomic batchGet snapshot.
            if (String(colA[matchIdx]?.[0] ?? '').trim() !== item.id) {
              throw new RowMovedError();
            }
            if (item.expectedBaseUpdatedAt && item.timestampCol) {
              const colTs = readMap.get(`${item.tab}!${item.timestampCol}:${item.timestampCol}`) || [];
              validateGuardTimestamp(
                item.timestampCol,
                colTs[matchIdx]?.[0],
                item.expectedBaseUpdatedAt
              );
            }
            updates.push({ item, rowIndex: matchIdx });
          } else {
            // QA-46: on a cold fast-reload cache hit (empty rowHints), a guarded or
            // update-only op whose row was deleted remotely MUST abort with RowMovedError
            // rather than appending and resurrecting the deleted row.
            if (item.expectedBaseUpdatedAt || item.mode === 'update') {
              throw new RowMovedError();
            }
            appends.push(item);
          }
        }
      }

      // Step 2b: Relocate & re-verify any shifted hinted rows (still ZERO writes).
      if (mismatchedHints.length > 0) {
        const relocateTabs = Array.from(new Set(mismatchedHints.map(m => m.tab)));
        const colAMap = await this.batchReadColumns(
          spreadsheetId,
          relocateTabs.map(t => `${t}!A:A`)
        );
        for (const tab of relocateTabs) {
          this.recordRowHintsFromRows(spreadsheetId, tab, colAMap.get(`${tab}!A:A`) || []);
        }

        const verifySpecs: Array<{ item: NormalizedBatchOp; rowIndex: number; verifyRange: string }> = [];
        for (const item of mismatchedHints) {
          const relocated = findRowIndexInColA(colAMap.get(`${item.tab}!A:A`) || [], item.id);
          if (relocated < 1) {
            throw new RowMovedError();
          }
          const sheetRow = relocated + 1;
          const verifyRange =
            item.expectedBaseUpdatedAt && item.timestampCol
              ? `${item.tab}!A${sheetRow}:${item.timestampCol}${sheetRow}`
              : `${item.tab}!A${sheetRow}`;
          verifySpecs.push({ item, rowIndex: relocated, verifyRange });
        }

        const verifyRanges = Array.from(new Set(verifySpecs.map(s => s.verifyRange)));
        const verifyMap = await this.batchReadColumns(spreadsheetId, verifyRanges);

        for (const spec of verifySpecs) {
          const cells = verifyMap.get(spec.verifyRange)?.[0] || [];
          if (String(cells[0] ?? '').trim() !== spec.item.id) {
            throw new RowMovedError();
          }
          if (spec.item.expectedBaseUpdatedAt && spec.item.timestampCol) {
            validateGuardTimestamp(
              spec.item.timestampCol,
              cells[columnIndex(spec.item.timestampCol)],
              spec.item.expectedBaseUpdatedAt
            );
          }
          updates.push({ item: spec.item, rowIndex: spec.rowIndex });
        }
      }

      // Enforce canonical tab order (Books before Sessions) even after relocation.
      const tabRank = (tab: BatchTabName) => BATCH_TAB_ORDER.indexOf(tab);
      updates.sort((a, b) => tabRank(a.item.tab) - tabRank(b.item.tab));

      const committed: BatchMutationResult = { books: [], notes: [], sessions: [], deltaLogs: [] };
      const recordCommitted = (item: NormalizedBatchOp) => {
        const { op } = item;
        if (op.kind === 'book') committed.books.push(op.book);
        else if (op.kind === 'note') committed.notes.push(op.note);
        else if (op.kind === 'session') committed.sessions.push(op.session);
        else committed.deltaLogs.push(op.deltaLog);
      };
      const applyBatchResultToState = (
        st: CachedSheetsPayload['state'],
        res: BatchMutationResult
      ): CachedSheetsPayload['state'] => ({
        ...st,
        books: res.books.reduce((acc, b) => upsertInArray(acc, b), st.books),
        notes: res.notes.reduce((acc, n) => upsertInArray(acc, n), st.notes),
        sessions: res.sessions.reduce((acc, s) => upsertInArray(acc, s), st.sessions),
        deltaLogs: res.deltaLogs.reduce((acc, d) => upsertInArray(acc, d), st.deltaLogs),
      });

      // Step 3: ONE values:batchUpdate for all row updates (`valueInputOption=RAW`).
      try {
        if (updates.length > 0) {
          await this.fetchApi(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
              spreadsheetId
            )}/values:batchUpdate`,
            {
              method: 'POST',
              body: JSON.stringify({
                valueInputOption: 'RAW',
                data: updates.map(({ item, rowIndex }) => {
                  const sheetRow = rowIndex + 1;
                  return {
                    range: `${item.tab}!A${sheetRow}:${item.lastCol}${sheetRow}`,
                    values: [item.rowValues],
                  };
                }),
              }),
            }
          );
          for (const { item, rowIndex } of updates) {
            recordCommitted(item);
            this.setRowHint(spreadsheetId, item.tab, item.id, rowIndex);
          }
        }

        // Step 4: Grouped appends (at most one :append call per tab, Books before Sessions).
        for (const tab of BATCH_TAB_ORDER) {
          const tabAppends = appends.filter(a => a.tab === tab);
          if (tabAppends.length === 0) continue;
          const appendRes = await this.fetchApi<{ updates?: { updatedRange?: string } }>(
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
              spreadsheetId
            )}/values/${encodeURIComponent(
              `${tab}!A1`
            )}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
            {
              method: 'POST',
              body: JSON.stringify({ values: tabAppends.map(a => a.rowValues) }),
            }
          );
          for (const a of tabAppends) {
            recordCommitted(a);
          }
          if (tabAppends.length === 1) {
            const appendedIdx = parseAppendedRowIndex(appendRes.updates?.updatedRange);
            if (appendedIdx !== null) {
              this.setRowHint(spreadsheetId, tab, tabAppends[0].id, appendedIdx);
            }
          }
        }
      } catch (err) {
        const hasCommitted =
          committed.books.length +
            committed.notes.length +
            committed.sessions.length +
            committed.deltaLogs.length >
          0;
        if (hasCommitted) {
          this.clearRowHints();
          if (this.isSessionStillActive()) {
            // R1#2: preserve 429 non-cache-wipe rule AND patch committed rows into v2 cache
            // (keeping prior modifiedTime so next online sync still reconciles the failed op);
            // for non-429 partial failures clear cache so next sync fetches authoritative state.
            if (classifyApiError(err) === 'rate_limited') {
              const cached = await readSheetsCache();
              if (cached && cached.spreadsheetId === spreadsheetId) {
                await this.persistSheetsCache({
                  spreadsheetId,
                  modifiedTime: cached.modifiedTime,
                  accountEmail: this.accountEmail,
                  mediaFolderId:
                    this.mediaFolderId ||
                    localStorage.getItem(MEDIA_FOLDER_ID_STORAGE_KEY) ||
                    undefined,
                  state: applyBatchResultToState(cached.state, committed),
                });
              }
            } else {
              await clearSheetsCache();
            }
          }
          throw new PartialBatchCommitError(committed, err);
        }
        throw err;
      }

      // Step 5: ONE Drive modifiedTime refresh + v2 cache update.
      await this.updateCacheAfterMutation(st => applyBatchResultToState(st, committed));

      return committed;
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
    this.clearRowHints(tab);
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

  /**
   * One consistent read of the requested ranges from a SINGLE `values:batchGet`.
   * Safely distinguishes multiple ranges on the same tab (`Books!A:A` + `Books!L:L`, etc.).
   */
  private async batchReadColumns(
    spreadsheetId: string,
    ranges: string[]
  ): Promise<Map<string, unknown[][]>> {
    const query = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
    const res = await this.fetchApi<{ valueRanges?: Array<{ range?: string; values?: unknown[][] }> }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values:batchGet?${query}&valueRenderOption=UNFORMATTED_VALUE`
    );
    return matchBatchValueRanges(ranges, res.valueRanges || []);
  }

  private async sheetIdsByTitle(spreadsheetId: string): Promise<Map<string, number>> {
    const meta = await this.fetchApi<{
      sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
    }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}?fields=sheets.properties`
    );
    const out = new Map<string, number>();
    for (const sheet of meta.sheets || []) {
      const { title, sheetId } = sheet.properties || {};
      if (title && typeof sheetId === 'number') out.set(title, sheetId);
    }
    return out;
  }

  /**
   * CD C1.2 fix-up (R1#1/#2, QA-30/31) + re-review (R2-a/R2-b): ATOMIC cascade delete.
   * 1. ONE values:batchGet of every involved tab's FULL rows (the target's metaJson comes
   *    from the same read). The full rows are a snapshot for the R2-b repair below.
   * 2. Re-verify the target is STILL archived in that read (refuse with NotArchivedError).
   * 3. ONE spreadsheets.batchUpdate with every deleteDimension (descending row index per
   *    sheet, so earlier deletes never shift later ones). Sheets applies a batchUpdate
   *    all-or-nothing, so a rejected write deletes nothing. Ids absent from the read are
   *    skipped (another device already removed them). Never touches Drive files.
   * 4. ONE A:A re-read of the involved tabs:
   *    - R2-a: if the write failed with no HTTP answer (network/timeout), the outcome is
   *      unknown. If any planned id is gone the write landed → treat as success; if every
   *      planned id is still there → rethrow (nothing removed). If the re-read fails too →
   *      DeleteOutcomeUnknownError (the caller keeps the backup).
   *    - R2-b: any id that vanished but was NOT planned was hit by an index shift (another
   *      device deleted a row above ours in between) → re-append it from the snapshot via
   *      the append-if-absent path. Planned ids still present are reported for a retry.
   */
  async deleteRowsCascade(plan: DeleteRowsPlan, options: DeleteCascadeOptions = {}): Promise<DeleteCascadeResult> {
    return this.enqueueWrite(async () => {
      const result: DeleteCascadeResult = { repaired: 0, stillPresent: [] };
      const spreadsheetId = await this.getActiveSpreadsheetId();
      const tabs: Array<{ tab: TabSchemaSpec['title']; ids: string[] }> = [
        { tab: 'DeltaLogs', ids: plan.deltaLogIds },
        { tab: 'Sessions', ids: plan.sessionIds },
        { tab: 'Notes', ids: plan.noteIds },
        { tab: 'Books', ids: plan.bookIds },
      ];
      const involved = tabs.filter(t => t.ids.length > 0);
      if (involved.length === 0) return result;
      const target = options.target;
      const targetTab: TabSchemaSpec['title'] | null = target ? (target.kind === 'book' ? 'Books' : 'Notes') : null;
      const lastCol: Record<TabSchemaSpec['title'], string> = { Books: 'L', Notes: 'R', Sessions: 'G', DeltaLogs: 'E' };
      const fullRange = (tab: TabSchemaSpec['title']) => `${tab}!A:${lastCol[tab]}`;
      const readTabs = involved.map(t => t.tab);
      if (targetTab && !readTabs.includes(targetTab)) readTabs.push(targetTab);
      const read = await this.batchReadColumns(spreadsheetId, readTabs.map(fullRange));
      const tabRows = (tab: TabSchemaSpec['title']): unknown[][] => read.get(fullRange(tab)) || [];
      const cellId = (r: unknown[] | undefined) => String(r?.[0] ?? '').trim();

      if (target && targetTab) {
        const metaCol = targetTab === 'Books' ? 11 : 17;
        const row = tabRows(targetTab).find((r, i) => i > 0 && cellId(r) === target.id);
        if (row) {
          let meta: unknown = null;
          try {
            meta = JSON.parse(String(row[metaCol] ?? '') || 'null');
          } catch {
            meta = null;
          }
          if (!isArchived({ meta: meta as { archivedAt?: unknown } | null })) {
            throw new NotArchivedError(target.kind);
          }
        }
      }

      const requests: Array<Record<string, unknown>> = [];
      const requested: Array<{ tab: TabSchemaSpec['title']; id: string }> = [];
      let sheetIds: Map<string, number> | null = null;
      for (const { tab, ids } of involved) {
        const wanted = new Set(ids);
        const rows = tabRows(tab);
        const indexes: number[] = [];
        for (let i = 1; i < rows.length; i += 1) {
          if (wanted.has(cellId(rows[i]))) {
            indexes.push(i);
            requested.push({ tab, id: cellId(rows[i]) });
          }
        }
        if (indexes.length === 0) continue;
        indexes.sort((a, b) => b - a);
        sheetIds = sheetIds || (await this.sheetIdsByTitle(spreadsheetId));
        const sheetId = sheetIds.get(tab);
        if (typeof sheetId !== 'number') throw new RowMovedError();
        for (const i of indexes) {
          requests.push({
            deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } },
          });
        }
      }

      const drop = <T extends { id: string }>(list: T[], ids: string[], keep: Set<string>) => {
        const set = new Set(ids.filter(id => !keep.has(id)));
        return list.filter(x => !set.has(x.id));
      };
      const updateCache = (keep: Set<string>) =>
        this.updateCacheAfterMutation(st => ({
          ...st,
          deltaLogs: drop(st.deltaLogs, plan.deltaLogIds, keep),
          sessions: drop(st.sessions, plan.sessionIds, keep),
          notes: drop(st.notes, plan.noteIds, keep),
          books: drop(st.books, plan.bookIds, keep),
        }));

      if (requests.length === 0) {
        await updateCache(new Set());
        return result;
      }

      let ambiguous: unknown = null;
      try {
        await this.fetchApi(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
          { method: 'POST', body: JSON.stringify({ requests }) }
        );
      } catch (err) {
        // An HTTP answer (incl. 401) or a missing token means Sheets rejected / never got
        // the write → nothing deleted. Anything else (network drop, timeout, bad body) is
        // an UNKNOWN outcome that must be reconciled by reading back (R2-a).
        if (!isAmbiguousWriteError(err)) throw err;
        ambiguous = err;
      }

      this.clearRowHints();

      let after: Map<string, unknown[][]>;
      try {
        after = await this.batchReadColumns(spreadsheetId, involved.map(t => `${t.tab}!A:A`));
      } catch {
        if (ambiguous) throw new DeleteOutcomeUnknownError();
        // The write was acknowledged; only the shift check is skipped.
        await updateCache(new Set());
        return result;
      }
      const afterIds = new Map<string, Set<string>>(
        involved.map(t => [t.tab, new Set((after.get(`${t.tab}!A:A`) || []).slice(1).map(cellId).filter(Boolean))])
      );
      const present = (tab: string, id: string) => afterIds.get(tab)?.has(id) ?? false;
      if (ambiguous && requested.every(r => present(r.tab, r.id))) throw ambiguous;

      const restore: RestoreRowsInput = { books: [], notes: [], sessions: [], deltaLogs: [] };
      for (const { tab, ids } of involved) {
        const planned = new Set(ids);
        result.stillPresent.push(...ids.filter(id => present(tab, id)));
        for (const row of tabRows(tab).slice(1)) {
          const id = cellId(row);
          if (!id || planned.has(id) || present(tab, id)) continue;
          if (tab === 'Books') {
            const b = rowToBook(row);
            if (b) restore.books.push(b);
          } else if (tab === 'Notes') {
            const n = rowToNote(row);
            if (n) restore.notes.push(n);
          } else if (tab === 'Sessions') {
            const s = rowToSession(row);
            if (s) restore.sessions.push(s);
          } else {
            const l = rowToDeltaLog(row);
            if (l) restore.deltaLogs.push(l);
          }
        }
      }
      await updateCache(new Set(result.stillPresent));
      if (restore.books.length + restore.notes.length + restore.sessions.length + restore.deltaLogs.length > 0) {
        const repaired = await this.appendRowsIfAbsentUnlocked(spreadsheetId, restore);
        const r = repaired.restored;
        result.repaired = r.books.length + r.notes.length + r.sessions.length + r.deltaLogs.length;
      }
      return result;
    });
  }

  /**
   * CD C1.2 fix-up (R1#4): Undo re-append. ONE values:batchGet of the id columns, then ONE
   * values:append per tab for the rows whose id is ABSENT. Existing rows are never
   * overwritten (they're reported as skipped). Parents first: Books, Notes, Sessions, Logs.
   * Rows are written through the canonical codecs and land at the bottom of each tab.
   */
  async appendRowsIfAbsent(rows: RestoreRowsInput): Promise<RestoreRowsResult> {
    return this.enqueueWrite(async () => this.appendRowsIfAbsentUnlocked(await this.getActiveSpreadsheetId(), rows));
  }

  /** appendRowsIfAbsent body, for callers already inside the write queue. */
  private async appendRowsIfAbsentUnlocked(spreadsheetId: string, rows: RestoreRowsInput): Promise<RestoreRowsResult> {
    const groups: Array<{ tab: TabSchemaSpec['title']; key: keyof RestoreRowsResult['restored']; items: Array<{ id: string }>; toRow: (x: never) => (string | number)[] }> = [
      { tab: 'Books', key: 'books', items: rows.books, toRow: bookToRow as (x: never) => (string | number)[] },
      { tab: 'Notes', key: 'notes', items: rows.notes, toRow: noteToRow as (x: never) => (string | number)[] },
      { tab: 'Sessions', key: 'sessions', items: rows.sessions, toRow: sessionToRow as (x: never) => (string | number)[] },
      { tab: 'DeltaLogs', key: 'deltaLogs', items: rows.deltaLogs, toRow: deltaLogToRow as (x: never) => (string | number)[] },
    ];
    const result: RestoreRowsResult = { restored: { books: [], notes: [], sessions: [], deltaLogs: [] }, skipped: 0 };
    const involved = groups.filter(g => g.items.length > 0);
    if (involved.length === 0) return result;
    const read = await this.batchReadColumns(spreadsheetId, involved.map(g => `${g.tab}!A:A`));
    for (const g of involved) {
      const present = new Set((read.get(`${g.tab}!A:A`) || []).slice(1).map(r => String(r?.[0] ?? '').trim()));
      const absent = g.items.filter(x => !present.has(x.id));
      result.skipped += g.items.length - absent.length;
      if (absent.length === 0) continue;
      await this.fetchApi(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values/${encodeURIComponent(`${g.tab}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: absent.map(x => g.toRow(x as never)) }) }
      );
      result.restored[g.key] = absent.map(x => x.id);
    }
    const ids = result.restored;
    await this.updateCacheAfterMutation(st => ({
      ...st,
      books: rows.books.filter(b => ids.books.includes(b.id)).reduce((acc, b) => upsertInArray(acc, b), st.books),
      notes: rows.notes.filter(n => ids.notes.includes(n.id)).reduce((acc, n) => upsertInArray(acc, n), st.notes),
      sessions: rows.sessions.filter(x => ids.sessions.includes(x.id)).reduce((acc, x) => upsertInArray(acc, x), st.sessions),
      deltaLogs: rows.deltaLogs.filter(l => ids.deltaLogs.includes(l.id)).reduce((acc, l) => upsertInArray(acc, l), st.deltaLogs),
    }));
    return result;
  }

  /** CD 3 fix-up (R1#1): one fresh `Sessions!A:G` read (UNFORMATTED, codec-decoded). */
  async loadSessions(): Promise<ReadingSession[]> {
    const spreadsheetId = await this.getActiveSpreadsheetId();
    const read = await this.batchReadColumns(spreadsheetId, ['Sessions!A:G']);
    return (read.get('Sessions!A:G') || [])
      .slice(1)
      .map(rowToSession)
      .filter((x): x is ReadingSession => x !== null);
  }

  /** CD 2 fix-up (R1#1/#2): one fresh `DeltaLogs!A:E` read (UNFORMATTED, codec-decoded). */
  async loadDeltaLogs(): Promise<DeltaLog[]> {
    const spreadsheetId = await this.getActiveSpreadsheetId();
    const read = await this.batchReadColumns(spreadsheetId, ['DeltaLogs!A:E']);
    return (read.get('DeltaLogs!A:E') || [])
      .slice(1)
      .map(rowToDeltaLog)
      .filter((d): d is DeltaLog => d !== null);
  }

  /** CD C2.1 check-in Undo: id-verified single-row delete (idempotent if already gone). */
  async deleteDeltaLog(logId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.deleteRowById('DeltaLogs', logId);
      await this.updateCacheAfterMutation(s => ({
        ...s,
        deltaLogs: s.deltaLogs.filter(x => x.id !== logId),
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

      this.clearRowHints();
      await this.persistSheetsCache({
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

  private async clearCachedMediaFolderId(): Promise<void> {
    this.mediaFolderId = null;
    if (!this.isSessionStillActive()) return;
    localStorage.removeItem(MEDIA_FOLDER_ID_STORAGE_KEY);
    const cached = await readSheetsCache();
    if (!this.isSessionStillActive()) return;
    if (cached && cached.mediaFolderId) {
      await this.persistSheetsCache({
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
          if (this.isSessionStillActive()) {
            localStorage.setItem(MEDIA_FOLDER_ID_STORAGE_KEY, candidateId);
          }
          return candidateId;
        }
        await this.clearCachedMediaFolderId();
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('401')) throw err;
        const kind = classifyApiError(err);
        if (kind === 'not_found' || kind === 'forbidden') {
          await this.clearCachedMediaFolderId();
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
      if (this.isSessionStillActive()) {
        localStorage.setItem(MEDIA_FOLDER_ID_STORAGE_KEY, this.mediaFolderId);
      }
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
    if (this.isSessionStillActive()) {
      localStorage.setItem(MEDIA_FOLDER_ID_STORAGE_KEY, created.id);
    }
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
        await this.clearCachedMediaFolderId();
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
