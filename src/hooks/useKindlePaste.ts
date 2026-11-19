import React, { useCallback, useRef, useState } from 'react';
import type { PosUnit } from '../types/pragya';
import {
  pickCitationHint,
  stripKindleBoilerplate,
  type KindleHintResult,
} from '../utils/kindlePaste';

export interface KindleCleanState {
  field: 'quote' | 'takeaway';
  rawValue: string;
}

export interface UseKindlePasteOptions {
  posUnit: PosUnit;
  pos: string;
  setPos: (next: string) => void;
  setQuote: (next: string) => void;
  setTakeaway: (next: string) => void;
}

/**
 * CD Batch 5 (decisions.md R2#2): encapsulates Kindle boilerplate paste stripping (with Undo)
 * and unit-guarded citation position hints for QuickCaptureModal.
 */
export function useKindlePaste({
  posUnit,
  pos,
  setPos,
  setQuote,
  setTakeaway,
}: UseKindlePasteOptions) {
  const [kindleHint, setKindleHint] = useState<KindleHintResult>(null);
  const [kindleClean, setKindleClean] = useState<KindleCleanState | null>(null);
  const dismissedHintRef = useRef<string | null>(null);

  const detectKindleHint = useCallback(
    (rawText: string, currentPosStr: string) => {
      const result = pickCitationHint(rawText, posUnit);
      if (!result || result.hint.label === dismissedHintRef.current) {
        setKindleHint(null);
      } else if (result.kind === 'match' && String(result.hint.pos) === currentPosStr.trim()) {
        setKindleHint(null);
      } else {
        setKindleHint(result);
      }
    },
    [posUnit]
  );

  const handleTextPaste = useCallback(
    (
      e: React.ClipboardEvent<HTMLTextAreaElement>,
      field: 'quote' | 'takeaway',
      detectHint: boolean
    ) => {
      const pasted = e.clipboardData?.getData('text/plain') || '';
      if (!pasted) return;
      if (detectHint) detectKindleHint(pasted, pos);
      const { text: cleanedText, cleaned } = stripKindleBoilerplate(pasted);
      if (!cleaned) return;
      e.preventDefault();
      const el = e.currentTarget;
      const current = el.value;
      const start = el.selectionStart ?? current.length;
      const end = el.selectionEnd ?? current.length;
      const before = current.slice(0, start);
      const after = current.slice(end);
      const setter = field === 'quote' ? setQuote : setTakeaway;
      setter(`${before}${cleanedText}${after}`);
      setKindleClean({ field, rawValue: `${before}${pasted}${after}` });
    },
    [detectKindleHint, pos, setQuote, setTakeaway]
  );

  const clearHintIfMatchesPos = useCallback((nextPos: string) => {
    setKindleHint(prev =>
      prev?.kind === 'match' && String(prev.hint.pos) === nextPos.trim() ? null : prev
    );
  }, []);

  const clearFieldClean = useCallback((field: 'quote' | 'takeaway') => {
    setKindleClean(prev => (prev?.field === field ? null : prev));
  }, []);

  const applyKindleHint = useCallback(() => {
    if (kindleHint?.kind !== 'match') return;
    setPos(String(kindleHint.hint.pos));
    setKindleHint(null);
  }, [kindleHint, setPos]);

  const dismissKindleHint = useCallback(() => {
    if (kindleHint) {
      dismissedHintRef.current = kindleHint.hint.label;
    }
    setKindleHint(null);
  }, [kindleHint]);

  const undoKindleClean = useCallback(() => {
    if (!kindleClean) return;
    if (kindleClean.field === 'quote') setQuote(kindleClean.rawValue);
    else setTakeaway(kindleClean.rawValue);
    setKindleClean(null);
  }, [kindleClean, setQuote, setTakeaway]);

  const resetKindleState = useCallback((preserveClean = false) => {
    setKindleHint(null);
    if (!preserveClean) setKindleClean(null);
    dismissedHintRef.current = null;
  }, []);

  return {
    kindleHint,
    kindleClean,
    detectKindleHint,
    handleTextPaste,
    clearHintIfMatchesPos,
    clearFieldClean,
    applyKindleHint,
    dismissKindleHint,
    undoKindleClean,
    resetKindleState,
  };
}
