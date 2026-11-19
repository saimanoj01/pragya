import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Tier 10 — CD Batch 7 (Sync Architecture):
 *  - Real browser IndexedDB persistence (`pragya-cache` / `kv`) & fast-reload cache hit
 *  - Transparent one-time `localStorage` → IndexedDB migration (cache + pre-import backup)
 *  - Explicit logout & account-switch IndexedDB cleanup (zero cross-account bleed)
 *  - Cloud multi-tab batched writes: `<= 5` HTTP calls on capture+advance and bookmark advance,
 *    and conflict-before-write zero-write guarantee
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

interface StatefulCloudMock {
  calls: RecordedCall[];
  sheetData: Record<string, unknown[][]>;
  setModifiedTime: (v: string) => void;
  setBookUpdatedAt: (iso: string) => void;
}

async function installStatefulCloudMock(
  page: Page,
  sheetId: string,
  initialBookTitle = 'CD7 Sync Architecture',
  options: { onSheetsRequest?: (route: Route, url: string, method: string) => Promise<boolean> } = {}
): Promise<StatefulCloudMock> {
  let modifiedTime = '2026-11-16T10:00:00Z';
  const calls: RecordedCall[] = [];
  const sheetData: Record<string, unknown[][]> = {
    Books: [
      BOOK_HEADERS,
      [
        'book-cd7',
        initialBookTitle,
        'Systems Author',
        'physical',
        'nonfiction',
        'reading',
        50,
        200,
        'page',
        0.25,
        '',
        JSON.stringify({ updatedAt: '2026-11-16T10:00:00.000Z', subgenre: 'architecture' }),
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
    if (u.includes(`drive/v3/files/${sheetId}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: sheetId, name: 'Pragya Commonplace', modifiedTime }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ files: [] }),
    });
  });

  await page.route('https://sheets.googleapis.com/**', async route => {
    const u = route.request().url();
    const method = route.request().method();
    const body = parseBody(route);
    calls.push({ method, url: u, body });

    if (options.onSheetsRequest && (await options.onSheetsRequest(route, u, method))) {
      return;
    }

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
      const parsed = new URL(u);
      const ranges = parsed.searchParams.getAll('ranges');
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
    if (u.includes(':append') && method === 'POST') {
      modifiedTime = new Date(Date.parse(modifiedTime) + 1000).toISOString();
      const m = /\/values\/([^/?:]+)!A1:append/.exec(decodeURIComponent(u));
      const tab = m?.[1] || 'Notes';
      const rowsToAppend = (body?.values as unknown[][]) || [];
      const startRow = sheetData[tab].length + 1;
      for (const row of rowsToAppend) sheetData[tab].push(row);
      const endRow = sheetData[tab].length;
      const lastColMap: Record<string, string> = { Books: 'L', Notes: 'R', Sessions: 'G', DeltaLogs: 'E' };
      await fulfill({
        updates: { updatedRange: `${tab}!A${startRow}:${lastColMap[tab] || 'R'}${endRow}` },
      });
      return;
    }
    await fulfill({});
  });

  return {
    calls,
    sheetData,
    setModifiedTime: v => {
      modifiedTime = v;
    },
    setBookUpdatedAt: iso => {
      const meta = JSON.parse(String(sheetData.Books[1][11] || '{}')) as Record<string, unknown>;
      meta.updatedAt = iso;
      sheetData.Books[1][11] = JSON.stringify(meta);
    },
  };
}

/** Read all key/value pairs currently stored in the browser's `pragya-cache` IndexedDB store. */
async function readAllIdbCacheEntries(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    return new Promise<Record<string, string>>((resolve, reject) => {
      const req = indexedDB.open('pragya-cache', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) {
          req.result.createObjectStore('kv');
        }
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
          const keys = keysReq.result || [];
          const vals = valsReq.result || [];
          for (let i = 0; i < keys.length; i += 1) {
            out[String(keys[i])] = String(vals[i]);
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
      localStorage.setItem('pragya_google_token', 'cd7-tok');
      localStorage.setItem('pragya_google_user', JSON.stringify({ email, name: 'CD7 Reader' }));
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', sheetId);
      localStorage.removeItem('pragya_google_token_expires_at');
    },
    { sheetId, email }
  );
  await page.reload();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
  await expect(page.getByTestId('book-card-book-cd7')).toBeVisible();
}

test.describe('Tier 10 — CD Batch 7 Sync Architecture (IndexedDB, Migration, Cleanup & Batched Writes)', () => {
  test('CD7.1: Cloud cache & pre-import backup persist in real IndexedDB (zero localStorage bloat) and fast-reload skips Sheets GETs', async ({
    page,
  }) => {
    const mock = await installStatefulCloudMock(page, 'sheet-cd7-idb');
    await seedCloudSession(page, 'sheet-cd7-idb', 'idb@pragya.dev');

    // Cache lives in IndexedDB `pragya-cache/kv` with codecVersion=2, NOT in localStorage.
    await expect
      .poll(async () => {
        const entries = await readAllIdbCacheEntries(page);
        return Boolean(entries.pragya_sheets_cache_v1);
      })
      .toBe(true);
    const idbEntries = await readAllIdbCacheEntries(page);
    const parsedCache = JSON.parse(idbEntries.pragya_sheets_cache_v1);
    expect(parsedCache.codecVersion).toBe(2);
    expect(parsedCache.spreadsheetId).toBe('sheet-cd7-idb');
    expect(parsedCache.state.books[0].title).toBe('CD7 Sync Architecture');
    expect(await page.evaluate(() => localStorage.getItem('pragya_sheets_cache_v1'))).toBeNull();

    // Reload with unchanged modifiedTime -> fast-reload hit from IndexedDB with ZERO Sheets calls!
    mock.calls.length = 0;
    await page.reload();
    await expect(page.getByTestId('book-card-book-cd7')).toBeVisible();
    expect(mock.calls.filter(c => c.url.includes('sheets.googleapis.com'))).toHaveLength(0);

    // Import a snapshot -> pre-import backup is saved in IndexedDB (not localStorage) and restores cleanly
    await page.getByTestId('nav-item-settings').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();
    const minimalSnap = {
      version: 1,
      exportedAt: '2026-11-16T12:00:00Z',
      books: [],
      notes: [],
      sessions: [],
      deltaLogs: [],
    };
    await page.locator('input[type="file"]').setInputFiles({
      name: 'empty-snap.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(minimalSnap)),
    });
    await expect(page.getByTestId('import-confirm-modal')).toBeVisible();
    await page.getByTestId('import-confirm-btn').click();
    await expect(page.getByTestId('import-confirm-modal')).toBeHidden();
    await expect(page.getByTestId('restore-pre-import-backup-btn')).toBeVisible();

    const afterImportIdb = await readAllIdbCacheEntries(page);
    expect(afterImportIdb.pragya_pre_import_backup_v1).toContain('CD7 Sync Architecture');
    expect(await page.evaluate(() => localStorage.getItem('pragya_pre_import_backup_v1'))).toBeNull();

    // R2-3: exercise the full IDB pre-import backup restore flow end-to-end
    await page.getByTestId('restore-pre-import-backup-btn').click();
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(
      page
        .getByTestId('notification-toast')
        .filter({ hasText: /Restored workspace from pre-import backup/i })
    ).toBeVisible();
    await page.getByTestId('nav-item-shelf').click();
    await expect(page.getByTestId('book-card-book-cd7')).toContainText('CD7 Sync Architecture');
  });

  test('CD7.2: Transparent one-time localStorage → IndexedDB migration serves offline cache across reloads and deletes legacy localStorage keys', async ({
    page,
  }) => {
    await page.route('https://www.googleapis.com/**', route => route.abort('internetdisconnected'));
    await page.route('https://sheets.googleapis.com/**', route => route.abort('internetdisconnected'));

    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token', 'cd7-offline-tok');
      localStorage.setItem(
        'pragya_google_user',
        JSON.stringify({ email: 'mig@pragya.dev', name: 'Migrating Reader' })
      );
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-cd7-mig');
      localStorage.setItem(
        'pragya_sheets_cache_v1',
        JSON.stringify({
          spreadsheetId: 'sheet-cd7-mig',
          modifiedTime: '2026-11-16T08:00:00Z',
          accountEmail: 'mig@pragya.dev',
          codecVersion: 2,
          state: {
            books: [
              {
                id: 'book-migrated',
                title: 'Migrated Legacy Monograph',
                author: 'Legacy Author',
                format: 'physical',
                kind: 'nonfiction',
                status: 'reading',
                currentPos: 64,
                totalPos: 256,
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
      localStorage.setItem(
        'pragya_pre_import_backup_v1',
        JSON.stringify({
          savedAt: '2026-11-16T07:00:00Z',
          snapshot: {
            version: 1,
            exportedAt: '2026-11-16T07:00:00Z',
            books: [],
            notes: [],
            sessions: [],
            deltaLogs: [],
          },
        })
      );
    });

    await page.reload();
    await expect(page.getByTestId('offline-readonly-badge')).toBeVisible();
    await expect(page.getByTestId('book-card-book-migrated')).toContainText('Migrated Legacy Monograph');

    // Legacy localStorage cache was moved to IndexedDB and deleted from localStorage
    expect(await page.evaluate(() => localStorage.getItem('pragya_sheets_cache_v1'))).toBeNull();
    const idbAfterFirstReload = await readAllIdbCacheEntries(page);
    expect(idbAfterFirstReload.pragya_sheets_cache_v1).toContain('Migrated Legacy Monograph');

    // Second offline reload proves IndexedDB alone serves the workspace (localStorage is already empty!)
    await page.reload();
    await expect(page.getByTestId('book-card-book-migrated')).toContainText('Migrated Legacy Monograph');

    // Visiting Settings migrates legacy pre-import backup from localStorage -> IndexedDB too
    await page.getByTestId('nav-item-settings').click();
    await expect(page.getByTestId('restore-pre-import-backup-btn')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pragya_pre_import_backup_v1'))).toBeNull();
    const idbAfterSettings = await readAllIdbCacheEntries(page);
    expect(idbAfterSettings.pragya_pre_import_backup_v1).toContain('2026-11-16T07:00:00Z');
  });

  test('CD7.3: Explicit logout & account switch clear IndexedDB cache & backup completely (zero cross-account bleed)', async ({
    page,
  }) => {
    await installStatefulCloudMock(page, 'sheet-cd7-a', 'Account A Private Book');
    await seedCloudSession(page, 'sheet-cd7-a', 'a@pragya.dev');

    // Wait for IDB cache write and also store a pre-import backup in IDB for Account A.
    await expect
      .poll(async () => Boolean((await readAllIdbCacheEntries(page)).pragya_sheets_cache_v1))
      .toBe(true);
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('pragya-cache', 1);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(
            JSON.stringify({
              savedAt: '2026-11-16T09:00:00Z',
              snapshot: { version: 1, exportedAt: 'x', books: [{ id: 'a-secret-book' }], notes: [], sessions: [], deltaLogs: [] },
            }),
            'pragya_pre_import_backup_v1'
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
        req.onerror = () => reject(req.error);
      });
    });

    // 1. Explicit logout must wipe IndexedDB completely
    await page.getByTestId('logout-btn').click();
    await expect(page.getByTestId('login-view')).toBeVisible();
    const afterLogout = await readAllIdbCacheEntries(page);
    expect(Object.keys(afterLogout)).toHaveLength(0);

    // 2. Account switch (A -> B after expired session) wipes Account A's IndexedDB entries before loading B
    await page.addInitScript(() => {
      (window as unknown as { VITE_GOOGLE_CLIENT_ID?: string }).VITE_GOOGLE_CLIENT_ID = 'mock-cid.apps.googleusercontent.com';
      (window as unknown as { __PLAYWRIGHT__?: boolean }).__PLAYWRIGHT__ = true;
    });
    await page.unroute('https://www.googleapis.com/**');
    await page.unroute('https://sheets.googleapis.com/**');
    await page.route('https://www.googleapis.com/**', async route => {
      const u = route.request().url();
      const fulfill = (b: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (u.includes('oauth2/v3/userinfo')) return fulfill({ email: 'b@pragya.dev', name: 'Account B' });
      if (u.includes('drive/v3/files?q='))
        return fulfill({ files: [{ id: 'sheet-cd7-b', name: 'Pragya Commonplace', modifiedTime: '2026-11-16T15:00:00Z' }] });
      if (u.includes('drive/v3/files/'))
        return fulfill({ id: 'sheet-cd7-b', modifiedTime: '2026-11-16T15:00:00Z' });
      return fulfill({ files: [] });
    });
    await page.route('https://sheets.googleapis.com/**', async route => {
      const u = route.request().url();
      const fulfill = (b: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (u.includes('fields=sheets.properties')) {
        return fulfill({
          sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map((title, idx) => ({
            properties: { sheetId: idx + 1, title },
          })),
        });
      }
      if (u.includes('values:batchGet')) {
        return fulfill({
          valueRanges: [
            { range: 'Books!A:L', values: [BOOK_HEADERS] },
            { range: 'Notes!A:R', values: [NOTE_HEADERS] },
            { range: 'Sessions!A:G', values: [SESSION_HEADERS] },
            { range: 'DeltaLogs!A:E', values: [DELTA_HEADERS] },
          ],
        });
      }
      return fulfill({});
    });

    await page.goto('/');
    await page.evaluate(async () => {
      localStorage.setItem('pragya_google_token', 'ya29.expired-a');
      localStorage.setItem('pragya_google_token_expires_at', String(Date.now() - 60_000));
      localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'a@pragya.dev', name: 'A' }));
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-cd7-a');
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('pragya-cache', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(
            JSON.stringify({
              spreadsheetId: 'sheet-cd7-a',
              modifiedTime: '2026-11-16T09:00:00Z',
              accountEmail: 'a@pragya.dev',
              codecVersion: 2,
              state: { books: [{ id: 'a-secret-book', title: 'Secret A' }], notes: [], sessions: [], deltaLogs: [] },
            }),
            'pragya_sheets_cache_v1'
          );
          tx.objectStore('kv').put(
            JSON.stringify({
              savedAt: '2026-11-16T09:00:00Z',
              snapshot: { version: 1, exportedAt: 'x', books: [{ id: 'a-secret-backup' }], notes: [], sessions: [], deltaLogs: [] },
            }),
            'pragya_pre_import_backup_v1'
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
        req.onerror = () => reject(req.error);
      });
    });

    await page.reload();
    await expect(page.getByTestId('session-expired-modal')).toBeVisible();

    await page.evaluate(() => {
      sessionStorage.setItem('pragya_oauth_csrf_state', 'csrf-cd7-switch');
      window.location.hash = '#state=csrf-cd7-switch&access_token=ya29.fresh-b&expires_in=3600';
    });
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await expect
      .poll(async () => (await readAllIdbCacheEntries(page)).pragya_sheets_cache_v1 || '')
      .toContain('sheet-cd7-b');

    const afterSwitchIdb = await readAllIdbCacheEntries(page);
    expect(afterSwitchIdb.pragya_pre_import_backup_v1).toBeUndefined();
    expect(afterSwitchIdb.pragya_sheets_cache_v1).not.toContain('a-secret-book');
    expect(afterSwitchIdb.pragya_sheets_cache_v1).toContain('b@pragya.dev');

    // R2-3: Account B's Settings must not surface Account A's pre-import backup button
    await page.getByTestId('nav-item-settings').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();
    await expect(page.getByTestId('restore-pre-import-backup-btn')).toBeHidden();
  });

  test('CD7.4: Cloud capture+advance & bookmark advance make <= 5 HTTP calls; Book conflict aborts Capture with ZERO writes', async ({
    page,
  }) => {
    const mock = await installStatefulCloudMock(page, 'sheet-cd7-batch');
    await seedCloudSession(page, 'sheet-cd7-batch', 'batch@pragya.dev');

    // 1. Capture a note ahead of bookmark (50 -> 85): updates Book + appends Note + appends Session in <= 5 HTTP calls
    mock.calls.length = 0;
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-pos-input').fill('85');
    await page.getByTestId('capture-takeaway-input').fill('Coalesced multi-tab capture insight');
    await page.getByTestId('capture-submit-btn').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();
    await expect(page.getByTestId('book-card-book-cd7')).toContainText('p. 85 / 200');

    // Wait for Drive modifiedTime refresh to finish (last call of the batch)
    await expect
      .poll(() => mock.calls.filter(c => c.url.includes('drive/v3/files/sheet-cd7-batch')).length)
      .toBe(1);
    expect(mock.calls.length).toBeLessThanOrEqual(5);
    expect(mock.calls.some(c => c.url.includes('values:batchUpdate') && c.body?.valueInputOption === 'RAW')).toBe(true);

    // 2. +10p bookmark advance (85 -> 95, coalescing into today's session): Book + Session in ONE batchUpdate (<= 4 calls)
    mock.calls.length = 0;
    await page.getByTestId('advance-10p-btn-book-cd7').click();
    await expect(page.getByTestId('book-card-book-cd7')).toContainText('p. 95 / 200');
    await expect
      .poll(() => mock.calls.filter(c => c.url.includes('drive/v3/files/sheet-cd7-batch')).length)
      .toBe(1);
    expect(mock.calls.length).toBeLessThanOrEqual(4);
    const batchUpCall = mock.calls.find(c => c.url.includes('values:batchUpdate'));
    expect(batchUpCall).toBeTruthy();
    const updatedRanges = ((batchUpCall?.body?.data as Array<{ range: string }>) || []).map(d => d.range);
    expect(updatedRanges).toEqual(['Books!A2:L2', 'Sessions!A2:G2']);

    // 3. Remote conflict on Book -> Capture+Advance aborts BEFORE any write (0 POST/PUT calls!)
    mock.setBookUpdatedAt('2099-01-01T00:00:00.000Z');
    mock.calls.length = 0;
    const notesBeforeConflict = mock.sheetData.Notes.length;

    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-pos-input').fill('120');
    await page.getByTestId('capture-takeaway-input').fill('Conflicting capture should write zero rows');
    await page.getByTestId('capture-submit-btn').click();

    await expect(
      page.locator('[data-testid="notification-toast"][data-toast-variant="error"]').last()
    ).toContainText(/Updated on another device/i);
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    expect(mock.calls.filter(c => c.method === 'POST' || c.method === 'PUT')).toHaveLength(0);
    expect(mock.sheetData.Notes.length).toBe(notesBeforeConflict);
    await page.keyboard.press('Escape');
  });

  test('CD7.5: Partial multi-tab commit reconciles committed rows without duplicating Note (R1#2), and Demo→Cloud OAuth preserves same-account IDB cache (R1#3)', async ({
    page,
  }) => {
    let failSessionsAppend = true;
    let failNotesAppend = false;

    const mock = await installStatefulCloudMock(page, 'sheet-cd7-partial', 'Partial Commit Book', {
      onSheetsRequest: async (route, url, method) => {
        const decoded = decodeURIComponent(url);
        if (method === 'POST' && failSessionsAppend && decoded.includes('Sessions!A1:append')) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'Sessions append failure' } }),
          });
          return true;
        }
        if (method === 'POST' && failNotesAppend && decoded.includes('Notes!A1:append')) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'Notes append failure' } }),
          });
          return true;
        }
        return false;
      },
    });
    await seedCloudSession(page, 'sheet-cd7-partial', 'partial@pragya.dev');

    // Part A (R1#2): Book + Note succeed, Sessions:append fails 500 -> modal closes cleanly with calm warning
    // toast, both Book and Note are reconciled into UI, and Notes tab has exactly 1 appended row (no duplicate).
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-pos-input').fill('85');
    await page.getByTestId('capture-takeaway-input').fill('Saved despite session append failure');
    await page.getByTestId('capture-submit-btn').click();

    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();
    await expect(
      page
        .getByTestId('notification-toast')
        .filter({ hasText: /Note saved, but your reading session could not be logged/i })
    ).toBeVisible();
    await expect(page.getByTestId('book-card-book-cd7')).toContainText('p. 85 / 200');
    expect(mock.sheetData.Notes.length).toBe(2); // header + 1 Note (zero duplicate)

    // Verify Note is visible in Notes view immediately without reload
    await page.getByTestId('nav-item-notes').click();
    await expect(page.getByTestId('notes-view')).toContainText('Saved despite session append failure');
    await page.getByTestId('nav-item-shelf').click();

    // Part B (R1#2): Book succeeds (85 -> 110), Notes:append fails 500 -> Book is reconciled into state,
    // modal stays open with error toast; retry after clearing fault succeeds with NO phantom RowConflictError.
    failSessionsAppend = false;
    failNotesAppend = true;
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-pos-input').fill('110');
    await page.getByTestId('capture-takeaway-input').fill('Retry note after book committed');
    await page.getByTestId('capture-submit-btn').click();

    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await expect(
      page.locator('[data-testid="notification-toast"][data-toast-variant="error"]').last()
    ).toBeVisible();
    // Book position was already reconciled to 110 in React state despite Notes:append failing
    await expect(page.getByTestId('book-card-book-cd7')).toContainText('p. 110 / 200');

    failNotesAppend = false;
    await page.getByTestId('capture-submit-btn').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();
    expect(mock.sheetData.Notes.length).toBe(3); // header + 2 Notes total

    // Part C (R1#3): Demo Mode -> OAuth same-account sign-in with delayed userinfo must NOT prematurely
    // construct GoogleSheetsAdapter with demo@pragya.local or wipe Account A's IndexedDB cache!
    await page.unroute('https://www.googleapis.com/**');
    await page.unroute('https://sheets.googleapis.com/**');
    const sheetsCallsOnReauth: string[] = [];
    await page.route('https://www.googleapis.com/**', async route => {
      const u = route.request().url();
      if (u.includes('oauth2/v3/userinfo')) {
        // Delay userinfo so any premature setIsMockMode(false) would have time to fire loadWorkspace()!
        await new Promise(r => setTimeout(r, 120));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ email: 'same@pragya.dev', name: 'Same Reader' }),
        });
        return;
      }
      if (u.includes('drive/v3/files/sheet-same-r13')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'sheet-same-r13', name: 'Pragya Commonplace', modifiedTime: '2026-11-16T20:00:00Z' }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
    });
    await page.route('https://sheets.googleapis.com/**', async route => {
      sheetsCallsOnReauth.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });

    await page.goto('/');
    await page.evaluate(async () => {
      // Seed Account A's IDB cache + spreadsheetId + last account marker, while currently in Demo mode.
      localStorage.removeItem('pragya_google_token');
      localStorage.removeItem('pragya_google_user');
      localStorage.setItem('pragya_last_account_email', 'same@pragya.dev');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-same-r13');
      localStorage.setItem('pragya_mock_mode', 'true');
      localStorage.setItem('pragya_mock_session', JSON.stringify({ email: 'demo@pragya.local', name: 'Demo Reader' }));
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('pragya-cache', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(
            JSON.stringify({
              spreadsheetId: 'sheet-same-r13',
              modifiedTime: '2026-11-16T20:00:00Z',
              accountEmail: 'same@pragya.dev',
              codecVersion: 2,
              state: {
                books: [
                  {
                    id: 'book-same-cached',
                    title: 'Preserved Same-Account Cache Book',
                    author: 'Cache Author',
                    format: 'physical',
                    kind: 'nonfiction',
                    status: 'reading',
                    currentPos: 42,
                    totalPos: 100,
                    posUnit: 'page',
                    normalizedPos: 0.42,
                    docUrl: '',
                    meta: { updatedAt: '2026-11-16T20:00:00Z' },
                  },
                ],
                notes: [],
                sessions: [],
                deltaLogs: [],
              },
            }),
            'pragya_sheets_cache_v1'
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
        req.onerror = () => reject(req.error);
      });
    });
    await page.reload();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    // Complete OAuth callback while in Demo mode -> must preserve Account A's IDB cache & fast-reload hit (0 Sheets calls!)
    await page.evaluate(() => {
      sessionStorage.setItem('pragya_oauth_csrf_state', 'csrf-r13-same');
      window.location.hash = '#state=csrf-r13-same&access_token=ya29.same-tok&expires_in=3600';
    });
    await expect(page.getByTestId('book-card-book-same-cached')).toContainText(
      'Preserved Same-Account Cache Book'
    );
    expect(sheetsCallsOnReauth).toHaveLength(0);
    const idbSame = await readAllIdbCacheEntries(page);
    expect(idbSame.pragya_sheets_cache_v1).toContain('Preserved Same-Account Cache Book');
  });
});
