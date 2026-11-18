import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 10 (Dev, CD Batch 1b) — permanent delete from the archive (C1.2), Demo mode.
 * Delete Forever… exists only on archived items, confirms with exact cascade counts and a
 * "Download a backup first" link, and offers an 8 s Undo that restores the exact rows.
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

type DemoState = {
  books: Array<{ id: string }>;
  notes: Array<{ id: string; bookId: string }>;
  sessions: Array<{ id: string; bookId: string }>;
  deltaLogs: Array<{ id: string; noteId: string }>;
};

const demoState = (page: Page): Promise<DemoState> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}'));

test.describe('Tier 10 — CD Batch 1b permanent delete (Dev)', () => {
  test('a live (non-archived) note or book never offers Delete Forever', async ({ page }) => {
    await demo(page);
    await go(page, '#/note/self-organization-over-control');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await expect(page.getByTestId('delete-forever-btn')).toHaveCount(0);
    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await expect(page.getByTestId('delete-forever-btn')).toHaveCount(0);
  });

  test('note: archive → Delete Forever… (copy, backup download, backdrop/Escape) → delete → Undo restores it exactly', async ({ page }) => {
    await demo(page);
    const before = (await demoState(page)).notes.find(n => n.id === 'note-self-organization');
    await go(page, '#/note/self-organization-over-control');
    await page.getByTestId('note-detail-archive-btn').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    const archived = (await demoState(page)).notes.find(n => n.id === 'note-self-organization');

    await go(page, '#/note/self-organization-over-control');
    await page.getByTestId('delete-forever-btn').click();
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toContainText('Delete this note forever?');
    await expect(dialog).toContainText('from this browser.');
    await expect(dialog).toContainText('Notes linking to [[self-organization-over-control]] will show it as missing.');
    await expect(dialog).toContainText("You can undo this for a few seconds; after that it's permanent.");
    await expect(page.getByTestId('confirm-dialog-cancel-btn')).toBeFocused();
    await expect(page.getByTestId('confirm-dialog-confirm-btn')).toHaveText('Delete Note');

    // "Download a backup first" exports the snapshot and keeps the dialog open.
    const download = page.waitForEvent('download');
    await page.getByTestId('confirm-dialog-backup-btn').click();
    expect((await download).suggestedFilename()).toMatch(/^pragya-backup-\d{4}-\d{2}-\d{2}\.json$/);
    await expect(page.getByText('Downloaded a backup.')).toBeVisible();
    await expect(dialog).toBeVisible();

    // Backdrop is not an answer; Escape cancels; nothing was deleted.
    await dialog.click({ position: { x: 4, y: 4 } });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await demoState(page)).notes.some(n => n.id === 'note-self-organization')).toBe(true);

    await page.getByTestId('delete-forever-btn').click();
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await expect(page.getByText('Deleted "Self-Organization Over Control".')).toBeVisible();
    expect((await demoState(page)).notes.some(n => n.id === 'note-self-organization')).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('pragya_last_delete_backup_v1'))).toContain('note-self-organization');

    // The archive toast's Undo may still be on screen: use the one on the Deleted toast.
    await page.locator('[data-sonner-toast]').filter({ hasText: 'Deleted "Self-Organization' }).getByTestId('toast-undo-btn').click();
    await expect(page.getByText('Restored "Self-Organization Over Control".')).toBeVisible();
    const restored = (await demoState(page)).notes.find(n => n.id === 'note-self-organization');
    expect(restored).toEqual(archived);
    expect(restored).not.toEqual(before); // still archived, exactly as it was when deleted
  });

  test('book: Delete Forever… from the Shelf archive cascades with exact counts; Undo restores every row', async ({ page }) => {
    await demo(page);
    const s0 = await demoState(page);
    const noteIds = s0.notes.filter(n => n.bookId === 'book-lathe').map(n => n.id);
    const logs = s0.deltaLogs.filter(l => noteIds.includes(l.noteId));
    const sessions = s0.sessions.filter(x => x.bookId === 'book-lathe');
    expect(noteIds.length).toBeGreaterThan(0);

    // Archive the book from EditBookModal.
    await go(page, '#/book/book-lathe');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('e');
    await page.getByTestId('archive-book-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    const s1 = await demoState(page);

    await page.getByTestId('archived-books-section').locator('summary').click();
    await page.getByTestId('archived-book-delete-btn-book-lathe').click();
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toContainText('Delete "The Lathe of Heaven" forever?');
    // R2#1: the copy says plainly that live notes go too.
    await expect(dialog).toContainText(
      noteIds.length === 1
        ? "the book and its 1 note (even though it's still in your Notes)"
        : `the book and all ${noteIds.length} of its notes (including ones still in your Notes)`
    );
    if (logs.length) await expect(dialog).toContainText(`${logs.length} check-in`);
    if (sessions.length) await expect(dialog).toContainText(`${sessions.length} reading session`);
    await expect(dialog).toContainText('from this browser.');
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByText('Deleted "The Lathe of Heaven".')).toBeVisible();

    const s2 = await demoState(page);
    expect(s2.books.some(b => b.id === 'book-lathe')).toBe(false);
    expect(s2.notes.filter(n => noteIds.includes(n.id))).toEqual([]);
    expect(s2.sessions.filter(x => x.bookId === 'book-lathe')).toEqual([]);
    expect(s2.deltaLogs.filter(l => noteIds.includes(l.noteId))).toEqual([]);
    // Other books' rows untouched.
    expect(s2.books.length).toBe(s1.books.length - 1);
    await expect(page.getByTestId('archived-books-section')).toHaveCount(0);

    await page.locator('[data-sonner-toast]').filter({ hasText: 'Deleted "The Lathe' }).getByTestId('toast-undo-btn').click();
    await expect(page.getByText('Restored "The Lathe of Heaven".')).toBeVisible();
    const s3 = await demoState(page);
    const sortById = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
    expect(sortById(s3.books)).toEqual(sortById(s1.books));
    expect(sortById(s3.notes)).toEqual(sortById(s1.notes));
    expect(sortById(s3.sessions)).toEqual(sortById(s1.sessions));
    expect(sortById(s3.deltaLogs)).toEqual(sortById(s1.deltaLogs));
    await expect(page.getByTestId('archived-book-row-book-lathe')).toBeAttached();
  });

  test('Notes "Archived" pill offers Delete Forever… per card and removes the card', async ({ page }) => {
    await demo(page);
    await go(page, '#/note/self-organization-over-control');
    await page.getByTestId('note-detail-archive-btn').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await page.getByTestId('notes-filter-archived').click();
    const card = page.getByTestId('note-card-self-organization-over-control');
    await card.getByTestId('delete-forever-btn').click();
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(card).toHaveCount(0);
    expect((await demoState(page)).notes.some(n => n.id === 'note-self-organization')).toBe(false);
  });
});
