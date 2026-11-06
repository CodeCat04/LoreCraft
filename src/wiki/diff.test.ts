import { describe, expect, it } from 'vitest';

import { compareTexts, countChanges, foldUnchanged, versionText, type DiffLine } from './diff';
import type { PmNode } from '../lib/types';

const render = (lines: DiffLine[]) =>
  lines.map((line) =>
    line.runs
      .map((r) => (r.kind === 'ins' ? `{+${r.text}+}` : r.kind === 'del' ? `{-${r.text}-}` : r.text))
      .join(''),
  );

describe('compareTexts', () => {
  it('reports nothing for identical text', () => {
    const lines = compareTexts('one\ntwo', 'one\ntwo');
    expect(lines.every((l) => l.kind === 'same')).toBe(true);
    expect(countChanges(lines)).toEqual({ inserted: 0, deleted: 0 });
  });

  it('marks words within a changed line', () => {
    const lines = compareTexts('The river runs north past the keep.', 'The river runs south past the keep.');
    expect(render(lines)).toEqual(['The river runs {-north-}{+south+} past the keep.']);
    expect(countChanges(lines)).toEqual({ inserted: 1, deleted: 1 });
  });

  it('shows whole added and removed lines', () => {
    expect(render(compareTexts('one\nthree', 'one\ntwo\nthree'))).toEqual(['one', '{+two+}', 'three']);
    expect(render(compareTexts('one\ntwo\nthree', 'one\nthree'))).toEqual(['one', '{-two-}', 'three']);
  });

  it('shows an unrelated rewrite as old then new rather than confetti', () => {
    expect(render(compareTexts('Completely different sentence here', 'Nothing in common with that at all'))).toEqual([
      '{-Completely different sentence here-}',
      '{+Nothing in common with that at all+}',
    ]);
  });

  it('handles empty versions', () => {
    expect(render(compareTexts('', 'new text'))).toEqual(['{+new text+}']);
    expect(render(compareTexts('old text', ''))).toEqual(['{-old text-}']);
    expect(compareTexts('', '')).toEqual([]);
  });

  it('stays fast on a very long article with scattered edits', () => {
    const older = Array.from({ length: 5000 }, (_, i) => `Paragraph ${i} with a fair number of words in it to compare.`);
    const newer = older.map((line, i) => (i % 500 === 0 ? line.replace('fair', 'large') : line));
    const start = performance.now();
    const lines = compareTexts(older.join('\n'), newer.join('\n'));
    expect(performance.now() - start).toBeLessThan(3000);
    expect(lines.filter((l) => l.kind === 'changed')).toHaveLength(10);
  });
});

describe('foldUnchanged', () => {
  const same = (text: string): DiffLine => ({ kind: 'same', runs: [{ kind: 'same', text }] });
  const changed = (text: string): DiffLine => ({ kind: 'changed', runs: [{ kind: 'ins', text }] });

  it('keeps context beside changes and folds the rest', () => {
    const lines = [same('a'), same('b'), same('c'), same('d'), changed('X'), same('e'), same('f'), same('g'), same('h')];
    const folded = foldUnchanged(lines, 1);
    expect(folded.map((item) => (item.kind === 'skip' ? `skip ${item.lines.length}` : item.runs[0].text))).toEqual([
      'skip 3',
      'd',
      'X',
      'e',
      'skip 3',
    ]);
  });

  it('does not fold a short gap', () => {
    const lines = [changed('X'), same('a'), same('b'), changed('Y')];
    expect(foldUnchanged(lines, 1)).toEqual(lines);
  });

  it('folds between two distant changes', () => {
    const lines = [changed('X'), same('a'), same('b'), same('c'), same('d'), same('e'), changed('Y')];
    const folded = foldUnchanged(lines, 1);
    expect(folded.map((item) => (item.kind === 'skip' ? `skip ${item.lines.length}` : item.runs[0].text))).toEqual([
      'X',
      'a',
      'skip 3',
      'e',
      'Y',
    ]);
  });
});

describe('versionText', () => {
  const content: PmNode = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'the Vale', marks: [{ type: 'wikiLink', attrs: { target: 'Silver Vale' } }] },
        ],
      },
    ],
  };
  const infobox = { fields: [{ key: 'born', label: 'Born', kind: 'date', value: 'Year 1' }] };

  it('compares what a reader sees by default', () => {
    expect(versionText({ content }, false, false)).toBe('the Vale');
  });

  it('shows link targets in markup mode', () => {
    expect(versionText({ content }, true, false)).toBe('[[Silver Vale|the Vale]]');
  });

  it('includes the summary and infobox when both versions have them', () => {
    expect(versionText({ content, infobox, summary: 'A valley.' }, false, true)).toBe(
      'Summary: A valley.\nBorn: Year 1\nthe Vale',
    );
  });
});
