/** The "Updates and logs" tab in Settings. */

import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { useSettings } from '../state/settings';
import { copyDiagnostics, openLogFolder } from './actions';
import { checkForUpdatesByHand } from './updates';

export function SupportSettings() {
  useLocale();
  const checkAtStartup = useSettings((s) => s.settings.updates.checkAtStartup);
  const update = useSettings((s) => s.update);
  return (
    <section className="support-settings">
      <h2 className="field-label">{t('Updates')}</h2>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={checkAtStartup}
          onChange={(e) => void update({ updates: { checkAtStartup: e.target.checked } })}
        />
        <span>
          {t('Check for updates at startup')}
          <span className="field-hint">
            {t(
              'Off by default, because LoreCraft otherwise makes no network calls on its own. It asks GitHub for the latest version number and sends nothing about you. Nothing is installed automatically.',
            )}
          </span>
        </span>
      </label>
      <div className="support-actions">
        <button type="button" className="btn" onClick={() => void checkForUpdatesByHand()}>{t('Check now')}</button>
      </div>
      <h2 className="field-label">{t('Logs')}</h2>
      <p className="muted support-hint">
        {t(
          'LoreCraft records errors in log files on this computer. They hold error messages and codes, and never your writing, your lore, AI prompts or replies, keys or file contents. Nothing is sent anywhere.',
        )}
      </p>
      <div className="support-actions">
        <button type="button" className="btn" onClick={() => void openLogFolder()}>{t('Open log folder')}</button>
        <button type="button" className="btn" onClick={() => void copyDiagnostics()}>{t('Copy diagnostics')}</button>
      </div>
    </section>
  );
}
