import { getSchema } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { documentExtensions } from '../editor/schema';
import type { PmNode } from '../lib/types';
import { splitDocAt } from './splitDoc';

const schema = getSchema(documentExtensions());

const text = (t: string, marks?: PmNode['marks']): PmNode => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: PmNode[]): PmNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });

function doc(...content: PmNode[]) {
  return schema.nodeFromJSON({ type: 'doc', content });
}

describe('splitDocAt', () => {
  it('splits inside a paragraph, keeping formatting on both sides', () => {
    const d = doc(para(text('Plain '), text('bold words', [{ type: 'bold' }]), text(' end')));
    // Inside "bold words", after "bold ".
    const parts = splitDocAt(d, 1 + 'Plain bold '.length);
    expect(parts?.before).toEqual({
      type: 'doc',
      content: [para(text('Plain '), text('bold ', [{ type: 'bold' }]))],
    });
    expect(parts?.after).toEqual({
      type: 'doc',
      content: [para(text('words', [{ type: 'bold' }]), text(' end'))],
    });
  });

  it('leaves no blank paragraph when the cut is at the edge of one', () => {
    const d = doc(para(text('One')), para(text('Two')));
    // The end of "One".
    const atEnd = splitDocAt(d, 4);
    expect(atEnd?.before).toEqual({ type: 'doc', content: [para(text('One'))] });
    expect(atEnd?.after).toEqual({ type: 'doc', content: [para(text('Two'))] });
    // The start of "Two".
    const atStart = splitDocAt(d, 6);
    expect(atStart).toEqual(atEnd);
  });

  it('keeps whole blocks on either side, with nested structure', () => {
    const d = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('A heading')] },
      { type: 'blockquote', content: [para(text('Quoted line'))] },
      para(text('After')),
    );
    const inQuote = 1 + 'A heading'.length + 1 + 1 + 1 + 'Quoted '.length;
    const parts = splitDocAt(d, inQuote);
    expect(parts?.before.content?.[0].type).toBe('heading');
    expect(parts?.before.content?.[1]).toEqual({ type: 'blockquote', content: [para(text('Quoted '))] });
    expect(parts?.after.content?.[0]).toEqual({ type: 'blockquote', content: [para(text('line'))] });
    expect(parts?.after.content?.[1]).toEqual(para(text('After')));
  });

  it('refuses a cut with nothing on one side', () => {
    const d = doc(para(text('Only line')), para());
    expect(splitDocAt(d, 1)).toBeNull();
    expect(splitDocAt(d, 10)).toBeNull();
    expect(splitDocAt(d, d.content.size - 1)).toBeNull();
    expect(splitDocAt(doc(para()), 1)).toBeNull();
  });

  it('keeps a picture as content, not as a blank', () => {
    const d = doc(para(text('Words')), { type: 'image', attrs: { src: 'x.png' } });
    const parts = splitDocAt(d, 6);
    expect(parts?.after.content?.[0].type).toBe('image');
  });

  it('loses nothing: the two halves hold all the text', () => {
    const d = doc(para(text('The quick brown fox')), para(text('jumps over the lazy dog')));
    for (let pos = 2; pos < d.content.size - 2; pos += 1) {
      const parts = splitDocAt(d, pos);
      if (!parts) continue;
      const all = [parts.before, parts.after]
        .map((p) => schema.nodeFromJSON(p).textBetween(0, schema.nodeFromJSON(p).content.size, ' '))
        .join('');
      expect(all.replace(/\s/g, '')).toBe('Thequickbrownfoxjumpsoverthelazydog');
    }
  });
});
