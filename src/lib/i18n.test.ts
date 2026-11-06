import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach } from 'vitest';

import { INTERFACE_LANGUAGES, currentLocale, setLocale, subscribeLocale, t } from './i18n';
import { relativeTime } from './text';

afterEach(async () => {
  await setLocale('en');
});

describe('t', () => {
  it('uses the English text when there is no translation', async () => {
    expect(t('Open project…')).toBe('Open project…');
    await setLocale('es');
    expect(t('No such text anywhere')).toBe('No such text anywhere');
  });

  it('translates once a language is chosen', async () => {
    await setLocale('es');
    expect(currentLocale()).toBe('es');
    expect(t('New project')).toBe('Nuevo proyecto');
    await setLocale('fr');
    expect(t('New project')).toBe('Nouveau projet');
    await setLocale('de');
    expect(t('New project')).toBe('Neues Projekt');
    await setLocale('en');
    expect(t('New project')).toBe('New project');
  });

  it('fills in placeholders wherever a language puts them', async () => {
    expect(t('Save changes to {name}?', { name: 'Vale' })).toBe('Save changes to Vale?');
    await setLocale('de');
    expect(t('Remove {name} from this list', { name: 'Vale' })).toBe('Vale aus dieser Liste entfernen');
    expect(t('Save changes to {name}?', { name: '$& {name}' })).toBe('Änderungen an $& {name} speichern?');
  });

  it('leaves a placeholder with no value in view, and accepts numbers', () => {
    expect(t('{a} and {b}', { a: 1 })).toBe('1 and {b}');
  });

  it('falls back to English for an unknown language', async () => {
    await setLocale('xx');
    expect(currentLocale()).toBe('en');
    expect(t('New project')).toBe('New project');
  });

  it('keeps the last language chosen, even if an earlier one loads later', async () => {
    await Promise.all([setLocale('es'), setLocale('de')]);
    expect(currentLocale()).toBe('de');
  });

  it('marks the document with the language and tells listeners', async () => {
    let told = 0;
    const stop = subscribeLocale(() => {
      told += 1;
    });
    await setLocale('fr');
    expect(document.documentElement.lang).toBe('fr');
    expect(told).toBe(1);
    stop();
    await setLocale('en');
    expect(told).toBe(1);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-01-10T12:00:00Z');
  it('follows the interface language', async () => {
    await setLocale('es');
    expect(relativeTime('2026-01-10T11:59:50Z', now)).toBe('ahora mismo');
    expect(relativeTime('2026-01-10T11:59:00Z', now)).toBe('hace 1 minuto');
    await setLocale('de');
    expect(relativeTime('2026-01-10T09:00:00Z', now)).toBe('vor 3 Stunden');
  });
});

describe('catalogs', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  // Missing text is allowed, as it falls back to English. Wrong placeholders would show a gap.
  it('has a catalog for every language offered, with the same placeholders as the English', () => {
    for (const { code } of INTERFACE_LANGUAGES) {
      if (code === 'en') continue;
      const catalog = JSON.parse(readFileSync(resolve(`src/locales/${code}.json`), 'utf8')) as Record<string, string>;
      expect(Object.keys(catalog).length).toBeGreaterThan(50);
      for (const [english, translated] of Object.entries(catalog)) {
        expect(translated, `${code}: ${english}`).not.toBe('');
        expect(placeholders(translated), `${code}: ${english}`).toEqual(placeholders(english));
      }
    }
  });

  it('lists what is missing per language', () => {
    const output = execFileSync(process.execPath, ['scripts/i18n-extract.mjs'], { encoding: 'utf8' });
    expect(output).toMatch(/\d+ texts to translate/);
    expect(output).toMatch(/es: \d+ of \d+ translated/);
    const list = execFileSync(process.execPath, ['scripts/i18n-extract.mjs', '--list'], { encoding: 'utf8' });
    expect(list).toContain('src/shell/StartScreen.tsx\tRemove from this list');
  });
});
