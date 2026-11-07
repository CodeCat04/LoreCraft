/**
 * The bridge between editors and the AI pane: the selection menu, inline prompt and
 * tracked-change suggestions.
 */

import type { Extensions } from '@tiptap/core';

import type { EditorSource } from '../RichEditor';
import { AiSuggestions } from './suggestions';

export function editorAiExtensions(source: EditorSource): Extensions {
  return [AiSuggestions.configure({ source })];
}

export { SelectionMenu, openAskFor, rewriteInMyStyleFor, sendSelectionToPane } from './SelectionMenu';
export { activeEditor, editorFor, waitForEditor, type EditorEntry } from './registry';
export {
  acceptChanges,
  activeChange,
  addSuggestion,
  clearParkedSuggestions,
  pendingSuggestions,
  rejectChanges,
  stepChange,
  trackedRange,
  untrack,
} from './suggestions';
export { startEdit, canEditRange, type EditOutcome, type EditStatus } from './flow';
export { hasRunningActions, stopRunningActions, whileRunning } from './running';
export { cleanReply, computeHunks, computeInsertion, planRewrite, planToMarkdown, stripMarkers } from './hunks';
