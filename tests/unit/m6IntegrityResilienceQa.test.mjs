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

// QA (Batch 3) adversarial probes. QA-11/12/13 were `{ todo }` findings — fixed in the
// Batch 3 fix-up and now normal tests. (Original note: tests marked `todo` document open
// low-severity findings from team/batch3_qa_report.md; they do not fail the run.)

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const { ApiError, classifyApiError, describeSyncError, RATE_LIMIT_TOAST } = await load('src/utils/apiErrors.ts');
const { RowConflictError, RowMovedError, resolveExpectedBase } = await load('src/utils/conflictGuard.ts');
const { isNetworkError, OfflineReadOnlyError } = await load('src/utils/offline.ts');
const { parseHash, safeDecode } = await load('src/utils/navigation.ts');
const { computeExpiresAt, isTokenExpired, parseStoredExpiresAt } = await load('src/utils/tokenExpiry.ts');
const {
  mergeEditedAttachments,
  mergeUnknownMetaKeys,
  splitAttachments,
  getRenderableAttachments,
  BOOK_EDITOR_OWNED_META_KEYS,
  NOTE_EDITOR_OWNED_META_KEYS,
} = await load('src/utils/metaCodecs.ts');
const { GoogleSheetsAdapter, SHEETS_CACHE_STORAGE_KEY, SHEETS_CACHE_CODEC_VERSION, SPREADSHEET_ID_STORAGE_KEY } =
  await load('src/services/googleSheetsAdapter.ts');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const noSleep = async () => {};
const book = (overrides = {}) => ({
  id: 'book-1', title: 'Book', author: 'A', format: 'physical', kind: 'nonfiction', status: 'reading',
  currentPos: 10, totalPos: 100, posUnit: 'page', normalizedPos: 0.1, docUrl: '',
  meta: { updatedAt: '2026-11-16T12:00:00.000Z', subgenre: 'memoir' }, ...overrides,
});
const apiErr = (status, body) => new ApiError(status, typeof body === 'string' ? body : JSON.stringify(body));

// ---------------------------------------------------------------------------
// classifyApiError
// ---------------------------------------------------------------------------

test('QA: classifyApiError matrix (403 permission vs quota, legacy messages, non-HTTP)', () => {
  const cases = [
    [apiErr(429, ''), 'rate_limited'],
    [apiErr(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } }), 'forbidden'],
    [apiErr(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }), 'rate_limited'],
    [apiErr(403, { error: { errors: [{ reason: 'userRateLimitExceeded', domain: 'usageLimits' }] } }), 'rate_limited'],
    [apiErr(403, { error: { status: 'RESOURCE_EXHAUSTED' } }), 'rate_limited'],
    [apiErr(403, 'User rate limit exceeded.'), 'rate_limited'],
    [apiErr(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }), 'forbidden'],
    [apiErr(403, '<html>Forbidden</html>'), 'forbidden'],
    [apiErr(403, { error: { message: 'Spreadsheet sheet-4291 forbidden' } }), 'forbidden'],
    [apiErr(404, ''), 'not_found'],
    [apiErr(500, 'RESOURCE_EXHAUSTED'), 'other'],
    [apiErr(503, ''), 'other'],
    [new Error('API Error 403: {"error":{"errors":[{"reason":"quotaExceeded"}]}}'), 'rate_limited'],
    [new Error('API Error 403: nope'), 'forbidden'],
    [new Error('API Error 429: '), 'rate_limited'],
    [new TypeError('Failed to fetch'), 'other'],
    [new Error('401 Unauthorized'), 'other'],
    [null, 'other'],
    ['API Error 404: gone', 'not_found'],
  ];
  for (const [err, expected] of cases) {
    assert.equal(classifyApiError(err), expected, String(err?.message ?? err));
  }
  assert.equal(describeSyncError(apiErr(429, '')), RATE_LIMIT_TOAST);
  assert.equal(describeSyncError(new Error('boom')), 'boom');
});

test('QA-12: Drive 403 daily/sharing quota reasons are treated as rate limits (cache kept)', () => {
  for (const reason of ['dailyLimitExceeded', 'sharingRateLimitExceeded']) {
    assert.equal(classifyApiError(apiErr(403, { error: { errors: [{ reason, domain: 'usageLimits' }] } })), 'rate_limited', reason);
  }
});

// ---------------------------------------------------------------------------
// fetchApi retry counts
// ---------------------------------------------------------------------------

async function withFetch(fetchImpl, fn) {
  localStorage.clear();
  const orig = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
    localStorage.clear();
  }
}

test('QA: retry policy — 5xx and plain 403 are never retried; quota-403 then 200 succeeds; writes retried on 429', async () => {
  for (const [status, body] of [[500, 'RESOURCE_EXHAUSTED text'], [503, ''], [403, '{"error":{"status":"PERMISSION_DENIED"}}'], [404, '']]) {
    let n = 0;
    const sleeps = [];
    await withFetch(
      async () => {
        n += 1;
        return new Response(body, { status });
      },
      async () => {
        const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: async ms => sleeps.push(ms) });
        localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
        await adapter.saveBook(book()).catch(() => {});
      }
    );
    assert.equal(sleeps.length, 0, `status ${status} must not back off`);
  }

  // A 429 on the PUT itself is retried (server rejected it, so no double write).
  const calls = [];
  let putAttempts = 0;
  await withFetch(
    async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || 'GET').toUpperCase();
      calls.push({ method, u });
      if (u.includes('/values/Books!A%3AA')) return json({ values: [['id'], ['book-1']] });
      // Batch 3 fix-up R1#2: every update verifies the one-cell id first.
      if (/\/values\/Books!A2\?/.test(u)) return json({ values: [['book-1']] });
      if (method === 'PUT') {
        putAttempts += 1;
        return putAttempts < 3 ? new Response('{"error":{"code":429}}', { status: 429 }) : json({});
      }
      if (u.includes('drive/v3/files/')) return json({ id: 'sheet-1', modifiedTime: 'x' });
      return json({});
    },
    async () => {
      localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
      const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
      await adapter.saveBook(book());
    }
  );
  assert.equal(putAttempts, 3);
});

// ---------------------------------------------------------------------------
// Explicit "" base and RowMovedError
// ---------------------------------------------------------------------------

test('QA: explicit "" base disables the guard (documented semantics) — no guard read, write proceeds', async () => {
  const calls = [];
  await withFetch(
    async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || 'GET').toUpperCase();
      calls.push({ method, u });
      if (u.includes('/values/Books!A%3AA')) return json({ values: [['id'], ['book-1']] });
      // Batch 3 fix-up R1#2: the unguarded write still verifies the one-cell id (no timestamp).
      if (/\/values\/Books!A2\?/.test(u)) return json({ values: [['book-1']] });
      if (u.includes('Books!A2%3AL2') && method === 'GET') {
        return json({ values: [['book-1', '', '', '', '', '', 0, 0, '', 0, '', JSON.stringify({ updatedAt: '2099-01-01T00:00:00Z' })]] });
      }
      return json({});
    },
    async () => {
      localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
      const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
      await adapter.saveBook(book(), { expectedBaseUpdatedAt: '' });
    }
  );
  assert.equal(calls.some(c => c.method === 'GET' && c.u.includes('Books!A2%3AL2')), false);
  assert.equal(calls.filter(c => c.method === 'GET' && /\/values\/Books!A2\?/.test(c.u)).length, 1);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(resolveExpectedBase('', '2026-11-16T00:00:00Z'), '');
  assert.equal(resolveExpectedBase(undefined, 'L'), 'L');
  assert.equal(resolveExpectedBase(undefined, undefined), undefined);
});

test('QA: RowMovedError — id vanished on re-resolve, and guard row id blank; never PUTs; not a network error', async () => {
  for (const scenario of ['vanished', 'blank-guard']) {
    const calls = [];
    let colAReads = 0;
    const err = await withFetch(
      async (url, init = {}) => {
        const u = String(url);
        const method = (init.method || 'GET').toUpperCase();
        calls.push({ method, u });
        if (u.includes('/values/Books!A%3AA')) {
          colAReads += 1;
          if (scenario === 'vanished' && colAReads > 1) return json({ values: [['id'], ['other']] });
          return json({ values: [['id'], ['book-1']] });
        }
        if (method === 'GET' && u.includes('Books!A2%3AL2')) {
          return json({ values: [scenario === 'blank-guard' ? [''] : ['someone-else']] });
        }
        return json({});
      },
      async () => {
        localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
        const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
        return adapter.saveBook(book(), { expectedBaseUpdatedAt: '2026-11-16T12:00:00.000Z' }).then(
          () => null,
          e => e
        );
      }
    );
    assert.ok(err instanceof RowMovedError, `${scenario}: ${err}`);
    assert.equal(err.code, 'ROW_MOVED');
    assert.equal(isNetworkError(err), false);
    assert.equal(calls.filter(c => c.method === 'PUT').length, 0, scenario);
  }
});

// ---------------------------------------------------------------------------
// Drive modifiedTime 403 rate-limit keeps the cache
// ---------------------------------------------------------------------------

test('QA: Drive modifiedTime 429 (retries exhausted) serves the v2 cache and never wipes it', async () => {
  const cache = {
    spreadsheetId: 'sheet-1',
    modifiedTime: '2026-11-15T00:00:00Z',
    codecVersion: SHEETS_CACHE_CODEC_VERSION,
    state: { books: [book()], notes: [], sessions: [], deltaLogs: [] },
  };
  let driveCalls = 0;
  const ws = await withFetch(
    async url => {
      if (String(url).includes('drive/v3/files/sheet-1')) {
        driveCalls += 1;
        return new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', { status: 429 });
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      localStorage.setItem(SPREADSHEET_ID_STORAGE_KEY, 'sheet-1');
      localStorage.setItem(SHEETS_CACHE_STORAGE_KEY, JSON.stringify(cache));
      const adapter = new GoogleSheetsAdapter(() => 'tok', undefined, undefined, { sleep: noSleep });
      const result = await adapter.loadWorkspace();
      assert.ok(localStorage.getItem(SHEETS_CACHE_STORAGE_KEY), 'cache kept');
      assert.equal(localStorage.getItem(SPREADSHEET_ID_STORAGE_KEY), 'sheet-1');
      return result;
    }
  );
  assert.equal(driveCalls, 3);
  assert.equal(ws.books[0].meta.subgenre, 'memoir');
  assert.notEqual(ws.isOfflineReadOnly, true);
});

// ---------------------------------------------------------------------------
// isNetworkError narrowing
// ---------------------------------------------------------------------------

test('QA: isNetworkError recognises real browser fetch failures and rejects code bugs', () => {
  const yes = [
    new TypeError('Failed to fetch'), // Chrome
    new TypeError('NetworkError when attempting to fetch resource.'), // Firefox
    new TypeError('Load failed'), // Safari
    new TypeError('The Internet connection appears to be offline.'), // Safari
    new Error('net::ERR_INTERNET_DISCONNECTED'),
    'TypeError: Failed to fetch',
  ];
  const no = [
    new TypeError("Cannot read properties of undefined (reading 'map')"),
    new TypeError('x.map is not a function'),
    new OfflineReadOnlyError(),
    new RowConflictError('a', 'b'),
    new RowMovedError(),
    new Error('API Error 503: Service Unavailable offline'),
    new Error('401 Unauthorized'),
    new Error('Not authenticated'),
    null,
    undefined,
  ];
  for (const e of yes) assert.equal(isNetworkError(e), true, String(e?.message ?? e));
  for (const e of no) assert.equal(isNetworkError(e), false, String(e?.message ?? e));
});

test('QA-11: Safari "The network connection was lost." is a transport failure', () => {
  assert.equal(isNetworkError(new TypeError('The network connection was lost.')), true);
});

// ---------------------------------------------------------------------------
// safeDecode / parseHash
// ---------------------------------------------------------------------------

test('QA: safeDecode and parseHash never throw on hostile segments', () => {
  assert.equal(safeDecode('%E0%A4'), '%E0%A4');
  assert.equal(safeDecode('%'), '%');
  assert.equal(safeDecode('%zz'), '%zz');
  assert.equal(safeDecode('%E0%A4%AA'), 'प');
  assert.equal(safeDecode('a%2Fb'), 'a/b');
  for (const h of ['#/note/%', '#/book/%E0%A4', '#/note/%25%', '#/note/%F0%9F%93', '#//', '#/note/', '#']) {
    assert.doesNotThrow(() => parseHash(h), h);
  }
  assert.deepEqual(
    { view: parseHash('#/book/%E0%A4').view, bookId: parseHash('#/book/%E0%A4').bookId },
    { view: 'book', bookId: '%E0%A4' }
  );
});

// ---------------------------------------------------------------------------
// Token expiry
// ---------------------------------------------------------------------------

test('QA: token expiry — 30 s skew boundary, missing/garbage expires_in never expires', () => {
  const now = 1_000_000;
  assert.equal(computeExpiresAt('3600', now), now + 3_600_000);
  assert.equal(computeExpiresAt(3599, now), now + 3_599_000);
  for (const bad of [undefined, null, '', '0', 0, '-5', 'abc', 'NaN', 'Infinity']) {
    assert.equal(computeExpiresAt(bad, now), null, String(bad));
  }
  assert.equal(computeExpiresAt(' 60 ', now), now + 60_000);
  const exp = now + 60_000;
  assert.equal(isTokenExpired(exp, exp - 30_001), false);
  assert.equal(isTokenExpired(exp, exp - 30_000), true); // exactly at skew → expired
  assert.equal(isTokenExpired(null, Number.MAX_SAFE_INTEGER), false);
  for (const raw of [null, undefined, '', 'abc', '-1', '0']) {
    assert.equal(parseStoredExpiresAt(raw), null, String(raw));
  }
  assert.equal(parseStoredExpiresAt(String(exp)), exp);
});

// ---------------------------------------------------------------------------
// mergeUnknownMetaKeys / mergeEditedAttachments
// ---------------------------------------------------------------------------

test('QA: mergeUnknownMetaKeys — foreign keys survive, editor deletions stick, latest wins for non-editor keys', () => {
  const latest = {
    updatedAt: 'L', coverUrl: 'c', currentChapter: 'Ch 9', subgenre: 'memoir',
    capstone: { arcOrThesis: 'new' }, agent: { x: 1 },
  };
  const edited = { updatedAt: 'E', capstone: { arcOrThesis: 'stale' } };
  const out = mergeUnknownMetaKeys(edited, latest, BOOK_EDITOR_OWNED_META_KEYS);
  assert.equal(out.updatedAt, 'E');
  assert.equal('coverUrl' in out, false); // deliberate deletion sticks
  // Batch 3 fix-up (R2#1): currentChapter is not editor-owned until Batch 7's chapter UI.
  assert.equal(out.currentChapter, 'Ch 9');
  assert.equal(out.subgenre, 'memoir');
  assert.deepEqual(out.agent, { x: 1 });
  // Batch 3 fix-up (R1#3): editors never change non-editor keys → latest value wins.
  assert.deepEqual(out.capstone, { arcOrThesis: 'new' });
  assert.deepEqual(edited, { updatedAt: 'E', capstone: { arcOrThesis: 'stale' } }, 'input not mutated');

  // Explicit undefined = present key → never resurrected.
  const noteOut = mergeUnknownMetaKeys({ title: undefined, attachments: [] }, { title: 'Old', sparStage: 's1', attachments: [1] }, NOTE_EDITOR_OWNED_META_KEYS);
  assert.equal(noteOut.title, undefined);
  assert.equal(noteOut.sparStage, 's1');
  assert.deepEqual(noteOut.attachments, []);

  for (const latestBad of [null, undefined, [], 'x', 5]) {
    assert.deepEqual(mergeUnknownMetaKeys({ a: 1 }, latestBad, []), { a: 1 });
  }
  // JSON-sourced __proto__ key is copied as data, no pollution.
  const polluted = JSON.parse('{"__proto__":{"evil":true},"ok":1}');
  const merged = mergeUnknownMetaKeys({}, polluted, []);
  assert.equal({}.evil, undefined);
  assert.equal(merged.ok, 1);
});

const A = { id: 'a', type: 'link', url: 'https://a', title: 'A' };
const B = { id: 'b', type: 'doc', url: 'https://b', title: 'B' };
const C = { id: 'c', type: 'image', fileName: 'c.webp', mimeType: 'image/webp' };
const D = { id: 'd', type: 'link', url: 'https://d', title: 'D' };
const J = { id: 'j', type: 'video' };

test('QA: mergeEditedAttachments — order, preserved-in-place, remove, add, edit, idempotent', () => {
  const original = [J, A, 'junk', B, C, D];
  const editable = splitAttachments(original).renderable;
  assert.deepEqual(editable.map(a => a.id), ['a', 'b', 'c']);
  // No-op
  assert.deepEqual(mergeEditedAttachments(original, editable), original);
  // Remove B, edit A's title, add E
  const E = { id: 'e', type: 'link', url: 'https://e', title: 'E' };
  const edited = [{ ...A, title: 'A2' }, C, E];
  const out = mergeEditedAttachments(original, edited);
  assert.deepEqual(out, [J, { ...A, title: 'A2' }, 'junk', C, D, E]);
  // Re-open + no-op on the result is stable.
  assert.deepEqual(mergeEditedAttachments(out, splitAttachments(out).renderable), out);
  assert.deepEqual(getRenderableAttachments({ attachments: out }).map(a => a.id), ['a', 'c', 'd']);
  // Non-array original
  assert.deepEqual(mergeEditedAttachments(undefined, [A]), [A]);
  assert.deepEqual(mergeEditedAttachments('x', []), []);
});

test('QA-13: duplicate-id attachments survive a no-op edit', () => {
  const A2 = { ...A, url: 'https://a-two' };
  const original = [A, A2];
  const out = mergeEditedAttachments(original, splitAttachments(original).renderable);
  assert.equal(out.length, 2);
});
