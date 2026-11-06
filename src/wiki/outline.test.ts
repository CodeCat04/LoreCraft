import { describe, expect, it } from 'vitest';

import { extractHeadings, extractReferences, isDocBlank, isDocEmpty } from './outline';
import type { PmNode } from '../lib/types';

const h = (level: number, text: string): PmNode => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const p = (...content: PmNode[]): PmNode => ({ type: 'paragraph', content });
const t = (text: string): PmNode => ({ type: 'text', text });
const doc = (...content: PmNode[]): PmNode => ({ type: 'doc', content });

describe('extractHeadings', () => {
  it('numbers headings by nesting', () => {
    const outline = extractHeadings(doc(h(2, 'One'), h(3, 'Sub'), h(3, 'Sub two'), h(2, 'Two'), h(3, 'Again')));
    expect(outline.map((x) => [x.number, x.text, x.level])).toEqual([
      ['1', 'One', 1],
      ['1.1', 'Sub', 2],
      ['1.2', 'Sub two', 2],
      ['2', 'Two', 1],
      ['2.1', 'Again', 2],
    ]);
  });

  it('handles an article that skips or starts deep', () => {
    expect(extractHeadings(doc(h(4, 'Deep'), h(2, 'Up'), h(4, 'Down'))).map((x) => x.number)).toEqual(['1', '1', '1.1']);
  });

  it('joins heading text across marks and finds headings inside quotes', () => {
    const outline = extractHeadings(doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('Early '), { type: 'text', text: 'life', marks: [{ type: 'bold' }] }] },
      { type: 'blockquote', content: [h(2, 'Quoted')] },
    ));
    expect(outline.map((x) => [x.index, x.text])).toEqual([[0, 'Early life'], [1, 'Quoted']]);
  });

  it('returns nothing for a document with no headings', () => {
    expect(extractHeadings(doc(p(t('text'))))).toEqual([]);
    expect(extractHeadings({ type: 'doc' })).toEqual([]);
  });

  it('keeps up with a very long article', () => {
    const big = doc(...Array.from({ length: 20000 }, (_, i) => (i % 10 === 0 ? h(2, `Section ${i}`) : p(t('words')))));
    const start = performance.now();
    expect(extractHeadings(big)).toHaveLength(2000);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('extractReferences', () => {
  it('lists citations in document order, including in lists', () => {
    const refs = extractReferences(doc(
      p(t('a'), { type: 'reference', attrs: { text: 'First' } }),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p({ type: 'reference', attrs: { text: 'Second' } })] }] },
    ));
    expect(refs).toEqual(['First', 'Second']);
  });
});

describe('isDocEmpty and isDocBlank', () => {
  it('sees a new page as empty', () => {
    expect(isDocEmpty(doc({ type: 'paragraph' }))).toBe(true);
    expect(isDocEmpty(doc(p(t('   '))))).toBe(true);
    expect(isDocBlank(doc({ type: 'paragraph' }))).toBe(true);
  });

  it('counts anything readable as content', () => {
    expect(isDocEmpty(doc(p(t('x'))))).toBe(false);
    expect(isDocEmpty(doc({ type: 'image', attrs: { assetId: 'a' } }))).toBe(false);
    expect(isDocEmpty(doc(p({ type: 'reference', attrs: { text: 'x' } })))).toBe(false);
  });

  it('does not treat starter headings as blank, so a template never overwrites them', () => {
    expect(isDocBlank(doc({ type: 'paragraph' }, h(2, 'Biography')))).toBe(false);
  });
});
