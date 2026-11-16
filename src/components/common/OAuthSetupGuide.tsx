import React, { useState } from 'react';
import { Check, Copy, Info } from 'lucide-react';
import { showToast } from '../../utils/toast';

export interface OAuthSetupGuideProps {
  compact?: boolean;
}

export const OAuthSetupGuide: React.FC<OAuthSetupGuideProps> = ({ compact = false }) => {
  const [copiedField, setCopiedField] = useState<'origin' | 'redirect' | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const redirectUri =
    typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : '';

  const copyValue = async (field: 'origin' | 'redirect', value: string, label: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        showToast(`Copy manually: ${value}`, 'info');
        return;
      }
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      showToast(`Copied ${label}`, 'info');
      window.setTimeout(() => {
        setCopiedField(prev => (prev === field ? null : prev));
      }, 2000);
    } catch {
      showToast(`Copy manually: ${value}`, 'info');
    }
  };

  return (
    <div
      data-testid="oauth-setup-guide"
      className={`rounded-[10px] bg-surface2/70 border border-border text-label text-muted-foreground space-y-2.5 ${
        compact ? 'p-3' : 'p-4'
      }`}
    >
      <div className="flex items-center gap-1.5 text-foreground font-semibold">
        <Info className="w-3.5 h-3.5 shrink-0" />
        <span>Google OAuth Setup Guide</span>
      </div>

      <div className="space-y-2">
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-foreground">Authorized JavaScript Origin</div>
          <div className="flex items-center gap-1.5 min-w-0">
            <code
              data-testid="oauth-guide-origin"
              className="flex-1 min-w-0 truncate px-2 py-1 rounded bg-background border border-border font-mono text-[11px] text-foreground"
            >
              {origin}
            </code>
            <button
              type="button"
              data-testid="oauth-copy-origin-btn"
              onClick={() => void copyValue('origin', origin, 'Authorized Origin')}
              className="h-7 px-2 rounded bg-background border border-border hover:bg-secondary text-[11px] text-foreground inline-flex items-center gap-1 shrink-0"
              aria-label="Copy Authorized JavaScript Origin"
            >
              {copiedField === 'origin' ? (
                <Check className="w-3 h-3 text-positive" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              <span>{copiedField === 'origin' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-[11px] font-medium text-foreground">Authorized Redirect URI</div>
          <div className="flex items-center gap-1.5 min-w-0">
            <code
              data-testid="oauth-guide-redirect"
              className="flex-1 min-w-0 truncate px-2 py-1 rounded bg-background border border-border font-mono text-[11px] text-foreground"
            >
              {redirectUri}
            </code>
            <button
              type="button"
              data-testid="oauth-copy-redirect-btn"
              onClick={() => void copyValue('redirect', redirectUri, 'Redirect URI')}
              className="h-7 px-2 rounded bg-background border border-border hover:bg-secondary text-[11px] text-foreground inline-flex items-center gap-1 shrink-0"
              aria-label="Copy Authorized Redirect URI"
            >
              {copiedField === 'redirect' ? (
                <Check className="w-3 h-3 text-positive" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              <span>{copiedField === 'redirect' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
      </div>

      <ul className="space-y-1 text-[11px] leading-relaxed">
        <li>
          <strong className="text-foreground">Enable GCP APIs:</strong> Google Sheets API, Google
          Drive API (plus Google Docs API if using <code className="font-mono">pragya-companion</code>
          ).
        </li>
        <li>
          <strong className="text-foreground">Testing Mode:</strong> Add your Google account under
          OAuth Consent Screen &rarr; Test Users.
        </li>
        <li>
          <strong className="text-foreground">Why drive.readonly:</strong> Used to read{' '}
          <code className="font-mono">Pragya Commonplace</code> Sheet{' '}
          <code className="font-mono">modifiedTime</code> for fast reloads, display private images
          uploaded by <code className="font-mono">pragya-companion</code> in{' '}
          <code className="font-mono">Pragya Media/</code>, and resolve attached Google Doc titles.
        </li>
      </ul>
    </div>
  );
};
