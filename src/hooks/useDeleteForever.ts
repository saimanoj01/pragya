import { useCallback, useMemo, useState } from 'react';
import type { Book, Note } from '../types/pragya';
import { usePragya } from '../context/PragyaContext';
import { useAuth } from '../context/AuthContext';
import type { ConfirmDialogProps } from '../components/common/ConfirmDialog';
import { describeSyncError } from '../utils/apiErrors';
import {
  DeleteOutcomeUnknownError,
  NotArchivedError,
  deleteDialogCopy,
  deleteOutcomeNotice,
  planBookDelete,
  planNoteDelete,
  type DeleteBackup,
} from '../utils/deletePlan';
import { OfflineReadOnlyError } from '../utils/offline';
import { downloadWorkspaceSnapshot } from '../utils/snapshotDownload';
import { showToast } from '../utils/toast';
import { navigateTo } from '../utils/navigation';

const UNDO_TOAST_MS = 8000;

interface Pending {
  kind: 'book' | 'note';
  id: string;
  title: string;
  copy: { title: string; body: string; confirm: string };
  /** Where to go after the delete when the user is on the deleted item's page. */
  leaveTo: string;
  leaveIfHashStartsWith: string[];
}

/**
 * CD C1.2 "Delete Forever…" flow (archived items only): opens the ux_spec_cd C.1.4
 * ConfirmDialog with exact cascade counts + "Download a backup first", runs the
 * children-first delete, then shows `Deleted "{title}".` with an 8 s Undo that re-appends
 * the exact rows. Render `<ConfirmDialog {...dialogProps} />` where you use the hook.
 */
export function useDeleteForever() {
  const {
    books,
    notes,
    sessions,
    deltaLogs,
    deleteNotePermanently,
    deleteBookPermanently,
    restoreDeletedRows,
  } = usePragya();
  const { isMockMode } = useAuth();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => ({ books, notes, sessions, deltaLogs }), [books, deltaLogs, notes, sessions]);

  const requestDeleteNote = useCallback(
    (note: Note, options: { shielded?: boolean; title?: string } = {}) => {
      const preview = planNoteDelete(note, { books, notes, sessions, deltaLogs }, new Date().toISOString());
      setPending({
        kind: 'note',
        id: note.id,
        title: options.title || preview.title,
        copy: deleteDialogCopy(preview, { demo: isMockMode, shielded: options.shielded }),
        leaveTo: '#/notes',
        leaveIfHashStartsWith: [
          `#/note/${encodeURIComponent(note.slug)}`,
          `#/note/${encodeURIComponent(note.id)}`,
        ],
      });
    },
    [books, deltaLogs, isMockMode, notes, sessions]
  );

  const requestDeleteBook = useCallback(
    (book: Book) => {
      const preview = planBookDelete(book, { books, notes, sessions, deltaLogs }, new Date().toISOString());
      setPending({
        kind: 'book',
        id: book.id,
        title: book.title,
        copy: deleteDialogCopy(preview, { demo: isMockMode }),
        leaveTo: '#/shelf',
        leaveIfHashStartsWith: [`#/book/${encodeURIComponent(book.id)}`],
      });
    },
    [books, deltaLogs, isMockMode, notes, sessions]
  );

  const undo = useCallback(
    (backup: DeleteBackup, title: string) => {
      void restoreDeletedRows(backup)
        .then(result =>
          showToast(
            result.skipped > 0
              ? `Restored "${title}". Some parts already existed and were left as they are.`
              : `Restored "${title}".`,
            'info',
            { id: `delete-${backup.targetId}` }
          )
        )
        .catch(err => showToast(describeSyncError(err, 'Failed to undo delete'), 'error'));
    },
    [restoreDeletedRows]
  );

  const confirm = useCallback(async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const { backup, outcome } =
        pending.kind === 'note'
          ? await deleteNotePermanently(pending.id)
          : await deleteBookPermanently(pending.id);
      const title = pending.title;
      setPending(null);
      if (pending.leaveIfHashStartsWith.some(p => window.location.hash.startsWith(p))) {
        navigateTo(pending.leaveTo);
      }
      showToast(`Deleted "${title}".`, 'info', {
        id: `delete-${backup.targetId}`,
        duration: UNDO_TOAST_MS,
        action: { label: 'Undo', testId: 'toast-undo-btn', onClick: () => undo(backup, title) },
      });
      // Re-review R2-b: another device shifted rows mid-delete; say what Pragya repaired.
      const notice = deleteOutcomeNotice(outcome);
      if (notice) showToast(notice, 'info');
    } catch (err) {
      // The cascade is atomic: a failure means nothing was removed.
      if (err instanceof NotArchivedError) {
        setPending(null);
        showToast(`"${pending.title}" was restored elsewhere, so it wasn't deleted.`, 'info');
      } else if (err instanceof DeleteOutcomeUnknownError) {
        // R2-a: the connection dropped mid-delete and the re-check failed too.
        setPending(null);
        showToast(
          `Lost the connection while deleting "${pending.title}". Check the Sheet once you're back online; a backup is kept on this device.`,
          'error'
        );
      } else if (err instanceof OfflineReadOnlyError) {
        showToast(describeSyncError(err, 'Failed to delete'), 'error');
      } else {
        showToast(`Couldn't delete "${pending.title}". Nothing was removed. Try again.`, 'error');
      }
    } finally {
      setBusy(false);
    }
  }, [busy, deleteBookPermanently, deleteNotePermanently, pending, undo]);

  const dialogProps: ConfirmDialogProps = {
    isOpen: pending !== null,
    title: pending?.copy.title || '',
    body: pending?.copy.body || '',
    confirmLabel: pending?.copy.confirm || 'Delete',
    tone: 'destructive',
    busy,
    onCancel: () => {
      if (!busy) setPending(null);
    },
    onConfirm: () => void confirm(),
    onDownloadBackup: () => {
      downloadWorkspaceSnapshot(rows);
      showToast('Downloaded a backup.', 'success');
    },
  };

  return { requestDeleteNote, requestDeleteBook, dialogProps };
}
