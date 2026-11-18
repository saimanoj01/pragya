import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { spawnSync } from 'node:child_process';
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
          if (fs.existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

/**
 * QA (CD Batch 3) — adversarial probes: WikiText tokenizer vs backlink extraction,
 * non-ASCII link collapse, alias rules TS ⇄ Python, spoiler-safe search incl. aliases,
 * cover-URL scheme guard, everFinished parity, activity window boundaries.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const wl = await load('src/utils/wikilinks.ts');
const nq = await load('src/utils/notesQuery.ts');
const bs = await load('src/utils/bookSurfaces.ts');
const sm = await load('src/utils/spoilerMath.ts');
const { resolveNoteRef } = await load('src/utils/noteVisibility.ts');

const book = (o = {}) => ({
  id: 'b1', title: 'Exhalation', author: 'Ted Chiang', format: 'physical', kind: 'fiction', status: 'reading',
  currentPos: 100, totalPos: 300, posUnit: 'page', normalizedPos: 100 / 300, docUrl: '', meta: {}, ...o,
});
const note = (id, o = {}) => ({
  id, slug: id, bookId: 'b1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', pos: 10,
  normalizedPos: 10 / 300, status: 'saved', source: 'app', tags: [], quote: '', takeaway: '', contextMechanism: '',
  critique: '', deltaTrigger: '', deltaAction: '', deltaStatus: 'none', meta: {}, ...o,
});

function py(code, input) {
  const r = spawnSync('python3', ['-c', `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("cli", "scripts/pragya_cli.py")
cli = importlib.util.module_from_spec(spec); sys.modules["cli"] = cli; spec.loader.exec_module(cli)
d = json.load(sys.stdin)
${code}
`], { cwd: repoRoot, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('QA CD3: tokenizer edge cases — nested/unclosed/multi-line/code-like/emoji', () => {
  const links = s => wl.tokenizeWikiText(s).filter(t => t.type === 'link').map(t => t.slug);
  const text = s => wl.tokenizeWikiText(s).map(t => (t.type === 'link' ? t.raw : t.value)).join('');
  const cases = ['[[a', 'a]]', '[[]]', '[[ ]]', '[[a]b]]', '[[a\nb]]', '[[[a]]]', '[[a]][[b]]', 'x [[A B]] y', 'arr[[0]]', '[[a]] [[a]]'];
  for (const s of cases) assert.equal(text(s), s, `lossless: ${JSON.stringify(s)}`);
  assert.deepEqual(links('[[a'), []);
  assert.deepEqual(links('[[]]'), []);
  assert.deepEqual(links('[[ ]]'), []);
  assert.deepEqual(links('[[a]b]]'), []);
  assert.deepEqual(links('[[a\nb]]'), []);
  assert.deepEqual(links('[[a]][[b]]'), ['a', 'b']);
  assert.deepEqual(links('[[[a]]]'), ['a'], 'triple brackets: inner link, outer brackets stay text');
  assert.deepEqual(links('arr[[0]]'), ['0'], 'Info: code-like text becomes a chip');
});

// CD 3 fix-up: QA-37 fixed (shared WIKILINK_SOURCE) — converted from `todo`.
test('QA-37: chips and backlinks agree (tokenizeWikiText vs extractNoteWikilinks)', () => {
  const samples = ['[[a]] and [[B c]]', '[[x]b]]', '[[[deep]]]', '[[one]][[two]]', '[[ spaced ]]', 'multi [[li\nne]]', '[[a[b]]'];
  for (const s of samples) {
    const chips = [...new Set(wl.tokenizeWikiText(s).filter(t => t.type === 'link').map(t => t.slug))].sort();
    const back = [...new Set(wl.extractNoteWikilinks(note('n', { takeaway: s })))].sort();
    assert.deepEqual(back, chips, JSON.stringify(s));
  }
});

// CD 3 fix-up: QA-36 fixed (Unicode-aware slugifyOrNull) — converted from `todo`.
test('QA-36: non-ASCII-only / symbol-only link text must not collapse onto the generic "note" slug', () => {
  for (const s of ['[[🔥]]', '[[日本]]', '[[!!!]]']) {
    const tok = wl.tokenizeWikiText(s).find(t => t.type === 'link');
    assert.notEqual(tok?.slug, 'note', s);
  }
});

test('QA CD3: alias add/cap/dedupe and taken-slug rules — TS ⇄ Python parity', () => {
  const seqs = [
    [[], 'a', 'b'], [['a'], 'b', 'c'], [['a', 'b'], 'c', 'a'], [['A B', 'a-b', ' '], 'x', 'y'],
    [Array.from({ length: 12 }, (_, i) => `s${i}`), 'old', 'new'], [['x'], 'same', 'same'], ['junk', 'o', 'n'], [[1, null, 'ok'], 'o', 'n'],
  ];
  const ts = seqs.map(([al, o, n]) => wl.addSlugAlias(al, o, n));
  const pyOut = py(`print(json.dumps([cli.add_slug_alias(a, o, n) for a, o, n in d]))`, seqs);
  assert.deepEqual(pyOut, ts);
  assert.equal(ts[4].length, 10);
  assert.deepEqual(ts[2], ['b', 'c'], 'renaming back to an alias removes it');

  const notes = [note('n1', { slug: 'cur', meta: { aliases: ['old-one'] } }), note('n2', { slug: 'other' })];
  assert.deepEqual(wl.takenSlugs(notes, 'n2').sort(), py(`print(json.dumps(sorted(cli.taken_slugs(d, "n2"))))`, notes));
  assert.ok(!wl.takenSlugs(notes, 'n1').includes('old-one'), 'a note may reclaim its own alias');
});

test('QA CD3: resolution — slug beats alias; alias resolves; TS route/chip ⇄ Python resolve_note', () => {
  const notes = [
    note('n-alias', { slug: 'renamed', meta: { aliases: ['shared', 'old-name'] } }),
    note('n-slug', { slug: 'shared' }), // imported/CLI collision: slug wins
    note('n-two', { slug: 'two', meta: { aliases: ['old-name'] } }), // alias in two notes → first wins
  ];
  const refs = ['shared', 'old-name', 'renamed', 'n-two'];
  const ts = refs.map(r => resolveNoteRef(notes, r)?.id ?? null);
  const chips = refs.map(r => wl.resolveWikilinkTarget(notes, r)?.id ?? null);
  const pyIds = py(`
out = []
for r in d["refs"]:
    try: out.append(cli.resolve_note(d["notes"], r)["id"])
    except cli.CliError: out.append(None)
print(json.dumps(out))`, { notes, refs });
  assert.deepEqual(ts, ['n-slug', 'n-alias', 'n-alias', 'n-two']);
  assert.deepEqual(pyIds, ts);
  assert.deepEqual(chips.slice(0, 3), ts.slice(0, 3));
});

test('QA CD3: search — AND, accents both ways, #tag exact, phrase, unclosed quote, shield incl. aliases', () => {
  const b = book();
  const visible = note('v', { takeaway: 'Café culture and feedback loops', tags: ['#systems'], meta: { aliases: ['old-cafe-slug'] } });
  const shielded = note('s', { pos: 250, normalizedPos: 250 / 300, takeaway: 'the twist ending', tags: ['#plot'], meta: { aliases: ['secret-ending-alias'] }, deltaTrigger: 'hidden-trigger' });
  const m = (n, q, revealed = false) => nq.matchesNoteQuery(n, b, q, { revealed });
  assert.ok(m(visible, 'cafe loops'));
  assert.ok(m(visible, 'CAFÉ'));
  assert.ok(!m(visible, 'cafe missingword'), 'AND');
  assert.ok(m(visible, '#systems'));
  assert.ok(!m(visible, '#system'), '#tag is exact, not prefix');
  assert.ok(m(visible, '"feedback loops"'));
  assert.ok(!m(visible, '"loops feedback"'));
  assert.ok(m(visible, 'old-cafe-slug'), 'visible alias searchable');
  assert.ok(!m(visible, '"feedback'), 'Info: an unclosed quote is a literal token (no match)');
  // Shield: aliases, takeaway and delta text never match while unrevealed.
  for (const q of ['secret-ending-alias', 'secret', 'twist', 'hidden-trigger']) assert.ok(!m(shielded, q), `shielded leak via "${q}"`);
  assert.ok(m(shielded, '#plot'), 'tags are exposed by design');
  assert.ok(m(shielded, 'chiang'), 'book author is exposed by design');
  assert.ok(m(shielded, 'secret-ending-alias', true), 'revealed → alias searchable');
});

test('QA CD3: cover URL — https only; javascript:/data:/http:/protocol-relative/garbage rejected', () => {
  const ok = ['https://img.example/c.jpg', 'HTTPS://IMG.EXAMPLE/C.JPG', '  https://x.example/a.png  '];
  const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:image/png;base64,AAAA', 'http://x.example/a.png', '//x.example/a.png', 'https://', 'https:\\\\evil', 'ftp://x/a', 'blob:https://x/1', ' javascript:https://x'];
  for (const u of ok) assert.ok(bs.safeCoverUrl({ meta: { coverUrl: u } }), u);
  for (const u of bad) {
    assert.equal(bs.safeCoverUrl({ meta: { coverUrl: u } }), null, u);
    assert.equal(bs.coverUrlError(u), 'Use an https:// image link.', u);
  }
  assert.equal(bs.coverUrlError(''), null);
  assert.equal(bs.safeCoverUrl({ meta: { coverUrl: 42 } }), null);
});

test('QA CD3: everFinished → no spoilers / sealed off / unlocked on — TS ⇄ Python parity', () => {
  const books = [
    book(), book({ meta: { everFinished: true } }), book({ meta: { everFinished: 'true' } }), book({ meta: { everFinished: 1 } }),
    book({ status: 'finished' }), book({ kind: 'nonfiction', meta: { everFinished: true } }),
  ];
  const ahead = note('a', { pos: 250, normalizedPos: 250 / 300, meta: { isPrediction: true } });
  const ts = books.map(b => [sm.isNoteSpoiler(ahead, b), sm.isSealedPrediction(ahead, b), sm.isUnlockedPrediction(ahead, b)]);
  const pyOut = py(`print(json.dumps([[cli.is_note_spoiler(d["n"], b), cli.is_sealed_prediction(d["n"], b), cli.is_unlocked_prediction(d["n"], b)] for b in d["books"]]))`, { n: ahead, books });
  assert.deepEqual(pyOut, ts);
  assert.deepEqual(ts[1], [false, false, true]);
  assert.deepEqual(ts[2], ts[0], 'only boolean true counts');
});

test('QA CD3: activity — 30-day window boundaries, timestamp sessions bucket by local day, levels', () => {
  const books = [book({ id: 'bp', totalPos: 300, posUnit: 'page' }), book({ id: 'bpc', posUnit: 'percent', totalPos: 100 })];
  const s = (date, start, end, bookId = 'bp') => ({ id: `${date}-${start}`, bookId, date, startPos: start, endPos: end, updatedAt: 'u', note: '' });
  const days = bs.buildActivityDays(
    [s('2026-11-18', 0, 5), s('2026-10-20', 0, 50), s('2026-10-19', 0, 50), s('2026-11-17', 0, 40), s('2026-11-16', 0, 3, 'bpc'), s('2026-11-15', 10, 5)],
    books,
    '2026-11-18'
  );
  assert.equal(days.length, 30);
  assert.equal(days[0].date, '2026-10-20');
  assert.equal(days[29].date, '2026-11-18');
  assert.equal(days[0].count, 1, '29 days ago is inside the window');
  assert.equal(bs.activityCountLabel(days), '5 sessions in the last 30 days', '30 days ago (10-19) excluded');
  assert.equal(days.find(d => d.date === '2026-11-17').level, 3, '40 pages → level 3');
  assert.equal(days.find(d => d.date === '2026-11-18').level, 1, '5 pages of 300 → level 1');
  assert.equal(days.find(d => d.date === '2026-11-16').level, 2, '3% → fraction .03 → level 2');
  const back = days.find(d => d.date === '2026-11-15');
  assert.equal(back.count, 1);
  assert.equal(back.level, 1, 'negative delta clamps to 0 → still a session dot');
});

// ---- CD 3 fix-up re-verify --------------------------------------------------------------

test('QA CD3 re-verify: Unicode slugOrNull TS ⇄ Python parity (mixed scripts, combining marks, case quirks)', () => {
  const inputs = [
    'Über Café', 'naïve résumé', '日本 語', 'Ελληνικά ΟΔΟΣ', 'İstanbul', 'Straße', 'ﬁnancial', '２０２６ Ｆｕｌｌ',
    'हिन्दी नोट', 'مرحبا بالعالم', 'e\u0301cole', 'Mix 日本 and Ελλάδα', '🔥', '!!!', '👩‍💻 dev', "O'Brien’s", '²³', ' -- ', 'a\u200bb', 'Ⅻ roman',
  ];
  const ts = inputs.map(s => wl.slugifyOrNull(s));
  const pyOut = py(`print(json.dumps([cli.slugify_or_none(s) for s in d]))`, inputs);
  assert.deepEqual(pyOut, ts);
  assert.equal(wl.slugifyOrNull('🔥'), null);
  assert.equal(wl.slugifyOrNull('!!!'), null);
  assert.equal(wl.slugifyOrNull('Über Café'), 'uber-cafe');
  assert.equal(wl.slugifyOrNull('e\u0301cole'), 'ecole', 'combining acute dropped');
});

test('QA CD3 re-verify: symbol-only links never resolve, even when a note slugged "note" exists', () => {
  const notes = [note('generic', { slug: 'note' }), note('n2', { slug: 'note-2' })];
  for (const s of ['🔥', '!!!', '  ', '👩‍💻']) assert.equal(wl.resolveWikilinkTarget(notes, s), undefined, s);
  assert.deepEqual(wl.tokenizeWikiText('[[🔥]] [[!!!]]').filter(t => t.type === 'link'), []);
  assert.deepEqual(wl.extractNoteWikilinks(note('x', { takeaway: '[[🔥]] and [[!!!]]' })), []);
});

test('QA CD3 re-verify: shared regex — no link spans two fields; TS ⇄ Python extractor parity', () => {
  const n = note('x', { takeaway: 'ends with [[half', contextMechanism: 'other]] start', critique: '[[ok one]] [[a\nb]] [[c[d]]', quote: '[[Über]]' });
  const ts = wl.extractNoteWikilinks(n);
  assert.deepEqual(ts, ['ok-one', 'uber']);
  const pyOut = py(`print(json.dumps(cli.extract_wikilinks("\\n".join([d["takeaway"], d["contextMechanism"], d["critique"], d["quote"]]))))`, n);
  assert.deepEqual(pyOut, ts);
});

// CD 3 follow-up: QA-38 fixed (legacy ASCII slug fallback) — converted from `todo`.
test('QA-38: links written before the Unicode slug change still resolve to their (legacy ASCII) stored slug', () => {
  // Stored slug generated by the pre-fix ASCII slugify for the title "Café Culture".
  const target = note('t', { slug: 'caf-culture' });
  const linker = note('l', { takeaway: 'See [[Café Culture]].' });
  assert.equal(wl.resolveWikilinkTarget([target, linker], 'Café Culture')?.id, 't');
  assert.deepEqual(wl.computeNoteBacklinks(target, [target, linker]).map(x => x.id), ['l']);
});

test('QA CD3 re-verify: slug edit validation copy + rules', () => {
  assert.equal(wl.SLUG_FORMAT_ERROR, 'Use lowercase letters, numbers, and hyphens.');
  assert.ok(typeof wl.isValidSlug === 'function' && typeof wl.normalizeSlugInput === 'function');
  assert.equal(wl.isValidSlug('good-slug-2'), true);
  for (const bad of ['Bad Slug', 'UPPER', 'a--b-', '-lead', 'with space', 'emoji🔥', '']) assert.equal(wl.isValidSlug(bad), false, bad);
  assert.equal(wl.normalizeSlugInput('  My New  Slug '), 'my-new-slug');
});
