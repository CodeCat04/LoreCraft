import { strFromU8 } from 'fflate';

import { FONT_COPYRIGHTS, SITE_FONTS, siteFontFiles } from './siteFonts';

describe('the exported site’s fonts', () => {
  const files = new Map(siteFontFiles());

  it('travel with the Open Font License, as it requires', () => {
    const license = files.get('assets/fonts/OFL.txt');
    expect(license).toBeDefined();
    const text = strFromU8(license!);
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
    expect(text).toContain('PERMISSION & CONDITIONS');
    expect(text).toContain('TERMINATION');
    expect(text).toContain('Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)');
    expect(text).toContain('The Libertinus Project Authors');
    expect(text).not.toContain('Google Inc.');
  });

  it('name the copyright holder of every font the site uses', () => {
    const text = strFromU8(files.get('assets/fonts/OFL.txt')!);
    const families = [...SITE_FONTS.matchAll(/font-family: '([^']+)'/g)].map((match) => match[1]);
    expect(new Set(families)).toEqual(new Set(['Inter', 'Libertinus Serif']));
    for (const family of families) {
      expect(FONT_COPYRIGHTS[family], family).toMatch(/^Copyright /);
      expect(text, family).toContain(`${family}\n${FONT_COPYRIGHTS[family]}`);
    }
  });

  it('are stored as files beside the license', () => {
    const fonts = [...files.keys()].filter((path) => path.endsWith('.woff2'));
    expect(fonts.length).toBe(6);
    for (const path of fonts) {
      expect(path.startsWith('assets/fonts/'), path).toBe(true);
      expect(strFromU8(files.get(path)!.slice(0, 4))).toBe('wOF2');
    }
  });
});
