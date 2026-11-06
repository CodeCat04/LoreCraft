import { describe, expect, it } from 'vitest';

import type { InfoboxField } from '../lib/types';
import {
  hasVisibleInfobox,
  infoboxLines,
  keyFromLabel,
  moved,
  normalizeInfobox,
  splitTitles,
  visibleFields,
} from './infobox';

describe('normalizeInfobox', () => {
  it('survives anything stored', () => {
    expect(normalizeInfobox(null)).toEqual({ fields: [] });
    expect(normalizeInfobox('nonsense')).toEqual({ fields: [] });
    expect(normalizeInfobox({ fields: 'nope' })).toEqual({ fields: [] });
    expect(normalizeInfobox({ fields: [null, 3, { key: 'a', value: 5, kind: 'weird' }] })).toEqual({
      fields: [{ key: 'a', label: 'a', kind: 'text', value: '5' }],
    });
  });

  it('keeps anything else a field carries, such as changes over the story', () => {
    const changes = [{ nodeId: 'ch10', value: 'black' }];
    const box = normalizeInfobox({ fields: [{ key: 'hair', label: 'Hair', kind: 'text', value: 'blonde', changes }] });
    expect(box.fields[0].changes).toEqual(changes);
  });

  it('keeps the image and caption', () => {
    expect(normalizeInfobox({ imageAssetId: 'x', caption: 'Portrait', fields: [] })).toEqual({
      imageAssetId: 'x',
      caption: 'Portrait',
      fields: [],
    });
  });
});

describe('splitTitles', () => {
  it('splits on commas and ignores blanks', () => {
    expect(splitTitles(' Aria , Morn,, ')).toEqual(['Aria', 'Morn']);
    expect(splitTitles('')).toEqual([]);
  });
});

describe('visible fields', () => {
  const box = {
    fields: [
      { key: 'a', label: 'A', kind: 'text' as const, value: 'x' },
      { key: 'b', label: 'B', kind: 'text' as const, value: '  ' },
    ],
  };

  it('hides empty fields', () => {
    expect(visibleFields(box).map((f) => f.key)).toEqual(['a']);
    expect(infoboxLines(box)).toEqual(['A: x']);
  });

  it('shows an infobox with an image even with no filled fields', () => {
    expect(hasVisibleInfobox({ fields: [] })).toBe(false);
    expect(hasVisibleInfobox({ fields: [box.fields[1]] })).toBe(false);
    expect(hasVisibleInfobox({ imageAssetId: 'x', fields: [] })).toBe(true);
    expect(hasVisibleInfobox(box)).toBe(true);
  });
});

describe('keyFromLabel', () => {
  it('makes a readable key', () => {
    expect(keyFromLabel('Favourite Weapon', [])).toBe('favourite_weapon');
    expect(keyFromLabel('  Élan — vital! ', [])).toBe('elan_vital');
  });

  it('keeps keys unique', () => {
    expect(keyFromLabel('Rank', ['rank'])).toBe('rank_2');
    expect(keyFromLabel('Rank', ['rank', 'rank_2'])).toBe('rank_3');
  });

  it('never returns an empty key', () => {
    expect(keyFromLabel('!!!', [])).toBe('field');
  });
});

describe('moved', () => {
  it('swaps neighbours and leaves the original alone', () => {
    const items = ['a', 'b', 'c'];
    expect(moved(items, 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moved(items, 1, 1)).toEqual(['a', 'c', 'b']);
    expect(items).toEqual(['a', 'b', 'c']);
  });

  it('does nothing past the ends', () => {
    const items = ['a', 'b'];
    expect(moved(items, 0, -1)).toBe(items);
    expect(moved(items, 1, 1)).toBe(items);
  });
});

describe('fields that change during the story', () => {
  const field = (value: string, changes?: InfoboxField['changes']): InfoboxField => ({ key: 'rank', label: 'Rank', kind: 'text', value, changes });

  it('keeps changes, tidied, through normalizing', () => {
    const box = normalizeInfobox({ fields: [{ key: 'rank', value: 'Squire', changes: [{ value: 'Knight', date: '312', note: '', nodeId: null, stray: 1 }, 'junk'] }] });
    expect(box.fields[0].changes).toEqual([{ value: 'Knight', date: '312' }]);
  });

  it('leaves no changes key on a field without any', () => {
    expect('changes' in normalizeInfobox({ fields: [{ key: 'rank', value: 'Squire', changes: [] }] }).fields[0]).toBe(false);
  });

  it('shows a field that starts empty but gains a value', () => {
    expect(visibleFields({ fields: [field('', [{ date: '312', value: 'Knight' }])] })).toHaveLength(1);
    expect(hasVisibleInfobox({ fields: [field('', [{ date: '312', value: 'Knight' }])] })).toBe(true);
    expect(visibleFields({ fields: [field('')] })).toHaveLength(0);
  });

  it('counts changes when comparing versions', () => {
    expect(infoboxLines({ fields: [field('Squire', [{ date: '312', value: 'Knight', note: 'After the siege' }])] })).toEqual([
      'Rank: Squire',
      'Rank changes to Knight on 312 (After the siege)',
    ]);
  });
});
