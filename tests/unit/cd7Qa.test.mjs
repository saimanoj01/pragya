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
const conflictGuard = await load('src/utils/conflictGuard.ts');
const sheetCodecs = await load('src/utils/sheetCodecs.ts');
const mutations = await load('src/context/pragyaMutations.ts');
const {
  GoogleSheetsAdapter,
  SHEETS_CACHE_CODEC_VERSION,
  SHEETS_CACHE_STORAGE_KEY,
  SPREADSHEET_ID_STORAGE_KEY,
} = await load('src/services/googleSheetsAdapter.ts');

const noSleep = async () => {};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function makeBook(overrides = {}) {
  return {
    id: 'book-qa7',
    title: 'QA7 Systems Book',
    author: 'Meadows',
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
    id: 'note-qa7',
    slug: 'qa7-slug',
    bookId: 'book-qa7',
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
    pos: 80,
    normalizedPos: 0.4,
    status: 'saved',
    source: 'app',
    tags: ['#systems'],
    quote: 'Quote',
    takeaway: 'Takeaway',
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
    id: 'sess-qa7',
    bookId: 'book-qa7',
    date: '2026-11-16',
    startPos: 40,
    endPos: 50,
    updatedAt: '2026-11-16T09:50:00.000Z',
    note: '',
    ...overrides,
  };
}

function createSheetsMock({ books = [makeBook()], notes = [], sessions = [makeSession()], deltaLogs = [], onRequest } = {}) {
  const sheetData = {
    Books: [sheetCodecs.BOOKS_HEADERS, ...books.map(sheetCodecs.bookToRow)],
    Notes: [sheetCodecs.NOTES_HEADERS, ...notes.map(sheetCodecs.noteToRow)],
    Sessions: [sheetCodecs.SESSIONS_HEADERS, ...sessions.map(sheetCodecs.sessionToRow)],
    DeltaLogs: [sheetCodecs.DELTA_LOGS_HEADERS, ...deltaLogs.map(sheetCodecs.deltaLogToRow)],
  };
  let curModifiedTime = '2026-11-15T10:00:00Z';
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

    if (u.includes('drive/v3/files/sheet-qa7')) {
      return json({ id: 'sheet-qa7', name: 'Pragya Commonplace', modifiedTime: curModifiedTime });
    }
    if (u.includes('fields=sheets.properties')) {
      return json({
        sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map((title, idx) => ({
          properties: { sheetId: idx + 1, title },
        })),
      });
    }
    if (u.includes('values:batchGet')) {
      const ranges = new URL(u).searchParams.getAll('ranges');
      return json({
        valueRanges: ranges.map(r => ({ range: r, values: readRange(r) })),
      });
    }
    if (u.includes('values:batchUpdate') && method === 'POST') {
      curModifiedTime = '2026-11-16T10:00:01Z';
      for (const item of body.data || []) {
        const [tab, a1] = item.range.split('!');
        const m = /^A(\d+):/.exec(a1);
        if (m) sheetData[tab][Number(m[1]) - 1] = item.values[0];
      }
      return json({ totalUpdatedRows: (body.data || []).length });
    }
    if (u.includes(':append') && method === 'POST') {
      curModifiedTime = '2026-11-16T10:00:02Z';
      const m = /\/values\/([^/?:]+)!A1:append/.exec(decodeURIComponent(u));
      const tab = m?.[1];
      const startRow = sheetData[tab].length + 1;
      for (const row of body.values || []) sheetData[tab].push(row);
      const endRow = sheetData[tab].length;
      const lastCol = batchPlan.BATCH_TAB_META[tab].lastCol;
      return json({ updates: { updatedRange: `${tab}!A${startRow}:${lastCol}${endRow}` } });
    }
    return json({});
  };

  return { fetchImpl, calls, sheetData };
}

test('CD7 QA batchCommitMutations: shifted/vanished Session row aborts with ZERO writes on vanish & relocates on shift', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const origFetch = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-qa7');
    const mock = createSheetsMock();
    globalThis.fetch = mock.fetchImpl;
    const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, 'qa@pragya.dev', { sleep: noSleep });

    // Warm hints: book-qa7 @ row 2, sess-qa7 @ row 2
    await adapter.loadWorkspace();

    // Shift sess-qa7 down to row 3 by inserting another session above it
    mock.sheetData.Sessions.splice(
      1,
      0,
      sheetCodecs.sessionToRow(makeSession({ id: 'sess-other-above', endPos: 30 }))
    );
    mock.calls.length = 0;

    await adapter.batchCommitMutations([
      {
        kind: 'book',
        book: makeBook({ currentPos: 65, meta: { updatedAt: '2026-11-16T10:00:00.000Z' } }),
        expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z',
      },
      { kind: 'session', session: makeSession({ endPos: 65 }) },
    ]);

    const batchUp = mock.calls.find(c => c.url.includes('values:batchUpdate'));
    assert.deepEqual(
      batchUp.body.data.map(d => d.range),
      ['Books!A2:L2', 'Sessions!A3:G3'],
      'Relocated Session must write to row 3 and stay ordered after Books'
    );
    assert.equal(mock.sheetData.Sessions[1][0], 'sess-other-above', 'Inserted row untouched');

    // Now vanish sess-qa7 remotely -> batchCommitMutations must throw RowMovedError with ZERO writes (Book NOT written!)
    mock.sheetData.Sessions.splice(2, 1);
    mock.calls.length = 0;
    await assert.rejects(
      () =>
        adapter.batchCommitMutations([
          {
            kind: 'book',
            book: makeBook({ currentPos: 75, meta: { updatedAt: '2026-11-16T10:05:00.000Z' } }),
            expectedBaseUpdatedAt: '2026-11-16T10:00:00.000Z',
          },
          { kind: 'session', session: makeSession({ endPos: 75 }) },
        ]),
      conflictGuard.RowMovedError
    );
    assert.equal(
      mock.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length,
      0,
      'Vanished Session row must abort ENTIRE batch with zero writes'
    );
    assert.equal(mock.sheetData.Books[1][6], 65, 'Book row remained untouched when Session vanished');
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
    idbStore.resetIdbStoreForTests();
  }
});

test('CD7 QA batchCommitMutations: partial failure between batchUpdate and :append invalidates cache on 500 & preserves cache on exhausted 429', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const origFetch = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-qa7');

    // Case 1: values:batchUpdate (Books) succeeds, then Notes:append fails 500 -> Sessions:append skipped, cache cleared!
    let noteAppendCalls = 0;
    let sessAppendCalls = 0;
    const mock500 = createSheetsMock({
      sessions: [],
      onRequest: ({ method, url }) => {
        if (method === 'POST' && decodeURIComponent(url).includes('Notes!A1:append')) {
          noteAppendCalls += 1;
          return json({ error: { code: 500, message: 'backendError' } }, 500);
        }
        if (method === 'POST' && decodeURIComponent(url).includes('Sessions!A1:append')) {
          sessAppendCalls += 1;
        }
        return undefined;
      },
    });
    globalThis.fetch = mock500.fetchImpl;
    const adapter1 = new GoogleSheetsAdapter(() => 'tok', undefined, 'qa@pragya.dev', { sleep: noSleep });
    await adapter1.loadWorkspace();
    assert.ok(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY), 'v2 cache populated before partial failure');

    await assert.rejects(() =>
      adapter1.batchCommitMutations([
        {
          kind: 'book',
          book: makeBook({ currentPos: 80, meta: { updatedAt: '2026-11-16T10:00:00Z' } }),
          expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z',
        },
        { kind: 'note', note: makeNote({ id: 'n-fail-500' }) },
        { kind: 'session', session: makeSession({ id: 's-never-append' }) },
      ])
    );
    assert.equal(noteAppendCalls, 1, 'HTTP 500 on :append must NEVER retry');
    assert.equal(sessAppendCalls, 0, 'Sessions:append must not run after Notes:append fails');
    assert.equal(
      localStorage.getItem(SHEETS_CACHE_STORAGE_KEY),
      null,
      'Non-429 partial failure must invalidate local cache so next sync reconciles authoritative Sheet'
    );

    // Case 2: values:batchUpdate succeeds, then Notes:append exhausts 429 retries -> v2 cache preserved (old modifiedTime)
    let note429Attempts = 0;
    const sleeps = [];
    const mock429 = createSheetsMock({
      sessions: [],
      onRequest: ({ method, url }) => {
        if (method === 'POST' && decodeURIComponent(url).includes('Notes!A1:append')) {
          note429Attempts += 1;
          return json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429);
        }
        return undefined;
      },
    });
    globalThis.fetch = mock429.fetchImpl;
    const adapter2 = new GoogleSheetsAdapter(() => 'tok', undefined, 'qa@pragya.dev', {
      sleep: async ms => {
        sleeps.push(ms);
      },
    });
    await adapter2.loadWorkspace();
    await assert.rejects(() =>
      adapter2.batchCommitMutations([
        {
          kind: 'book',
          book: makeBook({ currentPos: 85, meta: { updatedAt: '2026-11-16T10:05:00Z' } }),
          expectedBaseUpdatedAt: '2026-11-15T10:00:00.000Z',
        },
        { kind: 'note', note: makeNote({ id: 'n-fail-429' }) },
      ])
    );
    assert.equal(note429Attempts, 3, 'Genuine 429 retries up to 3 attempts');
    assert.deepEqual(sleeps, [500, 1000], 'Uses [500, 1000]ms backoff');
    const preserved = JSON.parse(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY) || 'null');
    assert.ok(preserved, 'Exhausted 429 must NOT wipe valid v2 cache');
    assert.equal(preserved.codecVersion, SHEETS_CACHE_CODEC_VERSION);
    assert.equal(preserved.modifiedTime, '2026-11-15T10:00:00Z');
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
    idbStore.resetIdbStoreForTests();
  }
});

test('CD7 QA pragyaMutations & consumer split: markBookFinished conflict guard & action-only components never subscribe to PragyaDataContext', () => {
  // planMarkBookFinished sets status=finished, normalizedPos=1, preserves existing startedAt & unknown meta, guards updatedAt
  const b = makeBook({
    status: 'reading',
    currentPos: 120,
    totalPos: 200,
    meta: { startedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-15T10:00:00Z', customKey: 'keep' },
  });
  const fin = mutations.planMarkBookFinished(b, '2026-11-19T12:00:00Z');
  assert.equal(fin.nextBook.status, 'finished');
  assert.equal(fin.nextBook.currentPos, 200);
  assert.equal(fin.nextBook.normalizedPos, 1);
  assert.equal(fin.nextBook.meta.startedAt, '2026-11-01T00:00:00Z');
  assert.equal(fin.nextBook.meta.finishedAt, '2026-11-19T12:00:00Z');
  assert.equal(fin.nextBook.meta.customKey, 'keep');
  assert.equal(fin.expectedBaseUpdatedAt, '2026-11-15T10:00:00Z');

  // Migrated action-only components subscribe ONLY to usePragyaActions() (never usePragya() or usePragyaData())
  for (const rel of [
    'src/components/modals/AddBookModal.tsx',
    'src/components/modals/EditBookModal.tsx',
    'src/components/common/BookChapterLine.tsx',
    'src/components/modals/PredictionOutcomeModal.tsx',
  ]) {
    const src = read(rel);
    assert.ok(src.includes('usePragyaActions('), `${rel} uses usePragyaActions()`);
    assert.ok(!src.includes('usePragya('), `${rel} must not call combined usePragya()`);
    assert.ok(!src.includes('usePragyaData('), `${rel} must not subscribe to PragyaDataContext`);
  }

  // Migrated data-only components subscribe ONLY to usePragyaData() (or split SessionNoteEditor inside SessionsTrail)
  for (const rel of ['src/components/modals/ImportConfirmModal.tsx']) {
    const src = read(rel);
    assert.ok(src.includes('usePragyaData('), `${rel} uses usePragyaData()`);
    assert.ok(!src.includes('usePragya('), `${rel} must not call combined usePragya()`);
  }
});
