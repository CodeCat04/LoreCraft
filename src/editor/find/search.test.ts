import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';

import { documentExtensions } from '../schema';
import { buildPattern, drawnSpan, findMatches, firstAtOrAfter, nextMatchFrom, seedFromSelection, type FindMatch, type FindOptions } from './search';

const schema = getSchema(documentExtensions());

function text(value: string, ...marks: string[]) {
  return { type: 'text', text: value, marks: marks.map((type) => ({ type })) };
}

function paragraph(...content: unknown[]) {
  return { type: 'paragraph', content };
}

function doc(...content: unknown[]): ProseNode {
  return schema.nodeFromJSON({ type: 'doc', content });
}

function search(document: ProseNode, query: string, options: Partial<FindOptions> = {}): string[] {
  return findMatches(document, { query, matchCase: false, wholeWord: false, ...options }).map((m) =>
    document.textBetween(m.from, m.to, '|', '#'),
  );
}

describe('findMatches', () => {
  it('finds every match in document order, with true positions', () => {
    const document = doc(paragraph(text('one two one')), paragraph(text('two one')));
    expect(findMatches(document, { query: 'one', matchCase: false, wholeWord: false })).toEqual([
      { from: 1, to: 4 },
      { from: 9, to: 12 },
      { from: 18, to: 21 },
    ]);
  });

  it('finds a match that runs across differently formatted text', () => {
    const document = doc(paragraph(text('The Sil'), text('ver', 'bold'), text(' Vale', 'italic'), text(' waits')));
    const found = findMatches(document, { query: 'silver vale', matchCase: false, wholeWord: false });
    expect(found).toHaveLength(1);
    expect(document.textBetween(found[0].from, found[0].to)).toBe('Silver Vale');
  });

  it('does not match across a line break, a citation or a new block', () => {
    const document = doc(
      paragraph(text('hello'), { type: 'hardBreak' }, text('world')),
      paragraph(text('hello'), { type: 'reference', attrs: { text: 'A source' } }, text('world')),
      paragraph(text('hello')),
      paragraph(text('world')),
    );
    expect(search(document, 'helloworld')).toEqual([]);
    // Positions after the inline nodes still line up.
    expect(search(document, 'world')).toEqual(['world', 'world', 'world']);
    expect(search(document, 'A source')).toEqual([]);
  });

  it('honors case and whole words', () => {
    const document = doc(paragraph(text('Aria aria arias Maria Aria’s _aria')));
    expect(search(document, 'aria')).toHaveLength(6);
    expect(search(document, 'Aria', { matchCase: true })).toEqual(['Aria', 'Aria']);
    expect(search(document, 'aria', { wholeWord: true })).toEqual(['Aria', 'aria', 'Aria']);
    expect(search(document, 'Aria', { wholeWord: true, matchCase: true })).toEqual(['Aria', 'Aria']);
  });

  it('treats letters with accents and other scripts as parts of words', () => {
    const document = doc(paragraph(text('Élan élan éla Кот кот котик 猫')));
    expect(search(document, 'ÉLAN')).toEqual(['Élan', 'élan']);
    expect(search(document, 'éla', { wholeWord: true })).toEqual(['éla']);
    expect(search(document, 'кот', { wholeWord: true })).toEqual(['Кот', 'кот']);
    expect(search(document, '猫')).toEqual(['猫']);
  });

  it('finds what the typing rules turned into something else', () => {
    const document = doc(paragraph(text('Don’t say “hello”… or—worse—bye\u00A0now')));
    expect(search(document, "don't")).toEqual(['Don’t']);
    expect(search(document, '"hello"')).toEqual(['“hello”']);
    expect(search(document, 'hello"...')).toEqual(['hello”…']);
    expect(search(document, 'or--worse')).toEqual(['or—worse']);
    expect(search(document, 'bye now')).toEqual(['bye\u00A0now']);
  });

  it('takes the query literally', () => {
    const document = doc(paragraph(text('a.b axb (a+b) [x] c:\\d $1 ^up {2} a|b 🐉 end')));
    expect(search(document, 'a.b')).toEqual(['a.b']);
    expect(search(document, '(a+b)')).toEqual(['(a+b)']);
    expect(search(document, '[x]')).toEqual(['[x]']);
    expect(search(document, 'c:\\d')).toEqual(['c:\\d']);
    expect(search(document, '$1')).toEqual(['$1']);
    expect(search(document, '^up')).toEqual(['^up']);
    expect(search(document, '{2}')).toEqual(['{2}']);
    expect(search(document, 'a|b')).toEqual(['a|b']);
    expect(search(document, '🐉')).toEqual(['🐉']);
  });

  it('keeps offsets true when lower-casing would change a string’s length', () => {
    // 'İ' becomes two characters when lower-cased.
    const document = doc(paragraph(text('İİ target')));
    const [match] = findMatches(document, { query: 'target', matchCase: false, wholeWord: false });
    expect(document.textBetween(match.from, match.to)).toBe('target');
  });

  it('searches figure captions, table cells and lists', () => {
    const document = doc(
      {
        type: 'figure',
        content: [
          { type: 'image', attrs: { src: 'x.png' } },
          { type: 'figcaption', content: [text('The dragon map')] },
        ],
      },
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph(text('A dragon'))] }],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{ type: 'tableCell', content: [paragraph(text('dragon cell'))] }],
          },
        ],
      },
    );
    expect(search(document, 'dragon')).toEqual(['dragon', 'dragon', 'dragon']);
  });

  it('finds nothing for an empty query, or one holding the stand-in character', () => {
    const document = doc(paragraph(text('words'), { type: 'hardBreak' }));
    expect(search(document, '')).toEqual([]);
    expect(search(document, '\uFFFC')).toEqual([]);
    expect(buildPattern({ query: '', matchCase: false, wholeWord: false })).toBeNull();
  });

  it('is quick on a very long document', () => {
    const line = 'the quick brown fox jumps over the lazy dog and keeps on running through the wood ';
    const paragraphs = Array.from({ length: 6000 }, () => paragraph(text(line)));
    const document = doc(...paragraphs);
    const started = performance.now();
    const found = findMatches(document, { query: 'the', matchCase: false, wholeWord: true });
    const elapsed = performance.now() - started;
    expect(found).toHaveLength(18_000);
    // 100,000 words. The real figure is a few milliseconds, with room for a busy machine.
    expect(elapsed).toBeLessThan(250);
  });
});

function spans(...froms: number[]): FindMatch[] {
  return froms.map((from) => ({ from, to: from + 1 }));
}

describe('finding a place among the matches', () => {
  const matches = spans(10, 20, 30);

  it('goes to the first match at or after a position', () => {
    expect(firstAtOrAfter(matches, 0)).toBe(0);
    expect(firstAtOrAfter(matches, 10)).toBe(0);
    expect(firstAtOrAfter(matches, 11)).toBe(1);
    expect(firstAtOrAfter(matches, 30)).toBe(2);
    expect(firstAtOrAfter(matches, 31)).toBe(-1);
    expect(firstAtOrAfter([], 0)).toBe(-1);
  });

  it('wraps around past the last', () => {
    expect(nextMatchFrom(matches, 31)).toBe(0);
    expect(nextMatchFrom([], 0)).toBe(-1);
  });
});

describe('drawnSpan', () => {
  const many = spans(...Array.from({ length: 1000 }, (_, i) => i * 10));

  it('draws everything when it fits', () => {
    expect(drawnSpan(many, { from: 0, to: 1 }, 0, 1000)).toEqual({ start: 0, end: 1000 });
  });

  it('draws what is in range when that fits', () => {
    expect(drawnSpan(many, { from: 100, to: 300 }, 200, 100)).toEqual({ start: 10, end: 31 });
  });

  it('keeps to the limit, centered on the place, when the range holds too many', () => {
    expect(drawnSpan(many, { from: 0, to: 9990 }, 5000, 100)).toEqual({ start: 450, end: 550 });
  });

  it('stays in range near its ends', () => {
    expect(drawnSpan(many, { from: 0, to: 9990 }, 0, 100)).toEqual({ start: 0, end: 100 });
    expect(drawnSpan(many, { from: 0, to: 9990 }, 9990, 100)).toEqual({ start: 900, end: 1000 });
  });

  it('copes with a range holding nothing', () => {
    const { start, end } = drawnSpan(many, { from: 20000, to: 30000 }, 25000, 100);
    expect(end - start).toBe(0);
  });
});

describe('seedFromSelection', () => {
  it('takes one short line, without spaces at its edges', () => {
    expect(seedFromSelection('Silver Vale')).toBe('Silver Vale');
    expect(seedFromSelection('word ')).toBe('word');
  });
  it('turns down what is not a search', () => {
    expect(seedFromSelection('')).toBeNull();
    expect(seedFromSelection('   ')).toBeNull();
    expect(seedFromSelection('two\nlines')).toBeNull();
    expect(seedFromSelection('x'.repeat(201))).toBeNull();
  });
});
