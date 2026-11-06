/** Marks the open document local only, from the "What is sent" tab. */

import { useEffect, useState } from 'react';

import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { toast } from '../../shell/toasts';
import { useLocale } from '../../state/language';
import { isSourceLocalOnly, setSourceLocalOnly } from './localOnly';

type Source = { kind: 'page' | 'node' | 'notes'; id: string; title: string };

export function LocalOnlyToggle({ source, onChanged }: { source: Source; onChanged: () => void }) {
  useLocale();
  const [marked, setMarked] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setMarked(null);
    void isSourceLocalOnly(source).then((value) => {
      if (!cancelled) setMarked(value);
    });
    return () => {
      cancelled = true;
    };
  }, [source.kind, source.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <label className="checkbox ai-context-local">
      <input
        type="checkbox"
        disabled={marked === null}
        checked={marked === true}
        onChange={(e) => {
          const next = e.target.checked;
          setMarked(next);
          setSourceLocalOnly(source, next).then(onChanged).catch((problem: unknown) => {
            setMarked(!next);
            toast(errorMessage(problem), 'error');
          });
        }}
      />
      <span>{t('Local only: never send “{title}” to a cloud provider', { title: source.title })}</span>
    </label>
  );
}
