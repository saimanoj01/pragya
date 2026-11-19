import { useCallback, useEffect, useRef, useState } from 'react';
import { clearDraft, writeDraft } from '../utils/draftStorage';
import { flushSessionModalDraft, resolveModalDraftOnOpen } from '../utils/modalDraft';

export interface UseModalDraftOptions<TDraft> {
  isOpen: boolean;
  /** Unique identifier for the current editing target (`note.id`, `book.id`, or `'capture'`). */
  sessionId: string | null;
  /** Logical draft key (scoped automatically per account via `draftStorage.ts`). */
  draftKey: string;
  /** When true (e.g. C3.3 capture-for-[[slug]]), never reads, writes, or clears the saved draft. */
  disabled?: boolean;
  isDirty: boolean;
  /** Memoized draft payload written on debounced autosave, close flush, and beforeunload. */
  payload: TDraft;
  currentUpdatedAt?: string;
  getBaseUpdatedAt?: (draft: TDraft) => string | undefined;
  canRestore: (draft: TDraft) => boolean;
  onRestore: (draft: TDraft, meta: { swapping: boolean }) => void;
  onInitCanonical: (meta: { swapping: boolean }) => void;
  onDiscard: () => void;
  debounceMs?: number;
}

export interface UseModalDraftResult {
  draftRestored: boolean;
  markSubmitted: () => void;
  discardDraft: () => void;
}

/**
 * CD Batch 5 (D3.1 + R1#2 / R2-1): shared modal draft lifecycle — open resolution + stale
 * auto-clear, 250ms debounced autosave, synchronous flush on close or session swap, untouched
 * foreign-draft preservation, `beforeunload` guard while dirty, per-account scoping, and Discard.
 */
export function useModalDraft<TDraft>({
  isOpen,
  sessionId,
  draftKey,
  disabled = false,
  isDirty,
  payload,
  currentUpdatedAt,
  getBaseUpdatedAt,
  canRestore,
  onRestore,
  onInitCanonical,
  onDiscard,
  debounceMs = 250,
}: UseModalDraftOptions<TDraft>): UseModalDraftResult {
  const [draftRestored, setDraftRestored] = useState(false);

  const wasOpenRef = useRef(false);
  const initializedSessionRef = useRef<string | null>(null);
  const submittedOrDiscardedRef = useRef(false);
  const justInitializedRef = useRef(false);
  /**
   * R1#2 / R2-1: true only when this session restored a draft or became dirty from user input.
   * Prevents an untouched canonical session (e.g. Book B's explicit Capture when Book A has a
   * saved draft) from scheduling a timer or calling `clearDraft` on close.
   */
  const dirtiedOrRestoredRef = useRef(false);

  const snapshotRef = useRef<{
    key: string;
    disabled: boolean;
    isDirty: boolean;
    payload: TDraft;
  }>({
    key: draftKey,
    disabled,
    isDirty,
    payload,
  });
  snapshotRef.current = {
    key: draftKey,
    disabled,
    isDirty,
    payload,
  };

  const callbacksRef = useRef({
    currentUpdatedAt,
    getBaseUpdatedAt,
    canRestore,
    onRestore,
    onInitCanonical,
    onDiscard,
  });
  callbacksRef.current = {
    currentUpdatedAt,
    getBaseUpdatedAt,
    canRestore,
    onRestore,
    onInitCanonical,
    onDiscard,
  };

  const prevSnapshotRef = useRef({
    ...snapshotRef.current,
    dirtiedOrRestored: false,
  });

  useEffect(() => {
    if (!isOpen || !sessionId) {
      if (
        wasOpenRef.current &&
        prevSnapshotRef.current.key &&
        !submittedOrDiscardedRef.current &&
        !prevSnapshotRef.current.disabled
      ) {
        flushSessionModalDraft(
          prevSnapshotRef.current.key,
          prevSnapshotRef.current.isDirty,
          prevSnapshotRef.current.dirtiedOrRestored,
          prevSnapshotRef.current.payload
        );
      }
      wasOpenRef.current = false;
      initializedSessionRef.current = null;
      submittedOrDiscardedRef.current = false;
      justInitializedRef.current = false;
      dirtiedOrRestoredRef.current = false;
      return;
    }

    if (wasOpenRef.current && initializedSessionRef.current === sessionId) {
      return;
    }

    const swapping = wasOpenRef.current && initializedSessionRef.current !== null;
    if (
      swapping &&
      prevSnapshotRef.current.key &&
      prevSnapshotRef.current.key !== draftKey &&
      !submittedOrDiscardedRef.current &&
      !prevSnapshotRef.current.disabled
    ) {
      flushSessionModalDraft(
        prevSnapshotRef.current.key,
        prevSnapshotRef.current.isDirty,
        prevSnapshotRef.current.dirtiedOrRestored,
        prevSnapshotRef.current.payload
      );
    }

    wasOpenRef.current = true;
    initializedSessionRef.current = sessionId;
    submittedOrDiscardedRef.current = false;
    justInitializedRef.current = true;

    const resolution = resolveModalDraftOnOpen<TDraft>({
      key: draftKey,
      disabled,
      currentUpdatedAt: callbacksRef.current.currentUpdatedAt,
      getBaseUpdatedAt: callbacksRef.current.getBaseUpdatedAt,
      canRestore: callbacksRef.current.canRestore,
    });

    if (resolution.kind === 'restored') {
      dirtiedOrRestoredRef.current = true;
      callbacksRef.current.onRestore(resolution.draft, { swapping });
      setDraftRestored(true);
      prevSnapshotRef.current = {
        key: draftKey,
        disabled,
        isDirty: true,
        dirtiedOrRestored: true,
        payload: resolution.draft,
      };
    } else {
      dirtiedOrRestoredRef.current = false;
      callbacksRef.current.onInitCanonical({ swapping });
      setDraftRestored(false);
      prevSnapshotRef.current = {
        key: draftKey,
        disabled,
        isDirty: false,
        dirtiedOrRestored: false,
        payload: snapshotRef.current.payload,
      };
    }
  }, [disabled, draftKey, isOpen, sessionId]);

  useEffect(() => {
    if (!isOpen || !sessionId || initializedSessionRef.current !== sessionId) return;
    if (justInitializedRef.current) {
      justInitializedRef.current = false;
      return;
    }
    if (isDirty) {
      dirtiedOrRestoredRef.current = true;
      submittedOrDiscardedRef.current = false;
    }
    prevSnapshotRef.current = {
      ...snapshotRef.current,
      dirtiedOrRestored: dirtiedOrRestoredRef.current,
    };
    if (disabled) return;
    if (!isDirty && !dirtiedOrRestoredRef.current) return;
    const timer = window.setTimeout(() => {
      if (submittedOrDiscardedRef.current || snapshotRef.current.disabled) return;
      flushSessionModalDraft(
        snapshotRef.current.key,
        snapshotRef.current.isDirty,
        dirtiedOrRestoredRef.current,
        snapshotRef.current.payload
      );
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [debounceMs, disabled, draftKey, isDirty, isOpen, payload, sessionId]);

  useEffect(() => {
    if (!isOpen || !isDirty || disabled) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (
        snapshotRef.current.key &&
        snapshotRef.current.isDirty &&
        !snapshotRef.current.disabled
      ) {
        writeDraft(snapshotRef.current.key, snapshotRef.current.payload);
      }
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [disabled, isDirty, isOpen]);

  const markSubmitted = useCallback(() => {
    submittedOrDiscardedRef.current = true;
    if (!snapshotRef.current.disabled && snapshotRef.current.key) {
      clearDraft(snapshotRef.current.key);
    }
    setDraftRestored(false);
  }, []);

  const discardDraft = useCallback(() => {
    submittedOrDiscardedRef.current = true;
    dirtiedOrRestoredRef.current = false;
    if (snapshotRef.current.key) {
      clearDraft(snapshotRef.current.key);
    }
    setDraftRestored(false);
    callbacksRef.current.onDiscard();
  }, []);

  return {
    draftRestored,
    markSubmitted,
    discardDraft,
  };
}
