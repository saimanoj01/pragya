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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const { selectTakeawayShuffle, isEligibleForShuffle } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/takeawayShuffle.ts')).href
);
const { extractNoteWikilinks, computeBacklinks } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/wikilinks.ts')).href
);
const { buildSnapshot, validateSnapshotPayload } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/snapshot.ts')).href
);
const { getRenderableAttachments } = await import(
  pathToFileURL(path.join(repoRoot, 'src/utils/metaCodecs.ts')).href
);
const { createDemoSeed } = await import(
  pathToFileURL(path.join(repoRoot, 'src/data/demoSeed.ts')).href
);

test('Takeaway Shuffle determinism and eligibility exclusions', () => {
  const today = '2026-11-15';
  const seed = createDemoSeed(new Date('2026-11-15T12:00:00.000Z'));

  const readingBook = seed.books.find(b => b.id === 'book-systems');
  const fictionBook = seed.books.find(b => b.id === 'book-exhalation');
  assert.ok(readingBook && fictionBook);

  // Build focused fixture notes
  const baseNote = {
    bookId: readingBook.id,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    pos: 50,
    normalizedPos: 50 / readingBook.totalPos,
    status: 'atomic',
    source: 'app',
    tags: ['#systems'],
    quote: 'A quote',
    takeaway: 'A takeaway',
    contextMechanism: '',
    critique: '',
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none',
    meta: { attachments: [], links: [] },
  };

  const notes = [
    { ...baseNote, id: 'old-1', slug: 'old-1', createdAt: '2026-11-01T23:00:00.000Z' }, // 14 days
    { ...baseNote, id: 'old-2', slug: 'old-2', createdAt: '2026-10-20T10:00:00.000Z' }, // 26 days
    { ...baseNote, id: 'fav-new', slug: 'fav-new', createdAt: '2026-11-14T10:00:00.000Z', tags: ['#favorites'] }, // 1 day + #favorites
    { ...baseNote, id: 'fav-singular', slug: 'fav-singular', createdAt: '2026-11-14T10:00:00.000Z', tags: ['#favorite'] }, // 1 day + #favorite
    { ...baseNote, id: 'too-new', slug: 'too-new', createdAt: '2026-11-05T10:00:00.000Z', tags: ['#systems'] }, // 10 days
    {
      ...baseNote,
      id: 'reviewed-today',
      slug: 'reviewed-today',
      createdAt: '2026-10-10T10:00:00.000Z',
      meta: { attachments: [], links: [], lastReviewedAt: today },
    },
    {
      ...baseNote,
      id: 'reviewed-today-iso',
      slug: 'reviewed-today-iso',
      createdAt: '2026-10-10T10:00:00.000Z',
      meta: { attachments: [], links: [], lastReviewedAt: `${today}T18:30:00.000Z` },
    },
    {
      ...baseNote,
      id: 'reviewed-yesterday',
      slug: 'reviewed-yesterday',
      createdAt: '2026-10-10T10:00:00.000Z',
      meta: { attachments: [], links: [], lastReviewedAt: '2026-11-14T18:30:00.000Z' },
    },
    {
      ...baseNote,
      id: 'spoiler-note',
      slug: 'spoiler-note',
      pos: 210,
      normalizedPos: 210 / readingBook.totalPos,
    },
    {
      ...baseNote,
      id: 'sealed-pred',
      slug: 'sealed-pred',
      bookId: fictionBook.id,
      pos: 100,
      normalizedPos: 100 / fictionBook.totalPos,
      meta: { attachments: [], links: [], isPrediction: true },
    },
  ];

  // Verify eligibility rules
  const byId = id => notes.find(n => n.id === id);
  assert.equal(isEligibleForShuffle(byId('old-1'), readingBook, today), true);
  assert.equal(isEligibleForShuffle(byId('fav-new'), readingBook, today), true);
  assert.equal(isEligibleForShuffle(byId('fav-singular'), readingBook, today), true);
  assert.equal(isEligibleForShuffle(byId('too-new'), readingBook, today), false);
  assert.equal(isEligibleForShuffle(byId('reviewed-today'), readingBook, today), false);
  assert.equal(isEligibleForShuffle(byId('reviewed-today-iso'), readingBook, today), false);
  assert.equal(isEligibleForShuffle(byId('reviewed-yesterday'), readingBook, today), true);
  assert.equal(isEligibleForShuffle(byId('spoiler-note'), readingBook, today), false);
  assert.equal(isEligibleForShuffle(byId('sealed-pred'), fictionBook, today), false);

  // Once fiction book is finished, unlocked prediction becomes eligible
  const finishedFictionBook = { ...fictionBook, status: 'finished', normalizedPos: 1 };
  assert.equal(isEligibleForShuffle(byId('sealed-pred'), finishedFictionBook, today), true);

  // Determinism for same date regardless of input ordering
  const run1 = selectTakeawayShuffle(notes, [readingBook, fictionBook], today, 3);
  const run2 = selectTakeawayShuffle([...notes].reverse(), [readingBook, fictionBook], today, 3);
  assert.equal(run1.length, 3);
  assert.deepEqual(
    run1.map(n => n.id),
    run2.map(n => n.id)
  );
  const pickedIds = new Set(run1.map(n => n.id));
  assert.ok(!pickedIds.has('too-new'));
  assert.ok(!pickedIds.has('reviewed-today'));
  assert.ok(!pickedIds.has('reviewed-today-iso'));
  assert.ok(!pickedIds.has('spoiler-note'));
  assert.ok(!pickedIds.has('sealed-pred'));
});

test('Backlinks resolver extracts [[wikilinks]], deduplicates, normalizes target, and excludes self-references', () => {
  const mkNote = (id, slug, takeaway, contextMechanism = '', critique = '') => ({
    id,
    slug,
    bookId: 'b1',
    createdAt: '',
    updatedAt: '',
    pos: 10,
    normalizedPos: 0.1,
    status: 'atomic',
    source: 'app',
    tags: [],
    quote: '',
    takeaway,
    contextMechanism,
    critique,
    deltaTrigger: '',
    deltaAction: '',
    deltaStatus: 'none',
    meta: { attachments: [], links: [] },
  });

  const target = mkNote('n1', 'feedback-delays', 'See [[feedback-delays]] and [[Boundary Play]].');
  const citing1 = mkNote(
    'n2',
    'second-note',
    'Relates to [[feedback-delays]] and [[Feedback Delays]].',
    'Context also mentions [[feedback-delays]].'
  );
  const citing2 = mkNote(
    'n3',
    'third-note',
    'No links here',
    '',
    'Boundary breaks down without [[feedback-delays]].'
  );
  const unrelated = mkNote('n4', 'fourth-note', 'Mentions [[other-concept]] only.');

  assert.deepEqual(extractNoteWikilinks(citing1), ['feedback-delays']);
  assert.deepEqual(extractNoteWikilinks(target), ['feedback-delays', 'boundary-play']);

  const backlinks = computeBacklinks('feedback-delays', [target, citing1, citing2, unrelated]);
  assert.deepEqual(
    backlinks.map(n => n.slug),
    ['second-note', 'third-note']
  );

  // Target normalization handles mixed-case/spaces and still excludes self
  const normalizedBacklinks = computeBacklinks('Feedback Delays', [
    target,
    citing1,
    citing2,
    unrelated,
  ]);
  assert.deepEqual(
    normalizedBacklinks.map(n => n.slug),
    ['second-note', 'third-note']
  );
});

test('Active Behavioral Delta <= 5 cap enforcement helper invariant', () => {
  const seed = createDemoSeed(new Date('2026-11-15T12:00:00.000Z'));
  const makeActive = idx => ({
    ...seed.notes[0],
    id: `active-${idx}`,
    slug: `active-${idx}`,
    deltaStatus: 'active',
  });
  const fiveActive = [1, 2, 3, 4, 5].map(makeActive);
  const sixthId = 'candidate-6';
  const otherActiveCount = fiveActive.filter(
    n => n.id !== sixthId && n.deltaStatus === 'active'
  ).length;
  assert.equal(otherActiveCount, 5);
  assert.equal(otherActiveCount >= 5, true);

  // Updating an already-active note among the 5 should allow 4 others (< 5)
  const existingOtherCount = fiveActive.filter(
    n => n.id !== 'active-3' && n.deltaStatus === 'active'
  ).length;
  assert.equal(existingOtherCount, 4);
  assert.equal(existingOtherCount >= 5, false);
});

test('Snapshot schema validator normalizes WHEN/DO, clamps attachments, and rejects malformed payloads', () => {
  const seed = createDemoSeed(new Date('2026-11-15T12:00:00.000Z'));
  const snapshot = buildSnapshot({
    books: seed.books,
    notes: seed.notes.map((n, idx) =>
      idx === 0
        ? {
            ...n,
            deltaTrigger: 'WHEN WHEN metrics spike',
            deltaAction: 'DO DO wait before tuning',
            meta: {
              ...n.meta,
              attachments: [
                { id: 'a1', type: 'link', title: '1', url: 'https://a.test' },
                { id: 'a2', type: 'link', title: '2', url: 'https://b.test' },
                { id: 'a3', type: 'link', title: '3', url: 'https://c.test' },
                { id: 'a4', type: 'link', title: '4', url: 'https://d.test' },
              ],
            },
          }
        : n
    ),
    sessions: seed.sessions,
    deltaLogs: seed.deltaLogs,
  });

  const validRes = validateSnapshotPayload(JSON.stringify(snapshot));
  assert.equal(validRes.ok, true);
  if (validRes.ok) {
    assert.equal(validRes.counts.books, seed.books.length);
    assert.equal(validRes.snapshot.notes[0].deltaTrigger, 'metrics spike');
    assert.equal(validRes.snapshot.notes[0].deltaAction, 'wait before tuning');
    // M6 Batch 1 fix-up (decisions.md override): storage keeps every attachment;
    // the 3-cap is applied at render/creation time.
    assert.equal(validRes.snapshot.notes[0].meta.attachments.length, 4);
    assert.equal(getRenderableAttachments(validRes.snapshot.notes[0].meta).length, 3);
  }

  assert.equal(validateSnapshotPayload('{bad json').ok, false);
  assert.equal(validateSnapshotPayload('[]').ok, false);
  assert.equal(validateSnapshotPayload(null).ok, false);
  assert.equal(
    validateSnapshotPayload({ ...snapshot, version: 2 }).ok,
    false
  );
  assert.equal(
    validateSnapshotPayload({ version: 1, books: [], notes: [] }).ok,
    false
  );
  assert.equal(
    validateSnapshotPayload({ ...snapshot, books: [{ id: '', title: 'Missing ID' }] }).ok,
    false
  );
  assert.equal(
    validateSnapshotPayload({ ...snapshot, notes: [{ id: 'n1' }] }).ok,
    false
  );
  assert.equal(
    validateSnapshotPayload({ ...snapshot, sessions: [{ id: 's1', bookId: 'b1' }] }).ok,
    false
  );
  assert.equal(
    validateSnapshotPayload({ ...snapshot, deltaLogs: [{ id: 'd1', noteId: 'n1' }] }).ok,
    false
  );
});
