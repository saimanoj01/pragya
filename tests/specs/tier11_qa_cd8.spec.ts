import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 11 — CD Batch 8 QA adversarial GIS silent refresh probes:
 * 1. Live Chromium single-flight mutex: concurrent Sheets 401 + DriveImage 401 share ONE GIS call.
 * 2. Live Chromium 5s GIS timeout fallback -> SessionExpiredModal & cleared token.
 * 3. Mid-session 401 cross-account mismatch rejects Bob's token cleanly without clobbering Account A's user/IDB.
 * 4. QA-48 (`test.fail` repro): Logout mid-GIS-silent-refresh discards late token AND must NOT pop
 *    SessionExpiredModal over LoginView.
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

// Minimal valid 1x1 PNG bytes for DriveImage media response
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
);

async function installControllableGisStub(
  page: Page,
  mode:
    | { kind: 'delayed'; delayMs: number; token: string }
    | { kind: 'hang' }
    | { kind: 'manual' }
) {
  await page.addInitScript(cfg => {
    const win = window as unknown as {
      VITE_GOOGLE_CLIENT_ID?: string;
      __PLAYWRIGHT__?: boolean;
      __GIS_CALLS__?: Array<{ client_id: string; prompt?: string; hint?: string }>;
      __RESOLVE_GIS__?: (resp: { access_token?: string; expires_in?: number; error?: string }) => void;
      google?: unknown;
    };
    win.VITE_GOOGLE_CLIENT_ID = 'qa8-gis-client.apps.googleusercontent.com';
    win.__PLAYWRIGHT__ = true;
    win.__GIS_CALLS__ = [];
    const pendingCallbacks: Array<(r: { access_token?: string; expires_in?: number; error?: string }) => void> = [];
    win.__RESOLVE_GIS__ = resp => {
      while (pendingCallbacks.length > 0) {
        const cb = pendingCallbacks.shift();
        cb?.(resp);
      }
    };

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
                if (cfg.kind === 'hang') return;
                if (cfg.kind === 'manual') {
                  pendingCallbacks.push(opts.callback);
                  return;
                }
                setTimeout(() => {
                  opts.callback({ access_token: cfg.token, expires_in: 3600 });
                }, cfg.delayMs);
              },
            };
          },
        },
      },
    };
  }, mode);
}

async function installQa8CloudRoutes(
  page: Page,
  opts: {
    sheetId: string;
    validTokens: Set<string>;
    userEmail: string;
    userinfoEmail?: string;
    withImageNote?: boolean;
  }
) {
  const bookRow: unknown[] = [
    'book-qa8',
    'QA8 GIS Hardening Book',
    'Systems Author',
    'physical',
    'nonfiction',
    'reading',
    50,
    200,
    'page',
    0.25,
    '',
    JSON.stringify({ updatedAt: '2026-11-19T10:00:00.000Z' }),
  ];
  const noteRows: unknown[][] = [NOTE_HEADERS];
  if (opts.withImageNote) {
    noteRows.push([
      'note-img-qa8',
      'qa8-img-note',
      'book-qa8',
      '2026-11-18T10:00:00.000Z',
      '2026-11-18T10:00:00.000Z',
      25,
      0.125,
      'saved',
      'app',
      '#systems',
      'Visual quote',
      'Visual takeaway',
      '',
      '',
      '',
      '',
      'none',
      JSON.stringify({
        title: 'QA8 Image Note',
        attachments: [
          {
            id: 'att-qa8-1',
            type: 'image',
            driveFileId: 'drv-img-qa8',
            fileName: 'qa8-page.png',
            mimeType: 'image/png',
          },
        ],
        links: [],
      }),
    ]);
  }
  const modifiedTime = '2026-11-19T10:00:00Z';

  await page.route('https://accounts.google.com/**', route => route.abort('failed'));

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
          name: 'QA8 User',
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

    if (u.includes('drive/v3/files/drv-img-qa8') && u.includes('alt=media')) {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: TINY_PNG,
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
      const ranges = new URL(u).searchParams.getAll('ranges');
      const valueRanges = ranges.map(r => {
        if (r.startsWith('Books!')) return { range: 'Books!A1:L2', values: [BOOK_HEADERS, bookRow] };
        if (r.startsWith('Notes!')) return { range: `Notes!A1:R${noteRows.length}`, values: noteRows };
        if (r.startsWith('Sessions!')) return { range: 'Sessions!A1:G1', values: [SESSION_HEADERS] };
        return { range: 'DeltaLogs!A1:E1', values: [DELTA_HEADERS] };
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valueRanges }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function seedCloud(page: Page, sheetId: string, token: string, email: string) {
  await page.goto('/');
  await page.evaluate(
    ({ sid, tok, mail }) => {
      localStorage.setItem('pragya_google_token', tok);
      localStorage.removeItem('pragya_google_token_expires_at');
      localStorage.setItem('pragya_google_user', JSON.stringify({ email: mail, name: 'QA8 Reader' }));
      localStorage.setItem('pragya_last_account_email', mail);
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', sid);
    },
    { sid: sheetId, tok: token, mail: email }
  );
  await page.reload();
  await expect(page.getByTestId('book-card-book-qa8')).toBeVisible();
}

test.describe('Tier 11 — CD Batch 8 QA adversarial GIS silent refresh probes', () => {
  test('single-flight GIS mutex coalesces concurrent Sheets 401 and DriveImage 401 into ONE GIS request', async ({
    page,
  }) => {
    const validTokens = new Set(['ya29.init-sf', 'ya29.single-flight']);
    await installControllableGisStub(page, {
      kind: 'delayed',
      delayMs: 120,
      token: 'ya29.single-flight',
    });
    await installQa8CloudRoutes(page, {
      sheetId: 'sheet-qa8-sf',
      validTokens,
      userEmail: 'sf@pragya.dev',
      withImageNote: true,
    });

    await seedCloud(page, 'sheet-qa8-sf', 'ya29.init-sf', 'sf@pragya.dev');

    // Revoke initial token so BOTH DriveImage (?alt=media) AND manual Sync (drive/sheets) hit 401 concurrently!
    validTokens.delete('ya29.init-sf');
    await page.evaluate(() => {
      window.location.hash = '#/note/qa8-img-note';
    });
    await page.keyboard.press('r');

    // Both DriveImage and Workspace Sync recover via the SAME single-flight GIS refresh!
    await expect(page.locator('img[data-testid="attachment-image-att-qa8-1"]')).toBeVisible();
    await expect(
      page.getByTestId('notification-toast').filter({ hasText: /Workspace synced/i })
    ).toBeVisible();
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();

    const gisCalls = await page.evaluate(
      () => (window as unknown as { __GIS_CALLS__?: Array<{ prompt?: string; hint?: string }> }).__GIS_CALLS__ || []
    );
    expect(gisCalls).toHaveLength(1);
    expect(gisCalls[0].prompt).toBe('');
    expect(gisCalls[0].hint).toBe('sf@pragya.dev');
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_token'))).toBe('ya29.single-flight');
  });

  test('5s GIS silent refresh timeout falls back cleanly to SessionExpiredModal and clears dead token', async ({
    page,
  }) => {
    const validTokens = new Set(['ya29.init-to']);
    await installControllableGisStub(page, { kind: 'hang' });
    await installQa8CloudRoutes(page, {
      sheetId: 'sheet-qa8-to',
      validTokens,
      userEmail: 'to@pragya.dev',
    });

    await seedCloud(page, 'sheet-qa8-to', 'ya29.init-to', 'to@pragya.dev');
    validTokens.delete('ya29.init-to');

    await page.keyboard.press('r');
    // Real GIS_SILENT_REFRESH_TIMEOUT_MS is 5000ms -> wait up to 8s for clean fallback
    await expect(page.getByTestId('session-expired-modal')).toBeVisible({ timeout: 8500 });
    expect(await page.evaluate(() => localStorage.getItem('pragya_google_token'))).toBeNull();
  });

  test('mid-session 401 cross-account mismatch rejects wrong-account token without clobbering Account A user profile', async ({
    page,
  }) => {
    const validTokens = new Set(['ya29.acct-a', 'ya29.acct-b-wrong']);
    await installControllableGisStub(page, {
      kind: 'delayed',
      delayMs: 20,
      token: 'ya29.acct-b-wrong',
    });
    await installQa8CloudRoutes(page, {
      sheetId: 'sheet-qa8-mismatch',
      validTokens,
      userEmail: 'acct-a@pragya.dev',
      userinfoEmail: 'acct-b@pragya.dev',
    });

    await seedCloud(page, 'sheet-qa8-mismatch', 'ya29.acct-a', 'acct-a@pragya.dev');

    // Revoke Account A token mid-session -> GIS returns Account B's token -> MUST reject!
    validTokens.delete('ya29.acct-a');
    await page.keyboard.press('r');

    await expect(page.getByTestId('session-expired-modal')).toBeVisible();
    const state = await page.evaluate(() => ({
      token: localStorage.getItem('pragya_google_token'),
      user: localStorage.getItem('pragya_google_user'),
      lastAccount: localStorage.getItem('pragya_last_account_email'),
    }));
    expect(state.token).toBeNull();
    expect(state.user).toContain('acct-a@pragya.dev');
    expect(state.user).not.toContain('acct-b@pragya.dev');
    expect(state.lastAccount).toBe('acct-a@pragya.dev');
  });

  test('QA-48: Logout mid-GIS-silent-refresh discards late token AND must NOT pop SessionExpiredModal over LoginView', async ({
    page,
  }) => {
    const validTokens = new Set(['ya29.init-lo', 'ya29.late-after-logout']);
    await installControllableGisStub(page, { kind: 'manual' });
    await installQa8CloudRoutes(page, {
      sheetId: 'sheet-qa8-lo',
      validTokens,
      userEmail: 'logout-race@pragya.dev',
    });

    await seedCloud(page, 'sheet-qa8-lo', 'ya29.init-lo', 'logout-race@pragya.dev');

    // Trigger 401 -> GIS silent refresh enters in-flight wait
    validTokens.delete('ya29.init-lo');
    await page.keyboard.press('r');
    await expect
      .poll(() =>
        page.evaluate(
          () => ((window as unknown as { __GIS_CALLS__?: unknown[] }).__GIS_CALLS__ || []).length
        )
      )
      .toBe(1);

    // User explicitly clicks Logout while GIS silent refresh is still pending
    await page.getByTestId('logout-btn').click();
    await expect(page.getByTestId('login-view')).toBeVisible();
    await expect(page.getByTestId('session-expired-modal')).toBeHidden();

    // Now the late GIS callback settles -> token MUST stay cleared AND SessionExpiredModal MUST stay hidden!
    await page.evaluate(() => {
      (
        window as unknown as {
          __RESOLVE_GIS__?: (r: { access_token?: string; expires_in?: number }) => void;
        }
      ).__RESOLVE_GIS__?.({ access_token: 'ya29.late-after-logout', expires_in: 3600 });
    });
    await page.waitForTimeout(250);

    expect(await page.evaluate(() => localStorage.getItem('pragya_google_token'))).toBeNull();
    expect(await page.getByTestId('session-expired-modal').isVisible()).toBe(false);
  });

  test('QA-49: scripts/syncSkill.mjs --check must exit non-zero on drift even when invoked via a symlinked directory path', async () => {
    const baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pragya-qa49-')));
    try {
      const realRepo = path.join(baseDir, 'real-repo');
      const linkRepo = path.join(baseDir, 'link-repo');
      const scriptsDir = path.join(realRepo, 'scripts');
      const skillScriptsDir = path.join(realRepo, '.agents', 'skills', 'pragya-companion', 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.mkdirSync(skillScriptsDir, { recursive: true });
      fs.copyFileSync(path.resolve('scripts/syncSkill.mjs'), path.join(scriptsDir, 'syncSkill.mjs'));
      fs.writeFileSync(path.join(scriptsDir, 'pragya_cli.py'), '# source v2\n', 'utf8');
      fs.writeFileSync(path.join(skillScriptsDir, 'pragya_cli.py'), '# drifted v1\n', 'utf8');
      fs.symlinkSync(realRepo, linkRepo);

      const res = spawnSync(
        process.execPath,
        [path.join(linkRepo, 'scripts', 'syncSkill.mjs'), '--check'],
        { cwd: linkRepo, encoding: 'utf8' }
      );
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/out of sync/i);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
