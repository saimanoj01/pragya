import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  Attachment,
  Book,
  DeltaLog,
  DeltaOutcome,
  Note,
  PragyaSnapshot,
  ReadingSession,
} from '../types/pragya';
import { DemoStorageAdapter } from '../services/demoAdapter';
import { GoogleSheetsAdapter } from '../services/googleSheetsAdapter';
import {
  PartialBatchCommitError,
  type BatchMutationResult,
  type StorageAdapter,
} from '../services/storage';
import { compressImageToWebp } from '../utils/imageCompress';
import { createUuid, getLocalDateString } from '../utils/sessionCoalesce';
import { RATE_LIMIT_TOAST, describeSyncError } from '../utils/apiErrors';
import { showToast } from '../utils/toast';
import { buildSnapshot } from '../utils/snapshot';
import { savePreImportBackupAsync } from '../utils/importSafety';
import { DEMO_DRAFT_SCOPE, clearAllDrafts } from '../utils/draftStorage';
import { SESSION_NOTE_MAX } from '../utils/bookSurfaces';
import { applyDeltaLogPatch, planDeltaCheckIn, type DeltaCheckInPlan } from '../utils/deltaCheckIn';
import {
  clearLastDeleteBackup,
  planBookDelete,
  planNoteDelete,
  readLastDeleteBackup,
  toDeleteRowsPlan,
  withoutDeleted,
  withoutIds,
  DeleteOutcomeUnknownError,
  type DeleteCascadeResult,
  type PermanentDeleteResult,
  writeLastDeleteBackup,
  expireStaleDeleteBackup,
  type DeleteBackup,
  type RestoreRowsResult,
  type WorkspaceRows,
} from '../utils/deletePlan';
import {
  OfflineReadOnlyError,
  STILL_OFFLINE_TOAST,
  isNetworkError,
  shouldBlockCloudWrite,
} from '../utils/offline';
import {
  clearCollisionSkipState,
  planNoteBridgeOps,
  type NoteBridgeOptions,
} from '../utils/crossBookSynthesis';
import {
  NOTE_BRIDGES_OWNED_META_KEYS,
  mergeUnknownMetaKeys,
} from '../utils/metaCodecs';
import type { BatchMutationOp } from '../utils/batchPlan';
import { useAuth } from './AuthContext';
import {
  planBookmarkAdvance,
  planCaptureWithAdvance,
  planMarkBookFinished,
  planNewBook,
  planRestoredBook,
  planStartReadingBook,
  planStartReread,
  planUpdatedBook,
  planUpdatedNote,
  upsertList,
  type AddBookInput,
  type BookWriteOptions,
  type BookmarkAdvanceResult,
  type BookmarkAdvanceUndo,
  type BookmarkSessionUndoAction,
  type QuickCaptureInput,
  type ReplaceWorkspaceOptions,
  type UpdateNoteOptions,
} from './pragyaMutations';

export type {
  AddBookInput,
  BookWriteOptions,
  BookmarkAdvanceResult,
  BookmarkAdvanceUndo,
  BookmarkSessionUndoAction,
  QuickCaptureInput,
  ReplaceWorkspaceOptions,
  UpdateNoteOptions,
};

/** R2 N1 (dev only): an editor changed a meta key it doesn't own; the latest value wins. */
function warnOverriddenMetaKeys(entity: string, keys: readonly string[]): void {
  if (!import.meta.env.DEV || keys.length === 0) return;
  console.warn(
    `[pragya] ${entity} edit changed non-owned meta key(s) ${keys.join(', ')}; the latest loaded value was kept. Pass ownedMetaKeys at this call site if the change is intended.`
  );
}

export interface PragyaDataContextValue {
  books: Book[];
  notes: Note[];
  sessions: ReadingSession[];
  deltaLogs: DeltaLog[];
  /** Derived memoized lookup maps for O(1) reads across views & cards. */
  booksById: ReadonlyMap<string, Book>;
  notesById: ReadonlyMap<string, Note>;
  isLoading: boolean;
  isSyncing: boolean;
  lastSyncedAt: string | null;
  spreadsheetId: string | null;
  mediaFolderId: string | null;
  /** Cloud Mode only: true while serving cached data because the network is unavailable. */
  isOfflineReadOnly: boolean;
}

export interface NoteBridgeUndo {
  prevNotes: Note[];
  appliedUpdatedAtById: Record<string, string>;
}

export interface NoteBridgeActionResult {
  changed: boolean;
  notes: Note[];
  undo?: NoteBridgeUndo;
}

export interface PragyaActionsContextValue {
  syncNow: (force?: boolean) => Promise<void>;
  addBook: (input: AddBookInput) => Promise<Book>;
  updateBook: (book: Book, options?: BookWriteOptions) => Promise<Book>;
  advanceBookPosition: (
    bookId: string,
    incomingPos: number,
    options?: { manualOverride?: boolean; sessionNote?: string }
  ) => Promise<BookmarkAdvanceResult>;
  revertBookmarkAdvance: (undo: BookmarkAdvanceUndo) => Promise<void>;
  restoreBook: (prevBook: Book, options?: BookWriteOptions) => Promise<Book>;
  startReadingBook: (bookId: string) => Promise<Book | null>;
  markBookFinished: (bookId: string) => Promise<Book | null>;
  captureNote: (input: QuickCaptureInput) => Promise<Note>;
  updateNote: (note: Note, options?: UpdateNoteOptions) => Promise<Note>;
  /** v2: atomic link/unlink of two notes via meta.relatedSlugs + meta.bridgeNotes. */
  saveNoteBridge: (
    noteAId: string,
    noteBId: string,
    options: Omit<NoteBridgeOptions, 'allowShielded' | 'nowIso'>
  ) => Promise<NoteBridgeActionResult>;
  /** v2: single compensating Undo restoring both notes' bridge fields atomically. */
  restoreNoteBridge: (undo: NoteBridgeUndo) => Promise<void>;
  /** @deprecated CD C2.1: always appends (no same-day coalescing) — use `checkInDelta`. */
  logDeltaOutcome: (
    noteId: string,
    outcome: DeltaOutcome,
    reflection?: string
  ) => Promise<DeltaLog>;
  /**
   * CD C2.1 (decisions OQ-5): same-day coalescing check-in. First of the local day →
   * append; later → update today's row's outcome (reflection kept); same outcome → no write.
   */
  checkInDelta: (noteId: string, outcome: DeltaOutcome) => Promise<DeltaCheckInPlan>;
  /**
   * CD C2.1 fix-up (R1#2): field-level change of one DeltaLogs row against a FRESH read
   * (reflection edits; check-in Undo restores only the outcome). Never reverts the other field.
   */
  updateDeltaLogFields: (
    logId: string,
    patch: { outcome?: DeltaOutcome; reflection?: string }
  ) => Promise<DeltaLog>;
  /** CD C2.1: remove one DeltaLogs row (check-in Undo of a first-of-day append). */
  deleteDeltaLog: (logId: string) => Promise<void>;
  replaceWorkspaceFromSnapshot: (
    snapshot: PragyaSnapshot,
    options?: ReplaceWorkspaceOptions
  ) => Promise<void>;
  resetDemoWorkspace: () => Promise<void>;
  uploadImageAttachment: (file: File | Blob) => Promise<Attachment>;
  resolveDocTitle: (docId: string) => Promise<string | null>;
  /**
   * CD C2.3 (decisions OQ-1 override): set/clear one session's note (Sessions!G, ≤ 280 chars).
   * `updatedAt` is kept — a note isn't reading progress (keeps the 30-min coalescing window honest).
   */
  updateSessionNote: (sessionId: string, note: string) => Promise<ReadingSession>;
  /**
   * CD C2.6 Read Again: finished → reading at position 0, `meta.everFinished = true`, new
   * `startedAt`; `finishedAt` and the capstone are kept (owned keys only).
   */
  startReread: (bookId: string) => Promise<Book>;
  /** CD C1.2: permanently delete an ARCHIVED note (+ its delta logs). Resolves to the Undo backup. */
  deleteNotePermanently: (noteId: string) => Promise<PermanentDeleteResult>;
  /** CD C1.2: permanently delete an ARCHIVED book with its notes, their logs and its sessions. */
  deleteBookPermanently: (bookId: string) => Promise<PermanentDeleteResult>;
  /** CD C1.2 Undo: re-append the exact removed rows (same UUIDs), parents first. */
  restoreDeletedRows: (backup: DeleteBackup) => Promise<RestoreRowsResult>;
}

export type PragyaContextValue = PragyaDataContextValue & PragyaActionsContextValue;

const PragyaDataContext = createContext<PragyaDataContextValue | undefined>(undefined);
const PragyaActionsContext = createContext<PragyaActionsContextValue | undefined>(undefined);

export const PragyaProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    isAuthenticated,
    isMockMode,
    user,
    getGoogleToken,
    refreshGoogleTokenSilent,
    triggerSessionExpired,
  } = useAuth();

  const userEmail = user?.email;
  const isAuthenticatedRef = useRef<boolean>(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;
  const isMockModeRef = useRef<boolean>(isMockMode);
  isMockModeRef.current = isMockMode;
  const userEmailRef = useRef<string | undefined>(userEmail);
  userEmailRef.current = userEmail;
  const activeAdapterRef = useRef<StorageAdapter | null>(null);

  const adapter: StorageAdapter = useMemo(() => {
    if (isMockMode) {
      return new DemoStorageAdapter();
    }
    const ownerEmail = userEmail;
    function isAdapterStillActive(): boolean {
      return (
        activeAdapterRef.current === instance &&
        isAuthenticatedRef.current &&
        !isMockModeRef.current &&
        userEmailRef.current === ownerEmail
      );
    }
    const instance = new GoogleSheetsAdapter(
      () => (isAdapterStillActive() ? getGoogleToken() : null),
      () => {
        if (!isAdapterStillActive()) return;
        triggerSessionExpired();
      },
      ownerEmail,
      {
        refreshToken: async () => {
          if (!isAdapterStillActive()) return null;
          const refreshed = await refreshGoogleTokenSilent({
            force: true,
            expectedEmailOverride: ownerEmail,
          });
          if (!isAdapterStillActive()) return null;
          return refreshed;
        },
      }
    );
    return instance;
  }, [isMockMode, userEmail, getGoogleToken, triggerSessionExpired, refreshGoogleTokenSilent]);

  const [books, setBooks] = useState<Book[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [sessions, setSessions] = useState<ReadingSession[]>([]);
  const [deltaLogs, setDeltaLogs] = useState<DeltaLog[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [spreadsheetId, setSpreadsheetId] = useState<string | null>(null);
  const [mediaFolderId, setMediaFolderId] = useState<string | null>(null);
  const [isOfflineReadOnly, setIsOfflineReadOnly] = useState<boolean>(false);

  const adapterRef = useRef<StorageAdapter>(adapter);
  adapterRef.current = adapter;
  activeAdapterRef.current = adapter;
  const booksRef = useRef<Book[]>(books);
  const notesRef = useRef<Note[]>(notes);
  const sessionsRef = useRef<ReadingSession[]>(sessions);
  const deltaLogsRef = useRef<DeltaLog[]>(deltaLogs);
  const isOfflineReadOnlyRef = useRef<boolean>(false);

  // R1#1: monotonic session epoch incremented synchronously whenever auth/mode/account/adapter
  // changes so in-flight syncs or queued mutations from a prior session can never execute against
  // a new session's adapter or write stale rows into the new session's React state.
  const sessionEpochRef = useRef<number>(0);
  const lastSessionKeyRef = useRef<{
    adapter: StorageAdapter;
    isAuthenticated: boolean;
    isMockMode: boolean;
    userEmail: string | undefined;
  }>({
    adapter,
    isAuthenticated,
    isMockMode,
    userEmail,
  });
  if (
    lastSessionKeyRef.current.adapter !== adapter ||
    lastSessionKeyRef.current.isAuthenticated !== isAuthenticated ||
    lastSessionKeyRef.current.isMockMode !== isMockMode ||
    lastSessionKeyRef.current.userEmail !== userEmail
  ) {
    sessionEpochRef.current += 1;
    lastSessionKeyRef.current = { adapter, isAuthenticated, isMockMode, userEmail };
  }

  const mutationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastRateLimitToastRef = useRef<number>(0);

  interface MutationSessionContext {
    adapter: StorageAdapter;
    isCurrentSession: () => boolean;
  }

  const enqueueMutation = useCallback(
    <T,>(
      task: (ctx: MutationSessionContext) => Promise<T>,
      options: { allowStaleSkip?: boolean } = {}
    ): Promise<T> => {
      const originEpoch = sessionEpochRef.current;
      const originAdapter = adapterRef.current;
      const isCurrentSession = () =>
        sessionEpochRef.current === originEpoch &&
        adapterRef.current === originAdapter &&
        isAuthenticatedRef.current;
      const next = mutationQueueRef.current.catch(() => {}).then(async () => {
        if (!isCurrentSession()) {
          if (options.allowStaleSkip) return undefined as T;
          throw new Error('Session changed before this action could complete. Please try again.');
        }
        return task({ adapter: originAdapter, isCurrentSession });
      });
      mutationQueueRef.current = next;
      return next;
    },
    []
  );

  const setOfflineReadOnly = useCallback((value: boolean) => {
    isOfflineReadOnlyRef.current = value;
    setIsOfflineReadOnly(value);
  }, []);

  /** M4.5: Cloud writes are blocked while offline; Demo Mode stays 100% writable. */
  const assertCloudWritable = useCallback(() => {
    if (shouldBlockCloudWrite(isMockModeRef.current, isOfflineReadOnlyRef.current)) {
      throw new OfflineReadOnlyError();
    }
  }, []);

  const applyRows = useCallback((rows: WorkspaceRows) => {
    booksRef.current = rows.books;
    notesRef.current = rows.notes;
    sessionsRef.current = rows.sessions;
    deltaLogsRef.current = rows.deltaLogs;
    setBooks(rows.books);
    setNotes(rows.notes);
    setSessions(rows.sessions);
    setDeltaLogs(rows.deltaLogs);
  }, []);

  const currentRows = useCallback(
    (): WorkspaceRows => ({
      books: booksRef.current,
      notes: notesRef.current,
      sessions: sessionsRef.current,
      deltaLogs: deltaLogsRef.current,
    }),
    []
  );

  /** R1#2: merge committed rows from a batch (or partial batch failure) into React state. */
  const reconcileCommitted = useCallback(
    (committed: BatchMutationResult, isCurrentSession: () => boolean) => {
      if (!isCurrentSession()) return;
      if (committed.books.length > 0) {
        const nextBooks = committed.books.reduce((acc, b) => upsertList(acc, b), booksRef.current);
        booksRef.current = nextBooks;
        setBooks(nextBooks);
      }
      if (committed.notes.length > 0) {
        const existingIds = new Set(notesRef.current.map(n => n.id));
        const nextNotes = committed.notes.reduce(
          (acc, n) => (existingIds.has(n.id) ? upsertList(acc, n) : [n, ...acc]),
          notesRef.current
        );
        notesRef.current = nextNotes;
        setNotes(nextNotes);
      }
      if (committed.sessions.length > 0) {
        const nextSessions = committed.sessions.reduce(
          (acc, s) => upsertList(acc, s),
          sessionsRef.current
        );
        sessionsRef.current = nextSessions;
        setSessions(nextSessions);
      }
      if (committed.deltaLogs.length > 0) {
        const nextLogs = committed.deltaLogs.reduce(
          (acc, l) => upsertList(acc, l),
          deltaLogsRef.current
        );
        deltaLogsRef.current = nextLogs;
        setDeltaLogs(nextLogs);
      }
    },
    []
  );

  const syncNow = useCallback(
    async (force = false) => {
      if (!isAuthenticatedRef.current) return;
      const callEpoch = sessionEpochRef.current;
      setIsSyncing(true);
      let servedOffline = false;
      let servedRateLimitedCache = false;
      try {
        await enqueueMutation(
          async ({ adapter: activeAdapter, isCurrentSession }) => {
            if (!isCurrentSession()) return;
            const ws = await activeAdapter.loadWorkspace({ forceRefresh: force });
            if (!isCurrentSession()) return;
            booksRef.current = ws.books;
            notesRef.current = ws.notes;
            sessionsRef.current = ws.sessions;
            deltaLogsRef.current = ws.deltaLogs;
            setBooks(ws.books);
            setNotes(ws.notes);
            setSessions(ws.sessions);
            setDeltaLogs(ws.deltaLogs);
            setSpreadsheetId(ws.spreadsheetId || null);
            setMediaFolderId(ws.mediaFolderId || null);
            servedOffline = Boolean(ws.isOfflineReadOnly) && !isMockModeRef.current;
            if (ws.servedFromCacheDueToRateLimit) servedRateLimitedCache = true;
            setOfflineReadOnly(servedOffline);
            // N2: cached data served because Google throttled us is not a fresh sync.
            if (!servedOffline && !ws.servedFromCacheDueToRateLimit) {
              setLastSyncedAt(new Date().toISOString());
              // CD C1.2: the local copy of the last permanently deleted rows lives only until
              // the next successful sync after the delete was CONFIRMED (support-only net).
              if (readLastDeleteBackup()?.confirmed) clearLastDeleteBackup();
            }
          },
          { allowStaleSkip: true }
        );
        if (sessionEpochRef.current !== callEpoch || !isAuthenticatedRef.current) return;
        if (servedRateLimitedCache) {
          // R2#3: tell the user (at most once a minute) that cached data is shown
          // because Google is throttling (ux_spec D.2 copy).
          const nowMs = Date.now();
          if (nowMs - lastRateLimitToastRef.current > 60_000) {
            lastRateLimitToastRef.current = nowMs;
            showToast(RATE_LIMIT_TOAST, 'error');
          }
        } else if (force && isAuthenticatedRef.current) {
          if (servedOffline) {
            showToast(STILL_OFFLINE_TOAST, 'info');
          } else {
            showToast('Workspace synced', 'success');
          }
        }
      } catch (err) {
        if (sessionEpochRef.current !== callEpoch || !isAuthenticatedRef.current) return;
        const msg = err instanceof Error ? err.message : 'Failed to sync workspace';
        if (
          isNetworkError(err) &&
          !isMockModeRef.current &&
          (booksRef.current.length > 0 || notesRef.current.length > 0)
        ) {
          // Keep already-loaded state visible, read-only.
          setOfflineReadOnly(true);
          if (force) showToast(STILL_OFFLINE_TOAST, 'info');
        } else if (!msg.includes('401')) {
          // B4.7: a throttled Google API keeps the loaded data and says so calmly.
          showToast(describeSyncError(err), 'error');
        }
      } finally {
        if (sessionEpochRef.current === callEpoch) {
          setIsSyncing(false);
          setIsLoading(false);
        }
      }
    },
    [enqueueMutation, setOfflineReadOnly]
  );

  useEffect(() => {
    if (!isAuthenticated) {
      booksRef.current = [];
      notesRef.current = [];
      sessionsRef.current = [];
      deltaLogsRef.current = [];
      setBooks([]);
      setNotes([]);
      setSessions([]);
      setDeltaLogs([]);
      setSpreadsheetId(null);
      setMediaFolderId(null);
      setLastSyncedAt(null);
      setOfflineReadOnly(false);
      setIsSyncing(false);
      setIsLoading(false);
      return;
    }
    if (isMockMode) {
      setOfflineReadOnly(false);
    }
    setIsLoading(true);
    void syncNow(false);
  }, [adapter, isAuthenticated, isMockMode, syncNow, setOfflineReadOnly]);

  // M4.5: foreground sync — refresh on reconnect / tab visible (Cloud Mode only).
  useEffect(() => {
    if (!isAuthenticated || isMockMode) return;
    const maybeSync = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      void syncNow(false);
    };
    const handleVisibility = () => {
      if (!document.hidden) maybeSync();
    };
    // B4.8: go read-only the moment the browser reports offline (no failed request
    // needed). Only when data is loaded; Demo Mode never reaches here.
    const handleOffline = () => {
      if (booksRef.current.length > 0 || notesRef.current.length > 0) {
        setOfflineReadOnly(true);
      }
    };
    window.addEventListener('online', maybeSync);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('online', maybeSync);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isAuthenticated, isMockMode, syncNow, setOfflineReadOnly]);

  // R1 nit 6: a support-only delete backup never lingers past its TTL.
  useEffect(() => {
    expireStaleDeleteBackup();
  }, []);

  const addBook = useCallback(
    (input: AddBookInput): Promise<Book> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        const newBook = planNewBook(input);
        const saved = await activeAdapter.saveBook(newBook);
        if (!isCurrentSession()) return saved;
        const nextBooks = upsertList(booksRef.current, saved);
        booksRef.current = nextBooks;
        setBooks(nextBooks);
        return saved;
      }),
    [assertCloudWritable, enqueueMutation]
  );

  const updateBook = useCallback(
    (book: Book, options: BookWriteOptions = {}): Promise<Book> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        const loaded = booksRef.current.find(b => b.id === book.id);
        const plan = planUpdatedBook(book, loaded, options);
        warnOverriddenMetaKeys('Book', plan.overriddenMetaKeys);
        const saved = await activeAdapter.saveBook(plan.nextBook, {
          expectedBaseUpdatedAt: plan.expectedBaseUpdatedAt,
        });
        if (!isCurrentSession()) return saved;
        const nextBooks = upsertList(booksRef.current, saved);
        booksRef.current = nextBooks;
        setBooks(nextBooks);
        return saved;
      }),
    [assertCloudWritable, enqueueMutation]
  );

  const advanceBookPositionInternal = useCallback(
    async (
      bookId: string,
      incomingPos: number,
      options: { manualOverride?: boolean; sessionNote?: string } = {},
      ctx: MutationSessionContext
    ): Promise<BookmarkAdvanceResult> => {
      const { adapter: activeAdapter, isCurrentSession } = ctx;
      const existing = booksRef.current.find(b => b.id === bookId);
      if (!existing) {
        throw new Error('Book not found');
      }
      assertCloudWritable();
      const plan = planBookmarkAdvance(existing, sessionsRef.current, incomingPos, options);
      if (!plan.changed) {
        return { book: existing, changed: false, rejectedBackward: plan.rejectedBackward };
      }

      let savedBook: Book;
      let savedSession: ReadingSession;
      if (activeAdapter.batchCommitMutations) {
        let res: BatchMutationResult;
        try {
          res = await activeAdapter.batchCommitMutations(plan.ops);
        } catch (err) {
          if (err instanceof PartialBatchCommitError) {
            reconcileCommitted(err.committed, isCurrentSession);
          }
          throw err;
        }
        savedBook = res.books[0] ?? plan.updatedBook;
        savedSession = res.sessions[0] ?? plan.sessionToSave;
      } else {
        savedBook = await activeAdapter.saveBook(plan.updatedBook, {
          expectedBaseUpdatedAt: plan.expectedBaseUpdatedAt,
        });
        if (!isCurrentSession()) {
          return { book: savedBook, changed: true, rejectedBackward: false };
        }
        reconcileCommitted(
          { books: [savedBook], notes: [], sessions: [], deltaLogs: [] },
          isCurrentSession
        );
        try {
          savedSession = await activeAdapter.saveSession(plan.sessionToSave);
        } catch (err) {
          throw new PartialBatchCommitError(
            { books: [savedBook], notes: [], sessions: [], deltaLogs: [] },
            err
          );
        }
      }

      reconcileCommitted(
        { books: [savedBook], notes: [], sessions: [savedSession], deltaLogs: [] },
        isCurrentSession
      );

      return {
        book: savedBook,
        changed: true,
        rejectedBackward: false,
        sessionId: savedSession.id,
        undo: {
          prevBook: existing,
          sessionAction: plan.sessionAction,
          appliedUpdatedAt: savedBook.meta?.updatedAt,
        },
      };
    },
    [assertCloudWritable, reconcileCommitted]
  );

  const advanceBookPosition = useCallback(
    (
      bookId: string,
      incomingPos: number,
      options: { manualOverride?: boolean; sessionNote?: string } = {}
    ): Promise<BookmarkAdvanceResult> =>
      enqueueMutation(ctx => advanceBookPositionInternal(bookId, incomingPos, options, ctx)),
    [advanceBookPositionInternal, enqueueMutation]
  );

  const revertBookmarkAdvance = useCallback(
    (undo: BookmarkAdvanceUndo): Promise<void> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        const loaded = booksRef.current.find(b => b.id === undo.prevBook.id);
        // B4.1: the base is what the advance wrote; any remote change since → conflict.
        const bookPlan = planRestoredBook(undo.prevBook, loaded, {
          expectedBaseUpdatedAt: undo.appliedUpdatedAt,
        });

        if (undo.sessionAction.mode === 'updated' && activeAdapter.batchCommitMutations) {
          let res: BatchMutationResult;
          try {
            res = await activeAdapter.batchCommitMutations([
              {
                kind: 'book',
                book: bookPlan.nextBook,
                expectedBaseUpdatedAt: bookPlan.expectedBaseUpdatedAt,
                mode: 'update',
              },
              { kind: 'session', session: undo.sessionAction.prevSession, mode: 'update' },
            ]);
          } catch (err) {
            if (err instanceof PartialBatchCommitError) {
              reconcileCommitted(err.committed, isCurrentSession);
            }
            throw err;
          }
          const savedBook = res.books[0] ?? bookPlan.nextBook;
          const savedSession = res.sessions[0] ?? undo.sessionAction.prevSession;
          reconcileCommitted(
            { books: [savedBook], notes: [], sessions: [savedSession], deltaLogs: [] },
            isCurrentSession
          );
          return;
        }

        const savedBook = await activeAdapter.saveBook(bookPlan.nextBook, {
          expectedBaseUpdatedAt: bookPlan.expectedBaseUpdatedAt,
        });
        if (!isCurrentSession()) return;
        const nextBooks = upsertList(booksRef.current, savedBook);
        booksRef.current = nextBooks;
        setBooks(nextBooks);

        if (undo.sessionAction.mode === 'created') {
          const { sessionId } = undo.sessionAction;
          if (activeAdapter.deleteSession) {
            await activeAdapter.deleteSession(sessionId);
          }
          if (!isCurrentSession()) return;
          const nextSessions = sessionsRef.current.filter(s => s.id !== sessionId);
          sessionsRef.current = nextSessions;
          setSessions(nextSessions);
        } else {
          const savedSession = await activeAdapter.saveSession(undo.sessionAction.prevSession);
          if (!isCurrentSession()) return;
          const nextSessions = upsertList(sessionsRef.current, savedSession);
          sessionsRef.current = nextSessions;
          setSessions(nextSessions);
        }
      }),
    [assertCloudWritable, enqueueMutation, reconcileCommitted]
  );

  const restoreBook = useCallback(
    (prevBook: Book, options: BookWriteOptions = {}): Promise<Book> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        const loaded = booksRef.current.find(b => b.id === prevBook.id);
        const plan = planRestoredBook(prevBook, loaded, options);
        const saved = await activeAdapter.saveBook(plan.nextBook, {
          expectedBaseUpdatedAt: plan.expectedBaseUpdatedAt,
        });
        if (!isCurrentSession()) return saved;
        const nextBooks = upsertList(booksRef.current, saved);
        booksRef.current = nextBooks;
        setBooks(nextBooks);
        return saved;
      }),
    [assertCloudWritable, enqueueMutation]
  );

  const startReadingBook = useCallback(
    (bookId: string): Promise<Book | null> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        const existing = booksRef.current.find(b => b.id === bookId);
        if (!existing) return null;
        assertCloudWritable();
        const plan = planStartReadingBook(existing);
        const saved = await activeAdapter.saveBook(plan.nextBook, {
          expectedBaseUpdatedAt: plan.expectedBaseUpdatedAt,
        });
        if (!isCurrentSession()) return saved;
        const nextBooks = upsertList(booksRef.current, saved);
        booksRef.current = nextBooks;
        setBooks(nextBooks);
        return saved;
      }),
    [assertCloudWritable, enqueueMutation]
  );

  const markBookFinished = useCallback(
    (bookId: string): Promise<Book | null> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        const existing = booksRef.current.find(b => b.id === bookId);
        if (!existing) return null;
        assertCloudWritable();
        const plan = planMarkBookFinished(existing);
        const saved = await activeAdapter.saveBook(plan.nextBook, {
          expectedBaseUpdatedAt: plan.expectedBaseUpdatedAt,
        });
        if (!isCurrentSession()) return saved;
        const nextBooks = upsertList(booksRef.current, saved);
        booksRef.current = nextBooks;
        setBooks(nextBooks);
        return saved;
      }),
    [assertCloudWritable, enqueueMutation]
  );

  const captureNote = useCallback(
    (input: QuickCaptureInput): Promise<Note> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        const book = booksRef.current.find(b => b.id === input.bookId);
        if (!book) {
          throw new Error('Select a valid book before capturing a note.');
        }
        assertCloudWritable();
        const plan = planCaptureWithAdvance(
          input,
          book,
          notesRef.current,
          sessionsRef.current
        );

        // CD Batch 7 (OQ-12): when capture also advances the book, commit Books + Notes +
        // Sessions in ONE coalesced batch (conflict-checked BEFORE any write; <= 5 HTTP calls).
        if (plan.advance && activeAdapter.batchCommitMutations) {
          let res: BatchMutationResult;
          try {
            res = await activeAdapter.batchCommitMutations(plan.ops);
          } catch (err) {
            if (err instanceof PartialBatchCommitError) {
              // R1#2: reconcile any committed rows into React state BEFORE rethrowing so the
              // caller sees committed Book/Note updates and retries never hit stale guards or
              // duplicate an already-appended Note.
              reconcileCommitted(err.committed, isCurrentSession);
            }
            throw err;
          }
          const savedNote = res.notes[0] ?? plan.newNote;
          const savedBook = res.books[0] ?? plan.advance.updatedBook;
          const savedSession = res.sessions[0] ?? plan.advance.sessionToSave;
          reconcileCommitted(
            { books: [savedBook], notes: [savedNote], sessions: [savedSession], deltaLogs: [] },
            isCurrentSession
          );
          return savedNote;
        }

        const savedNote = await activeAdapter.saveNote(plan.newNote);
        if (!isCurrentSession()) return savedNote;
        const nextNotes = [savedNote, ...notesRef.current];
        notesRef.current = nextNotes;
        setNotes(nextNotes);

        if (plan.advance) {
          try {
            await advanceBookPositionInternal(
              book.id,
              plan.newNote.pos,
              {},
              { adapter: activeAdapter, isCurrentSession }
            );
          } catch (err) {
            const extra = err instanceof PartialBatchCommitError ? err.committed : null;
            throw new PartialBatchCommitError(
              {
                books: extra?.books ?? [],
                notes: [savedNote, ...(extra?.notes ?? [])],
                sessions: extra?.sessions ?? [],
                deltaLogs: extra?.deltaLogs ?? [],
              },
              err instanceof PartialBatchCommitError ? err.cause : err
            );
          }
        }

        return savedNote;
      }),
    [advanceBookPositionInternal, assertCloudWritable, enqueueMutation, reconcileCommitted]
  );

  const updateNote = useCallback(
    (note: Note, options: UpdateNoteOptions = {}): Promise<Note> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        const existingNote = notesRef.current.find(n => n.id === note.id);
        const book = booksRef.current.find(b => b.id === note.bookId);
        const plan = planUpdatedNote(note, existingNote, book, notesRef.current, options);
        warnOverriddenMetaKeys('Note', plan.overriddenMetaKeys);
        const saved = await activeAdapter.saveNote(plan.nextNote, {
          expectedBaseUpdatedAt: plan.expectedBaseUpdatedAt,
        });
        if (!isCurrentSession()) return saved;
        const nextNotes = upsertList(notesRef.current, saved);
        notesRef.current = nextNotes;
        setNotes(nextNotes);
        return saved;
      }),
    [assertCloudWritable, enqueueMutation]
  );

  const saveNoteBridge = useCallback(
    (
      noteAId: string,
      noteBId: string,
      options: Omit<NoteBridgeOptions, 'allowShielded' | 'nowIso'>
    ): Promise<NoteBridgeActionResult> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        const noteA = notesRef.current.find(n => n.id === noteAId);
        const noteB = notesRef.current.find(n => n.id === noteBId);
        if (!noteA || !noteB) throw new Error('Note not found.');
        const plan = planNoteBridgeOps(noteA, noteB, notesRef.current, booksRef.current, {
          ...options,
          allowShielded: false,
        });
        if (!plan.changed) {
          return { changed: false, notes: [] };
        }
        let savedNotes: Note[];
        if (activeAdapter.batchCommitMutations) {
          const ops: BatchMutationOp[] = plan.nextNotes.map(n => ({
            kind: 'note',
            note: n,
            expectedBaseUpdatedAt: plan.expectedBaseById[n.id],
            mode: 'update',
          }));
          let res: BatchMutationResult;
          try {
            res = await activeAdapter.batchCommitMutations(ops);
          } catch (err) {
            if (err instanceof PartialBatchCommitError) {
              reconcileCommitted(err.committed, isCurrentSession);
            }
            throw err;
          }
          savedNotes = res.notes.length > 0 ? res.notes : plan.nextNotes;
          reconcileCommitted(
            { books: [], notes: savedNotes, sessions: [], deltaLogs: [] },
            isCurrentSession
          );
        } else {
          savedNotes = [];
          for (const nextNote of plan.nextNotes) {
            try {
              const saved = await activeAdapter.saveNote(nextNote, {
                expectedBaseUpdatedAt: plan.expectedBaseById[nextNote.id],
              });
              savedNotes.push(saved);
            } catch (err) {
              if (savedNotes.length > 0) {
                const committed = { books: [], notes: savedNotes, sessions: [], deltaLogs: [] };
                reconcileCommitted(committed, isCurrentSession);
                throw new PartialBatchCommitError(committed, err);
              }
              throw err;
            }
          }
          reconcileCommitted(
            { books: [], notes: savedNotes, sessions: [], deltaLogs: [] },
            isCurrentSession
          );
        }
        const appliedUpdatedAtById: Record<string, string> = {};
        for (const saved of savedNotes) appliedUpdatedAtById[saved.id] = saved.updatedAt;
        return {
          changed: true,
          notes: savedNotes,
          undo: {
            prevNotes: plan.prevNotes,
            appliedUpdatedAtById,
          },
        };
      }),
    [assertCloudWritable, enqueueMutation, reconcileCommitted]
  );

  const restoreNoteBridge = useCallback(
    (undo: NoteBridgeUndo): Promise<void> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        if (!undo.prevNotes.length) return;
        const nowIso = new Date().toISOString();
        const restoredList: Array<{ note: Note; expectedBaseUpdatedAt?: string }> = [];
        for (const prev of undo.prevNotes) {
          const loaded = notesRef.current.find(n => n.id === prev.id) ?? prev;
          const mergedMeta = mergeUnknownMetaKeys(
            prev.meta,
            loaded.meta,
            NOTE_BRIDGES_OWNED_META_KEYS
          );
          restoredList.push({
            note: {
              ...loaded,
              meta: mergedMeta,
              updatedAt: nowIso,
            },
            expectedBaseUpdatedAt: undo.appliedUpdatedAtById[prev.id] ?? loaded.updatedAt,
          });
        }

        if (activeAdapter.batchCommitMutations) {
          const ops: BatchMutationOp[] = restoredList.map(item => ({
            kind: 'note',
            note: item.note,
            expectedBaseUpdatedAt: item.expectedBaseUpdatedAt,
            mode: 'update',
          }));
          let res: BatchMutationResult;
          try {
            res = await activeAdapter.batchCommitMutations(ops);
          } catch (err) {
            if (err instanceof PartialBatchCommitError) {
              reconcileCommitted(err.committed, isCurrentSession);
            }
            throw err;
          }
          reconcileCommitted(
            {
              books: [],
              notes: res.notes.length > 0 ? res.notes : restoredList.map(i => i.note),
              sessions: [],
              deltaLogs: [],
            },
            isCurrentSession
          );
        } else {
          const savedList: Note[] = [];
          for (const item of restoredList) {
            try {
              const saved = await activeAdapter.saveNote(item.note, {
                expectedBaseUpdatedAt: item.expectedBaseUpdatedAt,
              });
              savedList.push(saved);
            } catch (err) {
              if (savedList.length > 0) {
                const committed = { books: [], notes: savedList, sessions: [], deltaLogs: [] };
                reconcileCommitted(committed, isCurrentSession);
                throw new PartialBatchCommitError(committed, err);
              }
              throw err;
            }
          }
          reconcileCommitted(
            { books: [], notes: savedList, sessions: [], deltaLogs: [] },
            isCurrentSession
          );
        }
      }),
    [assertCloudWritable, enqueueMutation, reconcileCommitted]
  );

  const logDeltaOutcome = useCallback(
    (noteId: string, outcome: DeltaOutcome, reflection = ''): Promise<DeltaLog> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        const log: DeltaLog = {
          id: createUuid(),
          noteId,
          date: getLocalDateString(),
          outcome,
          reflection: reflection.trim(),
        };
        const saved = await activeAdapter.saveDeltaLog(log);
        if (!isCurrentSession()) return saved;
        const nextLogs = upsertList(deltaLogsRef.current, saved);
        deltaLogsRef.current = nextLogs;
        setDeltaLogs(nextLogs);
        return saved;
      }),
    [assertCloudWritable, enqueueMutation]
  );

  /** R1#1: fresh DeltaLogs (adapter read) adopted into local state before any plan/patch. */
  const readFreshDeltaLogs = useCallback(
    async (activeAdapter: StorageAdapter, isCurrentSession: () => boolean): Promise<DeltaLog[]> => {
      if (!activeAdapter.loadDeltaLogs) return deltaLogsRef.current;
      const fresh = await activeAdapter.loadDeltaLogs();
      if (!isCurrentSession()) {
        throw new Error('Session changed before this action could complete. Please try again.');
      }
      deltaLogsRef.current = fresh;
      setDeltaLogs(fresh);
      return fresh;
    },
    []
  );

  const checkInDelta = useCallback(
    (noteId: string, outcome: DeltaOutcome): Promise<DeltaCheckInPlan> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        // R1#1/#2: plan against a fresh read, so a same-day check-in from the CLI or another
        // device is updated (never duplicated) and its reflection is kept (outcome-only patch).
        const fresh = await readFreshDeltaLogs(activeAdapter, isCurrentSession);
        const plan = planDeltaCheckIn(fresh, noteId, getLocalDateString(), outcome, createUuid());
        if (plan.kind === 'unchanged') return plan;
        const saved = await activeAdapter.saveDeltaLog(plan.log);
        if (!isCurrentSession()) return { ...plan, log: saved };
        const nextLogs = upsertList(deltaLogsRef.current, saved);
        deltaLogsRef.current = nextLogs;
        setDeltaLogs(nextLogs);
        return { ...plan, log: saved };
      }),
    [assertCloudWritable, enqueueMutation, readFreshDeltaLogs]
  );

  const updateDeltaLogFields = useCallback(
    (logId: string, patch: { outcome?: DeltaOutcome; reflection?: string }): Promise<DeltaLog> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        const fresh = await readFreshDeltaLogs(activeAdapter, isCurrentSession);
        const row = fresh.find(l => l.id === logId);
        if (!row) throw new Error('That check-in was removed on another device.');
        const saved = await activeAdapter.saveDeltaLog(applyDeltaLogPatch(row, patch));
        if (!isCurrentSession()) return saved;
        const nextLogs = upsertList(deltaLogsRef.current, saved);
        deltaLogsRef.current = nextLogs;
        setDeltaLogs(nextLogs);
        return saved;
      }),
    [assertCloudWritable, enqueueMutation, readFreshDeltaLogs]
  );

  const deleteDeltaLog = useCallback(
    (logId: string): Promise<void> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        if (!activeAdapter.deleteDeltaLog) throw new Error('Undo is not supported here.');
        await activeAdapter.deleteDeltaLog(logId);
        if (!isCurrentSession()) return;
        const nextLogs = deltaLogsRef.current.filter(l => l.id !== logId);
        deltaLogsRef.current = nextLogs;
        setDeltaLogs(nextLogs);
      }),
    [assertCloudWritable, enqueueMutation]
  );

  const updateSessionNote = useCallback(
    (sessionId: string, note: string): Promise<ReadingSession> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        // CD 3 fix-up R1#1: patch only `note` on a FRESH row (never revert endPos/updatedAt
        // written by the CLI or another device since this view loaded).
        let fresh = sessionsRef.current;
        if (activeAdapter.loadSessions) {
          fresh = await activeAdapter.loadSessions();
          if (!isCurrentSession()) {
            throw new Error('Session changed before this action could complete. Please try again.');
          }
          sessionsRef.current = fresh;
          setSessions(fresh);
        }
        const existing = fresh.find(s => s.id === sessionId);
        if (!existing) throw new Error('That session was removed on another device.');
        const saved = await activeAdapter.saveSession({
          ...existing,
          note: (note || '').trim().slice(0, SESSION_NOTE_MAX),
        });
        if (!isCurrentSession()) return saved;
        const nextSessions = upsertList(sessionsRef.current, saved);
        sessionsRef.current = nextSessions;
        setSessions(nextSessions);
        return saved;
      }),
    [assertCloudWritable, enqueueMutation]
  );

  const startReread = useCallback(
    (bookId: string): Promise<Book> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        const loaded = booksRef.current.find(b => b.id === bookId);
        if (!loaded) throw new Error('Book not found');
        const plan = planStartReread(loaded);
        const saved = await activeAdapter.saveBook(plan.nextBook, {
          expectedBaseUpdatedAt: plan.expectedBaseUpdatedAt,
        });
        if (!isCurrentSession()) return saved;
        const nextBooks = upsertList(booksRef.current, saved);
        booksRef.current = nextBooks;
        setBooks(nextBooks);
        return saved;
      }),
    [assertCloudWritable, enqueueMutation]
  );

  const replaceWorkspaceFromSnapshot = useCallback(
    (snapshot: PragyaSnapshot, options: ReplaceWorkspaceOptions = {}): Promise<void> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        // M4.8 / CD7: keep an IndexedDB pre-import backup of the current workspace first.
        if (options.backup !== false) {
          await savePreImportBackupAsync(
            buildSnapshot({
              books: booksRef.current,
              notes: notesRef.current,
              sessions: sessionsRef.current,
              deltaLogs: deltaLogsRef.current,
            })
          );
          if (!isCurrentSession()) {
            throw new Error('Session changed before this action could complete. Please try again.');
          }
        }
        const ws = await activeAdapter.replaceWorkspace(snapshot);
        if (!isCurrentSession()) return;
        booksRef.current = ws.books;
        notesRef.current = ws.notes;
        sessionsRef.current = ws.sessions;
        deltaLogsRef.current = ws.deltaLogs;
        setBooks(ws.books);
        setNotes(ws.notes);
        setSessions(ws.sessions);
        setDeltaLogs(ws.deltaLogs);
        setLastSyncedAt(new Date().toISOString());
      }),
    [assertCloudWritable, enqueueMutation]
  );

  const resetDemoWorkspace = useCallback(
    () =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        if (!activeAdapter.resetDemoData) return;
        // CD 1a fix-up: Reset Demo clears only Demo drafts (real-account scopes untouched).
        clearAllDrafts({ scope: DEMO_DRAFT_SCOPE });
        clearCollisionSkipState();
        const fresh = await activeAdapter.resetDemoData();
        if (!isCurrentSession()) return;
        booksRef.current = fresh.books;
        notesRef.current = fresh.notes;
        sessionsRef.current = fresh.sessions;
        deltaLogsRef.current = fresh.deltaLogs;
        setBooks(fresh.books);
        setNotes(fresh.notes);
        setSessions(fresh.sessions);
        setDeltaLogs(fresh.deltaLogs);
        setLastSyncedAt(new Date().toISOString());
        showToast('Demo data reset to defaults', 'success');
      }),
    [enqueueMutation]
  );

  const uploadImageAttachment = useCallback(
    async (file: File | Blob): Promise<Attachment> => {
      assertCloudWritable();
      const originEpoch = sessionEpochRef.current;
      const activeAdapter = adapterRef.current;
      const compressed = await compressImageToWebp(file, 1600, 0.82);
      if (
        sessionEpochRef.current !== originEpoch ||
        adapterRef.current !== activeAdapter ||
        !isAuthenticatedRef.current
      ) {
        throw new Error('Session changed before image upload could complete. Please try again.');
      }
      if (activeAdapter.uploadImage) {
        return activeAdapter.uploadImage(
          compressed.blob,
          compressed.fileName,
          compressed.mimeType,
          compressed.width,
          compressed.height
        );
      }
      throw new Error('Image upload unavailable in current adapter');
    },
    [assertCloudWritable]
  );

  /**
   * CD C1.2 (fix-up): refresh → re-plan → write the (unconfirmed) local backup → ONE atomic
   * adapter cascade that re-verifies the target is still archived. All-or-nothing: on any
   * failure nothing was deleted, so the backup is dropped and the error is rethrown.
   * Re-review R2-a: if the adapter can't tell whether the write landed
   * (DeleteOutcomeUnknownError) the backup is KEPT (unconfirmed) and the error rethrown.
   * R2-b: planned rows the adapter reports as still present stay in local state.
   */
  const runPermanentDelete = useCallback(
    (kind: 'book' | 'note', id: string): Promise<PermanentDeleteResult> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        if (!activeAdapter.deleteRowsCascade) {
          throw new Error('Permanent delete is not supported here.');
        }
        // R1#3: plan from a fresh read so rows added elsewhere (CLI / another device) are
        // included and the counts are true; a restore done elsewhere surfaces here (QA-30).
        const ws = await activeAdapter.loadWorkspace({ forceRefresh: true });
        if (!isCurrentSession()) {
          throw new Error('Session changed before this action could complete. Please try again.');
        }
        applyRows(ws);
        const rows = currentRows();
        const nowIso = new Date().toISOString();
        let backup: DeleteBackup;
        if (kind === 'note') {
          const note = rows.notes.find(n => n.id === id);
          if (!note) throw new Error('Note not found');
          backup = planNoteDelete(note, rows, nowIso);
        } else {
          const book = rows.books.find(b => b.id === id);
          if (!book) throw new Error('Book not found');
          backup = planBookDelete(book, rows, nowIso);
        }
        writeLastDeleteBackup(backup);
        let outcome: DeleteCascadeResult;
        try {
          outcome = (await activeAdapter.deleteRowsCascade(toDeleteRowsPlan(backup), {
            target: { kind, id },
          })) || {
            repaired: 0,
            stillPresent: [],
          };
        } catch (err) {
          // Unknown outcome: the rows may be gone, so keep the backup as the safety net.
          if (!(err instanceof DeleteOutcomeUnknownError) && isCurrentSession()) {
            clearLastDeleteBackup(); // atomic: nothing was deleted
          }
          throw err;
        }
        const confirmed: DeleteBackup = { ...backup, confirmed: true };
        if (!isCurrentSession()) return { backup: confirmed, outcome };
        writeLastDeleteBackup(confirmed);
        applyRows(withoutDeleted(currentRows(), withoutIds(backup, outcome.stillPresent)));
        return { backup: confirmed, outcome };
      }),
    [applyRows, assertCloudWritable, currentRows, enqueueMutation]
  );

  const deleteNotePermanently = useCallback(
    (noteId: string) => runPermanentDelete('note', noteId),
    [runPermanentDelete]
  );

  const deleteBookPermanently = useCallback(
    (bookId: string) => runPermanentDelete('book', bookId),
    [runPermanentDelete]
  );

  const restoreDeletedRows = useCallback(
    (backup: DeleteBackup): Promise<RestoreRowsResult> =>
      enqueueMutation(async ({ adapter: activeAdapter, isCurrentSession }) => {
        assertCloudWritable();
        if (!activeAdapter.appendRowsIfAbsent) throw new Error('Restore is not supported here.');
        // R1#4: append only rows that are absent; never overwrite a row that exists.
        const result = await activeAdapter.appendRowsIfAbsent(backup);
        if (!isCurrentSession()) return result;
        const rows = currentRows();
        const pick = <T extends { id: string }>(items: T[], ids: string[]) =>
          items.filter(x => ids.includes(x.id));
        applyRows({
          books: pick(backup.books, result.restored.books).reduce(
            (acc, b) => upsertList(acc, b),
            rows.books
          ),
          notes: pick(backup.notes, result.restored.notes).reduce(
            (acc, n) => upsertList(acc, n),
            rows.notes
          ),
          sessions: pick(backup.sessions, result.restored.sessions).reduce(
            (acc, x) => upsertList(acc, x),
            rows.sessions
          ),
          deltaLogs: pick(backup.deltaLogs, result.restored.deltaLogs).reduce(
            (acc, l) => upsertList(acc, l),
            rows.deltaLogs
          ),
        });
        const last = readLastDeleteBackup();
        if (last && last.targetId === backup.targetId && last.deletedAt === backup.deletedAt) {
          clearLastDeleteBackup();
        }
        return result;
      }),
    [applyRows, assertCloudWritable, currentRows, enqueueMutation]
  );

  const resolveDocTitle = useCallback(async (docId: string): Promise<string | null> => {
    const activeAdapter = adapterRef.current;
    if (!activeAdapter.resolveDocTitle) return null;
    return activeAdapter.resolveDocTitle(docId);
  }, []);

  const booksById = useMemo<ReadonlyMap<string, Book>>(
    () => new Map(books.map(b => [b.id, b])),
    [books]
  );

  const notesById = useMemo<ReadonlyMap<string, Note>>(
    () => new Map(notes.map(n => [n.id, n])),
    [notes]
  );

  const dataValue = useMemo<PragyaDataContextValue>(
    () => ({
      books,
      notes,
      sessions,
      deltaLogs,
      booksById,
      notesById,
      isLoading,
      isSyncing,
      lastSyncedAt,
      spreadsheetId,
      mediaFolderId,
      isOfflineReadOnly,
    }),
    [
      books,
      notes,
      sessions,
      deltaLogs,
      booksById,
      notesById,
      isLoading,
      isSyncing,
      lastSyncedAt,
      spreadsheetId,
      mediaFolderId,
      isOfflineReadOnly,
    ]
  );

  const actionsValue = useMemo<PragyaActionsContextValue>(
    () => ({
      syncNow,
      addBook,
      updateBook,
      advanceBookPosition,
      revertBookmarkAdvance,
      restoreBook,
      startReadingBook,
      markBookFinished,
      captureNote,
      updateNote,
      saveNoteBridge,
      restoreNoteBridge,
      logDeltaOutcome,
      checkInDelta,
      updateDeltaLogFields,
      deleteDeltaLog,
      updateSessionNote,
      startReread,
      replaceWorkspaceFromSnapshot,
      resetDemoWorkspace,
      uploadImageAttachment,
      resolveDocTitle,
      deleteNotePermanently,
      deleteBookPermanently,
      restoreDeletedRows,
    }),
    [
      syncNow,
      addBook,
      updateBook,
      advanceBookPosition,
      revertBookmarkAdvance,
      restoreBook,
      startReadingBook,
      markBookFinished,
      captureNote,
      updateNote,
      saveNoteBridge,
      restoreNoteBridge,
      logDeltaOutcome,
      checkInDelta,
      updateDeltaLogFields,
      deleteDeltaLog,
      updateSessionNote,
      startReread,
      replaceWorkspaceFromSnapshot,
      resetDemoWorkspace,
      uploadImageAttachment,
      resolveDocTitle,
      deleteNotePermanently,
      deleteBookPermanently,
      restoreDeletedRows,
    ]
  );

  return (
    <PragyaActionsContext.Provider value={actionsValue}>
      <PragyaDataContext.Provider value={dataValue}>{children}</PragyaDataContext.Provider>
    </PragyaActionsContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export function usePragyaData(): PragyaDataContextValue {
  const ctx = useContext(PragyaDataContext);
  if (!ctx) throw new Error('usePragyaData must be used within PragyaProvider');
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePragyaActions(): PragyaActionsContextValue {
  const ctx = useContext(PragyaActionsContext);
  if (!ctx) throw new Error('usePragyaActions must be used within PragyaProvider');
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePragya(): PragyaContextValue {
  const data = usePragyaData();
  const actions = usePragyaActions();
  return useMemo(() => ({ ...data, ...actions }), [data, actions]);
}
