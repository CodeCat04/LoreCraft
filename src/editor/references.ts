/** Citations: inline `reference` nodes. The wiki lists them under the article. */

import type { Editor } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';

import { t } from '../lib/i18n';
import { promptText } from '../shell/dialogs';

const askForCitation = (initial: string) =>
  promptText({
    title: initial ? t('Edit reference') : t('Add a reference'),
    label: t('Citation'),
    initial,
    placeholder: t('Book, chapter, page or source'),
    confirmLabel: initial ? t('Save') : t('Insert'),
    validate: (value) => (value.trim() ? null : t('A reference needs some text.')),
  });

export async function insertReference(editor: Editor) {
  const text = await askForCitation('');
  const chain = editor.chain().focus();
  if (text?.trim()) chain.insertContent({ type: 'reference', attrs: { text: text.trim() } });
  chain.run();
}

/** Asks for new text for the citation at `pos`, then returns focus to the editor. */
export async function editReferenceAt(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  if (node?.type.name !== 'reference') return;
  const text = await askForCitation(String(node.attrs.text ?? ''));
  if (text?.trim()) {
    // The document may have changed while the dialog was open, but only by saves.
    const { tr } = editor.state;
    editor.view.dispatch(tr.setNodeMarkup(pos, undefined, { ...node.attrs, text: text.trim() }));
  }
  editor.commands.focus();
}

/** Where each citation sits, in the order the References section lists them. */
export function referencePositions(doc: ProseNode): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'reference') positions.push(pos);
  });
  return positions;
}
