import { openBackups } from './BackupsDialog';
import { newProject, openProject } from './fileActions';
import { openAbout, openGettingStarted, openSampleWorld, openShortcuts } from '../help';
import { changeInterfaceLanguage, useLocale } from '../state/language';
import { useSettings } from '../state/settings';
import { INTERFACE_LANGUAGES, t } from '../lib/i18n';
import { relativeTime } from '../lib/text';
import * as api from '../lib/api';

/** Shown when no project is open. */
export function StartScreen() {
  useLocale();
  const recent = useSettings((s) => s.settings.recent);
  const interfaceLanguage = useSettings((s) => s.settings.language.interface);
  const update = useSettings((s) => s.update);

  const forget = async (path: string) => {
    await api.settings.removeRecent(path);
    await update({ recent: recent.filter((r) => r.path !== path) });
  };

  return (
    <div className="start">
      <div className="start-card">
        <h1 className="start-title">LoreCraft</h1>
        <p className="muted">{t('Your world, your novel, and an AI that remembers both.')}</p>
        <div className="start-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => void newProject()}>
            {t('New project')}
          </button>
          <button type="button" className="btn btn-lg" onClick={() => void openProject()}>
            {t('Open project…')}
          </button>
          <button type="button" className="btn btn-lg" onClick={() => void openSampleWorld()}>
            Open sample world
          </button>
        </div>
        {recent.length > 0 && (
          <section className="start-recent">
            <h2 className="start-recent-title">{t('Recent')}</h2>
            <ul className="start-recent-list">
              {recent.slice(0, 8).map((file) => (
                <li key={file.path} className="start-recent-item">
                  <button
                    type="button"
                    className="link-button start-recent-open"
                    title={file.path}
                    onClick={() => void openProject(file.path)}
                  >
                    <span className="start-recent-name">{file.name}</span>
                    <span className="start-recent-path">{file.path}</span>
                  </button>
                  <span className="muted small">{relativeTime(file.openedAt)}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('Remove from this list')}
                    aria-label={t('Remove {name} from this list', { name: file.name })}
                    onClick={() => void forget(file.path)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {/* There is no menu bar here, so these stand in for the Help menu. */}
        <nav className="start-help" aria-label={t('Help')}>
          <button type="button" className="link-button" onClick={() => void openGettingStarted()}>{t('Getting started')}</button>
          <button type="button" className="link-button" onClick={() => void openShortcuts()}>{t('Keyboard shortcuts')}</button>
          <button type="button" className="link-button" onClick={() => void openBackups()}>{t('Backups')}</button>
          <button type="button" className="link-button" onClick={() => void openAbout()}>{t('About')}</button>
        </nav>
        <label className="start-language">
          <span className="start-language-label">{t('Interface language')}</span>
          <select
            className="select"
            data-testid="start-interface-language"
            value={interfaceLanguage}
            onChange={(e) => void changeInterfaceLanguage(e.target.value)}
          >
            {INTERFACE_LANGUAGES.map((option) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
