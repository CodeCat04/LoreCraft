/** Narrows a project to what the person asked to export. */

import { titleKey } from '../lib/text';
import type { BookPublishing, Node, Page } from '../lib/types';
import { resolveMatter } from './novel/matter';
import type { ExportOptions, ExportSnapshot, SceneFilter } from './types';
import { assetsInDoc } from './util';

function pageWanted(page: Page, options: ExportOptions): boolean {
  if (options.scope === 'page') return page.id === options.pageId;
  if (options.canonOnly) return page.status === 'canon';
  if (page.status === 'retconned') return options.includeRetconned;
  if (page.status === 'draft' || page.status === 'idea') return options.includeDrafts;
  return true;
}

function sceneWanted(status: string, filter: SceneFilter): boolean {
  if (filter === 'written') return status === 'draft' || status === 'revised' || status === 'final';
  if (filter === 'revised') return status === 'revised' || status === 'final';
  return true;
}

/** Pictures a book's publishing details show, wherever those details are written out. */
function assetsInPublishing(details: BookPublishing | undefined, used: Set<string>) {
  if (!details) return;
  if (details.coverAssetId) used.add(details.coverAssetId);
  for (const page of [details.copyright, details.dedication, details.epigraph, details.acknowledgments, details.aboutAuthor]) {
    if (page?.content) assetsInDoc(page.content, used);
  }
}

/**
 * A filter can empty a chapter of its scenes, and then the heading would only mislead.
 * A chapter the writer has not started keeps its place.
 */
function keepNodes(nodes: Node[], filter: SceneFilter): Node[] {
  if (filter === 'all') return nodes;
  const childrenOf = new Map<string | null, Node[]>();
  for (const node of nodes) {
    const list = childrenOf.get(node.parentId) ?? [];
    list.push(node);
    childrenOf.set(node.parentId, list);
  }
  const kept = new Set<string>();
  const visit = (node: Node): boolean => {
    if (node.kind === 'scene') {
      const wanted = sceneWanted(node.status, filter);
      if (wanted) kept.add(node.id);
      return wanted;
    }
    const children = childrenOf.get(node.id) ?? [];
    const results = children.map(visit);
    const keep = children.length === 0 || results.some(Boolean);
    if (keep) kept.add(node.id);
    return keep;
  };
  (childrenOf.get(null) ?? []).forEach(visit);
  return nodes.filter((n) => kept.has(n.id));
}

export interface Scoped {
  snapshot: ExportSnapshot;
  excludedPages: Set<string>;
}

export function applyScope(all: ExportSnapshot, options: ExportOptions): Scoped {
  const wiki = options.scope === 'project' || options.scope === 'wiki' || options.scope === 'page';
  const novel = options.scope === 'project' || options.scope === 'book' || options.scope === 'books';

  const pages = wiki ? all.pages.filter((p) => pageWanted(p, options)) : [];
  const kept = new Set(pages.map((p) => p.id));
  const excludedPages = new Set<string>();
  for (const page of all.pages) {
    if (kept.has(page.id)) continue;
    excludedPages.add(titleKey(page.title));
    page.aliases.forEach((alias) => excludedPages.add(titleKey(alias)));
  }

  const books = !novel
    ? []
    : options.scope === 'book'
      ? all.books.filter((b) => b.id === options.bookId)
      : all.books;
  // A manuscript goes to an agent or editor as bare text, so it has none of this.
  const withMatter = options.bookMatter && !options.manuscriptFormat && (options.scope === 'book' || options.scope === 'books');
  const finalBooks = withMatter ? books.map((book) => ({ ...book, matter: resolveMatter(book, all) })) : books;
  const bookIds = new Set(books.map((b) => b.id));
  const nodes = keepNodes(all.nodes.filter((n) => bookIds.has(n.bookId)), options.scenes);
  const nodeIds = new Set(nodes.map((n) => n.id));

  const maps = wiki && options.scope !== 'page' ? all.maps : [];
  const usedAssets = new Set<string>();
  for (const page of pages) {
    assetsInDoc(page.content, usedAssets);
    assetsInDoc(page.notes, usedAssets);
    if (page.infobox?.imageAssetId) usedAssets.add(page.infobox.imageAssetId);
  }
  for (const node of nodes) assetsInDoc(node.content, usedAssets);
  for (const map of maps) if (map.assetId) usedAssets.add(map.assetId);
  for (const book of finalBooks) {
    assetsInPublishing(book.publishing, usedAssets);
    for (const section of [...(book.matter?.front ?? []), ...(book.matter?.back ?? [])]) assetsInDoc(section.doc, usedAssets);
  }
  const everything = options.scope === 'project' && pages.length === all.pages.length && nodes.length === all.nodes.length;
  const nodeThreads = all.nodeThreads.filter((link) => nodeIds.has(link.nodeId));
  const threadsUsed = new Set(nodeThreads.map((link) => link.threadId));

  return {
    excludedPages,
    snapshot: {
      ...all,
      pages,
      books: finalBooks,
      nodes,
      maps,
      relationships: all.relationships.filter((r) => kept.has(r.fromPageId) && kept.has(r.toPageId)),
      mentions: all.mentions.filter((m) =>
        kept.has(m.pageId) && (m.sourceKind === 'page' ? kept.has(m.sourceId) : nodeIds.has(m.sourceId)),
      ),
      assets: everything ? all.assets : all.assets.filter((a) => usedAssets.has(a.id)),
      writingLog: all.writingLog.filter((d) => bookIds.has(d.bookId)),
      dictionary: everything ? all.dictionary : [],
      prompts: everything ? all.prompts : [],
      nodeThreads,
      // With the whole project, a thread with no scenes yet is still the writer's plan.
      threads: options.scope === 'project' ? all.threads : all.threads.filter((t) => threadsUsed.has(t.id)),
    },
  };
}

/** A child list for each parent, in reading order. */
export function childrenByParent(nodes: Node[]): Map<string | null, Node[]> {
  const out = new Map<string | null, Node[]>();
  for (const node of nodes) {
    const list = out.get(node.parentId) ?? [];
    list.push(node);
    out.set(node.parentId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.position - b.position);
  return out;
}
