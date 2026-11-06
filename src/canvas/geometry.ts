/** Plain geometry for the canvas: boxes, the view, where edges attach, and fast hit-testing. */

import type { CanvasNode, Side } from './model';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What part of the board is on screen: a screen point p shows world point (p - offset) / zoom. */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function toWorld(view: Viewport, screen: Point): Point {
  return { x: (screen.x - view.x) / view.zoom, y: (screen.y - view.y) / view.zoom };
}

export function toScreen(view: Viewport, world: Point): Point {
  return { x: world.x * view.zoom + view.x, y: world.y * view.zoom + view.y };
}

/** Zooms so the world point under `screen` stays under it. */
export function zoomAt(view: Viewport, screen: Point, zoom: number): Viewport {
  const next = clampZoom(zoom);
  const world = toWorld(view, screen);
  return { zoom: next, x: screen.x - world.x * next, y: screen.y - world.y * next };
}

/** The smallest box around all of these, or null for none. */
export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The view that shows `rect` whole in a `width` by `height` screen, with a margin. */
export function fitView(rect: Rect, width: number, height: number, margin = 48, maxZoom = 1): Viewport {
  const zoom = clampZoom(
    Math.min(maxZoom, (width - margin * 2) / Math.max(1, rect.width), (height - margin * 2) / Math.max(1, rect.height)),
  );
  return {
    zoom,
    x: width / 2 - (rect.x + rect.width / 2) * zoom,
    y: height / 2 - (rect.y + rect.height / 2) * zoom,
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** True if `inner` lies entirely within `outer`. */
export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** A box from two corners in any order. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** The middle of one side of a box, where an edge attaches. */
export function anchor(r: Rect, side: Side): Point {
  switch (side) {
    case 'top':
      return { x: r.x + r.width / 2, y: r.y };
    case 'bottom':
      return { x: r.x + r.width / 2, y: r.y + r.height };
    case 'left':
      return { x: r.x, y: r.y + r.height / 2 };
    case 'right':
      return { x: r.x + r.width, y: r.y + r.height / 2 };
  }
}

/** The side of `r` that faces the point. */
export function sideFacing(r: Rect, p: Point): Side {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const dx = (p.x - cx) / Math.max(1, r.width);
  const dy = (p.y - cy) / Math.max(1, r.height);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

const NORMALS: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** The sides to join two boxes by, when the canvas does not say. */
export function chooseSides(a: Rect, b: Rect): { from: Side; to: Side } {
  const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  return { from: sideFacing(a, cb), to: sideFacing(b, ca) };
}

/** An SVG path for an edge: a curve leaving and arriving square to each side. */
export function edgePath(from: Point, fromSide: Side, to: Point, toSide: Side | null): string {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const pull = Math.min(160, Math.max(30, distance / 2.5));
  const n1 = NORMALS[fromSide];
  const c1 = { x: from.x + n1.x * pull, y: from.y + n1.y * pull };
  const n2 = toSide ? NORMALS[toSide] : { x: 0, y: 0 };
  const c2 = { x: to.x + n2.x * pull, y: to.y + n2.y * pull };
  return `M${from.x},${from.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`;
}

/** The middle of an edge's curve, for its label. */
export function edgeMidpoint(from: Point, fromSide: Side, to: Point, toSide: Side): Point {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const pull = Math.min(160, Math.max(30, distance / 2.5));
  const n1 = NORMALS[fromSide];
  const n2 = NORMALS[toSide];
  const c1 = { x: from.x + n1.x * pull, y: from.y + n1.y * pull };
  const c2 = { x: to.x + n2.x * pull, y: to.y + n2.y * pull };
  // A cubic Bezier at t = 0.5.
  return { x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8, y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8 };
}

/**
 * Finds cards by place without looking at every one. Cards go into square buckets, and a
 * query looks only at the buckets it touches. Built again when the cards change, which costs
 * about as much as one pass over them.
 */
export class SpatialIndex {
  private buckets = new Map<string, CanvasNode[]>();
  private order = new Map<string, number>();
  constructor(
    nodes: CanvasNode[],
    private size = 512,
  ) {
    nodes.forEach((node, i) => {
      this.order.set(node.id, i);
      this.cells(node, (key) => {
        let list = this.buckets.get(key);
        if (!list) this.buckets.set(key, (list = []));
        list.push(node);
      });
    });
  }

  private cells(r: Rect, visit: (key: string) => void) {
    const x0 = Math.floor(r.x / this.size);
    const y0 = Math.floor(r.y / this.size);
    const x1 = Math.floor((r.x + r.width) / this.size);
    const y1 = Math.floor((r.y + r.height) / this.size);
    // A huge box (a group around everything) is fine: it costs its own buckets once.
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) visit(`${x},${y}`);
  }

  /** Cards touching the box, in drawing order. */
  query(r: Rect): CanvasNode[] {
    const found = new Map<string, CanvasNode>();
    this.cells(r, (key) => {
      for (const node of this.buckets.get(key) ?? []) if (!found.has(node.id) && intersects(node, r)) found.set(node.id, node);
    });
    return [...found.values()].sort((a, b) => (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0));
  }

  /** The topmost card under a point. Cards are drawn over groups, so a card wins. */
  hit(p: Point): CanvasNode | null {
    const under = this.query({ x: p.x, y: p.y, width: 0.01, height: 0.01 });
    const cards = under.filter((n) => n.type !== 'group');
    const pick = cards.length ? cards : under;
    return pick[pick.length - 1] ?? null;
  }
}

/**
 * The nodes inside a group: those whose box lies within it. A nested group's own contents
 * come along, since they lie within too.
 */
export function insideGroup(group: Rect & { id: string }, nodes: CanvasNode[]): CanvasNode[] {
  return nodes.filter((n) => n.id !== group.id && contains(group, n));
}

/** Groups drawn first, the largest first, so a nested group sits over the one around it. */
export function drawingOrder(nodes: CanvasNode[]): CanvasNode[] {
  const groups = nodes.filter((n) => n.type === 'group').sort((a, b) => b.width * b.height - a.width * a.height);
  return [...groups, ...nodes.filter((n) => n.type !== 'group')];
}
