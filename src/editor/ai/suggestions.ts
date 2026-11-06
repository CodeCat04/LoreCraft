/**
 * Tracked changes for AI edits. A suggestion is decorations only: the stored document does
 * not change until a change is accepted, so autosave and undo history stay clean, and
 * rejecting leaves nothing behind. Positions follow any edits made in the meantime. An
 * edit inside a suggested range marks the suggestion stale rather than guessing, and a
 * stale suggestion can only be discarded or asked for again.
 */

import { Extension, type Editor } from '@tiptap/core';
import { DOMSerializer, Fragment, Slice, type Node as ProseNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import * as api from '../../lib/api';
import { errorMessage } from '../../lib/rpc';
import { t } from '../../lib/i18n';
import { toast } from '../../shell/toasts';
import type { PmNode } from '../../lib/types';
import type { EditorSource } from '../RichEditor';
import { flushOrStop } from '../saving';
import type { Hunk } from './hunks';
import { registerEditor, touchEditor, unregisterEditor } from './registry';

export interface Suggestion {
  id: string;
  /** What was asked for, shown on the bar. */
  label: string;
  from: number;
  to: number;
  hunks: Hunk[];
  /** The text changed underneath it, so it can no longer be applied. */
  stale: boolean;
  /** What the model wrote, kept for showing or trying again. */
  reply: string;
  /** The request, so "try again" does not need it retyped. */
  instruction: string;
  checkpointed: boolean;
}

/** A range being tracked: where a request is working, or where a chip's text came from. */
interface Tracked {
  id: string;
  from: number;
  to: number;
  /** The text inside was edited after this began. */
  touched: boolean;
  /** Highlighted in the document. Chips are tracked silently. */
  visible: boolean;
}

export interface SuggestionsState {
  suggestions: Suggestion[];
  tracked: Tracked[];
  activeHunk: string | null;
  decorations: DecorationSet;
}

type Action =
  | { type: 'add'; suggestion: Suggestion }
  | { type: 'accepted'; suggestionId: string; hunkIds: string[] }
  | { type: 'reject'; suggestionId: string; hunkIds: string[] }
  | { type: 'dismiss'; suggestionId: string }
  | { type: 'markCheckpointed'; suggestionId: string }
  | { type: 'active'; hunkId: string | null }
  | { type: 'track'; item: Tracked }
  | { type: 'freshRead'; id: string }
  | { type: 'untrack'; id: string };

export const suggestionsKey = new PluginKey<SuggestionsState>('aiSuggestions');

/** The live text of a request's preview, updated without touching the editor state. */
const previews = new Map<string, HTMLElement>();

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Inserted text, with the block shape it will have, without being part of the document. */
function renderSlice(schema: Schema, slice: Slice): HTMLElement {
  const serializer = DOMSerializer.fromSchema(schema);
  const holder = document.createElement('span');
  holder.className = 'ai-ins';
  const inline = (fragment: Fragment, into: HTMLElement) => {
    into.appendChild(serializer.serializeFragment(fragment));
  };
  if (slice.content.firstChild?.isInline) {
    inline(slice.content, holder);
    return holder;
  }
  slice.content.forEach((node, _offset, index) => {
    if (node.isTextblock && (slice.openStart > 0 || slice.openEnd > 0)) {
      // A flowing piece of text: its first line continues the sentence it lands in.
      if (index > 0) {
        const pilcrow = document.createElement('span');
        pilcrow.className = 'ai-ins-break';
        holder.appendChild(pilcrow);
      }
      inline(node.content, holder);
    } else {
      const block = document.createElement('span');
      block.className = 'ai-ins-block';
      block.appendChild(serializer.serializeNode(node));
      holder.appendChild(block);
    }
  });
  return holder;
}

function hunkButton(label: string, symbol: string, className: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `ai-hunk-btn ${className}`;
  button.textContent = symbol;
  button.title = label;
  button.setAttribute('aria-label', label);
  // Keeps the selection where it is, and the view from treating this as an edit.
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    run();
  });
  return button;
}

function hunkWidget(view: EditorView, suggestion: Suggestion, hunk: Hunk, active: boolean): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = `ai-hunk${active ? ' is-active' : ''}`;
  wrap.dataset.hunk = hunk.id;
  wrap.contentEditable = 'false';
  if (hunk.slice.size > 0) wrap.appendChild(renderSlice(view.state.schema, hunk.slice));
  // Links in a preview must not navigate anywhere.
  wrap.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) e.preventDefault();
  });
  const actions = document.createElement('span');
  actions.className = 'ai-hunk-actions';
  actions.appendChild(
    hunkButton(t('Accept this change ({shortcut})', { shortcut: 'Alt+A' }), '✓', 'ai-hunk-accept', () => void acceptFromView(view, suggestion.id, [hunk.id])),
  );
  actions.appendChild(
    hunkButton(t('Reject this change ({shortcut})', { shortcut: 'Alt+R' }), '✕', 'ai-hunk-reject', () => {
      dispatch(view, { type: 'reject', suggestionId: suggestion.id, hunkIds: [hunk.id] });
    }),
  );
  wrap.appendChild(actions);
  return wrap;
}

function previewWidget(id: string): HTMLElement {
  let element = previews.get(id);
  if (!element) {
    element = document.createElement('span');
    element.className = 'ai-preview';
    element.contentEditable = 'false';
    previews.set(id, element);
  }
  return element;
}

function buildDecorations(doc: ProseNode, state: Omit<SuggestionsState, 'decorations'>): DecorationSet {
  const decorations: Decoration[] = [];
  for (const suggestion of state.suggestions) {
    if (suggestion.stale) {
      if (suggestion.from < suggestion.to) {
        decorations.push(Decoration.inline(suggestion.from, suggestion.to, { class: 'ai-stale' }));
      }
      continue;
    }
    for (const hunk of suggestion.hunks) {
      const active = state.activeHunk === hunk.id;
      if (hunk.from < hunk.to) {
        decorations.push(Decoration.inline(hunk.from, hunk.to, { class: `ai-del${active ? ' is-active' : ''}`, 'data-hunk-del': hunk.id }));
        // Inline styling cannot show on a block with no text in it.
        doc.nodesBetween(hunk.from, hunk.to, (node, pos) => {
          if (node.isLeaf && node.isBlock && pos >= hunk.from && pos + node.nodeSize <= hunk.to) {
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'ai-del-node' }));
          }
          return true;
        });
      }
      decorations.push(
        Decoration.widget(hunk.to, (view) => hunkWidget(view, suggestion, hunk, active), {
          side: 1,
          key: `hunk-${hunk.id}-${active ? 1 : 0}`,
          ignoreSelection: true,
          stopEvent: () => true,
        }),
      );
    }
  }
  for (const item of state.tracked) {
    if (!item.visible) continue;
    if (item.from < item.to) decorations.push(Decoration.inline(item.from, item.to, { class: 'ai-target' }));
    decorations.push(
      Decoration.widget(item.to, () => previewWidget(item.id), {
        side: 1,
        key: `preview-${item.id}`,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

// ---------------------------------------------------------------------------
// Following edits
// ---------------------------------------------------------------------------

/** True if a change in this transaction falls inside the range. Edges do not count. */
function isTouched(tr: Transaction, from: number, to: number): boolean {
  let a = from;
  let b = to;
  for (const map of tr.mapping.maps) {
    let hit = false;
    map.forEach((oldStart, oldEnd) => {
      if (a === b ? oldStart <= a && oldEnd >= a : oldStart < b && oldEnd > a) hit = true;
    });
    if (hit) return true;
    a = map.map(a, 1);
    b = map.map(b, -1);
    if (b < a) b = a;
  }
  return false;
}

function mapRange(tr: Transaction, from: number, to: number): { from: number; to: number } {
  const start = tr.mapping.map(from, 1);
  const end = tr.mapping.map(to, -1);
  return { from: start, to: Math.max(start, end) };
}

function followEdits(state: Omit<SuggestionsState, 'decorations'>, tr: Transaction, ownAccept: boolean): Omit<SuggestionsState, 'decorations'> {
  const isUndo = tr.getMeta('history$') !== undefined;
  const suggestions = state.suggestions.map((suggestion) => {
    const hunksHit = suggestion.hunks.some((hunk) => isTouched(tr, hunk.from, hunk.to));
    // Undoing an accepted change touches the range but none of what is still pending.
    const staleNow = !ownAccept && (isUndo ? hunksHit : isTouched(tr, suggestion.from, suggestion.to) || hunksHit);
    const range = mapRange(tr, suggestion.from, suggestion.to);
    return {
      ...suggestion,
      ...range,
      stale: suggestion.stale || staleNow,
      hunks: suggestion.hunks.map((hunk) => ({ ...hunk, ...mapRange(tr, hunk.from, hunk.to) })),
    };
  });
  const tracked = state.tracked.map((item) => ({
    ...item,
    ...mapRange(tr, item.from, item.to),
    touched: item.touched || isTouched(tr, item.from, item.to),
  }));
  return { ...state, suggestions, tracked };
}

function reduce(state: Omit<SuggestionsState, 'decorations'>, action: Action): Omit<SuggestionsState, 'decorations'> {
  switch (action.type) {
    case 'add': {
      // A new suggestion replaces any older one over the same text, since it was made
      // from what was there and both cannot apply.
      const { from, to } = action.suggestion;
      const others = state.suggestions.filter((s) => s.to < from || s.from > to);
      const first = action.suggestion.hunks[0];
      return { ...state, suggestions: [...others, action.suggestion], activeHunk: first?.id ?? null };
    }
    case 'accepted':
    case 'reject': {
      const suggestions = state.suggestions
        .map((s) => (s.id === action.suggestionId ? { ...s, hunks: s.hunks.filter((h) => !action.hunkIds.includes(h.id)) } : s))
        .filter((s) => s.stale || s.hunks.length > 0);
      const remaining = suggestions.flatMap((s) => s.hunks);
      const activeStays = remaining.some((h) => h.id === state.activeHunk);
      return { ...state, suggestions, activeHunk: activeStays ? state.activeHunk : remaining[0]?.id ?? null };
    }
    case 'dismiss':
      return { ...state, suggestions: state.suggestions.filter((s) => s.id !== action.suggestionId) };
    case 'markCheckpointed':
      return {
        ...state,
        suggestions: state.suggestions.map((s) => (s.id === action.suggestionId ? { ...s, checkpointed: true } : s)),
      };
    case 'active':
      return { ...state, activeHunk: action.hunkId };
    case 'track':
      return { ...state, tracked: [...state.tracked, action.item] };
    case 'freshRead':
      return { ...state, tracked: state.tracked.map((t) => (t.id === action.id ? { ...t, touched: false } : t)) };
    case 'untrack':
      previews.delete(action.id);
      return { ...state, tracked: state.tracked.filter((t) => t.id !== action.id) };
  }
}

function dispatch(view: EditorView, action: Action): void {
  view.dispatch(view.state.tr.setMeta(suggestionsKey, action).setMeta('addToHistory', false));
}

// ---------------------------------------------------------------------------
// Coming back to a document
// ---------------------------------------------------------------------------

interface ParkedSuggestion extends Omit<Suggestion, 'hunks'> {
  hunks: { id: string; from: number; to: number; slice: unknown }[];
}

/**
 * Suggestions set aside when an editor closes. Navigating away and back should not throw
 * them out, and they only return if the document is exactly as it was.
 */
const parked = new Map<string, { doc: string; suggestions: ParkedSuggestion[] }>();

function parkingKey(source: EditorSource): string {
  return `${source.kind}:${source.id}`;
}

function restore(source: EditorSource, doc: ProseNode, schema: Schema): Suggestion[] {
  const saved = parked.get(parkingKey(source));
  if (!saved) return [];
  parked.delete(parkingKey(source));
  if (saved.doc !== JSON.stringify(doc.toJSON())) return [];
  return saved.suggestions.map((s) => ({
    ...s,
    hunks: s.hunks.map((h) => ({ ...h, slice: Slice.fromJSON(schema, h.slice as never) })),
  }));
}

function park(source: EditorSource, state: EditorState): void {
  const plugin = suggestionsKey.getState(state);
  if (!plugin || plugin.suggestions.length === 0) return;
  parked.set(parkingKey(source), {
    doc: JSON.stringify(state.doc.toJSON()),
    suggestions: plugin.suggestions.map((s) => ({
      ...s,
      hunks: s.hunks.map((h) => ({ ...h, slice: h.slice.toJSON() })),
    })),
  });
}

/** Forgets every set-aside suggestion. They belong to one project. */
export function clearParkedSuggestions(): void {
  parked.clear();
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

const sources = new WeakMap<EditorView, EditorSource>();

/** Exported for its tests. Editors get it through `AiSuggestions`. */
export function makePlugin(source: EditorSource): Plugin<SuggestionsState> {
  return new Plugin<SuggestionsState>({
    key: suggestionsKey,
    state: {
      init(_config, instance) {
        const base = {
          suggestions: instance.doc ? restore(source, instance.doc, instance.schema) : [],
          tracked: [],
          activeHunk: null,
        };
        return { ...base, decorations: buildDecorations(instance.doc, base) };
      },
      apply(tr, value, _old, newState) {
        const action = tr.getMeta(suggestionsKey) as Action | undefined;
        if (!tr.docChanged && !action) return value;
        const { decorations: _decorations, ...rest } = value;
        let next: Omit<SuggestionsState, 'decorations'> = rest;
        if (tr.docChanged) next = followEdits(next, tr, action?.type === 'accepted');
        if (action) next = reduce(next, action);
        return { ...next, decorations: buildDecorations(newState.doc, next) };
      },
    },
    props: {
      decorations: (state) => suggestionsKey.getState(state)?.decorations,
      attributes: (state): Record<string, string> => {
        const plugin = suggestionsKey.getState(state);
        const busy = (plugin?.suggestions.length ?? 0) > 0 || plugin?.tracked.some((t) => t.visible);
        return busy ? { class: 'has-ai-suggestion' } : {};
      },
    },
    view(view) {
      sources.set(view, source);
      return {
        destroy: () => park(source, view.state),
      };
    },
  });
}

export const AiSuggestions = Extension.create<{ source: EditorSource | null }>({
  name: 'aiSuggestions',
  addOptions() {
    return { source: null };
  },
  addProseMirrorPlugins() {
    const source = this.options.source;
    return source ? [makePlugin(source)] : [];
  },
  onCreate() {
    if (this.options.source) registerEditor(this.editor, this.options.source);
  },
  onFocus() {
    touchEditor(this.editor);
  },
  onSelectionUpdate() {
    touchEditor(this.editor);
  },
  onDestroy() {
    unregisterEditor(this.editor);
  },
});

// ---------------------------------------------------------------------------
// Using it
// ---------------------------------------------------------------------------

let nextId = 1;
function newId(prefix: string): string {
  nextId += 1;
  return `${prefix}${nextId}`;
}

export function suggestionsOf(editor: Editor): SuggestionsState | undefined {
  return editor.isDestroyed ? undefined : suggestionsKey.getState(editor.state);
}

export function pendingSuggestions(editor: Editor): Suggestion[] {
  return suggestionsOf(editor)?.suggestions ?? [];
}

/** Starts tracking a range. `visible` highlights it and gives it a preview area. */
export function trackRange(editor: Editor, from: number, to: number, visible: boolean): string {
  const id = newId('t');
  dispatch(editor.view, { type: 'track', item: { id, from, to, touched: false, visible } });
  return id;
}

export function trackedRange(editor: Editor, id: string): { from: number; to: number; touched: boolean } | null {
  const item = suggestionsOf(editor)?.tracked.find((t) => t.id === id);
  return item ? { from: item.from, to: item.to, touched: item.touched } : null;
}

export function untrack(editor: Editor, id: string): void {
  if (!editor.isDestroyed) dispatch(editor.view, { type: 'untrack', id });
}

/** The text in this range is about to be read, so only edits from now on count. */
export function markRead(editor: Editor, id: string): void {
  dispatch(editor.view, { type: 'freshRead', id });
}

/** Shows text as it streams in. This edits the preview directly, not the editor's state. */
export function setPreviewText(id: string, text: string): void {
  const element = previews.get(id);
  if (element) element.textContent = text;
}

export function addSuggestion(
  editor: Editor,
  fields: Pick<Suggestion, 'label' | 'from' | 'to' | 'hunks' | 'reply' | 'instruction'> & { stale?: boolean },
): string {
  const id = newId('sug');
  dispatch(editor.view, {
    type: 'add',
    suggestion: { ...fields, id, stale: fields.stale ?? false, checkpointed: false },
  });
  return id;
}

/** Saves what is typed so far, and records the document before an AI edit lands on it. */
async function checkpoint(source: EditorSource): Promise<void> {
  await flushOrStop();
  if (source.kind === 'page' || source.kind === 'node') {
    await api.revisions.checkpoint(source.kind, source.id, 'ai');
  }
}

/** A read-only view may not be wired to save, so an accepted edit there is written here. */
function saveIfNotEditing(view: EditorView, source: EditorSource): void {
  if (view.editable) return;
  const content = view.state.doc.toJSON() as PmNode;
  const saved =
    source.kind === 'page'
      ? api.pages.update(source.id, { content })
      : source.kind === 'node'
        ? api.nodes.update(source.id, { content })
        : Promise.resolve();
  void Promise.resolve(saved).catch((e: unknown) => toast(t('Could not save that change: {reason}', { reason: errorMessage(e) }), 'error'));
}

async function acceptFromView(view: EditorView, suggestionId: string, hunkIds: string[] | 'all'): Promise<boolean> {
  const source = sources.get(view);
  if (!source) return false;
  return applyAccept(view, source, suggestionId, hunkIds);
}

async function applyAccept(view: EditorView, source: EditorSource, suggestionId: string, hunkIds: string[] | 'all'): Promise<boolean> {
  const before = suggestionsKey.getState(view.state)?.suggestions.find((s) => s.id === suggestionId);
  if (!before || before.stale) return false;
  if (!before.checkpointed) {
    try {
      await checkpoint(source);
    } catch (e) {
      // Without the snapshot the promise of being able to go back is not kept, so stop.
      toast(t('The change was not applied, because a snapshot could not be saved first: {reason}', { reason: errorMessage(e) }), 'error');
      return false;
    }
    if (view.isDestroyed) return false;
    dispatch(view, { type: 'markCheckpointed', suggestionId });
  }
  // Read again: something may have changed during the wait.
  const current = suggestionsKey.getState(view.state)?.suggestions.find((s) => s.id === suggestionId);
  if (!current || current.stale) return false;
  const chosen = hunkIds === 'all' ? current.hunks : current.hunks.filter((h) => hunkIds.includes(h.id));
  if (chosen.length === 0) return false;

  const tr = view.state.tr;
  for (const hunk of [...chosen].sort((a, b) => b.from - a.from || b.to - a.to)) {
    tr.replace(hunk.from, hunk.to, hunk.slice);
  }
  tr.setMeta(suggestionsKey, { type: 'accepted', suggestionId, hunkIds: chosen.map((h) => h.id) } satisfies Action);
  view.dispatch(tr);
  saveIfNotEditing(view, source);
  return true;
}

/** Applies changes to the document, as one undoable step. */
export function acceptChanges(editor: Editor, source: EditorSource, suggestionId: string, hunkIds: string[] | 'all' = 'all'): Promise<boolean> {
  return applyAccept(editor.view, source, suggestionId, hunkIds);
}

export function rejectChanges(editor: Editor, suggestionId: string, hunkIds: string[] | 'all' = 'all'): void {
  const suggestion = pendingSuggestions(editor).find((s) => s.id === suggestionId);
  if (!suggestion) return;
  dispatch(editor.view, {
    type: 'reject',
    suggestionId,
    hunkIds: hunkIds === 'all' ? suggestion.hunks.map((h) => h.id) : hunkIds,
  });
}

export function dismissSuggestion(editor: Editor, suggestionId: string): void {
  dispatch(editor.view, { type: 'dismiss', suggestionId });
}

function allHunks(editor: Editor): { suggestion: Suggestion; hunk: Hunk }[] {
  return pendingSuggestions(editor)
    .filter((s) => !s.stale)
    .flatMap((suggestion) => suggestion.hunks.map((hunk) => ({ suggestion, hunk })))
    .sort((a, b) => a.hunk.from - b.hunk.from);
}

export function activeChange(editor: Editor): { suggestion: Suggestion; hunk: Hunk } | null {
  const all = allHunks(editor);
  const active = suggestionsOf(editor)?.activeHunk;
  return all.find((item) => item.hunk.id === active) ?? all[0] ?? null;
}

/** Moves to the next or previous change and brings it into view. */
export function stepChange(editor: Editor, direction: 1 | -1): void {
  const all = allHunks(editor);
  if (all.length === 0) return;
  const current = all.findIndex((item) => item.hunk.id === suggestionsOf(editor)?.activeHunk);
  const next = all[(current + direction + all.length) % all.length];
  dispatch(editor.view, { type: 'active', hunkId: next.hunk.id });
  const element = editor.view.dom.querySelector(`[data-hunk="${next.hunk.id}"]`);
  element?.scrollIntoView({ block: 'center' });
}
