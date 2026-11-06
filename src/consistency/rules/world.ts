/**
 * The project as the rule checks read it: the snapshot with its lookups built. Everything
 * here is pure, so the rules can be tested with a plain object.
 */

import { fieldValueAt, type MomentResolver, type StoryMoment } from '../../lib/facts';
import { t } from '../../lib/i18n';
import { parseStoryDate, type Era } from '../../lib/storyDate';
import { titleKey } from '../../lib/text';
import type { Infobox, InfoboxField, NodeMeta, PageStatus, PmNode } from '../../lib/types';
import type { Evidence } from '../types';

/** Being added to the snapshot by other modules, so each may be absent. */
export interface WorldNode extends Omit<NodeMeta, 'locationPageId' | 'localOnly'> {
  content: PmNode;
  notes?: string;
  locationPageId?: string | null;
  castPageIds?: string[];
  localOnly?: boolean;
}

export interface WorldPage {
  id: string;
  title: string;
  pageType: string;
  status: PageStatus;
  summary: string;
  isHome?: boolean;
  aliases: string[];
  categories?: string[];
  content: PmNode;
  infobox: Infobox;
  localOnly?: boolean;
}

export interface WorldInput {
  pages: WorldPage[];
  books: { id: string; title: string; position: number }[];
  nodes: WorldNode[];
}

export interface World {
  pages: WorldPage[];
  pageById: Map<string, WorldPage>;
  /** Title or alias key to page. Titles win over aliases, as links do. */
  pageByName: Map<string, WorldPage>;
  books: { id: string; title: string; position: number }[];
  nodes: WorldNode[];
  nodeById: Map<string, WorldNode>;
  /** Scenes in reading order, across books. */
  scenes: WorldNode[];
  /** Where each node falls across the series. */
  orderOf: Map<string, number>;
  eras: Era[];
  resolver: MomentResolver;
  /** Each scene's date as a sort key, worked out once. */
  sceneSorts: Map<string, number | null>;
}

/** Books in order, each book's tree in reading order. */
function readingOrder(input: WorldInput): Map<string, number> {
  const order = new Map<string, number>();
  let next = 0;
  const books = [...input.books].sort((a, b) => a.position - b.position);
  const known = new Set(books.map((book) => book.id));
  const bookIds = [...books.map((book) => book.id), ...new Set(input.nodes.map((n) => n.bookId).filter((id) => !known.has(id)))];
  for (const bookId of bookIds) {
    const children = new Map<string | null, WorldNode[]>();
    for (const node of input.nodes) {
      if (node.bookId !== bookId) continue;
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.position - b.position);
    const walk = (parent: string | null) => {
      for (const node of children.get(parent) ?? []) {
        order.set(node.id, next);
        next += 1;
        walk(node.id);
      }
    };
    walk(null);
  }
  return order;
}

export function buildWorld(input: WorldInput, eras: Era[] = []): World {
  const pageById = new Map(input.pages.map((page) => [page.id, page]));
  const pageByName = new Map<string, WorldPage>();
  for (const page of input.pages) {
    for (const alias of page.aliases ?? []) pageByName.set(titleKey(alias), page);
  }
  for (const page of input.pages) pageByName.set(titleKey(page.title), page);

  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const orderOf = readingOrder(input);
  const scenes = input.nodes
    .filter((node) => node.kind === 'scene')
    .sort((a, b) => (orderOf.get(a.id) ?? 0) - (orderOf.get(b.id) ?? 0));

  return {
    pages: input.pages,
    pageById,
    pageByName,
    books: input.books,
    nodes: input.nodes,
    nodeById,
    scenes,
    orderOf,
    eras,
    resolver: {
      nodeOrder: (id) => orderOf.get(id) ?? null,
      dateSort: (date) => parseStoryDate(date, eras),
    },
    sceneSorts: new Map(),
  };
}

/** The date a scene takes place: its own, or else the chapter's or part's it sits in. */
export function sceneDate(world: World, node: WorldNode): string {
  let at: WorldNode | undefined = node;
  for (let depth = 0; at && depth < 8; depth += 1) {
    if (at.storyDate?.trim()) return at.storyDate.trim();
    at = at.parentId ? world.nodeById.get(at.parentId) : undefined;
  }
  return '';
}

/** A scene's sort key, or null if it has no date that can be put in order. */
export function sceneSort(world: World, node: WorldNode): number | null {
  const known = world.sceneSorts.get(node.id);
  if (known !== undefined) return known;
  const date = sceneDate(world, node);
  const sort = date ? parseStoryDate(date, world.eras) : null;
  world.sceneSorts.set(node.id, sort);
  return sort;
}

export function momentOf(world: World, node: WorldNode): StoryMoment {
  return { nodeOrder: world.orderOf.get(node.id) ?? null, dateSort: sceneSort(world, node) };
}

export function fieldOf(page: WorldPage, key: string): InfoboxField | undefined {
  return page.infobox?.fields?.find((field) => field.key === key);
}

/** A field's value when this scene happens. */
export function fieldAtScene(world: World, field: InfoboxField, node: WorldNode): string {
  return fieldValueAt(field, momentOf(world, node), world.resolver);
}

/** Canon and draft pages state things. An idea is not fact, and a retcon no longer is. */
export function statesFacts(page: WorldPage): boolean {
  return page.status === 'canon' || page.status === 'draft';
}

export function sceneTitle(node: WorldNode): string {
  return node.title?.trim() || t('Untitled scene');
}

export function pageEvidence(page: WorldPage, quote: string): Evidence {
  return { sourceKind: 'page', sourceId: page.id, title: page.title, quote, status: page.status };
}

export function sceneEvidence(node: WorldNode, quote: string): Evidence {
  return { sourceKind: 'node', sourceId: node.id, title: sceneTitle(node), quote };
}

/** True if a chapter or part a scene sits in, or the scene itself, is local only. */
export function isNodeLocalOnly(world: World, node: WorldNode): boolean {
  let at: WorldNode | undefined = node;
  for (let depth = 0; at && depth < 8; depth += 1) {
    if (at.localOnly) return true;
    at = at.parentId ? world.nodeById.get(at.parentId) : undefined;
  }
  return false;
}
