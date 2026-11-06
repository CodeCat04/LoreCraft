import { Component, type ErrorInfo, type ReactNode } from 'react';

import { reportError } from '../support/errorReporting';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  useLocale();
  return (
    <div className="view-pad" role="alert">
      <h1 className="view-title">{t('This screen hit a problem')}</h1>
      <p>{t('Your work is safe. Every saved edit is already in the recovery copy.')}</p>
      <pre className="error-detail">{message}</pre>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        {t('Try again')}
      </button>
    </div>
  );
}

/** Keeps a bug in one screen from taking the whole window down. */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: unknown },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
    reportError('react', error);
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <ErrorNotice message={this.state.error.message} onRetry={() => this.setState({ error: null })} />;
  }
}
