/** Mixing up to three styles into one, which can be copied or saved as a custom style. */

import { useMemo } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { promptText } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { useSettings } from '../state/settings';
import { copyText } from './BrowseTab';
import { blendStyles, buildStylePrompt, countWords } from './prompt';
import { getStyle, saveCustomStyle } from './store';
import { StylePicker } from './StylePicker';
import { BLEND_WEIGHTS, blendWeightLabel, type BlendPart, type BlendWeight } from './types';
import { goToTab, useStylesUi } from './uiStore';

export function BlendTab() {
  useLocale();
  const slots = useStylesUi((s) => s.slots);
  const set = useStylesUi((s) => s.set);
  const custom = useSettings((s) => s.settings.writingStyles.custom);

  const parts = useMemo<BlendPart[]>(
    () =>
      slots.flatMap((slot) => {
        const style = slot.styleId ? getStyle(slot.styleId) : undefined;
        return style ? [{ style, weight: slot.weight }] : [];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slots, custom],
  );
  const blend = useMemo(() => (parts.length >= 2 ? blendStyles(parts) : null), [parts]);
  const prompt = blend ? buildStylePrompt(blend) : '';
  const words = countWords(prompt);

  const save = async () => {
    if (!blend) return;
    const name = await promptText({
      title: t('Save this blend'),
      label: t('Name'),
      initial: blend.name,
      confirmLabel: t('Save'),
      validate: (v) => (v.trim() ? null : t('A style needs a name.')),
    });
    if (!name) return;
    try {
      const saved = await saveCustomStyle({ ...blend, name: name.trim() });
      toast(t('Saved {name} to your styles.', { name: saved.name }), 'success');
      set({ kind: 'custom', selectedId: saved.id, query: '', genre: '', favoritesOnly: false });
      goToTab('browse');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const updateSlot = (index: number, patch: Partial<(typeof slots)[number]>) => {
    set({ slots: slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)) });
  };

  return (
    <div className="styles-scroll">
      <div className="styles-narrow">
        <p className="muted styles-intro">
          {t('Choose two or three styles and say roughly how much of each you want. The heaviest style leads. Each part of the prose then follows one style only, so the instructions cannot pull against each other.')}
        </p>
        <div className="styles-blend-slots">
          {slots.map((slot, i) => (
            <div key={i} className="styles-blend-slot" role="group" aria-label={t('Style {number} in the blend', { number: i + 1 })}>
              <StylePicker
                label={t('Style {number}', { number: i + 1 })}
                value={slot.styleId}
                noneLabel={t('Choose a style')}
                onChange={(styleId) => updateSlot(i, { styleId })}
              />
              <select
                className="select"
                aria-label={t('How much of style {number}', { number: i + 1 })}
                value={slot.weight}
                onChange={(e) => updateSlot(i, { weight: e.target.value as BlendWeight })}
              >
                {BLEND_WEIGHTS.map((w) => <option key={w.id} value={w.id}>{blendWeightLabel(w.id)}</option>)}
              </select>
            </div>
          ))}
        </div>

        {!blend && (
          <div className="styles-empty">
            <p>{t('Choose at least two styles to see the blend.')}</p>
            <p className="muted">{t('You can also press Blend on any style in Browse.')}</p>
          </div>
        )}

        {blend && (
          <section className="styles-section">
            <div className="styles-section-head">
              <h3>{blend.name}</h3>
              <span className="faint small">{words === 1 ? t('1 word') : t('{count} words', { count: words })}</span>
            </div>
            <pre className="styles-prompt" tabIndex={0} aria-label={t('Prompt for this blend')} data-testid="blend-prompt">{prompt}</pre>
            <div className="styles-actions">
              <button type="button" className="btn btn-primary" onClick={() => void save()}>{t('Save as a custom style')}</button>
              <button type="button" className="btn" onClick={() => void copyText(prompt, t('Prompt copied.'))}>{t('Copy prompt')}</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
