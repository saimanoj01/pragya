import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const gis = await load('src/utils/gisSilentRefresh.ts');
const syncSkill = await load('scripts/syncSkill.mjs');
const idbStore = await load('src/utils/idbStore.ts');
const { GoogleSheetsAdapter, SPREADSHEET_ID_STORAGE_KEY } = await load(
  'src/services/googleSheetsAdapter.ts'
);

const noSleep = async () => {};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ---------------------------------------------------------------------------
// 1. GIS Silent Token Refresh — Eligibility Matrix (B4.12)
// ---------------------------------------------------------------------------

test('CD8 B4.12: shouldAttemptSilentRefresh enforces Cloud, online, Client ID, Playwright, and 5-min window rules', () => {
  const now = 1_700_000_000_000;
  const base = {
    clientId: 'real-cid.apps.googleusercontent.com',
    isMockMode: false,
    isOffline: false,
    isPlaywright: false,
    hasGisRuntime: false,
    expiresAt: now + 60_000, // 1 min left (inside 5-min window)
    now,
    force: false,
  };

  assert.equal(gis.shouldAttemptSilentRefresh(base), true, 'Eligible within 5-min window');
  assert.equal(
    gis.shouldAttemptSilentRefresh({ ...base, expiresAt: now + gis.GIS_SILENT_REFRESH_WINDOW_MS }),
    true,
    'Eligible right at 5-min boundary'
  );
  assert.equal(
    gis.shouldAttemptSilentRefresh({ ...base, expiresAt: now + gis.GIS_SILENT_REFRESH_WINDOW_MS + 1 }),
    false,
    'Too early outside 5-min window when not forced'
  );
  assert.equal(
    gis.shouldAttemptSilentRefresh({ ...base, expiresAt: null, force: false }),
    false,
    'Non-expiring token does not proactively refresh'
  );
  assert.equal(
    gis.shouldAttemptSilentRefresh({ ...base, expiresAt: null, force: true }),
    true,
    'Forced (401/expired) refresh is eligible even if expiresAt was cleared'
  );
  assert.equal(gis.shouldAttemptSilentRefresh({ ...base, clientId: undefined, force: true }), false);
  assert.equal(gis.shouldAttemptSilentRefresh({ ...base, clientId: '   ', force: true }), false);
  assert.equal(gis.shouldAttemptSilentRefresh({ ...base, isMockMode: true, force: true }), false);
  assert.equal(gis.shouldAttemptSilentRefresh({ ...base, isOffline: true, force: true }), false);
  assert.equal(
    gis.shouldAttemptSilentRefresh({ ...base, isPlaywright: true, hasGisRuntime: false, force: true }),
    false,
    'Never injects external GIS script under Playwright without a mocked runtime'
  );
  assert.equal(
    gis.shouldAttemptSilentRefresh({ ...base, isPlaywright: true, hasGisRuntime: true, force: true }),
    true,
    'Allows deterministic Playwright tests when mock GIS runtime is injected'
  );
});

// ---------------------------------------------------------------------------
// 2. GIS Silent Refresh Controller — Single-Flight Mutex, Timeout, Errors, Identity
// ---------------------------------------------------------------------------

test('CD8 B4.12: createSilentRefreshController enforces single-flight mutex, prompt="", timeout, and account verification', async () => {
  const nowMs = 1_700_000_000_000;

  // 1. Success + single-flight deduplication across 3 concurrent callers
  let initCalls = 0;
  let requestedPrompts = [];
  let pendingCallback = null;
  const ctrl1 = gis.createSilentRefreshController({
    now: () => nowMs,
    getOAuth2: () => ({
      initTokenClient(cfg) {
        initCalls += 1;
        return {
          requestAccessToken(override) {
            requestedPrompts.push({ prompt: override?.prompt, hint: override?.hint ?? cfg.hint });
            pendingCallback = () => cfg.callback({ access_token: 'ya29.fresh-1', expires_in: 3600 });
          },
        };
      },
    }),
    verifyTokenEmail: async (tok, email) => tok === 'ya29.fresh-1' && email === 'reader@pragya.dev',
  });

  const p1 = ctrl1.requestSilentToken({
    clientId: 'cid-1',
    scope: 'email profile',
    loginHint: 'reader@pragya.dev',
    expectedEmail: 'reader@pragya.dev',
    timeoutMs: 2000,
  });
  const p2 = ctrl1.requestSilentToken({
    clientId: 'cid-1',
    scope: 'email profile',
    loginHint: 'READER@pragya.dev',
    expectedEmail: 'reader@pragya.dev',
    timeoutMs: 2000,
  });
  const p3 = ctrl1.requestSilentToken({
    clientId: 'cid-1',
    scope: 'email profile',
    loginHint: 'reader@pragya.dev',
    expectedEmail: 'reader@pragya.dev',
    timeoutMs: 2000,
  });

  assert.equal(initCalls, 1, 'Single-flight mutex must invoke initTokenClient exactly once');
  assert.deepEqual(requestedPrompts, [{ prompt: '', hint: 'reader@pragya.dev' }]);
  pendingCallback();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  for (const r of [r1, r2, r3]) {
    assert.equal(r.ok, true);
    assert.equal(r.accessToken, 'ya29.fresh-1');
    assert.equal(r.expiresAt, nowMs + 3_600_000);
  }

  // 2. Timeout settles cleanly without hanging and releases mutex
  const ctrlTimeout = gis.createSilentRefreshController({
    getOAuth2: () => ({
      initTokenClient() {
        return { requestAccessToken() {} }; // never calls callback
      },
    }),
  });
  const timedOut = await ctrlTimeout.requestSilentToken({
    clientId: 'cid-timeout',
    scope: 'email',
    timeoutMs: 60,
  });
  assert.deepEqual(timedOut, { ok: false, reason: 'timeout' });

  // 3. GIS error / error_callback / script load failure / account mismatch
  const ctrlErr = gis.createSilentRefreshController({
    getOAuth2: () => ({
      initTokenClient(cfg) {
        return {
          requestAccessToken() {
            cfg.callback({ error: 'interaction_required' });
          },
        };
      },
    }),
  });
  const errRes = await ctrlErr.requestSilentToken({ clientId: 'cid-err', scope: 'email' });
  assert.equal(errRes.ok, false);
  assert.equal(errRes.reason, 'gis_error');

  const ctrlScriptFail = gis.createSilentRefreshController({
    getOAuth2: () => null,
    loadScript: async () => false,
  });
  const scriptRes = await ctrlScriptFail.requestSilentToken({ clientId: 'cid-script', scope: 'email' });
  assert.deepEqual(scriptRes, { ok: false, reason: 'script_load_failed' });

  const ctrlMismatch = gis.createSilentRefreshController({
    getOAuth2: () => ({
      initTokenClient(cfg) {
        return {
          requestAccessToken() {
            cfg.callback({ access_token: 'ya29.wrong-account', expires_in: 3600 });
          },
        };
      },
    }),
    verifyTokenEmail: async () => false,
  });
  const mismatchRes = await ctrlMismatch.requestSilentToken({
    clientId: 'cid-mismatch',
    scope: 'email',
    expectedEmail: 'a@pragya.dev',
  });
  assert.deepEqual(mismatchRes, { ok: false, reason: 'account_mismatch' });
});

// ---------------------------------------------------------------------------
// 3. GoogleSheetsAdapter Silent Refresh Integration (expired token & 401)
// ---------------------------------------------------------------------------

test('CD8 B4.12: GoogleSheetsAdapter retries once via refreshToken on expired token & 401 before onUnauthorized', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const origFetch = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-gis');

    // Case A: expired token (getToken() returns null) -> silent refresh mints token -> succeeds with 0 onUnauthorized
    let curToken = null;
    let unauthCalls = 0;
    let refreshCalls = 0;
    globalThis.fetch = async (url, init = {}) => {
      const auth = new Headers(init.headers).get('Authorization');
      if (auth !== 'Bearer ya29.from-silent') {
        return json({ error: { message: 'Unauthorized' } }, 401);
      }
      if (String(url).includes('drive/v3/files/doc-1')) {
        return json({ id: 'doc-1', name: 'Companion Doc' });
      }
      return json({});
    };
    const adapterA = new GoogleSheetsAdapter(
      () => curToken,
      () => {
        unauthCalls += 1;
      },
      'gis@pragya.dev',
      {
        sleep: noSleep,
        refreshToken: async () => {
          refreshCalls += 1;
          curToken = 'ya29.from-silent';
          return curToken;
        },
      }
    );
    const titleA = await adapterA.resolveDocTitle('doc-1');
    assert.equal(titleA, 'Companion Doc');
    assert.equal(refreshCalls, 1);
    assert.equal(unauthCalls, 0);

    // Case B: active token rejected with 401 -> silent refresh mints new token -> retries ONCE and succeeds
    curToken = 'ya29.revoked';
    refreshCalls = 0;
    unauthCalls = 0;
    let fetchAttempts = 0;
    globalThis.fetch = async (_url, init = {}) => {
      fetchAttempts += 1;
      const auth = new Headers(init.headers).get('Authorization');
      if (auth === 'Bearer ya29.revoked') {
        return json({ error: { message: 'Revoked' } }, 401);
      }
      return json({ id: 'doc-2', name: 'Retried Doc' });
    };
    const adapterB = new GoogleSheetsAdapter(
      () => curToken,
      () => {
        unauthCalls += 1;
      },
      'gis@pragya.dev',
      {
        sleep: noSleep,
        refreshToken: async () => {
          refreshCalls += 1;
          curToken = 'ya29.retried';
          return curToken;
        },
      }
    );
    const titleB = await adapterB.resolveDocTitle('doc-2');
    assert.equal(titleB, 'Retried Doc');
    assert.equal(fetchAttempts, 2);
    assert.equal(refreshCalls, 1);
    assert.equal(unauthCalls, 0);

    // Case C: 401 + refresh fails -> calls onUnauthorized once and rejects (never loops)
    curToken = 'ya29.dead';
    refreshCalls = 0;
    unauthCalls = 0;
    globalThis.fetch = async () => json({ error: { message: 'Unauthorized' } }, 401);
    const adapterC = new GoogleSheetsAdapter(
      () => curToken,
      () => {
        unauthCalls += 1;
      },
      'gis@pragya.dev',
      {
        sleep: noSleep,
        refreshToken: async () => {
          refreshCalls += 1;
          return null;
        },
      }
    );
    await assert.rejects(() => adapterC.resolveDocTitle('doc-3'), /401/);
    assert.equal(refreshCalls, 1);
    assert.equal(unauthCalls, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// 4. syncSkill.mjs, package.json scripts, index.html & CI workflow contracts
// ---------------------------------------------------------------------------

test('CD8 D3.6/D3.7: syncSkillCli syncs & detects drift, and CI workflows lock all release gates', () => {
  // Repo copy is currently byte-identical
  const liveCheck = syncSkill.syncSkillCli({ checkOnly: true });
  assert.equal(liveCheck.ok, true);
  assert.ok(liveCheck.bytes > 100_000);

  // Isolated temp copy detects missing/drifted file and syncs cleanly
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pragya-sync-skill-'));
  try {
    const src = path.join(tmpDir, 'src_cli.py');
    const dst = path.join(tmpDir, 'nested', 'dst_cli.py');
    fs.writeFileSync(src, 'print("v1")\n', 'utf8');

    assert.equal(syncSkill.syncSkillCli({ checkOnly: true, source: src, target: dst }).ok, false);
    const synced = syncSkill.syncSkillCli({ checkOnly: false, source: src, target: dst });
    assert.equal(synced.ok, true);
    assert.equal(syncSkill.syncSkillCli({ checkOnly: true, source: src, target: dst }).ok, true);

    fs.writeFileSync(dst, 'print("drifted")\n', 'utf8');
    const drifted = syncSkill.syncSkillCli({ checkOnly: true, source: src, target: dst });
    assert.equal(drifted.ok, false);
    assert.match(drifted.error, /out of sync/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // package.json scripts
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.lint.includes('mjs'), 'npm run lint must cover .mjs files');
  assert.equal(pkg.scripts['sync:skill'], 'node scripts/syncSkill.mjs');
  assert.equal(pkg.scripts['check:skill'], 'node scripts/syncSkill.mjs --check');

  // index.html must NOT eagerly load accounts.google.com/gsi/client (lazy Cloud-only!)
  const indexHtml = read('index.html');
  assert.ok(
    !indexHtml.includes('accounts.google.com/gsi/client'),
    'GIS must be dynamically lazy-loaded in Cloud mode only (never eager in index.html)'
  );

  // PR & Deploy CI workflows
  const e2eYml = read('.github/workflows/e2e.yml');
  for (const required of [
    'push:',
    'pull_request:',
    'setup-python',
    'npx tsc --noEmit',
    'npm run lint',
    'npm run test:unit',
    'python3 -m unittest discover -s tests/unit',
    'npm run check:skill',
    'npm run build',
    "VITE_BASE_PATH: '/pragya/'",
    'npm run test:e2e',
  ]) {
    assert.ok(e2eYml.includes(required), `e2e.yml must include "${required}"`);
  }

  const deployYml = read('.github/workflows/deploy.yml');
  assert.ok(deployYml.includes('npx tsc --noEmit'));
  assert.ok(deployYml.includes('npm run check:skill'));
});

// ---------------------------------------------------------------------------
// 5. Batch 8 Fix-ups: R1#1 (fail-closed + timeout), R1-N2, R1#3, R2-1
// ---------------------------------------------------------------------------

test('CD8 fix-up R1#1: defaultVerifyTokenEmail fails CLOSED on non-2xx, missing email, network error, and AbortController timeout', async () => {
  const origFetch = globalThis.fetch;
  try {
    // 1. Matching email (case-insensitive) -> true
    globalThis.fetch = async () => json({ email: 'Reader@Pragya.Dev' }, 200);
    assert.equal(await gis.defaultVerifyTokenEmail('ya29.ok', 'reader@pragya.dev', 200), true);

    // 2. Mismatched email -> false
    globalThis.fetch = async () => json({ email: 'other@pragya.dev' }, 200);
    assert.equal(await gis.defaultVerifyTokenEmail('ya29.other', 'reader@pragya.dev', 200), false);

    // 3. Non-2xx (401, 403, 500) -> MUST fail closed (false)
    for (const status of [401, 403, 500]) {
      globalThis.fetch = async () => json({ error: 'fail' }, status);
      assert.equal(
        await gis.defaultVerifyTokenEmail('ya29.err', 'reader@pragya.dev', 200),
        false,
        `Status ${status} must fail closed`
      );
    }

    // 4. Missing / blank email -> MUST fail closed (false)
    globalThis.fetch = async () => json({ name: 'No Email' }, 200);
    assert.equal(await gis.defaultVerifyTokenEmail('ya29.noemail', 'reader@pragya.dev', 200), false);

    // 5. Network error -> MUST fail closed (false)
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    assert.equal(await gis.defaultVerifyTokenEmail('ya29.net', 'reader@pragya.dev', 200), false);

    // 6. Hanging userinfo -> AbortController aborts at timeoutMs and resolves false without stalling mutex
    let aborted = false;
    globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('Aborted'));
        });
      });
    const t0 = Date.now();
    const resTimeout = await gis.defaultVerifyTokenEmail('ya29.hang', 'reader@pragya.dev', 70);
    const elapsed = Date.now() - t0;
    assert.equal(resTimeout, false);
    assert.equal(aborted, true, 'AbortController must abort a hanging userinfo fetch');
    assert.ok(elapsed < 1000, `Expected fast timeout, got ${elapsed}ms`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('CD8 fix-up R1-N2: single-flight key isolates different expectedEmail and scope values', async () => {
  let initCalls = 0;
  const resolvers = [];
  const ctrl = gis.createSilentRefreshController({
    getOAuth2: () => ({
      initTokenClient(cfg) {
        initCalls += 1;
        const callIdx = initCalls;
        return {
          requestAccessToken() {
            resolvers.push(() => cfg.callback({ access_token: `ya29.tok-${callIdx}`, expires_in: 3600 }));
          },
        };
      },
    }),
    verifyTokenEmail: async () => true,
  });

  const pA = ctrl.requestSilentToken({
    clientId: 'cid-k',
    scope: 'email profile',
    loginHint: 'shared@pragya.dev',
    expectedEmail: 'a@pragya.dev',
  });
  const pB = ctrl.requestSilentToken({
    clientId: 'cid-k',
    scope: 'email profile',
    loginHint: 'shared@pragya.dev',
    expectedEmail: 'b@pragya.dev',
  });
  const pScope = ctrl.requestSilentToken({
    clientId: 'cid-k',
    scope: 'email profile drive.file',
    loginHint: 'shared@pragya.dev',
    expectedEmail: 'a@pragya.dev',
  });

  assert.equal(initCalls, 3, 'Distinct expectedEmail and scope must NOT share an in-flight promise');
  for (const r of resolvers) r();
  const [rA, rB, rS] = await Promise.all([pA, pB, pScope]);
  assert.equal(rA.ok && rB.ok && rS.ok, true);
  assert.equal(rA.accessToken, 'ya29.tok-1');
  assert.equal(rB.accessToken, 'ya29.tok-2');
  assert.equal(rS.accessToken, 'ya29.tok-3');
});

test('CD8 fix-up R1#3: computeProactiveRefreshDelayMs prevents infinite delayMs=0 loops on short-lived tokens', () => {
  const now = 1_700_000_000_000;
  // Normal 1-hour token -> schedules 5 min before expiry
  assert.equal(
    gis.computeProactiveRefreshDelayMs({ expiresAt: now + 3_600_000, now, lastProactiveRefreshAt: 0 }),
    3_300_000
  );
  // First-time boot inside 5-min window (e.g. 2 min left) -> fires once immediately (0ms)
  assert.equal(
    gis.computeProactiveRefreshDelayMs({ expiresAt: now + 120_000, now, lastProactiveRefreshAt: 0 }),
    0
  );
  // Short-lived token (<= 5 min) returned right after a proactive refresh -> returns null (no tight loop!)
  assert.equal(
    gis.computeProactiveRefreshDelayMs({ expiresAt: now + 180_000, now, lastProactiveRefreshAt: now }),
    null
  );
  // Token just above 5-min window (5m10s) right after proactive refresh -> respects 60s min cooldown floor
  assert.equal(
    gis.computeProactiveRefreshDelayMs({ expiresAt: now + 310_000, now, lastProactiveRefreshAt: now }),
    gis.GIS_PROACTIVE_MIN_COOLDOWN_MS
  );
  // Already expired or null -> returns null (reactive boot/401 handles it)
  assert.equal(gis.computeProactiveRefreshDelayMs({ expiresAt: null, now }), null);
  assert.equal(gis.computeProactiveRefreshDelayMs({ expiresAt: now - 1000, now }), null);
});

test('CD8 fix-up R2-1: loadGisScript removes failed <script> tag on error so retry injects fresh node immediately', async () => {
  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  gis.resetSilentRefreshForTests();
  try {
    const scripts = [];
    const fakeWin = {};
    globalThis.window = fakeWin;
    globalThis.document = {
      head: {
        appendChild(el) {
          scripts.push(el);
          // Attempt 1 fails immediately; attempt 2 loads GIS runtime immediately.
          if (scripts.length === 1) {
            queueMicrotask(() => el.onerror?.());
          } else {
            queueMicrotask(() => {
              fakeWin.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken() {} }) } } };
              el.onload?.();
            });
          }
        },
      },
      querySelector(sel) {
        if (sel.includes(gis.GIS_SCRIPT_URL)) {
          return scripts.find(s => !s._removed) ?? null;
        }
        return null;
      },
      createElement() {
        const el = {
          src: '',
          async: false,
          defer: false,
          _removed: false,
          onload: null,
          onerror: null,
          addEventListener() {},
          remove() {
            this._removed = true;
          },
        };
        return el;
      },
    };

    const first = await gis.loadGisScript(1000);
    assert.equal(first, false, 'First attempt should fail on onerror');
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0]._removed, true, 'Failed <script> node MUST be removed from DOM');

    const t0 = Date.now();
    const second = await gis.loadGisScript(1000);
    const elapsed = Date.now() - t0;
    assert.equal(second, true, 'Retry must inject a fresh <script> and succeed');
    assert.equal(scripts.length, 2);
    assert.ok(elapsed < 500, `Retry must not stall on dead script node (took ${elapsed}ms)`);
  } finally {
    gis.resetSilentRefreshForTests();
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
});
