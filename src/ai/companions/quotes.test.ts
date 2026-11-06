import { getSchema } from '@tiptap/core';
import { Node as ProseNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import { documentExtensions } from '../../editor/schema';
import type { PmNode } from '../../lib/types';
import { documentText, findQuote, locateQuote, normalizeText, verifyNotes } from './quotes';

const schema = getSchema(documentExtensions());
const isLeaf = (type: string) => schema.nodes[type]?.isLeaf ?? false;

const text = (t: string, marks?: PmNode['marks']): PmNode => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const p = (...content: (PmNode | string)[]): PmNode => ({ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? text(c) : c)) });
const doc = (...content: PmNode[]): PmNode => ({ type: 'doc', content });

/** The text ProseMirror itself finds in a range, which a located quote must match. */
function textAt(json: PmNode, range: { from: number; to: number }): string {
  return ProseNode.fromJSON(schema, json).textBetween(range.from, range.to, ' ', ' ');
}

describe('normalizeText', () => {
  it('collapses whitespace and evens out quotes, dashes and ellipses', () => {
    expect(normalizeText('  “Run,”\n\n she said—it’s  late…  ').text).toBe(`"Run," she said-it's late...`);
    expect(normalizeText('a -- b').text).toBe('a - b');
    expect(normalizeText('soft­hyphen​').text).toBe('softhyphen');
  });

  it('keeps a map back to the source', () => {
    const { text: normal, map } = normalizeText('a  b…c');
    expect(normal).toBe('a b...c');
    expect(map).toEqual([0, 1, 3, 4, 4, 4, 5]);
  });
});

describe('findQuote', () => {
  const source = 'She said, “Run,” and\n\nthe  gate — old as it was — held…';

  it('finds a quote whatever the spacing, quote marks or dashes', () => {
    const found = findQuote(source, `"Run," and the gate - old as it was - held...`);
    expect(found).not.toBeNull();
    expect(source.slice(found!.from, found!.to)).toBe('“Run,” and\n\nthe  gate — old as it was — held…');
  });

  it('is exact about the words and their case', () => {
    expect(findQuote(source, 'the gate - old as he was')).toBeNull();
    expect(findQuote(source, 'THE GATE')).toBeNull();
    expect(findQuote(source, 'gate ... held')).toBeNull();
  });

  it('forgives what a model wraps around a quote, but not an empty one', () => {
    expect(findQuote(source, '"the  gate"')).not.toBeNull();
    expect(findQuote(source, '…old as it was…')).not.toBeNull();
    expect(findQuote(source, '**the gate**')).not.toBeNull();
    expect(findQuote(source, '')).toBeNull();
    expect(findQuote(source, '...')).toBeNull();
    expect(findQuote(source, '"')).toBeNull();
  });

  it('prefers a quote as written, keeping its own quotation marks', () => {
    const line = 'Then "Run," she said.';
    const found = findQuote(line, '"Run,"');
    expect(line.slice(found!.from, found!.to)).toBe('"Run,"');
  });
});

describe('positions in a document', () => {
  it('matches ProseMirror, past marks, breaks, atoms and empty blocks', () => {
    const json = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('The Gate')] },
      { type: 'paragraph' },
      p('Aria ', text('drew', [{ type: 'bold' }]), ' her bow.', { type: 'hardBreak' }, 'Nobody moved.'),
      { type: 'horizontalRule' },
      p('Morning ', { type: 'reference', attrs: { text: 'A source' } }, 'came.'),
    );
    for (const quote of ['The Gate', 'drew her bow.', 'her bow. Nobody moved', 'Nobody moved. Morning', 'came.']) {
      const range = locateQuote(json, quote, isLeaf);
      expect(range, quote).not.toBeNull();
      expect(textAt(json, range!).replace(/\s+/g, ' ').trim()).toBe(quote);
    }
  });

  it('agrees with or without the schema', () => {
    const json = doc(p('One.', { type: 'hardBreak' }, 'Two.'), { type: 'horizontalRule' }, p('Three.'));
    expect(documentText(json, isLeaf)).toEqual(documentText(json));
  });

  it('says so when a passage is gone', () => {
    expect(locateQuote(doc(p('Nothing like it.')), 'The gate held', isLeaf)).toBeNull();
  });

  it('handles characters outside the basic plane', () => {
    const json = doc(p('A rune 𐰀 then the words.'));
    const range = locateQuote(json, 'the words', isLeaf)!;
    expect(textAt(json, range)).toBe('the words');
  });
});

describe('verifyNotes', () => {
  const scenes = [
    { id: 's1', title: 'One', doc: doc(p('The “old” dragon sleeps under the vale.')) },
    { id: 's2', title: 'Two', doc: doc(p('Morning came slowly over the hills.'), p('The dragon woke.')) },
  ];

  it('keeps what occurs, drops what does not, and counts what it drops', () => {
    const { notes, dropped } = verifyNotes(
      [
        { quote: 'The "old" dragon sleeps', note: 'Good.' },
        { quote: 'Morning came slowly', note: 'Slow.' },
        { quote: 'This was never written.', note: 'Invented.' },
        { quote: 'The dragon was', note: 'Almost.' },
      ],
      scenes,
    );
    expect(notes.map((n) => [n.sceneId, n.note])).toEqual([['s1', 'Good.'], ['s2', 'Slow.']]);
    expect(dropped).toBe(2);
  });

  it("shows the writer's text rather than the model's copy of it", () => {
    const { notes } = verifyNotes([{ quote: 'The "old" dragon', note: 'x' }], scenes);
    expect(notes[0].quote).toBe('The “old” dragon');
  });

  it('gives a quote to the first scene it occurs in', () => {
    const { notes } = verifyNotes([{ quote: 'dragon', note: 'x' }], scenes);
    expect(notes[0].sceneId).toBe('s1');
    expect(notes[0].sceneTitle).toBe('One');
  });

  it('does not repeat a note given twice, and does not count that as dropped', () => {
    const { notes, dropped } = verifyNotes([{ quote: 'dragon woke', note: 'x' }, { quote: 'dragon woke', note: 'x' }], scenes);
    expect(notes).toHaveLength(1);
    expect(dropped).toBe(0);
  });

  it('counts an empty quote as dropped', () => {
    expect(verifyNotes([{ quote: ' ', note: 'x' }], scenes).dropped).toBe(1);
  });
});
