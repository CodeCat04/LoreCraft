/**
 * What can be done to figures, as plain ProseMirror commands so it can all be tested
 * without a window. See the Figures part of "Document format" in docs/ARCHITECTURE.md.
 */

import type { Node as ProseNode, ResolvedPos, Schema } from '@tiptap/pm/model';
import {
  NodeSelection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';

import { t } from '../../lib/i18n';
import type { FigureAlign, FigureKind } from '../schema';

/** Below this a label wraps a word at a time and a picture is too small to make out. */
export const MIN_FIGURE_WIDTH = 15;
export const MAX_FIGURE_WIDTH = 100;

/** What the writer is asked to label. */
export function labelHint(kind: string): string {
  switch (kind) {
    case 'picture':
      return t('Label this picture so the AI knows what it shows');
    case 'table':
      return t('Label this table so the AI knows what it shows');
    case 'video':
      return t('Label this video so the AI knows what it shows');
    default:
      return t('Label this figure so the AI knows what it shows');
  }
}

export interface FigureAt {
  node: ProseNode;
  /** The position just before the figure. */
  pos: number;
}

/** The figure a position is inside, if any. */
export function figureAround($pos: ResolvedPos): FigureAt | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === 'figure') return { node, pos: $pos.before(depth) };
  }
  return null;
}

/** The figure the selection is on or in. */
export function selectedFigure(state: EditorState): FigureAt | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && selection.node.type.name === 'figure') {
    return { node: selection.node, pos: selection.from };
  }
  return figureAround(selection.$from);
}

/** The position inside a figure's caption where the label starts. */
export function captionStart(figure: ProseNode, pos: number): number {
  let at = pos + 1;
  let found = at;
  figure.forEach((child, offset) => {
    if (child.type.name === 'figcaption') found = at + offset + 1;
  });
  return found;
}

export function captionEnd(figure: ProseNode, pos: number): number {
  const caption = figure.lastChild;
  return captionStart(figure, pos) + (caption ? caption.content.size : 0);
}

/**
 * The nearest place a figure can go. A figure never splits a paragraph, so a position in
 * text moves to the boundary before or after its block, whichever is closer, and a
 * position inside another figure moves out of it.
 */
export function nearestFigurePos(doc: ProseNode, pos: number): number {
  const type = doc.type.schema.nodes.figure;
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  let top = $pos.depth;
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    if ($pos.node(depth).type === type) {
      top = depth - 1;
      break;
    }
  }
  if (top === $pos.depth && !$pos.parent.inlineContent) {
    const index = $pos.index();
    if ($pos.parent.canReplaceWith(index, index, type)) return $pos.pos;
  }
  for (let depth = Math.min(top, $pos.depth - 1); depth >= 0; depth -= 1) {
    const parent = $pos.node(depth);
    const index = $pos.index(depth);
    const before = $pos.before(depth + 1);
    const after = $pos.after(depth + 1);
    const places: [number, number][] = [
      [index, before],
      [index + 1, after],
    ];
    if ($pos.pos > (before + after) / 2) places.reverse();
    for (const [at, place] of places) {
      if (parent.canReplaceWith(at, at, type)) return place;
    }
  }
  return doc.content.size;
}

export interface FigureMedia {
  type: 'image' | 'video' | 'table';
  attrs?: Record<string, unknown>;
  /** A table to wrap, rather than a new node. */
  node?: ProseNode;
}

export interface NewFigure {
  media: FigureMedia;
  kind: FigureKind;
  align?: FigureAlign;
  width?: number | null;
  description?: string;
  caption?: string;
}

export function createFigure(schema: Schema, spec: NewFigure): ProseNode {
  const media = spec.media.node ?? schema.nodes[spec.media.type].create(spec.media.attrs ?? {});
  const caption = spec.caption
    ? schema.nodes.figcaption.create(null, schema.text(spec.caption))
    : schema.nodes.figcaption.create();
  return schema.nodes.figure.create(
    {
      kind: spec.kind,
      align: spec.align ?? 'right',
      width: spec.width ?? null,
      description: spec.description ?? '',
    },
    [media, caption],
  );
}

/** A new table, with a header row. */
export function createTable(schema: Schema, rows = 3, columns = 3): ProseNode {
  const cell = (type: 'tableCell' | 'tableHeader') =>
    schema.nodes[type].create(null, schema.nodes.paragraph.create());
  const row = (type: 'tableCell' | 'tableHeader') =>
    schema.nodes.tableRow.create(null, Array.from({ length: columns }, () => cell(type)));
  return schema.nodes.table.create(null, [
    row('tableHeader'),
    ...Array.from({ length: Math.max(0, rows - 1) }, () => row('tableCell')),
  ]);
}

/** Inserts a figure at `pos`, which must be a block boundary, and starts labeling it. */
export function insertFigureTr(tr: Transaction, pos: number, figure: ProseNode, focusLabel: boolean): Transaction {
  tr.insert(pos, figure);
  if (focusLabel) {
    tr.setSelection(TextSelection.create(tr.doc, captionEnd(figure, pos))).scrollIntoView();
  }
  return tr;
}

/** Changes a figure's attributes. Width is kept within its limits and dropped for full width. */
export function setFigureAttrs(tr: Transaction, pos: number, attrs: Record<string, unknown>): Transaction {
  const next: Record<string, unknown> = { ...attrs };
  if (typeof next.width === 'number') next.width = clampWidth(next.width);
  if (next.align === 'full') next.width = null;
  for (const [key, value] of Object.entries(next)) tr.setNodeAttribute(pos, key, value);
  return tr;
}

export function clampWidth(width: number): number {
  return Math.round(Math.max(MIN_FIGURE_WIDTH, Math.min(MAX_FIGURE_WIDTH, width)) * 10) / 10;
}

export function deleteFigureTr(tr: Transaction, pos: number): Transaction {
  const node = tr.doc.nodeAt(pos);
  return node ? tr.delete(pos, pos + node.nodeSize) : tr;
}

function inCaption(state: EditorState): boolean {
  return state.selection.$from.parent.type.name === 'figcaption';
}

/** Enter in a label goes to the paragraph after the figure, making one if needed. */
export const leaveCaption: Command = (state, dispatch) => {
  if (!inCaption(state)) return false;
  const figure = figureAround(state.selection.$from);
  if (!figure) return false;
  if (dispatch) {
    const tr = state.tr;
    const after = figure.pos + figure.node.nodeSize;
    const $after = tr.doc.resolve(after);
    const next = $after.nodeAfter;
    if (next?.type.name === 'paragraph') {
      tr.setSelection(TextSelection.create(tr.doc, after + 1));
    } else {
      const index = $after.index();
      const paragraph = state.schema.nodes.paragraph;
      if ($after.parent.canReplaceWith(index, index, paragraph)) {
        tr.insert(after, paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
      } else {
        tr.setSelection(TextSelection.near(tr.doc.resolve(after), 1));
      }
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Backspace at the start of a label does nothing, so clearing one cannot delete the figure. */
export const guardCaptionBackspace: Command = (state) => {
  const { selection } = state;
  return selection.empty && inCaption(state) && selection.$from.parentOffset === 0;
};

/** Delete at the end of a label likewise. */
export const guardCaptionDelete: Command = (state) => {
  const { selection } = state;
  return selection.empty && inCaption(state) && selection.$from.parentOffset === selection.$from.parent.content.size;
};

/** Escape in a label selects the figure, which is how to reach it by keyboard. */
export const selectFigureFromCaption: Command = (state, dispatch) => {
  if (!inCaption(state)) return false;
  const figure = figureAround(state.selection.$from);
  if (!figure) return false;
  if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, figure.pos)));
  return true;
};

/** Enter on a selected figure goes into its label. */
export const enterCaption: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'figure') return false;
  if (dispatch) {
    dispatch(
      state.tr
        .setSelection(TextSelection.create(state.doc, captionEnd(selection.node, selection.from)))
        .scrollIntoView(),
    );
  }
  return true;
};

/** Typing on a selected figure labels it, where a stray key would otherwise replace it. */
export function typeIntoCaption(state: EditorState, text: string): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'figure') return null;
  const at = captionEnd(selection.node, selection.from);
  return state.tr.setSelection(TextSelection.create(state.doc, at)).insertText(text).scrollIntoView();
}

const BARE_MEDIA = new Set(['table', 'image', 'video']);

/** The table, picture or video around the selection, if it has no label yet. */
function bareMediaAt(state: EditorState): FigureAt | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && BARE_MEDIA.has(selection.node.type.name)) {
    return selection.$from.parent.type.name === 'figure' ? null : { node: selection.node, pos: selection.from };
  }
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'figure') return null;
    if (node.type.name === 'table') {
      const outer = $from.node(depth - 1);
      return outer.type.name === 'figure' ? null : { node, pos: $from.before(depth) };
    }
  }
  return null;
}

/** Wraps a bare table, picture or video in a figure and starts labeling it. */
export const addLabel: Command = (state, dispatch) => {
  const target = bareMediaAt(state);
  if (!target) return false;
  const { node, pos } = target;
  const kind: FigureKind = node.type.name === 'table' ? 'table' : node.type.name === 'video' ? 'video' : 'picture';
  const figure = createFigure(state.schema, {
    media: { type: node.type.name as FigureMedia['type'], node },
    kind,
    align: node.type.name === 'table' ? 'full' : 'right',
  });
  const $pos = state.doc.resolve(pos);
  const index = $pos.index();
  if (!$pos.parent.canReplaceWith(index, index + 1, figure.type)) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith(pos, pos + node.nodeSize, figure);
    tr.setSelection(TextSelection.create(tr.doc, captionStart(figure, pos)));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Unwraps a table's figure, leaving the plain table. The label goes with it. */
export const removeLabel: Command = (state, dispatch) => {
  const figure = selectedFigure(state);
  const media = figure?.node.firstChild;
  if (!figure || media?.type.name !== 'table') return false;
  if (dispatch) {
    const tr = state.tr.replaceWith(figure.pos, figure.pos + figure.node.nodeSize, media);
    tr.setSelection(TextSelection.near(tr.doc.resolve(figure.pos + 1), 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Which figures have lost their media, in document order. */
function hollowFigures(doc: ProseNode): FigureAt[] {
  const out: FigureAt[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) return false;
    if (node.type.name !== 'figure') return true;
    const media = node.firstChild;
    const empty =
      (media?.type.name === 'image' && !media.attrs.assetId && !media.attrs.src) ||
      (media?.type.name === 'video' && !media.attrs.assetId && !media.attrs.url);
    if (empty) out.push({ node, pos });
    return true;
  });
  return out;
}

/**
 * A deletion that runs through a figure's media makes ProseMirror fill the gap with an
 * empty image, since a figure must hold something. Nothing useful remains, so it goes.
 * A hollow figure that was already there, from an import say, is not this edit's doing.
 */
export function removeHollowFiguresTr(state: EditorState, previous: EditorState): Transaction | null {
  const hollow = hollowFigures(state.doc);
  if (hollow.length === 0 || hollow.length <= hollowFigures(previous.doc).length) return null;
  const tr = state.tr;
  for (const { node, pos } of hollow.reverse()) tr.delete(pos, pos + node.nodeSize);
  return tr;
}

/**
 * A picture or video inside a figure is not selectable on its own, because moving or
 * deleting it alone would break the figure. Selecting one selects the figure.
 */
export function figureInsteadOfMediaTr(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return null;
  if (selection.node.type.name !== 'image' && selection.node.type.name !== 'video') return null;
  if (selection.$from.parent.type.name !== 'figure') return null;
  return state.tr
    .setSelection(NodeSelection.create(state.doc, selection.$from.before()))
    .setMeta('addToHistory', false);
}
