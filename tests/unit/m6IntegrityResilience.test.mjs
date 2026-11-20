import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof module.registerHooks === 'function') {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !path.extname(specifier) &&
        context.parentURL
      ) {
        const parentPath = fileURLToPath(context.parentURL);
        const parentDir = path.dirname(parentPath);
        for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
          const candidate = path.resolve(parentDir, `${specifier}${ext}`);
          if (fs.existsSync(candidate)) {
            return nextResolve(pathToFileURL(candidate).href, context);
          }
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const {
  ApiError,
  RATE_LIMIT_PATTERN,
  RATE_LIMIT_TOAST,
  classifyApiError,
  describeSyncError,
  extractErrorReason,
  isRateLimitedText,
} = await load('src/utils/apiErrors.ts');
const { RowConflictError, RowMovedError, isRemoteNewer, resolveExpectedBase } = await load(
  'src/utils/conflictGuard.ts'
);
const { isNetworkError, OfflineReadOnlyError } = await load('src/utils/offline.ts');
const { parseHash, safeDecode } = await load('src/utils/navigation.ts');
const { formatErrorReport } = await load('src/utils/errorReport.ts');
const { computeExpiresAt, isTokenExpired, parseStoredExpiresAt, TOKEN_EXPIRY_SKEW_MS } = await load(
  'src/utils/tokenExpiry.ts'
);
const {
  mergeEditedAttachments,
  mergeUnknownMetaKeys,
  splitAttachments,
  BOOK_EDITOR_OWNED_META_KEYS,
  NOTE_EDITOR_OWNED_META_KEYS,
} = await load('src/utils/metaCodecs.ts');
const { sheetSerialToMillis, toSheetSerial } = await load('src/utils/sheetSerial.ts');
const { decodeSheetDate, decodeSheetTimestamp, bookToRow, BOOKS_HEADERS, NOTES_HEADERS, SESSIONS_HEADERS, DELTA_LOGS_HEADERS } =
  await load('src/utils/sheetCodecs.ts');
const {
  GoogleSheetsAdapter,
  SHEETS_CACHE_STORAGE_KEY,
  SHEETS_CACHE_CODEC_VERSION,
  SPREADSHEET_ID_STORAGE_KEY,
} = await load('src/services/googleSheetsAdapter.ts');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function book(overrides = {}) {
  return {
    id: 'book-1',
    title: 'Book',
    author: 'A',
    format: 'physical',
    kind: 'nonfiction',
    status: 'reading',
    currentPos: 10,
    totalPos: 100,
    posUnit: 'page',
    normalizedPos: 0.1,
    docUrl: '',
    meta: { updatedAt: '2026-11-16T12:00:00.000Z', subgenre: 'memoir' },
    ...overrides,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** Minimal Sheets fake; `handlers` can intercept before the defaults. */
function makeFetch({ calls, handlers = [], bookColA = [['id'], ['book-1']], guardRows = {} }) {
  return async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url: u, body: init.body });
    for (const h of handlers) {
      const r = await h(u, method, init);
      if (r) return r;
    }
    if (u.includes('/values/Books!A%3AA')) return json({ values: typeof bookColA === 'function' ? bookColA() : bookColA });
    for (const [needle, row] of Object.entries(guardRows)) {
      if (method === 'GET' && u.includes(needle)) return json({ values: [row] });
    }
    if (method === 'PUT' || u.includes(':append')) return json({});
    if (u.includes('drive/v3/files/')) return json({ id: 'sheet-1', modifiedTime: '2026-11-16T00:00:00Z' });
    return json({});
  };
}

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// B4.1 — explicit conflict base
// ---------------------------------------------------------------------------

test('B4.1: resolveExpectedBase — explicit wins, even ""', () => {
  assert.equal(resolveExpectedBase('2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z'), '2026-11-16T00:00:00Z');
  assert.equal(resolveExpectedBase('', '2026-11-17T00:00:00Z'), '');
  assert.equal(resolveExpectedBase(undefined, '2026-11-17T00:00:00Z'), '2026-11-17T00:00:00Z');
  assert.equal(resolveExpectedBase(undefined, undefined), undefined);
});

test('B4.1: adapter conflict with the modal-open base after a background sync advanced the loaded row', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  const calls = [];
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
    const remoteMeta = JSON.stringify({ updatedAt: '2026-11-16T12:05:00.000Z' });
    globalThis.fetch = makeFetch({
      calls,
      guardRows: { 'Books!A2%3AL2': ['book-1', 'Book', '', '', '', '', 0, 0, '', 0, '', remoteMeta] },
    });
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
    // Modal opened at 12:00; a sync loaded 12:05; the explicit 12:00 base must conflict.
    await assert.rejects(
      () =>
        adapter.saveBook(book({ meta: { updatedAt: '2026-11-16T12:10:00.000Z' } }), {
          expectedBaseUpdatedAt: '2026-11-16T12:00:00.000Z',
        }),
      err => err instanceof RowConflictError
    );
    assert.equal(calls.filter(c => c.method === 'PUT').length, 0);
    // Undo/restore with no remote change since the applied write → succeeds.
    await adapter.saveBook(book(), { expectedBaseUpdatedAt: '2026-11-16T12:05:00.000Z' });
    assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});

// ---------------------------------------------------------------------------
// B4.3 — A{row} === id verification
// ---------------------------------------------------------------------------

test('B4.3: guard read verifies the row id; relocated row → write goes to the new row', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  const calls = [];
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
    let colAReads = 0;
    const oldMeta = JSON.stringify({ updatedAt: '2026-11-16T11:00:00.000Z' });
    globalThis.fetch = makeFetch({
      calls,
      // First A:A: row 2. After the guard mismatch, A:A shows the book on row 3.
      bookColA: () => {
        colAReads += 1;
        return colAReads === 1 ? [['id'], ['book-1']] : [['id'], ['inserted'], ['book-1']];
      },
      guardRows: {
        'Books!A2%3AL2': ['inserted', 'Someone else'],
        'Books!A3%3AL3': ['book-1', 'Book', '', '', '', '', 0, 0, '', 0, '', oldMeta],
      },
    });
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
    await adapter.saveBook(book(), { expectedBaseUpdatedAt: '2026-11-16T12:00:00.000Z' });
    const guardGets = calls.filter(c => c.method === 'GET' && c.url.includes('valueRenderOption=UNFORMATTED_VALUE'));
    assert.ok(guardGets.some(c => c.url.includes('Books!A2%3AL2')));
    assert.ok(guardGets.some(c => c.url.includes('Books!A3%3AL3')));
    const puts = calls.filter(c => c.method === 'PUT');
    assert.equal(puts.length, 1);
    assert.ok(puts[0].url.includes('Books!A3%3AL3'));
    assert.equal(colAReads, 2);
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});

test('B4.3: persistent mismatch → RowMovedError and no PUT', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  const calls = [];
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
    globalThis.fetch = makeFetch({
      calls,
      guardRows: { 'Books!A2%3AL2': ['someone-else'] },
    });
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
    await assert.rejects(
      () => adapter.saveBook(book(), { expectedBaseUpdatedAt: '2026-11-16T12:00:00.000Z' }),
      err => err instanceof RowMovedError && /Row moved/.test(err.message)
    );
    assert.equal(calls.filter(c => c.method === 'PUT' || c.url.includes(':append')).length, 0);
    assert.equal(isNetworkError(new RowMovedError()), false);
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});

// ---------------------------------------------------------------------------
// B4.7 + A5.6 — structured errors, rate limits keep caches, backoff
// ---------------------------------------------------------------------------

test('B4.7: classifyApiError + extractErrorReason', () => {
  const quota403 = JSON.stringify({ error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }], status: 'PERMISSION_DENIED' } });
  assert.equal(extractErrorReason(quota403), 'rateLimitExceeded');
  assert.equal(classifyApiError(new ApiError(403, quota403)), 'rate_limited');
  assert.equal(classifyApiError(new ApiError(403, JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }))), 'rate_limited');
  assert.equal(classifyApiError(new ApiError(403, JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }))), 'rate_limited');
  assert.equal(classifyApiError(new ApiError(429, '')), 'rate_limited');
  assert.equal(classifyApiError(new ApiError(403, JSON.stringify({ error: { errors: [{ reason: 'forbidden' }] } }))), 'forbidden');
  assert.equal(classifyApiError(new ApiError(403, 'Forbidden')), 'forbidden');
  assert.equal(classifyApiError(new ApiError(404, 'Not Found')), 'not_found');
  assert.equal(classifyApiError(new ApiError(500, 'oops')), 'other');
  // Legacy plain Error messages still classify.
  assert.equal(classifyApiError(new Error('API Error 404: Not Found')), 'not_found');
  assert.equal(classifyApiError(new Error('API Error 429: slow')), 'rate_limited');
  assert.equal(classifyApiError(new Error('Failed to fetch')), 'other');
  const e = new ApiError(429, 'x');
  assert.equal(e.message, 'API Error 429: x');
  assert.equal(isNetworkError(e), false);
  assert.equal(describeSyncError(e), RATE_LIMIT_TOAST);
  assert.equal(describeSyncError(new Error('boom')), 'boom');
  assert.equal(RATE_LIMIT_TOAST, 'Google is limiting requests right now. Try again in a minute — nothing was lost.');
});

test('A5.6: RATE_LIMIT_PATTERN classifies like the CLI (positive / negative tables)', () => {
  for (const text of [
    'HTTP 429 Too Many Requests',
    'HTTP/1.1 429',
    'HTTP Error 429: quota',
    'status=429',
    '{"error": {"code": 429}}',
    '429',
    '429 Too Many Requests',
    'RESOURCE_EXHAUSTED',
    'Quota exceeded for quota metric',
    '<HttpError 429 when requesting https://x returned "y">',
    'Resource has been exhausted (e.g. check quota).',
    'User rate limit exceeded.',
  ]) {
    assert.equal(isRateLimitedText(text), true, text);
  }
  for (const text of [
    'PERMISSION_DENIED on doc 1a429bc0-1234-4429-8429-000000004290',
    'NOT_FOUND: Requested entity sheet-4291 was not found',
    'Unable to parse range: Notes!A1429',
    'File "x.py", line 429, in main',
    'error 4291',
    'HTTP 4290',
    '429.5 seconds',
  ]) {
    assert.equal(isRateLimitedText(text), false, text);
  }
});

// Skips only on a dev machine without python3; in CI a missing interpreter is a failure.
test('A5.6: RATE_LIMIT_PATTERN is byte-identical to scripts/pragya_cli.py', { skip: !process.env.CI && spawnSync('python3', ['--version']).status !== 0 }, () => {
  const res = spawnSync(
    'python3',
    ['-c', 'import sys, json; sys.path.insert(0, "scripts"); import pragya_cli as p; print(json.dumps(p.RATE_LIMIT_PATTERN))'],
    { cwd: repoRoot, encoding: 'utf-8' }
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout), RATE_LIMIT_PATTERN);
});

test('A5.6: 429, 429, 200 → success after 3 calls with 500/1000 ms backoff', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  const sleeps = [];
  let n = 0;
  try {
    globalThis.fetch = async () => {
      n += 1;
      if (n < 3) return new Response('{"error":{"code":429}}', { status: 429 });
      return json({ files: [] });
    };
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, {
      sleep: async ms => {
        sleeps.push(ms);
      },
    });
    const title = await adapter.resolveDocTitle('doc-1');
    assert.equal(n, 3);
    assert.deepEqual(sleeps, [500, 1000]);
    assert.equal(title === null || typeof title === 'string', true);
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});

test('A5.6: persistent 429 → ApiError after exactly 3 attempts; a plain 403 is not retried', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  let n = 0;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
    globalThis.fetch = async () => {
      n += 1;
      return new Response('Too Many Requests', { status: 429 });
    };
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
    await assert.rejects(() => adapter.saveBook(book()), err => err instanceof ApiError && err.status === 429);
    assert.equal(n, 3);

    n = 0;
    globalThis.fetch = async () => {
      n += 1;
      return new Response('Forbidden', { status: 403 });
    };
    await assert.rejects(() => adapter.saveBook(book()), err => classifyApiError(err) === 'forbidden');
    assert.equal(n, 1);
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});

function seedV2Cache(modifiedTime = '2026-11-15T00:00:00Z') {
  localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
  localStorage.setItem(
    SHEETS_CACHE_STORAGE_KEY,
    JSON.stringify({
      spreadsheetId: 'sheet-1',
      modifiedTime,
      codecVersion: SHEETS_CACHE_CODEC_VERSION,
      state: { books: [book()], notes: [], sessions: [], deltaLogs: [] },
    })
  );
}

test('B4.7: Drive 403 rateLimitExceeded on the modifiedTime check keeps and serves the cache', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  const calls = [];
  try {
    seedV2Cache();
    const body = JSON.stringify({ error: { code: 403, errors: [{ reason: 'rateLimitExceeded', domain: 'usageLimits' }] } });
    globalThis.fetch = async url => {
      calls.push(String(url));
      if (String(url).includes('drive/v3/files/sheet-1')) return new Response(body, { status: 403 });
      return json({});
    };
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
    const ws = await adapter.loadWorkspace();
    assert.equal(ws.books.length, 1);
    assert.equal(ws.books[0].meta.subgenre, 'memoir');
    assert.equal(ws.isOfflineReadOnly, undefined);
    assert.ok(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY), 'cache must survive a rate-limited 403');
    assert.equal(localStorage.getItem(SPREADSHEET_ID_STORAGE_KEY), 'sheet-1');
    assert.equal(calls.filter(u => u.includes('drive/v3/files/sheet-1')).length, 3);
    assert.equal(calls.filter(u => u.includes('sheets.googleapis.com')).length, 0);
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});

test('B4.7: a plain Drive 403 still clears the cache and spreadsheet id', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  try {
    seedV2Cache();
    globalThis.fetch = async url => {
      const u = String(url);
      if (u.includes('drive/v3/files/sheet-1')) return new Response('Forbidden', { status: 403 });
      // Rediscovery then fails fast so the test stays focused on the cache decision.
      throw new TypeError('Failed to fetch');
    };
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
    await assert.rejects(() => adapter.loadWorkspace());
    assert.equal(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY), null);
    assert.equal(localStorage.getItem(SPREADSHEET_ID_STORAGE_KEY), null);
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});

// ---------------------------------------------------------------------------
// B4.8 / B4.9 / B4.10b / B4.11 pure helpers
// ---------------------------------------------------------------------------

test('B4.8: isNetworkError is tight', () => {
  assert.equal(isNetworkError(new TypeError('Cannot read properties of undefined (reading "x")')), false);
  assert.equal(isNetworkError(new TypeError('Failed to fetch')), true);
  assert.equal(isNetworkError(new TypeError('NetworkError when attempting to fetch resource.')), true);
  assert.equal(isNetworkError(new TypeError('Load failed')), true);
  assert.equal(isNetworkError(new OfflineReadOnlyError()), false);
  assert.equal(isNetworkError(new RowConflictError('a', 'b')), false);
  assert.equal(isNetworkError({ code: 'ROW_CONFLICT', message: 'offline' }), false);
  assert.equal(isNetworkError(new Error('API Error 503: offline')), false);
  assert.equal(isNetworkError(new Error('401 Unauthorized')), false);
  assert.equal(isNetworkError(null), false);
});

test('B4.9: parseHash never throws on malformed escapes', () => {
  assert.deepEqual(parseHash('#/note/%E0%A4'), { view: 'note', noteSlug: '%E0%A4', raw: '#/note/%E0%A4' });
  assert.equal(parseHash('#/book/%ZZ').bookId, '%ZZ');
  assert.equal(parseHash('#/note/caf%C3%A9').noteSlug, 'café');
  assert.equal(safeDecode('%'), '%');
  assert.equal(safeDecode('a%20b'), 'a b');
});

test('B4.10b: formatErrorReport', () => {
  const e = new TypeError('x is undefined');
  assert.equal(formatErrorReport(e), 'TypeError: x is undefined');
  assert.equal(
    formatErrorReport(e, { route: '#/note/a', when: '2026-11-16T00:00:00.000Z', userAgent: 'UA' }),
    'TypeError: x is undefined\nRoute: #/note/a\nWhen: 2026-11-16T00:00:00.000Z\nBrowser: UA'
  );
  assert.equal(formatErrorReport('plain'), 'Error: plain');
  assert.equal(formatErrorReport({ a: 1 }), 'Error: {"a":1}');
  assert.equal(formatErrorReport(new Error('')), 'Error: (no message)');
  assert.ok(!formatErrorReport(e).includes('at '), 'no stack trace by default');
});

test('B4.11: computeExpiresAt / isTokenExpired with injected now', () => {
  const now = 1_000_000;
  assert.equal(computeExpiresAt('3600', now), now + 3_600_000);
  assert.equal(computeExpiresAt(1, now), now + 1000);
  assert.equal(computeExpiresAt(null, now), null);
  assert.equal(computeExpiresAt('', now), null);
  assert.equal(computeExpiresAt('abc', now), null);
  assert.equal(computeExpiresAt('-5', now), null);
  assert.equal(isTokenExpired(null, now), false);
  assert.equal(isTokenExpired(now + 3_600_000, now), false);
  assert.equal(isTokenExpired(now + TOKEN_EXPIRY_SKEW_MS, now), true);
  const oneSecond = computeExpiresAt('1', now);
  assert.equal(isTokenExpired(oneSecond, now + 2000), true);
  assert.equal(parseStoredExpiresAt(String(now)), now);
  assert.equal(parseStoredExpiresAt('garbage'), null);
  assert.equal(parseStoredExpiresAt(null), null);
});

// ---------------------------------------------------------------------------
// Carry-forwards
// ---------------------------------------------------------------------------

test('R2#1: mergeUnknownMetaKeys restores agent keys a stale modal lacks, but not editor-owned deletions', () => {
  const stale = { updatedAt: 'a', startedAt: 's' };
  const latest = { updatedAt: 'b', startedAt: 's', coverUrl: 'https://c', subgenre: 'memoir', capstone: { arcOrThesis: 'x' } };
  const merged = mergeUnknownMetaKeys(stale, latest, BOOK_EDITOR_OWNED_META_KEYS);
  assert.equal(merged.subgenre, 'memoir');
  assert.deepEqual(merged.capstone, { arcOrThesis: 'x' });
  assert.equal('coverUrl' in merged, false, 'editor-owned deletion is respected');
  assert.equal(merged.updatedAt, 'a', 'edited values win');
  const noteMerged = mergeUnknownMetaKeys(
    { attachments: [], links: [] },
    { attachments: [{ id: 'x' }], links: ['l'], title: 'T', sparStage: { stage: 2 } },
    NOTE_EDITOR_OWNED_META_KEYS
  );
  assert.deepEqual(noteMerged, { attachments: [], links: [], sparStage: { stage: 2 } });
  assert.equal(mergeUnknownMetaKeys(stale, undefined, BOOK_EDITOR_OWNED_META_KEYS), stale);
});

test('R-4: mergeEditedAttachments keeps stored order and preserved entries in place', () => {
  const original = [
    { id: 'aud', type: 'audio', url: 'u' },
    { id: 'l1', type: 'link', url: 'https://1', title: '1' },
    'junk',
    { id: 'l2', type: 'link', url: 'https://2', title: '2' },
    { id: 'img', type: 'image', fileName: 'a.webp', mimeType: 'image/webp' },
    { id: 'l4', type: 'link', url: 'https://4', title: '4th (beyond cap)' },
  ];
  const { renderable } = splitAttachments(original);
  assert.deepEqual(renderable.map(a => a.id), ['l1', 'l2', 'img']);
  const edited = renderable
    .filter(a => a.id !== 'l2')
    .map(a => (a.id === 'l1' ? { ...a, title: 'renamed' } : a))
    .concat([{ id: 'new', type: 'link', url: 'https://n', title: 'n' }]);
  const merged = mergeEditedAttachments(original, edited);
  assert.deepEqual(
    merged.map(a => (typeof a === 'string' ? a : a.id)),
    ['aud', 'l1', 'junk', 'img', 'l4', 'new']
  );
  assert.equal(merged[1].title, 'renamed');
  assert.deepEqual(merged[0], original[0]);
  assert.deepEqual(mergeEditedAttachments(undefined, edited).map(a => a.id), ['l1', 'img', 'new']);
});

test('R2#5: serial-date math is shared by the codecs and the conflict guard', () => {
  assert.equal(toSheetSerial('46342'), 46342);
  assert.equal(toSheetSerial('४६३४२'), null);
  assert.equal(new Date(sheetSerialToMillis(46342.5)).toISOString(), '2026-11-16T12:00:00.000Z');
  assert.equal(decodeSheetTimestamp(46342.5), '2026-11-16T12:00:00.000Z');
  assert.equal(decodeSheetDate(46342), '2026-11-16');
  assert.equal(isRemoteNewer(46342.5, '2026-11-16T11:59:59.000Z'), true);
  assert.equal(isRemoteNewer(46342.5, '2026-11-16T12:00:00.000Z'), false);
  const src = fs.readFileSync(path.join(repoRoot, 'src/utils/conflictGuard.ts'), 'utf-8');
  assert.ok(!src.includes('25569') && !src.includes('2_958_466'), 'no duplicated serial constants');
});

test('Sanity: headers untouched (locked schema)', () => {
  assert.equal(BOOKS_HEADERS.length, 12);
  assert.equal(NOTES_HEADERS.length, 18);
  assert.equal(SESSIONS_HEADERS.length, 7);
  assert.equal(DELTA_LOGS_HEADERS.length, 5);
  assert.equal(bookToRow(book()).length, 12);
});

// ---------------------------------------------------------------------------
// Batch 3 fix-up
// ---------------------------------------------------------------------------

const {
  LAST_ACCOUNT_EMAIL_KEY,
  GOOGLE_USER_STORAGE_KEY,
  applySignedInAccount,
  forgetLastAccount,
  getPreviousAccountEmail,
  rememberCurrentAccount,
} = await load('src/utils/accountSession.ts');
const { CAPTURE_DRAFT_KEY, writeDraft, readDraft } = await load('src/utils/draftStorage.ts');
const { savePreImportBackup, readPreImportBackup, PRE_IMPORT_BACKUP_KEY } = await load('src/utils/importSafety.ts');

function seedAccountArtifacts() {
  writeDraft(CAPTURE_DRAFT_KEY, { takeaway: 'Account A private draft', updatedAt: 'x' });
  savePreImportBackup({ version: 1, exportedAt: 'x', books: [], notes: [], sessions: [], deltaLogs: [] });
  localStorage.setItem(SHEETS_CACHE_STORAGE_KEY, '{"a":1}');
  localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-a');
}

test('Fix-up R1#1: account switch after a clock-expired session still clears account A data', () => {
  localStorage.clear();
  try {
    // Device signed in as A before the durable marker existed (upgrade path).
    localStorage.setItem(GOOGLE_USER_STORAGE_KEY, JSON.stringify({ email: 'a@x.dev', name: 'A' }));
    seedAccountArtifacts();
    // Mount: seed the marker, then the expired-token cleanup removes the profile key.
    rememberCurrentAccount();
    localStorage.removeItem('pragya_google_token');
    localStorage.removeItem(GOOGLE_USER_STORAGE_KEY);
    assert.equal(getPreviousAccountEmail(), 'a@x.dev');

    // Account B signs in on this device.
    assert.equal(applySignedInAccount('b@x.dev'), true);
    assert.equal(readDraft(CAPTURE_DRAFT_KEY), null);
    assert.equal(readPreImportBackup(), null);
    assert.equal(localStorage.getItem(PRE_IMPORT_BACKUP_KEY), null);
    assert.equal(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY), null);
    assert.equal(localStorage.getItem(SPREADSHEET_ID_STORAGE_KEY), null);
    assert.equal(localStorage.getItem(LAST_ACCOUNT_EMAIL_KEY), 'b@x.dev');
  } finally {
    localStorage.clear();
  }
});

test('Fix-up R1#1: same account re-login keeps data; explicit logout forgets the account', () => {
  localStorage.clear();
  try {
    applySignedInAccount('a@x.dev');
    seedAccountArtifacts();
    assert.equal(applySignedInAccount('a@x.dev'), false);
    assert.ok(readDraft(CAPTURE_DRAFT_KEY));
    forgetLastAccount();
    assert.equal(getPreviousAccountEmail(), null);
    assert.equal(applySignedInAccount(''), false);
  } finally {
    localStorage.clear();
  }
});

function idCellFetch({ calls, colA, idAt, extra = [] }) {
  return makeFetch({
    calls,
    bookColA: colA,
    handlers: [
      ...extra,
      (u, method) => {
        const m = /\/values\/(Books|Sessions|DeltaLogs|Notes)!A(\d+)\?valueRenderOption=UNFORMATTED_VALUE/.exec(u);
        if (m && method === 'GET') return json({ values: [[idAt(m[1], Number(m[2]))]] });
        return null;
      },
    ],
  });
}

test('Fix-up R1#2: unguarded update (empty base) follows a shifted row; vanished → RowMovedError, no PUT', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
    let calls = [];
    let colAReads = 0;
    globalThis.fetch = idCellFetch({
      calls,
      colA: () => (++colAReads === 1 ? [['id'], ['book-1']] : [['id'], ['inserted'], ['book-1']]),
      idAt: (_tab, row) => ({ 2: 'inserted', 3: 'book-1' })[row] ?? '',
    });
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
    await adapter.saveBook(book(), { expectedBaseUpdatedAt: '' });
    const puts = calls.filter(c => c.method === 'PUT');
    assert.equal(puts.length, 1);
    assert.ok(puts[0].url.includes('Books!A3%3AL3'));

    calls = [];
    globalThis.fetch = idCellFetch({ calls, colA: [['id'], ['book-1']], idAt: () => 'someone-else' });
    await assert.rejects(() => adapter.saveBook(book(), { expectedBaseUpdatedAt: '' }), err => err instanceof RowMovedError);
    assert.equal(calls.filter(c => c.method === 'PUT').length, 0);
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});

test('Fix-up R1#2: saveSession / saveDeltaLog verify the id cell before the PUT', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
    const calls = [];
    globalThis.fetch = idCellFetch({
      calls,
      colA: [['id']],
      idAt: (tab, row) => (tab === 'Sessions' && row === 2 ? 'sess-1' : tab === 'DeltaLogs' && row === 2 ? 'log-1' : ''),
      extra: [
        u => (u.includes('/values/Sessions!A%3AA') ? json({ values: [['id'], ['sess-1']] }) : null),
        u => (u.includes('/values/DeltaLogs!A%3AA') ? json({ values: [['id'], ['log-1']] }) : null),
      ],
    });
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
    await adapter.saveSession({ id: 'sess-1', bookId: 'book-1', date: '2026-11-16', startPos: 1, endPos: 2, updatedAt: 'x', note: '' });
    await adapter.saveDeltaLog({ id: 'log-1', noteId: 'n', date: '2026-11-16', outcome: 'applied', reflection: '' });
    assert.ok(calls.some(c => c.method === 'GET' && /\/values\/Sessions!A2\?/.test(c.url)));
    assert.ok(calls.some(c => c.method === 'GET' && /\/values\/DeltaLogs!A2\?/.test(c.url)));
    assert.ok(calls.some(c => c.method === 'PUT' && c.url.includes('Sessions!A2%3AG2')));
    assert.ok(calls.some(c => c.method === 'PUT' && c.url.includes('DeltaLogs!A2%3AE2')));
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});

test('Fix-up R1#2: deleteSession re-verifies right before deleteDimension (shifted → right row; vanished → no batchUpdate)', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
    const sheetsMeta = u =>
      u.includes('fields=sheets.properties')
        ? json({ sheets: [{ properties: { sheetId: 22, title: 'Sessions' } }] })
        : null;
    let calls = [];
    let colAReads = 0;
    globalThis.fetch = idCellFetch({
      calls,
      colA: [['id']],
      // A:A first says row 3; a row was deleted elsewhere, so it is now row 2.
      idAt: (tab, row) => (tab === 'Sessions' ? ({ 2: 'sess-target', 3: 'sess-other' })[row] ?? '' : ''),
      extra: [
        sheetsMeta,
        u =>
          u.includes('/values/Sessions!A%3AA')
            ? json({ values: ++colAReads === 1 ? [['id'], ['sess-gone'], ['sess-target']] : [['id'], ['sess-target']] })
            : null,
      ],
    });
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
    await adapter.deleteSession('sess-target');
    const batch = calls.find(c => c.url.includes(':batchUpdate'));
    assert.ok(batch, 'expected a deleteDimension');
    const range = JSON.parse(String(batch.body)).requests[0].deleteDimension.range;
    assert.deepEqual([range.startIndex, range.endIndex], [1, 2]);

    calls = [];
    globalThis.fetch = idCellFetch({
      calls,
      colA: [['id']],
      idAt: () => 'sess-other',
      extra: [sheetsMeta, u => (u.includes('/values/Sessions!A%3AA') ? json({ values: [['id'], ['sess-target']] }) : null)],
    });
    await assert.rejects(() => adapter.deleteSession('sess-target'), err => err instanceof RowMovedError);
    assert.equal(calls.filter(c => c.url.includes(':batchUpdate')).length, 0);
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});

test('Batch 4 R2-a: deleteRowById is idempotent — id gone on re-resolve → false, no batchUpdate, no throw', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
    const calls = [];
    let colAReads = 0;
    globalThis.fetch = idCellFetch({
      calls,
      colA: [['id']],
      // Another device deleted sess-target between the first A:A read and the verify.
      idAt: (tab, row) => (tab === 'Sessions' && row === 2 ? 'sess-other' : ''),
      extra: [
        u =>
          u.includes('fields=sheets.properties')
            ? json({ sheets: [{ properties: { sheetId: 22, title: 'Sessions' } }] })
            : null,
        u =>
          u.includes('/values/Sessions!A%3AA')
            ? json({ values: ++colAReads === 1 ? [['id'], ['sess-target']] : [['id'], ['sess-other']] })
            : null,
      ],
    });
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
    assert.equal(await adapter.deleteRowById('Sessions', 'sess-target'), false);
    assert.equal(calls.filter(c => c.url.includes(':batchUpdate')).length, 0);
    colAReads = 0;
    await adapter.deleteSession('sess-target');
    assert.equal(calls.filter(c => c.url.includes(':batchUpdate')).length, 0);
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});

test('Batch 4 R2-b: account email compare is case-insensitive (no false switch, no data wipe)', () => {
  localStorage.clear();
  try {
    applySignedInAccount('Reader@Example.com');
    seedAccountArtifacts();
    assert.equal(applySignedInAccount('reader@example.com'), false);
    assert.equal(applySignedInAccount('  READER@EXAMPLE.COM '), false);
    assert.ok(readDraft(CAPTURE_DRAFT_KEY));
    assert.equal(localStorage.getItem(SPREADSHEET_ID_STORAGE_KEY), 'sheet-a');
    // A genuinely different account still switches.
    assert.equal(applySignedInAccount('other@example.com'), true);
    assert.equal(readDraft(CAPTURE_DRAFT_KEY), null);
  } finally {
    localStorage.clear();
  }
});

test('Fix-up R1#3 / R2#1: latest wins for non-editor keys; chapter keys are not editor-owned', () => {
  for (const key of ['currentChapter', 'chapter', 'exportedAt', 'ocrBackfilled']) {
    assert.equal(BOOK_EDITOR_OWNED_META_KEYS.includes(key) || NOTE_EDITOR_OWNED_META_KEYS.includes(key), false, key);
  }
  const bookOut = mergeUnknownMetaKeys(
    { updatedAt: 'E', currentChapter: 'Ch 2 (stale)', capstone: { arcOrThesis: 'stale' }, startedAt: 's' },
    { updatedAt: 'L', currentChapter: 'Ch 5', capstone: { arcOrThesis: 'new' }, startedAt: 'old', coverUrl: 'c' },
    BOOK_EDITOR_OWNED_META_KEYS
  );
  assert.equal(bookOut.currentChapter, 'Ch 5');
  assert.deepEqual(bookOut.capstone, { arcOrThesis: 'new' });
  assert.equal(bookOut.updatedAt, 'E');
  assert.equal(bookOut.startedAt, 's');
  assert.equal('coverUrl' in bookOut, false);
  const noteOut = mergeUnknownMetaKeys(
    { title: 'T', chapter: 'Ch 1 (stale)', exportedAt: 'old', attachments: [] },
    { title: 'Old', chapter: 'Ch 3', exportedAt: 'new', ocrBackfilled: true, attachments: [{ id: 'x' }] },
    NOTE_EDITOR_OWNED_META_KEYS
  );
  assert.deepEqual(noteOut, { title: 'T', chapter: 'Ch 3', exportedAt: 'new', ocrBackfilled: true, attachments: [] });
  // Per-call-site list (Batch 7 chapter editor): chapter owned → edited value wins.
  const owned = [...NOTE_EDITOR_OWNED_META_KEYS, 'chapter'];
  assert.equal(mergeUnknownMetaKeys({ chapter: 'Ch 9' }, { chapter: 'Ch 3' }, owned).chapter, 'Ch 9');
});

test('Fix-up R1#5 / QA-12: storageQuotaExceeded is not a rate limit; Drive daily/sharing limits are', () => {
  assert.equal(isRateLimitedText('storageQuotaExceeded'), false);
  assert.equal(isRateLimitedText('{"reason":"storageQuotaExceeded"}'), false);
  assert.equal(classifyApiError(new ApiError(403, JSON.stringify({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }))), 'forbidden');
  for (const reason of ['dailyLimitExceeded', 'sharingRateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']) {
    assert.equal(isRateLimitedText(`{"reason":"${reason}"}`), true, reason);
    assert.equal(classifyApiError(new ApiError(403, JSON.stringify({ error: { errors: [{ reason }] } }))), 'rate_limited', reason);
  }
});

test('Fix-up QA-11: Safari / Firefox transport messages are network errors', () => {
  for (const msg of ['The network connection was lost.', 'Load failed', 'NetworkError when attempting to fetch resource.', 'The Internet connection appears to be offline.']) {
    assert.equal(isNetworkError(new TypeError(msg)), true, msg);
  }
});

test('Fix-up R2#2: describeSyncError keeps per-site fallbacks', () => {
  assert.equal(describeSyncError(new ApiError(429, '{}'), 'Failed to save note'), RATE_LIMIT_TOAST);
  assert.equal(describeSyncError('nope', 'Failed to save note'), 'Failed to save note');
  assert.equal(describeSyncError(new Error(''), 'Failed to save note'), 'Failed to save note');
  const src = ['QuickCaptureModal', 'EditNoteModal', 'DeepenNoteModal'].map(f =>
    fs.readFileSync(path.join(repoRoot, `src/components/modals/${f}.tsx`), 'utf-8')
  );
  for (const s of src) assert.ok(!s.includes('err instanceof Error ? err.message'), 'raw error toasts removed');
});

test('Fix-up R2#3: a rate-limited freshness check flags the served cache', async () => {
  localStorage.clear();
  const orig = globalThis.fetch;
  try {
    seedV2Cache();
    globalThis.fetch = async url =>
      String(url).includes('drive/v3/files/sheet-1') ? new Response('{"error":{"code":429}}', { status: 429 }) : json({});
    const ws = await new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep }).loadWorkspace();
    assert.equal(ws.servedFromCacheDueToRateLimit, true);
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
});
