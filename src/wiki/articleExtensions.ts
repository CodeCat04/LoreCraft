/** Editor behavior only articles have. None of it adds stored nodes or marks. */

import { Extension, type Extensions } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { editReferenceAt } from '../editor/references';

interface ArticleOptions {
  /** The element the Contents box renders into. */
  contentsHost: HTMLElement;
  isEditing: () => boolean;
}

function firstHeadingPos(doc: ProseNode): number | null {
  let found: number | null = null;
  doc.forEach((node, offset) => {
    if (found === null && node.type.name === 'heading') found = offset;
  });
  return found;
}

/**
 * Puts the Contents box between the lead and the first heading, where an encyclopedia
 * reader expects it. While reading, links also become reachable with the keyboard.
 */
function buildDecorations(doc: ProseNode, host: HTMLElement, editing: boolean): DecorationSet {
  const decorations: Decoration[] = [];
  const heading = firstHeadingPos(doc);
  if (heading !== null) {
    decorations.push(
      Decoration.widget(heading, host, {
        key: 'wiki-contents',
        side: -1,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    );
  }
  if (!editing) {
    doc.descendants((node, pos) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'wikiLink')) {
        decorations.push(Decoration.inline(pos, pos + node.nodeSize, { tabindex: '0', role: 'link' }));
      }
    });
  }
  return DecorationSet.create(doc, decorations);
}

export function articleExtensions({ contentsHost, isEditing }: ArticleOptions): Extensions {
  const ArticleBehavior = Extension.create({
    name: 'articleBehavior',
    priority: 1200,
    addKeyboardShortcuts() {
      return {
        // Ctrl+E toggles editing here. Without this it would also mark text as code.
        'Mod-e': () => true,
      };
    },
    addProseMirrorPlugins() {
      const { editor } = this;
      let cached: { doc: ProseNode; editing: boolean; set: DecorationSet } | null = null;
      return [
        new Plugin({
          key: new PluginKey('articleBehavior'),
          props: {
            decorations(state) {
              const editing = isEditing();
              if (!cached || cached.doc !== state.doc || cached.editing !== editing) {
                cached = {
                  doc: state.doc,
                  editing,
                  set: buildDecorations(state.doc, contentsHost, editing),
                };
              }
              return cached.set;
            },
            handleDoubleClickOn(view, pos, node) {
              if (!view.editable || node.type.name !== 'reference') return false;
              void editReferenceAt(editor, pos);
              return true;
            },
          },
        }),
      ];
    },
  });
  return [ArticleBehavior];
}
