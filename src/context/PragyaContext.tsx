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
  BookFormat,
  BookKind,
  BookStatus,
  DeltaLog,
  DeltaOutcome,
  Note,
  PosUnit,
  PragyaSnapshot,
  ReadingSession,
} from '../types/pragya';
import { DemoStorageAdapter } from '../services/demoAdapter';
import { GoogleSheetsAdapter } from '../services/googleSheetsAdapter';
import type { StorageAdapter } from '../services/storage';
import { compressImageToWebp } from '../utils/imageCompress';
import {
  applyBookmarkAdvance,
  createUuid,
  getLocalDateString,
  upsertCoalescedSession,
} from '../utils/sessionCoalesce';
import { normalizeDeltaAction, normalizeDeltaTrigger } from '../utils/deltaFormat';
import { normalizeTagList } from '../utils/sheetCodecs';
import { computeNormalizedPos } from '../utils/spoilerMath';
import { generateUniqueSlug } from '../utils/wikilinks';
import { showToast } from '../utils/toast';
import { buildSnapshot } from '../utils/snapshot';
import { savePreImportBackup } from '../utils/importSafety';
import { clearAllDrafts } from '../utils/draftStorage';
import { clampNotePos } from '../utils/positionClamp';
import {
  OfflineReadOnlyError,
  STILL_OFFLINE_TOAST,
  isNetworkError,
  shouldBlockCloudWrite,
} from '../utils/offline';
import { useAuth } from './AuthContext';

export interface AddBookInput {
  title: string;
  author: string;
  format: BookFormat;
  kind: BookKind;
  status: BookStatus;
  currentPos: number;
  totalPos: number;
  posUnit: PosUnit;
  docUrl?: string;
}

export interface QuickCaptureInput {
  bookId: string;
  pos: number;
  title?: string;
  quote?: string;
  takeaway: string;
  tags: string[];
  sparLater?: boolean;
  isPrediction?: boolean;
  attachments?: Attachment[];
}

export interface UpdateNoteOptions {
  /** Keep `note.updatedAt` as-is (e.g. Mark Reviewed only touches meta.lastReviewedAt). */
  preserveUpdatedAt?: boolean;
  /** Override the conflict-guard base; defaults to the loaded note's updatedAt. */
  expectedBaseUpdatedAt?: string;
}

export interface ReplaceWorkspaceOptions {
  /** Save current workspace to pragya_pre_import_backup_v1 first (default true). */
  backup?: boolean;
}

export interface PragyaContextValue {
  books: Book[];
  notes: Note[];
  sessions: ReadingSession[];
  deltaLogs: DeltaLog[];
  isLoading: boolean;
  isSyncing: boolean;
  lastSyncedAt: string | null;
  spreadsheetId: string | null;
  mediaFolderId: string | null;
  /** Cloud Mode only: true while serving cached data because the network is unavailable. */
  isOfflineReadOnly: boolean;
  syncNow: (force?: boolean) => Promise<void>;
  addBook: (input: AddBookInput) => Promise<Book>;
  updateBook: (book: Book) => Promise<Book>;
  advanceBookPosition: (
    bookId: string,
    incomingPos: number,
    options?: { manualOverride?: boolean; sessionNote?: string }
  ) => Promise<{ book: Book; changed: boolean; rejectedBackward: boolean }>;
  startReadingBook: (bookId: string) => Promise<Book | null>;
  markBookFinished: (bookId: string) => Promise<Book | null>;
  captureNote: (input: QuickCaptureInput) => Promise<Note>;
  updateNote: (note: Note, options?: UpdateNoteOptions) => Promise<Note>;
  logDeltaOutcome: (
    noteId: string,
    outcome: DeltaOutcome,
    reflection?: string
  ) => Promise<DeltaLog>;
  replaceWorkspaceFromSnapshot: (
    snapshot: PragyaSnapshot,
    options?: ReplaceWorkspaceOptions
  ) => Promise<void>;
  resetDemoWorkspace: () => Promise<void>;
  uploadImageAttachment: (file: File | Blob) => Promise<Attachment>;
  resolveDocTitle: (docId: string) => Promise<string | null>;
}

const PragyaContext = createContext<PragyaContextValue | undefined>(undefined);

function upsertList<T extends { id: string }>(items: T[], item: T): T[] {
  const idx = items.findIndex(x => x.id === item.id);
  if (idx >= 0) {
    const next = [...items];
    next[idx] = item;
    return next;
  }
  return [...items, item];
}

export const PragyaProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isMockMode, user, getGoogleToken, triggerSessionExpired } = useAuth();

  const userEmail = user?.email;
  const adapter: StorageAdapter = useMemo(() => {
    if (isMockMode) {
      return new DemoStorageAdapter();
    }
    return new GoogleSheetsAdapter(getGoogleToken, triggerSessionExpired, userEmail);
  }, [isMockMode, userEmail, getGoogleToken, triggerSessionExpired]);

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

  const booksRef = useRef<Book[]>(books);
  const notesRef = useRef<Note[]>(notes);
  const sessionsRef = useRef<ReadingSession[]>(sessions);
  const deltaLogsRef = useRef<DeltaLog[]>(deltaLogs);
  const isAuthenticatedRef = useRef<boolean>(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;
  const isOfflineReadOnlyRef = useRef<boolean>(false);
  const isMockModeRef = useRef<boolean>(isMockMode);
  isMockModeRef.current = isMockMode;

  const mutationQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  const enqueueMutation = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = mutationQueueRef.current.catch(() => {}).then(task);
    mutationQueueRef.current = next;
    return next;
  }, []);

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

  const syncNow = useCallback(
    async (force = false) => {
      if (!isAuthenticated) return;
      setIsSyncing(true);
      let servedOffline = false;
      try {
        await enqueueMutation(async () => {
          if (!isAuthenticatedRef.current) return;
          const ws = await adapter.loadWorkspace({ forceRefresh: force });
          if (!isAuthenticatedRef.current) return;
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
          setOfflineReadOnly(servedOffline);
          if (!servedOffline) {
            setLastSyncedAt(new Date().toISOString());
          }
        });
        if (force && isAuthenticatedRef.current) {
          if (servedOffline) {
            showToast(STILL_OFFLINE_TOAST, 'info');
          } else {
            showToast('Workspace synced', 'success');
          }
        }
      } catch (err) {
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
          showToast(msg, 'error');
        }
      } finally {
        setIsSyncing(false);
        setIsLoading(false);
      }
    },
    [adapter, enqueueMutation, isAuthenticated, setOfflineReadOnly]
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
      return;
    }
    if (isMockMode) {
      setOfflineReadOnly(false);
    }
    setIsLoading(true);
    void syncNow(false);
  }, [isAuthenticated, isMockMode, syncNow, setOfflineReadOnly]);

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
    window.addEventListener('online', maybeSync);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('online', maybeSync);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isAuthenticated, isMockMode, syncNow]);

  const addBook = useCallback(
    (input: AddBookInput): Promise<Book> =>
      enqueueMutation(async () => {
        assertCloudWritable();
        const nowIso = new Date().toISOString();
        const totalPos = Math.max(0, Number(input.totalPos) || 0);
        const currentPos = Math.max(0, Number(input.currentPos) || 0);
        const normalizedPos =
          input.status === 'finished'
            ? 1
            : computeNormalizedPos(currentPos, totalPos, input.posUnit);

        const newBook: Book = {
          id: createUuid(),
          title: input.title.trim(),
          author: input.author.trim(),
          format: input.format,
          kind: input.kind,
          status: input.status,
          currentPos,
          totalPos,
          posUnit: input.posUnit,
          normalizedPos,
          docUrl: (input.docUrl || '').trim(),
          meta: {
            ...(input.status === 'reading' || input.status === 'finished'
              ? { startedAt: nowIso }
              : {}),
            ...(input.status === 'finished' ? { finishedAt: nowIso } : {}),
            updatedAt: nowIso,
          },
        };

        const saved = await adapter.saveBook(newBook);
        const nextBooks = upsertList(booksRef.current, saved);
        booksRef.current = nextBooks;
        setBooks(nextBooks);
        return saved;
      }),
    [adapter, assertCloudWritable, enqueueMutation]
  );

  const updateBook = useCallback(
    (book: Book): Promise<Book> =>
      enqueueMutation(async () => {
        assertCloudWritable();
        const nowIso = new Date().toISOString();
        const loaded = booksRef.current.find(b => b.id === book.id);
        const nextBook: Book = {
          ...book,
          normalizedPos:
            book.status === 'finished'
              ? 1
              : computeNormalizedPos(book.currentPos, book.totalPos, book.posUnit),
          meta: {
            ...book.meta,
            updatedAt: nowIso,
          },
        };
        const saved = await adapter.saveBook(nextBook, {
          expectedBaseUpdatedAt: loaded?.meta?.updatedAt,
        });
        const nextBooks = upsertList(booksRef.current, saved);
        booksRef.current = nextBooks;
        setBooks(nextBooks);
        return saved;
      }),
    [adapter, assertCloudWritable, enqueueMutation]
  );

  const advanceBookPositionInternal = useCallback(
    async (
      bookId: string,
      incomingPos: number,
      options: { manualOverride?: boolean; sessionNote?: string } = {}
    ): Promise<{ book: Book; changed: boolean; rejectedBackward: boolean }> => {
      const existing = booksRef.current.find(b => b.id === bookId);
      if (!existing) {
        throw new Error('Book not found');
      }
      assertCloudWritable();
      const nowIso = new Date().toISOString();
      const res = applyBookmarkAdvance(existing, incomingPos, {
        manualOverride: options.manualOverride,
        nowIso,
      });

      if (res.rejectedBackward) {
        return { book: existing, changed: false, rejectedBackward: true };
      }

      if (!res.changed) {
        return { book: existing, changed: false, rejectedBackward: false };
      }

      const savedBook = await adapter.saveBook(res.updatedBook, {
        expectedBaseUpdatedAt: existing.meta?.updatedAt,
      });
      const nextBooks = upsertList(booksRef.current, savedBook);
      booksRef.current = nextBooks;
      setBooks(nextBooks);

      const sessionRes = upsertCoalescedSession(sessionsRef.current, {
        bookId,
        prevPos: res.prevPos,
        nextPos: res.nextPos,
        nowIso,
        note: options.sessionNote,
        manualOverride: options.manualOverride,
      });

      const savedSession = await adapter.saveSession(sessionRes.upserted);
      const nextSessions = upsertList(sessionsRef.current, savedSession);
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);

      return { book: savedBook, changed: true, rejectedBackward: false };
    },
    [adapter, assertCloudWritable]
  );

  const advanceBookPosition = useCallback(
    (
      bookId: string,
      incomingPos: number,
      options: { manualOverride?: boolean; sessionNote?: string } = {}
    ): Promise<{ book: Book; changed: boolean; rejectedBackward: boolean }> =>
      enqueueMutation(() => advanceBookPositionInternal(bookId, incomingPos, options)),
    [advanceBookPositionInternal, enqueueMutation]
  );

  const startReadingBook = useCallback(
    (bookId: string): Promise<Book | null> =>
      enqueueMutation(async () => {
        const existing = booksRef.current.find(b => b.id === bookId);
        if (!existing) return null;
        assertCloudWritable();
        const nowIso = new Date().toISOString();
        const next: Book = {
          ...existing,
          status: 'reading',
          meta: {
            ...existing.meta,
            startedAt: existing.meta.startedAt || nowIso,
            updatedAt: nowIso,
          },
        };
        const saved = await adapter.saveBook(next, {
          expectedBaseUpdatedAt: existing.meta?.updatedAt,
        });
        const nextBooks = upsertList(booksRef.current, saved);
        booksRef.current = nextBooks;
        setBooks(nextBooks);
        return saved;
      }),
    [adapter, assertCloudWritable, enqueueMutation]
  );

  const markBookFinished = useCallback(
    (bookId: string): Promise<Book | null> =>
      enqueueMutation(async () => {
        const existing = booksRef.current.find(b => b.id === bookId);
        if (!existing) return null;
        assertCloudWritable();
        const nowIso = new Date().toISOString();
        const finalPos = existing.totalPos > 0 ? existing.totalPos : existing.currentPos;
        const next: Book = {
          ...existing,
          status: 'finished',
          currentPos: finalPos,
          normalizedPos: 1,
          meta: {
            ...existing.meta,
            startedAt: existing.meta.startedAt || nowIso,
            finishedAt: nowIso,
            updatedAt: nowIso,
          },
        };
        const saved = await adapter.saveBook(next, {
          expectedBaseUpdatedAt: existing.meta?.updatedAt,
        });
        const nextBooks = upsertList(booksRef.current, saved);
        booksRef.current = nextBooks;
        setBooks(nextBooks);
        return saved;
      }),
    [adapter, assertCloudWritable, enqueueMutation]
  );

  const captureNote = useCallback(
    (input: QuickCaptureInput): Promise<Note> =>
      enqueueMutation(async () => {
        const book = booksRef.current.find(b => b.id === input.bookId);
        if (!book) {
          throw new Error('Select a valid book before capturing a note.');
        }
        assertCloudWritable();
        const nowIso = new Date().toISOString();
        // M4.9: clamp into [0, totalPos] / [0, 100] for parity with pragya_cli.py
        const pos = clampNotePos(input.pos, book);
        const normalizedPos = computeNormalizedPos(pos, book.totalPos, book.posUnit);
        const attachments = (input.attachments || []).slice(0, 3);
        const links = attachments
          .filter((a): a is Extract<Attachment, { type: 'link' | 'doc' }> => a.type !== 'image')
          .map(a => a.url);

        const slugSource =
          (input.title || '').trim() ||
          input.takeaway.trim().split(/\s+/).slice(0, 6).join(' ') ||
          (input.quote || '').trim().split(/\s+/).slice(0, 6).join(' ') ||
          `${book.title} p${pos}`;

        const slug = generateUniqueSlug(
          slugSource,
          notesRef.current.map(n => n.slug)
        );

        const newNote: Note = {
          id: createUuid(),
          slug,
          bookId: book.id,
          createdAt: nowIso,
          updatedAt: nowIso,
          pos,
          normalizedPos,
          status: input.sparLater ? 'inbox' : 'saved',
          source: 'app',
          tags: normalizeTagList(input.tags || []),
          quote: (input.quote || '').trim(),
          takeaway: input.takeaway.trim(),
          contextMechanism: '',
          critique: '',
          deltaTrigger: '',
          deltaAction: '',
          deltaStatus: 'none',
          meta: {
            ...(input.title?.trim() ? { title: input.title.trim() } : {}),
            attachments,
            links,
            ...(book.kind === 'fiction' && input.isPrediction ? { isPrediction: true } : {}),
          },
        };

        const savedNote = await adapter.saveNote(newNote);
        const nextNotes = [savedNote, ...notesRef.current];
        notesRef.current = nextNotes;
        setNotes(nextNotes);

        if (pos > book.currentPos) {
          await advanceBookPositionInternal(book.id, pos);
        }

        return savedNote;
      }),
    [adapter, advanceBookPositionInternal, assertCloudWritable, enqueueMutation]
  );

  const updateNote = useCallback(
    (note: Note, options: UpdateNoteOptions = {}): Promise<Note> =>
      enqueueMutation(async () => {
        assertCloudWritable();
        if (note.deltaStatus === 'active') {
          const otherActiveCount = notesRef.current.filter(
            n => n.id !== note.id && n.deltaStatus === 'active'
          ).length;
          if (otherActiveCount >= 5) {
            throw new Error(
              'Active Behavioral Delta cap (5/5) reached. Graduate or pause an active delta first.'
            );
          }
        }

        const existingNote = notesRef.current.find(n => n.id === note.id);
        const book = booksRef.current.find(b => b.id === note.bookId);
        const attachments = (note.meta?.attachments || []).slice(0, 3);
        const newAttachmentUrls = attachments
          .filter((a): a is Extract<Attachment, { type: 'link' | 'doc' }> => a.type !== 'image')
          .map(a => a.url);
        const oldAttachmentUrls = new Set(
          (existingNote?.meta?.attachments || [])
            .filter((a): a is Extract<Attachment, { type: 'link' | 'doc' }> => a.type !== 'image')
            .map(a => a.url)
        );
        const newAttachmentUrlSet = new Set(newAttachmentUrls);
        const preservedStandaloneLinks = (note.meta?.links || []).filter(
          url => !oldAttachmentUrls.has(url) || newAttachmentUrlSet.has(url)
        );
        const mergedLinks = Array.from(new Set([...preservedStandaloneLinks, ...newAttachmentUrls]));

        const nowIso = new Date().toISOString();
        // M4.9: clamp pos only when it actually changed (never rewrite legacy values silently).
        const posChanged = !existingNote || Number(existingNote.pos) !== Number(note.pos);
        const nextPos = posChanged && book ? clampNotePos(note.pos, book) : note.pos;
        const nextNormalizedPos =
          posChanged && book
            ? computeNormalizedPos(nextPos, book.totalPos, book.posUnit)
            : note.normalizedPos;
        const updated: Note = {
          ...note,
          pos: nextPos,
          normalizedPos: nextNormalizedPos,
          tags: normalizeTagList(note.tags || []),
          deltaTrigger: normalizeDeltaTrigger(note.deltaTrigger),
          deltaAction: normalizeDeltaAction(note.deltaAction),
          meta: {
            ...note.meta,
            attachments,
            links: mergedLinks,
          },
          updatedAt: options.preserveUpdatedAt ? note.updatedAt : nowIso,
        };
        const saved = await adapter.saveNote(updated, {
          expectedBaseUpdatedAt: options.expectedBaseUpdatedAt ?? existingNote?.updatedAt,
        });
        const nextNotes = upsertList(notesRef.current, saved);
        notesRef.current = nextNotes;
        setNotes(nextNotes);
        return saved;
      }),
    [adapter, assertCloudWritable, enqueueMutation]
  );

  const logDeltaOutcome = useCallback(
    (noteId: string, outcome: DeltaOutcome, reflection = ''): Promise<DeltaLog> =>
      enqueueMutation(async () => {
        assertCloudWritable();
        const log: DeltaLog = {
          id: createUuid(),
          noteId,
          date: getLocalDateString(),
          outcome,
          reflection: reflection.trim(),
        };
        const saved = await adapter.saveDeltaLog(log);
        const nextLogs = upsertList(deltaLogsRef.current, saved);
        deltaLogsRef.current = nextLogs;
        setDeltaLogs(nextLogs);
        return saved;
      }),
    [adapter, assertCloudWritable, enqueueMutation]
  );

  const replaceWorkspaceFromSnapshot = useCallback(
    (snapshot: PragyaSnapshot, options: ReplaceWorkspaceOptions = {}): Promise<void> =>
      enqueueMutation(async () => {
        assertCloudWritable();
        // M4.8: keep a local pre-import backup of the current workspace first.
        if (options.backup !== false) {
          savePreImportBackup(
            buildSnapshot({
              books: booksRef.current,
              notes: notesRef.current,
              sessions: sessionsRef.current,
              deltaLogs: deltaLogsRef.current,
            })
          );
        }
        const ws = await adapter.replaceWorkspace(snapshot);
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
    [adapter, assertCloudWritable, enqueueMutation]
  );

  const resetDemoWorkspace = useCallback(
    () =>
      enqueueMutation(async () => {
        if (!adapter.resetDemoData) return;
        clearAllDrafts();
        const fresh = await adapter.resetDemoData();
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
    [adapter, enqueueMutation]
  );

  const uploadImageAttachment = useCallback(
    async (file: File | Blob): Promise<Attachment> => {
      assertCloudWritable();
      const compressed = await compressImageToWebp(file, 1600, 0.82);
      if (adapter.uploadImage) {
        return adapter.uploadImage(
          compressed.blob,
          compressed.fileName,
          compressed.mimeType,
          compressed.width,
          compressed.height
        );
      }
      throw new Error('Image upload unavailable in current adapter');
    },
    [adapter, assertCloudWritable]
  );

  const resolveDocTitle = useCallback(
    async (docId: string): Promise<string | null> => {
      if (!adapter.resolveDocTitle) return null;
      return adapter.resolveDocTitle(docId);
    },
    [adapter]
  );

  return (
    <PragyaContext.Provider
      value={{
        books,
        notes,
        sessions,
        deltaLogs,
        isLoading,
        isSyncing,
        lastSyncedAt,
        spreadsheetId,
        mediaFolderId,
        isOfflineReadOnly,
        syncNow,
        addBook,
        updateBook,
        advanceBookPosition,
        startReadingBook,
        markBookFinished,
        captureNote,
        updateNote,
        logDeltaOutcome,
        replaceWorkspaceFromSnapshot,
        resetDemoWorkspace,
        uploadImageAttachment,
        resolveDocTitle,
      }}
    >
      {children}
    </PragyaContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export function usePragya(): PragyaContextValue {
  const ctx = useContext(PragyaContext);
  if (!ctx) throw new Error('usePragya must be used within PragyaProvider');
  return ctx;
}
