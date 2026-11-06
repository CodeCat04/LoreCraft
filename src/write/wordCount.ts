/**
 * Live word counts. A document shares every block that did not change between edits, so
 * remembering each block's count by identity turns a recount of a 20,000-word scene into
 * one small count and a sum.
 */

import type { Node as ProseNode } from '@tiptap/pm/model';

import { wordCount } from '../lib/text';

const blockWords = new WeakMap<ProseNode, number>();

/** The block's text as `extract` in `content.rs` reads it. */
function inlineText(block: ProseNode): string {
  let text = '';
  block.forEach((child) => {
    if (child.isText) text += child.text ?? '';
    else if (child.type.name === 'hardBreak') text += '\n';
  });
  return text;
}

function countBlock(node: ProseNode): number {
  const known = blockWords.get(node);
  if (known !== undefined) return known;
  let count = 0;
  if (node.type.name === 'figure') {
    // A figure's caption is not the writer's prose, and `extract` leaves it out too.
    count = 0;
  } else if (node.isTextblock) {
    count = wordCount(inlineText(node));
  } else {
    node.forEach((child) => {
      if (!child.isLeaf) count += countBlock(child);
    });
  }
  blockWords.set(node, count);
  return count;
}

/** Words in a document. Must match `word_count` in `content.rs`. */
export function docWordCount(doc: ProseNode): number {
  return countBlock(doc);
}

/** Words in part of a document. */
export function rangeWordCount(doc: ProseNode, from: number, to: number): number {
  const text = doc.textBetween(from, to, '\n', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ''));
  return wordCount(text);
}
