import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Tier 11 (QA, CD Batch 6 — Refactor B: Native `<dialog>` Top-Layer Migration)
 * Adversarial end-to-end probes across all 5 migrated `<dialog>` surfaces + `popover="manual"` toast layer:
 * 1. Genuine `.showModal()` (`:modal`), background inertness (click + programmatic `.focus()` blocked),
 *    and zero `framer-motion` overlay wrappers across Modal, ConfirmDialog, CommandPalette, ImageLightbox,
 *    and BottomNav mobile More drawer (`390×844` safe-area, bottom dock, resize-to-desktop auto-close).
 * 2. Text-selection drag starting inside a dialog and releasing on `::backdrop`:
 *    - Native `closedby` mode (Chromium 134+) across form (`closerequest`) and view-only (`any`) dialogs
 *      (KeyboardHelpModal, PromptFallbackModal, CommandPalette, ImageLightbox, BottomNav drawer).
 *    - Safari / Chromium <134 fallback (`!('closedBy' in HTMLDialogElement.prototype)`).
 * 3. Nested top-layer stacking, `Space` & `Escape` layering, sibling dialog focus handoff, and
 *    `useModalDraft` synchronous flush on native `cancel` (`DeepenNoteModal` -> `ImageLightbox`,
 *    `EditNoteModal` -> `ConfirmDialog` `role="alertdialog"`, `CapstoneModal` -> `PromptFallbackModal`,
 *    `EditNoteModal` -> `WikilinkAutocomplete`, `CommandPalette` -> `QuickCaptureModal`,
 *    `BottomNav` drawer -> `CommandPalette`).
 * 4. Non-modal `popover="manual"` toast focus & click-through safety.
 * 5. Regression checks for QA-44 (interactive reparented toast-layer), QA-45 (busy ConfirmDialog
 *    CloseWatcher double-Escape resilience), and full nested toast-host reparenting (`body → dlg1 → dlg2 → dlg1 → body`).
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

async function patchDemo(page: Page, fn: string) {
  await page.evaluate(src => {
    const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
    new Function('s', src)(s);
    localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
  }, fn);
  await page.reload();
  await expect(page.locator('[data-testid$="-view"]').first()).toBeVisible();
}

async function assertBackgroundInert(page: Page, bgTestId: string) {
  const result = await page.getByTestId(bgTestId).evaluate(el => {
    const htmlEl = el as HTMLElement;
    htmlEl.focus();
    const becameFocused = document.activeElement === htmlEl;
    const rect = htmlEl.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const hitIsBackground = Boolean(hit && (hit === htmlEl || htmlEl.contains(hit)));
    return { becameFocused, hitIsBackground };
  });
  expect(result.becameFocused).toBe(false);
  expect(result.hitIsBackground).toBe(false);
}

test.describe('Tier 11 — CD Batch 6 QA adversarial native <dialog> probes', () => {
  test('all 5 native <dialog> surfaces use showModal() (:modal), enforce genuine background inertness (click + .focus()), and have zero framer-motion wrappers', async ({
    page,
  }) => {
    await demo(page);
    await patchDemo(
      page,
      `
      const n = s.notes.find(x => x.id === 'note-delays-feedback');
      n.meta = {
        ...(n.meta || {}),
        attachments: [{
          id: 'att-qa6-img',
          type: 'image',
          driveFileId: 'demo-qa6-img',
          fileName: 'qa6-diagram.png',
          mimeType: 'image/png',
          width: 640,
          height: 480,
          previewDataUrl: ${JSON.stringify(TINY_PNG)}
        }]
      };
      `
    );

    // 1. Modal (QuickCaptureModal)
    await page.keyboard.press('n');
    const capModal = page.getByTestId('quick-capture-modal');
    await expect(capModal).toBeVisible();
    expect(
      await capModal.evaluate(el => ({
        tag: el.tagName,
        modal: el.matches(':modal'),
        hasFramerMotionDiv: Boolean(el.querySelector('[style*="transform"]')),
      }))
    ).toEqual({ tag: 'DIALOG', modal: true, hasFramerMotionDiv: false });
    await assertBackgroundInert(page, 'add-book-btn');
    await page.keyboard.press('Escape');
    await expect(capModal).toHaveCount(0);

    // 2. CommandPalette
    await page.getByTestId('command-palette-trigger').click();
    const palette = page.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    expect(await palette.evaluate(el => el.tagName === 'DIALOG' && el.matches(':modal'))).toBe(true);
    await assertBackgroundInert(page, 'add-book-btn');
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    // 3. ConfirmDialog (role="alertdialog")
    await go(page, '#/settings');
    await page.getByTestId('reset-demo-btn').click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();
    expect(
      await confirm.evaluate(el => ({
        tag: el.tagName,
        modal: el.matches(':modal'),
        role: el.getAttribute('role'),
      }))
    ).toEqual({ tag: 'DIALOG', modal: true, role: 'alertdialog' });
    await assertBackgroundInert(page, 'nav-item-shelf');
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);

    // 4. ImageLightbox
    await go(page, '#/notes');
    await page.getByTestId('stream-thumb-btn-att-qa6-img').click();
    const lightbox = page.getByTestId('image-lightbox');
    await expect(lightbox).toBeVisible();
    expect(await lightbox.evaluate(el => el.tagName === 'DIALOG' && el.matches(':modal'))).toBe(true);
    await assertBackgroundInert(page, 'nav-item-shelf');
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);

    // 5. BottomNav mobile drawer at 390x844 (bottom-docked, safe-area padding, backdrop & Escape, resize auto-close)
    await page.setViewportSize({ width: 390, height: 844 });
    const moreBtn = page.getByTestId('bottom-nav-more');
    await moreBtn.click();
    const drawer = page.getByTestId('mobile-more-drawer');
    await expect(drawer).toBeVisible();
    await expect
      .poll(async () =>
        drawer.evaluate(el => {
          const r = el.getBoundingClientRect();
          const inner = el.firstElementChild as HTMLElement | null;
          return {
            tag: el.tagName,
            modal: el.matches(':modal'),
            bottom: Math.round(r.bottom),
            width: Math.round(r.width),
            hasSafeAreaBottom: Boolean(inner?.className.includes('safe-area-inset-bottom')),
            overflowX: document.documentElement.scrollWidth > window.innerWidth,
          };
        })
      )
      .toEqual({
        tag: 'DIALOG',
        modal: true,
        bottom: 844,
        width: 390,
        hasSafeAreaBottom: true,
        overflowX: false,
      });
    await assertBackgroundInert(page, 'bottom-nav-shelf');

    // Escape closes drawer and restores focus to More trigger
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(moreBtn).toBeFocused();

    // Backdrop click above drawer closes & restores focus
    await moreBtn.click();
    await expect(drawer).toBeVisible();
    await page.mouse.click(20, 20);
    await expect(drawer).toHaveCount(0);
    await expect(moreBtn).toBeFocused();

    // Reopen drawer -> resize to desktop -> auto-closes and desktop nav is immediately clickable (not inert!)
    await moreBtn.click();
    await expect(drawer).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(drawer).toHaveCount(0);
    await page.getByTestId('nav-item-shelf').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
  });

  test('native closedby mode: text-selection drag onto ::backdrop NEVER closes form (closerequest) or view-only (any) dialogs', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('Clipboard blocked by QA')) },
      });
      document.execCommand = () => false;
    });

    await demo(page);
    await patchDemo(
      page,
      `
      const n = s.notes.find(x => x.id === 'note-delays-feedback');
      n.meta = {
        ...(n.meta || {}),
        attachments: [{
          id: 'att-drag-img',
          type: 'image',
          driveFileId: 'demo-drag-img',
          fileName: 'drag-test.png',
          mimeType: 'image/png',
          width: 400,
          height: 300,
          previewDataUrl: ${JSON.stringify(TINY_PNG)}
        }]
      };
      `
    );

    // 1. Form modal (QuickCaptureModal, closedby="closerequest"): drag out of textarea -> stays open
    await page.keyboard.press('n');
    const capModal = page.getByTestId('quick-capture-modal');
    const ta = page.getByTestId('capture-takeaway-input');
    await ta.fill('Drag text selection onto backdrop');
    const taBox = await ta.boundingBox();
    expect(taBox).not.toBeNull();
    await page.mouse.move(taBox!.x + 60, taBox!.y + 20);
    await page.mouse.down();
    await page.mouse.move(6, 6, { steps: 5 });
    await page.mouse.up();
    await expect(capModal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(capModal).toHaveCount(0);

    // 2. View-only ImageLightbox (closedby="any"): drag from caption pill onto backdrop -> stays open; direct click closes
    await go(page, '#/notes');
    await page.getByTestId('stream-thumb-btn-att-drag-img').click();
    const lightbox = page.getByTestId('image-lightbox');
    await expect(lightbox).toBeVisible();
    const lbBox = await lightbox.boundingBox();
    expect(lbBox).not.toBeNull();
    await page.mouse.move(lbBox!.x + lbBox!.width / 2, lbBox!.y + lbBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(10, 10, { steps: 5 });
    await page.mouse.up();
    await expect(lightbox).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(lightbox).toHaveCount(0);

    // 3. View-only PromptFallbackModal (closedby="any"): drag from prompt textarea onto backdrop -> stays open; direct click closes
    await go(page, '#/book/book-finite');
    await page.getByTestId('copy-capstone-prompt-btn').click();
    const fbModal = page.getByTestId('capstone-prompt-fallback-modal');
    await expect(fbModal).toBeVisible();
    const fbBox = await fbModal.locator('textarea').boundingBox();
    expect(fbBox).not.toBeNull();
    await page.mouse.move(fbBox!.x + 40, fbBox!.y + 40);
    await page.mouse.down();
    await page.mouse.move(6, 6, { steps: 5 });
    await page.mouse.up();
    await expect(fbModal).toBeVisible();
    await page.mouse.click(6, 6);
    await expect(fbModal).toHaveCount(0);

    // 4. BottomNav mobile drawer (closedby="any") at 390x844: drag from inside drawer onto backdrop -> stays open; direct click closes
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('bottom-nav-more').click();
    const drawer = page.getByTestId('mobile-more-drawer');
    await expect(drawer).toBeVisible();
    const drawerBox = await drawer.boundingBox();
    expect(drawerBox).not.toBeNull();
    await page.mouse.move(drawerBox!.x + 40, drawerBox!.y + 30);
    await page.mouse.down();
    await page.mouse.move(20, 20, { steps: 5 });
    await page.mouse.up();
    await expect(drawer).toBeVisible();
    await page.mouse.click(20, 20);
    await expect(drawer).toHaveCount(0);
  });

  test('Safari / Chromium<134 fallback (!closedBy in HTMLDialogElement.prototype): drags never close, direct backdrop click closes view-only dialogs only', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      try {
        delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>).closedBy;
      } catch {
        // ignore if non-configurable
      }
      const origSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name: string, value: string) {
        if (this.tagName === 'DIALOG' && name.toLowerCase() === 'closedby') {
          return;
        }
        return origSetAttribute.call(this, name, value);
      };
    });

    await demo(page);
    expect(await page.evaluate(() => 'closedBy' in HTMLDialogElement.prototype)).toBe(false);

    // 1. Form modal (QuickCaptureModal): drag & direct backdrop click both stay open
    await page.keyboard.press('n');
    const capModal = page.getByTestId('quick-capture-modal');
    await expect(capModal).toBeVisible();
    const ta = page.getByTestId('capture-takeaway-input');
    await ta.fill('Drag selection inside form modal');
    const taBox = await ta.boundingBox();
    expect(taBox).not.toBeNull();
    await page.mouse.move(taBox!.x + 60, taBox!.y + 20);
    await page.mouse.down();
    await page.mouse.move(6, 6, { steps: 5 });
    await page.mouse.up();
    await expect(capModal).toBeVisible();
    await page.mouse.click(6, 6);
    await expect(capModal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(capModal).toHaveCount(0);

    // 2. View-only modal (KeyboardHelpModal): fallback ignores forward/reverse drags & detail===0, closes on direct backdrop click
    const helpBtn = page.getByTestId('keyboard-help-btn');
    await helpBtn.click();
    const helpModal = page.getByTestId('keyboard-help-modal');
    await expect(helpModal).toBeVisible();
    expect(await helpModal.getAttribute('closedby')).toBeNull();
    const helpBox = await helpModal.boundingBox();
    expect(helpBox).not.toBeNull();

    await page.mouse.move(helpBox!.x + 50, helpBox!.y + 40);
    await page.mouse.down();
    await page.mouse.move(6, 6, { steps: 5 });
    await page.mouse.up();
    await expect(helpModal).toBeVisible();

    await page.mouse.move(6, 6);
    await page.mouse.down();
    await page.mouse.move(helpBox!.x + 50, helpBox!.y + 40, { steps: 5 });
    await page.mouse.up();
    await expect(helpModal).toBeVisible();

    await page.mouse.click(6, 6);
    await expect(helpModal).toHaveCount(0);
    await expect(helpBtn).toBeFocused();

    // 3. CommandPalette via fallback
    await page.getByTestId('command-palette-trigger').click();
    const palette = page.getByTestId('command-palette');
    const cmdInput = page.getByTestId('command-palette-input');
    await cmdInput.fill('Feedback');
    const inputBox = await cmdInput.boundingBox();
    expect(inputBox).not.toBeNull();
    await page.mouse.move(inputBox!.x + 50, inputBox!.y + inputBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(8, 8, { steps: 5 });
    await page.mouse.up();
    await expect(palette).toBeVisible();
    await page.mouse.click(8, 8);
    await expect(palette).toHaveCount(0);

    // 4. BottomNav mobile drawer via fallback at 390x844
    await page.setViewportSize({ width: 390, height: 844 });
    const moreBtn = page.getByTestId('bottom-nav-more');
    await moreBtn.click();
    const drawer = page.getByTestId('mobile-more-drawer');
    await expect(drawer).toBeVisible();
    const drawerBox = await drawer.boundingBox();
    expect(drawerBox).not.toBeNull();
    await page.mouse.move(drawerBox!.x + 40, drawerBox!.y + 30);
    await page.mouse.down();
    await page.mouse.move(20, 20, { steps: 5 });
    await page.mouse.up();
    await expect(drawer).toBeVisible();
    await page.mouse.click(20, 20);
    await expect(drawer).toHaveCount(0);
    await expect(moreBtn).toBeFocused();
  });

  test('nested top-layer stacking, Space/Escape layering, sibling focus handoff, and useModalDraft synchronous flush on native cancel', async ({
    page,
  }) => {
    await demo(page);
    await patchDemo(
      page,
      `
      const n = s.notes.find(x => x.id === 'note-delays-feedback');
      n.meta = {
        ...(n.meta || {}),
        attachments: [{
          id: 'att-nested-img',
          type: 'image',
          driveFileId: 'demo-nested-img',
          fileName: 'nested-diagram.png',
          mimeType: 'image/png',
          width: 900,
          height: 600,
          previewDataUrl: ${JSON.stringify(TINY_PNG)}
        }]
      };
      `
    );

    // 1. DeepenNoteModal -> ImageLightbox: Space & Escape both close ONLY lightbox, restore focus inside parent, 2nd Escape flushes draft
    await go(page, '#/note/delays-in-feedback-loops');
    await page.getByTestId('deepen-note-btn').click();
    const deepenModal = page.getByTestId('deepen-note-modal');
    await expect(deepenModal).toBeVisible();

    await page.getByTestId('deepen-takeaway-input').fill('Unsaved deepen insight before lightbox');
    const thumbBtn = page.getByTestId('deepen-attachment-image-att-nested-img');
    await thumbBtn.click();
    const lightbox = page.getByTestId('image-lightbox');
    await expect(lightbox).toBeVisible();

    // Space closes ONLY lightbox (never re-opens on Space keyup) & restores focus to thumbBtn inside DeepenNoteModal
    await page.keyboard.press(' ');
    await expect(lightbox).toHaveCount(0);
    await expect(deepenModal).toBeVisible();
    await expect(thumbBtn).toBeFocused();

    // Reopen lightbox -> 1st Escape closes ONLY lightbox -> immediate 2nd Escape closes DeepenNoteModal & flushes draft
    await thumbBtn.click();
    await expect(lightbox).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
    await expect(deepenModal).toBeVisible();
    await expect(thumbBtn).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(deepenModal).toHaveCount(0);
    const savedDeepenDraft = await page.evaluate(() =>
      localStorage.getItem('pragya_draft:demo:pragya_draft_deepen_note-delays-feedback')
    );
    expect(savedDeepenDraft).toContain('Unsaved deepen insight before lightbox');

    // 2. EditNoteModal -> ConfirmDialog (role="alertdialog"): Cancel focused, backdrop ignored, 1st Esc = confirm only, 2nd Esc = flush edit draft
    await page.getByTestId('edit-note-btn').click();
    const editModal = page.getByTestId('edit-note-modal');
    await expect(editModal).toBeVisible();
    await page.getByTestId('edit-note-takeaway-input').fill('Unsaved edit takeaway before archive confirm');
    const archiveBtn = page.getByTestId('archive-note-btn');
    await archiveBtn.click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();
    await expect(page.getByTestId('confirm-dialog-cancel-btn')).toBeFocused();

    await page.mouse.click(6, 6);
    await expect(confirm).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(editModal).toBeVisible();
    await expect(archiveBtn).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(editModal).toHaveCount(0);
    const savedEditDraft = await page.evaluate(() =>
      localStorage.getItem('pragya_draft:demo:pragya_draft_edit_note-delays-feedback')
    );
    expect(savedEditDraft).toContain('Unsaved edit takeaway before archive confirm');

    // 3. Sibling dialog handoff: CommandPalette -> New Capture (focus stays in QuickCaptureModal)
    await go(page, '#/shelf');
    await page.getByTestId('command-palette-trigger').click();
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.getByTestId('command-palette-item-new-capture').click();
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    const capModal = page.getByTestId('quick-capture-modal');
    await expect(capModal).toBeVisible();
    expect(
      await capModal.evaluate(el => Boolean(document.activeElement && el.contains(document.activeElement)))
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(capModal).toHaveCount(0);

    // 4. Sibling dialog handoff on mobile: BottomNav drawer -> Search & Commands -> CommandPalette input focused
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('bottom-nav-more').click();
    await expect(page.getByTestId('mobile-more-drawer')).toBeVisible();
    await page.getByTestId('drawer-search-btn').click();
    await expect(page.getByTestId('mobile-more-drawer')).toHaveCount(0);
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await expect(page.getByTestId('command-palette-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    // 5. Cmd/Ctrl+K CommandPalette opened on top of an already-open Modal (AddBookModal): 1st Esc = palette, 2nd Esc = modal
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByTestId('add-book-btn').click();
    const addBookModal = page.getByTestId('add-book-modal');
    await expect(addBookModal).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const stackedPalette = page.getByTestId('command-palette');
    await expect(stackedPalette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(stackedPalette).toHaveCount(0);
    await expect(addBookModal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(addBookModal).toHaveCount(0);
  });

  test('non-modal popover="manual" toast does not steal focus or block clicks on the rest of the page', async ({
    page,
  }) => {
    await demo(page);

    const advBtn = page.getByTestId('advance-10p-btn-book-systems');
    await advBtn.click();
    const toast = page.getByTestId('notification-toast').last();
    await expect(toast).toBeVisible();
    expect(await page.getByTestId('toast-layer').evaluate(el => el.matches(':popover-open'))).toBe(
      true
    );

    // Must not steal focus into toast-layer
    const focusInToast = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('[data-testid="toast-layer"]'))
    );
    expect(focusInToast).toBe(false);

    // Clicking another page control works while toast is open (wrapper is click-through)
    await page.getByTestId('nav-item-notes').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();

    // Clicking Undo on the toast while no modal is open works cleanly
    const undoBtn = page.getByTestId('toast-undo-btn').last();
    await expect(undoBtn).toBeVisible();
    await undoBtn.click();
    await expect(page.getByTestId('notification-toast').last()).toContainText(
      'Reverted bookmark update'
    );
  });

  test('QA-44: toast dismiss & Undo action buttons must remain interactive (not inert) over an open <dialog:modal> and must not click through onto closedby="any" backdrops', async ({
    page,
  }) => {
    await demo(page);

    // 1. Trigger +10p Undo toast, then open AddBookModal while toast is visible
    await page.getByTestId('advance-10p-btn-book-systems').click();
    const undoBtn = page.getByTestId('toast-undo-btn').last();
    await expect(undoBtn).toBeVisible();
    await page.getByTestId('add-book-btn').click();
    const addBookModal = page.getByTestId('add-book-modal');
    await expect(addBookModal).toBeVisible();

    // Wait for toast entry slide to settle inside viewport
    await page.waitForTimeout(250);
    const undoBox = await undoBtn.boundingBox();
    expect(undoBox).not.toBeNull();

    // elementFromPoint over the Undo button must hit toast-layer (not pass through inert toast to dialog)
    const hitInsideToast = await page.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="toast-layer"]')),
      { x: undoBox!.x + undoBox!.width / 2, y: undoBox!.y + undoBox!.height / 2 }
    );
    expect(hitInsideToast).toBe(true);

    // Clicking Undo while AddBookModal is open must execute Undo and keep AddBookModal open
    await page.mouse.click(undoBox!.x + undoBox!.width / 2, undoBox!.y + undoBox!.height / 2);
    await expect(page.getByTestId('notification-toast').last()).toContainText(
      'Reverted bookmark update',
      { timeout: 1500 }
    );
    await expect(addBookModal).toBeVisible();

    // 2. Clicking a toast over a closedby="any" modal (KeyboardHelpModal) must dismiss ONLY the toast, NOT the modal
    await page.keyboard.press('Escape');
    await expect(addBookModal).toHaveCount(0);
    await page.getByTestId('advance-10p-btn-book-systems').click();
    const toast2 = page.getByTestId('notification-toast').last();
    await expect(toast2).toBeVisible();
    await page.getByTestId('keyboard-help-btn').click();
    const helpModal = page.getByTestId('keyboard-help-modal');
    await expect(helpModal).toBeVisible();
    await page.waitForTimeout(250);
    const t2Box = await toast2.boundingBox();
    expect(t2Box).not.toBeNull();
    await page.mouse.click(t2Box!.x + t2Box!.width / 2, t2Box!.y + t2Box!.height / 2);
    await expect(helpModal).toBeVisible();
    await expect(toast2).toHaveCount(0);
  });

  test('QA-45: double Escape on a busy ConfirmDialog during an in-flight delete must not close <dialog> out from under React', async ({
    page,
  }) => {
    // Seed a signed-in Cloud session with 1 archived note and a slow failing :batchUpdate
    await page.addInitScript(() => {
      if (!localStorage.getItem('pragya_google_token')) {
        localStorage.setItem('pragya_google_token', 'qa6-token');
        localStorage.setItem('pragya_google_token_expiry', String(Date.now() + 3600_000));
        localStorage.setItem(
          'pragya_google_user',
          JSON.stringify({ name: 'QA Reader', email: 'qa@example.com' })
        );
        localStorage.setItem('pragya_spreadsheet_id', 'sheet-qa6');
      }
    });

    const HEADERS: Record<string, string[]> = {
      Books: ['id', 'title', 'author', 'kind', 'format', 'status', 'current_pos', 'total_pos', 'pos_unit', 'normalized_pos', 'doc_url', 'meta_json'],
      Notes: ['id', 'slug', 'book_id', 'created_at', 'updated_at', 'pos', 'normalized_pos', 'status', 'source', 'tags_json', 'quote', 'takeaway', 'context_mechanism', 'critique', 'delta_trigger', 'delta_action', 'delta_status', 'meta_json'],
      Sessions: ['id', 'book_id', 'date', 'start_pos', 'end_pos', 'updated_at', 'note'],
      DeltaLogs: ['id', 'note_id', 'date', 'outcome', 'note'],
    };
    const SHEET_ID: Record<string, number> = { Books: 1, Notes: 2, Sessions: 3, DeltaLogs: 4 };
    const sheet: Record<string, string[][]> = {
      Books: [['b1', 'Systems', 'Meadows', 'nonfiction', 'physical', 'reading', '50', '200', 'page', '0.25', '', '{"updatedAt":"2026-11-01T00:00:00.000Z"}']],
      Notes: [['n1', 'arch-note', 'b1', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '10', '0.05', 'atomic', 'app', '[]', 'q', 't', '', '', '', '', 'none', '{"title":"Archived Note","archivedAt":"2026-11-02T00:00:00.000Z"}']],
      Sessions: [],
      DeltaLogs: [],
    };

    let releaseBatch!: () => void;
    const batchStarted = new Promise<void>(r => {
      releaseBatch = r;
    });
    let resolveFail!: () => void;
    const waitToFail = new Promise<void>(r => {
      resolveFail = r;
    });

    await page.route('https://www.googleapis.com/**', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          route.request().url().includes('drive/v3/files/sheet-qa6')
            ? { id: 'sheet-qa6', modifiedTime: '2026-11-15T10:00:00Z' }
            : { files: [] }
        ),
      })
    );
    await page.route('https://oauth2.googleapis.com/**', route => route.fulfill({ status: 200, body: '{}' }));
    await page.route('https://sheets.googleapis.com/**', async (route: Route) => {
      const req = route.request();
      const href = req.url();
      const json = (b: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
      if (href.includes('fields=sheets.properties')) {
        await json({
          sheets: Object.entries(SHEET_ID).map(([title, sheetId]) => ({ properties: { title, sheetId } })),
        });
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
        releaseBatch();
        await waitToFail;
        await json({ error: { code: 500, message: 'backendError' } }, 500);
        return;
      }
      await json({});
    });

    await page.goto('/#/note/arch-note');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.getByTestId('delete-forever-btn').click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();

    // Start Delete Forever (busy=true while batchUpdate is held open)
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await batchStarted;

    // Press Escape TWICE rapidly while busy=true (tests Chromium CloseWatcher non-cancelable 2nd Escape)
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Release server 500 error so ConfirmDialog should stay open & retryable
    resolveFail();
    await expect(page.getByTestId('notification-toast').last()).toContainText("Couldn't delete");

    // Dialog MUST still be visibly open (`dialog.open === true` and `:modal`), never closed out from under React!
    const state = await confirm.evaluate(el => ({
      open: (el as HTMLDialogElement).open,
      modal: el.matches(':modal'),
    }));
    expect(state).toEqual({ open: true, modal: true });
    await expect(confirm).toBeVisible();
  });

  test('toast-layer reparenting (body -> dlg1 -> dlg2 -> dlg1 -> body) never orphans <Toaster> or breaks post-cycle non-modal toasts', async ({
    page,
  }) => {
    await demo(page);

    const toastParentState = () =>
      page.evaluate(() => {
        const host = document.querySelector('[data-testid="toast-layer"]');
        const parent = host?.parentElement;
        return {
          connected: Boolean(host?.isConnected),
          popoverOpen: Boolean(host?.matches(':popover-open')),
          parentTag: parent?.tagName || null,
          parentTestId: parent?.getAttribute('data-testid') || null,
        };
      });

    // 1. Initial mount: attached to <body>
    expect(await toastParentState()).toEqual({
      connected: true,
      popoverOpen: true,
      parentTag: 'BODY',
      parentTestId: null,
    });

    // 2. Open dlg1 (AddBookModal): reparents into add-book-modal
    await page.getByTestId('add-book-btn').click();
    const dlg1 = page.getByTestId('add-book-modal');
    await expect(dlg1).toBeVisible();
    expect(await toastParentState()).toEqual({
      connected: true,
      popoverOpen: true,
      parentTag: 'DIALOG',
      parentTestId: 'add-book-modal',
    });

    // 3. Open dlg2 (CommandPalette via Cmd/Ctrl+K) on top of dlg1: reparents into command-palette
    await page.keyboard.press('ControlOrMeta+k');
    const dlg2 = page.getByTestId('command-palette');
    await expect(dlg2).toBeVisible();
    expect(await toastParentState()).toEqual({
      connected: true,
      popoverOpen: true,
      parentTag: 'DIALOG',
      parentTestId: 'command-palette',
    });

    // 4. Close dlg2 -> rescues back into dlg1 (add-book-modal) & validation toast is still clickable inside dlg1
    await page.keyboard.press('Escape');
    await expect(dlg2).toHaveCount(0);
    await expect(dlg1).toBeVisible();
    expect(await toastParentState()).toEqual({
      connected: true,
      popoverOpen: true,
      parentTag: 'DIALOG',
      parentTestId: 'add-book-modal',
    });
    await page.getByTestId('book-title-input').fill('   ');
    await page.getByTestId('book-submit-btn').click();
    const errToast = page.locator('[data-testid="notification-toast"][data-toast-variant="error"]').last();
    await expect(errToast).toBeVisible();
    await page.waitForTimeout(250);
    const errBox = await errToast.boundingBox();
    expect(errBox).not.toBeNull();
    await page.mouse.click(errBox!.x + errBox!.width / 2, errBox!.y + errBox!.height / 2);
    await expect(errToast).toHaveCount(0);
    await expect(dlg1).toBeVisible();

    // 5. Close dlg1 -> rescues back to <body>, never orphaned
    await page.keyboard.press('Escape');
    await expect(dlg1).toHaveCount(0);
    expect(await toastParentState()).toEqual({
      connected: true,
      popoverOpen: true,
      parentTag: 'BODY',
      parentTestId: null,
    });

    // 6. Post-cycle non-modal toast works cleanly (renders, doesn't steal focus, Undo works)
    await page.getByTestId('advance-10p-btn-book-systems').click();
    const undoBtn = page.getByTestId('toast-undo-btn').last();
    await expect(undoBtn).toBeVisible();
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="toast-layer"]')))
    ).toBe(false);
    await undoBtn.click();
    await expect(page.getByTestId('notification-toast').last()).toContainText(
      'Reverted bookmark update'
    );
  });
});
