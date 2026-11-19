import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Search,
  BookOpen,
  FileText,
  Target,
  Settings,
  Plus,
  SunMoon,
  RefreshCw,
  X,
  Keyboard,
} from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { useNativeDialog } from '../../hooks/useNativeDialog';
import { dialogClosedByValue } from '../../utils/dialogOverlay';
import { navigateTo } from '../../utils/navigation';
import { isNoteSpoiler } from '../../utils/spoilerMath';
import { isArchived } from '../../utils/archive';
import { buildNoteSearchHaystack, noteHref, shieldedNoteLabel } from '../../utils/noteVisibility';
import { hasFinePointer } from '../../utils/keyboardShortcuts';

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  books: Book[];
  notes: Note[];
  onOpenCapture: () => void;
  onToggleTheme: () => void;
  onSyncNow: () => void;
  /** CD D2.1: `Keyboard Shortcuts` command (subtitle `?`). */
  onOpenKeyboardHelp?: () => void;
}

interface CommandItem {
  id: string;
  title: string;
  subtitle?: string;
  category: 'Actions' | 'Views' | 'Books' | 'Notes';
  icon: React.ComponentType<{ className?: string }>;
  keywords: string[];
  action: () => void;
}

const CATEGORIES: Array<CommandItem['category']> = ['Actions', 'Views', 'Books', 'Notes'];
const EMPTY_QUERY_CAPS: Record<CommandItem['category'], number> = {
  Actions: 5,
  Views: 5,
  Books: 6,
  Notes: 8,
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  books,
  notes,
  onOpenCapture,
  onToggleTheme,
  onSyncNow,
  onOpenKeyboardHelp,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // CD D2.2: combobox / listbox ids (DOM focus stays on the input; aria-activedescendant moves).
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (idx: number) => `${baseId}-opt-${idx}`;
  const [announcement, setAnnouncement] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  useNativeDialog({
    dialogRef,
    isOpen,
    onClose,
    dismissOnBackdrop: true,
    focusInitial: focusInput,
  });

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setSelectedIndex(0);
  }, [isOpen]);

  const bookMap = useMemo(() => {
    const map = new Map<string, Book>();
    // CD D2.3: nothing to index while the palette is closed (memo gating, like `items`).
    if (!isOpen) return map;
    books.forEach(b => map.set(b.id, b));
    return map;
  }, [books, isOpen]);

  const items = useMemo<CommandItem[]>(() => {
    // QA-10: nothing to build (or crash on) while the palette is closed.
    if (!isOpen) return [];
    const list: CommandItem[] = [
      {
        id: 'new-capture',
        title: 'New Capture',
        subtitle: 'Record a quote, personal takeaway, or media note (N)',
        category: 'Actions',
        icon: Plus,
        keywords: ['capture', 'new', 'note', 'quote'],
        action: onOpenCapture,
      },
      {
        id: 'go-shelf',
        title: 'Go to Shelf',
        subtitle: 'Active books, reading progress, and activity',
        category: 'Views',
        icon: BookOpen,
        keywords: ['shelf', 'books', 'home'],
        action: () => navigateTo('#/shelf'),
      },
      {
        id: 'go-notes',
        title: 'Go to Notes',
        subtitle: 'Search commonplace cards, tags, and [[concepts]]',
        category: 'Views',
        icon: FileText,
        keywords: ['notes', 'commonplace', 'concepts'],
        action: () => navigateTo('#/notes'),
      },
      {
        id: 'go-practice',
        title: 'Go to Practice',
        subtitle: 'Active Behavioral Deltas and Takeaway Shuffle',
        category: 'Views',
        icon: Target,
        keywords: ['practice', 'deltas', 'shuffle'],
        action: () => navigateTo('#/practice'),
      },
      {
        id: 'go-settings',
        title: 'Go to Settings',
        subtitle: 'Google Workspace sync, theme, and JSON snapshots',
        category: 'Views',
        icon: Settings,
        keywords: ['settings', 'config', 'sync'],
        action: () => navigateTo('#/settings'),
      },
      {
        id: 'toggle-theme',
        title: 'Toggle Theme',
        subtitle: 'Switch between Nebula Dark and Light mode',
        category: 'Actions',
        icon: SunMoon,
        keywords: ['theme', 'dark', 'light'],
        action: onToggleTheme,
      },
      {
        id: 'sync-now',
        title: 'Sync Now',
        subtitle: 'Force refresh from storage backend (R)',
        category: 'Actions',
        icon: RefreshCw,
        keywords: ['sync', 'refresh', 'reload'],
        action: onSyncNow,
      },
    ];
    if (onOpenKeyboardHelp && hasFinePointer()) {
      list.push({
        id: 'keyboard-shortcuts',
        title: 'Keyboard Shortcuts',
        subtitle: '?',
        category: 'Actions',
        icon: Keyboard,
        keywords: ['keyboard', 'shortcuts', 'keys', 'help', 'hotkeys'],
        action: onOpenKeyboardHelp,
      });
    }

    for (const book of books) {
      if (isArchived(book)) continue; // C1.1: archived books stay out of the palette
      list.push({
        id: `book-${book.id}`,
        title: book.title,
        subtitle: `${book.author} · ${book.status}`,
        category: 'Books',
        icon: BookOpen,
        keywords: [book.title.toLowerCase(), book.author.toLowerCase(), book.kind, book.format],
        action: () => navigateTo(`#/book/${encodeURIComponent(book.id)}`),
      });
    }

    for (const note of notes) {
      if (isArchived(note)) continue; // C1.1
      const book = bookMap.get(note.bookId);
      const spoiler = isNoteSpoiler(note, book);
      // B2.2 / decisions.md #2: a shielded note shows only its position; title, slug and
      // content never reach the palette (title, keywords or the DOM test id).
      const title = spoiler
        ? shieldedNoteLabel(note, book)
        : String(note.meta?.title || note.slug || '');
      list.push({
        id: spoiler ? `note-shielded-${note.id}` : `note-${note.slug}`,
        title,
        subtitle: spoiler
          ? `${book?.title || 'Book'} · Spoiler Shielded`
          : `${book?.title || 'Book'} · ${note.takeaway || note.quote}`.slice(0, 90),
        category: 'Notes',
        icon: FileText,
        keywords: spoiler
          ? [buildNoteSearchHaystack(note, book)]
          : [
              title.toLowerCase(),
              String(note.slug || '').toLowerCase(),
              String(note.takeaway || '').toLowerCase(),
              String(note.quote || '').toLowerCase(),
              ...(Array.isArray(note.tags) ? note.tags : []).map(t => String(t).toLowerCase()),
            ],
        action: () => navigateTo(noteHref(note, book)),
      });
    }

    return list;
  }, [isOpen, bookMap, books, notes, onOpenCapture, onOpenKeyboardHelp, onSyncNow, onToggleTheme]);

  const { groupedItems, flatItems } = useMemo(() => {
    if (!isOpen) return { groupedItems: [], flatItems: [] as CommandItem[] };
    const q = query.trim().toLowerCase();
    const matches = q
      ? items.filter(
          item =>
            item.title.toLowerCase().includes(q) ||
            (item.subtitle && item.subtitle.toLowerCase().includes(q)) ||
            item.keywords.some(k => k.includes(q))
        )
      : items;

    const groups: Array<{
      category: CommandItem['category'];
      entries: Array<{ item: CommandItem; flatIndex: number }>;
    }> = [];
    const flat: CommandItem[] = [];

    for (const cat of CATEGORIES) {
      const catMatches = matches.filter(item => item.category === cat);
      const capped = q ? catMatches : catMatches.slice(0, EMPTY_QUERY_CAPS[cat]);
      if (capped.length === 0) continue;
      const entries = capped.map(item => {
        const flatIndex = flat.length;
        flat.push(item);
        return { item, flatIndex };
      });
      groups.push({ category: cat, entries });
    }

    return { groupedItems: groups, flatItems: flat };
  }, [isOpen, items, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // CD D2.2: polite, debounced (400 ms) result count — `{n} results` / `No results`.
  const resultCount = flatItems.length;
  useEffect(() => {
    if (!isOpen) {
      setAnnouncement('');
      return;
    }
    const timer = window.setTimeout(() => {
      setAnnouncement(resultCount === 0 ? 'No results' : `${resultCount} ${resultCount === 1 ? 'result' : 'results'}`);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [isOpen, resultCount, query]);

  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const activeEl = listRef.current.querySelector<HTMLElement>(`[data-cmd-idx="${selectedIndex}"]`);
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % Math.max(1, flatItems.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(
        prev => (prev - 1 + flatItems.length) % Math.max(1, flatItems.length)
      );
    } else if (e.key === 'Home' && flatItems.length > 0) {
      e.preventDefault();
      setSelectedIndex(0);
    } else if (e.key === 'End' && flatItems.length > 0) {
      e.preventDefault();
      setSelectedIndex(flatItems.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = flatItems[selectedIndex];
      if (selected) {
        onClose();
        selected.action();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      data-testid="command-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
      {...({ closedby: dialogClosedByValue(true) } as Record<string, string>)}
      className="pragya-dialog pragya-dialog--palette print:hidden mt-16 sm:mt-20 mb-auto mx-auto w-[calc(100%-2rem)] max-w-xl"
    >
      <div className="w-full bg-card border border-border rounded-[14px] shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface2/50">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flatItems[selectedIndex] ? optionId(selectedIndex) : undefined}
            enterKeyHint="search"
            autoComplete="off"
            aria-label="Search commands, books, and notes"
            data-testid="command-palette-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search books, notes, #tags, or commands…"
            className="w-full bg-transparent text-foreground placeholder:text-muted-foreground text-base sm:text-body font-medium outline-none"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 sm:p-1 inline-flex items-center justify-center rounded-[8px] text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-label rounded bg-surface2 text-muted-foreground border border-border">
            ESC
          </kbd>
        </div>

        <div role="status" aria-live="polite" className="sr-only" data-testid="command-palette-announcer">
          {announcement}
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          className={
            flatItems.length === 0
              ? 'sr-only'
              : 'max-h-80 overflow-y-auto overscroll-contain custom-scrollbar p-2 space-y-2'
          }
        >
          {groupedItems.map(group => (
            <div
              key={group.category}
              role="group"
              aria-label={group.category}
              data-testid={`command-palette-group-${group.category.toLowerCase()}`}
              className="space-y-0.5"
            >
              <div
                aria-hidden="true"
                className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {group.category}
              </div>
              {group.entries.map(({ item, flatIndex }) => {
                const Icon = item.icon;
                const isSelected = flatIndex === selectedIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    id={optionId(flatIndex)}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                    data-cmd-idx={flatIndex}
                    data-testid={`command-palette-item-${item.id}`}
                    onClick={() => {
                      onClose();
                      item.action();
                    }}
                    onMouseEnter={() => setSelectedIndex(flatIndex)}
                    className={`w-full min-h-11 sm:min-h-0 flex items-center justify-between gap-3 px-3 py-2.5 rounded-[10px] text-left transition-colors ${
                      isSelected
                        ? 'bg-surface2 text-foreground border border-border'
                        : 'text-foreground hover:bg-surface2/60 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`p-1.5 rounded-[8px] shrink-0 ${
                          isSelected
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-surface2 text-muted-foreground'
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-body font-medium truncate">{item.title}</p>
                        {item.subtitle && (
                          <p className="text-label text-muted-foreground truncate">
                            {item.subtitle}
                          </p>
                        )}
                      </div>
                    </div>
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface2 text-muted-foreground shrink-0 border border-border/60">
                      {item.category}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {flatItems.length === 0 && (
          <div className="py-8 text-center text-muted-foreground text-label">
            No matching books, notes, or actions found.
          </div>
        )}
      </div>
    </dialog>
  );
};
