import React from 'react';
import { RefreshCw } from 'lucide-react';
import { formatErrorReport } from '../../utils/errorReport';
import { BTN_PRIMARY, BTN_SECONDARY, BTN_TERTIARY } from './uiClasses';

export interface ErrorFallbackProps {
  error: Error;
  onGoToShelf: () => void;
}

/** ux_spec D.1 — self-contained (no React context), tokens only, never auto-reloads. */
export const ErrorFallback: React.FC<ErrorFallbackProps> = ({ error, onGoToShelf }) => {
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = React.useState(false);
  const details = formatErrorReport(error);

  React.useEffect(() => {
    headingRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    const report = formatErrorReport(error, {
      route: typeof window !== 'undefined' ? window.location.hash : '',
      when: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    });
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context): the details stay visible to select.
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background p-4">
      <div
        data-testid="error-boundary-fallback"
        role="alert"
        className="bg-card border border-border rounded-[14px] p-6 w-full max-w-md space-y-4 shadow-2xl"
      >
        <div className="flex items-center gap-2 text-heading text-foreground">
          <span aria-hidden="true">🪷</span>
          <span>Pragya</span>
        </div>
        <h1 ref={headingRef} tabIndex={-1} className="text-title text-foreground outline-none">
          Something went wrong on this screen
        </h1>
        <p className="text-body text-muted-foreground">
          Your notes are safe — they live in your Google Sheet (or in this browser in Demo mode).
          Unsaved capture drafts stay on this device.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="error-reload-btn"
            className={BTN_PRIMARY}
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            Reload Pragya
          </button>
          <button
            type="button"
            data-testid="error-go-shelf-btn"
            className={BTN_SECONDARY}
            onClick={onGoToShelf}
          >
            Go to Shelf
          </button>
        </div>
        <details className="space-y-2">
          <summary className={`${BTN_TERTIARY} cursor-pointer`}>Technical details</summary>
          <pre className="font-mono text-label text-muted-foreground bg-surface2 border border-border rounded-[10px] p-3 max-h-40 overflow-auto whitespace-pre-wrap">
            {details}
          </pre>
          <button
            type="button"
            data-testid="error-copy-details-btn"
            className={BTN_SECONDARY}
            onClick={() => void handleCopy()}
          >
            <span aria-live="polite">{copied ? 'Copied' : 'Copy details'}</span>
          </button>
        </details>
      </div>
    </div>
  );
};

