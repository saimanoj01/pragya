export type PragyaView =
  | 'shelf'
  | 'book'
  | 'notes'
  | 'note'
  | 'practice'
  | 'lexicon'
  | 'settings';

export interface PragyaRoute {
  view: PragyaView;
  bookId?: string;
  noteSlug?: string;
  noteId?: string;
  raw: string;
}

const ROUTE_PREFIXES = ['shelf', 'book/', 'notes', 'note/', 'practice', 'lexicon', 'settings'];

export function isOAuthCallbackHash(hash: string): boolean {
  const h = hash || '';
  if (!h.includes('access_token=') && !h.includes('error=')) {
    return false;
  }
  const rawFragment = h.includes('#')
    ? h.slice(h.lastIndexOf('#') + 1).replace(/^\//, '')
    : h;
  if (ROUTE_PREFIXES.some(prefix => rawFragment === prefix || rawFragment.startsWith(prefix))) {
    return false;
  }
  const params = new URLSearchParams(rawFragment);
  return params.has('access_token') || params.has('error');
}

export function isSafeHttpUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** B4.9: a malformed percent-escape (e.g. `%E0%A4`) keeps the raw segment instead of throwing. */
export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseHash(hashValue?: string): PragyaRoute {
  const raw =
    hashValue !== undefined
      ? hashValue
      : typeof window !== 'undefined'
        ? window.location.hash
        : '';

  if (!raw || raw === '#' || raw === '#/' || isOAuthCallbackHash(raw)) {
    return { view: 'shelf', raw };
  }

  const withoutHash = raw.startsWith('#') ? raw.slice(1) : raw;
  const qIndex = withoutHash.indexOf('?');
  const pathOnly = qIndex >= 0 ? withoutHash.slice(0, qIndex) : withoutHash;
  const queryString = qIndex >= 0 ? withoutHash.slice(qIndex + 1) : '';
  const normalized = pathOnly.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) {
    return { view: 'shelf', raw };
  }

  const segments = normalized.split('/');
  const head = segments[0]?.toLowerCase();

  if (head === 'shelf') {
    return { view: 'shelf', raw };
  }
  if (head === 'book' && segments[1]) {
    const params = queryString ? new URLSearchParams(queryString) : null;
    const rawNoteId = params?.get('note')?.trim() || undefined;
    return {
      view: 'book',
      bookId: safeDecode(segments[1]),
      ...(rawNoteId ? { noteId: rawNoteId } : {}),
      raw,
    };
  }
  if (head === 'notes') {
    return { view: 'notes', raw };
  }
  if (head === 'note' && segments[1]) {
    return { view: 'note', noteSlug: safeDecode(segments[1]), raw };
  }
  if (head === 'practice') {
    return { view: 'practice', raw };
  }
  if (head === 'lexicon') {
    return { view: 'lexicon', raw };
  }
  if (head === 'settings') {
    return { view: 'settings', raw };
  }

  return { view: 'shelf', raw };
}

export function navigateTo(hash: string): void {
  if (typeof window === 'undefined') return;
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

/** sessionStorage key holding the pre-login hash route restored after OAuth (M4.4). */
export const OAUTH_RETURN_ROUTE_KEY = 'pragya_oauth_return_route';
export const DEFAULT_POST_LOGIN_HASH = '#/shelf';

/**
 * A hash is restorable after OAuth only when it is a real in-app route
 * (never an OAuth callback fragment, never empty / `#` / `#/`).
 */
export function isRestorableAppRoute(hash: string | null | undefined): hash is string {
  if (!hash || typeof hash !== 'string') return false;
  if (hash === '#' || hash === '#/') return false;
  if (!hash.startsWith('#/')) return false;
  if (isOAuthCallbackHash(hash)) return false;
  if (hash.length > 512) return false;
  const withoutHash = hash.slice(2).split('?')[0];
  const head = withoutHash.split('/')[0]?.toLowerCase() || '';
  return ['shelf', 'book', 'notes', 'note', 'practice', 'lexicon', 'settings'].includes(head);
}

/** Resolve the post-login landing hash from a stored pre-login route. */
export function resolvePostLoginHash(stored: string | null | undefined): string {
  return isRestorableAppRoute(stored) ? stored : DEFAULT_POST_LOGIN_HASH;
}

/**
 * Swap the current hash without a new history entry or a `hashchange` event (Batch 4:
 * a revealed shielded note moves from `#/note/<uuid>` to its canonical slug URL).
 */
export function replaceHash(hash: string): void {
  if (typeof window === 'undefined') return;
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (window.location.hash === target) return;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${target}`);
}
