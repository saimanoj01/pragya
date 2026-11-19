import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 10 — CD Batch 6 (Refactor B: Native `<dialog>` Top-Layer Migration)
 * Verifies:
 * 1. Native `<dialog>` opened via `.showModal()` (`:modal`, `open`, `closedby`) across
 *    Modal, ConfirmDialog (`role="alertdialog"`), CommandPalette, ImageLightbox, and BottomNav drawer.
 * 2. Light-dismiss policy & text-selection drag safety (view-only dialogs close on direct backdrop
 *    click, NEVER on drag from content to backdrop; forms & confirms NEVER close on backdrop click).
 * 3. Top-layer stacking & nested Escape layering:
 *    - ImageLightbox escaping DeepenNoteModal's card into the full viewport top layer
 *    - ConfirmDialog (`role="alertdialog"`) stacked over EditNoteModal (paste blocked underneath)
 *    - PromptFallbackModal stacked over CapstoneModal (drag-select safe, 1st Esc = top only, 2nd Esc = draft flush)
 *    - WikilinkAutocomplete `[data-popover="true"]` inside QuickCaptureModal (1st Esc = popup, 2nd Esc = modal)
 * 4. Background inertness, scroll lock (`:has(dialog:modal)`), native Tab cycling, shortcut guards
 *    on `role="alertdialog"`, and focus restoration to the invoker.
 * 5. Sonner `<Toaster>` top-layer promotion (`popover="manual"` `:popover-open`) above open modals.
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

async function inspectNativeModalDialog(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate(el => ({
    tagName: el.tagName,
    open: (el as HTMLDialogElement).open,
    isModal: el.matches(':modal'),
    role: el.getAttribute('role'),
    closedby: el.getAttribute('closedby'),
    ariaModal: el.getAttribute('aria-modal'),
  }));
}

test.describe('Tier 10 — CD Batch 6 native <dialog> top-layer migration', () => {
  test('all migrated overlays open as native :modal <dialog> via showModal() with correct roles, closedby, scroll lock & focus restore', async ({
    page,
  }) => {
    await demo(page);

    // 1. Standard form Modal (AddBookModal): closedby="closerequest", role="dialog", scroll lock active
    const addBookBtn = page.getByTestId('add-book-btn');
    await addBookBtn.click();
    await expect(page.getByTestId('add-book-modal')).toBeVisible();
    const addBookBox = await page.getByTestId('add-book-modal').boundingBox();
    expect(addBookBox).not.toBeNull();
    expect(addBookBox!.width).toBeLessThanOrEqual(520); // max-w-lg (512px), never full-width 1248px
    expect(await inspectNativeModalDialog(page, 'add-book-modal')).toEqual({
      tagName: 'DIALOG',
      open: true,
      isModal: true,
      role: 'dialog',
      closedby: 'closerequest',
      ariaModal: 'true',
    });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
      'hidden'
    );
    // Direct backdrop click on a form modal MUST NOT close it
    await page.mouse.click(6, 6);
    await expect(page.getByTestId('add-book-modal')).toBeVisible();
    // Escape closes and restores focus to Add Book trigger + releases scroll lock
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('add-book-modal')).toHaveCount(0);
    await expect(addBookBtn).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe(
      'hidden'
    );

    // 2. CommandPalette: native :modal <dialog>, closedby="any", input focused, Escape restores focus
    const cmdTrigger = page.getByTestId('command-palette-trigger');
    await cmdTrigger.click();
    await expect(page.getByTestId('command-palette')).toBeVisible();
    const paletteBox = await page.getByTestId('command-palette').boundingBox();
    expect(paletteBox).not.toBeNull();
    expect(paletteBox!.width).toBeLessThanOrEqual(584); // max-w-xl (576px)
    expect(await inspectNativeModalDialog(page, 'command-palette')).toEqual({
      tagName: 'DIALOG',
      open: true,
      isModal: true,
      role: 'dialog',
      closedby: 'any',
      ariaModal: 'true',
    });
    await expect(page.getByTestId('command-palette-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await expect(cmdTrigger).toBeFocused();

    // 3. View-only Modal (KeyboardHelpModal): closedby="any", direct backdrop click closes, restores focus
    const helpBtn = page.getByTestId('keyboard-help-btn');
    await helpBtn.click();
    await expect(page.getByTestId('keyboard-help-modal')).toBeVisible();
    expect(await inspectNativeModalDialog(page, 'keyboard-help-modal')).toEqual({
      tagName: 'DIALOG',
      open: true,
      isModal: true,
      role: 'dialog',
      closedby: 'any',
      ariaModal: 'true',
    });
    await page.mouse.click(6, 6);
    await expect(page.getByTestId('keyboard-help-modal')).toHaveCount(0);
    await expect(helpBtn).toBeFocused();

    // 4. ConfirmDialog: native :modal <dialog role="alertdialog" closedby="closerequest">, Cancel autofocused
    await go(page, '#/settings');
    const resetBtn = page.getByTestId('reset-demo-btn');
    await resetBtn.click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    const confirmBox = await page.getByTestId('confirm-dialog').boundingBox();
    expect(confirmBox).not.toBeNull();
    expect(confirmBox!.width).toBeLessThanOrEqual(456); // max-w-md (448px)
    expect(await inspectNativeModalDialog(page, 'confirm-dialog')).toEqual({
      tagName: 'DIALOG',
      open: true,
      isModal: true,
      role: 'alertdialog',
      closedby: 'closerequest',
      ariaModal: 'true',
    });
    await expect(page.getByTestId('confirm-dialog-cancel-btn')).toBeFocused();
    // Backdrop click outside ConfirmDialog NEVER dismisses it
    await page.mouse.click(6, 6);
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    // Global shortcuts ('n', '?') are blocked while alertdialog is open
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await expect(resetBtn).toBeFocused();

    // 5. BottomNav mobile More drawer: native :modal <dialog closedby="any">, autofocus first item, desktop resize closes
    await page.setViewportSize({ width: 390, height: 844 });
    const moreBtn = page.getByTestId('bottom-nav-more');
    await moreBtn.click();
    await expect(page.getByTestId('mobile-more-drawer')).toBeVisible();
    expect(await inspectNativeModalDialog(page, 'mobile-more-drawer')).toEqual({
      tagName: 'DIALOG',
      open: true,
      isModal: true,
      role: 'dialog',
      closedby: 'any',
      ariaModal: 'true',
    });
    await expect(page.getByTestId('mobile-more-drawer')).not.toHaveAttribute('data-popover', 'true');
    await expect(page.getByTestId('drawer-search-btn')).toBeFocused();
    // Backdrop tap above bottom drawer closes it and restores focus to More button
    await page.mouse.click(20, 20);
    await expect(page.getByTestId('mobile-more-drawer')).toHaveCount(0);
    await expect(moreBtn).toBeFocused();
    // Reopen and widen viewport to desktop -> auto-closes so hidden modal cannot inert desktop
    await moreBtn.click();
    await expect(page.getByTestId('mobile-more-drawer')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('mobile-more-drawer')).toHaveCount(0);
  });

  test('light-dismiss text-selection drag safety: dragging from dialog content onto backdrop NEVER closes view-only dialogs', async ({
    page,
  }) => {
    await demo(page);

    // 1. KeyboardHelpModal (closedby="any"): drag from heading out onto backdrop -> stays open!
    await page.getByTestId('keyboard-help-btn').click();
    const helpModal = page.getByTestId('keyboard-help-modal');
    await expect(helpModal).toBeVisible();
    const helpBox = await helpModal.boundingBox();
    expect(helpBox).not.toBeNull();

    await page.mouse.move(helpBox!.x + 40, helpBox!.y + 30);
    await page.mouse.down();
    await page.mouse.move(6, 6, { steps: 5 });
    await page.mouse.up();
    await expect(helpModal).toBeVisible();

    // Reverse drag (backdrop -> inside modal) -> stays open!
    await page.mouse.move(6, 6);
    await page.mouse.down();
    await page.mouse.move(helpBox!.x + 40, helpBox!.y + 30, { steps: 5 });
    await page.mouse.up();
    await expect(helpModal).toBeVisible();

    // Direct backdrop click (pointerdown + click both on backdrop) -> closes!
    await page.mouse.click(6, 6);
    await expect(helpModal).toHaveCount(0);

    // 2. CommandPalette (closedby="any"): drag text from search input out onto backdrop -> stays open!
    await page.getByTestId('command-palette-trigger').click();
    const palette = page.getByTestId('command-palette');
    const cmdInput = page.getByTestId('command-palette-input');
    await cmdInput.fill('Systems');
    const inputBox = await cmdInput.boundingBox();
    expect(inputBox).not.toBeNull();

    await page.mouse.move(inputBox!.x + 50, inputBox!.y + inputBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(8, 8, { steps: 5 });
    await page.mouse.up();
    await expect(palette).toBeVisible();

    // Direct backdrop click closes CommandPalette
    await page.mouse.click(8, 8);
    await expect(palette).toHaveCount(0);
  });

  test('nested top-layer dialogs: ImageLightbox escapes DeepenNoteModal, ConfirmDialog guards EditNoteModal paste, PromptFallbackModal stacks on CapstoneModal', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('Clipboard blocked')) },
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
          id: 'att-cd6-img',
          type: 'image',
          driveFileId: 'demo-cd6-img',
          fileName: 'feedback-diagram.png',
          mimeType: 'image/png',
          width: 800,
          height: 600,
          previewDataUrl: ${JSON.stringify(TINY_PNG)}
        }]
      };
      `
    );

    // A. DeepenNoteModal -> ImageLightbox top-layer escape + Escape layering
    await go(page, '#/note/delays-in-feedback-loops');
    await page.getByTestId('deepen-note-btn').click();
    const deepenModal = page.getByTestId('deepen-note-modal');
    await expect(deepenModal).toBeVisible();

    const thumbBtn = page.getByTestId('deepen-attachment-image-att-cd6-img');
    await thumbBtn.click();
    const lightbox = page.getByTestId('image-lightbox');
    await expect(lightbox).toBeVisible();
    expect(await inspectNativeModalDialog(page, 'image-lightbox')).toEqual({
      tagName: 'DIALOG',
      open: true,
      isModal: true,
      role: 'dialog',
      closedby: 'any',
      ariaModal: 'true',
    });

    // Close button must sit near the viewport top-right (NOT trapped inside DeepenNoteModal's box!)
    const closeBox = await page.getByRole('button', { name: 'Close image lightbox' }).boundingBox();
    const deepenBox = await deepenModal.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(deepenBox).not.toBeNull();
    expect(closeBox!.x + closeBox!.width).toBeGreaterThan(deepenBox!.x + deepenBox!.width);
    expect(closeBox!.y).toBeLessThan(40);

    // 1st Escape closes ONLY ImageLightbox; DeepenNoteModal stays open & focus returns to thumbBtn
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
    await expect(deepenModal).toBeVisible();
    await expect(thumbBtn).toBeFocused();

    // 2nd Escape closes DeepenNoteModal (staying on NoteDetailView!)
    await page.keyboard.press('Escape');
    await expect(deepenModal).toHaveCount(0);
    await expect(page.getByTestId('note-detail-view')).toBeVisible();

    // B. EditNoteModal -> ConfirmDialog (role="alertdialog"): blocks background paste & 1st Escape closes only ConfirmDialog
    await page.getByTestId('edit-note-btn').click();
    const editModal = page.getByTestId('edit-note-modal');
    await expect(editModal).toBeVisible();
    await page.getByTestId('archive-note-btn').click();
    const confirmDialog = page.getByTestId('confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    expect(await inspectNativeModalDialog(page, 'confirm-dialog')).toMatchObject({
      tagName: 'DIALOG',
      open: true,
      isModal: true,
      role: 'alertdialog',
    });

    // Pasting a URL while ConfirmDialog is topmost must NOT attach to EditNoteModal beneath it
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'https://blocked-under-alertdialog.example.org/test');
      window.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    });
    await expect(editModal).not.toContainText('blocked-under-alertdialog.example.org');

    // 1st Escape closes ONLY ConfirmDialog; EditNoteModal stays open & interactive
    await page.keyboard.press('Escape');
    await expect(confirmDialog).toHaveCount(0);
    await expect(editModal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editModal).toHaveCount(0);

    // C. CapstoneModal -> PromptFallbackModal: drag-select safe, 1st Escape closes fallback, 2nd Escape flushes Capstone draft
    await go(page, '#/book/book-finite');
    await page.getByTestId('capstone-write-btn').click();
    const capModal = page.getByTestId('capstone-modal');
    await expect(capModal).toBeVisible();
    await page.getByTestId('capstone-arc-input').fill('Infinite players continue play.');
    await page.getByTestId('capstone-modal-copy-prompt-btn').click();
    const fallbackModal = page.getByTestId('capstone-prompt-fallback-modal');
    await expect(fallbackModal).toBeVisible();
    expect(await inspectNativeModalDialog(page, 'capstone-prompt-fallback-modal')).toMatchObject({
      tagName: 'DIALOG',
      open: true,
      isModal: true,
      closedby: 'any',
    });

    // Dragging selection out of the fallback textarea onto backdrop MUST NOT close it
    const fbTextarea = fallbackModal.locator('textarea');
    const taBox = await fbTextarea.boundingBox();
    expect(taBox).not.toBeNull();
    await page.mouse.move(taBox!.x + 30, taBox!.y + 30);
    await page.mouse.down();
    await page.mouse.move(6, 6, { steps: 5 });
    await page.mouse.up();
    await expect(fallbackModal).toBeVisible();

    // 1st Escape closes ONLY PromptFallbackModal
    await page.keyboard.press('Escape');
    await expect(fallbackModal).toHaveCount(0);
    await expect(capModal).toBeVisible();
    await expect(page.getByTestId('capstone-arc-input')).toHaveValue('Infinite players continue play.');

    // 2nd Escape closes CapstoneModal and synchronously flushes draft
    await page.keyboard.press('Escape');
    await expect(capModal).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem('pragya_draft:demo:pragya_draft_capstone:book-finite')
      )
    ).toContain('Infinite players continue play.');
  });

  test('native Tab cycling, background inertness, WikilinkAutocomplete Escape layering, and top-layer Sonner toasts above open modal', async ({
    page,
  }) => {
    await demo(page);

    // 1. Background inertness + native Tab cycling inside ConfirmDialog
    await go(page, '#/settings');
    await page.getByTestId('reset-demo-btn').click();
    const confirmDialog = page.getByTestId('confirm-dialog');
    await expect(confirmDialog).toBeVisible();

    // Native modal <dialog> Tabbing cycles between Cancel & Confirm (with browser-chrome `body` stop
    // between wrap-around in Chromium) and NEVER focuses any inert background element in <nav>/<main>.
    const visitedTestIds = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      const info = await confirmDialog.evaluate(dlg => {
        const active = document.activeElement;
        return {
          inDialog: Boolean(active && dlg.contains(active)),
          isBodyChromeStop: active === document.body || active === document.documentElement,
          testId: active?.getAttribute('data-testid') || null,
        };
      });
      expect(info.inDialog || info.isBodyChromeStop).toBe(true);
      if (info.testId) visitedTestIds.add(info.testId);
    }
    expect(visitedTestIds.has('confirm-dialog-cancel-btn')).toBe(true);
    expect(visitedTestIds.has('confirm-dialog-confirm-btn')).toBe(true);

    // Clicking coordinates over the background Sidebar nav (inert behind modal backdrop) must NOT navigate away
    const shelfNavBox = await page.getByTestId('nav-item-shelf').boundingBox();
    expect(shelfNavBox).not.toBeNull();
    await page.mouse.click(
      shelfNavBox!.x + shelfNavBox!.width / 2,
      shelfNavBox!.y + shelfNavBox!.height / 2
    );
    await expect(confirmDialog).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe('#/settings');
    await page.keyboard.press('Escape');
    await expect(confirmDialog).toHaveCount(0);

    // 2. WikilinkAutocomplete inside QuickCaptureModal: 1st Escape = popup only, 2nd Escape = modal + draft flush
    await go(page, '#/shelf');
    await page.keyboard.press('n');
    const capModal = page.getByTestId('quick-capture-modal');
    await expect(capModal).toBeVisible();
    await page.getByTestId('capture-takeaway-input').click();
    await page.keyboard.type('Link [[delays');
    await expect(page.getByTestId('wikilink-autocomplete')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('wikilink-autocomplete')).toHaveCount(0);
    await expect(capModal).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(capModal).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem('pragya_draft:demo:pragya_draft_capture_v1')
      )
    ).toContain('Link [[delays');

    // 3. Sonner Toaster promoted to Top Layer (`:popover-open`) above an open modal `<dialog>`
    await page.getByTestId('add-book-btn').click();
    const addBookModal = page.getByTestId('add-book-modal');
    await expect(addBookModal).toBeVisible();

    // Trigger a validation error toast while AddBookModal stays open (whitespace title bypasses HTML required)
    await page.getByTestId('book-title-input').fill('   ');
    await page.getByTestId('book-submit-btn').click();

    const errorToast = page.locator('[data-testid="notification-toast"][data-toast-variant="error"]').last();
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText('Please enter a book title');
    await expect(addBookModal).toBeVisible();

    // Verify toast-layer is in the Top Layer via Popover API (`:popover-open`)
    const toastLayerIsTopLayer = await page
      .getByTestId('toast-layer')
      .evaluate(el => el.matches(':popover-open'));
    expect(toastLayerIsTopLayer).toBe(true);
  });
});
