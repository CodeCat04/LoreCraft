import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { THEMES, type ThemeId, type ThemeMode } from '../lib/settings';

/** Read as text, because CSS imports are empty under Vitest. */
const source = readFileSync(resolve(process.cwd(), 'src/styles/themes.css'), 'utf8');
const css = source.replace(/\/\*[\s\S]*?\*\//g, '');

function tokensOf(theme: string, mode: string): Record<string, string> {
  const block = new RegExp(`:root\\[data-theme='${theme}'\\]\\[data-mode='${mode}'\\]\\s*\\{([^}]*)\\}`).exec(css);
  if (!block) throw new Error(`themes.css has no block for ${theme} in ${mode}`);
  const tokens: Record<string, string> = {};
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[name] = value.trim();
  return tokens;
}

function channels(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Not a hex color: ${hex}`);
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join('') : match[1];
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** What `color-mix(in srgb, color share, transparent)` looks like over a background. */
function over(color: string, share: number, background: string): string {
  const [a, b] = [channels(color), channels(background)];
  return '#' + a.map((c, i) => Math.round(c * share + b[i] * (1 - share)).toString(16).padStart(2, '0')).join('');
}

/** How far apart two colors look, as CIE76 delta E. About 2 is just noticeable. */
function difference(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, b] = channels(hex).map((c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const [x, y, z] = [
      f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047),
      f(r * 0.2126 + g * 0.7152 + b * 0.0722),
      f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883),
    ];
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Each kind of text, and every surface the app's own CSS shows it on. */
const TEXT_ON: Record<string, string[]> = {
  '--text': ['--bg', '--bg-sunken', '--surface', '--surface-2', '--surface-3', '--infobox-bg', '--selection'],
  '--text-muted': ['--bg', '--bg-sunken', '--surface', '--surface-2', '--surface-3', '--infobox-bg'],
  '--text-faint': ['--bg', '--bg-sunken', '--surface', '--surface-2', '--infobox-bg'],
  '--link': ['--bg', '--bg-sunken', '--surface', '--surface-2', '--infobox-bg'],
  '--link-hover': ['--bg', '--bg-sunken', '--surface', '--surface-2', '--infobox-bg'],
  '--link-red': ['--bg', '--bg-sunken', '--surface', '--infobox-bg'],
  '--danger': ['--bg', '--surface', '--surface-2', '--del-bg'],
  '--success': ['--bg', '--surface', '--surface-2'],
  '--warning': ['--bg', '--surface', '--surface-2'],
  '--ins-text': ['--ins-bg'],
  '--del-text': ['--del-bg'],
  '--accent-text': ['--accent', '--accent-hover'],
};

function failures(theme: ThemeId, mode: ThemeMode, minimum: number): string[] {
  const tokens = tokensOf(theme, mode);
  const out: string[] = [];
  for (const [text, surfaces] of Object.entries(TEXT_ON)) {
    for (const surface of surfaces) {
      const ratio = contrast(tokens[text], tokens[surface]);
      if (ratio < minimum) out.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
    }
  }
  return out;
}

const VARIANTS = THEMES.flatMap((theme) => (['dark', 'light'] as const).map((mode) => ({ theme: theme.id, mode })));

describe('themes', () => {
  it('computes contrast the way WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrast('#fff', '#000')).toBeCloseTo(21, 5);
  });

  it.each(VARIANTS)('$theme in $mode defines the same tokens as every other', ({ theme, mode }) => {
    expect(Object.keys(tokensOf(theme, mode)).sort()).toEqual(Object.keys(tokensOf('encyclopedia', 'dark')).sort());
  });

  it.each(VARIANTS)('$theme in $mode keeps text at 4.5:1 or better', ({ theme, mode }) => {
    expect(failures(theme, mode, 4.5)).toEqual([]);
  });

  it.each(VARIANTS)('$theme in $mode has a focus ring that can be seen', ({ theme, mode }) => {
    const tokens = tokensOf(theme, mode);
    for (const surface of ['--bg', '--bg-sunken', '--surface', '--surface-2']) {
      expect(contrast(tokens['--accent'], tokens[surface])).toBeGreaterThanOrEqual(3);
    }
  });

  // find.css and notes.css: the current match is --bg on --warning, and other matches and
  // comments mix --warning into the page.
  it.each(VARIANTS)('$theme in $mode keeps search matches and comment highlights readable', ({ theme, mode }) => {
    const tokens = tokensOf(theme, mode);
    expect(contrast(tokens['--bg'], tokens['--warning'])).toBeGreaterThanOrEqual(4.5);
    for (const share of [0.2, 0.34, 0.45]) {
      expect(contrast(tokens['--text'], over(tokens['--warning'], share, tokens['--bg']))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(VARIANTS)('$theme in $mode tells links to missing pages from other links', ({ theme, mode }) => {
    const tokens = tokensOf(theme, mode);
    expect(difference(tokens['--link'], tokens['--link-red'])).toBeGreaterThanOrEqual(20);
  });

  it.each(['dark', 'light'] as const)('high contrast in %s keeps text at 7:1 or better', (mode) => {
    expect(failures('contrast', mode, 7)).toEqual([]);
  });

  it.each(['dark', 'light'] as const)('high contrast in %s has borders that stand out', (mode) => {
    const tokens = tokensOf('contrast', mode);
    for (const surface of ['--bg', '--surface', '--surface-2']) {
      expect(contrast(tokens['--border'], tokens[surface])).toBeGreaterThanOrEqual(3);
      expect(contrast(tokens['--border-strong'], tokens[surface])).toBeGreaterThanOrEqual(7);
      expect(contrast(tokens['--accent'], tokens[surface])).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('lorekeeper', () => {
  /** Its accent is a warm terracotta, close to the reds and yellows that mean something else. */
  it.each(['dark', 'light'] as const)('in %s keeps the accent, states and highlights apart', (mode) => {
    const tokens = tokensOf('lorekeeper', mode);
    const marks: Record<string, string> = {
      accent: tokens['--accent'],
      danger: tokens['--danger'],
      warning: tokens['--warning'],
      success: tokens['--success'],
      'missing page': tokens['--link-red'],
      selection: tokens['--selection'],
      'search match': over(tokens['--warning'], 0.34, tokens['--bg']),
      comment: over(tokens['--warning'], 0.2, tokens['--bg']),
      insertion: tokens['--ins-bg'],
      deletion: tokens['--del-bg'],
    };
    // A missing page and danger share one red, as in every theme.
    const groups = [
      ['accent', 'danger', 'warning', 'success'],
      ['accent', 'missing page'],
      ['accent', 'selection', 'search match'],
      ['selection', 'comment', 'insertion', 'deletion'],
    ];
    const tooClose: string[] = [];
    for (const group of groups) {
      for (const [i, a] of group.entries()) {
        for (const b of group.slice(i + 1)) {
          const apart = difference(marks[a], marks[b]);
          if (apart < 15) tooClose.push(`${a} and ${b}: ${apart.toFixed(1)}`);
        }
      }
    }
    expect(tooClose).toEqual([]);
  });

  it('dashes links to missing pages, so they do not depend on telling two reds apart', () => {
    expect(source).toMatch(/:root\[data-theme='lorekeeper'\] \.wiki-link-red \{[^}]*text-decoration-style: dashed/);
  });
});
