import { computeExpiresAt } from './tokenExpiry';

/**
 * Persistent PWA OAuth 2.0 PKCE + Stateless Refresh Proxy helpers.
 *
 * Pure, erasable TypeScript with zero React imports so PKCE generation, URL building,
 * pending transaction persistence (Android Custom Tab resilience), sealed refresh token
 * scoping, and single-flight proxy refresh mutex are directly unit-testable in Node.
 */

export const GOOGLE_AUTH_PROXY_URL_KEY = 'pragya_google_auth_proxy_url';
export const GOOGLE_SEALED_REFRESH_KEY = 'pragya_google_sealed_refresh_v1';
export const OAUTH_PENDING_TX_KEY = 'pragya_oauth_pending_tx_v1';

/** Pending OAuth transactions expire after 10 minutes (bounds localStorage CSRF fallback). */
export const OAUTH_PENDING_TX_TTL_MS = 10 * 60 * 1000;
/** Network timeout for Worker `/exchange` and `/refresh` calls. */
export const OAUTH_PROXY_TIMEOUT_MS = 8_000;

export interface PendingOAuthTx {
  state: string;
  mode: 'pkce' | 'implicit';
  codeVerifier?: string;
  returnRoute?: string;
  redirectUri?: string;
  proxyUrl?: string;
  clientId?: string;
  createdAt: number;
}

export interface SealedRefreshRecord {
  token: string;
  email: string;
  clientId: string;
  proxyUrl: string;
  savedAt: number;
}

export type ProxyRefreshFailureReason =
  | 'revoked'
  | 'client_id_mismatch'
  | 'network_error'
  | 'timeout'
  | 'server_error'
  | 'account_mismatch'
  | 'invalid_response';

export type ProxyRefreshResult =
  | {
      ok: true;
      accessToken: string;
      expiresAt: number | null;
      rotatedSealedRefreshToken?: string;
    }
  | {
      ok: false;
      reason: ProxyRefreshFailureReason;
      detail?: string;
    };

export type ProxyExchangeResult =
  | {
      ok: true;
      accessToken: string;
      expiresAt: number | null;
      sealedRefreshToken?: string;
    }
  | {
      ok: false;
      reason: 'network_error' | 'timeout' | 'client_id_mismatch' | 'exchange_failed' | 'invalid_response';
      detail?: string;
    };

export type EmailVerificationOutcome = 'match' | 'mismatch' | 'error';

export interface ProxyRefreshRequest {
  proxyUrl: string;
  clientId: string;
  sealedRefreshToken: string;
  expectedEmail?: string;
  timeoutMs?: number;
}

export interface ProxyRefreshControllerDeps {
  fetch?: typeof fetch;
  verifyTokenEmail?: (
    accessToken: string,
    expectedEmail: string,
    timeoutMs?: number
  ) => Promise<EmailVerificationOutcome>;
  now?: () => number;
}

export interface ProxyRefreshController {
  requestAccessToken: (req: ProxyRefreshRequest) => Promise<ProxyRefreshResult>;
  reset: () => void;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Validates and normalizes an Auth Proxy base URL.
 * Accepts `https://...` (and `http://localhost` / `127.0.0.1` / `[::1]` for local dev/E2E).
 * Rejects embedded credentials, query/hash fragments, and non-HTTP(S) schemes.
 */
export function normalizeAuthProxyUrl(raw: string | null | undefined): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.username || parsed.password) return undefined;
  const isLocalHttp =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]');
  if (parsed.protocol !== 'https:' && !isLocalHttp) return undefined;
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}

/**
 * Generates an RFC 7636 PKCE verifier (86 chars) and S256 challenge.
 * Returns `null` if Web Crypto subtle digest is unavailable (e.g. insecure non-localhost HTTP).
 */
export async function generatePkcePair(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
} | null> {
  if (
    typeof crypto === 'undefined' ||
    typeof crypto.getRandomValues !== 'function' ||
    !crypto.subtle ||
    typeof crypto.subtle.digest !== 'function'
  ) {
    return null;
  }
  try {
    const randomBytes = new Uint8Array(64);
    crypto.getRandomValues(randomBytes);
    const codeVerifier = bytesToBase64Url(randomBytes);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    const codeChallenge = bytesToBase64Url(new Uint8Array(digest));
    return { codeVerifier, codeChallenge };
  } catch {
    return null;
  }
}

export function savePendingOAuthTx(tx: PendingOAuthTx): void {
  try {
    localStorage.setItem(OAUTH_PENDING_TX_KEY, JSON.stringify(tx));
  } catch {
    // Ignore storage quota / private mode errors
  }
}

export function readPendingOAuthTx(now: number = Date.now()): PendingOAuthTx | null {
  try {
    const raw = localStorage.getItem(OAUTH_PENDING_TX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingOAuthTx>;
    if (
      !parsed ||
      typeof parsed.state !== 'string' ||
      !parsed.state.trim() ||
      (parsed.mode !== 'pkce' && parsed.mode !== 'implicit') ||
      typeof parsed.createdAt !== 'number' ||
      !Number.isFinite(parsed.createdAt)
    ) {
      localStorage.removeItem(OAUTH_PENDING_TX_KEY);
      return null;
    }
    if (now - parsed.createdAt > OAUTH_PENDING_TX_TTL_MS || parsed.createdAt > now + 60_000) {
      localStorage.removeItem(OAUTH_PENDING_TX_KEY);
      return null;
    }
    return parsed as PendingOAuthTx;
  } catch {
    try {
      localStorage.removeItem(OAUTH_PENDING_TX_KEY);
    } catch {
      // Ignore cleanup error
    }
    return null;
  }
}

export function clearPendingOAuthTx(): void {
  try {
    localStorage.removeItem(OAUTH_PENDING_TX_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function readSealedRefreshRecord(): SealedRefreshRecord | null {
  try {
    const raw = localStorage.getItem(GOOGLE_SEALED_REFRESH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SealedRefreshRecord>;
    const normalizedProxy = normalizeAuthProxyUrl(parsed?.proxyUrl);
    if (
      !parsed ||
      typeof parsed.token !== 'string' ||
      !parsed.token.trim() ||
      typeof parsed.email !== 'string' ||
      !parsed.email.trim() ||
      typeof parsed.clientId !== 'string' ||
      !parsed.clientId.trim() ||
      !normalizedProxy
    ) {
      return null;
    }
    return {
      token: parsed.token.trim(),
      email: parsed.email.trim(),
      clientId: parsed.clientId.trim(),
      proxyUrl: normalizedProxy,
      savedAt: typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeSealedRefreshRecord(record: SealedRefreshRecord): void {
  const normalizedProxy = normalizeAuthProxyUrl(record.proxyUrl);
  if (!normalizedProxy || !record.token.trim() || !record.email.trim() || !record.clientId.trim()) {
    return;
  }
  try {
    localStorage.setItem(
      GOOGLE_SEALED_REFRESH_KEY,
      JSON.stringify({
        token: record.token.trim(),
        email: record.email.trim(),
        clientId: record.clientId.trim(),
        proxyUrl: normalizedProxy,
        savedAt: record.savedAt,
      })
    );
  } catch {
    // Ignore storage quota errors
  }
}

export function clearSealedRefreshRecord(): void {
  try {
    localStorage.removeItem(GOOGLE_SEALED_REFRESH_KEY);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Returns the stored sealed refresh record only when it matches the active Client ID,
 * Auth Proxy URL, and (when known) signed-in account email.
 */
export function getMatchingSealedRefreshRecord(opts: {
  clientId?: string;
  proxyUrl?: string;
  expectedEmail?: string;
}): SealedRefreshRecord | null {
  const clientId = (opts.clientId || '').trim();
  const proxyUrl = normalizeAuthProxyUrl(opts.proxyUrl);
  if (!clientId || !proxyUrl) return null;

  const record = readSealedRefreshRecord();
  if (!record) return null;
  if (record.clientId !== clientId) return null;
  if (record.proxyUrl !== proxyUrl) return null;

  const expected = (opts.expectedEmail || '').trim().toLowerCase();
  if (expected && record.email.trim().toLowerCase() !== expected) {
    return null;
  }
  return record;
}

const OAUTH_SEARCH_PARAMS = [
  'code',
  'state',
  'scope',
  'authuser',
  'prompt',
  'hd',
  'error',
  'error_description',
  'error_uri',
];

export function isOAuthCodeCallbackSearch(search: string): boolean {
  if (!search || !search.includes('=')) return false;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (params.has('code') && (params.get('code') || '').trim().length > 0) {
    return true;
  }
  if (params.has('error') && (params.has('state') || params.has('error_description'))) {
    return true;
  }
  return false;
}

export function clearOAuthSearchParams(): void {
  if (typeof window === 'undefined' || !window.location.search) return;
  try {
    const params = new URLSearchParams(window.location.search);
    let mutated = false;
    for (const key of OAUTH_SEARCH_PARAMS) {
      if (params.has(key)) {
        params.delete(key);
        mutated = true;
      }
    }
    if (!mutated) return;
    const nextSearch = params.toString();
    const nextUrl =
      window.location.pathname +
      (nextSearch ? `?${nextSearch}` : '') +
      (window.location.hash || '');
    window.history.replaceState(null, '', nextUrl);
  } catch {
    // Ignore restricted History API errors
  }
}

export interface BuildGoogleAuthUrlOptions {
  mode: 'pkce' | 'implicit';
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge?: string;
  loginHint?: string;
  reconnect?: boolean;
  switchAccount?: boolean;
}

/**
 * Builds the Google OAuth 2.0 authorization URL.
 * - `pkce`: requests `response_type=code` + `access_type=offline` + `S256` PKCE so the
 *   Worker obtains a long-lived refresh token. Requests `prompt=consent` (or
 *   `select_account consent` when no `loginHint` / switching accounts) so Google always
 *   issues a refresh token on first connect.
 * - `implicit`: requests `response_type=token`. Passes `login_hint` and omits
 *   `prompt=select_account` during same-account reconnects to skip the account chooser.
 */
export function buildGoogleAuthUrl(opts: BuildGoogleAuthUrlOptions): string {
  const hint = (opts.loginHint || '').trim();
  const useHint = Boolean(hint) && !opts.switchAccount;

  if (opts.mode === 'pkce') {
    const params = new URLSearchParams({
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      response_type: 'code',
      scope: opts.scope,
      state: opts.state,
      code_challenge: opts.codeChallenge || '',
      code_challenge_method: 'S256',
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: useHint ? 'consent' : 'select_account consent',
    });
    if (useHint) {
      params.set('login_hint', hint);
    }
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'token',
    scope: opts.scope,
    state: opts.state,
    include_granted_scopes: 'true',
  });
  if (opts.reconnect && useHint) {
    params.set('login_hint', hint);
  } else {
    params.set('prompt', 'select_account');
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function verifyProxyTokenEmail(
  accessToken: string,
  expectedEmail: string,
  timeoutMs: number = OAUTH_PROXY_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch
): Promise<EmailVerificationOutcome> {
  const expected = expectedEmail.trim().toLowerCase();
  if (!expected) return 'match';
  if (typeof fetchImpl !== 'function') return 'error';

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const effectiveTimeout = Math.max(50, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<EmailVerificationOutcome>(resolve => {
    timer = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // Ignore abort errors
      }
      resolve('error');
    }, effectiveTimeout);
  });

  const fetchPromise = (async (): Promise<EmailVerificationOutcome> => {
    try {
      const res = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) return 'error';
      const info = (await res.json()) as { email?: unknown };
      if (typeof info?.email === 'string' && info.email.trim()) {
        return info.email.trim().toLowerCase() === expected ? 'match' : 'mismatch';
      }
      return 'error';
    } catch {
      return 'error';
    }
  })();

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; reason: 'timeout' | 'network_error'; detail?: string }
> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const effectiveTimeout = Math.max(50, timeoutMs);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      controller?.abort();
    } catch {
      // Ignore abort errors
    }
  }, effectiveTimeout);

  try {
    const res = await fetchImpl(url, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    });
    let data: Record<string, unknown> = {};
    try {
      const parsed = (await res.json()) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = {};
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    if (timedOut) {
      return { ok: false, reason: 'timeout' };
    }
    return {
      ok: false,
      reason: 'network_error',
      detail: err instanceof Error ? err.message : 'Network error',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeAuthCodeViaProxy(
  req: {
    proxyUrl: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    timeoutMs?: number;
  },
  deps: { fetch?: typeof fetch; now?: () => number } = {}
): Promise<ProxyExchangeResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const nowFn = deps.now ?? (() => Date.now());
  const baseUrl = normalizeAuthProxyUrl(req.proxyUrl);
  if (!baseUrl) {
    return { ok: false, reason: 'exchange_failed', detail: 'Invalid auth proxy URL' };
  }

  const res = await fetchJsonWithTimeout(
    `${baseUrl}/exchange`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: req.code,
        codeVerifier: req.codeVerifier,
        redirectUri: req.redirectUri,
        clientId: req.clientId,
      }),
    },
    req.timeoutMs ?? OAUTH_PROXY_TIMEOUT_MS,
    fetchImpl
  );

  if (!res.ok) {
    return { ok: false, reason: res.reason, detail: res.detail };
  }

  if (res.status < 200 || res.status >= 300) {
    const errCode = typeof res.data.error === 'string' ? res.data.error : 'exchange_failed';
    const detail =
      typeof res.data.error_description === 'string' ? res.data.error_description : errCode;
    if (errCode === 'client_id_mismatch') {
      return { ok: false, reason: 'client_id_mismatch', detail };
    }
    return { ok: false, reason: 'exchange_failed', detail };
  }

  const accessToken =
    typeof res.data.access_token === 'string' ? res.data.access_token.trim() : '';
  if (!accessToken) {
    return { ok: false, reason: 'invalid_response', detail: 'Missing access_token' };
  }
  const expiresAt = computeExpiresAt(res.data.expires_in, nowFn());
  const sealedRefreshToken =
    typeof res.data.sealed_refresh_token === 'string' && res.data.sealed_refresh_token.trim()
      ? res.data.sealed_refresh_token.trim()
      : undefined;

  return {
    ok: true,
    accessToken,
    expiresAt,
    ...(sealedRefreshToken ? { sealedRefreshToken } : {}),
  };
}

/**
 * Creates a single-flight Auth Proxy token refresh controller.
 * Concurrent callers share ONE in-flight `POST /refresh` request, and transient
 * network/server failures are clearly separated from permanent revocations.
 */
export function createProxyRefreshController(
  deps: ProxyRefreshControllerDeps = {}
): ProxyRefreshController {
  const fetchImpl = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const verifyEmail =
    deps.verifyTokenEmail ??
    ((tok: string, email: string, ms?: number) => verifyProxyTokenEmail(tok, email, ms, fetchImpl));
  const nowFn = deps.now ?? (() => Date.now());

  const inFlight = new Map<string, Promise<ProxyRefreshResult>>();

  const runOnce = async (req: ProxyRefreshRequest): Promise<ProxyRefreshResult> => {
    const baseUrl = normalizeAuthProxyUrl(req.proxyUrl);
    if (!baseUrl) {
      return { ok: false, reason: 'invalid_response', detail: 'Invalid auth proxy URL' };
    }
    const timeoutMs = Math.max(50, req.timeoutMs ?? OAUTH_PROXY_TIMEOUT_MS);

    const res = await fetchJsonWithTimeout(
      `${baseUrl}/refresh`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sealedRefreshToken: req.sealedRefreshToken,
          clientId: req.clientId,
        }),
      },
      timeoutMs,
      fetchImpl
    );

    if (!res.ok) {
      return { ok: false, reason: res.reason, detail: res.detail };
    }

    if (res.status < 200 || res.status >= 300) {
      const errCode = typeof res.data.error === 'string' ? res.data.error : '';
      const detail =
        typeof res.data.error_description === 'string' ? res.data.error_description : errCode;
      if (errCode === 'client_id_mismatch') {
        return { ok: false, reason: 'client_id_mismatch', detail };
      }
      if (
        res.status === 401 ||
        res.data.revoked === true ||
        errCode === 'invalid_grant' ||
        errCode === 'invalid_sealed_token' ||
        errCode === 'unauthorized_client'
      ) {
        return { ok: false, reason: 'revoked', detail };
      }
      return { ok: false, reason: 'server_error', detail };
    }

    const accessToken =
      typeof res.data.access_token === 'string' ? res.data.access_token.trim() : '';
    if (!accessToken) {
      return { ok: false, reason: 'invalid_response', detail: 'Missing access_token' };
    }

    const expiresAt = computeExpiresAt(res.data.expires_in, nowFn());
    const rotatedSealedRefreshToken =
      typeof res.data.sealed_refresh_token === 'string' && res.data.sealed_refresh_token.trim()
        ? res.data.sealed_refresh_token.trim()
        : undefined;

    if (req.expectedEmail) {
      const verified = await verifyEmail(accessToken, req.expectedEmail, timeoutMs);
      if (verified === 'mismatch') {
        return { ok: false, reason: 'account_mismatch' };
      }
      if (verified === 'error') {
        return { ok: false, reason: 'network_error', detail: 'userinfo_verify_failed' };
      }
    }

    return {
      ok: true,
      accessToken,
      expiresAt,
      ...(rotatedSealedRefreshToken ? { rotatedSealedRefreshToken } : {}),
    };
  };

  const requestAccessToken = (req: ProxyRefreshRequest): Promise<ProxyRefreshResult> => {
    const baseUrl = normalizeAuthProxyUrl(req.proxyUrl) || '';
    const key = [
      baseUrl,
      req.clientId.trim(),
      (req.expectedEmail || '').trim().toLowerCase(),
      req.sealedRefreshToken.trim(),
    ].join('::');

    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = runOnce(req).finally(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
    });
    inFlight.set(key, promise);
    return promise;
  };

  const reset = () => {
    inFlight.clear();
  };

  return { requestAccessToken, reset };
}

const defaultProxyController = createProxyRefreshController();

export function requestProxyAccessToken(req: ProxyRefreshRequest): Promise<ProxyRefreshResult> {
  return defaultProxyController.requestAccessToken(req);
}

export function resetProxyRefreshForTests(): void {
  defaultProxyController.reset();
}

export async function revokeSealedRefreshViaProxy(
  req: { proxyUrl: string; sealedRefreshToken: string; clientId: string },
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const baseUrl = normalizeAuthProxyUrl(req.proxyUrl);
  if (!baseUrl || !req.sealedRefreshToken.trim()) return;
  try {
    await fetchJsonWithTimeout(
      `${baseUrl}/revoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sealedRefreshToken: req.sealedRefreshToken,
          clientId: req.clientId,
        }),
      },
      3_000,
      fetchImpl
    );
  } catch {
    // Best-effort revoke
  }
}
