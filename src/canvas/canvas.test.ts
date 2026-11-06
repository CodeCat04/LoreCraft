import { describe, expect, it } from 'vitest';

import { align, arrangeGrid, distribute, lockAxis, snapMove, snapToGrid } from './arrange';
import {
  anchor,
  boundsOf,
  chooseSides,
  fitView,
  insideGroup,
  SpatialIndex,
  toScreen,
  toWorld,
  zoomAt,
} from './geometry';
import { History } from './history';
import { formatRef, parseCanvas, parseRef, safeWebUrl, serializeCanvas, youtubeEmbedUrl, type CanvasNode } from './model';
import { duplicate, groupAround, moveNodes, removeItems, withContents } from './ops';

/** The example from the JSON Canvas 1.0 spec page, shortened but with every node type. */
const SPEC_EXAMPLE = {
  nodes: [
    { id: '8132d4d894c80022', type: 'file', file: 'readme.md', x: -280, y: -200, width: 570, height: 560, color: '6' },
    { id: '7efdbbe0c4742315', type: 'file', file: '_site/logo.svg', x: -280, y: -440, width: 217, height: 80 },
    { id: '59e896bc8da20699', type: 'text', text: 'Learn more:\n\n- [Apps](/docs/apps)', x: 315, y: -200, width: 280, height: 220 },
    { id: 'ad0b3b9b5ded6eae', type: 'link', url: 'https://github.com/obsidianmd/jsoncanvas', x: 315, y: 40, width: 280, height: 80, color: '5' },
    { id: '6da4bd8ed4ffd1a4', type: 'group', label: 'Group', x: -320, y: -480, width: 960, height: 880, background: 'bg.png', backgroundStyle: 'cover' },
  ],
  edges: [
    { id: '6fa11ab87f90b8af', fromNode: '7efdbbe0c4742315', fromSide: 'right', toNode: '59e896bc8da20699', toSide: 'left', toEnd: 'arrow', label: 'see' },
    { id: 'aaaabbbbccccdddd', fromNode: '8132d4d894c80022', toNode: 'ad0b3b9b5ded6eae', color: '#ff0000', fromEnd: 'arrow', toEnd: 'none' },
  ],
};

const box = (id: string, x: number, y: number, width = 100, height = 50, type: CanvasNode['type'] = 'text'): CanvasNode => ({
  id,
  type,
  x,
  y,
  width,
  height,
});

describe('JSON Canvas', () => {
  it('round-trips the spec example exactly', () => {
    const parsed = parseCanvas(JSON.stringify(SPEC_EXAMPLE));
    expect(JSON.parse(serializeCanvas(parsed))).toEqual(SPEC_EXAMPLE);
  });

  it('keeps fields from other apps', () => {
    const parsed = parseCanvas({ nodes: [{ ...box('a', 0, 0), styleAttributes: { shape: 'pill' } }], edges: [], meta: 1 });
    expect(parsed.nodes[0].styleAttributes).toEqual({ shape: 'pill' });
    expect(parsed.meta).toBe(1);
  });

  it('drops what cannot be drawn', () => {
    const parsed = parseCanvas({
      nodes: [box('a', 0, 0), { id: 'b', type: 'weird', x: 0, y: 0 }, box('a', 5, 5), { type: 'text' }, { ...box('c', 1.6, Number.NaN), color: 'red' }],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'gone' }, { id: 'f', fromNode: 'a', toNode: 'c', fromSide: 'middle' }],
    });
    expect(parsed.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(parsed.nodes[1]).toMatchObject({ x: 2, y: 0 });
    expect(parsed.nodes[1].color).toBeUndefined();
    expect(parsed.edges).toEqual([{ id: 'f', fromNode: 'a', toNode: 'c' }]);
  });

  it('refuses what is not a canvas', () => {
    expect(() => parseCanvas('nope')).toThrow();
    expect(() => parseCanvas('[1]')).toThrow();
    expect(() => parseCanvas('{"nodes": 3}')).toThrow();
    expect(parseCanvas('')).toEqual({ nodes: [], edges: [] });
  });

  it('reads and writes LoreCraft references', () => {
    expect(parseRef('lorecraft:page/abc')).toEqual({ kind: 'page', id: 'abc' });
    expect(parseRef(formatRef({ kind: 'scene', id: 'x y', heading: 'The Fall' }))).toEqual({ kind: 'scene', id: 'x y', heading: 'The Fall' });
    expect(parseRef('notes/readme.md')).toBeNull();
    expect(parseRef('lorecraft:secret/abc')).toBeNull();
  });

  it('lets only web addresses load', () => {
    expect(safeWebUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeWebUrl('javascript:alert(1)')).toBeNull();
    expect(safeWebUrl('lbasset://localhost/abc')).toBeNull();
    expect(safeWebUrl('http://tauri.localhost/')).toBe('http://tauri.localhost/');
    expect(safeWebUrl('https://user:pw@example.com')).toBeNull();
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(youtubeEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=3')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(youtubeEmbedUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeEmbedUrl('https://youtube.com/watch?v="><script>')).toBeNull();
  });
});

describe('geometry', () => {
  it('converts between screen and world and zooms toward a point', () => {
    const view = { x: 100, y: 50, zoom: 2 };
    expect(toWorld(view, { x: 300, y: 250 })).toEqual({ x: 100, y: 100 });
    expect(toScreen(view, { x: 100, y: 100 })).toEqual({ x: 300, y: 250 });
    const zoomed = zoomAt(view, { x: 300, y: 250 }, 4);
    expect(toWorld(zoomed, { x: 300, y: 250 })).toEqual({ x: 100, y: 100 });
    expect(zoomAt(view, { x: 0, y: 0 }, 100).zoom).toBe(4);
  });

  it('fits a box in the screen', () => {
    const view = fitView({ x: 0, y: 0, width: 1000, height: 500 }, 548, 548, 24);
    expect(view.zoom).toBeCloseTo(0.5);
    expect(toScreen(view, { x: 500, y: 250 })).toEqual({ x: 274, y: 274 });
    expect(boundsOf([box('a', 0, 0), box('b', 200, -10, 10, 10)])).toEqual({ x: 0, y: -10, width: 210, height: 60 });
    expect(boundsOf([])).toBeNull();
  });

  it('picks facing sides and anchors', () => {
    expect(chooseSides(box('a', 0, 0), box('b', 300, 0))).toEqual({ from: 'right', to: 'left' });
    expect(chooseSides(box('a', 0, 0), box('b', 0, 300))).toEqual({ from: 'bottom', to: 'top' });
    expect(anchor(box('a', 0, 0), 'bottom')).toEqual({ x: 50, y: 50 });
  });

  it('hit-tests through the index, cards over groups', () => {
    const nodes = [box('g', -50, -50, 400, 400, 'group'), box('a', 0, 0), box('b', 2000, 2000), box('c', 50, 20)];
    const index = new SpatialIndex(nodes);
    expect(index.hit({ x: 60, y: 30 })?.id).toBe('c');
    expect(index.hit({ x: 10, y: 10 })?.id).toBe('a');
    expect(index.hit({ x: 300, y: 300 })?.id).toBe('g');
    expect(index.hit({ x: 1000, y: 1000 })).toBeNull();
    expect(index.query({ x: 1900, y: 1900, width: 200, height: 200 }).map((n) => n.id)).toEqual(['b']);
  });

  it('hit-tests 10,000 cards quickly', () => {
    const nodes = Array.from({ length: 10000 }, (_, i) => box(`n${i}`, (i % 100) * 300, Math.floor(i / 100) * 200));
    const started = performance.now();
    const index = new SpatialIndex(nodes);
    for (let i = 0; i < 1000; i++) index.hit({ x: (i * 37) % 30000, y: (i * 53) % 20000 });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('finds what lies in a group', () => {
    const nodes = [box('g', 0, 0, 500, 500, 'group'), box('in', 10, 10), box('out', 450, 450)];
    expect(insideGroup(nodes[0], nodes).map((n) => n.id)).toEqual(['in']);
  });
});

describe('snapping and arranging', () => {
  it('snaps to the grid', () => {
    expect(snapToGrid(29)).toBe(20);
    expect(snapToGrid(31)).toBe(40);
    const snap = snapMove(box('m', 0, 0), 33, 7, [], 8);
    expect(snap).toEqual({ dx: 40, dy: 0, guides: [] });
  });

  it('snaps to another card edge and shows a guide', () => {
    const other = box('o', 205, 300, 100, 50);
    const snap = snapMove(box('m', 0, 0), 103, 0, [other], 8);
    // Moving's left (103) snaps to the other's left (205)? No: its right (203) snaps to 205.
    expect(snap.dx).toBe(105);
    expect(snap.guides[0]).toMatchObject({ axis: 'x', at: 205 });
  });

  it('locks to one axis', () => {
    expect(lockAxis(10, 3)).toEqual({ dx: 10, dy: 0 });
    expect(lockAxis(-1, -30)).toEqual({ dx: 0, dy: -30 });
  });

  it('aligns', () => {
    const items = [box('a', 0, 0, 100), box('b', 50, 100, 200), box('c', 10, 300, 50)];
    expect(align(items, 'left').get('b')).toEqual({ x: 0, y: 100 });
    expect(align(items, 'right').get('c')).toEqual({ x: 200, y: 300 });
    expect(align(items, 'centerX').get('a')).toEqual({ x: 75, y: 0 });
    expect(align(items, 'top').get('c')).toEqual({ x: 10, y: 0 });
    expect(align(items, 'bottom').get('a')).toEqual({ x: 0, y: 300 });
    expect(align([items[0]], 'left').size).toBe(0);
  });

  it('spreads evenly', () => {
    const items = [box('a', 0, 0, 100), box('b', 120, 0, 100), box('c', 400, 0, 100)];
    const out = distribute(items, 'x');
    expect(out.get('a')).toEqual({ x: 0, y: 0 });
    expect(out.get('b')).toEqual({ x: 200, y: 0 });
    expect(out.get('c')).toEqual({ x: 400, y: 0 });
  });

  it('arranges a grid', () => {
    const items = [box('a', 0, 0), box('b', 500, 0), box('c', 0, 500), box('d', 500, 500), box('e', 900, 900)];
    const out = arrangeGrid(items, 10);
    expect(out.get('a')).toEqual({ x: 0, y: 0 });
    expect(out.get('b')).toEqual({ x: 110, y: 0 });
    expect(out.get('c')).toEqual({ x: 220, y: 0 });
    expect(out.get('d')).toEqual({ x: 0, y: 60 });
  });
});

describe('changes', () => {
  const data = parseCanvas({
    nodes: [box('g', 0, 0, 500, 500, 'group'), box('a', 10, 10), box('b', 800, 0)],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  });

  it('moves a group with what is inside', () => {
    const ids = withContents(data, ['g']);
    expect([...ids].sort()).toEqual(['a', 'g']);
    const moved = moveNodes(data, ids, 5, 5);
    expect(moved.nodes.map((n) => [n.x, n.y])).toEqual([[5, 5], [15, 15], [800, 0]]);
    expect(data.nodes[0].x).toBe(0);
  });

  it('removes edges with their nodes', () => {
    expect(removeItems(data, new Set(['b'])).edges).toEqual([]);
  });

  it('duplicates with the edges between', () => {
    const { data: out, ids } = duplicate(data, new Set(['a', 'b']));
    expect(out.nodes).toHaveLength(5);
    expect(out.edges).toHaveLength(2);
    expect(ids.size).toBe(2);
    expect(ids.has(out.edges[1].fromNode)).toBe(true);
  });

  it('groups around a selection', () => {
    expect(groupAround([box('a', 0, 0), box('b', 200, 100)])).toMatchObject({ type: 'group', x: -40, y: -40, width: 380, height: 230 });
  });
});

describe('undo', () => {
  it('undoes and redoes, and merges quick steps with one key', () => {
    const history = new History<number>();
    history.record(0, null, 0);
    history.record(1, 'type', 1000);
    history.record(2, 'type', 1500);
    expect(history.undo(3)).toBe(1);
    expect(history.undo(1)).toBe(0);
    expect(history.undo(0)).toBeNull();
    expect(history.redo(0)).toBe(1);
    expect(history.redo(1)).toBe(3);
    expect(history.canRedo).toBe(false);
  });

  it('forgets the future after a new change and keeps a limit', () => {
    const history = new History<number>(3);
    for (let i = 0; i < 5; i++) history.record(i, null, i * 5000);
    expect(history.undo(5)).toBe(4);
    history.record(4, null, 99999);
    expect(history.canRedo).toBe(false);
    expect(history.undo(5)).toBe(4);
    expect(history.undo(4)).toBe(3);
    expect(history.undo(3)).toBe(2);
    expect(history.undo(2)).toBeNull();
  });
});
