import React, { useState } from 'react';
import { AlertTriangle, FileJson, X } from 'lucide-react';
import type { PragyaSnapshot } from '../../types/pragya';
import { showToast } from '../../utils/toast';
import { Modal } from '../common/Modal';

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
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (!snapshot) return;
    setSubmitting(true);
    try {
      await onConfirm(snapshot);
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to import snapshot', 'error');
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
      maxWidth="max-w-md"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <FileJson className="w-5 h-5 text-foreground" />
          <h2 className="text-title text-foreground">Import Snapshot</h2>
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
              Importing replaces all current Books, Notes, Reading Sessions, and Delta Logs in your active workspace.
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

          <div className="text-[11px] text-muted-foreground num">
            Snapshot exported: {new Date(snapshot.exportedAt).toLocaleString()}
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
