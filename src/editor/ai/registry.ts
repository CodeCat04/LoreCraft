/**
 * Which editors are on screen, so commands and the AI pane can reach the right one. The
 * active editor is the one last focused or selected in. Notes editors count only when
 * there is nothing else, since "this page" means the article, not its Talk tab.
 */

import type { Editor } from '@tiptap/core';

import type { EditorSource } from '../RichEditor';
import { useNav } from '../../state/nav';

export interface EditorEntry {
  editor: Editor;
  source: EditorSource;
  lastUsed: number;
  /** Where the selection last was. Survives focus moving to the pane. */
  selection: { from: number; to: number };
}

const entries = new Set<EditorEntry>();
const listeners = new Set<() => void>();
let clock = 0;

function changed() {
  listeners.forEach((listener) => listener());
}

export function registerEditor(editor: Editor, source: EditorSource): void {
  clock += 1;
  entries.add({ editor, source, lastUsed: clock, selection: { from: 0, to: 0 } });
  changed();
}

export function unregisterEditor(editor: Editor): void {
  for (const entry of entries) {
    if (entry.editor === editor) entries.delete(entry);
  }
  changed();
}

/** Records that this editor is the one in use. */
export function touchEditor(editor: Editor): void {
  for (const entry of entries) {
    if (entry.editor === editor) {
      clock += 1;
      entry.lastUsed = clock;
      const { from, to } = editor.state.selection;
      entry.selection = { from, to };
    }
  }
  changed();
}

/**
 * A read-only view of a document that is being edited elsewhere, as in the other pane. It may
 * be a moment behind, and an edit made through it would overwrite the real one.
 */
function isCopy(entry: EditorEntry): boolean {
  if (entry.editor.isEditable) return false;
  for (const other of entries) {
    if (
      other !== entry &&
      !other.editor.isDestroyed &&
      other.editor.isEditable &&
      other.source.kind === entry.source.kind &&
      other.source.id === entry.source.id
    ) {
      return true;
    }
  }
  return false;
}

function inFocusedPane(entry: EditorEntry): boolean {
  const dom = entry.editor.view?.dom as HTMLElement | undefined;
  const pane = dom?.closest?.('[data-pane-id]')?.getAttribute('data-pane-id');
  return pane === useNav.getState().focusedPaneId;
}

/**
 * The editor actions should apply to, or null if none is open: the focused pane's if it has
 * one, then an article or scene ahead of notes, then whichever was used last.
 */
export function activeEditor(): EditorEntry | null {
  let best: EditorEntry | null = null;
  let bestRank = -1;
  for (const entry of entries) {
    if (entry.editor.isDestroyed || isCopy(entry)) continue;
    const rank = (inFocusedPane(entry) ? 2 : 0) + (entry.source.kind === 'notes' ? 0 : 1);
    if (!best || rank > bestRank || (rank === bestRank && entry.lastUsed > best.lastUsed)) {
      best = entry;
      bestRank = rank;
    }
  }
  return best;
}

export function editorFor(kind: EditorSource['kind'], id: string): EditorEntry | null {
  for (const entry of entries) {
    if (!entry.editor.isDestroyed && entry.source.kind === kind && entry.source.id === id && !isCopy(entry)) return entry;
  }
  return null;
}

export function subscribeEditors(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Waits for an editor to appear, as after navigating to the document it belongs to. */
export function waitForEditor(kind: EditorSource['kind'], id: string, timeoutMs = 3000): Promise<EditorEntry | null> {
  const now = editorFor(kind, id);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      stop();
      resolve(null);
    }, timeoutMs);
    const stop = subscribeEditors(() => {
      const found = editorFor(kind, id);
      if (found) {
        window.clearTimeout(timer);
        stop();
        resolve(found);
      }
    });
  });
}
