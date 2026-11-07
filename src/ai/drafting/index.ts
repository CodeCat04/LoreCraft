/** Drafting a scene: from selected notes, from its synopsis, or from a premise. */

import * as coreApi from '../../lib/api';
import { t } from '../../lib/i18n';
import { registerCommands } from '../../shell/commands';
import { toast } from '../../shell/toasts';
import { activeEditor } from '../../editor/ai/registry';
import { askForDraft, lastDraftLength } from './DraftDialog';
import { draftSceneFromSynopsis, firstDraft, writeSelectionAsScene } from './run';

export { draftSceneFromSynopsis, firstDraft, writeSelectionAsScene, startDraft, type DraftRequest } from './run';
export { draftInstruction, draftParts, DRAFT_LENGTHS, DRAFT_WORDS, type DraftLength, type DraftMode } from './prompts';
export { LengthChoice, lastDraftLength, rememberDraftLength, lengthLabel } from './DraftDialog';

function openScene() {
  const entry = activeEditor();
  return entry && entry.source.kind === 'node' ? entry : null;
}

/** "Write as a scene" from the menu or its shortcut, with the length last chosen. */
export function writeActiveSelectionAsScene(): void {
  const entry = openScene();
  if (!entry) {
    toast(t('Open a scene first.'));
    return;
  }
  const { from, to, empty } = entry.editor.state.selection;
  if (empty || !entry.editor.state.doc.textBetween(from, to, ' ').trim()) {
    toast(t('Select your notes for the scene first.'));
    return;
  }
  void writeSelectionAsScene(entry.editor, entry.source, { from, to }, lastDraftLength());
}

export async function openDraftFromSynopsis(): Promise<void> {
  const entry = openScene();
  if (!entry) return;
  const node = await coreApi.nodes.get(entry.source.id);
  if (!node.synopsis.trim()) {
    toast(t('This scene has no synopsis yet. Write one in its details first.'));
    return;
  }
  const choice = await askForDraft('synopsis', node.synopsis);
  if (choice) await draftSceneFromSynopsis(node.id, { length: choice.length });
}

export async function openFirstDraft(): Promise<void> {
  const entry = openScene();
  if (!entry) return;
  const choice = await askForDraft('premise');
  if (choice) await firstDraft(entry.source.id, choice.plan, choice.length);
}

/** Runs again when the interface language changes, which replaces the titles. */
export function registerDraftingCommands(): void {
  registerCommands([
    {
      id: 'ai.writeAsScene',
      title: t('Write the selection as a scene'),
      shortcut: 'Ctrl+Shift+E',
      menu: 'AI',
      order: 52,
      when: () => !!openScene(),
      keywords: 'notes draft prose beats bullet stream',
      run: writeActiveSelectionAsScene,
    },
    {
      id: 'ai.draftFromSynopsis',
      title: t('Draft from synopsis…'),
      menu: 'AI',
      order: 53,
      when: () => !!openScene(),
      keywords: 'write scene draft outline',
      run: openDraftFromSynopsis,
    },
    {
      id: 'ai.firstDraft',
      title: t('First draft…'),
      menu: 'AI',
      order: 54,
      when: () => !!openScene(),
      keywords: 'write scene draft premise empty',
      run: openFirstDraft,
    },
  ]);
}
