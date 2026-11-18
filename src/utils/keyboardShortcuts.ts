/**
 * CD D2.1 / ux_spec_cd §D.3.6: the ONE list of keyboard shortcuts. The `?` Keyboard Help modal
 * renders it and the tests assert against it, so the modal can't drift from behavior.
 *
 * A row's `keys` mixes key caps (`{ key }`) and plain connector words (`{ text }`); the token
 * `mod` renders as `⌘` on Apple platforms and `Ctrl` elsewhere.
 */
export type ShortcutKeyToken = { key: string } | { text: string };

export interface ShortcutRow {
  keys: ShortcutKeyToken[];
  action: string;
}

export interface ShortcutSection {
  id: string;
  title: string;
  rows: ShortcutRow[];
}

export const MOD_KEY = 'mod';

const k = (key: string): ShortcutKeyToken => ({ key });
const t = (text: string): ShortcutKeyToken => ({ text });

export const KEYBOARD_HELP_TITLE = 'Keyboard Shortcuts';
export const KEYBOARD_HELP_SUBLINE = "Shortcuts are off while you're typing in a field.";

export const KEYBOARD_SHORTCUTS: ShortcutSection[] = [
  {
    id: 'anywhere',
    title: 'Anywhere',
    rows: [
      { keys: [k(MOD_KEY), k('K')], action: 'Open search & commands' },
      { keys: [k('N')], action: 'New capture (uses the current book on a book or note page)' },
      { keys: [k('R')], action: 'Sync now' },
      { keys: [k('G'), t('then'), k('S'), t('/'), k('N'), t('/'), k('P')], action: 'Go to Shelf / Notes / Practice' },
      { keys: [k('Esc')], action: 'Close dialog · back from a book or note page' },
      { keys: [k('?')], action: 'Show this list' },
    ],
  },
  {
    id: 'notes-list',
    title: 'Notes list',
    rows: [
      { keys: [k('J'), t('/'), k('K')], action: 'Next / previous note' },
      { keys: [k('Enter')], action: 'Open note' },
      { keys: [k('Space')], action: 'Reveal shielded note' },
      { keys: [k('E')], action: 'Edit note' },
      { keys: [k('D')], action: 'Deepen note' },
      { keys: [k('O')], action: "Open the note's first link or doc" },
    ],
  },
  {
    id: 'book-page',
    title: 'Book page',
    rows: [
      { keys: [k('J'), t('/'), k('K')], action: 'Next / previous note' },
      { keys: [k('Enter')], action: 'Open note' },
      { keys: [k('Space')], action: 'Reveal shielded note' },
      { keys: [k('D')], action: 'Deepen focused note' },
      { keys: [k('E')], action: 'Edit focused note, or the book' },
      { keys: [k('Shift'), k('E')], action: 'Edit book' },
      { keys: [k('O')], action: 'Open Book Doc' },
      { keys: [k('C')], action: 'Whole-Book Picture' },
    ],
  },
  {
    id: 'note-page',
    title: 'Note page',
    rows: [
      { keys: [k('E')], action: 'Edit' },
      { keys: [k('D')], action: 'Deepen' },
      { keys: [k('O')], action: 'Open first link or doc' },
      { keys: [k('Space')], action: 'Reveal (shielded) · view image' },
    ],
  },
  {
    id: 'practice',
    title: 'Practice',
    rows: [
      { keys: [k('J'), t('/'), k('K')], action: 'Next / previous delta' },
      { keys: [k('1'), t('/'), k('2'), t('/'), k('3')], action: "Applied / Missed trigger / Didn't come up" },
      { keys: [k('Enter')], action: 'Open note' },
    ],
  },
  {
    id: 'forms',
    title: 'In forms',
    rows: [
      { keys: [k(MOD_KEY), k('Enter')], action: 'Save' },
      { keys: [k('[[')], action: 'Link a note' },
      {
        keys: [k('↑'), t('/'), k('↓'), t(','), k('Enter'), t('or'), k('Tab'), t(','), k('Esc')],
        action: 'Choose, insert, dismiss suggestion',
      },
    ],
  },
  {
    id: 'search-images',
    title: 'Search & images',
    rows: [
      { keys: [k('↑'), t('/'), k('↓'), t(','), k('Enter')], action: 'Move, open result' },
      { keys: [k('Space'), t('/'), k('Esc')], action: 'Close image' },
    ],
  },
];

/** `⌘` on Apple platforms, else `Ctrl` (ux_spec_cd §0.4). */
export function modKeyLabel(platform: string): string {
  return /Mac|iPhone|iPad/.test(platform || '') ? '⌘' : 'Ctrl';
}

/** A key cap's visible label (`mod` → platform modifier). */
export function shortcutKeyLabel(key: string, platform: string): string {
  return key === MOD_KEY ? modKeyLabel(platform) : key;
}

/** Plain-text form of a row's keys, e.g. `G then S / N / P` (tests + aria). */
export function shortcutKeysText(keys: ShortcutKeyToken[], platform: string): string {
  return keys
    .map(tok => ('key' in tok ? shortcutKeyLabel(tok.key, platform) : tok.text))
    .join(' ')
    .replace(/ ,/g, ',');
}

/** True for the `?` key (Shift+/ on US layouts; any layout that produces `?`). */
export function isHelpShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** CD D2.1 (ux_spec_cd Q13): true when the device has a fine pointer (mouse / trackpad). */
export function hasFinePointer(matchMediaImpl?: (query: string) => { matches: boolean }): boolean {
  try {
    const mm = matchMediaImpl || (typeof window !== 'undefined' ? window.matchMedia.bind(window) : null);
    return mm ? mm('(any-pointer: fine)').matches : false;
  } catch {
    return false;
  }
}
