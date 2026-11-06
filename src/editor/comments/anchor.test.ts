import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import type { PmNode } from '../../lib/types';
import { computeHunks, planRewrite } from '../ai/hunks';
import { cleanPasted } from './extension';
import { markdownToPm, pmToHtml, pmToMarkdown, pmToPlainText, stripCommentMarks } from '../convert';
import { documentExtensions } from '../schema';
import {
  addCommentMark,
  commentRanges,
  findQuote,
  markQuoteInStored,
  quoteOf,
  removeCommentMark,
  unmarkInStored,
} from './anchor';

const schema = getSchema(documentExtensions());

const text = (value: string, marks?: PmNode['marks']): PmNode => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const para = (...content: PmNode[]): PmNode => ({ type: 'paragraph', content });
const doc = (...content: PmNode[]): PmNode => ({ type: 'doc', content });
const comment = (id: string) => ({ type: 'comment', attrs: { id } });

function stateOf(json: PmNode) {
  return EditorState.create({ schema, doc: schema.nodeFromJSON(json) });
}

describe('the comment mark', () => {
  it('lets comments overlap', () => {
    const state = stateOf(doc(para(text('one two three'))));
    const tr = state.tr;
    addCommentMark(tr, 'a', 1, 8);
    addCommentMark(tr, 'b', 5, 14);
    const ranges = commentRanges(tr.doc);
    expect(ranges.get('a')).toEqual([{ from: 1, to: 8 }]);
    expect(ranges.get('b')).toEqual([{ from: 5, to: 14 }]);
    tr.doc.check();
  });

  it('does not grow when typing at its edge', () => {
    const state = stateOf(doc(para(text('one two three'))));
    const marked = state.apply(
      (() => {
        const tr = state.tr;
        addCommentMark(tr, 'a', 5, 8);
        return tr;
      })(),
    );
    const atEnd = marked.apply(marked.tr.setSelection(TextSelection.create(marked.doc, 8)));
    const typed = atEnd.apply(atEnd.tr.insertText('X'));
    expect(quoteOf(typed.doc, 5, 9)).toBe('twoX');
    expect(commentRanges(typed.doc).get('a')).toEqual([{ from: 5, to: 8 }]);
  });

  it('survives typing inside it and moves with the text', () => {
    const state = stateOf(doc(para(text('one two three'))));
    const tr = state.tr;
    addCommentMark(tr, 'a', 5, 8);
    tr.insertText('Well, ', 1);
    tr.insertText('-', 12);
    const [range] = commentRanges(tr.doc).get('a') ?? [];
    expect(quoteOf(tr.doc, range.from, range.to)).toBe('t-wo');
  });

  it('removes one comment and leaves others on the same text', () => {
    const state = stateOf(doc(para(text('one two three'))));
    const tr = state.tr;
    addCommentMark(tr, 'a', 1, 8);
    addCommentMark(tr, 'b', 5, 14);
    removeCommentMark(tr, 'a');
    const ranges = commentRanges(tr.doc);
    expect(ranges.has('a')).toBe(false);
    expect(ranges.get('b')).toEqual([{ from: 5, to: 14 }]);
  });

  it('joins next-door stretches and keeps separate ones apart', () => {
    const state = stateOf(
      doc(
        para(text('aa', [comment('x')]), text('bb', [{ type: 'bold' }, comment('x')]), text(' gap '), text('cc', [comment('x')])),
        para(text('dd', [comment('x')])),
      ),
    );
    expect(commentRanges(state.doc).get('x')).toEqual([
      { from: 1, to: 5 },
      { from: 10, to: 12 },
      { from: 14, to: 16 },
    ]);
  });
});

describe('findQuote', () => {
  const sample = schema.nodeFromJSON(
    doc(
      para(text('“Stop,” she said. It’s late — too late… ')),
      para(text('The gate '), text('held', [{ type: 'bold' }]), text(' fast.')),
      para(text('Line one'), { type: 'hardBreak' }, text('line two')),
    ),
  );
  const found = (quote: string) => {
    const range = findQuote(sample, quote);
    return range ? sample.textBetween(range.from, range.to, '|', '/') : null;
  };

  it('finds words across marks', () => {
    expect(found('gate held fast')).toBe('gate held fast');
  });

  it('treats typed and typeset punctuation alike', () => {
    expect(found('"Stop," she said.')).toBe('“Stop,” she said.');
    expect(found("It's late - too late...")).toBe('It’s late — too late…');
    expect(found("It's late -- too late")).toBe('It’s late — too late');
  });

  it('crosses a paragraph break or a line break', () => {
    expect(found('too late… The gate')).toBe('too late… |The gate');
    expect(found('one line two')).toBe('one/line two');
    expect(found('Line  one\n line')).toBe('Line one/line');
  });

  it('falls back to ignoring case', () => {
    expect(found('THE GATE')).toBe('The gate');
  });

  it('finds nothing when the words are not there', () => {
    expect(found('the dragon')).toBeNull();
    expect(found('   ')).toBeNull();
  });
});

describe('stored documents', () => {
  const stored = doc(para(text('The old gate held.')));

  it('marks a quote and can take the mark out again', () => {
    const marked = markQuoteInStored(stored, 'c1', 'old gate');
    expect(marked).not.toBeNull();
    const node = schema.nodeFromJSON(marked as PmNode);
    expect(commentRanges(node).get('c1')).toEqual([{ from: 5, to: 13 }]);
    expect(pmToPlainText(marked as PmNode)).toBe(pmToPlainText(stored));

    const clean = unmarkInStored(marked as PmNode, 'c1');
    expect(clean).toEqual(stored);
  });

  it('reports quotes and marks it cannot find', () => {
    expect(markQuoteInStored(stored, 'c1', 'nowhere')).toBeNull();
    expect(unmarkInStored(stored, 'c1')).toBeNull();
  });
});

describe('pasting', () => {
  const marked = schema.nodeFromJSON(
    doc(para(text('kept ', [comment('moved')]), text('gone', [comment('copied')]), text(' plain', [{ type: 'bold' }]))),
  );
  const slice = marked.slice(0, marked.content.size);
  const marksIn = (result: typeof slice) => {
    const found: string[] = [];
    result.content.descendants((node) => {
      node.marks.forEach((m) => found.push(m.type.name === 'comment' ? String(m.attrs.id) : m.type.name));
    });
    return found;
  };

  it('keeps only the comments allowed, and every other mark', () => {
    const cleaned = cleanPasted(slice, (id) => id === 'moved');
    expect(marksIn(cleaned)).toEqual(['moved', 'bold']);
    expect(cleaned.content.textBetween(0, cleaned.content.size)).toBe('kept gone plain');
  });

  it('leaves a slice with nothing to remove as it was', () => {
    expect(cleanPasted(slice, () => true)).toBe(slice);
  });
});

describe('what leaves the document', () => {
  const marked = doc(
    para(
      text('See '),
      text('the ', [{ type: 'wikiLink', attrs: { target: 'Old Gate' } }]),
      text('old', [{ type: 'wikiLink', attrs: { target: 'Old Gate' } }, comment('a')]),
      text(' gate', [{ type: 'wikiLink', attrs: { target: 'Old Gate' } }]),
      text(' and '),
      text('bo', [{ type: 'bold' }, comment('a')]),
      text('ld', [{ type: 'bold' }]),
      text(' and a '),
      text('li', [{ type: 'link', attrs: { href: 'https://example.com' } }, comment('b')]),
      text('nk', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
      text('.', [comment('c')]),
    ),
  );
  const clean = doc(
    para(
      text('See '),
      text('the old gate', [{ type: 'wikiLink', attrs: { target: 'Old Gate' } }]),
      text(' and '),
      text('bold', [{ type: 'bold' }]),
      text(' and a '),
      text('link', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
      text('.'),
    ),
  );

  it('plain text is the same with or without comments', () => {
    expect(pmToPlainText(marked)).toBe(pmToPlainText(clean));
  });

  it('Markdown is the same, so a link stays one link', () => {
    expect(pmToMarkdown(marked)).toBe(pmToMarkdown(clean));
    expect(pmToMarkdown(marked)).toContain('[[Old Gate|the old gate]]');
    expect(pmToMarkdown(marked)).toContain('**bold**');
    expect(pmToMarkdown(marked)).not.toContain('comment');
  });

  it('HTML is the same and names no comment', () => {
    expect(pmToHtml(marked)).toBe(pmToHtml(clean));
    expect(pmToHtml(marked)).not.toMatch(/comment/);
  });

  it('can strip a whole document', () => {
    expect(stripCommentMarks(marked)).toEqual(clean);
    const nested = doc({ type: 'blockquote', content: [marked.content?.[0] as PmNode] });
    expect(stripCommentMarks(nested).content?.[0].content?.[0]).toEqual(clean.content?.[0]);
  });

  it('a document without comments comes back unchanged', () => {
    expect(stripCommentMarks(clean)).toEqual(clean);
  });

  it('survives a Markdown round trip with no trace', () => {
    expect(JSON.stringify(markdownToPm(pmToMarkdown(marked)))).not.toContain('comment');
  });
});

describe('AI suggestions on commented text', () => {
  it('a comment does not make its words look changed', () => {
    const node = schema.nodeFromJSON(
      doc(para(text('The '), text('old gate', [comment('a')]), text(' held fast.'))),
    );
    const plan = planRewrite(node, 1, node.content.size - 1);
    if (!plan) throw new Error('There should be something to rewrite.');
    const hunks = computeHunks(node, plan, 'The old gate held firm.');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].slice.content.textBetween(0, hunks[0].slice.content.size)).toBe('firm');
    expect(node.textBetween(hunks[0].from, hunks[0].to)).toBe('fast');
  });
});
