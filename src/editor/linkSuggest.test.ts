import { describe, expect, it } from 'vitest';

import { findLinkQuery, foldName, isKnownName, rankTitles } from './linkSuggest';
import type { TitleEntry } from '../lib/types';

function entry(title: string, aliases: string[] = []): TitleEntry {
  return { id: title, title, aliases, pageType: 'article', status: 'canon', summary: '' };
}

const entries = [
  entry('Silver Vale'),
  entry('Vale of Tears'),
  entry('Aria Vale', ['The Ranger']),
  entry('Éowyn'),
  entry('Old Keep at the Vale'),
  entry('Ranger Corps'),
];

const titles = (query: string, limit?: number) =>
  rankTitles(query, entries, limit).map((m) => m.entry.title);

describe('rankTitles', () => {
  it('puts title prefixes ahead of later words and substrings', () => {
    expect(titles('vale')).toEqual(['Vale of Tears', 'Aria Vale', 'Silver Vale', 'Old Keep at the Vale']);
    expect(titles('ale')).toEqual(['Aria Vale', 'Silver Vale', 'Vale of Tears', 'Old Keep at the Vale']);
  });

  it('ignores case, spacing, underscores and accents', () => {
    expect(titles('EOWYN')).toEqual(['Éowyn']);
    expect(titles('silver_vale')).toEqual(['Silver Vale']);
    expect(titles('  silver   vale ')).toEqual(['Silver Vale']);
  });

  it('finds pages by alias and says which alias matched', () => {
    const [first] = rankTitles('the rang', entries);
    expect(first.entry.title).toBe('Aria Vale');
    expect(first.alias).toBe('The Ranger');
  });

  it('prefers a title over an alias that matches equally well', () => {
    const ranked = rankTitles('ranger', entries);
    expect(ranked[0].entry.title).toBe('Ranger Corps');
    expect(ranked[0].alias).toBeNull();
    expect(ranked[1].alias).toBe('The Ranger');
  });

  it('respects the limit and lists pages for an empty query', () => {
    expect(titles('', 2)).toHaveLength(2);
    expect(titles('vale', 1)).toEqual(['Vale of Tears']);
    expect(titles('no such page')).toEqual([]);
  });

  it('copes with a large project quickly', () => {
    const many = Array.from({ length: 5000 }, (_, i) => entry(`Page number ${i}`, [`Alias ${i}`]));
    const start = performance.now();
    for (let i = 0; i < 20; i += 1) rankTitles(`number ${i}`, many);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('isKnownName', () => {
  it('knows titles and aliases, loosely', () => {
    expect(isKnownName('silver_VALE', entries)).toBe(true);
    expect(isKnownName('the ranger', entries)).toBe(true);
    expect(isKnownName('silver', entries)).toBe(false);
  });
});

describe('foldName', () => {
  it('drops accents only', () => {
    expect(foldName('  Ñandú_Élan ')).toBe('nandu elan');
  });
});

describe('findLinkQuery', () => {
  it('finds a link being typed', () => {
    expect(findLinkQuery('Born in [[Silver V')).toEqual({ start: 8, trailing: 0, query: 'Silver V', label: null });
    expect(findLinkQuery('[[')).toEqual({ start: 0, trailing: 0, query: '', label: null });
  });

  it('separates the label', () => {
    expect(findLinkQuery('[[Silver Vale|the Va')).toEqual({ start: 0, trailing: 0, query: 'Silver Vale', label: 'the Va' });
  });

  it('picks up a label waiting after the cursor', () => {
    expect(findLinkQuery('see [[sil', '|the Vale]] today')).toEqual({
      start: 4,
      trailing: '|the Vale]]'.length,
      query: 'sil',
      label: 'the Vale',
    });
    expect(findLinkQuery('[[sil', ' and more')).toEqual({ start: 0, trailing: 0, query: 'sil', label: null });
  });

  it('ignores text that cannot be inside a link', () => {
    expect(findLinkQuery('no brackets')).toBeNull();
    expect(findLinkQuery('[single')).toBeNull();
    expect(findLinkQuery('[[closed]] and on')).toBeNull();
    expect(findLinkQuery('[[two\nlines')).toBeNull();
    expect(findLinkQuery('[[past a￼citation')).toBeNull();
    expect(findLinkQuery(`[[${'x'.repeat(101)}`)).toBeNull();
  });

  it('uses the nearest opening brackets', () => {
    expect(findLinkQuery('[[one]] and [[two')?.query).toBe('two');
    expect(findLinkQuery('[[one [[two')?.query).toBe('two');
  });
});
