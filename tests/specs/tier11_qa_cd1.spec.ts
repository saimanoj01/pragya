import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 11 (QA, CD Batch 1a) — adversarial probes for soft-archive "hidden from EVERY
 * surface" and the nested ConfirmDialog. QA-26 / QA-27 were `test.fail()` findings; fixed in
 * the CD 1a fix-up and now run as regular tests.
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

async function archiveFromNotePage(page: Page, slug: string) {
  await go(page, `#/note/${slug}`);
  await expect(page.getByTestId('note-detail-view')).toBeVisible();
  await page.getByTestId('note-detail-archive-btn').click();
  await expect(page.getByTestId('notes-view')).toBeVisible();
}

async function stubClipboard(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __copied?: string };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          w.__copied = text;
          return Promise.resolve();
        },
      },
    });
  });
}

test.describe('Tier 11 — CD Batch 1a QA probes', () => {
  test('QA-26: archived note must not appear in BookDetail "Captured Notes"', async ({ page }) => {
    await demo(page);
    await archiveFromNotePage(page, 'self-organization-over-control');
    expect((await demoNote(page, 'note-self-organization')).meta.archivedAt).toBeTruthy();
    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    // Control: a non-archived note of the same book is listed.
    await expect(page.getByTestId('note-card-delays-in-feedback-loops')).toBeVisible();
    await expect(page.getByTestId('note-card-self-organization-over-control')).toHaveCount(0);
  });

  test('QA-27: capstone Copy Prompt must exclude archived notes (CLI notesSummary parity)', async ({ page }) => {
    await demo(page);
    await archiveFromNotePage(page, 'rules-of-infinite-play');
    expect((await demoNote(page, 'note-infinite-rules')).meta.archivedAt).toBeTruthy();
    await go(page, '#/book/book-finite');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await stubClipboard(page);
    await page.getByTestId('copy-capstone-prompt-btn').click();
    await expect(page.getByText('Capstone prompt copied.', { exact: false })).toBeVisible();
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied || '');
    expect(copied).toContain('Finite and Infinite Games');
    expect(copied).not.toContain('Rules of Infinite Play');
    expect(copied).toContain('My notes (1 total, in reading order):');
  });

  test('nested ConfirmDialog in EditNoteModal: Cancel focused, backdrop ignored, Escape closes only the confirm', async ({ page }) => {
    await demo(page);
    await go(page, '#/note/delays-in-feedback-loops');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.getByTestId('edit-note-btn').click();
    const modal = page.getByTestId('edit-note-modal');
    await expect(modal).toBeVisible();
    await page.getByTestId('archive-note-btn').click();

    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('pause its delta');
    await expect(page.getByTestId('confirm-dialog-cancel-btn')).toBeFocused();

    await dialog.click({ position: { x: 4, y: 4 } });
    await expect(dialog).toBeVisible();
    await expect(modal).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(modal).toBeVisible();
    const n = await demoNote(page, 'note-delays-feedback');
    expect(n.deltaStatus).toBe('active');
    expect(n.meta?.archivedAt).toBeUndefined();

    // Confirm path from inside the modal archives + pauses, keeping other meta.
    const before = await demoNote(page, 'note-delays-feedback');
    await page.getByTestId('archive-note-btn').click();
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await expect.poll(async () => (await demoNote(page, 'note-delays-feedback')).meta?.archivedAt).toBeTruthy();
    const after = await demoNote(page, 'note-delays-feedback');
    expect(after.deltaStatus).toBe('paused');
    expect(after.meta.archivedDeltaStatus).toBe('active');
    // meta.links is excluded: updateNote (pre-existing, every write) merges attachment URLs
    // into links, and the seed note's doc attachment URL is not in its links array.
    for (const [k, v] of Object.entries(before.meta || {})) {
      if (k !== 'links') expect(after.meta[k]).toEqual(v);
    }
    expect(after.meta.links).toEqual(expect.arrayContaining(before.meta.links));
  });

  test('editing an archived note (save) keeps archivedAt and archivedDeltaStatus', async ({ page }) => {
    await demo(page);
    await go(page, '#/note/delays-in-feedback-loops');
    await page.getByTestId('note-detail-archive-btn').click();
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    const archived = await demoNote(page, 'note-delays-feedback');
    expect(archived.meta.archivedAt).toBeTruthy();

    await go(page, '#/note/delays-in-feedback-loops');
    await expect(page.getByTestId('archived-banner')).toBeVisible();
    await page.getByTestId('edit-note-btn').click();
    const modal = page.getByTestId('edit-note-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('archive-note-btn')).toHaveCount(0);
    await modal.locator('button[type="submit"]').click();
    await expect(modal).toHaveCount(0);
    const after = await demoNote(page, 'note-delays-feedback');
    expect(after.meta.archivedAt).toBe(archived.meta.archivedAt);
    expect(after.meta.archivedDeltaStatus).toBe('active');
    expect(after.deltaStatus).toBe('paused');
  });
});
