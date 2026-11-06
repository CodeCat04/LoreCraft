/** Cuts a document in two at a position, keeping all its formatting. */

import { Fragment, type Node as ProseNode } from '@tiptap/pm/model';

import type { PmNode } from '../lib/types';

/** True if nothing in the block would show, so a cut at its edge leaves nothing behind. */
function isBlankBlock(node: ProseNode): boolean {
  if (node.textContent.trim() !== '') return false;
  let hasContent = false;
  node.descendants((child) => {
    if (child.isLeaf && !child.isText && child.type.name !== 'hardBreak') hasContent = true;
    return !hasContent;
  });
  return !hasContent && !(node.isLeaf && !node.isText);
}

/** Drops the blank blocks at one end, which a cut at the edge of a paragraph leaves there. */
function withoutBlankEdge(doc: ProseNode, end: 'start' | 'end'): ProseNode {
  const blocks: ProseNode[] = [];
  doc.forEach((block) => blocks.push(block));
  while (blocks.length > 0 && isBlankBlock(end === 'start' ? blocks[0] : blocks[blocks.length - 1])) {
    if (end === 'start') blocks.shift();
    else blocks.pop();
  }
  return doc.copy(Fragment.from(blocks));
}

export interface SplitParts {
  before: PmNode;
  after: PmNode;
}

/** Returns null when one side would have nothing in it, or the cut would break the document. */
export function splitDocAt(doc: ProseNode, pos: number): SplitParts | null {
  const before = withoutBlankEdge(doc.cut(0, pos), 'end');
  const after = withoutBlankEdge(doc.cut(pos), 'start');
  if (before.childCount === 0 || after.childCount === 0) return null;
  try {
    before.check();
    after.check();
  } catch {
    return null;
  }
  return { before: before.toJSON() as PmNode, after: after.toJSON() as PmNode };
}
