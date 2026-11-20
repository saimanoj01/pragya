import { computeExpiresAt } from './tokenExpiry';

/**
 * CD Batch 8 (B4.12): Google Identity Services (GIS) silent OAuth2 access-token refresh.
 *
 * Pure, erasable TypeScript with zero React imports so eligibility, single-flight mutex,
 * timeout, account-mismatch protection, and offline/Playwright skipping are directly
 * unit-testable in Node without real Google network calls.
 */

export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
/** Proactively attempt a silent refresh when within 5 minutes of token expiry. */
export const GIS_SILENT_REFRESH_WINDOW_MS = 5 * 60 * 1000;
/** Hard timeout so a stuck GIS popup/iframe never blocks fallback to SessionExpiredModal. */
export const GIS_SILENT_REFRESH_TIMEOUT_MS = 5_000;
/** Minimum cooldown between proactive refreshes to prevent tight loops on short-lived tokens. */
export const GIS_PROACTIVE_MIN_COOLDOWN_MS = 60_000;

export interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

export interface GisTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string; hint?: string }) => void;
}

export interface GisOAuth2Namespace {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    hint?: string;
    callback: (response: GisTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }) => GisTokenClient;
}

export interface GisWindowLike {
  google?: {
    accounts?: {
      oauth2?: GisOAuth2Namespace;
    };
  };
  __PLAYWRIGHT__?: boolean;
}

export interface SilentRefreshEnv {
  clientId: string | undefined;
  isMockMode: boolean;
  isOffline: boolean;
  isPlaywright: boolean;
  /** True when `window.google.accounts.oauth2.initTokenClient` is already loaded/injected. */
  hasGisRuntime: boolean;
  expiresAt: number | null;
  now?: number;
  /** True when triggered reactively by an expired token (<= 30s) or a 401 Unauthorized. */
  force?: boolean;
}

export type SilentRefreshFailureReason =
  | 'ineligible'
  | 'script_load_failed'
  | 'gis_unavailable'
  | 'timeout'
  | 'gis_error'
  | 'missing_token'
  | 'account_mismatch';

export type SilentRefreshResult =
  | { ok: true; accessToken: string; expiresAt: number | null }
  | { ok: false; reason: SilentRefreshFailureReason; detail?: string };

export interface SilentRefreshRequest {
  clientId: string;
  scope: string;
  loginHint?: string;
  expectedEmail?: string;
  timeoutMs?: number;
}

export interface SilentRefreshControllerDeps {
  getOAuth2?: () => GisOAuth2Namespace | null;
  loadScript?: (timeoutMs: number) => Promise<boolean>;
  verifyTokenEmail?: (
    accessToken: string,
    expectedEmail: string,
    timeoutMs?: number
  ) => Promise<boolean>;
  now?: () => number;
}

/**
 * Pure eligibility guard for GIS silent token refresh (B4.12):
 *  - Never runs in Demo Mode, offline, or without a configured OAuth Client ID.
 *  - Never injects the external GIS script under Playwright (zero external network calls in CI),
 *    unless a test explicitly provides `window.google.accounts.oauth2.initTokenClient`.
 *  - When `force` is false (proactive check), runs only when `expiresAt` is known and within
 *    `GIS_SILENT_REFRESH_WINDOW_MS` (5 min).
 */
export function shouldAttemptSilentRefresh(env: SilentRefreshEnv): boolean {
  if (!env.clientId || !env.clientId.trim()) return false;
  if (env.isMockMode) return false;
  if (env.isOffline) return false;
  if (env.isPlaywright && !env.hasGisRuntime) return false;
  if (env.force) return true;
  if (env.expiresAt === null) return false;
  const now = env.now ?? Date.now();
  return env.expiresAt <= now + GIS_SILENT_REFRESH_WINDOW_MS;
}

/**
 * R1#3: compute the timeout delay (ms) for proactive GIS silent refresh.
 * Returns `null` when no proactive timer should be scheduled (non-expiring token,
 * already expired token, or a token returned after a proactive refresh that still
 * has `<= windowMs` remaining — preventing an infinite `delayMs = 0` tight loop on
 * short-lived tokens while letting reactive expiry/401 handle actual expiration).
 */
export function computeProactiveRefreshDelayMs(opts: {
  expiresAt: number | null;
  now?: number;
  lastProactiveRefreshAt?: number;
  windowMs?: number;
  minCooldownMs?: number;
}): number | null {
  if (opts.expiresAt === null) return null;
  const now = opts.now ?? Date.now();
  if (opts.expiresAt <= now) return null;
  const windowMs = opts.windowMs ?? GIS_SILENT_REFRESH_WINDOW_MS;
  const minCooldownMs = opts.minCooldownMs ?? GIS_PROACTIVE_MIN_COOLDOWN_MS;
  const lastAt = opts.lastProactiveRefreshAt ?? 0;

  const rawDelay = opts.expiresAt - now - windowMs;
  if (rawDelay > 0) {
    const sinceLast = lastAt > 0 ? Math.max(0, now - lastAt) : Infinity;
    const cooldownLeft = Math.max(0, minCooldownMs - sinceLast);
    return Math.min(2_147_483_647, Math.max(rawDelay, cooldownLeft));
  }
  if (lastAt > 0) return null;
  return 0;
}

export function getGisOAuth2Namespace(win?: unknown): GisOAuth2Namespace | null {
  const target = (win !== undefined
    ? win
    : typeof window !== 'undefined'
      ? window
      : undefined) as GisWindowLike | undefined;
  const oauth2 = target?.google?.accounts?.oauth2;
  if (oauth2 && typeof oauth2.initTokenClient === 'function') {
    return oauth2;
  }
  return null;
}

export function hasGisOAuth2Runtime(win?: unknown): boolean {
  return getGisOAuth2Namespace(win) !== null;
}

let scriptLoadPromise: Promise<boolean> | null = null;

/**
 * Lazily injects `https://accounts.google.com/gsi/client` once (Cloud mode only).
 * Resolves to `false` on timeout, DOM error, or non-browser environment — never throws.
 * R2-1: removes a failed/timed-out `<script>` tag so later retries inject a fresh node
 * instead of attaching dead listeners and stalling for 5 s.
 */
export function loadGisScript(timeoutMs: number = GIS_SILENT_REFRESH_TIMEOUT_MS): Promise<boolean> {
  if (hasGisOAuth2Runtime()) return Promise.resolve(true);
  if (typeof document === 'undefined') return Promise.resolve(false);
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise<boolean>(resolve => {
    let settled = false;
    let scriptEl: HTMLScriptElement | null = null;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) {
        if (scriptEl && !hasGisOAuth2Runtime()) {
          try {
            scriptEl.remove();
          } catch {
            // Ignore DOM detach errors
          }
        }
        // Allow retry later if transient network failure prevented script load.
        scriptLoadPromise = null;
      }
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), Math.max(50, timeoutMs));

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GIS_SCRIPT_URL}"]`
    );
    if (existing) {
      scriptEl = existing;
      if (hasGisOAuth2Runtime()) {
        finish(true);
        return;
      }
      existing.addEventListener('load', () => finish(hasGisOAuth2Runtime()), { once: true });
      existing.addEventListener('error', () => finish(false), { once: true });
      return;
    }

    const script = document.createElement('script');
    scriptEl = script;
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => finish(hasGisOAuth2Runtime());
    script.onerror = () => finish(false);
    (document.head || document.documentElement).appendChild(script);
  });

  return scriptLoadPromise;
}

/**
 * R1#1: Verify that a silently minted token belongs to `expectedEmail`.
 * Fails CLOSED (`false`) on `!res.ok`, missing/empty email, network error, or timeout
 * (bounded via `AbortController`), falling back safely to `SessionExpiredModal`.
 */
export async function defaultVerifyTokenEmail(
  accessToken: string,
  expectedEmail: string,
  timeoutMs: number = GIS_SILENT_REFRESH_TIMEOUT_MS
): Promise<boolean> {
  const expected = expectedEmail.trim().toLowerCase();
  if (!expected) return true;
  if (typeof fetch !== 'function') return false;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const effectiveTimeout = Math.max(50, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<boolean>(resolve => {
    timer = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // Ignore abort errors
      }
      resolve(false);
    }, effectiveTimeout);
  });

  const fetchPromise = (async (): Promise<boolean> => {
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) return false;
      const info = (await res.json()) as { email?: unknown };
      if (typeof info?.email === 'string' && info.email.trim()) {
        return info.email.trim().toLowerCase() === expected;
      }
      return false;
    } catch {
      return false;
    }
  })();

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export interface SilentRefreshController {
  requestSilentToken: (req: SilentRefreshRequest) => Promise<SilentRefreshResult>;
  reset: () => void;
}

/**
 * Creates a single-flight GIS silent-refresh controller.
 * Concurrent callers for the same `(clientId, loginHint, expectedEmail, scope)` share ONE in-flight promise.
 */
export function createSilentRefreshController(
  deps: SilentRefreshControllerDeps = {}
): SilentRefreshController {
  const getOAuth2 = deps.getOAuth2 ?? (() => getGisOAuth2Namespace());
  const loadScript = deps.loadScript ?? loadGisScript;
  const verifyTokenEmail = deps.verifyTokenEmail ?? defaultVerifyTokenEmail;
  const nowFn = deps.now ?? (() => Date.now());

  const inFlight = new Map<string, Promise<SilentRefreshResult>>();

  const runOnce = async (req: SilentRefreshRequest): Promise<SilentRefreshResult> => {
    const timeoutMs = Math.max(50, req.timeoutMs ?? GIS_SILENT_REFRESH_TIMEOUT_MS);
    let oauth2 = getOAuth2();
    if (!oauth2) {
      const loaded = await loadScript(timeoutMs);
      if (!loaded) {
        return { ok: false, reason: 'script_load_failed' };
      }
      oauth2 = getOAuth2();
    }
    if (!oauth2 || typeof oauth2.initTokenClient !== 'function') {
      return { ok: false, reason: 'gis_unavailable' };
    }

    const raw = await new Promise<SilentRefreshResult>(resolve => {
      let settled = false;
      const finish = (result: SilentRefreshResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ ok: false, reason: 'timeout' });
      }, timeoutMs);

      try {
        const hint = req.loginHint?.trim() || undefined;
        const client = oauth2!.initTokenClient({
          client_id: req.clientId,
          scope: req.scope,
          ...(hint ? { hint } : {}),
          callback: resp => {
            if (!resp || resp.error) {
              finish({
                ok: false,
                reason: 'gis_error',
                detail: resp?.error || resp?.error_description,
              });
              return;
            }
            const accessToken = typeof resp.access_token === 'string' ? resp.access_token.trim() : '';
            if (!accessToken) {
              finish({ ok: false, reason: 'missing_token' });
              return;
            }
            const expiresAt = computeExpiresAt(resp.expires_in, nowFn());
            finish({ ok: true, accessToken, expiresAt });
          },
          error_callback: err => {
            finish({
              ok: false,
              reason: 'gis_error',
              detail: err?.type || err?.message,
            });
          },
        });
        client.requestAccessToken({ prompt: '', ...(hint ? { hint } : {}) });
      } catch (err) {
        finish({
          ok: false,
          reason: 'gis_error',
          detail: err instanceof Error ? err.message : 'GIS error',
        });
      }
    });

    if (!raw.ok) return raw;

    if (req.expectedEmail) {
      const matches = await verifyTokenEmail(raw.accessToken, req.expectedEmail, timeoutMs);
      if (!matches) {
        return { ok: false, reason: 'account_mismatch' };
      }
    }

    return raw;
  };

  const requestSilentToken = (req: SilentRefreshRequest): Promise<SilentRefreshResult> => {
    // R1-N2: include expectedEmail and normalized scope so callers with different
    // identity/scope expectations never coalesce onto the same promise.
    const normScope = req.scope.trim().replace(/\s+/g, ' ');
    const key = [
      req.clientId.trim(),
      (req.loginHint || '').trim().toLowerCase(),
      (req.expectedEmail || '').trim().toLowerCase(),
      normScope,
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

  return { requestSilentToken, reset };
}

const defaultController = createSilentRefreshController();

export function requestSilentGisToken(req: SilentRefreshRequest): Promise<SilentRefreshResult> {
  return defaultController.requestSilentToken(req);
}

export function resetSilentRefreshForTests(): void {
  scriptLoadPromise = null;
  defaultController.reset();
}
