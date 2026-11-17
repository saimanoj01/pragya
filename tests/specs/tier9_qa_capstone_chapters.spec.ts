import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 9 (QA, M6 Batch 7): capstone save never wipes other meta keys; the `C` shortcut never
 * fires from inside an input; chapter dividers never leak a shielded note's chapter.
 */

async function demo(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-login-btn').click();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
}

async function patchDemo(page: Page, fn: string) {
  await page.evaluate(src => {
    const state = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
    new Function('state', src)(state);
    localStorage.setItem('pragya_demo_state_v1', JSON.stringify(state));
  }, fn);
  await page.reload();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
}

async function goBook(page: Page, id: string) {
  await page.evaluate(b => {
    window.location.hash = `#/book/${b}`;
  }, id);
  await expect(page.getByTestId('book-detail-view')).toBeVisible();
}

test.describe('Tier 9 — capstone & chapters (QA)', () => {
  test('saving a capstone keeps every other book meta key (ownedMetaKeys)', async ({ page }) => {
    await demo(page);
    await patchDemo(page, `
      const b = state.books.find(x => x.id === 'book-finite');
      b.meta = { ...b.meta, subgenre: 'philosophy', agentState: { spar: 2 }, currentChapter: 'Coda' };
    `);
    await goBook(page, 'book-finite');
    await page.getByTestId('capstone-write-btn').click();
    await page.getByTestId('capstone-arc-input').fill('Play to keep playing.');
    await page.getByTestId('capstone-learnings-input').fill('- one\n- two');
    await page.getByTestId('capstone-shift-input').fill('I notice matches now.');
    await page.getByTestId('capstone-save-btn').click();
    await expect(page.getByTestId('capstone-card')).toBeVisible();
    const meta = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      return state.books.find((b: { id: string }) => b.id === 'book-finite').meta;
    });
    expect(meta.subgenre).toBe('philosophy');
    expect(meta.agentState).toEqual({ spar: 2 });
    expect(meta.currentChapter).toBe('Coda');
    expect(meta.capstone.keyLearnings).toEqual(['one', 'two']);
    expect(meta.capstone.arcOrThesis).toBe('Play to keep playing.');
  });

  test('`C` opens the capstone editor from the page but never from inside a text input', async ({ page }) => {
    await demo(page);
    await goBook(page, 'book-finite');
    await page.keyboard.press('n');
    const capture = page.getByTestId('quick-capture-modal');
    await expect(capture).toBeVisible();
    await page.getByTestId('capture-takeaway-input').fill('');
    await page.getByTestId('capture-takeaway-input').pressSequentially('cccc');
    await expect(page.getByTestId('capture-takeaway-input')).toHaveValue('cccc');
    await expect(page.getByTestId('capstone-modal')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(capture).toHaveCount(0);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('c');
    await expect(page.getByTestId('capstone-modal')).toBeVisible();
    // Typing inside the capstone editor doesn't re-trigger anything.
    await page.getByTestId('capstone-arc-input').pressSequentially('ccc');
    await expect(page.getByTestId('capstone-arc-input')).toHaveValue('ccc');
  });

  test('chapter dividers and chips never reveal a shielded note\'s chapter on BookDetail', async ({ page }) => {
    await demo(page);
    await patchDemo(page, `
      const set = (id, ch) => { const n = state.notes.find(x => x.id === id); n.meta = { ...(n.meta || {}), chapter: ch }; };
      set('note-self-organization', '2');          // p.78  visible
      set('note-delays-feedback', '5');            // p.142 visible (at bookmark)
      set('note-leverage-paradigm', 'SECRET_CHAPTER_X'); // p.210 shielded (bookmark p.142)
    `);
    await goBook(page, 'book-systems');
    const html = await page.content();
    expect(html).not.toContain('SECRET_CHAPTER_X');
    await expect(page.getByTestId('spoiler-shield-paradigm-shifts-outrank-parameters')).toBeVisible();
    await page.getByTestId('spoiler-reveal-btn-paradigm-shifts-outrank-parameters').click();
    await expect(page.getByText('SECRET_CHAPTER_X', { exact: false }).first()).toBeVisible();
  });
});
