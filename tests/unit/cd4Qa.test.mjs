import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
        const parentDir = path.dirname(fileURLToPath(context.parentURL));
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
 * QA (CD Batch 4) — adversarial unit probes:
 * - Source-wide ban on third-party Google Fonts origins + WOFF2 binary header & preload hygiene
 * - Zero-FOUC <head> script resilience (throwing storage, poisoned values, class preservation, missing metas)
 * - Service Worker font CacheFirst prefix boundary, 404/500 non-caching, cross-origin bypass & FONT_FILE_RE exclusions
 * - cardFocus / keyboardShortcuts / navLinks edge cases (Shift+/ = ?, invalid jkCard indices, spoiler-safe labels)
 * - CommandPalette memo gating invariants
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

function walkFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

test('QA CD4: zero Google Fonts references across index.html, src/**, and public/**; WOFF2 headers & preload hygiene', () => {
  const checked = [
    path.join(repoRoot, 'index.html'),
    ...walkFiles(path.join(repoRoot, 'src')),
    ...walkFiles(path.join(repoRoot, 'public')).filter(f => !f.endsWith('.woff2') && !f.endsWith('.png')),
  ];
  for (const file of checked) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(
      /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(text),
      false,
      `unexpected third-party Google Fonts reference in ${path.relative(repoRoot, file)}`
    );
  }

  for (const rel of ['public/fonts/InterVariable.woff2', 'public/fonts/InterVariable-Italic.woff2']) {
    const buf = fs.readFileSync(path.join(repoRoot, rel));
    assert.equal(buf.subarray(0, 4).toString('ascii'), 'wOF2', `${rel} magic`);
    // WOFF2 header bytes 8..12 = total compressed file length (big-endian uint32).
    assert.equal(buf.readUInt32BE(8), buf.length, `${rel} WOFF2 declared length matches file bytes`);
    assert.ok(buf.length > 300_000, `${rel} keeps full variable tables + Latin-Ext (>300 KB)`);
  }

  // Only 1 font preload link, roman only, crossorigin present, no redundant fetchpriority="high".
  const preloads = [...INDEX_HTML.matchAll(/<link\b[^>]*rel="preload"[^>]*>/gi)].map(m => m[0]);
  assert.equal(preloads.length, 1);
  assert.match(preloads[0], /href="(?:\.\/|%BASE_URL%)fonts\/InterVariable\.woff2"/);
  assert.match(preloads[0], /\bcrossorigin\b/i);
  assert.equal(/fetchpriority/i.test(preloads[0]), false);
});

test('QA CD4: zero-FOUC inline <head> script tolerates throwing storage, poisoned values, extra classes & missing metas', () => {
  const scriptMatch = INDEX_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'inline synchronous <head> script must exist');
  const headTag = INDEX_HTML.slice(0, INDEX_HTML.indexOf('</head>'));
  // Inline theme script must appear before any stylesheet / preload / module script.
  const inlineIdx = headTag.indexOf('<script>');
  const preloadIdx = headTag.indexOf('rel="preload"');
  assert.ok(inlineIdx > 0 && inlineIdx < preloadIdx, 'inline theme script runs before preload/styles');

  const execThemeScript = ({ getItemImpl, initialClasses = ['dark'], hasMeta = true }) => {
    const classes = new Set(initialClasses);
    const attrs = { 'color-scheme': 'dark light', 'theme-color': '#0B0C0F' };
    vm.runInNewContext(scriptMatch[1], {
      localStorage: { getItem: getItemImpl },
      document: {
        documentElement: {
          classList: {
            remove: (...names) => names.forEach(n => classes.delete(n)),
            add: name => classes.add(name),
          },
        },
        querySelector: sel => {
          if (!hasMeta) return null;
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

  // SecurityError in private / sandboxed mode -> keeps 'dark', never throws.
  assert.deepEqual(
    execThemeScript({
      getItemImpl: () => {
        throw new Error('SecurityError: The operation is insecure.');
      },
    }),
    { classes: ['dark'], attrs: { 'color-scheme': 'dark', 'theme-color': '#0B0C0F' } }
  );

  // Poisoned / non-canonical storage values fall back to 'dark' (Q7 override).
  for (const bad of ['', 'system', 'auto', 'LIGHT', 'DARK', 'true', '"><script>alert(1)</script>']) {
    const res = execThemeScript({ getItemImpl: () => bad, initialClasses: ['light', 'custom-flag'] });
    assert.deepEqual(res.classes.sort(), ['custom-flag', 'dark'], `bad value: ${bad}`);
    assert.equal(res.attrs['color-scheme'], 'dark');
    assert.equal(res.attrs['theme-color'], '#0B0C0F');
  }

  // Saved 'light' preserves unrelated html classes and survives missing meta tags.
  const noMetaRes = execThemeScript({
    getItemImpl: () => 'light',
    initialClasses: ['dark', 'custom-flag'],
    hasMeta: false,
  });
  assert.deepEqual(noMetaRes.classes.sort(), ['custom-flag', 'light']);
});

test('QA CD4: swPrecache & sw.js enforce strict fonts/*.woff2 boundaries and never cache 404/cross-origin font misses', async () => {
  const list = swPrecache.buildPrecacheList([
    'fonts/InterVariable.woff2',
    'fonts/InterVariable-Italic.woff2',
    'fonts/Inter-LICENSE.txt',
    'fonts/InterVariable.woff2.map',
    'fonts/nested/Extra.woff2',
    'fonts/Inter.ttf',
    './fonts/InterVariable.woff2',
  ]);
  assert.deepEqual(list, ['fonts/InterVariable-Italic.woff2', 'fonts/InterVariable.woff2']);

  const ORIGIN = 'https://example.github.io';
  const SCOPE = `${ORIGIN}/pragya/`;
  const listeners = {};
  const shellStore = new Map();
  let networkCalls = 0;

  vm.runInNewContext(SW_SOURCE, {
    self: {
      location: { origin: ORIGIN },
      registration: { scope: SCOPE },
      addEventListener: (type, fn) => (listeners[type] = fn),
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      match: async req => shellStore.get(typeof req === 'string' ? req : req.url),
      open: async () => ({
        addAll: async () => {},
        put: async (req, res) => shellStore.set(typeof req === 'string' ? req : req.url, res),
      }),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async req => {
      networkCalls += 1;
      const u = typeof req === 'string' ? req : req.url;
      if (u.endsWith('missing.woff2')) return new Response('not found', { status: 404 });
      return new Response('fresh-bytes', { status: 200 });
    },
    Response,
    Request,
    URL,
    console,
  });

  const dispatch = url => {
    let called = false;
    let promise;
    listeners.fetch({
      request: { url, mode: 'cors', method: 'GET' },
      respondWith: p => {
        called = true;
        promise = p;
      },
      waitUntil: () => {},
    });
    return { called, promise };
  };

  // Cross-origin font URL is completely ignored by SW.
  assert.equal(dispatch('https://fonts.gstatic.com/s/inter/v18/font.woff2').called, false);

  // 404 under /pragya/fonts/ is returned as 404 and NOT poisoned into SHELL_CACHE.
  const res404 = await dispatch(`${SCOPE}fonts/missing.woff2`).promise;
  assert.equal(res404.status, 404);
  assert.equal(shellStore.has(`${SCOPE}fonts/missing.woff2`), false);

  // Prefix lookalike `/pragya/fonts-extra/foo.woff2` does NOT enter the FONTS_PREFIX CacheFirst branch
  // (it goes through stale-while-revalidate static branch, which still works, and caches basic 200s).
  networkCalls = 0;
  shellStore.set(`${SCOPE}fonts-extra/foo.woff2`, new Response('cached-swr', { status: 200 }));
  const swrRes = await dispatch(`${SCOPE}fonts-extra/foo.woff2`).promise;
  assert.equal(await swrRes.text(), 'cached-swr');
  assert.equal(networkCalls, 1, 'non-fonts/ path uses SWR (triggers background fetch), proving FONTS_PREFIX has trailing slash');

  // True `/pragya/fonts/InterVariable.woff2` hit does ZERO background fetches (strict CacheFirst).
  networkCalls = 0;
  shellStore.set(`${SCOPE}fonts/InterVariable.woff2`, new Response('cached-font', { status: 200 }));
  const fontHit = await dispatch(`${SCOPE}fonts/InterVariable.woff2`).promise;
  assert.equal(await fontHit.text(), 'cached-font');
  assert.equal(networkCalls, 0, 'fonts/ uses strict CacheFirst without background revalidation');
});

test('QA CD4: cardFocus, keyboardShortcuts, and navLinks adversarial edge cases', () => {
  // Shift+/ produces key='?' with shiftKey=true on US keyboards -> MUST match isHelpShortcut!
  assert.equal(
    ks.isHelpShortcut({ key: '?', shiftKey: true, metaKey: false, ctrlKey: false, altKey: false }),
    true
  );

  // Platform modifier detection across Apple vs non-Apple UA/platform strings
  for (const apple of ['MacIntel', 'Macintosh', 'iPhone', 'iPad', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)']) {
    assert.equal(ks.modKeyLabel(apple), '⌘', apple);
  }
  for (const other of ['Win32', 'Linux x86_64', 'Android', '']) {
    assert.equal(ks.modKeyLabel(other), 'Ctrl', other);
  }

  // hasFinePointer survives a throwing matchMedia implementation
  assert.equal(
    ks.hasFinePointer(() => {
      throw new Error('matchMedia unavailable');
    }),
    false
  );

  // focusedCardIndex rejects negative, non-integer, NaN, empty, and missing data-jk-card attributes
  for (const bad of ['-1', '1.5', 'abc', '', '   ', undefined]) {
    assert.equal(
      cf.focusedCardIndex({ closest: () => ({ dataset: { jkCard: bad } }) }),
      null,
      `jkCard=${String(bad)}`
    );
  }
  assert.equal(cf.focusedCardIndex({ closest: () => ({ dataset: { jkCard: '0' } }) }), 0);
  assert.equal(cf.focusedCardIndex({}), null);

  // noteCardAriaLabel trims inputs and strictly hides title when shielded
  assert.equal(
    cf.noteCardAriaLabel({
      bookTitle: '  ',
      posLabel: '55%',
      title: '  Secret Twist  ',
      shielded: true,
    }),
    'Book · 55% · Shielded note'
  );
  assert.equal(
    cf.noteCardAriaLabel({
      bookTitle: '  Exhalation ',
      posLabel: '55%',
      title: '   ',
      shielded: false,
    }),
    'Exhalation · 55% · Note'
  );

  // navAriaCurrent matrix across all 4 destinations × 6 views
  for (const view of ['shelf', 'notes', 'practice', 'settings', 'book', 'note']) {
    assert.equal(nl.navAriaCurrent('practice', view), view === 'practice' ? 'page' : undefined);
    assert.equal(nl.navAriaCurrent('settings', view), view === 'settings' ? 'page' : undefined);
  }
});

test('QA CD4: CommandPalette gates bookMap, items, and filtered groups on isOpen', () => {
  const paletteSrc = fs.readFileSync(
    path.join(repoRoot, 'src/components/layout/CommandPalette.tsx'),
    'utf8'
  );
  // All 3 memos (`bookMap`, `items`, `{ groupedItems, flatItems }`) must short-circuit when `!isOpen`.
  const guards = paletteSrc.match(/if \(!isOpen\) return/g) || [];
  assert.ok(guards.length >= 4, `expected >=4 !isOpen early returns in CommandPalette, found ${guards.length}`);
});
