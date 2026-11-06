/**
 * Actions on a whole document that are under way. They have no selection or box to show
 * themselves in, and a reply from a local model can take minutes, so the editor lists them
 * with a way to stop them.
 */

import type { Editor } from '@tiptap/core';
import { create } from 'zustand';

export interface RunningAction {
  id: number;
  editor: Editor;
  label: string;
  stop: () => void;
}

export const useRunningActions = create<{ actions: RunningAction[] }>(() => ({ actions: [] }));

let nextId = 0;

/** Lists an action for as long as `work` takes. */
export async function whileRunning<T>(editor: Editor, label: string, stop: () => void, work: () => Promise<T>): Promise<T> {
  nextId += 1;
  const action: RunningAction = { id: nextId, editor, label, stop };
  useRunningActions.setState((state) => ({ actions: [...state.actions, action] }));
  try {
    return await work();
  } finally {
    useRunningActions.setState((state) => ({ actions: state.actions.filter((other) => other !== action) }));
  }
}

export function hasRunningActions(): boolean {
  return useRunningActions.getState().actions.length > 0;
}

export function stopRunningActions(): void {
  useRunningActions.getState().actions.forEach((action) => action.stop());
}
