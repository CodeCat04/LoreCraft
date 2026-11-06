import type { Node as ProseNode } from '@tiptap/pm/model';

/** Stands in for anything inside a block that is not text to check. Never part of a word. */
const MASK = '￼';

/** Marks whose text is not prose: code, and links that already name a page on purpose. */
const SKIPPED_MARKS = new Set(['code', 'wikiLink']);

/**
 * A text block as a string where each character sits at its document position, relative
 * to the start of the block's content. This string is also the cache key for the block's
 * result, so identical paragraphs share one check.
 */
export function blockText(block: ProseNode): string {
  let text = '';
  block.forEach((child) => {
    if (child.isText && !child.marks.some((mark) => SKIPPED_MARKS.has(mark.type.name))) {
      text += child.text ?? '';
    } else {
      text += MASK.repeat(child.nodeSize);
    }
  });
  return text;
}
