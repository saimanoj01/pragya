import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  BookOpenText,
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
import { useNativeDialog } from '../../hooks/useNativeDialog';
import { dialogClosedByValue } from '../../utils/dialogOverlay';
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
  const drawerRef = useRef<HTMLDialogElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  const closeMoreMenu = useCallback(() => setShowMoreMenu(false), []);
  const focusFirstItem = useCallback(() => {
    firstItemRef.current?.focus();
  }, []);

  useNativeDialog({
    dialogRef: drawerRef,
    isOpen: showMoreMenu,
    onClose: closeMoreMenu,
    dismissOnBackdrop: true,
    focusInitial: focusFirstItem,
  });

  // Close the mobile-only drawer if the viewport widens to desktop (`md:hidden`) while open,
  // preventing a hidden top-layer `<dialog>` from leaving the desktop page inert.
  useEffect(() => {
    if (!showMoreMenu || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(min-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setShowMoreMenu(false);
    };
    if (mql.matches) {
      setShowMoreMenu(false);
      return;
    }
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
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
              showMoreMenu || currentView === 'settings' || currentView === 'lexicon'
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <MoreHorizontal className="w-5 h-5 mb-0.5" />
            <span>More</span>
          </button>
        </div>
      </nav>

      {showMoreMenu && (
        <dialog
          ref={drawerRef}
          data-testid="mobile-more-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="More"
          {...({ closedby: dialogClosedByValue(true) } as Record<string, string>)}
          className="pragya-dialog pragya-dialog--drawer print:hidden md:hidden m-0 mt-auto mb-0 w-full max-w-none"
        >
          <div className="bg-card border-t border-border rounded-t-[14px] pt-4 pb-[max(env(safe-area-inset-bottom),1rem)] pl-[max(env(safe-area-inset-left),1rem)] pr-[max(env(safe-area-inset-right),1rem)] shadow-2xl space-y-2">
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
                onClick={closeMoreMenu}
                className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-[8px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                ref={firstItemRef}
                type="button"
                autoFocus
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
                href="#/lexicon"
                data-testid="drawer-nav-lexicon"
                aria-current={navAriaCurrent('lexicon', currentView)}
                onClick={e => {
                  setShowMoreMenu(false);
                  handleNavLinkClick(e, '#/lexicon');
                }}
                className="min-h-11 flex items-center gap-2.5 p-3 rounded-[10px] bg-surface2/60 hover:bg-surface2 border border-border text-label font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <BookOpenText className="w-4 h-4 shrink-0" />
                <span>Lexicon</span>
              </a>

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
          </div>
        </dialog>
      )}
    </>
  );
};
