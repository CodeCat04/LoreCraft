/**
 * The languages a project can be written in. A project's language decides which spelling
 * dictionary loads and what language the AI writes in.
 */

export interface WritingLanguage {
  /** A language tag, stored in the project's `language` meta value. */
  code: string;
  /** In English, for the AI. */
  name: string;
  /** As its own writers name it, which is how people look for it in a list. */
  nativeName: string;
  /** The script its dictionary covers. Words in other scripts are not checked. */
  dictionaryScript?: 'latin' | 'cyrillic';
}

export const DEFAULT_WRITING_LANGUAGE = 'en-US';

export const WRITING_LANGUAGES: WritingLanguage[] = [
  { code: 'en-US', name: 'American English', nativeName: 'English (United States)', dictionaryScript: 'latin' },
  { code: 'en-GB', name: 'British English', nativeName: 'English (United Kingdom)', dictionaryScript: 'latin' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', dictionaryScript: 'latin' },
  { code: 'fr', name: 'French', nativeName: 'Français', dictionaryScript: 'latin' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', dictionaryScript: 'latin' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', dictionaryScript: 'latin' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', dictionaryScript: 'latin' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', dictionaryScript: 'cyrillic' },
  { code: 'zh', name: 'Chinese', nativeName: '中文' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
];

export function languageInfo(code: string): WritingLanguage | undefined {
  return WRITING_LANGUAGES.find((language) => language.code === code);
}

/** Whether the spellchecker can work in this language. */
export function hasDictionary(code: string): boolean {
  return languageInfo(code)?.dictionaryScript !== undefined;
}

/**
 * What the AI is told about a project's language, or null when there is nothing to say: a
 * model writes American English unless told otherwise, or follows the text it is shown.
 */
export function languageInstruction(code: string): string | null {
  if (code === DEFAULT_WRITING_LANGUAGE) return null;
  const language = languageInfo(code);
  if (!language) return null;
  return (
    `This project is written in ${language.name}. Write in ${language.name}, whatever language ` +
    `this message or these instructions are in, unless the writer's own request explicitly asks ` +
    `for another language. Keep the names of people and places as the project spells them.`
  );
}
