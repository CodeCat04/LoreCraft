/** Changes to a canvas, as pure functions returning a new canvas. The view records each for undo. */

import { boundsOf, insideGroup, type Rect } from './geometry';
import { newId, type CanvasData, type CanvasEdge, type CanvasNode } from './model';

export function nodeById(data: CanvasData, id: string): CanvasNode | undefined {
  return data.nodes.find((n) => n.id === id);
}

/** The ids to move when these are moved: a group takes what lies inside it. */
export function withContents(data: CanvasData, ids: Iterable<string>): Set<string> {
  const out = new Set<string>(ids);
  for (const id of [...out]) {
    const node = nodeById(data, id);
    if (node?.type === 'group') for (const inner of insideGroup(node, data.nodes)) out.add(inner.id);
  }
  return out;
}

export function moveNodes(data: CanvasData, ids: Set<string>, dx: number, dy: number): CanvasData {
  if (!dx && !dy) return data;
  return { ...data, nodes: data.nodes.map((n) => (ids.has(n.id) ? { ...n, x: Math.round(n.x + dx), y: Math.round(n.y + dy) } : n)) };
}

export function setPositions(data: CanvasData, positions: Map<string, { x: number; y: number }>): CanvasData {
  if (positions.size === 0) return data;
  return { ...data, nodes: data.nodes.map((n) => (positions.has(n.id) ? { ...n, ...positions.get(n.id)! } : n)) };
}

export function updateNode(data: CanvasData, id: string, patch: Partial<CanvasNode>): CanvasData {
  return {
    ...data,
    nodes: data.nodes.map((n) => {
      if (n.id !== id) return n;
      const next = { ...n, ...patch };
      for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key];
      return next;
    }),
  };
}

export function updateEdge(data: CanvasData, id: string, patch: Partial<CanvasEdge>): CanvasData {
  return {
    ...data,
    edges: data.edges.map((e) => {
      if (e.id !== id) return e;
      const next = { ...e, ...patch };
      for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key];
      return next;
    }),
  };
}

export function addNodes(data: CanvasData, nodes: CanvasNode[], edges: CanvasEdge[] = []): CanvasData {
  return { ...data, nodes: [...data.nodes, ...nodes], edges: [...data.edges, ...edges] };
}

/** Removes nodes and edges, and every edge left without both ends. */
export function removeItems(data: CanvasData, nodeIds: Set<string>, edgeIds: Set<string> = new Set()): CanvasData {
  return {
    ...data,
    nodes: data.nodes.filter((n) => !nodeIds.has(n.id)),
    edges: data.edges.filter((e) => !edgeIds.has(e.id) && !nodeIds.has(e.fromNode) && !nodeIds.has(e.toNode)),
  };
}

/** Copies nodes, and the edges between them, offset. Returns the canvas and the new ids. */
export function duplicate(data: CanvasData, ids: Set<string>, dx = 20, dy = 20): { data: CanvasData; ids: Set<string> } {
  const map = new Map<string, string>();
  const copies: CanvasNode[] = [];
  for (const n of data.nodes) {
    if (!ids.has(n.id)) continue;
    const id = newId();
    map.set(n.id, id);
    copies.push({ ...n, id, x: n.x + dx, y: n.y + dy });
  }
  const edges = data.edges
    .filter((e) => map.has(e.fromNode) && map.has(e.toNode))
    .map((e) => ({ ...e, id: newId(), fromNode: map.get(e.fromNode)!, toNode: map.get(e.toNode)! }));
  return { data: addNodes(data, copies, edges), ids: new Set(map.values()) };
}

export const GROUP_PADDING = 40;

/** A group box around these nodes, with room for its label. */
export function groupAround(nodes: Rect[], label = ''): CanvasNode | null {
  const box = boundsOf(nodes);
  if (!box) return null;
  return {
    id: newId(),
    type: 'group',
    label,
    x: box.x - GROUP_PADDING,
    y: box.y - GROUP_PADDING,
    width: box.width + GROUP_PADDING * 2,
    height: box.height + GROUP_PADDING * 2,
  };
}

/** Moves a node to the end, so it draws over the others. */
export function bringToFront(data: CanvasData, ids: Set<string>): CanvasData {
  return { ...data, nodes: [...data.nodes.filter((n) => !ids.has(n.id)), ...data.nodes.filter((n) => ids.has(n.id))] };
}

// ---- Copy and paste -----------------------------------------------------------------------

/**
 * The part of a canvas to put on the clipboard: these cards with what lies in their groups,
 * the connections between them, and each chosen connection with its two cards.
 */
export function copyFragment(data: CanvasData, ids: Iterable<string>, edgeIds: Iterable<string> = []): CanvasData {
  const keep = withContents(data, ids);
  const edgeSet = new Set(edgeIds);
  for (const e of data.edges) {
    if (edgeSet.has(e.id)) {
      keep.add(e.fromNode);
      keep.add(e.toNode);
    }
  }
  return {
    nodes: data.nodes.filter((n) => keep.has(n.id)),
    edges: data.edges.filter((e) => keep.has(e.fromNode) && keep.has(e.toNode)),
  };
}

/** Copies of a fragment's cards and connections with new ids, moved by dx and dy. */
export function cloneFragment(fragment: CanvasData, dx: number, dy: number): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const map = new Map<string, string>();
  const nodes = fragment.nodes.map((n) => {
    const id = newId();
    map.set(n.id, id);
    return { ...n, id, x: Math.round(n.x + dx), y: Math.round(n.y + dy) };
  });
  const edges = fragment.edges
    .filter((e) => map.has(e.fromNode) && map.has(e.toNode))
    .map((e) => ({ ...e, id: newId(), fromNode: map.get(e.fromNode)!, toNode: map.get(e.toNode)! }));
  return { nodes, edges };
}

// ---- Sizes ---------------------------------------------------------------------------------

/** Set on a text card once the writer resizes it by hand, so typing no longer grows it. */
export const FIXED_SIZE = 'lorecraftFixedSize';

export const MIN_CARD = { width: 80, height: 40 };
export const MAX_FIT_HEIGHT = 2000;

/**
 * The size that shows all of a card. `content` is the height its contents need, and
 * `chrome` the rest of the card around them. A picture or video passes its `ratio`
 * (width over height) and keeps its width.
 */
export function fitSize(node: CanvasNode, measured: { content: number; chrome: number; ratio?: number }): { width: number; height: number } {
  const width = node.width;
  const wanted = measured.ratio && measured.ratio > 0 ? width / measured.ratio : measured.content + measured.chrome;
  const height = Math.round(Math.min(MAX_FIT_HEIGHT, Math.max(MIN_CARD.height, wanted)));
  return { width, height };
}
