import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';

import { documentExtensions } from '../schema';
import { positionAfterReplacing, replaceAllMatches, replaceMatch } from './replace';
import { findMatches } from './search';

const schema = getSchema(documentExtensions());

function text(value: string, ...marks: (string | { type: string; attrs: Record<string, unknown> })[]) {
  return {
    type: 'text',
    text: value,
    ...(marks.length > 0 ? { marks: marks.map((mark) => (typeof mark === 'string' ? { type: mark } : mark)) } : {}),
  };
}

function paragraph(...content: unknown[]) {
  return { type: 'paragraph', content };
}

function doc(...content: unknown[]): ProseNode {
  return schema.nodeFromJSON({ type: 'doc', content });
}

const link = { type: 'wikiLink', attrs: { target: 'Ser Tolin' } };

/** Replaces everything both ways, with a step each and as one step, which must agree. */
function replaced(document: ProseNode, query: string, replacement: string): unknown {
  const matches = findMatches(document, { query, matchCase: false, wholeWord: false });
  const state = EditorState.create({ doc: document });
  const separate = state.tr;
  replaceAllMatches(separate, matches, replacement, Number.MAX_SAFE_INTEGER);
  const together = state.tr;
  replaceAllMatches(together, matches, replacement, 0);
  separate.doc.check();
  together.doc.check();
  expect(together.doc.toJSON()).toEqual(separate.doc.toJSON());
  expect(together.steps).toHaveLength(1);
  return together.doc.toJSON();
}

describe('replacing', () => {
  it('replaces every match, keeping the text around them', () => {
    expect(replaced(doc(paragraph(text('one two one')), paragraph(text('two one'))), 'one', 'three')).toEqual({
      type: 'doc',
      content: [paragraph(text('three two three')), paragraph(text('two three'))],
    });
  });

  it('gives a replacement the formatting of what it replaced', () => {
    const before = doc(paragraph(text('a '), text('word', 'bold'), text(' b '), text('word', 'italic')));
    expect(replaced(before, 'word', 'name')).toEqual({
      type: 'doc',
      content: [paragraph(text('a '), text('name', 'bold'), text(' b '), text('name', 'italic'))],
    });
  });

  it('takes the first character’s formatting for a match across formatting', () => {
    const before = doc(paragraph(text('Ser ', 'bold'), text('Tolin'), text(' left')));
    expect(replaced(before, 'ser tolin', 'Bram')).toEqual({
      type: 'doc',
      content: [paragraph(text('Bram', 'bold'), text(' left'))],
    });
  });

  it('keeps a link when the whole of it is replaced', () => {
    const before = doc(paragraph(text('Later '), text('Ser Tolin', link), text(' came')));
    expect(replaced(before, 'ser tolin', 'the Captain')).toEqual({
      type: 'doc',
      content: [paragraph(text('Later '), text('the Captain', link), text(' came'))],
    });
  });

  it('can replace with nothing, even all of a block', () => {
    expect(replaced(doc(paragraph(text('gone')), paragraph(text('a gone b'))), 'gone', '')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }, paragraph(text('a  b'))],
    });
  });

  it('joins text that ends up with the same formatting', () => {
    const result = replaced(doc(paragraph(text('axb'))), 'x', 'y') as { content: { content: unknown[] }[] };
    expect(result.content[0].content).toHaveLength(1);
  });

  it('leaves line breaks and citations in place', () => {
    const before = doc(paragraph(text('x'), { type: 'hardBreak' }, text('x'), { type: 'reference', attrs: { text: 'Source' } }, text('x')));
    expect(replaced(before, 'x', 'y')).toEqual({
      type: 'doc',
      content: [paragraph(text('y'), { type: 'hardBreak' }, text('y'), { type: 'reference', attrs: { text: 'Source' } }, text('y'))],
    });
  });

  it('reaches into lists, tables and captions, and leaves what has no match alone', () => {
    const before = doc(
      paragraph(text('nothing here')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('a dragon'))] }] },
      {
        type: 'table',
        content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(text('dragon cell'))] }] }],
      },
      {
        type: 'figure',
        content: [
          { type: 'image', attrs: { src: 'x.png' } },
          { type: 'figcaption', content: [text('The dragon map')] },
        ],
      },
      paragraph(text('nothing here either')),
    );
    const result = replaced(before, 'dragon', 'wyrm');
    const expected = JSON.parse(JSON.stringify(before.toJSON()).replaceAll('dragon', 'wyrm'));
    expect(result).toEqual(expected);
  });

  it('touches only the span with matches, so a change elsewhere keeps its place', () => {
    const before = doc(paragraph(text('first')), paragraph(text('a word')), paragraph(text('b word')), paragraph(text('last')));
    const matches = findMatches(before, { query: 'word', matchCase: false, wholeWord: false });
    const tr = EditorState.create({ doc: before }).tr;
    replaceAllMatches(tr, matches, 'x', 0);
    const lastAt = before.content.size - 5;
    expect(tr.mapping.map(lastAt)).toBe(lastAt - 6);
    expect(tr.doc.textBetween(tr.mapping.map(lastAt), tr.doc.content.size - 1)).toBe('last');
  });

  it('undoes as one step, back to exactly what was there', () => {
    const before = doc(paragraph(text('Ser ', 'bold'), text('Tolin')), paragraph(text('x')), paragraph(text('Ser Tolin', link), text(' end')));
    const matches = findMatches(before, { query: 'ser tolin', matchCase: false, wholeWord: false });
    const tr = EditorState.create({ doc: before }).tr;
    replaceAllMatches(tr, matches, 'Bram', 0);
    const undone = tr.steps[0].invert(before).apply(tr.doc);
    expect(undone.doc?.toJSON()).toEqual(before.toJSON());
  });

  it('keeps the cursor with its text when everything is written as one step', () => {
    const before = doc(paragraph(text('aa word bb')), paragraph(text('cc word dd')), paragraph(text('ee')));
    const matches = findMatches(before, { query: 'word', matchCase: false, wholeWord: false });
    const dd = before.content.size - 6;
    const state = EditorState.create({ doc: before, selection: TextSelection.create(before, dd - 1, dd + 1) });
    const tr = state.tr;
    replaceAllMatches(tr, matches, 'longer name', 0);
    expect(tr.doc.textBetween(tr.selection.from, tr.selection.to)).toBe(before.textBetween(dd - 1, dd + 1));
  });

  it('replaces one match on its own', () => {
    const before = doc(paragraph(text('Ser Tolin', link), text(' went')));
    const tr = EditorState.create({ doc: before }).tr;
    replaceMatch(tr, { from: 1, to: 10 }, 'Bram');
    expect(tr.doc.toJSON().content[0].content[0]).toEqual(text('Bram', link));
    const removed = EditorState.create({ doc: before }).tr;
    replaceMatch(removed, { from: 1, to: 10 }, '');
    expect(removed.doc.textContent).toBe(' went');
  });
});

describe('positionAfterReplacing', () => {
  const matches = [
    { from: 10, to: 14 },
    { from: 20, to: 24 },
  ];

  it('moves what comes after by what changed before it', () => {
    expect(positionAfterReplacing(5, matches, 6)).toBe(5);
    expect(positionAfterReplacing(10, matches, 6)).toBe(10);
    expect(positionAfterReplacing(14, matches, 6)).toBe(16);
    expect(positionAfterReplacing(20, matches, 6)).toBe(22);
    expect(positionAfterReplacing(30, matches, 6)).toBe(34);
    expect(positionAfterReplacing(30, matches, 0)).toBe(22);
  });

  it('sends a position inside a match to the end of its replacement', () => {
    expect(positionAfterReplacing(12, matches, 6)).toBe(16);
    expect(positionAfterReplacing(22, matches, 6)).toBe(28);
  });
});

describe('replacing a very long document', () => {
  it('takes no time worth noticing when written as one step', () => {
    const line = 'the quick brown fox jumps over the lazy dog and keeps on running through the wood ';
    const document = doc(...Array.from({ length: 5500 }, () => paragraph(text(line))));
    const matches = findMatches(document, { query: 'the', matchCase: false, wholeWord: true });
    const tr = EditorState.create({ doc: document }).tr;
    const started = performance.now();
    replaceAllMatches(tr, matches, 'that');
    const elapsed = performance.now() - started;
    expect(tr.steps).toHaveLength(1);
    expect(tr.doc.textContent.includes(' the ')).toBe(false);
    // The real figure is tens of milliseconds, with room for a busy machine.
    expect(elapsed).toBeLessThan(2000);
  });
});
