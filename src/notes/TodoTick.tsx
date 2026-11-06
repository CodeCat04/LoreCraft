import { useEffect, useState } from 'react';

import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

/** The box on a to-do. It answers the click at once, and the stored value follows. */
export function TodoTick(props: { done: boolean; className: string; onChange: (done: boolean) => void }) {
  useLocale();
  const [shown, setShown] = useState(props.done);
  useEffect(() => setShown(props.done), [props.done]);
  return (
    <input
      type="checkbox"
      className={props.className}
      checked={shown}
      aria-label={shown ? t('To-do is done. Mark as not done') : t('Mark to-do as done')}
      onChange={(e) => {
        setShown(e.target.checked);
        props.onChange(e.target.checked);
      }}
    />
  );
}
