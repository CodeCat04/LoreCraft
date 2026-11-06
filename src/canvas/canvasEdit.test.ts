import { describe, expect, it } from 'vitest';

import type { PmNode } from '../lib/types';
import { headingRange, sliceToHeading, spliceRange } from './cards';
import { parseRef, readFragment, serializeCanvas, type CanvasData } from './model';
import { cloneFragment, copyFragment, fitSize, MAX_FIT_HEIGHT } from './ops';
import { REF_MIME, refDragProps } from './refDrag';
import { filterScenes } from './scenePicker';

const board: CanvasData = {
  nodes: [
    { id: 'g', type: 'group', label: 'Act', x: 0, y: 0, width: 600, height: 400 },
    { id: 'a', type: 'text', text: 'A', x: 40, y: 40, width: 100, height: 60 },
    { id: 'b', type: 'text', text: 'B', x: 300, y: 40, width: 100, height: 60 },
    { id: 'c', type: 'text', text: 'C', x: 900, y: 40, width: 100, height: 60 },
  ],
  edges: [
    { id: 'ab', fromNode: 'a', toNode: 'b', label: 'then' },
    { id: 'bc', fromNode: 'b', toNode: 'c' },
  ],
};

describe('copy and paste', () => {
  it('copies cards with the connections between them only', () => {
    const out = copyFragment(board, ['a', 'b']);
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(out.edges.map((e) => e.id)).toEqual(['ab']);
  });

  it('copies what lies in a group, and a chosen connection with its cards', () => {
    expect(copyFragment(board, ['g']).nodes.map((n) => n.id)).toEqual(['g', 'a', 'b']);
    const edgeOnly = copyFragment(board, [], ['bc']);
    expect(edgeOnly.nodes.map((n) => n.id)).toEqual(['b', 'c']);
    expect(edgeOnly.edges.map((e) => e.id)).toEqual(['bc']);
  });

  it('pastes with new ids, offset, keeping the connections between copies', () => {
    const fragment = readFragment(serializeCanvas(copyFragment(board, ['a', 'b'])))!;
    const copy = cloneFragment(fragment, 30, 30);
    expect(copy.nodes).toHaveLength(2);
    for (const n of copy.nodes) expect(['a', 'b']).not.toContain(n.id);
    expect(copy.nodes.map((n) => [n.x, n.y])).toEqual([[70, 70], [330, 70]]);
    expect(copy.nodes[0].text).toBe('A');
    expect(copy.edges).toHaveLength(1);
    expect(copy.edges[0].fromNode).toBe(copy.nodes[0].id);
    expect(copy.edges[0].toNode).toBe(copy.nodes[1].id);
    expect(copy.edges[0].label).toBe('then');
    expect(copy.edges[0].id).not.toBe('ab');
  });

  it('reads only canvas fragments as cards', () => {
    expect(readFragment('just words')).toBeNull();
    expect(readFragment('{"a": 1}')).toBeNull();
    expect(readFragment('{"nodes": []}')).toBeNull();
    expect(readFragment('{"nodes": [ broken')).toBeNull();
    expect(readFragment('{"nodes":[{"id":"x","type":"text","text":"hi","x":0,"y":0,"width":10,"height":10}]}')?.nodes[0].text).toBe('hi');
  });
});

describe('fitting cards', () => {
  const node = { id: 'n', type: 'text' as const, x: 0, y: 0, width: 200, height: 300 };
  it('fits the height to the content, within limits', () => {
    expect(fitSize(node, { content: 120, chrome: 4 })).toEqual({ width: 200, height: 124 });
    expect(fitSize(node, { content: 5, chrome: 4 }).height).toBe(40);
    expect(fitSize(node, { content: 99999, chrome: 4 }).height).toBe(MAX_FIT_HEIGHT);
  });
  it('keeps a picture’s shape at its width', () => {
    expect(fitSize(node, { content: 0, chrome: 0, ratio: 2 })).toEqual({ width: 200, height: 100 });
  });
});

describe('editing one section of a page', () => {
  const h = (level: number, text: string): PmNode => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
  const p = (text: string): PmNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const doc: PmNode = { type: 'doc', content: [p('intro'), h(2, 'Past'), p('old'), h(3, 'Child'), p('young'), h(2, 'Now'), p('new')] };

  it('finds the section and puts an edit back in its place', () => {
    const range = headingRange(doc, 'past');
    expect(range).toEqual([1, 5]);
    expect(sliceToHeading(doc, 'Past').content).toHaveLength(4);
    const edited: PmNode = { type: 'doc', content: [h(2, 'Long ago'), p('rewritten')] };
    const whole = spliceRange(doc, range, edited);
    expect(whole.content!.map((b) => b.content?.[0].text)).toEqual(['intro', 'Long ago', 'rewritten', 'Now', 'new']);
  });

  it('edits the whole document without a heading, or when it is gone', () => {
    expect(headingRange(doc, undefined)).toBeNull();
    expect(headingRange(doc, 'Missing')).toBeNull();
    const edited: PmNode = { type: 'doc', content: [p('all new')] };
    expect(spliceRange(doc, null, edited)).toBe(edited);
  });
});

describe('dragging onto a board', () => {
  it('sets the reference type on a native drag', () => {
    const set = new Map<string, string>();
    const props = refDragProps({ kind: 'scene', id: 's 1' });
    expect(props.draggable).toBe(true);
    props.onDragStart!({ dataTransfer: { setData: (k: string, v: string) => set.set(k, v), effectAllowed: 'all' } as unknown as DataTransfer });
    expect(parseRef(set.get(REF_MIME))).toEqual({ kind: 'scene', id: 's 1' });
    expect(set.has('text/plain')).toBe(false);
    expect(refDragProps(null)).toEqual({});
  });
});

describe('the scene picker', () => {
  const options = [
    { id: '1', label: 'Book One, Chapter 1, The road' },
    { id: '2', label: 'Book One, Chapter 2, The inn' },
    { id: '3', label: 'Book Two, Chapter 1, The road back' },
  ];
  it('matches every word typed, in reading order', () => {
    expect(filterScenes(options, 'road').map((o) => o.id)).toEqual(['1', '3']);
    expect(filterScenes(options, 'two road').map((o) => o.id)).toEqual(['3']);
    expect(filterScenes(options, '')).toHaveLength(3);
  });
});
