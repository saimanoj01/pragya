import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Tier 7 (QA, M6 Batch 3) — deferred E2E scenarios:
 *  - B4.1 visibilitychange background sync while EditBookModal is open → Save conflicts
 *  - B4.8 Cloud `offline` event mid-session → read-only badge, writes blocked w/o network
 *  - B4.10b forced render throw → ErrorBoundary fallback, Go to Shelf recovers
 * All Google APIs are mocked via page.route; no real network.
 */

const BOOK_HEADERS = ['id', 'title', 'author', 'format', 'kind', 'status', 'currentPos', 'totalPos', 'posUnit', 'normalizedPos', 'docUrl', 'metaJson'];
const NOTE_HEADERS = ['id', 'slug', 'bookId', 'createdAt', 'updatedAt', 'pos', 'normalizedPos', 'status', 'source', 'tags', 'quote', 'takeaway', 'contextMechanism', 'critique', 'deltaTrigger', 'deltaAction', 'deltaStatus', 'metaJson'];
const SESSION_HEADERS = ['id', 'bookId', 'date', 'startPos', 'endPos', 'updatedAt', 'note'];
const DELTA_HEADERS = ['id', 'noteId', 'date', 'outcome', 'reflection'];

interface CloudMock {
  remote: { bookUpdatedAt: string; modifiedTime: string; title: string };
  calls: Array<{ method: string; url: string }>;
}

function bookRow(m: CloudMock['remote']): string[] {
  return [
    'book-t7', m.title, 'Author', 'physical', 'nonfiction', 'reading', '50', '200', 'page', '0.25', '',
    JSON.stringify({ updatedAt: m.bookUpdatedAt, subgenre: 'qa' }),
  ];
}

async function installCloudMock(page: Page, sheetId: string): Promise<CloudMock> {
  const mock: CloudMock = {
    remote: { bookUpdatedAt: '2026-11-15T10:00:00.000Z', modifiedTime: '2026-11-15T10:00:00Z', title: 'Tier7 Book' },
    calls: [],
  };
  await page.route('https://www.googleapis.com/**', async (route: Route) => {
    const u = route.request().url();
    mock.calls.push({ method: route.request().method(), url: u });
    if (u.includes(`drive/v3/files/${sheetId}`)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: sheetId, modifiedTime: mock.remote.modifiedTime }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
  });
  await page.route('https://sheets.googleapis.com/**', async (route: Route) => {
    const u = route.request().url();
    const method = route.request().method();
    mock.calls.push({ method, url: u });
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.includes('fields=sheets.properties')) {
      await json({ sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map(title => ({ properties: { title } })) });
      return;
    }
    if (u.includes('values:batchGet') && u.includes('A1%3AL1')) {
      await json({
        valueRanges: [
          { range: 'Books!A1:L1', values: [BOOK_HEADERS] },
          { range: 'Notes!A1:R1', values: [NOTE_HEADERS] },
          { range: 'Sessions!A1:G1', values: [SESSION_HEADERS] },
          { range: 'DeltaLogs!A1:E1', values: [DELTA_HEADERS] },
        ],
      });
      return;
    }
    if (u.includes('values:batchGet')) {
      await json({
        valueRanges: [
          { range: 'Books!A:L', values: [BOOK_HEADERS, bookRow(mock.remote)] },
          { range: 'Notes!A:R', values: [NOTE_HEADERS] },
          { range: 'Sessions!A:G', values: [SESSION_HEADERS] },
          { range: 'DeltaLogs!A:E', values: [DELTA_HEADERS] },
        ],
      });
      return;
    }
    if (u.includes('Books!A%3AA')) {
      await json({ values: [['id'], ['book-t7']] });
      return;
    }
    if (method === 'GET' && u.includes('Books!A2%3AL2')) {
      await json({ values: [bookRow(mock.remote)] });
      return;
    }
    await json({});
  });
  return mock;
}

async function loginCloud(page: Page, sheetId: string, email: string) {
  await page.goto('/');
  await page.evaluate(
    ({ sheetId, email }) => {
      localStorage.setItem('pragya_google_token', 'tier7-tok');
      localStorage.setItem('pragya_google_user', JSON.stringify({ email, name: 'Tier7' }));
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', sheetId);
      localStorage.removeItem('pragya_sheets_cache_v1');
      localStorage.removeItem('pragya_google_token_expires_at');
    },
    { sheetId, email }
  );
  await page.reload();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
  await expect(page.getByTestId('book-card-book-t7')).toBeVisible();
}

const bookPuts = (mock: CloudMock) =>
  mock.calls.filter(c => c.method === 'PUT' && c.url.includes('Books!A2%3AL2'));

test.describe('Tier 7 — M6 integrity & resilience (QA)', () => {
  test('B4.1: background visibilitychange sync while EditBookModal is open → Save conflicts and keeps the draft', async ({ page }) => {
    const mock = await installCloudMock(page, 'sheet-t7-conflict');
    await loginCloud(page, 'sheet-t7-conflict', 't7@pragya.dev');

    await page.getByRole('button', { name: 'Edit Tier7 Book' }).first().click();
    await expect(page.getByTestId('edit-book-modal')).toBeVisible();

    // Another device writes the row; Drive modifiedTime moves so the sync re-reads.
    mock.remote.bookUpdatedAt = '2026-11-16T12:00:00.000Z';
    mock.remote.modifiedTime = '2026-11-16T12:00:00Z';
    mock.remote.title = 'Tier7 Book (remote edit)';
    const batchGetsBefore = mock.calls.filter(c => c.url.includes('values:batchGet') && c.url.includes('Books!A%3AL')).length;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect
      .poll(() => mock.calls.filter(c => c.url.includes('values:batchGet') && c.url.includes('Books!A%3AL')).length)
      .toBeGreaterThan(batchGetsBefore);
    await expect(page.getByTestId('book-card-book-t7')).toContainText('Tier7 Book (remote edit)');

    await page.getByTestId('edit-book-title-input').fill('Stale modal title');
    await page.getByTestId('edit-book-submit-btn').click();

    await expect(
      page.locator('[data-testid="notification-toast"][data-toast-variant="error"]').last()
    ).toContainText(/Updated on another device/i);
    await expect(page.getByTestId('edit-book-modal')).toBeVisible();
    await expect(page.getByTestId('edit-book-title-input')).toHaveValue('Stale modal title');
    expect(bookPuts(mock)).toHaveLength(0);
  });

  test('B4.1 control: with no remote change the same edit saves (single guarded PUT)', async ({ page }) => {
    const mock = await installCloudMock(page, 'sheet-t7-ok');
    await loginCloud(page, 'sheet-t7-ok', 't7ok@pragya.dev');
    await page.getByRole('button', { name: 'Edit Tier7 Book' }).first().click();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByTestId('edit-book-title-input').fill('Fresh title');
    await page.getByTestId('edit-book-submit-btn').click();
    await expect(page.getByTestId('edit-book-modal')).toBeHidden();
    await expect.poll(() => bookPuts(mock).length).toBe(1);
  });

  test('B4.8: Cloud offline event mid-session → read-only badge, writes blocked with zero requests; online re-syncs', async ({ page, context }) => {
    const mock = await installCloudMock(page, 'sheet-t7-offline');
    await loginCloud(page, 'sheet-t7-offline', 't7off@pragya.dev');
    await expect(page.getByTestId('offline-readonly-badge')).toBeHidden();

    await context.setOffline(true);
    await expect(page.getByTestId('offline-readonly-badge')).toBeVisible();

    const before = mock.calls.length;
    await page.getByTestId('advance-10p-btn-book-t7').click();
    await expect(
      page.locator('[data-sonner-toast]', { hasText: /read-only while offline/i }).first()
    ).toBeVisible();
    await expect(page.getByTestId('book-card-book-t7')).toContainText('p. 50 / 200');
    expect(mock.calls.length).toBe(before);

    await context.setOffline(false);
    await expect(page.getByTestId('offline-readonly-badge')).toBeHidden();
  });

  test('B4.10b: a forced render throw shows the ErrorBoundary fallback; Go to Shelf recovers', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    await page.goto('/');
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    // Corrupt one note in the demo store so only NoteDetailView throws while rendering
    // (the Socratic banner calls .map on socraticQuestions; Demo storage is not normalized).
    const slug = await page.evaluate(() => {
      const raw = localStorage.getItem('pragya_demo_state_v1');
      if (!raw) throw new Error('demo state missing');
      const state = JSON.parse(raw);
      const note = state.notes[0];
      note.status = 'in-reflection';
      note.meta = { ...note.meta, socraticQuestions: 'not-an-array' };
      localStorage.setItem('pragya_demo_state_v1', JSON.stringify(state));
      return note.slug as string;
    });
    await page.evaluate(s => {
      window.location.hash = `#/note/${encodeURIComponent(s)}`;
    }, slug);
    await page.reload();

    await expect(page.getByTestId('error-boundary-fallback')).toBeVisible();
    await expect(page.getByTestId('error-reload-btn')).toBeVisible();
    // Technical details (with a local-only Copy button) are collapsed by default.
    await expect(page.getByTestId('error-copy-details-btn')).toBeAttached();

    await page.getByTestId('error-go-shelf-btn').click();
    await expect(page.getByTestId('error-boundary-fallback')).toBeHidden();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
  });

  test('QA-10: a demo note with tags: null no longer crashes every route (Demo sanitizer + palette guard)', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      state.notes[0].tags = null;
      state.notes[1].meta = 'not-an-object';
      localStorage.setItem('pragya_demo_state_v1', JSON.stringify(state));
    });
    await page.reload();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await expect(page.getByTestId('error-boundary-fallback')).toBeHidden();
    await page.getByTestId('nav-item-notes').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await expect(page.getByTestId('error-boundary-fallback')).toBeHidden();
    await page.keyboard.press('Meta+k');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('error-boundary-fallback')).toBeHidden();
  });

  for (const scenario of ['switch', 'same'] as const) {
    test(`B4.11/R1#1: sign-in after an EXPIRED session as ${scenario === 'switch' ? 'a different' : 'the same'} account ${scenario === 'switch' ? 'clears' : 'keeps'} per-account local data`, async ({ page }) => {
      const newEmail = scenario === 'switch' ? 'b@pragya.dev' : 'a@pragya.dev';
      await page.addInitScript(() => {
        (window as unknown as { VITE_GOOGLE_CLIENT_ID?: string }).VITE_GOOGLE_CLIENT_ID = 'mock-client-id.apps.googleusercontent.com';
        (window as unknown as { __PLAYWRIGHT__?: boolean }).__PLAYWRIGHT__ = true;
      });
      await page.route('https://www.googleapis.com/**', async (route: Route) => {
        const u = route.request().url();
        const fulfill = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        if (u.includes('oauth2/v3/userinfo')) return fulfill({ email: newEmail, name: 'Reader' });
        if (u.includes('drive/v3/files?q=')) return fulfill({ files: [{ id: 'sheet-new', name: 'Pragya Commonplace', modifiedTime: '2026-11-16T00:00:00Z' }] });
        if (u.includes('drive/v3/files/')) return fulfill({ id: 'sheet-new', modifiedTime: '2026-11-16T00:00:00Z' });
        return fulfill({ files: [] });
      });
      await page.route('https://oauth2.googleapis.com/**', route => route.fulfill({ status: 200, body: '{}' }));
      await page.route('https://sheets.googleapis.com/**', async (route: Route) => {
        const u = route.request().url();
        const fulfill = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        if (u.includes('fields=sheets.properties')) {
          return fulfill({ sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map(title => ({ properties: { title } })) });
        }
        if (u.includes('values:batchGet') && u.includes('A1%3AL1')) {
          return fulfill({ valueRanges: [
            { range: 'Books!A1:L1', values: [BOOK_HEADERS] },
            { range: 'Notes!A1:R1', values: [NOTE_HEADERS] },
            { range: 'Sessions!A1:G1', values: [SESSION_HEADERS] },
            { range: 'DeltaLogs!A1:E1', values: [DELTA_HEADERS] },
          ] });
        }
        if (u.includes('values:batchGet')) {
          return fulfill({ valueRanges: [
            { range: 'Books!A:L', values: [BOOK_HEADERS] },
            { range: 'Notes!A:R', values: [NOTE_HEADERS] },
            { range: 'Sessions!A:G', values: [SESSION_HEADERS] },
            { range: 'DeltaLogs!A:E', values: [DELTA_HEADERS] },
          ] });
        }
        return fulfill({});
      });

      await page.goto('/');
      // Account A signed in earlier; its token has since EXPIRED (expires_at in the past).
      await page.evaluate(() => {
        localStorage.setItem('pragya_google_token', 'ya29.old-a');
        localStorage.setItem('pragya_google_token_expires_at', String(Date.now() - 60_000));
        localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'a@pragya.dev', name: 'A' }));
        localStorage.setItem('pragya_mock_mode', 'false');
        localStorage.setItem('pragya_spreadsheet_id', 'sheet-a');
        localStorage.setItem('pragya_sheets_cache_v1', JSON.stringify({ spreadsheetId: 'sheet-a', modifiedTime: 'x', state: { books: [], notes: [], sessions: [], deltaLogs: [] } }));
        localStorage.setItem('pragya_draft_edit_note-a', JSON.stringify({ title: 'A private draft' }));
        localStorage.setItem('pragya_draft_capture_v1', JSON.stringify({ takeaway: 'A capture draft' }));
        localStorage.setItem('pragya_pre_import_backup_v1', JSON.stringify({ books: [{ id: 'a-secret' }] }));
      });
      await page.reload();
      await expect(page.getByTestId('session-expired-modal')).toBeVisible();
      // Expiry cleanup removed the profile but kept the durable account marker.
      expect(await page.evaluate(() => localStorage.getItem('pragya_google_user'))).toBeNull();
      expect(await page.evaluate(() => localStorage.getItem('pragya_last_account_email'))).toBe('a@pragya.dev');

      // Complete a fresh OAuth redirect (valid CSRF) as the new/same account.
      await page.evaluate(() => {
        sessionStorage.setItem('pragya_oauth_csrf_state', 'csrf-t7');
        window.location.hash = '#state=csrf-t7&access_token=ya29.fresh&expires_in=3600';
      });
      await expect(page.getByTestId('shelf-view')).toBeVisible();
      await expect.poll(() => page.evaluate(() => localStorage.getItem('pragya_last_account_email'))).toBe(newEmail);

      const snapshot = await page.evaluate(() => ({
        draftEdit: localStorage.getItem('pragya_draft_edit_note-a'),
        draftCapture: localStorage.getItem('pragya_draft_capture_v1'),
        backup: localStorage.getItem('pragya_pre_import_backup_v1'),
        sheetId: localStorage.getItem('pragya_spreadsheet_id'),
        expiresAt: Number(localStorage.getItem('pragya_google_token_expires_at')),
      }));
      expect(snapshot.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
      if (scenario === 'switch') {
        // R2 N3 (Batch 7): calm info toast on an account switch.
        await expect(
          page.getByText('Signed in as a different account. Unsaved drafts from the previous account were cleared on this device.')
        ).toBeVisible();
        expect(snapshot.draftEdit).toBeNull();
        expect(snapshot.draftCapture).toBeNull();
        expect(snapshot.backup).toBeNull();
        expect(snapshot.sheetId).not.toBe('sheet-a');
      } else {
        await expect(page.getByText('Signed in as a different account.', { exact: false })).toHaveCount(0);
        expect(snapshot.draftEdit).toContain('A private draft');
        expect(snapshot.backup).toContain('a-secret');
      }
    });
  }
});
