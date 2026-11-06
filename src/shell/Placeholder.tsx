import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

/** Stands in for a screen that has not been built yet. */
export function Placeholder({ title, children }: { title: string; children?: React.ReactNode }) {
  useLocale();
  return (
    <div className="view-pad">
      <h1 className="view-title">{title}</h1>
      <p className="muted">{children ?? t('This screen is not built yet.')}</p>
    </div>
  );
}
