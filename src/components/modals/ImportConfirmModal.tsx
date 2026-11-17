import React, { useId, useState } from 'react';
import { AlertTriangle, Download, FileJson, X } from 'lucide-react';
import type { PragyaSnapshot } from '../../types/pragya';
import { usePragya } from '../../context/PragyaContext';
import { getLocalDateString } from '../../utils/sessionCoalesce';
import { buildSnapshot } from '../../utils/snapshot';
import { showToast } from '../../utils/toast';
import { Modal } from '../common/Modal';
import { describeSyncError } from '../../utils/apiErrors';

export interface ImportConfirmModalProps {
  snapshot: PragyaSnapshot | null;
  onClose: () => void;
  onConfirm: (snapshot: PragyaSnapshot) => Promise<void>;
}

export const ImportConfirmModal: React.FC<ImportConfirmModalProps> = ({
  snapshot,
  onClose,
  onConfirm,
}) => {
  const { books, notes, sessions, deltaLogs } = usePragya();
  const [submitting, setSubmitting] = useState(false);
  const headingId = useId();

  const handleDownloadCurrentBackup = () => {
    const current = buildSnapshot({ books, notes, sessions, deltaLogs });
    const blob = new Blob([JSON.stringify(current, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pragya-pre-import-backup-${getLocalDateString()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Downloaded current workspace backup', 'info');
  };

  const handleConfirm = async () => {
    if (!snapshot) return;
    setSubmitting(true);
    try {
      await onConfirm(snapshot);
      onClose();
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to import snapshot'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={Boolean(snapshot)}
      onClose={onClose}
      dataTestId="import-confirm-modal"
      title="Confirm JSON Snapshot Import"
      headingId={headingId}
      maxWidth="max-w-md"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <FileJson className="w-5 h-5 text-foreground" />
          <h2 id={headingId} className="text-title text-foreground">
            Import Snapshot
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="p-1.5 rounded-[8px] text-muted-foreground hover:text-foreground hover:bg-surface2"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {snapshot && (
        <div className="space-y-4">
          <div className="rounded-[10px] bg-warning/10 border border-warning/30 p-3 flex items-start gap-2.5 text-label text-foreground">
            <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <span>
              Importing replaces all current Books, Notes, Reading Sessions, and Delta Logs in your
              active workspace. A local rollback backup is also saved automatically.
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-label">
            <div className="p-3 rounded-[10px] bg-surface2/60 border border-border">
              <div className="text-muted-foreground">Books</div>
              <div className="text-heading text-foreground num mt-0.5">{snapshot.books.length}</div>
            </div>
            <div className="p-3 rounded-[10px] bg-surface2/60 border border-border">
              <div className="text-muted-foreground">Notes</div>
              <div className="text-heading text-foreground num mt-0.5">{snapshot.notes.length}</div>
            </div>
            <div className="p-3 rounded-[10px] bg-surface2/60 border border-border">
              <div className="text-muted-foreground">Reading Sessions</div>
              <div className="text-heading text-foreground num mt-0.5">
                {snapshot.sessions.length}
              </div>
            </div>
            <div className="p-3 rounded-[10px] bg-surface2/60 border border-border">
              <div className="text-muted-foreground">Delta Logs</div>
              <div className="text-heading text-foreground num mt-0.5">
                {snapshot.deltaLogs.length}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground num">
            <span>Snapshot exported: {new Date(snapshot.exportedAt).toLocaleString()}</span>
            <button
              type="button"
              data-testid="import-download-backup-btn"
              onClick={handleDownloadCurrentBackup}
              className="inline-flex items-center gap-1 text-foreground font-medium hover:underline"
            >
              <Download className="w-3 h-3" />
              <span>Download current workspace backup first</span>
            </button>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-[10px] text-body font-medium text-muted-foreground hover:text-foreground hover:bg-surface2"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={submitting}
              data-testid="import-confirm-btn"
              onClick={() => void handleConfirm()}
              className="h-10 px-5 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Importing…' : 'Confirm Import'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
};
