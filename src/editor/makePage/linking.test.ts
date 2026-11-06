import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import type { Node as ProseNode } from '@tiptap/pm/model';

import { documentExtensions } from '../schema';
import { addLinks, linkableRange, linkedTarget, nameCandidates, otherMentions } from './linking';

const schema = getSchema(documentExtensions());

function text(value: string, ...marks: (string | { type: string; attrs: Record<string, unknown> })[]) {
  return {
    type: 'text',
    text: value,
    marks: marks.map((mark) => (typeof mark === 'string' ? { type: mark } : mark)),
  };
}

const link = (target: string) => ({ type: 'wikiLink', attrs: { target } });

function paragraph(...content: unknown[]) {
  return { type: 'paragraph', content };
}

function doc(...content: unknown[]): ProseNode {
  return schema.nodeFromJSON({ type: 'doc', content });
}

/** The positions of the first occurrence of `what`. */
function at(document: ProseNode, what: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  document.descendants((node, pos) => {
    if (found || !node.isText) return;
    const index = node.text!.indexOf(what);
    if (index >= 0) found = { from: pos + index, to: pos + index + what.length };
  });
  if (!found) throw new Error(`${what} is not in the document`);
  return found;
}

describe('linkableRange', () => {
  it('takes a plain selection', () => {
    const document = doc(paragraph(text('The Silver Vale is far')));
    const { from, to } = at(document, 'Silver Vale');
    expect(linkableRange(document, from, to)).toEqual({ from, to, text: 'Silver Vale' });
  });

  it('leaves out the spaces and punctuation that come with selecting by hand', () => {
    const document = doc(paragraph(text('He saw “Aria,” and left')));
    const { from, to } = at(document, '“Aria,” ');
    const range = linkableRange(document, from, to)!;
    expect(range.text).toBe('Aria');
    expect(document.textBetween(range.from, range.to)).toBe('Aria');
  });

  it('runs across formatting', () => {
    const document = doc(paragraph(text('Sil', 'bold'), text('ver', 'italic')));
    expect(linkableRange(document, 1, 7)?.text).toBe('Silver');
  });

  it('turns down what could not be a link', () => {
    const across = doc(paragraph(text('one')), paragraph(text('two')));
    expect(linkableRange(across, 2, 7), 'more than one block').toBeNull();

    const code = doc({ type: 'codeBlock', content: [text('let x')] });
    expect(linkableRange(code, 1, 4), 'code').toBeNull();

    const brackets = doc(paragraph(text('a [b] c')));
    expect(linkableRange(brackets, 1, 6), 'brackets').toBeNull();

    const citation = doc(paragraph(text('one'), { type: 'reference', attrs: { text: 'x' } }, text('two')));
    expect(linkableRange(citation, 1, 8), 'a citation').toBeNull();

    const spaces = doc(paragraph(text('a   b')));
    expect(linkableRange(spaces, 2, 5), 'nothing but spaces').toBeNull();

    const long = doc(paragraph(text('x'.repeat(200))));
    expect(linkableRange(long, 1, 150), 'too long for a name').toBeNull();
    expect(linkableRange(long, 1, 1), 'an empty selection').toBeNull();
  });

  it('turns down a range the document no longer has, rather than failing', () => {
    // What is left after selecting two paragraphs and the start of a third, and deleting.
    // The selection menu still has the old range for a moment.
    const shorter = doc(paragraph(text('Third line.')));
    expect(linkableRange(shorter, 1, 42)).toBeNull();
    expect(linkableRange(shorter, -1, 4)).toBeNull();
  });
});

describe('linkedTarget', () => {
  const document = doc(paragraph(text('Before '), text('Aria', link('Aria')), text(' after')));

  it('names the page when all of it is a link', () => {
    expect(linkedTarget(document, at(document, 'Aria'))).toBe('Aria');
  });

  it('is null when some of it is not', () => {
    const { from, to } = at(document, 'Aria');
    expect(linkedTarget(document, { from: from - 2, to })).toBeNull();
    expect(linkedTarget(document, at(document, 'after'))).toBeNull();
  });
});

describe('nameCandidates', () => {
  it('also tries a name without its possessive', () => {
    expect(nameCandidates('Aria’s')).toEqual(['Aria’s', 'Aria']);
    expect(nameCandidates("Aria's")).toEqual(["Aria's", 'Aria']);
    expect(nameCandidates('Aria')).toEqual(['Aria']);
  });
});

describe('otherMentions', () => {
  const words = (document: ProseNode, ranges: { from: number; to: number }[]) =>
    ranges.map((r) => document.textBetween(r.from, r.to));

  it('finds whole words with the same capitals, and not the selection itself', () => {
    const document = doc(paragraph(text('Aria met aria and Maria and Aria.')), paragraph(text('Aria again')));
    const selected = at(document, 'Aria');
    const found = otherMentions(document, ['Aria'], selected);
    expect(words(document, found)).toEqual(['Aria', 'Aria']);
    expect(found.every((r) => r.from !== selected.from)).toBe(true);
  });

  it('leaves links, code and headings alone', () => {
    const document = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Aria')] },
      paragraph(text('Aria', link('Aria')), text(' and '), text('Aria', 'code'), text(' and '), text('Aria', { type: 'link', attrs: { href: 'https://x.test' } })),
      { type: 'codeBlock', content: [text('Aria')] },
      paragraph(text('Plain Aria')),
    );
    expect(otherMentions(document, ['Aria'], null)).toHaveLength(1);
  });

  it('counts one name once, and the longest of overlapping names', () => {
    const document = doc(paragraph(text('The Silver Vale and the Vale')));
    expect(words(document, otherMentions(document, ['Vale', 'Silver Vale', 'Vale'], null))).toEqual(['Silver Vale', 'Vale']);
  });

  it('skips names too short to trust', () => {
    const document = doc(paragraph(text('Al met Al')));
    expect(otherMentions(document, ['Al'], null)).toEqual([]);
  });

  it('finds a mention that runs across formatting', () => {
    const document = doc(paragraph(text('Sil', 'bold'), text('ver the end')));
    expect(words(document, otherMentions(document, ['Silver'], null))).toEqual(['Silver']);
  });
});

describe('addLinks', () => {
  it('links every range in one step-per-range transaction, keeping other formatting', () => {
    const document = doc(paragraph(text('Aria', 'bold'), text(' met Aria')));
    const state = EditorState.create({ doc: document });
    const tr = addLinks(state.tr, [{ from: 1, to: 5 }, { from: 10, to: 14 }], 'Aria');
    const json = tr.doc.toJSON();
    const nodes = json.content[0].content;
    expect(nodes[0].marks).toEqual(
      expect.arrayContaining([{ type: 'bold' }, { type: 'wikiLink', attrs: { target: 'Aria' } }]),
    );
    expect(nodes[2]).toEqual({ type: 'text', text: 'Aria', marks: [{ type: 'wikiLink', attrs: { target: 'Aria' } }] });
    expect(nodes[1].marks).toBeUndefined();
  });
});
