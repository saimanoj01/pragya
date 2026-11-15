import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  BookOpen,
  FileText,
  Target,
  Settings,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Sun,
  Moon,
  LogOut,
} from 'lucide-react';
import type { User } from '../../context/AuthContext';
import type { PragyaView } from '../../utils/navigation';
import { navigateTo } from '../../utils/navigation';

export const SIDEBAR_COLLAPSED_KEY = 'pragya_sidebar_collapsed';

export interface SidebarProps {
  currentView: PragyaView;
  user: User | null;
  isMockMode: boolean;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  onOpenCapture: () => void;
  onOpenCommandPalette: () => void;
  logout: () => Promise<void> | void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  user,
  isMockMode,
  theme,
  toggleTheme,
  onOpenCapture,
  onOpenCommandPalette,
  logout,
}) => {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Ignore storage error
    }
  }, [collapsed]);

  const navItems: Array<{
    id: 'shelf' | 'notes' | 'practice' | 'settings';
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    route: string;
    isActive: boolean;
  }> = [
    {
      id: 'shelf',
      label: 'Shelf',
      icon: BookOpen,
      route: '#/shelf',
      isActive: currentView === 'shelf' || currentView === 'book',
    },
    {
      id: 'notes',
      label: 'Notes',
      icon: FileText,
      route: '#/notes',
      isActive: currentView === 'notes' || currentView === 'note',
    },
    {
      id: 'practice',
      label: 'Practice',
      icon: Target,
      route: '#/practice',
      isActive: currentView === 'practice',
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
      route: '#/settings',
      isActive: currentView === 'settings',
    },
  ];

  return (
    <motion.aside
      data-testid="sidebar"
      initial={false}
      animate={{ width: collapsed ? 64 : 244 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="print:hidden hidden md:flex flex-col shrink-0 border-r border-border bg-background z-30 select-none"
    >
      {/* Top Brand Header */}
      <div className="h-14 flex items-center justify-between gap-2 px-3 border-b border-border/60">
        {!collapsed ? (
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg leading-none" aria-hidden="true">
              🪷
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-foreground truncate">
              Pragya
            </span>
            <span
              data-testid="demo-badge"
              className="px-1.5 py-0.5 text-[10px] font-medium rounded-md bg-surface2 border border-border text-muted-foreground shrink-0"
            >
              {isMockMode ? 'Demo' : 'Cloud'}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => navigateTo('#/shelf')}
            className="w-full flex items-center justify-center text-lg"
            title="Pragya"
          >
            🪷
          </button>
        )}

        {!collapsed && (
          <button
            type="button"
            data-testid="sidebar-toggle-btn"
            onClick={() => setCollapsed(true)}
            className="w-7 h-7 rounded-[8px] inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors focus-visible:ring-2 ring-ring/40"
            title="Collapse Sidebar"
            aria-label="Collapse Sidebar"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Primary Capture CTA + Search */}
      <div className="px-2.5 pt-3 pb-2 space-y-2">
        <button
          type="button"
          data-testid="sidebar-capture-btn"
          onClick={onOpenCapture}
          className={`w-full h-10 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body flex items-center justify-center gap-2 hover:opacity-90 transition-opacity shadow-sm focus-visible:ring-2 ring-ring/40 ${
            collapsed ? 'px-0' : 'px-3'
          }`}
          title="Quick Capture (N)"
        >
          <Plus className="w-4 h-4 shrink-0" />
          {!collapsed && <span className="whitespace-nowrap">Capture (N)</span>}
        </button>

        <button
          type="button"
          data-testid="command-palette-trigger"
          onClick={onOpenCommandPalette}
          className={`w-full h-9 flex items-center justify-between px-2.5 rounded-[10px] bg-surface2/50 border border-border text-body text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors focus-visible:ring-2 ring-ring/40 ${
            collapsed ? 'justify-center px-0' : ''
          }`}
          title="Search or jump to (⌘K)"
        >
          <span className="flex items-center gap-2.5 truncate">
            <Search className="w-3.5 h-3.5 shrink-0" />
            {!collapsed && <span className="truncate text-label">Search…</span>}
          </span>
          {!collapsed && (
            <kbd className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-background text-muted-foreground border border-border">
              ⌘K
            </kbd>
          )}
        </button>
      </div>

      {/* Primary Nav */}
      <nav className="flex-1 px-2.5 py-2 space-y-1 overflow-y-auto custom-scrollbar">
        {navItems.map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`nav-item-${item.id}`}
              onClick={() => navigateTo(item.route)}
              className={`w-full h-9 flex items-center gap-3 px-2.5 rounded-[10px] text-body font-medium transition-colors focus-visible:ring-2 ring-ring/40 ${
                item.isActive
                  ? 'bg-surface2 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-surface2/60'
              } ${collapsed ? 'justify-center px-0' : ''}`}
              title={collapsed ? item.label : undefined}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Bottom Footer: Theme, User & Logout */}
      <div className="px-2.5 py-2.5 border-t border-border/60 space-y-2">
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              data-testid="theme-toggle-btn"
              onClick={toggleTheme}
              className="w-8 h-8 rounded-[8px] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors"
              title="Toggle Light/Dark Theme"
              aria-label="Toggle Light/Dark Theme"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              type="button"
              data-testid="logout-btn"
              onClick={logout}
              className="w-8 h-8 rounded-[8px] flex items-center justify-center text-muted-foreground hover:text-negative hover:bg-negative/10 transition-colors"
              title="Logout"
              aria-label="Logout"
            >
              <LogOut className="w-4 h-4" />
            </button>
            <button
              type="button"
              data-testid="sidebar-expand-btn"
              onClick={() => setCollapsed(false)}
              className="w-8 h-8 rounded-[8px] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors"
              title="Expand Sidebar"
              aria-label="Expand Sidebar"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <div className="w-7 h-7 rounded-full bg-surface2 border border-border text-foreground flex items-center justify-center font-semibold text-label shrink-0">
                {user?.name?.charAt(0) || 'P'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-label font-medium text-foreground truncate">
                  {user?.name || 'Reader'}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {isMockMode ? 'Demo Workspace' : user?.email || 'Google Sync'}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                data-testid="theme-toggle-btn"
                onClick={toggleTheme}
                className="w-7 h-7 rounded-[8px] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors"
                title="Toggle Light/Dark Theme"
                aria-label="Toggle Light/Dark Theme"
              >
                {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
              <button
                type="button"
                data-testid="logout-btn"
                onClick={logout}
                className="w-7 h-7 rounded-[8px] flex items-center justify-center text-muted-foreground hover:text-negative hover:bg-negative/10 transition-colors"
                title="Logout"
                aria-label="Logout"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </motion.aside>
  );
};
