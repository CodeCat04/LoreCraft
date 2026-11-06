/**
 * The editors on screen, so that menu commands and drops outside an editor can find the
 * right one.
 */

import type { Editor } from '@tiptap/core';

import type { EditorSource } from '../RichEditor';

interface Entry {
  editor: Editor;
  source: EditorSource;
  lastFocus: number;
}

export interface RememberedDocument {
  source: EditorSource;
  /** Where its cursor was, if it was being edited. */
  pos: number | null;
}

const entries = new Map<Editor, Entry>();
let remembered: RememberedDocument | null = null;
const listeners = new Set<() => void>();
let clock = 0;

function changed() {
  listeners.forEach((listener) => listener());
}

export function registerEditor(editor: Editor, source: EditorSource) {
  entries.set(editor, { editor, source, lastFocus: 0 });
  changed();
}

export function unregisterEditor(editor: Editor) {
  entries.delete(editor);
  changed();
}

/** Keeps track of the main document, so a screen without an editor can still act on it. */
export function rememberDocument(editor: Editor) {
  const entry = entries.get(editor);
  if (!entry || entry.source.kind === 'notes' || !editor.view.dom.closest('.content')) return;
  remembered = { source: entry.source, pos: editor.isEditable ? editor.state.selection.from : null };
}

/** The page or scene most recently on screen. */
export function rememberedDocument(): RememberedDocument | null {
  return remembered;
}

export function noteEditorFocus(editor: Editor) {
  const entry = entries.get(editor);
  if (entry) {
    clock += 1;
    entry.lastFocus = clock;
  }
}

function live(): Entry[] {
  return [...entries.values()]
    .filter((e) => !e.editor.isDestroyed)
    .sort((a, b) => b.lastFocus - a.lastFocus);
}

/** The editor to act on: the last one focused, among those that can be edited. */
export function activeEditableEditor(): Editor | null {
  return live().find((e) => e.editor.isEditable)?.editor ?? null;
}

/** The editor an element belongs to. */
export function editorAt(target: EventTarget | null): Entry | null {
  const element = target instanceof Element ? target.closest('.ProseMirror') : null;
  if (!element) return null;
  return live().find((e) => e.editor.view.dom === element) ?? null;
}

/** The main document on screen, whether or not it can be edited. */
export function mainEditor(): Entry | null {
  const all = live();
  return all.find((e) => e.editor.view.dom.closest('.content')) ?? all[0] ?? null;
}

/** Waits for an editable editor showing this document, for after a switch to Edit. */
export function waitForEditableEditor(sourceId: string, timeoutMs = 4000): Promise<Editor | null> {
  const find = () =>
    live().find((e) => e.source.id === sourceId && e.editor.isEditable)?.editor ?? null;
  return new Promise((resolve) => {
    const found = find();
    if (found) {
      resolve(found);
      return;
    }
    const finish = (editor: Editor | null) => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      listeners.delete(check);
      resolve(editor);
    };
    const check = () => {
      const editor = find();
      if (editor) finish(editor);
    };
    listeners.add(check);
    // Editable can change without a new editor appearing.
    const poll = window.setInterval(check, 50);
    const timer = window.setTimeout(() => finish(null), timeoutMs);
  });
}
