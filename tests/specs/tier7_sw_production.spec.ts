import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * Tier 7 (QA, M6 Batch 4) — production Service Worker under base path /pragya/.
 *
 * Builds the app once into a temp dir (VITE_BASE_PATH=/pragya/, never touching ./dist)
 * and serves it from an in-process static server that the test can stop. "Offline" =
 * server stopped: Chromium's context.setOffline() does not apply to fetches made by the
 * service worker itself, so it would give a false signal.
 *
 * Checks: precache of every built asset + 12-hex build id, offline reload/deep link,
 * respondWith never resolves to a non-Response (asset miss rejects with TypeError and no
 * "not a Response" console error), inline offline page, update → toast, old shell caches
 * evicted (polled), pragya-media-v1 preserved.
 */

test.describe.configure({ mode: 'serial' });

const ROOT = process.cwd();
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

let distDir = '';
let server: http.Server | null = null;
let port = 0;
const base = () => `http://localhost:${port}/pragya/`;

function startServer(): Promise<void> {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (!url.pathname.startsWith('/pragya/')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const rel = decodeURIComponent(url.pathname.slice('/pragya/'.length)) || 'index.html';
      let file = path.join(distDir, rel);
      if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (rel.startsWith('assets/') || rel.startsWith('fonts/')) {
          res.writeHead(404);
          res.end();
          return;
        }
        file = path.join(distDir, 'index.html');
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(port, '127.0.0.1', () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise(resolve => {
    if (!server) return resolve();
    const s = server;
    server = null;
    s.closeAllConnections();
    s.close(() => resolve());
  });
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pragya-swprod-'));
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', distDir, '--emptyOutDir', '--logLevel', 'warn'],
    { cwd: ROOT, env: { ...process.env, VITE_BASE_PATH: '/pragya/' }, stdio: 'pipe' }
  );
  if (!fs.existsSync(path.join(distDir, 'sw.js'))) throw new Error('build produced no sw.js');
});

test.afterAll(async () => {
  await stopServer();
  if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  port = 0; // fresh origin per test → fresh SW registration / caches
  await startServer();
});
test.afterEach(stopServer);

function collectErrors(page: Page, context: BrowserContext) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  // Context-level console covers every page in the context (incl. respondWith/FetchEvent
  // errors Chromium reports to the controlled page). Typed API — Worker has no 'console'
  // event in the installed Playwright typings.
  context.on('console', m => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** Errors other than the expected "server is down" noise. */
const unexpected = (errors: string[]) =>
  errors.filter(e => !/Failed to (load resource|fetch)|ERR_CONNECTION_REFUSED|503 \(Offline\)|status of 503/.test(e));

async function waitForController(page: Page) {
  await page.waitForFunction(
    async () => {
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg.active) && Boolean(navigator.serviceWorker.controller);
    },
    undefined,
    { timeout: 30_000 }
  );
}

test('SW /pragya/: precaches the whole build; offline reload, demo flow and deep link render; asset miss rejects (never undefined)', async ({ page, context }) => {
  const errors = collectErrors(page, context);
  await page.goto(base());
  await expect(page.getByTestId('login-view')).toBeVisible();
  await waitForController(page);

  const info = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    const shell = keys.find(k => k.startsWith('pragya-shell-')) || '';
    const reqs = shell ? await (await caches.open(shell)).keys() : [];
    return { scope: reg?.scope || '', keys, shell, urls: reqs.map(r => new URL(r.url).pathname).sort() };
  });
  expect(new URL(info.scope).pathname).toBe('/pragya/');
  expect(info.shell).toMatch(/^pragya-shell-[0-9a-f]{12}$/);
  const distAssets = fs
    .readdirSync(path.join(distDir, 'assets'))
    .filter(f => !f.endsWith('.map'))
    .map(f => `/pragya/assets/${f}`);
  expect(distAssets.length).toBeGreaterThan(0);
  for (const a of distAssets) expect(info.urls).toContain(a);
  expect(info.urls).toContain('/pragya/fonts/InterVariable.woff2');
  expect(info.urls).toContain('/pragya/fonts/InterVariable-Italic.woff2');
  expect(info.urls).toContain('/pragya/index.html');
  expect(info.urls.every(u => u.startsWith('/pragya/'))).toBe(true);
  const swSource = fs.readFileSync(path.join(distDir, 'sw.js'), 'utf8');
  expect(swSource).toContain(info.shell.slice('pragya-shell-'.length));
  expect(swSource).not.toContain('__PRAGYA_BUILD_ID__');

  await stopServer();
  const probe = await page.evaluate(() =>
    fetch(`/pragya/probe-${Date.now()}.txt`).then(() => 'resolved', e => `rejected:${e.name}`)
  );
  expect(probe).toBe('rejected:TypeError'); // network really gone (SWR miss → Response.error())

  await page.reload();
  await expect(page.getByTestId('login-view')).toBeVisible();
  await page.getByTestId('demo-login-btn').click();
  await expect(page.getByTestId('shelf-view')).toBeVisible();

  await page.goto(`${base()}#/notes`);
  await expect(page.getByTestId('notes-view')).toBeVisible();

  const missed = await page.evaluate(() =>
    fetch('/pragya/assets/does-not-exist-123.js').then(() => 'resolved', e => `rejected:${e.name}`)
  );
  expect(missed).toBe('rejected:TypeError');
  expect(errors.filter(e => /not a Response|respondWith/i.test(e))).toEqual([]);
  expect(unexpected(errors)).toEqual([]);
});

test('SW /pragya/: offline with no cached shell serves the inline offline page; Try Again recovers', async ({ page, context }) => {
  const errors = collectErrors(page, context);
  await page.goto(base());
  await waitForController(page);
  await page.evaluate(async () => {
    for (const k of await caches.keys()) await caches.delete(k);
  });
  await stopServer();
  await page.reload();
  await expect(page.getByTestId('sw-offline-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible();
  await expect(
    page.getByText("Pragya will open as soon as you're back online. Your notes are safe in your Google account.")
  ).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(11, 12, 15)');
  // No external assets on the offline page.
  expect(await page.evaluate(() => document.querySelectorAll('link[href], script[src], img[src]').length)).toBe(0);

  await startServer();
  await page.getByRole('button', { name: 'Try Again' }).click();
  await expect(page.getByTestId('login-view')).toBeVisible();
  expect(errors.filter(e => /not a Response|respondWith/i.test(e))).toEqual([]);
  expect(unexpected(errors)).toEqual([]);
});

test('SW /pragya/: a new build activates → update toast, old shell caches evicted, media cache kept; Reload reloads', async ({ page }) => {
  const swPath = path.join(distDir, 'sw.js');
  const original = fs.readFileSync(swPath, 'utf8');
  const idMatch = /const BUILD_ID = (["'])([0-9a-f]{12})\1;/.exec(original);
  expect(idMatch, 'built sw.js has a 12-hex BUILD_ID').not.toBeNull();
  try {
    await page.goto(base());
    await expect(page.getByTestId('login-view')).toBeVisible();
    await waitForController(page);

    // A user-media entry and an orphaned older shell must be handled correctly by activate.
    await page.evaluate(async () => {
      const media = await caches.open('pragya-media-v1');
      await media.put('/pragya/__media-probe', new Response('img-bytes'));
      await caches.open('pragya-shell-000000000000');
    });

    fs.writeFileSync(swPath, original.replace(idMatch![0], `const BUILD_ID = ${idMatch![1]}ffffffffffff${idMatch![1]};`));
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await expect(page.getByText('A new version of Pragya is ready.')).toBeVisible({ timeout: 20_000 });

    // controllerchange fires as activation starts; eviction finishes inside activate → poll.
    await expect
      .poll(async () => (await page.evaluate(() => caches.keys())).sort(), { timeout: 20_000 })
      .toEqual(['pragya-media-v1', 'pragya-shell-ffffffffffff']);
    const mediaBody = await page.evaluate(async () => {
      const hit = await (await caches.open('pragya-media-v1')).match('/pragya/__media-probe');
      return hit ? hit.text() : null;
    });
    expect(mediaBody).toBe('img-bytes');

    await Promise.all([page.waitForEvent('load'), page.getByTestId('sw-update-reload-btn').click()]);
    await expect(page.getByTestId('login-view')).toBeVisible();
  } finally {
    fs.writeFileSync(swPath, original);
  }
});
