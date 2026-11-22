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

const lexiconMod = await load('src/utils/lexicon.ts');
const navigationMod = await load('src/utils/navigation.ts');
const navLinksMod = await load('src/utils/navLinks.ts');
const shuffleMod = await load('src/utils/takeawayShuffle.ts');
const crossBookMod = await load('src/utils/crossBookSynthesis.ts');
const capstoneMod = await load('src/utils/capstonePrompt.ts');
const mutationsMod = await load('src/context/pragyaMutations.ts');
const metaCodecsMod = await load('src/utils/metaCodecs.ts');
const sheetCodecsMod = await load('src/utils/sheetCodecs.ts');

const {
  buildWordLookupPrompt,
  ensureVocabularyTag,
  getLexiconStrollStatus,
  getWordEncountersForBook,
  getWordLexicon,
  groupWordsByLemma,
  isWordNote,
  normalizeWordLexicon,
  noteHasValidContent,
  selectLexiconStroll,
} = lexiconMod;
const { isRestorableAppRoute, parseHash } = navigationMod;
const { navAriaCurrent } = navLinksMod;
const { isStructurallyEligibleForShuffle, selectTakeawayShuffle } = shuffleMod;
const { findCrossBookEchoes, selectDailyCollisionPair } = crossBookMod;
const { capstoneEligibleNotes } = capstoneMod;
const { planCaptureWithAdvance, planQuickCaptureNote } = mutationsMod;
const { normalizeNoteMeta } = metaCodecsMod;
const { noteToRow, rowToNote } = sheetCodecsMod;

function makeBook(overrides = {}) {
  const currentPos = overrides.currentPos ?? 142;
  const totalPos = overrides.totalPos ?? 218;
  const status = overrides.status ?? 'reading';
  const posUnit = overrides.posUnit ?? 'page';
  const normalizedPos =
    overrides.normalizedPos ??
    (status === 'finished' ? 1 : posUnit === 'percent' ? currentPos / 100 : totalPos > 0 ? currentPos / totalPos : 0);
  return {
    id: 'book-1',
    title: 'Thinking in Systems',
    author: 'Donella Meadows',
    format: 'physical',
    kind: 'nonfiction',
    status,
    currentPos,
    totalPos,
    posUnit,
    normalizedPos,
    docUrl: '',
    tags: ['#systems'],
    meta: { updatedAt: '2026-10-01T00:00:00.000Z' },
    ...overrides,
  };
}

function makeNote(overrides = {}) {
  return {
    id: 'note-1',
    slug: 'note-1',
    bookId: 'book-1',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    pos: 40,
    normalizedPos: 40 / 218,
    status: 'saved',
    source: 'app',
    tags: ['#systems'],
    quote: 'A sample passage.',
    takeaway: 'A sample takeaway.',
    contextMechanism: '',
    critique: '',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none',
    meta: { attachments: [], links: [] },
    ...overrides,
  };
}

function makeWordNote(lex, overrides = {}) {
  const lexicon = normalizeWordLexicon(lex);
  return makeNote({
    id: `word-${lexicon.lemma}-${overrides.pos ?? 40}`,
    slug: lexicon.lemma,
    tags: ['#vocabulary'],
    quote: 'The system drifted into oscillation.',
    takeaway: lexicon.transferExample ?? lexicon.definition ?? '',
    ...overrides,
    meta: {
      title: lexicon.word,
      attachments: [],
      links: [],
      entryKind: 'word',
      lexicon,
      ...(overrides.meta ?? {}),
    },
  });
}

test('Lexicon domain: isWordNote, getWordLexicon, normalization, and word-note validity', () => {
  const regular = makeNote();
  assert.equal(isWordNote(regular), false);
  assert.equal(getWordLexicon(regular), null);
  assert.equal(noteHasValidContent(regular), true);

  const bareWord = makeWordNote(
    { word: '  Pandemonium  ' },
    { quote: '', takeaway: '' }
  );
  assert.equal(isWordNote(bareWord), true);
  assert.equal(noteHasValidContent(bareWord), true);
  const parsed = getWordLexicon(bareWord);
  assert.deepEqual(parsed, {
    word: 'Pandemonium',
    lemma: 'pandemonium',
  });

  const malformed = makeNote({
    quote: '',
    takeaway: '',
    meta: { attachments: [], links: [], entryKind: 'word' },
  });
  assert.equal(isWordNote(malformed), true);
  assert.equal(getWordLexicon(malformed), null);
  assert.equal(noteHasValidContent(malformed), false);

  const emptyRegular = makeNote({ quote: '', takeaway: '' });
  assert.equal(noteHasValidContent(emptyRegular), false);

  assert.deepEqual(ensureVocabularyTag(['#systems', 'Philosophy', 'vocabulary']), [
    '#systems',
    '#philosophy',
    '#vocabulary',
  ]);
});

test('Lexicon domain: metaCodecs and sheetCodecs preserve entryKind and lexicon verbatim', () => {
  const book = makeBook();
  const note = makeWordNote({
    word: 'Oscillation',
    lemma: 'oscillation',
    pronunciation: '/ˌɒs.ɪˈleɪ.ʃən/',
    partOfSpeech: 'noun',
    definition: 'Back-and-forth variation around an equilibrium point.',
    etymology: 'Latin oscillare, to swing.',
    transferExample: 'Hiring freezes triggered a two-year oscillation.',
  });

  const row = noteToRow(note);
  const roundTripped = rowToNote(row);
  assert.equal(roundTripped.meta.entryKind, 'word');
  assert.deepEqual(roundTripped.meta.lexicon, note.meta.lexicon);

  const normalizedMeta = normalizeNoteMeta({
    ...roundTripped.meta,
    customCompanionFlag: 'keep-me',
  });
  assert.equal(normalizedMeta.entryKind, 'word');
  assert.equal(normalizedMeta.customCompanionFlag, 'keep-me');
  assert.equal(getWordLexicon({ meta: normalizedMeta })?.definition, note.meta.lexicon?.definition);
  assert.equal(getWordEncountersForBook(book, [roundTripped]).length, 1);
});

test('Lexicon domain: groupWordsByLemma groups multiple encounters and honors spoiler shield', () => {
  const b1 = makeBook({ id: 'b1', title: 'Thinking in Systems', currentPos: 142, totalPos: 218 });
  const b2 = makeBook({ id: 'b2', title: 'Exhalation', currentPos: 168, totalPos: 352, kind: 'fiction' });

  const w1 = makeWordNote(
    { word: 'Oscillation', lemma: 'oscillation' },
    {
      id: 'w1',
      bookId: 'b1',
      pos: 55,
      normalizedPos: 55 / 218,
      createdAt: '2026-10-02T10:00:00.000Z',
      quote: 'Delays produce oscillation in stock levels.',
      meta: { chapter: 'Ch. 2' },
    }
  );
  const w2 = makeWordNote(
    {
      word: 'oscillations',
      lemma: 'oscillation',
      definition: 'Repeated swinging between opposing states.',
      etymology: 'From Latin oscillum, a swing.',
    },
    {
      id: 'w2',
      bookId: 'b2',
      pos: 90,
      normalizedPos: 90 / 352,
      createdAt: '2026-10-05T10:00:00.000Z',
      quote: 'Tiny mechanical oscillations marked time.',
    }
  );
  const spoilerWord = makeWordNote(
    {
      word: 'Tautology',
      lemma: 'tautology',
      definition: 'Needless repetition of the same idea.',
    },
    {
      id: 'w3',
      bookId: 'b2',
      pos: 260,
      normalizedPos: 260 / 352,
      createdAt: '2026-10-06T10:00:00.000Z',
      quote: 'A late-book spoiler line.',
    }
  );
  const archivedWord = makeWordNote(
    { word: 'Obsolete', lemma: 'obsolete' },
    {
      id: 'w4',
      bookId: 'b1',
      pos: 20,
      normalizedPos: 20 / 218,
      meta: { archivedAt: '2026-10-07T00:00:00.000Z' },
    }
  );

  const groups = groupWordsByLemma([w1, w2, spoilerWord, archivedWord], [b1, b2]);
  assert.equal(groups.length, 2);

  // Unshielded group sorts first cleanly; shielded-only sorts last with redacted text.
  const osc = groups[0];
  assert.equal(osc.lemma, 'oscillation');
  assert.equal(osc.encounters.length, 2);
  assert.equal(osc.definition, 'Repeated swinging between opposing states.');
  assert.equal(osc.allShielded, false);

  const hidden = groups[1];
  assert.equal(hidden.allShielded, true);
  assert.equal(hidden.word, '');
  assert.equal(hidden.lemma, '');
  assert.equal(hidden.definition, undefined);
  assert.equal(hidden.encounters[0].shielded, true);
  assert.equal(hidden.encounters[0].quote, '');
  assert.equal(hidden.encounters[0].posLabel, 'p. 260');

  // Search query must never leak shielded future words
  const searchLeakCheck = groupWordsByLemma([w1, w2, spoilerWord], [b1, b2], {
    query: 'tautology',
  });
  assert.equal(searchLeakCheck.length, 0);

  // includeSpoilers reveals it for companion CLI
  const withSpoilers = groupWordsByLemma([spoilerWord], [b1, b2], {
    includeSpoilers: true,
  });
  assert.equal(withSpoilers[0].word, 'Tautology');
  assert.equal(withSpoilers[0].encounters[0].shielded, false);
});

test('Lexicon domain: D8 excludes word notes from Shuffle, Collision, Cross-Book Echoes, and Capstone', () => {
  const b1 = makeBook({ id: 'b1', title: 'Book One', currentPos: 200, totalPos: 200, status: 'finished' });
  const b2 = makeBook({ id: 'b2', title: 'Book Two', currentPos: 150, totalPos: 200, status: 'reading' });

  const regular1 = makeNote({
    id: 'n1',
    slug: 'n1',
    bookId: 'b1',
    tags: ['#systems', '#feedback'],
    createdAt: '2026-09-01T10:00:00.000Z',
    takeaway: 'Delays in feedback loops destabilize systems.',
    meta: { attachments: [], links: ['n2'] },
  });
  const regular2 = makeNote({
    id: 'n2',
    slug: 'n2',
    bookId: 'b2',
    tags: ['#systems', '#feedback'],
    createdAt: '2026-09-02T10:00:00.000Z',
    takeaway: 'Control depends on timely measurement.',
    meta: { attachments: [], links: [] },
  });

  const word1 = makeWordNote(
    {
      word: 'Homeostasis',
      definition: 'Self-regulating stability in a complex system.',
      transferExample: 'Sleep enforces metabolic homeostasis.',
    },
    {
      id: 'w1',
      bookId: 'b1',
      pos: 50,
      normalizedPos: 0.25,
      createdAt: '2026-09-01T10:00:00.000Z',
      tags: ['#systems', '#vocabulary', '#favorite'],
    }
  );
  const word2 = makeWordNote(
    {
      word: 'Equilibrium',
      definition: 'Balance between opposing forces.',
      transferExample: 'Markets rarely stay in static equilibrium.',
    },
    {
      id: 'w2',
      bookId: 'b2',
      pos: 60,
      normalizedPos: 0.3,
      createdAt: '2026-09-01T10:00:00.000Z',
      tags: ['#systems', '#vocabulary', '#favorite'],
    }
  );

  // Shuffle exclusion
  assert.equal(isStructurallyEligibleForShuffle(word1, b1, '2026-10-15'), false);
  const shuffled = selectTakeawayShuffle([word1, word2], [b1, b2], '2026-10-15');
  assert.deepEqual(shuffled, []);

  // Collision exclusion (word notes cannot form collision pairs; regular1+regular2 pairs cleanly when word notes exist)
  assert.equal(selectDailyCollisionPair([word1, word2], [b1, b2], '2026-10-15'), null);
  assert.equal(selectDailyCollisionPair([regular1, word2], [b1, b2], '2026-10-15'), null);
  const regularPair = selectDailyCollisionPair(
    [regular1, regular2, word1, word2],
    [b1, b2],
    '2026-10-15'
  );
  assert.equal(regularPair?.pairKey, 'n1::n2');
  assert.equal(regularPair?.totalCandidates, 1);

  // Cross-book echoes exclusion (returns regular2 but never word2)
  const echoes = findCrossBookEchoes(b1, [regular1, regular2, word1, word2], [b1, b2]);
  assert.deepEqual(
    echoes.map(e => e.note.id),
    ['n2']
  );

  // Capstone exclusion
  const cap = capstoneEligibleNotes(b1, [regular1, word1]);
  assert.deepEqual(
    cap.map(n => n.id),
    ['n1']
  );
});

test('Lexicon domain: selectLexiconStroll picks 1-2 unshielded >=1-day words deterministically and honors reviewed today', () => {
  const b1 = makeBook({ id: 'b1', currentPos: 120, totalPos: 200 });
  const wFresh = makeWordNote(
    { word: 'FreshWord', definition: 'Created today.' },
    { id: 'w-fresh', bookId: 'b1', pos: 10, normalizedPos: 0.05, createdAt: '2026-10-15T09:00:00.000Z' }
  );
  const wSpoiler = makeWordNote(
    { word: 'FutureWord', definition: 'Ahead of bookmark.' },
    { id: 'w-spoiler', bookId: 'b1', pos: 180, normalizedPos: 0.9, createdAt: '2026-10-10T09:00:00.000Z' }
  );
  const wReady1 = makeWordNote(
    { word: 'Oscillation', definition: 'Swinging back and forth.' },
    { id: 'w-1', bookId: 'b1', pos: 30, normalizedPos: 0.15, createdAt: '2026-10-13T09:00:00.000Z' }
  );
  const wReady2 = makeWordNote(
    { word: 'Pandemonium', definition: 'Wild and noisy disorder.' },
    { id: 'w-2', bookId: 'b1', pos: 60, normalizedPos: 0.3, createdAt: '2026-10-12T09:00:00.000Z' }
  );
  const wReady3 = makeWordNote(
    { word: 'Ephemeral', definition: 'Lasting for a very short time.' },
    { id: 'w-3', bookId: 'b1', pos: 80, normalizedPos: 0.4, createdAt: '2026-10-11T09:00:00.000Z' }
  );

  const notes = [wFresh, wSpoiler, wReady1, wReady2, wReady3];
  const pickA = selectLexiconStroll(notes, [b1], '2026-10-15', 2);
  const pickB = selectLexiconStroll(notes, [b1], '2026-10-15', 2);
  assert.equal(pickA.length, 2);
  assert.deepEqual(
    pickA.map(p => p.note.id),
    pickB.map(p => p.note.id)
  );
  assert.ok(!pickA.some(p => p.note.id === 'w-fresh' || p.note.id === 'w-spoiler'));

  // Marking one reviewed today excludes it from today's stroll and advances pool
  const reviewedFirst = notes.map(n =>
    n.id === pickA[0].note.id
      ? { ...n, meta: { ...n.meta, lastReviewedAt: '2026-10-15T12:00:00.000Z' } }
      : n
  );
  const afterReview = getLexiconStrollStatus(reviewedFirst, [b1], '2026-10-15', 2);
  assert.equal(afterReview.totalPoolCount, 3);
  assert.equal(afterReview.freshTodayCount, 1);
  assert.equal(afterReview.reviewedTodayCount, 1);
  assert.equal(afterReview.items.length, 2);
  assert.ok(!afterReview.items.some(p => p.note.id === pickA[0].note.id));
});

test('Lexicon routing & capture planner: parseHash, navAriaCurrent, planQuickCaptureNote', () => {
  assert.deepEqual(parseHash('#/lexicon'), { view: 'lexicon', raw: '#/lexicon' });
  assert.equal(isRestorableAppRoute('#/lexicon'), true);
  assert.equal(navAriaCurrent('lexicon', 'lexicon'), 'page');
  assert.equal(navAriaCurrent('notes', 'lexicon'), undefined);

  const bookRoute = parseHash('#/book/book-1?note=note-99');
  assert.deepEqual(bookRoute, {
    view: 'book',
    bookId: 'book-1',
    noteId: 'note-99',
    raw: '#/book/book-1?note=note-99',
  });
  assert.equal(isRestorableAppRoute('#/book/book-1?note=note-99'), true);

  const book = makeBook({ currentPos: 50, totalPos: 200 });
  const planned = planQuickCaptureNote(
    {
      bookId: book.id,
      pos: 62,
      quote: 'A scene of pandemonium broke out.',
      takeaway: '',
      tags: ['systems'],
      chapter: 'Part I',
      entryKind: 'word',
      lexicon: {
        word: 'Pandemonium',
        definition: 'Wild uproar.',
      },
    },
    book,
    [],
    '2026-10-15T08:00:00.000Z',
    'uuid-word-1'
  );
  assert.equal(planned.status, 'saved');
  assert.equal(planned.slug, 'pandemonium');
  assert.equal(planned.meta.title, 'Pandemonium');
  assert.equal(planned.meta.entryKind, 'word');
  assert.deepEqual(planned.meta.lexicon, {
    word: 'Pandemonium',
    lemma: 'pandemonium',
    definition: 'Wild uproar.',
  });
  assert.equal(planned.takeaway, 'Wild uproar.');
  assert.ok(planned.tags.includes('#vocabulary'));

  const batch = planCaptureWithAdvance(
    {
      bookId: book.id,
      pos: 62,
      takeaway: '',
      tags: [],
      entryKind: 'word',
      lexicon: { word: 'Liminal' },
    },
    book,
    [planned],
    [],
    '2026-10-15T09:00:00.000Z'
  );
  assert.equal(batch.advance?.changed, true);
  assert.equal(batch.newNote.slug, 'liminal');
  assert.equal(batch.newNote.takeaway, '');
  assert.equal(noteHasValidContent(batch.newNote), true);

  const prompt = buildWordLookupPrompt({
    word: 'Oscillation',
    bookTitle: 'Thinking in Systems',
    author: 'Donella Meadows',
    chapter: 'Ch. 2',
    posLabel: 'p. 55',
    quote: 'Delays cause oscillation.',
  });
  assert.match(prompt, /Look up the word "Oscillation"/);
  assert.match(prompt, /Thinking in Systems/);
  assert.match(prompt, /Delays cause oscillation\./);
});

const demoSeedMod = await load('src/data/demoSeed.ts');
const shortcutsMod = await load('src/utils/keyboardShortcuts.ts');
const { createDemoSeed } = demoSeedMod;
const { KEYBOARD_SHORTCUTS, shortcutKeysText } = shortcutsMod;

test('Lexicon demoSeed & shortcuts: seeded words exercise unshielded, incomplete, and spoiler-shielded cases', () => {
  const seed = createDemoSeed(new Date('2026-11-15T12:00:00.000Z'));
  const wordNotes = seed.notes.filter(isWordNote);
  assert.equal(wordNotes.length, 3);

  const groups = groupWordsByLemma(seed.notes, seed.books);
  assert.equal(groups.length, 3);

  const visible = groups.filter(g => !g.allShielded);
  const shielded = groups.filter(g => g.allShielded);
  assert.equal(visible.length, 2);
  assert.equal(shielded.length, 1);

  assert.deepEqual(
    visible.map(g => g.lemma),
    ['homeostasis', 'oscillation']
  );
  assert.equal(visible.find(g => g.lemma === 'homeostasis')?.needsDefinition, true);
  assert.equal(visible.find(g => g.lemma === 'oscillation')?.needsDefinition, false);
  assert.equal(shielded[0].word, '');
  assert.equal(shielded[0].encounters[0].posLabel, 'p. 284');

  // Demo seed word ahead of bookmark must stay hidden from Shuffle, Echoes, Collision, Capstone
  assert.deepEqual(selectTakeawayShuffle(seed.notes, seed.books, '2026-11-15').filter(isWordNote), []);

  // Shortcut registry preserves the 7 exact section titles and documents G then S / N / P / W
  assert.deepEqual(
    KEYBOARD_SHORTCUTS.map(s => s.title),
    ['Anywhere', 'Notes list', 'Book page', 'Note page', 'Practice', 'In forms', 'Search & images']
  );
  const goRow = KEYBOARD_SHORTCUTS[0].rows.find(r => r.action.includes('Lexicon'));
  assert.ok(goRow);
  assert.equal(shortcutKeysText(goRow.keys, 'Linux'), 'G then S / N / P / W');
});

const noteVisMod = await load('src/utils/noteVisibility.ts');
const { buildNoteSearchHaystack } = noteVisMod;
const { syncWordTitleOnLexiconEdit } = lexiconMod;

test('groupWordsByLemma isolates shielded encounters per note ID (no spoiler-by-association leak)', () => {
  const nonfiction = makeBook({ id: 'b-sys', title: 'Thinking in Systems', kind: 'nonfiction', currentPos: 150 });
  const fiction = makeBook({ id: 'b-exh', title: 'Exhalation', kind: 'fiction', currentPos: 100 });
  const notes = [
    makeWordNote(
      { word: 'pandemonium', definition: 'Wild uproar.' },
      {
        id: 'w-sys-pandemonium',
        bookId: 'b-sys',
        pos: 40,
        createdAt: '2026-10-10T10:00:00Z',
      }
    ),
    makeWordNote(
      { word: 'Pandemonium', definition: 'Future fiction encounter.' },
      {
        id: 'w-exh-pandemonium',
        bookId: 'b-exh',
        pos: 300,
        createdAt: '2026-10-11T10:00:00Z',
      }
    ),
    makeWordNote(
      { word: 'ephemeral' },
      {
        id: 'w-exh-future-b',
        bookId: 'b-exh',
        pos: 310,
        createdAt: '2026-10-12T10:00:00Z',
      }
    ),
    makeWordNote(
      { word: 'pandemonium' },
      {
        id: 'w-exh-future-pandemonium-2',
        bookId: 'b-exh',
        pos: 320,
        createdAt: '2026-10-13T10:00:00Z',
      }
    ),
  ];

  const groups = groupWordsByLemma(notes, [nonfiction, fiction]);
  assert.equal(groups.length, 4);

  const visiblePandemonium = groups.find(g => !g.allShielded && g.lemma === 'pandemonium');
  assert.ok(visiblePandemonium);
  // Must contain ONLY the nonfiction encounter, never the shielded fiction encounter
  assert.equal(visiblePandemonium.encounters.length, 1);
  assert.equal(visiblePandemonium.encounters[0].note.id, 'w-sys-pandemonium');

  // Every redacted encounter must sit on its own anonymous standalone card
  const shielded = groups.filter(g => g.allShielded);
  assert.equal(shielded.length, 3);
  for (const s of shielded) {
    assert.equal(s.lemma, '');
    assert.equal(s.word, '');
    assert.equal(s.encounters.length, 1);
    assert.equal(s.encounters[0].shielded, true);
    assert.equal(s.encounters[0].word, '');
  }

  // Querying "pandemonium" matches only the visible group, never hidden cards
  const queried = groupWordsByLemma(notes, [nonfiction, fiction], { query: 'pandemonium' });
  assert.equal(queried.length, 1);
  assert.equal(queried[0].encounters[0].note.id, 'w-sys-pandemonium');

  // Revealing w-exh-pandemonium merges it back into the visible pandemonium lemma group
  const revealed = groupWordsByLemma(notes, [nonfiction, fiction], {
    revealedNoteIds: new Set(['w-exh-pandemonium']),
  });
  const merged = revealed.find(g => g.lemma === 'pandemonium');
  assert.ok(merged);
  assert.deepEqual(
    merged.encounters.map(e => e.note.id),
    ['w-exh-pandemonium', 'w-sys-pandemonium']
  );
  assert.equal(revealed.filter(g => g.allShielded).length, 2);
});

test('Malformed meta.lexicon never crashes getWordLexicon, buildNoteSearchHaystack, or groupWordsByLemma', () => {
  const book = makeBook({ id: 'b-sys', currentPos: 150 });
  const malformedCases = [
    null,
    'not-an-object',
    42,
    [],
    {},
    { word: 123, definition: { nested: true } },
    { word: '   ' },
  ];

  const badNotes = malformedCases.map((badLex, idx) =>
    makeNote({
      id: `bad-${idx}`,
      bookId: book.id,
      pos: 10 + idx,
      meta: { entryKind: 'word', lexicon: badLex },
    })
  );

  for (const n of badNotes) {
    assert.equal(getWordLexicon(n), null);
    const haystack = buildNoteSearchHaystack(n, book);
    assert.equal(typeof haystack, 'string');
    assert.ok(!haystack.includes('[object Object]'));
  }

  const mixedNotes = [
    ...badNotes,
    makeNote({
      id: 'bad-optional-types',
      bookId: book.id,
      pos: 40,
      meta: {
        entryKind: 'word',
        lexicon: {
          word: 'Resilience',
          definition: { invalid: true },
          etymology: 99,
        },
      },
    }),
  ];
  const groups = groupWordsByLemma(mixedNotes, [book]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].word, 'Resilience');
  assert.equal(groups[0].definition, undefined);
});

test('syncWordTitleOnLexiconEdit syncs title -> lexicon.word and preserves custom base lemmas', () => {
  const autoLemmaNote = makeWordNote(
    {
      word: 'Oscillation',
      lemma: 'oscillation',
      definition: 'Back-and-forth swing.',
      pronunciation: '/ˌɒsɪˈleɪʃən/',
      partOfSpeech: 'noun',
    },
    { id: 'w-auto' }
  );
  const syncedAuto = syncWordTitleOnLexiconEdit(autoLemmaNote, 'Oscillations');
  assert.equal(syncedAuto?.word, 'Oscillations');
  assert.equal(syncedAuto?.lemma, 'oscillations');
  assert.equal(syncedAuto?.definition, 'Back-and-forth swing.');
  assert.equal(syncedAuto?.pronunciation, '/ˌɒsɪˈleɪʃən/');
  assert.equal(syncedAuto?.partOfSpeech, 'noun');

  const customLemmaNote = makeWordNote(
    {
      word: 'oscillating',
      lemma: 'oscillate',
      definition: 'Swinging periodically.',
    },
    { id: 'w-custom' }
  );
  const syncedCustom = syncWordTitleOnLexiconEdit(customLemmaNote, 'oscillated');
  assert.equal(syncedCustom?.word, 'oscillated');
  assert.equal(syncedCustom?.lemma, 'oscillate');
  assert.equal(syncedCustom?.definition, 'Swinging periodically.');

  assert.equal(syncWordTitleOnLexiconEdit(autoLemmaNote, '   '), null);
});
