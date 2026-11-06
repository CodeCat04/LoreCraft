/**
 * The app's own heading and text fonts for the exported site, so it looks the same on a
 * computer without them. Other alphabets fall back to the reader's system fonts.
 */

import libertinusLatin from '@fontsource/libertinus-serif/files/libertinus-serif-latin-400-normal.woff2?inline';
import libertinusExt from '@fontsource/libertinus-serif/files/libertinus-serif-latin-ext-400-normal.woff2?inline';
import interLatin from '@fontsource/inter/files/inter-latin-400-normal.woff2?inline';
import interExt from '@fontsource/inter/files/inter-latin-ext-400-normal.woff2?inline';
import interLatinBold from '@fontsource/inter/files/inter-latin-600-normal.woff2?inline';
import interExtBold from '@fontsource/inter/files/inter-latin-ext-600-normal.woff2?inline';
import interLicense from '@fontsource/inter/LICENSE?raw';

import { base64ToBytes } from '../util';

/**
 * The OFL lets the fonts travel with the site if their copyright notices and the license go
 * too. The Libertinus package names "Google Inc." in its license file, which is not who
 * made the font, so the lines are written out here.
 */
export const FONT_COPYRIGHTS: Record<string, string> = {
  Inter: 'Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)',
  'Libertinus Serif': 'Copyright © 2012-2024 The Libertinus Project Authors, with Reserved Font Name "Linux Libertine", "Biolinum", "STIX Fonts". (https://github.com/alerque/libertinus)',
};

/** The license text itself, which is the same for every OFL font. */
function openFontLicense(): string {
  const text = interLicense.replace(/\r\n?/g, '\n');
  return text.slice(text.indexOf('This Font Software is licensed under the SIL Open Font License'));
}

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

const FONTS: { file: string; data: string; family: string; weight: number; range: string }[] = [
  { file: 'libertinus-latin-400.woff2', data: libertinusLatin, family: 'Libertinus Serif', weight: 400, range: LATIN },
  { file: 'libertinus-latin-ext-400.woff2', data: libertinusExt, family: 'Libertinus Serif', weight: 400, range: LATIN_EXT },
  { file: 'inter-latin-400.woff2', data: interLatin, family: 'Inter', weight: 400, range: LATIN },
  { file: 'inter-latin-ext-400.woff2', data: interExt, family: 'Inter', weight: 400, range: LATIN_EXT },
  { file: 'inter-latin-600.woff2', data: interLatinBold, family: 'Inter', weight: 600, range: LATIN },
  { file: 'inter-latin-ext-600.woff2', data: interExtBold, family: 'Inter', weight: 600, range: LATIN_EXT },
];

export const SITE_FONTS = FONTS.map(
  (f) =>
    `@font-face { font-family: '${f.family}'; font-weight: ${f.weight}; font-style: normal; font-display: swap; ` +
    `src: url('fonts/${f.file}') format('woff2'); unicode-range: ${f.range}; }`,
).join('\n');

/** The fonts' license, with each font's copyright line, to go in the folder beside them. */
export function siteFontLicense(): string {
  const families = [...new Set(FONTS.map((f) => f.family))];
  const notices = families.map((family) => `${family}\n${FONT_COPYRIGHTS[family]}`).join('\n\n');
  return `The fonts in this folder are under the SIL Open Font License, Version 1.1.\n\n${notices}\n\n${openFontLicense()}`;
}

/** Vite gives each font as a `data:` URL. The site stores them as ordinary files, with their license. */
export function siteFontFiles(): [string, Uint8Array][] {
  const fonts: [string, Uint8Array][] = FONTS.map((f) => [
    `assets/fonts/${f.file}`,
    base64ToBytes(f.data.slice(f.data.indexOf(',') + 1)),
  ]);
  return [...fonts, ['assets/fonts/OFL.txt', new TextEncoder().encode(siteFontLicense())]];
}
