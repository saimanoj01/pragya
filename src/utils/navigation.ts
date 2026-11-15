export type PragyaView = 'shelf' | 'book' | 'notes' | 'note' | 'practice' | 'settings';

export interface PragyaRoute {
  view: PragyaView;
  bookId?: string;
  noteSlug?: string;
  raw: string;
}

const ROUTE_PREFIXES = ['shelf', 'book/', 'notes', 'note/', 'practice', 'settings'];

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
  const [pathOnly] = withoutHash.split('?');
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
    return { view: 'book', bookId: decodeURIComponent(segments[1]), raw };
  }
  if (head === 'notes') {
    return { view: 'notes', raw };
  }
  if (head === 'note' && segments[1]) {
    return { view: 'note', noteSlug: decodeURIComponent(segments[1]), raw };
  }
  if (head === 'practice') {
    return { view: 'practice', raw };
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
