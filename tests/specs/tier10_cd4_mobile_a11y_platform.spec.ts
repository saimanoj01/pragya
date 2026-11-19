import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 10 (Dev, CD Batch 4) — Mobile, accessibility, and platform polish:
 * - iOS viewport-fit=cover (no zoom lock), safe-area-inset styles, zero horizontal overflow
 * - 16px mobile form controls (text-base sm:text-body) + enterkeyhint / inputmode="numeric"
 * - >= 44x44px mobile touch targets across views & modals
 * - StreamThumbnail tap-to-zoom -> ImageLightbox (Space/Esc close + focus restore; never on shielded)
 * - CommandPalette + WikilinkAutocomplete combobox/listbox ARIA & live announcements
 * - Primary nav <a href> + aria-current="page" / "location"
 * - J/K real DOM focus + spoiler-safe card aria-label + BookDetailView D / E / Shift+E (Q6)
 * - ? Keyboard Help modal + (any-pointer: fine) touch-only hiding (Q13)
 * - Zero-FOUC <head> theme script (Q7 dark default), self-hosted Inter fonts (zero Google Fonts requests)
 * - @media print (white bg, hidden chrome, expanded disclosures, data-print-href, spoiler shields preserved)
 * - @media (prefers-reduced-motion: reduce)
 */

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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

async function editState(page: Page, fn: string) {
  await page.evaluate(body => {
    const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
    new Function('s', body)(s);
    localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
  }, fn);
  await page.reload();
  await expect(page.locator('[data-testid$="-view"]').first()).toBeVisible();
}

test.describe('Tier 10 — CD Batch 4 mobile, accessibility & platform polish (Dev)', () => {
  test('mobile 390x844: viewport-fit=cover without zoom lock, 16px inputs vs 14px desktop, inputmode/enterkeyhint, >=44px targets & zero horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await demo(page);

    const meta = await page.evaluate(() => ({
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '',
      capable:
        document.querySelector('meta[name="mobile-web-app-capable"]')?.getAttribute('content') || '',
    }));
    expect(meta.viewport).toContain('viewport-fit=cover');
    expect(meta.viewport).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i);
    expect(meta.capable).toBe('yes');

    // Shelf mobile targets & overflow
    const addBookBox = await page.getByTestId('add-book-btn').boundingBox();
    expect(addBookBox?.height).toBeGreaterThanOrEqual(44);
    expect(addBookBox?.width).toBeGreaterThanOrEqual(44);

    for (const navId of ['bottom-nav-shelf', 'bottom-nav-notes', 'bottom-nav-capture', 'bottom-nav-practice', 'bottom-nav-more']) {
      const box = await page.getByTestId(navId).boundingBox();
      expect(box?.height, navId).toBeGreaterThanOrEqual(44);
      expect(box?.width, navId).toBeGreaterThanOrEqual(44);
    }

    const posInput = page.getByTestId('advance-exact-input-book-systems');
    await expect(posInput).toHaveAttribute('inputmode', 'numeric');
    await expect(posInput).toHaveAttribute('enterkeyhint', 'done');
    expect(await posInput.evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
    expect((await posInput.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    for (const route of ['#/shelf', '#/notes', '#/practice', '#/book/book-systems', '#/settings']) {
      await go(page, route);
      await expect(page.locator('[data-testid$="-view"]').first()).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect(overflow, `horizontal overflow on ${route}`).toBeLessThanOrEqual(0);
    }

    // Notes search 16px + enterkeyhint="search" on mobile
    await go(page, '#/notes');
    const searchInput = page.getByTestId('notes-search-input');
    await expect(searchInput).toHaveAttribute('enterkeyhint', 'search');
    expect(await searchInput.evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
    expect((await searchInput.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    // Quick Capture modal mobile 16px controls & 44px buttons
    await page.getByTestId('bottom-nav-capture').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await expect(page.getByTestId('capture-pos-input')).toHaveAttribute('inputmode', 'numeric');
    for (const tid of ['capture-book-select', 'capture-pos-input', 'capture-takeaway-input']) {
      expect(await page.getByTestId(tid).evaluate(el => getComputedStyle(el).fontSize), tid).toBe('16px');
    }
    expect((await page.getByTestId('capture-submit-btn').boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const closeBtnBox = await page
      .getByTestId('quick-capture-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .boundingBox();
    expect(Math.round(closeBtnBox?.height ?? 0)).toBeGreaterThanOrEqual(44);
    expect(Math.round(closeBtnBox?.width ?? 0)).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Escape');

    // Desktop >=640px restores 14px (text-body)
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await searchInput.evaluate(el => getComputedStyle(el).fontSize)).toBe('14px');
  });

  test('StreamThumbnail tap-to-zoom opens ImageLightbox across Notes, BookDetail & Practice Shuffle, restores focus on Space/Esc, and never renders for shielded notes', async ({
    page,
  }) => {
    await demo(page);
    await editState(
      page,
      `
      const visible = s.notes.find(n => n.id === 'note-delays-feedback');
      visible.meta.attachments = [{
        id: 'att-visible-img',
        type: 'image',
        driveFileId: '',
        fileName: 'feedback-loop.png',
        mimeType: 'image/png',
        width: 100,
        height: 100,
        previewDataUrl: ${JSON.stringify(TINY_PNG)}
      }];
      const shielded = s.notes.find(n => n.id === 'note-leverage-paradigm');
      shielded.meta.attachments = [{
        id: 'att-shielded-img',
        type: 'image',
        driveFileId: '',
        fileName: 'secret-spoiler.png',
        mimeType: 'image/png',
        width: 100,
        height: 100,
        previewDataUrl: ${JSON.stringify(TINY_PNG)}
      }];
      `
    );

    // Notes stream: visible thumbnail opens lightbox; shielded thumbnail is absent.
    await go(page, '#/notes');
    await expect(page.getByTestId('stream-thumb-btn-att-shielded-img')).toHaveCount(0);
    const notesThumb = page.getByTestId('stream-thumb-btn-att-visible-img');
    await expect(notesThumb).toBeVisible();
    await notesThumb.click();
    await expect(page.getByTestId('image-lightbox')).toBeVisible();
    // Space closes lightbox and restores focus to the thumbnail button.
    await page.keyboard.press(' ');
    await expect(page.getByTestId('image-lightbox')).toHaveCount(0);
    await expect(notesThumb).toBeFocused();

    // BookDetail stream: visible thumbnail opens lightbox; Escape closes & restores focus; shielded stays hidden.
    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('stream-thumb-btn-att-shielded-img')).toHaveCount(0);
    const bookThumb = page.getByTestId('stream-thumb-btn-att-visible-img');
    await bookThumb.click();
    await expect(page.getByTestId('image-lightbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('image-lightbox')).toHaveCount(0);
    await expect(bookThumb).toBeFocused();

    // Practice Shuffle: archive other notes and clear lastReviewed on note-delays-feedback so it is
    // deterministically selected regardless of the date-seeded fnv1a shuffle hash.
    await editState(
      page,
      `
      for (const n of s.notes) {
        if (n.id === 'note-delays-feedback') {
          n.lastReviewed = '';
        } else {
          n.meta = { ...(n.meta || {}), archivedAt: '2026-01-01T00:00:00.000Z' };
        }
      }
      `
    );
    await go(page, '#/practice');
    const practiceThumb = page
      .getByTestId('shuffle-card-delays-in-feedback-loops')
      .getByTestId('stream-thumb-btn-att-visible-img');
    await expect(practiceThumb).toBeVisible();
    await practiceThumb.click();
    await expect(page.getByTestId('image-lightbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(practiceThumb).toBeFocused();
  });

  test('CommandPalette + WikilinkAutocomplete expose valid ARIA 1.2 combobox/listbox semantics and polite live counts', async ({
    page,
  }) => {
    await demo(page);

    // CommandPalette combobox/listbox
    await page.getByTestId('command-palette-trigger').click();
    const cmdInput = page.getByTestId('command-palette-input');
    await expect(cmdInput).toHaveAttribute('role', 'combobox');
    await expect(cmdInput).toHaveAttribute('aria-expanded', 'true');
    const listboxId = await cmdInput.getAttribute('aria-controls');
    expect(listboxId).toBeTruthy();
    const listbox = page.locator(`[id="${listboxId}"]`);
    await expect(listbox).toHaveAttribute('role', 'listbox');

    const firstActiveId = await cmdInput.getAttribute('aria-activedescendant');
    expect(firstActiveId).toBeTruthy();
    await expect(page.locator(`[id="${firstActiveId}"]`)).toHaveAttribute('aria-selected', 'true');

    await cmdInput.press('ArrowDown');
    const secondActiveId = await cmdInput.getAttribute('aria-activedescendant');
    expect(secondActiveId).not.toBe(firstActiveId);
    await expect(page.locator(`[id="${secondActiveId}"]`)).toHaveAttribute('aria-selected', 'true');

    await cmdInput.press('End');
    const endActiveId = await cmdInput.getAttribute('aria-activedescendant');
    await cmdInput.press('Home');
    expect(await cmdInput.getAttribute('aria-activedescendant')).toBe(firstActiveId);
    expect(endActiveId).not.toBe(firstActiveId);

    await cmdInput.fill('Feedback Loops');
    await expect(page.getByTestId('command-palette-announcer')).toContainText(/result/);
    await cmdInput.fill('zzzzzz-no-match-ever');
    await expect(page.getByTestId('command-palette-announcer')).toHaveText('No results');
    await page.keyboard.press('Escape');

    // WikilinkAutocomplete combobox/listbox on textarea
    await page.getByTestId('sidebar-capture-btn').click();
    const takeaway = page.getByTestId('capture-takeaway-input');
    await expect(takeaway).toHaveAttribute('role', 'combobox');
    await expect(takeaway).toHaveAttribute('aria-multiline', 'true');
    await expect(takeaway).toHaveAttribute('aria-expanded', 'false');

    await takeaway.click();
    await takeaway.pressSequentially('See [[');
    await expect(takeaway).toHaveAttribute('aria-expanded', 'true');
    const wlListId = await takeaway.getAttribute('aria-controls');
    expect(wlListId).toBeTruthy();
    await expect(page.locator(`[id="${wlListId}"]`)).toHaveAttribute('role', 'listbox');
    const wlFirstActiveId = await takeaway.getAttribute('aria-activedescendant');
    expect(wlFirstActiveId).toBeTruthy();
    await expect(page.locator(`[id="${wlFirstActiveId}"]`)).toHaveAttribute('aria-selected', 'true');
    await takeaway.press('ArrowDown');
    const wlSecondActiveId = await takeaway.getAttribute('aria-activedescendant');
    expect(wlSecondActiveId).not.toBe(wlFirstActiveId);
    await expect(page.locator(`[id="${wlSecondActiveId}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('wikilink-autocomplete-announcer')).toContainText(/suggestion/);

    await takeaway.pressSequentially('memory-prism');
    await takeaway.press('Enter');
    await expect(takeaway).toHaveValue('See [[memory-prism-digital-remembrance]]');
    await expect(takeaway).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Escape');
  });

  test('Primary nav renders real <a href> links and sets aria-current="page" vs "location"', async ({
    page,
  }) => {
    await demo(page);

    const navShelf = page.getByTestId('nav-item-shelf');
    const navNotes = page.getByTestId('nav-item-notes');
    const navPractice = page.getByTestId('nav-item-practice');
    const navSettings = page.getByTestId('nav-item-settings');

    expect(await navShelf.evaluate(el => el.tagName)).toBe('A');
    await expect(navShelf).toHaveAttribute('href', '#/shelf');
    await expect(navNotes).toHaveAttribute('href', '#/notes');
    await expect(navPractice).toHaveAttribute('href', '#/practice');
    await expect(navSettings).toHaveAttribute('href', '#/settings');

    await expect(navShelf).toHaveAttribute('aria-current', 'page');
    await expect(navNotes).not.toHaveAttribute('aria-current', /.+/);

    // Book detail -> Shelf has aria-current="location"
    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await expect(navShelf).toHaveAttribute('aria-current', 'location');

    // Note detail -> Notes has aria-current="location"
    await go(page, '#/note/delays-in-feedback-loops');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await expect(navNotes).toHaveAttribute('aria-current', 'location');

    // Plain click navigates without reload
    await navPractice.click();
    await expect(page.getByTestId('practice-view')).toBeVisible();
    await expect(navPractice).toHaveAttribute('aria-current', 'page');
  });

  test('J/K moves real DOM focus with spoiler-safe card aria-label, and BookDetailView supports D / E / Shift+E (Q6)', async ({
    page,
  }) => {
    await demo(page);

    // NotesView J/K DOM focus (focusedIndex starts at 0, so J moves 0 -> 1 and K moves 1 -> 0) + spoiler-safe aria-label
    await go(page, '#/notes');
    await expect(page.getByTestId('notes-view')).toBeVisible();
    const shieldedCard = page.getByTestId('note-card-effective-dreaming-ethics');
    const shieldedAria = await shieldedCard.getAttribute('aria-label');
    expect(shieldedAria).toContain('Shielded note');
    expect(shieldedAria).not.toContain('Burden of Effective Dreaming');

    await page.keyboard.press('j');
    await expect(page.locator('[data-testid="notes-view"] [data-jk-card="1"]')).toBeFocused();
    await page.keyboard.press('k');
    await expect(page.locator('[data-testid="notes-view"] [data-jk-card="0"]')).toBeFocused();

    // PracticeView J/K DOM focus (2 active deltas in demo seed: J moves 0 -> 1, K moves 1 -> 0)
    await go(page, '#/practice');
    await expect(page.getByTestId('practice-view')).toBeVisible();
    await page.keyboard.press('j');
    await expect(page.locator('[data-testid="active-deltas-section"] [data-jk-card="1"]')).toBeFocused();
    await page.keyboard.press('k');
    await expect(page.locator('[data-testid="active-deltas-section"] [data-jk-card="0"]')).toBeFocused();

    // BookDetailView Q6: E edits book before card DOM focus; after J/K focuses a note, E edits note, Shift+E edits book, D deepens note
    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();

    await page.keyboard.press('e');
    await expect(page.getByTestId('edit-book-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-book-modal')).toHaveCount(0);

    // J moves 0 -> 1, then K moves 1 -> 0 (note-self-organization at p. 78, status 'saved')
    await page.keyboard.press('j');
    await expect(page.locator('[data-testid="book-detail-view"] [data-jk-card="1"]')).toBeFocused();
    await page.keyboard.press('k');
    const firstBookCard = page.locator('[data-testid="book-detail-view"] [data-jk-card="0"]');
    await expect(firstBookCard).toBeFocused();

    await page.keyboard.press('e');
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-note-modal')).toHaveCount(0);

    // Re-focus card and verify Shift+E always edits the book
    await firstBookCard.focus();
    await page.keyboard.press('Shift+E');
    await expect(page.getByTestId('edit-book-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-book-modal')).toHaveCount(0);

    // D deepens the focused saved note
    await firstBookCard.focus();
    await page.keyboard.press('d');
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
    await page.keyboard.press('Escape');

    // Shielded note (note-leverage-paradigm at p. 210 > p. 142) ignores E and D
    const shieldedBookCard = page.getByTestId('note-card-paradigm-shifts-outrank-parameters');
    await shieldedBookCard.focus();
    await page.keyboard.press('d');
    await expect(page.getByTestId('deepen-note-modal')).toHaveCount(0);
    await page.keyboard.press('e');
    await expect(page.getByTestId('edit-note-modal')).toHaveCount(0);
  });

  test('? Keyboard Help modal renders KEYBOARD_SHORTCUTS; touch-only devices hide UI triggers while keeping hardware ? (Q13)', async ({
    browser,
    page,
  }) => {
    await demo(page);
    await expect(page.getByTestId('keyboard-help-btn')).toBeVisible();

    await page.keyboard.press('?');
    const modal = page.getByTestId('keyboard-help-modal');
    await expect(modal).toBeVisible();
    for (const sec of ['anywhere', 'notes-list', 'book-page', 'note-page', 'practice', 'forms', 'search-images']) {
      await expect(page.getByTestId(`keyboard-help-section-${sec}`)).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);

    // Touch-only context: (any-pointer: fine) is false -> UI buttons hidden, hardware ? still opens modal.
    const touchContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      const touchPage = await touchContext.newPage();
      await demo(touchPage);
      expect(await touchPage.evaluate(() => window.matchMedia('(any-pointer: fine)').matches)).toBe(false);
      await expect(touchPage.getByTestId('keyboard-help-btn')).toBeHidden();

      await touchPage.getByTestId('bottom-nav-more').click();
      await expect(touchPage.getByTestId('mobile-more-drawer')).toBeVisible();
      await expect(touchPage.getByTestId('drawer-keyboard-help-btn')).toHaveCount(0);
      await touchPage.keyboard.press('Escape');
      await expect(touchPage.getByTestId('mobile-more-drawer')).toHaveCount(0);

      // Hardware Bluetooth keyboard `?` still works
      await touchPage.keyboard.press('?');
      await expect(touchPage.getByTestId('keyboard-help-modal')).toBeVisible();
    } finally {
      await touchContext.close();
    }
  });

  test('Zero-FOUC <head> theme script (Q7 dark default + saved light), zero Google Fonts requests, @media print & prefers-reduced-motion', async ({
    browser,
  }) => {
    // 1. Fresh visit even under OS light mode defaults to dark (Q7 override) and makes 0 external font requests.
    const lightOsContext = await browser.newContext({ colorScheme: 'light' });
    try {
      const p1 = await lightOsContext.newPage();
      const externalFontUrls: string[] = [];
      const selfHostedFontStatuses: number[] = [];
      p1.on('request', req => {
        if (/fonts\.(googleapis|gstatic)\.com/.test(req.url())) externalFontUrls.push(req.url());
      });
      p1.on('response', res => {
        if (res.url().includes('InterVariable') && res.url().endsWith('.woff2')) {
          selfHostedFontStatuses.push(res.status());
        }
      });

      await demo(p1);
      expect(externalFontUrls).toEqual([]);
      expect(selfHostedFontStatuses.length).toBeGreaterThanOrEqual(1);
      expect(selfHostedFontStatuses.every(s => s === 200)).toBe(true);
      expect(await p1.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);

      // 2. @media print: white bg, hidden chrome, expanded SessionsTrail, data-print-href URL, spoiler shields stay shielded!
      await go(p1, '#/book/book-systems');
      await expect(p1.getByTestId('book-detail-view')).toBeVisible();
      await p1.emulateMedia({ media: 'print' });

      const printState = await p1.evaluate(() => {
        const sidebarDisplay = getComputedStyle(document.querySelector('[data-testid="sidebar"]')!).display;
        const bodyBg = getComputedStyle(document.body).backgroundColor;
        const linkChip = document.querySelector('a[data-print-href]');
        return {
          sidebarDisplay,
          bodyBg,
          printHref: linkChip?.getAttribute('data-print-href') || '',
        };
      });
      expect(printState.sidebarDisplay).toBe('none');
      expect(printState.bodyBg).toBe('rgb(255, 255, 255)');
      expect(printState.printHref).toContain('https://');
      await expect(p1.getByTestId('sessions-trail-list')).toBeVisible();
      // Spoiler shield for note-leverage-paradigm (pos 210 > 142) MUST remain shielded in print!
      await expect(p1.locator('body')).not.toContainText('Paradigm Shifts Outrank Parameters');
      await expect(p1.getByTestId('spoiler-shield-paradigm-shifts-outrank-parameters')).toBeVisible();

      // 3. @media (prefers-reduced-motion: reduce)
      await p1.emulateMedia({ media: 'screen', reducedMotion: 'reduce' });
      const reduced = await p1.evaluate(() => ({
        matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        durationSeconds: parseFloat(getComputedStyle(document.body).transitionDuration),
      }));
      expect(reduced.matches).toBe(true);
      expect(reduced.durationSeconds).toBeLessThanOrEqual(0.001);
    } finally {
      await lightOsContext.close();
    }

    // 4. Saved 'light' theme applies synchronously in <head> before paint (zero FOUC).
    const savedLightContext = await browser.newContext({ colorScheme: 'dark' });
    try {
      await savedLightContext.addInitScript(() => {
        localStorage.setItem('pragya_theme', 'light');
      });
      const p2 = await savedLightContext.newPage();
      await p2.goto('/');
      const headTheme = await p2.evaluate(() => ({
        hasLight: document.documentElement.classList.contains('light'),
        hasDark: document.documentElement.classList.contains('dark'),
        themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
      }));
      expect(headTheme).toEqual({ hasLight: true, hasDark: false, themeColor: '#FAFAF9' });
    } finally {
      await savedLightContext.close();
    }
  });

  test('Batch 4 fix-ups: Related Concepts chip spoiler-safe UUID route (R1#2), @media print content retention + repeated beforeprint idempotency (R1#1/R1#4), right-click autocomplete guard (R1#3), and Cmd/Ctrl+Enter across modals (R2-3a)', async ({
    page,
  }) => {
    await demo(page);

    // 1. R1#2: Related Concepts chip linking (even via alias) to a shielded note navigates to #/note/<uuid>, never leaking canonical slug.
    await editState(
      page,
      `
      const shielded = s.notes.find(n => n.id === 'note-effective-dreaming');
      shielded.meta = { ...(shielded.meta || {}), aliases: ['harmless-setup'] };
      const src = s.notes.find(n => n.id === 'note-delays-feedback');
      src.takeaway = src.takeaway + ' Linked to [[harmless-setup]].';
      `
    );
    await go(page, '#/note/delays-in-feedback-loops');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.getByTestId('wikilink-chip-harmless-setup').click();
    expect(await page.evaluate(() => window.location.hash)).toBe('#/note/note-effective-dreaming');
    expect(await page.evaluate(() => window.location.hash)).not.toContain('effective-dreaming-ethics');

    // 2. R1#1 + R1#4: @media print preserves Shelf book titles, Practice delta titles & Notes tag pills, hides capstone-empty-state, and survives repeated beforeprint.
    await go(page, '#/shelf');
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    await expect(
      page.getByTestId('book-card-book-systems').getByRole('button', { name: 'Thinking in Systems: A Primer' })
    ).toBeVisible();

    await go(page, '#/practice');
    await expect(page.getByTestId('practice-view')).toBeVisible();
    await expect(page.getByTestId('delta-card-note-delays-feedback').getByRole('button', { name: /\[\[Delays in Feedback Loops\]\]/ })).toBeVisible();

    await go(page, '#/notes');
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await expect(page.getByTestId('tag-pill-systems').first()).toBeVisible();

    // Finished book capstone-empty-state is hidden in print
    await go(page, '#/book/book-finite');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await expect(page.getByTestId('capstone-empty-state')).toBeHidden();
    await page.emulateMedia({ media: 'screen' });

    // Repeated beforeprint -> beforeprint -> afterprint restores closed state cleanly
    await go(page, '#/book/book-systems');
    const trail = page.getByTestId('sessions-trail');
    expect(await trail.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('beforeprint'));
      window.dispatchEvent(new Event('beforeprint'));
    });
    expect(await trail.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    expect(await trail.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);

    // 3. R1#3 + R2-3a: AddBookModal, EditBookModal, EditNoteModal & DeepenNoteModal submit on Ctrl+Enter; right-click does not pick wikilink option.
    await go(page, '#/shelf');
    await page.getByTestId('add-book-btn').click();
    await page.getByTestId('book-title-input').fill('Ctrl+Enter Book');
    await page.getByTestId('book-title-input').press('Control+Enter');
    await expect(page.getByTestId('add-book-modal')).toHaveCount(0);

    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await page.keyboard.press('e');
    await expect(page.getByTestId('edit-book-modal')).toBeVisible();
    await page.getByTestId('edit-book-chapter-input').fill('Ch. 4: Delays');
    await page.getByTestId('edit-book-chapter-input').press('Control+Enter');
    await expect(page.getByTestId('edit-book-modal')).toHaveCount(0);

    // EditNoteModal: right-click on wikilink option does NOT insert, Ctrl+Enter submits
    await page.keyboard.press('j');
    await page.keyboard.press('k');
    await page.keyboard.press('e');
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    const editContext = page.getByTestId('edit-note-context-input');
    await editContext.click();
    await editContext.fill('Test [[');
    const opt = page.getByTestId('wikilink-option-delays-in-feedback-loops');
    await expect(opt).toBeVisible();
    await opt.click({ button: 'right' });
    await expect(editContext).toHaveValue('Test [[');
    await editContext.fill('Saved via Ctrl+Enter');
    await editContext.press('Control+Enter');
    await expect(page.getByTestId('edit-note-modal')).toHaveCount(0);

    // DeepenNoteModal: Ctrl+Enter submits
    await page.locator('[data-testid="book-detail-view"] [data-jk-card="0"]').focus();
    await page.keyboard.press('d');
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
    await page.getByTestId('deepen-title-input').fill('Self-Organization Principle');
    await page.getByTestId('deepen-title-input').press('Control+Enter');
    await expect(page.getByTestId('deepen-note-modal')).toHaveCount(0);
  });
});
