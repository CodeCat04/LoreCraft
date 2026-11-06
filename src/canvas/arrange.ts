/** Snapping, aligning, spreading and laying out cards. Pure functions over boxes. */

import type { Rect } from './geometry';

export const GRID = 20;

export function snapToGrid(value: number, grid = GRID): number {
  return Math.round(value / grid) * grid;
}

/** A line to draw while snapping: vertical at `x`, or horizontal at `y`, across a span. */
export interface Guide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

export interface Snap {
  dx: number;
  dy: number;
  guides: Guide[];
}

function linesX(r: Rect): number[] {
  return [r.x, r.x + r.width / 2, r.x + r.width];
}
function linesY(r: Rect): number[] {
  return [r.y, r.y + r.height / 2, r.y + r.height];
}

/**
 * Snaps a moving box, already moved by (dx, dy), to the edges and centers of the others when
 * one is within `threshold`, otherwise to the grid. Returns the corrected move and the guides.
 */
export function snapMove(moving: Rect, dx: number, dy: number, others: Rect[], threshold: number, grid = GRID): Snap {
  const moved = { ...moving, x: moving.x + dx, y: moving.y + dy };
  let bestX: { delta: number; at: number } | null = null;
  let bestY: { delta: number; at: number } | null = null;
  for (const other of others) {
    for (const a of linesX(moved)) {
      for (const b of linesX(other)) {
        const delta = b - a;
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, at: b };
      }
    }
    for (const a of linesY(moved)) {
      for (const b of linesY(other)) {
        const delta = b - a;
        if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, at: b };
      }
    }
  }
  const outX = bestX ? dx + bestX.delta : snapToGrid(moving.x + dx, grid) - moving.x;
  const outY = bestY ? dy + bestY.delta : snapToGrid(moving.y + dy, grid) - moving.y;
  const final = { ...moving, x: moving.x + outX, y: moving.y + outY };
  const guides: Guide[] = [];
  if (bestX) {
    const spans = others.filter((o) => linesX(o).some((v) => Math.abs(v - bestX.at) < 0.5));
    const ys = [final.y, final.y + final.height, ...spans.flatMap((o) => [o.y, o.y + o.height])];
    guides.push({ axis: 'x', at: bestX.at, from: Math.min(...ys), to: Math.max(...ys) });
  }
  if (bestY) {
    const spans = others.filter((o) => linesY(o).some((v) => Math.abs(v - bestY.at) < 0.5));
    const xs = [final.x, final.x + final.width, ...spans.flatMap((o) => [o.x, o.x + o.width])];
    guides.push({ axis: 'y', at: bestY.at, from: Math.min(...xs), to: Math.max(...xs) });
  }
  return { dx: outX, dy: outY, guides };
}

/** Keeps only the larger part of a move, for Shift-drag. */
export function lockAxis(dx: number, dy: number): { dx: number; dy: number } {
  return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy };
}

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY';

/** New positions, by id, lining the boxes up on the selection's own edge or middle. */
export function align<T extends Rect & { id: string }>(items: T[], mode: AlignMode): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (items.length < 2) return out;
  const minX = Math.min(...items.map((r) => r.x));
  const maxX = Math.max(...items.map((r) => r.x + r.width));
  const minY = Math.min(...items.map((r) => r.y));
  const maxY = Math.max(...items.map((r) => r.y + r.height));
  for (const r of items) {
    let { x, y } = r;
    if (mode === 'left') x = minX;
    if (mode === 'right') x = maxX - r.width;
    if (mode === 'centerX') x = Math.round((minX + maxX) / 2 - r.width / 2);
    if (mode === 'top') y = minY;
    if (mode === 'bottom') y = maxY - r.height;
    if (mode === 'centerY') y = Math.round((minY + maxY) / 2 - r.height / 2);
    out.set(r.id, { x, y });
  }
  return out;
}

/** Equal gaps between boxes along an axis, keeping the first and last where they are. */
export function distribute<T extends Rect & { id: string }>(items: T[], axis: 'x' | 'y'): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (items.length < 3) return out;
  const size = axis === 'x' ? 'width' : 'height';
  const sorted = [...items].sort((a, b) => a[axis] - b[axis]);
  const start = sorted[0][axis];
  const last = sorted[sorted.length - 1];
  const end = last[axis] + last[size];
  const total = sorted.reduce((sum, r) => sum + r[size], 0);
  const gap = (end - start - total) / (sorted.length - 1);
  let at = start;
  for (const r of sorted) {
    out.set(r.id, axis === 'x' ? { x: Math.round(at), y: r.y } : { x: r.x, y: Math.round(at) });
    at += r[size] + gap;
  }
  return out;
}

/** Lays boxes out in rows from the selection's top left, in reading order. */
export function arrangeGrid<T extends Rect & { id: string }>(items: T[], gap = GRID * 2): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (items.length === 0) return out;
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const columns = Math.ceil(Math.sqrt(sorted.length));
  const cellW = Math.max(...sorted.map((r) => r.width));
  const originX = Math.min(...sorted.map((r) => r.x));
  let y = Math.min(...sorted.map((r) => r.y));
  for (let row = 0; row * columns < sorted.length; row++) {
    const cells = sorted.slice(row * columns, row * columns + columns);
    cells.forEach((r, i) => out.set(r.id, { x: originX + i * (cellW + gap), y }));
    y += Math.max(...cells.map((r) => r.height)) + gap;
  }
  return out;
}
