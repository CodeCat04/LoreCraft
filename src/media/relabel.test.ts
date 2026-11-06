import type { PmNode } from '../lib/types';
import { relabelFigures, type LabelChange } from './relabel';

function figure(assetId: string, label?: string | PmNode[], description = ''): PmNode {
  const content = typeof label === 'string' ? [{ type: 'text', text: label }] : label;
  return {
    type: 'figure',
    attrs: { kind: 'picture', align: 'right', width: null, description },
    content: [
      { type: 'image', attrs: { assetId } },
      content ? { type: 'figcaption', content } : { type: 'figcaption' },
    ],
  };
}

const doc = (...content: PmNode[]): PmNode => ({ type: 'doc', content });

const change: LabelChange = { oldLabel: 'Old', newLabel: 'New', oldDescription: 'Old detail', newDescription: 'New detail' };

const captionOf = (node: PmNode) => node.content?.[1].content?.map((c) => c.text).join('') ?? '';

describe('relabelFigures', () => {
  it('changes figures that share the old label, and fills in empty ones', () => {
    const before = doc(figure('a', 'Old', 'Old detail'), figure('a'));
    const { doc: after, changed, kept } = relabelFigures(before, 'a', change);
    expect(changed).toBe(2);
    expect(kept).toBe(0);
    for (const node of after.content!) {
      expect(captionOf(node)).toBe('New');
      expect(node.attrs?.description).toBe('New detail');
    }
  });

  it('leaves a figure with words of its own, and says so', () => {
    const before = doc(figure('a', 'Written for this page', 'Its own detail'));
    const { doc: after, changed, kept } = relabelFigures(before, 'a', change);
    expect(changed).toBe(0);
    expect(kept).toBe(1);
    expect(after).toBe(before);
  });

  it('treats the label and the description separately', () => {
    const before = doc(figure('a', 'Written for this page', 'Old detail'));
    const { doc: after, changed, kept } = relabelFigures(before, 'a', change);
    expect(changed).toBe(1);
    expect(kept).toBe(1);
    expect(captionOf(after.content![0])).toBe('Written for this page');
    expect(after.content![0].attrs?.description).toBe('New detail');
  });

  it('leaves a label holding a link, which plain text would lose', () => {
    const linked = [{ type: 'text', text: 'Old', marks: [{ type: 'wikiLink', attrs: { target: 'Old' } }] }];
    const before = doc(figure('a', linked));
    const { doc: after, kept } = relabelFigures(before, 'a', { ...change, newDescription: '' , oldDescription: '' });
    expect(kept).toBe(1);
    expect(after.content![0].content![1].content).toEqual(linked);
  });

  it('does not touch figures of other assets', () => {
    const before = doc(figure('other', 'Old', 'Old detail'));
    const result = relabelFigures(before, 'a', change);
    expect(result.doc).toBe(before);
    expect(result.changed).toBe(0);
    expect(result.kept).toBe(0);
  });

  it('finds figures at any depth, and leaves the rest of the document as it was', () => {
    const quote = { type: 'blockquote', content: [figure('a', 'Old')] };
    const paragraph = { type: 'paragraph', content: [{ type: 'text', text: 'Old' }] };
    const { doc: after } = relabelFigures(doc(paragraph, quote), 'a', change);
    expect(captionOf(after.content![1].content![0])).toBe('New');
    expect(after.content![0]).toBe(paragraph);
  });

  it('clears a label without leaving an empty text node, which the schema forbids', () => {
    const { doc: after } = relabelFigures(doc(figure('a', 'Old')), 'a', { ...change, newLabel: '' });
    expect(after.content![0].content![1]).toEqual({ type: 'figcaption' });
  });

  it('finds a linked video the same way as a stored picture', () => {
    const video: PmNode = {
      type: 'figure',
      attrs: { kind: 'video', description: '' },
      content: [{ type: 'video', attrs: { assetId: 'v' } }, { type: 'figcaption' }],
    };
    expect(relabelFigures(doc(video), 'v', change).changed).toBe(1);
  });
});
