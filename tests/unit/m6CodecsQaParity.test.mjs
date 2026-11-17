// QA (Batch 1) — adversarial probes for the M6 drift codecs.
// - TS ↔ Python parity on a shared drift matrix (spawns python3 and imports scripts/pragya_cli.py)
// - Idempotency of every normalizer
// - PWA edit flows (+10p bookmark advance, Mark Reviewed, Edit book/note, Deepen) keep unknown keys
// - Prototype-ish keys (__proto__, constructor) survive round-trip without pollution
// - Fractional serial timestamps; timezone independence of serial-date decoding
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
        const parentDir = path.dirname(fileURLToPath(context.parentURL));
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

const {
  normalizeBookMeta,
  normalizeNoteMeta,
  normalizeAttachments,
  normalizeBookFormat,
  normalizeNoteSource,
} = await load('src/utils/metaCodecs.ts');
const {
  bookToRow,
  rowToBook,
  noteToRow,
  rowToNote,
  decodeSheetDate,
  decodeSheetTimestamp,
} = await load('src/utils/sheetCodecs.ts');
const { buildSnapshot, validateSnapshotPayload } = await load('src/utils/snapshot.ts');
const { applyBookmarkAdvance } = await load('src/utils/sessionCoalesce.ts');

// ---------------------------------------------------------------------------
// Shared drift matrix
// ---------------------------------------------------------------------------

const BOOK_META_CASES = [
  { updatedAt: '2026-11-15T00:00:00.000Z', subgenre: 'memoir' },
  { chapterNote: 'Ch 3' },
  { chapterNote: 'old', currentChapter: 'new' },
  { chapterNote: '   ', currentChapter: '' },
  { chapterNote: 7 },
  { currentChapter: 3, startedAt: 12345, finishedAt: true, coverUrl: null },
  { capstone: { arcOrThesis: 'Arc', keyLearnings: 'one', extra: { x: 1 } } },
  { capstone: { keyLearnings: ['a', 1, null, '  b  ', ''] } },
  { capstone: 'nope' },
  { capstone: ['x'] },
  { capstone: null },
  { updatedAt: 0 },
  { updatedAt: '   ' },
  { updatedAt: true },
  { updatedAt: 1731700000000 },
  { nested: { deep: [1, { two: [3] }] }, emoji: 'पढ़ना 📚' },
  '{"subgenre":"memoir","chapterNote":"Ch 1"}',
  '[1,2]',
  'null',
  'oops',
  '',
  '   ',
  '{',
  '"str"',
  '42',
  null,
  42,
  [1, 2],
];

const NOTE_META_CASES = [
  { q1: 'a', q2: 'b' },
  { q1: '  a  ', q2: '', q3: 'c' },
  { socraticQuestions: ['x'], q1: 'a' },
  { socraticQuestions: [], q1: 'a', q2: 'b' },
  { socraticQuestions: 'solo' },
  { socraticQuestions: ['1', '2', '3', '4'] },
  { socraticQuestions: [42, null, 'ok', true] },
  { socraticQuestions: ['', '  '] },
  { q1: 5, q2: null },
  { isPrediction: 'false', ocrBackfilled: 'YES' },
  { isPrediction: 'maybe', ocrBackfilled: 0 },
  { isPrediction: null, ocrBackfilled: 2.5 },
  { isPrediction: '', ocrBackfilled: [] },
  { title: '', exportedAt: 5, lastReviewedAt: '2026-11-16', chapter: 3, sparStage: '' },
  { chapter: 'Ch 3', sparStage: 'stage-2', custom: { a: [1] } },
  { links: ['a', 1, null, '', true, 2.5] },
  { links: 'notalist' },
  {
    attachments: [
      null,
      { id: 'i', type: 'image' },
      { id: 'd', type: 'doc' },
      { id: 'l', type: 'link', url: 'https://x', title: 7, localPath: '/p' },
      { id: ' ', type: 'image' },
      { id: 'i2', type: 'image', fileName: 'a.png', mimeType: '' },
      { id: 'i3', type: 'image' },
    ],
  },
  { attachments: { id: 'x' } },
  '{"q1":"a","q2":"b","sparStage":"s"}',
  '[1,2]',
  'null',
  'oops',
  '',
  null,
  7,
];

const FORMAT_CASES = ['print', 'Hardcover', ' paperback ', 'physical', 'Ebook', 'KINDLE', 'audiobook', '', null, 5];
const SOURCE_CASES = ['companion', 'Agent', ' assistant ', 'CLI', 'skill', 'app', 'web', '', null, 1];

const DATE_CASES = [
  46342,
  '46342',
  46342.99,
  ' 46342.25 ',
  46342.999999,
  1,
  0,
  -5,
  2958465.5,
  2958466,
  '2026-11-16',
  '  2026-11-16 ',
  'garbage',
  '1234',
  '123456',
  '46342.',
  '4.6342e4',
  null,
];
const TS_CASES = [
  46342,
  46342.5,
  '46342.5',
  46342.123456789,
  46342.0000057870,
  46342.99999999,
  25569,
  25568.5,
  1,
  '2026-11-16T08:00:00.000Z',
  'oops',
  null,
];

function runPython(payload) {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, 'scripts'))})
import pragya_cli as c
p = json.load(sys.stdin)
out = {
  "book": [c.normalize_book_meta(x) for x in p["book"]],
  "note": [c.normalize_note_meta(x) for x in p["note"]],
  "fmt": [c.normalize_book_format(x) for x in p["fmt"]],
  "src": [c.normalize_note_source(x) for x in p["src"]],
  "date": [c.decode_sheet_date(x) for x in p["date"]],
  "ts": [c.decode_sheet_timestamp(x) for x in p["ts"]],
}
json.dump(out, sys.stdout, ensure_ascii=False)
`;
  const res = spawnSync('python3', ['-c', script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`python3 failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

const pythonAvailable = spawnSync('python3', ['--version']).status === 0;

test('QA parity: TS and Python normalizers agree on the shared drift matrix', { skip: !pythonAvailable }, () => {
  const py = runPython({
    book: BOOK_META_CASES,
    note: NOTE_META_CASES,
    fmt: FORMAT_CASES,
    src: SOURCE_CASES,
    date: DATE_CASES,
    ts: TS_CASES,
  });
  BOOK_META_CASES.forEach((input, i) => {
    assert.deepEqual(py.book[i], normalizeBookMeta(input), `book meta #${i} ${JSON.stringify(input)}`);
  });
  NOTE_META_CASES.forEach((input, i) => {
    assert.deepEqual(py.note[i], normalizeNoteMeta(input), `note meta #${i} ${JSON.stringify(input)}`);
  });
  FORMAT_CASES.forEach((input, i) => assert.equal(py.fmt[i], normalizeBookFormat(input), `fmt ${input}`));
  SOURCE_CASES.forEach((input, i) => assert.equal(py.src[i], normalizeNoteSource(input), `src ${input}`));
  DATE_CASES.forEach((input, i) => assert.equal(py.date[i], decodeSheetDate(input), `date ${input}`));
  TS_CASES.forEach((input, i) => assert.equal(py.ts[i], decodeSheetTimestamp(input), `ts ${input}`));
});

test('QA: all TS normalizers are idempotent across the matrix', () => {
  for (const input of BOOK_META_CASES) {
    const once = normalizeBookMeta(input);
    assert.deepEqual(normalizeBookMeta(once), once, JSON.stringify(input));
    assert.deepEqual(normalizeBookMeta(JSON.stringify(once)), once);
  }
  for (const input of NOTE_META_CASES) {
    const once = normalizeNoteMeta(input);
    assert.deepEqual(normalizeNoteMeta(once), once, JSON.stringify(input));
    assert.deepEqual(normalizeNoteMeta(JSON.stringify(once)), once);
  }
  const atts = normalizeAttachments(NOTE_META_CASES[17].attachments);
  assert.deepEqual(normalizeAttachments(atts), atts);
});

test('QA: normalizers never mutate their input', () => {
  const bookIn = { chapterNote: 'Ch 3', capstone: { keyLearnings: 'x' }, subgenre: 'm' };
  const bookCopy = structuredClone(bookIn);
  normalizeBookMeta(bookIn);
  assert.deepEqual(bookIn, bookCopy);
  const noteIn = { q1: 'a', q2: 'b', attachments: [{ id: 'i', type: 'image' }], links: [1] };
  const noteCopy = structuredClone(noteIn);
  normalizeNoteMeta(noteIn);
  assert.deepEqual(noteIn, noteCopy);
});

test('QA: __proto__/constructor keys in metaJson round-trip without prototype pollution', () => {
  const raw = '{"__proto__":{"polluted":true},"constructor":"c","updatedAt":"u","subgenre":"s"}';
  const meta = normalizeBookMeta(raw);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(meta, '__proto__'), true);
  assert.equal(meta.subgenre, 's');
  const row = [
    'b1', 'T', 'A', 'physical', 'nonfiction', 'reading', 1, 10, 'page', 0.1, '', raw,
  ];
  const book = rowToBook(row);
  const again = rowToBook(bookToRow(book));
  assert.deepEqual(again, book);
  assert.deepEqual(JSON.parse(bookToRow(again)[11]).__proto__, { polluted: true });
  assert.equal({}.polluted, undefined);
});

// ---------------------------------------------------------------------------
// PWA edit flows must never strip unknown keys
// ---------------------------------------------------------------------------

const DRIFT_BOOK_ROW = [
  'book-1', 'Born a Crime', 'Trevor Noah', 'print', 'nonfiction', 'reading', 100, 304, 'page',
  Number((100 / 304).toFixed(6)), '',
  JSON.stringify({
    chapterNote: 'Ch 3',
    subgenre: 'memoir',
    capstone: { arcOrThesis: 'A', keyLearnings: ['k'], perspectiveShift: 'p', completedAt: 'c', v: 2 },
    agentState: { lastSpar: '2026-11-10' },
  }),
];
const DRIFT_NOTE_ROW = [
  'note-1', 'slug-1', 'book-1', '2026-11-01T10:00:00.000Z', '2026-11-02T10:00:00.000Z', 55,
  0.18, 'in-reflection', 'companion', '#a', 'Q', 'T', '', '', '', '', 'none',
  JSON.stringify({
    q1: 'Why?', q2: 'How?', chapter: 'Ch 2', sparStage: 'stage-1', agentState: { x: 1 },
    attachments: [{ id: 'l', type: 'link', url: 'https://x', title: 't' }], links: [],
  }),
];

function writtenBookMeta(book) {
  return JSON.parse(bookToRow(book)[11]);
}
function writtenNoteMeta(note) {
  return JSON.parse(noteToRow(note)[17]);
}

test('QA: +10p bookmark advance (applyBookmarkAdvance) keeps unknown book meta keys', () => {
  const book = rowToBook(DRIFT_BOOK_ROW);
  const result = applyBookmarkAdvance(book, 110, { nowIso: '2026-11-16T12:00:00.000Z' });
  assert.equal(result.changed, true);
  assert.equal(result.updatedBook.currentPos, 110);
  const next = result.updatedBook;
  const meta = writtenBookMeta(next);
  assert.equal(meta.subgenre, 'memoir');
  assert.equal(meta.currentChapter, 'Ch 3');
  assert.deepEqual(meta.agentState, { lastSpar: '2026-11-10' });
  assert.equal(meta.capstone.v, 2);
  assert.equal('chapterNote' in meta, false);
  assert.equal(meta.updatedAt, '2026-11-16T12:00:00.000Z');
});

test('QA: EditBookModal-style spread + updatedAt bump keeps unknown book meta keys', () => {
  const book = rowToBook(DRIFT_BOOK_ROW);
  const nowIso = '2026-11-16T12:00:00.000Z';
  const edited = {
    ...book,
    title: 'Edited',
    status: 'finished',
    meta: {
      ...book.meta,
      ...(!book.meta.finishedAt ? { finishedAt: nowIso } : {}),
      updatedAt: nowIso,
    },
  };
  const meta = writtenBookMeta(edited);
  assert.deepEqual(
    Object.keys(meta).sort(),
    ['agentState', 'capstone', 'currentChapter', 'finishedAt', 'subgenre', 'updatedAt'].sort()
  );
  // And through a full rowToBook/snapshot cycle.
  const reread = rowToBook(bookToRow(edited));
  const snap = validateSnapshotPayload(
    JSON.stringify(buildSnapshot({ books: [reread], notes: [], sessions: [], deltaLogs: [] }))
  );
  assert.deepEqual(snap.snapshot.books[0], reread);
});

test('QA: Mark Reviewed / Edit / Deepen note spreads keep sparStage, chapter, socraticQuestions, unknowns', () => {
  const note = rowToNote(DRIFT_NOTE_ROW);
  assert.equal(note.source, 'agent');
  assert.deepEqual(note.meta.socraticQuestions, ['Why?', 'How?']);

  // PracticeView "Mark Reviewed"
  const reviewed = { ...note, meta: { ...note.meta, lastReviewedAt: '2026-11-16' } };
  // EditNoteModal with title cleared
  const editedNote = {
    ...reviewed,
    meta: { ...reviewed.meta, title: undefined, attachments: reviewed.meta.attachments.slice(0, 3) },
  };
  // DeepenNoteModal with a title
  const deepened = { ...editedNote, status: 'atomic', meta: { ...editedNote.meta, title: 'New' } };

  for (const n of [reviewed, editedNote, deepened]) {
    const meta = writtenNoteMeta(n);
    assert.equal(meta.sparStage, 'stage-1');
    assert.equal(meta.chapter, 'Ch 2');
    assert.deepEqual(meta.agentState, { x: 1 });
    assert.deepEqual(meta.socraticQuestions, ['Why?', 'How?']);
    assert.equal('q1' in meta, false);
    assert.equal('q2' in meta, false);
    assert.equal(meta.attachments.length, 1);
    const back = rowToNote(noteToRow(n));
    assert.equal(back.meta.sparStage, 'stage-1');
  }
  assert.equal('title' in writtenNoteMeta(editedNote), false);
  assert.equal(writtenNoteMeta(deepened).title, 'New');
  assert.equal(writtenNoteMeta(reviewed).lastReviewedAt, '2026-11-16');
});

// ---------------------------------------------------------------------------
// Serial dates: fractional timestamps and timezone independence
// ---------------------------------------------------------------------------

test('QA: fractional serial timestamps decode to UTC ISO with ms rounding', () => {
  assert.equal(decodeSheetTimestamp(46342.75), '2026-11-16T18:00:00.000Z');
  assert.equal(decodeSheetTimestamp(46342 + 1 / 86400), '2026-11-16T00:00:01.000Z');
  assert.equal(decodeSheetTimestamp(46342.99999999), '2026-11-16T23:59:59.999Z');
  assert.equal(decodeSheetTimestamp(25568.5), '1969-12-31T12:00:00.000Z');
  assert.equal(decodeSheetDate(46342.999999), '2026-11-16');
  // ISO strings are never mistaken for serials.
  assert.equal(decodeSheetTimestamp('2026-11-16'), '2026-11-16');
  assert.equal(decodeSheetDate('123456'), '123456');
  assert.equal(decodeSheetDate('46342.'), '46342.');
});

test('QA: serial-date decoding is independent of the process timezone', { skip: process.platform === 'win32' }, () => {
  const probe = `
    import fs from 'node:fs'; import path from 'node:path'; import module from 'node:module';
    import { fileURLToPath, pathToFileURL } from 'node:url';
    module.registerHooks({ resolve(spec, ctx, next) {
      if ((spec.startsWith('./') || spec.startsWith('../')) && !path.extname(spec) && ctx.parentURL) {
        const dir = path.dirname(fileURLToPath(ctx.parentURL));
        for (const ext of ['.ts', '.mjs', '.js']) {
          const c = path.resolve(dir, spec + ext);
          if (fs.existsSync(c)) return next(pathToFileURL(c).href, ctx);
        }
      }
      return next(spec, ctx);
    } });
    import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src/utils/sheetCodecs.ts')).href)}).then(m => {
      process.stdout.write(JSON.stringify([m.decodeSheetDate(46342), m.decodeSheetDate(46342.99),
        m.decodeSheetTimestamp(46342.5), m.decodeSheetDate('46342.01')]));
    });
  `;
  const outputs = new Set();
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata']) {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    outputs.add(res.stdout);
  }
  assert.equal(outputs.size, 1, [...outputs].join(' | '));
  assert.deepEqual(JSON.parse([...outputs][0]), [
    '2026-11-16',
    '2026-11-16',
    '2026-11-16T12:00:00.000Z',
    '2026-11-16',
  ]);
});

// ---------------------------------------------------------------------------
// QA re-verify (fix-up): EditNoteModal attachment split/merge + verbatim storage
// ---------------------------------------------------------------------------

const {
  splitAttachments,
  mergePreservedAttachments,
  getRenderableAttachments,
} = await load('src/utils/metaCodecs.ts');

const ATT = {
  a: { id: 'a', type: 'link', url: 'https://a.example', title: 'A' },
  b: { id: 'b', type: 'doc', url: 'https://docs.google.com/document/d/b', title: 'B' },
  c: { id: 'c', type: 'image', driveFileId: 'drv-c', fileName: 'c.webp', mimeType: 'image/webp' },
  d: { id: 'd', type: 'link', url: 'https://d.example', title: 'D' },
  junk1: { id: 'v', type: 'video', url: 'https://v' },
  junk2: 'not-an-object',
  junk3: { type: 'link', url: 'https://noid' },
  junk4: { id: 'nourl', type: 'doc' },
};

/** Mirrors EditNoteModal: open → edit renderable → save merge → store via noteToRow/rowToNote. */
function editAndSave(note, editFn) {
  const opened = splitAttachments(note.meta?.attachments).renderable;
  const edited = editFn(opened.slice());
  const saved = {
    ...note,
    meta: {
      ...note.meta,
      attachments: mergePreservedAttachments(
        edited.slice(0, 3),
        splitAttachments(note.meta?.attachments).preserved
      ),
    },
  };
  return rowToNote(noteToRow(saved));
}

function noteWith(attachments) {
  return rowToNote([
    'n-att', 'n-att', 'book-1', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 5, 0.05,
    'saved', 'app', '', '', '', '', '', '', '', 'none',
    JSON.stringify({ attachments, links: [], agentKey: 1 }),
  ]);
}

test('QA re-verify: storage keeps every attachment verbatim (invalid + beyond 3)', () => {
  const stored = [ATT.junk1, ATT.a, ATT.junk2, ATT.b, ATT.c, ATT.d, ATT.junk3, ATT.junk4];
  const note = noteWith(stored);
  assert.deepEqual(note.meta.attachments, stored);
  assert.deepEqual(rowToNote(noteToRow(note)).meta.attachments, stored);
  const snap = validateSnapshotPayload(
    JSON.stringify(buildSnapshot({ books: [], notes: [note], sessions: [], deltaLogs: [] }))
  );
  assert.deepEqual(snap.snapshot.notes[0].meta.attachments, stored);
  assert.deepEqual(getRenderableAttachments(note.meta).map(a => a.id), ['a', 'b', 'c']);
});

test('QA re-verify: no-op edits are idempotent (no duplication, stable after first save)', () => {
  const stored = [ATT.junk1, ATT.a, ATT.junk2, ATT.b, ATT.c, ATT.d, ATT.junk3];
  let note = noteWith(stored);
  const first = editAndSave(note, list => list);
  // First save moves renderable entries to the front; preserved follow in original order.
  assert.deepEqual(first.meta.attachments.map(a => (typeof a === 'string' ? a : a.id ?? 'noid')), [
    'a', 'b', 'c', 'v', 'not-an-object', 'd', 'noid',
  ]);
  note = first;
  for (let i = 0; i < 5; i += 1) {
    note = editAndSave(note, list => list);
    assert.deepEqual(note.meta.attachments, first.meta.attachments, `edit #${i + 2}`);
  }
  assert.equal(note.meta.attachments.length, stored.length, 'no entry duplicated or lost');
  assert.equal(note.meta.agentKey, 1);
});

test('QA re-verify: removing / adding keeps the renderable cap at 3 and preserved entries', () => {
  const note = noteWith([ATT.a, ATT.b, ATT.c, ATT.d, ATT.junk1]);
  assert.deepEqual(splitAttachments(note.meta.attachments).preserved, [ATT.d, ATT.junk1]);

  // Remove "a": the hidden 4th valid entry ("d") becomes renderable (documented promotion).
  const removed = editAndSave(note, list => list.filter(a => a.id !== 'a'));
  assert.deepEqual(removed.meta.attachments.map(a => a.id), ['b', 'c', 'd', 'v']);
  assert.deepEqual(getRenderableAttachments(removed.meta).map(a => a.id), ['b', 'c', 'd']);
  assert.equal(removed.meta.attachments.some(a => a.id === 'a'), false);

  // Editor over-fills (bypassing the UI limit): slice(0,3) still caps the editable part.
  const e = { id: 'e', type: 'link', url: 'https://e.example', title: 'E' };
  const f = { id: 'f', type: 'link', url: 'https://f.example', title: 'F' };
  const overfilled = editAndSave(removed, list => [...list, e, f]);
  assert.equal(getRenderableAttachments(overfilled.meta).length, 3);
  assert.deepEqual(getRenderableAttachments(overfilled.meta).map(a => a.id), ['b', 'c', 'd']);
  assert.equal(overfilled.meta.attachments.some(a => a.id === 'e' || a.id === 'f'), false);
  assert.ok(overfilled.meta.attachments.some(a => a.id === 'v'), 'junk preserved');

  // Clearing all editable entries keeps the junk only.
  const cleared = editAndSave(overfilled, () => []);
  assert.deepEqual(cleared.meta.attachments, [ATT.junk1]);
  assert.deepEqual(getRenderableAttachments(cleared.meta), []);
});

test('QA re-verify: an all-invalid stored list lets the user add 3 new and keeps the junk', () => {
  const junk = [ATT.junk1, ATT.junk2, ATT.junk3, ATT.junk4];
  const note = noteWith(junk);
  assert.deepEqual(splitAttachments(note.meta.attachments).renderable, []);
  const added = editAndSave(note, () => [ATT.a, ATT.b, ATT.c]);
  assert.deepEqual(added.meta.attachments, [ATT.a, ATT.b, ATT.c, ...junk]);
  assert.deepEqual(getRenderableAttachments(added.meta).map(a => a.id), ['a', 'b', 'c']);
});

test('QA re-verify: Deepen / Mark Reviewed spreads keep raw attachments untouched', () => {
  const stored = [ATT.junk2, ATT.a, ATT.b, ATT.c, ATT.d];
  const note = noteWith(stored);
  const reviewed = { ...note, meta: { ...note.meta, lastReviewedAt: '2026-11-16' } };
  const deepened = { ...note, meta: { ...note.meta, title: 'T' } };
  for (const n of [reviewed, deepened]) {
    assert.deepEqual(rowToNote(noteToRow(n)).meta.attachments, stored);
  }
});
