/** Turns the project's links and relationships into what the graph and its list show. */

import { titleKey } from '../../lib/text';
import type { GraphData, GraphPage, Relationship } from '../api';

export interface GraphFilter {
  hiddenTypes: ReadonlySet<string>;
  /** Empty means every category. */
  category: string;
  /** The page the view is centered on. It stays visible whatever the filters say. */
  center: string | null;
  /** How far from the center to show. 0 shows everything. */
  hops: 0 | 1 | 2;
}

export interface GraphNodeView extends GraphPage {
  /** Pages this one is connected to in the whole project, however the view is filtered. */
  linkCount: number;
}

/** Everything between two pages, drawn as one line. */
export interface GraphEdgeView {
  key: string;
  source: string;
  target: string;
  /** A wiki link runs between them, in either direction. */
  linked: boolean;
  relationships: Relationship[];
}

export interface GraphViewData {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Merges links in both directions and relationships into one edge per pair of pages. */
function mergeEdges(data: GraphData): Map<string, GraphEdgeView> {
  const known = new Set(data.nodes.map((node) => node.id));
  const edges = new Map<string, GraphEdgeView>();
  const edgeFor = (from: string, to: string) => {
    const key = pairKey(from, to);
    let edge = edges.get(key);
    if (!edge) {
      edge = { key, source: from, target: to, linked: false, relationships: [] };
      edges.set(key, edge);
    }
    return edge;
  };
  for (const link of data.links) {
    if (link.from === link.to || !known.has(link.from) || !known.has(link.to)) continue;
    edgeFor(link.from, link.to).linked = true;
  }
  for (const rel of data.relationships) {
    if (rel.fromPageId === rel.toPageId || !known.has(rel.fromPageId) || !known.has(rel.toPageId)) continue;
    edgeFor(rel.fromPageId, rel.toPageId).relationships.push(rel);
  }
  return edges;
}

export function neighborMap(edges: GraphEdgeView[]): Map<string, Set<string>> {
  const neighbors = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = neighbors.get(a);
    if (!set) {
      set = new Set();
      neighbors.set(a, set);
    }
    set.add(b);
  };
  for (const edge of edges) {
    add(edge.source, edge.target);
    add(edge.target, edge.source);
  }
  return neighbors;
}

export function buildGraph(data: GraphData, filter: GraphFilter): GraphViewData {
  const allEdges = [...mergeEdges(data).values()];
  const allNeighbors = neighborMap(allEdges);

  const visible = new Set<string>();
  for (const node of data.nodes) {
    const passes =
      !filter.hiddenTypes.has(node.pageType) &&
      (!filter.category || node.categories.includes(filter.category));
    if (passes || node.id === filter.center) visible.add(node.id);
  }
  let edges = allEdges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));

  if (filter.center && filter.hops > 0 && visible.has(filter.center)) {
    const neighbors = neighborMap(edges);
    const reached = new Set([filter.center]);
    let frontier = [filter.center];
    for (let hop = 0; hop < filter.hops; hop += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const other of neighbors.get(id) ?? []) {
          if (!reached.has(other)) {
            reached.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    visible.clear();
    reached.forEach((id) => visible.add(id));
    edges = edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));
  }

  return {
    nodes: data.nodes
      .filter((node) => visible.has(node.id))
      .map((node) => ({ ...node, linkCount: allNeighbors.get(node.id)?.size ?? 0 })),
    edges,
  };
}

/** Page types in use, most common first, with how many pages each has. */
export function graphTypes(data: GraphData): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const node of data.nodes) counts.set(node.pageType, (counts.get(node.pageType) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export function graphCategories(data: GraphData): string[] {
  const categories = new Set<string>();
  for (const node of data.nodes) node.categories.forEach((category) => categories.add(category));
  return [...categories].sort((a, b) => a.localeCompare(b));
}

/** Ids of pages whose title or alias holds the text. `aliasesOf` is optional. */
export function matchNodes(
  nodes: GraphNodeView[],
  query: string,
  aliasesOf?: (id: string) => string[],
): string[] {
  const key = titleKey(query);
  if (!key) return [];
  return nodes
    .filter((node) =>
      [node.title, ...(aliasesOf?.(node.id) ?? [])].some((name) => titleKey(name).includes(key)),
    )
    .map((node) => node.id);
}
