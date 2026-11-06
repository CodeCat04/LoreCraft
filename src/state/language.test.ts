import { afterEach } from 'vitest';

import { DEFAULT_SETTINGS } from '../lib/settings';
import { hasDictionary, languageInstruction, WRITING_LANGUAGES } from '../lib/languages';
import { useProjectLanguage, writingLanguage } from './language';
import { useSettings } from './settings';

function setDefault(writing: string) {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, language: { ...DEFAULT_SETTINGS.language, writing } },
  });
}

afterEach(() => {
  useProjectLanguage.setState({ language: null });
  setDefault('en-US');
});

describe('writingLanguage', () => {
  it('uses the app default when the project has not chosen', () => {
    expect(writingLanguage()).toBe('en-US');
    setDefault('fr');
    expect(writingLanguage()).toBe('fr');
  });

  it('prefers the choice of the project', () => {
    setDefault('fr');
    useProjectLanguage.setState({ language: 'ja' });
    expect(writingLanguage()).toBe('ja');
  });

  it('ignores a language it does not know, as a file from a newer version could hold', () => {
    useProjectLanguage.setState({ language: 'tlh' });
    setDefault('es');
    expect(writingLanguage()).toBe('es');
    setDefault('tlh');
    expect(writingLanguage()).toBe('en-US');
  });
});

describe('languages', () => {
  it('has a dictionary for the languages promised, and none for those without spaces', () => {
    for (const code of ['en-US', 'en-GB', 'es', 'fr', 'de', 'pt', 'it', 'ru']) expect(hasDictionary(code), code).toBe(true);
    for (const code of ['zh', 'ja', 'ko', 'ar', 'he', 'th', 'tlh']) expect(hasDictionary(code), code).toBe(false);
  });

  it('gives the AI an instruction in every language but the one it assumes', () => {
    for (const { code, name } of WRITING_LANGUAGES) {
      const instruction = languageInstruction(code);
      if (code === 'en-US') expect(instruction).toBeNull();
      else expect(instruction, code).toContain(`Write in ${name}`);
    }
    expect(languageInstruction('tlh')).toBeNull();
  });
});
