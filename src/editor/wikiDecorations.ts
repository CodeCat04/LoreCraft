import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseNode } from '@tiptap/pm/model';

import { useTitles } from '../state/project';

const key = new PluginKey<DecorationSet>('wikiDecorations');
const REFRESH = 'refreshWikiLinks';

function build(doc: ProseNode): DecorationSet {
  const resolve = useTitles.getState().resolve;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === 'wikiLink');
    if (!mark) return;
    const page = resolve(String(mark.attrs.target));
    const cls = page ? `wiki-link-ok status-${page.status}` : 'wiki-link-red';
    decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: cls }));
  });
  return DecorationSet.create(doc, decorations);
}

/** Colors wiki links by whether their target exists and by its canon status. */
export const wikiDecorations = Extension.create({
  name: 'wikiDecorations',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, value, _old, state) => {
            if (tr.docChanged || tr.getMeta(REFRESH)) return build(state.doc);
            return value;
          },
        },
        props: {
          decorations: (state) => key.getState(state),
        },
      }),
    ];
  },
});

export function refreshWikiDecorations(editor: Editor) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(REFRESH, true).setMeta('addToHistory', false));
}
