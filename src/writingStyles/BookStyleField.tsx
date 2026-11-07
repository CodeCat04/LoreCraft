/** Book settings' choice of style for one book. It saves as soon as it is chosen. */

import { useId } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { getActiveStyle, resolveEffectiveStyle, setActiveStyle } from './store';
import { StylePicker } from './StylePicker';

export function BookStyleField({ bookId }: { bookId: string }) {
  useLocale();
  const version = useDataVersion('meta');
  const labelId = useId();
  const { data: own, reload } = useLoad(() => getActiveStyle({ kind: 'book', bookId }), [bookId, version]);
  const { data: effective, reload: reloadEffective } = useLoad(() => resolveEffectiveStyle({ bookId }), [bookId, version]);
  const inherited = !own && effective?.name ? t('{name}, from the project', { name: effective.name }) : null;
  return (
    <div className="field" role="group" aria-labelledby={labelId}>
      <span className="field-label" id={labelId}>{t('Writing style')}</span>
      <StylePicker
        label={t('Writing style for this book')}
        value={own?.styleId ?? null}
        fallbackName={own?.name}
        noneLabel={t('Same as the project')}
        onChange={(styleId) => {
          void setActiveStyle({ kind: 'book', bookId }, styleId).then(
            () => {
              reload();
              reloadEffective();
            },
            (e) => toast(errorMessage(e), 'error'),
          );
        }}
      />
      <span className="field-hint">{inherited ?? t('Used for every scene in this book with no style of its own.')}</span>
    </div>
  );
}
