import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
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
} from 'lucide-react';
import type { Book, Note } from '../../types/pragya';
import { navigateTo } from '../../utils/navigation';
import { isNoteSpoiler } from '../../utils/spoilerMath';

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  books: Book[];
  notes: Note[];
  onOpenCapture: () => void;
  onToggleTheme: () => void;
  onSyncNow: () => void;
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

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  books,
  notes,
  onOpenCapture,
  onToggleTheme,
  onSyncNow,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setSelectedIndex(0);
    if (
      inputRef.current &&
      (!dialogRef.current || !dialogRef.current.contains(document.activeElement))
    ) {
      inputRef.current.focus();
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const dialogs = document.querySelectorAll('[role="dialog"]');
        if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== dialogRef.current) {
          return;
        }
        if (document.querySelector('[data-popover="true"]')) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', handleEsc, true);
    return () => {
      window.removeEventListener('keydown', handleEsc, true);
    };
  }, [isOpen]);

  const bookMap = useMemo(() => {
    const map = new Map<string, Book>();
    books.forEach(b => map.set(b.id, b));
    return map;
  }, [books]);

  const items = useMemo<CommandItem[]>(() => {
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

    for (const book of books) {
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
      const book = bookMap.get(note.bookId);
      const spoiler = isNoteSpoiler(note, book);
      const title = note.meta.title || note.slug;
      list.push({
        id: `note-${note.slug}`,
        title,
        subtitle: spoiler
          ? `${book?.title || 'Book'} · Spoiler Shielded`
          : `${book?.title || 'Book'} · ${note.takeaway || note.quote}`.slice(0, 90),
        category: 'Notes',
        icon: FileText,
        keywords: [
          title.toLowerCase(),
          note.slug.toLowerCase(),
          ...(spoiler ? [] : [note.takeaway.toLowerCase(), note.quote.toLowerCase()]),
          ...note.tags.map(t => t.toLowerCase()),
        ],
        action: () => navigateTo(`#/note/${encodeURIComponent(note.slug)}`),
      });
    }

    return list;
  }, [bookMap, books, notes, onOpenCapture, onSyncNow, onToggleTheme]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 20);
    return items.filter(
      item =>
        item.title.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)) ||
        item.keywords.some(k => k.includes(q))
    );
  }, [items, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const activeEl = listRef.current.querySelector<HTMLElement>(`[data-cmd-idx="${selectedIndex}"]`);
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % Math.max(1, filteredItems.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(
        prev => (prev - 1 + filteredItems.length) % Math.max(1, filteredItems.length)
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filteredItems[selectedIndex];
      if (selected) {
        onClose();
        selected.action();
      }
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="print:hidden fixed inset-0 z-[60] flex items-start justify-center pt-16 sm:pt-20 px-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-background/70 backdrop-blur-sm"
          />

          <motion.div
            ref={dialogRef}
            data-testid="command-palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command Palette"
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ duration: 0.14 }}
            className="relative w-full max-w-xl bg-card border border-border rounded-[14px] shadow-2xl overflow-hidden flex flex-col z-10"
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface2/50">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                type="text"
                data-testid="command-palette-input"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search books, notes, #tags, or commands…"
                className="w-full bg-transparent text-foreground placeholder:text-muted-foreground text-body font-medium outline-none"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                  className="p-1 rounded-[8px] text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-label rounded bg-surface2 text-muted-foreground border border-border">
                ESC
              </kbd>
            </div>

            <div
              ref={listRef}
              className="max-h-80 overflow-y-auto custom-scrollbar p-2 space-y-1"
            >
              {filteredItems.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground text-label">
                  No matching books, notes, or actions found.
                </div>
              ) : (
                filteredItems.map((item, idx) => {
                  const Icon = item.icon;
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-cmd-idx={idx}
                      data-testid={`command-palette-item-${item.id}`}
                      onClick={() => {
                        onClose();
                        item.action();
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-[10px] text-left transition-colors ${
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
                })
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
