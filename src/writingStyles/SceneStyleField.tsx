/** The scene details panel's choice of style for one scene. */

import { useId } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { getActiveStyle, resolveEffectiveStyle, setActiveStyle } from './store';
import { StylePicker } from './StylePicker';

function inheritedText(name: string, level: string): string {
  if (level === 'book') return t('{name}, from the book', { name });
  if (level === 'project') return t('{name}, from the project', { name });
  return `${name}, from the ${level}`;
}

export function SceneStyleField({ nodeId }: { nodeId: string }) {
  useLocale();
  const version = useDataVersion('meta');
  const labelId = useId();
  const { data: own } = useLoad(() => getActiveStyle({ kind: 'scene', nodeId }), [nodeId, version]);
  const { data: effective } = useLoad(() => resolveEffectiveStyle({ nodeId }), [nodeId, version]);
  const inherited = !own && effective?.name ? inheritedText(effective.name, effective.level) : null;
  return (
    <div className="field">
      <span className="field-label" id={labelId}>{t('Writing style')}</span>
      <StylePicker
        label={t('Writing style for this scene')}
        value={own?.styleId ?? null}
        fallbackName={own?.name}
        noneLabel={t('Same as the book or project')}
        onChange={(styleId) => {
          void setActiveStyle({ kind: 'scene', nodeId }, styleId).catch((e) => toast(errorMessage(e), 'error'));
        }}
      />
      {inherited && <span className="field-hint">{inherited}</span>}
    </div>
  );
}
