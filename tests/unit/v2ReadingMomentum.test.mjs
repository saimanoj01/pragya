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

const metaCodecs = await load('src/utils/metaCodecs.ts');
const wikilinks = await load('src/utils/wikilinks.ts');
const readingMomentum = await load('src/utils/readingMomentum.ts');
const crossBook = await load('src/utils/crossBookSynthesis.ts');
const capstonePrompt = await load('src/utils/capstonePrompt.ts');
const mutations = await load('src/context/pragyaMutations.ts');
const sheetsAdapter = await load('src/services/googleSheetsAdapter.ts');

function makeBook(overrides = {}) {
  return {
    id: 'book-1',
    title: 'Thinking in Systems',
    author: 'Donella Meadows',
    format: 'physical',
    kind: 'nonfiction',
    status: 'reading',
    currentPos: 100,
    totalPos: 200,
    posUnit: 'page',
    normalizedPos: 0.5,
    docUrl: '',
    meta: { updatedAt: '2026-11-10T10:00:00Z' },
    ...overrides,
  };
}

function makeNote(overrides = {}) {
  return {
    id: 'note-1',
    slug: 'feedback-delays',
    bookId: 'book-1',
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-10T10:00:00Z',
    pos: 80,
    normalizedPos: 0.4,
    status: 'atomic',
    source: 'app',
    tags: ['#systems', '#delays'],
    quote: 'Delays cause oscillation.',
    takeaway: 'Wait out lag before tuning.',
    contextMechanism: '',
    critique: '',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none',
    meta: { title: 'Feedback Delays', attachments: [], links: [] },
    ...overrides,
  };
}

test('v2 metaCodecs: verbatim pass-through keeps SHEETS_CACHE_CODEC_VERSION === 2 and exact empty shapes', () => {
  assert.equal(sheetsAdapter.SHEETS_CACHE_CODEC_VERSION, 2);
  assert.deepEqual(metaCodecs.normalizeBookMeta(''), { updatedAt: '' });
  assert.deepEqual(metaCodecs.normalizeNoteMeta(''), { attachments: [], links: [] });

  const rawBookMeta = {
    updatedAt: '2026-11-10T00:00:00Z',
    whyQueued: '  Sam recommended it  ',
    pauseNote: 'Save for vacation',
    nextStop: 'Ch. 4 · p. 150',
    readingQuestions: [
      { id: 'q_11111111', question: 'What is leverage?', status: 'open', createdAt: '2026-11-01T00:00:00Z' },
      { weirdFutureEntry: true },
    ],
  };
  const normBook = metaCodecs.normalizeBookMeta(rawBookMeta);
  assert.equal(normBook.readingQuestions.length, 2);
  assert.deepEqual(normBook.readingQuestions[1], { weirdFutureEntry: true });
  assert.equal(metaCodecs.getBookMetaString(normBook, 'whyQueued'), 'Sam recommended it');
  assert.equal(metaCodecs.getBookReadingQuestions(normBook).length, 1);

  const normNote = metaCodecs.normalizeNoteMeta({
    relatedSlugs: ['Infinite Games', 'infinite-games', '!!!'],
    bridgeNotes: { 'Infinite Games': '  Both reject static control  ', '': 'ignored' },
  });
  assert.deepEqual(metaCodecs.getNoteRelatedSlugs(normNote), ['infinite-games']);
  assert.deepEqual(metaCodecs.getNoteBridgeNotes(normNote), {
    'infinite-games': 'Both reject static control',
  });
});

test('v2 planUpdatedNote: preserves non-owned attachments and links when ownedMetaKeys is NOTE_BRIDGES_OWNED_META_KEYS', () => {
  const existingNote = makeNote({
    meta: {
      title: 'Feedback Delays',
      attachments: [{ id: 'att-cli', type: 'image', driveFileId: 'drv-99', fileName: 'p.webp', mimeType: 'image/webp' }],
      links: ['https://example.com/cli-link'],
    },
  });
  const staleEdited = makeNote({
    meta: {
      title: 'Feedback Delays',
      attachments: [],
      links: [],
      relatedSlugs: ['infinite-games'],
      bridgeNotes: { 'infinite-games': 'Shared systems lens' },
    },
  });
  const planned = mutations.planUpdatedNote(
    staleEdited,
    existingNote,
    makeBook(),
    [existingNote],
    { ownedMetaKeys: metaCodecs.NOTE_BRIDGES_OWNED_META_KEYS }
  );
  assert.equal(planned.nextNote.meta.attachments.length, 1);
  assert.equal(planned.nextNote.meta.attachments[0].driveFileId, 'drv-99');
  assert.deepEqual(planned.nextNote.meta.links, ['https://example.com/cli-link']);
  assert.deepEqual(planned.nextNote.meta.relatedSlugs, ['infinite-games']);
});

test('v2 readingQuestions: 5-open cap, prefix answer, reopen, remove, unknown entry pass-through', () => {
  let raw = [{ unknownLegacy: 'keep-me' }];
  for (let i = 1; i <= 5; i += 1) {
    raw = readingMomentum.addReadingQuestion(raw, `Question ${i}`, '2026-11-10T10:00:00Z', `q_0000000${i}`);
  }
  assert.throws(
    () => readingMomentum.addReadingQuestion(raw, 'Question 6', '2026-11-10T10:00:00Z', 'q_00000006'),
    /limit \(5\)/i
  );

  // Answer q_00000001 via unique prefix; now 4 open -> can add Question 6!
  raw = readingMomentum.answerReadingQuestion(
    raw,
    'q_00000001',
    { answer: 'Because delays amplify overshoot.', noteId: 'note-1' },
    '2026-11-11T10:00:00Z'
  );
  const qs = metaCodecs.getBookReadingQuestions({ readingQuestions: raw });
  assert.equal(qs[0].status, 'answered');
  assert.equal(qs[0].answer, 'Because delays amplify overshoot.');
  assert.equal(qs[0].noteId, 'note-1');

  raw = readingMomentum.addReadingQuestion(raw, 'Question 6', '2026-11-11T11:00:00Z', 'q_00000006');
  assert.equal(metaCodecs.getBookReadingQuestions({ readingQuestions: raw }).length, 6);
  // Unknown entry still preserved at index 0
  assert.deepEqual(raw[0], { unknownLegacy: 'keep-me' });

  // Reopen blocked at 5 open
  assert.throws(() => readingMomentum.reopenReadingQuestion(raw, 'q_00000001'), /limit \(5\)/i);

  // Remove one open question then reopen succeeds
  raw = readingMomentum.removeReadingQuestion(raw, 'q_00000006');
  raw = readingMomentum.reopenReadingQuestion(raw, 'q_00000001');
  assert.equal(metaCodecs.getBookReadingQuestions({ readingQuestions: raw })[0].status, 'open');
});

test('v2 computeSittingPace: median delta, re-read startedAt filtering, and percent totalPos=0 handling', () => {
  const rereadBook = makeBook({
    currentPos: 40,
    totalPos: 200,
    meta: {
      everFinished: true,
      startedAt: '2026-11-15T12:00:00Z',
      updatedAt: '2026-11-18T12:00:00Z',
    },
  });
  const sessions = [
    // Read #1 session from earlier the same morning -> must be excluded!
    { id: 's0', bookId: 'book-1', date: '2026-11-15', startPos: 150, endPos: 200, updatedAt: '2026-11-15T08:00:00Z', note: '' },
    // Read #2 sessions
    { id: 's1', bookId: 'book-1', date: '2026-11-16', startPos: 0, endPos: 20, updatedAt: '2026-11-16T20:00:00Z', note: '' },
    { id: 's2', bookId: 'book-1', date: '2026-11-17', startPos: 20, endPos: 40, updatedAt: '2026-11-17T20:00:00Z', note: '' },
  ];
  const pace = readingMomentum.computeSittingPace(rereadBook, sessions);
  assert.ok(pace);
  assert.equal(pace.medianDelta, 20);
  assert.equal(pace.sittingsLeft, 8);
  assert.match(pace.label, /~20 pages a sitting · about 8 sittings left/);

  // Percent book with totalPos === 0 defaults to 100
  const pctBook = makeBook({ id: 'book-pct', posUnit: 'percent', currentPos: 50, totalPos: 0, normalizedPos: 0.5, meta: { updatedAt: '' } });
  const pctSessions = [
    { id: 'p1', bookId: 'book-pct', date: '2026-11-10', startPos: 0, endPos: 25, updatedAt: '2026-11-10T20:00:00Z', note: '' },
    { id: 'p2', bookId: 'book-pct', date: '2026-11-11', startPos: 25, endPos: 50, updatedAt: '2026-11-11T20:00:00Z', note: '' },
  ];
  const pctPace = readingMomentum.computeSittingPace(pctBook, pctSessions);
  assert.ok(pctPace);
  assert.equal(pctPace.sittingsLeft, 2);
  assert.match(pctPace.label, /~25% a sitting · about 2 sittings left/);

  // Fewer than 2 sessions returns null
  assert.equal(readingMomentum.computeSittingPace(pctBook, [pctSessions[0]]), null);
});

test('v2 buildReEntryPrompt: strictly spoiler-safe and redacts sealed prediction text', () => {
  const fictionBook = makeBook({
    id: 'book-fic',
    title: 'Exhalation',
    author: 'Ted Chiang',
    kind: 'fiction',
    currentPos: 120,
    totalPos: 300,
    normalizedPos: 0.4,
    meta: {
      currentChapter: 'Exhalation',
      nextStop: 'Finish story · p. 150',
      updatedAt: '2026-11-15T10:00:00Z',
      readingQuestions: [
        { id: 'q_1', question: 'How does entropy frame memory?', status: 'open', createdAt: '2026-11-10T00:00:00Z' },
      ],
    },
  });
  const notes = [
    makeNote({ id: 'n-safe', bookId: 'book-fic', pos: 80, normalizedPos: 80 / 300, takeaway: 'Air pressure equals memory.' }),
    makeNote({ id: 'n-spoiler', bookId: 'book-fic', pos: 250, normalizedPos: 250 / 300, takeaway: 'SECRET TWIST ENDING' }),
    makeNote({
      id: 'n-pred',
      bookId: 'book-fic',
      pos: 110,
      normalizedPos: 110 / 300,
      takeaway: 'SECRET SEALED PREDICTION GUESS',
      meta: { isPrediction: true, attachments: [], links: [] },
    }),
  ];
  const prompt = readingMomentum.buildReEntryPrompt(fictionBook, notes, []);
  assert.ok(prompt.includes('Air pressure equals memory.'));
  assert.ok(prompt.includes('How does entropy frame memory?'));
  assert.ok(prompt.includes('Finish story · p. 150'));
  assert.ok(prompt.includes('Sealed predictions waiting until I finish: 1 (logged at p. 110)'));
  assert.equal(prompt.includes('SECRET TWIST ENDING'), false);
  assert.equal(prompt.includes('SECRET SEALED PREDICTION GUESS'), false);
});

test('v2 crossBookSynthesis: echoes exclude generic tags & spoilers, rank links over tags, deterministic ties', () => {
  const bookA = makeBook({ id: 'b-a', title: 'Systems', currentPos: 100, totalPos: 200, normalizedPos: 0.5 });
  const bookB = makeBook({ id: 'b-b', title: 'Infinite Games', currentPos: 100, totalPos: 200, normalizedPos: 0.5 });
  const bookC = makeBook({ id: 'b-c', title: 'Noise Book', currentPos: 50, totalPos: 200, normalizedPos: 0.25 });

  const notes = [
    makeNote({
      id: 'na-1',
      slug: 'delays-loop',
      bookId: 'b-a',
      pos: 90,
      normalizedPos: 0.45,
      tags: ['#systems', '#favorite'],
      meta: { relatedSlugs: ['old-infinite-alias'], attachments: [], links: [] },
    }),
    // Linked via alias -> weight 5 + #systems (2) = 7
    makeNote({
      id: 'nb-linked',
      slug: 'infinite-play',
      bookId: 'b-b',
      pos: 60,
      normalizedPos: 0.3,
      tags: ['#systems', '#favorite'],
      meta: { aliases: ['old-infinite-alias'], attachments: [], links: [] },
    }),
    // Shares only #favorite -> MUST be ignored (score 0)
    makeNote({
      id: 'nc-generic',
      slug: 'only-fav',
      bookId: 'b-c',
      pos: 20,
      normalizedPos: 0.1,
      tags: ['#favorite'],
    }),
    // Shares #systems but is a SPOILER (pos 150 > 50) -> MUST be excluded!
    makeNote({
      id: 'nc-spoiler',
      slug: 'future-systems',
      bookId: 'b-c',
      pos: 150,
      normalizedPos: 0.75,
      tags: ['#systems'],
    }),
  ];

  const echoes = crossBook.findCrossBookEchoes(bookA, notes, [bookA, bookB, bookC], 3);
  assert.equal(echoes.length, 1);
  assert.equal(echoes[0].note.id, 'nb-linked');
  assert.equal(echoes[0].linked, true);
  assert.equal(echoes[0].score, 7);
});

test('v2 planNoteBridgeOps & wikilinks: alias canonicalization, symmetric link/unlink, refusal of self/archived/shielded', () => {
  const bookA = makeBook({ id: 'b-a', currentPos: 100, totalPos: 200, normalizedPos: 0.5 });
  const bookB = makeBook({ id: 'b-b', currentPos: 100, totalPos: 200, normalizedPos: 0.5 });
  const noteA = makeNote({
    id: 'na',
    slug: 'note-a',
    bookId: 'b-a',
    pos: 80,
    normalizedPos: 0.4,
    takeaway: 'My original voice stays untouched.',
    meta: {
      relatedSlugs: ['old-b-slug'],
      bridgeNotes: { 'old-b-slug': 'Old reason' },
      attachments: [],
      links: [],
    },
  });
  const noteB = makeNote({
    id: 'nb',
    slug: 'new-b-slug',
    bookId: 'b-b',
    pos: 60,
    normalizedPos: 0.3,
    meta: { aliases: ['old-b-slug'], attachments: [], links: [] },
  });

  // Backlinks & wikilinks recognize relatedSlugs + aliases
  assert.ok(wikilinks.extractNoteWikilinks(noteA).includes('old-b-slug'));
  assert.equal(wikilinks.computeNoteBacklinks(noteB, [noteA, noteB]).length, 1);

  // Linking canonicalizes old-b-slug -> new-b-slug and writes symmetric bridge
  const linked = crossBook.planNoteBridgeOps(noteA, noteB, [noteA, noteB], [bookA, bookB], {
    mode: 'link',
    bidirectional: true,
    why: 'Updated shared lens',
    nowIso: '2026-11-20T00:00:00Z',
  });
  assert.equal(linked.changed, true);
  assert.equal(linked.nextNotes.length, 2);
  const nextA = linked.nextNotes.find(n => n.id === 'na');
  const nextB = linked.nextNotes.find(n => n.id === 'nb');
  assert.deepEqual(nextA.meta.relatedSlugs, ['new-b-slug']);
  assert.deepEqual(nextA.meta.bridgeNotes, { 'new-b-slug': 'Updated shared lens' });
  assert.equal(nextA.takeaway, 'My original voice stays untouched.');
  assert.deepEqual(nextB.meta.relatedSlugs, ['note-a']);
  assert.deepEqual(nextB.meta.bridgeNotes, { 'note-a': 'Updated shared lens' });

  // Unlinking removes both sides and deletes empty keys cleanly
  const unlinked = crossBook.planNoteBridgeOps(nextA, nextB, [nextA, nextB], [bookA, bookB], {
    mode: 'unlink',
    bidirectional: true,
    nowIso: '2026-11-20T01:00:00Z',
  });
  assert.equal(unlinked.changed, true);
  const cleanA = unlinked.nextNotes.find(n => n.id === 'na');
  assert.equal('relatedSlugs' in cleanA.meta, false);
  assert.equal('bridgeNotes' in cleanA.meta, false);

  // Refuses self-link, archived, and shielded
  assert.throws(
    () => crossBook.planNoteBridgeOps(noteA, noteA, [noteA], [bookA], { mode: 'link' }),
    /itself/i
  );
  const archivedB = { ...noteB, meta: { ...noteB.meta, archivedAt: '2026-11-19T00:00:00Z' } };
  assert.throws(
    () => crossBook.planNoteBridgeOps(noteA, archivedB, [noteA, archivedB], [bookA, bookB], { mode: 'link' }),
    /archived/i
  );
  const spoilerB = { ...noteB, pos: 180, normalizedPos: 0.9 };
  assert.throws(
    () => crossBook.planNoteBridgeOps(noteA, spoilerB, [noteA, spoilerB], [bookA, bookB], { mode: 'link' }),
    /spoiler/i
  );
});

test('v2 selectDailyCollisionPair: deterministic per date, cross-book only, excludes linked & skipped', () => {
  const bookA = makeBook({ id: 'b-a', currentPos: 200, totalPos: 200, normalizedPos: 1, status: 'finished' });
  const bookB = makeBook({ id: 'b-b', currentPos: 200, totalPos: 200, normalizedPos: 1, status: 'finished' });
  const n1 = makeNote({ id: 'n1', slug: 'n1', bookId: 'b-a' });
  const n2 = makeNote({ id: 'n2', slug: 'n2', bookId: 'b-b' });
  const n3 = makeNote({ id: 'n3', slug: 'n3', bookId: 'b-b', meta: { relatedSlugs: ['n1'], attachments: [], links: [] } });

  const p1 = crossBook.selectDailyCollisionPair([n1, n2, n3], [bookA, bookB], '2026-11-20');
  assert.ok(p1);
  // n1 and n3 are already linked, so only (n1, n2) is eligible!
  assert.equal(p1.totalCandidates, 1);
  assert.equal(p1.pairKey, 'n1::n2');

  const pSkipped = crossBook.selectDailyCollisionPair([n1, n2, n3], [bookA, bookB], '2026-11-20', {
    skippedKeys: new Set(['n1::n2']),
  });
  assert.equal(pSkipped, null);
});

test('v2 capstonePrompt: appends spoiler-safe answered readingQuestions when present', () => {
  const book = makeBook({
    status: 'finished',
    normalizedPos: 1,
    meta: {
      updatedAt: '2026-11-20T00:00:00Z',
      readingQuestions: [
        {
          id: 'q_1',
          question: 'Where is the highest leverage point?',
          status: 'answered',
          answer: 'Shifting the unstated paradigm.',
          noteId: 'note-1',
          createdAt: '2026-11-01T00:00:00Z',
          answeredAt: '2026-11-15T00:00:00Z',
        },
        {
          id: 'q_2',
          question: 'Still open question',
          status: 'open',
          createdAt: '2026-11-01T00:00:00Z',
        },
      ],
    },
  });
  const note = makeNote({ id: 'note-1', meta: { title: 'Feedback Delays', attachments: [], links: [] } });
  const otherBookNote = makeNote({
    id: 'note-other',
    bookId: 'book-unfinished',
    meta: { title: 'SECRET OTHER BOOK NOTE', attachments: [], links: [] },
  });
  const archivedNote = makeNote({
    id: 'note-arch',
    bookId: 'book-1',
    meta: { title: 'ARCHIVED NOTE', archivedAt: '2026-11-10T00:00:00Z', attachments: [], links: [] },
  });
  const bookWithCrossRefs = {
    ...book,
    meta: {
      ...book.meta,
      readingQuestions: [
        ...book.meta.readingQuestions,
        {
          id: 'q_3',
          question: 'Cross-book note ref?',
          status: 'answered',
          answer: 'Still visible answer',
          noteId: 'note-other',
          createdAt: '2026-11-01T00:00:00Z',
          answeredAt: '2026-11-15T00:00:00Z',
        },
        {
          id: 'q_4',
          question: 'Archived note ref?',
          status: 'answered',
          answer: 'Visible answer too',
          noteId: 'note-arch',
          createdAt: '2026-11-01T00:00:00Z',
          answeredAt: '2026-11-15T00:00:00Z',
        },
      ],
    },
  };
  const prompt = capstonePrompt.buildCapstonePrompt(bookWithCrossRefs, [note, otherBookNote, archivedNote]);
  assert.ok(prompt.includes('Reading questions I answered along the way:'));
  assert.ok(prompt.includes('Where is the highest leverage point? (from: Feedback Delays)'));
  assert.ok(prompt.includes('A: Shifting the unstated paradigm.'));
  assert.equal(prompt.includes('Still open question'), false);
  assert.equal(prompt.includes('SECRET OTHER BOOK NOTE'), false);
  assert.equal(prompt.includes('ARCHIVED NOTE'), false);
});

test('v2 pickNextReadCandidates: opposite kind, shorter read, token tag/author spark, excludes archived book notes', () => {
  const refBook = makeBook({ id: 'b-ref', kind: 'nonfiction', status: 'finished', author: 'Donella Meadows' });
  const archivedBook = makeBook({
    id: 'b-arch',
    kind: 'fiction',
    status: 'reading',
    currentPos: 10,
    totalPos: 300,
    meta: { archivedAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' },
  });
  const q1 = makeBook({
    id: 'q-fic',
    title: 'The Lathe of Heaven',
    author: 'Ursula Le Guin',
    kind: 'fiction',
    status: 'queued',
    totalPos: 192,
    meta: { whyQueued: 'Recommended by Sam', updatedAt: '2026-11-01T00:00:00Z' },
  });
  const q2 = makeBook({
    id: 'q-short',
    title: 'Short Essay',
    author: 'Author B',
    kind: 'nonfiction',
    status: 'queued',
    totalPos: 110,
    meta: { updatedAt: '2026-11-01T00:00:00Z' },
  });
  const q3 = makeBook({
    id: 'q-author',
    title: 'Limits to Growth',
    author: 'Donella Meadows',
    kind: 'nonfiction',
    status: 'queued',
    totalPos: 340,
    meta: { updatedAt: '2026-11-01T00:00:00Z' },
  });
  const q4 = makeBook({
    id: 'q-false-substr',
    title: 'Sometimes Later',
    author: 'Author C',
    kind: 'nonfiction',
    status: 'queued',
    totalPos: 350,
    meta: { whyQueued: 'Read sometimes', updatedAt: '2026-11-01T00:00:00Z' },
  });
  const notes = [
    makeNote({ id: 'n-live', bookId: 'b-ref', tags: ['#time'], pos: 50, normalizedPos: 0.25 }),
    // Belongs to archived book -> must NOT leak #secret-tag
    makeNote({ id: 'n-arch-book', bookId: 'b-arch', tags: ['#sometimes'], pos: 250, normalizedPos: 0.9 }),
  ];

  const picks = readingMomentum.pickNextReadCandidates(
    [refBook, archivedBook, q1, q2, q3, q4],
    notes,
    refBook
  );
  assert.equal(picks.length, 3);
  assert.equal(picks[0].book.id, 'q-fic');
  assert.match(picks[0].reason, /Change of pace · Fiction/);
  assert.equal(picks[1].book.id, 'q-short');
  assert.match(picks[1].reason, /Shorter read · 110 pages/);
  assert.equal(picks[2].book.id, 'q-author');
  assert.match(picks[2].reason, /Same author · Donella Meadows/);
});

test('v2 collision skip storage: date pruning, corrupt JSON resilience, and account-switch cleanup', async () => {
  const storeMap = new Map();
  const mockStorage = {
    getItem: k => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => storeMap.set(k, v),
    removeItem: k => storeMap.delete(k),
  };

  crossBook.skipCollisionPairToday('a::b', '2026-11-20', mockStorage);
  assert.equal(crossBook.readSkippedCollisionKeys('2026-11-20', mockStorage).has('a::b'), true);
  // Next day prunes stale skips automatically
  assert.equal(crossBook.readSkippedCollisionKeys('2026-11-21', mockStorage).size, 0);
  assert.equal(storeMap.has(crossBook.COLLISION_SKIP_KEY), false);

  // Corrupt JSON does not throw
  mockStorage.setItem(crossBook.COLLISION_SKIP_KEY, '{bad-json');
  assert.equal(crossBook.readSkippedCollisionKeys('2026-11-21', mockStorage).size, 0);

  // clearCollisionSkipState removes key
  crossBook.skipCollisionPairToday('x::y', '2026-11-21', mockStorage);
  crossBook.clearCollisionSkipState(mockStorage);
  assert.equal(storeMap.has(crossBook.COLLISION_SKIP_KEY), false);

  // accountSession.clearPerAccountLocalData also clears COLLISION_SKIP_KEY
  const accountSession = await load('src/utils/accountSession.ts');
  localStorage.setItem(crossBook.COLLISION_SKIP_KEY, JSON.stringify({ date: '2026-11-21', skipped: ['a::b'] }));
  accountSession.clearPerAccountLocalData();
  assert.equal(localStorage.getItem(crossBook.COLLISION_SKIP_KEY), null);
});

test('v2 planNoteBridgeOps edge cases: why clearing, no-op ordering stability, 20-bridge cap, and one-way links', () => {
  const bookA = makeBook({ id: 'b-a', status: 'finished', normalizedPos: 1 });
  const bookB = makeBook({ id: 'b-b', status: 'finished', normalizedPos: 1 });
  const noteA = makeNote({
    id: 'na',
    slug: 'note-a',
    bookId: 'b-a',
    meta: {
      relatedSlugs: ['note-b', 'other-slug'],
      bridgeNotes: { 'note-b': 'Existing reason' },
      attachments: [],
      links: [],
    },
  });
  const noteB = makeNote({
    id: 'nb',
    slug: 'note-b',
    bookId: 'b-b',
    meta: { relatedSlugs: ['note-a'], bridgeNotes: { 'note-a': 'Existing reason' }, attachments: [], links: [] },
  });

  // Re-linking with unchanged canonical slug + undefined why is a true no-op (no reordering!)
  const noop = crossBook.planNoteBridgeOps(noteA, noteB, [noteA, noteB], [bookA, bookB], {
    mode: 'link',
    bidirectional: true,
  });
  assert.equal(noop.changed, false);

  // Passing why: '' clears bridgeNotes while preserving relatedSlugs order
  const cleared = crossBook.planNoteBridgeOps(noteA, noteB, [noteA, noteB], [bookA, bookB], {
    mode: 'link',
    bidirectional: false,
    why: '',
    nowIso: '2026-11-20T05:00:00Z',
  });
  assert.equal(cleared.changed, true);
  assert.equal(cleared.nextNotes.length, 1);
  assert.deepEqual(cleared.nextNotes[0].meta.relatedSlugs, ['note-b', 'other-slug']);
  assert.equal('bridgeNotes' in cleared.nextNotes[0].meta, false);

  // 20-bridge cap rejects a 21st distinct target
  const fullA = makeNote({
    id: 'na-full',
    slug: 'na-full',
    bookId: 'b-a',
    meta: {
      relatedSlugs: Array.from({ length: 20 }, (_, i) => `slug-${i}`),
      attachments: [],
      links: [],
    },
  });
  assert.throws(
    () => crossBook.planNoteBridgeOps(fullA, noteB, [fullA, noteB], [bookA, bookB], { mode: 'link' }),
    /at most 20/i
  );
});

test('v2 readingQuestions & computeSittingPace edge cases: ambiguous prefix, remove last -> undefined, loc/singular', () => {
  let raw = readingMomentum.addReadingQuestion([], 'First?', '2026-11-01T00:00:00Z', 'q_aa111111');
  raw = readingMomentum.addReadingQuestion(raw, 'Second?', '2026-11-01T00:00:00Z', 'q_aa222222');
  assert.throws(() => readingMomentum.answerReadingQuestion(raw, 'q_aa', { answer: 'Ambiguous' }), /not found/i);

  raw = readingMomentum.editReadingQuestion(raw, 'q_aa1', 'First edited?');
  assert.equal(metaCodecs.getBookReadingQuestions({ readingQuestions: raw })[0].question, 'First edited?');

  raw = readingMomentum.removeReadingQuestion(raw, 'q_aa1');
  assert.equal(raw.length, 1);
  const emptyAfterLast = readingMomentum.removeReadingQuestion(raw, 'q_aa2');
  assert.equal(emptyAfterLast, undefined);

  // Loc unit + singular sitting left + ignores non-positive deltas
  const locBook = makeBook({ id: 'b-loc', posUnit: 'loc', currentPos: 950, totalPos: 1000, status: 'reading' });
  const locPace = readingMomentum.computeSittingPace(locBook, [
    { id: 'l0', bookId: 'b-loc', date: '2026-11-01', startPos: 100, endPos: 100, updatedAt: '2026-11-01T10:00:00Z', note: '' },
    { id: 'l1', bookId: 'b-loc', date: '2026-11-02', startPos: 100, endPos: 200, updatedAt: '2026-11-02T10:00:00Z', note: '' },
    { id: 'l2', bookId: 'b-loc', date: '2026-11-03', startPos: 200, endPos: 300, updatedAt: '2026-11-03T10:00:00Z', note: '' },
  ]);
  assert.ok(locPace);
  assert.equal(locPace.sittingsLeft, 1);
  assert.match(locPace.label, /~100 locs a sitting · about 1 sitting left/);
  assert.equal(readingMomentum.computeSittingPace({ ...locBook, status: 'paused' }, []), null);
});

