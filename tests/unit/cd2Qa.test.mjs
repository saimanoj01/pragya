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
 * QA (CD Batch 2) — adversarial probes: check-in coalescing TS ⇄ Python parity, Kindle
 * cleanup on dialogue / apostrophes, citation-% from prose with pipes, Save & Next edges,
 * capture preselect edges, sparring-prompt spoiler safety, IME-safe shortcut, draft
 * attachment validation per account scope.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const ci = await load('src/utils/deltaCheckIn.ts');
const kp = await load('src/utils/kindlePaste.ts');
const { nextInboxNote } = await load('src/utils/deepenFlow.ts');
const { resolveCaptureBookId } = await load('src/utils/captureContext.ts');
const { buildSparringPrompt } = await load('src/utils/sparringPrompt.ts');
const { isSubmitShortcut } = await load('src/utils/keyboard.ts');
const ds = await load('src/utils/draftStorage.ts');

const book = (o = {}) => ({
  id: 'b1', title: 'Exhalation', author: 'Ted Chiang', format: 'physical', kind: 'fiction', status: 'reading',
  currentPos: 100, totalPos: 300, posUnit: 'page', normalizedPos: 0.33, docUrl: '', meta: {}, ...o,
});
const note = (id, o = {}) => ({
  id, slug: `slug-${id}`, bookId: 'b1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  pos: 10, normalizedPos: 0.03, status: 'inbox', source: 'app', tags: [], quote: '', takeaway: `take ${id}`,
  contextMechanism: '', critique: '', deltaTrigger: '', deltaAction: '', deltaStatus: 'none', meta: {}, ...o,
});

test('QA CD2: planDeltaCheckIn ⇄ plan_delta_checkin parity (append / update / unchanged, legacy dups, date shapes)', () => {
  const logs = [
    { id: 'old', noteId: 'n1', date: '2026-11-17', outcome: 'applied', reflection: 'yesterday' },
    { id: 'dup1', noteId: 'n2', date: '2026-11-18', outcome: 'missed', reflection: 'first' },
    { id: 'dup2', noteId: 'n2', date: '2026-11-18', outcome: 'applied', reflection: 'second' },
    { id: 'ts', noteId: 'n3', date: '2026-11-18T23:30:00', outcome: 'no-trigger', reflection: 'r3' },
    { id: 'pad', noteId: 'n4', date: ' 2026-11-18 ', outcome: 'missed', reflection: '' },
    { id: 'other', noteId: 'n5', date: '2026-11-18', outcome: 'applied', reflection: '' },
  ];
  const cases = [
    ['n1', 'applied'], ['n1', 'missed'], ['n2', 'applied'], ['n2', 'missed'], ['n2', 'no-trigger'],
    ['n3', 'no-trigger'], ['n3', 'applied'], ['n4', 'missed'], ['n4', 'applied'], ['n6', 'applied'],
  ];
  const today = '2026-11-18';
  const ts = cases.map(([noteId, outcome]) => {
    const p = ci.planDeltaCheckIn(logs, noteId, today, outcome, 'NEW');
    return { kind: p.kind, id: p.log.id, outcome: p.log.outcome, reflection: p.log.reflection, prev: p.kind === 'update' ? p.previous.id : null };
  });
  const py = spawnSync(
    'python3',
    ['-c', `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("cli", "scripts/pragya_cli.py")
cli = importlib.util.module_from_spec(spec); sys.modules["cli"] = cli; spec.loader.exec_module(cli)
d = json.load(sys.stdin)
out = []
for note_id, outcome in d["cases"]:
    p = cli.plan_delta_checkin(d["logs"], note_id, d["today"], outcome, "NEW")
    out.append({"kind": p["kind"], "id": p["log"]["id"], "outcome": p["log"]["outcome"], "reflection": p["log"]["reflection"], "prev": p["previous"]["id"] if p["kind"] == "update" else None})
print(json.dumps(out))
`],
    { cwd: repoRoot, input: JSON.stringify({ logs, cases, today }), encoding: 'utf8' }
  );
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), ts);
  // Spot checks of the contract.
  assert.equal(ts[0].kind, 'append', "yesterday's row never coalesces");
  assert.equal(ts[2].kind, 'unchanged');
  assert.equal(ts[3].prev, 'dup2', 'legacy duplicates → the LAST row is updated');
  assert.equal(ts[3].reflection, 'second', 'reflection kept on update');
  assert.equal(ts[6].kind, 'update', 'local-timestamp date coalesces by its date part');
  assert.equal(ts[8].kind, 'update', 'padded date coalesces');
});

test('QA CD2: check-in history is newest-first, capped at 10, other notes excluded', () => {
  const logs = [];
  for (let d = 1; d <= 12; d += 1) logs.push({ id: `l${d}`, noteId: 'n1', date: `2026-11-${String(d).padStart(2, '0')}`, outcome: 'applied', reflection: '' });
  logs.push({ id: 'x', noteId: 'n2', date: '2026-11-30', outcome: 'missed', reflection: '' });
  const h = ci.recentDeltaHistory(logs, 'n1');
  assert.equal(h.length, 10);
  assert.equal(h[0].id, 'l12');
  assert.ok(!h.some(l => l.noteId !== 'n1'));
});

// CD 2 fix-up: QA-34 fixed (unwrapOuterQuotes) — converted from `todo` to a real test.
test('QA-34: Kindle cleanup must not strip quote marks that belong to the highlighted text (dialogue / apostrophes)', () => {
  const cite = 'Your Highlight on page 12 | Location 180-181 | Added on Monday';
  assert.equal(kp.stripKindleBoilerplate(`“Run,” she said. “Now.”\n${cite}`).text, '“Run,” she said. “Now.”');
  assert.equal(kp.stripKindleBoilerplate(`${cite}\n'Tis the season`).text, "'Tis the season");
  assert.equal(kp.stripKindleBoilerplate(`${cite}\nHe said “stop.”`).text, 'He said “stop.”');
});

test('QA CD2: Kindle cleanup keeps prose; a fully-wrapped highlight is unwrapped; boilerplate-only stays raw', () => {
  const cite = 'Your Highlight on page 12 | Added on Monday';
  assert.deepEqual(kp.stripKindleBoilerplate('Plain prose, no citation.'), { text: 'Plain prose, no citation.', cleaned: false });
  assert.equal(kp.stripKindleBoilerplate(`${cite}\n"Whole quote"`).text, 'Whole quote');
  assert.equal(kp.stripKindleBoilerplate(`${cite}\n==========`).cleaned, false, 'nothing left → raw kept');
  assert.equal(kp.pickCitationHint('Growth was 40% faster than expected', 'percent'), null, 'prose % ignored');
  // CD 2 fix-up (orchestrator ruling on QA info): a `|` alone no longer makes a citation —
  // a prose table row yields NO % hint; a real Kindle segment (keyword) still does.
  assert.equal(kp.pickCitationHint('Revenue | 40% margin this year', 'percent'), null, 'prose table row: no % hint');
  assert.equal(kp.pickCitationHint('Highlight on Page 84 | 42%', 'percent')?.hint.pos, 42);
  const mm = kp.pickCitationHint('Your Highlight on Location 1423-1425 | Added on Nov 16', 'page');
  assert.equal(mm.kind, 'mismatch');
  assert.equal(kp.kindleUnitMismatchCopy(mm.hint, 'page'), 'Detected Location 1423 — this book tracks pages.');
  assert.equal(kp.pickCitationHint('Your Highlight on Location 1423-1425 | Added on Nov 16', 'loc').kind, 'match');
});

test('QA CD2: Save & Next skips current, saved/atomic, archived and shielded; ties by id; oldest first', () => {
  const books = [book(), book({ id: 'b2', kind: 'nonfiction' })];
  const notes = [
    note('cur', { createdAt: '2025-01-01T00:00:00Z' }),
    note('atomic', { status: 'atomic', createdAt: '2025-01-02T00:00:00Z' }),
    note('saved', { status: 'saved', createdAt: '2025-01-02T00:00:00Z' }),
    note('arch', { createdAt: '2025-01-03T00:00:00Z', meta: { archivedAt: '2026-01-01T00:00:00Z' } }),
    note('spoiler', { pos: 250, createdAt: '2025-01-04T00:00:00Z' }), // ahead of p.100 in fiction
    note('zz', { bookId: 'b2', status: 'in-reflection', createdAt: '2025-02-01T00:00:00Z' }),
    note('aa', { bookId: 'b2', createdAt: '2025-02-01T00:00:00Z' }),
  ];
  assert.equal(nextInboxNote(notes, books, 'cur')?.id, 'aa', 'tie on createdAt → id order');
  assert.equal(nextInboxNote(notes.filter(n => n.id !== 'aa'), books, 'cur')?.id, 'zz');
  assert.equal(nextInboxNote(notes.filter(n => !['aa', 'zz'].includes(n.id)), books, 'cur'), null, 'only skipped notes left → done');
});

test('QA CD2: capture preselect — book/note routes, uuid route, archived book/notes, unknown', () => {
  const books = [book(), book({ id: 'b-arch', meta: { archivedAt: '2026-01-01T00:00:00Z' } })];
  const notes = [note('n1'), note('n-arch', { meta: { archivedAt: '2026-01-01T00:00:00Z' } }), note('n-in-arch', { bookId: 'b-arch' })];
  assert.equal(resolveCaptureBookId({ view: 'book', bookId: 'b1' }, notes, books), 'b1');
  assert.equal(resolveCaptureBookId({ view: 'book', bookId: 'b-arch' }, notes, books), null);
  assert.equal(resolveCaptureBookId({ view: 'note', noteSlug: 'slug-n1' }, notes, books), 'b1');
  assert.equal(resolveCaptureBookId({ view: 'note', noteSlug: 'n1' }, notes, books), 'b1', 'uuid route (shielded notes)');
  assert.equal(resolveCaptureBookId({ view: 'note', noteSlug: 'slug-n-arch' }, notes, books), 'b1', 'archived note in a live book → live book');
  assert.equal(resolveCaptureBookId({ view: 'note', noteSlug: 'slug-n-in-arch' }, notes, books), null);
  assert.equal(resolveCaptureBookId({ view: 'note', noteSlug: 'nope' }, notes, books), null);
  assert.equal(resolveCaptureBookId({ view: 'book', bookId: 'missing' }, notes, books), null);
  assert.equal(resolveCaptureBookId({ view: 'shelf' }, notes, books), null);
});

test('QA CD2: sparring prompt — only this note, bookmark ceiling for unfinished fiction, shielded → null', () => {
  const b = book();
  const other = 'SECRET-OTHER-NOTE';
  const n = note('n1', { quote: 'q text', takeaway: 'my take', status: 'saved', meta: { socraticQuestions: ['Why?', ' ', 'How?'] } });
  const p = buildSparringPrompt(n, b);
  assert.ok(p.includes('My takeaway: my take'));
  assert.ok(p.includes("Questions I've already been asked: Why? / How?"));
  assert.ok(p.includes("I'm only at p. 100. Don't mention anything that happens after that point."));
  assert.ok(!p.includes('WHEN'), 'fiction has no habit clause');
  assert.ok(!p.includes(other));
  const ahead = note('n2', { pos: 250, takeaway: other });
  assert.equal(buildSparringPrompt(ahead, b), null, 'shielded → nothing');
  assert.ok(buildSparringPrompt(ahead, b, { revealed: true }).includes(other), 'revealed → allowed');
  const nf = buildSparringPrompt(note('n3', { bookId: 'b2', pos: 50 }), book({ id: 'b2', kind: 'nonfiction' }));
  assert.ok(nf.includes('WHEN … → DO …'));
  assert.ok(!nf.includes("I'm only at"), 'non-fiction: no spoiler ceiling');
  const fin = buildSparringPrompt(note('n4'), book({ status: 'finished', currentPos: 300 }));
  assert.ok(!fin.includes("I'm only at"), 'finished fiction: no ceiling');
  assert.equal(buildSparringPrompt(n, null), null);
});

test('QA CD2: isSubmitShortcut — IME composition / keyCode 229 / Alt never submit; Shift still submits', () => {
  assert.equal(isSubmitShortcut({ key: 'Enter', metaKey: true, ctrlKey: false }), true);
  assert.equal(isSubmitShortcut({ key: 'Enter', metaKey: false, ctrlKey: true }), true);
  assert.equal(isSubmitShortcut({ key: 'Enter', metaKey: true, ctrlKey: false, isComposing: true }), false);
  assert.equal(isSubmitShortcut({ key: 'Enter', metaKey: true, ctrlKey: false, keyCode: 229 }), false);
  assert.equal(isSubmitShortcut({ key: 'Enter', metaKey: true, ctrlKey: false, altKey: true }), false);
  assert.equal(isSubmitShortcut({ key: 'Enter', metaKey: false, ctrlKey: false }), false);
  assert.equal(isSubmitShortcut({ key: 'a', metaKey: true, ctrlKey: false }), false);
});

test('QA CD2: capture-draft attachments — validated, max 3, scoped per account (Demo never sees real ones)', () => {
  localStorage.clear();
  try {
    const good = [
      { id: 'i1', type: 'image', fileName: 'a.png', mimeType: 'image/png', driveFileId: 'drv1' },
      { id: 'l1', type: 'link', url: 'https://example.com', title: 'Ex' },
      { id: 'd1', type: 'doc', url: 'https://docs.google.com/document/d/x/edit', title: 'Doc' },
      { id: 'l2', type: 'link', url: 'https://four.example', title: 'Fourth' },
    ];
    const junk = [null, 7, { type: 'image', fileName: 'x' }, { id: 'nofile', type: 'image', mimeType: 'image/png', driveFileId: 'd' }, { id: 'bad', type: 'video', url: 'u', title: 't' }];
    const out = ds.draftAttachments({ attachments: [...junk, ...good] });
    assert.deepEqual(out.map(a => a.id), ['i1', 'l1', 'd1'], 'junk dropped, max 3');
    assert.deepEqual(ds.draftAttachments({ attachments: 'nope' }), []);

    localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'real@example.com' }));
    ds.writeDraft(ds.CAPTURE_DRAFT_KEY, { bookId: 'b1', takeaway: 't', attachments: good.slice(0, 1) });
    localStorage.removeItem('pragya_google_user');
    localStorage.setItem('pragya_mock_mode', 'true');
    localStorage.setItem('pragya_mock_session', '{}');
    assert.equal(ds.readDraft(ds.CAPTURE_DRAFT_KEY), null, 'Demo never restores the real draft attachment');
  } finally {
    localStorage.clear();
  }
});

test('QA CD2 re-verify: unwrapOuterQuotes matrix', () => {
  const cases = [
    ['“Whole”', 'Whole'],
    ['"Whole"', 'Whole'],
    ['‘Single’', 'Single'],
    ['“He said ‘hi’ to me”', 'He said ‘hi’ to me'], // inner quotes of another kind are fine
    ['"a "b" c"', '"a "b" c"'], // same quote inside → untouched
    ['"mismatched”', '"mismatched”'],
    ['“”', '“”'], // empty inner → untouched
    ['  “padded”  ', 'padded'],
    ['no quotes', 'no quotes'],
  ];
  for (const [input, want] of cases) assert.equal(kp.unwrapOuterQuotes(input), want, input);
  // Info: a highlight that starts AND ends with an apostrophe-like straight quote is unwrapped.
  assert.equal(kp.unwrapOuterQuotes("'Tis the dogs'"), 'Tis the dogs');
});
