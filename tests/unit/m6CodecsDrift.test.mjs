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
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const {
  normalizeBookMeta,
  normalizeNoteMeta,
  normalizeAttachments,
  normalizeBookFormat,
  normalizeNoteSource,
  getBookCapstone,
  getRenderableAttachments,
  splitAttachments,
  mergePreservedAttachments,
} = await load('src/utils/metaCodecs.ts');
const {
  BOOKS_HEADERS,
  NOTES_HEADERS,
  SESSIONS_HEADERS,
  DELTA_LOGS_HEADERS,
  bookToRow,
  rowToBook,
  noteToRow,
  rowToNote,
  rowToSession,
  rowToDeltaLog,
  decodeSheetDate,
  decodeSheetTimestamp,
} = await load('src/utils/sheetCodecs.ts');
const { buildSnapshot, validateSnapshotPayload } = await load('src/utils/snapshot.ts');
const { upsertCoalescedSession, getLocalDateString } = await load('src/utils/sessionCoalesce.ts');
const {
  GoogleSheetsAdapter,
  SHEETS_CACHE_STORAGE_KEY,
  SHEETS_CACHE_CODEC_VERSION,
  SPREADSHEET_ID_STORAGE_KEY,
} = await load('src/services/googleSheetsAdapter.ts');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CAPSTONE = {
  arcOrThesis: 'Language is survival.',
  keyLearnings: ['Code-switching is belonging', 'Humor defuses violence'],
  perspectiveShift: 'Apartheid as a lived system, not a history lesson.',
  completedAt: '2026-11-10T12:00:00.000Z',
};

function bookRow(format, meta) {
  return [
    'book-born-a-crime',
    'Born a Crime',
    'Trevor Noah',
    format,
    'nonfiction',
    'reading',
    120,
    304,
    'page',
    Number((120 / 304).toFixed(6)),
    '',
    typeof meta === 'string' ? meta : JSON.stringify(meta),
  ];
}

function noteRow(source, meta, overrides = {}) {
  const row = [
    'note-1',
    'language-as-survival',
    'book-born-a-crime',
    '2026-11-01T10:00:00.000Z',
    '2026-11-02T10:00:00.000Z',
    55,
    Number((55 / 304).toFixed(6)),
    'atomic',
    source,
    '#language, #identity',
    'Quote',
    'Takeaway',
    '',
    '',
    '',
    '',
    'none',
    typeof meta === 'string' ? meta : JSON.stringify(meta),
  ];
  for (const [idx, val] of Object.entries(overrides)) row[Number(idx)] = val;
  return row;
}

function metaOfBookRow(row) {
  return JSON.parse(row[11]);
}
function metaOfNoteRow(row) {
  return JSON.parse(row[17]);
}

// ---------------------------------------------------------------------------
// A5.1 — meta pass-through and legacy aliases
// ---------------------------------------------------------------------------

test('A5.1: Books/Notes row round-trip preserves subgenre, capstone, currentChapter, chapter, sparStage', () => {
  const book1 = rowToBook(
    bookRow('physical', {
      updatedAt: '2026-11-15T00:00:00.000Z',
      subgenre: 'memoir',
      currentChapter: 'Ch 7',
      capstone: CAPSTONE,
      nested: { keep: [1, 2, { deep: true }] },
    })
  );
  const book2 = rowToBook(bookToRow(book1));
  assert.deepEqual(book2, book1);
  assert.equal(book2.meta.subgenre, 'memoir');
  assert.equal(book2.meta.currentChapter, 'Ch 7');
  assert.deepEqual(book2.meta.capstone, CAPSTONE);
  assert.deepEqual(book2.meta.nested, { keep: [1, 2, { deep: true }] });

  const note1 = rowToNote(
    noteRow('agent', {
      title: 'Language as Survival',
      attachments: [],
      links: ['identity'],
      chapter: 'Ch 3',
      sparStage: 'stage-2',
      customAgentKey: { a: 1 },
    })
  );
  const note2 = rowToNote(noteToRow(note1));
  assert.deepEqual(note2, note1);
  assert.equal(note2.meta.chapter, 'Ch 3');
  assert.equal(note2.meta.sparStage, 'stage-2');
  assert.deepEqual(note2.meta.customAgentKey, { a: 1 });
});

test('A5.1: snapshot round-trip preserves unknown and new meta keys', () => {
  const book = rowToBook(
    bookRow('kindle', {
      updatedAt: '2026-11-15T00:00:00.000Z',
      subgenre: 'memoir',
      currentChapter: 'Ch 7',
      capstone: CAPSTONE,
    })
  );
  const note = rowToNote(
    noteRow('agent', {
      attachments: [],
      links: [],
      chapter: 'Ch 3',
      sparStage: 'stage-2',
      socraticQuestions: ['Only one?'],
    })
  );
  const ws = { books: [book], notes: [note], sessions: [], deltaLogs: [] };
  const result = validateSnapshotPayload(JSON.stringify(buildSnapshot(ws)));
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.books[0], book);
  assert.deepEqual(result.snapshot.notes[0], note);
});

test('A5.1: chapterNote aliases to currentChapter and is never written back', () => {
  const book = rowToBook(bookRow('physical', { chapterNote: 'Ch 3', updatedAt: 'x' }));
  assert.equal(book.meta.currentChapter, 'Ch 3');
  assert.equal('chapterNote' in book.meta, false);
  assert.equal('chapterNote' in metaOfBookRow(bookToRow(book)), false);

  // An existing currentChapter wins.
  const both = normalizeBookMeta({ chapterNote: 'old', currentChapter: 'new' });
  assert.equal(both.currentChapter, 'new');
  assert.equal('chapterNote' in both, false);

  // Even if a caller builds meta by spreading legacy keys, bookToRow canonicalizes.
  const dirty = { ...book, meta: { ...book.meta, chapterNote: 'Ch 9' } };
  const written = metaOfBookRow(bookToRow(dirty));
  assert.equal('chapterNote' in written, false);
  assert.equal(written.currentChapter, 'Ch 3');
});

test('A5.1: q1/q2 → socraticQuestions; 1–3 kept; 0/empty dropped', () => {
  const cases = [
    [{ q1: 'a', q2: 'b' }, ['a', 'b']],
    [{ q1: '  a  ', q2: '' }, ['a']],
    [{ socraticQuestions: ['x'], q1: 'a', q2: 'b' }, ['x']],
    [{ socraticQuestions: [], q1: 'a', q2: 'b' }, ['a', 'b']],
    [{ socraticQuestions: ['one'] }, ['one']],
    [{ socraticQuestions: ['one', 'two', 'three'] }, ['one', 'two', 'three']],
    [{ socraticQuestions: ['1', '2', '3', '4'] }, ['1', '2', '3']],
    [{ socraticQuestions: [] }, undefined],
    [{ socraticQuestions: ['', '   '] }, undefined],
    [{ socraticQuestions: [42, null, 'ok'] }, ['ok']],
    [{ q1: '', q2: '  ' }, undefined],
  ];
  for (const [input, expected] of cases) {
    const meta = rowToNote(noteRow('app', input)).meta;
    assert.deepEqual(meta.socraticQuestions, expected, JSON.stringify(input));
    assert.equal('q1' in meta, false);
    assert.equal('q2' in meta, false);
    const written = metaOfNoteRow(noteToRow(rowToNote(noteRow('app', input))));
    assert.equal('q1' in written, false);
    assert.equal('q2' in written, false);
    assert.deepEqual(written.socraticQuestions, expected);
  }
});

test('A5.1: malformed metaJson never throws', () => {
  for (const raw of ['[1,2]', 'null', 'oops', '"str"', '42', '', '{', undefined, null, 7]) {
    assert.doesNotThrow(() => rowToBook(bookRow('physical', raw ?? '')));
    const book = rowToBook(bookRow('physical', raw === undefined || raw === null ? '' : raw));
    assert.deepEqual(book.meta, { updatedAt: '' });
    const note = rowToNote(noteRow('app', raw === undefined || raw === null ? '' : raw));
    assert.deepEqual(note.meta, { attachments: [], links: [] });
    assert.doesNotThrow(() => normalizeBookMeta(raw));
    assert.doesNotThrow(() => normalizeNoteMeta(raw));
  }
  // Raw non-string inputs to the normalizers.
  assert.deepEqual(normalizeBookMeta([1, 2]), { updatedAt: '' });
  assert.deepEqual(normalizeNoteMeta(new Date()), { attachments: [], links: [] });
});

test('A5.1: known keys re-validated; capstone preserved verbatim with typed accessor', () => {
  const rawCapstone = { arcOrThesis: 'Arc', keyLearnings: 'single', extra: 'kept' };
  const meta = normalizeBookMeta({
    coverUrl: '',
    startedAt: 12345,
    finishedAt: { bad: true },
    currentChapter: '   ',
    updatedAt: '2026-11-15T00:00:00.000Z',
    capstone: rawCapstone,
  });
  assert.equal('coverUrl' in meta, false);
  assert.equal(meta.startedAt, '12345');
  assert.equal('finishedAt' in meta, false);
  assert.equal('currentChapter' in meta, false);
  // Fix-up (R1#3): stored capstone is never rewritten; the accessor coerces for rendering.
  assert.deepEqual(meta.capstone, rawCapstone);
  assert.deepEqual(getBookCapstone(meta), {
    arcOrThesis: 'Arc',
    keyLearnings: ['single'],
    perspectiveShift: '',
    completedAt: '',
  });

  const rich = { keyLearnings: ['a', 3, null, ' b ', { text: 't', page: 12 }] };
  const kept = normalizeBookMeta({ capstone: rich });
  assert.deepEqual(kept.capstone, rich);
  assert.deepEqual(getBookCapstone(kept).keyLearnings, ['a', '3', 'b']);
  for (const bad of ['str', 42, null, ['x']]) {
    const keptBad = normalizeBookMeta({ capstone: bad });
    assert.deepEqual(keptBad.capstone, bad);
    assert.equal(getBookCapstone(keptBad), undefined);
  }
  assert.equal(getBookCapstone({}), undefined);
  assert.equal(getBookCapstone('nope'), undefined);

  const b1 = rowToBook(bookRow('physical', { updatedAt: 'x', capstone: rich }));
  assert.deepEqual(rowToBook(bookToRow(b1)).meta.capstone, rich);

  const note = normalizeNoteMeta({
    isPrediction: 'false',
    ocrBackfilled: 1,
    title: '',
    lastReviewedAt: '2026-11-15',
  });
  assert.equal(note.isPrediction, false);
  assert.equal(note.ocrBackfilled, true);
  assert.equal('title' in note, false);
  assert.equal(note.lastReviewedAt, '2026-11-15');
  // R2#4: an empty-string boolean is "absent" (dropped), not materialized as false.
  assert.equal('isPrediction' in normalizeNoteMeta({ isPrediction: '' }), false);
});

test('Fix-up R1#1: sparStage passes through verbatim (row + snapshot)', () => {
  for (const value of [{ stage: 2 }, 2, '', 'stage-1', [1, 'a'], null]) {
    const n1 = rowToNote(noteRow('agent', { attachments: [], links: [], sparStage: value }));
    const n2 = rowToNote(noteToRow(n1));
    assert.equal('sparStage' in n2.meta, true, JSON.stringify(value));
    assert.deepEqual(n2.meta.sparStage, value);
    const res = validateSnapshotPayload(
      JSON.stringify(buildSnapshot({ books: [], notes: [n2], sessions: [], deltaLogs: [] }))
    );
    assert.deepEqual(res.snapshot.notes[0].meta.sparStage, value);
  }
});

test('Fix-up R1#2: attachments round-trip verbatim; filtered only at render/edit time', () => {
  const raw = [
    { id: 'img-1', type: 'image', driveFileId: 'drv' },
    { id: 'aud-1', type: 'audio', url: 'https://x/a.mp3' },
    'stray-string',
    { type: 'link', url: 'https://no-id.example' },
    { id: 'link-1', type: 'link', url: 'https://example.com', title: 'L' },
    { id: 'doc-1', type: 'doc', url: 'https://docs.google.com/document/d/abc', title: 'D' },
    { id: 'link-2', type: 'link', url: 'https://fourth.example', title: '4th' },
  ];
  const n1 = rowToNote(noteRow('app', { attachments: raw, links: [] }));
  assert.deepEqual(n1.meta.attachments, raw);
  const n2 = rowToNote(noteToRow(n1));
  assert.deepEqual(n2.meta.attachments, raw);
  const snap = validateSnapshotPayload(
    JSON.stringify(buildSnapshot({ books: [], notes: [n2], sessions: [], deltaLogs: [] }))
  );
  assert.deepEqual(snap.snapshot.notes[0].meta.attachments, raw);

  const rendered = getRenderableAttachments(n2.meta);
  assert.deepEqual(
    rendered.map(a => a.id),
    ['img-1', 'link-1', 'doc-1']
  );
  assert.equal(rendered[0].fileName, 'image.webp');
  assert.deepEqual(getRenderableAttachments(undefined), []);

  // Editor flow: edit the renderable subset, carry the rest through untouched.
  const { renderable, preserved } = splitAttachments(n2.meta.attachments);
  assert.deepEqual(
    renderable.map(a => a.id),
    ['img-1', 'link-1', 'doc-1']
  );
  assert.deepEqual(preserved, [raw[1], raw[2], raw[3], raw[6]]);
  const edited = renderable.filter(a => a.id !== 'link-1');
  const merged = mergePreservedAttachments(edited, preserved);
  const n3 = rowToNote(noteToRow({ ...n2, meta: { ...n2.meta, attachments: merged } }));
  assert.equal(n3.meta.attachments.length, 6);
  assert.ok(n3.meta.attachments.some(a => a && a.id === 'aud-1'));
  assert.ok(n3.meta.attachments.includes('stray-string'));
  assert.equal(
    n3.meta.attachments.some(a => a && a.id === 'link-1'),
    false
  );
});

test('Fix-up R2#8: writers drop only known blank keys', () => {
  const book = rowToBook(bookRow('physical', { updatedAt: 'x', subgenre: 'memoir' }));
  const written = metaOfBookRow(
    bookToRow({ ...book, meta: { ...book.meta, coverUrl: '', subgenre: '' } })
  );
  assert.equal('coverUrl' in written, false);
  assert.equal(written.subgenre, '');
});

test('Fix-up R1#7: empty {} meta writes updatedAt "" (Python parity)', () => {
  const book = rowToBook(bookRow('physical', {}));
  assert.deepEqual(metaOfBookRow(bookToRow({ ...book, meta: {} })), { updatedAt: '' });
});

test('A5.1/B4.10: normalizeAttachments keeps ≤3 valid objects with defaults', () => {
  const out = normalizeAttachments([
    null,
    'string',
    { id: '', type: 'image' },
    { id: 'no-type' },
    { id: 'bad-type', type: 'video', url: 'x' },
    { id: 'link-no-url', type: 'link', title: 'x' },
    { id: 'img-1', type: 'image', driveFileId: 'drv' },
    { id: 'doc-1', type: 'doc', url: 'https://docs.google.com/document/d/abc', title: 'Doc' },
    { id: 'link-1', type: 'link', url: 'https://example.com' },
    { id: 'img-4', type: 'image', fileName: 'x.png', mimeType: 'image/png' },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {
    id: 'img-1',
    type: 'image',
    driveFileId: 'drv',
    fileName: 'image.webp',
    mimeType: 'image/webp',
  });
  assert.equal(out[1].id, 'doc-1');
  assert.deepEqual(out[2], { id: 'link-1', type: 'link', url: 'https://example.com', title: '' });
  assert.deepEqual(normalizeAttachments('nope'), []);
});

// ---------------------------------------------------------------------------
// A5.2 — enum coercion and missing updatedAt
// ---------------------------------------------------------------------------

test('A5.2: format/source drift coercion through Sheet and snapshot paths', () => {
  const formatCases = [
    ['print', 'physical'],
    ['Hardcover', 'physical'],
    [' paperback ', 'physical'],
    ['physical', 'physical'],
    ['Ebook', 'kindle'],
    ['KINDLE', 'kindle'],
    ['audiobook', 'physical'],
    ['', 'physical'],
    [undefined, 'physical'],
  ];
  for (const [raw, expected] of formatCases) {
    assert.equal(normalizeBookFormat(raw), expected, String(raw));
  }
  assert.equal(rowToBook(bookRow('print', {})).format, 'physical');
  assert.equal(rowToBook(bookRow('Ebook', {})).format, 'kindle');

  const sourceCases = [
    ['companion', 'agent'],
    ['Agent', 'agent'],
    ['assistant', 'agent'],
    ['cli', 'agent'],
    ['skill', 'agent'],
    ['app', 'app'],
    ['web', 'app'],
    ['', 'app'],
  ];
  for (const [raw, expected] of sourceCases) {
    assert.equal(normalizeNoteSource(raw), expected, String(raw));
  }
  assert.equal(rowToNote(noteRow('companion', {})).source, 'agent');

  const snap = {
    version: 1,
    exportedAt: '2026-11-16T00:00:00.000Z',
    books: [{ id: 'b1', title: 'T', format: 'print', meta: { chapterNote: 'Ch 2' } }],
    notes: [{ id: 'n1', bookId: 'b1', source: 'companion', meta: { q1: 'a', q2: 'b' } }],
    sessions: [],
    deltaLogs: [],
  };
  const result = validateSnapshotPayload(snap);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.books[0].format, 'physical');
  assert.equal(result.snapshot.books[0].meta.currentChapter, 'Ch 2');
  assert.equal(result.snapshot.books[0].meta.updatedAt, '');
  assert.equal(result.snapshot.notes[0].source, 'agent');
  assert.deepEqual(result.snapshot.notes[0].meta.socraticQuestions, ['a', 'b']);
});

test('A5.2: missing updatedAt reads as "" (row + snapshot)', () => {
  assert.equal(rowToBook(bookRow('physical', { subgenre: 'memoir' })).meta.updatedAt, '');
  assert.equal(rowToBook(bookRow('physical', '')).meta.updatedAt, '');
  const res = validateSnapshotPayload({
    version: 1,
    books: [{ id: 'b', title: 't', meta: {} }],
    notes: [],
    sessions: [],
    deltaLogs: [],
  });
  assert.equal(res.snapshot.books[0].meta.updatedAt, '');
});

// ---------------------------------------------------------------------------
// Adapter: saveBook with base "" + A5.3 cache codecVersion
// ---------------------------------------------------------------------------

function makeSheetsFetch({ modifiedTime, sheetRows, calls }) {
  return async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ method, url: u, body: opts.body });
    if (u.includes('drive/v3/files/sheet-m6')) {
      return new Response(JSON.stringify({ id: 'sheet-m6', modifiedTime }), { status: 200 });
    }
    if (u.includes('fields=sheets.properties')) {
      return new Response(
        JSON.stringify({
          sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map(title => ({
            properties: { title },
          })),
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
            { range: 'Books!A:L', values: sheetRows.Books },
            { range: 'Notes!A:R', values: sheetRows.Notes },
            { range: 'Sessions!A:G', values: sheetRows.Sessions },
            { range: 'DeltaLogs!A:E', values: sheetRows.DeltaLogs },
          ],
        }),
        { status: 200 }
      );
    }
    if (u.includes('/values/Books!A%3AA')) {
      return new Response(JSON.stringify({ values: sheetRows.Books.map(r => [r[0]]) }), {
        status: 200,
      });
    }
    // M6 Batch 3 (R1#2): one-cell id verification before a UUID-resolved PUT.
    const idCell = /\/values\/Books!A(\d+)\?valueRenderOption=UNFORMATTED_VALUE/.exec(u);
    if (idCell && method === 'GET') {
      const row = sheetRows.Books[Number(idCell[1]) - 1];
      return new Response(JSON.stringify({ values: row ? [[row[0]]] : [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
}

function defaultSheetRows() {
  return {
    Books: [
      [...BOOKS_HEADERS],
      bookRow('print', { subgenre: 'memoir', chapterNote: 'Ch 3' }), // no updatedAt
    ],
    Notes: [[...NOTES_HEADERS]],
    Sessions: [[...SESSIONS_HEADERS]],
    DeltaLogs: [[...DELTA_LOGS_HEADERS]],
  };
}

test('A5.2: saveBook with expectedBaseUpdatedAt "" skips the timestamp pre-read and never conflicts', async () => {
  localStorage.clear();
  const origFetch = globalThis.fetch;
  const calls = [];
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-m6');
    const sheetRows = defaultSheetRows();
    globalThis.fetch = makeSheetsFetch({ modifiedTime: '2026-11-16T00:00:00Z', sheetRows, calls });
    const adapter = new GoogleSheetsAdapter(() => 'tok');
    const ws = await adapter.loadWorkspace();
    const book = ws.books[0];
    assert.equal(book.meta.updatedAt, '');
    assert.equal(book.format, 'physical');

    calls.length = 0;
    const edited = { ...book, title: 'Born a Crime (edited)' };
    await adapter.saveBook(edited, { expectedBaseUpdatedAt: book.meta.updatedAt });
    assert.equal(
      calls.some(c => c.url.includes(encodeURIComponent('Books!L2'))),
      false,
      'No single-cell timestamp pre-read for a falsy base'
    );
    const put = calls.find(c => c.method === 'PUT' && c.url.includes('Books!A2%3AL2'));
    assert.ok(put, 'Expected a UUID-resolved PUT to row 2');
    const written = JSON.parse(put.body).values[0];
    assert.equal(written[3], 'physical');
    const writtenMeta = JSON.parse(written[11]);
    assert.equal(writtenMeta.subgenre, 'memoir');
    assert.equal(writtenMeta.currentChapter, 'Ch 3');
    assert.equal('chapterNote' in writtenMeta, false);
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
  }
});

test('A5.3: legacy cache (no codecVersion) with matching modifiedTime forces batchGet; v2 cache hits', async () => {
  localStorage.clear();
  const origFetch = globalThis.fetch;
  const calls = [];
  const modifiedTime = '2026-11-16T00:00:00Z';
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-m6');
    // Legacy cache: decoded by the old codec, so subgenre is already gone.
    const legacyBook = { ...rowToBook(bookRow('physical', {})), meta: { updatedAt: '' } };
    localStorage.setItem(
      SHEETS_CACHE_STORAGE_KEY,
      JSON.stringify({
        spreadsheetId: 'sheet-m6',
        modifiedTime,
        state: { books: [legacyBook], notes: [], sessions: [], deltaLogs: [] },
      })
    );
    globalThis.fetch = makeSheetsFetch({ modifiedTime, sheetRows: defaultSheetRows(), calls });
    const adapter = new GoogleSheetsAdapter(() => 'tok');

    const ws = await adapter.loadWorkspace();
    assert.ok(
      calls.some(c => c.url.includes('values:batchGet') && c.url.includes('Books!A%3AL')),
      'Legacy cache must not be served as a 0 ms hit'
    );
    assert.equal(ws.books[0].meta.subgenre, 'memoir');
    const rewritten = JSON.parse(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY));
    assert.equal(SHEETS_CACHE_CODEC_VERSION, 2);
    assert.equal(rewritten.codecVersion, 2);
    assert.equal(rewritten.state.books[0].meta.subgenre, 'memoir');

    // Second load: v2 cache + same modifiedTime → zero Sheets calls.
    calls.length = 0;
    const cachedWs = await adapter.loadWorkspace();
    assert.equal(cachedWs.books[0].meta.subgenre, 'memoir');
    assert.equal(calls.filter(c => c.url.includes('sheets.googleapis.com')).length, 0);
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
  }
});

test('A5.3: a legacy cache is never mutated in place after a save (invalidated instead)', async () => {
  localStorage.clear();
  const origFetch = globalThis.fetch;
  const calls = [];
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-m6');
    localStorage.setItem(
      SHEETS_CACHE_STORAGE_KEY,
      JSON.stringify({
        spreadsheetId: 'sheet-m6',
        modifiedTime: '2026-11-15T00:00:00Z',
        state: { books: [], notes: [], sessions: [], deltaLogs: [] },
      })
    );
    globalThis.fetch = makeSheetsFetch({
      modifiedTime: '2026-11-16T00:00:00Z',
      sheetRows: defaultSheetRows(),
      calls,
    });
    const adapter = new GoogleSheetsAdapter(() => 'tok');
    await adapter.saveBook(rowToBook(bookRow('physical', { updatedAt: '' })));
    assert.equal(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY), null);
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
  }
});

test('A5.3: offline read-only fallback still serves a legacy cache (no writes possible)', async () => {
  localStorage.clear();
  const origFetch = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-m6');
    localStorage.setItem(
      SHEETS_CACHE_STORAGE_KEY,
      JSON.stringify({
        spreadsheetId: 'sheet-m6',
        modifiedTime: '2026-11-15T00:00:00Z',
        state: {
          books: [rowToBook(bookRow('physical', { updatedAt: 'x' }))],
          notes: [],
          sessions: [],
          deltaLogs: [],
        },
      })
    );
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const ws = await new GoogleSheetsAdapter(() => 'tok').loadWorkspace();
    assert.equal(ws.isOfflineReadOnly, true);
    assert.equal(ws.books.length, 1);
    // R2#7: the stale cache is never promoted to the current codec by the fallback ...
    assert.equal(JSON.parse(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY)).codecVersion, undefined);

    // ... so the next online load (same modifiedTime) still does a full batchGet.
    const calls = [];
    globalThis.fetch = makeSheetsFetch({
      modifiedTime: '2026-11-15T00:00:00Z',
      sheetRows: defaultSheetRows(),
      calls,
    });
    const online = await new GoogleSheetsAdapter(() => 'tok').loadWorkspace();
    assert.ok(calls.some(c => c.url.includes('values:batchGet') && c.url.includes('Books!A%3AL')));
    assert.equal(online.isOfflineReadOnly, undefined);
    assert.equal(online.books[0].meta.subgenre, 'memoir');
    assert.equal(JSON.parse(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY)).codecVersion, 2);
  } finally {
    globalThis.fetch = origFetch;
    localStorage.clear();
  }
});

// ---------------------------------------------------------------------------
// B1.2 — serial dates on read
// ---------------------------------------------------------------------------

test('B1.2: decodeSheetDate / decodeSheetTimestamp', () => {
  assert.equal(decodeSheetDate(46342), '2026-11-16');
  assert.equal(decodeSheetDate('46342'), '2026-11-16');
  assert.equal(decodeSheetDate(46342.99), '2026-11-16');
  assert.equal(decodeSheetDate(' 46342.25 '), '2026-11-16');
  assert.equal(decodeSheetDate(1), '1899-12-31');
  assert.equal(decodeSheetDate('2026-11-16'), '2026-11-16');
  assert.equal(decodeSheetDate('  2026-11-16 '), '2026-11-16');
  assert.equal(decodeSheetDate('garbage'), 'garbage');
  assert.equal(decodeSheetDate('1234'), '1234');
  assert.equal(decodeSheetDate(0), '0');
  assert.equal(decodeSheetDate(-5), '-5');
  assert.equal(decodeSheetDate(3_000_000), '3000000');
  assert.equal(decodeSheetDate(undefined), '');
  assert.equal(decodeSheetDate(null), '');

  assert.equal(decodeSheetTimestamp(46342), '2026-11-16T00:00:00.000Z');
  assert.equal(decodeSheetTimestamp(46342.5), '2026-11-16T12:00:00.000Z');
  assert.equal(decodeSheetTimestamp('2026-11-16T08:00:00.000Z'), '2026-11-16T08:00:00.000Z');
  assert.equal(decodeSheetTimestamp('oops'), 'oops');

  const s = rowToSession(['s1', 'b1', 46342, 1, 5, 46342.5, '']);
  assert.equal(s.date, '2026-11-16');
  assert.equal(s.updatedAt, '2026-11-16T12:00:00.000Z');
  const d = rowToDeltaLog(['d1', 'n1', 46342, 'applied', '']);
  assert.equal(d.date, '2026-11-16');
  const n = rowToNote(noteRow('app', {}, { 3: 46342, 4: '46342.5' }));
  assert.equal(n.createdAt, '2026-11-16T00:00:00.000Z');
  assert.equal(n.updatedAt, '2026-11-16T12:00:00.000Z');
});

test('B1.2: coalescing matches a decoded serial "today" session', () => {
  const now = new Date();
  const today = getLocalDateString(now);
  const [y, m, d] = today.split('-').map(Number);
  const todaySerial = Date.UTC(y, m - 1, d) / 86_400_000 + 25569;
  const fiveMinAgo = new Date(now.getTime() - 5 * 60_000).toISOString();
  const session = rowToSession(['sess-serial', 'book-1', todaySerial, 10, 20, fiveMinAgo, '']);
  assert.equal(session.date, today);
  const result = upsertCoalescedSession([session], {
    bookId: 'book-1',
    prevPos: 20,
    nextPos: 30,
    nowIso: now.toISOString(),
  });
  assert.equal(result.isNew, false);
  assert.equal(result.upserted.id, 'sess-serial');
  assert.equal(result.upserted.endPos, 30);
});
