import { useState } from 'react';
import type { Book } from '../../types/pragya';
import { safeCoverUrl } from '../../utils/bookSurfaces';

/**
 * CD C2.6: small decorative cover (https only). Any load error → renders nothing (no broken
 * icon, no placeholder art); offline it simply disappears.
 */
export function BookCover({ book, className }: { book: Book; className: string }) {
  const url = safeCoverUrl(book);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!url || failedUrl === url) return null;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      data-testid="book-cover-img"
      onError={() => setFailedUrl(url)}
      className={className}
    />
  );
}

export const REREADING_BADGE =
  'px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-md bg-surface2 border border-border text-muted-foreground';
