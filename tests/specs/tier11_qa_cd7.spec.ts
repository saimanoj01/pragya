import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Tier 11 (QA, CD Batch 7 — Sync Architecture)
 * Adversarial end-to-end verification in real Chromium:
 * 1. Stale-codec (`codecVersion: 1`) localStorage → IndexedDB migration serves offline read-only
 *    WITHOUT promoting to v2, then online reload skips fast-reload cache hit and upgrades only from Sheets.
 * 2. IndexedDB unavailable / throwing (`indexedDB.open` throws SecurityError) degrades gracefully
 *    to localStorage across Cloud load, offline reload, and snapshot import backup with zero page errors.
 * 3. Immediate reload right after explicit Logout AND right after Account Switch (`A -> B`) leaves
 *    zero Account A data in IndexedDB (`pragya_sheets_cache_v1` and `pragya_pre_import_backup_v1`).
 * 4. Cloud rapid back-to-back `+10p` mutations (no stale-closure overwrite), `revertBookmarkAdvance`
 *    for both `mode === 'created'` (delete) and `mode === 'updated'` (batched + conflict-guarded),
 *    and `markBookFinished` conflict guard.
 * 5. Active `test.fail` repros for any discovered Batch 7 findings (`QA-46`, `QA-47`).
 */

const BOOK_HEADERS = [
  'id', 'title', 'author', 'format', 'kind', 'status',
  'currentPos', 'totalPos', 'posUnit', 'normalizedPos', 'docUrl', 'metaJson',
];
const NOTE_HEADERS = [
  'id', 'slug', 'bookId', 'createdAt', 'updatedAt', 'pos', 'normalizedPos',
  'status', 'source', 'tags', 'quote', 'takeaway', 'contextMechanism',
  'critique', 'deltaTrigger', 'deltaAction', 'deltaStatus', 'metaJson',
];
const SESSION_HEADERS = ['id', 'bookId', 'date', 'startPos', 'endPos', 'updatedAt', 'note'];
const DELTA_HEADERS = ['id', 'noteId', 'date', 'outcome', 'reflection'];

function colIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

interface RecordedCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

interface CloudMockOptions {
  sheetId: string;
  bookTitle?: string;
  onBatchGet?: (url: string) => Promise<void>;
  onAppend?: (url: string) => Promise<void>;
}

async function installCloudMock(page: Page, opts: CloudMockOptions) {
  let modifiedTime = '2026-11-16T10:00:00Z';
  const calls: RecordedCall[] = [];
  const sheetData: Record<string, unknown[][]> = {
    Books: [
      BOOK_HEADERS,
      [
        'book-qa7',
        opts.bookTitle || 'QA7 Sync Book',
        'Meadows',
        'physical',
        'nonfiction',
        'reading',
        50,
        200,
        'page',
        0.25,
        '',
        JSON.stringify({ updatedAt: '2026-11-16T10:00:00.000Z', subgenre: 'systems' }),
      ],
    ],
    Notes: [NOTE_HEADERS],
    Sessions: [SESSION_HEADERS],
    DeltaLogs: [DELTA_HEADERS],
  };

  const readRange = (rangeStr: string): unknown[][] => {
    const clean = rangeStr.replace(/'/g, '');
    const [tab, a1] = clean.split('!');
    const rows = sheetData[tab] || [];
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(a1);
    if (!m) return rows;
    const c1 = colIndex(m[1]);
    const r1 = m[2] ? Number(m[2]) - 1 : 0;
    const c2 = m[3] ? colIndex(m[3]) : c1;
    const r2 = m[4] ? Number(m[4]) - 1 : rows.length - 1;
    const out: unknown[][] = [];
    for (let r = r1; r <= r2 && r < rows.length; r += 1) {
      out.push(rows[r].slice(c1, c2 + 1));
    }
    return out;
  };

  const parseBody = (route: Route): Record<string, unknown> | null => {
    const raw = route.request().postData();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  await page.route('https://www.googleapis.com/**', async route => {
    const u = route.request().url();
    const method = route.request().method();
    calls.push({ method, url: u, body: parseBody(route) });
    if (u.includes(`drive/v3/files/${opts.sheetId}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: opts.sheetId, name: 'Pragya Commonplace', modifiedTime }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
  });

  await page.route('https://sheets.googleapis.com/**', async route => {
    const u = route.request().url();
    const method = route.request().method();
    const body = parseBody(route);
    calls.push({ method, url: u, body });

    const fulfill = (payload: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });

    if (u.includes('fields=sheets.properties')) {
      await fulfill({
        sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map((title, idx) => ({
          properties: { sheetId: idx + 1, title },
        })),
      });
      return;
    }
    if (u.includes('values:batchGet')) {
      if (opts.onBatchGet) await opts.onBatchGet(u);
      const ranges = new URL(u).searchParams.getAll('ranges');
      const valueRanges = ranges.map(r => {
        const clean = r.replace(/'/g, '');
        const [tab, a1] = clean.split('!');
        const rows = sheetData[tab] || [];
        const echoed = /^[A-Z]+:[A-Z]+$/.test(a1)
          ? `'${tab}'!${a1.split(':')[0]}1:${a1.split(':')[1]}${Math.max(1, rows.length)}`
          : r;
        return { range: echoed, values: readRange(r) };
      });
      await fulfill({ valueRanges });
      return;
    }
    if (u.includes('values:batchUpdate') && method === 'POST') {
      modifiedTime = new Date(Date.parse(modifiedTime) + 1000).toISOString();
      const data = (body?.data as Array<{ range: string; values: unknown[][] }>) || [];
      for (const item of data) {
        const [tab, a1] = item.range.split('!');
        const m = /^A(\d+):/.exec(a1);
        if (m) {
          const startIdx = Number(m[1]) - 1;
          item.values.forEach((row, offset) => {
            sheetData[tab][startIdx + offset] = row;
          });
        }
      }
      await fulfill({ totalUpdatedRows: data.length });
      return;
    }
    if (u.includes(':batchUpdate') && method === 'POST') {
      modifiedTime = new Date(Date.parse(modifiedTime) + 1000).toISOString();
      const reqs = (body?.requests as Array<{ deleteDimension?: { range: { sheetId: number; startIndex: number } } }>) || [];
      const tabBySheetId: Record<number, string> = { 1: 'Books', 2: 'Notes', 3: 'Sessions', 4: 'DeltaLogs' };
      for (const r of reqs) {
        const rng = r.deleteDimension?.range;
        if (rng && tabBySheetId[rng.sheetId]) {
          sheetData[tabBySheetId[rng.sheetId]].splice(rng.startIndex, 1);
        }
      }
      await fulfill({});
      return;
    }
    if (u.includes(':append') && method === 'POST') {
      if (opts.onAppend) await opts.onAppend(u);
      modifiedTime = new Date(Date.parse(modifiedTime) + 1000).toISOString();
      const m = /\/values\/([^/?:]+)!A1:append/.exec(decodeURIComponent(u));
      const tab = m?.[1] || 'Notes';
      const rowsToAppend = (body?.values as unknown[][]) || [];
      const startRow = sheetData[tab].length + 1;
      for (const row of rowsToAppend) sheetData[tab].push(row);
      const endRow = sheetData[tab].length;
      const lastColMap: Record<string, string> = { Books: 'L', Notes: 'R', Sessions: 'G', DeltaLogs: 'E' };
      await fulfill({ updates: { updatedRange: `${tab}!A${startRow}:${lastColMap[tab] || 'R'}${endRow}` } });
      return;
    }
    if (method === 'PUT' && u.includes('/values/')) {
      modifiedTime = new Date(Date.parse(modifiedTime) + 1000).toISOString();
      const m = /\/values\/([^/?]+)/.exec(decodeURIComponent(u));
      if (m) {
        const [tab, a1] = m[1].split('!');
        const rm = /^A(\d+):/.exec(a1);
        const vals = (body?.values as unknown[][]) || [];
        if (rm && vals[0]) sheetData[tab][Number(rm[1]) - 1] = vals[0];
      }
      await fulfill({});
      return;
    }
    if (method === 'GET' && u.includes('/values/')) {
      const m = /\/values\/([^/?]+)/.exec(decodeURIComponent(u));
      const rangeStr = m ? m[1] : 'Books!A:A';
      await fulfill({ range: rangeStr, values: readRange(rangeStr) });
      return;
    }
    await fulfill({});
  });

  return {
    calls,
    sheetData,
    setModifiedTime: (v: string) => {
      modifiedTime = v;
    },
    setBookUpdatedAt: (iso: string) => {
      const meta = JSON.parse(String(sheetData.Books[1][11] || '{}')) as Record<string, unknown>;
      meta.updatedAt = iso;
      sheetData.Books[1][11] = JSON.stringify(meta);
    },
  };
}

async function readIdbEntries(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    return new Promise<Record<string, string>>((resolve, reject) => {
      const req = indexedDB.open('pragya-cache', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readonly');
        const store = tx.objectStore('kv');
        const keysReq = store.getAllKeys();
        const valsReq = store.getAll();
        tx.oncomplete = () => {
          const out: Record<string, string> = {};
          for (let i = 0; i < (keysReq.result || []).length; i += 1) {
            out[String(keysReq.result[i])] = String(valsReq.result[i]);
          }
          db.close();
          resolve(out);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  });
}

async function seedCloudSession(page: Page, sheetId: string, email: string) {
  await page.goto('/');
  await page.evaluate(
    ({ sheetId, email }) => {
      localStorage.setItem('pragya_google_token', 'qa7-tok');
      localStorage.setItem('pragya_google_user', JSON.stringify({ email, name: 'QA7 Reader' }));
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', sheetId);
      localStorage.removeItem('pragya_google_token_expires_at');
    },
    { sheetId, email }
  );
  await page.reload();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
  await expect(page.getByTestId('book-card-book-qa7')).toBeVisible();
}

test.describe('Tier 11 — CD Batch 7 QA adversarial sync architecture probes', () => {
  test('stale-codec (codecVersion=1) migration never promotes to v2 offline, and online reload refreshes from Sheets before stamping v2', async ({
    page,
  }) => {
    let offline = true;
    await page.route('https://www.googleapis.com/**', async route => {
      if (offline) return route.abort('internetdisconnected');
      const u = route.request().url();
      if (u.includes('drive/v3/files/sheet-stale-v1')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'sheet-stale-v1', modifiedTime: '2026-11-16T08:00:00Z' }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
    });
    let sheetsBatchGetCount = 0;
    await page.route('https://sheets.googleapis.com/**', async route => {
      if (offline) return route.abort('internetdisconnected');
      const u = route.request().url();
      if (u.includes('fields=sheets.properties')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map((title, idx) => ({
              properties: { sheetId: idx + 1, title },
            })),
          }),
        });
      }
      if (u.includes('values:batchGet')) {
        sheetsBatchGetCount += 1;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            valueRanges: [
              {
                range: 'Books!A:L',
                values: [
                  BOOK_HEADERS,
                  [
                    'book-v1',
                    'Fresh From Sheets V2',
                    'Author',
                    'physical',
                    'nonfiction',
                    'reading',
                    50,
                    200,
                    'page',
                    0.25,
                    '',
                    JSON.stringify({ updatedAt: '2026-11-16T08:00:00Z', subgenre: 'preserved-key' }),
                  ],
                ],
              },
              { range: 'Notes!A:R', values: [NOTE_HEADERS] },
              { range: 'Sessions!A:G', values: [SESSION_HEADERS] },
              { range: 'DeltaLogs!A:E', values: [DELTA_HEADERS] },
            ],
          }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token', 'qa7-stale-tok');
      localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'v1@pragya.dev', name: 'V1' }));
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-stale-v1');
      localStorage.setItem(
        'pragya_sheets_cache_v1',
        JSON.stringify({
          spreadsheetId: 'sheet-stale-v1',
          modifiedTime: '2026-11-16T08:00:00Z',
          accountEmail: 'v1@pragya.dev',
          codecVersion: 1, // stale!
          state: {
            books: [
              {
                id: 'book-v1',
                title: 'Stale V1 Book',
                author: 'Author',
                format: 'physical',
                kind: 'nonfiction',
                status: 'reading',
                currentPos: 50,
                totalPos: 200,
                posUnit: 'page',
                normalizedPos: 0.25,
                docUrl: '',
                meta: { updatedAt: '2026-11-16T08:00:00Z' },
              },
            ],
            notes: [],
            sessions: [],
            deltaLogs: [],
          },
        })
      );
    });

    // 1. Offline reload migrates verbatim into IndexedDB and serves read-only WITHOUT promoting codecVersion!
    await page.reload();
    await expect(page.getByTestId('offline-readonly-badge')).toBeVisible();
    await expect(page.getByTestId('book-card-book-v1')).toContainText('Stale V1 Book');
    expect(await page.evaluate(() => localStorage.getItem('pragya_sheets_cache_v1'))).toBeNull();
    const idbOffline = await readIdbEntries(page);
    expect(JSON.parse(idbOffline.pragya_sheets_cache_v1).codecVersion).toBe(1);

    // 2. Come back online with IDENTICAL modifiedTime -> must NOT fast-reload hit stale v1; must fetch Sheets & upgrade to v2!
    offline = false;
    await page.reload();
    await expect(page.getByTestId('book-card-book-v1')).toContainText('Fresh From Sheets V2');
    expect(sheetsBatchGetCount).toBeGreaterThan(0);
    await expect
      .poll(async () => JSON.parse((await readIdbEntries(page)).pragya_sheets_cache_v1 || '{}').codecVersion)
      .toBe(2);
    const upgraded = JSON.parse((await readIdbEntries(page)).pragya_sheets_cache_v1);
    expect(upgraded.state.books[0].meta.subgenre).toBe('preserved-key');
  });

  test('IndexedDB blocked/throwing (SecurityError) degrades gracefully to localStorage without crashing across online & offline reloads', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        get() {
          return {
            open() {
              throw new DOMException('IndexedDB blocked in private mode', 'SecurityError');
            },
          };
        },
      });
    });

    let offline = false;
    await page.route('https://www.googleapis.com/**', route => {
      if (offline) return route.abort('internetdisconnected');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'sheet-noidb', modifiedTime: '2026-11-16T10:00:00Z' }),
      });
    });
    await page.route('https://sheets.googleapis.com/**', route => {
      if (offline) return route.abort('internetdisconnected');
      const u = route.request().url();
      if (u.includes('fields=sheets.properties')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map((title, idx) => ({
              properties: { sheetId: idx + 1, title },
            })),
          }),
        });
      }
      if (u.includes('values:batchGet')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            valueRanges: [
              {
                range: 'Books!A:L',
                values: [
                  BOOK_HEADERS,
                  ['book-noidb', 'Private Mode Fallback Book', 'Author', 'physical', 'nonfiction', 'reading', 30, 100, 'page', 0.3, '', '{"updatedAt":"2026-11-16T10:00:00Z"}'],
                ],
              },
              { range: 'Notes!A:R', values: [NOTE_HEADERS] },
              { range: 'Sessions!A:G', values: [SESSION_HEADERS] },
              { range: 'DeltaLogs!A:E', values: [DELTA_HEADERS] },
            ],
          }),
        });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token', 'qa7-noidb-tok');
      localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'priv@pragya.dev', name: 'Priv' }));
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-noidb');
    });
    await page.reload();
    await expect(page.getByTestId('book-card-book-noidb')).toContainText('Private Mode Fallback Book');

    // Fell back cleanly to localStorage without uncaught errors
    const lsFallback = await page.evaluate(() => localStorage.getItem('pragya_sheets_cache_v1'));
    expect(lsFallback).toContain('Private Mode Fallback Book');

    // Offline reload still works via localStorage fallback
    offline = true;
    await page.reload();
    await expect(page.getByTestId('offline-readonly-badge')).toBeVisible();
    await expect(page.getByTestId('book-card-book-noidb')).toContainText('Private Mode Fallback Book');
    expect(pageErrors).toEqual([]);
  });

  test('PragyaActionsContext stays referentially identical across mutations; overlapping mutations read fresh state via refs (no stale closures); Undo & markBookFinished enforce conflict guards', async ({
    page,
  }) => {
    let holdAppend = false;
    let appendHeld!: () => void;
    let releaseAppend!: () => void;
    const appendHeldPromise = new Promise<void>(r => {
      appendHeld = r;
    });
    const waitToReleaseAppend = new Promise<void>(r => {
      releaseAppend = r;
    });

    const mock = await installCloudMock(page, {
      sheetId: 'sheet-qa7-rapid',
      onAppend: async url => {
        if (holdAppend && url.includes('Sessions')) {
          holdAppend = false;
          appendHeld();
          await waitToReleaseAppend;
        }
      },
    });
    await seedCloudSession(page, 'sheet-qa7-rapid', 'rapid@pragya.dev');

    // Snapshot the live React 18 PragyaDataContext & PragyaActionsContext Provider values
    // directly from #root's fiber tree so we prove at runtime that mutations update Data
    // without changing Actions identity (zero action-only consumer re-renders).
    const snapshotCaptured = await page.evaluate(() => {
      type Fiber = {
        tag?: number;
        memoizedProps?: { value?: Record<string, unknown> };
        child?: Fiber | null;
        sibling?: Fiber | null;
      };
      const rootEl = document.getElementById('root') as unknown as Record<string, unknown> | null;
      const containerKey = rootEl ? Object.keys(rootEl).find(k => k.startsWith('__reactContainer$')) : undefined;
      const rootFiber = containerKey ? (rootEl?.[containerKey] as Fiber | undefined) : undefined;
      let dataVal: unknown = null;
      let actionsVal: unknown = null;
      const walk = (f: Fiber | null | undefined) => {
        if (!f) return;
        const val = f.memoizedProps?.value;
        if (val && typeof val === 'object') {
          if ('books' in val && 'isSyncing' in val && !('advanceBookPosition' in val)) dataVal = val;
          if ('advanceBookPosition' in val && 'captureNote' in val && !('books' in val)) actionsVal = val;
        }
        walk(f.child);
        walk(f.sibling);
      };
      walk(rootFiber);
      (window as unknown as Record<string, unknown>).__qa7CtxBefore = { dataVal, actionsVal };
      return Boolean(dataVal && actionsVal);
    });
    expect(snapshotCaptured).toBe(true);

    // 1. First +10p advance (50 -> 60, creates new session) then Undo (`mode === 'created'` deletes session row!)
    mock.calls.length = 0;
    await page.getByTestId('advance-10p-btn-book-qa7').click();
    await expect(page.getByTestId('book-card-book-qa7')).toContainText('p. 60 / 200');
    expect(mock.sheetData.Sessions.length).toBe(2); // header + 1 new session

    await page.getByTestId('toast-undo-btn').last().click();
    await expect(page.getByTestId('book-card-book-qa7')).toContainText('p. 50 / 200');
    await expect.poll(() => mock.sheetData.Sessions.length).toBe(1); // deleted back to header only!

    // 2. TRUE overlapping back-to-back mutations: hold Mutation #1 (+10p: 50 -> 60) in flight on Sessions:append.
    // While #1 has NOT resolved (UI still shows p. 50, book meta.updatedAt is still T0, sessions is still []),
    // submit Mutation #2 (exact 70). Because PragyaContext queues via enqueueMutation and reads booksRef/sessionsRef,
    // #2 MUST see #1's new updatedAt (no ConflictError) AND coalesce into #1's session (50 -> 70, 1 session row)!
    holdAppend = true;
    await page.getByTestId('advance-10p-btn-book-qa7').click();
    await appendHeldPromise;
    await expect(page.getByTestId('book-card-book-qa7')).toContainText('p. 50 / 200');

    await page.getByTestId('advance-exact-input-book-qa7').fill('70');
    await page.getByTestId('advance-exact-btn-book-qa7').click();
    releaseAppend();

    await expect(page.getByTestId('book-card-book-qa7')).toContainText('p. 70 / 200');
    await expect.poll(() => mock.sheetData.Books[1][6]).toBe(70);
    expect(mock.sheetData.Sessions.length).toBe(2); // single coalesced session 50 -> 70
    expect(mock.sheetData.Sessions[1][3]).toBe(50);
    expect(mock.sheetData.Sessions[1][4]).toBe(70);
    await expect(page.locator('[data-testid="notification-toast"][data-toast-variant="error"]')).toHaveCount(0);

    // Live React 18 context split check: Data changed, Actions is strictly Object.is identical!
    const ctxComparison = await page.evaluate(() => {
      type Fiber = {
        memoizedProps?: { value?: Record<string, unknown> };
        child?: Fiber | null;
        sibling?: Fiber | null;
      };
      const rootEl = document.getElementById('root') as unknown as Record<string, unknown>;
      const containerKey = Object.keys(rootEl).find(k => k.startsWith('__reactContainer$'))!;
      const found: {
        dataAfter: Record<string, unknown> | null;
        actionsAfter: Record<string, unknown> | null;
      } = { dataAfter: null, actionsAfter: null };
      const walk = (f: Fiber | null | undefined) => {
        if (!f) return;
        const val = f.memoizedProps?.value;
        if (val && typeof val === 'object') {
          if ('books' in val && 'isSyncing' in val && !('advanceBookPosition' in val)) found.dataAfter = val;
          if ('advanceBookPosition' in val && 'captureNote' in val && !('books' in val)) found.actionsAfter = val;
        }
        walk(f.child);
        walk(f.sibling);
      };
      walk(rootEl[containerKey] as Fiber);
      const before = (window as unknown as Record<string, { dataVal: Record<string, unknown>; actionsVal: Record<string, unknown> }>).__qa7CtxBefore;
      return {
        dataChanged: found.dataAfter !== null && !Object.is(before.dataVal, found.dataAfter),
        actionsIdentical: found.actionsAfter !== null && Object.is(before.actionsVal, found.actionsAfter),
        advanceFnIdentical:
          found.actionsAfter !== null &&
          Object.is(before.actionsVal.advanceBookPosition, found.actionsAfter.advanceBookPosition),
        captureFnIdentical:
          found.actionsAfter !== null &&
          Object.is(before.actionsVal.captureNote, found.actionsAfter.captureNote),
      };
    });
    expect(ctxComparison).toEqual({
      dataChanged: true,
      actionsIdentical: true,
      advanceFnIdentical: true,
      captureFnIdentical: true,
    });

    // 3. Undo of the 2nd coalesced advance (`mode === 'updated'`) uses ONE batched values:batchUpdate (<= 3 calls)
    mock.calls.length = 0;
    await page.getByTestId('toast-undo-btn').last().click();
    await expect(page.getByTestId('book-card-book-qa7')).toContainText('p. 60 / 200');
    await expect
      .poll(() => mock.calls.filter(c => c.url.includes('drive/v3/files/sheet-qa7-rapid')).length)
      .toBe(1);
    expect(mock.calls.length).toBeLessThanOrEqual(3);
    const undoBatch = mock.calls.find(c => c.url.includes('values:batchUpdate'));
    expect(((undoBatch?.body?.data as Array<{ range: string }>) || []).map(d => d.range)).toEqual([
      'Books!A2:L2',
      'Sessions!A2:G2',
    ]);

    // 4. Advance again (60 -> 70), simulate remote Book edit before clicking Undo -> Undo aborts with 0 writes!
    await page.getByTestId('advance-10p-btn-book-qa7').click();
    await expect(page.getByTestId('book-card-book-qa7')).toContainText('p. 70 / 200');
    mock.setBookUpdatedAt('2099-01-01T00:00:00.000Z');
    mock.calls.length = 0;
    await page.getByTestId('toast-undo-btn').last().click();
    await expect(
      page.locator('[data-testid="notification-toast"][data-toast-variant="error"]').last()
    ).toContainText(/Updated on another device/i);
    expect(mock.calls.filter(c => c.method === 'POST' || c.method === 'PUT')).toHaveLength(0);

    // 5. markBookFinished on BookDetailView respects conflict guard (0 writes when remote book is newer)
    await page.evaluate(() => {
      window.location.hash = '#/book/book-qa7';
    });
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    mock.calls.length = 0;
    await page.getByTestId('mark-finished-btn').click();
    await expect(
      page.locator('[data-testid="notification-toast"][data-toast-variant="error"]').last()
    ).toContainText(/Updated on another device/i);
    expect(mock.calls.filter(c => c.method === 'POST' || c.method === 'PUT')).toHaveLength(0);
  });

  test('immediate reload after explicit logout AND after Account A -> B switch leaves zero Account A IndexedDB state', async ({
    page,
  }) => {
    await installCloudMock(page, { sheetId: 'sheet-qa7-logout', bookTitle: 'Account A Confidential Book' });
    await seedCloudSession(page, 'sheet-qa7-logout', 'acct-a@pragya.dev');
    await expect.poll(async () => Boolean((await readIdbEntries(page)).pragya_sheets_cache_v1)).toBe(true);

    // Seed an Account A pre-import backup directly in IndexedDB as well
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('pragya-cache', 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(
          JSON.stringify({ savedAt: '2026-11-16T00:00:00Z', snapshot: { books: [{ id: 'a-bk', title: 'Secret Backup' }] } }),
          'pragya_pre_import_backup_v1'
        );
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });

    // Part 1: Explicit Logout + immediate reload -> 0 keys in IDB
    await page.getByTestId('logout-btn').click();
    await expect(page.getByTestId('login-view')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('login-view')).toBeVisible();
    expect(Object.keys(await readIdbEntries(page))).toHaveLength(0);

    // Part 2: Re-sign in as Account A, populate IDB + backup, then switch to Account B via OAuth token
    // and immediately reload once Account B loads -> zero Account A cache or pre-import backup survives!
    await seedCloudSession(page, 'sheet-qa7-logout', 'acct-a@pragya.dev');
    await expect.poll(async () => Boolean((await readIdbEntries(page)).pragya_sheets_cache_v1)).toBe(true);
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('pragya-cache', 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(
          JSON.stringify({ savedAt: '2026-11-16T00:00:00Z', snapshot: { books: [{ id: 'a-bk', title: 'Secret Backup' }] } }),
          'pragya_pre_import_backup_v1'
        );
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });

    // Switch to Account B via the real OAuth callback flow (exercising applySignedInAccount + flushIdbQueue)
    // and verify Account A's IDB cache & pre-import backup are wiped and stay wiped across an immediate reload.
    await page.route('https://www.googleapis.com/oauth2/v3/userinfo', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'acct-b@pragya.dev', name: 'Account B' }),
      });
    });
    await page.route(/googleapis\.com\/drive\/v3\/files/, async route => {
      const u = route.request().url();
      if (u.includes('sheet-qa7-b')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'sheet-qa7-b', name: 'Pragya Commonplace', modifiedTime: '2026-11-17T00:00:00Z' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ files: [{ id: 'sheet-qa7-b', name: 'Pragya Commonplace', modifiedTime: '2026-11-17T00:00:00Z' }] }),
      });
    });
    await page.route(/sheets\.googleapis\.com\/v4\/spreadsheets\/sheet-qa7-b/, async route => {
      const u = route.request().url();
      if (u.includes('fields=sheets.properties')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map((title, idx) => ({
              properties: { sheetId: idx + 1, title },
            })),
          }),
        });
        return;
      }
      if (u.includes('values:batchGet')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            valueRanges: [
              {
                range: 'Books!A1:L2',
                values: [
                  BOOK_HEADERS,
                  ['book-b', 'Account B Clean Book', 'Author B', 'physical', 'nonfiction', 'reading', 5, 100, 'page', 0.05, '', '{"updatedAt":"2026-11-17T00:00:00Z"}'],
                ],
              },
              { range: 'Notes!A1:R1', values: [NOTE_HEADERS] },
              { range: 'Sessions!A1:G1', values: [SESSION_HEADERS] },
              { range: 'DeltaLogs!A1:E1', values: [DELTA_HEADERS] },
            ],
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.evaluate(() => {
      sessionStorage.setItem('pragya_oauth_csrf_state', 'qa7-switch-csrf');
      window.location.hash = '#access_token=qa7-token-b&state=qa7-switch-csrf&expires_in=3600';
    });
    await expect(page.getByTestId('book-card-book-b')).toContainText('Account B Clean Book');
    await expect(page.getByTestId('book-card-book-qa7')).toHaveCount(0);

    // Immediate reload right after Account A -> B switch: zero Account A cache or pre-import backup!
    await page.reload();
    await expect(page.getByTestId('book-card-book-b')).toContainText('Account B Clean Book');
    const idbB = await readIdbEntries(page);
    expect(idbB.pragya_pre_import_backup_v1).toBeUndefined();
    expect(idbB.pragya_sheets_cache_v1).toContain('Account B Clean Book');
    expect(idbB.pragya_sheets_cache_v1).not.toContain('Account A Confidential Book');
  });

  test('QA-46: cold fast-reload cache hit + remotely deleted Book must abort batchCommitMutations with RowMovedError and ZERO writes (never resurrect deleted book)', async ({
    page,
  }) => {
    const mock = await installCloudMock(page, { sheetId: 'sheet-qa46', bookTitle: 'Deleted Elsewhere Book' });
    await seedCloudSession(page, 'sheet-qa46', 'qa46@pragya.dev');

    // Wait for v2 IndexedDB cache, then reload -> fast-reload cache hit leaves rowHints empty!
    await expect.poll(async () => Boolean((await readIdbEntries(page)).pragya_sheets_cache_v1)).toBe(true);
    mock.calls.length = 0;
    await page.reload();
    await expect(page.getByTestId('book-card-book-qa7')).toBeVisible();
    expect(mock.calls.filter(c => c.url.includes('sheets.googleapis.com'))).toHaveLength(0);

    // Another device permanently deletes book-qa7 from the Books tab
    mock.sheetData.Books.splice(1, 1);
    mock.calls.length = 0;

    // Click +10p advance -> must abort with RowMovedError and 0 POST/PUT writes (must NOT append/resurrect!)
    await page.getByTestId('advance-10p-btn-book-qa7').click();
    await expect(page.getByTestId('notification-toast').last()).toBeVisible();
    expect(mock.calls.filter(c => c.method === 'POST' || c.method === 'PUT')).toHaveLength(0);
    expect(mock.sheetData.Books.length).toBe(1); // header only — deleted book NOT resurrected!
    expect(mock.sheetData.Sessions.length).toBe(1); // header only — no orphaned session!
    await expect(
      page.locator('[data-testid="notification-toast"][data-toast-variant="error"]').last()
    ).toBeVisible();
  });

  test('QA-47: in-flight loadWorkspaceFromSheets settling after explicit Logout must NOT re-write Account A cache back into IndexedDB', async ({
    page,
  }) => {
    let holdSync = false;
    let releaseSync!: () => void;
    let syncHeld!: () => void;
    const syncHeldPromise = new Promise<void>(r => {
      syncHeld = r;
    });
    const waitToRelease = new Promise<void>(r => {
      releaseSync = r;
    });

    await installCloudMock(page, {
      sheetId: 'sheet-qa47',
      bookTitle: 'Account A Secret Manuscript',
      onBatchGet: async url => {
        // Hold the DATA values:batchGet (loadWorkspaceFromSheets L649), after discoverOrCreateSpreadsheet
        // and ensureSchemaAndRepair have completed, right before writeSheetsCache (L707).
        if (holdSync && url.includes('UNFORMATTED_VALUE')) {
          holdSync = false;
          syncHeld();
          await waitToRelease;
        }
      },
    });
    await seedCloudSession(page, 'sheet-qa47', 'a-secret@pragya.dev');
    await expect.poll(async () => Boolean((await readIdbEntries(page)).pragya_sheets_cache_v1)).toBe(true);

    // Trigger a manual Sync Now and hold its data values:batchGet in flight
    holdSync = true;
    await page.keyboard.press('r');
    await syncHeldPromise;

    // User clicks Log out while sync is still in flight -> Login screen appears & IDB is wiped
    await page.getByTestId('logout-btn').click();
    await expect(page.getByTestId('login-view')).toBeVisible();
    expect(Object.keys(await readIdbEntries(page))).toHaveLength(0);

    // Now the in-flight values:batchGet response resolves -> MUST NOT resurrect Account A's cache in IndexedDB!
    releaseSync();
    await page.waitForTimeout(300);

    const idbAfterLateSync = await readIdbEntries(page);
    expect(idbAfterLateSync.pragya_sheets_cache_v1).toBeUndefined();
  });
});
