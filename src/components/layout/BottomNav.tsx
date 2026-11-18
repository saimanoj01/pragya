import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BookOpen,
  FileText,
  Plus,
  Target,
  MoreHorizontal,
  Settings,
  RefreshCw,
  Sun,
  Moon,
  LogOut,
  Search,
  X,
  WifiOff,
  Keyboard,
} from 'lucide-react';
import type { PragyaView } from '../../utils/navigation';
import { handleNavLinkClick, navAriaCurrent } from '../../utils/navLinks';
import { hasFinePointer, modKeyLabel } from '../../utils/keyboardShortcuts';

export interface BottomNavProps {
  currentView: PragyaView;
  isOfflineReadOnly?: boolean;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  onOpenCapture: () => void;
  onOpenCommandPalette: () => void;
  onSyncNow: () => void;
  onLogout: () => void;
  /** CD D2.1: More drawer `Keyboard Shortcuts` (only on devices with a fine pointer, Q13). */
  onOpenKeyboardHelp?: () => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  currentView,
  isOfflineReadOnly = false,
  theme,
  toggleTheme,
  onOpenCapture,
  onOpenCommandPalette,
  onSyncNow,
  onLogout,
  onOpenKeyboardHelp,
}) => {
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  useEffect(() => {
    if (!showMoreMenu) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setShowMoreMenu(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showMoreMenu]);

  const isShelf = currentView === 'shelf' || currentView === 'book';
  const isNotes = currentView === 'notes' || currentView === 'note';
  const isPractice = currentView === 'practice';
  const modLabel = modKeyLabel(
    typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent
  );

  return (
    <>
      <nav
        data-testid="bottom-nav"
        className="print:hidden md:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur-xl border-t border-border pl-[max(env(safe-area-inset-left),0.5rem)] pr-[max(env(safe-area-inset-right),0.5rem)] pt-1 pb-[max(env(safe-area-inset-bottom),0.5rem)]"
        aria-label="Primary"
      >
        <div className="flex items-center justify-around h-14">
          <a
            href="#/shelf"
            data-testid="bottom-nav-shelf"
            aria-current={navAriaCurrent('shelf', currentView)}
            onClick={e => {
              setShowMoreMenu(false);
              handleNavLinkClick(e, '#/shelf');
            }}
            className={`min-h-11 min-w-11 flex flex-col items-center justify-center flex-1 py-1 rounded-[8px] text-label font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
              isShelf ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <BookOpen className="w-5 h-5 mb-0.5" />
            <span>Shelf</span>
          </a>

          <a
            href="#/notes"
            data-testid="bottom-nav-notes"
            aria-current={navAriaCurrent('notes', currentView)}
            onClick={e => {
              setShowMoreMenu(false);
              handleNavLinkClick(e, '#/notes');
            }}
            className={`min-h-11 min-w-11 flex flex-col items-center justify-center flex-1 py-1 rounded-[8px] text-label font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
              isNotes ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <FileText className="w-5 h-5 mb-0.5" />
            <span>Notes</span>
          </a>

          <div className="flex-1 flex justify-center -mt-4">
            <button
              type="button"
              data-testid="bottom-nav-capture"
              onClick={() => {
                setShowMoreMenu(false);
                onOpenCapture();
              }}
              className="w-11 h-11 rounded-full bg-primary text-primary-foreground border border-border flex items-center justify-center shadow-md hover:opacity-90 active:scale-95 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              aria-label="Quick Capture"
              title="Quick Capture"
            >
              <Plus className="w-5 h-5 stroke-[2.2]" />
            </button>
          </div>

          <a
            href="#/practice"
            data-testid="bottom-nav-practice"
            aria-current={navAriaCurrent('practice', currentView)}
            onClick={e => {
              setShowMoreMenu(false);
              handleNavLinkClick(e, '#/practice');
            }}
            className={`min-h-11 min-w-11 flex flex-col items-center justify-center flex-1 py-1 rounded-[8px] text-label font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
              isPractice ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Target className="w-5 h-5 mb-0.5" />
            <span>Practice</span>
          </a>

          <button
            type="button"
            data-testid="bottom-nav-more"
            aria-expanded={showMoreMenu}
            onClick={() => setShowMoreMenu(prev => !prev)}
            className={`min-h-11 min-w-11 flex flex-col items-center justify-center flex-1 py-1 rounded-[8px] text-label font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
              showMoreMenu || currentView === 'settings'
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <MoreHorizontal className="w-5 h-5 mb-0.5" />
            <span>More</span>
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {showMoreMenu && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowMoreMenu(false)}
              className="print:hidden md:hidden fixed inset-0 z-40 bg-background/60 backdrop-blur-sm"
            />
            <motion.div
              data-testid="mobile-more-drawer"
              data-popover="true"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 280 }}
              className="print:hidden md:hidden fixed bottom-[calc(3.75rem+max(env(safe-area-inset-bottom),0.5rem))] left-0 right-0 z-50 bg-card border-t border-border rounded-t-[14px] pt-4 pb-4 pl-[max(env(safe-area-inset-left),1rem)] pr-[max(env(safe-area-inset-right),1rem)] shadow-2xl space-y-2"
            >
              <div className="flex items-center justify-between pb-2 border-b border-border/60">
                <div className="flex items-center gap-2">
                  <span className="text-eyebrow uppercase text-muted-foreground">More Options</span>
                  {isOfflineReadOnly && (
                    <span
                      data-testid="drawer-offline-badge"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-warning/15 border border-warning/30 text-[10px] font-semibold text-warning"
                    >
                      <WifiOff className="w-3 h-3" />
                      <span>Offline · Read-Only</span>
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Close More menu"
                  onClick={() => setShowMoreMenu(false)}
                  className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-[8px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  data-testid="drawer-search-btn"
                  onClick={() => {
                    setShowMoreMenu(false);
                    onOpenCommandPalette();
                  }}
                  className="col-span-2 min-h-11 flex items-center justify-between gap-2.5 p-3 rounded-[10px] bg-surface2/60 hover:bg-surface2 border border-border text-label font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <span className="inline-flex items-center gap-2.5">
                    <Search className="w-4 h-4 shrink-0" />
                    <span>Search &amp; Commands</span>
                  </span>
                  <kbd className="px-1.5 py-0.5 text-[10px] rounded bg-background text-muted-foreground border border-border">
                    {modLabel}K
                  </kbd>
                </button>

                <a
                  href="#/settings"
                  data-testid="drawer-nav-settings"
                  aria-current={navAriaCurrent('settings', currentView)}
                  onClick={e => {
                    setShowMoreMenu(false);
                    handleNavLinkClick(e, '#/settings');
                  }}
                  className="min-h-11 flex items-center gap-2.5 p-3 rounded-[10px] bg-surface2/60 hover:bg-surface2 border border-border text-label font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <Settings className="w-4 h-4 shrink-0" />
                  <span>Settings</span>
                </a>

                <button
                  type="button"
                  data-testid="drawer-sync-btn"
                  onClick={() => {
                    setShowMoreMenu(false);
                    onSyncNow();
                  }}
                  className="min-h-11 flex items-center gap-2.5 p-3 rounded-[10px] bg-surface2/60 hover:bg-surface2 border border-border text-label font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <RefreshCw className="w-4 h-4 shrink-0" />
                  <span>Sync Now</span>
                </button>

                <button
                  type="button"
                  data-testid="drawer-theme-toggle"
                  onClick={() => {
                    toggleTheme();
                    setShowMoreMenu(false);
                  }}
                  className="min-h-11 flex items-center gap-2.5 p-3 rounded-[10px] bg-surface2/60 hover:bg-surface2 border border-border text-label font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {theme === 'dark' ? (
                    <Sun className="w-4 h-4 shrink-0" />
                  ) : (
                    <Moon className="w-4 h-4 shrink-0" />
                  )}
                  <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
                </button>

                {onOpenKeyboardHelp && hasFinePointer() && (
                  <button
                    type="button"
                    data-testid="drawer-keyboard-help-btn"
                    onClick={() => {
                      setShowMoreMenu(false);
                      onOpenKeyboardHelp();
                    }}
                    className="hidden [@media(any-pointer:fine)]:flex min-h-11 items-center gap-2.5 p-3 rounded-[10px] bg-surface2/60 hover:bg-surface2 border border-border text-label font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <Keyboard className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>Keyboard Shortcuts</span>
                  </button>
                )}

                <button
                  type="button"
                  data-testid="drawer-logout-btn"
                  onClick={() => {
                    setShowMoreMenu(false);
                    onLogout();
                  }}
                  className="min-h-11 flex items-center gap-2.5 p-3 rounded-[10px] bg-surface2/60 hover:bg-negative/10 border border-border text-label font-semibold text-negative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <LogOut className="w-4 h-4 shrink-0" />
                  <span>Logout</span>
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
};
