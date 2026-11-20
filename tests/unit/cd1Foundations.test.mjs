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
 * CD Batch 1a — data-safe foundations: tz-safe + staleness-weighted Takeaway Shuffle,
 * `Do not …` delta fix (TS ⇄ Python parity on a shared fixture), soft-archive helpers,
 * and draft detection for the logout confirmation.
 */

// C5.1 acceptance runs under a fixed US-Pacific zone (Node re-reads TZ at runtime).
process.env.TZ = 'America/Los_Angeles';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const {
  toLocalDateKey,
  getCalendarDaysBetween,
  isEligibleForShuffle,
  selectTakeawayShuffle,
  shuffleStalenessBucket,
  shuffleProvenanceLabel,
} = await load('src/utils/takeawayShuffle.ts');
const { stripDoPrefix, normalizeDeltaAction, normalizeDeltaTrigger, formatWhenDoDisplay } = await load(
  'src/utils/deltaFormat.ts'
);
const {
  isArchived,
  withoutArchived,
  onlyArchived,
  archivedDateLabel,
  buildArchivedBook,
  buildRestoredBook,
  buildArchivedNote,
  buildRestoredNote,
} = await load('src/utils/archive.ts');
const { filterWikilinkCandidates, getPracticeDeltaLists } = await load('src/utils/noteVisibility.ts');
const { normalizeBookMeta, normalizeNoteMeta, mergeUnknownMetaKeys, NOTE_ARCHIVE_OWNED_META_KEYS } =
  await load('src/utils/metaCodecs.ts');
const draftStorage = await load('src/utils/draftStorage.ts');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/cd1_parity.json'), 'utf8'));

const book = {
  id: 'b1', title: 'T', author: 'A', format: 'physical', kind: 'nonfiction', status: 'finished',
  currentPos: 200, totalPos: 200, posUnit: 'page', normalizedPos: 1, docUrl: '', meta: { updatedAt: 'x' },
};
const note = (o = {}) => ({
  id: 'n1', bookId: 'b1', slug: 'n1', status: 'saved', pos: 10, normalizedPos: 0.05, takeaway: 't', quote: '',
  tags: [], createdAt: '2026-01-01T12:00:00Z', updatedAt: '2026-01-01T12:00:00Z', deltaStatus: 'none',
  deltaTrigger: '', deltaAction: '', contextMechanism: '', critique: '', source: 'app', meta: { attachments: [], links: [] }, ...o,
});

test('C5.1 toLocalDateKey: date-only passes through; ISO converts to the LOCAL date (LA)', () => {
  assert.equal(toLocalDateKey('2026-11-17'), '2026-11-17');
  assert.equal(toLocalDateKey('2026-11-17T06:30:00Z'), '2026-11-16');
  assert.equal(toLocalDateKey('2026-11-17T06:30:00.000Z'), '2026-11-16');
  assert.equal(toLocalDateKey('2026-11-17T06:30:00'), '2026-11-16', 'offset-less timestamps are UTC (CLI parity)');
  assert.equal(toLocalDateKey('2026-11-17T06:30:00+05:30'), '2026-11-16');
  assert.equal(toLocalDateKey(''), null);
  assert.equal(toLocalDateKey(undefined), null);
  assert.equal(toLocalDateKey('garbage'), null);
});

test('C5.1 a review at 06:30Z (= yesterday local) does NOT hide the note on local today', () => {
  const n = note({ meta: { attachments: [], links: [], lastReviewedAt: '2026-11-17T06:30:00Z' } });
  assert.equal(isEligibleForShuffle(n, book, '2026-11-17'), true);
  assert.equal(isEligibleForShuffle(n, book, '2026-11-16'), false, 'hidden on the local review day');
  // Date-only values behave exactly as before.
  const d = note({ meta: { attachments: [], links: [], lastReviewedAt: '2026-11-17' } });
  assert.equal(isEligibleForShuffle(d, book, '2026-11-17'), false);
  assert.equal(isEligibleForShuffle(d, book, '2026-11-18'), true);
});

test('C5.1 createdAt age uses the local date: 03:00Z on 11-03 (= 11-02 local) is 14 days old on 11-16', () => {
  assert.equal(getCalendarDaysBetween('2026-11-03T03:00:00Z', '2026-11-16'), 14);
  const n = note({ createdAt: '2026-11-03T03:00:00Z' });
  assert.equal(isEligibleForShuffle(n, book, '2026-11-16'), true);
  assert.equal(isEligibleForShuffle(note({ createdAt: '2026-11-03T09:00:00Z' }), book, '2026-11-16'), false);
});

test('C5.2 staleness buckets and the shared TS ⇄ Python fixture order', () => {
  const fx = fixture.shuffle;
  for (const [id, bucket] of Object.entries(fx.expectedBuckets)) {
    assert.equal(shuffleStalenessBucket(fx.notes.find(n => n.id === id), fx.today), bucket, id);
  }
  const ids = selectTakeawayShuffle(fx.notes, fx.books, fx.today, 10).map(n => n.id);
  assert.deepEqual(ids, fx.expectedOrder);
  // Deterministic regardless of input order.
  const reversed = selectTakeawayShuffle([...fx.notes].reverse(), fx.books, fx.today, 10).map(n => n.id);
  assert.deepEqual(reversed, fx.expectedOrder);
  // Never-reviewed always ahead of reviewed-3-days-ago, whatever the hash says.
  assert.ok(ids.indexOf('n-never-a') < ids.indexOf('n-recent'));
  assert.ok(ids.indexOf('n-never-b') < ids.indexOf('n-recent'));
});

test('C5 provenance line: "First revisit · saved MMM YYYY" / "Last revisited …"', () => {
  assert.equal(shuffleProvenanceLabel(note({ createdAt: '2025-03-04T12:00:00Z' }), '2026-11-17'), 'First revisit · saved Mar 2025');
  const r = (v) => note({ meta: { attachments: [], links: [], lastReviewedAt: v } });
  assert.equal(shuffleProvenanceLabel(r('2026-02-09'), '2026-11-17'), 'Last revisited Feb 9');
  assert.equal(shuffleProvenanceLabel(r('2025-12-30'), '2026-11-17'), 'Last revisited Dec 2025');
  for (const label of [shuffleProvenanceLabel(r('2026-11-10'), '2026-11-17')]) {
    assert.ok(!/ago|overdue|\d+ days/i.test(label));
  }
});

test('C5.3 DO prefix parity table (shared with Python); WHEN unchanged', () => {
  for (const [input, expected] of fixture.doPrefix) {
    assert.equal(stripDoPrefix(input), expected, JSON.stringify(input));
    assert.equal(normalizeDeltaAction(input), expected, JSON.stringify(input));
  }
  assert.equal(normalizeDeltaTrigger('WHEN WHEN tired'), 'tired');
  assert.equal(formatWhenDoDisplay('', 'DO Do not refresh dashboards mid-incident').doLine, 'DO Do not refresh dashboards mid-incident');
});

test('C1.1 isArchived / list helpers / banner date', () => {
  const a = note({ id: 'a', meta: { attachments: [], links: [], archivedAt: '2026-02-01T10:00:00Z' } });
  const b = note({ id: 'b' });
  const blank = note({ id: 'c', meta: { attachments: [], links: [], archivedAt: '  ' } });
  assert.equal(isArchived(a), true);
  assert.equal(isArchived(b), false);
  assert.equal(isArchived(blank), false);
  assert.equal(isArchived(null), false);
  assert.deepEqual(withoutArchived([a, b, blank]).map(n => n.id), ['b', 'c']);
  assert.deepEqual(onlyArchived([a, b]).map(n => n.id), ['a']);
  assert.equal(archivedDateLabel(a), '2026-02-01');
  // Default surfaces drop archived notes.
  assert.deepEqual(filterWikilinkCandidates([a, b], [book], '').map(n => n.id), ['b']);
  const lists = getPracticeDeltaLists(
    [note({ id: 'x', deltaStatus: 'active' }), note({ id: 'y', deltaStatus: 'paused', meta: { attachments: [], links: [], archivedAt: 'z' } })],
    new Map([['b1', book]])
  );
  assert.deepEqual(lists.active.map(n => n.id), ['x']);
  assert.deepEqual(lists.archived.map(n => n.id), []);
  assert.equal(selectTakeawayShuffle([a], [book], '2026-11-17').length, 0);
});

test('C1.1 archive/restore builders: book keeps every other key; note pauses + restores its delta under the cap', () => {
  const b = { ...book, meta: { updatedAt: 'u', capstone: { arcOrThesis: 'x', extra: 1 }, subgenre: 'sf' } };
  const archived = buildArchivedBook(b, '2026-03-01T00:00:00.000Z');
  assert.equal(archived.meta.archivedAt, '2026-03-01T00:00:00.000Z');
  assert.deepEqual(archived.meta.capstone, { arcOrThesis: 'x', extra: 1 });
  const restored = buildRestoredBook(archived);
  assert.equal('archivedAt' in restored.meta, false);
  assert.equal(restored.meta.subgenre, 'sf');

  const n = note({ status: 'atomic', deltaStatus: 'active', meta: { attachments: [], links: [], sparStage: { s: 2 } } });
  const { note: an, pausedDelta } = buildArchivedNote(n, 'T');
  assert.equal(pausedDelta, true);
  assert.equal(an.deltaStatus, 'paused');
  assert.equal(an.meta.archivedDeltaStatus, 'active');
  assert.deepEqual(an.meta.sparStage, { s: 2 });
  const ok = buildRestoredNote(an, 4);
  assert.equal(ok.note.deltaStatus, 'active');
  assert.equal(ok.reactivated, true);
  assert.equal('archivedAt' in ok.note.meta || 'archivedDeltaStatus' in ok.note.meta, false);
  const capped = buildRestoredNote(an, 5);
  assert.equal(capped.note.deltaStatus, 'paused');
  assert.equal(capped.capped, true);
  // A note archived with a paused delta restores as paused.
  const plain = buildArchivedNote(note({ deltaStatus: 'paused' }), 'T');
  assert.equal(plain.pausedDelta, false);
  assert.equal(buildRestoredNote(plain.note, 0).note.deltaStatus, 'paused');
});

test('C1.1 archivedAt / archivedDeltaStatus survive the meta codecs and the owned-key merge', () => {
  assert.equal(normalizeBookMeta({ updatedAt: 'u', archivedAt: '2026-01-01T00:00:00Z' }).archivedAt, '2026-01-01T00:00:00Z');
  const nm = normalizeNoteMeta({ archivedAt: '2026-01-01', archivedDeltaStatus: 'active', mystery: { k: 1 } });
  assert.equal(nm.archivedAt, '2026-01-01');
  assert.equal(nm.archivedDeltaStatus, 'active');
  assert.deepEqual(nm.mystery, { k: 1 });
  // Restore deletes archive keys (owned) while a newer unknown key from the latest row wins.
  const merged = mergeUnknownMetaKeys({ title: 'stale' }, { title: 'fresh', archivedAt: 'x', sparStage: 'B' }, NOTE_ARCHIVE_OWNED_META_KEYS);
  assert.equal('archivedAt' in merged, false);
  assert.equal(merged.sparStage, 'B');
  assert.equal(merged.title, 'fresh');
});

test('C1.3 hasAnyDraft / describeDrafts for the logout confirmation', () => {
  localStorage.clear();
  try {
    assert.equal(draftStorage.hasAnyDraft(), false);
    assert.equal(draftStorage.describeDrafts(), '');
    localStorage.setItem('unrelated', '1');
    assert.equal(draftStorage.hasAnyDraft(), false);
    draftStorage.writeDraft(draftStorage.CAPTURE_DRAFT_KEY, { bookId: 'b' });
    draftStorage.writeDraft(draftStorage.getCapstoneDraftKey('b1'), { arcOrThesis: 'x' });
    draftStorage.writeDraft(draftStorage.getEditNoteDraftKey('n1'), { title: 'x' });
    assert.equal(draftStorage.hasAnyDraft(), true);
    assert.equal(draftStorage.describeDrafts(), 'a capture, a note edit, a Whole-Book Picture');
    draftStorage.clearAllDrafts();
    assert.equal(draftStorage.hasAnyDraft(), false);
  } finally {
    localStorage.clear();
  }
});

// ---- CD 1a fix-up -------------------------------------------------------------------

const { countOtherActiveDeltas, noteDisplayTitle } = await load('src/utils/archive.ts');
const { capstoneEligibleNotes, countCapstoneEligibleNotes } = await load('src/utils/capstonePrompt.ts');

test('Fix-up R1#1: drafts are scoped per account; Demo never sees or wipes real drafts', () => {
  localStorage.clear();
  const ds = draftStorage;
  const signIn = email => {
    localStorage.removeItem('pragya_mock_mode');
    localStorage.removeItem('pragya_mock_session');
    localStorage.setItem('pragya_google_user', JSON.stringify({ email }));
  };
  const demoIn = () => {
    localStorage.removeItem('pragya_google_user');
    localStorage.setItem('pragya_mock_mode', 'true');
    localStorage.setItem('pragya_mock_session', '{"email":"demo@pragya.local"}');
  };
  try {
    assert.equal(ds.currentDraftScope(), null);
    signIn('Reader@Pragya.dev');
    const scope = ds.currentDraftScope();
    assert.match(scope, /^u[0-9a-z]+$/);
    assert.equal(scope, ds.accountDraftScope(' reader@pragya.dev '), 'case/whitespace-insensitive');
    ds.writeDraft(ds.CAPTURE_DRAFT_KEY, { takeaway: 'REAL' });
    assert.ok(localStorage.getItem(`pragya_draft:${scope}:pragya_draft_capture_v1`));
    assert.equal(localStorage.getItem(ds.CAPTURE_DRAFT_KEY), null, 'no unscoped write');
    assert.ok(!Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).some(k => k.includes('reader@')), 'raw email never in keys');
    assert.equal(ds.describeDrafts(), 'a capture');

    demoIn();
    assert.equal(ds.currentDraftScope(), 'demo');
    assert.equal(ds.readDraft(ds.CAPTURE_DRAFT_KEY), null);
    assert.equal(ds.hasAnyDraft(), false);
    ds.writeDraft(ds.CAPTURE_DRAFT_KEY, { takeaway: 'DEMO' });
    ds.clearAllDrafts({ scope: ds.DEMO_DRAFT_SCOPE }); // Demo logout / Reset Demo
    assert.equal(ds.readDraft(ds.CAPTURE_DRAFT_KEY), null);

    signIn('reader@pragya.dev');
    assert.deepEqual(ds.readDraft(ds.CAPTURE_DRAFT_KEY), { takeaway: 'REAL' }, 'survives logout → Demo → re-login');

    signIn('other@pragya.dev');
    assert.equal(ds.readDraft(ds.CAPTURE_DRAFT_KEY), null, 'another account never sees them');

    ds.clearAllDrafts({ scope: 'current' });
    signIn('reader@pragya.dev');
    assert.ok(ds.readDraft(ds.CAPTURE_DRAFT_KEY), "clearing another scope keeps this one");
    ds.clearAllDrafts(); // default 'all' (account-switch wipe / explicit Discard)
    assert.equal(ds.hasAnyDraft(), false);
    assert.ok(!Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).some(k => k.startsWith('pragya_draft')));
  } finally {
    localStorage.clear();
  }
});

test('Fix-up R1#1: legacy unscoped drafts are adopted only by the last-account match', async () => {
  localStorage.clear();
  const { adoptLegacyDraftsForAccount } = await load('src/utils/accountSession.ts');
  try {
    localStorage.setItem('pragya_draft_capture_v1', JSON.stringify({ takeaway: 'LEGACY' }));
    localStorage.setItem('pragya_draft_edit_n1', JSON.stringify({ title: 'L' }));
    localStorage.setItem('pragya_last_account_email', 'reader@pragya.dev');
    assert.equal(adoptLegacyDraftsForAccount('someone-else@pragya.dev'), 0);
    assert.ok(localStorage.getItem('pragya_draft_capture_v1'), 'non-matching account adopts nothing');
    const scope = draftStorage.accountDraftScope('reader@pragya.dev');
    localStorage.setItem(`pragya_draft:${scope}:pragya_draft_edit_n1`, JSON.stringify({ title: 'NEWER' }));
    assert.equal(adoptLegacyDraftsForAccount('Reader@pragya.dev'), 1);
    assert.equal(localStorage.getItem('pragya_draft_capture_v1'), null);
    assert.equal(localStorage.getItem('pragya_draft_edit_n1'), null);
    assert.deepEqual(JSON.parse(localStorage.getItem(`pragya_draft:${scope}:pragya_draft_capture_v1`)), { takeaway: 'LEGACY' });
    assert.deepEqual(JSON.parse(localStorage.getItem(`pragya_draft:${scope}:pragya_draft_edit_n1`)), { title: 'NEWER' }, 'existing scoped draft wins');
  } finally {
    localStorage.clear();
  }
});

test('Fix-up R1#3: archived notes never count toward the 5-delta cap', () => {
  const act = (id, archived = false) =>
    note({ id, deltaStatus: 'active', meta: { attachments: [], links: [], ...(archived ? { archivedAt: 'x' } : {}) } });
  const list = [act('a'), act('b'), act('c', true), act('d'), note({ id: 'e', deltaStatus: 'paused' })];
  assert.equal(countOtherActiveDeltas(list, 'zz'), 3);
  assert.equal(countOtherActiveDeltas(list, 'a'), 2);
});

test('Fix-up QA-27 / R1#2: capstone prompt excludes archived notes', () => {
  const fin = { ...book, kind: 'nonfiction', status: 'finished' };
  const notes = [note({ id: 'v', takeaway: 'VISIBLE' }), note({ id: 'h', takeaway: 'HIDDEN', meta: { attachments: [], links: [], archivedAt: 'x' } })];
  assert.deepEqual(capstoneEligibleNotes(fin, notes).map(n => n.id), ['v']);
  assert.equal(countCapstoneEligibleNotes(fin, notes), 1);
});

test('Fix-up R2 nit: noteDisplayTitle → title, else 8 takeaway words, else slug', () => {
  assert.equal(noteDisplayTitle(note({ meta: { title: ' Loops ' } })), 'Loops');
  assert.equal(noteDisplayTitle(note({ slug: 's', takeaway: 'Wait out the lag.' })), 'Wait out the lag');
  assert.equal(noteDisplayTitle(note({ takeaway: 'one two three four five six seven eight nine' })), 'one two three four five six seven eight…');
  assert.equal(noteDisplayTitle(note({ slug: 'the-slug', takeaway: '' })), 'the-slug');
});
