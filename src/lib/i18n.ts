/**
 * Translating the interface. The English text is the key, so code stays readable and a
 * missing translation falls back to English:
 *
 *   t('Open project…')
 *   t('Save changes to {name}?', { name })
 *
 * Put the whole sentence in one `t()` with `{placeholders}`, because the order of words
 * changes between languages. Never build a sentence by joining translated pieces. The text
 * must be written out in the call, so `scripts/i18n-extract.mjs` can find it.
 *
 * Catalogs are `src/locales/<code>.json`, a map of English text to its translation, plus
 * any module catalogs in `src/locales/<code>/*.json`, merged in. Each language loads when
 * chosen. This file has no React in it, so workers can use `lib/text.ts`.
 */

type Catalog = Record<string, string>;

export const INTERFACE_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
];

const catalogs = import.meta.glob<{ default: Catalog }>('../locales/**/*.json');

/** The catalogs that make up one language: the main one, then each module's. */
function catalogsFor(code: string) {
  return Object.entries(catalogs)
    .filter(([path]) => path === `../locales/${code}.json` || path.startsWith(`../locales/${code}/`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, load]) => load);
}

let locale = 'en';
let catalog: Catalog = {};
let latestRequest = 0;
const listeners = new Set<() => void>();

/** The interface text for this English text, with `{placeholders}` filled in. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const template = catalog[text] || text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export function currentLocale(): string {
  return locale;
}

/** Switches the interface language. An unknown one, or a catalog that cannot load, means English. */
export async function setLocale(code: string): Promise<void> {
  latestRequest += 1;
  const request = latestRequest;
  let next: Catalog = {};
  let nextLocale = 'en';
  const loads = catalogsFor(code);
  if (loads.length > 0) {
    try {
      const parts = await Promise.all(loads.map((load) => load()));
      next = Object.assign({}, ...parts.map((part) => part.default));
      nextLocale = code;
    } catch (e) {
      console.warn(`Could not load the ${code} interface text: ${String(e)}`);
    }
  }
  // A slow catalog must not replace one chosen after it.
  if (request !== latestRequest) return;
  locale = nextLocale;
  catalog = next;
  if (typeof document !== 'undefined') document.documentElement.lang = nextLocale;
  listeners.forEach((listener) => listener());
}

/** Calls back after the language changes. Returns how to stop. */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
