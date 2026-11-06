/** Settings > Language: the language of the interface, of new projects and of this project. */

import { INTERFACE_LANGUAGES, t } from '../lib/i18n';
import { WRITING_LANGUAGES, hasDictionary, languageInfo } from '../lib/languages';
import {
  changeInterfaceLanguage,
  setProjectLanguage,
  useLocale,
  useProjectLanguage,
  useWritingLanguage,
} from '../state/language';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { toast } from '../shell/toasts';
import { errorMessage } from '../lib/rpc';

function languageOptions() {
  return WRITING_LANGUAGES.map((language) => (
    <option key={language.code} value={language.code}>
      {language.nativeName}
    </option>
  ));
}

/** Says when spellcheck has no dictionary to use. Other than that, it just works. */
export function SpellcheckLanguageNote() {
  useLocale();
  const language = useWritingLanguage();
  const spellcheck = useSettings((s) => s.settings.editor.spellcheck);
  if (!spellcheck || hasDictionary(language)) return null;
  return (
    <span className="field-hint language-note" data-testid="spellcheck-off-note">
      {t('Spellcheck is off, because LoreCraft has no dictionary for {language} yet.', {
        language: languageInfo(language)?.nativeName ?? language,
      })}
    </span>
  );
}

export function LanguageSettings() {
  useLocale();
  const language = useSettings((s) => s.settings.language);
  const update = useSettings((s) => s.update);
  const projectOpen = useProject((s) => s.status.open);
  const projectLanguage = useProjectLanguage((s) => s.language);
  const defaultName = languageInfo(language.writing)?.nativeName ?? language.writing;

  return (
    <section>
      <label className="field language-field">
        <span className="field-label">{t('Interface language')}</span>
        <select
          className="select"
          data-testid="interface-language"
          value={language.interface}
          onChange={(e) => void changeInterfaceLanguage(e.target.value)}
        >
          {INTERFACE_LANGUAGES.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
            </option>
          ))}
        </select>
        <span className="field-hint">
          {t(
            'The menus and messages are being translated a part at a time. These translations were made by machine, and anyone can improve them: they are plain files in src/locales, in the project on GitHub.',
          )}
        </span>
      </label>
      {projectOpen && (
        <label className="field language-field">
          <span className="field-label">{t('Language of this project')}</span>
          <select
            className="select"
            data-testid="project-language"
            value={projectLanguage ?? ''}
            onChange={(e) => {
              setProjectLanguage(e.target.value).catch((error) => {
                toast(t('Could not change the language: {reason}', { reason: errorMessage(error) }), 'error');
              });
            }}
          >
            <option value="">{t('The default: {language}', { language: defaultName })}</option>
            {languageOptions()}
          </select>
          <span className="field-hint">
            {t('Spellcheck uses this language, and the AI writes in it unless you ask for another.')}
          </span>
          <SpellcheckLanguageNote />
        </label>
      )}
      <label className="field language-field">
        <span className="field-label">{t('Default language for projects')}</span>
        <select
          className="select"
          data-testid="default-language"
          value={language.writing}
          onChange={(e) => void update({ language: { writing: e.target.value } })}
        >
          {languageOptions()}
        </select>
        <span className="field-hint">{t('Any project that has not chosen its own language uses this one.')}</span>
        {!projectOpen && <SpellcheckLanguageNote />}
      </label>
    </section>
  );
}
