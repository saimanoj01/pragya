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
 * M6 Batch 7 — PWA chapter & capstone helpers (pure logic; no DOM, no network).
 * The chapter table mirrors QA's pinned Python table for format_chapter_badge.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const {
  formatChapterLabel,
  formatChapterPos,
  formatChapterBadge,
  normalizeChapterInput,
  withChapterKey,
  resolveCaptureChapter,
  deepenChapterSuggestion,
  computeChapterDividers,
  chapterDividerLabel,
  CHAPTER_MAX_LENGTH,
} = await load('src/utils/chapterFormat.ts');
const {
  CAPSTONE_HIDDEN_KEY,
  CAPSTONE_PROMPT_MAX_NOTES,
  buildCapstonePrompt,
  buildCapstoneForSave,
  capstoneNoteLabel,
  countCapstoneEligibleNotes,
  formatOmittedLine,
  isIsoTimestamp,
  getFilledCapstone,
  hideCapstonePromptForBook,
  parseCapstoneReply,
  parseLearningsInput,
  readHiddenCapstoneBooks,
  selectCapstoneNotes,
  truncateCapstoneText,
} = await load('src/utils/capstonePrompt.ts');
const { findOverriddenMetaKeys, metaValuesEqual, CAPSTONE_OWNED_META_KEYS, BOOK_DETAIL_CHAPTER_OWNED_META_KEYS } =
  await load('src/utils/metaCodecs.ts');

function makeBook(over = {}) {
  return {
    id: 'b1',
    title: 'Thinking in Systems',
    author: 'Donella Meadows',
    format: 'physical',
    kind: 'nonfiction',
    status: 'finished',
    posUnit: 'page',
    totalPos: 300,
    currentPos: 300,
    normalizedPos: 1,
    docUrl: '',
    meta: {},
    ...over,
  };
}

let seq = 0;
function makeNote(over = {}) {
  seq += 1;
  return {
    id: `n${seq}`,
    bookId: 'b1',
    slug: `note-${seq}`,
    pos: 10,
    normalizedPos: 0,
    status: 'saved',
    quote: '',
    takeaway: `Takeaway ${seq}`,
    tags: [],
    contextMechanism: '',
    critique: '',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none',
    source: 'pwa',
    createdAt: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    meta: {},
    ...over,
  };
}

test('formatChapterBadge matches the pinned Python table (QA-17)', () => {
  const rows = [
    [['3', 42, 'page'], '[Ch. 3 · p. 42]'],
    [['03', 42, 'page'], '[Ch. 03 · p. 42]'],
    [[3, 42, 'page'], '[Ch. 3 · p. 42]'],
    [['3.5', 1, 'page'], '[3.5 · p. 1]'],
    [['Chapter 3', 1, 'page'], '[Chapter 3 · p. 1]'],
    [['Run', 10, 'percent'], '[Run · 10%]'],
    [['  ', 10, 'percent'], '[10%]'],
    [[null, 0, 'page'], '[p. 0]'],
    [[true, 5, 'page'], '[p. 5]'],
    [['३', 4, 'page'], '[३ · p. 4]'],
    [['３', 4, 'page'], '[３ · p. 4]'],
    [['Ch. 3: Run', 1203, 'loc'], '[Ch. 3: Run · loc 1203]'],
  ];
  for (const [[ch, pos, unit], expected] of rows) {
    assert.equal(formatChapterBadge(ch, pos, unit), expected, JSON.stringify(ch));
  }
});

test('formatChapterPos is unbracketed; formatChapterLabel uses ASCII digits only', () => {
  assert.equal(formatChapterPos('3', 42, 'page'), 'Ch. 3 · p. 42');
  assert.equal(formatChapterPos(undefined, 42, 'page'), 'p. 42');
  assert.equal(formatChapterLabel(' 12 '), 'Ch. 12');
  assert.equal(formatChapterLabel('३'), '३');
  assert.equal(formatChapterLabel(''), '');
});

test('normalizeChapterInput / withChapterKey trim, cap at 80 and delete empty keys', () => {
  assert.equal(normalizeChapterInput('   '), undefined);
  assert.equal(normalizeChapterInput('x'.repeat(100)).length, CHAPTER_MAX_LENGTH);
  const meta = { title: 'T', chapter: 'Old', extra: { a: 1 } };
  assert.deepEqual(withChapterKey(meta, 'chapter', '  New '), { title: 'T', chapter: 'New', extra: { a: 1 } });
  const cleared = withChapterKey(meta, 'chapter', '');
  assert.equal('chapter' in cleared, false);
  assert.deepEqual(cleared.extra, { a: 1 });
  assert.equal(meta.chapter, 'Old', 'input not mutated');
  assert.equal(withChapterKey({}, 'currentChapter', 'Ch. 4').currentChapter, 'Ch. 4');
});

test('resolveCaptureChapter inherits only at the bookmark until touched', () => {
  const base = { bookChapter: 'Ch. 3: Run', currentPos: 42, touched: false, value: '' };
  assert.deepEqual(resolveCaptureChapter({ ...base, pos: 42 }), { value: 'Ch. 3: Run', hint: 'inherited' });
  assert.deepEqual(resolveCaptureChapter({ ...base, pos: null }), { value: 'Ch. 3: Run', hint: 'inherited' });
  assert.deepEqual(resolveCaptureChapter({ ...base, pos: 50 }), { value: '', hint: 'not-applied' });
  assert.deepEqual(resolveCaptureChapter({ ...base, bookChapter: '  ', pos: 42 }), { value: '', hint: null });
  // R1 nit: the typed pos is clamped first (CLI parity): 999 on a 42-page book == bookmark.
  assert.deepEqual(
    resolveCaptureChapter({ ...base, currentPos: 42, pos: 999, clampTo: { posUnit: 'page', totalPos: 42 } }),
    { value: 'Ch. 3: Run', hint: 'inherited' }
  );
  assert.deepEqual(
    resolveCaptureChapter({ ...base, currentPos: 100, pos: 140, clampTo: { posUnit: 'percent', totalPos: 0 } }),
    { value: 'Ch. 3: Run', hint: 'inherited' }
  );
  assert.deepEqual(
    resolveCaptureChapter({ ...base, pos: 50, touched: true, value: 'Mine' }),
    { value: 'Mine', hint: null }
  );
});

test('deepenChapterSuggestion: only for chapterless notes at the bookmark', () => {
  const book = makeBook({ status: 'reading', currentPos: 42, meta: { currentChapter: 'Ch. 3' } });
  assert.equal(deepenChapterSuggestion(makeNote({ pos: 42 }), book), 'Ch. 3');
  assert.equal(deepenChapterSuggestion(makeNote({ pos: 41 }), book), null);
  assert.equal(deepenChapterSuggestion(makeNote({ pos: 42, meta: { chapter: 'Ch. 2' } }), book), null);
  assert.equal(deepenChapterSuggestion(makeNote({ pos: 42 }), makeBook({ currentPos: 42 })), null);
  assert.equal(deepenChapterSuggestion(makeNote({ pos: 42 }), null), null);
});

test('computeChapterDividers: contiguous runs, ≥2 visible chapters, shielded runs never named', () => {
  const notes = [
    makeNote({ meta: { chapter: '1' } }),
    makeNote({ meta: { chapter: '1' } }),
    makeNote({}),
    makeNote({ meta: { chapter: 'Part II' } }),
    makeNote({ meta: { chapter: 'Ch. 31: The Betrayal' } }),
  ];
  const shielded = new Set([notes[4].id]);
  const map = computeChapterDividers(notes, n => shielded.has(n.id));
  assert.deepEqual([...map.keys()], [0, 2, 3, 4]);
  assert.deepEqual(map.get(0), { kind: 'chapter', label: 'Ch. 1', count: 2 });
  assert.equal(chapterDividerLabel(map.get(2)), 'No chapter');
  assert.equal(chapterDividerLabel(map.get(3)), 'Part II');
  assert.equal(chapterDividerLabel(map.get(4)), 'Ahead of your bookmark');
  for (const d of map.values()) assert.ok(!chapterDividerLabel(d).includes('Betrayal'));

  // Only one distinct visible chapter (the other is shielded) → no dividers at all.
  assert.equal(computeChapterDividers([notes[0], notes[4]], n => shielded.has(n.id)).size, 0);
  assert.equal(computeChapterDividers([], () => false).size, 0);
});

test('buildCapstonePrompt: template, ARC vs THESIS, reading order, badges, delta, truncation', () => {
  const book = makeBook();
  const notes = [
    makeNote({ pos: 50, status: 'atomic', meta: { title: 'Loops', chapter: '3' }, deltaTrigger: 'WHEN I blame', deltaAction: 'DO look for the loop' }),
    makeNote({ pos: 5, quote: 'q'.repeat(400), takeaway: 'line one\nline two' }),
    makeNote({ pos: 7, status: 'inbox', takeaway: 'INBOX-ONLY' }),
    makeNote({ pos: 8, status: 'in-reflection', takeaway: 'REFLECTION-ONLY' }),
    makeNote({ pos: 9, bookId: 'other', takeaway: 'OTHER-BOOK' }),
  ];
  const prompt = buildCapstonePrompt(book, notes);
  assert.ok(prompt.startsWith('I just finished reading "Thinking in Systems" by Donella Meadows (Non-fiction).'));
  assert.ok(prompt.includes('\nTHESIS: <2–3 sentences'));
  assert.ok(!prompt.includes('\nARC:'));
  assert.ok(prompt.includes('KEY LEARNINGS:\n- <3 to 5 one-line learnings, in my words>'));
  assert.ok(prompt.includes('HOW MY THINKING SHIFTED:'));
  assert.ok(prompt.includes('My notes (2 total, in reading order):'));
  for (const s of ['INBOX-ONLY', 'REFLECTION-ONLY', 'OTHER-BOOK']) assert.ok(!prompt.includes(s), s);
  const first = prompt.indexOf('[p. 5] line one line two');
  const second = prompt.indexOf('[Ch. 3 · p. 50] Loops');
  assert.ok(first > 0 && second > first, 'reading order + badges');
  assert.ok(prompt.includes(`Quote: "${'q'.repeat(279)}…"`), '280-char truncation');
  assert.ok(prompt.includes('Takeaway: line one line two'), 'one line');
  assert.ok(prompt.includes('Delta: WHEN I blame → DO look for the loop'), 'WHEN/DO prefixes stripped');
  assert.ok(!prompt.includes('(+'), 'no omitted line under the cap');

  const fiction = buildCapstonePrompt(makeBook({ kind: 'fiction' }), notes);
  assert.ok(fiction.includes('(Fiction)'));
  assert.ok(fiction.includes("\nARC: <2–3 sentences — the story's arc"));
  assert.equal(countCapstoneEligibleNotes(book, notes), 2);
});

test('truncateCapstoneText keeps ≤280 verbatim', () => {
  assert.equal(truncateCapstoneText('a'.repeat(280)), 'a'.repeat(280));
  assert.equal(truncateCapstoneText('a'.repeat(281)).length, 280);
});

test('60-note cap keeps every atomic note, then the most recent saved; "(+K …)" line', () => {
  const book = makeBook();
  const atomic = Array.from({ length: 5 }, (_, i) =>
    makeNote({ status: 'atomic', pos: 200 + i, createdAt: `2025-01-01T00:00:0${i}.000Z` })
  );
  const saved = Array.from({ length: 70 }, (_, i) =>
    makeNote({ pos: i + 1, createdAt: `2026-02-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` })
  );
  const { notes: picked, omitted } = selectCapstoneNotes(book, [...saved, ...atomic]);
  assert.equal(picked.length, CAPSTONE_PROMPT_MAX_NOTES);
  assert.equal(omitted, 15);
  for (const a of atomic) assert.ok(picked.includes(a), 'all atomic kept');
  // The 15 oldest saved notes (pos 1..15) are dropped.
  assert.ok(!picked.some(n => n.status === 'saved' && n.pos <= 15));
  const positions = picked.map(n => n.pos);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 're-sorted into reading order');
  const prompt = buildCapstonePrompt(book, [...saved, ...atomic]);
  assert.ok(prompt.includes('My notes (60 total, in reading order):'));
  assert.ok(prompt.trimEnd().endsWith('(+15 more notes left out for length)'));
});

test('parseLearningsInput strips bullets/numbers and drops empties', () => {
  assert.deepEqual(parseLearningsInput('- one\n• two\n* three\n1. four\n2) five\n\n   \nsix'), [
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
  ]);
  assert.deepEqual(parseLearningsInput(''), []);
});

test('parseCapstoneReply: case-insensitive headers, partial fills, nothing on garbage', () => {
  const reply = [
    'Sure! Here is a draft.',
    '',
    '**THESIS:** Systems behave according to',
    'their structure.',
    'Key Learnings:',
    '- Delays cause oscillation.',
    '2) Stocks buffer flows.',
    'how my thinking shifted: I look for the loop.',
    '',
    '(Optional: what will you do differently?)',
  ].join('\n');
  const parsed = parseCapstoneReply(reply);
  assert.equal(parsed.arcOrThesis, 'Systems behave according to their structure.');
  assert.deepEqual(parsed.keyLearnings, ['Delays cause oscillation.', 'Stocks buffer flows.']);
  // The assistant's optional closing question (after a blank line) never lands in a field.
  assert.equal(parsed.perspectiveShift, 'I look for the loop.');

  const spaced = parseCapstoneReply('KEY LEARNINGS:\n- a\n\n- b\n\nAnything else you want to add?');
  assert.deepEqual(spaced, { keyLearnings: ['a', 'b'] });

  assert.deepEqual(parseCapstoneReply('ARC: A boy dreams worlds.'), { arcOrThesis: 'A boy dreams worlds.' });
  assert.deepEqual(parseCapstoneReply('Arc or Thesis: X'), { arcOrThesis: 'X' });
  assert.deepEqual(parseCapstoneReply('no headings here at all'), {});
  assert.deepEqual(parseCapstoneReply(''), {});
});

test('buildCapstoneForSave: completedAt set once, preserved on edit, unknown inner keys kept', () => {
  const now = '2026-11-17T10:00:00.000Z';
  const fresh = buildCapstoneForSave(undefined, { arcOrThesis: ' A ', learningsText: '- x\n\n- y', perspectiveShift: ' S ' }, now);
  assert.deepEqual(fresh, { arcOrThesis: 'A', keyLearnings: ['x', 'y'], perspectiveShift: 'S', completedAt: now });

  const existing = { arcOrThesis: 'Old', keyLearnings: ['o'], perspectiveShift: '', completedAt: '2026-01-02T00:00:00.000Z', agentNote: { v: 1 } };
  const edited = buildCapstoneForSave(existing, { arcOrThesis: 'New', learningsText: '', perspectiveShift: '' }, now);
  assert.equal(edited.completedAt, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(edited.agentNote, { v: 1 });
  assert.deepEqual(edited.keyLearnings, []);
  assert.equal(existing.arcOrThesis, 'Old', 'input not mutated');
  assert.equal(buildCapstoneForSave('garbage', { arcOrThesis: 'a', learningsText: '', perspectiveShift: '' }, now).completedAt, now);
});

test('getFilledCapstone treats an all-empty capstone as absent', () => {
  assert.equal(getFilledCapstone(makeBook()), undefined);
  assert.equal(
    getFilledCapstone(makeBook({ meta: { capstone: { arcOrThesis: ' ', keyLearnings: [], perspectiveShift: '' } } })),
    undefined
  );
  const filled = getFilledCapstone(makeBook({ meta: { capstone: { arcOrThesis: 'A', keyLearnings: ['k'], perspectiveShift: '', completedAt: 'x' } } }));
  assert.equal(filled.arcOrThesis, 'A');
});

test('Hide is device-local: JSON array of book ids, idempotent, tolerant of junk', () => {
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(readHiddenCapstoneBooks(storage), []);
  hideCapstonePromptForBook('b1', storage);
  hideCapstonePromptForBook('b1', storage);
  hideCapstonePromptForBook('b2', storage);
  assert.deepEqual(JSON.parse(store.get(CAPSTONE_HIDDEN_KEY)), ['b1', 'b2']);
  assert.equal(CAPSTONE_HIDDEN_KEY, 'pragya_capstone_prompt_hidden_v1');
  store.set(CAPSTONE_HIDDEN_KEY, '{not json');
  assert.deepEqual(readHiddenCapstoneBooks(storage), []);
  store.set(CAPSTONE_HIDDEN_KEY, JSON.stringify(['b3', 7, null]));
  assert.deepEqual(readHiddenCapstoneBooks(storage), ['b3']);
});

test('findOverriddenMetaKeys (R2 N1) flags only non-owned keys an editor changed', () => {
  const latest = { capstone: { arcOrThesis: 'cli' }, currentChapter: 'Ch. 2', updatedAt: 't1', coverUrl: 'c' };
  const edited = { capstone: { arcOrThesis: 'mine' }, currentChapter: 'Ch. 3', updatedAt: 't0', coverUrl: 'c' };
  const base = { capstone: { arcOrThesis: 'cli' }, currentChapter: 'Ch. 2', updatedAt: 't0', coverUrl: 'c' };
  assert.deepEqual(findOverriddenMetaKeys(edited, base, latest, CAPSTONE_OWNED_META_KEYS), ['currentChapter']);
  assert.deepEqual(findOverriddenMetaKeys(edited, base, latest, BOOK_DETAIL_CHAPTER_OWNED_META_KEYS), ['capstone']);
  assert.deepEqual(findOverriddenMetaKeys(edited, null, latest, CAPSTONE_OWNED_META_KEYS), [], 'no base → no warning');
  // Another device changed coverUrl while the editor left it alone → not flagged.
  const stale = { ...base, coverUrl: 'old' };
  assert.deepEqual(
    findOverriddenMetaKeys({ ...stale, capstone: { arcOrThesis: 'mine' } }, stale, { ...latest, coverUrl: 'new' }, CAPSTONE_OWNED_META_KEYS),
    []
  );
  // Key order inside a nested object is not a change.
  assert.deepEqual(
    findOverriddenMetaKeys({ agent: { b: 1, a: 2 } }, { agent: { a: 2, b: 1 } }, { agent: { a: 2, b: 1 } }, CAPSTONE_OWNED_META_KEYS),
    []
  );
  assert.equal(metaValuesEqual({ a: [1, { y: 1, x: 2 }] }, { a: [1, { x: 2, y: 1 }] }), true);
});

test('Batch 7 fix-up R1#1/QA-22: unfinished book prompt drops notes ahead of the bookmark and sealed predictions', () => {
  const book = makeBook({ kind: 'fiction', status: 'reading', currentPos: 100, normalizedPos: 100 / 300 });
  const notes = [
    makeNote({ pos: 50, takeaway: 'EARLY' }),
    makeNote({ pos: 100, status: 'atomic', takeaway: 'AT-BOOKMARK' }),
    makeNote({ pos: 250, takeaway: 'SPOILER-AHEAD' }),
    makeNote({ pos: 20, takeaway: 'SEALED-GUESS', meta: { isPrediction: true } }),
  ];
  const prompt = buildCapstonePrompt(book, notes);
  assert.ok(prompt.includes('EARLY') && prompt.includes('AT-BOOKMARK'));
  assert.ok(!prompt.includes('SPOILER-AHEAD') && !prompt.includes('SEALED-GUESS'));
  assert.ok(prompt.includes('My notes (2 total, in reading order):'));
  assert.equal(countCapstoneEligibleNotes(book, notes), 2);
  // Finished: everything (predictions unlocked, nothing ahead of the bookmark).
  const finished = { ...book, status: 'finished', currentPos: 300, normalizedPos: 1 };
  assert.equal(countCapstoneEligibleNotes(finished, notes), 4);
});

test('Batch 7 fix-up R1#2: code-point truncation of the raw text, 8-word labels, delta for non-atomic, omitted wording', () => {
  const emoji = '📚'.repeat(300);
  const t = truncateCapstoneText(emoji);
  assert.equal(Array.from(t).length, 280);
  assert.ok(t.endsWith('📚…'));
  assert.equal(truncateCapstoneText(null), '');
  // Raw text is truncated first (newlines count, like Python), then collapsed for the prompt.
  const raw = `${'a'.repeat(270)}\n\n\n${'b'.repeat(20)}`;
  assert.equal(truncateCapstoneText(raw), `${'a'.repeat(270)}\n\n\n${'b'.repeat(6)}…`);

  assert.equal(capstoneNoteLabel(makeNote({ meta: { title: ' Loops\n2 ' } })), 'Loops 2');
  assert.equal(capstoneNoteLabel(makeNote({ takeaway: 'Short takeaway.' })), 'Short takeaway');
  assert.equal(
    capstoneNoteLabel(makeNote({ takeaway: 'one two three four five six seven eight nine ten' })),
    'one two three four five six seven eight…'
  );
  assert.equal(capstoneNoteLabel(makeNote({ takeaway: '   ' })), 'Quick Note');

  const book = makeBook();
  const prompt = buildCapstonePrompt(book, [
    makeNote({ pos: 3, status: 'saved', deltaStatus: 'paused', deltaTrigger: 'WHEN tired', deltaAction: 'DO walk' }),
    makeNote({ pos: 4, status: 'saved', deltaStatus: 'none', deltaTrigger: 'x', deltaAction: 'y' }),
  ]);
  assert.ok(prompt.includes('Delta: WHEN tired → DO walk'));
  assert.ok(!prompt.includes('Delta: WHEN x'));
  assert.equal(formatOmittedLine(1), '(+1 more note left out for length)');
  assert.equal(formatOmittedLine(3), '(+3 more notes left out for length)');
});

test('Batch 7 fix-up R1#3: invalid stored completedAt is repaired on save; valid ones kept', () => {
  const now = '2026-11-17T10:00:00.000Z';
  const fields = { arcOrThesis: 'A', learningsText: '', perspectiveShift: '' };
  for (const bad of ['soon', 123, '', '   ', '2026-13-45', null]) {
    assert.equal(buildCapstoneForSave({ completedAt: bad }, fields, now).completedAt, now, String(bad));
  }
  for (const good of ['2026-01-02', '2026-01-02T03:04:05Z', '2026-01-02T03:04:05.123+05:30']) {
    assert.equal(buildCapstoneForSave({ completedAt: good }, fields, now).completedAt, good);
    assert.ok(isIsoTimestamp(good));
  }
  assert.equal(isIsoTimestamp('soon'), false);
});

test('Batch 7 fix-up QA-24: trailing question line after the shift is dropped; a one-line question shift is kept', () => {
  assert.equal(
    parseCapstoneReply('HOW MY THINKING SHIFTED: I look for loops.\nWant me to tighten anything?').perspectiveShift,
    'I look for loops.'
  );
  assert.equal(
    parseCapstoneReply('HOW MY THINKING SHIFTED: Why did I ever blame people?').perspectiveShift,
    'Why did I ever blame people?'
  );
  assert.equal(
    parseCapstoneReply('HOW MY THINKING SHIFTED:\nWhat if structure is the culprit?\nNow I check structure first.').perspectiveShift,
    'What if structure is the culprit? Now I check structure first.',
    'a question that is not the last line stays'
  );
});
