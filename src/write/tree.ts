/**
 * The book's tree as plain data: lookup, word totals, reading order, and working out
 * where a drag or a key press would put a node. Everything here is pure, so the rules
 * can be tested without a window. `check_placement` in `manuscript.rs` has the final
 * say, and the rules here must agree with it.
 */

import { t } from '../lib/i18n';
import type { NodeKind, NodeMeta, NodeStatus } from '../lib/types';

export interface TreeIndex {
  byId: Map<string, NodeMeta>;
  /** Children in order. The key `null` holds the book's top level. */
  childrenOf: Map<string | null, NodeMeta[]>;
  /** Words in each node, summed up the tree. */
  totals: Map<string, number>;
  /** Scenes in reading order. */
  scenes: NodeMeta[];
  /** Chapters in reading order. */
  chapters: NodeMeta[];
  parts: NodeMeta[];
  /** Words in the whole book. */
  words: number;
}

const NO_CHILDREN: NodeMeta[] = [];

export function indexTree(nodes: NodeMeta[]): TreeIndex {
  const byId = new Map<string, NodeMeta>();
  for (const node of nodes) byId.set(node.id, node);

  const childrenOf = new Map<string | null, NodeMeta[]>();
  for (const node of nodes) {
    // A parent that is missing should not make its children vanish.
    const key = node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;
    const list = childrenOf.get(key);
    if (list) list.push(node);
    else childrenOf.set(key, [node]);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.position - b.position);

  const totals = new Map<string, number>();
  const scenes: NodeMeta[] = [];
  const chapters: NodeMeta[] = [];
  const parts: NodeMeta[] = [];
  const visit = (node: NodeMeta): number => {
    if (node.kind === 'scene') scenes.push(node);
    else if (node.kind === 'chapter') chapters.push(node);
    else parts.push(node);
    let total = node.kind === 'scene' ? node.wordCount : 0;
    for (const child of childrenOf.get(node.id) ?? NO_CHILDREN) total += visit(child);
    totals.set(node.id, total);
    return total;
  };
  let words = 0;
  for (const node of childrenOf.get(null) ?? NO_CHILDREN) words += visit(node);

  return { byId, childrenOf, totals, scenes, chapters, parts, words };
}

export const EMPTY_INDEX: TreeIndex = indexTree([]);

export function childrenOf(index: TreeIndex, id: string | null): NodeMeta[] {
  return index.childrenOf.get(id) ?? NO_CHILDREN;
}

/** The node's parent id as the tree sees it, which is null for a top-level node. */
function parentKey(index: TreeIndex, node: NodeMeta): string | null {
  return node.parentId !== null && index.byId.has(node.parentId) ? node.parentId : null;
}

/** From the node's parent up to the top. */
export function ancestorsOf(index: TreeIndex, id: string): NodeMeta[] {
  const out: NodeMeta[] = [];
  let cursor = index.byId.get(id);
  while (cursor) {
    const parent = cursor.parentId === null ? undefined : index.byId.get(cursor.parentId);
    if (parent) out.push(parent);
    cursor = parent;
  }
  return out;
}

export function isInside(index: TreeIndex, id: string, ancestorId: string): boolean {
  return ancestorsOf(index, id).some((a) => a.id === ancestorId);
}

/** The chapter a scene is in, or the chapter itself. */
export function chapterOf(index: TreeIndex, id: string): NodeMeta | undefined {
  const node = index.byId.get(id);
  if (!node) return undefined;
  if (node.kind === 'chapter') return node;
  return ancestorsOf(index, id).find((a) => a.kind === 'chapter');
}

/** The scenes under any node, in reading order. */
export function scenesUnder(index: TreeIndex, id: string): NodeMeta[] {
  const node = index.byId.get(id);
  if (!node) return [];
  if (node.kind === 'scene') return [node];
  const out: NodeMeta[] = [];
  for (const child of childrenOf(index, id)) out.push(...scenesUnder(index, child.id));
  return out;
}

/** The chapters under a node. A chapter or scene answers with its own chapter. */
export function chaptersUnder(index: TreeIndex, id: string | null): NodeMeta[] {
  if (id === null) return index.chapters;
  const node = index.byId.get(id);
  if (!node) return [];
  if (node.kind === 'part') return childrenOf(index, id).filter((c) => c.kind === 'chapter');
  const chapter = chapterOf(index, id);
  return chapter ? [chapter] : [];
}

export function neighborScene(index: TreeIndex, id: string, direction: 1 | -1): NodeMeta | undefined {
  const at = index.scenes.findIndex((s) => s.id === id);
  return at < 0 ? undefined : index.scenes[at + direction];
}

// ---------------------------------------------------------------------------
// Rows for the binder
// ---------------------------------------------------------------------------

export interface BinderRow {
  id: string;
  kind: NodeKind;
  title: string;
  status: NodeStatus;
  parentId: string | null;
  depth: number;
  words: number;
  hasChildren: boolean;
  open: boolean;
  /** One-based place among its siblings, for assistive technology. */
  place: number;
  siblings: number;
}

export function visibleRows(index: TreeIndex, collapsed: ReadonlySet<string>): BinderRow[] {
  const rows: BinderRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const list = childrenOf(index, parentId);
    list.forEach((node, i) => {
      const hasChildren = childrenOf(index, node.id).length > 0;
      const open = !collapsed.has(node.id);
      rows.push({
        id: node.id,
        kind: node.kind,
        title: node.title,
        status: node.status,
        parentId,
        depth,
        words: index.totals.get(node.id) ?? 0,
        hasChildren,
        open,
        place: i + 1,
        siblings: list.length,
      });
      if (hasChildren && open) walk(node.id, depth + 1);
    });
  };
  walk(null, 0);
  return rows;
}

// ---------------------------------------------------------------------------
// Where a node may go
// ---------------------------------------------------------------------------

/** Must match `check_placement` in `manuscript.rs`. */
export function canContain(parent: NodeKind | null, child: NodeKind): boolean {
  switch (child) {
    case 'part':
      return parent === null;
    case 'chapter':
      return parent === null || parent === 'part';
    case 'scene':
      return parent === 'chapter';
  }
}

export type DropZone = 'before' | 'inside' | 'after';

/** Which part of a row the pointer is over, from 0 at its top to 1 at its bottom. */
export function zoneAt(fraction: number, canDropInside: boolean): DropZone {
  if (canDropInside) {
    if (fraction < 0.25) return 'before';
    return fraction > 0.75 ? 'after' : 'inside';
  }
  return fraction < 0.5 ? 'before' : 'after';
}

/** Where the drop line is drawn: at an edge of a row, or around a row. */
export interface DropMarker {
  rowId: string;
  edge: 'top' | 'bottom' | 'inside';
  depth: number;
}

export type DropPlan =
  | { kind: 'move'; parentId: string | null; index: number; marker: DropMarker }
  /** Dropping here would change nothing. */
  | { kind: 'none' }
  | { kind: 'refused'; reason: string; marker: DropMarker };

export const NOT_INSIDE_SELF = 'An item cannot be moved inside itself.';
export const SCENE_NEEDS_CHAPTER = 'A scene must go inside a chapter.';
export const CHAPTER_PLACE = 'A chapter can go in a part or at the top of the book.';
export const PART_PLACE = 'A part can only go at the top of the book.';

/** Why a drop was refused, in the interface language. */
export function refusalText(reason: string): string {
  switch (reason) {
    case NOT_INSIDE_SELF:
      return t('An item cannot be moved inside itself.');
    case SCENE_NEEDS_CHAPTER:
      return t('A scene must go inside a chapter.');
    case CHAPTER_PLACE:
      return t('A chapter can go in a part or at the top of the book.');
    case PART_PLACE:
      return t('A part can only go at the top of the book.');
    default:
      return reason;
  }
}

function depthOf(index: TreeIndex, id: string | null): number {
  return id === null ? -1 : ancestorsOf(index, id).length;
}

/** The last row shown for a node: itself, or its deepest open last child. */
function lastVisibleRow(index: TreeIndex, collapsed: ReadonlySet<string>, id: string): string {
  let cursor = id;
  for (;;) {
    const list = childrenOf(index, cursor);
    if (list.length === 0 || collapsed.has(cursor)) return cursor;
    cursor = list[list.length - 1].id;
  }
}

/** Turns "before or after this sibling, or at this place" into a move, if it changes anything. */
function moveTo(
  index: TreeIndex,
  dragged: NodeMeta,
  parentId: string | null,
  place: { before: string } | { after: string } | { at: number } | 'end',
  marker: DropMarker,
): DropPlan {
  const others = childrenOf(index, parentId).filter((n) => n.id !== dragged.id);
  let at: number;
  if (place === 'end') at = others.length;
  else if ('at' in place) at = Math.min(place.at, others.length);
  else if ('before' in place) at = others.findIndex((n) => n.id === place.before);
  else at = others.findIndex((n) => n.id === place.after) + 1;

  if (parentKey(index, dragged) === parentId) {
    const current = childrenOf(index, parentId).findIndex((n) => n.id === dragged.id);
    if (current === at) return { kind: 'none' };
  }
  return { kind: 'move', parentId, index: at, marker };
}

/**
 * What dropping `draggedId` on part of the row `overId` means. The rows are a flat list
 * but the tree has rules, so a line drawn between two rows has to be read according to
 * what is being dragged.
 */
export function planDrop(
  index: TreeIndex,
  collapsed: ReadonlySet<string>,
  draggedId: string,
  overId: string,
  zone: DropZone,
): DropPlan {
  const dragged = index.byId.get(draggedId);
  const over = index.byId.get(overId);
  if (!dragged || !over || dragged.id === over.id) return { kind: 'none' };

  const depth = depthOf(index, over.id);
  const refuse = (reason: string): DropPlan => ({
    kind: 'refused',
    reason,
    marker: { rowId: over.id, edge: zone === 'before' ? 'top' : zone === 'after' ? 'bottom' : 'inside', depth },
  });
  if (isInside(index, over.id, dragged.id)) return refuse(NOT_INSIDE_SELF);

  const parent = parentKey(index, over);
  const opened = childrenOf(index, over.id).length > 0 && !collapsed.has(over.id);
  const below = { rowId: over.id, edge: 'bottom' as const };
  const above = { rowId: over.id, edge: 'top' as const };

  switch (dragged.kind) {
    case 'scene': {
      if (over.kind === 'scene') {
        const place = zone === 'before' ? { before: over.id } : { after: over.id };
        return moveTo(index, dragged, parent, place, { ...(zone === 'before' ? above : below), depth });
      }
      if (over.kind !== 'chapter') return refuse(SCENE_NEEDS_CHAPTER);
      if (zone === 'inside') {
        return moveTo(index, dragged, over.id, 'end', { rowId: over.id, edge: 'inside', depth });
      }
      if (zone === 'after') {
        if (opened) return moveTo(index, dragged, over.id, { at: 0 }, { ...below, depth: depth + 1 });
        return moveTo(index, dragged, over.id, 'end', { ...below, depth: depth + 1 });
      }
      // A line above a chapter is the end of whichever chapter comes before it.
      const at = index.chapters.findIndex((c) => c.id === over.id);
      const previous = index.chapters[at - 1];
      if (!previous) return refuse(SCENE_NEEDS_CHAPTER);
      return moveTo(index, dragged, previous.id, 'end', { ...above, depth: depthOf(index, previous.id) + 1 });
    }

    case 'chapter': {
      if (over.kind === 'part') {
        if (zone === 'inside') {
          return moveTo(index, dragged, over.id, 'end', { rowId: over.id, edge: 'inside', depth });
        }
        if (zone === 'before') return moveTo(index, dragged, null, { before: over.id }, { ...above, depth });
        if (opened) return moveTo(index, dragged, over.id, { at: 0 }, { ...below, depth: depth + 1 });
        return moveTo(index, dragged, null, { after: over.id }, { ...below, depth });
      }
      if (over.kind === 'chapter') {
        if (zone === 'before') return moveTo(index, dragged, parent, { before: over.id }, { ...above, depth });
        const rowId = lastVisibleRow(index, collapsed, over.id);
        return moveTo(index, dragged, parent, { after: over.id }, { rowId, edge: 'bottom', depth });
      }
      // Over a scene: only the line below a chapter's last scene is a place for a chapter.
      const siblings = childrenOf(index, parent);
      if (zone === 'after' && parent !== null && siblings[siblings.length - 1]?.id === over.id) {
        const chapter = index.byId.get(parent);
        if (chapter) {
          return moveTo(index, dragged, parentKey(index, chapter), { after: chapter.id }, { ...below, depth: depth - 1 });
        }
      }
      return refuse(CHAPTER_PLACE);
    }

    case 'part': {
      if (parent === null) {
        if (zone === 'before') return moveTo(index, dragged, null, { before: over.id }, { ...above, depth });
        const rowId = lastVisibleRow(index, collapsed, over.id);
        return moveTo(index, dragged, null, { after: over.id }, { rowId, edge: 'bottom', depth });
      }
      // Below the very last row of a top-level node is still the top level.
      const top = ancestorsOf(index, over.id).at(-1);
      if (zone === 'after' && top && lastVisibleRow(index, collapsed, top.id) === over.id) {
        return moveTo(index, dragged, null, { after: top.id }, { ...below, depth: 0 });
      }
      return refuse(PART_PLACE);
    }
  }
}

export interface CardDrop {
  parentId: string;
  index: number;
  /** The card the line is drawn beside, or none for an empty chapter. */
  cardId: string | null;
  side: 'before' | 'after';
}

/** Where a dragged card lands beside another card, or at the end of a chapter if none. */
export function planCardDrop(
  index: TreeIndex,
  draggedId: string,
  chapterId: string,
  overCardId: string | null,
  side: 'before' | 'after',
): CardDrop | null {
  const dragged = index.byId.get(draggedId);
  if (!dragged || overCardId === draggedId) return null;
  const all = childrenOf(index, chapterId);
  const others = all.filter((n) => n.id !== draggedId);
  let at: number;
  let drop: CardDrop;
  if (overCardId) {
    const overAt = others.findIndex((n) => n.id === overCardId);
    if (overAt < 0) return null;
    at = side === 'before' ? overAt : overAt + 1;
    drop = { parentId: chapterId, index: at, cardId: overCardId, side };
  } else {
    at = others.length;
    drop = { parentId: chapterId, index: at, cardId: others[others.length - 1]?.id ?? null, side: 'after' };
  }
  // Dropping a card back where it is changes nothing.
  if (dragged.parentId === chapterId && all.findIndex((n) => n.id === draggedId) === at) return null;
  return drop;
}

/**
 * The deleted nodes that can be restored by themselves. Nodes deleted along with their
 * parent come back with it, so they are counted instead of listed.
 */
export function restorableNodes(trash: NodeMeta[]): (NodeMeta & { carried: number })[] {
  const byId = new Map(trash.map((n) => [n.id, n]));
  const carried = new Map<string, number>();
  const tops: NodeMeta[] = [];
  for (const node of trash) {
    let top = node;
    for (;;) {
      const parent = top.parentId ? byId.get(top.parentId) : undefined;
      if (!parent || parent.deletedAt !== top.deletedAt) break;
      top = parent;
    }
    if (top === node) tops.push(node);
    else carried.set(top.id, (carried.get(top.id) ?? 0) + 1);
  }
  return tops.map((n) => ({ ...n, carried: carried.get(n.id) ?? 0 }));
}

/** A drop on the empty space under the last row. */
export function planDropAtEnd(index: TreeIndex, collapsed: ReadonlySet<string>, draggedId: string): DropPlan {
  const dragged = index.byId.get(draggedId);
  if (!dragged) return { kind: 'none' };
  const top = childrenOf(index, null);
  const lastTop = top[top.length - 1];
  if (!lastTop) return { kind: 'none' };
  const rowId = lastVisibleRow(index, collapsed, lastTop.id);
  if (dragged.kind === 'scene') {
    const chapter = index.chapters[index.chapters.length - 1];
    if (!chapter) return { kind: 'refused', reason: SCENE_NEEDS_CHAPTER, marker: { rowId, edge: 'bottom', depth: 0 } };
    return moveTo(index, dragged, chapter.id, 'end', { rowId, edge: 'bottom', depth: depthOf(index, chapter.id) + 1 });
  }
  return moveTo(index, dragged, null, 'end', { rowId, edge: 'bottom', depth: 0 });
}

export interface MoveStep {
  parentId: string | null;
  index: number;
}

/**
 * One step up or down from the keyboard, crossing into the neighboring chapter or part
 * when the node is at the edge of its own. Returns null when there is nowhere to go.
 */
export function moveStep(index: TreeIndex, id: string, direction: 1 | -1): MoveStep | null {
  const node = index.byId.get(id);
  if (!node) return null;
  const parent = parentKey(index, node);
  const siblings = childrenOf(index, parent);
  const at = siblings.findIndex((n) => n.id === id);
  const neighbor = siblings[at + direction];

  if (node.kind === 'scene') {
    if (neighbor) return { parentId: parent, index: at + direction };
    const chapterAt = index.chapters.findIndex((c) => c.id === parent);
    const nextChapter = index.chapters[chapterAt + direction];
    if (!nextChapter) return null;
    return {
      parentId: nextChapter.id,
      index: direction === 1 ? 0 : childrenOf(index, nextChapter.id).length,
    };
  }

  if (node.kind === 'chapter') {
    if (neighbor?.kind === 'part') {
      // Into the part, at the near end.
      return { parentId: neighbor.id, index: direction === 1 ? 0 : childrenOf(index, neighbor.id).length };
    }
    if (neighbor) return { parentId: parent, index: at + direction };
    if (parent === null) return null;
    // Out of the part, on the side it was moving towards.
    const top = childrenOf(index, null);
    const partAt = top.findIndex((n) => n.id === parent);
    return { parentId: null, index: direction === 1 ? partAt + 1 : partAt };
  }

  return neighbor ? { parentId: null, index: at + direction } : null;
}

/** Applies a move to the rows, so the screen can change before the native side answers. */
export function applyMove(nodes: NodeMeta[], id: string, parentId: string | null, at: number): NodeMeta[] {
  const moved = nodes.find((n) => n.id === id);
  if (!moved) return nodes;
  const sameParent = (a: string | null, b: string | null) => (a ?? null) === (b ?? null);
  const positions = new Map<string, number>();
  const write = (list: NodeMeta[]) => list.forEach((n, i) => positions.set(n.id, i));
  const byPosition = (a: NodeMeta, b: NodeMeta) => a.position - b.position;

  if (!sameParent(moved.parentId, parentId)) {
    write(nodes.filter((n) => n.id !== id && sameParent(n.parentId, moved.parentId)).sort(byPosition));
  }
  const order = nodes.filter((n) => n.id !== id && sameParent(n.parentId, parentId)).sort(byPosition);
  order.splice(Math.min(at, order.length), 0, moved);
  write(order);

  return nodes.map((n) => {
    const position = positions.get(n.id);
    if (position === undefined) return n;
    return n.id === id ? { ...n, parentId, position } : position === n.position ? n : { ...n, position };
  });
}

// ---------------------------------------------------------------------------
// Where new nodes go
// ---------------------------------------------------------------------------

export interface NewChapterPlan {
  parentId: string | null;
  afterId?: string;
}

/** A new chapter follows the chapter in use, or goes at the end of the selected part. */
export function planNewChapter(index: TreeIndex, currentId: string | null): NewChapterPlan {
  const current = currentId ? index.byId.get(currentId) : undefined;
  if (current?.kind === 'part') return { parentId: current.id };
  const chapter = currentId ? chapterOf(index, currentId) : undefined;
  if (chapter) return { parentId: parentKey(index, chapter), afterId: chapter.id };
  // With nothing selected, a book made of parts grows in its last part.
  const lastTop = childrenOf(index, null).at(-1);
  if (lastTop?.kind === 'part') return { parentId: lastTop.id };
  return { parentId: null, afterId: lastTop?.id };
}

export type NewScenePlan =
  | { chapterId: string; afterId?: string }
  /** The book has no chapter to hold a scene, so one must be made first. */
  | { chapter: NewChapterPlan };

/** A new scene follows the scene in use, or ends the selected or the last chapter. */
export function planNewScene(index: TreeIndex, currentId: string | null): NewScenePlan {
  const current = currentId ? index.byId.get(currentId) : undefined;
  if (current?.kind === 'scene' && current.parentId) {
    return { chapterId: current.parentId, afterId: current.id };
  }
  if (current?.kind === 'chapter') return { chapterId: current.id };
  if (current?.kind === 'part') {
    const last = childrenOf(index, current.id).filter((c) => c.kind === 'chapter').at(-1);
    return last ? { chapterId: last.id } : { chapter: { parentId: current.id } };
  }
  const last = index.chapters.at(-1);
  return last ? { chapterId: last.id } : { chapter: planNewChapter(index, currentId) };
}

export function nextTitle(index: TreeIndex, kind: NodeKind, parentId: string | null): string {
  switch (kind) {
    case 'part':
      return t('Part {number}', { number: index.parts.length + 1 });
    case 'chapter':
      return t('Chapter {number}', { number: index.chapters.length + 1 });
    case 'scene':
      return t('Scene {number}', { number: childrenOf(index, parentId).filter((c) => c.kind === 'scene').length + 1 });
  }
}

/** What is left to send after a write: anything it did not carry, or changed since it went. */
export function unsentFields<T extends object>(collected: T, sent: T): T {
  const left = { ...collected } as Record<string, unknown>;
  for (const [key, value] of Object.entries(sent)) {
    if (left[key] === value) delete left[key];
  }
  return left as T;
}

/** How a node reads where it has no title yet. */
export function displayTitle(node: { title: string; kind: NodeKind }): string {
  const title = node.title.trim();
  if (title) return title;
  if (node.kind === 'part') return t('Untitled part');
  if (node.kind === 'chapter') return t('Untitled chapter');
  return t('Untitled scene');
}
