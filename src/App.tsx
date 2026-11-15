import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { MotionConfig } from 'framer-motion';
import type { Book } from './types/pragya';
import { dur, ease } from './theme/motion';
import { AuthProvider, useAuth } from './context/AuthContext';
import { PragyaProvider, usePragya } from './context/PragyaContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { isOAuthCallbackHash, navigateTo, parseHash, type PragyaRoute } from './utils/navigation';
import { AppLayout } from './components/layout/AppLayout';
import { Sidebar } from './components/layout/Sidebar';
import { BottomNav } from './components/layout/BottomNav';
import { CommandPalette } from './components/layout/CommandPalette';
import { SessionExpiredModal } from './components/layout/SessionExpiredModal';
import { LoginView } from './components/views/LoginView';
import { ShelfView } from './components/views/ShelfView';
import { NotesView } from './components/views/NotesView';
import { SettingsView } from './components/views/SettingsView';
import { BookDetailPreview, NoteDetailPreview, PracticePreview } from './components/views/BridgeViews';
import { AddBookModal } from './components/modals/AddBookModal';
import { EditBookModal } from './components/modals/EditBookModal';
import { QuickCaptureModal } from './components/modals/QuickCaptureModal';

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

function PragyaShell() {
  const {
    user,
    isAuthenticated,
    isMockMode,
    login,
    loginAsMock,
    logout,
    showSessionExpiredModal,
    setShowSessionExpiredModal,
  } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { books, notes, isLoading, syncNow } = usePragya();

  const [route, setRoute] = useState<PragyaRoute>(() => parseHash());
  const [showCaptureModal, setShowCaptureModal] = useState(false);
  const [captureBookId, setCaptureBookId] = useState<string | null>(null);
  const [showAddBookModal, setShowAddBookModal] = useState(false);
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  const gChordTimerRef = useRef<number | null>(null);
  const awaitingGTargetRef = useRef(false);

  useEffect(() => {
    const onHashChange = () => {
      if (isOAuthCallbackHash(window.location.hash)) {
        return;
      }
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Global keyboard map with input focus guard
  useEffect(() => {
    if (!isAuthenticated) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (showSessionExpiredModal) return;
        e.preventDefault();
        setShowCommandPalette(prev => !prev);
        return;
      }

      if (e.key === 'Escape') {
        if (document.querySelector('[data-popover="true"]')) return;
        if (
          showCommandPalette ||
          showCaptureModal ||
          showAddBookModal ||
          editingBook ||
          showSessionExpiredModal
        ) {
          return;
        }
        if (route.view === 'book') {
          navigateTo('#/shelf');
        } else if (route.view === 'note') {
          navigateTo('#/notes');
        }
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableElement(e.target)) return;
      if (showCommandPalette || showCaptureModal || showAddBookModal || editingBook || showSessionExpiredModal) {
        return;
      }

      const key = e.key.toLowerCase();

      if (awaitingGTargetRef.current) {
        awaitingGTargetRef.current = false;
        if (gChordTimerRef.current) {
          window.clearTimeout(gChordTimerRef.current);
          gChordTimerRef.current = null;
        }
        if (key === 's') {
          e.preventDefault();
          navigateTo('#/shelf');
          return;
        }
        if (key === 'n') {
          e.preventDefault();
          navigateTo('#/notes');
          return;
        }
        if (key === 'p') {
          e.preventDefault();
          navigateTo('#/practice');
          return;
        }
      }

      if (key === 'g') {
        awaitingGTargetRef.current = true;
        if (gChordTimerRef.current) window.clearTimeout(gChordTimerRef.current);
        gChordTimerRef.current = window.setTimeout(() => {
          awaitingGTargetRef.current = false;
        }, 1000);
        return;
      }

      if (key === 'n') {
        e.preventDefault();
        setCaptureBookId(route.view === 'book' ? route.bookId || null : null);
        setShowCaptureModal(true);
        return;
      }

      if (key === 'r') {
        e.preventDefault();
        void syncNow(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (gChordTimerRef.current) window.clearTimeout(gChordTimerRef.current);
    };
  }, [
    editingBook,
    isAuthenticated,
    route.bookId,
    route.view,
    showAddBookModal,
    showCaptureModal,
    showCommandPalette,
    showSessionExpiredModal,
    syncNow,
  ]);

  const openQuickCapture = (bookId: string | null = null) => {
    setCaptureBookId(bookId);
    setShowCaptureModal(true);
  };

  let mainContent: React.ReactNode;
  if (isLoading && books.length === 0) {
    mainContent = (
      <div className="h-[60vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  } else if (route.view === 'notes') {
    mainContent = <NotesView onOpenCapture={() => openQuickCapture(null)} />;
  } else if (route.view === 'settings') {
    mainContent = <SettingsView />;
  } else if (route.view === 'book' && route.bookId) {
    mainContent = (
      <BookDetailPreview
        bookId={route.bookId}
        onEditBook={b => setEditingBook(b)}
        onOpenCaptureForBook={id => openQuickCapture(id)}
      />
    );
  } else if (route.view === 'note' && route.noteSlug) {
    mainContent = <NoteDetailPreview noteSlug={route.noteSlug} />;
  } else if (route.view === 'practice') {
    mainContent = <PracticePreview />;
  } else {
    mainContent = (
      <ShelfView
        onOpenAddBook={() => setShowAddBookModal(true)}
        onEditBook={b => setEditingBook(b)}
        onOpenCaptureForBook={id => openQuickCapture(id)}
      />
    );
  }

  return (
    <AppLayout>
      {!isAuthenticated ? (
        <main className="flex-1 overflow-y-auto custom-scrollbar">
          <LoginView />
        </main>
      ) : (
        <>
          <div className="flex-1 flex print:block overflow-hidden print:overflow-visible min-h-0">
            <Sidebar
              currentView={route.view}
              user={user}
              isMockMode={isMockMode}
              theme={theme}
              toggleTheme={toggleTheme}
              onOpenCapture={() => openQuickCapture(null)}
              onOpenCommandPalette={() => setShowCommandPalette(true)}
              logout={logout}
            />

            <main className="flex-1 overflow-y-auto print:overflow-visible px-4 md:px-8 print:px-0 pt-0 pb-24 md:pb-8 print:pb-0 w-full relative custom-scrollbar">
              <div className="max-w-5xl mx-auto w-full">{mainContent}</div>
            </main>
          </div>

          <BottomNav
            currentView={route.view}
            theme={theme}
            toggleTheme={toggleTheme}
            onOpenCapture={() => openQuickCapture(null)}
            onSyncNow={() => void syncNow(true)}
            onLogout={() => void logout()}
          />

          <QuickCaptureModal
            isOpen={showCaptureModal}
            initialBookId={captureBookId}
            onClose={() => setShowCaptureModal(false)}
          />

          <AddBookModal
            isOpen={showAddBookModal}
            onClose={() => setShowAddBookModal(false)}
          />

          <EditBookModal
            book={editingBook}
            onClose={() => setEditingBook(null)}
          />

          <CommandPalette
            isOpen={showCommandPalette}
            onClose={() => setShowCommandPalette(false)}
            books={books}
            notes={notes}
            onOpenCapture={() => openQuickCapture(null)}
            onToggleTheme={toggleTheme}
            onSyncNow={() => void syncNow(true)}
          />
        </>
      )}

      <SessionExpiredModal
        isOpen={showSessionExpiredModal}
        onClose={() => setShowSessionExpiredModal(false)}
        onReconnect={() => {
          setShowSessionExpiredModal(false);
          void login();
        }}
        onContinueDemo={() => {
          setShowSessionExpiredModal(false);
          void loginAsMock();
        }}
      />
    </AppLayout>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <PragyaProvider>
          <MotionConfig reducedMotion="user" transition={{ duration: dur.small, ease }}>
            <PragyaShell />
          </MotionConfig>
        </PragyaProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
