import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { Decoration } from '@tiptap/pm/view';
import { describe, expect, it, vi } from 'vitest';

import { documentExtensions } from '../editor/schema';
import type { PmNode, TitleEntry } from '../lib/types';
import { NameMatcher } from './nameMatcher';
import { nameHighlightKey, nameHighlightPlugin } from './nameHighlight';

// The plugin only needs this to follow a link, which these tests do not do.
vi.mock('../editor/RichEditor', () => ({ followWikiLink: vi.fn() }));

const schema = getSchema(documentExtensions());

function entry(title: string, aliases: string[] = []): TitleEntry {
  return { id: title, title, pageType: 'character', status: 'canon', summary: '', aliases };
}

const NAMES = new NameMatcher([entry('Aria Vale', ['Aria']), entry('Silver Keep'), entry('Mira')]);

function text(t: string, marks?: PmNode['marks']): PmNode {
  return marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
}

function para(...content: PmNode[]): PmNode {
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function stateOf(content: PmNode[], matcher: NameMatcher | null = NAMES) {
  const doc = schema.nodeFromJSON({ type: 'doc', content });
  return EditorState.create({ doc, plugins: [nameHighlightPlugin(() => matcher)] });
}

function marks(state: EditorState) {
  const set = nameHighlightKey.getState(state)!.decorations;
  return set
    .find()
    .map((d: Decoration) => ({
      text: state.doc.textBetween(d.from, d.to),
      target: (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs['data-wiki-target'],
      from: d.from,
      to: d.to,
    }))
    .sort((a, b) => a.from - b.from);
}

function fresh(state: EditorState, matcher: NameMatcher | null = NAMES) {
  return marks(stateOf(state.doc.toJSON().content as PmNode[], matcher));
}

describe('name highlighting', () => {
  it('marks titles and aliases with the page title as the target', () => {
    const state = stateOf([para(text('Aria rode to Silver Keep. Aria Vale slept.'))]);
    expect(marks(state).map((m) => [m.text, m.target])).toEqual([
      ['Aria', 'Aria Vale'],
      ['Silver Keep', 'Silver Keep'],
      ['Aria Vale', 'Aria Vale'],
    ]);
  });

  it('finds names across marks, in headings, lists and quotes', () => {
    const state = stateOf([
      { type: 'heading', attrs: { level: 2 }, content: [text('Mira returns')] },
      para(text('At Silver '), text('Keep', [{ type: 'italic' }]), text(' they met.')),
      { type: 'blockquote', content: [para(text('Said Mira.'))] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('Aria'))] }] },
    ]);
    expect(marks(state).map((m) => m.text)).toEqual(['Mira', 'Silver Keep', 'Mira', 'Aria']);
  });

  it('leaves names the author already linked', () => {
    const link = [{ type: 'wikiLink', attrs: { target: 'Aria Vale' } }];
    const state = stateOf([para(text('Mira saw '), text('Aria', link), text(' and Aria.'))]);
    expect(marks(state).map((m) => m.text)).toEqual(['Mira', 'Aria']);
    expect(marks(state)[1].from).toBeGreaterThan(state.doc.textContent.indexOf('and'));
  });

  it('keeps positions right around line breaks and references', () => {
    const state = stateOf([
      para(text('Mira'), { type: 'hardBreak' }, text('Aria'), { type: 'reference', attrs: { text: 'x' } }, text(' Mira')),
    ]);
    expect(marks(state).map((m) => m.text)).toEqual(['Mira', 'Aria', 'Mira']);
  });

  it('does nothing while off', () => {
    const state = stateOf([para(text('Aria'))], null);
    expect(marks(state)).toEqual([]);
  });
});

/** A small seeded generator, so a failure can be reproduced. */
function random(seed: number) {
  let state = seed;
  return (limit: number) => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return Math.floor((state / 4294967296) * limit);
  };
}

const SNIPPETS = ['Aria', ' Vale', 'Silver', ' Keep', 'Mira', ' the ', 'x', '.', ' ', 'Ariadne', 'é'];

function randomEdit(state: EditorState, next: (limit: number) => number): Transaction {
  const size = state.doc.content.size;
  const tr = state.tr;
  const positions = () => {
    const a = TextSelection.near(state.doc.resolve(next(size + 1))).from;
    const b = TextSelection.near(state.doc.resolve(next(size + 1))).from;
    return a < b ? [a, b] : [b, a];
  };
  switch (next(9)) {
    case 7: {
      // Structure changes move text without changing it.
      const [at] = positions();
      const $at = state.doc.resolve(at);
      if ($at.parent.isTextblock && $at.depth === 1) {
        const range = $at.blockRange();
        if (range) tr.wrap(range, [{ type: schema.nodes.blockquote }]);
      }
      break;
    }
    case 8: {
      const [from, to] = positions();
      tr.setBlockType(from, to, schema.nodes.heading, { level: 2 });
      break;
    }
    case 0: {
      const [at] = positions();
      tr.insertText(SNIPPETS[next(SNIPPETS.length)], at);
      break;
    }
    case 1: {
      const [from, to] = positions();
      if (to - from < 30 && state.doc.resolve(from).sameParent(state.doc.resolve(to))) tr.delete(from, to);
      break;
    }
    case 2: {
      const [at] = positions();
      if (state.doc.resolve(at).parent.isTextblock) tr.split(at);
      break;
    }
    case 3: {
      const [from, to] = positions();
      if (from < to) tr.addMark(from, to, schema.marks.bold.create());
      break;
    }
    case 4: {
      const [from, to] = positions();
      if (from < to && state.doc.resolve(from).sameParent(state.doc.resolve(to))) {
        tr.addMark(from, to, schema.marks.wikiLink.create({ target: 'Aria Vale' }));
      }
      break;
    }
    case 5: {
      const [from, to] = positions();
      if (from < to) tr.removeMark(from, to, schema.marks.wikiLink);
      break;
    }
    case 6: {
      // Two steps in one transaction, as a paste over a selection is.
      const [from, to] = positions();
      if (state.doc.resolve(from).sameParent(state.doc.resolve(to))) {
        tr.insertText(SNIPPETS[next(SNIPPETS.length)], from, to);
        tr.insertText(SNIPPETS[next(SNIPPETS.length)], tr.mapping.map(to));
      }
      break;
    }
  }
  return tr;
}

describe('incremental updates', () => {
  it('always matches a full scan, through hundreds of random edits', () => {
    for (const seed of [1, 7, 42, 1234, 99999]) {
      const next = random(seed);
      let state = stateOf([
        para(text('Aria rode to Silver Keep.')),
        para(text('Mira and Aria Vale.')),
        para(),
        { type: 'blockquote', content: [para(text('Said Mira.'))] },
      ]);
      for (let i = 0; i < 300; i += 1) {
        state = state.apply(randomEdit(state, next));
        expect(marks(state), `seed ${seed}, edit ${i}`).toEqual(fresh(state));
      }
    }
  });

  it('notices a name being completed, broken and rejoined', () => {
    let state = stateOf([para(text('Ari'))]);
    expect(marks(state)).toEqual([]);
    state = state.apply(state.tr.insertText('a', 4));
    expect(marks(state).map((m) => m.text)).toEqual(['Aria']);
    state = state.apply(state.tr.insertText('d', 5));
    expect(marks(state)).toEqual([]);
    state = state.apply(state.tr.delete(5, 6));
    expect(marks(state).map((m) => m.text)).toEqual(['Aria']);
  });

  it('rescans when paragraphs split and join', () => {
    let state = stateOf([para(text('Silver Keep'))]);
    state = state.apply(state.tr.split(8));
    expect(marks(state)).toEqual([]);
    state = state.apply(state.tr.join(9));
    expect(marks(state).map((m) => m.text)).toEqual(['Silver Keep']);
  });

  it('notices a wiki link being added and removed', () => {
    let state = stateOf([para(text('Aria slept'))]);
    const link = schema.marks.wikiLink.create({ target: 'Aria Vale' });
    state = state.apply(state.tr.addMark(1, 5, link));
    expect(marks(state)).toEqual([]);
    state = state.apply(state.tr.removeMark(1, 5, schema.marks.wikiLink));
    expect(marks(state).map((m) => m.text)).toEqual(['Aria']);
  });

  it('leaves the decorations of untouched blocks alone', () => {
    const state = stateOf([para(text('Aria')), para(text('Mira'))]);
    const before = nameHighlightKey.getState(state)!.decorations.find(7, 11)[0];
    const after = state.apply(state.tr.insertText('x', 5));
    const second = nameHighlightKey.getState(after)!.decorations.find(8, 12)[0];
    // Mapped, not rebuilt, so the view has nothing to redraw there.
    expect((second as unknown as { type: unknown }).type).toBe((before as unknown as { type: unknown }).type);
  });

  it('rebuilds when told the names changed, and clears when turned off', () => {
    let state = stateOf([para(text('Aria met Zed Zed'))]);
    const names = new NameMatcher([entry('Zed')]);
    state = state.apply(state.tr.setMeta(nameHighlightKey, { matcher: names }));
    expect(marks(state).map((m) => m.text)).toEqual(['Zed', 'Zed']);
    state = state.apply(state.tr.setMeta(nameHighlightKey, { matcher: null }));
    expect(marks(state)).toEqual([]);
    // Edits while off do no work and find nothing.
    state = state.apply(state.tr.insertText('Zed ', 1));
    expect(marks(state)).toEqual([]);
  });

  it('stays quick on a 20,000-word scene', () => {
    const line = 'Aria rode out past Silver Keep before the rain came down on Mira and the others, and nobody spoke of it again';
    const content = Array.from({ length: 800 }, () => para(text(`${line}, not that night or any other time afterwards.`)));
    let state = stateOf(content);
    expect(state.doc.textContent.split(/\s+/).length).toBeGreaterThan(20000);

    const start = performance.now();
    const edits = 200;
    for (let i = 0; i < edits; i += 1) state = state.apply(state.tr.insertText('x', 200 + i));
    const each = (performance.now() - start) / edits;
    expect(marks(state).length).toBe(fresh(state).length);
    expect(each).toBeLessThan(5);
  });

  it('copes with pasting a whole scene at once', () => {
    const line = 'Aria rode out past Silver Keep before the rain came down on Mira and the others';
    const content = Array.from({ length: 800 }, () => para(text(line)));
    const state = stateOf([para(text('Short.'))]);
    const pasted = schema.nodeFromJSON({ type: 'doc', content }).content;
    const start = performance.now();
    const next = state.apply(state.tr.replaceWith(0, state.doc.content.size, pasted));
    const elapsed = performance.now() - start;
    expect(marks(next).length).toBe(2400);
    expect(elapsed).toBeLessThan(250);
  });
});
