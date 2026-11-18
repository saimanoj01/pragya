import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
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

/**
 * CD Batch 4 — Mobile, accessibility, and platform polish:
 * - Self-hosted Inter .woff2 integrity, license, preload & SW precache + CacheFirst (D4.2)
 * - index.html iOS viewport / PWA meta + zero-FOUC dark-default theme script (D1.1, D4.1)
 * - KEYBOARD_SHORTCUTS single source of truth, ? shortcut & (any-pointer: fine) gate (D3.6)
 * - Primary nav <a href> click + aria-current="page" / "location" helper (D3.3)
 * - Spoiler-safe note card aria-label, J/K focus index & reduced-motion helper (D3.4, D4.4)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const ks = await load('src/utils/keyboardShortcuts.ts');
const nl = await load('src/utils/navLinks.ts');
const cf = await load('src/utils/cardFocus.ts');
const swPrecache = await load('scripts/swPrecache.mjs');

const SW_SOURCE = fs.readFileSync(path.join(repoRoot, 'public/sw.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const INDEX_CSS = fs.readFileSync(path.join(repoRoot, 'src/index.css'), 'utf8');

function sha256File(relPath) {
  const bytes = fs.readFileSync(path.join(repoRoot, relPath));
  return {
    bytes,
    hex: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

// ---- D4.2 Self-hosted Inter fonts + D1.1 / D4.1 index.html ------------------------------

test('D4.2: public/fonts contains valid WOFF2 InterVariable roman + italic and SIL OFL 1.1 license', () => {
  const roman = sha256File('public/fonts/InterVariable.woff2');
  const italic = sha256File('public/fonts/InterVariable-Italic.woff2');
  const license = fs.readFileSync(path.join(repoRoot, 'public/fonts/Inter-LICENSE.txt'), 'utf8');

  assert.equal(roman.bytes.subarray(0, 4).toString('ascii'), 'wOF2');
  assert.equal(italic.bytes.subarray(0, 4).toString('ascii'), 'wOF2');
  assert.equal(roman.hex, '693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3');
  assert.equal(italic.hex, 'e564f652916db6c139570fefb9524a77c4d48f30c92928de9db19b6b5c7a262a');
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test('D1.1 / D4.1 / D4.2: index.html has viewport-fit=cover without zoom lock, preloads roman Inter only, drops Google Fonts, and runs sync dark-default theme script', () => {
  assert.equal(/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(INDEX_HTML), false);

  const viewportMatch = INDEX_HTML.match(/<meta\s+name="viewport"\s+content="([^"]+)"/i);
  assert.ok(viewportMatch, 'viewport meta present');
  assert.match(viewportMatch[1], /viewport-fit=cover/);
  assert.equal(/maximum-scale|user-scalable\s*=\s*no/i.test(viewportMatch[1]), false);

  assert.match(INDEX_HTML, /<meta\s+name="mobile-web-app-capable"\s+content="yes"/i);
  assert.match(INDEX_HTML, /<meta\s+name="color-scheme"\s+content="dark light"/i);
  assert.match(
    INDEX_HTML,
    /<link[\s\S]*?rel="preload"[\s\S]*?href="(?:\.\/|%BASE_URL%)fonts\/InterVariable\.woff2"[\s\S]*?as="font"[\s\S]*?type="font\/woff2"[\s\S]*?crossorigin/
  );
  assert.equal(/InterVariable-Italic\.woff2/.test(INDEX_HTML), false, 'italic must not be preloaded');

  // Synchronous inline script (no defer / module) defaulting to dark per Q7 override.
  const themeScriptMatch = INDEX_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(themeScriptMatch, 'inline synchronous head script present');
  assert.match(themeScriptMatch[1], /var theme = 'dark'/);
  assert.match(themeScriptMatch[1], /localStorage\.getItem\('pragya_theme'\)/);
  assert.match(themeScriptMatch[1], /saved === 'light' \|\| saved === 'dark'/);

  // Execute the head script in a minimal DOM sandbox to prove Q7 dark default + saved light.
  const runHeadScript = savedTheme => {
    const classes = new Set(['dark']);
    const attrs = { 'color-scheme': 'dark light', 'theme-color': '#0B0C0F' };
    vm.runInNewContext(themeScriptMatch[1], {
      localStorage: {
        getItem: k => (k === 'pragya_theme' ? savedTheme : null),
      },
      document: {
        documentElement: {
          classList: {
            remove: (...names) => names.forEach(n => classes.delete(n)),
            add: name => classes.add(name),
          },
        },
        querySelector: sel => {
          if (sel === 'meta[name="color-scheme"]') {
            return { setAttribute: (_k, v) => (attrs['color-scheme'] = v) };
          }
          if (sel === 'meta[name="theme-color"]') {
            return { setAttribute: (_k, v) => (attrs['theme-color'] = v) };
          }
          return null;
        },
      },
    });
    return { classes: [...classes], attrs };
  };

  assert.deepEqual(runHeadScript(null), {
    classes: ['dark'],
    attrs: { 'color-scheme': 'dark', 'theme-color': '#0B0C0F' },
  });
  assert.deepEqual(runHeadScript('light'), {
    classes: ['light'],
    attrs: { 'color-scheme': 'light', 'theme-color': '#FAFAF9' },
  });

  // CSS @font-face + font-size-adjust: from-font + @media print + prefers-reduced-motion
  assert.match(INDEX_CSS, /font-size-adjust:\s*from-font/);
  assert.match(INDEX_CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(INDEX_CSS, /@media\s+print/);
});

// ---- D4.2 Service Worker font precache & CacheFirst -------------------------------------

const ORIGIN = 'https://example.github.io';
const SCOPE = `${ORIGIN}/pragya/`;

function loadSw({ source = SW_SOURCE, cacheEntries = {}, fetchImpl } = {}) {
  const listeners = {};
  const stores = new Map();
  const added = [];
  const keyOf = r => (typeof r === 'string' ? r : r.url);
  const openStore = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const map = stores.get(name);
    return {
      map,
      addAll: async list => {
        for (const item of list) {
          added.push(item);
          map.set(keyOf(item), new Response('precached', { status: 200 }));
        }
      },
      put: async (req, res) => {
        map.set(keyOf(req), res);
      },
    };
  };
  const seed = openStore('seed');
  for (const [u, r] of Object.entries(cacheEntries)) seed.map.set(u, r);

  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      registration: { scope: SCOPE },
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      match: async req => {
        for (const m of stores.values()) {
          if (m.has(keyOf(req))) return m.get(keyOf(req));
        }
        return undefined;
      },
      open: async name => openStore(name),
      keys: async () => [...stores.keys()],
      delete: async name => stores.delete(name),
    },
    fetch: fetchImpl || (() => Promise.reject(new TypeError('Failed to fetch'))),
    Response,
    Request,
    URL,
    console,
  };
  vm.runInNewContext(source, sandbox);
  const dispatchFetch = (url, mode = 'cors', method = 'GET') => {
    let responded;
    let called = false;
    listeners.fetch({
      request: { url, mode, method },
      respondWith: p => {
        called = true;
        responded = p;
      },
      waitUntil: () => {},
    });
    return { called, promise: responded };
  };
  const runLifecycle = async type => {
    let waited;
    listeners[type]({ waitUntil: p => (waited = p) });
    await waited;
  };
  const addedUrls = () => added.map(r => (typeof r === 'string' ? r : r.url));
  return { dispatchFetch, runLifecycle, addedUrls };
}

test('D4.2: swPrecache includes fonts/*.woff2 (excludes license txt) and hashes font bytes into BUILD_ID', () => {
  const list = swPrecache.buildPrecacheList([
    'index.html',
    'assets/index-1.js',
    'fonts/InterVariable.woff2',
    'fonts/InterVariable-Italic.woff2',
    'fonts/Inter-LICENSE.txt',
  ]);
  assert.ok(list.includes('fonts/InterVariable.woff2'));
  assert.ok(list.includes('fonts/InterVariable-Italic.woff2'));
  assert.equal(list.includes('fonts/Inter-LICENSE.txt'), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pragya-cd4-sw-'));
  try {
    const out = path.join(dir, 'dist');
    fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(out, 'index.html'), '<html/>');
    fs.writeFileSync(path.join(out, 'assets/app-1.js'), 'console.log(1)');
    fs.writeFileSync(path.join(out, 'fonts/InterVariable.woff2'), 'woff2-v1');
    fs.writeFileSync(path.join(out, 'fonts/Inter-LICENSE.txt'), 'OFL');
    fs.writeFileSync(path.join(out, 'sw.js'), SW_SOURCE);

    const templatePath = path.join(repoRoot, 'public/sw.js');
    const r1 = swPrecache.injectIntoDist(out, { templatePath });
    assert.ok(r1.list.includes('fonts/InterVariable.woff2'));
    assert.equal(r1.list.includes('fonts/Inter-LICENSE.txt'), false);

    fs.writeFileSync(path.join(out, 'fonts/InterVariable.woff2'), 'woff2-v2');
    const r2 = swPrecache.injectIntoDist(out, { templatePath });
    assert.notEqual(r1.buildId, r2.buildId, 'font byte changes rotate BUILD_ID');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D4.2: public/sw.js serves fonts/*.woff2 CacheFirst without touching the network on hit', async () => {
  let fetches = 0;
  const sw = loadSw({
    cacheEntries: {
      [`${SCOPE}fonts/InterVariable.woff2`]: new Response('font-bytes', {
        status: 200,
        headers: { 'Content-Type': 'font/woff2' },
      }),
    },
    fetchImpl: async () => {
      fetches += 1;
      return new Response('net-font');
    },
  });
  const hit = await sw.dispatchFetch(`${SCOPE}fonts/InterVariable.woff2`).promise;
  assert.equal(await hit.text(), 'font-bytes');
  assert.equal(fetches, 0);

  const offlineSw = loadSw();
  const miss = await offlineSw.dispatchFetch(`${SCOPE}fonts/InterVariable-Italic.woff2`).promise;
  assert.equal(miss.type, 'error');

  await offlineSw.runLifecycle('install');
  assert.ok(offlineSw.addedUrls().includes(`${SCOPE}fonts/InterVariable.woff2`));
  assert.ok(offlineSw.addedUrls().includes(`${SCOPE}fonts/InterVariable-Italic.woff2`));
});

// ---- D3.6 Keyboard shortcuts single source of truth -------------------------------------

test('D3.6: KEYBOARD_SHORTCUTS covers all 7 sections, Q6 Shift+E override, and Mac/non-Mac key labels', () => {
  assert.deepEqual(
    ks.KEYBOARD_SHORTCUTS.map(s => s.title),
    ['Anywhere', 'Notes list', 'Book page', 'Note page', 'Practice', 'In forms', 'Search & images']
  );
  const allRows = ks.KEYBOARD_SHORTCUTS.flatMap(s => s.rows);
  assert.ok(
    allRows.some(r => r.action === 'Show this list' && ks.shortcutKeysText(r.keys, 'MacIntel') === '?')
  );
  assert.ok(
    allRows.some(
      r => r.action === 'Edit book' && ks.shortcutKeysText(r.keys, 'MacIntel') === 'Shift E'
    )
  );
  assert.ok(
    allRows.some(
      r => r.action === 'Edit focused note, or the book' && ks.shortcutKeysText(r.keys, 'MacIntel') === 'E'
    )
  );

  assert.equal(ks.modKeyLabel('MacIntel'), '⌘');
  assert.equal(ks.modKeyLabel('Linux x86_64'), 'Ctrl');
  assert.equal(ks.shortcutKeysText([{ key: 'mod' }, { key: 'K' }], 'MacIntel'), '⌘ K');
  assert.equal(ks.shortcutKeysText([{ key: 'mod' }, { key: 'K' }], 'Win32'), 'Ctrl K');
  assert.equal(
    ks.shortcutKeysText([{ key: 'G' }, { text: 'then' }, { key: 'S' }], 'MacIntel'),
    'G then S'
  );
});

test('D3.6: isHelpShortcut matches unmodified ? and hasFinePointer gates on (any-pointer: fine)', () => {
  assert.equal(ks.isHelpShortcut({ key: '?', metaKey: false, ctrlKey: false, altKey: false }), true);
  assert.equal(ks.isHelpShortcut({ key: '?', metaKey: true, ctrlKey: false, altKey: false }), false);
  assert.equal(ks.isHelpShortcut({ key: '?', metaKey: false, ctrlKey: true, altKey: false }), false);
  assert.equal(ks.isHelpShortcut({ key: '?', metaKey: false, ctrlKey: false, altKey: true }), false);
  assert.equal(ks.isHelpShortcut({ key: '/', metaKey: false, ctrlKey: false, altKey: false }), false);

  assert.equal(ks.hasFinePointer(undefined), false);
  assert.equal(ks.hasFinePointer(q => ({ matches: q === '(any-pointer: fine)' ? false : true })), false);
  assert.equal(ks.hasFinePointer(q => ({ matches: q === '(any-pointer: fine)' })), true);
});

// ---- D3.3 Primary nav <a href> + aria-current -------------------------------------------

test('D3.3: navAriaCurrent distinguishes exact page vs detail location', () => {
  assert.equal(nl.navAriaCurrent('shelf', 'shelf'), 'page');
  assert.equal(nl.navAriaCurrent('shelf', 'book'), 'location');
  assert.equal(nl.navAriaCurrent('notes', 'notes'), 'page');
  assert.equal(nl.navAriaCurrent('notes', 'note'), 'location');
  assert.equal(nl.navAriaCurrent('practice', 'practice'), 'page');
  assert.equal(nl.navAriaCurrent('practice', 'book'), undefined);
  assert.equal(nl.navAriaCurrent('settings', 'shelf'), undefined);
});

test('D3.3: handleNavLinkClick intercepts plain left-click and preserves Cmd/Ctrl/Shift/middle-click', () => {
  const prevWindow = globalThis.window;
  const mockLoc = { hash: '#/shelf' };
  globalThis.window = { location: mockLoc };
  try {
    let prevented = 0;
    const mkEvent = (overrides = {}) => ({
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        prevented += 1;
      },
      ...overrides,
    });

    nl.handleNavLinkClick(mkEvent(), '#/notes');
    assert.equal(prevented, 1);
    assert.equal(mockLoc.hash, '#/notes');

    for (const mod of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { defaultPrevented: true },
    ]) {
      nl.handleNavLinkClick(mkEvent(mod), '#/practice');
    }
    assert.equal(prevented, 1);
    assert.equal(mockLoc.hash, '#/notes', 'modified/non-primary clicks must fall through to native anchor behavior');
  } finally {
    globalThis.window = prevWindow;
  }
});

// ---- D3.4 / D4.4 Card focus & spoiler-safe aria-label -----------------------------------

test('D3.4: noteCardAriaLabel never leaks shielded note title', () => {
  const shieldedLabel = cf.noteCardAriaLabel({
    bookTitle: 'A Storm of Swords',
    posLabel: 'p. 412',
    title: 'The Red Wedding',
    shielded: true,
  });
  assert.equal(shieldedLabel, 'A Storm of Swords · p. 412 · Shielded note');
  assert.equal(shieldedLabel.includes('Red Wedding'), false);

  const visibleLabel = cf.noteCardAriaLabel({
    bookTitle: 'A Storm of Swords',
    posLabel: 'p. 412',
    title: 'The Red Wedding',
    shielded: false,
  });
  assert.equal(visibleLabel, 'A Storm of Swords · p. 412 · The Red Wedding');

  const untitledLabel = cf.noteCardAriaLabel({
    bookTitle: 'Thinking in Systems',
    posLabel: 'p. 42',
    title: '',
    shielded: false,
  });
  assert.equal(untitledLabel, 'Thinking in Systems · p. 42 · Note');
  assert.equal(cf.focusedCardIndex(null), null);
  assert.equal(cf.focusedCardIndex({ closest: () => null }), null);
  assert.equal(cf.focusedCardIndex({ closest: () => ({ dataset: { jkCard: '2' } }) }), 2);
});
