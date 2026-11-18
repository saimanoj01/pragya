import { test, expect, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';

/**
 * Tier 11 (QA, CD Batch 1b) — adversarial probes for permanent delete (C1.2):
 * exact cascade copy on a book with check-ins, shielded slug never surfaces, Undo after
 * navigation, backup download content, double-confirm, focus, and Undo across logout.
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

type Row = { id: string; bookId?: string; noteId?: string; meta?: Record<string, unknown> };
type DemoState = { books: Row[]; notes: Row[]; sessions: Row[]; deltaLogs: Row[] };

const demoState = (page: Page): Promise<DemoState> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}'));

async function archiveInState(page: Page, kind: 'books' | 'notes', id: string) {
  await page.evaluate(
    ({ kind, id }) => {
      const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      const row = s[kind].find((x: { id: string }) => x.id === id);
      row.meta = { ...(row.meta || {}), archivedAt: '2026-11-01T00:00:00.000Z' };
      localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
    },
    { kind, id }
  );
  await page.reload();
  await expect(page.getByTestId('shelf-view').or(page.getByTestId('notes-view')).first()).toBeVisible();
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const UNDO = "You can undo this for a few seconds; after that it's permanent.";
const deletedToastUndo = (page: Page, text: string) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text }).getByTestId('toast-undo-btn');

test.describe('Tier 11 — CD Batch 1b QA probes', () => {
  test('book with notes + check-ins + sessions: dialog body is EXACT; cascade removes exactly those rows', async ({ page }) => {
    await demo(page);
    const s0 = await demoState(page);
    const noteIds = s0.notes.filter(n => n.bookId === 'book-systems').map(n => n.id);
    const logs = s0.deltaLogs.filter(l => noteIds.includes(l.noteId!));
    const sessions = s0.sessions.filter(x => x.bookId === 'book-systems');
    expect(logs.length).toBeGreaterThan(0);
    expect(sessions.length).toBeGreaterThan(0);
    await archiveInState(page, 'books', 'book-systems');

    await page.getByTestId('archived-books-section').locator('summary').click();
    await page.getByTestId('archived-book-delete-btn-book-systems').click();
    const dialog = page.getByTestId('confirm-dialog');
    // CD 1b fix-up (decisions R2#1): the copy now says plainly that live notes are removed too.
    expect(noteIds.length).toBeGreaterThan(1);
    const expected =
      `This removes the book and all ${noteIds.length} of its notes (including ones still in your Notes), plus ` +
      `${plural(logs.length, 'check-in', 'check-ins')} and ` +
      `${plural(sessions.length, 'reading session', 'reading sessions')}, from this browser. ${UNDO}`;
    await expect(dialog).toContainText(expected);
    await expect(dialog).toContainText('Delete "Thinking in Systems: A Primer" forever?');
    await expect(page.getByTestId('confirm-dialog-cancel-btn')).toBeFocused();

    // Double-click confirm: busy guard → one delete, no error toast.
    await page.getByTestId('confirm-dialog-confirm-btn').dblclick();
    await expect(page.getByText('Deleted "Thinking in Systems: A Primer".')).toBeVisible();
    await expect(page.getByText(/Failed to delete/)).toHaveCount(0);
    const s1 = await demoState(page);
    expect(s1.books.map(b => b.id)).not.toContain('book-systems');
    expect(s1.notes.length).toBe(s0.notes.length - noteIds.length);
    expect(s1.deltaLogs.length).toBe(s0.deltaLogs.length - logs.length);
    expect(s1.sessions.length).toBe(s0.sessions.length - sessions.length);
    // Other books' rows untouched.
    for (const k of ['notes', 'sessions'] as const) {
      expect(s1[k].filter(x => x.bookId !== 'book-systems')).toEqual(s0[k].filter(x => x.bookId !== 'book-systems'));
    }
  });

  test('shielded archived note: Delete Forever disabled on its page, absent on its Archived card; slug never shown', async ({ page }) => {
    await demo(page);
    await archiveInState(page, 'notes', 'note-leverage-paradigm');
    await go(page, '#/note/note-leverage-paradigm');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await expect(page.getByTestId('archived-banner')).toBeVisible();
    await expect(page.getByTestId('delete-forever-btn')).toBeDisabled();
    await expect(page.locator('body')).not.toContainText('paradigm-shifts-outrank-parameters');

    await go(page, '#/notes');
    await page.getByTestId('notes-filter-archived').click();
    const shield = page.getByTestId('spoiler-shield-paradigm-shifts-outrank-parameters');
    await expect(shield).toBeVisible();
    await expect(page.getByTestId('delete-forever-btn')).toHaveCount(0);
  });

  test('Undo still restores exactly after navigating to other views', async ({ page }) => {
    await demo(page);
    await archiveInState(page, 'notes', 'note-self-organization');
    const archived = (await demoState(page)).notes.find(n => n.id === 'note-self-organization');
    await go(page, '#/note/self-organization-over-control');
    await page.getByTestId('delete-forever-btn').click();
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('practice-view')).toBeVisible();
    await page.getByTestId('nav-item-shelf').click();
    await deletedToastUndo(page, 'Deleted "Self-Organization').click();
    await expect(page.getByText('Restored "Self-Organization Over Control".')).toBeVisible();
    expect((await demoState(page)).notes.find(n => n.id === 'note-self-organization')).toEqual(archived);
    expect(await page.evaluate(() => localStorage.getItem('pragya_last_delete_backup_v1'))).toBeNull();
  });

  test('"Download a backup first" JSON contains the full workspace incl. the archived target', async ({ page }) => {
    await demo(page);
    await archiveInState(page, 'notes', 'note-self-organization');
    const s0 = await demoState(page);
    await go(page, '#/note/self-organization-over-control');
    await page.getByTestId('delete-forever-btn').click();
    const dl = page.waitForEvent('download');
    await page.getByTestId('confirm-dialog-backup-btn').click();
    const file = await (await dl).path();
    const snap = JSON.parse(fs.readFileSync(file!, 'utf8'));
    expect(snap.version).toBe(1);
    expect(snap.books.length).toBe(s0.books.length);
    expect(snap.notes.length).toBe(s0.notes.length);
    expect(snap.sessions.length).toBe(s0.sessions.length);
    expect(snap.deltaLogs.length).toBe(s0.deltaLogs.length);
    const target = snap.notes.find((n: Row) => n.id === 'note-self-organization');
    expect(target.meta.archivedAt).toBe('2026-11-01T00:00:00.000Z');
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    // Escape cancels; focus returns to the opener.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await expect(page.getByTestId('delete-forever-btn')).toBeFocused();
  });

  test('Undo toast surviving logout → Demo never writes the deleted Cloud rows into Demo or the Sheet (fails closed)', async ({ page }) => {
    const sheetsWrites: string[] = [];
    const BOOK_HEADERS = ['id', 'title', 'author', 'format', 'kind', 'status', 'currentPos', 'totalPos', 'posUnit', 'normalizedPos', 'docUrl', 'metaJson'];
    const NOTE_HEADERS = ['id', 'slug', 'bookId', 'createdAt', 'updatedAt', 'pos', 'normalizedPos', 'status', 'source', 'tags', 'quote', 'takeaway', 'contextMechanism', 'critique', 'deltaTrigger', 'deltaAction', 'deltaStatus', 'metaJson'];
    const SESSION_HEADERS = ['id', 'bookId', 'date', 'startPos', 'endPos', 'updatedAt', 'note'];
    const DELTA_HEADERS = ['id', 'noteId', 'date', 'outcome', 'reflection'];
    let loggedOut = false;
    await page.route('https://www.googleapis.com/**', (route: Route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().url().includes('drive/v3/files/sheet-qa') ? { id: 'sheet-qa', modifiedTime: '2026-11-15T10:00:00Z' } : { files: [] }) })
    );
    await page.route('https://oauth2.googleapis.com/**', route => route.fulfill({ status: 200, body: '{}' }));
    await page.route('https://sheets.googleapis.com/**', async (route: Route) => {
      const req = route.request();
      const u = req.url();
      if (loggedOut && req.method() !== 'GET') sheetsWrites.push(`${req.method()} ${decodeURIComponent(u)}`);
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (u.includes('values:batchGet')) {
        const header = u.includes('A1%3AL1');
        await json({
          valueRanges: [
            {
              range: header ? 'Books!A1:L1' : 'Books!A:L',
              values: header
                ? [BOOK_HEADERS]
                : [BOOK_HEADERS, ['book-cloud-secret', 'Cloud Secret Book', 'Author', 'physical', 'nonfiction', 'reading', '10', '200', 'page', '0.05', '', JSON.stringify({ updatedAt: '2026-11-15T10:00:00.000Z', archivedAt: '2026-11-10T00:00:00.000Z' })]],
            },
            { range: header ? 'Notes!A1:R1' : 'Notes!A:R', values: [NOTE_HEADERS] },
            { range: header ? 'Sessions!A1:G1' : 'Sessions!A:G', values: [SESSION_HEADERS] },
            { range: header ? 'DeltaLogs!A1:E1' : 'DeltaLogs!A:E', values: [DELTA_HEADERS] },
          ],
        });
        return;
      }
      // CD 1b fix-up: the atomic cascade needs real sheetIds; the old per-row path silently
      // returned "not deleted" when metadata was missing, which the atomic path now refuses.
      if (u.includes('fields=sheets.properties')) {
        await json({ sheets: ['Books', 'Notes', 'Sessions', 'DeltaLogs'].map((title, sheetId) => ({ properties: { title, sheetId } })) });
        return;
      }
      await json({});
    });
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('pragya_google_token', 'qa-tok');
      localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'reader@pragya.dev', name: 'QA' }));
      localStorage.setItem('pragya_mock_mode', 'false');
      localStorage.setItem('pragya_spreadsheet_id', 'sheet-qa');
    });
    await page.reload();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    await page.getByTestId('archived-books-section').locator('summary').click();
    await page.getByTestId('archived-book-delete-btn-book-cloud-secret').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('from your Google Sheet.');
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByText('Deleted "Cloud Secret Book".')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pragya_last_delete_backup_v1'))).toContain('book-cloud-secret');

    loggedOut = true;
    await page.getByTestId('logout-btn').first().click();
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pragya_last_delete_backup_v1')), 'logout clears the backup').toBeNull();

    const undo = deletedToastUndo(page, 'Deleted "Cloud Secret Book"');
    // CD 1b fix-up: logout now dismisses all toasts, so the Undo must be gone. The
    // fail-closed branch below is kept as defence in depth.
    await expect(undo).toHaveCount(0);
    const undoVisible = (await undo.count()) > 0;
    if (undoVisible) {
      await undo.click();
      await page.waitForTimeout(800);
      // Stale closure targets the logged-out Sheets adapter → fails closed.
      await expect(page.getByText('Not authenticated')).toBeVisible();
    }
    const s = await demoState(page);
    expect(s.books.map(b => b.id), 'real-account rows must never land in Demo').not.toContain('book-cloud-secret');
    expect(sheetsWrites, 'no Sheet writes after logout').toEqual([]);
  });
});

// ---- QA re-verify (CD 1b fix-up): stateful mocked Cloud Sheet --------------------------

const HEADERS: Record<string, string[]> = {
  Books: ['id', 'title', 'author', 'format', 'kind', 'status', 'currentPos', 'totalPos', 'posUnit', 'normalizedPos', 'docUrl', 'metaJson'],
  Notes: ['id', 'slug', 'bookId', 'createdAt', 'updatedAt', 'pos', 'normalizedPos', 'status', 'source', 'tags', 'quote', 'takeaway', 'contextMechanism', 'critique', 'deltaTrigger', 'deltaAction', 'deltaStatus', 'metaJson'],
  Sessions: ['id', 'bookId', 'date', 'startPos', 'endPos', 'updatedAt', 'note'],
  DeltaLogs: ['id', 'noteId', 'date', 'outcome', 'reflection'],
};
const SHEET_ID: Record<string, number> = { Books: 101, Notes: 102, Sessions: 103, DeltaLogs: 104 };
const ARCH_META = JSON.stringify({ updatedAt: '2026-11-15T10:00:00.000Z', archivedAt: '2026-11-10T00:00:00.000Z' });

type Sheet = Record<string, unknown[][]>;
type BatchMode = 'ok' | 'fail500' | 'applyThenDrop';

function seedSheet(): Sheet {
  return {
    Books: [
      ['book-arch', 'Archived Cloud Book', 'A', 'physical', 'nonfiction', 'reading', 10, 200, 'page', 0.05, '', ARCH_META],
      ['book-live', 'Live Cloud Book', 'A', 'physical', 'nonfiction', 'reading', 10, 200, 'page', 0.05, '', JSON.stringify({ updatedAt: '2026-11-15T10:00:00.000Z' })],
    ],
    Notes: [
      ['note-a1', 'a-one', 'book-arch', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 5, 0.025, 'saved', 'app', '', '', 'take one', '', '', '', '', 'none', JSON.stringify({ attachments: [], links: [] })],
      ['note-live', 'live', 'book-live', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 5, 0.025, 'saved', 'app', '', '', 'live take', '', '', '', '', 'none', JSON.stringify({ attachments: [], links: [] })],
    ],
    Sessions: [['sess-a1', 'book-arch', '2026-11-02', 0, 10, '2026-11-02T00:00:00Z', '']],
    DeltaLogs: [['log-a1', 'note-a1', '2026-11-03', 'applied', '']],
  };
}

async function statefulCloud(page: Page, sheet: Sheet, ctl: { batchMode: BatchMode; batchUpdates: number }) {
  await page.route('https://www.googleapis.com/**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().url().includes('drive/v3/files/sheet-st') ? { id: 'sheet-st', modifiedTime: `2026-11-15T10:00:0${ctl.batchUpdates}Z` } : { files: [] }) })
  );
  await page.route('https://oauth2.googleapis.com/**', route => route.fulfill({ status: 200, body: '{}' }));
  await page.route('https://sheets.googleapis.com/**', async (route: Route) => {
    const req = route.request();
    const href = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (href.includes('fields=sheets.properties')) {
      await json({ sheets: Object.entries(SHEET_ID).map(([title, sheetId]) => ({ properties: { title, sheetId } })) });
      return;
    }
    if (href.includes('values:batchGet')) {
      const ranges = new URL(href).searchParams.getAll('ranges');
      await json({
        valueRanges: ranges.map(r => {
          const [tab, span] = r.split('!');
          const [, end] = span.split(':');
          const all = [HEADERS[tab], ...sheet[tab]];
          if (/^[A-Z]1$/.test(end)) return { range: `${tab}!A1:${end}`, values: [HEADERS[tab]] };
          if (end === 'A') return { range: `${tab}!A1:A${all.length}`, values: all.map(x => [x[0]]) };
          return { range: `${tab}!A1:${end}${all.length}`, values: all };
        }),
      });
      return;
    }
    if (href.endsWith(':batchUpdate') && req.method() === 'POST') {
      ctl.batchUpdates += 1;
      if (ctl.batchMode === 'fail500') {
        await json({ error: { code: 500, message: 'backendError' } }, 500);
        return;
      }
      for (const r of JSON.parse(req.postData() || '{}').requests || []) {
        const range = r.deleteDimension?.range;
        if (!range) continue;
        const tab = Object.keys(SHEET_ID).find(t => SHEET_ID[t] === range.sheetId)!;
        sheet[tab].splice(range.startIndex - 1, 1);
      }
      if (ctl.batchMode === 'applyThenDrop') {
        // Server applied the batch, but the response never reached the client.
        await route.abort('connectionreset');
        return;
      }
      await json({});
      return;
    }
    const append = /\/values\/([A-Za-z]+)!A1:append/.exec(decodeURIComponent(href));
    if (append && req.method() === 'POST') {
      for (const row of JSON.parse(req.postData() || '{}').values || []) sheet[append[1]].push(row);
      await json({});
      return;
    }
    await json({});
  });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('pragya_google_token', 'qa-tok');
    localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'reader@pragya.dev', name: 'QA' }));
    localStorage.setItem('pragya_mock_mode', 'false');
    localStorage.setItem('pragya_spreadsheet_id', 'sheet-st');
  });
  await page.reload();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
}

async function openBookDelete(page: Page) {
  await page.getByTestId('archived-books-section').locator('summary').click();
  await page.getByTestId('archived-book-delete-btn-book-arch').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('from your Google Sheet.');
}

const ids = (sheet: Sheet) => Object.fromEntries(Object.entries(sheet).map(([t, rows]) => [t, rows.map(r => r[0])]));
const backupKey = (page: Page) => page.evaluate(() => localStorage.getItem('pragya_last_delete_backup_v1'));

test.describe('Tier 11 — CD 1b fix-up re-verify (stateful mocked Cloud)', () => {
  test('Cloud happy path: ONE batchUpdate removes exactly the cascade; Undo re-appends only absent rows', async ({ page }) => {
    const sheet = seedSheet();
    const ctl = { batchMode: 'ok' as BatchMode, batchUpdates: 0 };
    await statefulCloud(page, sheet, ctl);
    await openBookDelete(page);
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByText('Deleted "Archived Cloud Book".')).toBeVisible();
    expect(ctl.batchUpdates).toBe(1);
    expect(ids(sheet)).toEqual({ Books: ['book-live'], Notes: ['note-live'], Sessions: [], DeltaLogs: [] });
    expect(JSON.parse((await backupKey(page))!).confirmed).toBe(true);

    // Partial-exists: another device already re-created the session row before Undo.
    sheet.Sessions.push(['sess-a1', 'book-arch', '2026-11-02', 0, 10, '2026-11-02T00:00:00Z', 'edited elsewhere']);
    await deletedToastUndo(page, 'Deleted "Archived Cloud Book"').click();
    await expect(page.getByText(/Restored "Archived Cloud Book"\. Some parts already existed and were left as they are\./)).toBeVisible();
    expect(ids(sheet)).toEqual({ Books: ['book-live', 'book-arch'], Notes: ['note-live', 'note-a1'], Sessions: ['sess-a1'], DeltaLogs: ['log-a1'] });
    expect(sheet.Sessions[0][6], 'existing row never overwritten').toBe('edited elsewhere');
    expect(JSON.parse(String(sheet.Books[1][11])).archivedAt).toBe('2026-11-10T00:00:00.000Z');
    expect(await backupKey(page)).toBeNull();
  });

  test('QA-30: book unarchived elsewhere (CLI) after the dialog opened → refused, NO batchUpdate, nothing deleted', async ({ page }) => {
    const sheet = seedSheet();
    const ctl = { batchMode: 'ok' as BatchMode, batchUpdates: 0 };
    await statefulCloud(page, sheet, ctl);
    await openBookDelete(page);
    sheet.Books[0][11] = JSON.stringify({ updatedAt: '2026-11-16T00:00:00.000Z' }); // CLI --unarchive
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByText('"Archived Cloud Book" was restored elsewhere, so it wasn\'t deleted.')).toBeVisible();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    expect(ctl.batchUpdates).toBe(0);
    expect(ids(sheet)).toEqual(ids(seedSheet()));
    expect(await backupKey(page)).toBeNull();
    await expect(page.getByTestId('book-card-book-arch')).toBeVisible();
  });

  test('QA-31: atomic failure (500) → nothing deleted, honest toast, backup cleared, retry succeeds', async ({ page }) => {
    const sheet = seedSheet();
    const ctl = { batchMode: 'fail500' as BatchMode, batchUpdates: 0 };
    await statefulCloud(page, sheet, ctl);
    await openBookDelete(page);
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByText('Couldn\'t delete "Archived Cloud Book". Nothing was removed. Try again.')).toBeVisible();
    expect(ids(sheet)).toEqual(ids(seedSheet()));
    expect(await backupKey(page)).toBeNull();
    ctl.batchMode = 'ok';
    if (!(await page.getByTestId('confirm-dialog').count())) await openBookDelete(page);
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByText('Deleted "Archived Cloud Book".')).toBeVisible();
    expect(ids(sheet)).toEqual({ Books: ['book-live'], Notes: ['note-live'], Sessions: [], DeltaLogs: [] });
  });

  test('QA-33: batch APPLIED but response lost → must not claim "Nothing was removed" nor drop the backup', async ({ page }) => {
    const sheet = seedSheet();
    const ctl = { batchMode: 'applyThenDrop' as BatchMode, batchUpdates: 0 };
    await statefulCloud(page, sheet, ctl);
    await openBookDelete(page);
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect.poll(() => ctl.batchUpdates).toBeGreaterThan(0);
    // Wait for the outcome toast (the client sees a dropped connection).
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible({ timeout: 15000 });
    // Rows really are gone on the server:
    expect(ids(sheet).Books).toEqual(['book-live']);
    // Desired: no false "Nothing was removed" and the support backup still holds the rows.
    const backup = await backupKey(page);
    const toasts = (await page.locator('[data-sonner-toast]').allInnerTexts()).join(' | ');
    expect.soft(toasts, 'no false "Nothing was removed" claim').not.toContain('Nothing was removed');
    expect(backup, 'support backup still holds the deleted rows').toContain('book-arch');
  });
});
