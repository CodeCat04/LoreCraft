/**
 * Which drafting box is open, and on which editor: Guided Continue at the end of a scene,
 * or Describe with the senses on a selection. One at a time. Each holds a tracked range
 * that follows the text while the box is open, and lets it go when the box closes.
 */

import type { Editor } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { create } from 'zustand';

import type { EditorSource } from '../../editor/RichEditor';
import { trackRange, untrack } from '../../editor/ai/suggestions';

export interface ContinueRunner {
  /** The built-in Continue prompt, as the project has it. */
  template: () => Promise<string>;
  /** One version, run the way Continue always has, with the writer's direction added. */
  runOne: (direction: string) => Promise<void>;
}

export type DraftingBox =
  | { kind: 'continue'; editor: Editor; source: EditorSource; targetId: string; runner: ContinueRunner }
  | { kind: 'senses'; editor: Editor; source: EditorSource; targetId: string };

export const useDrafting = create<{ open: DraftingBox | null }>(() => ({ open: null }));

/** Closes what is open, and hands the editor back. */
export function closeDrafting(focus = true): void {
  const open = useDrafting.getState().open;
  if (!open) return;
  useDrafting.setState({ open: null });
  if (open.editor.isDestroyed) return;
  untrack(open.editor, open.targetId);
  if (focus) open.editor.view.focus();
}

/** Opens Guided Continue at the end of this editor's text. */
export function openGuidedContinue(editor: Editor, source: EditorSource, runner: ContinueRunner): void {
  closeDrafting(false);
  const end = Selection.atEnd(editor.state.doc).to;
  // The box sits at the end, so the end comes into view.
  try {
    editor.view.dom.ownerDocument.defaultView?.requestAnimationFrame(() => {
      if (editor.isDestroyed) return;
      const { node } = editor.view.domAtPos(Selection.atEnd(editor.state.doc).to);
      (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: 'nearest' });
    });
  } catch {
    // Nothing to scroll to.
  }
  const targetId = trackRange(editor, end, end, false);
  useDrafting.setState({ open: { kind: 'continue', editor, source, targetId, runner } });
}

/** Opens Describe with the senses on this range. */
export function openSenses(editor: Editor, source: EditorSource, from: number, to: number): void {
  closeDrafting(false);
  const targetId = trackRange(editor, from, to, true);
  useDrafting.setState({ open: { kind: 'senses', editor, source, targetId } });
}

/** Opens Describe with the senses on this editor's selection. False if nothing is selected. */
export function openSensesForSelection(editor: Editor, source: EditorSource): boolean {
  const { from, to, empty } = editor.state.selection;
  if (empty || !editor.state.doc.textBetween(from, to, ' ').trim()) return false;
  openSenses(editor, source, from, to);
  return true;
}
