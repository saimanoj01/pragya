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
 * CD Batch 2 — Practice & capture (pure helpers): same-day check-in coalescing + history
 * (C2.1), sparring prompt template / spoiler ceiling / shield guard (C4.1, C4.2), capture
 * book preselect + draft attachment schema + ⌘/Ctrl+Enter (C4.3), Kindle cleanup / unit
 * guard / citation-only percent (C4.4), Save & Next order (C4.5).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const ci = await load('src/utils/deltaCheckIn.ts');
const sh = await load('src/utils/takeawayShuffle.ts');
const sp = await load('src/utils/sparringPrompt.ts');
const cc = await load('src/utils/captureContext.ts');
const df = await load('src/utils/deepenFlow.ts');
const kp = await load('src/utils/kindlePaste.ts');
const kb = await load('src/utils/keyboard.ts');
const ds = await load('src/utils/draftStorage.ts');

const book = (o = {}) => ({
  id: 'b1', title: 'Thinking in Systems', author: 'Donella Meadows', format: 'physical', kind: 'nonfiction',
  status: 'reading', currentPos: 100, totalPos: 200, posUnit: 'page', normalizedPos: 0.5, docUrl: '',
  meta: { updatedAt: 'u' }, ...o,
});
const note = (id, o = {}) => ({
  id, slug: id, bookId: 'b1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', pos: 50,
  normalizedPos: 0.25, status: 'saved', source: 'app', tags: [], quote: '', takeaway: `takeaway ${id}`,
  contextMechanism: '', critique: '', deltaTrigger: '', deltaAction: '', deltaStatus: 'none',
  meta: { attachments: [], links: [] }, ...o,
});
const log = (id, noteId, date, outcome = 'applied', reflection = '') => ({ id, noteId, date, outcome, reflection });

// ---- C2.1 check-ins ---------------------------------------------------------------------

test('C2.1 planDeltaCheckIn: first of the day appends; later updates outcome (reflection kept); same outcome → unchanged', () => {
  const T = '2026-11-18';
  const a = ci.planDeltaCheckIn([log('old', 'n1', '2026-11-17', 'missed')], 'n1', T, 'applied', 'new-id');
  assert.equal(a.kind, 'append');
  assert.deepEqual(a.log, { id: 'new-id', noteId: 'n1', date: T, outcome: 'applied', reflection: '' });
  assert.equal(ci.checkInToastMessage(a), 'Logged: Applied.');

  const logs = [log('t1', 'n1', T, 'applied', 'felt good'), log('t2', 'n2', T, 'missed')];
  const u = ci.planDeltaCheckIn(logs, 'n1', T, 'no-trigger', 'x');
  assert.equal(u.kind, 'update');
  assert.deepEqual(u.log, { ...logs[0], outcome: 'no-trigger' }, 'same row id, reflection kept');
  assert.deepEqual(u.previous, logs[0]);
  assert.equal(ci.checkInToastMessage(u), "Updated today's check-in to Didn't come up.");

  const same = ci.planDeltaCheckIn(logs, 'n1', T, 'applied', 'x');
  assert.equal(same.kind, 'unchanged');
  assert.equal(ci.checkInToastMessage(same), null, 'pressing the logged outcome: no toast');

  assert.equal(ci.checkInToastMessage(ci.planDeltaCheckIn([], 'n9', T, 'missed', 'm')), 'Logged: Missed trigger.');
  assert.equal(ci.checkInToastMessage(ci.planDeltaCheckIn([], 'n9', T, 'no-trigger', 'm')), "Logged: Didn't come up.");
});

test('C2.1 todaysDeltaLog: legacy same-day duplicates → the LAST row is the one updated; timestamps keyed by LOCAL day (R1#4)', () => {
  const T = '2026-11-18';
  const logs = [log('d1', 'n1', T, 'applied'), log('d2', 'n1', T, 'missed')];
  assert.equal(ci.todaysDeltaLog(logs, 'n1', T).id, 'd2');
  assert.equal(ci.todaysDeltaLog(logs, 'n2', T), null);
  // A timestamp-shaped date belongs to its local day (toLocalDateKey), never its UTC prefix.
  const ts = '2026-11-18T23:30:00Z';
  const localDay = sh.toLocalDateKey(ts);
  assert.equal(ci.todaysDeltaLog([log('x', 'n1', ts)], 'n1', localDay).id, 'x');
  if (localDay !== '2026-11-18') assert.equal(ci.todaysDeltaLog([log('x', 'n1', ts)], 'n1', '2026-11-18'), null);
});

test('C2.1 fix-up: applyDeltaLogPatch changes only the edited field; History summary is counts only', () => {
  const fresh = log('t1', 'n1', '2026-11-18', 'applied', 'written by the CLI');
  assert.deepEqual(ci.applyDeltaLogPatch(fresh, { outcome: 'missed' }), { ...fresh, outcome: 'missed' });
  assert.deepEqual(ci.applyDeltaLogPatch(fresh, { reflection: '  mine  ' }), { ...fresh, reflection: 'mine' });
  assert.deepEqual(ci.applyDeltaLogPatch(fresh, {}), fresh);
  const logs = [log('a', 'n1', 'd', 'applied'), log('b', 'n1', 'd', 'missed'), log('c', 'n1', 'd', 'no-trigger'), log('z', 'n2', 'd')];
  assert.equal(ci.deltaHistorySummary(logs, 'n1'), 'History (3) · 1 applied · 1 missed');
  assert.ok(!ci.deltaHistorySummary(logs, 'n1').includes('%'));
});

test('C2.1 recentDeltaHistory: newest first, capped at 10, other notes excluded; no rates', () => {
  const logs = [];
  for (let i = 1; i <= 12; i += 1) logs.push(log(`l${i}`, 'n1', `2026-11-${String(i).padStart(2, '0')}`));
  logs.push(log('other', 'n2', '2026-11-30'));
  logs.push(log('l12b', 'n1', '2026-11-12', 'missed')); // same day, later row → first
  const h = ci.recentDeltaHistory(logs, 'n1');
  assert.equal(h.length, ci.DELTA_HISTORY_LIMIT);
  assert.deepEqual(h.slice(0, 3).map(x => x.id), ['l12b', 'l12', 'l11']);
  assert.ok(!h.some(x => x.noteId !== 'n1'));
  assert.deepEqual(ci.recentDeltaHistory(logs, 'n1', 2).map(x => x.id), ['l12b', 'l12']);
  assert.equal(ci.DELTA_REFLECTION_PLACEHOLDERS.missed, 'What got in the way? (optional)');
});

// ---- C4.1 / C4.2 sparring prompt -------------------------------------------------------

test('C4.1 buildSparringPrompt: exact non-fiction template (quote, chapter·pos, prior questions, WHEN→DO habit)', () => {
  const n = note('n1', {
    quote: 'Delays cause oscillation.',
    takeaway: 'Wait out the lag.',
    pos: 42,
    meta: { attachments: [], links: [], chapter: '3', socraticQuestions: ['Where does it fail?', 'Why now?'] },
  });
  assert.equal(
    sp.buildSparringPrompt(n, book()),
    [
      'Help me think through a note from "Thinking in Systems" by Donella Meadows (Non-fiction), from Ch. 3 · p. 42 in my reading.',
      '',
      'Quote: "Delays cause oscillation."',
      'My takeaway: Wait out the lag.',
      "Questions I've already been asked: Where does it fail? / Why now?",
      '',
      "Ask me 2 short Socratic questions that test this idea — where it would fail, and where I could actually use it. Then wait for my answers. Don't summarize the book or answer for me.",
      'When we\'re done, help me phrase it as: a one-line takeaway, how it works, where it breaks, and one "WHEN … → DO …" habit.',
    ].join('\n')
  );
});

test('C4.1 fiction: spoiler ceiling at the bookmark while unfinished; conditional lines omitted; finished → no ceiling', () => {
  const fb = book({ kind: 'fiction', title: 'Piranesi', author: 'Susanna Clarke', currentPos: 120 });
  const n = note('n1', { takeaway: 'The House is kind.', pos: 80 });
  const prompt = sp.buildSparringPrompt(n, fb);
  assert.equal(
    prompt,
    [
      'Help me think through a note from "Piranesi" by Susanna Clarke (Fiction), from p. 80 in my reading.',
      '',
      'My takeaway: The House is kind.',
      '',
      "Ask me 2 short Socratic questions that test this idea — what the author is doing here, and why it landed for me. Then wait for my answers. Don't summarize the book or answer for me.",
      "I'm only at p. 120. Don't mention anything that happens after that point.",
      "When we're done, help me phrase it as: a one-line takeaway, how it works, where it breaks.",
    ].join('\n')
  );
  assert.ok(!prompt.includes('Quote:') && !prompt.includes('already been asked'));
  const done = sp.buildSparringPrompt(n, { ...fb, status: 'finished', currentPos: 300 });
  assert.ok(!done.includes("I'm only at"));
});

test('C4.1 shield guard: a note ahead of the bookmark never yields a prompt unless revealed; no book → null; atomic hides the button', () => {
  const fb = book({ kind: 'fiction', currentPos: 50, normalizedPos: 0.25 });
  const ahead = note('n1', { pos: 90, takeaway: 'SECRET ENDING' });
  assert.equal(sp.buildSparringPrompt(ahead, fb), null);
  assert.ok(sp.buildSparringPrompt(ahead, fb, { revealed: true }).includes('SECRET ENDING'));
  assert.equal(sp.buildSparringPrompt(ahead, null), null);
  assert.equal(sp.canCopySparringPrompt(note('a', { status: 'atomic' })), false);
  for (const st of ['saved', 'inbox', 'in-reflection']) assert.equal(sp.canCopySparringPrompt(note('a', { status: st })), true);
  assert.equal(sp.SPARRING_COPY_SUCCESS_MESSAGE, 'Sparring prompt copied. Paste it into your assistant.');
});

test('C4.1 fix-up: quote-only note → no "My takeaway:" line, "about this passage" ask (R2#3); revealed note ahead of the bookmark → ceiling = note pos (R1 nit 5)', () => {
  const nf = sp.buildSparringPrompt(note('q', { quote: 'Stocks change slowly.', takeaway: '' }), book());
  assert.ok(!nf.includes('My takeaway:'));
  assert.ok(nf.includes('Ask me 2 short Socratic questions about this passage — '));
  const fb = book({ kind: 'fiction', currentPos: 50, normalizedPos: 0.25 });
  const ahead = note('a', { pos: 90 });
  const revealed = sp.buildSparringPrompt(ahead, fb, { revealed: true });
  assert.ok(revealed.includes("I'm only at p. 90. Don't mention anything that happens after that point."));
  assert.ok(!revealed.includes('p. 50.'));
  const behind = sp.buildSparringPrompt(note('b', { pos: 20 }), fb);
  assert.ok(behind.includes("I'm only at p. 50."));
});

test('C4.2 unlocked prediction → "how did my prediction compare" variant (includes the recorded outcome)', () => {
  const fb = book({ kind: 'fiction', status: 'finished', title: 'Piranesi', author: 'Susanna Clarke' });
  const n = note('p1', {
    takeaway: 'The Other is lying.',
    meta: { attachments: [], links: [], isPrediction: true, predictionOutcome: { text: 'He was.', at: 'x' } },
  });
  const prompt = sp.buildSparringPrompt(n, fb);
  assert.ok(prompt.startsWith('Help me reflect on a prediction I made while reading "Piranesi" by Susanna Clarke (Fiction), at p. 50.'));
  assert.ok(prompt.includes('My prediction: The Other is lying.'));
  assert.ok(prompt.includes('What actually happened, in my words: He was.'));
  assert.ok(prompt.includes('how my prediction compared'));
});

// ---- C4.3 capture ----------------------------------------------------------------------

test('C4.3 resolveCaptureBookId: book page → that book; note page (slug or uuid) → its book; archived / other routes → null', () => {
  const books = [book(), book({ id: 'b2' }), book({ id: 'b-arch', meta: { archivedAt: '2026-01-01T00:00:00Z' } })];
  const notes = [note('n1', { slug: 'my-note', bookId: 'b2' }), note('n-arch', { bookId: 'b-arch' })];
  assert.equal(cc.resolveCaptureBookId({ view: 'book', bookId: 'b1' }, notes, books), 'b1');
  assert.equal(cc.resolveCaptureBookId({ view: 'note', noteSlug: 'my-note' }, notes, books), 'b2');
  assert.equal(cc.resolveCaptureBookId({ view: 'note', noteSlug: 'n1' }, notes, books), 'b2');
  assert.equal(cc.resolveCaptureBookId({ view: 'note', noteSlug: 'missing' }, notes, books), null);
  assert.equal(cc.resolveCaptureBookId({ view: 'book', bookId: 'b-arch' }, notes, books), null);
  assert.equal(cc.resolveCaptureBookId({ view: 'note', noteSlug: 'n-arch' }, notes, books), null);
  assert.equal(cc.resolveCaptureBookId({ view: 'book', bookId: 'gone' }, notes, books), null);
  for (const view of ['shelf', 'notes', 'practice', 'settings']) {
    assert.equal(cc.resolveCaptureBookId({ view }, notes, books), null);
  }
});

test('C4.3 draftAttachments: refs only, junk dropped, max 3; older drafts (no field) → []', () => {
  const img = { id: 'i1', type: 'image', driveFileId: 'f1', fileName: 'a.webp', mimeType: 'image/webp', width: 10 };
  const demoImg = { id: 'i2', type: 'image', demoMediaId: 'm1', fileName: 'b.webp', mimeType: 'image/webp' };
  const link = { id: 'l1', type: 'link', title: 'x', url: 'https://x.dev' };
  const doc = { id: 'd1', type: 'doc', title: 'Doc', url: 'https://docs.google.com/document/d/abc', docId: 'abc' };
  const junk = [null, 'str', { id: 'n', type: 'image', fileName: 'c', mimeType: 'image/png' }, { type: 'link', url: 'u', title: 't' }];
  assert.deepEqual(ds.draftAttachments({ attachments: [...junk, img, demoImg, link, doc] }), [img, demoImg, link]);
  assert.deepEqual(ds.draftAttachments({}), []);
  assert.deepEqual(ds.draftAttachments(null), []);
});

test('C4.3 isSubmitShortcut: ⌘/Ctrl+Enter only; never during IME composition', () => {
  const e = o => ({ key: 'Enter', metaKey: false, ctrlKey: false, ...o });
  assert.equal(kb.isSubmitShortcut(e({ metaKey: true })), true);
  assert.equal(kb.isSubmitShortcut(e({ ctrlKey: true })), true);
  assert.equal(kb.isSubmitShortcut(e({})), false);
  assert.equal(kb.isSubmitShortcut(e({ metaKey: true, isComposing: true })), false);
  assert.equal(kb.isSubmitShortcut(e({ ctrlKey: true, keyCode: 229 })), false);
  assert.equal(kb.isSubmitShortcut(e({ metaKey: true, altKey: true })), false);
  assert.equal(kb.isSubmitShortcut({ key: 'a', metaKey: true, ctrlKey: false }), false);
  assert.equal(kb.submitShortcutModifierLabel('MacIntel'), '⌘');
  assert.equal(kb.submitShortcutModifierLabel('Win32'), 'Ctrl');
});

// ---- C4.4 Kindle -----------------------------------------------------------------------

test('C4.4 stripKindleBoilerplate: table of real Kindle exports → clean quote only', () => {
  const cases = [
    [
      'Your Highlight on page 84 | Location 1423-1425 | Added on Sunday, November 16, 2026 9:12:04 PM\n\nDelays in feedback loops cause oscillations.',
      'Delays in feedback loops cause oscillations.',
    ],
    [
      'Thinking in Systems (Donella H. Meadows)\n- Your Highlight on Location 1423-1425 | Added on Sunday, 16 November 2026 21:12:04\n\nA system is more than the sum of its parts.\n==========',
      'Thinking in Systems (Donella H. Meadows)\n\nA system is more than the sum of its parts.',
    ],
    ['Highlight (yellow) - Page 12 · Location 180\n“Stocks change slowly.”', 'Stocks change slowly.'],
    ['"Stocks change slowly." — Donella H. Meadows, Thinking in Systems (Kindle Edition)', 'Stocks change slowly.'],
    ['Notes From: Thinking in Systems\nNote on Location 200 | Added on Monday\nBuffers stabilise.', 'Buffers stabilise.'],
    ['Highlight on Page 84 | Location 1280 | 42%\nResilience has limits.', 'Resilience has limits.'],
  ];
  for (const [raw, clean] of cases) {
    assert.deepEqual(kp.stripKindleBoilerplate(raw), { text: clean, cleaned: true }, raw);
  }
});

test('C4.4 stripKindleBoilerplate: prose untouched (no false cleanups); boilerplate-only paste kept raw', () => {
  for (const prose of [
    'Revenue grew 40% faster than expected.',
    'Page after page, the house kept its secrets.',
    'Location, location, location — the oldest rule in real estate.',
    'Added on top of that, the delay compounds.',
  ]) {
    assert.deepEqual(kp.stripKindleBoilerplate(prose), { text: prose, cleaned: false }, prose);
  }
  const only = 'Your Highlight on Location 10 | Added on Monday';
  assert.deepEqual(kp.stripKindleBoilerplate(only), { text: only, cleaned: false });
});

test('C4.4 percent only from citation lines; unit guard picks the book unit or reports a mismatch', () => {
  assert.equal(kp.pickCitationHint('Revenue grew 40% faster than expected.', 'percent'), null);
  assert.equal(kp.pickCitationHint('It was 62% done', 'percent'), null);
  assert.deepEqual(kp.pickCitationHint('Highlight on Page 84 | Location 1280 | 42%', 'percent'), {
    kind: 'match',
    hint: { pos: 42, unitHint: 'percent', label: '42%' },
  });
  assert.deepEqual(kp.pickCitationHint('62%\nSome quote', 'percent'), {
    kind: 'match',
    hint: { pos: 62, unitHint: 'percent', label: '62%' },
  });
  // Both Location and Page: prefer the book's unit.
  assert.equal(kp.pickCitationHint('Your Highlight on page 84 | Location 1423-1425', 'page').hint.pos, 84);
  assert.equal(kp.pickCitationHint('Your Highlight on page 84 | Location 1423-1425', 'loc').hint.pos, 1423);
  // Location on a page-tracked book → mismatch, no Apply.
  const mm = kp.pickCitationHint('Your Highlight on Location 1423-1425 | Added on Nov 16', 'page');
  assert.deepEqual(mm, { kind: 'mismatch', hint: { pos: 1423, unitHint: 'loc', label: 'Location 1423' } });
  assert.equal(kp.kindleUnitMismatchCopy(mm.hint, 'page'), 'Detected Location 1423 — this book tracks pages.');
  assert.equal(
    kp.kindleUnitMismatchCopy({ pos: 84, unitHint: 'page', label: 'Page 84' }, 'loc'),
    'Detected Page 84 — this book tracks Kindle locations.'
  );
  assert.equal(kp.pickCitationHint('no numbers', 'page'), null);
});

// ---- C4.5 Save & Next ------------------------------------------------------------------

test('C4.5 nextInboxNote: To Spar order (oldest createdAt first), skips current / atomic / archived / shielded', () => {
  const books = [book(), book({ id: 'fic', kind: 'fiction', currentPos: 10, normalizedPos: 0.05 })];
  const notes = [
    note('cur', { status: 'inbox', createdAt: '2026-01-01T00:00:00Z' }),
    note('newer', { status: 'in-reflection', createdAt: '2026-03-01T00:00:00Z' }),
    note('older', { status: 'inbox', createdAt: '2026-02-01T00:00:00Z' }),
    note('atomic', { status: 'atomic', createdAt: '2025-01-01T00:00:00Z' }),
    note('arch', { status: 'inbox', createdAt: '2025-01-02T00:00:00Z', meta: { attachments: [], links: [], archivedAt: 'x' } }),
    note('shield', { status: 'inbox', bookId: 'fic', pos: 99, createdAt: '2025-01-03T00:00:00Z' }),
  ];
  assert.equal(df.nextInboxNote(notes, books, 'cur').id, 'older');
  assert.equal(df.nextInboxNote(notes, books, 'older').id, 'cur');
  assert.equal(df.nextInboxNote(notes.filter(n => n.id !== 'older' && n.id !== 'newer'), books, 'cur'), null);
  assert.equal(df.SAVE_NEXT_DONE_MESSAGE, "That's everything you'd marked to spar.");
});
