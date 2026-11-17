import React from 'react';
import { ErrorFallback } from './ErrorFallback';

interface BoundaryProps {
  children: React.ReactNode;
}

interface BoundaryState {
  error: Error | null;
  hash: string;
}

function currentHash(): string {
  return typeof window !== 'undefined' ? window.location.hash : '';
}

/**
 * B4.10b: top-level boundary so a render bug never white-screens the app. It resets
 * when the route (hash) changes, so navigating away recovers without a reload.
 * No telemetry: details are shown/copied locally only.
 */
export class ErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, hash: currentHash() };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidMount(): void {
    window.addEventListener('hashchange', this.handleHashChange);
  }

  componentWillUnmount(): void {
    window.removeEventListener('hashchange', this.handleHashChange);
  }

  componentDidCatch(error: unknown): void {
    // Local console only (no telemetry).
    console.error('[Pragya] Render error caught by ErrorBoundary:', error);
  }

  private handleHashChange = () => {
    const hash = currentHash();
    if (hash !== this.state.hash) {
      this.setState({ hash, error: null });
    }
  };

  private goToShelf = () => {
    if (currentHash() !== '#/shelf') {
      window.location.hash = '#/shelf';
    }
    this.setState({ error: null, hash: '#/shelf' });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} onGoToShelf={this.goToShelf} />;
    }
    return this.props.children;
  }
}
