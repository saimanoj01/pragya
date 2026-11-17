/**
 * Structured Google API errors + rate-limit classification (B4.7 / A5.6).
 *
 * RATE_LIMIT_PATTERN is byte-identical to `RATE_LIMIT_PATTERN` in scripts/pragya_cli.py
 * (a node test asserts parity by asking Python for its value). Rules:
 *  1. status tokens: RESOURCE_EXHAUSTED, RATE_LIMIT_EXCEEDED, "Too Many Requests",
 *     rateLimitExceeded, userRateLimitExceeded, quotaExceeded, dailyLimitExceeded,
 *     sharingRateLimitExceeded (camelCase reasons anchored with \b, so Drive's
 *     storageQuotaExceeded — "Drive is full" — is NOT a rate limit), "quota exceeded",
 *     "Resource has been exhausted", "User rate limit exceeded";
 *  2. a bare 429 only right after HTTP[/x.y] / HttpError / status[ code] / code / error
 *     (≤3 non-word chars) and not followed by another digit;
 *  3. a line that starts with 429.
 * Flags: case-insensitive + multiline.
 */
export const RATE_LIMIT_PATTERN = String.raw`RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED|Too Many Requests|\brateLimitExceeded|\buserRateLimitExceeded|\bquotaExceeded|\bdailyLimitExceeded|\bsharingRateLimitExceeded|quota exceeded|Resource has been exhausted|User rate limit exceeded|(?:\bHTTP(?:/\d(?:\.\d)?)?|\bHttpError|\bstatus(?:[ _]?code)?|\bcode|\berror)\W{0,3}429(?!\d)|^[ \t]*429(?![\w.])`;

const RATE_LIMIT_RE = new RegExp(RATE_LIMIT_PATTERN, 'im');

/** ux_spec D.2 / H. */
export const RATE_LIMIT_TOAST =
  'Google is limiting requests right now. Try again in a minute — nothing was lost.';

/** Google reasons that mean "slow down" when they arrive with HTTP 403. */
export const RATE_LIMIT_REASONS: readonly string[] = [
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
  'sharingRateLimitExceeded',
  'RESOURCE_EXHAUSTED',
];

export type ApiErrorKind = 'rate_limited' | 'forbidden' | 'not_found' | 'other';

export function isRateLimitedText(text: string | null | undefined): boolean {
  return RATE_LIMIT_RE.test(text || '');
}

/**
 * `fetchApi` failure for a non-401 HTTP response. The message format
 * `API Error <status>: <body>` is relied on by isNetworkError and older tests.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`API Error ${status}: ${body}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.reason = extractErrorReason(body);
  }
}

/** First Google error reason/status in a JSON error body (`error.errors[].reason`, `error.status`). */
export function extractErrorReason(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: unknown; errors?: Array<{ reason?: unknown }>; details?: Array<{ reason?: unknown }> };
    };
    const err = parsed?.error;
    if (!err || typeof err !== 'object') return '';
    for (const list of [err.errors, err.details]) {
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item.reason === 'string' && item.reason) return item.reason;
        }
      }
    }
    return typeof err.status === 'string' ? err.status : '';
  } catch {
    return '';
  }
}

function statusAndBody(err: unknown): { status: number | null; reason: string; body: string } {
  if (err instanceof ApiError) return { status: err.status, reason: err.reason, body: err.body };
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const m = /^API Error (\d{3}):\s?([\s\S]*)$/.exec(msg);
  if (!m) return { status: null, reason: '', body: msg };
  return { status: Number(m[1]), reason: extractErrorReason(m[2]), body: m[2] };
}

/**
 * Classifies a fetchApi failure. Only `forbidden` / `not_found` may clear caches;
 * `rate_limited` (429, or 403 with a quota reason / rate-limit text) keeps them.
 */
export function classifyApiError(err: unknown): ApiErrorKind {
  const { status, reason, body } = statusAndBody(err);
  if (status === 429) return 'rate_limited';
  if (status === 403) {
    if (RATE_LIMIT_REASONS.includes(reason) || isRateLimitedText(body)) return 'rate_limited';
    return 'forbidden';
  }
  if (status === 404) return 'not_found';
  return 'other';
}

/**
 * User-facing copy for a failed sync/save: a rate limit gets the calm ux_spec D.2
 * sentence instead of raw `API Error 429: {json}`; other errors keep their message.
 */
export function describeSyncError(err: unknown, fallback = 'Failed to sync workspace'): string {
  if (classifyApiError(err) === 'rate_limited') return RATE_LIMIT_TOAST;
  return err instanceof Error && err.message ? err.message : fallback;
}
