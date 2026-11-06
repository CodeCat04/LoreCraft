import { getSchema } from '@tiptap/core';
import { Node as ProseNode } from '@tiptap/pm/model';

import { documentExtensions } from '../schema';
import { pmToMarkdown } from '../convert';
import type { PmNode } from '../../lib/types';
import {
  applyHunks,
  cleanReply,
  computeHunks,
  computeInsertion,
  hasText,
  keptNodesIntact,
  planRewrite,
  planToMarkdown,
  planToPlainText,
  safeRange,
  splitAtMarkers,
  stripMarkers,
} from './hunks';

const schema = getSchema(documentExtensions());

const text = (t: string, marks?: PmNode['marks']): PmNode => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: PmNode[]): PmNode => ({ type: 'paragraph', content });
const p = (t: string) => para(text(t));
const heading = (t: string, level = 2): PmNode => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const makeDoc = (...content: PmNode[]) => ProseNode.fromJSON(schema, { type: 'doc', content });

function figure(caption: string, attrs: Record<string, unknown> = {}): PmNode {
  return {
    type: 'figure',
    attrs: { kind: 'picture', align: 'left', width: 35, description: 'Hand drawn', ...attrs },
    content: [
      { type: 'image', attrs: { assetId: 'asset-1', alt: '' } },
      { type: 'figcaption', content: [text(caption)] },
    ],
  };
}

function tableFigure(caption: string): PmNode {
  return {
    type: 'figure',
    attrs: { kind: 'table', align: 'center', width: null, description: '' },
    content: [
      { type: 'table', content: [{ type: 'tableRow', content: [
        { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [p('cell one')] },
        { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [p('cell two')] },
      ] }] },
      { type: 'figcaption', content: [text(caption)] },
    ],
  };
}

/** The position just before the first occurrence of some text. */
function find(doc: ProseNode, needle: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(needle)) {
      found = pos + node.text.indexOf(needle);
    }
    return found < 0;
  });
  if (found < 0) throw new Error(`Not found: ${needle}`);
  return found;
}

function range(doc: ProseNode, start: string, end: string): { from: number; to: number } {
  return { from: find(doc, start), to: find(doc, end) + end.length };
}

function rewrite(doc: ProseNode, from: number, to: number, reply: string) {
  const plan = planRewrite(doc, from, to)!;
  const hunks = computeHunks(doc, plan, reply);
  const after = applyHunks(doc, hunks).doc;
  after.check();
  return { plan, hunks, after };
}

function plain(doc: ProseNode): string {
  return doc.textBetween(0, doc.content.size, '\n');
}

const whole = (doc: ProseNode) => ({ from: 0, to: doc.content.size });

describe('word-level changes', () => {
  it('changes only the words that differ', () => {
    const doc = makeDoc(p('The dragon sleeps under the old vale.'));
    const { from, to } = whole(doc);
    const { hunks, after } = rewrite(doc, from, to, 'The wyvern sleeps under the old vale.');
    expect(hunks).toHaveLength(1);
    expect(doc.textBetween(hunks[0].from, hunks[0].to)).toBe('dragon');
    expect(hunks[0].slice.content.textBetween(0, hunks[0].slice.content.size)).toBe('wyvern');
    expect(plain(after)).toBe('The wyvern sleeps under the old vale.');
  });

  it('works on part of a paragraph and leaves the rest alone', () => {
    const doc = makeDoc(p('Before. The dragon sleeps. After.'));
    const { from, to } = range(doc, 'The dragon', 'sleeps.');
    const { hunks, after } = rewrite(doc, from, to, 'A wyrm slumbers.');
    expect(plain(after)).toBe('Before. A wyrm slumbers. After.');
    expect(hunks.every((h) => h.from >= from && h.to <= to)).toBe(true);
  });

  it('keeps the space a double-click selects, so words do not run together', () => {
    const doc = makeDoc(p('The dragon sleeps.'));
    const at = find(doc, 'dragon');
    const { after } = rewrite(doc, at, at + 'dragon '.length, 'wyvern');
    expect(plain(after)).toBe('The wyvern sleeps.');
    const before = find(doc, ' sleeps');
    expect(plain(rewrite(doc, before, before + ' sleeps'.length, 'naps').after)).toBe('The dragon naps.');
    expect(planRewrite(doc, at + 6, at + 7)).toBeNull();
  });

  it('merges neighboring changes across a single space', () => {
    const doc = makeDoc(p('the quick fox'));
    const { hunks } = rewrite(doc, 0, doc.content.size, 'a slow fox');
    expect(hunks).toHaveLength(1);
    expect(doc.textBetween(hunks[0].from, hunks[0].to)).toBe('the quick');
  });

  it('keeps changes separate when real words sit between them', () => {
    const doc = makeDoc(p('one two three four five'));
    const { hunks, after } = rewrite(doc, 0, doc.content.size, 'ONE two three four FIVE');
    expect(hunks).toHaveLength(2);
    expect(plain(after)).toBe('ONE two three four FIVE');
  });

  it('returns nothing when the reply is the same', () => {
    const doc = makeDoc(p('Nothing to change here.'));
    expect(rewrite(doc, 0, doc.content.size, 'Nothing to change here.').hunks).toEqual([]);
  });

  it('handles inline marks in the reply', () => {
    const doc = makeDoc(p('A quiet night.'));
    const { after } = rewrite(doc, 0, doc.content.size, 'A *very* quiet night.');
    const json = JSON.stringify(after.toJSON());
    expect(json).toContain('"italic"');
    expect(plain(after)).toBe('A very quiet night.');
  });

  it('treats a mark change as a change, keeping the marked text exact', () => {
    const doc = makeDoc(para(text('Bold '), text('word', [{ type: 'bold' }]), text(' here')));
    const { after } = rewrite(doc, 0, doc.content.size, 'Bold word here');
    expect(JSON.stringify(after.toJSON())).not.toContain('"bold"');
    expect(plain(after)).toBe('Bold word here');
  });

  it('keeps wiki links through a rewrite', () => {
    const doc = makeDoc(para(text('See '), text('the Vale', [{ type: 'wikiLink', attrs: { target: 'Silver Vale' } }]), text(' now.')));
    const { after, hunks } = rewrite(doc, 0, doc.content.size, 'Visit [[Silver Vale|the Vale]] now.');
    expect(hunks).toHaveLength(1);
    expect(doc.textBetween(hunks[0].from, hunks[0].to)).toBe('See');
    expect(JSON.stringify(after.toJSON())).toContain('Silver Vale');
  });

  it('handles selections that cross paragraphs', () => {
    const doc = makeDoc(p('First paragraph ends here.'), p('Second paragraph begins here.'), p('Third stays.'));
    const { from, to } = range(doc, 'ends here', 'begins');
    const { after } = rewrite(doc, from, to, 'finishes now.\n\nSecond paragraph starts');
    expect(plain(after)).toBe('First paragraph finishes now.\nSecond paragraph starts here.\nThird stays.');
  });

  it('can turn one paragraph into several', () => {
    const doc = makeDoc(p('A long thought and then another.'));
    const { after } = rewrite(doc, 0, doc.content.size, 'A long thought.\n\nAnd then another.');
    expect(after.childCount).toBe(2);
    expect(plain(after)).toBe('A long thought.\nAnd then another.');
  });

  it('can merge several paragraphs into one', () => {
    const doc = makeDoc(p('One.'), p('Two.'), p('Three.'));
    const { after } = rewrite(doc, 0, doc.content.size, 'One. Two. Three.');
    expect(after.childCount).toBe(1);
    expect(plain(after)).toBe('One. Two. Three.');
  });

  it('can add paragraphs after the selected ones', () => {
    const doc = makeDoc(p('Start.'), p('Unselected.'));
    const { from, to } = range(doc, 'Start', 'Start.');
    const { after } = rewrite(doc, from, to, 'Start.\n\nAn added paragraph.');
    expect(plain(after)).toBe('Start.\nAn added paragraph.\nUnselected.');
  });

  it('can change a block type when the whole block is selected', () => {
    const doc = makeDoc(p('A title'), p('Body.'));
    const { after } = rewrite(doc, 0, doc.content.size, '## A title\n\nBody.');
    expect(after.child(0).type.name).toBe('heading');
    expect(after.child(1).type.name).toBe('paragraph');
    expect(plain(after)).toBe('A title\nBody.');
  });

  it('copes with lists on both sides', () => {
    const doc = makeDoc({ type: 'bulletList', content: [
      { type: 'listItem', content: [p('First item')] },
      { type: 'listItem', content: [p('Second item')] },
    ] }, p('After.'));
    const { after } = rewrite(doc, 0, doc.content.size, '- First thing\n- Second thing\n\nAfter.');
    expect(after.child(0).type.name).toBe('bulletList');
    expect(plain(after)).toBe('First thing\nSecond thing\nAfter.');
  });

  it('rewrites a sentence in a list item without disturbing the list', () => {
    const doc = makeDoc({ type: 'bulletList', content: [{ type: 'listItem', content: [p('First item here')] }] });
    const { from, to } = range(doc, 'First', 'item');
    const { after } = rewrite(doc, from, to, 'Opening entry');
    expect(after.child(0).type.name).toBe('bulletList');
    expect(plain(after)).toBe('Opening entry here');
  });

  it('survives a very different reply', () => {
    const doc = makeDoc(heading('Old heading'), p('Old text.'), { type: 'horizontalRule' }, p('More.'));
    const { after } = rewrite(doc, 0, doc.content.size, 'Totally new.\n\n- a list\n- of things\n\n> quoted');
    after.check();
    expect(after.textContent).toContain('Totally new.');
    expect(after.textContent).toContain('quoted');
    expect(after.textContent).not.toContain('Old');
  });

  it('applies independently, so one hunk can be accepted and others rejected', () => {
    const doc = makeDoc(p('one two three four five'));
    const { hunks } = rewrite(doc, 0, doc.content.size, 'ONE two three four FIVE');
    expect(plain(applyHunks(doc, [hunks[0]]).doc)).toBe('ONE two three four five');
    expect(plain(applyHunks(doc, [hunks[1]]).doc)).toBe('one two three four FIVE');
  });

  it('handles non-English text and emoji', () => {
    const doc = makeDoc(p('Der Drache schläft 🐉 tief.'));
    const { after, hunks } = rewrite(doc, 0, doc.content.size, 'Der Drache träumt 🐉 tief.');
    expect(hunks).toHaveLength(1);
    expect(plain(after)).toBe('Der Drache träumt 🐉 tief.');
  });

  it('can empty a selection', () => {
    const doc = makeDoc(p('Keep this. Remove this.'));
    const { after } = rewrite(doc, find(doc, 'Remove'), doc.content.size - 1, '');
    expect(plain(after)).toBe('Keep this. ');
  });
});

describe('figures are never touched', () => {
  const crossing = () =>
    makeDoc(
      p('The first paragraph mentions the gate.'),
      figure('The Silver Gate at dawn', { description: 'Aria stands beneath it', width: 42, align: 'right' }),
      p('The second paragraph goes on from there.'),
      tableFigure('Noble houses'),
      p('The last paragraph ends it.'),
    );

  const figureNodes = (doc: ProseNode) => {
    const found: unknown[] = [];
    doc.descendants((node) => {
      if (node.type.name !== 'figure') return true;
      found.push(node.toJSON());
      return false;
    });
    return found;
  };

  it('shows the model a marker for each one, with its real name and number', () => {
    const doc = crossing();
    const plan = planRewrite(doc, 0, doc.content.size)!;
    expect(plan.kept).toHaveLength(2);
    expect(plan.segments).toHaveLength(3);
    const md = planToMarkdown(doc, plan);
    expect(md).toContain('{{KEEP 1: [Picture 1: The Silver Gate at dawn (Aria stands beneath it)]}}');
    expect(md).toContain('{{KEEP 2: [Table 1: Noble houses]}}');
    expect(md).toContain('The first paragraph mentions the gate.');
    expect(md).not.toContain('asset-1');
  });

  it('numbers a figure by the whole document even when the range starts later', () => {
    const doc = makeDoc(figure('Earlier'), p('Text one.'), figure('Second'), p('Text two.'));
    const { from, to } = range(doc, 'Text one.', 'Text two.');
    const plan = planRewrite(doc, from, to)!;
    expect(plan.kept[0].line).toContain('Picture 2: Second');
    expect(planToPlainText(doc, plan)).toContain('[Picture 2: Second (Hand drawn)]');
  });

  it('rewrites text on both sides of a figure and leaves it exactly as it was', () => {
    const doc = crossing();
    const { hunks, after } = rewrite(
      doc,
      find(doc, 'first paragraph'),
      find(doc, 'second paragraph') + 'second paragraph'.length,
      'opening paragraph mentions the portal.\n\n{{KEEP 1: [Picture 1: The Silver Gate at dawn (Aria stands beneath it)]}}\n\nThe next paragraph',
    );
    expect(figureNodes(after)).toEqual(figureNodes(doc));
    expect(plain(after)).toContain('The opening paragraph mentions the portal.');
    expect(plain(after)).toContain('The next paragraph goes on from there.');
    for (const hunk of hunks) {
      doc.nodesBetween(hunk.from, Math.max(hunk.from, hunk.to), (node) => {
        expect(node.type.name).not.toBe('figure');
        return true;
      });
    }
  });

  it('keeps every figure attribute through a whole-document rewrite', () => {
    const doc = crossing();
    const { after } = rewrite(
      doc,
      0,
      doc.content.size,
      'New first.\n\n{{KEEP 1}}\n\nNew second.\n\n{{KEEP 2}}\n\nNew last.',
    );
    expect(figureNodes(after)).toEqual(figureNodes(doc));
    const picture = figureNodes(after)[0] as PmNode;
    expect(picture.attrs).toMatchObject({ kind: 'picture', align: 'right', width: 42, description: 'Aria stands beneath it' });
    expect(plain(after)).toContain('New first.');
    expect(plain(after)).toContain('New last.');
  });

  it('keeps figures when the model drops every marker', () => {
    const doc = crossing();
    const { after } = rewrite(doc, 0, doc.content.size, 'One short version of it all.');
    expect(figureNodes(after)).toEqual(figureNodes(doc));
    expect(plain(after)).toContain('One short version of it all.');
    expect(plain(after)).not.toContain('The second paragraph');
  });

  it('keeps figures when the model drops one marker', () => {
    const doc = crossing();
    const { after } = rewrite(doc, 0, doc.content.size, 'A.\n\n{{KEEP 2: [Table 1: Noble houses]}}\n\nC.');
    expect(figureNodes(after)).toEqual(figureNodes(doc));
    expect(plain(after)).toContain('A.');
    expect(plain(after)).toContain('C.');
  });

  it('keeps figures in place when the model reorders or repeats markers', () => {
    const doc = crossing();
    const { after } = rewrite(doc, 0, doc.content.size, '{{KEEP 2}}\n\nA.\n\n{{KEEP 1}}\n\nB.\n\n{{KEEP 2}}\n\nC.\n\n{{KEEP 9}}');
    expect(figureNodes(after)).toEqual(figureNodes(doc));
    expect(plain(after)).not.toContain('KEEP');
  });

  it('keeps figures when the reply is empty', () => {
    const doc = crossing();
    const { after } = rewrite(doc, 0, doc.content.size, '');
    expect(figureNodes(after)).toEqual(figureNodes(doc));
    expect(plain(after)).not.toContain('paragraph');
  });

  it('does not let a model invent media, while keeping what it wrote', () => {
    const doc = makeDoc(p('Before.'));
    const { after } = rewrite(doc, 0, doc.content.size, 'New text.\n\n![A map of the vale](https://evil.example/x.png)\n\n![](asset:stolen)\n\n![Clip](video:https://evil.example/v)');
    const json = JSON.stringify(after.toJSON());
    expect(json).not.toContain('evil.example');
    expect(json).not.toContain('stolen');
    expect(json).not.toContain('"figure"');
    expect(plain(after)).toContain('New text.');
    expect(plain(after)).toContain('A map of the vale');
    expect(plain(after)).toContain('Clip');
  });

  it('lets a model add a table', () => {
    const doc = makeDoc(p('Before.'));
    const { after } = rewrite(doc, 0, doc.content.size, 'Before.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(JSON.stringify(after.toJSON())).toContain('"table"');
  });

  it('pulls a selection out of a figure it only partly covers', () => {
    const doc = crossing();
    const inCaption = find(doc, 'Silver Gate');
    const end = find(doc, 'second paragraph') + 6;
    const range = safeRange(doc, inCaption, end)!;
    expect(range.from).toBeGreaterThan(inCaption);
    const after = rewrite(doc, inCaption, end, 'Changed').after;
    expect(figureNodes(after)).toEqual(figureNodes(doc));
    expect(plain(after)).toContain('Changed');
  });

  it('pulls the end of a selection back out of a figure', () => {
    const doc = crossing();
    const { after } = rewrite(doc, find(doc, 'first paragraph'), find(doc, 'Silver Gate'), 'opening words');
    expect(figureNodes(after)).toEqual(figureNodes(doc));
    expect(plain(after)).toContain('opening words');
  });

  it('allows a rewrite wholly inside a caption, as one line', () => {
    const doc = crossing();
    const start = find(doc, 'Silver Gate');
    const { after, plan } = rewrite(doc, start, start + 'Silver Gate'.length, 'Argent Door\n\nwith a second paragraph');
    expect(plan.inlineOnly).toBe(true);
    const picture = figureNodes(after)[0] as PmNode;
    expect(picture.attrs).toMatchObject({ kind: 'picture', width: 42, description: 'Aria stands beneath it' });
    expect(picture.content![0]).toEqual((figureNodes(doc)[0] as PmNode).content![0]);
    expect(pmToMarkdown({ type: 'doc', content: [{ type: 'paragraph', content: picture.content![1].content }] })).toContain('Argent Door');
    expect(after.childCount).toBe(doc.childCount);
  });

  it('allows a rewrite inside one table cell but not across cells', () => {
    const doc = crossing();
    const cell = find(doc, 'cell one');
    expect(planRewrite(doc, cell, cell + 4)?.inlineOnly).toBe(true);
    expect(planRewrite(doc, cell, find(doc, 'cell two') + 4)).toBeNull();
  });

  it('has nothing to rewrite when only a figure is selected', () => {
    const doc = makeDoc(p('Text.'), figure('Alone'), p('More.'));
    let at = 0;
    doc.forEach((node, offset) => {
      if (node.type.name === 'figure') at = offset;
    });
    const plan = planRewrite(doc, at, at + doc.child(1).nodeSize)!;
    expect(hasText(doc, plan)).toBe(false);
    expect(hasText(doc, planRewrite(doc, 0, doc.content.size)!)).toBe(true);
  });

  it('protects bare tables and images too', () => {
    const table = tableFigure('x').content![0];
    const doc = makeDoc(p('A.'), table, { type: 'image', attrs: { assetId: 'old', alt: 'Old image' } }, p('B.'));
    const { after } = rewrite(doc, 0, doc.content.size, 'Everything replaced.');
    expect(after.textContent).toContain('cell one');
    expect(JSON.stringify(after.toJSON())).toContain('"assetId":"old"');
    expect(plain(after)).toContain('Everything replaced.');
  });

  it('protects a figure nested inside a blockquote', () => {
    const doc = makeDoc({ type: 'blockquote', content: [p('Quoted before.'), figure('Nested'), p('Quoted after.')] }, p('Outside.'));
    const { after } = rewrite(doc, 0, doc.content.size, 'New before.\n\n{{KEEP 1}}\n\nNew after.');
    after.check();
    expect(figureNodes(after)).toEqual(figureNodes(doc));
    expect(plain(after)).toContain('New before.');
  });

  it('checks the kept nodes against the real result', () => {
    const doc = makeDoc(figure('A'), p('x'));
    const damaged = makeDoc(figure('B'), p('x'));
    expect(keptNodesIntact(doc, doc)).toBe(true);
    expect(keptNodesIntact(doc, damaged)).toBe(false);
    expect(keptNodesIntact(doc, makeDoc(p('x')))).toBe(false);
    expect(keptNodesIntact(doc, makeDoc(p('new'), figure('A'), p('x')))).toBe(true);
  });
});

describe('markers', () => {
  it('splits a reply into one piece per segment', () => {
    expect(splitAtMarkers('a{{KEEP 1: x}}b{{KEEP 2}}c', 2)).toEqual(['a', 'b', 'c']);
    expect(splitAtMarkers('no markers', 2)).toEqual(['no markers', '', '']);
    expect(splitAtMarkers('a{{KEEP 2}}c', 2)).toEqual(['a', '', 'c']);
    expect(splitAtMarkers('{{KEEP 2}}a{{KEEP 1}}b', 2)).toEqual(['', '', 'ab']);
    expect(splitAtMarkers('a{{ KEEP 1 }}b{{KEEP 1}}c', 1)).toEqual(['a', 'bc']);
    expect(splitAtMarkers('a{{KEEP 7}}b', 1)).toEqual(['ab', '']);
    expect(splitAtMarkers('plain', 0)).toEqual(['plain']);
  });

  it('can be removed from text with nothing to line up with', () => {
    expect(stripMarkers('One.\n\n{{KEEP 1: [Picture 1: x]}}\n\nTwo.')).toBe('One.\n\nTwo.');
  });
});

describe('insertion', () => {
  it('adds new paragraphs after the current one when at its end', () => {
    const doc = makeDoc(p('The end of a thought.'), p('A later paragraph.'));
    const [hunk] = computeInsertion(doc, find(doc, 'thought.') + 'thought.'.length, 'It went on.\n\nAnd on.');
    expect(hunk.from).toBe(hunk.to);
    const after = applyHunks(doc, [hunk]).doc;
    expect(plain(after)).toBe('The end of a thought.\nIt went on.\nAnd on.\nA later paragraph.');
  });

  it('flows into the sentence when in the middle of one', () => {
    const doc = makeDoc(p('Start and finish.'));
    const [hunk] = computeInsertion(doc, find(doc, ' and'), ', middle');
    expect(plain(applyHunks(doc, [hunk]).doc)).toBe('Start, middle and finish.');
  });

  it('fills an empty page rather than leaving a blank line above', () => {
    const doc = makeDoc({ type: 'paragraph' });
    const [hunk] = computeInsertion(doc, 1, '## Heading\n\nBody text.');
    const after = applyHunks(doc, [hunk]).doc;
    expect(after.childCount).toBe(2);
    expect(after.child(0).type.name).toBe('heading');
  });

  it('never lands inside a figure', () => {
    const doc = makeDoc(p('Text.'), figure('Label'));
    const [hunk] = computeInsertion(doc, find(doc, 'Label') + 2, 'New paragraph.');
    const after = applyHunks(doc, [hunk]).doc;
    expect(plain(after)).toContain('New paragraph.');
    const picture = after.child(1);
    expect(picture.type.name).toBe('figure');
    expect(picture.textContent).toBe('Label');
  });

  it('gives nothing for an empty reply', () => {
    expect(computeInsertion(makeDoc(p('x')), 1, '   ')).toEqual([]);
  });
});

describe('a brand-new page', () => {
  it('turns an empty document into the whole reply', () => {
    const doc = makeDoc({ type: 'paragraph' });
    const { after, hunks } = rewrite(doc, 0, doc.content.size, '## Early life\n\nAria grew up in the Vale.\n\n- A ranger\n- A friend');
    expect(hunks).toHaveLength(1);
    expect(after.child(0).type.name).toBe('heading');
    expect(after.textContent).toContain('Aria grew up in the Vale.');
    expect(after.child(after.childCount - 1).type.name).toBe('bulletList');
  });

  it('adds to a page holding only a figure', () => {
    const doc = makeDoc(figure('Portrait'));
    const { after } = rewrite(doc, 0, doc.content.size, 'Text before.\n\n{{KEEP 1}}\n\nText after.');
    expect(after.childCount).toBe(3);
    expect(after.child(1).type.name).toBe('figure');
    expect(plain(after)).toContain('Text before.');
    expect(plain(after)).toContain('Text after.');
  });
});

describe('cleaning replies', () => {
  it('removes wrappers models tend to add', () => {
    expect(cleanReply('```\nThe text.\n```')).toBe('The text.');
    expect(cleanReply('```markdown\nThe text.\n```')).toBe('The text.');
    expect(cleanReply("Here's the rewritten passage:\n\nThe text.")).toBe('The text.');
    expect(cleanReply('Sure, here you go:\nThe text.')).toBe('The text.');
    expect(cleanReply('"The text."')).toBe('The text.');
    expect(cleanReply('  The text.  ')).toBe('The text.');
    expect(cleanReply('<selection from="A page">\nThe text.\n</selection>')).toBe('The text.');
  });

  it('leaves real content alone', () => {
    expect(cleanReply('"I will," she said. "Tomorrow."')).toBe('"I will," she said. "Tomorrow."');
    expect(cleanReply('"The text."', '"The original."')).toBe('"The text."');
    expect(cleanReply('Here the road ends: nothing but sand.')).toBe('Here the road ends: nothing but sand.');
  });
});
