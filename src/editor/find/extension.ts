/**
 * The document's side of Find: the highlights, and where the search has got to. Highlights
 * are decorations, so they never touch the text, the undo history or a save.
 */

import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { controllerFor, forgetEditor, noteEditorCreated, noteEditorUsed } from './controller';
import type { FindMatch } from './search';

interface FindPluginState {
  decorations: DecorationSet;
  /** Where the search continues from. It moves with the text. */
  anchor: number;
}

interface FindMeta {
  decorations?: DecorationSet;
  anchor?: number;
}

export const findKey = new PluginKey<FindPluginState>('findInPage');

/** Asks for these changes to go with a transaction. */
export function setFindMeta(tr: Transaction, meta: FindMeta) {
  return tr.setMeta(findKey, meta);
}

export function findAnchor(state: EditorState): number {
  return findKey.getState(state)?.anchor ?? 0;
}

export function highlights(state: EditorState, matches: FindMatch[], start: number, end: number, current: number): DecorationSet {
  const decorations: Decoration[] = [];
  const draw = (index: number) => {
    const match = matches[index];
    decorations.push(
      Decoration.inline(match.from, match.to, {
        class: index === current ? 'find-match find-match-current' : 'find-match',
      }),
    );
  };
  // The current match always shows, even if it is outside the span being drawn.
  if (current >= 0 && current < start) draw(current);
  for (let i = start; i < end; i += 1) draw(i);
  if (current >= end) draw(current);
  return DecorationSet.create(state.doc, decorations);
}

export const findInPage = Extension.create({
  name: 'findInPage',
  onCreate() {
    noteEditorCreated(this.editor as Editor);
  },
  onFocus() {
    noteEditorUsed(this.editor as Editor);
  },
  onDestroy() {
    forgetEditor(this.editor as Editor);
  },
  addProseMirrorPlugins() {
    const editor = this.editor as Editor;
    return [
      new Plugin<FindPluginState>({
        key: findKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty, anchor: 0 }),
          apply(tr, value) {
            const meta = tr.getMeta(findKey) as FindMeta | undefined;
            if (!meta && !tr.docChanged) return value;
            // Highlights follow the text until the search runs again on the new document.
            const decorations = meta?.decorations ?? (tr.docChanged ? value.decorations.map(tr.mapping, tr.doc) : value.decorations);
            const anchor = meta?.anchor ?? (tr.docChanged ? tr.mapping.map(value.anchor) : value.anchor);
            return { decorations, anchor };
          },
        },
        props: {
          decorations(state) {
            return findKey.getState(state)?.decorations;
          },
          handleKeyDown(_view, event) {
            if (event.key !== 'Escape' || event.isComposing) return false;
            const controller = controllerFor(editor);
            if (!controller.isOpen) return false;
            // Focus mode also listens for Escape, and it should take only one press to do
            // the nearest thing.
            event.stopPropagation();
            controller.close();
            return true;
          },
        },
        view: () => ({
          update(view, previous) {
            if (previous.doc !== view.state.doc) controllerFor(editor).documentChanged();
          },
        }),
      }),
    ];
  },
});
