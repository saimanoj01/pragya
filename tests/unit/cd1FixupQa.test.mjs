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
 * QA (CD Batch 1a fix-up re-verify): per-account draft scoping driven through the same
 * accountSession / draftStorage calls AuthContext makes, in AuthContext's order; plus
 * archived-aware delta-cap / isArchived TS ⇄ Python parity.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const ds = await load('src/utils/draftStorage.ts');
const acct = await load('src/utils/accountSession.ts');
const { isArchived, countOtherActiveDeltas } = await load('src/utils/archive.ts');

const A = 'Alice.Reader+books@Example.com';
const B = 'bob@example.org';

// Mirrors AuthContext: OAuth success (L339-349), loginAsMock (L453+), logout (L471+), boot (L234+).
function oauthSignIn(email) {
  localStorage.setItem('pragya_mock_mode', 'false');
  localStorage.removeItem('pragya_mock_session');
  const switched = acct.applySignedInAccount(email);
  localStorage.setItem('pragya_google_user', JSON.stringify({ email }));
  acct.adoptLegacyDraftsForAccount(email);
  return switched;
}
function demoLogin() {
  localStorage.removeItem('pragya_google_user');
  localStorage.setItem('pragya_mock_session', JSON.stringify({ email: 'demo@pragya.local' }));
  localStorage.setItem('pragya_mock_mode', 'true');
}
function logout({ discardDrafts = false } = {}) {
  const wasDemo = localStorage.getItem('pragya_mock_mode') === 'true';
  localStorage.removeItem('pragya_google_user');
  localStorage.removeItem('pragya_mock_session');
  localStorage.removeItem('pragya_mock_mode');
  if (discardDrafts) ds.clearAllDrafts({ scope: 'all' });
  else if (wasDemo) ds.clearAllDrafts({ scope: ds.DEMO_DRAFT_SCOPE });
}
const allKeys = () => {
  const out = [];
  for (let i = 0; i < localStorage.length; i += 1) out.push(localStorage.key(i));
  return out;
};
const draftKeys = () => allKeys().filter(k => k && k.startsWith('pragya_draft'));

test('QA fix-up: full lifecycle — logout keeps → Demo blind & non-wiping → Demo logout scoped → re-login restores → switch wipes all', () => {
  localStorage.clear();
  try {
    assert.equal(oauthSignIn(A), false);
    ds.writeDraft(ds.CAPTURE_DRAFT_KEY, { takeaway: 'REAL-capture' });
    ds.writeDraft(ds.getEditNoteDraftKey('n1'), { title: 'REAL-edit' });
    ds.writeDraft(ds.getDeepenDraftKey('n2'), { takeaway: 'REAL-deepen' });
    ds.writeDraft(ds.getCapstoneDraftKey('b1'), { arcOrThesis: 'REAL-cap' });
    assert.equal(ds.describeDrafts(), 'a capture, a note edit, a Deepen draft, a Whole-Book Picture');

    logout();
    assert.equal(draftKeys().length, 4, 'logout keeps all 4 real drafts');
    assert.equal(localStorage.getItem('pragya_last_account_email'), A, 'marker kept');

    demoLogin();
    assert.equal(ds.currentDraftScope(), 'demo');
    assert.equal(ds.hasAnyDraft(), false, 'Demo cannot see real drafts');
    assert.equal(ds.describeDrafts(), '');
    for (const k of [ds.CAPTURE_DRAFT_KEY, ds.getEditNoteDraftKey('n1'), ds.getDeepenDraftKey('n2'), ds.getCapstoneDraftKey('b1')]) {
      assert.equal(ds.readDraft(k), null, `Demo reads nothing for ${k}`);
    }
    ds.writeDraft(ds.CAPTURE_DRAFT_KEY, { takeaway: 'DEMO' });
    ds.writeDraft(ds.getEditNoteDraftKey('n1'), { title: 'DEMO-edit' });
    ds.clearAllDrafts({ scope: ds.DEMO_DRAFT_SCOPE }); // Reset Demo
    assert.equal(ds.hasAnyDraft(), false);
    assert.equal(draftKeys().length, 4, 'Reset Demo leaves real drafts');
    ds.writeDraft(ds.CAPTURE_DRAFT_KEY, { takeaway: 'DEMO2' });
    logout();
    assert.equal(draftKeys().length, 4, 'Demo logout clears only demo');
    assert.ok(!draftKeys().some(k => k.startsWith('pragya_draft:demo:')));

    // Same account, different casing/whitespace: restores, no switch.
    assert.equal(oauthSignIn('  alice.reader+BOOKS@example.com '), false);
    assert.deepEqual(ds.readDraft(ds.CAPTURE_DRAFT_KEY), { takeaway: 'REAL-capture' });
    assert.deepEqual(ds.readDraft(ds.getCapstoneDraftKey('b1')), { arcOrThesis: 'REAL-cap' });

    // Leave a demo draft around too, then switch accounts: everything goes.
    logout();
    demoLogin();
    ds.writeDraft(ds.CAPTURE_DRAFT_KEY, { takeaway: 'DEMO3' });
    localStorage.removeItem('pragya_mock_mode'); // tab closed in Demo, no logout
    localStorage.setItem('pragya_draft_capture_v1', JSON.stringify({ takeaway: 'LEGACY' }));
    assert.equal(oauthSignIn(B), true, 'switch detected → N3 toast path');
    assert.deepEqual(draftKeys(), [], 'account switch wipes every scope + legacy');
    assert.equal(ds.hasAnyDraft(), false);
  } finally {
    localStorage.clear();
  }
});

test('QA fix-up: Discard drafts and log out clears every scope', () => {
  localStorage.clear();
  try {
    oauthSignIn(A);
    ds.writeDraft(ds.CAPTURE_DRAFT_KEY, { takeaway: 'x' });
    logout({ discardDrafts: true });
    assert.deepEqual(draftKeys(), []);
  } finally {
    localStorage.clear();
  }
});

test('QA fix-up: hashed scope — no raw email / local part / domain in any key; distinct per account', () => {
  localStorage.clear();
  try {
    const emails = [A, B, 'xavier@yonder.zone', 'ünïcødé@exämple.de', 'a:b@weird.example', "o'brien@example.ie"];
    const scopes = new Set();
    for (const e of emails) {
      localStorage.clear();
      oauthSignIn(e);
      ds.writeDraft(ds.CAPTURE_DRAFT_KEY, { t: 1 });
      ds.writeDraft(ds.getEditNoteDraftKey('n'), { t: 1 });
      const scope = ds.currentDraftScope();
      assert.match(scope, /^u[0-9a-z]+$/, `scope is opaque for ${e}`);
      scopes.add(scope);
      const [local, domain] = e.trim().toLowerCase().split('@'); // all ≥ 4 chars, so substring checks are meaningful
      for (const k of draftKeys()) {
        assert.ok(!k.toLowerCase().includes(local), `${k} leaks local part`);
        assert.ok(!k.toLowerCase().includes(domain), `${k} leaks domain`);
        assert.equal(k.split(':').length >= 3, true);
      }
    }
    assert.equal(scopes.size, emails.length, 'no scope collision across test accounts');
    assert.notEqual(ds.accountDraftScope('demo'), ds.DEMO_DRAFT_SCOPE, 'account scope cannot equal demo');
  } finally {
    localStorage.clear();
  }
});

test('QA fix-up: legacy migration — matching account at boot adopts; Demo boot and non-matching account never adopt', () => {
  localStorage.clear();
  try {
    // Demo boot: AuthContext skips adoption in mock mode; Demo cannot see legacy keys.
    localStorage.setItem('pragya_last_account_email', A);
    localStorage.setItem('pragya_draft_capture_v1', JSON.stringify({ takeaway: 'LEGACY' }));
    demoLogin();
    assert.equal(ds.readDraft(ds.CAPTURE_DRAFT_KEY), null, 'Demo does not read legacy keys');
    assert.equal(ds.hasAnyDraft(), false);
    assert.equal(acct.adoptLegacyDraftsForAccount('demo@pragya.local'), 0, 'demo email never matches marker');
    ds.clearAllDrafts({ scope: ds.DEMO_DRAFT_SCOPE });
    assert.ok(localStorage.getItem('pragya_draft_capture_v1'), 'Demo clear never touches legacy keys');
    logout();

    // Boot with a real stored profile matching the marker → adopted.
    localStorage.setItem('pragya_google_user', JSON.stringify({ email: A }));
    acct.rememberCurrentAccount();
    assert.equal(acct.adoptLegacyDraftsForAccount(A.toUpperCase()), 1);
    assert.equal(localStorage.getItem('pragya_draft_capture_v1'), null);
    assert.deepEqual(ds.readDraft(ds.CAPTURE_DRAFT_KEY), { takeaway: 'LEGACY' });
  } finally {
    localStorage.clear();
  }
});

test(
  'QA-29: OAuth first sign-in with NO prior marker adopts unattributable legacy drafts (e.g. pre-upgrade Demo drafts)',
  { todo: 'QA-29 (Low): AuthContext L339→L349 sets the marker before the match check, so the check is tautological' },
  () => {
    localStorage.clear();
    try {
      // Pre-upgrade build: Demo wrote legacy unscoped keys; Demo logout used to forget the marker.
      localStorage.setItem('pragya_draft_capture_v1', JSON.stringify({ bookId: 'book-systems', takeaway: 'DEMO-OLD' }));
      assert.equal(localStorage.getItem('pragya_last_account_email'), null);
      oauthSignIn(A);
      assert.equal(ds.readDraft(ds.CAPTURE_DRAFT_KEY), null, 'unattributable legacy drafts must not be adopted');
    } finally {
      localStorage.clear();
    }
  }
);

test('QA fix-up: archived-aware 5-cap + isArchived — TS ⇄ Python parity', () => {
  const archivedAtValues = [
    undefined, null, '', '   ', '\t\n', '2026-01-01T00:00:00Z', 'garbage', 0, 1, true, false, [], {}, ['x'],
  ];
  const entities = archivedAtValues.map(v => ({ id: 'e', meta: v === undefined ? {} : { archivedAt: v } }));
  entities.push({ id: 'e' }, { id: 'e', meta: null });
  const ts = entities.map(e => isArchived(e));

  const notes = [];
  for (let i = 0; i < 5; i += 1) notes.push({ id: `arch${i}`, deltaStatus: 'active', meta: { archivedAt: '2026-01-01T00:00:00Z' } });
  for (let i = 0; i < 4; i += 1) notes.push({ id: `live${i}`, deltaStatus: 'active', meta: {} });
  notes.push({ id: 'blank', deltaStatus: 'active', meta: { archivedAt: '  ' } }); // not archived → counts
  notes.push({ id: 'target', deltaStatus: 'paused', meta: {} });
  const tsCount = countOtherActiveDeltas(notes, 'target');

  const py = spawnSync(
    'python3',
    [
      '-c',
      `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("cli", "scripts/pragya_cli.py")
cli = importlib.util.module_from_spec(spec); sys.modules["cli"] = cli; spec.loader.exec_module(cli)
d = json.load(sys.stdin)
arch = [cli.is_archived(e) for e in d["entities"]]
res = {}
for drop in (None, "blank"):
    ns = [n for n in d["notes"] if n["id"] != drop]
    try:
        cli.check_active_delta_cap(ns, "target", "active"); res[str(drop)] = "ok"
    except cli.CliError: res[str(drop)] = "capped"
print(json.dumps({"arch": arch, "cap": res}))
`,
    ],
    { cwd: repoRoot, input: JSON.stringify({ entities, notes }), encoding: 'utf8' }
  );
  assert.equal(py.status, 0, py.stderr);
  const out = JSON.parse(py.stdout);
  assert.deepEqual(out.arch, ts, 'isArchived parity');
  assert.equal(tsCount, 5, 'whitespace archivedAt is NOT archived → 4 live + blank = 5 others');
  assert.equal(out.cap.None, 'capped', 'Python caps at 5 other non-archived active');
  assert.equal(countOtherActiveDeltas(notes.filter(n => n.id !== 'blank'), 'target'), 4);
  assert.equal(out.cap.blank, 'ok', '5 archived active never hold a slot (Python)');
});
