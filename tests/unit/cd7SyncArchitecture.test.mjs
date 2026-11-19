import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);
const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const batchPlan = await load('src/utils/batchPlan.ts');
const idbStore = await load('src/utils/idbStore.ts');
const importSafety = await load('src/utils/importSafety.ts');
const accountSession = await load('src/utils/accountSession.ts');
const mutations = await load('src/context/pragyaMutations.ts');
const conflictGuard = await load('src/utils/conflictGuard.ts');
const apiErrors = await load('src/utils/apiErrors.ts');
const sheetCodecs = await load('src/utils/sheetCodecs.ts');
const {
  GoogleSheetsAdapter,
  PartialBatchCommitError,
  SHEETS_CACHE_CODEC_VERSION,
  SHEETS_CACHE_STORAGE_KEY,
  SPREADSHEET_ID_STORAGE_KEY,
} = await load('src/services/googleSheetsAdapter.ts');
const { DemoStorageAdapter, DEMO_STATE_STORAGE_KEY } = await load('src/services/demoAdapter.ts');

const noSleep = async () => {};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Spec-faithful minimal fake IDBFactory for Node unit tests. */
function createFakeIdbFactory({ failOpen = false, failPut = false, failGet = false } = {}) {
  const stores = new Map(); // storeName -> Map<key, value>
  const state = { failOpen, failPut, failGet, stores };

  const schedule = fn => queueMicrotask(fn);

  const factory = {
    open(_name, _version) {
      const req = {
        result: null,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      schedule(() => {
        if (state.failOpen) {
          req.error = new Error('IDB open blocked');
          req.onerror?.({ target: req });
          return;
        }
        const db = {
          onversionchange: null,
          objectStoreNames: {
            contains: name => stores.has(name),
          },
          createObjectStore: name => {
            if (!stores.has(name)) stores.set(name, new Map());
          },
          close() {},
          transaction(storeName, _mode) {
            const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
            const map = stores.get(storeName);
            return {
              ...tx,
              set oncomplete(fn) {
                tx.oncomplete = fn;
              },
              get oncomplete() {
                return tx.oncomplete;
              },
              set onerror(fn) {
                tx.onerror = fn;
              },
              get onerror() {
                return tx.onerror;
              },
              set onabort(fn) {
                tx.onabort = fn;
              },
              get onabort() {
                return tx.onabort;
              },
              objectStore() {
                return {
                  get(key) {
                    const gReq = { result: undefined, error: null, onsuccess: null, onerror: null };
                    schedule(() => {
                      if (state.failGet) {
                        gReq.error = new Error('IDB get failed');
                        gReq.onerror?.({ target: gReq });
                        return;
                      }
                      gReq.result = map?.get(key);
                      gReq.onsuccess?.({ target: gReq });
                      tx.oncomplete?.();
                    });
                    return gReq;
                  },
                  put(val, key) {
                    schedule(() => {
                      if (state.failPut) {
                        tx.error = new Error('QuotaExceededError');
                        tx.onerror?.({ target: tx });
                        return;
                      }
                      map.set(key, val);
                      tx.oncomplete?.();
                    });
                    return {};
                  },
                  delete(key) {
                    schedule(() => {
                      map?.delete(key);
                      tx.oncomplete?.();
                    });
                    return {};
                  },
                  clear() {
                    schedule(() => {
                      map?.clear();
                      tx.oncomplete?.();
                    });
                    return {};
                  },
                };
              },
            };
          },
        };
        req.result = db;
        if (!stores.has(idbStore.IDB_CACHE_STORE_NAME)) {
          req.onupgradeneeded?.({ target: req });
        }
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };

  return { factory, state, getKv: () => stores.get(idbStore.IDB_CACHE_STORE_NAME) || new Map() };
}

function makeBook(overrides = {}) {
  return {
    id: 'book-1',
    title: 'Thinking in Systems',
    author: 'Donella Meadows',
    format: 'physical',
    kind: 'nonfiction',
    status: 'reading',
    currentPos: 50,
    totalPos: 200,
    posUnit: 'page',
    normalizedPos: 0.25,
    docUrl: '',
    meta: { updatedAt: '2026-11-15T10:00:00.000Z', subgenre: 'systems' },
    ...overrides,
  };
}

function makeNote(overrides = {}) {
  return {
    id: 'note-new-1',
    slug: 'feedback-loops',
    bookId: 'book-1',
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
    pos: 80,
    normalizedPos: 0.4,
    status: 'saved',
    source: 'app',
    tags: ['#systems'],
    quote: 'A system is more than the sum of its parts.',
    takeaway: 'Delays create oscillation.',
    contextMechanism: '',
    critique: '',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none',
    meta: { attachments: [], links: [] },
    ...overrides,
  };
}

function makeSession(overrides = {}) {
  return {
    id: 'sess-1',
    bookId: 'book-1',
    date: '2026-11-16',
    startPos: 50,
    endPos: 80,
    updatedAt: '2026-11-16T10:00:00.000Z',
    note: '',
    ...overrides,
  };
}

/** In-memory Sheets backend simulator that faithfully handles values:batchGet/batchUpdate/:append. */
function createSheetsMock({
  books = [makeBook()],
  notes = [],
  sessions = [],
  deltaLogs = [],
  modifiedTime = '2026-11-15T10:00:00Z',
  onRequest,
} = {}) {
  const sheetData = {
    Books: [sheetCodecs.BOOKS_HEADERS, ...books.map(sheetCodecs.bookToRow)],
    Notes: [sheetCodecs.NOTES_HEADERS, ...notes.map(sheetCodecs.noteToRow)],
    Sessions: [sheetCodecs.SESSIONS_HEADERS, ...sessions.map(sheetCodecs.sessionToRow)],
    DeltaLogs: [sheetCodecs.DELTA_LOGS_HEADERS, ...deltaLogs.map(sheetCodecs.deltaLogToRow)],
  };
  let curModifiedTime = modifiedTime;
  const calls = [];

  const readRange = rangeStr => {
    const clean = rangeStr.replace(/'/g, '');
    const [tab, a1] = clean.split('!');
    const rows = sheetData[tab] || [];
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(a1);
    if (!m) return rows;
    const c1 = batchPlan.columnIndex(m[1]);
    const r1 = m[2] ? Number(m[2]) - 1 : 0;
    const c2 = m[3] ? batchPlan.columnIndex(m[3]) : c1;
    const r2 = m[4] ? Number(m[4]) - 1 : rows.length - 1;
    const out = [];
    for (let r = r1; r <= r2 && r < rows.length; r += 1) {
      out.push(rows[r].slice(c1, c2 + 1));
    }
    return out;
  };

  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    calls.push({ method, url: u, body });

    if (onRequest) {
      const override = await onRequest({ method, url: u, body, sheetData, calls });
      if (override !== undefined) return override;
    }

    if (u.includes('drive/v3/files/sheet-cd7')) {
      return json({ id: 'sheet-cd7', name: 'Pragya Commonplace', modifiedTime: curModifiedTime });
    }
    if (u.includes('fields=sheets.properties')) {
      return json({
        sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map((title, idx) => ({
          properties: { sheetId: idx + 1, title },
        })),
      });
    }
    if (u.includes('values:batchGet')) {
      const parsed = new URL(u);
      const ranges = parsed.searchParams.getAll('ranges');
      const valueRanges = ranges.map(r => {
        const clean = r.replace(/'/g, '');
        const [tab, a1] = clean.split('!');
        const rows = sheetData[tab] || [];
        // Echo Sheets-style concrete bounds for column ranges (e.g. Books!A:A -> 'Books'!A1:A5)
        const echoedRange = /^[A-Z]+:[A-Z]+$/.test(a1)
          ? `'${tab}'!${a1.split(':')[0]}1:${a1.split(':')[1]}${Math.max(1, rows.length)}`
          : r;
        return { range: echoedRange, values: readRange(r) };
      });
      return json({ valueRanges });
    }
    if (u.includes('values:batchUpdate') && method === 'POST') {
      curModifiedTime = '2026-11-16T10:00:01Z';
      for (const item of body.data || []) {
        const [tab, a1] = item.range.split('!');
        const m = /^A(\d+):/.exec(a1);
        if (m) {
          const rowIdx = Number(m[1]) - 1;
          sheetData[tab][rowIdx] = item.values[0];
        }
      }
      return json({ totalUpdatedRows: (body.data || []).length });
    }
    if (u.includes(':append') && method === 'POST') {
      curModifiedTime = '2026-11-16T10:00:02Z';
      const m = /\/values\/([^/?:]+)!A1:append/.exec(decodeURIComponent(u));
      const tab = m?.[1];
      const startRow = sheetData[tab].length + 1;
      for (const row of body.values || []) {
        sheetData[tab].push(row);
      }
      const endRow = sheetData[tab].length;
      const lastCol = batchPlan.BATCH_TAB_META[tab].lastCol;
      return json({
        updates: { updatedRange: `${tab}!A${startRow}:${lastCol}${endRow}` },
      });
    }
    return json({});
  };

  return { fetchImpl, calls, sheetData, setModifiedTime: v => (curModifiedTime = v) };
}

// ---------------------------------------------------------------------------
// 1. batchPlan pure utilities
// ---------------------------------------------------------------------------

test('CD7 batchPlan: normalizeBatchOps enforces Books→Notes→Sessions→DeltaLogs order & dedupes', () => {
  const b1 = makeBook({ title: 'First' });
  const b1Updated = makeBook({ title: 'Second' });
  const n1 = makeNote();
  const s1 = makeSession();
  const d1 = { id: 'dl-1', noteId: 'note-new-1', date: '2026-11-16', outcome: 'applied', reflection: '' };

  const out = batchPlan.normalizeBatchOps([
    { kind: 'deltaLog', deltaLog: d1 },
    { kind: 'session', session: s1 },
    { kind: 'book', book: b1, expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z' },
    { kind: 'note', note: n1 },
    { kind: 'book', book: b1Updated },
  ]);

  assert.deepEqual(
    out.map(x => x.tab),
    ['Books', 'Notes', 'Sessions', 'DeltaLogs']
  );
  assert.equal(out[0].op.book.title, 'Second');
  assert.equal(out[0].expectedBaseUpdatedAt, '2026-11-15T10:00:00.000Z');
});

test('CD7 batchPlan: matchBatchValueRanges distinguishes same-tab multi-ranges & quoted echoes', () => {
  const requested = ['Books!A:A', 'Books!L:L', 'Books!A2:L2', 'Sessions!A3'];
  const vrs = [
    { range: "'Books'!L1:L5", values: [['metaJson'], ['{"updatedAt":"T1"}']] },
    { range: "'Books'!A1:A5", values: [['id'], ['book-1']] },
    { range: 'Sessions!A3', values: [['sess-1']] },
    { range: 'Books!A2:L2', values: [['book-1', 'T', '', '', '', '', 50, 200, 'page', 0.25, '', '{"updatedAt":"T1"}']] },
  ];
  const matched = batchPlan.matchBatchValueRanges(requested, vrs);
  assert.deepEqual(matched.get('Books!A:A'), [['id'], ['book-1']]);
  assert.deepEqual(matched.get('Books!L:L'), [['metaJson'], ['{"updatedAt":"T1"}']]);
  assert.equal(matched.get('Books!A2:L2')?.[0]?.[0], 'book-1');
  assert.deepEqual(matched.get('Sessions!A3'), [['sess-1']]);
});

// ---------------------------------------------------------------------------
// 2. GoogleSheetsAdapter.batchCommitMutations — HTTP counts, conflicts, relocation, 429
// ---------------------------------------------------------------------------

test('CD7 batchCommitMutations: capture+advance cuts HTTP calls to <= 5 (warm & cold) and preserves Books before Sessions', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const origFetch = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-cd7');
    const mock = createSheetsMock();
    globalThis.fetch = mock.fetchImpl;
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, 'reader@pragya.dev', { sleep: noSleep });

    // Load once to warm rowHints + v2 cache.
    await adapter.loadWorkspace();
    mock.calls.length = 0;

    // 1. Warm capture + advance (existing Book update + new Note append + new Session append) -> 5 calls
    const advancedBook = makeBook({
      currentPos: 80,
      normalizedPos: 0.4,
      meta: { updatedAt: '2026-11-16T10:00:00.000Z', subgenre: 'systems' },
    });
    const newNote = makeNote();
    const newSession = makeSession({ id: 'sess-new-1', endPos: 80 });

    await adapter.batchCommitMutations([
      { kind: 'session', session: newSession },
      { kind: 'note', note: newNote },
      { kind: 'book', book: advancedBook, expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z' },
    ]);

    assert.ok(mock.calls.length <= 5, `Expected <= 5 HTTP calls, got ${mock.calls.length}`);
    assert.equal(mock.calls.length, 5);
    assert.ok(mock.calls[0].url.includes('values:batchGet'));
    assert.ok(mock.calls[1].url.includes('values:batchUpdate'));
    assert.equal(mock.calls[1].body.valueInputOption, 'RAW');
    assert.equal(mock.calls[1].body.data[0].range, 'Books!A2:L2');
    assert.ok(decodeURIComponent(mock.calls[2].url).includes('Notes!A1:append'));
    assert.ok(decodeURIComponent(mock.calls[3].url).includes('Sessions!A1:append'));
    assert.ok(mock.calls[4].url.includes('drive/v3/files/sheet-cd7'));

    // 2. Capture + advance with COALESCED session (Book + Session updated in ONE batchUpdate) -> 4 calls
    mock.calls.length = 0;
    const advancedBook2 = makeBook({
      currentPos: 100,
      normalizedPos: 0.5,
      meta: { updatedAt: '2026-11-16T10:05:00.000Z', subgenre: 'systems' },
    });
    const note2 = makeNote({ id: 'note-new-2', slug: 'second-note', pos: 100 });
    const coalescedSession = makeSession({ id: 'sess-new-1', endPos: 100 });

    await adapter.batchCommitMutations([
      { kind: 'session', session: coalescedSession },
      { kind: 'note', note: note2 },
      { kind: 'book', book: advancedBook2, expectedBaseUpdatedAt: '2026-11-16T10:00:00.000Z' },
    ]);

    assert.equal(mock.calls.length, 4, 'Coalesced capture+advance should take exactly 4 HTTP calls');
    const batchUp = mock.calls.find(c => c.url.includes('values:batchUpdate'));
    assert.deepEqual(
      batchUp.body.data.map(d => d.range),
      ['Books!A2:L2', 'Sessions!A2:G2'],
      'Books must precede Sessions inside values:batchUpdate'
    );

    // 3. Cold adapter (no rowHints, hydrated from cache) -> STILL <= 5 HTTP calls!
    const coldAdapter = new GoogleSheetsAdapter(() => 'tok', undefined, 'reader@pragya.dev', { sleep: noSleep });
    mock.calls.length = 0;
    const advancedBook3 = makeBook({
      currentPos: 120,
      normalizedPos: 0.6,
      meta: { updatedAt: '2026-11-16T10:10:00.000Z', subgenre: 'systems' },
    });
    await coldAdapter.batchCommitMutations([
      { kind: 'book', book: advancedBook3, expectedBaseUpdatedAt: '2026-11-16T10:05:00.000Z' },
      { kind: 'note', note: makeNote({ id: 'note-new-3', slug: 'third-note', pos: 120 }) },
      { kind: 'session', session: makeSession({ id: 'sess-brand-new', endPos: 120 }) },
    ]);
    assert.ok(mock.calls.length <= 5, `Cold capture+advance expected <= 5 HTTP calls, got ${mock.calls.length}`);
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
    idbStore.resetIdbStoreForTests();
  }
});

test('CD7 batchCommitMutations: conflict on Book aborts ENTIRE batch with ZERO writes (no Note/Session written)', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const origFetch = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-cd7');
    const mock = createSheetsMock({
      books: [makeBook({ meta: { updatedAt: '2026-11-16T12:00:00.000Z', subgenre: 'systems' } })],
    });
    globalThis.fetch = mock.fetchImpl;
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });

    await assert.rejects(
      () =>
        adapter.batchCommitMutations([
          {
            kind: 'book',
            book: makeBook({ currentPos: 90, meta: { updatedAt: '2026-11-16T12:05:00.000Z' } }),
            expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z', // stale!
          },
          { kind: 'note', note: makeNote() },
          { kind: 'session', session: makeSession() },
        ]),
      conflictGuard.RowConflictError
    );

    const writeCalls = mock.calls.filter(c => c.method === 'POST' || c.method === 'PUT');
    assert.equal(writeCalls.length, 0, 'ZERO write requests may occur when any row conflicts');
    assert.equal(mock.sheetData.Notes.length, 1, 'No note row appended');
    assert.equal(mock.sheetData.Sessions.length, 1, 'No session row appended');
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
    idbStore.resetIdbStoreForTests();
  }
});

test('CD7 batchCommitMutations: row-ID verification follows shifted row and aborts with RowMovedError when vanished', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const origFetch = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-cd7');
    const mock = createSheetsMock({ books: [makeBook()] });
    globalThis.fetch = mock.fetchImpl;
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });

    // Warm hint: book-1 is at row 2 (index 1).
    await adapter.loadWorkspace();

    // Another device inserts a new book ABOVE book-1 so book-1 shifts from row 2 -> row 3!
    const insertedRow = sheetCodecs.bookToRow(makeBook({ id: 'book-0-inserted', title: 'Inserted Above' }));
    mock.sheetData.Books.splice(1, 0, insertedRow);
    mock.calls.length = 0;

    const updatedBook = makeBook({
      currentPos: 95,
      normalizedPos: 0.475,
      meta: { updatedAt: '2026-11-16T11:00:00.000Z', subgenre: 'systems' },
    });
    await adapter.batchCommitMutations([
      { kind: 'book', book: updatedBook, expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z' },
      { kind: 'session', session: makeSession({ id: 'sess-reloc', endPos: 95 }) },
    ]);

    const batchUp = mock.calls.find(c => c.url.includes('values:batchUpdate'));
    assert.equal(batchUp.body.data[0].range, 'Books!A3:L3', 'Must write to relocated row 3, never stale row 2');
    assert.equal(mock.sheetData.Books[1][0], 'book-0-inserted', 'Inserted row at index 1 untouched');
    assert.equal(mock.sheetData.Books[2][6], 95, 'Relocated row updated');

    // Now simulate book-1 deleted remotely -> re-resolve fails -> RowMovedError with ZERO writes!
    mock.sheetData.Books.splice(2, 1);
    mock.calls.length = 0;

    await assert.rejects(
      () =>
        adapter.batchCommitMutations([
          { kind: 'book', book: updatedBook, expectedBaseUpdatedAt: '2026-11-16T11:00:00.000Z' },
          { kind: 'note', note: makeNote({ id: 'note-should-not-write' }) },
        ]),
      conflictGuard.RowMovedError
    );
    assert.equal(
      mock.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length,
      0,
      'Vanished row must abort with ZERO writes'
    );
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
    idbStore.resetIdbStoreForTests();
  }
});

test('CD7 batchCommitMutations: 429 retries safely with backoff; ambiguous append error NEVER retries; 429 on modifiedTime keeps v2 cache', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const origFetch = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-cd7');
    const sleeps = [];
    let append429Remaining = 1;
    let drive429Active = false;

    const mock = createSheetsMock({
      onRequest: ({ url, method }) => {
        if (method === 'POST' && url.includes(':append') && append429Remaining > 0) {
          append429Remaining -= 1;
          return json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429);
        }
        if (drive429Active && url.includes('drive/v3/files/sheet-cd7')) {
          return json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429);
        }
        return undefined;
      },
    });
    globalThis.fetch = mock.fetchImpl;
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, {
      sleep: async ms => {
        sleeps.push(ms);
      },
    });
    await adapter.loadWorkspace();

    // 1. 429 on :append retries once (500ms backoff) and succeeds without duplicating row;
    //    429 on Drive modifiedTime preserves v2 cache!
    drive429Active = true;
    await adapter.batchCommitMutations([
      { kind: 'book', book: makeBook({ currentPos: 70, meta: { updatedAt: '2026-11-16T09:00:00Z' } }), expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z' },
      { kind: 'note', note: makeNote({ id: 'note-retry-ok' }) },
    ]);
    assert.equal(sleeps[0], 500, 'Expected 500ms backoff on first 429');
    assert.equal(mock.sheetData.Notes.filter(r => r[0] === 'note-retry-ok').length, 1, 'Note appended exactly once');
    const cachedRaw = localStorage.getItem(SHEETS_CACHE_STORAGE_KEY);
    assert.ok(cachedRaw, '429 on post-mutation modifiedTime must NOT wipe cache');
    const cached = JSON.parse(cachedRaw);
    assert.equal(cached.codecVersion, SHEETS_CACHE_CODEC_VERSION);
    assert.equal(cached.modifiedTime, '2026-11-15T10:00:00Z', 'Retains previous modifiedTime so next sync detects drift');

    // 2. Ambiguous network error on :append NEVER retries (exactly 1 POST attempt -> zero duplication hazard)
    drive429Active = false;
    let appendAttempts = 0;
    const mockAmb = createSheetsMock({
      onRequest: ({ url, method }) => {
        if (method === 'POST' && url.includes(':append')) {
          appendAttempts += 1;
          throw new TypeError('Failed to fetch');
        }
        return undefined;
      },
    });
    globalThis.fetch = mockAmb.fetchImpl;
    await assert.rejects(
      () => adapter.batchCommitMutations([{ kind: 'note', note: makeNote({ id: 'note-amb' }) }]),
      /Failed to fetch/
    );
    assert.equal(appendAttempts, 1, 'Ambiguous network failure on non-idempotent :append must NEVER retry');
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
    idbStore.resetIdbStoreForTests();
  }
});

test('CD7 DemoStorageAdapter.batchCommitMutations: applies Book+Note+Session in one atomic write', async () => {
  localStorage.clear();
  try {
    const adapter = new DemoStorageAdapter();
    const initial = await adapter.loadWorkspace();
    const targetBook = { ...initial.books[0], currentPos: initial.books[0].currentPos + 15 };
    const newNote = makeNote({ id: 'demo-batch-note', bookId: targetBook.id });
    const newSession = makeSession({ id: 'demo-batch-sess', bookId: targetBook.id });

    let setItemCount = 0;
    const origSet = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (k, v) => {
      if (k === DEMO_STATE_STORAGE_KEY) setItemCount += 1;
      return origSet(k, v);
    };
    try {
      const res = await adapter.batchCommitMutations([
        { kind: 'book', book: targetBook },
        { kind: 'note', note: newNote },
        { kind: 'session', session: newSession },
      ]);
      assert.equal(setItemCount, 1, 'Demo batchCommitMutations writes localStorage once');
      assert.equal(res.books.length, 1);
      assert.equal(res.notes.length, 1);
      assert.equal(res.sessions.length, 1);
    } finally {
      localStorage.setItem = origSet;
    }

    const after = await adapter.loadWorkspace();
    assert.ok(after.notes.some(n => n.id === 'demo-batch-note'));
    assert.ok(after.sessions.some(s => s.id === 'demo-batch-sess'));
  } finally {
    localStorage.clear();
  }
});

// ---------------------------------------------------------------------------
// 3. IndexedDB store, localStorage migration, fallback & account-switch wipe
// ---------------------------------------------------------------------------

test('CD7 idbStore: writes to IndexedDB (keeping localStorage clean), migrates legacy localStorage keys once, and clears on account switch', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const fake = createFakeIdbFactory();
  idbStore.setIndexedDbForTests(fake.factory);
  const origFetch = globalThis.fetch;

  try {
    // 1. Transparent one-time migration from localStorage -> IndexedDB (sheets cache & pre-import backup)
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-mig');
    const legacyCache = {
      spreadsheetId: 'sheet-mig',
      modifiedTime: '2026-11-15T10:00:00Z',
      accountEmail: 'a@pragya.dev',
      codecVersion: SHEETS_CACHE_CODEC_VERSION,
      state: { books: [makeBook({ title: 'Migrated Book' })], notes: [], sessions: [], deltaLogs: [] },
    };
    localStorage.setItem(SHEETS_CACHE_STORAGE_KEY, JSON.stringify(legacyCache));
    const backupSnap = { version: 1, exportedAt: '2026-11-15T00:00:00Z', books: [makeBook()], notes: [], sessions: [], deltaLogs: [] };
    localStorage.setItem(
      importSafety.PRE_IMPORT_BACKUP_KEY,
      JSON.stringify({ savedAt: '2026-11-15T01:00:00Z', snapshot: backupSnap })
    );

    // Offline load migrates pragya_sheets_cache_v1 from localStorage -> IndexedDB and deletes localStorage copy!
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, 'a@pragya.dev', { sleep: noSleep });
    const offlineWs = await adapter.loadWorkspace();
    assert.equal(offlineWs.isOfflineReadOnly, true);
    assert.equal(offlineWs.books[0].title, 'Migrated Book');
    assert.equal(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY), null, 'Legacy localStorage cache removed after IDB migration');
    assert.ok(fake.getKv().has(SHEETS_CACHE_STORAGE_KEY), 'Cache now resides in IndexedDB kv store');

    // Reading pre-import backup migrates it from localStorage -> IndexedDB and deletes localStorage copy!
    const migratedBackup = await importSafety.readPreImportBackupAsync();
    assert.equal(migratedBackup?.savedAt, '2026-11-15T01:00:00Z');
    assert.equal(localStorage.getItem(importSafety.PRE_IMPORT_BACKUP_KEY), null, 'Legacy localStorage backup removed after IDB migration');
    assert.ok(fake.getKv().has(importSafety.PRE_IMPORT_BACKUP_KEY), 'Backup now resides in IndexedDB kv store');

    // Second read comes straight from IndexedDB!
    const secondOffline = await adapter.loadWorkspace();
    assert.equal(secondOffline.books[0].title, 'Migrated Book');

    // 2. Writing a new pre-import backup goes straight to IndexedDB, never touching localStorage
    await importSafety.savePreImportBackupAsync(backupSnap, '2026-11-16T05:00:00Z');
    assert.equal(localStorage.getItem(importSafety.PRE_IMPORT_BACKUP_KEY), null);
    assert.equal((await importSafety.readPreImportBackupAsync())?.savedAt, '2026-11-16T05:00:00Z');

    // 3. Account switch wipes BOTH IndexedDB and localStorage cleanly (even via sync applySignedInAccount!)
    accountSession.applySignedInAccount('a@pragya.dev');
    assert.equal(accountSession.applySignedInAccount('b@pragya.dev'), true);
    // Do NOT manually flush — FIFO queue guarantees the very next read sees null!
    assert.equal(await idbStore.idbGetWithMigration(SHEETS_CACHE_STORAGE_KEY), null);
    assert.equal(await importSafety.readPreImportBackupAsync(), null);
    assert.equal(fake.getKv().size, 0, 'IndexedDB kv store completely empty after account switch');
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
    idbStore.resetIdbStoreForTests();
  }
});

test('CD7 idbStore: graceful fallback when IndexedDB is blocked AND when localStorage throws QuotaExceededError', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const blockedIdb = createFakeIdbFactory({ failOpen: true, failPut: true, failGet: true });
  idbStore.setIndexedDbForTests(blockedIdb.factory);

  try {
    // 1. IDB blocked -> falls back cleanly to localStorage
    await idbStore.idbSet('k1', 'from-ls');
    assert.equal(localStorage.getItem('k1'), 'from-ls');
    assert.equal(await idbStore.idbGetWithMigration('k1'), 'from-ls');

    // 2. BOTH IDB blocked AND localStorage throws QuotaExceededError -> falls back cleanly to memory Map!
    const origSet = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      const ok = await idbStore.idbSet('k2', 'from-memory');
      assert.equal(ok, true);
      assert.equal(await idbStore.idbGetWithMigration('k2'), 'from-memory');
      await idbStore.idbDelete('k2');
      assert.equal(await idbStore.idbGetWithMigration('k2'), null);
    } finally {
      localStorage.setItem = origSet;
    }
  } finally {
    localStorage.clear();
    idbStore.resetIdbStoreForTests();
  }
});

test('CD7 idbStore: offline legacy-codec migration preserves codecVersion=undefined (never promotes stale cache to v2)', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const fake = createFakeIdbFactory();
  idbStore.setIndexedDbForTests(fake.factory);
  const origFetch = globalThis.fetch;

  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-stale');
    localStorage.setItem(
      SHEETS_CACHE_STORAGE_KEY,
      JSON.stringify({
        spreadsheetId: 'sheet-stale',
        modifiedTime: '2026-11-15T00:00:00Z',
        state: { books: [makeBook({ meta: { updatedAt: 'x' } })], notes: [], sessions: [], deltaLogs: [] },
      })
    );
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const adapter = new GoogleSheetsAdapter(() => 'tok');
    const ws = await adapter.loadWorkspace();
    assert.equal(ws.isOfflineReadOnly, true);
    const storedInIdb = JSON.parse(fake.getKv().get(SHEETS_CACHE_STORAGE_KEY));
    assert.equal(storedInIdb.codecVersion, undefined, 'Migrated legacy cache must NOT be promoted to v2');
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
    idbStore.resetIdbStoreForTests();
  }
});

// ---------------------------------------------------------------------------
// 4. pragyaMutations pure planners & PragyaContext split / stability invariants
// ---------------------------------------------------------------------------

test('CD7 pragyaMutations: pure planners preserve meta merges, everFinished, aliases, 5/5 delta cap, N1 warnings & capture batching', () => {
  const book = makeBook({ status: 'finished', currentPos: 200, normalizedPos: 1, meta: { updatedAt: 'T0', subgenre: 'systems', customX: 42 } });

  // Leaving finished sets everFinished=true, merges unknown keys, and flags non-owned meta edits for N1
  const bookPlan = mutations.planUpdatedBook(
    { ...book, status: 'reading', meta: { ...book.meta, subgenre: 'tampered' } },
    book,
    { baseMeta: book.meta, expectedBaseUpdatedAt: 'T0' },
    'T1'
  );
  assert.equal(bookPlan.nextBook.meta.everFinished, true);
  assert.equal(bookPlan.nextBook.meta.customX, 42);
  assert.equal(bookPlan.nextBook.meta.subgenre, 'systems', 'Non-owned key keeps latest loaded value');
  assert.deepEqual(bookPlan.overriddenMetaKeys, ['subgenre']);
  assert.equal(bookPlan.expectedBaseUpdatedAt, 'T0');

  // Capture with advancing pos plans 3 ops (Book + Note + Session)
  const readingBook = makeBook({ currentPos: 50, totalPos: 200, meta: { updatedAt: 'T0' } });
  const advCapture = mutations.planCaptureWithAdvance(
    { bookId: readingBook.id, pos: 80, takeaway: 'Loops matter', tags: ['systems'] },
    readingBook,
    [],
    [],
    '2026-11-16T10:00:00.000Z',
    'note-cap-1'
  );
  assert.ok(advCapture.advance, 'Expected advance plan when pos > currentPos');
  assert.deepEqual(
    advCapture.ops.map(o => o.kind),
    ['book', 'note', 'session']
  );

  // Capture at or behind currentPos plans only 1 op (Note)
  const noAdvCapture = mutations.planCaptureWithAdvance(
    { bookId: readingBook.id, pos: 40, takeaway: 'Earlier thought', tags: [] },
    readingBook,
    [],
    [],
    '2026-11-16T10:00:00.000Z',
    'note-cap-2'
  );
  assert.equal(noAdvCapture.advance, null);
  assert.deepEqual(noAdvCapture.ops.map(o => o.kind), ['note']);

  // Note update: slug rename adds alias, 5/5 active delta cap enforced, preserveUpdatedAt honored
  const existingNote = makeNote({ id: 'n1', slug: 'old-slug', updatedAt: 'T-OLD', meta: { attachments: [], links: [], sparStage: 2 } });
  const notePlan = mutations.planUpdatedNote(
    { ...existingNote, slug: 'new-slug' },
    existingNote,
    readingBook,
    [existingNote],
    { preserveUpdatedAt: true },
    'T-NOW'
  );
  assert.equal(notePlan.nextNote.updatedAt, 'T-OLD');
  assert.deepEqual(notePlan.nextNote.meta.aliases, ['old-slug']);
  assert.equal(notePlan.nextNote.meta.sparStage, 2);

  const fiveActive = Array.from({ length: 5 }, (_, i) =>
    makeNote({ id: `act-${i}`, slug: `act-${i}`, deltaStatus: 'active' })
  );
  assert.throws(
    () => mutations.planUpdatedNote({ ...existingNote, deltaStatus: 'active' }, existingNote, readingBook, [...fiveActive, existingNote]),
    /5\/5/
  );
});

test('CD7 PragyaContext & AuthContext architectural invariants: Data/Actions split, stable actions deps, sessionEpoch, R1#3 ordering', () => {
  const ctxSrc = read('src/context/PragyaContext.tsx');
  assert.ok(ctxSrc.includes('const PragyaDataContext = createContext'));
  assert.ok(ctxSrc.includes('const PragyaActionsContext = createContext'));
  assert.ok(ctxSrc.includes('export function usePragyaData()'));
  assert.ok(ctxSrc.includes('export function usePragyaActions()'));
  assert.ok(ctxSrc.includes('export function usePragya()'));
  assert.ok(ctxSrc.includes('const dataValue = useMemo<PragyaDataContextValue>'));
  assert.ok(ctxSrc.includes('const actionsValue = useMemo<PragyaActionsContextValue>'));
  assert.ok(ctxSrc.includes('activeAdapter.batchCommitMutations'));
  assert.ok(ctxSrc.includes('savePreImportBackupAsync'));
  // R1#1 + R1#2 invariants in PragyaContext
  assert.ok(ctxSrc.includes('sessionEpochRef'), 'PragyaContext must scope queued mutations by sessionEpochRef');
  assert.ok(ctxSrc.includes('isCurrentSession'), 'PragyaContext must guard post-await commits with isCurrentSession');
  assert.ok(ctxSrc.includes('PartialBatchCommitError'), 'PragyaContext must reconcile PartialBatchCommitError');
  assert.ok(ctxSrc.includes('reconcileCommitted'), 'PragyaContext must reconcile committed batch rows');

  // R1#3 invariant in AuthContext.handleHashAuth: applySignedInAccount + flushIdbQueue must precede
  // activating Cloud mode (GOOGLE_TOKEN_KEY, MOCK_MODE_KEY='false', setIsMockMode(false)).
  const authSrc = read('src/context/AuthContext.tsx');
  const hashStart = authSrc.indexOf('const handleHashAuth = async () =>');
  const hashEnd = authSrc.indexOf('void handleHashAuth();', hashStart);
  assert.ok(hashStart > 0 && hashEnd > hashStart);
  const hashBody = authSrc
    .slice(hashStart, hashEnd)
    .replace(/^\s*\/\/[^\n]*/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const userinfoIdx = hashBody.indexOf('oauth2/v3/userinfo');
  const applyIdx = hashBody.indexOf('applySignedInAccount(profile.email)');
  const flushIdx = hashBody.indexOf('await flushIdbQueue()');
  const tokenSetIdx = hashBody.indexOf('localStorage.setItem(GOOGLE_TOKEN_KEY, token)');
  const mockFalseStorageIdx = hashBody.indexOf("localStorage.setItem(MOCK_MODE_KEY, 'false')");
  const setMockFalseIdx = hashBody.indexOf('setIsMockMode(false)');
  assert.ok(userinfoIdx > 0 && applyIdx > userinfoIdx && flushIdx > applyIdx);
  assert.ok(
    tokenSetIdx > flushIdx && mockFalseStorageIdx > flushIdx && setMockFalseIdx > flushIdx,
    'R1#3: Cloud token & setIsMockMode(false) must run AFTER userinfo + applySignedInAccount + flushIdbQueue'
  );

  // Extract every useCallback(..., [deps]) inside PragyaProvider using a string/comment-aware
  // balanced-paren scanner and prove NO volatile state appears in any callback dep list.
  const forbiddenActionDeps = new Set([
    'books',
    'notes',
    'sessions',
    'deltaLogs',
    'booksById',
    'notesById',
    'isLoading',
    'isSyncing',
    'lastSyncedAt',
    'spreadsheetId',
    'mediaFolderId',
    'isOfflineReadOnly',
    'adapter',
    'isAuthenticated',
    'isMockMode',
  ]);
  const checked = [];
  const headerRe = /const (\w+) = useCallback\(/g;
  let match;
  while ((match = headerRe.exec(ctxSrc)) !== null) {
    const name = match[1];
    const openParen = match.index + match[0].length - 1;
    let depth = 0;
    let closeParen = -1;
    let quote = null;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = openParen; i < ctxSrc.length; i += 1) {
      const ch = ctxSrc[i];
      const next = ctxSrc[i + 1];
      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (ch === '\\') {
          i += 1;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && next === '/') {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          closeParen = i;
          break;
        }
      }
    }
    assert.ok(closeParen > openParen, `Unmatched useCallback paren for ${name}`);
    const body = ctxSrc.slice(openParen + 1, closeParen).trim();
    const depsMatch = /,\s*\[([^\]]*)\]\s*$/.exec(body);
    assert.ok(depsMatch, `Missing dependency array on useCallback "${name}"`);
    checked.push(name);
    const deps = depsMatch[1]
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    for (const dep of deps) {
      assert.ok(
        !forbiddenActionDeps.has(dep),
        `Action callback "${name}" depends on volatile state "${dep}" — breaks usePragyaActions() referential stability!`
      );
    }
  }
  assert.ok(
    checked.length >= 25,
    `Expected to verify >= 25 action useCallbacks in PragyaContext.tsx, found ${checked.length}`
  );
  assert.ok(
    checked.includes('captureNote') &&
      checked.includes('syncNow') &&
      checked.includes('advanceBookPosition') &&
      checked.includes('revertBookmarkAdvance') &&
      checked.includes('replaceWorkspaceFromSnapshot') &&
      checked.includes('reconcileCommitted')
  );
});

// ---------------------------------------------------------------------------
// 7. CD7 Fix-up Regression Tests: QA-46, QA-47, R1#1, R1#2, N1
// ---------------------------------------------------------------------------

test('CD7 fix-up QA-46: cold unhinted batchCommitMutations throws RowMovedError (0 writes) when guarded Book or mode=update Session was deleted remotely', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const origFetch = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-cd7-qa46');
    // Remote Books tab has header ONLY (book-1 deleted on another device)
    const mock = createSheetsMock({ books: [], sessions: [] });
    globalThis.fetch = mock.fetchImpl;
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, 'qa46@pragya.dev', { sleep: noSleep });

    // Case A: guarded Book update (expectedBaseUpdatedAt set) + new Session insert -> RowMovedError, 0 writes
    await assert.rejects(
      () =>
        adapter.batchCommitMutations([
          {
            kind: 'book',
            book: makeBook({ currentPos: 60 }),
            expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z',
            mode: 'update',
          },
          { kind: 'session', session: makeSession({ id: 'sess-new' }), mode: 'insert' },
        ]),
      err => err instanceof conflictGuard.RowMovedError
    );
    assert.equal(
      mock.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length,
      0,
      'Deleted guarded Book must abort with zero writes'
    );
    assert.equal(mock.sheetData.Books.length, 1);
    assert.equal(mock.sheetData.Sessions.length, 1);

    // Case B: existing Book present, but mode='update' Session deleted remotely -> RowMovedError, 0 writes
    mock.sheetData.Books.push(sheetCodecs.bookToRow(makeBook()));
    mock.calls.length = 0;
    await assert.rejects(
      () =>
        adapter.batchCommitMutations([
          {
            kind: 'book',
            book: makeBook({ currentPos: 70 }),
            expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z',
            mode: 'update',
          },
          { kind: 'session', session: makeSession({ id: 'sess-deleted' }), mode: 'update' },
        ]),
      err => err instanceof conflictGuard.RowMovedError
    );
    assert.equal(
      mock.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length,
      0,
      'Deleted mode=update Session must abort with zero writes'
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('CD7 fix-up QA-47 / R1#1: in-flight loadWorkspace settling after logout or account switch must NOT resurrect Account A cache in IDB', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const fakeIdb = createFakeIdbFactory();
  const origIdb = globalThis.indexedDB;
  const origFetch = globalThis.fetch;
  try {
    globalThis.indexedDB = fakeIdb.factory;

    // 1. Explicit logout mid-flight (token cleared before values:batchGet resolves)
    let token = 'tok-a';
    let releaseGet;
    let getReached;
    const reachedPromise = new Promise(r => {
      getReached = r;
    });
    const holdPromise = new Promise(r => {
      releaseGet = r;
    });
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-cd7-a');
    localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'a@pragya.dev', name: 'A' }));
    localStorage.setItem('pragya_last_account_email', 'a@pragya.dev');

    const mockA = createSheetsMock({
      books: [makeBook({ id: 'book-a', title: 'Secret Account A Book' })],
      onRequest: async ({ url }) => {
        if (url.includes('UNFORMATTED_VALUE')) {
          getReached();
          await holdPromise;
        }
        return undefined;
      },
    });
    globalThis.fetch = mockA.fetchImpl;

    const adapterA = new GoogleSheetsAdapter(() => token, undefined, 'a@pragya.dev', { sleep: noSleep });
    const inFlight = adapterA.loadWorkspace({ forceRefresh: true });
    await reachedPromise;

    // Simulate explicit logout while loadWorkspaceFromSheets is suspended
    token = null;
    localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
    localStorage.removeItem('pragya_google_user');
    await idbStore.idbClear();

    releaseGet();
    await inFlight;
    await idbStore.flushIdbQueue();

    assert.equal(
      fakeIdb.getKv().get(SHEETS_CACHE_STORAGE_KEY),
      undefined,
      'In-flight Account A loadWorkspace must NOT re-write IDB cache after logout'
    );
    assert.equal(localStorage.getItem(SPREADSHEET_ID_STORAGE_KEY), null);

    // 2. Account switch mid-flight (token still non-null for B, but last_account_email changed to B)
    let releaseGet2;
    let getReached2;
    const reachedPromise2 = new Promise(r => {
      getReached2 = r;
    });
    const holdPromise2 = new Promise(r => {
      releaseGet2 = r;
    });
    token = 'tok-shared-getter';
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-cd7-a2');
    localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'a@pragya.dev', name: 'A' }));
    localStorage.setItem('pragya_last_account_email', 'a@pragya.dev');

    const mockA2 = createSheetsMock({
      books: [makeBook({ id: 'book-a2', title: 'Secret A2' })],
      onRequest: async ({ url }) => {
        if (url.includes('UNFORMATTED_VALUE')) {
          getReached2();
          await holdPromise2;
        }
        return undefined;
      },
    });
    globalThis.fetch = mockA2.fetchImpl;
    const adapterA2 = new GoogleSheetsAdapter(() => token, undefined, 'a@pragya.dev', { sleep: noSleep });
    const inFlight2 = adapterA2.loadWorkspace({ forceRefresh: true });
    await reachedPromise2;

    // Account B signs in while Account A's fetch is still in flight
    localStorage.setItem('pragya_last_account_email', 'b@pragya.dev');
    localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'b@pragya.dev', name: 'B' }));
    await idbStore.idbClear();

    releaseGet2();
    await inFlight2;
    await idbStore.flushIdbQueue();

    assert.equal(
      fakeIdb.getKv().get(SHEETS_CACHE_STORAGE_KEY),
      undefined,
      'In-flight Account A fetch settling after switch to Account B must NOT write into IDB'
    );

    // 3. Direct idbSet shouldWrite guard skips queued write when predicate turns false
    await idbStore.idbSet('guarded_key', 'should-not-land', { shouldWrite: () => false });
    await idbStore.flushIdbQueue();
    assert.equal(fakeIdb.getKv().get('guarded_key'), undefined);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.indexedDB = origIdb;
    idbStore.resetIdbStoreForTests();
  }
});

test('CD7 fix-up R1#2: PartialBatchCommitError reports exact committed rows across 500 & 429 and unwraps cause for classifyApiError', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const fakeIdb = createFakeIdbFactory();
  const origIdb = globalThis.indexedDB;
  const origFetch = globalThis.fetch;
  try {
    globalThis.indexedDB = fakeIdb.factory;
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-cd7-r12');

    // Case 1: Books batchUpdate ok + Notes:append ok + Sessions:append 500 -> committed has Book AND Note
    const mock1 = createSheetsMock({
      onRequest: ({ url, method }) => {
        if (method === 'POST' && decodeURIComponent(url).includes('Sessions!A1:append')) {
          return json({ error: { message: 'Internal error' } }, 500);
        }
        return undefined;
      },
    });
    globalThis.fetch = mock1.fetchImpl;
    const adapter1 = new GoogleSheetsAdapter(() => 'tok', undefined, 'r12@pragya.dev', { sleep: noSleep });
    await adapter1.loadWorkspace();
    assert.ok(fakeIdb.getKv().get(SHEETS_CACHE_STORAGE_KEY));

    let caught1 = null;
    try {
      await adapter1.batchCommitMutations([
        {
          kind: 'book',
          book: makeBook({ currentPos: 85, normalizedPos: 0.425, meta: { updatedAt: '2026-11-16T10:00:00.000Z' } }),
          expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z',
          mode: 'update',
        },
        { kind: 'note', note: makeNote({ id: 'note-committed-1', pos: 85 }), mode: 'insert' },
        { kind: 'session', session: makeSession({ id: 'sess-failed-1', endPos: 85 }), mode: 'insert' },
      ]);
    } catch (err) {
      caught1 = err;
    }
    assert.ok(caught1 instanceof PartialBatchCommitError, 'Expected PartialBatchCommitError');
    assert.equal(caught1.committed.books.length, 1);
    assert.equal(caught1.committed.books[0].currentPos, 85);
    assert.equal(caught1.committed.notes.length, 1);
    assert.equal(caught1.committed.notes[0].id, 'note-committed-1');
    assert.equal(caught1.committed.sessions.length, 0);
    assert.equal(caught1.cause?.status, 500);
    assert.equal(apiErrors.classifyApiError(caught1), 'other');
    await idbStore.flushIdbQueue();
    assert.equal(
      fakeIdb.getKv().get(SHEETS_CACHE_STORAGE_KEY),
      undefined,
      'Non-429 partial failure clears stale cache so next sync fetches authoritative state'
    );

    // Case 2: Books batchUpdate ok + Notes:append exhausted 429 -> preserves & patches v2 cache with committed Book
    const mock2 = createSheetsMock({
      onRequest: ({ url, method }) => {
        if (method === 'POST' && decodeURIComponent(url).includes('Notes!A1:append')) {
          return json({ error: { message: 'Quota exceeded' } }, 429);
        }
        return undefined;
      },
    });
    globalThis.fetch = mock2.fetchImpl;
    const adapter2 = new GoogleSheetsAdapter(() => 'tok', undefined, 'r12@pragya.dev', { sleep: noSleep });
    await adapter2.loadWorkspace();
    const before429 = JSON.parse(fakeIdb.getKv().get(SHEETS_CACHE_STORAGE_KEY));
    assert.equal(before429.modifiedTime, '2026-11-15T10:00:00Z');

    let caught2 = null;
    try {
      await adapter2.batchCommitMutations([
        {
          kind: 'book',
          book: makeBook({ currentPos: 95, normalizedPos: 0.475, meta: { updatedAt: '2026-11-16T10:10:00.000Z' } }),
          expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z',
          mode: 'update',
        },
        { kind: 'note', note: makeNote({ id: 'note-429', pos: 95 }), mode: 'insert' },
      ]);
    } catch (err) {
      caught2 = err;
    }
    assert.ok(caught2 instanceof PartialBatchCommitError);
    assert.equal(caught2.committed.books.length, 1);
    assert.equal(caught2.committed.notes.length, 0);
    assert.equal(apiErrors.classifyApiError(caught2), 'rate_limited');
    assert.equal(apiErrors.describeSyncError(caught2), apiErrors.RATE_LIMIT_TOAST);
    await idbStore.flushIdbQueue();
    const after429Raw = fakeIdb.getKv().get(SHEETS_CACHE_STORAGE_KEY);
    assert.ok(after429Raw, '429 partial failure must preserve v2 cache');
    const after429 = JSON.parse(after429Raw);
    assert.equal(after429.codecVersion, SHEETS_CACHE_CODEC_VERSION);
    assert.equal(after429.modifiedTime, '2026-11-15T10:00:00Z', 'Prior modifiedTime retained so next sync refreshes');
    assert.equal(after429.state.books[0].currentPos, 95, 'Committed Book patched into preserved v2 cache');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.indexedDB = origIdb;
    idbStore.resetIdbStoreForTests();
  }
});

test('CD7 fix-up N1: idbClear self-containedly removes tracked fallback localStorage keys when IDB is unavailable', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const origIdb = globalThis.indexedDB;
  try {
    globalThis.indexedDB = undefined;
    await idbStore.idbSet('pragya_custom_fallback_test', 'hello');
    assert.equal(localStorage.getItem('pragya_custom_fallback_test'), 'hello');
    await idbStore.idbClear();
    assert.equal(
      localStorage.getItem('pragya_custom_fallback_test'),
      null,
      'idbClear() must remove keys written to localStorage fallback without caller knowledge'
    );
  } finally {
    globalThis.indexedDB = origIdb;
    idbStore.resetIdbStoreForTests();
  }
});
