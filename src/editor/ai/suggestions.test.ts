import { getSchema } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import { Node as ProseNode } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';

import { documentExtensions } from '../schema';
import { computeHunks, planRewrite } from './hunks';
import { makePlugin, suggestionsKey, type Suggestion } from './suggestions';

const schema = getSchema(documentExtensions());
const source = { kind: 'page' as const, id: 'p', title: 'P' };

function start(text: string): EditorState {
  const doc = ProseNode.fromJSON(schema, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  return EditorState.create({ doc, plugins: [history(), makePlugin(source)] });
}

function suggest(state: EditorState, from: number, to: number, reply: string): EditorState {
  const plan = planRewrite(state.doc, from, to)!;
  const suggestion: Suggestion = {
    id: 's1', label: 'x', from: plan.from, to: plan.to, stale: false, reply, instruction: 'x', checkpointed: true,
    hunks: computeHunks(state.doc, plan, reply),
  };
  return state.apply(state.tr.setMeta(suggestionsKey, { type: 'add', suggestion }).setMeta('addToHistory', false));
}

const plugin = (state: EditorState) => suggestionsKey.getState(state)!;
const only = (state: EditorState) => plugin(state).suggestions[0];
const text = (state: EditorState) => state.doc.textContent;

function find(state: EditorState, needle: string): number {
  return text(state).indexOf(needle) + 1;
}

function acceptFirst(state: EditorState): EditorState {
  const suggestion = only(state);
  const hunk = suggestion.hunks[0];
  const tr = state.tr.replace(hunk.from, hunk.to, hunk.slice);
  tr.setMeta(suggestionsKey, { type: 'accepted', suggestionId: suggestion.id, hunkIds: [hunk.id] });
  return state.apply(tr);
}

const SENTENCE = 'Start here. one two three four five. End here.';
const selected = (state: EditorState) => {
  const from = find(state, 'one');
  return { from, to: find(state, 'five.') + 'five.'.length };
};
const REPLY = 'ONE two three four FIVE.';

describe('a suggestion', () => {
  it('changes nothing in the document', () => {
    const state = start(SENTENCE);
    const { from, to } = selected(state);
    const next = suggest(state, from, to, REPLY);
    expect(next.doc.eq(state.doc)).toBe(true);
    expect(only(next).hunks).toHaveLength(2);
    expect(plugin(next).decorations.find().length).toBeGreaterThan(0);
  });

  it('follows its text when something is typed before it', () => {
    let state = start(SENTENCE);
    const { from, to } = selected(state);
    state = suggest(state, from, to, REPLY);
    const before = only(state).hunks.map((h) => state.doc.textBetween(h.from, h.to));
    state = state.apply(state.tr.insertText('NEW ', 1));
    expect(only(state).stale).toBe(false);
    expect(only(state).hunks.map((h) => state.doc.textBetween(h.from, h.to))).toEqual(before);
    expect(state.doc.textBetween(only(state).from, only(state).to)).toBe('one two three four five.');
  });

  it('follows its text when something after it changes, without going stale', () => {
    let state = start(SENTENCE);
    const { from, to } = selected(state);
    state = suggest(state, from, to, REPLY);
    state = state.apply(state.tr.insertText('!', state.doc.content.size - 1));
    expect(only(state).stale).toBe(false);
  });

  it('is not disturbed by typing right at its edges', () => {
    let state = start(SENTENCE);
    const { from, to } = selected(state);
    state = suggest(state, from, to, REPLY);
    state = state.apply(state.tr.insertText('X', only(state).to));
    expect(only(state).stale).toBe(false);
    state = state.apply(state.tr.insertText('Y', only(state).from));
    expect(only(state).stale).toBe(false);
    expect(state.doc.textBetween(only(state).from, only(state).to)).toBe('one two three four five.');
  });

  it('goes stale when the text inside it is edited, even between its changes', () => {
    let state = start(SENTENCE);
    const { from, to } = selected(state);
    state = suggest(state, from, to, REPLY);
    state = state.apply(state.tr.insertText('X', find(state, 'three')));
    expect(only(state).stale).toBe(true);
    // It stays around to be dismissed, and its changes no longer show.
    expect(only(state).hunks).toHaveLength(2);
    expect(plugin(state).decorations.find().every((d) => (d.spec as { key?: string }).key === undefined)).toBe(true);
  });

  it('goes stale when the text inside it is deleted', () => {
    let state = start(SENTENCE);
    const { from, to } = selected(state);
    state = suggest(state, from, to, REPLY);
    state = state.apply(state.tr.delete(from, from + 3));
    expect(only(state).stale).toBe(true);
  });

  it('goes stale when the whole document is replaced', () => {
    let state = start(SENTENCE);
    const { from, to } = selected(state);
    state = suggest(state, from, to, REPLY);
    const replacement = schema.nodes.paragraph.create(null, schema.text('Different.'));
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, replacement));
    expect(only(state).stale).toBe(true);
  });

  it('goes stale when typing lands right where a pure insertion would go', () => {
    let state = start('Before. After.');
    const at = find(state, ' After');
    const plan = planRewrite(state.doc, 1, at)!;
    const suggestion: Suggestion = {
      id: 's1', label: 'x', from: at, to: at, stale: false, reply: 'x', instruction: 'x', checkpointed: true,
      hunks: computeHunks(state.doc, plan, 'Before. New.').map((h) => ({ ...h, from: at, to: at })),
    };
    state = state.apply(state.tr.setMeta(suggestionsKey, { type: 'add', suggestion }));
    state = state.apply(state.tr.insertText('Z', at));
    expect(only(state).stale).toBe(true);
  });
});

describe('accepting and rejecting', () => {
  it('applies one change, keeps the other pending and correctly placed', () => {
    let state = start(SENTENCE);
    const { from, to } = selected(state);
    state = suggest(state, from, to, REPLY);
    state = acceptFirst(state);
    expect(text(state)).toBe('Start here. ONE two three four five. End here.');
    expect(only(state).stale).toBe(false);
    expect(only(state).hunks).toHaveLength(1);
    const left = only(state).hunks[0];
    expect(state.doc.textBetween(left.from, left.to)).toBe('five');
  });

  it('drops a suggestion when its last change is rejected, leaving the text alone', () => {
    let state = start(SENTENCE);
    const { from, to } = selected(state);
    state = suggest(state, from, to, REPLY);
    const ids = only(state).hunks.map((h) => h.id);
    state = state.apply(state.tr.setMeta(suggestionsKey, { type: 'reject', suggestionId: 's1', hunkIds: ids }));
    expect(plugin(state).suggestions).toHaveLength(0);
    expect(text(state)).toBe(SENTENCE);
    expect(plugin(state).decorations.find()).toHaveLength(0);
  });

  it('undoes an accepted change as one step, leaving the rest still applicable', () => {
    let state = start(SENTENCE);
    const { from, to } = selected(state);
    state = suggest(state, from, to, REPLY);
    state = acceptFirst(state);
    let undone: Transaction | null = null;
    expect(undo(state, (tr) => { undone = tr; })).toBe(true);
    state = state.apply(undone!);
    expect(text(state)).toBe(SENTENCE);
    expect(only(state).stale).toBe(false);
    const left = only(state).hunks[0];
    expect(state.doc.textBetween(left.from, left.to)).toBe('five');
  });

  it('keeps suggesting and undo apart: making a suggestion adds no undo step', () => {
    const state = start(SENTENCE);
    const { from, to } = selected(state);
    const next = suggest(state, from, to, REPLY);
    expect(undo(next)).toBe(false);
  });

  it('a new suggestion replaces an older one over the same text, but not one elsewhere', () => {
    let state = start('Alpha beta. Gamma delta.');
    const firstAt = find(state, 'Alpha');
    state = suggest(state, firstAt, firstAt + 'Alpha beta.'.length, 'Alpha BETA.');
    const secondAt = find(state, 'Gamma');
    const plan = planRewrite(state.doc, secondAt, secondAt + 'Gamma delta.'.length)!;
    const other: Suggestion = {
      id: 's2', label: 'x', from: plan.from, to: plan.to, stale: false, reply: 'x', instruction: 'x', checkpointed: true,
      hunks: computeHunks(state.doc, plan, 'Gamma DELTA.'),
    };
    state = state.apply(state.tr.setMeta(suggestionsKey, { type: 'add', suggestion: other }));
    expect(plugin(state).suggestions.map((s) => s.id)).toEqual(['s1', 's2']);

    const overlap: Suggestion = { ...other, id: 's3', hunks: computeHunks(state.doc, plan, 'GAMMA delta.') };
    state = state.apply(state.tr.setMeta(suggestionsKey, { type: 'add', suggestion: overlap }));
    expect(plugin(state).suggestions.map((s) => s.id)).toEqual(['s1', 's3']);
  });
});

describe('tracked ranges', () => {
  const track = (state: EditorState, from: number, to: number) =>
    state.apply(state.tr.setMeta(suggestionsKey, { type: 'track', item: { id: 't1', from, to, touched: false, visible: false } }));
  const item = (state: EditorState) => plugin(state).tracked[0];

  it('follow their text, and notice an edit inside it', () => {
    let state = start(SENTENCE);
    const { from, to } = selected(state);
    state = track(state, from, to);
    state = state.apply(state.tr.insertText('NEW ', 1));
    expect(state.doc.textBetween(item(state).from, item(state).to)).toBe('one two three four five.');
    expect(item(state).touched).toBe(false);
    state = state.apply(state.tr.insertText('X', item(state).from + 2));
    expect(item(state).touched).toBe(true);
  });

  it('can be reset, for when the text is read afresh', () => {
    let state = start(SENTENCE);
    const { from, to } = selected(state);
    state = track(state, from, to);
    state = state.apply(state.tr.insertText('X', from + 2));
    expect(item(state).touched).toBe(true);
    state = state.apply(state.tr.setMeta(suggestionsKey, { type: 'freshRead', id: 't1' }));
    expect(item(state).touched).toBe(false);
  });
});
