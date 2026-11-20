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

/**
 * CD Batch 1b — permanent delete from the archive (C1.2): pure planner + copy, last-delete
 * backup, Google Sheets cascade order / idempotency / mid-cascade failure (in-memory Sheets
 * fake, no network), Undo re-append by UUID, and Demo adapter parity.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const dp = await load('src/utils/deletePlan.ts');
const { GoogleSheetsAdapter, SPREADSHEET_ID_STORAGE_KEY } = await load(
  'src/services/googleSheetsAdapter.ts'
);
const { DemoStorageAdapter } = await load('src/services/demoAdapter.ts');
const codecs = await load('src/utils/sheetCodecs.ts');

const ARCH = '2026-02-01T00:00:00.000Z';
const book = (o = {}) => ({
  id: 'b1', title: 'Thinking in Systems', author: 'Meadows', format: 'physical', kind: 'nonfiction',
  status: 'finished', currentPos: 200, totalPos: 200, posUnit: 'page', normalizedPos: 1, docUrl: '',
  meta: { updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: ARCH, capstone: { arcOrThesis: 'x', extra: 1 } }, ...o,
});
const note = (id, o = {}) => ({
  id, slug: id, bookId: 'b1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', pos: 10,
  normalizedPos: 0.05, status: 'saved', source: 'app', tags: ['#a'], quote: '', takeaway: `t ${id}`,
  contextMechanism: '', critique: '', deltaTrigger: '', deltaAction: '', deltaStatus: 'none',
  meta: { attachments: [], links: [], sparStage: { s: 1 } }, ...o,
});
const rows = () => ({
  books: [book(), book({ id: 'b2', title: 'Other', meta: { updatedAt: 'u' } })],
  notes: [
    note('n1', { meta: { attachments: [], links: [], archivedAt: ARCH } }),
    note('n2'),
    note('n-other', { bookId: 'b2' }),
  ],
  sessions: [
    { id: 's1', bookId: 'b1', date: '2026-01-02', startPos: 0, endPos: 10, updatedAt: 'u', note: '' },
    { id: 's-other', bookId: 'b2', date: '2026-01-02', startPos: 0, endPos: 10, updatedAt: 'u', note: '' },
  ],
  deltaLogs: [
    { id: 'l1', noteId: 'n1', date: '2026-01-03', outcome: 'applied', reflection: '' },
    { id: 'l2', noteId: 'n2', date: '2026-01-03', outcome: 'missed', reflection: 'r' },
    { id: 'l-other', noteId: 'n-other', date: '2026-01-03', outcome: 'applied', reflection: '' },
  ],
});

test('planNoteDelete / planBookDelete: archived-only, exact cascade, deep copies', () => {
  const r = rows();
  assert.throws(() => dp.planNoteDelete(r.notes[1], r, 'T'), dp.NotArchivedError);
  assert.throws(() => dp.planBookDelete(r.books[1], r, 'T'), dp.NotArchivedError);

  const n = dp.planNoteDelete(r.notes[0], r, 'T');
  assert.equal(n.kind, 'note');
  assert.deepEqual(n.notes.map(x => x.id), ['n1']);
  assert.deepEqual(n.deltaLogs.map(x => x.id), ['l1']);
  assert.deepEqual(n.books, []);
  assert.deepEqual(n.sessions, []);

  const b = dp.planBookDelete(r.books[0], r, 'T');
  assert.deepEqual(b.books.map(x => x.id), ['b1']);
  assert.deepEqual(b.notes.map(x => x.id), ['n1', 'n2'], 'all of the book\'s notes, archived or not');
  assert.deepEqual(b.sessions.map(x => x.id), ['s1']);
  assert.deepEqual(b.deltaLogs.map(x => x.id), ['l1', 'l2']);
  assert.deepEqual(dp.toDeleteRowsPlan(b), {
    deltaLogIds: ['l1', 'l2'], sessionIds: ['s1'], noteIds: ['n1', 'n2'], bookIds: ['b1'],
  });
  b.books[0].meta.capstone.extra = 99;
  assert.equal(r.books[0].meta.capstone.extra, 1, 'backup is a deep copy');

  const after = dp.withoutDeleted(r, b);
  assert.deepEqual(after.books.map(x => x.id), ['b2']);
  assert.deepEqual(after.notes.map(x => x.id), ['n-other']);
  assert.deepEqual(after.sessions.map(x => x.id), ['s-other']);
  assert.deepEqual(after.deltaLogs.map(x => x.id), ['l-other']);
});

test('deleteDialogCopy: exact counts, Demo wording, undo sentence, shielded hides the slug', () => {
  const r = rows();
  const b = dp.planBookDelete(r.books[0], r, 'T');
  const cloud = dp.deleteDialogCopy(b, { demo: false });
  assert.equal(cloud.title, 'Delete "Thinking in Systems" forever?');
  assert.equal(
    cloud.body,
    "This removes the book and all 2 of its notes (including ones still in your Notes), plus 2 check-ins and 1 reading session, from your Google Sheet. You can undo this for a few seconds; after that it's permanent."
  );
  assert.equal(cloud.confirm, 'Delete Book');
  assert.ok(dp.deleteDialogCopy(b, { demo: true }).body.includes('from this browser.'));

  const lone = dp.planBookDelete(book({ id: 'b9' }), r, 'T');
  assert.equal(
    dp.deleteDialogCopy(lone, { demo: false }).body,
    "This removes the book from your Google Sheet. You can undo this for a few seconds; after that it's permanent."
  );

  const n = dp.planNoteDelete(r.notes[0], r, 'T');
  const nc = dp.deleteDialogCopy(n, { demo: false });
  assert.equal(nc.title, 'Delete this note forever?');
  assert.equal(
    nc.body,
    "This removes it and its 1 check-in from your Google Sheet. Notes linking to [[n1]] will show it as missing. You can undo this for a few seconds; after that it's permanent."
  );
  assert.equal(nc.confirm, 'Delete Note');
  assert.ok(!dp.deleteDialogCopy(n, { demo: false, shielded: true }).body.includes('[[n1]]'));
});

test('last-delete backup: write / read / clear; junk is ignored', () => {
  localStorage.clear();
  try {
    const r = rows();
    const b = dp.planBookDelete(r.books[0], r, '2026-03-01T00:00:00.000Z');
    dp.writeLastDeleteBackup(b);
    assert.deepEqual(dp.readLastDeleteBackup(), b);
    assert.equal(dp.LAST_DELETE_BACKUP_KEY, 'pragya_last_delete_backup_v1');
    dp.clearLastDeleteBackup();
    assert.equal(dp.readLastDeleteBackup(), null);
    localStorage.setItem(dp.LAST_DELETE_BACKUP_KEY, '{not json');
    assert.equal(dp.readLastDeleteBackup(), null);
  } finally {
    localStorage.clear();
  }
});

// ---- In-memory Google Sheets fake (atomic batchGet / batchUpdate / append) ----------

const SHEET_IDS = { Books: 11, Notes: 12, Sessions: 13, DeltaLogs: 14 };
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
/**
 * `tabs`: tab → ids (sheet order). `metas`: { Books|Notes: { id: metaObject } } for the
 * metaJson columns (missing → archived). `failBatchOnce`: the first batchUpdate 500s and
 * applies NOTHING (Sheets batchUpdate is atomic). `beforeRead(tabs)` mutates before reads.
 */
/*
 * Re-review additions: `rowsById` (tab → id → full row) feeds full-row reads (R2-b
 * snapshot); `beforeWrite(tabs)` lets another device change the sheet between our read and
 * our batchUpdate; `netFail: 'before' | 'after'` makes the batchUpdate throw a network
 * TypeError without / after applying it (R2-a); `failReadsAfterWrite` breaks re-reads.
 */
function sheetsFake({ tabs, metas = {}, failBatchOnce = false, beforeRead = null, rowsById = null, beforeWrite = null, netFail = null, failReadsAfterWrite = false }) {
  const deleted = [];
  const appended = [];
  const calls = [];
  let failed = false;
  let wrote = false;
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const u = decodeURIComponent(href);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url: u });
    if (u.includes('drive/v3/files/')) return json({ id: 'sheet-1', modifiedTime: '2026-11-16T00:00:00Z' });
    if (u.includes('fields=sheets.properties')) {
      return json({ sheets: Object.entries(SHEET_IDS).map(([title, sheetId]) => ({ properties: { title, sheetId } })) });
    }
    if (u.includes('values:batchGet') && method === 'GET') {
      if (failReadsAfterWrite && wrote) throw new TypeError('Failed to fetch');
      if (beforeRead) beforeRead(tabs);
      const ranges = new URL(href).searchParams.getAll('ranges');
      return json({
        valueRanges: ranges.map(r => {
          const [tab, cols] = r.split('!');
          const ids = tabs[tab] || [];
          if (cols === 'A:A') return { range: `${tab}!A1:A${ids.length + 1}`, values: [['id'], ...ids.map(id => [id])] };
          // Full-row read of the target tab: id at A, metaJson at L (Books) / R (Notes).
          const metaCol = tab === 'Books' ? 11 : 17;
          const fullRow = id => {
            if (rowsById && rowsById[tab] && rowsById[tab][id]) return rowsById[tab][id];
            const row = Array(metaCol + 1).fill('');
            row[0] = id;
            row[metaCol] = JSON.stringify((metas[tab] || {})[id] ?? { archivedAt: ARCH });
            return row;
          };
          return { range: `${tab}!A1:${cols.split(':')[1]}${ids.length + 1}`, values: [['id'], ...ids.map(fullRow)] };
        }),
      });
    }
    if (u.endsWith(':batchUpdate') && method === 'POST') {
      if (failBatchOnce && !failed) {
        failed = true;
        return json({ error: { message: 'boom' } }, 500);
      }
      if (beforeWrite) beforeWrite(tabs);
      if (netFail === 'before') throw new TypeError('Failed to fetch');
      wrote = true;
      for (const req of JSON.parse(init.body).requests) {
        const range = req.deleteDimension.range;
        const tab = Object.keys(SHEET_IDS).find(t => SHEET_IDS[t] === range.sheetId);
        const id = tabs[tab][range.startIndex - 1];
        tabs[tab].splice(range.startIndex - 1, 1);
        deleted.push(`${tab}:${id}`);
      }
      if (netFail === 'after') throw new TypeError('Failed to fetch');
      return json({});
    }
    if (u.includes(':append') && method === 'POST') {
      const tab = /\/values\/(Books|Notes|Sessions|DeltaLogs)!A1/.exec(u)[1];
      const values = JSON.parse(init.body).values;
      for (const row of values) tabs[tab].push(String(row[0]));
      appended.push({ tab, values });
      return json({});
    }
    return json({});
  };
  return { fetchImpl, deleted, appended, calls };
}
const noSleep = async () => {};

async function withFake(fake, fn) {
  const orig = globalThis.fetch;
  localStorage.clear();
  localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
  globalThis.fetch = fake.fetchImpl;
  try {
    await fn(new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep }));
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
}
const target = { kind: 'book', id: 'b1' };
const writes = fake => fake.calls.filter(c => c.method !== 'GET');

test('Sheets cascade is ATOMIC: one batchGet, one batchUpdate, descending rows per sheet; others untouched', async () => {
  const tabs = { Books: ['b2', 'b1'], Notes: ['n1', 'n-other', 'n2'], Sessions: ['s1', 's-other'], DeltaLogs: ['l1', 'l-other', 'l2'] };
  const fake = sheetsFake({ tabs });
  await withFake(fake, async adapter => {
    const r = rows();
    await adapter.deleteRowsCascade(dp.toDeleteRowsPlan(dp.planBookDelete(r.books[0], r, 'T')), { target });
  });
  // Re-review R2-b: one consistent pre-read + one A:A post-verify read (no writes between).
  const reads = fake.calls.filter(c => c.url.includes('values:batchGet'));
  assert.equal(reads.length, 2, 'one consistent read + one post-verify read');
  assert.ok(reads[1].url.includes('Notes!A:A') && !reads[1].url.includes('Notes!A:R'), 'post-verify reads ids only');
  assert.equal(writes(fake).length, 1, 'exactly one write request');
  assert.deepEqual(fake.deleted, ['DeltaLogs:l2', 'DeltaLogs:l1', 'Sessions:s1', 'Notes:n2', 'Notes:n1', 'Books:b1']);
  assert.deepEqual(tabs, { Books: ['b2'], Notes: ['n-other'], Sessions: ['s-other'], DeltaLogs: ['l-other'] });
});

test('Sheets cascade: rows already removed elsewhere are skipped; all gone → no write at all', async () => {
  const tabs = { Books: ['b1'], Notes: ['n2'], Sessions: [], DeltaLogs: ['l2'] }; // n1, l1, s1 already gone
  const fake = sheetsFake({ tabs });
  await withFake(fake, async adapter => {
    const r = rows();
    const plan = dp.toDeleteRowsPlan(dp.planBookDelete(r.books[0], r, 'T'));
    await adapter.deleteRowsCascade(plan, { target });
    assert.deepEqual(fake.deleted, ['DeltaLogs:l2', 'Notes:n2', 'Books:b1']);
    const before = writes(fake).length;
    await adapter.deleteRowsCascade(plan, { target }); // retry after success: idempotent
    assert.equal(writes(fake).length, before, 'nothing left → no batchUpdate');
  });
  assert.deepEqual(tabs, { Books: [], Notes: [], Sessions: [], DeltaLogs: [] });
});

test('Sheets cascade: a failed batchUpdate deletes NOTHING; the same plan then succeeds', async () => {
  const tabs = { Books: ['b1'], Notes: ['n1', 'n2'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] };
  const fake = sheetsFake({ tabs, failBatchOnce: true });
  await withFake(fake, async adapter => {
    const r = rows();
    const plan = dp.toDeleteRowsPlan(dp.planBookDelete(r.books[0], r, 'T'));
    await assert.rejects(() => adapter.deleteRowsCascade(plan, { target }));
    assert.deepEqual(tabs, { Books: ['b1'], Notes: ['n1', 'n2'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] }, 'all-or-nothing');
    await adapter.deleteRowsCascade(plan, { target });
  });
  assert.deepEqual(tabs, { Books: [], Notes: [], Sessions: [], DeltaLogs: [] });
});

test('QA-30: the target is re-verified as still archived in the same read; restored elsewhere → refused, nothing deleted', async () => {
  const tabs = { Books: ['b1'], Notes: ['n1', 'n2'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] };
  const fake = sheetsFake({ tabs, metas: { Books: { b1: { updatedAt: 'u' } } } }); // unarchived via CLI
  await withFake(fake, async adapter => {
    const r = rows();
    await assert.rejects(
      () => adapter.deleteRowsCascade(dp.toDeleteRowsPlan(dp.planBookDelete(r.books[0], r, 'T')), { target }),
      err => err instanceof dp.NotArchivedError
    );
  });
  assert.equal(writes(fake).length, 0);
  assert.deepEqual(tabs.Notes, ['n1', 'n2']);
});

test('Undo appends ONLY absent rows (one append per tab, parents first) and never overwrites existing ones', async () => {
  const tabs = { Books: [], Notes: ['n2'], Sessions: [], DeltaLogs: [] }; // n2 recreated/kept elsewhere
  const fake = sheetsFake({ tabs });
  const r = rows();
  const backup = dp.planBookDelete(r.books[0], r, 'T');
  let result;
  await withFake(fake, async adapter => {
    result = await adapter.appendRowsIfAbsent(backup);
  });
  assert.deepEqual(result.restored, { books: ['b1'], notes: ['n1'], sessions: ['s1'], deltaLogs: ['l1', 'l2'] });
  assert.equal(result.skipped, 1);
  assert.deepEqual(fake.appended.map(a => a.tab), ['Books', 'Notes', 'Sessions', 'DeltaLogs']);
  assert.ok(!fake.calls.some(c => c.method === 'PUT'), 'no overwrite of n2');
  assert.deepEqual(tabs, { Books: ['b1'], Notes: ['n2', 'n1'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] });
  const bookRow = fake.appended.find(a => a.tab === 'Books').values[0];
  assert.deepEqual(JSON.parse(bookRow[11]), backup.books[0].meta, 'metaJson (incl. archivedAt, capstone) verbatim');
  const noteRow = fake.appended.find(a => a.tab === 'Notes').values[0];
  assert.equal(JSON.parse(noteRow[17]).archivedAt, ARCH);
});

test('Demo adapter parity: atomic cascade, archived re-check, append-if-absent restore', async () => {
  localStorage.clear();
  try {
    const demo = new DemoStorageAdapter();
    const r = rows();
    await demo.replaceWorkspace({ version: 1, exportedAt: 'x', ...r });
    // Target restored elsewhere → refused, nothing removed.
    await assert.rejects(
      () => demo.deleteRowsCascade({ deltaLogIds: [], sessionIds: [], noteIds: [], bookIds: ['b2'] }, { target: { kind: 'book', id: 'b2' } }),
      err => err instanceof dp.NotArchivedError
    );
    const backup = dp.planBookDelete(r.books[0], r, 'T');
    await demo.deleteRowsCascade(dp.toDeleteRowsPlan(backup), { target: { kind: 'book', id: 'b1' } });
    let ws = await demo.loadWorkspace();
    assert.deepEqual(ws.books.map(b => b.id), ['b2']);
    assert.deepEqual(ws.notes.map(n => n.id), ['n-other']);
    assert.deepEqual(ws.sessions.map(s => s.id), ['s-other']);
    assert.deepEqual(ws.deltaLogs.map(l => l.id), ['l-other']);
    await demo.saveNote({ ...r.notes[1], takeaway: 'NEWER ELSEWHERE' }); // n2 recreated meanwhile
    const result = await demo.appendRowsIfAbsent(backup);
    assert.equal(result.skipped, 1);
    ws = await demo.loadWorkspace();
    const byId = (list, id) => list.find(x => x.id === id);
    assert.deepEqual(byId(ws.books, 'b1'), r.books[0]);
    assert.equal(byId(ws.notes, 'n2').takeaway, 'NEWER ELSEWHERE', 'existing row never overwritten');
    assert.deepEqual(byId(ws.deltaLogs, 'l2'), r.deltaLogs[1]);
  } finally {
    localStorage.clear();
  }
});

test('R2#1 copy names live notes; backup confirmation flag + boot expiry of stale backups', () => {
  const r = rows();
  const b = dp.planBookDelete(r.books[0], r, 'T');
  assert.equal(
    dp.deleteDialogCopy(b, { demo: false }).body,
    "This removes the book and all 2 of its notes (including ones still in your Notes), plus 2 check-ins and 1 reading session, from your Google Sheet. You can undo this for a few seconds; after that it's permanent."
  );
  const allArchived = { ...r, notes: r.notes.map(n => ({ ...n, meta: { ...n.meta, archivedAt: ARCH } })) };
  assert.ok(!dp.deleteDialogCopy(dp.planBookDelete(r.books[0], allArchived, 'T'), { demo: true }).body.includes('still in your Notes'));
  const one = { ...r, notes: [r.notes[1]], deltaLogs: [], sessions: [] };
  assert.equal(
    dp.deleteDialogCopy(dp.planBookDelete(r.books[0], one, 'T'), { demo: true }).body,
    "This removes the book and its 1 note (even though it's still in your Notes) from this browser. You can undo this for a few seconds; after that it's permanent."
  );
  const none = { ...r, notes: [], deltaLogs: [] };
  assert.equal(
    dp.deleteDialogCopy(dp.planBookDelete(r.books[0], none, 'T'), { demo: true }).body,
    "This removes the book and 1 reading session from this browser. You can undo this for a few seconds; after that it's permanent."
  );

  localStorage.clear();
  try {
    const now = Date.parse('2026-03-10T00:00:00.000Z');
    dp.writeLastDeleteBackup(dp.planBookDelete(r.books[0], r, '2026-03-09T00:00:00.000Z'));
    assert.equal(dp.expireStaleDeleteBackup(now), false, 'fresh backup kept');
    dp.writeLastDeleteBackup(dp.planBookDelete(r.books[0], r, '2026-02-01T00:00:00.000Z'));
    assert.equal(dp.expireStaleDeleteBackup(now), true, 'older than 7 days → expired');
    assert.equal(dp.readLastDeleteBackup(), null);
    localStorage.setItem(dp.LAST_DELETE_BACKUP_KEY, 'junk');
    assert.equal(dp.expireStaleDeleteBackup(now), true);
  } finally {
    localStorage.clear();
  }
});

// ---- CD 1b re-review: R2-a (ambiguous write outcome) and R2-b (index-shift repair) ------

const { isAmbiguousWriteError } = await load('src/services/googleSheetsAdapter.ts');
const { ApiError } = await load('src/utils/apiErrors.ts');
const bookPlan = () => {
  const r = rows();
  return dp.toDeleteRowsPlan(dp.planBookDelete(r.books[0], r, 'T'));
};
const fullTabs = () => ({ Books: ['b1'], Notes: ['n1', 'n2'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] });
const EMPTY = { Books: [], Notes: [], Sessions: [], DeltaLogs: [] };

test('R2-a: isAmbiguousWriteError — HTTP/401/no-token are verdicts; network/timeout/bad body are not', () => {
  assert.equal(isAmbiguousWriteError(new ApiError(500, 'boom')), false);
  assert.equal(isAmbiguousWriteError(new Error('401 Unauthorized')), false);
  assert.equal(isAmbiguousWriteError(new Error('Not authenticated')), false);
  assert.equal(isAmbiguousWriteError(new TypeError('Failed to fetch')), true);
  assert.equal(isAmbiguousWriteError(new DOMException('timed out', 'AbortError')), true);
  assert.equal(isAmbiguousWriteError(new SyntaxError('Unexpected end of JSON input')), true);
});

test('R2-a: network drop AFTER Google applied the batchUpdate → re-read shows the ids gone → success', async () => {
  const tabs = fullTabs();
  const fake = sheetsFake({ tabs, netFail: 'after' });
  let result;
  await withFake(fake, async adapter => {
    result = await adapter.deleteRowsCascade(bookPlan(), { target });
  });
  assert.deepEqual(result, { repaired: 0, stillPresent: [] });
  assert.deepEqual(tabs, EMPTY);
  assert.equal(writes(fake).length, 1, 'never re-sends the delete');
});

test('R2-a: network drop BEFORE the write landed → re-read shows every id present → original error, nothing removed', async () => {
  const tabs = fullTabs();
  const fake = sheetsFake({ tabs, netFail: 'before' });
  await withFake(fake, async adapter => {
    await assert.rejects(() => adapter.deleteRowsCascade(bookPlan(), { target }), err => err instanceof TypeError);
  });
  assert.deepEqual(tabs, fullTabs());
  assert.equal(fake.calls.filter(c => c.url.includes('values:batchGet')).length, 2, 'reconciled by one re-read');
});

test('R2-a: network drop and the re-read fails too → DeleteOutcomeUnknownError (caller keeps the backup)', async () => {
  const tabs = fullTabs();
  const fake = sheetsFake({ tabs, netFail: 'after', failReadsAfterWrite: true });
  await withFake(fake, async adapter => {
    await assert.rejects(() => adapter.deleteRowsCascade(bookPlan(), { target }), err => err instanceof dp.DeleteOutcomeUnknownError);
  });
});

test('R2-a: an HTTP rejection is a verdict → rethrown at once, no reconciliation read', async () => {
  const tabs = fullTabs();
  const fake = sheetsFake({ tabs, failBatchOnce: true });
  await withFake(fake, async adapter => {
    await assert.rejects(() => adapter.deleteRowsCascade(bookPlan(), { target }), err => err instanceof ApiError);
  });
  assert.equal(fake.calls.filter(c => c.url.includes('values:batchGet')).length, 1);
  assert.deepEqual(tabs, fullTabs());
});

test('R2-b: another device deletes a row ABOVE ours mid-delete → unrelated rows hit by the shift are re-appended from the snapshot; planned survivors reported', async () => {
  const notesById = {
    'n-a': codecs.noteToRow(note('n-a', { bookId: 'b2' })),
    n1: codecs.noteToRow(rows().notes[0]),
    'n-other': codecs.noteToRow(note('n-other', { bookId: 'b2', takeaway: 'keep me' })),
    n2: codecs.noteToRow(note('n2')),
    'n-z': codecs.noteToRow(note('n-z', { bookId: 'b2' })),
  };
  const tabs = { Books: ['b1'], Notes: ['n-a', 'n1', 'n-other', 'n2', 'n-z'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] };
  const fake = sheetsFake({
    tabs,
    rowsById: { Notes: notesById },
    beforeWrite(t) {
      t.Notes = t.Notes.filter(id => id !== 'n-a'); // another device's Delete Forever, row above ours
    },
  });
  let result;
  await withFake(fake, async adapter => {
    result = await adapter.deleteRowsCascade(bookPlan(), { target });
  });
  // Our stale indexes hit n-z and n-other instead of n2 and n1.
  assert.deepEqual(fake.deleted.filter(d => d.startsWith('Notes:')), ['Notes:n-z', 'Notes:n-other']);
  assert.deepEqual(result.stillPresent, ['n1', 'n2'], 'planned rows left for a retry');
  // Every unplanned row that vanished is re-appended (n-a too: we can't tell a concurrent
  // delete from a shift, and resurrecting is the recoverable failure).
  assert.equal(result.repaired, 3);
  const notesAppend = fake.appended.find(a => a.tab === 'Notes');
  assert.deepEqual(notesAppend.values.map(r => r[0]).sort(), ['n-a', 'n-other', 'n-z']);
  const kept = notesAppend.values.find(r => r[0] === 'n-other');
  assert.equal(codecs.rowToNote(kept).takeaway, 'keep me', 'restored from the pre-read snapshot through the codecs');
  assert.deepEqual([...tabs.Notes].sort(), ['n-a', 'n-other', 'n-z', 'n1', 'n2'].sort());
  assert.deepEqual(tabs.Books, [], 'other tabs deleted normally');
});

test('R2-b: no shift → nothing re-appended, result is clean', async () => {
  const tabs = { Books: ['b2', 'b1'], Notes: ['n1', 'n-other', 'n2'], Sessions: ['s1', 's-other'], DeltaLogs: ['l1', 'l-other', 'l2'] };
  const fake = sheetsFake({ tabs });
  let result;
  await withFake(fake, async adapter => {
    result = await adapter.deleteRowsCascade(bookPlan(), { target });
  });
  assert.deepEqual(result, { repaired: 0, stillPresent: [] });
  assert.equal(fake.appended.length, 0);
});

test('deleteOutcomeNotice / withoutIds: calm copy only when something was repaired or left', () => {
  assert.equal(dp.deleteOutcomeNotice({ repaired: 0, stillPresent: [] }), null);
  assert.equal(
    dp.deleteOutcomeNotice({ repaired: 1, stillPresent: [] }),
    'Another device changed this sheet during the delete; Pragya restored 1 unrelated row.'
  );
  assert.equal(
    dp.deleteOutcomeNotice({ repaired: 2, stillPresent: ['n1', 'n2'] }),
    'Another device changed this sheet during the delete; Pragya restored 2 unrelated rows. 2 rows were not deleted; try again.'
  );
  const r = rows();
  const b = dp.planBookDelete(r.books[0], r, 'T');
  assert.deepEqual(dp.withoutIds(b, ['n1']).notes.map(n => n.id), ['n2']);
  assert.equal(dp.withoutIds(b, []), b);
});
