import { useCallback, useRef } from 'react';
import type { Book, Note } from '../types/pragya';
import { usePragya } from '../context/PragyaContext';
import { describeSyncError } from '../utils/apiErrors';
import {
  buildArchivedBook,
  buildArchivedNote,
  buildRestoredBook,
  buildRestoredNote,
  countOtherActiveDeltas,
  noteDisplayTitle,
} from '../utils/archive';
import { BOOK_ARCHIVE_OWNED_META_KEYS, NOTE_ARCHIVE_OWNED_META_KEYS } from '../utils/metaCodecs';
import { showToast } from '../utils/toast';

const UNDO_TOAST_MS = 8000;

const noteTitle = (note: Note): string => noteDisplayTitle(note);

/**
 * C1.1 archive / restore actions with the ux_spec_cd §0.2 Undo toast. Writes go through
 * updateBook / updateNote with the explicit conflict-guard base and owned meta keys, so
 * no other meta key can be clobbered. Each action resolves to the saved entity or null.
 */
export function useArchiveActions() {
  const { notes, updateBook, updateNote } = usePragya();
  // R1 nit 5: Undo closures outlive the render that created them; always read fresh notes.
  const notesRef = useRef(notes);
  notesRef.current = notes;

  const restoreBookFromArchive = useCallback(
    async (book: Book, options: { fromUndo?: boolean } = {}): Promise<Book | null> => {
      try {
        const saved = await updateBook(buildRestoredBook(book), {
          expectedBaseUpdatedAt: book.meta?.updatedAt,
          ownedMetaKeys: BOOK_ARCHIVE_OWNED_META_KEYS,
          baseMeta: book.meta,
        });
        showToast(`Restored "${book.title}".`, 'info', { id: `archive-${book.id}` });
        return saved;
      } catch (err) {
        showToast(
          describeSyncError(err, options.fromUndo ? 'Failed to undo archive' : 'Failed to restore book'),
          'error'
        );
        return null;
      }
    },
    [updateBook]
  );

  const archiveBook = useCallback(
    async (book: Book): Promise<Book | null> => {
      try {
        const saved = await updateBook(buildArchivedBook(book, new Date().toISOString()), {
          expectedBaseUpdatedAt: book.meta?.updatedAt,
          ownedMetaKeys: BOOK_ARCHIVE_OWNED_META_KEYS,
          baseMeta: book.meta,
        });
        showToast(`Archived "${book.title}".`, 'success', {
          id: `archive-${book.id}`,
          duration: UNDO_TOAST_MS,
          action: {
            label: 'Undo',
            testId: 'toast-undo-btn',
            onClick: () => void restoreBookFromArchive(saved, { fromUndo: true }),
          },
        });
        return saved;
      } catch (err) {
        showToast(describeSyncError(err, 'Failed to archive book'), 'error');
        return null;
      }
    },
    [restoreBookFromArchive, updateBook]
  );

  const restoreNoteFromArchive = useCallback(
    async (note: Note, options: { fromUndo?: boolean } = {}): Promise<Note | null> => {
      const otherActive = countOtherActiveDeltas(notesRef.current, note.id);
      const { note: next, capped } = buildRestoredNote(note, otherActive);
      try {
        const saved = await updateNote(next, {
          expectedBaseUpdatedAt: note.updatedAt,
          ownedMetaKeys: NOTE_ARCHIVE_OWNED_META_KEYS,
          baseMeta: note.meta,
        });
        showToast(
          capped
            ? `Restored "${noteTitle(note)}". Its delta stays paused while your active slots are full.`
            : `Restored "${noteTitle(note)}".`,
          'info',
          { id: `archive-${note.id}` }
        );
        return saved;
      } catch (err) {
        showToast(
          describeSyncError(err, options.fromUndo ? 'Failed to undo archive' : 'Failed to restore note'),
          'error'
        );
        return null;
      }
    },
    [updateNote]
  );

  /** Callers confirm first when `note.deltaStatus === 'active'` (it gets paused). */
  const archiveNote = useCallback(
    async (note: Note): Promise<Note | null> => {
      const { note: next } = buildArchivedNote(note, new Date().toISOString());
      try {
        const saved = await updateNote(next, {
          expectedBaseUpdatedAt: note.updatedAt,
          ownedMetaKeys: NOTE_ARCHIVE_OWNED_META_KEYS,
          baseMeta: note.meta,
        });
        showToast(`Archived "${noteTitle(note)}".`, 'success', {
          id: `archive-${note.id}`,
          duration: UNDO_TOAST_MS,
          action: {
            label: 'Undo',
            testId: 'toast-undo-btn',
            onClick: () => void restoreNoteFromArchive(saved, { fromUndo: true }),
          },
        });
        return saved;
      } catch (err) {
        showToast(describeSyncError(err, 'Failed to archive note'), 'error');
        return null;
      }
    },
    [restoreNoteFromArchive, updateNote]
  );

  return { archiveBook, restoreBookFromArchive, archiveNote, restoreNoteFromArchive };
}
