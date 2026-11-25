import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

const worker = await load('workers/oauth-proxy/src/index.mjs');
const proxyUtils = await load('src/utils/oauthProxy.ts');
const accountSession = await load('src/utils/accountSession.ts');

function createMemoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key(i) {
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(String(k), String(v));
    },
    removeItem(k) {
      map.delete(String(k));
    },
    clear() {
      map.clear();
    },
  };
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = createMemoryStorage();
}

const TEST_KEY_B64 = crypto.randomBytes(32).toString('base64');
const TEST_KEY_HEX = crypto.randomBytes(32).toString('hex');
const OTHER_KEY_B64 = crypto.randomBytes(32).toString('base64');
const ORIGIN = 'https://saimanoj01.github.io';
const CLIENT_ID = '12345-test.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-secret';
const VALID_VERIFIER = 'a'.repeat(64);

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// ---------------------------------------------------------------------------
// 1. Cloudflare Worker Crypto Sealing & AAD Binding
// ---------------------------------------------------------------------------

test('Worker crypto: AES-256-GCM seals/unseals refresh token with strict Origin + Client ID AAD binding', async () => {
  const key = await worker.importCipherKey(TEST_KEY_B64);
  const hexKey = await worker.importCipherKey(TEST_KEY_HEX);
  const otherKey = await worker.importCipherKey(OTHER_KEY_B64);
  assert.ok(key, '32-byte base64 key must import');
  assert.ok(hexKey, '64-char hex key must import');
  assert.equal(await worker.importCipherKey('too-short'), null, 'Short keys must be rejected');

  const sealed = await worker.sealRefreshToken(
    { refreshToken: '1//0g-refresh-secret-value', issuedAt: 1_700_000_000_000 },
    key,
    ORIGIN,
    CLIENT_ID
  );
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.includes('1//0g-refresh-secret-value'), 'Plaintext token must never appear in sealed string');

  const unsealed = await worker.unsealRefreshToken(sealed, key, ORIGIN, CLIENT_ID);
  assert.deepEqual(unsealed, {
    refreshToken: '1//0g-refresh-secret-value',
    clientId: CLIENT_ID,
    origin: ORIGIN,
    issuedAt: 1_700_000_000_000,
  });

  // Wrong key, wrong origin, wrong clientId, or tampered ciphertext MUST all fail closed
  assert.equal(await worker.unsealRefreshToken(sealed, otherKey, ORIGIN, CLIENT_ID), null);
  assert.equal(await worker.unsealRefreshToken(sealed, key, 'https://evil.example', CLIENT_ID), null);
  assert.equal(await worker.unsealRefreshToken(sealed, key, ORIGIN, 'other-cid'), null);
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(await worker.unsealRefreshToken(tampered, key, ORIGIN, CLIENT_ID), null);
});

// ---------------------------------------------------------------------------
// 2. Cloudflare Worker Endpoints (/health, CORS, /exchange, /refresh, /revoke)
// ---------------------------------------------------------------------------

test('Worker HTTP: CORS allowlist, /health, /exchange, /refresh (with rotation + error classes), and /revoke', async () => {
  const env = {
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    TOKEN_CIPHER_KEY: TEST_KEY_B64,
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:3000`,
  };

  let googleMode = 'ok';
  const googleCalls = [];
  const handler = worker.createOAuthProxyHandler({
    now: () => 1_700_000_000_000,
    fetch: async (url, init) => {
      const bodyStr = String(init?.body || '');
      const params = new URLSearchParams(bodyStr);
      googleCalls.push({ url: String(url), params: Object.fromEntries(params.entries()) });

      if (String(url).includes('/revoke')) {
        return new Response('', { status: 200 });
      }
      if (params.get('grant_type') === 'authorization_code') {
        if (googleMode === 'exchange_fail') {
          return jsonRes({ error: 'invalid_grant', error_description: 'Code expired' }, 400);
        }
        return jsonRes({
          access_token: 'ya29.initial-access',
          expires_in: 3600,
          refresh_token: '1//0g-refresh-v1',
          token_type: 'Bearer',
          scope: 'email profile',
        });
      }
      if (params.get('grant_type') === 'refresh_token') {
        if (googleMode === 'revoked') {
          return jsonRes({ error: 'invalid_grant', error_description: 'Token revoked' }, 400);
        }
        if (googleMode === 'google_503') {
          return jsonRes({ error: 'temporarily_unavailable' }, 503);
        }
        if (googleMode === 'rotate') {
          return jsonRes({
            access_token: 'ya29.rotated-access',
            expires_in: 3600,
            refresh_token: '1//0g-refresh-v2',
          });
        }
        return jsonRes({
          access_token: 'ya29.refreshed-access',
          expires_in: 3599,
        });
      }
      return jsonRes({ error: 'unsupported' }, 400);
    },
  });

  // 1. /health reports configured status
  const healthOk = await handler.fetch(
    new Request('https://proxy.workers.dev/health', { headers: { Origin: ORIGIN } }),
    env
  );
  assert.equal(healthOk.status, 200);
  assert.equal(healthOk.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(await healthOk.json(), {
    ok: true,
    service: 'pragya-oauth-proxy',
    configured: true,
  });

  // 2. OPTIONS & POST reject disallowed origin (and wildcard ALLOWED_ORIGINS is ignored)
  const badPreflight = await handler.fetch(
    new Request('https://proxy.workers.dev/refresh', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    }),
    env
  );
  assert.equal(badPreflight.status, 403);
  assert.equal(badPreflight.headers.get('Access-Control-Allow-Origin'), null);

  const okPreflight = await handler.fetch(
    new Request('https://proxy.workers.dev/refresh', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN },
    }),
    env
  );
  assert.equal(okPreflight.status, 204);
  assert.equal(okPreflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);

  // 3. /exchange rejects clientId mismatch, bad PKCE verifier, and cross-origin redirectUri
  const mismatchRes = await handler.fetch(
    new Request('https://proxy.workers.dev/exchange', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'code-1',
        codeVerifier: VALID_VERIFIER,
        redirectUri: `${ORIGIN}/pragya/`,
        clientId: 'wrong-client-id',
      }),
    }),
    env
  );
  assert.equal(mismatchRes.status, 400);
  assert.equal((await mismatchRes.json()).error, 'client_id_mismatch');

  const badRedirectRes = await handler.fetch(
    new Request('https://proxy.workers.dev/exchange', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'code-1',
        codeVerifier: VALID_VERIFIER,
        redirectUri: 'https://evil.example/pragya/',
        clientId: CLIENT_ID,
      }),
    }),
    env
  );
  assert.equal(badRedirectRes.status, 400);
  assert.equal((await badRedirectRes.json()).error, 'invalid_redirect_uri');

  // 4. Valid /exchange returns access_token + AES-GCM sealed_refresh_token (never raw refresh_token)
  const exchangeRes = await handler.fetch(
    new Request('https://proxy.workers.dev/exchange', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'auth-code-123',
        codeVerifier: VALID_VERIFIER,
        redirectUri: `${ORIGIN}/pragya/`,
        clientId: CLIENT_ID,
      }),
    }),
    env
  );
  assert.equal(exchangeRes.status, 200);
  assert.equal(exchangeRes.headers.get('Cache-Control'), 'no-store');
  const exchangeData = await exchangeRes.json();
  assert.equal(exchangeData.access_token, 'ya29.initial-access');
  assert.equal(exchangeData.expires_in, 3600);
  assert.equal(exchangeData.refresh_token, undefined, 'Raw refresh_token must never be returned');
  assert.match(exchangeData.sealed_refresh_token, /^v1\./);

  // 5. /refresh unseals and mints a fresh access token
  const refreshRes = await handler.fetch(
    new Request('https://proxy.workers.dev/refresh', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sealedRefreshToken: exchangeData.sealed_refresh_token,
        clientId: CLIENT_ID,
      }),
    }),
    env
  );
  assert.equal(refreshRes.status, 200);
  const refreshData = await refreshRes.json();
  assert.equal(refreshData.access_token, 'ya29.refreshed-access');
  assert.equal(refreshData.sealed_refresh_token, undefined);

  // 6. /refresh handles refresh_token rotation cleanly
  googleMode = 'rotate';
  const rotateRes = await handler.fetch(
    new Request('https://proxy.workers.dev/refresh', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sealedRefreshToken: exchangeData.sealed_refresh_token,
        clientId: CLIENT_ID,
      }),
    }),
    env
  );
  assert.equal(rotateRes.status, 200);
  const rotateData = await rotateRes.json();
  assert.equal(rotateData.access_token, 'ya29.rotated-access');
  assert.match(rotateData.sealed_refresh_token, /^v1\./);
  assert.notEqual(rotateData.sealed_refresh_token, exchangeData.sealed_refresh_token);

  // 7. /refresh maps Google invalid_grant -> 401 { revoked: true } and 503 -> 502 { transient: true }
  googleMode = 'revoked';
  const revokedRes = await handler.fetch(
    new Request('https://proxy.workers.dev/refresh', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sealedRefreshToken: rotateData.sealed_refresh_token,
        clientId: CLIENT_ID,
      }),
    }),
    env
  );
  assert.equal(revokedRes.status, 401);
  assert.equal((await revokedRes.json()).revoked, true);

  googleMode = 'google_503';
  const transientRes = await handler.fetch(
    new Request('https://proxy.workers.dev/refresh', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sealedRefreshToken: rotateData.sealed_refresh_token,
        clientId: CLIENT_ID,
      }),
    }),
    env
  );
  assert.equal(transientRes.status, 502);
  assert.equal((await transientRes.json()).transient, true);

  // 8. /revoke unseals and calls Google revoke endpoint with the raw refresh token
  const revokeRes = await handler.fetch(
    new Request('https://proxy.workers.dev/revoke', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sealedRefreshToken: rotateData.sealed_refresh_token,
        clientId: CLIENT_ID,
      }),
    }),
    env
  );
  assert.equal(revokeRes.status, 200);
  const lastGoogleCall = googleCalls[googleCalls.length - 1];
  assert.ok(lastGoogleCall.url.includes('/revoke'));
  assert.equal(lastGoogleCall.params.token, '1//0g-refresh-v2');
});

// ---------------------------------------------------------------------------
// 3. Frontend oauthProxy.ts Utilities (URL normalization, PKCE, Pending TX, Auth URL)
// ---------------------------------------------------------------------------

test('Frontend oauthProxy: normalizeAuthProxyUrl, PKCE S256, pending tx TTL, sealed matching & auth URLs', async () => {
  localStorage.clear();

  // URL normalization & validation
  assert.equal(
    proxyUtils.normalizeAuthProxyUrl('https://pragya-oauth-proxy.user.workers.dev///'),
    'https://pragya-oauth-proxy.user.workers.dev'
  );
  assert.equal(
    proxyUtils.normalizeAuthProxyUrl('http://localhost:8787/'),
    'http://localhost:8787'
  );
  assert.equal(proxyUtils.normalizeAuthProxyUrl('http://127.0.0.1:8787/auth/'), 'http://127.0.0.1:8787/auth');
  assert.equal(proxyUtils.normalizeAuthProxyUrl('http://insecure.example.com'), undefined);
  assert.equal(proxyUtils.normalizeAuthProxyUrl('https://user:pass@example.com'), undefined);
  assert.equal(proxyUtils.normalizeAuthProxyUrl('javascript:alert(1)'), undefined);
  assert.equal(proxyUtils.normalizeAuthProxyUrl('   '), undefined);

  // PKCE verifier & S256 challenge match RFC 7636
  const pkce = await proxyUtils.generatePkcePair();
  assert.ok(pkce);
  assert.match(pkce.codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/);
  const expectedChallenge = crypto
    .createHash('sha256')
    .update(pkce.codeVerifier)
    .digest('base64url');
  assert.equal(pkce.codeChallenge, expectedChallenge);

  // Pending OAuth tx persists across Android Custom Tab handoffs and expires after 10 min
  const t0 = 1_700_000_000_000;
  proxyUtils.savePendingOAuthTx({
    state: 'st-1',
    mode: 'pkce',
    codeVerifier: pkce.codeVerifier,
    returnRoute: '#/notes',
    createdAt: t0,
  });
  assert.equal(proxyUtils.readPendingOAuthTx(t0 + 60_000)?.state, 'st-1');
  assert.equal(
    proxyUtils.readPendingOAuthTx(t0 + proxyUtils.OAUTH_PENDING_TX_TTL_MS + 1),
    null,
    'Expired pending tx must be discarded'
  );
  assert.equal(localStorage.getItem(proxyUtils.OAUTH_PENDING_TX_KEY), null);

  // Sealed refresh record matches clientId + proxyUrl + case-insensitive email
  proxyUtils.writeSealedRefreshRecord({
    token: 'v1.iv.ct',
    email: 'Reader@Pragya.Dev',
    clientId: CLIENT_ID,
    proxyUrl: 'https://proxy.workers.dev/',
    savedAt: t0,
  });
  assert.ok(
    proxyUtils.getMatchingSealedRefreshRecord({
      clientId: CLIENT_ID,
      proxyUrl: 'https://proxy.workers.dev',
      expectedEmail: 'reader@pragya.dev',
    })
  );
  assert.equal(
    proxyUtils.getMatchingSealedRefreshRecord({
      clientId: 'other-cid',
      proxyUrl: 'https://proxy.workers.dev',
      expectedEmail: 'reader@pragya.dev',
    }),
    null
  );
  assert.equal(
    proxyUtils.getMatchingSealedRefreshRecord({
      clientId: CLIENT_ID,
      proxyUrl: 'https://proxy.workers.dev',
      expectedEmail: 'someone-else@pragya.dev',
    }),
    null
  );

  // Account switch cleanup MUST clear GOOGLE_SEALED_REFRESH_KEY
  accountSession.clearPerAccountLocalData();
  assert.equal(proxyUtils.readSealedRefreshRecord(), null);

  // Query callback detection
  assert.equal(proxyUtils.isOAuthCodeCallbackSearch('?code=abc&state=123'), true);
  assert.equal(proxyUtils.isOAuthCodeCallbackSearch('?error=access_denied&state=123'), true);
  assert.equal(proxyUtils.isOAuthCodeCallbackSearch('?foo=bar'), false);
  assert.equal(proxyUtils.isOAuthCodeCallbackSearch(''), false);

  // Auth URL builder: PKCE vs implicit reconnect vs switch account
  const pkceFresh = new URL(
    proxyUtils.buildGoogleAuthUrl({
      mode: 'pkce',
      clientId: CLIENT_ID,
      redirectUri: `${ORIGIN}/pragya/`,
      scope: 'email profile',
      state: 's1',
      codeChallenge: pkce.codeChallenge,
    })
  );
  assert.equal(pkceFresh.searchParams.get('response_type'), 'code');
  assert.equal(pkceFresh.searchParams.get('access_type'), 'offline');
  assert.equal(pkceFresh.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(pkceFresh.searchParams.get('prompt'), 'select_account consent');

  const pkceHint = new URL(
    proxyUtils.buildGoogleAuthUrl({
      mode: 'pkce',
      clientId: CLIENT_ID,
      redirectUri: `${ORIGIN}/pragya/`,
      scope: 'email profile',
      state: 's2',
      codeChallenge: pkce.codeChallenge,
      loginHint: 'reader@pragya.dev',
      reconnect: true,
    })
  );
  assert.equal(pkceHint.searchParams.get('prompt'), 'consent');
  assert.equal(pkceHint.searchParams.get('login_hint'), 'reader@pragya.dev');

  const implicitReconnect = new URL(
    proxyUtils.buildGoogleAuthUrl({
      mode: 'implicit',
      clientId: CLIENT_ID,
      redirectUri: `${ORIGIN}/pragya/`,
      scope: 'email profile',
      state: 's3',
      loginHint: 'reader@pragya.dev',
      reconnect: true,
    })
  );
  assert.equal(implicitReconnect.searchParams.get('response_type'), 'token');
  assert.equal(implicitReconnect.searchParams.get('login_hint'), 'reader@pragya.dev');
  assert.equal(implicitReconnect.searchParams.get('prompt'), null, 'Same-account reconnect skips account chooser');

  const implicitSwitch = new URL(
    proxyUtils.buildGoogleAuthUrl({
      mode: 'implicit',
      clientId: CLIENT_ID,
      redirectUri: `${ORIGIN}/pragya/`,
      scope: 'email profile',
      state: 's4',
      loginHint: 'reader@pragya.dev',
      reconnect: true,
      switchAccount: true,
    })
  );
  assert.equal(implicitSwitch.searchParams.get('prompt'), 'select_account');
  assert.equal(implicitSwitch.searchParams.get('login_hint'), null);
});

// ---------------------------------------------------------------------------
// 4. Single-Flight Proxy Refresh Controller (Dedup, Rotation, Revoked vs Transient, Mismatch)
// ---------------------------------------------------------------------------

test('Frontend createProxyRefreshController: single-flight mutex, rotation, revoked vs transient separation, and fail-closed email check', async () => {
  const nowMs = 1_700_000_000_000;

  // 1. Three concurrent callers share ONE HTTP request
  let refreshFetchCalls = 0;
  let releaseFetch = null;
  const ctrl = proxyUtils.createProxyRefreshController({
    now: () => nowMs,
    fetch: async () => {
      refreshFetchCalls += 1;
      await new Promise(resolve => {
        releaseFetch = resolve;
      });
      return jsonRes({
        access_token: 'ya29.proxy-fresh',
        expires_in: 3600,
        sealed_refresh_token: 'v1.rotated.tok',
      });
    },
    verifyTokenEmail: async () => 'match',
  });

  const req = {
    proxyUrl: 'https://proxy.workers.dev',
    clientId: CLIENT_ID,
    sealedRefreshToken: 'v1.orig.tok',
    expectedEmail: 'reader@pragya.dev',
    timeoutMs: 2000,
  };
  const p1 = ctrl.requestAccessToken(req);
  const p2 = ctrl.requestAccessToken({ ...req, expectedEmail: 'READER@pragya.dev' });
  const p3 = ctrl.requestAccessToken(req);

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(refreshFetchCalls, 1, 'Concurrent proxy refreshes must coalesce into one fetch');
  releaseFetch();

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  for (const r of [r1, r2, r3]) {
    assert.equal(r.ok, true);
    assert.equal(r.accessToken, 'ya29.proxy-fresh');
    assert.equal(r.expiresAt, nowMs + 3_600_000);
    assert.equal(r.rotatedSealedRefreshToken, 'v1.rotated.tok');
  }

  // 2. Revoked (401) vs transient network error vs 502 server_error vs account mismatch
  const ctrlRevoked = proxyUtils.createProxyRefreshController({
    fetch: async () => jsonRes({ error: 'invalid_grant', revoked: true }, 401),
  });
  assert.equal((await ctrlRevoked.requestAccessToken(req)).reason, 'revoked');

  const ctrlNet = proxyUtils.createProxyRefreshController({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal((await ctrlNet.requestAccessToken(req)).reason, 'network_error');

  const ctrl502 = proxyUtils.createProxyRefreshController({
    fetch: async () => jsonRes({ error: 'upstream_error', transient: true }, 502),
  });
  assert.equal((await ctrl502.requestAccessToken(req)).reason, 'server_error');

  const ctrlMismatch = proxyUtils.createProxyRefreshController({
    fetch: async () => jsonRes({ access_token: 'ya29.other-acct', expires_in: 3600 }, 200),
    verifyTokenEmail: async () => 'mismatch',
  });
  assert.equal((await ctrlMismatch.requestAccessToken(req)).reason, 'account_mismatch');

  const ctrlVerifyNetErr = proxyUtils.createProxyRefreshController({
    fetch: async () => jsonRes({ access_token: 'ya29.maybe-ok', expires_in: 3600 }, 200),
    verifyTokenEmail: async () => 'error',
  });
  assert.equal(
    (await ctrlVerifyNetErr.requestAccessToken(req)).reason,
    'network_error',
    'Transient userinfo failure must fail closed without reporting revocation'
  );
});
