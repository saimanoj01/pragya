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

const {
  GoogleSheetsAdapter,
  SHEETS_CACHE_STORAGE_KEY,
  SPREADSHEET_ID_STORAGE_KEY,
} = await import(pathToFileURL(path.join(repoRoot, 'src/services/googleSheetsAdapter.ts')).href);

const { RowConflictError, extractMetaUpdatedAt, isRemoteNewer } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/conflictGuard.ts')).href
);

const {
  planTrailingClearRanges,
  savePreImportBackup,
  readPreImportBackup,
  clearPreImportBackup,
  PRE_IMPORT_BACKUP_KEY,
} = await import(pathToFileURL(path.join(repoRoot, 'src/utils/importSafety.ts')).href);

const {
  CAPTURE_DRAFT_KEY,
  getDeepenDraftKey,
  getEditNoteDraftKey,
  readDraft,
  writeDraft,
  clearDraft,
  clearAllDrafts,
  isNoteDraftStale,
} = await import(pathToFileURL(path.join(repoRoot, 'src/utils/draftStorage.ts')).href);

const { clampNotePos } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/positionClamp.ts')).href
);

const { isNetworkError, shouldBlockCloudWrite, OfflineReadOnlyError } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/offline.ts')).href
);

const { isRestorableAppRoute, resolvePostLoginHash } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/navigation.ts')).href
);

const { getToastStyle } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/toastStyle.ts')).href
);

const { applyBookmarkAdvance } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/sessionCoalesce.ts')).href
);

// Helper: WCAG 2.1 contrast math for HSL CSS variables
function hslToRgb(h, sPct, lPct) {
  const s = sPct / 100;
  const l = lPct / 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function relativeLuminance([r, g, b]) {
  const lin = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(rgbA, rgbB) {
  const l1 = relativeLuminance(rgbA);
  const l2 = relativeLuminance(rgbB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function blendAlpha(fgRgb, bgRgb, alpha) {
  return [
    fgRgb[0] * alpha + bgRgb[0] * (1 - alpha),
    fgRgb[1] * alpha + bgRgb[1] * (1 - alpha),
    fgRgb[2] * alpha + bgRgb[2] * (1 - alpha),
  ];
}

function parseCssThemeBlock(css, selectorPattern) {
  const match = css.match(selectorPattern);
  assert.ok(match, `Missing CSS block for ${selectorPattern}`);
  const vars = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/i);
    if (m) {
      vars[m[1]] = hslToRgb(Number(m[2]), Number(m[3]), Number(m[4]));
    }
  }
  return vars;
}

test('M4.1: WCAG AA (>=4.5:1) contrast holds for --faint and light semantic accents', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'src/index.css'), 'utf-8');
  const darkVars = parseCssThemeBlock(css, /:root,\s*\.dark\s*\{([\s\S]*?)\n\s*\}/);
  const lightVars = parseCssThemeBlock(css, /\.light\s*\{([\s\S]*?)\n\s*\}/);

  assert.ok(
    contrastRatio(darkVars['faint'], darkVars['surface-2']) >= 4.5,
    'Dark --faint on --surface-2 must meet >= 4.5:1'
  );
  assert.ok(
    contrastRatio(lightVars['faint'], lightVars['surface-2']) >= 4.5,
    'Light --faint on --surface-2 must meet >= 4.5:1'
  );

  for (const token of ['c-nonmonthly', 'c-saved', 'c-negative', 'destructive']) {
    const onCard = contrastRatio(lightVars[token], lightVars['card']);
    const tintBg = blendAlpha(lightVars[token], lightVars['card'], 0.15);
    const onTint = contrastRatio(lightVars[token], tintBg);
    assert.ok(onCard >= 4.5, `Light --${token} on --card (${onCard.toFixed(2)}) < 4.5`);
    assert.ok(onTint >= 4.5, `Light --${token} on 15% tint (${onTint.toFixed(2)}) < 4.5`);
  }

  // Toast high-contrast styles
  assert.match(getToastStyle('info').containerClass, /border-border.*text-foreground/);
  assert.match(getToastStyle('success').containerClass, /bg-emerald-700\/95.*text-white/);
  assert.match(getToastStyle('error').containerClass, /bg-rose-700\/95.*text-white/);
});

test('M4.4: OAuth return-route validation blocks token hashes and restores app views', () => {
  assert.equal(isRestorableAppRoute('#/notes'), true);
  assert.equal(isRestorableAppRoute('#/book/book-123'), true);
  assert.equal(isRestorableAppRoute('#/note/feedback-loops'), true);
  assert.equal(isRestorableAppRoute('#access_token=abc&state=123'), false);
  assert.equal(isRestorableAppRoute('#error=access_denied'), false);
  assert.equal(isRestorableAppRoute('#/login'), false);
  assert.equal(isRestorableAppRoute(''), false);

  assert.equal(resolvePostLoginHash('#/practice'), '#/practice');
  assert.equal(resolvePostLoginHash('#access_token=xyz'), '#/shelf');
  assert.equal(resolvePostLoginHash(null), '#/shelf');
});

test('M4.5: Offline helpers & GoogleSheetsAdapter cached read-only fallback', async () => {
  assert.equal(isNetworkError(new TypeError('Failed to fetch')), true);
  assert.equal(isNetworkError(new Error('HTTP 401 Unauthorized')), false);
  assert.equal(
    isNetworkError(new RowConflictError('2026-11-16T01:00:00Z', '2026-11-16T00:00:00Z')),
    false
  );
  assert.equal(shouldBlockCloudWrite(false, true), true);
  assert.equal(shouldBlockCloudWrite(true, true), false);
  assert.equal(new OfflineReadOnlyError().name, 'OfflineReadOnlyError');

  localStorage.clear();
  const cachedState = {
    books: [
      {
        id: 'book-cached',
        title: 'Cached Systems',
        author: 'Donella Meadows',
        format: 'physical',
        kind: 'nonfiction',
        status: 'reading',
        currentPos: 50,
        totalPos: 200,
        posUnit: 'page',
        normalizedPos: 0.25,
        docUrl: '',
        meta: {},
      },
    ],
    notes: [],
    sessions: [],
    deltaLogs: [],
  };
  localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-offline-1');
  localStorage.setItem(
    SHEETS_CACHE_STORAGE_KEY,
    JSON.stringify({
      spreadsheetId: 'sheet-offline-1',
      modifiedTime: '2026-11-15T10:00:00Z',
      accountEmail: 'reader@pragya.dev',
      state: cachedState,
    })
  );

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const offlineAdapter = new GoogleSheetsAdapter(() => 'tok-1', undefined, 'reader@pragya.dev');

    const ws = await offlineAdapter.loadWorkspace();
    assert.equal(ws.isOfflineReadOnly, true);
    assert.equal(ws.books.length, 1);
    assert.equal(ws.books[0].title, 'Cached Systems');
    assert.ok(
      localStorage.getItem(SHEETS_CACHE_STORAGE_KEY),
      'Cache must remain intact on network failure'
    );

    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 });
    const unauthAdapter = new GoogleSheetsAdapter(
      () => 'expired-tok',
      undefined,
      'reader@pragya.dev'
    );
    await assert.rejects(() => unauthAdapter.loadWorkspace(), /401/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('M4.7: Draft autosave utilities, stale timestamp check, and clearAllDrafts', () => {
  localStorage.clear();
  writeDraft(CAPTURE_DRAFT_KEY, { bookId: 'b1', takeaway: 'Unfinished note' });
  assert.deepEqual(readDraft(CAPTURE_DRAFT_KEY), { bookId: 'b1', takeaway: 'Unfinished note' });

  const deepenKey = getDeepenDraftKey('note-1');
  const editKey = getEditNoteDraftKey('note-2');
  writeDraft(deepenKey, { baseUpdatedAt: '2026-11-15T10:00:00Z', takeaway: 'Draft' });
  writeDraft(editKey, { baseUpdatedAt: '2026-11-15T10:00:00Z', title: 'Draft Title' });

  assert.equal(isNoteDraftStale('2026-11-15T10:00:00Z', '2026-11-15T10:00:00.000Z'), false);
  assert.equal(isNoteDraftStale('2026-11-15T10:00:00Z', '2026-11-15T10:01:00Z'), true);

  clearDraft(deepenKey);
  assert.equal(readDraft(deepenKey), null);

  localStorage.setItem('unrelated_key', 'keep-me');
  clearAllDrafts();
  assert.equal(readDraft(CAPTURE_DRAFT_KEY), null);
  assert.equal(readDraft(editKey), null);
  assert.equal(localStorage.getItem('unrelated_key'), 'keep-me');
});

test('M4.8: Write-before-clear snapshot import + pre-import local backup + atomic failure safety', async () => {
  // Plan trailing clear ranges
  const ranges = planTrailingClearRanges([
    { tab: 'Books', lastCol: 'L', oldRowCount: 4, newRowCount: 6 },
    { tab: 'Notes', lastCol: 'R', oldRowCount: 11, newRowCount: 4 },
    { tab: 'Sessions', lastCol: 'G', oldRowCount: 3, newRowCount: 3 },
    { tab: 'DeltaLogs', lastCol: 'E', oldRowCount: 0, newRowCount: 1 },
  ]);
  assert.deepEqual(ranges, ['Notes!A5:R11']);

  localStorage.clear();
  const backupSnap = {
    version: 1,
    exportedAt: '2026-11-15T08:00:00Z',
    books: [],
    notes: [],
    sessions: [],
    deltaLogs: [],
  };
  assert.equal(savePreImportBackup(backupSnap, '2026-11-15T09:00:00Z'), true);
  const loadedBackup = readPreImportBackup();
  assert.equal(loadedBackup?.savedAt, '2026-11-15T09:00:00Z');
  assert.equal(loadedBackup?.snapshot.version, 1);
  clearPreImportBackup();
  assert.equal(localStorage.getItem(PRE_IMPORT_BACKUP_KEY), null);

  // Verify GoogleSheetsAdapter.replaceWorkspace writes before clearing AND aborts clear on write error
  const callLog = [];
  const makeMockFetch = ({ failBatchUpdate = false } = {}) => {
    return async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || 'GET').toUpperCase();
      callLog.push({ method, url: u });

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
              {
                range: 'Books!A1:L1',
                values: [['id', 'title', 'author', 'format', 'kind', 'status', 'currentPos', 'totalPos', 'posUnit', 'normalizedPos', 'docUrl', 'metaJson']],
              },
              {
                range: 'Notes!A1:R1',
                values: [['id', 'slug', 'bookId', 'createdAt', 'updatedAt', 'pos', 'normalizedPos', 'status', 'source', 'tags', 'quote', 'takeaway', 'contextMechanism', 'critique', 'deltaTrigger', 'deltaAction', 'deltaStatus', 'metaJson']],
              },
              {
                range: 'Sessions!A1:G1',
                values: [['id', 'bookId', 'date', 'startPos', 'endPos', 'updatedAt', 'note']],
              },
              {
                range: 'DeltaLogs!A1:E1',
                values: [['id', 'noteId', 'date', 'outcome', 'reflection']],
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes('values:batchGet') && u.includes('Books!A%3AA')) {
        return new Response(
          JSON.stringify({
            valueRanges: [
              { range: 'Books!A:A', values: [['id'], ['b1'], ['b2'], ['b3']] },
              { range: 'Notes!A:A', values: [['id'], ['n1'], ['n2'], ['n3'], ['n4']] },
              { range: 'Sessions!A:A', values: [['id'], ['s1']] },
              { range: 'DeltaLogs!A:A', values: [['id']] },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes('values:batchUpdate')) {
        if (failBatchUpdate) {
          return new Response('Simulated 500 write error', { status: 500 });
        }
        return new Response(JSON.stringify({ totalUpdatedRows: 2 }), { status: 200 });
      }
      if (u.includes('values:batchClear')) {
        return new Response(JSON.stringify({ clearedRanges: JSON.parse(init.body).ranges }), {
          status: 200,
        });
      }
      if (u.includes('drive/v3/files/sheet-imp-1')) {
        return new Response(JSON.stringify({ modifiedTime: '2026-11-16T01:00:00Z' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
  };

  localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-imp-1');
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = makeMockFetch({ failBatchUpdate: true });
    const failingAdapter = new GoogleSheetsAdapter(() => 'tok-1');

    await assert.rejects(() => failingAdapter.replaceWorkspace(backupSnap), /500/);
    assert.equal(
      callLog.some(c => c.url.includes('values:batchClear')),
      false,
      'values:batchClear MUST NOT run if values:batchUpdate fails'
    );

    callLog.length = 0;
    globalThis.fetch = makeMockFetch({ failBatchUpdate: false });
    const okAdapter = new GoogleSheetsAdapter(() => 'tok-1');
    await okAdapter.replaceWorkspace(backupSnap);
    const updateIdx = callLog.findIndex(c => c.url.includes('values:batchUpdate'));
    const clearIdx = callLog.findIndex(c => c.url.includes('values:batchClear'));
    assert.ok(updateIdx >= 0 && clearIdx > updateIdx, 'values:batchUpdate must precede values:batchClear');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('M4.9: Pre-write row conflict guard, domain clamping, and UNFORMATTED_VALUE', async () => {
  assert.equal(clampNotePos(-12, { posUnit: 'page', totalPos: 300 }), 0);
  assert.equal(clampNotePos(150, { posUnit: 'percent', totalPos: 100 }), 100);
  assert.equal(clampNotePos(500, { posUnit: 'page', totalPos: 320 }), 320);
  assert.equal(clampNotePos(88, { posUnit: 'loc', totalPos: 0 }), 88);

  assert.equal(extractMetaUpdatedAt(JSON.stringify({ updatedAt: '2026-11-15T12:00:00Z' })), '2026-11-15T12:00:00Z');
  assert.equal(isRemoteNewer('2026-11-15T12:05:00Z', '2026-11-15T12:00:00Z'), true);
  assert.equal(isRemoteNewer('2026-11-15T12:00:00.000Z', '2026-11-15T12:00:00Z'), false);

  localStorage.clear();
  localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-conf-1');

  let putCalls = 0;
  let sawUnformatted = false;
  let sawConflictCellUnformatted = false;
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || 'GET').toUpperCase();
      if (u.includes('values:batchGet') && u.includes('UNFORMATTED_VALUE')) {
        sawUnformatted = true;
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
              { range: 'Books!A1:L1', values: [['id', 'title', 'author', 'format', 'kind', 'status', 'currentPos', 'totalPos', 'posUnit', 'normalizedPos', 'docUrl', 'metaJson']] },
              { range: 'Notes!A1:R1', values: [['id', 'slug', 'bookId', 'createdAt', 'updatedAt', 'pos', 'normalizedPos', 'status', 'source', 'tags', 'quote', 'takeaway', 'contextMechanism', 'critique', 'deltaTrigger', 'deltaAction', 'deltaStatus', 'metaJson']] },
              { range: 'Sessions!A1:G1', values: [['id', 'bookId', 'date', 'startPos', 'endPos', 'updatedAt', 'note']] },
              { range: 'DeltaLogs!A1:E1', values: [['id', 'noteId', 'date', 'outcome', 'reflection']] },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes('values:batchGet')) {
        return new Response(
          JSON.stringify({
            valueRanges: [
              { range: 'Books!A:L', values: [['id']] },
              { range: 'Notes!A:R', values: [['id']] },
              { range: 'Sessions!A:G', values: [['id']] },
              { range: 'DeltaLogs!A:E', values: [['id']] },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes('Notes!A%3AA')) {
        return new Response(JSON.stringify({ values: [['id'], ['note-1']] }), { status: 200 });
      }
      // M6 B4.3: the guard reads A{r}:{tsCol}{r} so it can verify the row id (col A).
      if (method === 'GET' && u.includes('Notes!A2%3AE2')) {
        if (u.includes('valueRenderOption=UNFORMATTED_VALUE')) {
          sawConflictCellUnformatted = true;
        }
        return new Response(
          JSON.stringify({ values: [['note-1', 'slug-1', 'book-1', '2026-11-15T10:00:00Z', '2026-11-16T12:05:00Z']] }),
          { status: 200 }
        );
      }
      if (u.includes('Books!A%3AA')) {
        return new Response(JSON.stringify({ values: [['id'], ['book-1']] }), { status: 200 });
      }
      if (method === 'GET' && u.includes('Books!A2%3AL2')) {
        if (u.includes('valueRenderOption=UNFORMATTED_VALUE')) {
          sawConflictCellUnformatted = true;
        }
        return new Response(
          JSON.stringify({
            values: [
              ['book-1', 'Book', '', 'physical', 'nonfiction', 'reading', 0, 0, 'page', 0, '',
                JSON.stringify({ updatedAt: '2026-11-16T12:05:00Z' })],
            ],
          }),
          { status: 200 }
        );
      }
      if (method === 'PUT') {
        putCalls += 1;
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const adapter = new GoogleSheetsAdapter(() => 'tok-1');
    await adapter.loadWorkspace();
    assert.equal(sawUnformatted, true, 'loadWorkspaceFromSheets must request UNFORMATTED_VALUE');

    await assert.rejects(
      () =>
        adapter.saveNote(
          {
            id: 'note-1',
            slug: 'slug-1',
            bookId: 'book-1',
            createdAt: '2026-11-15T10:00:00Z',
            updatedAt: '2026-11-16T12:06:00Z',
            pos: 10,
            normalizedPos: 0.1,
            status: 'saved',
            source: 'app',
            tags: [],
            quote: '',
            takeaway: 'Local stale edit',
            contextMechanism: '',
            critique: '',
            deltaTrigger: '',
            deltaAction: '',
            deltaStatus: 'none',
            meta: {},
          },
          { expectedBaseUpdatedAt: '2026-11-16T12:00:00Z' }
        ),
      err => err instanceof RowConflictError
    );

    await assert.rejects(
      () =>
        adapter.saveBook(
          {
            id: 'book-1',
            title: 'Book',
            author: 'Author',
            format: 'physical',
            kind: 'nonfiction',
            status: 'reading',
            currentPos: 20,
            totalPos: 100,
            posUnit: 'page',
            normalizedPos: 0.2,
            docUrl: '',
            meta: { updatedAt: '2026-11-16T12:06:00Z' },
          },
          { expectedBaseUpdatedAt: '2026-11-16T12:00:00Z' }
        ),
      err => err instanceof RowConflictError
    );

    assert.equal(
      sawConflictCellUnformatted,
      true,
      'Conflict timestamp cell reads must request UNFORMATTED_VALUE'
    );
    assert.equal(putCalls, 0, 'Conflicting saves must abort before issuing PUT');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('M4.9 parity: applyBookmarkAdvance transitions queued -> reading with startedAt and clamps percent with totalPos=0 to 100', () => {
  const queuedPercentBook = {
    id: 'book-q-pct',
    title: 'Percent Without Total',
    author: 'Tester',
    format: 'ebook',
    kind: 'nonfiction',
    status: 'queued',
    currentPos: 0,
    totalPos: 0,
    posUnit: 'percent',
    normalizedPos: 0,
    docUrl: '',
    meta: {},
  };

  const res = applyBookmarkAdvance(queuedPercentBook, 140, { nowIso: '2026-11-16T10:00:00Z' });
  assert.equal(res.changed, true);
  assert.equal(res.updatedBook.status, 'reading');
  assert.equal(res.updatedBook.meta.startedAt, '2026-11-16T10:00:00Z');
  assert.equal(res.updatedBook.currentPos, 100);
  assert.equal(res.updatedBook.normalizedPos, 1.0);

  const overrideRes = applyBookmarkAdvance(res.updatedBook, 120, {
    manualOverride: true,
    nowIso: '2026-11-16T10:05:00Z',
  });
  assert.equal(overrideRes.updatedBook.currentPos, 100);
  assert.equal(overrideRes.updatedBook.normalizedPos, 1.0);
});
