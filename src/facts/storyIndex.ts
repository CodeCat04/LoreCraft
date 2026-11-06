/**
 * Where everything is in the story: each node's place in reading order across all books, and
 * how to name it. This is what turns a scene into a `StoryMoment`, and a change into words
 * like "from Chapter 10".
 */

import * as api from '../lib/api';
import { dateResolver, type MomentResolver, type StoryMoment } from '../lib/facts';
import { getDateContext, parseStoryDate, type DateContext } from '../lib/storyDate';
import type { Book, NodeMeta } from '../lib/types';

export interface StoryIndex {
  nodes: Map<string, NodeMeta>;
  /** Where each node falls across the whole series. */
  order: Map<string, number>;
  /** The last position inside each node, so a chapter's end includes its scenes. */
  lastWithin: Map<string, number>;
  /** Chapters and scenes in reading order. */
  chapters: NodeMeta[];
  scenes: NodeMeta[];
  bookTitles: Map<string, string>;
  dates: DateContext;
  resolve: MomentResolver;
}

export function buildStoryIndex(
  books: Pick<Book, 'id' | 'title' | 'position'>[],
  treeOf: (bookId: string) => NodeMeta[],
  dates: DateContext,
): StoryIndex {
  const nodes = new Map<string, NodeMeta>();
  const order = new Map<string, number>();
  const lastWithin = new Map<string, number>();
  const chapters: NodeMeta[] = [];
  const scenes: NodeMeta[] = [];
  const bookTitles = new Map<string, string>();
  let next = 0;

  for (const book of [...books].sort((a, b) => a.position - b.position)) {
    bookTitles.set(book.id, book.title);
    const children = new Map<string | null, NodeMeta[]>();
    for (const node of treeOf(book.id)) {
      nodes.set(node.id, node);
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.position - b.position);
    const walk = (parent: string | null) => {
      for (const node of children.get(parent) ?? []) {
        order.set(node.id, next);
        next += 1;
        if (node.kind === 'chapter') chapters.push(node);
        if (node.kind === 'scene') scenes.push(node);
        walk(node.id);
        lastWithin.set(node.id, next - 1);
      }
    };
    walk(null);
  }

  const sortOfDate = dateResolver(dates);
  const resolve: MomentResolver = {
    nodeOrder: (id) => order.get(id) ?? null,
    dateSort: sortOfDate,
    nodeDateSort: (id) => {
      const date = nodes.get(id)?.storyDate;
      return date ? sortOfDate(date) : null;
    },
  };
  return { nodes, order, lastWithin, chapters, scenes, bookTitles, dates, resolve };
}

export async function loadStoryIndex(): Promise<StoryIndex> {
  const [books, dates] = await Promise.all([api.books.list(), getDateContext()]);
  const trees = await Promise.all(books.map(async (book) => [book.id, await api.nodes.tree(book.id)] as const));
  const byBook = new Map(trees);
  return buildStoryIndex(books, (id) => byBook.get(id) ?? [], dates);
}

function sortOfDate(index: StoryIndex, date: string): number | null {
  return date ? parseStoryDate(date, index.dates.eras, index.dates.calendar) : null;
}

/** The latest date any scene up to this point has reached. */
function latestDateBy(index: StoryIndex, at: number): number | null {
  let latest: number | null = null;
  for (const scene of index.scenes) {
    if ((index.order.get(scene.id) ?? Infinity) > at) break;
    const sort = sortOfDate(index, scene.storyDate);
    if (sort !== null && (latest === null || sort > latest)) latest = sort;
  }
  return latest;
}

function momentWithoutOwnDate(index: StoryIndex, nodeOrder: number | null, from: number | null): StoryMoment {
  const latest = from === null ? null : latestDateBy(index, from);
  return latest === null ? { nodeOrder, dateSort: null } : { nodeOrder, dateSort: latest, dateInferred: true };
}

/**
 * A scene as a moment: its place in reading order and its in-world date. A scene with no date
 * has at least reached the latest date before it, which is enough to see earlier changes.
 */
export function sceneMoment(index: StoryIndex, sceneId: string, storyDate?: string): StoryMoment {
  const own = sortOfDate(index, storyDate ?? index.nodes.get(sceneId)?.storyDate ?? '');
  const nodeOrder = index.order.get(sceneId) ?? null;
  return own !== null ? { nodeOrder, dateSort: own } : momentWithoutOwnDate(index, nodeOrder, nodeOrder);
}

/**
 * The end of a chapter, or any other part of the tree, as a moment. Its date is the latest
 * any scene inside it reaches, so a closing flashback does not undo the chapter.
 */
export function chapterEndMoment(index: StoryIndex, nodeId: string): StoryMoment {
  const from = index.order.get(nodeId);
  const to = index.lastWithin.get(nodeId);
  if (from === undefined || to === undefined) return { nodeOrder: null, dateSort: null };
  let dateSort: number | null = null;
  for (const scene of index.scenes) {
    const at = index.order.get(scene.id) ?? -1;
    if (at < from || at > to) continue;
    const sort = sortOfDate(index, scene.storyDate);
    if (sort !== null && (dateSort === null || sort > dateSort)) dateSort = sort;
  }
  return dateSort !== null ? { nodeOrder: to, dateSort } : momentWithoutOwnDate(index, to, to);
}

/** A node's moment: a scene's own, or the end of anything larger. */
export function momentOf(index: StoryIndex, nodeId: string): StoryMoment {
  return index.nodes.get(nodeId)?.kind === 'scene' ? sceneMoment(index, nodeId) : chapterEndMoment(index, nodeId);
}

/** How many scenes have been read by the end of a node, and how many there are. */
export function sceneCount(index: StoryIndex, nodeId: string): { scene: number; of: number } | null {
  const through = index.lastWithin.get(nodeId);
  if (through === undefined) return null;
  const scene = index.scenes.filter((s) => (index.order.get(s.id) ?? Infinity) <= through).length;
  return scene > 0 ? { scene, of: index.scenes.length } : null;
}

function firstSceneOf(index: StoryIndex, parentId: string): string | undefined {
  return index.scenes.find((scene) => scene.parentId === parentId)?.id;
}

/**
 * How a node reads in a sentence. The first scene of a chapter is named by its chapter, which
 * gives "from Chapter 10", and later ones are named in full. The book is named only when
 * there is more than one.
 */
export function nodeLabel(index: StoryIndex, nodeId: string): string | null {
  const node = index.nodes.get(nodeId);
  if (!node) return null;
  const parts: string[] = [];
  if (index.bookTitles.size > 1) parts.push(index.bookTitles.get(node.bookId) ?? '');
  const parent = node.parentId ? index.nodes.get(node.parentId) : undefined;
  if (node.kind === 'scene' && parent) {
    parts.push(parent.title || 'Untitled chapter');
    if (firstSceneOf(index, parent.id) !== node.id) parts.push(node.title || 'Untitled scene');
  } else {
    parts.push(node.title || (node.kind === 'scene' ? 'Untitled scene' : `Untitled ${node.kind}`));
  }
  return parts.filter(Boolean).join(', ');
}
