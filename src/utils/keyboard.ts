/**
 * CD C4.3 (ux_spec_cd C.4.1): ⌘/Ctrl+Enter submits from any field. IME-safe — ignored while
 * an IME composition is active (`isComposing`, or the legacy `keyCode === 229`).
 */
export interface SubmitShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export function isSubmitShortcut(e: SubmitShortcutEvent): boolean {
  if (e.key !== 'Enter') return false;
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return true;
}

/** `⌘` on Apple platforms, else `Ctrl` (ux_spec_cd §0.4). */
export function submitShortcutModifierLabel(platform: string): string {
  return /Mac|iPhone|iPad/.test(platform || '') ? '⌘' : 'Ctrl';
}
