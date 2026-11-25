/**
 * Pragya Stateless Google OAuth 2.0 Refresh Proxy (Cloudflare Worker).
 *
 * Zero dependencies, zero database/KV storage, zero user PII stored server-side.
 * - Exchanges PKCE authorization codes for Google access + refresh tokens.
 * - Seals Google's refresh_token with AES-256-GCM (AAD bound to Origin + Client ID)
 *   before returning it to the PWA.
 * - Refreshes expired 1-hour access tokens silently on behalf of allowed origins
 *   without browser popups or cross-site cookies (mobile PWA friendly).
 */

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const SEALED_VERSION = 'v1';
const MAX_JSON_BODY_BYTES = 16 * 1024;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(input) {
  if (typeof input !== 'string' || !input || /[^A-Za-z0-9+/_=-]/.test(input)) {
    return null;
  }
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function decodeCipherKeyBytes(secret) {
  if (typeof secret !== 'string') return null;
  const trimmed = secret.trim();
  if (!trimmed) return null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      out[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  const decoded = base64UrlToBytes(trimmed);
  if (decoded && decoded.length === 32) {
    return decoded;
  }
  return null;
}

export async function importCipherKey(secret) {
  const bytes = decodeCipherKeyBytes(secret);
  if (!bytes) return null;
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function buildAad(origin, clientId) {
  return textEncoder.encode(`${SEALED_VERSION}|${origin}|${clientId}`);
}

export async function sealRefreshToken(payload, cipherKey, origin, clientId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(
    JSON.stringify({
      v: 1,
      rt: payload.refreshToken,
      cid: clientId,
      ori: origin,
      iat: payload.issuedAt ?? Date.now(),
    })
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: buildAad(origin, clientId) },
      cipherKey,
      plaintext
    )
  );
  return `${SEALED_VERSION}.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

export async function unsealRefreshToken(sealed, cipherKey, origin, clientId) {
  if (typeof sealed !== 'string') return null;
  const parts = sealed.split('.');
  if (parts.length !== 3 || parts[0] !== SEALED_VERSION) return null;
  const iv = base64UrlToBytes(parts[1]);
  const ciphertext = base64UrlToBytes(parts[2]);
  if (!iv || iv.length !== 12 || !ciphertext || ciphertext.length < 17) return null;

  try {
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: buildAad(origin, clientId) },
      cipherKey,
      ciphertext
    );
    const parsed = JSON.parse(textDecoder.decode(new Uint8Array(plainBuf)));
    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.rt !== 'string' ||
      !parsed.rt.trim() ||
      parsed.cid !== clientId ||
      parsed.ori !== origin
    ) {
      return null;
    }
    return {
      refreshToken: parsed.rt,
      clientId: parsed.cid,
      origin: parsed.ori,
      issuedAt: typeof parsed.iat === 'number' ? parsed.iat : 0,
    };
  } catch {
    return null;
  }
}

export function parseAllowedOrigins(raw) {
  const set = new Set();
  if (typeof raw !== 'string') return set;
  for (const part of raw.split(/[\s,]+/)) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '*') continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        set.add(parsed.origin);
      }
    } catch {
      // Skip malformed entry
    }
  }
  return set;
}

export function parseAllowedRedirectUris(raw) {
  const set = new Set();
  if (typeof raw !== 'string') return set;
  for (const part of raw.split(/[\s,]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        set.add(parsed.href);
      }
    } catch {
      // Skip malformed entry
    }
  }
  return set;
}

export function isRedirectUriAllowed(redirectUri, requestOrigin, allowedRedirectUris) {
  if (typeof redirectUri !== 'string' || !redirectUri.trim()) return false;
  let parsed;
  try {
    parsed = new URL(redirectUri.trim());
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  const isLocalHttp =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]');
  if (parsed.protocol !== 'https:' && !isLocalHttp) return false;
  if (parsed.origin !== requestOrigin) return false;
  if (allowedRedirectUris.size > 0 && !allowedRedirectUris.has(parsed.href)) {
    return false;
  }
  return true;
}

function buildSecurityHeaders(allowedOrigin) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return headers;
}

function jsonResponse(body, status, allowedOrigin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: buildSecurityHeaders(allowedOrigin),
  });
}

async function readJsonBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_JSON_BODY_BYTES) {
    return { ok: false, status: 413, error: 'payload_too_large' };
  }
  try {
    const data = raw ? JSON.parse(raw) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, status: 400, error: 'invalid_json' };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
}

export function createOAuthProxyHandler(deps = {}) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const nowFn = deps.now ?? (() => Date.now());

  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      const origin = (request.headers.get('Origin') || '').trim();
      const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS || '');
      const allowedRedirectUris = parseAllowedRedirectUris(env.ALLOWED_REDIRECT_URIS || '');
      const originAllowed = Boolean(origin) && allowedOrigins.has(origin);
      const corsOrigin = originAllowed ? origin : null;

      if (request.method === 'OPTIONS') {
        if (!originAllowed) {
          return jsonResponse({ error: 'origin_not_allowed' }, 403, null);
        }
        const headers = buildSecurityHeaders(corsOrigin);
        headers.delete('Content-Type');
        return new Response(null, { status: 204, headers });
      }

      const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
      const clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
      const cipherKey = await importCipherKey(env.TOKEN_CIPHER_KEY || '');
      const isConfigured = Boolean(clientId && clientSecret && cipherKey && allowedOrigins.size > 0);

      if (pathname === '/health' && request.method === 'GET') {
        return jsonResponse(
          {
            ok: true,
            service: 'pragya-oauth-proxy',
            configured: isConfigured,
          },
          200,
          corsOrigin
        );
      }

      if (pathname !== '/exchange' && pathname !== '/refresh' && pathname !== '/revoke') {
        return jsonResponse({ error: 'not_found' }, 404, corsOrigin);
      }

      if (request.method !== 'POST') {
        return jsonResponse({ error: 'method_not_allowed' }, 405, corsOrigin);
      }

      if (!originAllowed) {
        return jsonResponse({ error: 'origin_not_allowed' }, 403, null);
      }

      if (!isConfigured || !cipherKey) {
        return jsonResponse({ error: 'server_misconfigured' }, 500, corsOrigin);
      }

      const parsedBody = await readJsonBody(request);
      if (!parsedBody.ok) {
        return jsonResponse({ error: parsedBody.error }, parsedBody.status, corsOrigin);
      }
      const body = parsedBody.data;

      if (
        typeof body.clientId === 'string' &&
        body.clientId.trim() &&
        body.clientId.trim() !== clientId
      ) {
        return jsonResponse(
          {
            error: 'client_id_mismatch',
            error_description: 'The Pragya Client ID does not match this Auth Proxy Worker.',
          },
          400,
          corsOrigin
        );
      }

      if (pathname === '/exchange') {
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        const codeVerifier = typeof body.codeVerifier === 'string' ? body.codeVerifier.trim() : '';
        const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri.trim() : '';

        if (!code || code.length > 4096) {
          return jsonResponse({ error: 'invalid_code' }, 400, corsOrigin);
        }
        if (!PKCE_VERIFIER_RE.test(codeVerifier)) {
          return jsonResponse({ error: 'invalid_code_verifier' }, 400, corsOrigin);
        }
        if (!isRedirectUriAllowed(redirectUri, origin, allowedRedirectUris)) {
          return jsonResponse({ error: 'invalid_redirect_uri' }, 400, corsOrigin);
        }

        let googleRes;
        try {
          googleRes = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: redirectUri,
              code_verifier: codeVerifier,
            }).toString(),
          });
        } catch {
          return jsonResponse({ error: 'upstream_error', transient: true }, 502, corsOrigin);
        }

        let googleData = {};
        try {
          googleData = await googleRes.json();
        } catch {
          googleData = {};
        }

        if (!googleRes.ok) {
          const isTransient = googleRes.status >= 500 || googleRes.status === 429;
          return jsonResponse(
            {
              error: googleData.error || (isTransient ? 'upstream_error' : 'exchange_failed'),
              ...(googleData.error_description
                ? { error_description: googleData.error_description }
                : {}),
              ...(isTransient ? { transient: true } : {}),
            },
            isTransient ? 502 : 400,
            corsOrigin
          );
        }

        const accessToken =
          typeof googleData.access_token === 'string' ? googleData.access_token.trim() : '';
        if (!accessToken) {
          return jsonResponse({ error: 'missing_access_token' }, 502, corsOrigin);
        }

        const refreshToken =
          typeof googleData.refresh_token === 'string' ? googleData.refresh_token.trim() : '';
        const sealedRefreshToken = refreshToken
          ? await sealRefreshToken(
              { refreshToken, issuedAt: nowFn() },
              cipherKey,
              origin,
              clientId
            )
          : undefined;

        return jsonResponse(
          {
            access_token: accessToken,
            expires_in: googleData.expires_in,
            token_type: googleData.token_type || 'Bearer',
            ...(typeof googleData.scope === 'string' ? { scope: googleData.scope } : {}),
            ...(sealedRefreshToken ? { sealed_refresh_token: sealedRefreshToken } : {}),
          },
          200,
          corsOrigin
        );
      }

      if (pathname === '/refresh') {
        const sealed =
          typeof body.sealedRefreshToken === 'string' ? body.sealedRefreshToken.trim() : '';
        const unsealed = await unsealRefreshToken(sealed, cipherKey, origin, clientId);
        if (!unsealed) {
          return jsonResponse(
            { error: 'invalid_sealed_token', revoked: true },
            401,
            corsOrigin
          );
        }

        let googleRes;
        try {
          googleRes = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: clientId,
              client_secret: clientSecret,
              refresh_token: unsealed.refreshToken,
            }).toString(),
          });
        } catch {
          return jsonResponse({ error: 'upstream_error', transient: true }, 502, corsOrigin);
        }

        let googleData = {};
        try {
          googleData = await googleRes.json();
        } catch {
          googleData = {};
        }

        if (!googleRes.ok) {
          const errCode = typeof googleData.error === 'string' ? googleData.error : '';
          if (errCode === 'invalid_grant' || errCode === 'unauthorized_client') {
            return jsonResponse(
              {
                error: errCode,
                ...(googleData.error_description
                  ? { error_description: googleData.error_description }
                  : {}),
                revoked: true,
              },
              401,
              corsOrigin
            );
          }
          return jsonResponse(
            {
              error: errCode || 'upstream_error',
              ...(googleData.error_description
                ? { error_description: googleData.error_description }
                : {}),
              transient: true,
            },
            502,
            corsOrigin
          );
        }

        const accessToken =
          typeof googleData.access_token === 'string' ? googleData.access_token.trim() : '';
        if (!accessToken) {
          return jsonResponse(
            { error: 'missing_access_token', transient: true },
            502,
            corsOrigin
          );
        }

        const rotatedRaw =
          typeof googleData.refresh_token === 'string' ? googleData.refresh_token.trim() : '';
        const rotatedSealed = rotatedRaw
          ? await sealRefreshToken(
              { refreshToken: rotatedRaw, issuedAt: nowFn() },
              cipherKey,
              origin,
              clientId
            )
          : undefined;

        return jsonResponse(
          {
            access_token: accessToken,
            expires_in: googleData.expires_in,
            token_type: googleData.token_type || 'Bearer',
            ...(typeof googleData.scope === 'string' ? { scope: googleData.scope } : {}),
            ...(rotatedSealed ? { sealed_refresh_token: rotatedSealed } : {}),
          },
          200,
          corsOrigin
        );
      }

      // POST /revoke (best-effort revocation on explicit logout)
      const sealed =
        typeof body.sealedRefreshToken === 'string' ? body.sealedRefreshToken.trim() : '';
      const unsealed = await unsealRefreshToken(sealed, cipherKey, origin, clientId);
      if (unsealed) {
        try {
          await fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: unsealed.refreshToken }).toString(),
          });
        } catch {
          // Best-effort revoke
        }
      }
      return jsonResponse({ ok: true }, 200, corsOrigin);
    },
  };
}

const defaultHandler = createOAuthProxyHandler();
export default defaultHandler;
