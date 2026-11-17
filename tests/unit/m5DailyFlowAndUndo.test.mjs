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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const { extractKindlePositionCandidates, pickKindlePositionHint } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/kindlePaste.ts')).href
);
const { getQuickAdvanceSpec } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/spoilerMath.ts')).href
);
const { applyBookmarkAdvance } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/sessionCoalesce.ts')).href
);
const { getShuffleEmptyReason } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/takeawayShuffle.ts')).href
);
const { DemoStorageAdapter } = await import(
  pathToFileURL(path.join(repoRoot, 'src/services/demoAdapter.ts')).href
);
const { GoogleSheetsAdapter, SPREADSHEET_ID_STORAGE_KEY } = await import(
  pathToFileURL(path.join(repoRoot, 'src/services/googleSheetsAdapter.ts')).href
);
const { stripDeltaPrefix, normalizeDeltaTrigger, normalizeDeltaAction } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/deltaFormat.ts')).href
);

function makeBook(overrides = {}) {
  return {
    id: 'book-1',
    title: 'Sample Book',
    author: 'Author',
    format: 'physical',
    kind: 'nonfiction',
    status: 'reading',
    currentPos: 20,
    totalPos: 200,
    posUnit: 'page',
    normalizedPos: 0.1,
    docUrl: '',
    meta: {},
    ...overrides,
  };
}

function makeNote(overrides = {}) {
  return {
    id: 'note-1',
    slug: 'sample-note',
    bookId: 'book-1',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    pos: 10,
    normalizedPos: 0.05,
    status: 'saved',
    source: 'app',
    tags: [],
    quote: '',
    takeaway: 'Important takeaway',
    contextMechanism: '',
    critique: '',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none',
    meta: {},
    ...overrides,
  };
}

test('M5.1: Kindle paste extracts Location, Page, and Percent with unit preference', () => {
  const locText = 'Your Highlight on Location 1,423-1425 | Added on Sunday, Nov 16, 2026';
  assert.deepEqual(pickKindlePositionHint(locText, 'loc'), {
    pos: 1423,
    unitHint: 'loc',
    label: 'Location 1423',
  });

  const pageText = 'Highlight (yellow) - Page 84 · Added on Nov 16';
  assert.deepEqual(pickKindlePositionHint(pageText, 'page'), {
    pos: 84,
    unitHint: 'page',
    label: 'Page 84',
  });

  const mixedText = 'Highlight on Page 84 | Location 1280 | 42%';
  assert.equal(extractKindlePositionCandidates(mixedText).length, 3);
  assert.equal(pickKindlePositionHint(mixedText, 'percent')?.pos, 42);
  assert.equal(pickKindlePositionHint(mixedText, 'loc')?.pos, 1280);
  assert.equal(pickKindlePositionHint(mixedText, 'page')?.pos, 84);

  assert.equal(pickKindlePositionHint('Just a plain quote with 150% effort'), null);
  assert.equal(pickKindlePositionHint('No numbers here'), null);
});

test('M5.2: getQuickAdvanceSpec returns unit-aware steps and labels', () => {
  assert.deepEqual(getQuickAdvanceSpec('page'), { step: 10, label: '+10p' });
  assert.deepEqual(getQuickAdvanceSpec('percent'), { step: 5, label: '+5%' });
  assert.deepEqual(getQuickAdvanceSpec('loc'), { step: 50, label: '+50 loc' });
});

test('M5.2: applyBookmarkAdvance resumes paused and queued books to reading', () => {
  const paused = makeBook({ status: 'paused', currentPos: 30, normalizedPos: 0.15, meta: {} });
  const res = applyBookmarkAdvance(paused, 45, { nowIso: '2026-11-16T12:00:00.000Z' });
  assert.equal(res.changed, true);
  assert.equal(res.updatedBook.status, 'reading');
  assert.equal(res.updatedBook.currentPos, 45);
  assert.equal(res.updatedBook.meta.startedAt, '2026-11-16T12:00:00.000Z');

  const pausedWithStarted = makeBook({
    status: 'paused',
    currentPos: 30,
    normalizedPos: 0.15,
    meta: { startedAt: '2026-11-01T08:00:00.000Z' },
  });
  const res2 = applyBookmarkAdvance(pausedWithStarted, 50, { nowIso: '2026-11-16T12:00:00.000Z' });
  assert.equal(res2.updatedBook.status, 'reading');
  assert.equal(res2.updatedBook.meta.startedAt, '2026-11-01T08:00:00.000Z');
});

test('M5.4: getShuffleEmptyReason distinguishes none-eligible from all-reviewed-today', () => {
  const book = makeBook({ currentPos: 100, normalizedPos: 0.5 });
  const tooYoung = makeNote({
    id: 'n-young',
    createdAt: '2026-11-15T10:00:00.000Z',
    tags: [],
  });
  assert.equal(getShuffleEmptyReason([tooYoung], [book], '2026-11-16'), 'none-eligible');

  const reviewedFav = makeNote({
    id: 'n-fav',
    createdAt: '2026-11-15T10:00:00.000Z',
    tags: ['#favorite'],
    meta: { lastReviewedAt: '2026-11-16' },
  });
  assert.equal(getShuffleEmptyReason([reviewedFav], [book], '2026-11-16'), 'all-reviewed-today');
});

test('M5.5: DemoStorageAdapter.deleteSession deletes target session cleanly', async () => {
  localStorage.clear();
  const adapter = new DemoStorageAdapter();
  const initial = await adapter.loadWorkspace();
  const countBefore = initial.sessions.length;

  await adapter.saveSession({
    id: 'sess-temp-undo',
    bookId: 'book-systems',
    date: '2026-11-16',
    startPos: 142,
    endPos: 152,
    updatedAt: '2026-11-16T12:00:00.000Z',
    note: '',
  });
  assert.equal((await adapter.loadWorkspace()).sessions.length, countBefore + 1);

  await adapter.deleteSession('sess-temp-undo');
  const after = await adapter.loadWorkspace();
  assert.equal(after.sessions.length, countBefore);
  assert.equal(
    after.sessions.some(s => s.id === 'sess-temp-undo'),
    false
  );
});

test('M5.5: GoogleSheetsAdapter.deleteSession resolves row via Sessions!A:A and calls deleteDimension', async () => {
  localStorage.clear();
  localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-undo-1');

  const fetchCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, method: init.method || 'GET', body: init.body });

    if (u.includes('Sessions!A%3AA')) {
      return new Response(
        JSON.stringify({ values: [['id'], ['sess-keep'], ['sess-target']] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.includes('fields=sheets.properties')) {
      return new Response(
        JSON.stringify({
          sheets: [
            { properties: { sheetId: 0, title: 'Books' } },
            { properties: { sheetId: 22, title: 'Sessions' } },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.includes(':batchUpdate')) {
      return new Response(JSON.stringify({ replies: [{}] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ modifiedTime: '2026-11-16T12:05:00Z' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const adapter = new GoogleSheetsAdapter(() => 'tok-undo');
    await adapter.deleteSession('sess-target');

    const batchCall = fetchCalls.find(c => c.url.includes(':batchUpdate'));
    assert.ok(batchCall, 'Expected batchUpdate deleteDimension call');
    const parsedBody = JSON.parse(String(batchCall.body));
    assert.deepEqual(parsedBody, {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: 22,
              dimension: 'ROWS',
              startIndex: 2,
              endIndex: 3,
            },
          },
        },
      ],
    });

    // Missing UUID should no-op gracefully without batchUpdate
    fetchCalls.length = 0;
    await adapter.deleteSession('sess-nonexistent');
    assert.equal(
      fetchCalls.some(c => c.url.includes(':batchUpdate')),
      false
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Pre-ship: WHEN/DO normalization enforces word boundaries without corrupting whenever/document/double-check/don\'t', () => {
  assert.equal(normalizeDeltaTrigger('WHEN WHEN foo'), 'foo');
  assert.equal(normalizeDeltaTrigger('WHEN: foo'), 'foo');
  assert.equal(normalizeDeltaTrigger('whenever latency spikes'), 'whenever latency spikes');
  assert.equal(stripDeltaPrefix('when', 'WHEN'), '');

  assert.equal(normalizeDeltaAction('DO DO bar'), 'bar');
  assert.equal(normalizeDeltaAction('DO: bar'), 'bar');
  assert.equal(normalizeDeltaAction('document the failure'), 'document the failure');
  assert.equal(normalizeDeltaAction('double-check metrics'), 'double-check metrics');
  assert.equal(normalizeDeltaAction("don't interrupt"), "don't interrupt");
  assert.equal(stripDeltaPrefix('do', 'DO'), '');
});
