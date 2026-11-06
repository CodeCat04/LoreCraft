/**
 * JSONL: one record per page or scene, in plain text, for AI and retrieval pipelines. Being
 * for AI tools, it leaves out what is marked local only unless the writer asks, and then
 * each record says whether it is.
 */

import { describeFigures, pmToPlainText } from '../../editor/convert';
import { titleKey } from '../../lib/text';
import type { Page, PmNode } from '../../lib/types';
import { forAiTools, localOnlyNodes } from '../localOnly';
import type { ExportInput } from '../types';
import { utf8, walkDoc } from '../util';

function linkTargets(doc: PmNode): string[] {
  const seen = new Map<string, string>();
  walkDoc(doc, (node) => {
    for (const mark of node.marks ?? []) {
      if (mark.type !== 'wikiLink') continue;
      const target = String(mark.attrs?.target ?? '');
      if (target && !seen.has(titleKey(target))) seen.set(titleKey(target), target);
    }
  });
  return [...seen.values()];
}

function figures(doc: PmNode) {
  return describeFigures(doc).map((f) => ({ name: f.name, kind: f.kind, caption: f.caption, description: f.description, media: f.media }));
}

function pageRecord(page: Page) {
  return {
    kind: 'page',
    id: page.id,
    title: page.title,
    type: page.pageType,
    status: page.status,
    summary: page.summary,
    aliases: page.aliases,
    categories: page.categories,
    infobox: Object.fromEntries((page.infobox?.fields ?? []).map((f) => [f.key, f.value])),
    links: linkTargets(page.content),
    figures: figures(page.content),
    wordCount: page.wordCount,
    localOnly: page.localOnly === true,
    updatedAt: page.updatedAt,
    text: pmToPlainText(page.content),
  };
}

export function exportJsonl(input: ExportInput): Uint8Array {
  const { snapshot } = input;
  const titleOf = new Map(snapshot.pages.map((p) => [p.id, p.title]));
  const bookOf = new Map(snapshot.books.map((b) => [b.id, b]));
  const nodeOf = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const shown = forAiTools(input);
  const marked = localOnlyNodes(snapshot.nodes);
  const lines = shown.pages.map((page) => JSON.stringify(pageRecord(page)));

  const scenes = shown.nodes.filter((n) => n.kind === 'scene');
  scenes.forEach((node, index) => {
    const chapter = node.parentId ? nodeOf.get(node.parentId) : undefined;
    const part = chapter?.parentId ? nodeOf.get(chapter.parentId) : undefined;
    lines.push(
      JSON.stringify({
        kind: 'scene',
        id: node.id,
        book: bookOf.get(node.bookId)?.title ?? '',
        bookId: node.bookId,
        part: part?.title ?? null,
        chapter: chapter?.title ?? null,
        title: node.title,
        order: index + 1,
        status: node.status,
        pov: node.povPageId ? (titleOf.get(node.povPageId) ?? null) : null,
        storyDate: node.storyDate,
        synopsis: node.synopsis,
        links: linkTargets(node.content),
        figures: figures(node.content),
        wordCount: node.wordCount,
        localOnly: marked.has(node.id),
        updatedAt: node.updatedAt,
        text: pmToPlainText(node.content),
      }),
    );
  });
  return utf8(lines.length > 0 ? `${lines.join('\n')}\n` : '');
}
