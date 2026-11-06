/** The status bar's view of search by meaning. Says nothing once there is nothing to say. */

import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { formatNumber } from '../lib/text';
import { resumeIndexing, stopDownload, stopIndexing, useMeaning } from './store';

export function megabytes(bytes: number): string {
  return `${formatNumber(Math.round(bytes / 1_000_000))} MB`;
}

export function MeaningStatusItem() {
  useLocale();
  const status = useMeaning((s) => s.status);
  const go = useNav((s) => s.go);
  if (!status) return null;
  const openSettings = () => go({ view: 'settings', tab: 'ai' });
  switch (status.state) {
    case 'downloading':
      return (
        <span className="status-item meaning-status" data-testid="meaning-status">
          {t('Downloading model, {done} of {total}', { done: megabytes(status.downloaded), total: megabytes(status.downloadTotal) })}{' '}
          <button type="button" className="link-button" onClick={() => void stopDownload()}>{t('Stop')}</button>
        </span>
      );
    case 'indexing':
      return (
        <span className="status-item meaning-status" data-testid="meaning-status">
          {t('Indexing {done} of {total}', { done: formatNumber(status.done), total: formatNumber(status.total) })}{' '}
          <button type="button" className="link-button" onClick={() => void stopIndexing()}>{t('Stop')}</button>
        </span>
      );
    case 'paused':
      return (
        <span className="status-item meaning-status" data-testid="meaning-status">
          {t('Indexing stopped at {done} of {total}', { done: formatNumber(status.done), total: formatNumber(status.total) })}{' '}
          <button type="button" className="link-button" onClick={() => void resumeIndexing()}>{t('Resume')}</button>
        </span>
      );
    case 'failed':
      return (
        <span className="status-item meaning-status" data-testid="meaning-status">
          <button type="button" className="link-button meaning-failed" title={status.message ?? undefined} onClick={openSettings}>
            {t('Search by meaning failed')}
          </button>
        </span>
      );
    default:
      return null;
  }
}
