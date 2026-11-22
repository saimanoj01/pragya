import type React from 'react';
import { navigateTo, type PragyaView } from './navigation';

export type NavDestination = 'shelf' | 'notes' | 'practice' | 'lexicon' | 'settings';

/**
 * CD D2.2 / ux_spec_cd §D.3.3: `aria-current` for a primary destination. The exact page gets
 * `page`; on a book (note) detail route, Shelf (Notes) is the parent section → `location`.
 */
export function navAriaCurrent(dest: NavDestination, view: PragyaView): 'page' | 'location' | undefined {
  if (view === dest) return 'page';
  if (dest === 'shelf' && view === 'book') return 'location';
  if (dest === 'notes' && view === 'note') return 'location';
  return undefined;
}

/**
 * Nav links are real `<a href="#/…">` (open-in-new-tab, copy link) but a plain click still
 * routes through `navigateTo`, exactly like the old buttons.
 */
export function handleNavLinkClick(e: React.MouseEvent<HTMLAnchorElement>, route: string): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigateTo(route);
}
