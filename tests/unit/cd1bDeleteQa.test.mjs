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
        const parentDir = path.dirname(fileURLToPath(context.parentURL));
        for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
          const candidate = path.resolve(parentDir, `${specifier}${ext}`);
          if (fs.existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

/**
 * QA (CD Batch 1b) — permanent-delete adversarial probes against an in-memory Sheets fake:
 * retry after a failure, parent vanishing (concurrent CLI/device delete), rows shifted by
 * another device (updated by Dev in the 1b fix-up for the atomic cascade), the archived guard, copy edge cases, and the
 * QA-29 fix (no previous account → legacy drafts dropped).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const dp = await load('src/utils/deletePlan.ts');
const { GoogleSheetsAdapter, SPREADSHEET_ID_STORAGE_KEY, SHEETS_CACHE_STORAGE_KEY } = await load(
  'src/services/googleSheetsAdapter.ts'
);
const ds = await load('src/utils/draftStorage.ts');
const acct = await load('src/utils/accountSession.ts');

const ARCH = '2026-02-01T00:00:00.000Z';
const book = (o = {}) => ({
  id: 'b1', title: 'B', author: 'A', format: 'physical', kind: 'nonfiction', status: 'reading',
  currentPos: 10, totalPos: 200, posUnit: 'page', normalizedPos: 0.05, docUrl: '',
  meta: { updatedAt: 'u', archivedAt: ARCH }, ...o,
});
const note = (id, o = {}) => ({
  id, slug: id, bookId: 'b1', createdAt: 'c', updatedAt: 'u', pos: 1, normalizedPos: 0, status: 'saved',
  source: 'app', tags: [], quote: '', takeaway: 't', contextMechanism: '', critique: '', deltaTrigger: '',
  deltaAction: '', deltaStatus: 'none', meta: { attachments: [], links: [] }, ...o,
});
const rows = () => ({
  books: [book()],
  notes: [note('n1'), note('n2')],
  sessions: [{ id: 's1', bookId: 'b1', date: 'd', startPos: 0, endPos: 1, updatedAt: 'u', note: '' }],
  deltaLogs: [
    { id: 'l1', noteId: 'n1', date: 'd', outcome: 'applied', reflection: '' },
    { id: 'l2', noteId: 'n2', date: 'd', outcome: 'missed', reflection: '' },
  ],
});

const SHEET_IDS = { Books: 11, Notes: 12, Sessions: 13, DeltaLogs: 14 };
const json = (b, status = 200) => new Response(JSON.stringify(b), { status });

/**
 * Sheets fake. CD 1b fix-up: the cascade is now ATOMIC (one values:batchGet + one
 * spreadsheets.batchUpdate), so the per-row endpoints of the original QA fake were replaced
 * by batchGet / multi-request batchUpdate. `hooks.beforeRead(tabs)` may mutate the tabs
 * right before the consistent read (another device / CLI). `failOnce`: the first
 * batchUpdate 500s and applies nothing (Sheets batchUpdate is all-or-nothing).
 */
function sheetsFake({ tabs, failOnce = false, hooks = {} }) {
  const deleted = [];
  let failed = false;
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const u = decodeURIComponent(href);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('drive/v3/files/')) return json({ id: 'sheet-1', modifiedTime: 'm' });
    if (u.includes('fields=sheets.properties')) {
      return json({ sheets: Object.entries(SHEET_IDS).map(([title, sheetId]) => ({ properties: { title, sheetId } })) });
    }
    if (u.includes('values:batchGet') && method === 'GET') {
      if (hooks.beforeRead && !hooks.__beforeReadFired) {
        // Fire once: the delete performs a second ids-only re-read after the write (CD 1b R2-b).
        hooks.__beforeReadFired = true;
        hooks.beforeRead(tabs);
      }
      const ranges = new URL(href).searchParams.getAll('ranges');
      return json({
        valueRanges: ranges.map(r => {
          const [tab, cols] = r.split('!');
          const ids = tabs[tab] || [];
          return cols === 'A:A'
            ? { range: `${tab}!A1:A${ids.length + 1}`, values: [['id'], ...ids.map(id => [id])] }
            : {
                range: `${tab}!A1:${cols.split(':')[1]}${ids.length + 1}`,
                values: [['id'], ...ids.map(id => {
                  const metaCol = tab === 'Books' ? 11 : 17;
                  const row = Array(metaCol + 1).fill('');
                  row[0] = id;
                  row[metaCol] = JSON.stringify({ archivedAt: ARCH });
                  return row;
                })],
              };
        }),
      });
    }
    if (u.endsWith(':batchUpdate') && method === 'POST') {
      if (failOnce && !failed) {
        failed = true;
        return json({ error: { message: 'boom' } }, 500);
      }
      for (const req of JSON.parse(init.body).requests) {
        const range = req.deleteDimension.range;
        const tab = Object.keys(SHEET_IDS).find(t => SHEET_IDS[t] === range.sheetId);
        const id = tabs[tab][range.startIndex - 1];
        tabs[tab].splice(range.startIndex - 1, 1);
        deleted.push(`${tab}:${id}`);
      }
      return json({});
    }
    return json({});
  };
  return { fetchImpl, deleted };
}

async function withFake(fake, fn) {
  const orig = globalThis.fetch;
  localStorage.clear();
  localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
  globalThis.fetch = fake.fetchImpl;
  try {
    await fn(new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: async () => {} }));
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
}

const target = { kind: 'book', id: 'b1' };

test('QA 1b: failure → NOTHING deleted (atomic); retry with the SAME plan completes', async () => {
  const tabs = { Books: ['b1'], Notes: ['n1', 'n2'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] };
  const fake = sheetsFake({ tabs, failOnce: true });
  const plan = dp.toDeleteRowsPlan(dp.planBookDelete(rows().books[0], rows(), 'T'));
  await withFake(fake, async adapter => {
    await assert.rejects(() => adapter.deleteRowsCascade(plan, { target }));
    assert.deepEqual(tabs, { Books: ['b1'], Notes: ['n1', 'n2'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] }, 'no child lost');
    assert.deepEqual(fake.deleted, []);
    await adapter.deleteRowsCascade(plan, { target }); // user retries
  });
  assert.deepEqual(tabs, { Books: [], Notes: [], Sessions: [], DeltaLogs: [] });
});

test('QA 1b: parent row already deleted (CLI/other device) before the read → no throw; unrelated rows untouched', async () => {
  const tabs = { Books: ['b0', 'b1'], Notes: ['n1', 'n2'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] };
  const fake = sheetsFake({
    tabs,
    hooks: {
      beforeRead(t) {
        t.Books = t.Books.filter(x => x !== 'b1');
      },
    },
  });
  await withFake(fake, async adapter => {
    localStorage.setItem(SHEETS_CACHE_STORAGE_KEY, JSON.stringify({ spreadsheetId: 'sheet-1', modifiedTime: 'm', codecVersion: 2, state: { ...rows(), books: [book(), book({ id: 'b0' })] } }));
    await adapter.deleteRowsCascade(dp.toDeleteRowsPlan(dp.planBookDelete(rows().books[0], rows(), 'T')), { target });
    const cache = JSON.parse(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY) || 'null');
    if (cache) assert.deepEqual(cache.state.books.map(b => b.id), ['b0'], 'cache drops the deleted rows only');
  });
  assert.deepEqual(tabs.Books, ['b0'], 'the unrelated book b0 is never deleted');
  assert.ok(!fake.deleted.includes('Books:b0'));
});

test('QA 1b: rows inserted above by another device before the read are resolved at their CURRENT index (never the wrong row)', async () => {
  const tabs = { Books: ['b1'], Notes: ['n1', 'n2'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] };
  const fake = sheetsFake({
    tabs,
    hooks: {
      beforeRead(t) {
        t.Notes = ['n-new', ...t.Notes]; // another device inserted a row above
      },
    },
  });
  await withFake(fake, async adapter => {
    await adapter.deleteRowsCascade(dp.toDeleteRowsPlan(dp.planBookDelete(rows().books[0], rows(), 'T')), { target });
  });
  assert.deepEqual(tabs.Notes, ['n-new'], 'n-new survives; n1/n2 deleted');
  assert.ok(!fake.deleted.includes('Notes:n-new'));
});

test('QA 1b: archived guard — planners refuse live items (whitespace archivedAt is NOT archived)', () => {
  const r = rows();
  assert.throws(() => dp.planBookDelete(book({ meta: { archivedAt: '   ' } }), r, 'T'), dp.NotArchivedError);
  assert.throws(() => dp.planNoteDelete(note('n1', { meta: { archivedAt: '' } }), r, 'T'), dp.NotArchivedError);
  assert.throws(() => dp.planNoteDelete(note('n1', { meta: { archivedAt: 123 } }), r, 'T'), dp.NotArchivedError);
  assert.doesNotThrow(() => dp.planNoteDelete(note('n1', { meta: { archivedAt: ARCH } }), r, 'T'));
});

test('QA 1b: copy edge cases — singulars, book with notes but no logs/sessions, note with 2 check-ins, shielded never shows slug', () => {
  const r = rows();
  const one = { ...r, notes: [note('n1')], deltaLogs: [r.deltaLogs[0]] };
  assert.equal(
    dp.deleteDialogCopy(dp.planBookDelete(r.books[0], one, 'T'), { demo: false }).body,
    "This removes the book and its 1 note (even though it's still in your Notes), plus 1 check-in and 1 reading session, from your Google Sheet. You can undo this for a few seconds; after that it's permanent."
  );
  const noLogs = { ...r, deltaLogs: [], sessions: [] };
  assert.equal(
    dp.deleteDialogCopy(dp.planBookDelete(r.books[0], noLogs, 'T'), { demo: true }).body,
    "This removes the book and all 2 of its notes (including ones still in your Notes) from this browser. You can undo this for a few seconds; after that it's permanent."
  );
  const n = note('secret-slug', { meta: { archivedAt: ARCH } });
  const two = { ...r, deltaLogs: [{ ...r.deltaLogs[0], noteId: 'secret-slug' }, { ...r.deltaLogs[1], noteId: 'secret-slug' }] };
  const plan = dp.planNoteDelete(n, two, 'T');
  assert.equal(
    dp.deleteDialogCopy(plan, { demo: false }).body,
    "This removes it and its 2 check-ins from your Google Sheet. Notes linking to [[secret-slug]] will show it as missing. You can undo this for a few seconds; after that it's permanent."
  );
  const shielded = dp.deleteDialogCopy(plan, { demo: false, shielded: true });
  assert.ok(!JSON.stringify(shielded).includes('secret-slug'));
  // Book title with quotes/markup is rendered verbatim (React escapes it).
  assert.equal(dp.deleteDialogCopy(dp.planBookDelete(book({ title: 'A "B" <i>' }), r, 'T'), { demo: true }).title, 'Delete "A "B" <i>" forever?');
});

test('QA-29 fix: no previous account → legacy drafts are dropped (not adopted); same account still adopts', () => {
  localStorage.clear();
  try {
    localStorage.setItem('pragya_draft_capture_v1', JSON.stringify({ takeaway: 'ORPHAN' }));
    localStorage.setItem('pragya_draft_edit_n1', JSON.stringify({ title: 'ORPHAN' }));
    assert.equal(acct.applySignedInAccount('first@example.com'), false);
    localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'first@example.com' }));
    assert.equal(acct.adoptLegacyDraftsForAccount('first@example.com'), 0);
    assert.equal(localStorage.getItem('pragya_draft_capture_v1'), null);
    assert.equal(localStorage.getItem('pragya_draft_edit_n1'), null);
    assert.equal(ds.readDraft(ds.CAPTURE_DRAFT_KEY), null);

    // Same account with marker: legacy keys are adopted.
    localStorage.setItem('pragya_draft_capture_v1', JSON.stringify({ takeaway: 'MINE' }));
    assert.equal(acct.applySignedInAccount('FIRST@example.com'), false);
    assert.equal(acct.adoptLegacyDraftsForAccount('FIRST@example.com'), 1);
    assert.deepEqual(ds.readDraft(ds.CAPTURE_DRAFT_KEY), { takeaway: 'MINE' });

    // Existing scoped drafts of the no-previous-account case are untouched by the drop.
    localStorage.clear();
    const scope = ds.accountDraftScope('first@example.com');
    localStorage.setItem(`pragya_draft:${scope}:pragya_draft_capture_v1`, JSON.stringify({ takeaway: 'SCOPED' }));
    localStorage.setItem('pragya_draft_capture_v1', JSON.stringify({ takeaway: 'ORPHAN' }));
    acct.applySignedInAccount('first@example.com');
    assert.equal(localStorage.getItem('pragya_draft_capture_v1'), null);
    assert.ok(localStorage.getItem(`pragya_draft:${scope}:pragya_draft_capture_v1`));
  } finally {
    localStorage.clear();
  }
});

test('QA 1b re-verify: last-delete backup TTL boundaries (7 days), junk / bad dates, future-dated', () => {
  localStorage.clear();
  try {
    const TTL = dp.LAST_DELETE_BACKUP_TTL_MS;
    assert.equal(TTL, 7 * 24 * 60 * 60 * 1000);
    const at = Date.parse('2026-11-01T00:00:00.000Z');
    const write = (o = {}) => dp.writeLastDeleteBackup({ ...dp.planBookDelete(rows().books[0], rows(), '2026-11-01T00:00:00.000Z'), ...o });
    assert.equal(dp.expireStaleDeleteBackup(at), false, 'nothing stored → false');
    write();
    assert.equal(dp.expireStaleDeleteBackup(at + TTL), false, 'exactly 7 days → kept');
    assert.ok(dp.readLastDeleteBackup());
    assert.equal(dp.expireStaleDeleteBackup(at + TTL + 1), true, '7 days + 1 ms → expired');
    assert.equal(dp.readLastDeleteBackup(), null);
    write({ confirmed: false });
    assert.equal(dp.expireStaleDeleteBackup(at + TTL + 1), true, 'unconfirmed backups expire too');
    write({ deletedAt: 'not-a-date' });
    assert.equal(dp.expireStaleDeleteBackup(at), true, 'unparseable deletedAt → cleared');
    localStorage.setItem(dp.LAST_DELETE_BACKUP_KEY, '{junk');
    assert.equal(dp.expireStaleDeleteBackup(at), true, 'junk → cleared');
    assert.equal(localStorage.getItem(dp.LAST_DELETE_BACKUP_KEY), null);
    // Info: a future-dated backup (clock moved back) is kept until its date + 7 days.
    write({ deletedAt: '2027-01-01T00:00:00.000Z' });
    assert.equal(dp.expireStaleDeleteBackup(at), false);
  } finally {
    localStorage.clear();
  }
});

test('QA 1b re-verify: adapter refuses when the target row in the SAME read is no longer archived; nothing deleted', async () => {
  const tabs = { Books: ['b1'], Notes: ['n1', 'n2'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] };
  const fake = sheetsFake({ tabs });
  const origFetch = fake.fetchImpl;
  // Serve the Books!A:L read with an UNARCHIVED metaJson for b1 (restored by the CLI after the refresh).
  fake.fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('values:batchGet') && decodeURIComponent(href).includes('Books!A:L')) {
      const res = await origFetch(url, init);
      const body = await res.json();
      for (const vr of body.valueRanges) {
        if (vr.range.startsWith('Books!')) vr.values = vr.values.map((r, i) => (i === 0 ? r : r.map((c, j) => (j === 11 ? JSON.stringify({ updatedAt: 'u2' }) : c))));
      }
      return json(body);
    }
    return origFetch(url, init);
  };
  await withFake(fake, async adapter => {
    await assert.rejects(
      () => adapter.deleteRowsCascade(dp.toDeleteRowsPlan(dp.planBookDelete(rows().books[0], rows(), 'T')), { target }),
      err => err.name === 'NotArchivedError'
    );
  });
  assert.deepEqual(fake.deleted, []);
  assert.deepEqual(tabs, { Books: ['b1'], Notes: ['n1', 'n2'], Sessions: ['s1'], DeltaLogs: ['l1', 'l2'] });
});
