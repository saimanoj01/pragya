import { test, expect } from '@playwright/test';

test.describe('Tier 5 — M4 Accessibility, Guided OAuth, Offline Cloud, Draft Autosave & Safety', () => {
  test('M4.1 & M4.2: Modal aria-labelledby, labeled form controls, and activity dot semantics', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    // Activity dots ARIA group + per-dot img labels
    const activityGroup = page.getByTestId('activity-dots');
    await expect(activityGroup).toHaveAttribute('role', 'group');
    await expect(activityGroup).toHaveAttribute('aria-label', /Reading sessions/i);
    await expect(page.getByTestId('activity-dot-29')).toHaveAttribute('role', 'img');
    await expect(page.getByTestId('activity-dot-29')).toHaveAttribute('aria-label', /\d{4}-\d{2}-\d{2}/);

    const assertDialogAccessible = async (dialogTestId: string) => {
      const result = await page.evaluate(tid => {
        const dlg = document.querySelector(`[data-testid="${tid}"]`);
        if (!dlg) return { ok: false, reason: `Dialog ${tid} missing` };
        if (dlg.getAttribute('role') !== 'dialog') return { ok: false, reason: 'missing role=dialog' };
        if (dlg.getAttribute('aria-modal') !== 'true') return { ok: false, reason: 'missing aria-modal' };
        const labelledBy = dlg.getAttribute('aria-labelledby');
        if (!labelledBy) return { ok: false, reason: 'missing aria-labelledby' };
        const heading = document.getElementById(labelledBy);
        if (!heading || !heading.textContent?.trim()) {
          return { ok: false, reason: `aria-labelledby target #${labelledBy} missing or empty` };
        }
        const controls = Array.from(dlg.querySelectorAll('input, select, textarea'));
        for (const el of controls) {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const htmlEl = el as HTMLInputElement;
          const hasLabel =
            (htmlEl.labels && htmlEl.labels.length > 0) ||
            Boolean(el.getAttribute('aria-label')) ||
            Boolean(el.getAttribute('aria-labelledby'));
          if (!hasLabel) {
            return {
              ok: false,
              reason: `Unlabeled control in ${tid}: ${el.tagName} ${el.getAttribute('data-testid') || ''}`,
            };
          }
        }
        return { ok: true, reason: 'ok' };
      }, dialogTestId);
      expect(result).toEqual({ ok: true, reason: 'ok' });
    };

    // QuickCaptureModal
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await assertDialogAccessible('quick-capture-modal');
    await page.keyboard.press('Escape');

    // AddBookModal
    await page.getByTestId('add-book-btn').click();
    await expect(page.getByTestId('add-book-modal')).toBeVisible();
    await assertDialogAccessible('add-book-modal');
    await page.keyboard.press('Escape');

    // EditNoteModal & DeepenNoteModal via NotesView
    await page.getByTestId('nav-item-notes').click();
    await page
      .getByTestId('note-card-memory-prism-digital-remembrance')
      .getByRole('button', { name: 'VIEW NOTE' })
      .click();
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.getByTestId('deepen-note-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
    await assertDialogAccessible('deepen-note-modal');
    await page.keyboard.press('Escape');

    await page.getByTestId('edit-note-btn').click();
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    await assertDialogAccessible('edit-note-modal');
    await page.keyboard.press('Escape');
  });

  test('M4.4: Missing Client ID opens calm guide without error toast, OAuth preserves return route, and mobile Login/Settings stay overflow-free', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      (window as unknown as { __PLAYWRIGHT__?: boolean }).__PLAYWRIGHT__ = true;
    });
    await page.goto('/');
    await expect(page.getByTestId('login-view')).toBeVisible();

    // Clicking Sign in with Google without Client ID must NOT emit an error toast
    await page.getByTestId('google-login-btn').click();
    await expect(page.getByTestId('missing-client-id-prompt')).toBeVisible();
    await expect(page.getByTestId('oauth-setup-guide')).toBeVisible();
    await expect(page.getByTestId('oauth-guide-origin')).toContainText('http://localhost:3000');
    await expect(page.getByTestId('oauth-guide-redirect')).toContainText('http://localhost:3000/');
    await expect(page.getByTestId('oauth-setup-guide')).toContainText('drive.readonly');
    await expect(
      page.locator('[data-testid="notification-toast"][data-toast-variant="error"]')
    ).toHaveCount(0);
    await expect(page.getByTestId('notification-toast')).toHaveCount(0);
    await expect(page.getByTestId('client-id-input')).toBeFocused();

    // Check 390px mobile overflow on LoginView with guide expanded
    const loginOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(loginOverflow.scrollWidth).toBeLessThanOrEqual(loginOverflow.innerWidth);

    // Save Client ID, navigate to #/notes, trigger login() to capture return route, and verify OAuth callback restores #/notes
    await page.getByTestId('client-id-input').fill('test-m4-client.apps.googleusercontent.com');
    await page.getByTestId('client-id-save-btn').click();
    await page.evaluate(() => {
      window.location.hash = '#/notes';
    });
    await page.getByTestId('google-login-btn').click();
    const state = await page.evaluate(() => sessionStorage.getItem('pragya_oauth_csrf_state'));
    expect(state).toBeTruthy();

    await page.route('https://www.googleapis.com/**', async route => {
      const u = route.request().url();
      if (u.includes('oauth2/v3/userinfo')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ email: 'oauth-return@pragya.dev', name: 'OAuth Return Reader' }),
        });
        return;
      }
      if (u.includes('drive/v3/files')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.route('https://sheets.googleapis.com/**', async route => {
      const u = route.request().url();
      if (u.includes('fields=sheets.properties')) {
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
      if (u.includes('values:batchGet')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ valueRanges: [] }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ spreadsheetId: 'sheet-return-1' }),
      });
    });

    await page.evaluate(st => {
      window.location.hash = `#access_token=mock-tok&token_type=Bearer&expires_in=3600&state=${encodeURIComponent(
        st || ''
      )}`;
    }, state);

    await expect(page.getByTestId('notes-view')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/notes');

    // Open Settings via mobile More drawer, expand setup guide, verify zero overflow
    await page.getByTestId('bottom-nav-more').click();
    await page.getByTestId('drawer-nav-settings').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();
    await page.getByTestId('settings-oauth-guide-toggle').click();
    await expect(page.getByTestId('oauth-setup-guide')).toBeVisible();
    const settingsOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(settingsOverflow.scrollWidth).toBeLessThanOrEqual(settingsOverflow.innerWidth);
  });

  test('M4.5: Cloud offline cached read-only mode surfaces indicator and guards writes while Demo remains writable', async ({
    page,
  }) => {
    await page.route('https://www.googleapis.com/**', route => route.abort('internetdisconnected'));
    await page.route('https://sheets.googleapis.com/**', route => route.abort('internetdisconnected'));

    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token', 'offline-cached-tok');
      localStorage.setItem(
        'pragya_google_user',
        JSON.stringify({ email: 'offline@pragya.dev', name: 'Offline Cloud User' })
      );
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-offline-99');
      localStorage.setItem(
        'pragya_sheets_cache_v1',
        JSON.stringify({
          spreadsheetId: 'sheet-offline-99',
          modifiedTime: '2026-11-15T10:00:00Z',
          accountEmail: 'offline@pragya.dev',
          state: {
            books: [
              {
                id: 'book-off-1',
                title: 'Offline Cached Monograph',
                author: 'A. Reader',
                format: 'physical',
                kind: 'nonfiction',
                status: 'reading',
                currentPos: 40,
                totalPos: 200,
                posUnit: 'page',
                normalizedPos: 0.2,
                docUrl: '',
                meta: { updatedAt: '2026-11-15T10:00:00Z' },
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

    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await expect(page.getByTestId('offline-readonly-badge')).toContainText('Offline · Cached Read-Only');
    await expect(page.getByTestId('sidebar-offline-badge')).toBeVisible();
    await expect(page.getByTestId('book-card-book-off-1')).toContainText('Offline Cached Monograph');

    // Attempt bookmark advance while Cloud offline -> blocked with clear error message & unchanged state
    await page.getByTestId('advance-10p-btn-book-off-1').click();
    await expect(page.locator('[data-sonner-toast]').last()).toContainText(
      /read-only while offline/i
    );
    await expect(page.getByTestId('book-card-book-off-1')).toContainText('p. 40 / 200');

    // Check Settings offline badge
    await page.getByTestId('nav-item-settings').click();
    await expect(page.getByTestId('settings-offline-badge')).toBeVisible();

    // Switch to Demo Mode offline -> remains 100% writable
    await page.getByTestId('logout-btn').click();
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('offline-readonly-badge')).toBeHidden();
    await page.getByTestId('nav-item-shelf').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await page.getByTestId('advance-10p-btn-book-systems').click();
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 152');
  });

  test('M4.7: Silent debounced modal draft autosave, instant Escape, Discard, stale auto-clear & beforeunload', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    // QuickCapture: type draft, hit Escape (instant close, no dialog), reload, reopen -> restored!
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-takeaway-input').fill('Autosaved capture thought');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    await page.reload();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await expect(page.getByTestId('draft-restored-banner')).toBeVisible();
    await expect(page.getByTestId('capture-takeaway-input')).toHaveValue('Autosaved capture thought');

    // Discard clears draft and resets fields
    await page.getByTestId('draft-discard-btn').click();
    await expect(page.getByTestId('draft-restored-banner')).toBeHidden();
    await expect(page.getByTestId('capture-takeaway-input')).toHaveValue('');
    await page.keyboard.press('Escape');

    // EditNoteModal: edit title, close with Escape, reopen -> restored; then bump remote updatedAt -> stale draft auto-discarded
    await page.getByTestId('nav-item-notes').click();
    await page
      .getByTestId('note-card-delays-in-feedback-loops')
      .getByRole('button', { name: 'VIEW NOTE' })
      .click();
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.getByTestId('edit-note-btn').click();
    await page.getByTestId('edit-note-title-input').fill('Edited Unsaved Title');
    await page.waitForTimeout(320); // allow 250ms debounce write
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-note-modal')).toBeHidden();

    await page.getByTestId('edit-note-btn').click();
    await expect(page.getByTestId('draft-restored-banner')).toBeVisible();
    await expect(page.getByTestId('edit-note-title-input')).toHaveValue('Edited Unsaved Title');
    await page.keyboard.press('Escape');

    // Simulate remote update bumping note.updatedAt in persisted state -> stale draft auto-clears
    await page.evaluate(() => {
      const raw = localStorage.getItem('pragya_demo_state_v1');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const target = parsed.notes.find((n: { slug: string }) => n.slug === 'delays-in-feedback-loops');
      if (target) {
        target.updatedAt = '2099-12-31T00:00:00.000Z';
        localStorage.setItem('pragya_demo_state_v1', JSON.stringify(parsed));
      }
    });
    await page.reload();
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.getByTestId('edit-note-btn').click();
    await expect(page.getByTestId('draft-restored-banner')).toBeHidden();
    await expect(page.getByTestId('edit-note-title-input')).not.toHaveValue('Edited Unsaved Title');

    // Test beforeunload guard triggers while modal is open & dirty, and accept dialog to reload cleanly
    await page.getByTestId('edit-note-title-input').fill('Dirty BeforeUnload Check');
    let sawBeforeUnload = false;
    page.once('dialog', async dialog => {
      sawBeforeUnload = dialog.type() === 'beforeunload';
      await dialog.accept();
    });
    await page.reload();
    expect(sawBeforeUnload).toBe(true);
  });

  test('M4.8 & M4.9: Pre-import backup + 1-click restore in Settings, and Mark Reviewed preserves updatedAt', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('demo-login-btn').click();

    // Verify Mark Reviewed preserves note.updatedAt
    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('practice-view')).toBeVisible();
    const firstReviewBtn = page.locator('[data-testid^="shuffle-review-btn-"]').first();
    await expect(firstReviewBtn).toBeVisible();
    const reviewBtnTid = await firstReviewBtn.getAttribute('data-testid');
    const reviewedSlug = (reviewBtnTid || '').replace('shuffle-review-btn-', '');
    expect(reviewedSlug).toBeTruthy();

    const beforeUpdated = await page.evaluate(slug => {
      const raw = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      const note = raw.notes?.find((n: { slug: string }) => n.slug === slug);
      return note?.updatedAt || '';
    }, reviewedSlug);
    await firstReviewBtn.click();
    const afterNote = await page.evaluate(slug => {
      const raw = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      return raw.notes?.find((n: { slug: string }) => n.slug === slug);
    }, reviewedSlug);
    expect(afterNote.updatedAt).toBe(beforeUpdated);
    expect(afterNote.meta?.lastReviewedAt).toBeTruthy();

    // Import a minimal snapshot in Settings -> verify pre-import download button + 1-click rollback
    await page.getByTestId('nav-item-settings').click();
    const minimalSnapshot = {
      version: 1,
      exportedAt: '2026-11-16T00:00:00Z',
      books: [
        {
          id: 'book-imported-only',
          title: 'Tiny Imported Book',
          author: 'Importer',
          format: 'ebook',
          kind: 'nonfiction',
          status: 'reading',
          currentPos: 5,
          totalPos: 100,
          posUnit: 'page',
          normalizedPos: 0.05,
          docUrl: '',
          meta: {},
        },
      ],
      notes: [],
      sessions: [],
      deltaLogs: [],
    };

    await page.locator('input[type="file"]').setInputFiles({
      name: 'minimal-snapshot.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(minimalSnapshot)),
    });
    await expect(page.getByTestId('import-confirm-modal')).toBeVisible();
    await expect(page.getByTestId('import-download-backup-btn')).toBeVisible();
    await page.getByTestId('import-confirm-btn').click();
    await expect(page.getByTestId('import-confirm-modal')).toBeHidden();

    // Verify imported workspace is active
    await page.getByTestId('nav-item-shelf').click();
    await expect(page.getByTestId('book-card-book-imported-only')).toBeVisible();
    await expect(page.getByTestId('book-card-book-systems')).toBeHidden();

    // Roll back using 1-click Restore Last Pre-Import Backup
    await page.getByTestId('nav-item-settings').click();
    await expect(page.getByTestId('restore-pre-import-backup-btn')).toBeVisible();
    await page.getByTestId('restore-pre-import-backup-btn').click();

    await page.getByTestId('nav-item-shelf').click();
    await expect(page.getByTestId('book-card-book-systems')).toBeVisible();
    await expect(page.getByTestId('book-card-book-imported-only')).toBeHidden();
  });

  test('M4.6: Manifest & PWA icon assets load cleanly with zero legacy brand leaks', async ({
    page,
    request,
  }) => {
    const manifestRes = await request.get('/manifest.webmanifest');
    expect(manifestRes.status()).toBe(200);
    const manifest = await manifestRes.json();
    expect(manifest.name).toBe('Pragya');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.some((i: { src: string }) => i.src.includes('icon-192.png'))).toBe(true);
    expect(manifest.icons.some((i: { src: string }) => i.src.includes('icon-512.png'))).toBe(true);

    for (const asset of ['/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/sw.js']) {
      const res = await request.get(asset);
      expect(res.status(), `${asset} must return 200`).toBe(200);
    }

    await page.goto('/');
    const hasManifestLink = await page.evaluate(
      () => Boolean(document.querySelector('link[rel="manifest"]'))
    );
    expect(hasManifestLink).toBe(true);
  });

  test('M4.3, M4.9 & M4.2 mobile: semantic toasts, browser RowConflictError keeps modal/draft intact, and 390px EditBook/ImportConfirm zero overflow', async ({
    page,
  }) => {
    // 1. M4.3 semantic toasts in Demo Mode
    await page.goto('/');
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-takeaway-input').fill('Failure Mode analysis note');
    await page.getByTestId('capture-submit-btn').click();
    await expect(
      page.locator('[data-testid="notification-toast"][data-toast-variant="success"]').last()
    ).toBeVisible();

    // Pause an active delta -> neutral info variant
    await page.getByTestId('nav-item-practice').click();
    const firstPauseBtn = page.locator('[data-testid^="delta-pause-btn-"]').first();
    await firstPauseBtn.click();
    await expect(
      page.locator('[data-testid="notification-toast"][data-toast-variant="info"]').last()
    ).toContainText(/paused/i);

    // 2. Mobile 390x844 zero-overflow on EditBookModal & ImportConfirmModal
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('bottom-nav-shelf').click();
    await page.getByRole('button', { name: /Edit Thinking in Systems/i }).click();
    await expect(page.getByTestId('edit-book-modal')).toBeVisible();
    const editBookOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(editBookOverflow.scrollWidth).toBeLessThanOrEqual(editBookOverflow.innerWidth);
    await page.keyboard.press('Escape');

    await page.getByTestId('bottom-nav-more').click();
    await page.getByTestId('drawer-nav-settings').click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'mobile-overflow-check.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ version: 1, exportedAt: '2026-11-16T00:00:00Z', books: [], notes: [], sessions: [], deltaLogs: [] })
      ),
    });
    await expect(page.getByTestId('import-confirm-modal')).toBeVisible();
    const importOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(importOverflow.scrollWidth).toBeLessThanOrEqual(importOverflow.innerWidth);
    await page.keyboard.press('Escape');

    // 3. M4.9 browser RowConflictError toast keeps EditNoteModal open + user input & draft intact
    await page.setViewportSize({ width: 1280, height: 800 });
    const loadedBooks = [
      [
        'book-conf-1',
        'Conflict Test Book',
        'Author',
        'physical',
        'nonfiction',
        'reading',
        '50',
        '200',
        'page',
        '0.25',
        '',
        JSON.stringify({ updatedAt: '2026-11-15T10:00:00Z' }),
      ],
    ];
    const loadedNotes = [
      [
        'note-conf-1',
        'conflict-note',
        'book-conf-1',
        '2026-11-15T10:00:00Z',
        '2026-11-15T10:00:00Z',
        '40',
        '0.2',
        'saved',
        'app',
        '',
        '',
        'Original takeaway',
        '',
        '',
        '',
        '',
        'none',
        JSON.stringify({ title: 'Original Title' }),
      ],
    ];

    await page.route('https://www.googleapis.com/**', async route => {
      const u = route.request().url();
      if (u.includes('drive/v3/files/sheet-conf-e2e')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ modifiedTime: '2026-11-15T10:00:00Z' }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [] }) });
    });

    await page.route('https://sheets.googleapis.com/**', async route => {
      const u = route.request().url();
      if (u.includes('fields=sheets.properties')) {
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
      if (u.includes('values:batchGet') && u.includes('A1%3AL1')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            valueRanges: [
              { range: 'Books!A1:L1', values: [['id', 'title', 'author', 'format', 'kind', 'status', 'currentPos', 'totalPos', 'posUnit', 'normalizedPos', 'docUrl', 'metaJson']] },
              { range: 'Notes!A1:R1', values: [['id', 'slug', 'bookId', 'createdAt', 'updatedAt', 'pos', 'normalizedPos', 'status', 'source', 'tags', 'quote', 'takeaway', 'contextMechanism', 'critique', 'deltaTrigger', 'deltaAction', 'deltaStatus', 'metaJson']] },
              { range: 'Sessions!A1:G1', values: [['id', 'bookId', 'date', 'startPos', 'endPos', 'updatedAt', 'note']] },
              { range: 'DeltaLogs!A1:E1', values: [['id', 'noteId', 'date', 'outcome', 'reflection']] },
            ],
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
              { range: 'Books!A:L', values: [['id'], ...loadedBooks] },
              { range: 'Notes!A:R', values: [['id'], ...loadedNotes] },
              { range: 'Sessions!A:G', values: [['id']] },
              { range: 'DeltaLogs!A:E', values: [['id']] },
            ],
          }),
        });
        return;
      }
      if (u.includes('Notes!A%3AA')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ values: [['id'], ['note-conf-1']] }),
        });
        return;
      }
      if (u.includes('Notes!E2')) {
        // Remote row was updated on another device!
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ values: [['2099-01-01T00:00:00Z']] }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token', 'cloud-conf-tok');
      localStorage.setItem(
        'pragya_google_user',
        JSON.stringify({ email: 'conf@pragya.dev', name: 'Conflict Tester' })
      );
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-conf-e2e');
      localStorage.removeItem('pragya_sheets_cache_v1');
      window.location.hash = '#/note/conflict-note';
    });
    await page.reload();

    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.getByTestId('edit-note-btn').click();
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    await page.getByTestId('edit-note-title-input').fill('Conflicting Draft Title');
    await page.waitForTimeout(320); // persist draft
    await page.getByTestId('edit-note-submit-btn').click();

    await expect(
      page.locator('[data-testid="notification-toast"][data-toast-variant="error"]').last()
    ).toContainText(/Updated on another device/i);
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    await expect(page.getByTestId('edit-note-title-input')).toHaveValue('Conflicting Draft Title');
    const savedDraft = await page.evaluate(() => localStorage.getItem('pragya_draft_edit_note-conf-1'));
    expect(savedDraft).toContain('Conflicting Draft Title');
    await page.keyboard.press('Escape');
  });
});
