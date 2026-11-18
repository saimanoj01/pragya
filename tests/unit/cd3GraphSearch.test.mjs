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

/**
 * CD Batch 3 — knowledge graph, search and book surfaces (pure helpers): wikilink tokenizer
 * and inline-chip resolution (C3.1), slug aliases (C3.2), deslugify + hub notes (C3.3),
 * tokenized spoiler-safe search + URL query state + sort (C3.4), activity days (C2.2),
 * sessions trail (C2.3), link chips (C2.5), covers + the everFinished spoiler rule (C2.6).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const wl = await load('src/utils/wikilinks.ts');
const nv = await load('src/utils/noteVisibility.ts');
const nq = await load('src/utils/notesQuery.ts');
const bs = await load('src/utils/bookSurfaces.ts');
const sm = await load('src/utils/spoilerMath.ts');
const nav = await load('src/utils/navigation.ts');

const book = (o = {}) => ({
  id: 'b1', title: 'Thinking in Systems', author: 'Donella Meadows', format: 'physical', kind: 'nonfiction',
  status: 'reading', currentPos: 100, totalPos: 200, posUnit: 'page', normalizedPos: 0.5, docUrl: '',
  meta: { updatedAt: 'u' }, ...o,
});
const note = (id, o = {}) => ({
  id, slug: id, bookId: 'b1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', pos: 50,
  normalizedPos: 0.25, status: 'saved', source: 'app', tags: [], quote: '', takeaway: '', contextMechanism: '',
  critique: '', deltaTrigger: '', deltaAction: '', deltaStatus: 'none', meta: { attachments: [], links: [] }, ...o,
});

// ---- C3.1 tokenizer ---------------------------------------------------------------------

test('C3.1 tokenizeWikiText: adjacent links, unclosed, empty, nested brackets, newlines', () => {
  assert.deepEqual(wl.tokenizeWikiText('See [[a]][[B c]] now'), [
    { type: 'text', value: 'See ' },
    { type: 'link', raw: '[[a]]', slug: 'a' },
    { type: 'link', raw: '[[B c]]', slug: 'b-c' },
    { type: 'text', value: ' now' },
  ]);
  assert.deepEqual(wl.tokenizeWikiText('open [[a and [[]] and [[x]y]]'), [
    { type: 'text', value: 'open [[a and [[]] and [[x]y]]' },
  ]);
  assert.deepEqual(wl.tokenizeWikiText('[[[[deep]]]]').map(t => t.type), ['text', 'link', 'text']);
  assert.deepEqual(wl.tokenizeWikiText('[[line\nbreak]]'), [{ type: 'text', value: '[[line\nbreak]]' }]);
  assert.deepEqual(wl.tokenizeWikiText(''), []);
});

// ---- C3.2 aliases ---------------------------------------------------------------------------

test('C3.2 addSlugAlias: append old, dedupe, never the current slug, newest last, cap 10', () => {
  assert.deepEqual(wl.addSlugAlias(undefined, 'a', 'b'), ['a']);
  assert.deepEqual(wl.addSlugAlias(['a'], 'b', 'c'), ['a', 'b']);
  assert.deepEqual(wl.addSlugAlias(['a', 'b'], 'c', 'a'), ['b', 'c'], 'renaming back to an alias drops it');
  assert.deepEqual(wl.addSlugAlias(['A b', 'a-b', 7, ''], 'x', 'y'), ['a-b', 'x']);
  const many = Array.from({ length: 12 }, (_, i) => `s${i}`);
  const out = wl.addSlugAlias(many, 'last', 'cur');
  assert.equal(out.length, wl.NOTE_ALIAS_CAP);
  assert.equal(out[out.length - 1], 'last');
  assert.ok(!out.includes('s0') && !out.includes('s2'));
  assert.deepEqual(wl.addSlugAlias(['a'], 'same', 'same'), ['a']);
});

test('C3.2 aliases resolve: route, wikilink target, backlinks, search, taken slugs', () => {
  const renamed = note('n-b', { slug: 'new-name', meta: { attachments: [], links: [], aliases: ['old-name'] } });
  const linker = note('n-a', { takeaway: 'see [[old-name]] and [[Missing One]]' });
  const notes = [renamed, linker];
  assert.equal(nv.resolveNoteRef(notes, 'old-name').id, 'n-b');
  assert.equal(nv.resolveNoteRef(notes, 'new-name').id, 'n-b');
  assert.equal(wl.resolveWikilinkTarget(notes, 'Old Name').id, 'n-b');
  assert.equal(wl.resolveWikilinkTarget(notes, 'missing-one'), undefined);
  assert.deepEqual(wl.computeNoteBacklinks(renamed, notes).map(n => n.id), ['n-a']);
  assert.ok(wl.takenSlugs(notes, 'n-a').includes('old-name'));
  assert.ok(!wl.takenSlugs(notes, 'n-b').includes('old-name'), 'own aliases are free to reclaim');
  assert.equal(wl.generateUniqueSlug('Old Name', wl.takenSlugs(notes)), 'old-name-2');
  assert.ok(nq.matchesNoteQuery(renamed, book(), 'old-name'));
});

test('C3.3 deslugify', () => {
  assert.equal(wl.deslugify('feedback-loops'), 'Feedback loops');
  assert.equal(wl.deslugify('a__b--c'), 'A b c');
  assert.equal(wl.deslugify(''), '');
});

// ---- C3.4 search & URL -----------------------------------------------------------------------

test('C3.4 tokenized AND search across Layer 2 / chapter / aliases; diacritics; #tag exact; "phrase"', () => {
  const n = note('n1', {
    takeaway: 'Wait out the lag',
    contextMechanism: 'Balancing loops with délai',
    critique: 'Fails under panic',
    deltaTrigger: 'graphs wobble',
    deltaAction: 'wait one cycle',
    tags: ['#systems', '#Feedback'],
    meta: { attachments: [], links: [], chapter: 'Ch. 3', aliases: ['old-slug'] },
  });
  const b = book();
  for (const q of ['lag delai', 'PANIC wobble', 'cycle Ch.', '#feedback lag', '"wait out the"', 'meadows systems', 'old-slug']) {
    assert.equal(nq.matchesNoteQuery(n, b, q), true, q);
  }
  for (const q of ['lag missingword', '#feed', '"out wait"', '#systems #nope']) {
    assert.equal(nq.matchesNoteQuery(n, b, q), false, q);
  }
});

test('C3.4 shield: an unrevealed spoiler never matches hidden fields (tags + book only)', () => {
  const fb = book({ kind: 'fiction', currentPos: 50, normalizedPos: 0.25 });
  const secret = note('s', { pos: 150, takeaway: 'SECRET twist', deltaTrigger: 'hidden trigger', tags: ['#plot'], meta: { attachments: [], links: [], chapter: 'Finale', aliases: ['hidden-alias'] } });
  for (const q of ['secret', 'hidden', 'finale', 'hidden-alias']) assert.equal(nq.matchesNoteQuery(secret, fb, q), false, q);
  assert.equal(nq.matchesNoteQuery(secret, fb, '#plot'), true);
  assert.equal(nq.matchesNoteQuery(secret, fb, 'meadows'), true);
  assert.equal(nq.matchesNoteQuery(secret, fb, 'secret', { revealed: true }), true);
});

test('C3.4 parseNotesQuery / buildNotesHash round-trip; defaults omitted; junk → defaults; parseHash unaffected', () => {
  const state = { q: 'feedback loop', tags: ['#systems', '#delays'], book: 'b1', filter: 'atomic', sort: 'reading' };
  const hash = nq.buildNotesHash(state);
  assert.equal(hash, '#/notes?q=feedback+loop&tag=systems&tag=delays&book=b1&filter=atomic&sort=reading');
  assert.deepEqual(nq.parseNotesQuery(hash), state);
  assert.equal(nq.buildNotesHash(nq.DEFAULT_NOTES_QUERY), '#/notes');
  assert.deepEqual(nq.parseNotesQuery('#/notes?tag=%23systems&q=loop'), { ...nq.DEFAULT_NOTES_QUERY, q: 'loop', tags: ['#systems'] });
  assert.deepEqual(nq.parseNotesQuery('#/notes?filter=bogus&sort=nope&tag=&tag=A%20B'), { ...nq.DEFAULT_NOTES_QUERY, tags: ['#a-b'] });
  assert.equal(nav.parseHash('#/notes?q=x').view, 'notes');
  assert.equal(nav.isOAuthCallbackHash('#/notes?q=access_token'), false);
  assert.equal(nq.hasActiveNotesFilters(nq.DEFAULT_NOTES_QUERY), false);
  assert.equal(nq.hasActiveNotesFilters({ ...nq.DEFAULT_NOTES_QUERY, tags: ['#a'] }), true);
});

test('C3.4 sortNotesForView: recent / newest / reading; To Spar stays oldest-first under the default', () => {
  const bm = new Map([['b1', book({ title: 'Zeta' })], ['b2', book({ id: 'b2', title: 'Alpha' })]]);
  const a = note('a', { bookId: 'b1', pos: 5, createdAt: '2026-01-01', updatedAt: '2026-03-01' });
  const b = note('b', { bookId: 'b2', pos: 9, createdAt: '2026-02-01', updatedAt: '2026-01-15' });
  const c = note('c', { bookId: 'b2', pos: 2, createdAt: '2026-03-01', updatedAt: '2026-02-01' });
  const ids = (sort, filter = 'all') => nq.sortNotesForView([a, b, c], sort, filter, bm).map(n => n.id);
  assert.deepEqual(ids('recent'), ['a', 'c', 'b']);
  assert.deepEqual(ids('newest'), ['c', 'b', 'a']);
  assert.deepEqual(ids('reading'), ['c', 'b', 'a']);
  assert.deepEqual(ids('recent', 'to-spar'), ['a', 'b', 'c']);
  assert.ok(nq.matchesTagFilters(note('t', { tags: ['#A', '#b'] }), ['#a', '#b']));
  assert.ok(!nq.matchesTagFilters(note('t', { tags: ['#A'] }), ['#a', '#b']));
});

// ---- C2.2 activity ----------------------------------------------------------------------------

test('C2.2 buildActivityDays: 30-day window count, 4 levels by fraction OR pages, labels', () => {
  const books = [book({ id: 'p', totalPos: 500 }), book({ id: 'q', totalPos: 0 }), book({ id: 'pct', posUnit: 'percent', totalPos: 100 })];
  const s = (id, bookId, date, startPos, endPos) => ({ id, bookId, date, startPos, endPos, updatedAt: 'u', note: '' });
  const sessions = [
    s('1', 'p', '2026-11-18', 0, 5), // 1% & 5 pages → L1
    s('2', 'q', '2026-11-17', 0, 20), // 20 pages, no total → L2
    s('3', 'p', '2026-11-16', 0, 40), // 8% & 40 pages → L3
    s('4', 'pct', '2026-11-15', 10, 13), // 3% → L2
    s('5', 'p', '2026-10-01', 0, 10), // outside the window
  ];
  const days = bs.buildActivityDays(sessions, books, '2026-11-18');
  assert.equal(days.length, 30);
  assert.equal(days[29].date, '2026-11-18');
  assert.equal(days[0].date, '2026-10-20');
  assert.deepEqual(days.slice(26).map(d => d.level), [2, 3, 2, 1]);
  assert.equal(days[29].label, 'Wed, Nov 18: 1 session, 5 pages');
  assert.equal(days[26].label, 'Sun, Nov 15: 1 session, 3%');
  assert.equal(days[0].label, 'Tue, Oct 20: no reading logged');
  assert.equal(bs.activityCountLabel(days), '4 sessions in the last 30 days');
  assert.equal(bs.activityCountLabel(bs.buildActivityDays([], books, '2026-11-18')), 'No sessions in the last 30 days');
  assert.equal(bs.activityCountLabel(bs.buildActivityDays([sessions[0]], books, '2026-11-18')), '1 session in the last 30 days');
});

// ---- C2.3 sessions trail -----------------------------------------------------------------------

test('C2.3 bookSessionsNewestFirst + sessionDateLabel', () => {
  const s = (id, date, updatedAt, bookId = 'b1') => ({ id, bookId, date, startPos: 0, endPos: 1, updatedAt, note: '' });
  const list = [s('a', '2026-11-10', '1'), s('b', '2026-11-12', '1'), s('c', '2026-11-12', '2'), s('x', '2026-11-30', '9', 'b2')];
  assert.deepEqual(bs.bookSessionsNewestFirst(list, 'b1').map(x => x.id), ['c', 'b', 'a']);
  assert.equal(bs.sessionDateLabel('2026-11-14', '2026-11-18'), 'Nov 14');
  assert.equal(bs.sessionDateLabel('2025-11-14', '2026-11-18'), 'Nov 14, 2025');
});

// ---- C2.5 / C2.6 -------------------------------------------------------------------------------

test('C2.5 link chips: label host+path ≤ 32, www stripped; standalone links deduped vs attachments', () => {
  assert.equal(bs.linkChipLabel('https://www.fs.blog/mental-models/'), 'fs.blog/mental-models/');
  assert.equal(bs.linkChipLabel('https://example.com/'), 'example.com');
  assert.equal(bs.linkChipLabel('https://example.com/a/very/long/path/that/keeps/going'), 'example.com/a/very/long/path/th…');
  const n = note('n', {
    meta: {
      attachments: [{ id: 'l', type: 'link', title: 'x', url: 'https://a.dev/x' }],
      links: ['https://a.dev/x', 'https://b.dev', ' https://b.dev ', 'javascript:alert(1)', 7],
    },
  });
  assert.deepEqual(bs.standaloneNoteLinks(n), ['https://b.dev', 'javascript:alert(1)']);
});

test('C2.6 https-only covers; everFinished → no spoilers, predictions unlocked (Python parity)', () => {
  assert.equal(bs.safeCoverUrl(book({ meta: { updatedAt: 'u', coverUrl: 'https://img.dev/c.jpg' } })), 'https://img.dev/c.jpg');
  for (const bad of ['http://img.dev/c.jpg', 'javascript:x', 'data:image/png;base64,AA', '', 42]) {
    assert.equal(bs.safeCoverUrl(book({ meta: { updatedAt: 'u', coverUrl: bad } })), null, String(bad));
  }
  assert.equal(bs.coverUrlError(''), null);
  assert.equal(bs.coverUrlError('http://x.dev/a.png'), 'Use an https:// image link.');
  const fb = book({ kind: 'fiction', currentPos: 10, normalizedPos: 0.05 });
  const ahead = note('n', { pos: 150, meta: { attachments: [], links: [], isPrediction: true } });
  assert.equal(sm.isNoteSpoiler(ahead, fb), true);
  assert.equal(sm.isSealedPrediction(ahead, fb), true);
  const reread = { ...fb, meta: { ...fb.meta, everFinished: true } };
  assert.equal(sm.isEverFinished(reread), true);
  assert.equal(sm.isNoteSpoiler(ahead, reread), false);
  assert.equal(sm.isSealedPrediction(ahead, reread), false);
  assert.equal(sm.isUnlockedPrediction(ahead, reread), true);
  assert.equal(sm.isEverFinished({ ...fb, meta: { updatedAt: 'u', everFinished: 'true' } }), false, 'strict boolean');
});

// ---- CD 3 fix-up -------------------------------------------------------------------------

test('fix-up QA-36: Unicode-aware slugs; symbol-only link text is plain text, never resolves', () => {
  assert.equal(wl.slugify('Über Café'), 'uber-cafe');
  assert.equal(wl.slugify('日本 の 本'), '日本-の-本');
  assert.equal(wl.slugify('It’s 2²'), 'its-22');
  assert.equal(wl.slugifyOrNull('🔥'), null);
  assert.equal(wl.slugifyOrNull('!!!'), null);
  assert.equal(wl.slugify('!!!'), 'note', 'generateUniqueSlug fallback unchanged');
  assert.deepEqual(wl.tokenizeWikiText('a [[🔥]] b [[!!!]]'), [{ type: 'text', value: 'a [[🔥]] b [[!!!]]' }]);
  assert.deepEqual(wl.extractWikilinks('[[🔥]] [[日本]] [[Über]]'), ['日本', 'uber']);
  const n = note('note', { slug: 'note' });
  assert.equal(wl.resolveWikilinkTarget([n], '🔥'), undefined);
  assert.equal(wl.resolveWikilinkTarget([n], '!!!'), undefined);
});

test('fix-up QA-37: one regex — no newline or "[" inside — for chips and backlinks', () => {
  const r = new RegExp(wl.WIKILINK_SOURCE, 'g');
  assert.deepEqual([...'[[a]] [[b\nc]] [[d[e]] [[f]]'.matchAll(r)].map(m => m[1]), ['a', 'f']);
  const n = note('n', { takeaway: 'tail [[split', contextMechanism: 'link]] and [[ok]]' });
  assert.deepEqual(wl.extractNoteWikilinks(n), ['ok'], 'a link never spans two fields');
});

test('fix-up R2#1 resolveSlugEdit: explicit edits validated (format / collision); title-derived auto-suffix', () => {
  const taken = ['taken', 'old-alias'];
  const base = { title: 'My Title', originalSlug: 'orig', taken };
  assert.deepEqual(wl.resolveSlugEdit({ ...base, rawSlug: 'orig' }), { slug: 'orig', error: null });
  assert.deepEqual(wl.resolveSlugEdit({ ...base, rawSlug: 'fresh-one' }), { slug: 'fresh-one', error: null });
  assert.equal(wl.resolveSlugEdit({ ...base, rawSlug: 'Bad Slug' }).error, wl.SLUG_FORMAT_ERROR);
  assert.equal(wl.resolveSlugEdit({ ...base, rawSlug: '🔥' }).error, 'Use lowercase letters, numbers, and hyphens.');
  assert.equal(wl.resolveSlugEdit({ ...base, rawSlug: 'taken' }).error, 'Another note already uses [[taken]].');
  assert.equal(wl.resolveSlugEdit({ ...base, rawSlug: 'old-alias' }).error, 'Another note already uses [[old-alias]].');
  assert.deepEqual(wl.resolveSlugEdit({ ...base, rawSlug: '', title: 'Taken' }), { slug: 'taken-2', error: null });
  assert.equal(wl.normalizeSlugInput('  Hello World '), 'hello-world');
  assert.equal(wl.normalizeSlugInput('🔥'), '🔥');
  assert.equal(wl.isValidSlug('日本-2'), true);
});

// ---- CD 3 follow-up R2-a: legacy ASCII slug fallback ----------------------------------------

test('R2-a legacySlugify: old ASCII-only rule, used only as a resolution key', () => {
  assert.equal(wl.legacySlugify('Café culture'), 'caf-culture');
  assert.equal(wl.legacySlugify('日本'), null);
  assert.deepEqual(wl.wikilinkKeys('Café culture'), ['Café culture', 'cafe-culture', 'caf-culture']);
  assert.deepEqual(wl.extractWikilinks('[[Café culture]]'), ['cafe-culture'], 'extractor output unchanged');
});

test('R2-a resolveWikilinkTarget: exact → new slug → legacy slug → aliases', () => {
  const legacy = note('n-legacy', { slug: 'caf-culture' });
  assert.equal(wl.resolveWikilinkTarget([legacy], 'Café culture'), legacy);
  const fresh = note('n-new', { slug: 'cafe-culture' });
  assert.equal(wl.resolveWikilinkTarget([legacy, fresh], 'Café culture'), fresh, 'new slug wins');
  const aliased = note('n-alias', { slug: 'other', meta: { attachments: [], links: [], aliases: ['caf-culture'] } });
  assert.equal(wl.resolveWikilinkTarget([aliased, legacy], 'Café culture'), legacy, 'legacy slug beats alias');
  assert.equal(wl.resolveWikilinkTarget([aliased], 'Café culture'), aliased, 'legacy key matches aliases');
  // Inline chip: the tokenizer slug stays new-rule; WikiText resolves from the raw inner text.
  const [tok] = wl.tokenizeWikiText('[[Café culture]]');
  assert.equal(tok.slug, 'cafe-culture');
  assert.equal(wl.resolveWikilinkTarget([legacy], tok.raw.slice(2, -2)), legacy);
});

test('R2-a backlinks + hub keys: [[Café culture]] links to a note slugged caf-culture', () => {
  const legacy = note('n-legacy', { slug: 'caf-culture' });
  const linker = note('n-linker', { takeaway: 'see [[Café culture]]' });
  const other = note('n-other', { takeaway: 'see [[Cafeteria]]' });
  assert.deepEqual(wl.computeNoteBacklinks(legacy, [legacy, linker, other]).map(n => n.id), ['n-linker']);
  const keys = wl.extractNoteWikilinkKeys(linker);
  assert.ok(keys.has('caf-culture') && keys.has('cafe-culture'), 'Concepts hub detection sees both keys');
  assert.deepEqual(wl.extractNoteWikilinkTexts(linker), [{ slug: 'cafe-culture', text: 'Café culture' }]);
});
