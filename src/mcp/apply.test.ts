import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { Node as ProseNode } from '@tiptap/pm/model';

import { applyEdit, findQuote, normalizeQuote } from './apply';
import { documentExtensions } from '../editor/schema';
import { pmToPlainText } from '../editor/convert';
import type { PmNode } from '../lib/types';

const schema = getSchema(documentExtensions());
const text = (t: string, marks?: PmNode['marks']): PmNode => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: PmNode[]): PmNode => ({ type: 'paragraph', content });
const doc = (...content: PmNode[]): PmNode => ({ type: 'doc', content });
const figure = (caption: string): PmNode => ({
  type: 'figure',
  attrs: { kind: 'figure', align: 'right', width: 40, description: 'Aria at dawn' },
  content: [
    { type: 'image', attrs: { assetId: 'asset-1' } },
    { type: 'figcaption', content: [text(caption)] },
  ],
});

function applied(content: PmNode, quote: string, replacement: string): PmNode {
  const result = applyEdit(content, quote, replacement);
  if ('stale' in result) throw new Error(result.stale);
  ProseNode.fromJSON(schema, result.doc).check();
  return result.doc;
}

const wiki = (target: string) => [{ type: 'wikiLink', attrs: { target } }];
/** A node as it comes back from storage, with every attribute filled in. */
const stored = (node: PmNode) => ProseNode.fromJSON(schema, node).toJSON() as PmNode;

describe('normalizeQuote', () => {
  it('ignores curly quotes and how lines were wrapped', () => {
    expect(normalizeQuote('  “Don’t\n\n go,”  she said. ')).toBe('"Don\'t go," she said.');
  });
});

describe('findQuote', () => {
  const pm = (content: PmNode) => ProseNode.fromJSON(schema, content);

  it('finds a quote across marks, and says when it is missing or repeated', () => {
    const d = pm(doc(para(text('The '), text('old', [{ type: 'italic' }]), text(' gate.'))));
    const match = findQuote(d, 'The old gate');
    expect(match).toEqual({ from: 1, to: 13 });
    expect(findQuote(d, 'no such words')).toEqual({ problem: 'missing' });
    expect(findQuote(pm(doc(para(text('a b a b')))), 'a b')).toEqual({ problem: 'repeated' });
    expect(findQuote(d, '   ')).toEqual({ problem: 'missing' });
  });

  it('cannot reach across a figure', () => {
    const d = pm(doc(para(text('Before the figure.')), figure('The gate'), para(text('After the figure.'))));
    expect(findQuote(d, 'Before the figure. After the figure.')).toEqual({ problem: 'missing' });
    expect(findQuote(d, 'Before the figure.')).toHaveProperty('from');
  });
});

describe('applyEdit', () => {
  it('changes only the words that differ, keeping marks on the rest', () => {
    const before = doc(
      para(
        text('Aria drew the '),
        text('Ember Blade', wiki('Ember Blade')),
        text(' and '),
        text('ran', [{ type: 'italic' }]),
        text(' for the gate.'),
      ),
    );
    const after = applied(before, 'drew the Ember Blade and ran for the gate', 'drew the Ember Blade and sprinted for the old gate');
    const nodes = after.content?.[0].content ?? [];
    expect(pmToPlainText(after)).toBe('Aria drew the Ember Blade and sprinted for the old gate.');
    expect(nodes.find((n) => n.text === 'Ember Blade')?.marks).toEqual(wiki('Ember Blade'));
    // A word changed inside italics stays italic.
    expect(nodes.find((n) => n.text === 'sprinted')?.marks?.[0].type).toBe('italic');
  });

  it('keeps curly quotes the replacement only straightened', () => {
    const before = doc(para(text('“No,” she said quietly.')));
    const after = applied(before, '"No," she said quietly.', '"No," she said loudly.');
    expect(pmToPlainText(after)).toBe('“No,” she said loudly.');
  });

  it('reads Markdown in the replacement', () => {
    const before = doc(para(text('She saw the gate.')));
    const after = applied(before, 'She saw the gate', 'She saw *the* [[Iron Gate|gate]]');
    expect(pmToPlainText(after)).toBe('She saw the gate.');
    const nodes = after.content?.[0].content ?? [];
    expect(nodes.find((n) => n.text === 'the')?.marks?.[0].type).toBe('italic');
    expect(nodes.find((n) => n.text === 'gate')?.marks?.[0]).toEqual(wiki('Iron Gate')[0]);
  });

  it('does not read a plain line as a list when part of a paragraph is replaced', () => {
    const after = applied(doc(para(text('Chapter one begins.'))), 'one begins', '1. begins again');
    expect(after.content).toHaveLength(1);
    expect(after.content?.[0].type).toBe('paragraph');
    expect(pmToPlainText(after)).toContain('1. begins again');
  });

  it('removes the quoted text when the replacement is empty', () => {
    expect(pmToPlainText(applied(doc(para(text('Keep this. Drop this.'))), ' Drop this.', ''))).toBe('Keep this.');
  });

  it('edits several paragraphs in place when the count is the same', () => {
    const before = doc(para(text('First line one.')), para(text('Second line two.')), para(text('Third line three.')));
    const after = applied(before, 'First line one. Second line two.', 'First line 1.\n\nSecond line 2.');
    expect(pmToPlainText(after)).toBe('First line 1.\n\nSecond line 2.\n\nThird line three.');
  });

  it('turns one paragraph into two through the rewrite path', () => {
    const after = applied(doc(para(text('One two three.'))), 'One two three.', 'One.\n\nTwo three.');
    expect(after.content).toHaveLength(2);
    expect(pmToPlainText(after)).toBe('One.\n\nTwo three.');
  });

  it('keeps every attribute of a figure beside an edit', () => {
    const fig = stored(figure('The gate'));
    const before = doc(para(text('Before.')), fig, para(text('After.')));
    const after = applied(before, 'After.', 'Afterwards.');
    expect(after.content?.[1]).toEqual(fig);
    expect(pmToPlainText(after)).toContain('Afterwards.');
  });

  it('can change a caption without touching the rest of its figure', () => {
    const fig = stored(figure('The gate at dawn'));
    const after = applied(doc(fig), 'at dawn', 'at dusk');
    const changed = after.content?.[0];
    expect(changed?.attrs).toEqual(fig.attrs);
    expect(changed?.content?.[0]).toEqual(fig.content?.[0]);
    expect(pmToPlainText(after)).toContain('The gate at dusk');
  });

  it('says a quote that has gone is stale, and leaves nothing changed', () => {
    const result = applyEdit(doc(para(text('Something else now.'))), 'The old words', 'New words');
    expect(result).toHaveProperty('stale');
    expect((result as { stale: string }).stale).toContain('no longer there');
    const repeated = applyEdit(doc(para(text('Same. Same.'))), 'Same.', 'New.');
    expect((repeated as { stale: string }).stale).toContain('more than once');
  });

  it('counts characters outside the basic plane correctly', () => {
    const before = doc(para(text('A \u{1F525} fire burned \u{1F525} on.')));
    const after = applied(before, 'A \u{1F525} fire burned \u{1F525} on.', 'A \u{1F525} flame burned \u{1F525} on and on.');
    expect(pmToPlainText(after)).toBe('A \u{1F525} flame burned \u{1F525} on and on.');
  });

  it('keeps a hard break the replacement leaves alone', () => {
    const before = doc(para(text('Line one'), { type: 'hardBreak' }, text('line two.')));
    const after = applied(before, 'Line one line two.', 'Line one\nline 2.');
    const nodes = after.content?.[0].content ?? [];
    expect(nodes.some((n) => n.type === 'hardBreak')).toBe(true);
    expect(pmToPlainText(after)).toBe('Line one\nline 2.');
  });
});
