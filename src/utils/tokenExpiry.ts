/**
 * OAuth implicit-flow token expiry (B4.11). Google `ya29.*` access tokens carry no
 * expiry of their own, so `expires_in` from the redirect hash is stored as an
 * absolute timestamp. Tokens without `expires_in` (mock / test hashes) never expire here.
 */
export const GOOGLE_TOKEN_EXPIRES_AT_KEY = 'pragya_google_token_expires_at';
/** Treat a token as expired slightly early so an in-flight request doesn't 401. */
export const TOKEN_EXPIRY_SKEW_MS = 30_000;

/** `expires_in` (seconds, string or number) → absolute ms, or null when absent/invalid. */
export function computeExpiresAt(expiresIn: unknown, now: number = Date.now()): number | null {
  if (expiresIn === null || expiresIn === undefined || expiresIn === '') return null;
  const seconds = typeof expiresIn === 'number' ? expiresIn : Number(String(expiresIn).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return now + Math.round(seconds * 1000);
}

/** Parses a stored expires-at value (ms). Garbage → null (non-expiring). */
export function parseStoredExpiresAt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isTokenExpired(
  expiresAt: number | null,
  now: number = Date.now(),
  skewMs: number = TOKEN_EXPIRY_SKEW_MS
): boolean {
  if (expiresAt === null) return false;
  return expiresAt <= now + skewMs;
}
