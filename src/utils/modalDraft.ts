import { clearDraft, isNoteDraftStale, readDraft, writeDraft } from './draftStorage';

export type ModalDraftResolution<TDraft> =
  | { kind: 'restored'; draft: TDraft }
  | { kind: 'canonical' };

export interface ResolveModalDraftOptions<TDraft> {
  key: string;
  /** When true (e.g. C3.3 capture-for-[[slug]]), leaves any saved draft untouched. */
  disabled?: boolean;
  /** Current entity `updatedAt` (Note or Book); if newer than draft's `baseUpdatedAt`, clears stale draft. */
  currentUpdatedAt?: string;
  getBaseUpdatedAt?: (draft: TDraft) => string | undefined;
  /** Returns true when the non-stale draft has meaningful edits worth restoring. */
  canRestore: (draft: TDraft) => boolean;
}

/**
 * Pure per-account draft resolution on modal open (`readDraft` / `clearDraft` automatically
 * scope to `pragya_draft:<scope>:<key>`). Auto-clears stale drafts whose `baseUpdatedAt`
 * predates `currentUpdatedAt`.
 */
export function resolveModalDraftOnOpen<TDraft>(
  options: ResolveModalDraftOptions<TDraft>
): ModalDraftResolution<TDraft> {
  if (options.disabled || !options.key) {
    return { kind: 'canonical' };
  }
  const saved = readDraft<TDraft>(options.key);
  if (!saved) {
    return { kind: 'canonical' };
  }
  if (options.getBaseUpdatedAt) {
    const draftBase = options.getBaseUpdatedAt(saved);
    if (isNoteDraftStale(draftBase, options.currentUpdatedAt)) {
      clearDraft(options.key);
      return { kind: 'canonical' };
    }
  }
  if (!options.canRestore(saved)) {
    return { kind: 'canonical' };
  }
  return { kind: 'restored', draft: saved };
}

/** Writes the draft when dirty, or removes any previously stored draft when back to canonical. */
export function flushModalDraft<TDraft>(key: string, isDirty: boolean, payload: TDraft): void {
  if (!key) return;
  if (isDirty) {
    writeDraft(key, payload);
  } else {
    clearDraft(key);
  }
}

/**
 * R1#2 / R2-1: session-aware flush. An untouched canonical session (`!isDirty && !dirtiedOrRestored`,
 * e.g. opening Book B's explicit Capture button while a capture draft exists for Book A and closing
 * without typing) is a strict no-op so foreign-book drafts are never wiped.
 */
export function flushSessionModalDraft<TDraft>(
  key: string,
  isDirty: boolean,
  dirtiedOrRestored: boolean,
  payload: TDraft
): 'written' | 'cleared' | 'noop' {
  if (!key) return 'noop';
  if (isDirty) {
    writeDraft(key, payload);
    return 'written';
  }
  if (!dirtiedOrRestored) return 'noop';
  clearDraft(key);
  return 'cleared';
}

export function captureDraftRestoredMessage(attachmentCount: number): string {
  const suffix =
    attachmentCount > 0
      ? ` (with ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'})`
      : '';
  return `Restored your unsaved draft${suffix}.`;
}
