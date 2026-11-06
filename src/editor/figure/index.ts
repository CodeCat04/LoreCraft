/**
 * Figures in the editor: node views, labeling, dropping, pasting and uploads. The stored
 * format is in `../schema.ts`. Everything here is behavior, and it stores nothing extra.
 */

import { Extension, type Extensions } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Command } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView, type NodeViewConstructor } from '@tiptap/pm/view';

import type { EditorSource } from '../RichEditor';
import {
  captionStart,
  enterCaption,
  figureInsteadOfMediaTr,
  guardCaptionBackspace,
  guardCaptionDelete,
  labelHint,
  leaveCaption,
  removeHollowFiguresTr,
  selectedFigure,
  selectFigureFromCaption,
  typeIntoCaption,
} from './commands';
import { dropIndicatorView, handleDrop, handlePaste } from './drop';
import { FigureView } from './figureView';
import { ImageView, syncImageReadMode, VideoView } from './mediaViews';
import { noteEditorFocus, registerEditor, rememberDocument, unregisterEditor } from './registry';
import { uploadsPlugin } from './uploads';

const figureKey = new PluginKey<DecorationSet>('figures');

function hintElement(kind: string): HTMLElement {
  const hint = document.createElement('span');
  hint.className = 'figure-hint';
  hint.textContent = labelHint(kind);
  return hint;
}

/** Every empty label asks for one. The hint sits after the cursor, so typing goes before it. */
function labelHints(doc: ProseNode): DecorationSet {
  const hints: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) return false;
    if (node.type.name === 'figure' && node.lastChild?.content.size === 0) {
      const kind = String(node.attrs.kind);
      hints.push(
        Decoration.widget(captionStart(node, pos), () => hintElement(kind), {
          side: 1,
          key: `figure-hint-${kind}`,
          ignoreSelection: true,
        }),
      );
    }
    return true;
  });
  return DecorationSet.create(doc, hints);
}

const nodeViews: Record<string, NodeViewConstructor> = {
  figure: (node, view, getPos) => new FigureView(node, view, getPos),
  image: (node, view, getPos) => new ImageView(node, view, getPos),
  video: (node, view) => new VideoView(node, view),
};

function figurePlugin(): Plugin {
  return new Plugin<DecorationSet>({
    key: figureKey,
    state: {
      init: (_, state) => labelHints(state.doc),
      apply: (tr, previous) => (tr.docChanged ? labelHints(tr.doc) : previous),
    },
    appendTransaction(transactions, oldState, newState) {
      if (transactions.some((tr) => tr.docChanged)) {
        const tr = removeHollowFiguresTr(newState, oldState);
        if (tr) return tr;
      }
      return figureInsteadOfMediaTr(newState);
    },
    props: {
      nodeViews,
      decorations(state) {
        const hints = figureKey.getState(state);
        const active = selectedFigure(state);
        if (!hints || !active) return hints;
        return hints.add(state.doc, [
          Decoration.node(active.pos, active.pos + active.node.nodeSize, { class: 'is-active' }),
        ]);
      },
      handleTextInput(view, _from, _to, text) {
        const tr = typeIntoCaption(view.state, text);
        if (!tr) return false;
        view.dispatch(tr);
        return true;
      },
      handleDrop: (view, event) => handleDrop(view, event as DragEvent),
      handlePaste: (view, event, slice) => handlePaste(view, event, slice),
    },
    view(view: EditorView) {
      const indicator = dropIndicatorView(view);
      let editable = view.editable;
      return {
        update(current) {
          if (current.editable === editable) return;
          editable = current.editable;
          current.dom.querySelectorAll<HTMLImageElement>('.media-frame img').forEach((image) => {
            syncImageReadMode(image, editable);
          });
        },
        destroy: () => indicator.destroy?.(),
      };
    },
  });
}

export interface FigureKitOptions {
  source: EditorSource | null;
}

/** High priority, so a label's own Enter and Backspace come before the document's. */
const FigureKit = Extension.create<FigureKitOptions>({
  name: 'figureKit',
  priority: 1100,
  addOptions() {
    return { source: null };
  },
  addKeyboardShortcuts() {
    const run = (command: Command) => () => command(this.editor.state, this.editor.view.dispatch, this.editor.view);
    const backspace = run(guardCaptionBackspace);
    const del = run(guardCaptionDelete);
    return {
      Enter: () => run(leaveCaption)() || run(enterCaption)(),
      Backspace: backspace,
      'Mod-Backspace': backspace,
      'Shift-Backspace': backspace,
      Delete: del,
      'Mod-Delete': del,
      Escape: run(selectFigureFromCaption),
    };
  },
  addProseMirrorPlugins() {
    return [figurePlugin(), uploadsPlugin()];
  },
  onCreate() {
    if (this.options.source) registerEditor(this.editor, this.options.source);
    rememberDocument(this.editor);
  },
  onFocus() {
    noteEditorFocus(this.editor);
    rememberDocument(this.editor);
  },
  onSelectionUpdate() {
    rememberDocument(this.editor);
  },
  onDestroy() {
    unregisterEditor(this.editor);
  },
});

export function figureExtensions(source: EditorSource): Extensions {
  return [FigureKit.configure({ source })];
}

export {
  activeEditableEditor,
  editorAt,
  mainEditor,
  rememberedDocument,
  waitForEditableEditor,
  type RememberedDocument,
} from './registry';
export { addExistingMedia, addFiles, addLinkedVideo, addPaths, addVideoLink, LARGE_VIDEO_BYTES } from './uploads';
export { carriesMedia, positionAtPoint } from './drop';
export {
  addLabel,
  createFigure,
  createTable,
  insertFigureTr,
  nearestFigurePos,
  removeLabel,
} from './commands';
