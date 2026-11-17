import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 8 (Dev, M6 Batch 7) — Whole-Book Picture (capstone) + Chapter / Story in the PWA.
 * Demo seed: `book-finite` is finished with 2 atomic notes and no capstone; `book-systems`
 * is reading at p. 142. Everything here is offline string work: no AI call, no network.
 */

async function demo(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-login-btn').click();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
}

async function goBook(page: Page, id: string) {
  await page.evaluate(b => {
    window.location.hash = `#/book/${encodeURIComponent(b)}`;
  }, id);
  await expect(page.getByTestId('book-detail-view')).toBeVisible();
}

async function stubClipboard(page: Page, mode: 'ok' | 'fail') {
  await page.evaluate(m => {
    const w = window as unknown as { __copied?: string };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          if (m === 'fail') return Promise.reject(new Error('denied'));
          w.__copied = text;
          return Promise.resolve();
        },
      },
    });
  }, mode);
}

const REPLY = [
  'Here is a draft:',
  '',
  'THESIS: Finite games are played to win; infinite games are played to keep playing.',
  'KEY LEARNINGS:',
  '- Titles are backward-looking.',
  '- Play, not power.',
  'HOW MY THINKING SHIFTED: I notice when I treat a relationship like a match.',
  '',
  '(Optional: what will you do differently?)',
].join('\n');

test.describe('Tier 8 — Whole-Book Picture & chapters (Dev, Batch 7)', () => {
  test('finished book: quiet empty state → Copy prompt (success + fallback) → paste-back → save → card; C reopens', async ({ page }) => {
    await demo(page);
    await goBook(page, 'book-finite');

    const empty = page.getByTestId('capstone-empty-state');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("While it's fresh, you can capture the shape of this book in a few lines. Entirely optional.");
    await expect(page.getByTestId('capstone-card')).toHaveCount(0);

    // Copy success: prompt built from this book's own notes only.
    await stubClipboard(page, 'ok');
    await page.getByTestId('copy-capstone-prompt-btn').click();
    await expect(page.getByText('Capstone prompt copied.', { exact: false })).toBeVisible();
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied || '');
    expect(copied).toContain('I just finished reading "Finite and Infinite Games" by James P. Carse (Non-fiction).');
    expect(copied).toContain('THESIS: <2–3 sentences');
    expect(copied).toContain('My notes (2 total, in reading order):');
    expect(copied).not.toContain('Delays in Feedback Loops');

    // Copy failure → select-and-copy fallback modal; Escape closes it.
    await stubClipboard(page, 'fail');
    await page.getByTestId('copy-capstone-prompt-btn').click();
    const fallback = page.getByTestId('capstone-prompt-fallback-modal');
    await expect(fallback).toBeVisible();
    await expect(fallback.locator('textarea')).toHaveValue(/Finite and Infinite Games/);
    await expect(fallback).toContainText('Select all and copy (⌘C / Ctrl+C).');
    await page.keyboard.press('Escape');
    await expect(fallback).toHaveCount(0);

    // Write It Myself → paste helper fills only parsed fields → Save Picture.
    await page.getByTestId('capstone-write-btn').click();
    const modal = page.getByTestId('capstone-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Finite and Infinite Games · Optional');
    await expect(page.getByTestId('capstone-save-btn')).toBeDisabled();
    await expect(page.getByTestId('capstone-save-btn')).toHaveText('Save Picture');
    await modal.getByText('Paste a reply from your assistant').click();
    await page.getByTestId('capstone-paste-input').fill(REPLY);
    await page.getByTestId('capstone-fill-btn').click();
    await expect(page.getByTestId('capstone-paste-status')).toHaveText('Filled from the reply. Edit anything you like.');
    await expect(page.getByTestId('capstone-arc-input')).toHaveValue(
      'Finite games are played to win; infinite games are played to keep playing.'
    );
    await expect(page.getByTestId('capstone-learnings-input')).toHaveValue('Titles are backward-looking.\nPlay, not power.');
    await expect(page.getByTestId('capstone-shift-input')).toHaveValue(
      'I notice when I treat a relationship like a match.'
    );
    await expect(modal).toContainText('2 learnings');
    await page.getByTestId('capstone-save-btn').click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByText('Saved your Whole-Book Picture.')).toBeVisible();

    const card = page.getByTestId('capstone-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('The Thesis');
    await expect(card.locator('ol li')).toHaveText(['Titles are backward-looking.', 'Play, not power.']);
    await expect(card).toContainText('How My Thinking Shifted');
    await expect(card).toContainText(/Written \d{4}-\d{2}-\d{2}/);
    await expect(page.getByTestId('capstone-empty-state')).toHaveCount(0);

    // Persisted through the adapter (Demo state), raw shape incl. completedAt.
    const stored = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      return state.books.find((b: { id: string }) => b.id === 'book-finite').meta.capstone;
    });
    expect(stored.keyLearnings).toEqual(['Titles are backward-looking.', 'Play, not power.']);
    expect(typeof stored.completedAt).toBe('string');

    // C opens the editor in edit mode; Escape closes instantly.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('c');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('capstone-save-btn')).toHaveText('Save Changes');
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  test('capstone draft survives close (restore banner + Discard); Hide is per-device and leaves an Add link', async ({ page }) => {
    await demo(page);
    await goBook(page, 'book-finite');

    await page.getByTestId('capstone-write-btn').click();
    await page.getByTestId('capstone-arc-input').fill('Half a thought');
    await page.keyboard.press('Escape');
    await page.getByTestId('capstone-write-btn').click();
    await expect(page.getByTestId('draft-restored-banner')).toBeVisible();
    await expect(page.getByTestId('capstone-arc-input')).toHaveValue('Half a thought');
    await page.getByTestId('draft-discard-btn').click();
    await expect(page.getByTestId('capstone-arc-input')).toHaveValue('');
    await page.keyboard.press('Escape');

    await page.getByTestId('capstone-hide-btn').click();
    await expect(page.getByText('Hidden. You can add it anytime from the Finished line above.')).toBeVisible();
    await expect(page.getByTestId('capstone-empty-state')).toHaveCount(0);
    await expect(page.getByTestId('capstone-add-link')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pragya_capstone_prompt_hidden_v1'))).toBe('["book-finite"]');

    await page.reload();
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await expect(page.getByTestId('capstone-empty-state')).toHaveCount(0);
    await page.getByTestId('capstone-add-link').click();
    await expect(page.getByTestId('capstone-modal')).toBeVisible();
  });

  test('reading book: no capstone UI; inline chapter → Shelf row → capture inherits at the bookmark only → chip', async ({ page }) => {
    await demo(page);
    await goBook(page, 'book-systems');
    await expect(page.getByTestId('capstone-empty-state')).toHaveCount(0);
    await expect(page.getByTestId('capstone-card')).toHaveCount(0);

    // Inline "Add chapter" → Enter saves → "Now in …".
    await page.getByTestId('book-detail-chapter-change-btn').click();
    const input = page.getByTestId('book-detail-chapter-input');
    await expect(input).toBeFocused();
    await input.fill('Ch. 5: Leverage Points');
    await input.press('Enter');
    await expect(page.getByText('Chapter updated.')).toBeVisible();
    await expect(page.getByTestId('book-detail-chapter-line')).toContainText('Now in');
    await expect(page.getByTestId('book-detail-chapter-line')).toContainText('Ch. 5: Leverage Points');
    await expect(page.getByTestId('book-detail-chapter-change-btn')).toBeFocused();

    // Escape cancels without saving.
    await page.getByTestId('book-detail-chapter-change-btn').click();
    await page.getByTestId('book-detail-chapter-input').fill('Nope');
    await page.getByTestId('book-detail-chapter-input').press('Escape');
    await expect(page.getByTestId('book-detail-chapter-line')).toContainText('Ch. 5: Leverage Points');

    // Capture at the bookmark inherits; moving the position clears it with a hint.
    await page.getByRole('button', { name: 'New Note' }).click();
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await expect(page.getByTestId('capture-pos-input')).toHaveValue('142');
    await expect(page.getByTestId('capture-chapter-input')).toHaveValue('Ch. 5: Leverage Points');
    await expect(page.getByTestId('capture-chapter-hint')).toHaveText('From your bookmark');
    await page.getByTestId('capture-pos-input').fill('100');
    await expect(page.getByTestId('capture-chapter-input')).toHaveValue('');
    await expect(page.getByTestId('capture-chapter-hint')).toContainText('Bookmark chapter not applied');
    await page.getByTestId('capture-pos-input').fill('142');
    await page.getByTestId('capture-takeaway-input').fill('Leverage hides where you least expect it.');
    await page.getByTestId('capture-submit-btn').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    const stored = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      return state.notes.find((n: { takeaway: string }) => n.takeaway === 'Leverage hides where you least expect it.');
    });
    expect(stored.meta.chapter).toBe('Ch. 5: Leverage Points');
    await expect(page.getByTestId(`chapter-pos-chip-${stored.slug}`)).toHaveText('Ch. 5: Leverage Points · p. 142');

    // Shelf "Now Reading" shows the chapter next to the page.
    await page.evaluate(() => {
      window.location.hash = '#/shelf';
    });
    await expect(page.getByTestId('shelf-chapter-book-systems')).toHaveText('Ch. 5: Leverage Points');
  });

  test('chapter names stay hidden while a note is shielded (chip shows position only)', async ({ page }) => {
    await demo(page);
    await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      const n = state.notes.find((x: { id: string }) => x.id === 'note-effective-dreaming');
      n.meta = { ...(n.meta || {}), chapter: 'Ch. 9: The Betrayal' };
      localStorage.setItem('pragya_demo_state_v1', JSON.stringify(state));
    });
    await page.reload();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await page.getByTestId('nav-item-notes').click();
    const chip = page.getByTestId('chapter-pos-chip-effective-dreaming-ethics');
    await expect(chip).toHaveText('p. 15');
    expect(await page.content()).not.toContain('The Betrayal');
    await page.getByTestId('spoiler-reveal-btn-effective-dreaming-ethics').click();
    await expect(chip).toHaveText('Ch. 9: The Betrayal · p. 15');
  });
});
