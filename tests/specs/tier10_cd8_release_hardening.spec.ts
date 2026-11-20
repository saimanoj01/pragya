import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 10 — CD Batch 8 (Release Hardening — B4.12 GIS Silent Token Refresh):
 *  - Expired Cloud token on boot & 401 mid-session silently refresh via GIS (`prompt: ''`)
 *    without popping SessionExpiredModal or interrupting mutations
 *  - GIS failure / timeout / account-email mismatch fall back cleanly to SessionExpiredModal
 *  - Offline Cloud mode & Demo mode skip GIS completely (zero external accounts.google.com requests)
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

interface GisStubScriptConfig {
  responses: Array<
    | { access_token: string; expires_in?: number }
    | { error: string }
    | { hang: true }
  >;
}

async function installGisRuntimeStub(page: Page, config: GisStubScriptConfig) {
  await page.addInitScript(cfg => {
    const win = window as unknown as {
      VITE_GOOGLE_CLIENT_ID?: string;
      __PLAYWRIGHT__?: boolean;
      __GIS_CALLS__?: Array<{ client_id: string; prompt?: string; hint?: string }>;
      google?: unknown;
    };
    win.VITE_GOOGLE_CLIENT_ID = 'cd8-gis-client.apps.googleusercontent.com';
    win.__PLAYWRIGHT__ = true;
    win.__GIS_CALLS__ = [];
    let idx = 0;

    win.google = {
      accounts: {
        oauth2: {
          initTokenClient(opts: {
            client_id: string;
            hint?: string;
            callback: (r: { access_token?: string; expires_in?: number; error?: string }) => void;
          }) {
            return {
              requestAccessToken(override?: { prompt?: string; hint?: string }) {
                win.__GIS_CALLS__!.push({
                  client_id: opts.client_id,
                  prompt: override?.prompt,
                  hint: override?.hint ?? opts.hint,
                });
                const next = cfg.responses[Math.min(idx, cfg.responses.length - 1)];
                idx += 1;
                if ('hang' in next) return;
                setTimeout(() => opts.callback(next), 15);
              },
            };
          },
        },
      },
    };
  }, config);
}

async function installCloudRoutes(
  page: Page,
  opts: {
    sheetId: string;
    validTokens: Set<string>;
    userEmail: string;
    userinfoEmail?: string;
  }
) {
  const bookRow: unknown[] = [
    'book-cd8',
    'CD8 GIS Book',
    'Auth Author',
    'physical',
    'nonfiction',
    'reading',
    50,
    200,
    'page',
    0.25,
    '',
    JSON.stringify({ updatedAt: '2026-11-18T10:00:00.000Z' }),
  ];
  const sessionsRows: unknown[][] = [SESSION_HEADERS];
  let modifiedTime = '2026-11-18T10:00:00Z';

  await page.route('https://accounts.google.com/**', async route => {
    await route.abort('failed');
  });

  await page.route('https://www.googleapis.com/**', async route => {
    const u = route.request().url();
    const auth = route.request().headers()['authorization'] || '';
    const tok = auth.replace(/^Bearer\s+/i, '');

    if (u.includes('oauth2/v3/userinfo')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          email: opts.userinfoEmail ?? opts.userEmail,
          name: 'CD8 Reader',
        }),
      });
      return;
    }

    if (!opts.validTokens.has(tok)) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }),
      });
      return;
    }

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
    const auth = route.request().headers()['authorization'] || '';
    const tok = auth.replace(/^Bearer\s+/i, '');

    if (!opts.validTokens.has(tok)) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }),
      });
      return;
    }

    const fulfill = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

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
        if (r.startsWith('Books!A2:L2')) return { range: 'Books!A2:L2', values: [bookRow] };
        if (r.startsWith('Books!')) return { range: 'Books!A1:L2', values: [BOOK_HEADERS, bookRow] };
        if (r.startsWith('Notes!')) return { range: 'Notes!A1:R1', values: [NOTE_HEADERS] };
        if (r.startsWith('Sessions!')) return { range: `Sessions!A1:G${sessionsRows.length}`, values: sessionsRows };
        return { range: 'DeltaLogs!A1:E1', values: [DELTA_HEADERS] };
      });
      await fulfill({ valueRanges });
      return;
    }
    if (u.includes('values:batchUpdate') && method === 'POST') {
      modifiedTime = new Date(Date.parse(modifiedTime) + 1000).toISOString();
      const body = JSON.parse(route.request().postData() || '{}') as {
        data?: Array<{ range: string; values: unknown[][] }>;
      };
      for (const item of body.data || []) {
        if (item.range.startsWith('Books!A2:') && item.values?.[0]) {
          bookRow.splice(0, bookRow.length, ...item.values[0]);
        }
      }
      await fulfill({ totalUpdatedRows: 1 });
      return;
    }
    if (u.includes(':append') && method === 'POST') {
      modifiedTime = new Date(Date.parse(modifiedTime) + 1000).toISOString();
      const body = JSON.parse(route.request().postData() || '{}') as { values?: unknown[][] };
      for (const row of body.values || []) sessionsRows.push(row);
      await fulfill({ updates: { updatedRange: `Sessions!A${sessionsRows.length}:G${sessionsRows.length}` } });
      return;
    }
    await fulfill({});
  });
}

test.describe('Tier 10 — CD Batch 8 Release Hardening (GIS Silent Token Refresh)', () => {
  test('CD8.1: GIS silent refresh recovers an expired token on boot AND recovers a mid-session 401 seamlessly', async ({
    page,
  }) => {
    const validTokens = new Set(['ya29.silent-boot', 'ya29.silent-401']);
    await installGisRuntimeStub(page, {
      responses: [
        { access_token: 'ya29.silent-boot', expires_in: 3600 },
        { access_token: 'ya29.silent-401', expires_in: 3600 },
      ],
    });
    await installCloudRoutes(page, {
      sheetId: 'sheet-cd8-ok',
      validTokens,
      userEmail: 'gis@pragya.dev',
    });

    // 1. Seed a Cloud session whose token expired 60s ago -> boot silently refreshes via GIS!
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token', 'ya29.stale-boot');
      localStorage.setItem('pragya_google_token_expires_at', String(Date.now() - 60_000));
      localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'gis@pragya.dev', name: 'CD8 Reader' }));
      localStorage.setItem('pragya_last_account_email', 'gis@pragya.dev');
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-cd8-ok');
    });

    await page.reload();
    await expect(page.getByTestId('book-card-book-cd8')).toContainText('CD8 GIS Book');
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_token'))).toBe('ya29.silent-boot');

    // 2. Revoke boot token server-side -> clicking +10p hits 401, refreshes silently, and advances 50 -> 60!
    validTokens.delete('ya29.silent-boot');
    await page.getByTestId('advance-10p-btn-book-cd8').click();
    await expect(page.getByTestId('book-card-book-cd8')).toContainText('p. 60 / 200');
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_token'))).toBe('ya29.silent-401');

    const gisCalls = await page.evaluate(
      () => (window as unknown as { __GIS_CALLS__?: Array<{ prompt?: string; hint?: string }> }).__GIS_CALLS__ || []
    );
    expect(gisCalls.length).toBeGreaterThanOrEqual(2);
    expect(gisCalls.every(c => c.prompt === '' && c.hint === 'gis@pragya.dev')).toBe(true);
  });

  test('CD8.2: GIS error and cross-account mismatch fall back cleanly to SessionExpiredModal', async ({
    page,
  }) => {
    // Sub-case A: GIS returns interaction_required -> 401 falls back to SessionExpiredModal
    const validTokens = new Set(['ya29.initial']);
    await installGisRuntimeStub(page, {
      responses: [{ error: 'interaction_required' }],
    });
    await installCloudRoutes(page, {
      sheetId: 'sheet-cd8-fail',
      validTokens,
      userEmail: 'gis@pragya.dev',
    });

    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token', 'ya29.initial');
      localStorage.removeItem('pragya_google_token_expires_at');
      localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'gis@pragya.dev', name: 'CD8 Reader' }));
      localStorage.setItem('pragya_last_account_email', 'gis@pragya.dev');
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-cd8-fail');
    });
    await page.reload();
    await expect(page.getByTestId('book-card-book-cd8')).toBeVisible();

    validTokens.delete('ya29.initial');
    await page.keyboard.press('r');
    await expect(page.getByTestId('session-expired-modal')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_token'))).toBeNull();

    // Sub-case B: GIS returns a token belonging to a DIFFERENT account -> rejected, opens SessionExpiredModal
    await page.unroute('https://www.googleapis.com/**');
    await page.unroute('https://sheets.googleapis.com/**');
    const validTokensB = new Set(['ya29.mismatch-tok']);
    await installGisRuntimeStub(page, {
      responses: [{ access_token: 'ya29.mismatch-tok', expires_in: 3600 }],
    });
    await installCloudRoutes(page, {
      sheetId: 'sheet-cd8-mismatch',
      validTokens: validTokensB,
      userEmail: 'account-a@pragya.dev',
      userinfoEmail: 'account-b@pragya.dev', // mismatch!
    });

    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token', 'ya29.expired-a');
      localStorage.setItem('pragya_google_token_expires_at', String(Date.now() - 60_000));
      localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'account-a@pragya.dev', name: 'Account A' }));
      localStorage.setItem('pragya_last_account_email', 'account-a@pragya.dev');
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-cd8-mismatch');
    });
    await page.reload();
    await expect(page.getByTestId('session-expired-modal')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_token'))).toBeNull();
  });

  test('CD8.3: Demo Mode and offline Cloud Mode skip GIS completely with zero accounts.google.com requests', async ({
    page,
  }) => {
    const gsiRequests: string[] = [];
    await page.route('https://accounts.google.com/**', async route => {
      gsiRequests.push(route.request().url());
      await route.abort('failed');
    });

    // 1. Demo Mode makes zero GIS script requests
    await page.goto('/');
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    expect(gsiRequests).toHaveLength(0);

    // 2. Cloud offline mode skips GIS even when runtime is present & token is inside the 5-min refresh window
    await page.route('https://www.googleapis.com/**', route => route.abort('internetdisconnected'));
    await page.route('https://sheets.googleapis.com/**', route => route.abort('internetdisconnected'));
    await installGisRuntimeStub(page, {
      responses: [{ access_token: 'ya29.should-not-fire', expires_in: 3600 }],
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    });

    await page.goto('/');
    await page.evaluate(async () => {
      localStorage.setItem('pragya_google_token', 'ya29.cached-tok');
      localStorage.setItem('pragya_google_token_expires_at', String(Date.now() + 60_000)); // within 5-min window!
      localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'off@pragya.dev', name: 'Offline' }));
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-cd8-off');
      localStorage.setItem(
        'pragya_sheets_cache_v1',
        JSON.stringify({
          spreadsheetId: 'sheet-cd8-off',
          modifiedTime: '2026-11-18T10:00:00Z',
          accountEmail: 'off@pragya.dev',
          codecVersion: 2,
          state: {
            books: [
              {
                id: 'book-off',
                title: 'Offline GIS Skip Book',
                author: 'A',
                format: 'physical',
                kind: 'nonfiction',
                status: 'reading',
                currentPos: 20,
                totalPos: 100,
                posUnit: 'page',
                normalizedPos: 0.2,
                docUrl: '',
                meta: { updatedAt: '2026-11-18T10:00:00Z' },
              },
            ],
            notes: [],
            sessions: [],
            deltaLogs: [],
          },
        })
      );
    });

    await page.reload();
    await expect(page.getByTestId('book-card-book-off')).toBeVisible();
    await expect(page.getByTestId('offline-readonly-badge')).toBeVisible();
    // Wait briefly to ensure no proactive timer fired GIS while offline
    await page.waitForTimeout(150);
    const callsOffline = await page.evaluate(
      () => (window as unknown as { __GIS_CALLS__?: unknown[] }).__GIS_CALLS__ || []
    );
    expect(callsOffline).toHaveLength(0);
    expect(gsiRequests).toHaveLength(0);
  });

  test('CD8.4: Expired-token Cloud boot shows recovery spinner (never flashes LoginView, R2-2) and slow DriveImage after logout never resurrects media cache (R1#2)', async ({
    page,
  }) => {
    // Part A (R2-2): Hold silent boot GIS response until we verify spinner is shown and LoginView is NOT flashed!
    const validTokens = new Set(['ya29.boot-recovered', 'ya29.drive-init']);
    await page.addInitScript(() => {
      const win = window as unknown as {
        VITE_GOOGLE_CLIENT_ID?: string;
        __PLAYWRIGHT__?: boolean;
        __BOOT_GIS_PENDING__?: boolean;
        __RESOLVE_BOOT_GIS__?: () => void;
        google?: unknown;
      };
      win.VITE_GOOGLE_CLIENT_ID = 'cd8-r22-client.apps.googleusercontent.com';
      win.__PLAYWRIGHT__ = true;
      win.__BOOT_GIS_PENDING__ = false;
      let bootCb: ((r: { access_token: string; expires_in: number }) => void) | null = null;
      win.__RESOLVE_BOOT_GIS__ = () => {
        bootCb?.({ access_token: 'ya29.boot-recovered', expires_in: 3600 });
        bootCb = null;
      };
      win.google = {
        accounts: {
          oauth2: {
            initTokenClient(opts: { callback: (r: { access_token: string; expires_in: number }) => void }) {
              return {
                requestAccessToken() {
                  bootCb = opts.callback;
                  win.__BOOT_GIS_PENDING__ = true;
                },
              };
            },
          },
        },
      };
    });

    await installCloudRoutes(page, {
      sheetId: 'sheet-cd8-r22',
      validTokens,
      userEmail: 'r22@pragya.dev',
    });

    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token', 'ya29.expired-boot');
      localStorage.setItem('pragya_google_token_expires_at', String(Date.now() - 60_000));
      localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'r22@pragya.dev', name: 'R22' }));
      localStorage.setItem('pragya_last_account_email', 'r22@pragya.dev');
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-cd8-r22');
    });

    await page.reload();
    // Spinner MUST be visible and LoginView MUST NOT flash while boot silent refresh is pending
    await expect(page.getByTestId('auth-recovering-spinner')).toBeVisible();
    await expect(page.getByTestId('login-view')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => Boolean((window as unknown as { __BOOT_GIS_PENDING__?: boolean }).__BOOT_GIS_PENDING__))
      )
      .toBe(true);
    await expect(page.getByTestId('login-view')).toHaveCount(0);

    // Release silent boot refresh -> lands straight on Shelf with zero LoginView or SessionExpiredModal
    await page.evaluate(() => {
      (window as unknown as { __RESOLVE_BOOT_GIS__?: () => void }).__RESOLVE_BOOT_GIS__?.();
    });
    await expect(page.getByTestId('book-card-book-cd8')).toBeVisible();
    await expect(page.getByTestId('auth-recovering-spinner')).toHaveCount(0);
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();

    // Part B (R1#2): Slow DriveImage fetch settling AFTER Logout must NOT recreate pragya-media-v1 cache
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64'
    );
    const mediaGate: { release: (() => void) | null } = { release: null };
    const driveMediaRequested = new Promise<void>(resolve => {
      void page.route('https://www.googleapis.com/drive/v3/files/drv-slow-r12**', async route => {
        resolve();
        await new Promise<void>(done => {
          mediaGate.release = done;
        });
        await route.fulfill({ status: 200, contentType: 'image/png', body: tinyPng });
      });
    });

    // Override Notes! values:batchGet to include a note with drv-slow-r12 attachment
    await page.route('https://sheets.googleapis.com/**', async route => {
      const u = route.request().url();
      if (u.includes('values:batchGet')) {
        const ranges = new URL(u).searchParams.getAll('ranges');
        const valueRanges = ranges.map(r => {
          if (r.startsWith('Books!')) {
            return {
              range: 'Books!A1:L2',
              values: [
                BOOK_HEADERS,
                ['book-cd8', 'CD8 GIS Book', 'A', 'physical', 'nonfiction', 'reading', 50, 200, 'page', 0.25, '', JSON.stringify({ updatedAt: '2026-11-19T10:00:00Z' })],
              ],
            };
          }
          if (r.startsWith('Notes!')) {
            return {
              range: 'Notes!A1:R2',
              values: [
                NOTE_HEADERS,
                [
                  'note-r12',
                  'r12-img',
                  'book-cd8',
                  '2026-11-19T10:00:00Z',
                  '2026-11-19T10:00:00Z',
                  10,
                  0.05,
                  'saved',
                  'app',
                  '',
                  'q',
                  't',
                  '',
                  '',
                  '',
                  '',
                  'none',
                  JSON.stringify({
                    title: 'R12 Media Note',
                    attachments: [
                      { id: 'att-r12', type: 'image', driveFileId: 'drv-slow-r12', fileName: 'secret.png', mimeType: 'image/png' },
                    ],
                    links: [],
                  }),
                ],
              ],
            };
          }
          if (r.startsWith('Sessions!')) return { range: 'Sessions!A1:G1', values: [SESSION_HEADERS] };
          return { range: 'DeltaLogs!A1:E1', values: [DELTA_HEADERS] };
        });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valueRanges }) });
        return;
      }
      await route.fallback();
    });

    await page.keyboard.press('r');
    await expect(page.getByTestId('notification-toast').filter({ hasText: /Workspace synced/i })).toBeVisible();
    await page.evaluate(() => {
      window.location.hash = '#/note/r12-img';
    });
    await driveMediaRequested;

    // Logout while the Drive image response is still in flight
    await page.getByTestId('logout-btn').click();
    await expect(page.getByTestId('login-view')).toBeVisible();

    // Now release the slow Drive media response
    mediaGate.release?.();
    await page.waitForTimeout(250);

    // pragya-media-v1 cache MUST NOT have been resurrected with Account A's private image!
    const hasMediaCache = await page.evaluate(async () => {
      if (typeof caches === 'undefined') return false;
      const names = await caches.keys();
      if (!names.includes('pragya-media-v1')) return false;
      const cache = await caches.open('pragya-media-v1');
      const keys = await cache.keys();
      return keys.length > 0;
    });
    expect(hasMediaCache).toBe(false);
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();
  });
});
