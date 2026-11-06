/** The monthly cloud limit, in Settings > AI. */

import { t } from '../../lib/i18n';
import { useLocale } from '../../state/language';
import { useSettings } from '../../state/settings';
import { money, spendingState, WARN_AT } from './spending';

export function SpendingSettings() {
  useLocale();
  // Read for the re-render. The state below is worked out from the same settings.
  const stored = useSettings((s) => s.settings.ai.spending);
  const update = useSettings((s) => s.update);
  const state = spendingState();
  const share = state.limitUsd > 0 ? Math.round((state.spentUsd / state.limitUsd) * 100) : null;

  return (
    <div className="ai-settings-card" data-testid="ai-spending">
      <label className="field">
        <span className="field-label">{t('Monthly cloud spending limit, in dollars')}</span>
        <input
          className="input ai-settings-short"
          type="number"
          min={0}
          step={1}
          value={stored.limitUsd > 0 ? stored.limitUsd : ''}
          placeholder={t('No limit')}
          onChange={(e) => void update({ ai: { spending: { limitUsd: Math.max(0, Number(e.target.value) || 0) } } })}
        />
        <span className="field-hint">
          {t('You are warned at {percent} percent. At the limit, nothing more goes to a cloud provider unless you allow it. Costs come from the prices set on each profile, so a profile with no prices counts as free. Local profiles do not count.', { percent: Math.round(WARN_AT * 100) })}
        </span>
      </label>
      <p className="ai-settings-spent" data-testid="ai-spent">
        {share !== null
          ? t('Spent this month: about {spent} of {limit} ({percent}%).', { spent: money(state.spentUsd), limit: money(state.limitUsd), percent: share })
          : t('Spent this month: about {spent}.', { spent: money(state.spentUsd) })}
      </p>
      {state.overridden && (
        <p className="ai-note">
          {t('You chose to go past the limit this month.')}{' '}
          <button type="button" className="link-button" onClick={() => void update({ ai: { spending: { overrideMonth: '' } } })}>
            {t('Apply the limit again')}
          </button>
        </p>
      )}
    </div>
  );
}
