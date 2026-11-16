import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { MotionConfig } from 'framer-motion';
import type { Book, Note } from './types/pragya';
import { dur, ease } from './theme/motion';
import { AuthProvider, useAuth } from './context/AuthContext';
import { PragyaProvider, usePragya } from './context/PragyaContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
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
import { BookDetailView } from './components/views/BookDetailView';
import { NoteDetailView } from './components/views/NoteDetailView';
import { PracticeView } from './components/views/PracticeView';
import { AddBookModal } from './components/modals/AddBookModal';
import { EditBookModal } from './components/modals/EditBookModal';
import { QuickCaptureModal } from './components/modals/QuickCaptureModal';
import { DeepenNoteModal } from './components/modals/DeepenNoteModal';
import { EditNoteModal } from './components/modals/EditNoteModal';

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
  const { books, notes, isLoading, isSyncing, isOfflineReadOnly, syncNow } = usePragya();

  const [route, setRoute] = useState<PragyaRoute>(() => parseHash());
  const [showCaptureModal, setShowCaptureModal] = useState(false);
  const [captureBookId, setCaptureBookId] = useState<string | null>(null);
  const [showAddBookModal, setShowAddBookModal] = useState(false);
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [deepeningNote, setDeepeningNote] = useState<Note | null>(null);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

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

  const hasOpenOverlay = Boolean(
    showCommandPalette ||
      showCaptureModal ||
      showAddBookModal ||
      editingBook ||
      deepeningNote ||
      editingNote
  );

  useKeyboardShortcuts({
    isAuthenticated,
    route,
    hasOpenOverlay,
    isSessionExpiredOpen: showSessionExpiredModal,
    onToggleCommandPalette: () => setShowCommandPalette(prev => !prev),
    onOpenCapture: bookId => {
      setCaptureBookId(bookId);
      setShowCaptureModal(true);
    },
    onSyncNow: () => void syncNow(true),
  });

  const openQuickCapture = (bookId: string | null = null) => {
    setCaptureBookId(bookId);
    setShowCaptureModal(true);
  };

  const handleNoteSaved = (saved: Note) => {
    if (route.view === 'note' && route.noteSlug !== saved.slug) {
      navigateTo(`#/note/${encodeURIComponent(saved.slug)}`);
    }
  };

  let mainContent: React.ReactNode;
  if (isLoading && books.length === 0) {
    mainContent = (
      <div className="h-[60vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  } else if (route.view === 'notes') {
    mainContent = (
      <NotesView
        onOpenCapture={() => openQuickCapture(null)}
        onEditNote={n => setEditingNote(n)}
        onDeepenNote={n => setDeepeningNote(n)}
      />
    );
  } else if (route.view === 'settings') {
    mainContent = <SettingsView />;
  } else if (route.view === 'book' && route.bookId) {
    mainContent = (
      <BookDetailView
        bookId={route.bookId}
        onEditBook={b => setEditingBook(b)}
        onOpenCaptureForBook={id => openQuickCapture(id)}
      />
    );
  } else if (route.view === 'note' && route.noteSlug) {
    mainContent = (
      <NoteDetailView
        noteSlug={route.noteSlug}
        onOpenEdit={n => setEditingNote(n)}
        onOpenDeepen={n => setDeepeningNote(n)}
        onOpenCapture={() => openQuickCapture(null)}
      />
    );
  } else if (route.view === 'practice') {
    mainContent = <PracticeView />;
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
              isOfflineReadOnly={isOfflineReadOnly}
              theme={theme}
              toggleTheme={toggleTheme}
              onOpenCapture={() => openQuickCapture(null)}
              onOpenCommandPalette={() => setShowCommandPalette(true)}
              logout={logout}
            />

            <main className="flex-1 overflow-y-auto print:overflow-visible px-4 md:px-8 print:px-0 pt-0 pb-24 md:pb-8 print:pb-0 w-full relative custom-scrollbar">
              <div className="max-w-5xl mx-auto w-full">
                {!isMockMode && isOfflineReadOnly && (
                  <div
                    data-testid="offline-readonly-badge"
                    role="status"
                    className="mt-4 rounded-[12px] bg-warning/10 border border-warning/30 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-label"
                  >
                    <div className="flex items-center gap-2 min-w-0 text-foreground">
                      <WifiOff className="w-4 h-4 text-warning shrink-0" />
                      <span>
                        <strong className="font-semibold">Offline · Cached Read-Only</strong>
                        <span className="text-muted-foreground">
                          {' '}
                          — Viewing cached reading data. Reconnect to save changes.
                        </span>
                      </span>
                    </div>
                    <button
                      type="button"
                      data-testid="offline-retry-sync-btn"
                      disabled={isSyncing}
                      onClick={() => void syncNow(true)}
                      className="h-8 px-3 rounded-[8px] bg-card border border-border hover:bg-surface2 text-label font-semibold text-foreground inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                      <span>Retry Sync</span>
                    </button>
                  </div>
                )}
                {mainContent}
              </div>
            </main>
          </div>

          <BottomNav
            currentView={route.view}
            isOfflineReadOnly={!isMockMode && isOfflineReadOnly}
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

          <DeepenNoteModal
            note={deepeningNote}
            isOpen={Boolean(deepeningNote)}
            onClose={() => setDeepeningNote(null)}
            onSaved={handleNoteSaved}
          />

          <EditNoteModal
            note={editingNote}
            isOpen={Boolean(editingNote)}
            onClose={() => setEditingNote(null)}
            onSaved={handleNoteSaved}
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
