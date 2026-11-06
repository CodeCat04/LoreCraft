/**
 * One dictionary per language. They ship as files beside the app, each with its license,
 * rather than inside it, because some are under the GPL (see THIRD_PARTY_NOTICES.md). The
 * content security policy lets the web view fetch nothing, and a worker cannot call Rust,
 * so the client reads them through `files.readResource` and hands them to the worker.
 *
 * Nothing here may import a `dictionary-*` package, which would compile it into the app.
 * `spellcheck.test.ts` checks that.
 */

import { rpc } from '../../lib/rpc';

export interface DictionaryFiles {
  aff: string;
  dic: string;
}

/** Each has a folder of that name under `dictionaries/`. See `bundle.resources` in tauri.conf.json. */
export const DICTIONARY_LANGUAGES: readonly string[] = ['en-US', 'en-GB', 'es', 'fr', 'de', 'pt', 'it', 'ru'];

async function readResource(name: string): Promise<string> {
  const { text } = await rpc<{ text: string }>('files.readResource', { name });
  return text;
}

export async function loadDictionary(language: string): Promise<DictionaryFiles> {
  if (!DICTIONARY_LANGUAGES.includes(language)) throw new Error(`There is no dictionary for ${language}.`);
  const folder = `dictionaries/${language}`;
  const [aff, dic] = await Promise.all([readResource(`${folder}/index.aff`), readResource(`${folder}/index.dic`)]);
  return { aff, dic };
}
