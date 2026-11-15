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
  X,
} from 'lucide-react';
import type { PragyaView } from '../../utils/navigation';
import { navigateTo } from '../../utils/navigation';

export interface BottomNavProps {
  currentView: PragyaView;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  onOpenCapture: () => void;
  onSyncNow: () => void;
  onLogout: () => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  currentView,
  theme,
  toggleTheme,
  onOpenCapture,
  onSyncNow,
  onLogout,
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

  return (
    <>
      <nav
        data-testid="bottom-nav"
        className="print:hidden md:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur-xl border-t border-border px-2 pt-1 pb-[max(env(safe-area-inset-bottom),0.5rem)]"
        aria-label="Mobile Navigation"
      >
        <div className="flex items-center justify-around h-14">
          <button
            type="button"
            data-testid="bottom-nav-shelf"
            onClick={() => {
              setShowMoreMenu(false);
              navigateTo('#/shelf');
            }}
            className={`flex flex-col items-center justify-center flex-1 py-1 text-label font-medium transition-colors ${
              isShelf ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <BookOpen className="w-5 h-5 mb-0.5" />
            <span>Shelf</span>
          </button>

          <button
            type="button"
            data-testid="bottom-nav-notes"
            onClick={() => {
              setShowMoreMenu(false);
              navigateTo('#/notes');
            }}
            className={`flex flex-col items-center justify-center flex-1 py-1 text-label font-medium transition-colors ${
              isNotes ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <FileText className="w-5 h-5 mb-0.5" />
            <span>Notes</span>
          </button>

          <div className="flex-1 flex justify-center -mt-4">
            <button
              type="button"
              data-testid="bottom-nav-capture"
              onClick={() => {
                setShowMoreMenu(false);
                onOpenCapture();
              }}
              className="w-11 h-11 rounded-full bg-primary text-primary-foreground border border-border flex items-center justify-center shadow-md hover:opacity-90 active:scale-95 transition-all"
              aria-label="Quick Capture"
              title="Quick Capture"
            >
              <Plus className="w-5 h-5 stroke-[2.2]" />
            </button>
          </div>

          <button
            type="button"
            data-testid="bottom-nav-practice"
            onClick={() => {
              setShowMoreMenu(false);
              navigateTo('#/practice');
            }}
            className={`flex flex-col items-center justify-center flex-1 py-1 text-label font-medium transition-colors ${
              isPractice ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Target className="w-5 h-5 mb-0.5" />
            <span>Practice</span>
          </button>

          <button
            type="button"
            data-testid="bottom-nav-more"
            aria-expanded={showMoreMenu}
            onClick={() => setShowMoreMenu(prev => !prev)}
            className={`flex flex-col items-center justify-center flex-1 py-1 text-label font-medium transition-colors ${
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
              className="print:hidden md:hidden fixed bottom-16 left-0 right-0 z-50 bg-card border-t border-border rounded-t-[14px] p-4 shadow-2xl space-y-2"
            >
              <div className="flex items-center justify-between pb-2 border-b border-border/60">
                <span className="text-eyebrow uppercase text-muted-foreground">More Options</span>
                <button
                  type="button"
                  aria-label="Close More menu"
                  onClick={() => setShowMoreMenu(false)}
                  className="p-1 rounded-[8px] text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  data-testid="drawer-nav-settings"
                  onClick={() => {
                    setShowMoreMenu(false);
                    navigateTo('#/settings');
                  }}
                  className="flex items-center gap-2.5 p-3 rounded-[10px] bg-surface2/60 hover:bg-surface2 border border-border text-label font-semibold text-foreground"
                >
                  <Settings className="w-4 h-4 shrink-0" />
                  <span>Settings</span>
                </button>

                <button
                  type="button"
                  data-testid="drawer-sync-btn"
                  onClick={() => {
                    setShowMoreMenu(false);
                    onSyncNow();
                  }}
                  className="flex items-center gap-2.5 p-3 rounded-[10px] bg-surface2/60 hover:bg-surface2 border border-border text-label font-semibold text-foreground"
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
                  className="flex items-center gap-2.5 p-3 rounded-[10px] bg-surface2/60 hover:bg-surface2 border border-border text-label font-semibold text-foreground"
                >
                  {theme === 'dark' ? (
                    <Sun className="w-4 h-4 shrink-0" />
                  ) : (
                    <Moon className="w-4 h-4 shrink-0" />
                  )}
                  <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
                </button>

                <button
                  type="button"
                  data-testid="drawer-logout-btn"
                  onClick={() => {
                    setShowMoreMenu(false);
                    onLogout();
                  }}
                  className="flex items-center gap-2.5 p-3 rounded-[10px] bg-surface2/60 hover:bg-negative/10 border border-border text-label font-semibold text-negative"
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
