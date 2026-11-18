/**
 * CD D2.1 / ux_spec_cd §D.3.4: J/K moves real DOM focus to the card (`tabIndex={-1}`) and
 * scrolls it into view only as far as needed (`block: 'nearest'`), without smooth scrolling
 * when the user prefers reduced motion.
 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function focusCard(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/**
 * Card accessible name: `{book} · {posLabel} · {title or "Note"}`; a shielded card never names
 * its title (`{book} · {posLabel} · Shielded note`).
 */
export function noteCardAriaLabel(input: {
  bookTitle?: string | null;
  posLabel: string;
  title?: string | null;
  shielded: boolean;
}): string {
  const book = (input.bookTitle || '').trim() || 'Book';
  const tail = input.shielded ? 'Shielded note' : (input.title || '').trim() || 'Note';
  return `${book} · ${input.posLabel} · ${tail}`;
}

/** True when DOM focus is on (or inside) a J/K note card (`data-jk-card`). */
export function focusedCardIndex(active: Element | null): number | null {
  const card =
    active && typeof (active as HTMLElement).closest === 'function'
      ? (active as HTMLElement).closest<HTMLElement>('[data-jk-card]')
      : null;
  const raw = card?.dataset?.jkCard;
  if (raw === undefined || raw.trim() === '') return null;
  const idx = Number(raw);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}
