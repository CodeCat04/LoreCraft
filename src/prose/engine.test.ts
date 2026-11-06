import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import { documentExtensions } from '../editor/schema';
import type { PmNode } from '../lib/types';
import { ProseEngine } from './engine';
import { ProseHighlights, proseKey } from './highlights';
import { rangesToRead } from './readAloud';

const schema = getSchema(documentExtensions());

const doc = (...texts: string[]): PmNode => ({
  type: 'doc',
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

describe('ProseEngine', () => {
  const filler = Array.from({ length: 1500 }, (_, i) => `filler${i}`).join(' ');

  it('reports on the scenes in scope and compares with the rest', () => {
    const engine = new ProseEngine();
    engine.setScene('a', doc('Ember ember ember ember ember glows here. She felt it.'));
    engine.setScene('b', doc(`${filler}.`));
    const report = engine.analyze({ scope: ['a'], rest: ['b'], names: [] });
    expect(report.overused.map((t) => t.text)).toContain('ember');
    expect(report.matches.filter.map((m) => m.scene)).toEqual(['a']);
    expect(report.overused.find((t) => t.text === 'ember')?.restPerThousand).toBe(0);
  });

  it('reads several scenes in the order asked for', () => {
    const engine = new ProseEngine();
    engine.setScene('a', doc('She felt it.'));
    engine.setScene('b', doc('He saw it.'));
    const report = engine.analyze({ scope: ['b', 'a'], rest: [], names: [] });
    expect(report.matches.filter.map((m) => m.text)).toEqual(['saw', 'felt']);
    expect(report.paragraphs).toBe(2);
  });

  it('picks up a changed scene, for the scope and for the rest', () => {
    const engine = new ProseEngine();
    engine.setScene('a', doc('She felt it.'));
    engine.setScene('b', doc(`${filler} ember.`));
    expect(engine.analyze({ scope: ['a'], rest: ['b'], names: [] }).matches.filter.length).toBe(1);
    engine.setScene('a', doc('She felt it, and saw it.'));
    expect(engine.analyze({ scope: ['a'], rest: ['b'], names: [] }).matches.filter.length).toBe(2);

    const scope = 'Ember ember ember ember ember glows here.';
    engine.setScene('a', doc(scope));
    const rare = engine.analyze({ scope: ['a'], rest: ['b'], names: [] });
    expect(rare.overused.map((t) => t.text)).toContain('ember');
    // The same word now turns up everywhere else too, so it is not overused here.
    const common = Array.from({ length: 800 }, (_, i) => `ember filler${i}`).join(' ');
    engine.setScene('b', doc(`${common}.`));
    const usual = engine.analyze({ scope: ['a'], rest: ['b'], names: [] });
    expect(usual.overused.map((t) => t.text)).not.toContain('ember');
  });

  it('ignores scenes it has not read or has been told to forget', () => {
    const engine = new ProseEngine();
    engine.setScene('a', doc('She felt it.'));
    expect(engine.analyze({ scope: ['a', 'nope'], rest: ['also nope'], names: [] }).words).toBe(3);
    engine.forget('a');
    expect(engine.analyze({ scope: ['a'], rest: [], names: [] }).words).toBe(0);
  });
});

describe('rangesToRead', () => {
  const content = doc('First one here. Second one here.', 'Third one here.');
  const real = schema.nodeFromJSON(content);
  const read = (from: number, to: number, hasSelection: boolean) =>
    rangesToRead(content, from, to, hasSelection).map((r) => real.textBetween(r.from, r.to, ' '));

  it('reads from the top of the sentence the cursor is in', () => {
    // A cursor in "Second", with the rest of the document after it.
    expect(read(20, real.content.size + 1, false)).toEqual(['Second one here.', 'Third one here.']);
  });

  it('reads everything from the start', () => {
    expect(read(1, real.content.size + 1, false)).toEqual(['First one here.', 'Second one here.', 'Third one here.']);
  });

  it('reads only what is selected, stopping where the selection does', () => {
    expect(read(7, 21, true)).toEqual(['one here.', 'Seco']);
  });

  it('finds nothing to read in an empty document', () => {
    expect(rangesToRead({ type: 'doc', content: [{ type: 'paragraph' }] }, 1, 3, false)).toEqual([]);
  });
});

describe('the highlight plugin', () => {
  function stateOf(json: PmNode) {
    return EditorState.create({ schema, doc: schema.nodeFromJSON(json), plugins: pluginsOf() });
  }
  function pluginsOf() {
    const config = (ProseHighlights as unknown as { config: { addProseMirrorPlugins: () => EditorState['plugins'] } }).config;
    return [...config.addProseMirrorPlugins.call({})];
  }

  it('shows only the checks that are on, and leaves the document alone', () => {
    const state = stateOf(doc('She felt the cold.'));
    const matches = [
      { check: 'filter' as const, from: 5, to: 9, text: 'felt' },
      { check: 'adverb' as const, from: 10, to: 13, text: 'the' },
    ];
    const tr = state.tr.setMeta(proseKey, { matches, enabled: new Set(['filter']) });
    const next = state.apply(tr);
    expect(next.doc.eq(state.doc)).toBe(true);
    expect(tr.docChanged).toBe(false);
    const found = proseKey.getState(next)?.decorations.find() ?? [];
    expect(found.map((d) => [d.from, d.to])).toEqual([[5, 9]]);
  });

  it('carries highlights along with edits, and drops what no longer fits', () => {
    const state = stateOf(doc('She felt the cold.'));
    const matches = [{ check: 'filter' as const, from: 5, to: 9, text: 'felt' }];
    const shown = state.apply(state.tr.setMeta(proseKey, { matches, enabled: new Set(['filter']), current: { from: 5, to: 9 } }));
    const moved = shown.apply(shown.tr.insertText('Well, ', 1));
    const after = proseKey.getState(moved);
    expect(after?.decorations.find().map((d) => [d.from, d.to])).toContainEqual([11, 15]);
    expect(after?.matches[0]).toMatchObject({ from: 11, to: 15 });
    expect(after?.current).toEqual({ from: 11, to: 15 });

    const far = moved.apply(moved.tr.setMeta(proseKey, { matches: [{ check: 'filter', from: 900, to: 910, text: 'x' }] }));
    expect(proseKey.getState(far)?.decorations.find().map((d) => [d.from, d.to])).toEqual([[11, 15]]);
  });
});
