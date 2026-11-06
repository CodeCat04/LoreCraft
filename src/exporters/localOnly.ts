/**
 * Pages and scenes marked local only never go to a cloud AI. Formats made for other AI tools
 * follow the MCP server's default and leave them out unless the writer asks. Every other
 * format keeps them: the data formats carry the mark, and books and sites are for people.
 */

import { t } from '../lib/i18n';
import type { Node, Page } from '../lib/types';
import type { ExportInput } from './types';

/** A scene inside a marked chapter or part counts as marked, since the safe mistake is to send too little. */
export function localOnlyNodes(nodes: Node[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const marked = new Set<string>();
  for (const node of nodes) {
    for (let at: Node | undefined = node; at; at = at.parentId ? byId.get(at.parentId) : undefined) {
      if (at.localOnly) {
        marked.add(node.id);
        break;
      }
    }
  }
  return marked;
}

/** What a format for other AI tools may hold, and a warning if anything was left out. */
export function forAiTools(input: ExportInput): { pages: Page[]; nodes: Node[] } {
  const { snapshot, options } = input;
  if (options.includeLocalOnly) return { pages: snapshot.pages, nodes: snapshot.nodes };
  const markedNodes = localOnlyNodes(snapshot.nodes);
  const pages = snapshot.pages.filter((p) => !p.localOnly);
  const nodes = snapshot.nodes.filter((n) => !markedNodes.has(n.id));
  if (pages.length < snapshot.pages.length || nodes.length < snapshot.nodes.length) {
    input.warn?.(t('Pages and scenes marked local only were left out. To add them, tick "Include pages and scenes marked local only".'));
  }
  return { pages, nodes };
}
