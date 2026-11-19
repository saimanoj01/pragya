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

test('CD6 QA dialogOverlay edge cases: corrupt/mixed dialog orders, null guards, and boundary hit geometry', () => {
  // Null / undefined document and element guards
  assert.deepEqual(dlg.getOpenDialogs(null), []);
  assert.deepEqual(dlg.getOpenDialogs(undefined), []);
  assert.equal(dlg.getTopmostOpenDialog(null), null);
  assert.equal(dlg.isTopmostOpenDialog(null, null), false);
  assert.equal(dlg.isTopmostOpenDialog({ id: 'x' }, { querySelectorAll: () => [] }), true);

  // Corrupt or empty data-dialog-order falls back cleanly to DOM order
  const corruptA = { id: 'a', getAttribute: () => 'NaN' };
  const corruptB = { id: 'b', getAttribute: () => '' };
  const corruptDoc = { querySelectorAll: () => [corruptA, corruptB] };
  assert.equal(dlg.getTopmostOpenDialog(corruptDoc), corruptB);

  // Mixed stack: ordered native dialog beats unordered legacy element; equal orders prefer later in DOM
  const ordered = { id: 'native', getAttribute: k => (k === 'data-dialog-order' ? '2' : null) };
  const unordered = { id: 'legacy', getAttribute: () => null };
  assert.equal(
    dlg.getTopmostOpenDialog({ querySelectorAll: () => [ordered, unordered] }),
    ordered
  );
  const tied1 = { id: 't1', getAttribute: k => (k === 'data-dialog-order' ? '5' : null) };
  const tied2 = { id: 't2', getAttribute: k => (k === 'data-dialog-order' ? '5' : null) };
  assert.equal(dlg.getTopmostOpenDialog({ querySelectorAll: () => [tied1, tied2] }), tied2);

  // Exact rect edges are INSIDE (never backdrop); null dialogEl is never a backdrop hit
  const rect = { top: 50, left: 100, width: 300, height: 200 };
  const fakeDlg = { tag: 'DIALOG' };
  assert.equal(dlg.isBackdropHit(fakeDlg, null, 0, 0, rect), false);
  assert.equal(dlg.isBackdropHit(fakeDlg, fakeDlg, 100, 50, rect), false);
  assert.equal(dlg.isBackdropHit(fakeDlg, fakeDlg, 400, 250, rect), false);
  assert.equal(dlg.isBackdropHit(fakeDlg, fakeDlg, 400.1, 250, rect), true);
  assert.equal(dlg.isBackdropHit(fakeDlg, fakeDlg, 100, 49.9, rect), true);

  // Focus restore with null previousEl or dialog missing contains()
  assert.equal(
    dlg.shouldRestoreFocusOnClose({
      previousElConnected: true,
      topmostOpenDialog: null,
      previousEl: null,
    }),
    false
  );
  assert.equal(
    dlg.shouldRestoreFocusOnClose({
      previousElConnected: true,
      topmostOpenDialog: {},
      previousEl: { id: 'btn' },
    }),
    false
  );
});

test('CD6 QA static overlay audit: zero framer-motion in all 5 dialogs, desktop drawer auto-close, and popover toast layer wiring', () => {
  const overlayFiles = [
    'src/components/common/Modal.tsx',
    'src/components/common/ConfirmDialog.tsx',
    'src/components/layout/CommandPalette.tsx',
    'src/components/modals/ImageLightbox.tsx',
    'src/components/layout/BottomNav.tsx',
  ];

  for (const rel of overlayFiles) {
    const src = read(rel);
    assert.ok(!src.includes('framer-motion'), `${rel} must not import framer-motion`);
    assert.ok(!src.includes('AnimatePresence'), `${rel} must not wrap overlay in AnimatePresence`);
  }

  // Modal removes hand-rolled Escape listener (delegates to native cancel via useNativeDialog)
  const modalSrc = read('src/components/common/Modal.tsx');
  assert.ok(!modalSrc.includes("e.key === 'Escape'"), 'Modal delegates Escape to native cancel');

  // BottomNav mobile drawer has desktop resize guard and no stale data-popover="true"
  const bottomNavSrc = read('src/components/layout/BottomNav.tsx');
  assert.ok(
    bottomNavSrc.includes("matchMedia('(min-width: 768px)')"),
    'BottomNav auto-closes drawer when viewport widens to desktop'
  );
  assert.ok(
    !bottomNavSrc.includes('data-popover="true"'),
    'BottomNav drawer no longer relies on data-popover="true"'
  );

  // AppLayout + toast.tsx wire popover="manual" toast-layer & promoteToastLayer
  const layoutSrc = read('src/components/layout/AppLayout.tsx');
  assert.ok(layoutSrc.includes("popover: 'manual'"), 'AppLayout declares popover="manual" toast-layer');
  assert.ok(layoutSrc.includes('registerToastLayerHost('), 'AppLayout registers toast-layer host');
  assert.ok(read('src/utils/toast.tsx').includes('promoteToastLayer('), 'showToast promotes toast-layer');

  // toastLayer promoteToastLayer handles null host safely
  tl.registerToastLayerHost(null);
  assert.equal(tl.promoteToastLayer(), false);
});
