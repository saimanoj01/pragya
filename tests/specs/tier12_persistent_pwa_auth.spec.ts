import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 12 — Persistent Mobile PWA Authentication:
 *  - PKCE Authorization Code login via stateless Auth Proxy + Android Custom Tab CSRF resilience
 *  - Cold boot silent refresh after 1h+ access token expiry (zero LoginView / SessionExpiredModal / GIS)
 *  - Mid-session 401 auto-refresh + refresh-token rotation + visibilitychange resume renewal
 *  - Offline cold boot & flaky network fallback preserve cached library + sealed refresh token
 *  - Revoked refresh token -> SessionExpiredModal; Logout -> /revoke + cleanup
 *  - Browser-only mode: 1-tap synchronous GIS reconnect from SessionExpiredModal
 */

const PROXY_URL = 'https://pragya-oauth-proxy.test.workers.dev';
const CLIENT_ID = 'tier12-pwa-client.apps.googleusercontent.com';

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

async function installCloudSheetRoutes(
  page: Page,
  opts: {
    sheetId: string;
    validTokens: Set<string>;
    userEmail: string;
  }
) {
  const bookRow: unknown[] = [
    'book-t12',
    'PWA Persistent Reading Book',
    'Cal Newport',
    'physical',
    'nonfiction',
    'reading',
    50,
    200,
    'page',
    0.25,
    '',
    JSON.stringify({ updatedAt: '2026-11-24T10:00:00.000Z' }),
  ];
  const sessionsRows: unknown[][] = [SESSION_HEADERS];
  let modifiedTime = '2026-11-24T10:00:00Z';

  await page.route('https://www.googleapis.com/**', async route => {
    const u = route.request().url();
    const auth = route.request().headers()['authorization'] || '';
    const tok = auth.replace(/^Bearer\s+/i, '');

    if (u.includes('oauth2/v3/userinfo')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: opts.userEmail, name: 'Android Reader' }),
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

    if (u.includes('drive/v3/files?q=')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          files: [{ id: opts.sheetId, name: 'Pragya Commonplace', modifiedTime }],
        }),
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
      const ranges = new URL(u).searchParams.getAll('ranges');
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

test.describe('Tier 12 — Persistent PWA Auth (PKCE Proxy, Offline Boot, 1-Tap Reconnect)', () => {
  test('T12.1: PKCE login via Auth Proxy survives Android Custom Tab sessionStorage loss, restores route, and shows Auto-Refresh Active badge on 390px mobile', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      (window as unknown as { __PLAYWRIGHT__?: boolean }).__PLAYWRIGHT__ = true;
    });

    const validTokens = new Set(['ya29.pkce-initial']);
    await installCloudSheetRoutes(page, {
      sheetId: 'sheet-t12-pkce',
      validTokens,
      userEmail: 'mobile@pragya.dev',
    });

    const exchangeCapture: { body: Record<string, unknown> | null } = { body: null };
    await page.route(`${PROXY_URL}/**`, async route => {
      const url = route.request().url();
      const body = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>;
      if (url.endsWith('/exchange')) {
        exchangeCapture.body = body;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            access_token: 'ya29.pkce-initial',
            expires_in: 3600,
            token_type: 'Bearer',
            sealed_refresh_token: 'v1.sealed-iv.sealed-cipher',
          }),
        });
        return;
      }
      await route.fulfill({ status: 404, body: '{}' });
    });

    await page.goto('/');
    await expect(page.getByTestId('login-view')).toBeVisible();

    // Configure Client ID + Auth Proxy URL via UI and verify zero horizontal overflow on 390px
    await page.getByTestId('client-id-input').fill(CLIENT_ID);
    await page.getByTestId('client-id-save-btn').click();
    await page.getByTestId('auth-proxy-url-input').fill(`${PROXY_URL}/`);
    await page.getByTestId('auth-proxy-url-save-btn').click();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

    // Start login from #/notes -> should generate PKCE auth URL
    await page.evaluate(() => {
      window.location.hash = '#/notes';
    });
    await page.getByTestId('google-login-btn').click();

    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __LAST_OAUTH_URL__?: string }).__LAST_OAUTH_URL__ || ''
        )
      )
      .toContain('accounts.google.com/o/oauth2/v2/auth');
    const authUrlStr = await page.evaluate(
      () => (window as unknown as { __LAST_OAUTH_URL__?: string }).__LAST_OAUTH_URL__ || ''
    );
    const authUrl = new URL(authUrlStr);
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    const state = authUrl.searchParams.get('state')!;
    expect(state).toBeTruthy();

    // Simulate Android Chrome Custom Tab wiping sessionStorage before returning with ?code=...
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`/?code=google-pkce-code-42&state=${encodeURIComponent(state)}`);

    // Lands back on #/notes with query params cleaned and sealed refresh token persisted!
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.location.search)).toBe('');
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/notes');
    expect(exchangeCapture.body?.code).toBe('google-pkce-code-42');
    expect(exchangeCapture.body?.clientId).toBe(CLIENT_ID);
    expect(typeof exchangeCapture.body?.codeVerifier).toBe('string');

    const sealedStored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('pragya_google_sealed_refresh_v1') || 'null')
    );
    expect(sealedStored?.token).toBe('v1.sealed-iv.sealed-cipher');
    expect(sealedStored?.email).toBe('mobile@pragya.dev');

    // Open Settings on 390px mobile -> Auto-Refresh Active badge visible & zero overflow
    await page.getByTestId('bottom-nav-more').click();
    await page.getByTestId('drawer-nav-settings').click();
    await expect(page.getByTestId('settings-persistent-auth-badge')).toContainText('Auto-Refresh Active');
    const settingsOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(settingsOverflow.scrollWidth).toBeLessThanOrEqual(settingsOverflow.innerWidth);
  });

  test('T12.2: Cold boot after expiry, mid-session 401 with refresh rotation, and visibilitychange resume all renew silently via Auth Proxy', async ({
    page,
  }) => {
    const gsiRequests: string[] = [];
    await page.route('https://accounts.google.com/**', async route => {
      gsiRequests.push(route.request().url());
      await route.abort('failed');
    });

    await page.addInitScript(
      ({ cid, proxy }) => {
        const win = window as unknown as {
          VITE_GOOGLE_CLIENT_ID?: string;
          VITE_GOOGLE_AUTH_PROXY_URL?: string;
          __PLAYWRIGHT__?: boolean;
        };
        win.VITE_GOOGLE_CLIENT_ID = cid;
        win.VITE_GOOGLE_AUTH_PROXY_URL = proxy;
        win.__PLAYWRIGHT__ = true;
      },
      { cid: CLIENT_ID, proxy: PROXY_URL }
    );

    const validTokens = new Set(['ya29.boot-proxy', 'ya29.rotated-401', 'ya29.resumed-vis']);
    await installCloudSheetRoutes(page, {
      sheetId: 'sheet-t12-auto',
      validTokens,
      userEmail: 'auto@pragya.dev',
    });

    let refreshStep = 0;
    const seenSealedTokens: string[] = [];
    await page.route(`${PROXY_URL}/refresh`, async route => {
      const body = JSON.parse(route.request().postData() || '{}') as { sealedRefreshToken?: string };
      seenSealedTokens.push(body.sealedRefreshToken || '');
      refreshStep += 1;
      if (refreshStep === 1) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ access_token: 'ya29.boot-proxy', expires_in: 3600 }),
        });
        return;
      }
      if (refreshStep === 2) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            access_token: 'ya29.rotated-401',
            expires_in: 3600,
            sealed_refresh_token: 'v1.rotated.tok2',
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: 'ya29.resumed-vis', expires_in: 3600 }),
      });
    });

    // 1. Seed a session whose access token expired 5 hours ago + valid sealed refresh token
    await page.goto('/');
    await page.evaluate(
      ({ cid, proxy }) => {
        localStorage.setItem('pragya_google_token', 'ya29.expired-5h-ago');
        localStorage.setItem('pragya_google_token_expires_at', String(Date.now() - 5 * 3600_000));
        localStorage.setItem(
          'pragya_google_user',
          JSON.stringify({ email: 'auto@pragya.dev', name: 'Android Reader' })
        );
        localStorage.setItem('pragya_last_account_email', 'auto@pragya.dev');
        localStorage.setItem('pragya_mock_mode', 'false');
        localStorage.setItem('pragya_spreadsheet_id', 'sheet-t12-auto');
        localStorage.setItem(
          'pragya_google_sealed_refresh_v1',
          JSON.stringify({
            token: 'v1.boot.tok1',
            email: 'auto@pragya.dev',
            clientId: cid,
            proxyUrl: proxy,
            savedAt: Date.now() - 5 * 3600_000,
          })
        );
      },
      { cid: CLIENT_ID, proxy: PROXY_URL }
    );

    await page.reload();
    await expect(page.getByTestId('book-card-book-t12')).toContainText('PWA Persistent Reading Book');
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_token'))).toBe('ya29.boot-proxy');

    // 2. Revoke boot access token server-side -> +10p hits 401 -> /refresh rotates sealed token -> succeeds!
    validTokens.delete('ya29.boot-proxy');
    await page.getByTestId('advance-10p-btn-book-t12').click();
    await expect(page.getByTestId('book-card-book-t12')).toContainText('p. 60 / 200');
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_token'))).toBe('ya29.rotated-401');
    const rotated = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('pragya_google_sealed_refresh_v1') || 'null')
    );
    expect(rotated?.token).toBe('v1.rotated.tok2');

    // 3. Simulate PWA waking up after 56 minutes (within 5-min window) -> visibilitychange uses rotated token!
    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token_expires_at', String(Date.now() + 60_000));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('pragya_google_token')))
      .toBe('ya29.resumed-vis');
    expect(seenSealedTokens).toEqual(['v1.boot.tok1', 'v1.boot.tok1', 'v1.rotated.tok2']);
    expect(gsiRequests).toHaveLength(0);
  });

  test('T12.3: Offline cold boot after 1-hour expiry AND flaky proxy network keep cached library readable and preserve sealed refresh token', async ({
    page,
  }) => {
    await page.addInitScript(
      ({ cid, proxy }) => {
        const win = window as unknown as {
          VITE_GOOGLE_CLIENT_ID?: string;
          VITE_GOOGLE_AUTH_PROXY_URL?: string;
          __PLAYWRIGHT__?: boolean;
        };
        win.VITE_GOOGLE_CLIENT_ID = cid;
        win.VITE_GOOGLE_AUTH_PROXY_URL = proxy;
        win.__PLAYWRIGHT__ = true;
      },
      { cid: CLIENT_ID, proxy: PROXY_URL }
    );

    const validTokens = new Set(['ya29.recovered-online']);
    let proxyOffline = true;
    await page.route(`${PROXY_URL}/refresh`, async route => {
      if (proxyOffline) {
        await route.abort('internetdisconnected');
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: 'ya29.recovered-online', expires_in: 3600 }),
      });
    });

    await installCloudSheetRoutes(page, {
      sheetId: 'sheet-t12-offline',
      validTokens,
      userEmail: 'flight@pragya.dev',
    });

    await page.goto('/');
    await page.evaluate(
      ({ cid, proxy }) => {
        localStorage.setItem('pragya_google_token', 'ya29.expired-on-flight');
        localStorage.setItem('pragya_google_token_expires_at', String(Date.now() - 3 * 3600_000));
        localStorage.setItem(
          'pragya_google_user',
          JSON.stringify({ email: 'flight@pragya.dev', name: 'Flight Reader' })
        );
        localStorage.setItem('pragya_last_account_email', 'flight@pragya.dev');
        localStorage.setItem('pragya_mock_mode', 'false');
        localStorage.setItem('pragya_spreadsheet_id', 'sheet-t12-offline');
        localStorage.setItem(
          'pragya_google_sealed_refresh_v1',
          JSON.stringify({
            token: 'v1.flight.sealed',
            email: 'flight@pragya.dev',
            clientId: cid,
            proxyUrl: proxy,
            savedAt: Date.now() - 3 * 3600_000,
          })
        );
        localStorage.setItem(
          'pragya_sheets_cache_v1',
          JSON.stringify({
            spreadsheetId: 'sheet-t12-offline',
            modifiedTime: '2026-11-24T10:00:00Z',
            accountEmail: 'flight@pragya.dev',
            codecVersion: 2,
            state: {
              books: [
                {
                  id: 'book-t12',
                  title: 'PWA Persistent Reading Book',
                  author: 'Cal Newport',
                  format: 'physical',
                  kind: 'nonfiction',
                  status: 'reading',
                  currentPos: 50,
                  totalPos: 200,
                  posUnit: 'page',
                  normalizedPos: 0.25,
                  docUrl: '',
                  meta: { updatedAt: '2026-11-24T10:00:00.000Z' },
                },
              ],
              notes: [],
              sessions: [],
              deltaLogs: [],
            },
          })
        );
      },
      { cid: CLIENT_ID, proxy: PROXY_URL }
    );

    // 1. Flaky network boot (navigator.onLine = true, /refresh fails with network error):
    //    MUST NOT log user out or wipe sealed refresh token; serves cached Shelf read-only!
    await page.reload();
    await expect(page.getByTestId('book-card-book-t12')).toBeVisible();
    await expect(page.getByTestId('offline-readonly-badge')).toBeVisible();
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_sealed_refresh_v1'))).toContain(
      'v1.flight.sealed'
    );

    // 2. Network comes back -> Retry Sync silently refreshes via /refresh and clears offline badge!
    proxyOffline = false;
    await page.getByTestId('offline-retry-sync-btn').click();
    await expect(page.getByTestId('offline-readonly-badge')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_token'))).toBe(
      'ya29.recovered-online'
    );

    // 3. Now simulate true airplane mode (navigator.onLine = false) with expired token on cold reload
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    });
    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token_expires_at', String(Date.now() - 3600_000));
    });
    await page.reload();
    await expect(page.getByTestId('book-card-book-t12')).toBeVisible();
    await expect(page.getByTestId('offline-readonly-badge')).toBeVisible();
    await expect(page.getByTestId('login-view')).toHaveCount(0);
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();
  });

  test('T12.4: Revoked refresh token falls back to SessionExpiredModal; Logout fires /revoke; Browser-only 1-tap GIS reconnect works in-place', async ({
    page,
  }) => {
    // Part A: Revoked proxy refresh -> clears sealed token + opens SessionExpiredModal
    await page.addInitScript(
      ({ cid, proxy }) => {
        const win = window as unknown as {
          VITE_GOOGLE_CLIENT_ID?: string;
          VITE_GOOGLE_AUTH_PROXY_URL?: string;
          __PLAYWRIGHT__?: boolean;
        };
        win.VITE_GOOGLE_CLIENT_ID = cid;
        win.VITE_GOOGLE_AUTH_PROXY_URL = proxy;
        win.__PLAYWRIGHT__ = true;
      },
      { cid: CLIENT_ID, proxy: PROXY_URL }
    );

    let revokeCalledWith = '';
    await page.route(`${PROXY_URL}/**`, async route => {
      const url = route.request().url();
      const body = JSON.parse(route.request().postData() || '{}') as { sealedRefreshToken?: string };
      if (url.endsWith('/revoke')) {
        revokeCalledWith = body.sealedRefreshToken || '';
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_grant', revoked: true }),
      });
    });

    const validTokens = new Set(['ya29.active-before-logout']);
    await installCloudSheetRoutes(page, {
      sheetId: 'sheet-t12-rev',
      validTokens,
      userEmail: 'rev@pragya.dev',
    });

    await page.goto('/');
    await page.evaluate(
      ({ cid, proxy }) => {
        localStorage.setItem('pragya_google_token', 'ya29.active-before-logout');
        localStorage.setItem('pragya_google_token_expires_at', String(Date.now() + 3600_000));
        localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'rev@pragya.dev', name: 'Rev' }));
        localStorage.setItem('pragya_last_account_email', 'rev@pragya.dev');
        localStorage.setItem('pragya_mock_mode', 'false');
        localStorage.setItem('pragya_spreadsheet_id', 'sheet-t12-rev');
        localStorage.setItem(
          'pragya_google_sealed_refresh_v1',
          JSON.stringify({
            token: 'v1.logout.sealed',
            email: 'rev@pragya.dev',
            clientId: cid,
            proxyUrl: proxy,
            savedAt: Date.now(),
          })
        );
      },
      { cid: CLIENT_ID, proxy: PROXY_URL }
    );

    await page.reload();
    await expect(page.getByTestId('book-card-book-t12')).toBeVisible();
    await page.getByTestId('logout-btn').click();
    await expect(page.getByTestId('login-view')).toBeVisible();
    await expect.poll(() => revokeCalledWith).toBe('v1.logout.sealed');
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_sealed_refresh_v1'))).toBeNull();

    // Seed expired session with revoked sealed token -> reload -> clears sealed token + shows SessionExpiredModal
    await page.evaluate(
      ({ cid, proxy }) => {
        localStorage.setItem('pragya_google_token', 'ya29.old-revoked');
        localStorage.setItem('pragya_google_token_expires_at', String(Date.now() - 60_000));
        localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'rev@pragya.dev', name: 'Rev' }));
        localStorage.setItem('pragya_last_account_email', 'rev@pragya.dev');
        localStorage.setItem('pragya_mock_mode', 'false');
        localStorage.setItem(
          'pragya_google_sealed_refresh_v1',
          JSON.stringify({
            token: 'v1.dead.sealed',
            email: 'rev@pragya.dev',
            clientId: cid,
            proxyUrl: proxy,
            savedAt: Date.now() - 8 * 86400_000,
          })
        );
      },
      { cid: CLIENT_ID, proxy: PROXY_URL }
    );
    await page.reload();
    await expect(page.getByTestId('session-expired-modal')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_sealed_refresh_v1'))).toBeNull();

    // Part B: Browser-only mode (no Auth Proxy) — tapping "Reconnect Google" with GIS runtime warm
    // renews synchronously in-place with prompt='' & login_hint, keeping current route!
    const validTokensGis = new Set(['ya29.gis-tap-renewed']);
    await page.unroute(`${PROXY_URL}/**`);
    await page.unroute('https://www.googleapis.com/**');
    await page.unroute('https://sheets.googleapis.com/**');
    await installCloudSheetRoutes(page, {
      sheetId: 'sheet-t12-gis',
      validTokens: validTokensGis,
      userEmail: 'tap@pragya.dev',
    });

    await page.addInitScript(cid => {
      const win = window as unknown as {
        VITE_GOOGLE_CLIENT_ID?: string;
        VITE_GOOGLE_AUTH_PROXY_URL?: string;
        __PLAYWRIGHT__?: boolean;
        __TAP_GIS_CALLS__?: Array<{ prompt?: string; hint?: string }>;
        google?: unknown;
      };
      win.VITE_GOOGLE_CLIENT_ID = cid;
      win.VITE_GOOGLE_AUTH_PROXY_URL = '';
      win.__PLAYWRIGHT__ = true;
      win.__TAP_GIS_CALLS__ = [];
      let callCount = 0;
      win.google = {
        accounts: {
          oauth2: {
            initTokenClient(cfg: {
              hint?: string;
              callback: (r: { access_token?: string; expires_in?: number; error?: string }) => void;
            }) {
              return {
                requestAccessToken(override?: { prompt?: string; hint?: string }) {
                  callCount += 1;
                  win.__TAP_GIS_CALLS__!.push({
                    prompt: override?.prompt,
                    hint: override?.hint ?? cfg.hint,
                  });
                  // First call (unattended boot) fails like Android popup blocker;
                  // Second call (user tap on Reconnect Google) succeeds!
                  if (callCount === 1) {
                    setTimeout(() => cfg.callback({ error: 'popup_failed_to_open' }), 10);
                  } else {
                    setTimeout(() => cfg.callback({ access_token: 'ya29.gis-tap-renewed', expires_in: 3600 }), 10);
                  }
                },
              };
            },
          },
        },
      };
    }, CLIENT_ID);

    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token', 'ya29.expired-browser-only');
      localStorage.setItem('pragya_google_token_expires_at', String(Date.now() - 60_000));
      localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'tap@pragya.dev', name: 'Tap Reader' }));
      localStorage.setItem('pragya_last_account_email', 'tap@pragya.dev');
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-t12-gis');
    });

    await page.reload();
    await expect(page.getByTestId('session-expired-modal')).toBeVisible();
    await page.getByTestId('session-reauth-btn').click();

    await expect(page.getByTestId('book-card-book-t12')).toBeVisible();
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();
    const tapCalls = await page.evaluate(
      () => (window as unknown as { __TAP_GIS_CALLS__?: Array<{ prompt?: string; hint?: string }> }).__TAP_GIS_CALLS__ || []
    );
    expect(tapCalls.length).toBeGreaterThanOrEqual(2);
    expect(tapCalls[1]).toEqual({ prompt: '', hint: 'tap@pragya.dev' });
  });
});
