import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, LINE_SPACING, PAGE_WIDTH, THEMES, withDefaults, WRITING_FONTS, writingStyle } from './settings';

describe('writing style', () => {
  it('leaves the font to the theme until one is chosen', () => {
    expect(writingStyle(DEFAULT_SETTINGS.editor)).toEqual({
      font: null,
      lineHeight: String(LINE_SPACING.standard),
      pageWidth: `${PAGE_WIDTH.standard}em`,
      paragraphs: 'spaced',
    });
  });

  it('turns choices into CSS values', () => {
    expect(writingStyle({ writingFont: 'opendyslexic', lineSpacing: 2.2, pageWidth: 36, paragraphStyle: 'indented' })).toEqual({
      font: "'OpenDyslexic', 'Comic Sans MS', sans-serif",
      lineHeight: '2.2',
      pageWidth: '36em',
      paragraphs: 'indented',
    });
  });

  it('copes with anything a hand-edited settings file could hold', () => {
    expect(writingStyle({ writingFont: 'no such font', lineSpacing: 'wide', pageWidth: null, paragraphStyle: 'zigzag' })).toEqual({
      font: null,
      lineHeight: String(LINE_SPACING.standard),
      pageWidth: `${PAGE_WIDTH.standard}em`,
      paragraphs: 'spaced',
    });
    expect(writingStyle({ lineSpacing: 99, pageWidth: -5 })).toMatchObject({
      lineHeight: String(LINE_SPACING.max),
      pageWidth: `${PAGE_WIDTH.min}em`,
    });
    expect(writingStyle({ lineSpacing: Number.NaN }).lineHeight).toBe(String(LINE_SPACING.standard));
  });

  it('lists each font once, ending in a generic family for when one is missing', () => {
    expect(new Set(WRITING_FONTS.map((f) => f.id)).size).toBe(WRITING_FONTS.length);
    for (const font of WRITING_FONTS) expect(font.stack).toMatch(/(serif|sans-serif|monospace)$/);
    const bundled = WRITING_FONTS.filter((f) => f.source === 'bundled').map((f) => f.id);
    expect(bundled).toContain('opendyslexic');
    expect(bundled).toContain('atkinson');
  });
});

describe('settings from an older version', () => {
  it('gain the new fields, and keep what was set', () => {
    const stored = { editor: { spellcheck: false }, appearance: { theme: 'parchment' } };
    const settings = withDefaults(stored, DEFAULT_SETTINGS);
    expect(settings.editor.spellcheck).toBe(false);
    expect(settings.editor.lineSpacing).toBe(LINE_SPACING.standard);
    expect(settings.editor.writingFont).toBe('');
    expect(settings.editor.paragraphStyle).toBe('spaced');
    expect(settings.help.guideSeen).toBe(false);
    expect(settings.appearance.theme).toBe('parchment');
  });

  it('offer a high contrast theme', () => {
    expect(THEMES.map((t) => t.id)).toContain('contrast');
  });
});
