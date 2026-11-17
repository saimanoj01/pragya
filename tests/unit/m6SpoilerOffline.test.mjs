import test from 'node:test';
import assert from 'node:assert/strict';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const { effectiveNoteNorm, isNoteSpoiler, SPOILER_NORM_EPSILON } = await load('src/utils/spoilerMath.ts');
const {
  SHIELDED_NOTE_TITLE,
  REVEAL_TO_EDIT_TOOLTIP,
  SPOILER_SEARCH_FOOTNOTE,
  NOTE_REVEALED_ANNOUNCEMENT,
  buildNoteSearchHaystack,
  filterWikilinkCandidates,
  getNoteDetailVisibility,
  isShielded,
  shieldedNoteLabel,
  noteHref,
  resolveNoteRef,
  getPracticeDeltaLists,
} = await load('src/utils/noteVisibility.ts');
const {
  NEW_VERSION_TOAST,
  NEW_VERSION_ACTION,
  announceWhenIdle,
  createThrottledUpdateCheck,
  isDialogOpen,
  watchControllerChanges,
} = await load('src/utils/swUpdateCore.ts');
const {
  BUILD_ID_PLACEHOLDER,
  PRECACHE_PLACEHOLDER,
  buildPrecacheList,
  computeBuildId,
  injectIntoDist,
  injectSwManifest,
} = await load('scripts/swPrecache.mjs');

const SW_SOURCE = fs.readFileSync(path.join(repoRoot, 'public/sw.js'), 'utf8');

function book(overrides = {}) {
  return {
    id: 'book-1',
    title: 'The Long Way',
    author: 'Becky Chambers',
    format: 'physical',
    kind: 'fiction',
    status: 'reading',
    currentPos: 100,
    totalPos: 300,
    posUnit: 'page',
    normalizedPos: 100 / 300,
    docUrl: '',
    meta: {},
    ...overrides,
  };
}

function note(overrides = {}) {
  return {
    id: 'note-1',
    slug: 'secret-twist-slug',
    bookId: 'book-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    pos: 250,
    normalizedPos: 0,
    status: 'saved',
    source: 'app',
    tags: ['found-family'],
    quote: 'The captain dies',
    takeaway: 'Mortality reframes duty',
    contextMechanism: 'hidden mechanism',
    critique: 'hidden critique',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none',
    meta: { title: 'Twist Title', chapter: 'Chapter 12: The Reveal' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// B2.4 dynamic normalizedPos
// ---------------------------------------------------------------------------

test('B2.4: totalPos edited 0 → 300 — stale stored normalizedPos 0 no longer hides the spoiler', () => {
  const n = note({ pos: 250, normalizedPos: 0 });
  const b = book({ currentPos: 100, totalPos: 300, normalizedPos: 100 / 300 });
  assert.equal(effectiveNoteNorm(n, b), 250 / 300);
  assert.equal(isNoteSpoiler(n, b), true);
  assert.equal(isNoteSpoiler(note({ pos: 50, normalizedPos: 0 }), b), false);
  assert.equal(isNoteSpoiler(n, book({ status: 'finished' })), false);
});

test('B2.4: percent books normalize pos/100; no scale falls back to stored value and raw positions', () => {
  const pct = book({ posUnit: 'percent', totalPos: 0, currentPos: 40, normalizedPos: 0.4 });
  assert.equal(effectiveNoteNorm(note({ pos: 55, normalizedPos: 0 }), pct), 0.55);
  assert.equal(isNoteSpoiler(note({ pos: 55 }), pct), true);
  assert.equal(isNoteSpoiler(note({ pos: 30 }), pct), false);
  const unscaled = book({ totalPos: 0, currentPos: 100, normalizedPos: 0 });
  assert.equal(effectiveNoteNorm(note({ normalizedPos: 0.7 }), unscaled), 0.7);
  assert.equal(isNoteSpoiler(note({ pos: 120 }), unscaled), true);
  assert.equal(isNoteSpoiler(note({ pos: 90 }), unscaled), false);
  assert.equal(effectiveNoteNorm(note({ normalizedPos: 0.2 }), null), 0.2);
});

// ---------------------------------------------------------------------------
// B2.2 / B2.3 spoiler-safe search, palette and wikilink picker
// ---------------------------------------------------------------------------

test('B2.2: shielded haystack holds only tags + book title/author; revealed/non-spoiler is full', () => {
  const b = book();
  const shielded = buildNoteSearchHaystack(note(), b);
  for (const leak of ['captain', 'mortality', 'twist title', 'secret-twist-slug', 'chapter 12', 'hidden mechanism', 'hidden critique']) {
    assert.equal(shielded.includes(leak), false, leak);
  }
  for (const ok of ['found-family', 'the long way', 'becky chambers']) {
    assert.ok(shielded.includes(ok), ok);
  }
  const revealed = buildNoteSearchHaystack(note(), b, { revealed: true });
  for (const term of ['captain', 'mortality', 'twist title', 'secret-twist-slug', 'chapter 12', 'found-family']) {
    assert.ok(revealed.includes(term), term);
  }
  assert.ok(buildNoteSearchHaystack(note({ pos: 50 }), b).includes('captain'));
});

test('B2.2: shielded label shows position only; footnote/a11y copy matches ux_spec', () => {
  const label = shieldedNoteLabel(note(), book());
  assert.ok(label.startsWith(`${SHIELDED_NOTE_TITLE} · `));
  assert.ok(label.includes('250'));
  assert.equal(label.includes('secret'), false);
  assert.equal(label.includes('Twist'), false);
  assert.equal(SPOILER_SEARCH_FOOTNOTE, 'Notes ahead of your bookmark are searched by tag and book only.');
  assert.equal(REVEAL_TO_EDIT_TOOLTIP, 'Reveal the note to edit');
  assert.equal(NOTE_REVEALED_ANNOUNCEMENT, 'Note revealed.');
});

test('B2.3: wikilink candidates exclude shielded notes entirely (even on exact slug match)', () => {
  const books = [book()];
  const spoiler = note();
  const safe = note({ id: 'note-2', slug: 'secret-safe-slug', pos: 20, meta: { title: 'Safe' } });
  const self = note({ id: 'note-3', slug: 'secret-self', pos: 10 });
  const got = filterWikilinkCandidates([spoiler, safe, self], books, 'secret', { noteId: 'note-3' });
  assert.deepEqual(got.map(n => n.id), ['note-2']);
  assert.deepEqual(filterWikilinkCandidates([spoiler], books, 'secret-twist-slug').length, 0);
  // Without book context (legacy callers) nothing is filtered by spoiler state.
  assert.equal(filterWikilinkCandidates([spoiler, safe], undefined, 'secret').length, 2);
  assert.equal(filterWikilinkCandidates([safe, safe, safe], books, '', {}, 2).length, 2);
});

test('B2.1: NoteDetailView visibility — shielded hides content/backlinks/chapter and disables edit', () => {
  const b = book();
  const hidden = getNoteDetailVisibility(note(), b, false);
  assert.deepEqual(hidden, {
    shielded: true,
    heading: SHIELDED_NOTE_TITLE,
    showContent: false,
    showBacklinks: false,
    showChapter: false,
    editDisabled: true,
    editTooltip: REVEAL_TO_EDIT_TOOLTIP,
  });
  const shown = getNoteDetailVisibility(note(), b, true);
  assert.equal(shown.shielded, false);
  assert.equal(shown.heading, 'Twist Title');
  assert.equal(shown.showContent && shown.showBacklinks && shown.showChapter, true);
  assert.equal(shown.editDisabled, false);
  assert.equal(getNoteDetailVisibility(note({ meta: {} }), b, true).heading, 'secret-twist-slug');
  assert.equal(isShielded(note(), b, true), false);
  assert.equal(isShielded(note(), null, false), false);
});

// ---------------------------------------------------------------------------
// B3.1 precache manifest
// ---------------------------------------------------------------------------

test('B3.1: buildPrecacheList keeps assets/* and shell files, drops maps/others, sorted + deduped', () => {
  const list = buildPrecacheList([
    'sw.js',
    'index.html',
    './assets/index-abc123.js',
    'assets\\vendor-react-def456.js',
    'assets/index-abc123.js',
    'assets/index-abc123.js.map',
    'assets/index-777.css',
    'assets/nested/deep.js',
    'manifest.webmanifest',
    'icon-192.png',
    'robots.txt',
  ]);
  assert.deepEqual(list, [
    'assets/index-777.css',
    'assets/index-abc123.js',
    'assets/vendor-react-def456.js',
    'icon-192.png',
    'index.html',
    'manifest.webmanifest',
  ]);
});

test('B3.1: computeBuildId is a stable 12-char hex, order-independent, content-sensitive', () => {
  const list = ['assets/a.js', 'index.html'];
  const id = computeBuildId(list);
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(computeBuildId([...list].reverse()), id);
  assert.notEqual(computeBuildId(['assets/b.js', 'index.html']), id);
  const c1 = computeBuildId(list, { 'index.html': '<html>1</html>' });
  const c2 = computeBuildId(list, { 'index.html': '<html>2</html>' });
  assert.notEqual(c1, c2);
});

test('B3.1: injectSwManifest replaces both placeholders; refuses a sw.js without them', () => {
  assert.ok(SW_SOURCE.includes(PRECACHE_PLACEHOLDER));
  assert.ok(SW_SOURCE.includes(BUILD_ID_PLACEHOLDER));
  const out = injectSwManifest(SW_SOURCE, ['assets/a.js', 'index.html'], 'abcdef012345');
  assert.equal(out.includes('__PRAGYA_PRECACHE__'), false);
  assert.equal(out.includes('__PRAGYA_BUILD_ID__'), false);
  assert.ok(out.includes('const PRECACHE = ["assets/a.js","index.html"];'));
  assert.ok(out.includes('const BUILD_ID = "abcdef012345";'));
  new vm.Script(out); // still valid JS
  assert.throws(() => injectSwManifest('const x = 1;', [], 'abcdef012345'), /placeholders/);
  assert.throws(() => injectSwManifest(SW_SOURCE, [], 'nope'), /invalid build id/);
});

test('B3.1: injectIntoDist rewrites dist/sw.js listing every dist/assets file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pragya-sw-'));
  try {
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets/index-1.js'), 'js');
    fs.writeFileSync(path.join(dir, 'assets/index-1.css'), 'css');
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(dir, 'sw.js'), SW_SOURCE);
    const res = injectIntoDist(dir);
    assert.deepEqual(res.list, ['assets/index-1.css', 'assets/index-1.js', 'index.html']);
    const written = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
    assert.ok(written.includes(JSON.stringify(res.list)));
    assert.ok(written.includes(JSON.stringify(res.buildId)));
    assert.equal(injectIntoDist(path.join(dir, 'assets')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B3.2 sw.js behavior in a node:vm sandbox
// ---------------------------------------------------------------------------

const ORIGIN = 'https://example.test';
const SCOPE = `${ORIGIN}/pragya/`;

function keyOf(req) {
  return typeof req === 'string' ? req : req.url;
}

function loadSw({ source = SW_SOURCE, fetchImpl, cacheEntries = {}, cacheNames = [], matchRejects = false } = {}) {
  const listeners = {};
  const stores = new Map(cacheNames.map(name => [name, new Map()]));
  const deleted = [];
  const added = [];
  const flat = new Map(Object.entries(cacheEntries));
  const openStore = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      put: async (req, res) => {
        store.set(keyOf(req), res);
        flat.set(keyOf(req), res);
      },
      addAll: async reqs => {
        added.push(...reqs);
      },
      match: async req => store.get(keyOf(req)),
    };
  };
  const sandbox = {
    self: {
      registration: { scope: SCOPE },
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      match: async req => {
        if (matchRejects) throw new Error('cache storage unavailable');
        return flat.get(keyOf(req));
      },
      open: async name => openStore(name),
      keys: async () => [...stores.keys()],
      delete: async name => {
        deleted.push(name);
        return stores.delete(name);
      },
    },
    fetch: fetchImpl || (() => Promise.reject(new TypeError('Failed to fetch'))),
    Response,
    Request,
    URL,
    console,
  };
  vm.runInNewContext(source, sandbox);
  const dispatchFetch = (url, mode = 'no-cors', method = 'GET') => {
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
  return { listeners, dispatchFetch, runLifecycle, stores, deleted, added, addedUrls };
}

async function expectResponse(result) {
  assert.equal(result.called, true, 'respondWith must be called');
  assert.notEqual(result.promise, undefined);
  const res = await result.promise;
  assert.ok(res instanceof Response, `expected a Response, got ${res}`);
  return res;
}

test('B3.2: offline navigation — cache miss serves the inline offline page (ux_spec D.2)', async () => {
  const sw = loadSw();
  const res = await expectResponse(sw.dispatchFetch(`${SCOPE}notes`, 'navigate'));
  assert.equal(res.status, 503);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes("You're offline"));
  assert.ok(html.includes("Pragya will open as soon as you're back online. Your notes are safe in your Google account."));
  assert.ok(html.includes('Try Again'));
  assert.ok(html.includes('location.reload()'));
  for (const hex of ['#0B0C0F', '#131418', '#EDEEF1', '#9DA0A8']) assert.ok(html.includes(hex), hex);
  assert.ok(html.includes('border-radius:14px'));
  assert.equal(/<(link|script)\b|src=|https?:\/\//.test(html), false, 'no external assets');
});

test('B3.2: offline navigation — cached index.html wins over the offline page', async () => {
  const shell = new Response('<html>shell</html>', { status: 200 });
  const sw = loadSw({ cacheEntries: { [`${SCOPE}index.html`]: shell } });
  const res = await expectResponse(sw.dispatchFetch(`${SCOPE}book/x`, 'navigate'));
  assert.equal(await res.text(), '<html>shell</html>');
});

const html = body => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

test('B3.2: online navigation returns the network response and refreshes cached index', async () => {
  const sw = loadSw({ fetchImpl: async () => html('<html>fresh</html>') });
  const res = await expectResponse(sw.dispatchFetch(SCOPE, 'navigate'));
  assert.equal(await res.text(), '<html>fresh</html>');
  await new Promise(r => setTimeout(r, 0));
  const [store] = [...sw.stores.values()];
  assert.ok(store.has(`${SCOPE}index.html`));
});

test('B3.2: hashed /assets/* — cache hit, offline miss → Response.error() (never undefined)', async () => {
  const cached = new Response('js', { status: 200 });
  const sw = loadSw({ cacheEntries: { [`${SCOPE}assets/index-1.js`]: cached } });
  assert.equal(await (await expectResponse(sw.dispatchFetch(`${SCOPE}assets/index-1.js`))).text(), 'js');
  const miss = await expectResponse(sw.dispatchFetch(`${SCOPE}assets/index-2.js`));
  assert.equal(miss.type, 'error');
});

test('B3.2: hashed asset cache-first does not hit the network on a hit', async () => {
  let fetches = 0;
  const sw = loadSw({
    cacheEntries: { [`${SCOPE}assets/a.css`]: new Response('css') },
    fetchImpl: async () => {
      fetches += 1;
      return new Response('net');
    },
  });
  await expectResponse(sw.dispatchFetch(`${SCOPE}assets/a.css`));
  assert.equal(fetches, 0);
});

test('B3.2: other static files — stale-while-revalidate; offline miss → Response.error()', async () => {
  const sw = loadSw({ cacheEntries: { [`${SCOPE}lotus.svg`]: new Response('<svg/>') } });
  assert.equal(await (await expectResponse(sw.dispatchFetch(`${SCOPE}lotus.svg`))).text(), '<svg/>');
  const miss = await expectResponse(sw.dispatchFetch(`${SCOPE}icon-512.png`));
  assert.equal(miss.type, 'error');
});

test('B3.2: CacheStorage failures still resolve to a Response', async () => {
  const sw = loadSw({ matchRejects: true });
  assert.equal((await expectResponse(sw.dispatchFetch(`${SCOPE}assets/x.js`))).type, 'error');
  assert.equal((await expectResponse(sw.dispatchFetch(`${SCOPE}lotus.svg`))).type, 'error');
  assert.equal((await expectResponse(sw.dispatchFetch(`${SCOPE}`, 'navigate'))).status, 503);
});

test('B3.2: bypasses cross-origin, non-GET, drive-media, sw.js and out-of-scope requests', () => {
  const sw = loadSw();
  assert.equal(sw.dispatchFetch('https://sheets.googleapis.com/v4/x').called, false);
  assert.equal(sw.dispatchFetch(`${SCOPE}assets/a.js`, 'no-cors', 'POST').called, false);
  assert.equal(sw.dispatchFetch(`${SCOPE}drive-media/abc`).called, false);
  assert.equal(sw.dispatchFetch(`${SCOPE}sw.js`).called, false);
  assert.equal(sw.dispatchFetch(`${ORIGIN}/other-app/x.js`).called, false);
});

test('B3.1: built worker precaches scope-relative URLs under a versioned cache; activate evicts old shells only', async () => {
  const id = '0123456789ab';
  const source = injectSwManifest(SW_SOURCE, ['assets/index-1.js', 'index.html'], id);
  const sw = loadSw({ source, cacheNames: ['pragya-shell-v1', 'pragya-shell-deadbeef0000', 'pragya-media-v1'] });
  await sw.runLifecycle('install');
  assert.deepEqual(sw.addedUrls(), [SCOPE, `${SCOPE}assets/index-1.js`, `${SCOPE}index.html`]);
  // Fix-up R1#2: precache bypasses the HTTP cache so a stale index.html is never captured.
  for (const req of sw.added) {
    assert.ok(req instanceof Request);
    assert.equal(req.cache, 'reload');
  }
  assert.ok(sw.stores.has(`pragya-shell-${id}`));
  await sw.runLifecycle('activate');
  assert.deepEqual(sw.deleted.sort(), ['pragya-shell-deadbeef0000', 'pragya-shell-v1']);
  assert.ok(sw.stores.has('pragya-media-v1'));
  assert.ok(sw.stores.has(`pragya-shell-${id}`));
});

test('B3.1: unbuilt public/sw.js is valid JS and falls back to the core shell list', async () => {
  new vm.Script(SW_SOURCE);
  const sw = loadSw();
  await sw.runLifecycle('install');
  assert.ok(sw.addedUrls().includes(`${SCOPE}index.html`));
  assert.ok(sw.addedUrls().includes(`${SCOPE}manifest.webmanifest`));
  assert.ok(sw.addedUrls().includes(SCOPE));
});

// ---------------------------------------------------------------------------
// Batch 4 fix-up
// ---------------------------------------------------------------------------

test('Fix-up R1#3: only scope-root / index.html HTML navigations become the cached shell', async () => {
  const cases = [
    { url: `${SCOPE}index.html`, res: () => html('<html>a</html>'), cached: true },
    { url: `${SCOPE}?utm=1`, res: () => html('<html>b</html>'), cached: true },
    { url: `${SCOPE}manifest.webmanifest`, res: () => new Response('{}', { headers: { 'Content-Type': 'application/manifest+json' } }), cached: false },
    { url: `${SCOPE}icon-192.png`, res: () => new Response('png', { headers: { 'Content-Type': 'image/png' } }), cached: false },
    { url: `${SCOPE}other.html`, res: () => html('<html>other</html>'), cached: false },
    { url: SCOPE, res: () => new Response('plain', { headers: { 'Content-Type': 'text/plain' } }), cached: false },
  ];
  for (const c of cases) {
    const sw = loadSw({ fetchImpl: async () => c.res() });
    const res = await expectResponse(sw.dispatchFetch(c.url, 'navigate'));
    assert.equal(res.ok, true, c.url);
    await new Promise(r => setTimeout(r, 0));
    const stored = [...sw.stores.values()].some(store => store.has(`${SCOPE}index.html`));
    assert.equal(stored, c.cached, c.url);
  }
});

test('Fix-up R1#5: injectIntoDist re-injects from the pristine template (watch-mode rebuild)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pragya-sw-'));
  try {
    const template = path.join(dir, 'template-sw.js');
    fs.writeFileSync(template, SW_SOURCE);
    const out = path.join(dir, 'dist');
    fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(out, 'assets/a-1.js'), 'one');
    fs.writeFileSync(path.join(out, 'sw.js'), SW_SOURCE);
    const first = injectIntoDist(out, { templatePath: template });
    // Rebuild: dist/sw.js is already injected (no placeholders) and assets changed.
    fs.rmSync(path.join(out, 'assets/a-1.js'));
    fs.writeFileSync(path.join(out, 'assets/a-2.js'), 'two');
    const second = injectIntoDist(out, { templatePath: template });
    assert.notEqual(second.buildId, first.buildId);
    const written = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
    assert.ok(written.includes('"assets/a-2.js"'));
    assert.equal(written.includes('a-1.js'), false);
    // Without a template the already-injected file is rejected loudly (no silent stale list).
    assert.throws(() => injectIntoDist(out), /placeholders/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix-up R1#1: Practice delta lists shield ahead-of-bookmark notes (label + Reveal), cap still counts them', () => {
  const b = book();
  const bookMap = new Map([[b.id, b]]);
  const spoilerActive = note({ id: 's-act', deltaStatus: 'active', deltaTrigger: 'WHEN secret', pos: 250 });
  const spoilerPaused = note({ id: 's-pau', deltaStatus: 'paused', pos: 280 });
  const safeActive = note({ id: 'ok-act', deltaStatus: 'active', pos: 50 });
  const safeGrad = note({ id: 'ok-grad', deltaStatus: 'graduated', pos: 60 });
  const none = note({ id: 'none', deltaStatus: 'none', pos: 10 });
  const all = [spoilerActive, spoilerPaused, safeActive, safeGrad, none];
  const lists = getPracticeDeltaLists(all, bookMap);
  assert.deepEqual(lists.active.map(n => n.id), ['s-act', 'ok-act']); // 5-cap counts both
  assert.deepEqual(lists.archived.map(n => n.id), ['s-pau', 'ok-grad']);
  assert.deepEqual([...lists.shieldedIds].sort(), ['s-act', 's-pau']);
  // The row label never carries title/slug/WHEN.
  const label = shieldedNoteLabel(spoilerActive, b);
  for (const leak of ['secret', 'Twist', 'twist-slug']) assert.equal(label.includes(leak), false, leak);
  // Local reveal un-shields just that delta.
  const revealed = getPracticeDeltaLists(all, bookMap, new Set(['s-act']));
  assert.deepEqual([...revealed.shieldedIds], ['s-pau']);
  // Finished book → nothing shielded.
  const done = getPracticeDeltaLists(all, new Map([[b.id, book({ status: 'finished' })]]));
  assert.equal(done.shieldedIds.size, 0);
});

test('Fix-up decision: shielded notes route by uuid; detail resolves slug or id', () => {
  const b = book();
  const shielded = note({ id: 'f1e2d3c4-uuid', slug: 'future-ending-twist' });
  const visible = note({ id: 'v-uuid', slug: 'safe-note', pos: 10 });
  assert.equal(noteHref(shielded, b), '#/note/f1e2d3c4-uuid');
  assert.equal(noteHref(shielded, b, true), '#/note/future-ending-twist');
  assert.equal(noteHref(visible, b), '#/note/safe-note');
  assert.equal(noteHref(note({ slug: 'a b' , pos: 1 }), b), '#/note/a%20b');
  const notes = [shielded, visible];
  assert.equal(resolveNoteRef(notes, 'future-ending-twist'), shielded);
  assert.equal(resolveNoteRef(notes, 'f1e2d3c4-uuid'), shielded);
  assert.equal(resolveNoteRef(notes, 'nope'), undefined);
  assert.equal(resolveNoteRef(notes, ''), undefined);
  // Slug wins when a slug happens to equal another note's id.
  const clash = note({ id: 'safe-note', slug: 'zzz' });
  assert.equal(resolveNoteRef([clash, visible], 'safe-note'), visible);
});

test('Fix-up decision: replaceHash swaps to the slug URL without a history entry', async () => {
  const { replaceHash } = await load('src/utils/navigation.ts');
  const calls = [];
  const prevWindow = globalThis.window;
  globalThis.window = {
    location: { hash: '#/note/f1e2d3c4-uuid', pathname: '/pragya/', search: '?x=1' },
    history: { state: { k: 1 }, replaceState: (...args) => calls.push(args) },
  };
  try {
    replaceHash('#/note/future-ending-twist');
    assert.deepEqual(calls, [[{ k: 1 }, '', '/pragya/?x=1#/note/future-ending-twist']]);
    globalThis.window.location.hash = '#/note/same';
    replaceHash('#/note/same');
    assert.equal(calls.length, 1);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

function fakeContainer(controller) {
  const target = new EventTarget();
  return {
    controller,
    addEventListener: (type, fn) => target.addEventListener(type, fn),
    fire: () => target.dispatchEvent(new Event('controllerchange')),
  };
}

test('Fix-up R2#1: swUpdate — first install is silent; a controlled page announces exactly once', () => {
  let count = 0;
  const fresh = fakeContainer(null);
  watchControllerChanges(fresh, () => (count += 1));
  fresh.fire(); // (a) first install claims an uncontrolled page
  assert.equal(count, 0);
  fresh.fire(); // later swap in the same tab is a real update
  assert.equal(count, 1);
  fresh.fire(); // (c) further changes: no repeat toast
  assert.equal(count, 1);

  let controlledCount = 0;
  const controlled = fakeContainer({ id: 'old-sw' });
  watchControllerChanges(controlled, () => (controlledCount += 1));
  controlled.fire(); // (b)
  controlled.fire(); // (c)
  assert.equal(controlledCount, 1);
});

test('Fix-up R2#1: swUpdate — deferred while a dialog is open, shown once it closes', () => {
  let dialogOpen = true;
  const timers = [];
  let notified = 0;
  const deps = {
    isDialogOpen: () => dialogOpen,
    notify: () => (notified += 1),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    retryMs: 2000,
  };
  announceWhenIdle(deps);
  assert.equal(notified, 0);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
  timers.shift().fn(); // still open → re-schedules
  assert.equal(notified, 0);
  assert.equal(timers.length, 1);
  dialogOpen = false;
  timers.shift().fn();
  assert.equal(notified, 1);
  assert.equal(timers.length, 0);

  const doc = sel => ({ querySelector: q => (q.includes(sel) ? {} : null) });
  assert.equal(isDialogOpen({ querySelector: () => null }), false);
  assert.equal(isDialogOpen(doc('[role="dialog"]')), true);
  assert.equal(NEW_VERSION_TOAST, 'A new version of Pragya is ready.');
  assert.equal(NEW_VERSION_ACTION, 'Reload');
});

test('Fix-up R1#6: throttled update check fires at most once per interval', () => {
  let t = 1000;
  let checks = 0;
  const check = createThrottledUpdateCheck(() => (checks += 1), () => t, 30 * 60 * 1000);
  assert.equal(check(), false); // just loaded
  t += 29 * 60 * 1000;
  assert.equal(check(), false);
  t += 2 * 60 * 1000;
  assert.equal(check(), true);
  assert.equal(check(), false);
  t += 30 * 60 * 1000;
  assert.equal(check(), true);
  assert.equal(checks, 2);
});

test('Batch 6: a note exactly at the bookmark is not shielded by 6-decimal Sheet rounding (CLI parity)', () => {
  // sheetCodecs/CLI store normalizedPos via toFixed(6): 142/218 -> 0.651376 < 0.6513761...
  const b = book({ currentPos: 142, totalPos: 218, normalizedPos: Number((142 / 218).toFixed(6)) });
  assert.equal(isNoteSpoiler(note({ pos: 142, normalizedPos: 0 }), b), false);
  assert.equal(isNoteSpoiler(note({ pos: 143, normalizedPos: 0 }), b), true);
  assert.equal(SPOILER_NORM_EPSILON, 1e-6);
});
