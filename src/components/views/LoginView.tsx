import React, { useId, useRef, useState } from 'react';
import { Moon, Sun, KeyRound, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { showToast } from '../../utils/toast';
import { OAuthSetupGuide } from '../common/OAuthSetupGuide';

export const LoginView: React.FC = () => {
  const { googleClientId, googleClientIdExists, saveGoogleClientId, login, loginAsMock, isLoading } =
    useAuth();
  const { theme, toggleTheme } = useTheme();

  const [showClientConfig, setShowClientConfig] = useState(!googleClientIdExists);
  const [showMissingClientPrompt, setShowMissingClientPrompt] = useState(false);
  const [clientIdDraft, setClientIdDraft] = useState(googleClientId || '');
  const clientIdInputRef = useRef<HTMLInputElement>(null);
  const clientIdFieldId = useId();

  const handleSaveClientId = (e: React.FormEvent) => {
    e.preventDefault();
    saveGoogleClientId(clientIdDraft);
    if (clientIdDraft.trim()) {
      setShowMissingClientPrompt(false);
    }
    showToast(
      clientIdDraft.trim() ? 'Google Client ID saved' : 'Custom Google Client ID cleared',
      'success'
    );
  };

  const handleGoogleSignIn = async () => {
    const result = await login();
    if (!result.ok && result.reason === 'missing_client_id') {
      setShowClientConfig(true);
      setShowMissingClientPrompt(true);
      window.requestAnimationFrame(() => {
        clientIdInputRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        clientIdInputRef.current?.focus();
      });
    }
  };

  return (
    <div
      data-testid="login-view"
      className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-background text-foreground relative"
    >
      <div className="absolute top-5 right-5">
        <button
          type="button"
          onClick={toggleTheme}
          data-testid="login-theme-toggle"
          className="w-11 h-11 sm:w-9 sm:h-9 rounded-[10px] border border-border bg-card hover:bg-surface2 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          title="Toggle Theme"
          aria-label="Toggle Theme"
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>

      <div className="w-full max-w-md bg-card border border-border rounded-[14px] p-6 sm:p-7 shadow-2xl space-y-6">
        <div className="space-y-2 text-center">
          <div className="w-12 h-12 rounded-2xl bg-surface2 border border-border flex items-center justify-center text-2xl mx-auto">
            🪷
          </div>
          <h1 className="text-display-l text-foreground tracking-tight">Pragya</h1>
          <p className="text-body text-muted-foreground">
            A calm, zero-AI commonplace book, reading tracker, and behavioral delta studio synced
            directly to your Google Workspace.
          </p>
        </div>

        <div className="space-y-3">
          <button
            type="button"
            data-testid="google-login-btn"
            disabled={isLoading}
            onClick={() => void handleGoogleSignIn()}
            className="w-full h-11 rounded-[10px] bg-primary text-primary-foreground font-semibold text-body flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <span>Sign in with Google</span>
          </button>

          <button
            type="button"
            data-testid="demo-login-btn"
            onClick={() => void loginAsMock()}
            className="w-full h-11 rounded-[10px] bg-surface2 hover:bg-secondary border border-border text-foreground font-semibold text-body transition-colors"
          >
            Continue in Demo Mode
          </button>
        </div>

        <div className="pt-2 border-t border-border/60">
          <button
            type="button"
            onClick={() => setShowClientConfig(prev => !prev)}
            aria-expanded={showClientConfig}
            className="w-full min-h-11 sm:min-h-0 flex items-center justify-between text-label text-muted-foreground hover:text-foreground py-1 transition-colors"
          >
            <span className="inline-flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5" />
              <span>
                Google OAuth Client ID {googleClientIdExists ? '(Configured)' : '(Optional)'}
              </span>
            </span>
            {showClientConfig ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>

          {showClientConfig && (
            <div className="mt-3 space-y-3">
              {showMissingClientPrompt && !googleClientIdExists && (
                <div
                  data-testid="missing-client-id-prompt"
                  role="status"
                  className="rounded-[8px] bg-surface2 border border-border px-3 py-2 text-label text-foreground"
                >
                  Paste your Google OAuth Client ID below or explore offline in Demo Mode.
                </div>
              )}

              <form onSubmit={handleSaveClientId} className="space-y-2">
                <label htmlFor={clientIdFieldId} className="sr-only">
                  Google OAuth Client ID
                </label>
                <input
                  id={clientIdFieldId}
                  ref={clientIdInputRef}
                  type="text"
                  enterKeyHint="done"
                  data-testid="client-id-input"
                  value={clientIdDraft}
                  onChange={e => setClientIdDraft(e.target.value)}
                  placeholder="xxx.apps.googleusercontent.com"
                  className="w-full h-11 sm:h-9 px-3 rounded-[8px] bg-background border border-input text-base sm:text-label text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    Stored locally in your browser.
                  </span>
                  <button
                    type="submit"
                    data-testid="client-id-save-btn"
                    className="h-11 sm:h-8 px-3 rounded-[8px] bg-surface2 border border-border hover:bg-secondary text-label font-medium text-foreground transition-colors whitespace-nowrap"
                  >
                    Save Client ID
                  </button>
                </div>
              </form>

              <OAuthSetupGuide compact />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
