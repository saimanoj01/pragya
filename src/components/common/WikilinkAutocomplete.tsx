import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Book, Note } from '../../types/pragya';
import { filterWikilinkCandidates } from '../../utils/noteVisibility';
import { applyWikilinkSelection, getActiveWikilinkMatch } from '../../utils/wikilinks';

export interface WikilinkAutocompleteProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  cursorPos: number | null;
  notes: Note[];
  books: Book[];
  excludeNoteId?: string;
  excludeSlug?: string;
  onSelect: (nextValue: string, nextCursorPos: number) => void;
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
  // CD D2.2: listbox ids + debounced polite announcement on open.
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (idx: number) => `${baseId}-opt-${idx}`;
  const [announcement, setAnnouncement] = useState('');
  const wasOpenRef = useRef(false);

  const match = useMemo(() => getActiveWikilinkMatch(value, cursorPos), [value, cursorPos]);

  useEffect(() => {
    if (!match) {
      setDismissedAtStart(null);
    }
  }, [match]);

  // B2.3 / decisions.md #2: shielded notes are dropped before prefix matching.
  const options = useMemo(() => {
    if (!match) return [];
    return filterWikilinkCandidates(
      notes,
      books,
      match.query,
      { noteId: excludeNoteId, slug: excludeSlug },
      6
    );
  }, [books, excludeNoteId, excludeSlug, match, notes]);

  const isOpen = Boolean(
    match && dismissedAtStart !== match.startIndex && options.length > 0
  );

  useEffect(() => {
    setSelectedIdx(0);
  }, [match?.query, match?.startIndex]);

  // CD D2.2: multiline combobox ARIA on the textarea (aria-expanded requires role="combobox"
  // in ARIA 1.2) + aria-controls / aria-activedescendant while the listbox popup is open.
  const activeId = isOpen && options[selectedIdx] ? optionId(selectedIdx) : null;
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.setAttribute('role', 'combobox');
    el.setAttribute('aria-multiline', 'true');
    el.setAttribute('aria-autocomplete', 'list');
    el.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen) {
      el.setAttribute('aria-controls', listId);
    } else {
      el.removeAttribute('aria-controls');
    }
    if (activeId) el.setAttribute('aria-activedescendant', activeId);
    else el.removeAttribute('aria-activedescendant');
  }, [activeId, isOpen, listId, textareaRef]);

  useEffect(() => {
    const el = textareaRef.current;
    return () => {
      if (!el) return;
      el.removeAttribute('role');
      el.removeAttribute('aria-multiline');
      el.removeAttribute('aria-autocomplete');
      el.removeAttribute('aria-expanded');
      el.removeAttribute('aria-controls');
      el.removeAttribute('aria-activedescendant');
    };
  }, [textareaRef]);

  const optionCount = options.length;
  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      setAnnouncement('');
      return;
    }
    const firstOpen = !wasOpenRef.current;
    wasOpenRef.current = true;
    const timer = window.setTimeout(() => {
      const countText = `${optionCount} note ${optionCount === 1 ? 'suggestion' : 'suggestions'}`;
      setAnnouncement(firstOpen ? `${countText}. Up and down to choose, Enter to insert.` : countText);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [isOpen, optionCount]);

  useEffect(() => {
    if (!isOpen) return;
    const activeEl = document.getElementById(`${baseId}-opt-${selectedIdx}`);
    activeEl?.scrollIntoView?.({ block: 'nearest' });
  }, [baseId, isOpen, selectedIdx]);

  const applySelection = useCallback(
    (targetSlug: string) => {
      if (!match) return;
      const { nextValue, nextCursor } = applyWikilinkSelection(value, match, targetSlug);
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

  const announcer = (
    <span role="status" aria-live="polite" className="sr-only" data-testid="wikilink-autocomplete-announcer">
      {announcement}
    </span>
  );

  if (!isOpen) return announcer;

  return (
    <>
      {announcer}
      <div
        id={listId}
        role="listbox"
        aria-label="Link a note"
        data-testid="wikilink-autocomplete"
        data-popover="true"
        onMouseDown={e => e.preventDefault()}
        className="absolute left-0 right-0 z-30 mt-1 rounded-[10px] bg-popover border border-border shadow-2xl p-1.5 space-y-0.5 max-h-80 sm:max-h-52 overflow-y-auto custom-scrollbar"
      >
        <div
          aria-hidden="true"
          className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold"
        >
          Link Note Concept
        </div>
        {options.map((n, idx) => {
          const active = idx === selectedIdx;
          return (
            <button
              key={n.id}
              type="button"
              id={optionId(idx)}
              role="option"
              aria-selected={active}
              tabIndex={-1}
              data-testid={`wikilink-option-${n.slug}`}
              // CD C3.5: select on pointerdown (touch + primary mouse) before the textarea can blur;
              // on touch, swallow the trailing synthesized click at the tap point so unmounting
              // the popup cannot activate an overlapping control (e.g. sticky Cancel/Save) below.
              onPointerDown={e => {
                if (e.pointerType !== 'touch' && e.button !== 0) return;
                e.preventDefault();
                if (e.pointerType === 'touch') {
                  const { clientX, clientY } = e;
                  const swallowGhostClick = (ev: MouseEvent) => {
                    window.removeEventListener('click', swallowGhostClick, true);
                    if (Math.hypot(ev.clientX - clientX, ev.clientY - clientY) < 12) {
                      ev.preventDefault();
                      ev.stopPropagation();
                    }
                  };
                  window.addEventListener('click', swallowGhostClick, true);
                  window.setTimeout(() => {
                    window.removeEventListener('click', swallowGhostClick, true);
                  }, 350);
                }
                applySelection(n.slug);
              }}
              onMouseDown={e => {
                if (e.button === 0) e.preventDefault();
              }}
              onClick={e => {
                if (e.detail === 0) applySelection(n.slug);
              }}
              onMouseEnter={() => setSelectedIdx(idx)}
              className={`w-full min-h-11 sm:min-h-0 text-left px-2.5 py-1.5 rounded-[8px] flex items-center justify-between gap-2 text-label transition-colors ${
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
    </>
  );
};
