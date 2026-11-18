import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Book, Note } from '../../types/pragya';
import { filterWikilinkCandidates } from '../../utils/noteVisibility';

export interface WikilinkAutocompleteProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  cursorPos: number | null;
  notes: Note[];
  /**
   * B2.3: notes ahead of their book's bookmark are never offered. Required (R2#3) so a
   * new caller cannot silently skip the spoiler filter.
   */
  books: Book[];
  excludeNoteId?: string;
  excludeSlug?: string;
  onSelect: (nextValue: string, nextCursorPos: number) => void;
}

interface ActiveWikilinkMatch {
  startIndex: number;
  endIndex: number;
  query: string;
}

function getActiveWikilinkMatch(value: string, cursorPos: number | null): ActiveWikilinkMatch | null {
  if (cursorPos === null || cursorPos < 0) return null;
  const beforeCursor = value.slice(0, cursorPos);
  const match = /\[\[([^[\]\n]*)$/.exec(beforeCursor);
  if (!match) return null;
  return {
    startIndex: match.index,
    endIndex: cursorPos,
    query: match[1] || '',
  };
}

export const WikilinkAutocomplete: React.FC<WikilinkAutocompleteProps> = ({
  textareaRef,
  value,
  cursorPos,
  notes,
  books,
  excludeNoteId,
  excludeSlug,
  onSelect,
}) => {
  const [dismissedAtStart, setDismissedAtStart] = useState<number | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const match = useMemo(() => getActiveWikilinkMatch(value, cursorPos), [value, cursorPos]);

  useEffect(() => {
    if (!match) {
      setDismissedAtStart(null);
      return;
    }
    if (dismissedAtStart !== null && dismissedAtStart !== match.startIndex) {
      setDismissedAtStart(null);
    }
  }, [dismissedAtStart, match]);

  const options = useMemo(() => {
    if (!match) return [];
    return filterWikilinkCandidates(notes, books, match.query, {
      noteId: excludeNoteId,
      slug: excludeSlug,
    });
  }, [books, excludeNoteId, excludeSlug, match, notes]);

  const isOpen = Boolean(
    match && dismissedAtStart !== match.startIndex && options.length > 0
  );

  useEffect(() => {
    setSelectedIdx(0);
  }, [match?.query, match?.startIndex]);

  const applySelection = useCallback(
    (targetSlug: string) => {
      if (!match) return;
      const before = value.slice(0, match.startIndex);
      const rawAfter = value.slice(match.endIndex);
      const after = rawAfter.startsWith(']]') ? rawAfter.slice(2) : rawAfter;
      const token = `[[${targetSlug}]]`;
      const nextValue = `${before}${token}${after}`;
      const nextCursor = before.length + token.length;
      setDismissedAtStart(null);
      const elNow = textareaRef.current;
      if (elNow && document.activeElement !== elNow) {
        elNow.focus();
      }
      onSelect(nextValue, nextCursor);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el && document.activeElement === el) {
          el.setSelectionRange(nextCursor, nextCursor);
        }
      });
    },
    [match, onSelect, textareaRef, value]
  );

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const el = textareaRef.current;
      if (!el || document.activeElement !== el) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(prev => (prev + 1) % options.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIdx(prev => (prev - 1 + options.length) % options.length);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        // CD C4.3: ⌘/Ctrl+Enter is the form's submit shortcut, never a pick.
        return;
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const chosen = options[selectedIdx];
        if (chosen) {
          e.preventDefault();
          e.stopPropagation();
          applySelection(chosen.slug);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (match) setDismissedAtStart(match.startIndex);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [applySelection, isOpen, match, options, selectedIdx, textareaRef]);

  if (!isOpen) return null;

  return (
    <div
      data-testid="wikilink-autocomplete"
      data-popover="true"
      onMouseDown={e => e.preventDefault()}
      className="absolute left-0 right-0 z-30 mt-1 rounded-[10px] bg-popover border border-border shadow-2xl p-1.5 space-y-0.5 max-h-52 overflow-y-auto custom-scrollbar"
    >
      <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        Link Note Concept
      </div>
      {options.map((n, idx) => {
        const active = idx === selectedIdx;
        return (
          <button
            key={n.id}
            type="button"
            data-testid={`wikilink-option-${n.slug}`}
            // CD C3.5: select on pointerdown (touch + mouse) before the textarea can blur;
            // onClick then only handles keyboard activation (detail === 0) to avoid a double pick.
            onPointerDown={e => {
              e.preventDefault();
              applySelection(n.slug);
            }}
            onMouseDown={e => {
              e.preventDefault();
            }}
            onClick={e => {
              if (e.detail === 0) applySelection(n.slug);
            }}
            onMouseEnter={() => setSelectedIdx(idx)}
            className={`w-full text-left px-2.5 py-1.5 rounded-[8px] flex items-center justify-between gap-2 text-label transition-colors ${
              active
                ? 'bg-surface2 text-foreground'
                : 'text-muted-foreground hover:bg-surface2/60 hover:text-foreground'
            }`}
          >
            <span className="font-medium text-foreground truncate">
              {n.meta?.title || n.slug}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground shrink-0">
              [[{n.slug}]]
            </span>
          </button>
        );
      })}
    </div>
  );
};
