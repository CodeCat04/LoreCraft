/**
 * Replacing matches, as ordinary edits. A replacement takes the formatting of the first
 * character it replaces, as typing over a selection would, except that a link stays a link
 * when the whole of it is replaced.
 */

import { Fragment, Slice, type Node as ProseNode } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';

import type { FindMatch } from './search';

/**
 * How many replacements get a step each, which keeps every position that follows the text
 * exact, such as a suggestion waiting elsewhere in the page. Steps cost more the longer the
 * document is, and plugins compare each with all the others, so thousands of them would
 * freeze the window. Beyond this they are written as one.
 */
const MAX_SEPARATE_STEPS = 500;

export function replaceMatch(tr: Transaction, match: FindMatch, text: string) {
  if (!text) {
    tr.delete(match.from, match.to);
    return;
  }
  const first = tr.doc.resolve(match.from).nodeAfter;
  tr.replaceWith(match.from, match.to, tr.doc.type.schema.text(text, first?.marks));
}

/** Where a position ends up once all the matches are replaced. Inside one, it goes to the end. */
export function positionAfterReplacing(pos: number, matches: FindMatch[], length: number): number {
  let shift = 0;
  for (const match of matches) {
    if (match.from >= pos) break;
    if (match.to > pos) return match.from + shift + length;
    shift += length - (match.to - match.from);
  }
  return pos + shift;
}

/** A way through the matches, which are in document order, as the document is rebuilt. */
class Rewriter {
  private next = 0;

  constructor(
    private readonly matches: FindMatch[],
    private readonly text: string,
  ) {}

  /** This node at this position, with the matches in it replaced. Untouched nodes are reused. */
  node(node: ProseNode, pos: number): ProseNode {
    const end = pos + node.nodeSize;
    if (this.next >= this.matches.length || this.matches[this.next].from >= end) return node;
    if (node.isTextblock) return this.textblock(node, pos + 1);
    const children: ProseNode[] = [];
    node.forEach((child, offset) => {
      children.push(this.node(child, pos + 1 + offset));
    });
    return node.copy(Fragment.fromArray(children));
  }

  private textblock(block: ProseNode, start: number): ProseNode {
    const end = start + block.content.size;
    const pieces: ProseNode[] = [];
    const add = (fragment: Fragment) => fragment.forEach((piece) => pieces.push(piece));
    let done = 0;
    while (this.next < this.matches.length && this.matches[this.next].from < end) {
      const match = this.matches[this.next];
      this.next += 1;
      const from = match.from - start;
      add(block.content.cut(done, from));
      if (this.text) {
        pieces.push(block.type.schema.text(this.text, block.childAfter(from).node?.marks));
      }
      done = match.to - start;
    }
    add(block.content.cut(done));
    // This also joins neighboring text with the same formatting.
    return block.copy(Fragment.fromArray(pieces));
  }
}

/** Replaces every match in one undo step. `matches` must be in document order. */
export function replaceAllMatches(tr: Transaction, matches: FindMatch[], text: string, maxSteps = MAX_SEPARATE_STEPS) {
  if (matches.length === 0) return;
  if (matches.length <= maxSteps) {
    // From the end, so the positions of matches still to come stay true.
    for (let i = matches.length - 1; i >= 0; i -= 1) replaceMatch(tr, matches[i], text);
    return;
  }
  const { doc, selection } = tr;
  const first = doc.resolve(matches[0].from);
  const lastIndex = doc.resolve(matches[matches.length - 1].from).index(0);
  const start = first.before(1);
  const rewriter = new Rewriter(matches, text);
  const rewritten: ProseNode[] = [];
  let pos = start;
  for (let index = first.index(0); index <= lastIndex; index += 1) {
    const child = doc.child(index);
    rewritten.push(rewriter.node(child, pos));
    pos += child.nodeSize;
  }
  tr.step(new ReplaceStep(start, pos, new Slice(Fragment.fromArray(rewritten), 0, 0)));
  // All of that is one change now, so the cursor would be thrown to its edge if left to follow.
  if (selection instanceof TextSelection) {
    tr.setSelection(
      TextSelection.create(
        tr.doc,
        positionAfterReplacing(selection.anchor, matches, text.length),
        positionAfterReplacing(selection.head, matches, text.length),
      ),
    );
  }
}
