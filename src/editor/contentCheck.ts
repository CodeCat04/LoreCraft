/**
 * Documents from a newer LoreCraft can hold nodes or marks this version does not know.
 * TipTap would replace such a document with an empty one, and the first edit would then
 * store that over the real text. These helpers find that case and make a copy that can be
 * shown, read-only, without changing what is stored.
 */

import type { Schema } from '@tiptap/pm/model';

import type { PmNode } from '../lib/types';

/** Why this version cannot load the document, or null if it can. */
export function contentProblem(schema: Schema, content: PmNode): string | null {
  try {
    schema.nodeFromJSON(content).check();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Unknown nodes give way to what they hold, and unknown marks are left off. */
function known(schema: Schema, node: PmNode): PmNode[] {
  if (!schema.nodes[node.type]) return (node.content ?? []).flatMap((child) => known(schema, child));
  const shown: PmNode = { ...node };
  if (node.marks) shown.marks = node.marks.filter((mark) => schema.marks[mark.type]);
  if (node.content) shown.content = node.content.flatMap((child) => known(schema, child));
  return [shown];
}

function textOf(node: PmNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(textOf).join(node.content?.some((c) => c.content) ? '\n' : '');
}

/**
 * A copy of the document this version can show, for reading only. It keeps as much as it
 * can: the known parts as they are, or failing that the text of each block.
 */
export function readableCopy(schema: Schema, content: PmNode): PmNode {
  const pruned: PmNode = { type: 'doc', content: known(schema, content).flatMap((node) => (node.type === 'doc' ? node.content ?? [] : [node])) };
  if (!contentProblem(schema, pruned)) return pruned;
  const blocks = (content.content ?? []).map(textOf);
  const paragraphs: PmNode = {
    type: 'doc',
    content: (blocks.length > 0 ? blocks : ['']).flatMap((block) =>
      block.split('\n').map((line) => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}) })),
    ),
  };
  return contentProblem(schema, paragraphs) ? { type: 'doc', content: [{ type: 'paragraph' }] } : paragraphs;
}
