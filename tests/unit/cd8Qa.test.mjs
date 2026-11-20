import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
const idbStore = await load('src/utils/idbStore.ts');
const { GoogleSheetsAdapter, SPREADSHEET_ID_STORAGE_KEY } = await load(
  'src/services/googleSheetsAdapter.ts'
);

const noSleep = async () => {};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('CD8 QA GIS: concurrent 401 retry bounds (no infinite loop when refreshed token is dead/same) & mutex release after timeout/error', async () => {
  localStorage.clear();
  idbStore.resetIdbStoreForTests();
  const origFetch = globalThis.fetch;
  try {
    localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-qa8');

    // 1. If refreshToken returns the SAME dead token, GoogleSheetsAdapter must NOT retry fetch or loop!
    let fetchCalls = 0;
    let refreshCalls = 0;
    let unauthCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return json({ error: { message: 'Still Unauthorized' } }, 401);
    };
    const adapterSame = new GoogleSheetsAdapter(
      () => 'ya29.dead-same',
      () => {
        unauthCalls += 1;
      },
      'qa8@pragya.dev',
      {
        sleep: noSleep,
        refreshToken: async () => {
          refreshCalls += 1;
          return 'ya29.dead-same';
        },
      }
    );
    await assert.rejects(() => adapterSame.resolveDocTitle('doc-same'), /401/);
    assert.equal(fetchCalls, 1, 'Identical refreshed token must NOT trigger a second wasted 401 request');
    assert.equal(refreshCalls, 1);
    assert.equal(unauthCalls, 1);

    // 2. If refreshed token is DIFFERENT but ALSO rejected with 401, retry at most once (2 fetches, 1 refresh, 1 onUnauthorized)
    fetchCalls = 0;
    refreshCalls = 0;
    unauthCalls = 0;
    const adapterStill401 = new GoogleSheetsAdapter(
      () => 'ya29.old',
      () => {
        unauthCalls += 1;
      },
      'qa8@pragya.dev',
      {
        sleep: noSleep,
        refreshToken: async () => {
          refreshCalls += 1;
          return 'ya29.still-bad';
        },
      }
    );
    await assert.rejects(() => adapterStill401.resolveDocTitle('doc-still-401'), /401/);
    assert.equal(fetchCalls, 2);
    assert.equal(refreshCalls, 1);
    assert.equal(unauthCalls, 1);

    // 3. Single-flight controller releases its mutex after a timeout so a later call can succeed
    let attempt = 0;
    const ctrl = gis.createSilentRefreshController({
      getOAuth2: () => ({
        initTokenClient(cfg) {
          return {
            requestAccessToken() {
              attempt += 1;
              if (attempt === 1) return; // hang -> trigger timeout
              cfg.callback({ access_token: 'ya29.recovered', expires_in: 3600 });
            },
          };
        },
      }),
    });
    const first = await ctrl.requestSilentToken({
      clientId: 'cid-recover',
      scope: 'email',
      loginHint: 'qa8@pragya.dev',
      timeoutMs: 60,
    });
    assert.deepEqual(first, { ok: false, reason: 'timeout' });

    const second = await ctrl.requestSilentToken({
      clientId: 'cid-recover',
      scope: 'email',
      loginHint: 'qa8@pragya.dev',
      timeoutMs: 200,
    });
    assert.equal(second.ok, true);
    assert.equal(second.accessToken, 'ya29.recovered');
    assert.equal(attempt, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('CD8 QA sync:skill CLI exits 0 on synced repo & non-zero on drifted temp copy; package.json & .eslintrc.cjs contracts', () => {
  // 1. Real CLI subprocess on synced repo exits 0
  const okRun = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'syncSkill.mjs'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(okRun.status, 0, `Expected exit 0 from syncSkill.mjs --check, got stderr: ${okRun.stderr}`);
  assert.match(okRun.stdout, /byte-identical/i);

  // 2. Real subprocess exits non-zero when target has drifted (using an isolated realpath temp copy — never touches repo!)
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pragya-qa8-sync-')));
  try {
    const tmpScripts = path.join(tmpDir, 'scripts');
    const tmpSkillScripts = path.join(tmpDir, '.agents', 'skills', 'pragya-companion', 'scripts');
    fs.mkdirSync(tmpScripts, { recursive: true });
    fs.mkdirSync(tmpSkillScripts, { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'scripts', 'syncSkill.mjs'), path.join(tmpScripts, 'syncSkill.mjs'));
    fs.writeFileSync(path.join(tmpScripts, 'pragya_cli.py'), '# source v2\n', 'utf8');
    fs.writeFileSync(path.join(tmpSkillScripts, 'pragya_cli.py'), '# drifted v1\n', 'utf8');

    const driftRun = spawnSync(process.execPath, [path.join(tmpScripts, 'syncSkill.mjs'), '--check'], {
      cwd: tmpDir,
      encoding: 'utf8',
    });
    assert.notEqual(driftRun.status, 0, 'syncSkill.mjs --check must exit non-zero on drift');
    assert.match(driftRun.stderr, /out of sync/i);

    const fixRun = spawnSync(process.execPath, [path.join(tmpScripts, 'syncSkill.mjs')], {
      cwd: tmpDir,
      encoding: 'utf8',
    });
    assert.equal(fixRun.status, 0, fixRun.stderr);

    const recheckRun = spawnSync(process.execPath, [path.join(tmpScripts, 'syncSkill.mjs'), '--check'], {
      cwd: tmpDir,
      encoding: 'utf8',
    });
    assert.equal(recheckRun.status, 0, recheckRun.stderr);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 3. .eslintrc.cjs includes Node override for .mjs & deploy.yml mirrors PR gates (OQ-14)
  const eslintrc = read('.eslintrc.cjs');
  assert.ok(eslintrc.includes('scripts/**/*.mjs') && eslintrc.includes('tests/**/*.mjs'));
  const deployYml = read('.github/workflows/deploy.yml');
  for (const step of ['npm run lint', 'npx tsc --noEmit', 'npm run test:unit', 'python3 -m unittest', 'npm run check:skill']) {
    assert.ok(deployYml.includes(step), `deploy.yml must mirror "${step}"`);
  }
});
