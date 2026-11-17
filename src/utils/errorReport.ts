/**
 * Plain-text technical details for the top-level ErrorBoundary fallback (B4.10b).
 * No stack trace by default and no telemetry: the text is only shown/copied locally.
 */
export function formatErrorReport(
  error: unknown,
  context: { route?: string; when?: string; userAgent?: string } = {}
): string {
  let name = 'Error';
  let message = '';
  if (error instanceof Error) {
    name = error.name || 'Error';
    message = error.message || '';
  } else if (typeof error === 'string') {
    message = error;
  } else {
    try {
      message = JSON.stringify(error) ?? String(error);
    } catch {
      message = String(error);
    }
  }
  const lines = [`${name}: ${message || '(no message)'}`];
  if (context.route) lines.push(`Route: ${context.route}`);
  if (context.when) lines.push(`When: ${context.when}`);
  if (context.userAgent) lines.push(`Browser: ${context.userAgent}`);
  return lines.join('\n');
}
