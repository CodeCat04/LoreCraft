/** Text from `storyDate` and `platform` follows the interface language, and stays the same in English. */

import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from './i18n';
import { NO_PDF_MESSAGE, noPdfMessage } from './platform';
import { explainStoryDate } from './storyDate';

afterEach(async () => {
  await setLocale('en');
});

const calendar = { months: [{ name: 'Frostmoot', days: 30 }, { name: 'Thawing', days: 1 }] };

describe('explainStoryDate', () => {
  it('says the same as before in English', () => {
    expect(explainStoryDate('312 AE')).toBe('"AE" is not a known era. Add it in era settings, or change the date.');
    expect(explainStoryDate('Nomonth 312', [], calendar)).toBe(
      '"Nomonth" is not a known era or month. Add it in era settings, or change the date.',
    );
    expect(explainStoryDate('the long winter')).toBe('Not a date that can be put in order. Use a year such as 312 or 312-04-15.');
    expect(explainStoryDate('the long winter', [], calendar)).toBe(
      'Not a date that can be put in order. Use a year such as 312, 312-04-15 or 15 Frostmoot 312.',
    );
    expect(explainStoryDate('31 Frostmoot 312', [], calendar)).toBe('Frostmoot has 30 days, so it has no day 31.');
    expect(explainStoryDate('2 Thawing 312', [], calendar)).toBe('Thawing has 1 day, so it has no day 2.');
    expect(explainStoryDate('Frostmoot', [], calendar)).toBe('Add a year, as in "Frostmoot 312".');
    expect(explainStoryDate('15 Nomonth 312', [], calendar)).toBe('"Nomonth" is not a month in this project\'s calendar.');
    expect(explainStoryDate(' ')).toBe('No date is set.');
  });

  it('speaks the interface language', async () => {
    await setLocale('de');
    expect(explainStoryDate('312 AE')).toBe('„AE“ ist keine bekannte Ära. Füge sie in den Ära-Einstellungen hinzu, oder ändere das Datum.');
    await setLocale('es');
    expect(explainStoryDate(' ')).toBe('No hay fecha.');
    expect(explainStoryDate('Frostmoot', [], calendar)).toBe('Añade un año, como en «Frostmoot 312».');
    await setLocale('fr');
    expect(explainStoryDate('31 Frostmoot 312', [], calendar)).toBe('Frostmoot a 30 jours, il n’a donc pas de jour 31.');
  });
});

describe('noPdfMessage', () => {
  it('is the English constant in English, and translated otherwise', async () => {
    expect(noPdfMessage()).toBe(NO_PDF_MESSAGE);
    await setLocale('fr');
    expect(noPdfMessage()).toBe('L’export PDF fonctionne sous Windows et Linux. Les exports Word et EPUB fonctionnent ici.');
  });
});
