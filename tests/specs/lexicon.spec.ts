import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

const SCREENSHOT_DIR =
  '/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p_devbox/a275b0d1-086a-445d-803f-706bd007fd52/scratch/lexicon_screens';

async function enterDemoMode(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-login-btn').click();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
}

test.describe('Lexicon feature — Demo Mode E2E & visual verification', () => {
  test('Quick Capture Word -> Lexicon -> ?note= highlight -> shielded card -> mobile BottomNav 5 slots', async ({
    page,
  }) => {
    // 1. Desktop viewport (1280x800)
    await page.setViewportSize({ width: 1280, height: 800 });
    await enterDemoMode(page);

    // 2. Open Quick Capture -> switch to Word mode -> save a word in Thinking in Systems
    await page.getByTestId('sidebar-capture-btn').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await expect(page.getByTestId('capture-mode-note')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('capture-mode-word').click();
    await expect(page.getByTestId('capture-mode-word')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('capture-mode-note')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('capture-word-input')).toBeVisible();

    await page.getByTestId('capture-book-select').selectOption('book-systems');
    await page.getByTestId('capture-pos-input').fill('95');
    await page.getByTestId('capture-word-input').fill('Equilibrium');
    await page
      .getByTestId('capture-quote-input')
      .fill('A dynamic equilibrium balances inflow against outflow over time.');
    await page
      .getByTestId('capture-word-meaning-input')
      .fill('A state where opposing forces or flows balance each other.');
    await page
      .getByTestId('capture-word-example-input')
      .fill('An engineering team seeks equilibrium between shipping speed and reliability.');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'quick-capture-word.png'),
    });

    await page.getByTestId('capture-submit-btn').click();
    await expect(page.getByTestId('capture-word-input')).toHaveCount(0);

    // 3. Navigate to #/lexicon via Sidebar link -> verify saved word & shielded demo word
    await page.getByTestId('nav-item-lexicon').click();
    await expect(page.getByTestId('lexicon-view')).toBeVisible();

    const eqCard = page.getByTestId('lexicon-card-equilibrium');
    await expect(eqCard).toBeVisible();
    await expect(eqCard).toContainText('Equilibrium');
    await expect(eqCard).toContainText('A state where opposing forces or flows balance each other.');

    // Ahead-of-bookmark demo word ("Palimpsest" in Exhalation at p. 284 > currentPos 168)
    // renders as a standalone anonymous locked card with no word/lemma leaked.
    const shieldedCard = page.getByTestId('lexicon-card-shielded-note-word-palimpsest');
    await expect(shieldedCard).toBeVisible();
    await expect(shieldedCard).toContainText('Shielded word · Exhalation: Stories · p. 284');
    await expect(shieldedCard).not.toContainText('Palimpsest');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'lexicon-desktop.png'),
      fullPage: true,
    });

    // 4. Click encounter book link -> lands on BookDetailView with ?note= highlighted card & Words met strip
    const bookLink = eqCard.locator('[data-testid^="lexicon-encounter-book-"]').first();
    await bookLink.click();

    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await expect(page).toHaveURL(/#\/book\/book-systems\?note=/);

    const wordsStrip = page.getByTestId('book-words-strip');
    await expect(wordsStrip).toBeVisible();
    await expect(wordsStrip).toContainText('Words met in this book (3)');
    await expect(wordsStrip).toContainText('Equilibrium');
    await expect(wordsStrip).toContainText('Oscillation');
    await expect(wordsStrip).toContainText('Homeostasis');

    const highlightedCard = page.locator('[data-highlighted="true"]');
    await expect(highlightedCard).toHaveCount(1);
    await expect(highlightedCard).toContainText('Equilibrium');

    await wordsStrip.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'book-words-strip.png'),
      fullPage: true,
    });

    // 5. Visit #/practice and verify Lexicon Stroll section + tap reveal + screenshot
    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('practice-view')).toBeVisible();
    const strollSection = page.getByTestId('lexicon-stroll-section');
    await expect(strollSection).toBeVisible();
    await expect(strollSection).toContainText('Lexicon Stroll');

    const revealBtn = strollSection.getByRole('button', { name: /Reveal/i }).first();
    await revealBtn.click();

    await strollSection.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'practice-lexicon-stroll.png'),
      fullPage: true,
    });

    // 6. Switch to mobile viewport (390x844) -> verify BottomNav keeps 5 slots & Lexicon mobile layout
    await page.setViewportSize({ width: 390, height: 844 });
    const bottomNav = page.getByTestId('bottom-nav');
    await expect(bottomNav).toBeVisible();
    const slotCount = await bottomNav.locator('a, button').count();
    expect(slotCount).toBe(5);

    await page.getByTestId('bottom-nav-more').click();
    await expect(page.getByTestId('drawer-nav-lexicon')).toBeVisible();
    await page.getByTestId('drawer-nav-lexicon').click();
    await expect(page.getByTestId('lexicon-view')).toBeVisible();
    await expect(page.getByTestId('lexicon-card-oscillation')).toBeVisible();
    await expect(page.getByTestId('lexicon-card-shielded-note-word-palimpsest')).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'lexicon-mobile.png'),
      fullPage: true,
    });
  });
});
