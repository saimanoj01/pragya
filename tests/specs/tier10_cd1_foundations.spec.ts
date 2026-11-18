import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Tier 10 (Dev, CD Batch 1a) — data-safe foundations in Demo mode (plus a mocked Cloud
 * session for the logout-with-drafts confirmation). No real Google calls.
 *  - C1.1 soft-archive: note (plain + active-delta confirm), book, archived lists, banner
 *  - C1.3 Settings / logout confirmations; per-account draft scopes (Demo never sees or wipes real drafts)
 *  - C5 shuffle provenance line
 */

async function demo(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-login-btn').click();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
}

async function go(page: Page, hash: string) {
  await page.evaluate(h => {
    window.location.hash = h;
  }, hash);
}

const demoNote = (page: Page, id: string) =>
  page.evaluate(i => {
    const state = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
    return state.notes.find((n: { id: string }) => n.id === i);
  }, id);

const demoBook = (page: Page, id: string) =>
  page.evaluate(i => {
    const state = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
    return state.books.find((b: { id: string }) => b.id === i);
  }, id);

test.describe('Tier 10 — CD Batch 1a foundations (Dev)', () => {
  test('archive a note from its page → hidden from Notes/search/palette, Archived pill, Undo, direct link banner, Restore', async ({ page }) => {
    await demo(page);
    await go(page, '#/note/self-organization-over-control');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.getByTestId('note-detail-archive-btn').click();

    await expect(page.getByTestId('notes-view')).toBeVisible();
    await expect(page.getByText('Archived "Self-Organization Over Control".')).toBeVisible();
    await expect(page.getByTestId('note-card-self-organization-over-control')).toHaveCount(0);
    expect((await demoNote(page, 'note-self-organization')).meta.archivedAt).toBeTruthy();

    await page.getByTestId('notes-search-input').fill('self-organization');
    await expect(page.getByTestId('note-card-self-organization-over-control')).toHaveCount(0);
    await page.getByTestId('notes-search-input').fill('');

    await page.keyboard.press('Control+k');
    await page.getByTestId('command-palette-input').fill('Self-Organization');
    await expect(page.getByTestId('command-palette-item-note-self-organization-over-control')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Archived pill shows it with the compact banner; Restore brings it back.
    await page.getByTestId('notes-filter-archived').click();
    const card = page.getByTestId('note-card-self-organization-over-control');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('archived-banner')).toContainText('Hidden from your Shelf, Notes, and search.');

    // Direct link still resolves, with the banner.
    await go(page, '#/note/self-organization-over-control');
    await expect(page.getByTestId('archived-banner')).toBeVisible();
    await expect(page.getByTestId('note-detail-archive-btn')).toHaveCount(0);
    await page.getByTestId('restore-btn').click();
    await expect(page.getByText('Restored "Self-Organization Over Control".')).toBeVisible();
    await expect(page.getByTestId('archived-banner')).toHaveCount(0);
    expect((await demoNote(page, 'note-self-organization')).meta.archivedAt).toBeUndefined();
  });

  test('Undo on the archive toast restores the note exactly (other meta keys kept)', async ({ page }) => {
    await demo(page);
    const before = await demoNote(page, 'note-self-organization');
    await go(page, '#/note/self-organization-over-control');
    await page.getByTestId('note-detail-archive-btn').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await page.getByTestId('toast-undo-btn').click();
    await expect(page.getByTestId('note-card-self-organization-over-control')).toBeVisible();
    const after = await demoNote(page, 'note-self-organization');
    expect(after.meta.archivedAt).toBeUndefined();
    const strip = (m: Record<string, unknown>) => {
      const rest = { ...m };
      delete rest.updatedAt;
      return rest;
    };
    expect(strip(after.meta)).toEqual(strip(before.meta));
    expect(after.deltaStatus).toBe(before.deltaStatus);
  });

  test('archiving a note with an ACTIVE delta asks first (Cancel focused, backdrop ignored) and pauses it; Restore reactivates', async ({ page }) => {
    await demo(page);
    // Control: the active delta is on Practice before archiving.
    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('delta-card-note-delays-feedback')).toBeVisible();
    await go(page, '#/note/delays-in-feedback-loops');
    await page.getByTestId('note-detail-archive-btn').click();
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toContainText('Archive this note and pause its delta?');
    await expect(page.getByTestId('confirm-dialog-cancel-btn')).toBeFocused();
    // Backdrop tap is not an answer.
    await dialog.click({ position: { x: 4, y: 4 } });
    await expect(dialog).toBeVisible();
    // Escape = Cancel (no-op).
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await demoNote(page, 'note-delays-feedback')).deltaStatus).toBe('active');

    await page.getByTestId('note-detail-archive-btn').click();
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    const archived = await demoNote(page, 'note-delays-feedback');
    expect(archived.deltaStatus).toBe('paused');
    expect(archived.meta.archivedDeltaStatus).toBe('active');

    // Practice no longer lists it.
    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('practice-view')).toBeVisible();
    await expect(page.getByTestId('delta-card-note-delays-feedback')).toHaveCount(0);

    await go(page, '#/note/delays-in-feedback-loops');
    await page.getByTestId('restore-btn').click();
    await expect(page.getByTestId('archived-banner')).toHaveCount(0);
    const restored = await demoNote(page, 'note-delays-feedback');
    expect(restored.deltaStatus).toBe('active');
    expect(restored.meta.archivedDeltaStatus).toBeUndefined();
  });

  test('archive a book from EditBookModal → leaves the Shelf + capture picker, sits in Archived (N), banner on its page, Restore', async ({ page }) => {
    await demo(page);
    await go(page, '#/book/book-lathe');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('e');
    await expect(page.getByTestId('edit-book-modal')).toBeVisible();
    await page.getByTestId('archive-book-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await expect(page.getByText('Archived "The Lathe of Heaven".')).toBeVisible();
    await expect(page.getByTestId('book-card-book-lathe')).toHaveCount(0);
    expect((await demoBook(page, 'book-lathe')).meta.archivedAt).toBeTruthy();

    const section = page.getByTestId('archived-books-section');
    await expect(section).toContainText('Archived (1)');
    await section.locator('summary').click();
    await expect(page.getByTestId('archived-book-row-book-lathe')).toBeVisible();

    // Not offered for capture.
    await page.getByTestId('add-book-btn').focus();
    await page.keyboard.press('Escape');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await expect(page.getByTestId('capture-book-select').locator('option[value="book-lathe"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await go(page, '#/book/book-lathe');
    // R2#2: the book variant says its notes stay in Notes.
    await expect(page.getByTestId('archived-banner')).toContainText('Hidden from your Shelf and search. Its notes stay in Notes.');
    await page.getByTestId('restore-btn').click();
    await expect(page.getByTestId('archived-banner')).toHaveCount(0);
    await go(page, '#/shelf');
    await expect(page.getByTestId('book-card-book-lathe')).toBeVisible();
    await expect(page.getByTestId('archived-books-section')).toHaveCount(0);
  });

  test('Settings: Reset Demo Data asks first and Cancel is a no-op', async ({ page }) => {
    await demo(page);
    await go(page, '#/note/self-organization-over-control');
    await page.getByTestId('note-detail-archive-btn').click();
    await page.getByTestId('nav-item-settings').click();
    await page.getByTestId('reset-demo-btn').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText(
      'This replaces everything in Demo mode with the original sample books and notes.'
    );
    await page.getByTestId('confirm-dialog-cancel-btn').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    expect((await demoNote(page, 'note-self-organization')).meta.archivedAt).toBeTruthy();
    await page.getByTestId('reset-demo-btn').click();
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect.poll(async () => (await demoNote(page, 'note-self-organization')).meta.archivedAt).toBeUndefined();
  });

  test('Takeaway Shuffle cards show a quiet provenance line (never "days ago")', async ({ page }) => {
    await demo(page);
    await page.getByTestId('nav-item-practice').click();
    const lines = page.locator('[data-testid^="shuffle-provenance-"]');
    const n = await lines.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i += 1) {
      await expect(lines.nth(i)).toHaveText(/^(First revisit · saved [A-Z][a-z]{2} \d{4}|Last revisited [A-Z][a-z]{2} \d+)$/);
    }
  });
});

// ---- Cloud (mocked) logout-with-drafts confirmation ----------------------------------

const BOOK_HEADERS = ['id', 'title', 'author', 'format', 'kind', 'status', 'currentPos', 'totalPos', 'posUnit', 'normalizedPos', 'docUrl', 'metaJson'];
const NOTE_HEADERS = ['id', 'slug', 'bookId', 'createdAt', 'updatedAt', 'pos', 'normalizedPos', 'status', 'source', 'tags', 'quote', 'takeaway', 'contextMechanism', 'critique', 'deltaTrigger', 'deltaAction', 'deltaStatus', 'metaJson'];
const SESSION_HEADERS = ['id', 'bookId', 'date', 'startPos', 'endPos', 'updatedAt', 'note'];
const DELTA_HEADERS = ['id', 'noteId', 'date', 'outcome', 'reflection'];

/** Draft keys are scoped per account (`pragya_draft:<scope>:<logical key>`). */
const draftKeysEndingWith = (page: Page, suffix: string) =>
  page.evaluate(sfx => Object.keys(localStorage).filter(k => k.endsWith(sfx)), suffix);

async function cloudSession(page: Page, sheetId: string, email: string) {
  await page.route('https://www.googleapis.com/**', async (route: Route) => {
    const u = route.request().url();
    const body = u.includes(`drive/v3/files/${sheetId}`) ? { id: sheetId, modifiedTime: '2026-11-15T10:00:00Z' } : { files: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://oauth2.googleapis.com/**', route => route.fulfill({ status: 200, body: '{}' }));
  await page.route('https://sheets.googleapis.com/**', async (route: Route) => {
    const u = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.includes('fields=sheets.properties')) {
      await json({ sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map(title => ({ properties: { title } })) });
      return;
    }
    if (u.includes('values:batchGet')) {
      const header = u.includes('A1%3AL1');
      await json({
        valueRanges: [
          {
            range: header ? 'Books!A1:L1' : 'Books!A:L',
            values: header
              ? [BOOK_HEADERS]
              : [BOOK_HEADERS, ['book-t10', 'Cloud Book', 'Author', 'physical', 'nonfiction', 'reading', '10', '200', 'page', '0.05', '', JSON.stringify({ updatedAt: '2026-11-15T10:00:00.000Z' })]],
          },
          { range: header ? 'Notes!A1:R1' : 'Notes!A:R', values: [NOTE_HEADERS] },
          { range: header ? 'Sessions!A1:G1' : 'Sessions!A:G', values: [SESSION_HEADERS] },
          { range: header ? 'DeltaLogs!A1:E1' : 'DeltaLogs!A:E', values: [DELTA_HEADERS] },
        ],
      });
      return;
    }
    await json({});
  });
  await page.goto('/');
  await page.evaluate(
    ({ sheetId, email }) => {
      localStorage.setItem('pragya_google_token', 'tier10-tok');
      localStorage.setItem('pragya_google_user', JSON.stringify({ email, name: 'Tier10' }));
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', sheetId);
      localStorage.removeItem('pragya_google_token_expires_at');
    },
    { sheetId, email }
  );
  await page.reload();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
}

test.describe('Tier 10 — logout with unsaved drafts (mocked Cloud)', () => {
  test('no drafts → one-click logout; drafts → confirm (tones, Cancel no-op, Log Out keeps drafts + marker, Discard clears)', async ({ page }) => {
    await cloudSession(page, 'sheet-t10', 'reader@pragya.dev');

    // Make a real capture draft through the UI (scoped to this account).
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('n');
    await page.getByTestId('capture-takeaway-input').fill('REAL ACCOUNT DRAFT');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-capture-modal')).toHaveCount(0);
    const scoped = await draftKeysEndingWith(page, ':pragya_draft_capture_v1');
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatch(/^pragya_draft:u[0-9a-z]+:pragya_draft_capture_v1$/);
    expect(scoped[0]).not.toContain('reader@');

    await page.getByTestId('logout-btn').first().click();
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toContainText('Log out with unsaved drafts?');
    await expect(dialog).toContainText('(a capture)');
    await expect(dialog).toContainText("They'll stay on this device for when you sign back in.");
    await expect(dialog).toContainText("If a different account signs in on this browser, they'll be cleared.");
    // R2#1: the data-losing choice carries the negative style, "Log Out" does not.
    await expect(page.getByTestId('confirm-dialog-secondary-btn')).toHaveClass(/text-negative/);
    await expect(page.getByTestId('confirm-dialog-confirm-btn')).not.toHaveClass(/text-negative/);
    await page.getByTestId('confirm-dialog-cancel-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    // Log Out keeps drafts and the last-account marker.
    await page.getByTestId('logout-btn').first().click();
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByTestId('demo-login-btn')).toBeVisible();
    expect(await draftKeysEndingWith(page, ':pragya_draft_capture_v1')).toEqual(scoped);
    expect(await page.evaluate(() => localStorage.getItem('pragya_last_account_email'))).toBe('reader@pragya.dev');

    // QA-28 / R1#1: Demo neither shows nor wipes them; Demo logout clears only Demo drafts.
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await expect(page.getByTestId('draft-restored-banner')).toHaveCount(0);
    await expect(page.getByTestId('capture-takeaway-input')).toHaveValue('');
    expect(await page.content()).not.toContain('REAL ACCOUNT DRAFT');
    await page.getByTestId('capture-takeaway-input').fill('demo scratch');
    await page.keyboard.press('Escape');
    expect(await draftKeysEndingWith(page, 'pragya_draft:demo:pragya_draft_capture_v1')).toHaveLength(1);
    await page.getByTestId('logout-btn').first().click();
    await expect(page.getByTestId('demo-login-btn')).toBeVisible();
    expect(await draftKeysEndingWith(page, 'pragya_draft:demo:pragya_draft_capture_v1')).toHaveLength(0);
    expect(await draftKeysEndingWith(page, ':pragya_draft_capture_v1')).toEqual(scoped);

    // Signing back in as the same account restores the draft.
    await cloudSession(page, 'sheet-t10', 'reader@pragya.dev');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('n');
    await expect(page.getByTestId('draft-restored-banner')).toBeVisible();
    await expect(page.getByTestId('capture-takeaway-input')).toHaveValue('REAL ACCOUNT DRAFT');
    await page.keyboard.press('Escape');

    // "Discard drafts and log out" clears them.
    await page.getByTestId('logout-btn').first().click();
    await page.getByTestId('confirm-dialog-secondary-btn').click();
    await expect(page.getByTestId('demo-login-btn')).toBeVisible();
    expect(await draftKeysEndingWith(page, ':pragya_draft_capture_v1')).toHaveLength(0);

    // No drafts → no dialog.
    await cloudSession(page, 'sheet-t10', 'reader@pragya.dev');
    await page.getByTestId('logout-btn').first().click();
    await expect(page.getByTestId('demo-login-btn')).toBeVisible();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  });

  test('legacy unscoped drafts are adopted by the matching real account, never by Demo', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('pragya_last_account_email', 'reader@pragya.dev');
      localStorage.setItem('pragya_draft_edit_note-legacy', JSON.stringify({ title: 'LEGACY EDIT' }));
    });
    await page.reload();
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    // Demo leaves the legacy key alone (not adopted, not wiped).
    expect(await page.evaluate(() => localStorage.getItem('pragya_draft_edit_note-legacy'))).toContain('LEGACY EDIT');
    expect(await draftKeysEndingWith(page, 'pragya_draft:demo:pragya_draft_edit_note-legacy')).toHaveLength(0);
    await page.getByTestId('logout-btn').first().click();
    await expect(page.getByTestId('demo-login-btn')).toBeVisible();

    await cloudSession(page, 'sheet-t10', 'reader@pragya.dev');
    expect(await page.evaluate(() => localStorage.getItem('pragya_draft_edit_note-legacy'))).toBeNull();
    const adopted = await draftKeysEndingWith(page, ':pragya_draft_edit_note-legacy');
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatch(/^pragya_draft:u[0-9a-z]+:/);
  });
});
