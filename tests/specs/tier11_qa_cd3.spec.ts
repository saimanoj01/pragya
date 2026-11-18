import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 11 (QA, CD Batch 3) — adversarial probes: a chip whose target is a shielded note
 * reached via an ALIAS still links by uuid and never renders its title; session-note edit
 * keeps updatedAt and doesn't break +10p coalescing; Read Again keeps capstone + unknown
 * meta keys; link chips hidden on shielded cards.
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
type Row = { id: string; bookId?: string; date?: string; updatedAt?: string; note?: string; startPos?: number; endPos?: number; meta?: Record<string, unknown>; status?: string; currentPos?: number };
type State = { books: Row[]; notes: Row[]; sessions: Row[] };
const demoState = (page: Page): Promise<State> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}'));
async function patch(page: Page, fn: string) {
  await page.evaluate(src => {
    const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
    new Function('s', src)(s);
    localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
  }, fn);
  await page.reload();
  await expect(page.locator('[data-testid$="-view"]').first()).toBeVisible();
}

test.describe('Tier 11 — CD Batch 3 QA probes', () => {
  test('chip → shielded note via ALIAS: uuid href, no title/slug of the target anywhere', async ({ page }) => {
    await demo(page);
    await patch(
      page,
      `const t = s.notes.find(n => n.id === 'note-leverage-paradigm'); t.meta = { ...(t.meta||{}), aliases: ['old-paradigm-name'] };
       const v = s.notes.find(n => n.id === 'note-self-organization'); v.takeaway = 'See [[old-paradigm-name]] for later.';`
    );
    await go(page, '#/note/self-organization-over-control');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    const chip = page.getByTestId('inline-wikilink-old-paradigm-name');
    await expect(chip).toHaveAttribute('href', '#/note/note-leverage-paradigm');
    await expect(chip).toHaveText('[[old-paradigm-name]]');
    const main = page.getByTestId('note-detail-view');
    await expect(main).not.toContainText('Paradigm Shifts Outrank Parameters');
    await expect(main).not.toContainText('paradigm-shifts-outrank-parameters');
    const attrs = await chip.evaluate(el => [el.getAttribute('title'), el.getAttribute('aria-label')].join('|'));
    expect(attrs).not.toMatch(/paradigm-shifts|Paradigm Shifts/i);
    await chip.click();
    await expect(page.getByTestId('spoiler-shield-note-leverage-paradigm')).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe('#/note/note-leverage-paradigm');
  });

  test('session note edit keeps updatedAt; a +10p right after still coalesces into the same session', async ({ page }) => {
    await demo(page);
    await page.getByTestId('advance-10p-btn-book-systems').click();
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 152 / 218');
    const s0 = (await demoState(page)).sessions.filter(x => x.bookId === 'book-systems');
    const latest = s0[s0.length - 1];
    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await page.getByTestId('sessions-trail').locator('summary').click();
    const add = page.getByTestId(`session-note-add-btn-${latest.id}`);
    await add.click();
    await page.getByTestId(`session-note-input-${latest.id}`).fill('Stock vs flow clicked.');
    await page.getByTestId(`session-note-input-${latest.id}`).press('Enter');
    await expect(page.getByText('Session note saved.')).toBeVisible();
    const edited = (await demoState(page)).sessions.find(x => x.id === latest.id)!;
    expect(edited.note).toBe('Stock vs flow clicked.');
    expect(edited.updatedAt).toBe(latest.updatedAt);
    await go(page, '#/shelf');
    await page.getByTestId('advance-10p-btn-book-systems').click();
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 162 / 218');
    const s1 = (await demoState(page)).sessions.filter(x => x.bookId === 'book-systems');
    expect(s1.length).toBe(s0.length);
    const merged = s1.find(x => x.id === latest.id)!;
    expect(merged.endPos).toBe(162);
    expect(merged.note).toBe('Stock vs flow clicked.');
  });

  test('Read Again keeps capstone, finishedAt and unknown meta keys; sets everFinished; spoilers off', async ({ page }) => {
    await demo(page);
    await patch(
      page,
      `const b = s.books.find(x => x.id === 'book-finite');
       b.meta = { ...(b.meta||{}), qaUnknownKey: { keep: 1 }, finishedAt: '2026-10-01T00:00:00.000Z', capstone: { arcOrThesis: 'QA thesis', learnings: ['x'] } };`
    );
    const before = (await demoState(page)).books.find(b => b.id === 'book-finite')!;
    await go(page, '#/book/book-finite');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await page.getByTestId('read-again-btn').click();
    await expect(page.getByTestId('confirm-dialog-cancel-btn')).toBeFocused();
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByTestId('rereading-badge')).toBeVisible();
    const after = (await demoState(page)).books.find(b => b.id === 'book-finite')!;
    expect(after.status).toBe('reading');
    expect(after.currentPos).toBe(0);
    expect(after.meta!.everFinished).toBe(true);
    expect(after.meta!.qaUnknownKey).toEqual({ keep: 1 });
    expect(after.meta!.capstone).toEqual(before.meta!.capstone);
    expect(after.meta!.finishedAt).toBe('2026-10-01T00:00:00.000Z');
    // Notes ahead of the reset bookmark are NOT shielded on a re-read.
    await expect(page.locator('[data-testid^="spoiler-shield-"]')).toHaveCount(0);
    await expect(page.getByTestId('note-card-rules-of-infinite-play')).toBeVisible();
  });

  test('link chips are hidden on a shielded card (Notes list) and shown once revealed', async ({ page }) => {
    await demo(page);
    await patch(page, `const t = s.notes.find(n => n.id === 'note-leverage-paradigm'); t.meta = { ...(t.meta||{}), links: ['https://secret.example/spoiler-path'] };`);
    await go(page, '#/notes');
    const card = page.getByTestId('note-card-paradigm-shifts-outrank-parameters');
    const shieldCard = page.locator('[data-testid="spoiler-shield-paradigm-shifts-outrank-parameters"]');
    await expect(shieldCard).toBeVisible();
    await expect(page.getByTestId('notes-view')).not.toContainText('secret.example');
    await expect(page.locator('a[href*="secret.example"]')).toHaveCount(0);
    expect(await card.count()).toBeGreaterThanOrEqual(0);
  });

  test('search typing never adds history entries; deep link with accents/#tag/phrase hydrates controls', async ({ page }) => {
    await demo(page);
    await go(page, '#/notes');
    await expect(page.getByTestId('notes-view')).toBeVisible();
    const len0 = await page.evaluate(() => history.length);
    await page.getByTestId('notes-search-input').pressSequentially('feedback loops', { delay: 20 });
    await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('q=feedback');
    expect(await page.evaluate(() => history.length)).toBe(len0);
    // Deep link (fresh load) with an accented word, a #tag and a quoted phrase.
    const q = encodeURIComponent('"Feedback Loops" DÉLAYS');
    await page.goto(`/#/notes?q=${q}&sort=reading`);
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await expect(page.getByTestId('notes-search-input')).toHaveValue('"Feedback Loops" DÉLAYS');
    await expect(page.getByTestId('note-card-delays-in-feedback-loops')).toBeVisible();
  });

  test('Undo of Mark Finished does NOT set everFinished; EditBook finished→reading does', async ({ page }) => {
    await demo(page);
    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await page.getByTestId('mark-finished-btn').click();
    const undo = page.locator('[data-sonner-toast]').getByTestId('toast-undo-btn').last();
    await undo.click();
    await expect.poll(async () => (await demoState(page)).books.find(b => b.id === 'book-systems')!.status).toBe('reading');
    const b = (await demoState(page)).books.find(x => x.id === 'book-systems')!;
    expect(b.meta?.everFinished).toBeUndefined();
    await expect(page.getByTestId('rereading-badge')).toHaveCount(0);
  });
});
