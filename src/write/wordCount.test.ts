import { getSchema } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import { documentExtensions } from '../editor/schema';
import { pmToPlainText } from '../editor/convert';
import { wordCount } from '../lib/text';
import type { PmNode } from '../lib/types';
import { docWordCount, rangeWordCount } from './wordCount';

const schema = getSchema(documentExtensions());

function para(...content: PmNode[]): PmNode {
  return { type: 'paragraph', content };
}
const text = (t: string): PmNode => ({ type: 'text', text: t });

function doc(...content: PmNode[]) {
  return schema.nodeFromJSON({ type: 'doc', content });
}

describe('docWordCount', () => {
  it('counts words across blocks, marks and line breaks', () => {
    const d = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Early life')] },
      para(
        text('Born in '),
        { type: 'text', text: 'the Vale', marks: [{ type: 'wikiLink', attrs: { target: 'Vale' } }] },
        text(', she left.'),
        { type: 'hardBreak' },
        text('Never returned.'),
      ),
    );
    // The same document and count as `extract_finds_text_links_and_counts` in content.rs.
    expect(docWordCount(d)).toBe(10);
  });

  it('agrees with counting the plain text', () => {
    const d = doc(
      para(text('One - two -- three')),
      { type: 'blockquote', content: [para(text('Quoted words here'))] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('item one'))] }] },
      { type: 'horizontalRule' },
      para(),
    );
    expect(docWordCount(d)).toBe(wordCount(pmToPlainText(d.toJSON() as PmNode)));
    expect(docWordCount(d)).toBe(8);
  });

  it('does not let an inline atom split or join words', () => {
    const d = doc(para(text('foot'), { type: 'reference', attrs: { text: 'cite' } }, text('note here')));
    // `extract` adds no text for a reference, so the words on either side touch.
    expect(docWordCount(d)).toBe(2);
  });

  it('leaves figure captions out, as extract in content.rs does', () => {
    const withFigures = new Schema({
      nodes: {
        doc: { content: 'block+' },
        text: { group: 'inline' },
        paragraph: { group: 'block', content: 'inline*' },
        figcaption: { content: 'inline*' },
        figure: { group: 'block', content: 'figcaption' },
      },
    });
    const d = withFigures.nodeFromJSON({
      type: 'doc',
      content: [
        para(text('Two words')),
        { type: 'figure', content: [{ type: 'figcaption', content: [text('A caption of five words')] }] },
      ],
    });
    expect(docWordCount(d)).toBe(2);
  });

  it('counts Chinese per character across blocks and leaves figures out', () => {
    // The same document and count as a test of `extract` in content.rs.
    const d = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('第一章')] },
      para(text('林黛玉'), { type: 'text', text: '笑了。', marks: [{ type: 'bold' }] }),
      {
        type: 'figure',
        attrs: { kind: 'picture', description: '一幅画' },
        content: [
          { type: 'image', attrs: { assetId: 'a' } },
          { type: 'figcaption', content: [text('大观园')] },
        ],
      },
      para(text('Yes.')),
    );
    expect(docWordCount(d)).toBe(9);
    const size = d.content.size;
    expect(rangeWordCount(d, 0, size)).toBeGreaterThanOrEqual(9);
  });

  it('is zero for an empty document', () => {
    expect(docWordCount(doc(para()))).toBe(0);
  });

  it('recounts only what changed', () => {
    const blocks = Array.from({ length: 1000 }, (_, i) => para(text(`Paragraph ${i} has five words`)));
    const d = doc(...blocks);
    expect(docWordCount(d)).toBe(5000);

    // Replace one block, as an edit does. Every other block keeps its identity.
    const edited = d.copy(d.content.replaceChild(0, schema.nodeFromJSON(para(text('Just two')))));
    const start = performance.now();
    for (let i = 0; i < 100; i += 1) docWordCount(edited);
    const each = (performance.now() - start) / 100;
    expect(docWordCount(edited)).toBe(4997);
    expect(each).toBeLessThan(5);
  });
});

describe('rangeWordCount', () => {
  it('counts the words in a selection across blocks', () => {
    const d = doc(para(text('one two three')), para(text('four five')));
    expect(rangeWordCount(d, 1, 8)).toBe(2);
    expect(rangeWordCount(d, 0, d.content.size)).toBe(5);
    // Part of a word still counts as a word.
    expect(rangeWordCount(d, 2, 3)).toBe(1);
    expect(rangeWordCount(d, 1, 1)).toBe(0);
  });
});
