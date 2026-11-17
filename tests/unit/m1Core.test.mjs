import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Register extensionless TypeScript resolver hook for Node 24
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

const {
  BOOKS_HEADERS,
  NOTES_HEADERS,
  SESSIONS_HEADERS,
  DELTA_LOGS_HEADERS,
  bookToRow,
  rowToBook,
  noteToRow,
  rowToNote,
  sessionToRow,
  rowToSession,
  deltaLogToRow,
  rowToDeltaLog,
  parseTagsCsv,
  serializeTagsCsv,
} = await import(pathToFileURL(path.join(repoRoot, 'src/utils/sheetCodecs.ts')).href);

const {
  computeNormalizedPos,
  isNoteSpoiler,
  isSealedPrediction,
  isUnlockedPrediction,
} = await import(pathToFileURL(path.join(repoRoot, 'src/utils/spoilerMath.ts')).href);

const {
  stripDeltaPrefix,
  normalizeDeltaTrigger,
  normalizeDeltaAction,
  formatWhenDoDisplay,
} = await import(pathToFileURL(path.join(repoRoot, 'src/utils/deltaFormat.ts')).href);

const { applyBookmarkAdvance, upsertCoalescedSession } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/sessionCoalesce.ts')).href
);

const { slugify, generateUniqueSlug, extractWikilinks, computeBacklinks } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/wikilinks.ts')).href
);

const { parseHash, isOAuthCallbackHash, isSafeHttpUrl } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/navigation.ts')).href
);

const { createDemoSeed } = await import(
  pathToFileURL(path.join(repoRoot, 'src/data/demoSeed.ts')).href
);

const {
  GoogleSheetsAdapter,
  MEDIA_FOLDER_ID_STORAGE_KEY,
  SHEETS_CACHE_STORAGE_KEY,
  SPREADSHEET_ID_STORAGE_KEY,
} = await import(pathToFileURL(path.join(repoRoot, 'src/services/googleSheetsAdapter.ts')).href);

test('Sheet row encode/decode roundtrips for Books!A:L, Notes!A:R, Sessions!A:G, DeltaLogs!A:E', () => {
  assert.deepEqual([...BOOKS_HEADERS], [
    'id',
    'title',
    'author',
    'format',
    'kind',
    'status',
    'currentPos',
    'totalPos',
    'posUnit',
    'normalizedPos',
    'docUrl',
    'metaJson',
  ]);
  assert.deepEqual([...NOTES_HEADERS], [
    'id',
    'slug',
    'bookId',
    'createdAt',
    'updatedAt',
    'pos',
    'normalizedPos',
    'status',
    'source',
    'tags',
    'quote',
    'takeaway',
    'contextMechanism',
    'critique',
    'deltaTrigger',
    'deltaAction',
    'deltaStatus',
    'metaJson',
  ]);
  assert.deepEqual([...SESSIONS_HEADERS], [
    'id',
    'bookId',
    'date',
    'startPos',
    'endPos',
    'updatedAt',
    'note',
  ]);
  assert.deepEqual([...DELTA_LOGS_HEADERS], [
    'id',
    'noteId',
    'date',
    'outcome',
    'reflection',
  ]);

  const seed = createDemoSeed(new Date('2026-11-15T12:00:00.000Z'));

  for (const book of seed.books) {
    const row = bookToRow(book);
    assert.equal(row.length, 12);
    const decoded = rowToBook(row);
    assert.ok(decoded);
    assert.equal(decoded.id, book.id);
    assert.equal(decoded.title, book.title);
    assert.equal(decoded.author, book.author);
    assert.equal(decoded.format, book.format);
    assert.equal(decoded.kind, book.kind);
    assert.equal(decoded.status, book.status);
    assert.equal(decoded.currentPos, book.currentPos);
    assert.equal(decoded.totalPos, book.totalPos);
    assert.equal(decoded.posUnit, book.posUnit);
    assert.equal(decoded.docUrl, book.docUrl);
    assert.deepEqual(decoded.meta, book.meta);
    assert.ok(Math.abs(decoded.normalizedPos - book.normalizedPos) < 1e-5);
  }

  for (const note of seed.notes) {
    const row = noteToRow(note);
    assert.equal(row.length, 18);
    const decoded = rowToNote(row);
    assert.ok(decoded);
    assert.equal(decoded.id, note.id);
    assert.equal(decoded.slug, note.slug);
    assert.equal(decoded.bookId, note.bookId);
    assert.equal(decoded.createdAt, note.createdAt);
    assert.equal(decoded.updatedAt, note.updatedAt);
    assert.equal(decoded.pos, note.pos);
    assert.ok(Math.abs(decoded.normalizedPos - note.normalizedPos) < 1e-5);
    assert.equal(decoded.status, note.status);
    assert.equal(decoded.source, note.source);
    assert.deepEqual(decoded.tags, note.tags);
    assert.equal(decoded.quote, note.quote);
    assert.equal(decoded.takeaway, note.takeaway);
    assert.equal(decoded.contextMechanism, note.contextMechanism);
    assert.equal(decoded.critique, note.critique);
    assert.equal(decoded.deltaTrigger, note.deltaTrigger);
    assert.equal(decoded.deltaAction, note.deltaAction);
    assert.equal(decoded.deltaStatus, note.deltaStatus);
    assert.deepEqual(decoded.meta, note.meta);
  }

  for (const sess of seed.sessions) {
    const row = sessionToRow(sess);
    assert.equal(row.length, 7);
    const decoded = rowToSession(row);
    assert.deepEqual(decoded, sess);
  }

  for (const dlog of seed.deltaLogs) {
    const row = deltaLogToRow(dlog);
    assert.equal(row.length, 5);
    const decoded = rowToDeltaLog(row);
    assert.deepEqual(decoded, dlog);
  }

  // Header & empty rows are ignored by decoders
  assert.equal(rowToBook([...BOOKS_HEADERS]), null);
  assert.equal(rowToNote([...NOTES_HEADERS]), null);
  assert.equal(rowToSession([...SESSIONS_HEADERS]), null);
  assert.equal(rowToDeltaLog([...DELTA_LOGS_HEADERS]), null);
  assert.equal(rowToBook([]), null);
  assert.equal(rowToNote(['']), null);

  assert.deepEqual(parseTagsCsv('systems, #Feedback Loops, #systems'), [
    '#systems',
    '#feedback-loops',
  ]);
  assert.equal(serializeTagsCsv(['systems', '#feedback-loops']), '#systems, #feedback-loops');
});

test('Spoiler math across page, percent, loc, unknown totalPos, and finished books', () => {
  assert.equal(computeNormalizedPos(142, 218, 'page'), 142 / 218);
  assert.equal(computeNormalizedPos(45, 0, 'percent'), 0.45);
  assert.equal(computeNormalizedPos(150, 100, 'percent'), 1);
  assert.equal(computeNormalizedPos(500, 2000, 'loc'), 0.25);
  assert.equal(computeNormalizedPos(50, 0, 'page'), 0);
  assert.equal(computeNormalizedPos(50, 0, 'loc'), 0);

  const baseNote = {
    id: 'n1',
    slug: 'n1',
    bookId: 'b1',
    createdAt: '',
    updatedAt: '',
    pos: 75,
    normalizedPos: 0,
    status: 'saved',
    source: 'app',
    tags: [],
    quote: '',
    takeaway: 'spoiler',
    contextMechanism: '',
    critique: '',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none',
    meta: { attachments: [], links: [], isPrediction: true },
  };

  // Page unit with known totalPos
  const pageBook = {
    id: 'b-page',
    title: 'Page Book',
    author: 'Author',
    format: 'physical',
    kind: 'nonfiction',
    status: 'reading',
    currentPos: 100,
    totalPos: 200,
    posUnit: 'page',
    normalizedPos: 0.5,
    docUrl: '',
    meta: { updatedAt: '2026-11-15T00:00:00.000Z' },
  };
  assert.equal(isNoteSpoiler({ ...baseNote, pos: 120, normalizedPos: 0.6 }, pageBook), true);
  assert.equal(isNoteSpoiler({ ...baseNote, pos: 100, normalizedPos: 0.5 }, pageBook), false);
  assert.equal(isNoteSpoiler(baseNote, null), false);

  // Percent unit (works even if totalPos === 0)
  const percentBook = {
    ...pageBook,
    id: 'b-pct',
    format: 'kindle',
    currentPos: 45,
    totalPos: 0,
    posUnit: 'percent',
    normalizedPos: 0.45,
  };
  assert.equal(isNoteSpoiler({ ...baseNote, pos: 60, normalizedPos: 0.6 }, percentBook), true);
  assert.equal(isNoteSpoiler({ ...baseNote, pos: 45, normalizedPos: 0.45 }, percentBook), false);

  // Kindle loc unit
  const locBook = {
    ...pageBook,
    id: 'b-loc',
    format: 'kindle',
    currentPos: 500,
    totalPos: 2000,
    posUnit: 'loc',
    normalizedPos: 0.25,
  };
  assert.equal(isNoteSpoiler({ ...baseNote, pos: 1200, normalizedPos: 0.6 }, locBook), true);
  assert.equal(isNoteSpoiler({ ...baseNote, pos: 400, normalizedPos: 0.2 }, locBook), false);

  // Unknown totalPos === 0 falls back to raw pos comparison
  const bookUnknownTotal = {
    id: 'b1',
    title: 'Unknown Total',
    author: 'Author',
    format: 'physical',
    kind: 'fiction',
    status: 'reading',
    currentPos: 50,
    totalPos: 0,
    posUnit: 'page',
    normalizedPos: 0,
    docUrl: '',
    meta: { updatedAt: '2026-11-15T00:00:00.000Z' },
  };
  const futureNoteUnknown = { ...baseNote, pos: 75, normalizedPos: 0 };
  const pastNoteUnknown = { ...baseNote, pos: 30, normalizedPos: 0 };

  assert.equal(isNoteSpoiler(futureNoteUnknown, bookUnknownTotal), true);
  assert.equal(isNoteSpoiler(pastNoteUnknown, bookUnknownTotal), false);
  assert.equal(
    isNoteSpoiler(futureNoteUnknown, { ...bookUnknownTotal, posUnit: 'loc' }),
    true
  );
  assert.equal(isSealedPrediction(pastNoteUnknown, bookUnknownTotal), true);
  assert.equal(isUnlockedPrediction(pastNoteUnknown, bookUnknownTotal), false);

  const finishedBook = { ...bookUnknownTotal, status: 'finished', normalizedPos: 1 };
  assert.equal(isNoteSpoiler(futureNoteUnknown, finishedBook), false);
  assert.equal(isSealedPrediction(pastNoteUnknown, finishedBook), false);
  assert.equal(isUnlockedPrediction(pastNoteUnknown, finishedBook), true);
});

test('Monotonic Math.max bookmark ceiling and explicit override', () => {
  const book = {
    id: 'b1',
    title: 'Test Book',
    author: 'Author',
    format: 'physical',
    kind: 'nonfiction',
    status: 'reading',
    currentPos: 100,
    totalPos: 200,
    posUnit: 'page',
    normalizedPos: 0.5,
    docUrl: '',
    meta: { updatedAt: '2026-11-15T00:00:00.000Z' },
  };

  // Equal position -> no-op
  const same = applyBookmarkAdvance(book, 100);
  assert.equal(same.rejectedBackward, false);
  assert.equal(same.changed, false);

  // Backward update rejected by default
  const backward = applyBookmarkAdvance(book, 80);
  assert.equal(backward.rejectedBackward, true);
  assert.equal(backward.changed, false);
  assert.equal(backward.updatedBook.currentPos, 100);

  // Forward update advances monotonically and caps at totalPos
  const forward = applyBookmarkAdvance(book, 250);
  assert.equal(forward.rejectedBackward, false);
  assert.equal(forward.changed, true);
  assert.equal(forward.nextPos, 200);
  assert.equal(forward.updatedBook.normalizedPos, 1);

  // Explicit manual override permits backward reset
  const override = applyBookmarkAdvance(book, 40, { manualOverride: true });
  assert.equal(override.rejectedBackward, false);
  assert.equal(override.changed, true);
  assert.equal(override.nextPos, 40);
  assert.equal(override.updatedBook.normalizedPos, 0.2);

  // Unknown totalPos === 0 advances freely without capping
  const unknownBook = { ...book, currentPos: 50, totalPos: 0, normalizedPos: 0 };
  const unknownForward = applyBookmarkAdvance(unknownBook, 500);
  assert.equal(unknownForward.changed, true);
  assert.equal(unknownForward.nextPos, 500);
  assert.equal(unknownForward.updatedBook.normalizedPos, 0);

  // Percent unit clamps to 100 / 1.0
  const percentBook = { ...book, currentPos: 40, totalPos: 100, posUnit: 'percent', normalizedPos: 0.4 };
  const pctForward = applyBookmarkAdvance(percentBook, 120);
  assert.equal(pctForward.nextPos, 100);
  assert.equal(pctForward.updatedBook.normalizedPos, 1);
});

test('30-minute session coalescing for same book and local date', () => {
  const t0 = '2026-11-15T10:00:00.000Z';
  const t15m = '2026-11-15T10:15:00.000Z';
  const t30mExact = '2026-11-15T10:30:00.000Z';
  const t61m = '2026-11-15T11:00:01.000Z';

  // Initial session
  const r1 = upsertCoalescedSession([], {
    bookId: 'book-1',
    prevPos: 10,
    nextPos: 20,
    nowIso: t0,
    date: '2026-11-15',
    generateId: () => 'sess-1',
  });
  assert.equal(r1.isNew, true);
  assert.equal(r1.sessions.length, 1);
  assert.equal(r1.upserted.startPos, 10);
  assert.equal(r1.upserted.endPos, 20);

  // Within 30 mins -> coalesced into sess-1
  const r2 = upsertCoalescedSession(r1.sessions, {
    bookId: 'book-1',
    prevPos: 20,
    nextPos: 35,
    nowIso: t15m,
    date: '2026-11-15',
    generateId: () => 'sess-2',
  });
  assert.equal(r2.isNew, false);
  assert.equal(r2.sessions.length, 1);
  assert.equal(r2.upserted.id, 'sess-1');
  assert.equal(r2.upserted.startPos, 10);
  assert.equal(r2.upserted.endPos, 35);

  // Exactly 30 mins later (relative to r2? No, 15m -> 30m is 15m; let's test exact 30m from r1 too)
  const rExact30 = upsertCoalescedSession(r1.sessions, {
    bookId: 'book-1',
    prevPos: 20,
    nextPos: 40,
    nowIso: t30mExact,
    date: '2026-11-15',
    generateId: () => 'sess-exact30',
  });
  assert.equal(rExact30.isNew, false);
  assert.equal(rExact30.sessions.length, 1);
  assert.equal(rExact30.upserted.id, 'sess-1');
  assert.equal(rExact30.upserted.endPos, 40);

  // Beyond 30 mins (30m + 1s from t30mExact) -> appends new session
  const r3 = upsertCoalescedSession(rExact30.sessions, {
    bookId: 'book-1',
    prevPos: 40,
    nextPos: 50,
    nowIso: t61m,
    date: '2026-11-15',
    generateId: () => 'sess-3',
  });
  assert.equal(r3.isNew, true);
  assert.equal(r3.sessions.length, 2);

  // Different book within 30 mins -> appends new session
  const r4 = upsertCoalescedSession(r3.sessions, {
    bookId: 'book-2',
    prevPos: 0,
    nextPos: 12,
    nowIso: t61m,
    date: '2026-11-15',
    generateId: () => 'sess-4',
  });
  assert.equal(r4.isNew, true);
  assert.equal(r4.sessions.length, 3);

  // Different calendar date even within 30 mins -> appends new session
  const r5 = upsertCoalescedSession(r4.sessions, {
    bookId: 'book-1',
    prevPos: 50,
    nextPos: 62,
    nowIso: '2026-11-15T11:10:00.000Z',
    date: '2026-11-16',
    generateId: () => 'sess-5',
  });
  assert.equal(r5.isNew, true);
  assert.equal(r5.sessions.length, 4);
  assert.equal(r5.upserted.date, '2026-11-16');
});

test('Delta prefix normalization prevents duplicate WHEN WHEN / DO DO', () => {
  assert.equal(stripDeltaPrefix('WHEN foo', 'WHEN'), 'foo');
  assert.equal(stripDeltaPrefix('WHEN WHEN foo', 'WHEN'), 'foo');
  assert.equal(stripDeltaPrefix('WHEN WHEN:   foo', 'WHEN'), 'foo');
  assert.equal(stripDeltaPrefix('when When foo', 'WHEN'), 'foo');
  assert.equal(stripDeltaPrefix('DO bar', 'DO'), 'bar');
  assert.equal(stripDeltaPrefix('DO DO bar', 'DO'), 'bar');
  assert.equal(stripDeltaPrefix('DO DO: bar', 'DO'), 'bar');
  assert.equal(normalizeDeltaTrigger('WHEN WHEN metrics dip'), 'metrics dip');
  assert.equal(normalizeDeltaAction('DO DO wait 24h'), 'wait 24h');

  const formatted = formatWhenDoDisplay('WHEN WHEN metrics dip', 'DO DO wait 24h');
  assert.equal(formatted.triggerBody, 'metrics dip');
  assert.equal(formatted.actionBody, 'wait 24h');
  assert.equal(formatted.whenLine, 'WHEN metrics dip');
  assert.equal(formatted.doLine, 'DO wait 24h');

  // Verify sheet row serializer/decoder also strips duplicate WHEN/DO prefixes
  const dirtyNote = {
    ...createDemoSeed(new Date('2026-11-15T12:00:00.000Z')).notes[0],
    deltaTrigger: 'WHEN WHEN foo',
    deltaAction: 'DO DO bar',
  };
  const encoded = noteToRow(dirtyNote);
  assert.equal(encoded[14], 'foo');
  assert.equal(encoded[15], 'bar');
  const decoded = rowToNote(encoded);
  assert.equal(decoded?.deltaTrigger, 'foo');
  assert.equal(decoded?.deltaAction, 'bar');
});

test('Wikilinks extraction, unique slug generation, and self-excluding backlinks', () => {
  assert.equal(slugify('Playing With Boundaries!'), 'playing-with-boundaries');
  assert.equal(
    generateUniqueSlug('Delays', ['delays', 'delays-2']),
    'delays-3'
  );
  assert.deepEqual(
    extractWikilinks('Compare [[Alpha Beta]] with [[alpha-beta]] and [[Gamma]]'),
    ['alpha-beta', 'gamma']
  );

  const seed = createDemoSeed(new Date('2026-11-15T12:00:00.000Z'));
  const backlinks = computeBacklinks('playing-with-boundaries', seed.notes);
  assert.ok(backlinks.every(n => n.slug !== 'playing-with-boundaries'));
  assert.ok(backlinks.some(n => n.slug === 'delays-in-feedback-loops'));
});

test('Hash router ignores OAuth callback fragments and isSafeHttpUrl blocks unsafe schemes', () => {
  assert.equal(isOAuthCallbackHash('#access_token=ya29.abc&state=123'), true);
  assert.equal(isOAuthCallbackHash('#state=123&access_token=ya29.abc'), true);
  assert.equal(isOAuthCallbackHash('#error=access_denied'), true);
  assert.equal(isOAuthCallbackHash('#/note/error=1'), false);
  assert.equal(parseHash('#access_token=ya29.abc&state=123').view, 'shelf');
  assert.equal(parseHash('#state=123&access_token=ya29.abc').view, 'shelf');
  assert.equal(parseHash('#/note/delays-in-feedback-loops').view, 'note');
  assert.equal(parseHash('#/note/delays-in-feedback-loops').noteSlug, 'delays-in-feedback-loops');
  assert.equal(parseHash('#/book/book-systems').bookId, 'book-systems');

  assert.equal(isSafeHttpUrl('https://docs.google.com/document/d/123'), true);
  assert.equal(isSafeHttpUrl('http://example.com/path'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('JAVASCRIPT:alert(1)'), false);
  assert.equal(isSafeHttpUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeHttpUrl('/relative/path'), false);
  assert.equal(isSafeHttpUrl(''), false);
});

test('GoogleSheetsAdapter: schema auto-repair, UUID A:A lookup, modifiedTime cache hit, and 401 trigger', async () => {
  localStorage.clear();
  const originalFetch = globalThis.fetch;

  try {
    // 1. Mock fetch for schema repair + initial load
    const calls = [];
    const sheetRows = {
      Books: [['wrong_header'], bookToRow(createDemoSeed().books[0])],
      Notes: [
        [...NOTES_HEADERS],
        noteToRow(createDemoSeed().notes[0]),
        noteToRow(createDemoSeed().notes[1]),
      ],
      Sessions: [[...SESSIONS_HEADERS]],
      DeltaLogs: [[...DELTA_LOGS_HEADERS]],
    };

    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-test-123');

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = (opts.method || 'GET').toUpperCase();
      calls.push({ method, url: u, body: opts.body });

      // Drive metadata
      if (u.includes('drive/v3/files/sheet-test-123')) {
        return new Response(
          JSON.stringify({ id: 'sheet-test-123', name: 'Pragya Commonplace', modifiedTime: '2026-11-15T10:00:00Z' }),
          { status: 200 }
        );
      }
      // Spreadsheet properties (missing DeltaLogs tab!)
      if (u.includes('fields=sheets.properties')) {
        return new Response(
          JSON.stringify({
            sheets: [
              { properties: { title: 'Books' } },
              { properties: { title: 'Notes' } },
              { properties: { title: 'Sessions' } },
            ],
          }),
          { status: 200 }
        );
      }
      // batchUpdate addSheet
      if (u.includes(':batchUpdate') && method === 'POST') {
        return new Response(JSON.stringify({ replies: [{}] }), { status: 200 });
      }
      // Header batchGet
      if (u.includes('values:batchGet') && u.includes('A1%3AL1')) {
        return new Response(
          JSON.stringify({
            valueRanges: [
              { range: 'Books!A1:L1', values: [sheetRows.Books[0]] },
              { range: 'Notes!A1:R1', values: [sheetRows.Notes[0]] },
              { range: 'Sessions!A1:G1', values: [sheetRows.Sessions[0]] },
              { range: 'DeltaLogs!A1:E1', values: [] },
            ],
          }),
          { status: 200 }
        );
      }
      // Repair PUT header
      if (u.includes('/values/') && method === 'PUT') {
        return new Response(JSON.stringify({ updatedRows: 1 }), { status: 200 });
      }
      // Data batchGet
      if (u.includes('values:batchGet') && u.includes('Books!A%3AL')) {
        return new Response(
          JSON.stringify({
            valueRanges: [
              { range: 'Books!A:L', values: sheetRows.Books },
              { range: 'Notes!A:R', values: sheetRows.Notes },
              { range: 'Sessions!A:G', values: sheetRows.Sessions },
              { range: 'DeltaLogs!A:E', values: sheetRows.DeltaLogs },
            ],
          }),
          { status: 200 }
        );
      }
      // M6 Batch 3 (R1#2): one-cell id verification before a UUID-resolved PUT.
      const idCell = /\/values\/Notes!A(\d+)\?valueRenderOption=UNFORMATTED_VALUE/.exec(u);
      if (idCell && method === 'GET') {
        const row = sheetRows.Notes[Number(idCell[1]) - 1];
        return new Response(JSON.stringify({ values: row ? [[row[0]]] : [] }), { status: 200 });
      }
      // UUID A:A lookup
      if (u.includes('/values/Notes!A%3AA')) {
        return new Response(
          JSON.stringify({
            values: sheetRows.Notes.map(r => [r[0]]),
          }),
          { status: 200 }
        );
      }
      // Append
      if (u.includes(':append') && method === 'POST') {
        return new Response(JSON.stringify({ updates: { updatedRows: 1 } }), { status: 200 });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    };

    let unauthorizedCount = 0;
    const adapter = new GoogleSheetsAdapter(
      () => 'ya29.valid-test-token',
      () => {
        unauthorizedCount += 1;
      }
    );

    const loaded = await adapter.loadWorkspace();
    assert.equal(loaded.books.length, 1);
    assert.equal(loaded.notes.length, 2);

    // Verify missing DeltaLogs tab was added and Books/DeltaLogs headers were repaired
    assert.ok(calls.some(c => c.url.includes(':batchUpdate') && c.method === 'POST'));
    assert.ok(calls.some(c => c.url.includes('Books!A1%3AL1') && c.method === 'PUT'));
    assert.ok(calls.some(c => c.url.includes('DeltaLogs!A1%3AE1') && c.method === 'PUT'));

    // 2. modifiedTime cache hit must skip Sheets batchGet
    calls.length = 0;
    const cachedLoad = await adapter.loadWorkspace();
    assert.equal(cachedLoad.notes.length, 2);
    assert.equal(
      calls.filter(c => c.url.includes('sheets.googleapis.com')).length,
      0,
      'Expected zero Sheets API calls on modifiedTime cache hit'
    );
    assert.ok(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY));

    // 2b. Changed remote modifiedTime invalidates cache and re-fetches Sheets
    const prevFetch = globalThis.fetch;
    let currentModifiedTime = '2026-11-15T10:05:00Z';
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('drive/v3/files/sheet-test-123')) {
        calls.push({ method: (opts.method || 'GET').toUpperCase(), url: u, body: opts.body });
        return new Response(
          JSON.stringify({ id: 'sheet-test-123', name: 'Pragya Commonplace', modifiedTime: currentModifiedTime }),
          { status: 200 }
        );
      }
      return prevFetch(url, opts);
    };
    calls.length = 0;
    await adapter.loadWorkspace();
    assert.ok(
      calls.some(c => c.url.includes('Books!A%3AL')),
      'Expected Sheets reload when modifiedTime changed'
    );
    globalThis.fetch = prevFetch;

    // 3. UUID-resolved PUT updates exact row 3 when updating second note
    calls.length = 0;
    const updatedSecondNote = { ...loaded.notes[1], takeaway: 'Updated via UUID lookup' };
    await adapter.saveNote(updatedSecondNote);
    assert.ok(calls.some(c => c.url.includes('/values/Notes!A%3AA') && c.method === 'GET'));
    assert.ok(calls.some(c => c.url.includes('Notes!A3%3AR3') && c.method === 'PUT'));

    // 4. Absent UUID falls back to :append
    calls.length = 0;
    const brandNewNote = { ...loaded.notes[1], id: 'note-brand-new-uuid', slug: 'brand-new' };
    await adapter.saveNote(brandNewNote);
    assert.ok(calls.some(c => c.url.includes('Notes!A1:append') && c.method === 'POST'));

    // 5. 401 triggers onUnauthorized callback
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 });
    await assert.rejects(() => adapter.loadWorkspace({ forceRefresh: true }), /401/);
    assert.equal(unauthorizedCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    localStorage.clear();
  }
});

test('GoogleSheetsAdapter: spreadsheet auto-creation, Pragya Media upload, and Doc title resolution', async () => {
  localStorage.clear();
  const originalFetch = globalThis.fetch;

  try {
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = (opts.method || 'GET').toUpperCase();
      calls.push({ method, url: u, body: opts.body });

      // Search Pragya Commonplace -> none found
      if (u.includes('drive/v3/files?q=') && u.includes('spreadsheet')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      // Create spreadsheet
      if (u === 'https://sheets.googleapis.com/v4/spreadsheets' && method === 'POST') {
        return new Response(JSON.stringify({ spreadsheetId: 'created-sheet-99' }), { status: 200 });
      }
      // Populate headers batchUpdate
      if (u.includes('created-sheet-99/values:batchUpdate') && method === 'POST') {
        return new Response(JSON.stringify({ totalUpdatedRows: 4 }), { status: 200 });
      }
      if (u.includes('drive/v3/files/created-sheet-99')) {
        return new Response(
          JSON.stringify({ id: 'created-sheet-99', modifiedTime: '2026-11-15T11:00:00Z' }),
          { status: 200 }
        );
      }
      if (u.includes('values:batchGet') && u.includes('Books!A%3AL')) {
        return new Response(
          JSON.stringify({
            valueRanges: [
              { range: 'Books!A:L', values: [[...BOOKS_HEADERS]] },
              { range: 'Notes!A:R', values: [[...NOTES_HEADERS]] },
              { range: 'Sessions!A:G', values: [[...SESSIONS_HEADERS]] },
              { range: 'DeltaLogs!A:E', values: [[...DELTA_LOGS_HEADERS]] },
            ],
          }),
          { status: 200 }
        );
      }
      // Search Pragya Media folder -> none found -> create folder
      if (u.includes('drive/v3/files?q=') && u.includes('folder')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      if (u === 'https://www.googleapis.com/drive/v3/files' && method === 'POST') {
        return new Response(JSON.stringify({ id: 'media-folder-77' }), { status: 200 });
      }
      // Multipart image upload
      if (u.includes('upload/drive/v3/files?uploadType=multipart') && method === 'POST') {
        return new Response(
          JSON.stringify({ id: 'drive-img-555', name: 'diagram.webp', mimeType: 'image/webp' }),
          { status: 200 }
        );
      }
      // Resolve doc title
      if (u.includes('drive/v3/files/doc-xyz')) {
        return new Response(JSON.stringify({ id: 'doc-xyz', name: 'Reading Companion' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    let unauthCalls = 0;
    const adapter = new GoogleSheetsAdapter(
      () => 'ya29.test-token',
      () => {
        unauthCalls += 1;
      }
    );

    const ws = await adapter.loadWorkspace();
    assert.equal(ws.spreadsheetId, 'created-sheet-99');
    assert.equal(localStorage.getItem(SPREADSHEET_ID_STORAGE_KEY), 'created-sheet-99');
    assert.ok(
      calls.some(
        c =>
          c.url === 'https://sheets.googleapis.com/v4/spreadsheets' &&
          c.method === 'POST' &&
          String(c.body).includes('Pragya Commonplace')
      )
    );
    assert.ok(
      calls.some(c => c.url.includes('created-sheet-99/values:batchUpdate') && c.method === 'POST')
    );

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    const att = await adapter.uploadImage(blob, 'diagram.webp', 'image/webp', 800, 600);
    assert.equal(att.type, 'image');
    assert.equal(att.driveFileId, 'drive-img-555');
    assert.equal(att.fileName, 'diagram.webp');
    assert.ok(
      calls.some(
        c =>
          c.url === 'https://www.googleapis.com/drive/v3/files' &&
          c.method === 'POST' &&
          String(c.body).includes('Pragya Media')
      )
    );

    const docTitle = await adapter.resolveDocTitle('doc-xyz');
    assert.equal(docTitle, 'Reading Companion');

    // 401 in resolveDocTitle propagates & triggers callback
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 });
    await assert.rejects(() => adapter.resolveDocTitle('doc-xyz'), /401/);
    assert.equal(unauthCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    localStorage.clear();
  }
});

test('GoogleSheetsAdapter: 404/403 cache recovery, no partial cache poisoning, and trashed media folder recovery', async () => {
  localStorage.clear();
  const originalFetch = globalThis.fetch;

  try {
    // Seed stale cached spreadsheet & stale cached media folder
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'deleted-sheet-id');
    localStorage.setItem(
      SHEETS_CACHE_STORAGE_KEY,
      JSON.stringify({
        spreadsheetId: 'deleted-sheet-id',
        modifiedTime: '2026-11-14T00:00:00Z',
        state: { books: [], notes: [], sessions: [], deltaLogs: [] },
      })
    );
    localStorage.setItem(MEDIA_FOLDER_ID_STORAGE_KEY, 'trashed-folder-id');

    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = (opts.method || 'GET').toUpperCase();
      calls.push({ method, url: u });

      // Stale spreadsheet returns 404
      if (u.includes('drive/v3/files/deleted-sheet-id')) {
        return new Response('Not Found', { status: 404 });
      }
      // Rediscover spreadsheet via Drive search
      if (u.includes('drive/v3/files?q=') && u.includes('spreadsheet')) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'recovered-sheet-42',
                name: 'Pragya Commonplace',
                modifiedTime: '2026-11-15T12:30:00Z',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes('fields=sheets.properties')) {
        return new Response(
          JSON.stringify({
            sheets: [
              { properties: { title: 'Books' } },
              { properties: { title: 'Notes' } },
              { properties: { title: 'Sessions' } },
              { properties: { title: 'DeltaLogs' } },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes('values:batchGet') && u.includes('A1%3AL1')) {
        return new Response(
          JSON.stringify({
            valueRanges: [
              { range: 'Books!A1:L1', values: [[...BOOKS_HEADERS]] },
              { range: 'Notes!A1:R1', values: [[...NOTES_HEADERS]] },
              { range: 'Sessions!A1:G1', values: [[...SESSIONS_HEADERS]] },
              { range: 'DeltaLogs!A1:E1', values: [[...DELTA_LOGS_HEADERS]] },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes('values:batchGet') && u.includes('Books!A%3AL')) {
        return new Response(
          JSON.stringify({
            valueRanges: [
              { range: 'Books!A:L', values: [[...BOOKS_HEADERS]] },
              { range: 'Notes!A:R', values: [[...NOTES_HEADERS]] },
              { range: 'Sessions!A:G', values: [[...SESSIONS_HEADERS]] },
              { range: 'DeltaLogs!A:E', values: [[...DELTA_LOGS_HEADERS]] },
            ],
          }),
          { status: 200 }
        );
      }
      // Trashed media folder check
      if (u.includes('drive/v3/files/trashed-folder-id')) {
        return new Response(JSON.stringify({ id: 'trashed-folder-id', trashed: true }), {
          status: 200,
        });
      }
      if (u.includes('drive/v3/files?q=') && u.includes('folder')) {
        return new Response(
          JSON.stringify({ files: [{ id: 'fresh-media-folder', name: 'Pragya Media' }] }),
          { status: 200 }
        );
      }
      if (u.includes('upload/drive/v3/files?uploadType=multipart') && method === 'POST') {
        return new Response(
          JSON.stringify({ id: 'drive-img-999', name: 'fresh.webp', mimeType: 'image/webp' }),
          { status: 200 }
        );
      }
      if (u.includes('/values/') || u.includes(':append')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const adapter = new GoogleSheetsAdapter(() => 'ya29.test-token');
    const ws = await adapter.loadWorkspace();
    assert.equal(ws.spreadsheetId, 'recovered-sheet-42');
    assert.equal(localStorage.getItem(SPREADSHEET_ID_STORAGE_KEY), 'recovered-sheet-42');

    // Verify trashed media folder is cleared & rediscovered
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    const att = await adapter.uploadImage(blob, 'fresh.webp', 'image/webp', 100, 100);
    assert.equal(att.driveFileId, 'drive-img-999');
    assert.equal(localStorage.getItem(MEDIA_FOLDER_ID_STORAGE_KEY), 'fresh-media-folder');

    // Verify updateCacheAfterMutation does NOT poison cache when cache is missing (null) or belongs to another sheet
    localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
    await adapter.saveNote(createDemoSeed().notes[0]);
    assert.equal(
      localStorage.getItem(SHEETS_CACHE_STORAGE_KEY),
      null,
      'Missing cache must remain null instead of poisoned with 1-note partial workspace'
    );

    localStorage.setItem(
      SHEETS_CACHE_STORAGE_KEY,
      JSON.stringify({
        spreadsheetId: 'other-sheet-id',
        modifiedTime: '2026-11-15T00:00:00Z',
        state: { books: [], notes: [], sessions: [], deltaLogs: [] },
      })
    );
    await adapter.saveBook(createDemoSeed().books[0]);
    assert.equal(
      localStorage.getItem(SHEETS_CACHE_STORAGE_KEY),
      null,
      'Mismatched or missing cache must be invalidated instead of poisoned with 1-item workspace'
    );

    // Subsequent loadWorkspace performs full Sheets batchGet instead of returning partial state
    calls.length = 0;
    await adapter.loadWorkspace();
    assert.ok(
      calls.some(c => c.url.includes('Books!A%3AL')),
      'Expected full Sheets batchGet after uncached mutation'
    );
  } finally {
    globalThis.fetch = originalFetch;
    localStorage.clear();
  }
});
