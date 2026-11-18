import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 11 (QA, CD Batch 4) — adversarial end-to-end verification:
 * - Exhaustive 390x844 computed fontSize >= 16px across EVERY view & modal form control
 * - Mobile >= 44x44px touch targets & safe-area styles across views, BottomNav, More drawer & modals
 * - Touch ghost-click guard in WikilinkAutocomplete when popup overlaps an underlying button
 * - StreamThumbnail + ImageLightbox: zero spoiler leakage, Escape on BookDetail stays on book route
 * - BookDetailView Q6 click-to-focus card + single-note J/K focus + editable/modal shortcut guards
 * - Print beforeprint/afterprint disclosure expansion (SessionsTrail + Socratic prompts) & spoiler safety
 * - Self-hosted Inter roman + italic font loading + ThemeContext meta synchronization
 * - QA findings probes (todo where unfixed): Q13 CommandPalette touch-only gate, post-button/link focus J/K, etc.
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

async function patch(page: Page, fn: string) {
  await page.evaluate(src => {
    const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
    new Function('s', src)(s);
    localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
  }, fn);
  await page.reload();
  await expect(page.locator('[data-testid$="-view"]').first()).toBeVisible();
}

async function assertAllVisibleControlsAtLeast16px(page: Page, contextLabel: string) {
  const offenders = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>(
        "input:not([type='checkbox']):not([type='radio']):not([type='range']):not([type='file']):not([type='color']):not([type='hidden']), textarea, select"
      )
    );
    const bad: Array<{ tag: string; testId: string | null; aria: string | null; fontSize: string }> = [];
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) {
        continue;
      }
      if (parseFloat(style.fontSize) < 16) {
        bad.push({
          tag: el.tagName,
          testId: el.getAttribute('data-testid'),
          aria: el.getAttribute('aria-label'),
          fontSize: style.fontSize,
        });
      }
    }
    return bad;
  });
  expect(offenders, `controls <16px at 390px in ${contextLabel}`).toEqual([]);
}

test.describe('Tier 11 — CD Batch 4 QA adversarial probes', () => {
  test('exhaustive 390x844 mobile audit: zero <16px inputs/selects/textareas across Login, Shelf, Notes, BookDetail, Practice, Settings, Palette & all 8 form modals', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByTestId('login-view')).toBeVisible();
    // Expand OAuth Client ID input if collapsed
    const oauthBtn = page.getByRole('button', { name: /Google OAuth Client ID/i });
    if ((await oauthBtn.getAttribute('aria-expanded')) === 'false') {
      await oauthBtn.click();
    }
    await expect(page.getByTestId('client-id-input')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'LoginView');

    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'ShelfView');

    // AddBookModal
    await page.getByTestId('add-book-btn').click();
    await expect(page.getByTestId('add-book-modal')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'AddBookModal');
    await page.keyboard.press('Escape');

    // QuickCaptureModal (including Doc/Link URL + title inputs)
    await page.getByTestId('bottom-nav-capture').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-attach-link-btn').click();
    await expect(page.getByTestId('capture-attachment-url-input')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'QuickCaptureModal');
    await page.keyboard.press('Escape');

    // NotesView (search + book filter + sort select)
    await go(page, '#/notes');
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'NotesView');

    // BookDetailView (chapter inline form + post-advance session note + SessionsTrail inline editor + EditBookModal + CapstoneModal)
    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await page.getByTestId('book-detail-chapter-change-btn').click();
    await expect(page.getByTestId('book-detail-chapter-input')).toBeVisible();
    await page.getByTestId('advance-10p-btn-book-systems').click();
    await page.getByTestId('post-advance-session-note-btn').click();
    await assertAllVisibleControlsAtLeast16px(page, 'BookDetailView inline editors');
    await page.keyboard.press('Escape'); // closes post-advance session note input
    await page.getByTestId('book-detail-chapter-input').focus();
    await page.keyboard.press('Escape'); // closes chapter input

    await page.getByTestId('book-detail-view').getByRole('button', { name: 'Edit (E)', exact: true }).click();
    await expect(page.getByTestId('edit-book-modal')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'EditBookModal');
    await page.keyboard.press('Escape');

    // Finished book -> CapstoneModal (including Paste assistant reply textarea) + PredictionOutcomeModal
    await patch(
      page,
      `
      const b = s.books.find(x => x.id === 'book-exhalation');
      b.status = 'finished';
      b.currentPos = b.totalPos;
      b.normalizedPos = 1;
      b.meta = { ...(b.meta || {}), finishedAt: '2026-11-10T00:00:00.000Z' };
      const pred = s.notes.find(n => n.bookId === 'book-exhalation');
      pred.meta = { ...(pred.meta || {}), isPrediction: true };
      `
    );
    await go(page, '#/book/book-exhalation');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await page.getByTestId('capstone-write-btn').click();
    await expect(page.getByTestId('capstone-modal')).toBeVisible();
    await page.getByTestId('capstone-modal').locator('summary').click();
    await expect(page.getByTestId('capstone-paste-input')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'CapstoneModal');
    await page.keyboard.press('Escape');

    // NoteDetailView -> EditNoteModal (with Link URL/title inputs) & DeepenNoteModal
    await go(page, '#/note/delays-in-feedback-loops');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.getByTestId('edit-note-btn').click();
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    await page.getByTestId('edit-note-modal').getByRole('button', { name: 'Link', exact: true }).click();
    await assertAllVisibleControlsAtLeast16px(page, 'EditNoteModal');
    await page.keyboard.press('Escape');

    await page.getByTestId('deepen-note-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'DeepenNoteModal');
    await page.keyboard.press('Escape');

    // PracticeView (Missed check-in -> WHEN/DO refine inputs + reflection input + PredictionOutcomeModal)
    await go(page, '#/practice');
    await expect(page.getByTestId('practice-view')).toBeVisible();
    await page.getByTestId('delta-missed-btn-note-delays-feedback').click();
    await expect(page.getByTestId('delta-trigger-edit-input-note-delays-feedback')).toBeVisible();
    await expect(page.getByTestId('delta-reflection-input-note-delays-feedback')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'PracticeView inline editors');

    const reflectBtn = page.locator('[data-testid^="reflect-outcome-btn-"]').first();
    await reflectBtn.click();
    await expect(page.getByTestId('prediction-outcome-modal')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'PredictionOutcomeModal');
    await page.keyboard.press('Escape');

    // SettingsView & CommandPalette
    await go(page, '#/settings');
    await expect(page.getByTestId('settings-view')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'SettingsView');

    await page.getByTestId('bottom-nav-more').click();
    await page.getByTestId('drawer-search-btn').click();
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await assertAllVisibleControlsAtLeast16px(page, 'CommandPalette');
  });

  test('WikilinkAutocomplete touch ghost-click guard swallows synthesized click over an underlying button without blocking later clicks', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      const page = await ctx.newPage();
      await demo(page);
      await page.getByTestId('bottom-nav-capture').click();
      await expect(page.getByTestId('quick-capture-modal')).toBeVisible();

      const takeaway = page.getByTestId('capture-takeaway-input');
      await takeaway.click();
      await takeaway.pressSequentially('Link [[');
      const opt = page.getByTestId('wikilink-option-delays-in-feedback-loops');
      await expect(opt).toBeVisible();

      // Place a probe button directly underneath the exact tap coordinates of `opt` to prove
      // the trailing touch-synthesized click is swallowed when `onPointerDown` unmounts the popup.
      const box = (await opt.boundingBox())!;
      const cx = Math.round(box.x + box.width / 2);
      const cy = Math.round(box.y + box.height / 2);

      await page.evaluate(
        ({ x, y }) => {
          (window as unknown as { __ghostClicks: number }).__ghostClicks = 0;
          const btn = document.createElement('button');
          btn.id = 'qa-underneath-probe';
          btn.type = 'button';
          btn.textContent = 'Underneath';
          Object.assign(btn.style, {
            position: 'fixed',
            left: `${x - 30}px`,
            top: `${y - 22}px`,
            width: '60px',
            height: '44px',
            zIndex: '55', // inside/above modal form, below autocomplete z-index in hit test after unmount
          });
          btn.addEventListener('click', () => {
            (window as unknown as { __ghostClicks: number }).__ghostClicks += 1;
          });
          document.querySelector('[data-testid="quick-capture-modal"]')!.appendChild(btn);
        },
        { x: cx, y: cy }
      );

      // Dispatch touch pointerdown on `opt` (which synchronously selects & unmounts popup),
      // followed immediately by the browser's synthesized click at (cx, cy) on whatever is now underneath.
      await page.evaluate(
        ({ x, y }) => {
          const optionEl = document.querySelector('[data-testid="wikilink-option-delays-in-feedback-loops"]')!;
          optionEl.dispatchEvent(
            new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              pointerType: 'touch',
              clientX: x,
              clientY: y,
            })
          );
          const nowUnder = document.elementFromPoint(x, y) || document.getElementById('qa-underneath-probe')!;
          nowUnder.dispatchEvent(
            new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              detail: 1,
            })
          );
        },
        { x: cx, y: cy }
      );

      await expect(takeaway).toHaveValue('Link [[delays-in-feedback-loops]]');
      await expect(page.getByTestId('wikilink-autocomplete')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { __ghostClicks: number }).__ghostClicks)).toBe(0);

      // A genuine subsequent click on the probe button right after IS allowed through.
      await page.locator('#qa-underneath-probe').click();
      expect(await page.evaluate(() => (window as unknown as { __ghostClicks: number }).__ghostClicks)).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  test('StreamThumbnail + ImageLightbox: zero spoiler filename/DOM leak across views & print; Escape on BookDetail closes lightbox without navigating to Shelf', async ({
    page,
  }) => {
    await demo(page);
    await patch(
      page,
      `
      const vis = s.notes.find(n => n.id === 'note-delays-feedback');
      vis.meta.attachments = [{
        id: 'att-vis',
        type: 'image',
        driveFileId: '',
        fileName: 'safe-diagram.png',
        mimeType: 'image/png',
        width: 64,
        height: 64,
        previewDataUrl: ${JSON.stringify(TINY_PNG)}
      }];
      const sp = s.notes.find(n => n.id === 'note-leverage-paradigm');
      sp.deltaStatus = 'active';
      sp.deltaTrigger = 'Secret spoiler trigger';
      sp.deltaAction = 'Secret spoiler action';
      sp.meta.attachments = [{
        id: 'att-secret',
        type: 'image',
        driveFileId: '',
        fileName: 'red-wedding-spoiler.png',
        mimeType: 'image/png',
        width: 64,
        height: 64,
        previewDataUrl: ${JSON.stringify(TINY_PNG)}
      }];
      `
    );

    for (const route of ['#/notes', '#/book/book-systems', '#/practice', '#/note/note-leverage-paradigm']) {
      await go(page, route);
      await expect(page.locator('[data-testid$="-view"]').first()).toBeVisible();
      await expect(page.getByTestId('stream-thumb-btn-att-secret')).toHaveCount(0);
      const html = await page.locator('main').innerHTML();
      expect(html, `spoiler filename leak on ${route}`).not.toContain('red-wedding-spoiler.png');
    }

    // On BookDetailView, Escape normally navigates back to #/shelf — when ImageLightbox is open,
    // Escape must ONLY close ImageLightbox and keep the user on #/book/book-systems!
    await go(page, '#/book/book-systems');
    const thumb = page.getByTestId('stream-thumb-btn-att-vis');
    await thumb.click();
    await expect(page.getByTestId('image-lightbox')).toBeVisible();
    const closeBox = await page.getByRole('button', { name: 'Close image lightbox' }).boundingBox();
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('image-lightbox')).toHaveCount(0);
    expect(await page.evaluate(() => window.location.hash)).toBe('#/book/book-systems');
    await expect(thumb).toBeFocused();
  });

  test('BookDetailView Q6 click-to-focus card, single-note J/K focus (jkTick), and editable/dialog shortcut guards', async ({
    page,
  }) => {
    await demo(page);
    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();

    // 1. Clicking directly on a note card's prose focuses the card -> E edits that note, Shift+E edits book.
    const secondCard = page.locator('[data-testid="book-detail-view"] [data-jk-card="1"]');
    await secondCard.locator('p').first().click();
    await expect(secondCard).toBeFocused();
    await page.keyboard.press('e');
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-note-modal')).toHaveCount(0);

    await secondCard.locator('p').first().click();
    await page.keyboard.press('Shift+E');
    await expect(page.getByTestId('edit-book-modal')).toBeVisible();
    await page.keyboard.press('Escape');

    // 2. Typing ?, j, k, e, d inside an input never fires global or view shortcuts.
    const posInput = page.getByTestId('book-detail-advance-input');
    await posInput.click();
    await page.keyboard.press('?');
    await page.keyboard.press('e');
    await page.keyboard.press('d');
    await expect(page.getByTestId('keyboard-help-modal')).toHaveCount(0);
    await expect(page.getByTestId('edit-book-modal')).toHaveCount(0);
    await expect(page.getByTestId('deepen-note-modal')).toHaveCount(0);

    // 3. Single-note book: focusedIndex starts at 0, yet pressing J still focuses card 0 via jkTick so E edits the note!
    await patch(
      page,
      `s.notes = s.notes.filter(n => n.bookId !== 'book-systems' || n.id === 'note-self-organization');`
    );
    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await page.keyboard.press('j');
    await expect(page.locator('[data-testid="book-detail-view"] [data-jk-card="0"]')).toBeFocused();
    await page.keyboard.press('e');
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('beforeprint/afterprint expands SessionsTrail and atomic Socratic prompts for real printing, restores closed state after, and Inter roman+italic faces load', async ({
    page,
  }) => {
    await demo(page);
    await patch(
      page,
      `
      const n = s.notes.find(x => x.id === 'note-delays-feedback');
      n.meta = { ...(n.meta || {}), socraticQuestions: ['Where does the delay hide?', 'Who sees the stock first?'] };
      `
    );

    // Verify self-hosted Inter roman & italic load in document.fonts and ThemeContext syncs meta tags
    await go(page, '#/notes');
    await expect(page.getByTestId('notes-view')).toBeVisible();
    const fontsLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        roman: document.fonts.check('16px Inter'),
        italic: document.fonts.check('italic 16px Inter'),
      };
    });
    expect(fontsLoaded).toEqual({ roman: true, italic: true });

    await page.getByTestId('theme-toggle-btn').click();
    expect(
      await page.evaluate(() => ({
        cls: document.documentElement.classList.contains('light'),
        scheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content'),
        color: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
        saved: localStorage.getItem('pragya_theme'),
      }))
    ).toEqual({ cls: true, scheme: 'light', color: '#FAFAF9', saved: 'light' });

    // BookDetailView beforeprint -> SessionsTrail opens -> afterprint closes
    await go(page, '#/book/book-systems');
    const trail = page.getByTestId('sessions-trail');
    expect(await trail.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });
    expect(await trail.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
    expect((await trail.locator('ol').boundingBox())?.height).toBeGreaterThan(0);
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    expect(await trail.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);

    // NoteDetailView beforeprint -> atomic socratic-prompts-details opens -> afterprint closes
    await go(page, '#/note/delays-in-feedback-loops');
    const socratic = page.getByTestId('socratic-prompts-details');
    expect(await socratic.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });
    expect(await socratic.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
    await expect(socratic.getByText('Where does the delay hide?')).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    expect(await socratic.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
  });

  test('mobile 390x844 touch-target >=44x44px sweep across Notes, Practice, BookDetail, NoteDetail, Settings, More drawer & ConfirmDialog', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await demo(page);

    const checkTargets = async (testIds: string[]) => {
      for (const tid of testIds) {
        const loc = page.getByTestId(tid).first();
        await expect(loc, `${tid} visible`).toBeVisible();
        await expect
          .poll(async () => Math.round((await loc.boundingBox())?.height ?? 0), { message: `${tid} height >= 44` })
          .toBeGreaterThanOrEqual(44);
        await expect
          .poll(async () => Math.round((await loc.boundingBox())?.width ?? 0), { message: `${tid} width >= 44` })
          .toBeGreaterThanOrEqual(44);
      }
    };

    // Shelf targets
    await checkTargets([
      'add-book-btn',
      'advance-10p-btn-book-systems',
      'advance-exact-btn-book-systems',
      'book-capture-btn-book-systems',
    ]);

    // Notes filter pills, tag pills, VIEW NOTE, spoiler reveal
    await go(page, '#/notes');
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await checkTargets([
      'notes-quick-capture-btn',
      'tag-pill-systems',
      'spoiler-reveal-btn-effective-dreaming-ethics',
    ]);
    const viewNoteBox = await page.locator('[data-view-note="true"]').first().boundingBox();
    expect(Math.round(viewNoteBox?.height ?? 0)).toBeGreaterThanOrEqual(44);
    expect(Math.round(viewNoteBox?.width ?? 0)).toBeGreaterThanOrEqual(44);

    // Practice check-in buttons, lifecycle buttons, Shuffle Open / Mark Reviewed
    await go(page, '#/practice');
    await expect(page.getByTestId('practice-view')).toBeVisible();
    await checkTargets([
      'export-json-btn',
      'import-json-btn',
      'delta-apply-btn-note-delays-feedback',
      'delta-missed-btn-note-delays-feedback',
      'delta-graduate-btn-note-delays-feedback',
      'delta-pause-btn-note-delays-feedback',
    ]);

    // More drawer targets
    await page.getByTestId('bottom-nav-more').click();
    await expect(page.getByTestId('mobile-more-drawer')).toBeVisible();
    await checkTargets([
      'drawer-search-btn',
      'drawer-nav-settings',
      'drawer-sync-btn',
      'drawer-theme-toggle',
      'drawer-logout-btn',
    ]);

    // Settings + ConfirmDialog targets
    await page.getByTestId('drawer-nav-settings').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();
    await page.getByTestId('reset-demo-btn').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await checkTargets(['confirm-dialog-cancel-btn', 'confirm-dialog-confirm-btn']);
    await page.getByTestId('confirm-dialog-cancel-btn').click();

    // NoteDetail header & Archive targets
    await go(page, '#/note/self-organization-over-control');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await checkTargets([
      'back-to-notes-btn',
      'edit-note-btn',
      'deepen-note-btn',
      'copy-sparring-prompt-btn',
      'note-detail-archive-btn',
    ]);
  });

  test('QA-41: Shelf Now Reading book title button meets >=44px mobile touch-target height like Up Next / Paused / Finished', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await demo(page);
    const nowReadingTitleBtn = page
      .getByTestId('book-card-book-exhalation')
      .getByRole('button', { name: 'Exhalation: Stories', exact: true });
    await expect(nowReadingTitleBtn).toBeVisible();
    const box = await nowReadingTitleBtn.boundingBox();
    expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(44);
  });

  test('QA-39: CommandPalette hides Keyboard Shortcuts (?) action on touch-only devices per Q13', async ({
    browser,
  }) => {
    const touchContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      const touchPage = await touchContext.newPage();
      await demo(touchPage);
      expect(await touchPage.evaluate(() => window.matchMedia('(any-pointer: fine)').matches)).toBe(false);
      await touchPage.getByTestId('bottom-nav-more').click();
      await touchPage.getByTestId('drawer-search-btn').click();
      await expect(touchPage.getByTestId('command-palette')).toBeVisible();
      await expect(touchPage.getByTestId('command-palette-item-keyboard-shortcuts')).toHaveCount(0);
    } finally {
      await touchContext.close();
    }
  });

  test('QA-40: J/K and card E/D shortcuts work after clicking Sidebar Notes link or closing StreamThumbnail lightbox (when focus is on <a>/<button>)', async ({
    page,
  }) => {
    await demo(page);
    // Real user clicks Sidebar Notes link -> <a data-testid="nav-item-notes"> retains DOM focus!
    await page.getByTestId('nav-item-notes').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await expect(page.getByTestId('nav-item-notes')).toBeFocused();
    await page.keyboard.press('j');
    await expect(page.locator('[data-testid="notes-view"] [data-jk-card="1"]')).toBeFocused();

    // Closing StreamThumbnail lightbox restores focus to <button data-testid="stream-thumb-btn-*"> inside card -> E edits card!
    await patch(
      page,
      `
      const vis = s.notes.find(n => n.id === 'note-self-organization');
      vis.meta.attachments = [{
        id: 'att-card-focus',
        type: 'image',
        driveFileId: '',
        fileName: 'card-focus.png',
        mimeType: 'image/png',
        width: 64,
        height: 64,
        previewDataUrl: ${JSON.stringify(TINY_PNG)}
      }];
      `
    );
    await go(page, '#/book/book-systems');
    const thumb = page.getByTestId('stream-thumb-btn-att-card-focus');
    await thumb.click();
    await expect(page.getByTestId('image-lightbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(thumb).toBeFocused();
    await page.keyboard.press('e');
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('fix-up re-verify: NoteDetailView Related Concepts wikilink-chip routes shielded alias target by uuid, and print keeps titles, tags & sessions-trail-list visible', async ({
    page,
  }) => {
    await demo(page);
    await patch(
      page,
      `
      const sp = s.notes.find(n => n.id === 'note-leverage-paradigm');
      sp.meta = { ...(sp.meta || {}), aliases: ['harmless-early-alias'] };
      const v = s.notes.find(n => n.id === 'note-self-organization');
      v.takeaway = 'Connects to [[harmless-early-alias]].';
      `
    );

    // Related Concepts button `wikilink-chip-harmless-early-alias` must navigate to `#/note/note-leverage-paradigm` (uuid), never leaking `paradigm-shifts-outrank-parameters`!
    await go(page, '#/note/self-organization-over-control');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.getByTestId('wikilink-chip-harmless-early-alias').click();
    await expect(page.getByTestId('spoiler-shield-note-leverage-paradigm')).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe('#/note/note-leverage-paradigm');

    // Print spot-check across Shelf (book titles), Notes (#tag pills), Practice (delta titles), and BookDetail (sessions-trail-list via matchMedia('print'))
    await page.emulateMedia({ media: 'print' });

    await go(page, '#/shelf');
    await expect(
      page.getByTestId('book-card-book-exhalation').getByRole('button', { name: 'Exhalation: Stories', exact: true })
    ).toBeVisible();

    await go(page, '#/notes');
    await expect(page.getByTestId('tag-pill-systems').first()).toBeVisible();

    await go(page, '#/practice');
    await expect(
      page.getByTestId('delta-card-note-delays-feedback').getByRole('button').first()
    ).toBeVisible();

    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('sessions-trail-list')).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
  });
});


