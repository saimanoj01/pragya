import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof module.registerHooks === 'function') {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !path.extname(specifier) &&
        context.parentURL
      ) {
        const parentPath = fileURLToPath(context.parentURL);
        const parentDir = path.dirname(parentPath);
        for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
          const candidate = path.resolve(parentDir, `${specifier}${ext}`);
          if (fs.existsSync(candidate)) {
            return nextResolve(pathToFileURL(candidate).href, context);
          }
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);
const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const dlg = await load('src/utils/dialogOverlay.ts');
const tl = await load('src/utils/toastLayer.ts');
const sw = await load('src/utils/swUpdateCore.ts');

test('CD6 dialogOverlay: OPEN_DIALOG_SELECTOR & open/topmost stack ordering', () => {
  assert.ok(dlg.OPEN_DIALOG_SELECTOR.includes('dialog[open]'));
  assert.ok(dlg.OPEN_DIALOG_SELECTOR.includes('[role="dialog"]'));
  assert.ok(dlg.OPEN_DIALOG_SELECTOR.includes('[role="alertdialog"]'));

  assert.equal(dlg.hasOpenDialog(null), false);
  assert.equal(dlg.hasOpenDialog({ querySelector: () => null }), false);
  assert.equal(
    dlg.hasOpenDialog({ querySelector: q => (q === dlg.OPEN_DIALOG_SELECTOR ? {} : null) }),
    true
  );

  // swUpdateCore shares the exact same multi-selector check (dialog[open], dialog, alertdialog).
  const mockDoc = token => ({ querySelector: q => (q.includes(token) ? {} : null) });
  assert.equal(sw.isDialogOpen(mockDoc('dialog[open]')), true);
  assert.equal(sw.isDialogOpen(mockDoc('[role="dialog"]')), true);
  assert.equal(sw.isDialogOpen(mockDoc('[role="alertdialog"]')), true);
  assert.equal(sw.isDialogOpen({ querySelector: () => null }), false);

  // Monotonic stacking order beats DOM order when an earlier DOM dialog opens later in the top layer.
  dlg.resetDialogOrderForTests();
  const order1 = dlg.claimDialogOrder();
  const order2 = dlg.claimDialogOrder();
  assert.ok(order2 > order1);

  const earlierInDomOpenedLater = {
    id: 'session-expired',
    getAttribute: name => (name === 'data-dialog-order' ? String(order2) : null),
  };
  const laterInDomOpenedEarlier = {
    id: 'confirm-portal',
    getAttribute: name => (name === 'data-dialog-order' ? String(order1) : null),
  };
  const stackedDoc = {
    querySelectorAll: () => [earlierInDomOpenedLater, laterInDomOpenedEarlier],
  };

  assert.equal(dlg.getTopmostOpenDialog(stackedDoc), earlierInDomOpenedLater);
  assert.equal(dlg.isTopmostOpenDialog(earlierInDomOpenedLater, stackedDoc), true);
  assert.equal(dlg.isTopmostOpenDialog(laterInDomOpenedEarlier, stackedDoc), false);

  // Fallback to DOM order when elements lack data-dialog-order (e.g. legacy ARIA dialogs).
  const legacyA = { id: 'a', getAttribute: () => null };
  const legacyB = { id: 'b', getAttribute: () => null };
  const legacyDoc = { querySelectorAll: () => [legacyA, legacyB] };
  assert.equal(dlg.getTopmostOpenDialog(legacyDoc), legacyB);
  assert.equal(dlg.isTopmostOpenDialog(legacyB, legacyDoc), true);
  assert.equal(dlg.isTopmostOpenDialog(legacyA, legacyDoc), false);
});

test('CD6 dialogOverlay: closedby policy, hit geometry, and text-drag-safe backdrop light-dismiss', () => {
  assert.equal(dlg.dialogClosedByValue(true), 'any');
  assert.equal(dlg.dialogClosedByValue(false), 'closerequest');

  const dialogEl = { tag: 'DIALOG' };
  const childEl = { tag: 'TEXTAREA' };
  const rect = { top: 100, left: 200, width: 400, height: 300 };

  assert.equal(dlg.isPointInsideRect(200, 100, rect), true);
  assert.equal(dlg.isPointInsideRect(600, 400, rect), true);
  assert.equal(dlg.isPointInsideRect(350, 250, rect), true);
  assert.equal(dlg.isPointInsideRect(199, 250, rect), false);
  assert.equal(dlg.isPointInsideRect(601, 250, rect), false);
  assert.equal(dlg.isPointInsideRect(350, 99, rect), false);
  assert.equal(dlg.isPointInsideRect(350, 401, rect), false);

  // Backdrop hit requires BOTH target === dialogEl AND coords outside the dialog box.
  assert.equal(dlg.isBackdropHit(dialogEl, dialogEl, 10, 10, rect), true);
  assert.equal(dlg.isBackdropHit(dialogEl, dialogEl, 300, 200, rect), false);
  assert.equal(dlg.isBackdropHit(childEl, dialogEl, 10, 10, rect), false);

  // View-only dialog in fallback browser (Safari / Chromium <134): direct backdrop tap closes.
  assert.equal(
    dlg.shouldCloseOnBackdrop({
      dismissOnBackdrop: true,
      pointerDownOnBackdrop: true,
      clickOnBackdrop: true,
      detail: 1,
      nativeClosedBySupported: false,
    }),
    true
  );

  // Text-selection drag: pointerdown started inside dialog, mouseup/click ended on backdrop -> MUST NOT CLOSE!
  assert.equal(
    dlg.shouldCloseOnBackdrop({
      dismissOnBackdrop: true,
      pointerDownOnBackdrop: false,
      clickOnBackdrop: true,
      detail: 1,
      nativeClosedBySupported: false,
    }),
    false
  );

  // Reverse drag: pointerdown on backdrop, click inside dialog -> MUST NOT CLOSE!
  assert.equal(
    dlg.shouldCloseOnBackdrop({
      dismissOnBackdrop: true,
      pointerDownOnBackdrop: true,
      clickOnBackdrop: false,
      detail: 1,
      nativeClosedBySupported: false,
    }),
    false
  );

  // Keyboard-synthesized click (detail === 0) -> MUST NOT CLOSE!
  assert.equal(
    dlg.shouldCloseOnBackdrop({
      dismissOnBackdrop: true,
      pointerDownOnBackdrop: true,
      clickOnBackdrop: true,
      detail: 0,
      nativeClosedBySupported: false,
    }),
    false
  );

  // Form / ConfirmDialog (dismissOnBackdrop: false) -> NEVER closes on backdrop click!
  assert.equal(
    dlg.shouldCloseOnBackdrop({
      dismissOnBackdrop: false,
      pointerDownOnBackdrop: true,
      clickOnBackdrop: true,
      detail: 1,
      nativeClosedBySupported: false,
    }),
    false
  );

  // Browser with native closedBy support -> defers to native `cancel` event (no double-close).
  assert.equal(
    dlg.shouldCloseOnBackdrop({
      dismissOnBackdrop: true,
      pointerDownOnBackdrop: true,
      clickOnBackdrop: true,
      detail: 1,
      nativeClosedBySupported: true,
    }),
    false
  );
});

test('CD6 dialogOverlay: cancel guard, Escape priority, and focus restoration safety', () => {
  assert.equal(dlg.shouldAcceptDialogCancel({ hasInnerPopover: true, isTopmost: true }), false);
  assert.equal(dlg.shouldAcceptDialogCancel({ hasInnerPopover: false, isTopmost: false }), false);
  assert.equal(dlg.shouldAcceptDialogCancel({ hasInnerPopover: false, isTopmost: true }), true);

  // Escape priority: popover > open dialog > detail route back > none.
  assert.equal(
    dlg.resolveEscapePriority({ hasPopover: true, hasOpenDialog: true, routeView: 'book' }),
    'popover'
  );
  assert.equal(
    dlg.resolveEscapePriority({ hasPopover: false, hasOpenDialog: true, routeView: 'book' }),
    'dialog'
  );
  assert.equal(
    dlg.resolveEscapePriority({
      hasPopover: false,
      hasOpenDialog: false,
      hasOverlayFlag: true,
      routeView: 'note',
    }),
    'dialog'
  );
  assert.equal(
    dlg.resolveEscapePriority({ hasPopover: false, hasOpenDialog: false, routeView: 'book' }),
    'route-shelf'
  );
  assert.equal(
    dlg.resolveEscapePriority({ hasPopover: false, hasOpenDialog: false, routeView: 'note' }),
    'route-notes'
  );
  assert.equal(
    dlg.resolveEscapePriority({ hasPopover: false, hasOpenDialog: false, routeView: 'shelf' }),
    'none'
  );

  // Focus restore: standalone, nested, detached, and sibling-swap (never steal focus).
  const triggerBtn = { id: 'trigger' };
  const nestedTriggerBtn = { id: 'archive-btn' };
  const parentDialog = { contains: node => node === nestedTriggerBtn };
  const siblingModal = { contains: () => false };

  assert.equal(
    dlg.shouldRestoreFocusOnClose({
      previousElConnected: true,
      topmostOpenDialog: null,
      previousEl: triggerBtn,
    }),
    true
  );
  assert.equal(
    dlg.shouldRestoreFocusOnClose({
      previousElConnected: false,
      topmostOpenDialog: null,
      previousEl: triggerBtn,
    }),
    false
  );
  assert.equal(
    dlg.shouldRestoreFocusOnClose({
      previousElConnected: true,
      topmostOpenDialog: parentDialog,
      previousEl: nestedTriggerBtn,
    }),
    true
  );
  assert.equal(
    dlg.shouldRestoreFocusOnClose({
      previousElConnected: true,
      topmostOpenDialog: siblingModal,
      previousEl: triggerBtn,
    }),
    false
  );
});

test('CD6 toastLayer: re-promotes popover="manual" host to top of Top Layer & degrades cleanly', () => {
  const calls = [];
  let open = false;
  const host = {
    matches: sel => sel === ':popover-open' && open,
    showPopover: () => {
      calls.push('show');
      open = true;
    },
    hidePopover: () => {
      calls.push('hide');
      open = false;
    },
  };

  tl.registerToastLayerHost(host);
  assert.equal(tl.promoteToastLayer(), true);
  assert.deepEqual(calls, ['show']);

  // Second promotion (e.g. toast fired while modal dialog is open) hides then re-shows to reach top.
  assert.equal(tl.promoteToastLayer(), true);
  assert.deepEqual(calls, ['show', 'hide', 'show']);

  // Graceful fallback when Popover API is unsupported or throws.
  tl.registerToastLayerHost({});
  assert.equal(tl.promoteToastLayer(), false);
  tl.registerToastLayerHost({
    showPopover: () => {
      throw new Error('disconnected');
    },
  });
  assert.equal(tl.promoteToastLayer(), false);
  tl.registerToastLayerHost(null);
});

test('CD6 architecture invariants: native <dialog> across overlays, alertdialog ConfirmDialog, unified guards & CSS', () => {
  const modalSrc = read('src/components/common/Modal.tsx');
  const confirmSrc = read('src/components/common/ConfirmDialog.tsx');
  const paletteSrc = read('src/components/layout/CommandPalette.tsx');
  const lightboxSrc = read('src/components/modals/ImageLightbox.tsx');
  const bottomNavSrc = read('src/components/layout/BottomNav.tsx');
  const hookSrc = read('src/hooks/useNativeDialog.ts');
  const cssSrc = read('src/index.css');

  for (const [name, src] of [
    ['Modal.tsx', modalSrc],
    ['CommandPalette.tsx', paletteSrc],
    ['ImageLightbox.tsx', lightboxSrc],
    ['BottomNav.tsx', bottomNavSrc],
  ]) {
    assert.ok(src.includes('<dialog'), `${name} renders a native <dialog>`);
    assert.ok(src.includes('useNativeDialog('), `${name} uses shared useNativeDialog hook`);
    assert.ok(src.includes('dialogClosedByValue('), `${name} declares closedby policy`);
  }

  // Modal uses native top-layer focus trapping (no hand-rolled Tab trap) and defaults dismissOnBackdrop=false.
  assert.ok(!modalSrc.includes("e.key === 'Tab'"), 'Modal removes hand-rolled Tab trap');
  assert.ok(modalSrc.includes('dismissOnBackdrop = false'), 'Modal defaults to closedby="closerequest"');

  // Hook calls showModal() and wires imperative cancel + close listeners (React 18 compatibility).
  assert.ok(hookSrc.includes('dialog.showModal()'), 'useNativeDialog opens via .showModal()');
  assert.ok(hookSrc.includes("addEventListener('cancel'"), 'useNativeDialog listens to native cancel');
  assert.ok(hookSrc.includes("addEventListener('close'"), 'useNativeDialog listens to native close');

  // ConfirmDialog uses role="alertdialog", Cancel autoFocus, and no backdrop dismiss.
  assert.ok(confirmSrc.includes('role="alertdialog"'), 'ConfirmDialog sets role="alertdialog"');
  assert.ok(confirmSrc.includes('dismissOnBackdrop={false}'), 'ConfirmDialog disables backdrop dismiss');
  assert.ok(confirmSrc.includes('autoFocus'), 'ConfirmDialog autofocuses Cancel');

  // View-only modals explicitly opt into light-dismiss.
  assert.ok(
    read('src/components/modals/KeyboardHelpModal.tsx').includes('dismissOnBackdrop={true}'),
    'KeyboardHelpModal enables light-dismiss'
  );
  assert.ok(
    read('src/components/common/PromptFallbackModal.tsx').includes('dismissOnBackdrop={true}'),
    'PromptFallbackModal enables light-dismiss'
  );

  // All shortcut/paste/SW guards delegate to dialogOverlay instead of raw [role="dialog"] queries.
  for (const rel of [
    'src/hooks/useKeyboardShortcuts.ts',
    'src/components/views/NotesView.tsx',
    'src/components/views/BookDetailView.tsx',
    'src/components/views/PracticeView.tsx',
    'src/components/views/NoteDetailView.tsx',
    'src/components/common/AttachmentManager.tsx',
    'src/utils/swUpdateCore.ts',
  ]) {
    const src = read(rel);
    assert.ok(src.includes('dialogOverlay'), `${rel} imports dialogOverlay`);
    assert.ok(
      !src.includes("querySelector('[role=\"dialog\"]')") &&
        !src.includes("querySelectorAll('[role=\"dialog\"]')") &&
        !src.includes("closest('[role=\"dialog\"]')"),
      `${rel} has no stale [role="dialog"]-only DOM query`
    );
  }

  // CSS rules for top-layer backdrop, scroll lock, @starting-style, overlay, allow-discrete, and print.
  assert.ok(cssSrc.includes('html:has(dialog:modal)'), 'CSS locks scroll via :has(dialog:modal)');
  assert.ok(cssSrc.includes('@media screen'), 'CSS scopes modal scroll lock to @media screen');
  assert.ok(cssSrc.includes('overflow: visible !important'), 'Print resets html/body overflow');
  assert.ok(cssSrc.includes('dialog.pragya-dialog[open]::backdrop'), 'CSS styles ::backdrop');
  assert.ok(cssSrc.includes('dialog.pragya-dialog::backdrop {\n    transition-duration: 0.01ms !important;'), 'Reduced motion includes ::backdrop');
  assert.ok(cssSrc.includes('transition-behavior: allow-discrete'), 'CSS sets allow-discrete');
  assert.ok(cssSrc.includes('overlay'), 'CSS transitions overlay for top-layer');
  assert.ok(cssSrc.includes('@starting-style'), 'CSS defines @starting-style entry state');
  assert.ok(cssSrc.includes('dialog[open],') && cssSrc.includes("[role='alertdialog'],"), 'Print hides dialog[open] and alertdialog');

  // Fix-up static invariants (QA-44, QA-45, R1#2, R1#3, R2-4)
  assert.ok(confirmSrc.includes('disableCloseRequest={busy}'), 'ConfirmDialog locks closedby="none" while busy');
  assert.ok(hookSrc.includes('if (!dialog.isConnected) return false;'), 'useNativeDialog guards showModal on isConnected');
  assert.ok(hookSrc.includes('const useBackdropFallback = !supportsDialogClosedBy();'), 'useNativeDialog gates fallback listeners on !supportsDialogClosedBy()');
  assert.ok(hookSrc.includes("e.pointerType !== 'touch' && e.button !== 0"), 'useNativeDialog ignores non-primary pointer buttons');
  assert.ok(modalSrc.includes('tabIndex={-1}'), 'Modal sets tabIndex=-1 on <dialog>');
  assert.ok(modalSrc.includes('[data-testid="toast-layer"]'), 'Modal excludes reparented toast-layer from focusInitial');
  assert.ok(!read('src/components/layout/SessionExpiredModal.tsx').includes('z-[70]'), 'SessionExpiredModal drops no-op z-[70]');
});

test('CD6 fix-up: closedby="none" busy guard, getTopmostOpenDialog(exclude), and toastLayer reparenting lifecycle', () => {
  // QA-45 / R1#2: disableCloseRequest maps to closedby="none" and rejects cancel events.
  assert.equal(dlg.dialogClosedByValue(false, true), 'none');
  assert.equal(dlg.dialogClosedByValue(true, true), 'none');
  assert.equal(
    dlg.shouldAcceptDialogCancel({ hasInnerPopover: false, isTopmost: true, disableCloseRequest: true }),
    false
  );

  // getTopmostOpenDialog(doc, exclude) picks the next topmost dialog when the top one is closing.
  const d1 = { id: 'd1', getAttribute: k => (k === 'data-dialog-order' ? '1' : null), appendChild: () => {} };
  const d2 = { id: 'd2', getAttribute: k => (k === 'data-dialog-order' ? '2' : null), appendChild: () => {} };
  const body = { id: 'body', appendChild: () => {} };
  const stackDoc = { body, querySelectorAll: () => [d1, d2] };

  assert.equal(dlg.getTopmostOpenDialog(stackDoc, d2), d1);
  assert.equal(dlg.getTopmostOpenDialog({ body, querySelectorAll: () => [d2] }, d2), null);

  // QA-44 / R1#1: toastLayer reparents host into topmost open dialog and rescues back to parent/body before close.
  const moves = [];
  const popCalls = [];
  let open = false;
  const childBtn = { id: 'toast-undo-btn' };
  const host = {
    parentNode: null,
    contains: node => node === childBtn,
    matches: sel => sel === ':popover-open' && open,
    showPopover: () => {
      popCalls.push('show');
      open = true;
    },
    hidePopover: () => {
      popCalls.push('hide');
      open = false;
    },
  };
  const makeParent = id => ({
    id,
    getAttribute: k => (k === 'data-dialog-order' ? (id === 'dlg1' ? '1' : '2') : null),
    appendChild: node => {
      // Simulate HTML spec removing-steps hiding an open popover upon reparenting.
      open = false;
      node.parentNode = parentMap[id];
      moves.push(id);
    },
  });
  const parentMap = {
    body: makeParent('body'),
    dlg1: makeParent('dlg1'),
    dlg2: makeParent('dlg2'),
  };

  tl.registerToastLayerHost(host);
  assert.equal(tl.isInsideToastLayer(host), true);
  assert.equal(tl.isInsideToastLayer(childBtn), true);
  assert.equal(tl.isInsideToastLayer({ id: 'backdrop' }), false);

  // 1. Mount with no modal open -> attaches to body and shows popover
  assert.equal(
    tl.syncToastLayerContainer({ body: parentMap.body, querySelectorAll: () => [] }),
    true
  );
  assert.equal(host.parentNode, parentMap.body);

  // 2. Dialog 1 opens -> reparents into dlg1 and re-opens popover
  assert.equal(
    tl.syncToastLayerContainer({ body: parentMap.body, querySelectorAll: () => [parentMap.dlg1] }),
    true
  );
  assert.equal(host.parentNode, parentMap.dlg1);
  assert.equal(open, true);

  // 3. Nested Dialog 2 opens -> reparents into dlg2
  assert.equal(
    tl.syncToastLayerContainer({
      body: parentMap.body,
      querySelectorAll: () => [parentMap.dlg1, parentMap.dlg2],
    }),
    true
  );
  assert.equal(host.parentNode, parentMap.dlg2);

  // 4. Dialog 2 closes (excluded) -> rescues host back into dlg1
  assert.equal(
    tl.syncToastLayerContainer(
      { body: parentMap.body, querySelectorAll: () => [parentMap.dlg1, parentMap.dlg2] },
      undefined,
      parentMap.dlg2
    ),
    true
  );
  assert.equal(host.parentNode, parentMap.dlg1);

  // 5. Dialog 1 closes (excluded) -> rescues host back into body
  assert.equal(
    tl.syncToastLayerContainer(
      { body: parentMap.body, querySelectorAll: () => [parentMap.dlg1] },
      undefined,
      parentMap.dlg1
    ),
    true
  );
  assert.equal(host.parentNode, parentMap.body);
  assert.deepEqual(moves, ['body', 'dlg1', 'dlg2', 'dlg1', 'body']);
  assert.equal(popCalls.filter(c => c === 'show').length, 5);

  tl.registerToastLayerHost(null);
});

