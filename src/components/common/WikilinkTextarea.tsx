import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Book, Note } from '../../types/pragya';
import { FIELD_LABEL, TEXTAREA } from './uiClasses';
import { WikilinkAutocomplete } from './WikilinkAutocomplete';

export interface WikilinkTextareaProps {
  id?: string;
  label: React.ReactNode;
  value: string;
  onValueChange: (nextValue: string) => void;
  notes: Note[];
  books: Book[];
  excludeNoteId?: string;
  excludeSlug?: string;
  rows?: number;
  placeholder?: string;
  dataTestId?: string;
  textareaClassName?: string;
  onPaste?: React.ClipboardEventHandler<HTMLTextAreaElement>;
  resetKey?: string | number | boolean;
}

/**
 * CD Batch 5 (D3.1): shared `<textarea>` + cursor tracking + `<WikilinkAutocomplete>`
 * (preserving ARIA 1.2 multiline combobox attributes and mobile touch ghost-click guard).
 */
export const WikilinkTextarea = React.forwardRef<HTMLTextAreaElement, WikilinkTextareaProps>(
  function WikilinkTextarea(
    {
      id,
      label,
      value,
      onValueChange,
      notes,
      books,
      excludeNoteId,
      excludeSlug,
      rows = 3,
      placeholder,
      dataTestId,
      textareaClassName = TEXTAREA,
      onPaste,
      resetKey,
    },
    forwardedRef
  ) {
    const generatedId = useId();
    const fieldId = id || generatedId;
    const internalRef = useRef<HTMLTextAreaElement | null>(null);
    const [cursorPos, setCursorPos] = useState<number | null>(null);

    useEffect(() => {
      setCursorPos(null);
    }, [resetKey]);

    const setMergedRef = useCallback(
      (node: HTMLTextAreaElement | null) => {
        internalRef.current = node;
        if (typeof forwardedRef === 'function') {
          forwardedRef(node);
        } else if (forwardedRef) {
          forwardedRef.current = node;
        }
      },
      [forwardedRef]
    );

    return (
      <div className="space-y-1.5 relative">
        <label htmlFor={fieldId} className={FIELD_LABEL}>
          {label}
        </label>
        <textarea
          id={fieldId}
          ref={setMergedRef}
          rows={rows}
          data-testid={dataTestId}
          value={value}
          onPaste={onPaste}
          onChange={e => {
            onValueChange(e.target.value);
            setCursorPos(e.target.selectionStart);
          }}
          onClick={e => setCursorPos(e.currentTarget.selectionStart)}
          onKeyUp={e => setCursorPos(e.currentTarget.selectionStart)}
          onBlur={() => setCursorPos(null)}
          placeholder={placeholder}
          className={textareaClassName}
        />
        <WikilinkAutocomplete
          textareaRef={internalRef}
          value={value}
          cursorPos={cursorPos}
          notes={notes}
          books={books}
          excludeNoteId={excludeNoteId}
          excludeSlug={excludeSlug}
          onSelect={(nextVal, nextCursor) => {
            onValueChange(nextVal);
            setCursorPos(nextCursor);
          }}
        />
      </div>
    );
  }
);
