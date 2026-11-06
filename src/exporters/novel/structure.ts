/** A book as a reader meets it: parts, chapters and scenes in order. */

import { figureInfo, figureNumberer, figureToLine, type FigureInfo } from '../../editor/convert';
import type { Node, PmNode } from '../../lib/types';
import { childrenByParent } from '../scope';
import type { ExportSnapshot, SnapshotBook } from '../types';
import { withoutWikiLinks, xmlSafe, xmlSafeDoc } from '../util';

export interface ChapterOutline {
  node: Node;
  title: string;
  /** Scene documents, cleaned for printing: no wiki links, XML-safe text. */
  scenes: { node: Node; doc: PmNode }[];
}

export interface PartOutline {
  node: Node;
  title: string;
  chapters: ChapterOutline[];
}

export interface BookOutline {
  book: SnapshotBook;
  /** In reading order. A book may mix parts with chapters outside any part. */
  items: (({ type: 'part' } & PartOutline) | ({ type: 'chapter' } & ChapterOutline))[];
  wordCount: number;
  hasParts: boolean;
}

function chapterOutline(node: Node, children: Map<string | null, Node[]>, number: number): ChapterOutline {
  const scenes = (children.get(node.id) ?? []).filter((n) => n.kind === 'scene');
  return {
    node,
    // A title of control characters alone is empty once a format removes them.
    title: xmlSafe(node.title).trim() || `Chapter ${number}`,
    scenes: scenes.map((scene) => ({ node: scene, doc: withoutWikiLinks(xmlSafeDoc(scene.content)) })),
  };
}

export function outlineBooks(snapshot: ExportSnapshot): BookOutline[] {
  return snapshot.books.map((book) => {
    const nodes = snapshot.nodes.filter((n) => n.bookId === book.id);
    const children = childrenByParent(nodes);
    let chapterNumber = 0;
    let partNumber = 0;
    const items: BookOutline['items'] = [];
    for (const node of children.get(null) ?? []) {
      if (node.kind === 'part') {
        partNumber += 1;
        const chapters = (children.get(node.id) ?? [])
          .filter((n) => n.kind === 'chapter')
          .map((chapter) => {
            chapterNumber += 1;
            return chapterOutline(chapter, children, chapterNumber);
          });
        items.push({ type: 'part', node, title: xmlSafe(node.title).trim() || `Part ${partNumber}`, chapters });
      } else if (node.kind === 'chapter') {
        chapterNumber += 1;
        items.push({ type: 'chapter', ...chapterOutline(node, children, chapterNumber) });
      }
    }
    return {
      book,
      items,
      wordCount: nodes.reduce((sum, n) => sum + (n.kind === 'scene' ? n.wordCount : 0), 0),
      hasParts: items.some((i) => i.type === 'part'),
    };
  });
}

/** Word counts in a manuscript are round, as editors expect: "about 81,000 words". */
export function roundedWords(words: number): string {
  const step = words >= 10_000 ? 1000 : 100;
  return (Math.round(words / step) * step).toLocaleString('en-US');
}

/**
 * For Markdown and plain text, which cannot show a picture in one file. A picture or
 * video becomes the line that names it, numbered through the whole book, and a table
 * stays because its cells are real text.
 */
export function figuresAsLines(doc: PmNode, next: (kind: string) => number): PmNode {
  const blocks = (nodes: PmNode[]): PmNode[] =>
    nodes.flatMap((node) => {
      if (node.type !== 'figure') return node.content ? [{ ...node, content: blocks(node.content) }] : [node];
      const info: FigureInfo = figureInfo(node, next(String(node.attrs?.kind ?? 'figure')));
      const table = node.content?.find((c) => c.type === 'table');
      const line: PmNode = { type: 'paragraph', content: [{ type: 'text', text: figureToLine(info) }] };
      return table ? [line, table] : [line];
    });
  return { ...doc, content: blocks(doc.content ?? []) };
}

export { figureNumberer };
