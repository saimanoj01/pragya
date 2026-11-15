import { test, expect } from '@playwright/test';

const BOOKS_HEADERS = [
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
];
const NOTES_HEADERS = [
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
];
const SESSIONS_HEADERS = ['id', 'bookId', 'date', 'startPos', 'endPos', 'updatedAt', 'note'];
const DELTA_LOGS_HEADERS = ['id', 'noteId', 'date', 'outcome', 'reflection'];

// 2x2 valid RGBA PNG
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==';

test.describe('Tier 2 — OAuth Flow, Google Sheets Mock, 401 Expiry & Mobile 390px', () => {
  test('OAuth CSRF check, SPA hash token extraction, mocked Sheets sync, modifiedTime cache hit, DriveImage cache & Doc title lookup', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { VITE_GOOGLE_CLIENT_ID?: string }).VITE_GOOGLE_CLIENT_ID =
        'mock-client-id.apps.googleusercontent.com';
      (window as unknown as { __PLAYWRIGHT__?: boolean }).__PLAYWRIGHT__ = true;
    });

    let driveMetaCalls = 0;
    let driveImageFetchCalls = 0;
    let lastDriveImageAuthHeader = '';
    let sheetsApiCalls = 0;
    let sheetsRangeGetCalls = 0;

    await page.route('https://www.googleapis.com/**', async route => {
      const url = route.request().url();
      const headers = route.request().headers();
      if (url.includes('oauth2/v3/userinfo')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ email: 'reader@pragya.dev', name: 'Cloud Reader' }),
        });
        return;
      }
      if (url.includes('drive/v3/files?q=')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: [
              {
                id: 'sheet-mock-001',
                name: 'Pragya Commonplace',
                modifiedTime: '2026-11-15T12:00:00Z',
              },
            ],
          }),
        });
        return;
      }
      if (url.includes('drive/v3/files/doc-abc-123')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'doc-abc-123', name: 'Resolved Systems Essay' }),
        });
        return;
      }
      if (url.includes('drive/v3/files/drive-img-101') && url.includes('alt=media')) {
        driveImageFetchCalls += 1;
        lastDriveImageAuthHeader = headers['authorization'] || '';
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: Buffer.from(TINY_PNG_BASE64, 'base64'),
        });
        return;
      }
      if (url.includes('drive/v3/files/sheet-mock-001')) {
        driveMetaCalls += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'sheet-mock-001',
            name: 'Pragya Commonplace',
            modifiedTime: '2026-11-15T12:00:00Z',
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.route('https://sheets.googleapis.com/**', async route => {
      sheetsApiCalls += 1;
      const url = route.request().url();
      if (url.includes('fields=sheets.properties')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sheets: [
              { properties: { title: 'Books' } },
              { properties: { title: 'Notes' } },
              { properties: { title: 'Sessions' } },
              { properties: { title: 'DeltaLogs' } },
            ],
          }),
        });
        return;
      }
      if (url.includes('values:batchGet') && url.includes('A1%3AL1')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            valueRanges: [
              { range: 'Books!A1:L1', values: [BOOKS_HEADERS] },
              { range: 'Notes!A1:R1', values: [NOTES_HEADERS] },
              { range: 'Sessions!A1:G1', values: [SESSIONS_HEADERS] },
              { range: 'DeltaLogs!A1:E1', values: [DELTA_LOGS_HEADERS] },
            ],
          }),
        });
        return;
      }
      if (url.includes('values:batchGet') && url.includes('Books!A%3AL')) {
        sheetsRangeGetCalls += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            valueRanges: [
              {
                range: 'Books!A:L',
                values: [
                  BOOKS_HEADERS,
                  [
                    'book-cloud-1',
                    'The Art of Doing Science and Engineering',
                    'Richard Hamming',
                    'physical',
                    'nonfiction',
                    'reading',
                    75,
                    360,
                    'page',
                    0.208333,
                    '',
                    JSON.stringify({ updatedAt: '2026-11-15T09:00:00Z' }),
                  ],
                ],
              },
              {
                range: 'Notes!A:R',
                values: [
                  NOTES_HEADERS,
                  [
                    'note-cloud-1',
                    'hamming-style-and-taste',
                    'book-cloud-1',
                    '2026-11-15T09:05:00Z',
                    '2026-11-15T09:05:00Z',
                    42,
                    0.116667,
                    'saved',
                    'app',
                    '#craft, #taste',
                    'Great scientists tolerate ambiguity while keeping sharp judgment.',
                    'Cultivating taste determines which hard problems you attempt.',
                    '',
                    '',
                    '',
                    '',
                    'none',
                    JSON.stringify({
                      title: 'Style and Scientific Taste',
                      attachments: [
                        {
                          id: 'att-cloud-img',
                          type: 'image',
                          driveFileId: 'drive-img-101',
                          fileName: 'hamming-diagram.webp',
                          mimeType: 'image/webp',
                          width: 2,
                          height: 2,
                        },
                      ],
                      links: [],
                    }),
                  ],
                ],
              },
              { range: 'Sessions!A:G', values: [SESSIONS_HEADERS] },
              { range: 'DeltaLogs!A:E', values: [DELTA_LOGS_HEADERS] },
            ],
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/');

    // Missing stored CSRF state must fail closed, leave token unset, and clear hash
    await page.evaluate(() => {
      window.location.hash = '#state=orphan-csrf&access_token=ya29.bad';
    });
    await expect(page.getByTestId('login-view')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('pragya_google_token')))
      .toBeNull();

    await page.getByTestId('google-login-btn').click();
    const csrfState = await page.evaluate(() => sessionStorage.getItem('pragya_oauth_csrf_state'));
    expect(csrfState).toBeTruthy();

    // Bad CSRF state is rejected, clears stored CSRF state & strips token hash from URL
    await page.evaluate(() => {
      window.location.hash = '#access_token=ya29.bad&state=wrong-csrf';
    });
    await expect(page.getByTestId('login-view')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('pragya_oauth_csrf_state')))
      .toBeNull();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');

    // Re-initiate OAuth to get fresh CSRF nonce and verify state-before-access_token param order
    await page.getByTestId('google-login-btn').click();
    const freshCsrfState = await page.evaluate(() =>
      sessionStorage.getItem('pragya_oauth_csrf_state')
    );
    expect(freshCsrfState).toBeTruthy();

    await page.evaluate(st => {
      window.location.hash = `#state=${st}&access_token=ya29.valid-cloud-token`;
    }, freshCsrfState);

    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await expect(page.getByTestId('demo-badge')).toHaveText('Cloud');
    await expect(page.getByTestId('now-reading-section')).toContainText(
      'The Art of Doing Science and Engineering'
    );
    expect(sheetsRangeGetCalls).toBe(1);

    // Navigate to Notes -> DriveImage fetches with Bearer token and caches in pragya-media-v1
    await page.getByTestId('nav-item-notes').click();
    await expect(page.getByTestId('note-card-hamming-style-and-taste')).toBeVisible();
    const cloudImg = page.getByTestId('note-card-hamming-style-and-taste').locator('img');
    await expect(cloudImg).toHaveAttribute('src', /^blob:/);
    // React 18 StrictMode in dev mounts DriveImage twice before Cache API write finishes
    expect(driveImageFetchCalls).toBeGreaterThanOrEqual(1);
    expect(lastDriveImageAuthHeader).toBe('Bearer ya29.valid-cloud-token');

    const isCachedInMediaCache = await page.evaluate(async () => {
      const cache = await caches.open('pragya-media-v1');
      const match = await cache.match('https://pragya.local/drive-media/drive-img-101');
      return Boolean(match);
    });
    expect(isCachedInMediaCache).toBe(true);

    // Reset network call counters and reload -> modifiedTime cache hit must skip ALL Sheets range GETs
    driveMetaCalls = 0;
    sheetsApiCalls = 0;
    sheetsRangeGetCalls = 0;
    driveImageFetchCalls = 0;

    await page.reload();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await expect(page.getByTestId('note-card-hamming-style-and-taste')).toBeVisible();
    await expect(
      page.getByTestId('note-card-hamming-style-and-taste').locator('img')
    ).toHaveAttribute('src', /^blob:/);

    expect(driveMetaCalls).toBeGreaterThanOrEqual(1);
    expect(sheetsRangeGetCalls).toBe(0);
    expect(sheetsApiCalls).toBe(0);
    // Image also served from pragya-media-v1 Cache API without re-fetching Drive alt=media
    expect(driveImageFetchCalls).toBe(0);

    // Quick Capture attaches a Google Doc and resolves its title via drive.readonly
    await page.keyboard.press('n');
    await page.getByTestId('capture-attach-doc-btn').click();
    await page
      .getByTestId('capture-attachment-url-input')
      .fill('https://docs.google.com/document/d/doc-abc-123/edit');
    await page.getByTestId('capture-attachment-confirm-btn').click();

    await expect(page.getByTestId('capture-attachment-list')).toContainText(
      'Resolved Systems Essay'
    );
  });

  test('401 Unauthorized triggers SessionExpiredModal and switches cleanly to Demo Mode', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pragya_google_token', 'ya29.active-session');
      localStorage.setItem(
        'pragya_google_user',
        JSON.stringify({ email: 'cloud@pragya.dev', name: 'Cloud User' })
      );
      localStorage.setItem('pragya_spreadsheet_id', '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms');
      localStorage.setItem('pragya_mock_mode', 'false');
    });

    let return401 = false;
    await page.route('https://www.googleapis.com/**', async route => {
      if (return401) {
        await route.fulfill({ status: 401, body: 'Unauthorized' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
          name: 'Pragya Commonplace',
          modifiedTime: '2026-11-15T12:00:00Z',
        }),
      });
    });

    await page.route('https://sheets.googleapis.com/**', async route => {
      if (return401) {
        await route.fulfill({ status: 401, body: 'Unauthorized' });
        return;
      }
      const url = route.request().url();
      if (url.includes('fields=sheets.properties')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sheets: [
              { properties: { title: 'Books' } },
              { properties: { title: 'Notes' } },
              { properties: { title: 'Sessions' } },
              { properties: { title: 'DeltaLogs' } },
            ],
          }),
        });
        return;
      }
      if (url.includes('values:batchGet')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            valueRanges: [
              { range: 'Books!A1:L1', values: [BOOKS_HEADERS] },
              { range: 'Notes!A1:R1', values: [NOTES_HEADERS] },
              { range: 'Sessions!A1:G1', values: [SESSIONS_HEADERS] },
              { range: 'DeltaLogs!A1:E1', values: [DELTA_LOGS_HEADERS] },
            ],
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/');
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    // Navigate to Settings then verify 44-char spreadsheetId truncates cleanly on 390px mobile
    await page.getByTestId('nav-item-settings').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('settings-spreadsheet-id')).toContainText(
      '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
    );
    const cloudSettingsLayout = await page.evaluate(() => {
      const idEl = document.querySelector(
        '[data-testid="settings-spreadsheet-id"]'
      ) as HTMLElement | null;
      const card = idEl?.closest('section') as HTMLElement | null;
      if (!idEl || !card) return { ok: false, scrollWidth: 999, innerWidth: 390 };
      const idRect = idEl.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      return {
        ok:
          idRect.right <= cardRect.right + 1 &&
          idEl.scrollWidth > idEl.clientWidth &&
          window.getComputedStyle(idEl).textOverflow === 'ellipsis',
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });
    expect(cloudSettingsLayout.ok).toBe(true);
    expect(cloudSettingsLayout.scrollWidth).toBeLessThanOrEqual(cloudSettingsLayout.innerWidth);

    return401 = true;
    await page.getByTestId('sync-now-btn').click();
    await expect(page.getByTestId('session-expired-modal')).toBeVisible();
    await expect(page.getByTestId('session-reauth-btn')).toBeVisible();
    await expect(page.getByTestId('session-demo-btn')).toBeVisible();

    await page.getByTestId('session-demo-btn').click();
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();
    await expect(page.getByTestId('settings-view')).toBeVisible();
    await expect(page.getByTestId('demo-badge')).toHaveText('Demo');
  });

  test('Mobile 390x844 layout: single-line Add Book, wrapped 30-day dots, 5-slot BottomNav, More drawer & zero overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await expect(page.getByTestId('bottom-nav')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeHidden();

    // Verify all 5 BottomNav slots are visible
    await expect(page.getByTestId('bottom-nav-shelf')).toBeVisible();
    await expect(page.getByTestId('bottom-nav-notes')).toBeVisible();
    await expect(page.getByTestId('bottom-nav-capture')).toBeVisible();
    await expect(page.getByTestId('bottom-nav-practice')).toBeVisible();
    await expect(page.getByTestId('bottom-nav-more')).toBeVisible();

    // Add Book button must remain single-line (height <= 44px, whitespace-nowrap, inside viewport)
    const addBookBtn = page.getByTestId('add-book-btn');
    const addBookBox = await addBookBtn.boundingBox();
    expect(addBookBox).not.toBeNull();
    expect(addBookBox!.height).toBeLessThanOrEqual(44);
    expect(addBookBox!.x + addBookBox!.width).toBeLessThanOrEqual(390);
    const addBookSingleLine = await addBookBtn.evaluate(el => {
      const style = window.getComputedStyle(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      return style.whiteSpace === 'nowrap' && range.getClientRects().length <= 2;
    });
    expect(addBookSingleLine).toBe(true);

    // Zero horizontal overflow on Shelf
    const shelfOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(shelfOverflow.scrollWidth).toBeLessThanOrEqual(shelfOverflow.innerWidth);

    // Activity dots container fits strictly inside its card section and all 30 dots fit with zero clipping
    const dotsCheck = await page.evaluate(() => {
      const dots = document.querySelector('[data-testid="activity-dots"]') as HTMLElement | null;
      const card = dots?.closest('section') as HTMLElement | null;
      if (!dots || !card) return { ok: false, reason: 'missing dots or card' };

      const cardRect = card.getBoundingClientRect();
      const dotsRect = dots.getBoundingClientRect();
      if (dots.scrollWidth > dots.clientWidth + 1) {
        return { ok: false, reason: 'dots scrollWidth > clientWidth' };
      }
      if (dotsRect.left < cardRect.left - 1 || dotsRect.right > cardRect.right + 1) {
        return { ok: false, reason: 'dots outside card horizontal bounds' };
      }

      for (let i = 0; i < 30; i += 1) {
        const dot = document.querySelector(`[data-testid="activity-dot-${i}"]`);
        if (!dot) return { ok: false, reason: `missing dot ${i}` };
        const dr = dot.getBoundingClientRect();
        if (dr.left < dotsRect.left - 1 || dr.right > dotsRect.right + 1) {
          return { ok: false, reason: `dot ${i} overflows dots container` };
        }
      }
      return { ok: true, reason: 'ok' };
    });
    expect(dotsCheck).toEqual({ ok: true, reason: 'ok' });

    // Check Notes and Practice views on 390x844 have zero horizontal overflow
    await page.getByTestId('bottom-nav-notes').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    const notesOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(notesOverflow.scrollWidth).toBeLessThanOrEqual(notesOverflow.innerWidth);

    await page.getByTestId('bottom-nav-practice').click();
    await expect(page.getByTestId('practice-view')).toBeVisible();
    const practiceOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(practiceOverflow.scrollWidth).toBeLessThanOrEqual(practiceOverflow.innerWidth);

    // Open More drawer, inspect options, test Escape close, reopen & navigate to Settings
    await page.getByTestId('bottom-nav-more').click();
    await expect(page.getByTestId('mobile-more-drawer')).toBeVisible();
    await expect(page.getByTestId('drawer-nav-settings')).toBeVisible();
    await expect(page.getByTestId('drawer-sync-btn')).toBeVisible();
    await expect(page.getByTestId('drawer-theme-toggle')).toBeVisible();
    await expect(page.getByTestId('drawer-logout-btn')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('mobile-more-drawer')).toBeHidden();

    await page.getByTestId('bottom-nav-more').click();
    await expect(page.getByTestId('mobile-more-drawer')).toBeVisible();
    await page.getByTestId('drawer-nav-settings').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();

    const settingsOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(settingsOverflow.scrollWidth).toBeLessThanOrEqual(settingsOverflow.innerWidth);
  });
});
