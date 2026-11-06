import { getSchema } from '@tiptap/core';
import { DOMParser as PmDOMParser, DOMSerializer, type Node as ProseNode } from '@tiptap/pm/model';
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Command,
  type Transaction,
} from '@tiptap/pm/state';

import { pmToPlainText, describeFigures } from '../convert';
import { documentExtensions } from '../schema';
import type { PmNode } from '../../lib/types';
import {
  addLabel,
  captionEnd,
  captionStart,
  clampWidth,
  createFigure,
  createTable,
  deleteFigureTr,
  enterCaption,
  figureAround,
  figureInsteadOfMediaTr,
  guardCaptionBackspace,
  guardCaptionDelete,
  insertFigureTr,
  labelHint,
  leaveCaption,
  MIN_FIGURE_WIDTH,
  nearestFigurePos,
  removeHollowFiguresTr,
  removeLabel,
  selectedFigure,
  selectFigureFromCaption,
  setFigureAttrs,
  typeIntoCaption,
} from './commands';

const schema = getSchema(documentExtensions());

const para = (text?: string): PmNode =>
  text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' };

function picture(label?: string, assetId = 'a1'): PmNode {
  return {
    type: 'figure',
    attrs: { kind: 'picture', align: 'right', width: null, description: '' },
    content: [
      { type: 'image', attrs: { assetId } },
      label ? { type: 'figcaption', content: [{ type: 'text', text: label }] } : { type: 'figcaption' },
    ],
  };
}

function tableJson(): PmNode {
  const cell = (type: string, text: string): PmNode => ({ type, content: [para(text)] });
  return {
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('tableHeader', 'A'), cell('tableHeader', 'B')] },
      { type: 'tableRow', content: [cell('tableCell', 'one'), cell('tableCell', 'two')] },
    ],
  };
}

function docOf(...content: PmNode[]): ProseNode {
  const doc = schema.nodeFromJSON({ type: 'doc', content });
  doc.check();
  return doc;
}

/** The position inside the first node of a type, plus an offset. */
function posIn(doc: ProseNode, type: string, offset = 0): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === type) found = pos + 1 + offset;
    return found < 0;
  });
  if (found < 0) throw new Error(`No ${type}`);
  return found;
}

function stateAt(doc: ProseNode, pos: number): EditorState {
  return EditorState.create({ schema, doc, selection: TextSelection.create(doc, pos) });
}

/** Runs a command. Returns whether it applied, and the state after. */
function run(state: EditorState, command: Command) {
  let tr: Transaction | undefined;
  const applied = command(state, (t) => {
    tr = t;
  });
  const after = tr ? state.apply(tr) : state;
  after.doc.check();
  return { applied, after };
}

const types = (doc: ProseNode) => doc.content.content.map((n) => n.type.name);

describe('labelHint', () => {
  it('asks for a label by what it is, and says why', () => {
    expect(labelHint('picture')).toBe('Label this picture so the AI knows what it shows');
    expect(labelHint('table')).toBe('Label this table so the AI knows what it shows');
    expect(labelHint('video')).toBe('Label this video so the AI knows what it shows');
    expect(labelHint('figure')).toBe('Label this figure so the AI knows what it shows');
    expect(labelHint('something else')).toBe('Label this figure so the AI knows what it shows');
  });
});

describe('nearestFigurePos', () => {
  const doc = docOf(para('First paragraph here'), para('Second one'));
  const firstEnd = doc.child(0).nodeSize;

  it('never splits a paragraph: it goes to the nearer boundary', () => {
    expect(nearestFigurePos(doc, 2)).toBe(0);
    expect(nearestFigurePos(doc, firstEnd - 2)).toBe(firstEnd);
    expect(nearestFigurePos(doc, firstEnd + 2)).toBe(firstEnd);
    expect(nearestFigurePos(doc, doc.content.size - 1)).toBe(doc.content.size);
  });

  it('keeps a position that is already between blocks', () => {
    expect(nearestFigurePos(doc, 0)).toBe(0);
    expect(nearestFigurePos(doc, firstEnd)).toBe(firstEnd);
    expect(nearestFigurePos(doc, doc.content.size)).toBe(doc.content.size);
  });

  it('copes with positions out of range', () => {
    expect(nearestFigurePos(doc, -5)).toBe(0);
    expect(nearestFigurePos(doc, 99999)).toBe(doc.content.size);
  });

  it('moves out of a figure, since figures do not nest', () => {
    const withFigure = docOf(para('Before'), picture('Label'), para('After'));
    const before = withFigure.child(0).nodeSize;
    const after = before + withFigure.child(1).nodeSize;
    const inCaption = posIn(withFigure, 'figcaption', 4);
    expect(nearestFigurePos(withFigure, inCaption)).toBe(after);
    expect(nearestFigurePos(withFigure, before + 1)).toBe(before);

    const tableFigure = docOf({
      type: 'figure',
      attrs: { kind: 'table', align: 'full' },
      content: [tableJson(), { type: 'figcaption' }],
    });
    const inCell = posIn(tableFigure, 'tableCell', 1);
    expect([0, tableFigure.child(0).nodeSize]).toContain(nearestFigurePos(tableFigure, inCell));
  });

  it('stays in a container that can hold a figure', () => {
    const quote = docOf({ type: 'blockquote', content: [para('Inside the quote')] });
    expect(nearestFigurePos(quote, 3)).toBe(1);
    const table = docOf(tableJson());
    const cellText = posIn(table, 'tableCell', 2);
    const placed = nearestFigurePos(table, cellText);
    const $placed = table.resolve(placed);
    expect($placed.parent.type.name).toBe('tableCell');
  });

  it('respects a list item having to start with a paragraph', () => {
    const list = docOf({
      type: 'bulletList',
      content: [{ type: 'listItem', content: [para('Item text here')] }],
    });
    const nearStart = posIn(list, 'paragraph', 1);
    const placed = nearestFigurePos(list, nearStart);
    const tr = EditorState.create({ schema, doc: list }).tr.insert(
      placed,
      createFigure(schema, { kind: 'picture', media: { type: 'image', attrs: { assetId: 'x' } } }),
    );
    tr.doc.check();
  });
});

describe('createFigure and insertFigureTr', () => {
  it('makes figures the schema accepts, in every kind', () => {
    createFigure(schema, { kind: 'picture', media: { type: 'image', attrs: { assetId: 'a' } } }).check();
    createFigure(schema, { kind: 'video', media: { type: 'video', attrs: { assetId: 'a' } } }).check();
    createFigure(schema, { kind: 'video', media: { type: 'video', attrs: { url: 'https://youtu.be/a' } } }).check();
    createFigure(schema, { kind: 'table', align: 'full', media: { type: 'table', node: createTable(schema) } }).check();
  });

  it('defaults to wrapping on the right with no stored width', () => {
    const figure = createFigure(schema, { kind: 'picture', media: { type: 'image', attrs: { assetId: 'a' } }, caption: 'Hi' });
    expect(figure.attrs).toEqual({ kind: 'picture', align: 'right', width: null, description: '' });
    expect(figure.lastChild?.textContent).toBe('Hi');
  });

  it('makes a table with a header row of the size asked for', () => {
    const table = createTable(schema, 4, 2);
    expect(table.childCount).toBe(4);
    expect(table.child(0).child(0).type.name).toBe('tableHeader');
    expect(table.child(1).child(0).type.name).toBe('tableCell');
    expect(table.child(3).childCount).toBe(2);
  });

  it('puts the cursor in the label when asked', () => {
    const doc = docOf(para('Text'));
    const state = EditorState.create({ schema, doc });
    const figure = createFigure(schema, { kind: 'picture', media: { type: 'image', attrs: { assetId: 'a' } } });
    const after = state.apply(insertFigureTr(state.tr, 0, figure, true));
    after.doc.check();
    expect(types(after.doc)).toEqual(['figure', 'paragraph']);
    expect(after.selection.$from.parent.type.name).toBe('figcaption');

    const quiet = state.apply(insertFigureTr(state.tr, 0, figure, false));
    expect(quiet.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('finds the start and end of a label', () => {
    const doc = docOf(picture('Label'));
    const figure = doc.child(0);
    const start = captionStart(figure, 0);
    expect(doc.resolve(start).parent.type.name).toBe('figcaption');
    expect(doc.resolve(start).parentOffset).toBe(0);
    expect(doc.resolve(captionEnd(figure, 0)).parentOffset).toBe(5);
  });

  it('is numbered by the converters, never in the stored attributes', () => {
    const json = docOf(picture('One'), picture('Two', 'a2')).toJSON() as PmNode;
    expect(JSON.stringify(json)).not.toMatch(/number|Picture 1/);
    expect(describeFigures(json).map((f) => f.name)).toEqual(['Picture 1', 'Picture 2']);
    expect(pmToPlainText(json)).toContain('[Picture 2: Two]');
  });
});

describe('setFigureAttrs', () => {
  const apply = (attrs: Record<string, unknown>) => {
    const doc = docOf(picture('L'));
    const state = EditorState.create({ schema, doc });
    return state.apply(setFigureAttrs(state.tr, 0, attrs)).doc.child(0).attrs;
  };

  it('changes attributes as one undoable transaction', () => {
    expect(apply({ align: 'left' }).align).toBe('left');
    expect(apply({ kind: 'figure' }).kind).toBe('figure');
    expect(apply({ description: 'More' }).description).toBe('More');
  });

  it('keeps the width within its limits', () => {
    expect(apply({ width: 1 }).width).toBe(MIN_FIGURE_WIDTH);
    expect(apply({ width: 500 }).width).toBe(100);
    expect(apply({ width: 33.333 }).width).toBe(33.3);
    expect(clampWidth(50)).toBe(50);
  });

  it('forgets the width at full width, which has no use for one', () => {
    expect(apply({ align: 'full' }).width).toBeNull();
    expect(apply({ align: 'full', width: 40 }).width).toBeNull();
  });

  it('deletes a figure whole', () => {
    const doc = docOf(para('a'), picture('L'), para('b'));
    const state = EditorState.create({ schema, doc });
    const after = state.apply(deleteFigureTr(state.tr, doc.child(0).nodeSize)).doc;
    expect(types(after)).toEqual(['paragraph', 'paragraph']);
  });
});

describe('the keys in a label', () => {
  describe('Enter', () => {
    it('goes to the start of the paragraph after, without changing the text', () => {
      const doc = docOf(picture('Label'), para('After'));
      const { applied, after } = run(stateAt(doc, posIn(doc, 'figcaption', 2)), leaveCaption);
      expect(applied).toBe(true);
      expect(after.doc.eq(doc)).toBe(true);
      expect(after.selection.$from.parent.textContent).toBe('After');
      expect(after.selection.$from.parentOffset).toBe(0);
    });

    it('makes a paragraph when the figure is last', () => {
      const doc = docOf(picture('Label'));
      const { after } = run(stateAt(doc, posIn(doc, 'figcaption')), leaveCaption);
      expect(types(after.doc)).toEqual(['figure', 'paragraph']);
      expect(after.selection.$from.parent.type.name).toBe('paragraph');
    });

    it('makes a paragraph when what follows is not one', () => {
      const doc = docOf(picture('Label'), { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] });
      const { after } = run(stateAt(doc, posIn(doc, 'figcaption')), leaveCaption);
      expect(types(after.doc)).toEqual(['figure', 'paragraph', 'heading']);
      expect(after.selection.$from.parent.type.name).toBe('paragraph');
    });

    it('works inside a container', () => {
      const doc = docOf({ type: 'blockquote', content: [picture('Label')] });
      const { after } = run(stateAt(doc, posIn(doc, 'figcaption')), leaveCaption);
      expect(after.doc.child(0).childCount).toBe(2);
      expect(after.selection.$from.parent.type.name).toBe('paragraph');
      expect(after.selection.$from.node(1).type.name).toBe('blockquote');
    });

    it('leaves other text alone', () => {
      const doc = docOf(para('Text'));
      expect(run(stateAt(doc, 2), leaveCaption).applied).toBe(false);
    });
  });

  describe('Backspace and Delete', () => {
    it('Backspace at the start does nothing, and says it handled the key', () => {
      for (const doc of [docOf(picture()), docOf(picture('Label'))]) {
        const { applied, after } = run(stateAt(doc, posIn(doc, 'figcaption')), guardCaptionBackspace);
        expect(applied).toBe(true);
        expect(after.doc.eq(doc)).toBe(true);
      }
    });

    it('Backspace elsewhere in a label is left to the editor', () => {
      const doc = docOf(picture('Label'));
      expect(run(stateAt(doc, posIn(doc, 'figcaption', 3)), guardCaptionBackspace).applied).toBe(false);
      const start = posIn(doc, 'figcaption');
      const selected = EditorState.create({ schema, doc, selection: TextSelection.create(doc, start, start + 3) });
      expect(run(selected, guardCaptionBackspace).applied).toBe(false);
    });

    it('Backspace in ordinary text is left to the editor', () => {
      const doc = docOf(para('Text'));
      expect(run(stateAt(doc, 1), guardCaptionBackspace).applied).toBe(false);
    });

    it('Delete at the end does nothing', () => {
      const doc = docOf(picture('Label'), para('After'));
      const end = posIn(doc, 'figcaption', 5);
      expect(run(stateAt(doc, end), guardCaptionDelete).applied).toBe(true);
      expect(run(stateAt(doc, end - 1), guardCaptionDelete).applied).toBe(false);
    });
  });

  describe('Escape and Enter on the figure', () => {
    it('Escape selects the figure, and Enter goes back to the end of the label', () => {
      const doc = docOf(para('a'), picture('Label'));
      const escaped = run(stateAt(doc, posIn(doc, 'figcaption', 2)), selectFigureFromCaption);
      expect(escaped.applied).toBe(true);
      expect((escaped.after.selection as NodeSelection).node.type.name).toBe('figure');

      const entered = run(escaped.after, enterCaption);
      expect(entered.applied).toBe(true);
      expect(entered.after.selection.$from.parent.type.name).toBe('figcaption');
      expect(entered.after.selection.$from.parentOffset).toBe(5);
    });

    it('neither does anything elsewhere', () => {
      const doc = docOf(para('a'));
      expect(run(stateAt(doc, 1), selectFigureFromCaption).applied).toBe(false);
      expect(run(stateAt(doc, 1), enterCaption).applied).toBe(false);
    });
  });

  describe('typing on a selected figure', () => {
    it('adds to the label rather than replacing the figure', () => {
      const doc = docOf(picture('Label'));
      const state = EditorState.create({ schema, doc, selection: NodeSelection.create(doc, 0) });
      const tr = typeIntoCaption(state, '!');
      const after = state.apply(tr!);
      expect(after.doc.child(0).type.name).toBe('figure');
      expect(after.doc.child(0).lastChild?.textContent).toBe('Label!');
      expect(after.selection.$from.parent.type.name).toBe('figcaption');
    });

    it('stays out of the way otherwise', () => {
      const doc = docOf(para('a'));
      expect(typeIntoCaption(stateAt(doc, 1), 'x')).toBeNull();
    });
  });
});

describe('Add a label and Remove label', () => {
  it('wraps a table the cursor is in, and starts labeling', () => {
    const doc = docOf(para('a'), tableJson());
    const { applied, after } = run(stateAt(doc, posIn(doc, 'tableCell', 1)), addLabel);
    expect(applied).toBe(true);
    expect(types(after.doc)).toEqual(['paragraph', 'figure']);
    const figure = after.doc.child(1);
    expect(figure.attrs.kind).toBe('table');
    expect(figure.attrs.align).toBe('full');
    expect(figure.firstChild?.eq(doc.child(1))).toBe(true);
    expect(after.selection.$from.parent.type.name).toBe('figcaption');
  });

  it('wraps a selected bare picture or video too', () => {
    const image = docOf({ type: 'image', attrs: { assetId: 'a' } });
    const state = EditorState.create({ schema, doc: image, selection: NodeSelection.create(image, 0) });
    const wrapped = run(state, addLabel).after.doc.child(0);
    expect(wrapped.attrs.kind).toBe('picture');
    expect(wrapped.attrs.align).toBe('right');

    const video = docOf({ type: 'video', attrs: { assetId: 'a' } });
    const videoState = EditorState.create({ schema, doc: video, selection: NodeSelection.create(video, 0) });
    expect(run(videoState, addLabel).after.doc.child(0).attrs.kind).toBe('video');
  });

  it('does not apply where there is nothing to label', () => {
    const doc = docOf(para('a'), picture('L'));
    expect(run(stateAt(doc, 1), addLabel).applied).toBe(false);
    expect(run(stateAt(doc, posIn(doc, 'figcaption')), addLabel).applied).toBe(false);
  });

  it('does not wrap a table already in a figure', () => {
    const doc = docOf({ type: 'figure', attrs: { kind: 'table' }, content: [tableJson(), { type: 'figcaption' }] });
    expect(run(stateAt(doc, posIn(doc, 'tableCell', 1)), addLabel).applied).toBe(false);
  });

  it('unwraps a table from its figure, from the label, a cell or the selected figure', () => {
    const doc = docOf(para('a'), {
      type: 'figure',
      attrs: { kind: 'table', align: 'full' },
      content: [tableJson(), { type: 'figcaption', content: [{ type: 'text', text: 'L' }] }],
    });
    const check = (state: EditorState) => {
      const { applied, after } = run(state, removeLabel);
      expect(applied).toBe(true);
      expect(types(after.doc)).toEqual(['paragraph', 'table']);
      expect(after.doc.child(1).eq(doc.child(1).firstChild!)).toBe(true);
    };
    check(stateAt(doc, posIn(doc, 'figcaption')));
    check(stateAt(doc, posIn(doc, 'tableCell', 1)));
    check(EditorState.create({ schema, doc, selection: NodeSelection.create(doc, doc.child(0).nodeSize) }));
  });

  it('Remove label applies only to tables', () => {
    const doc = docOf(picture('L'));
    expect(run(stateAt(doc, posIn(doc, 'figcaption')), removeLabel).applied).toBe(false);
    expect(run(stateAt(docOf(para('a')), 1), removeLabel).applied).toBe(false);
  });

  it('round trips: add then remove gives back the table', () => {
    const doc = docOf(tableJson(), para());
    const added = run(stateAt(doc, posIn(doc, 'tableCell', 1)), addLabel).after;
    const removed = run(added, removeLabel).after;
    expect(removed.doc.eq(doc)).toBe(true);
  });
});

describe('selection and damage control', () => {
  it('finds the figure around a position and under the selection', () => {
    const doc = docOf(para('a'), picture('L'));
    const pos = doc.child(0).nodeSize;
    expect(figureAround(doc.resolve(posIn(doc, 'figcaption')))?.pos).toBe(pos);
    expect(figureAround(doc.resolve(1))).toBeNull();
    expect(selectedFigure(stateAt(doc, posIn(doc, 'figcaption')))?.pos).toBe(pos);
    expect(selectedFigure(EditorState.create({ schema, doc, selection: NodeSelection.create(doc, pos) }))?.pos).toBe(pos);
    expect(selectedFigure(stateAt(doc, 1))).toBeNull();
  });

  it('turns a selected picture inside a figure into the figure', () => {
    const doc = docOf(picture('L'));
    const state = EditorState.create({ schema, doc, selection: NodeSelection.create(doc, 1) });
    const tr = figureInsteadOfMediaTr(state);
    expect(tr).not.toBeNull();
    const after = state.apply(tr!);
    expect((after.selection as NodeSelection).node.type.name).toBe('figure');
    expect(tr!.getMeta('addToHistory')).toBe(false);
  });

  it('leaves a bare picture selectable', () => {
    const doc = docOf({ type: 'image', attrs: { assetId: 'a' } });
    const state = EditorState.create({ schema, doc, selection: NodeSelection.create(doc, 0) });
    expect(figureInsteadOfMediaTr(state)).toBeNull();
  });

  it('removes a figure that a deletion has hollowed out', () => {
    // A selection from the paragraph into the label takes the picture with it, and
    // ProseMirror fills the required slot with an empty image.
    const doc = docOf(para('Before'), picture('Label'), para('After'));
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 3, posIn(doc, 'figcaption', 2)) });
    const after = state.apply(state.tr.deleteSelection());
    after.doc.check();
    const hollowed = removeHollowFiguresTr(after, state);
    const final = hollowed ? after.apply(hollowed) : after;
    final.doc.check();
    final.doc.descendants((node) => {
      if (node.type.name === 'figure') expect(node.firstChild?.attrs.assetId).toBeTruthy();
    });
  });

  it('removes a figure whose table has been deleted', () => {
    const doc = docOf({ type: 'figure', attrs: { kind: 'table' }, content: [tableJson(), { type: 'figcaption' }] }, para('a'));
    const state = EditorState.create({ schema, doc });
    const table = doc.child(0).firstChild!;
    const after = state.apply(state.tr.delete(1, 1 + table.nodeSize));
    after.doc.check();
    const hollowed = removeHollowFiguresTr(after, state);
    const final = hollowed ? after.apply(hollowed) : after;
    expect(types(final.doc)).toEqual(['paragraph']);
  });

  it('leaves a hollow figure it did not cause, from an import say', () => {
    const doc = docOf({ type: 'figure', attrs: { kind: 'figure' }, content: [{ type: 'image' }, { type: 'figcaption', content: [{ type: 'text', text: 'L' }] }] }, para('a'));
    const state = EditorState.create({ schema, doc });
    const after = state.apply(state.tr.insertText('x', doc.child(0).nodeSize + 1));
    expect(removeHollowFiguresTr(after, state)).toBeNull();
  });

  it('leaves whole figures alone', () => {
    const doc = docOf(picture('L'), para('a'));
    const state = EditorState.create({ schema, doc });
    const after = state.apply(state.tr.insertText('x', doc.child(0).nodeSize + 1));
    expect(removeHollowFiguresTr(after, state)).toBeNull();
  });
});

describe('the clipboard format', () => {
  const roundTrip = (doc: ProseNode) => {
    const dom = document.createElement('div');
    dom.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
    return PmDOMParser.fromSchema(schema).parse(dom);
  };

  it('keeps the asset, attributes and label of a picture', () => {
    const doc = docOf({
      type: 'figure',
      attrs: { kind: 'figure', align: 'left', width: 35, description: 'Detail' },
      content: [
        { type: 'image', attrs: { assetId: 'keep-me', width: 640, height: 480 } },
        { type: 'figcaption', content: [{ type: 'text', text: 'Label' }] },
      ],
    });
    const back = roundTrip(doc).child(0);
    expect(back.attrs).toEqual({ kind: 'figure', align: 'left', width: 35, description: 'Detail' });
    expect(back.firstChild?.attrs.assetId).toBe('keep-me');
    expect(back.firstChild?.attrs.width).toBe(640);
    expect(back.lastChild?.textContent).toBe('Label');
  });

  it('keeps a stored and a linked video', () => {
    const stored = roundTrip(docOf({ type: 'figure', attrs: { kind: 'video' }, content: [{ type: 'video', attrs: { assetId: 'v1' } }, { type: 'figcaption' }] }));
    expect(stored.child(0).firstChild?.attrs.assetId).toBe('v1');
    const linked = roundTrip(docOf({ type: 'figure', attrs: { kind: 'video' }, content: [{ type: 'video', attrs: { url: 'https://youtu.be/a' } }, { type: 'figcaption' }] }));
    expect(linked.child(0).firstChild?.attrs.url).toBe('https://youtu.be/a');
  });

  it('keeps a table inside a figure', () => {
    const doc = docOf({ type: 'figure', attrs: { kind: 'table', align: 'full' }, content: [tableJson(), { type: 'figcaption' }] });
    expect(roundTrip(doc).child(0).firstChild?.type.name).toBe('table');
  });

  it('keeps a bare picture', () => {
    const doc = docOf({ type: 'image', attrs: { assetId: 'bare' } });
    expect(roundTrip(doc).child(0).attrs.assetId).toBe('bare');
  });
});
