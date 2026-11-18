import React, { useId, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Cloud,
  Download,
  ExternalLink,
  FolderOpen,
  History,
  LogOut,
  Moon,
  RefreshCw,
  RotateCcw,
  Sun,
  Upload,
  WifiOff,
} from 'lucide-react';
import type { PragyaSnapshot } from '../../types/pragya';
import { useAuth } from '../../context/AuthContext';
import { usePragya } from '../../context/PragyaContext';
import { useTheme } from '../../context/ThemeContext';
import { readPreImportBackup } from '../../utils/importSafety';
import { buildSnapshot, validateSnapshotPayload } from '../../utils/snapshot';
import { showToast } from '../../utils/toast';
import { OAuthSetupGuide } from '../common/OAuthSetupGuide';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { ImportConfirmModal } from '../modals/ImportConfirmModal';
import { describeSyncError } from '../../utils/apiErrors';

export interface SettingsViewProps {
  /** App-level logout request (asks first when unsaved drafts exist; CD C.1.5). */
  onLogout?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onLogout }) => {
  const { user, isMockMode, googleClientId, saveGoogleClientId, logout } = useAuth();
  const [confirmAction, setConfirmAction] = useState<'reset-demo' | 'restore-backup' | null>(null);
  const {
    books,
    notes,
    sessions,
    deltaLogs,
    isSyncing,
    isOfflineReadOnly,
    lastSyncedAt,
    spreadsheetId,
    mediaFolderId,
    syncNow,
    replaceWorkspaceFromSnapshot,
    resetDemoWorkspace,
  } = usePragya();
  const { theme, toggleTheme } = useTheme();

  const [clientIdDraft, setClientIdDraft] = useState(googleClientId || '');
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [pendingSnapshot, setPendingSnapshot] = useState<PragyaSnapshot | null>(null);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const clientIdInputId = useId();

  const preImportBackup = readPreImportBackup();

  const handleSaveClientId = (e: React.FormEvent) => {
    e.preventDefault();
    saveGoogleClientId(clientIdDraft);
    showToast('Google Client ID updated', 'success');
  };

  const handleExportSnapshot = () => {
    const snapshot = buildSnapshot({ books, notes, sessions, deltaLogs });
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pragya-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported Pragya JSON snapshot', 'success');
  };

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const result = validateSnapshotPayload(text);
      if (!result.ok) {
        showToast(`Invalid snapshot JSON: ${result.error}`, 'error');
        return;
      }
      setPendingSnapshot(result.snapshot);
    } catch {
      showToast('Failed to read JSON file', 'error');
    }
  };

  const handleRestorePreImportBackup = async () => {
    const backup = readPreImportBackup();
    if (!backup) return;
    setRestoringBackup(true);
    try {
      await replaceWorkspaceFromSnapshot(backup.snapshot, { backup: false });
      showToast('Restored workspace from pre-import backup', 'success');
    } catch (err) {
      showToast(describeSyncError(err, 'Failed to restore backup'), 'error');
    } finally {
      setRestoringBackup(false);
    }
  };

  return (
    <div data-testid="settings-view" className="py-6 space-y-6">
      <div>
        <h1 className="text-display-l text-foreground tracking-tight">Settings</h1>
        <p className="text-body text-muted-foreground mt-1">
          Manage Google Workspace connection, theme, and snapshot portability.
        </p>
      </div>

      {/* Mode & Sync Card */}
      <section className="bg-card border border-border rounded-[14px] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-[10px] bg-surface2 border border-border flex items-center justify-center shrink-0">
              {!isMockMode && isOfflineReadOnly ? (
                <WifiOff className="w-5 h-5 text-warning" />
              ) : (
                <Cloud className="w-5 h-5 text-foreground" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-heading text-foreground">
                  {isMockMode ? 'Demo Workspace (Offline)' : 'Google Workspace Connected'}
                </h2>
                {!isMockMode && isOfflineReadOnly && (
                  <span
                    data-testid="settings-offline-badge"
                    className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-md bg-warning/15 border border-warning/30 text-warning"
                  >
                    Offline · Cached Read-Only
                  </span>
                )}
              </div>
              <p className="text-label text-muted-foreground truncate">
                {isMockMode
                  ? 'Stored locally in pragya_demo_state_v1 and IndexedDB.'
                  : user?.email || 'Synced with Pragya Commonplace'}
              </p>
            </div>
          </div>

          <button
            type="button"
            data-testid="sync-now-btn"
            disabled={isSyncing}
            onClick={() => void syncNow(true)}
            className="h-11 sm:h-9 px-3.5 rounded-[10px] bg-primary text-primary-foreground text-label font-semibold hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>{isSyncing ? 'Syncing…' : 'Sync Now (R)'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border/60 text-label">
          <div className="min-w-0 p-3 rounded-[10px] bg-surface2/50 border border-border space-y-1">
            <div className="text-eyebrow uppercase text-muted-foreground">Spreadsheet</div>
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span
                data-testid="settings-spreadsheet-id"
                className="min-w-0 font-mono text-foreground truncate"
              >
                {spreadsheetId || (isMockMode ? 'Demo Local Store' : 'Not linked yet')}
              </span>
              {spreadsheetId && (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open Pragya Commonplace Sheet"
                  className="min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 -my-2 -mr-2 sm:m-0 inline-flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0"
                  title="Open Pragya Commonplace Sheet"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          </div>

          <div className="min-w-0 p-3 rounded-[10px] bg-surface2/50 border border-border space-y-1">
            <div className="text-eyebrow uppercase text-muted-foreground">Media Folder</div>
            <div className="flex items-center gap-2 text-foreground min-w-0">
              <FolderOpen className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="min-w-0 truncate">
                {isMockMode
                  ? 'IndexedDB (pragya-demo-media)'
                  : mediaFolderId
                    ? `Pragya Media (${mediaFolderId})`
                    : 'Pragya Media/ (auto-created on upload)'}
              </span>
            </div>
          </div>
        </div>

        {lastSyncedAt && (
          <div className="text-[11px] text-muted-foreground num">
            Last synced: {new Date(lastSyncedAt).toLocaleString()}
          </div>
        )}
      </section>

      {/* Google OAuth Client ID */}
      <section className="bg-card border border-border rounded-[14px] p-5 space-y-3">
        <div>
          <label htmlFor={clientIdInputId} className="text-heading text-foreground block">
            Google OAuth Client ID
          </label>
          <p className="text-label text-muted-foreground mt-0.5">
            Optional runtime override persisted to localStorage (&lsquo;pragya_google_client_id&rsquo;).
          </p>
        </div>
        <form onSubmit={handleSaveClientId} className="flex flex-col sm:flex-row gap-2">
          <input
            id={clientIdInputId}
            type="text"
            enterKeyHint="done"
            data-testid="settings-client-id-input"
            value={clientIdDraft}
            onChange={e => setClientIdDraft(e.target.value)}
            placeholder="your-client-id.apps.googleusercontent.com"
            className="flex-1 h-11 sm:h-10 px-3 rounded-[10px] bg-background border border-input text-base sm:text-body text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <button
            type="submit"
            className="h-11 sm:h-10 px-4 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-body font-medium text-foreground whitespace-nowrap"
          >
            Save Client ID
          </button>
        </form>

        <div className="pt-1">
          <button
            type="button"
            data-testid="settings-oauth-guide-toggle"
            onClick={() => setShowSetupGuide(prev => !prev)}
            aria-expanded={showSetupGuide}
            className="min-h-11 sm:min-h-0 inline-flex items-center gap-1.5 text-label font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <span>Google OAuth Setup Guide &amp; Scope Details</span>
            {showSetupGuide ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
          {showSetupGuide && (
            <div className="mt-2.5">
              <OAuthSetupGuide />
            </div>
          )}
        </div>
      </section>

      {/* Preferences & Portability */}
      <section className="bg-card border border-border rounded-[14px] p-5 space-y-4">
        <h2 className="text-heading text-foreground">Appearance &amp; Portability</h2>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={toggleTheme}
            className="h-11 sm:h-10 px-4 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-body font-medium text-foreground inline-flex items-center gap-2"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            <span>Switch to {theme === 'dark' ? 'Light' : 'Dark'} Mode</span>
          </button>

          <button
            type="button"
            onClick={handleExportSnapshot}
            className="h-11 sm:h-10 px-4 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-body font-medium text-foreground inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            <span>Export JSON Snapshot</span>
          </button>

          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            onChange={e => void handleImportFileChange(e)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="h-11 sm:h-10 px-4 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-body font-medium text-foreground inline-flex items-center gap-2"
          >
            <Upload className="w-4 h-4" />
            <span>Import JSON Snapshot</span>
          </button>

          {preImportBackup && (
            <button
              type="button"
              data-testid="restore-pre-import-backup-btn"
              disabled={restoringBackup}
              onClick={() => setConfirmAction('restore-backup')}
              className="h-11 sm:h-10 px-4 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-body font-medium text-foreground inline-flex items-center gap-2 disabled:opacity-50"
              title={`Saved ${new Date(preImportBackup.savedAt).toLocaleString()}`}
            >
              <History className="w-4 h-4" />
              <span>
                {restoringBackup ? 'Restoring…' : 'Restore Last Pre-Import Backup'}
              </span>
            </button>
          )}

          {isMockMode && (
            <button
              type="button"
              data-testid="reset-demo-btn"
              onClick={() => setConfirmAction('reset-demo')}
              className="h-11 sm:h-10 px-4 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-body font-medium text-foreground inline-flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Reset Demo Data</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => (onLogout ? onLogout() : void logout())}
            className="h-11 sm:h-10 px-4 rounded-[10px] bg-negative/10 hover:bg-negative/20 border border-negative/30 text-body font-medium text-negative inline-flex items-center gap-2 ml-auto"
          >
            <LogOut className="w-4 h-4" />
            <span>Log out</span>
          </button>
        </div>

        {preImportBackup && (
          <div className="text-[11px] text-muted-foreground num">
            Last pre-import backup saved: {new Date(preImportBackup.savedAt).toLocaleString()} (
            {preImportBackup.snapshot.books.length} books, {preImportBackup.snapshot.notes.length}{' '}
            notes)
          </div>
        )}
      </section>

      <ConfirmDialog
        isOpen={confirmAction === 'reset-demo'}
        title="Reset demo data?"
        body="This replaces everything in Demo mode with the original sample books and notes."
        confirmLabel="Reset"
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          setConfirmAction(null);
          void resetDemoWorkspace();
        }}
      />
      <ConfirmDialog
        isOpen={confirmAction === 'restore-backup' && Boolean(preImportBackup)}
        title="Restore your pre-import backup?"
        body={
          preImportBackup
            ? `This replaces your current workspace with the backup saved ${new Date(
                preImportBackup.savedAt
              ).toLocaleString()} (${preImportBackup.snapshot.books.length} books, ${
                preImportBackup.snapshot.notes.length
              } notes). Changes made since then will be lost.`
            : ''
        }
        confirmLabel="Restore Backup"
        busy={restoringBackup}
        onDownloadBackup={handleExportSnapshot}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          // Stays open (buttons disabled via `busy`) until the restore settles.
          void handleRestorePreImportBackup().finally(() => setConfirmAction(null));
        }}
      />

      <ImportConfirmModal
        snapshot={pendingSnapshot}
        onClose={() => setPendingSnapshot(null)}
        onConfirm={async snap => {
          await replaceWorkspaceFromSnapshot(snap);
          showToast('Workspace restored from snapshot', 'success');
        }}
      />
    </div>
  );
};
