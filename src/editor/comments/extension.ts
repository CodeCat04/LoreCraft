/**
 * Comments inside an editor: highlights for their text, the text being commented on, and
 * which comment is active. All of it is decoration, so none of it touches the document
 * except adding and removing a comment's mark, which are not undoable steps of their own.
 */

import { Extension, type Editor } from '@tiptap/core';
import { Fragment, Slice, type Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { addCommentMark, commentRanges, COMMENT_MARK, removeCommentMark, type TextRange } from './anchor';

export interface CommentPluginState {
  /** Comments whose text is highlighted. */
  open: ReadonlySet<string>;
  /** Every comment belonging to this document, in any state. */
  known: ReadonlySet<string>;
  active: string | null;
  /** The text a new comment is being written about. */
  pending: TextRange | null;
  decorations: DecorationSet;
}

type Change = Partial<Pick<CommentPluginState, 'open' | 'known' | 'active' | 'pending'>>;

export const commentKey = new PluginKey<CommentPluginState>('comments');

const NOTHING: ReadonlySet<string> = new Set();

function buildDecorations(doc: ProseNode, state: Omit<CommentPluginState, 'decorations'>): DecorationSet {
  const { open, active, pending } = state;
  if (open.size === 0 && !active && !pending) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    let shown = 0;
    let isActive = false;
    for (const mark of node.marks) {
      if (mark.type.name !== COMMENT_MARK) continue;
      const id = String(mark.attrs.id);
      if (open.has(id) || id === active) shown += 1;
      if (id === active) isActive = true;
    }
    if (shown > 0) {
      const classes = ['comment-range'];
      if (shown > 1) classes.push('is-overlap');
      if (isActive) classes.push('is-active');
      decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: classes.join(' ') }));
    }
    return false;
  });
  if (pending && pending.to > pending.from) {
    decorations.push(Decoration.inline(pending.from, pending.to, { class: 'comment-pending' }));
  }
  return DecorationSet.create(doc, decorations);
}

/** Takes comment marks off pasted text, except a comment being moved within its document. */
export function cleanPasted(slice: Slice, keep: (id: string) => boolean): Slice {
  let changed = false;
  const clean = (fragment: Fragment): Fragment => {
    const children: ProseNode[] = [];
    fragment.forEach((node) => {
      let next = node;
      if (node.isInline) {
        const marks = node.marks.filter((m) => m.type.name !== COMMENT_MARK || keep(String(m.attrs.id)));
        if (marks.length !== node.marks.length) {
          changed = true;
          next = node.mark(marks);
        }
      } else if (node.content.size > 0) {
        next = node.copy(clean(node.content));
      }
      children.push(next);
    });
    return Fragment.fromArray(children);
  };
  const content = clean(slice.content);
  return changed ? new Slice(content, slice.openStart, slice.openEnd) : slice;
}

const saves = new WeakMap<Editor, () => boolean>();

/** Whether changes to this editor's document reach storage. A read-only copy's do not. */
export function editorSaves(editor: Editor): boolean {
  return saves.get(editor)?.() ?? false;
}

export interface CommentOptions {
  /** Whether this editor writes its changes anywhere. */
  canSave: () => boolean;
}

export const Comments = Extension.create<CommentOptions>({
  name: 'comments',
  // Ahead of the default key bindings, for the shortcut below.
  priority: 1200,
  addOptions() {
    return { canSave: () => false };
  },
  onBeforeCreate() {
    saves.set(this.editor, this.options.canSave);
  },
  addKeyboardShortcuts() {
    return {
      // Ctrl+Alt+C adds a comment. Without this it would also make the line a code block.
      'Mod-Alt-c': () => true,
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<CommentPluginState>({
        key: commentKey,
        state: {
          init: (_config, state) => {
            const base = { open: NOTHING, known: NOTHING, active: null, pending: null };
            return { ...base, decorations: buildDecorations(state.doc, base) };
          },
          apply: (tr, value) => {
            const change = tr.getMeta(commentKey) as Change | undefined;
            if (!change && !tr.docChanged) return value;
            let pending = value.pending;
            if (pending && tr.docChanged) {
              pending = { from: tr.mapping.map(pending.from, 1), to: tr.mapping.map(pending.to, -1) };
            }
            const next = { open: value.open, known: value.known, active: value.active, pending, ...change };
            return { ...next, decorations: buildDecorations(tr.doc, next) };
          },
        },
        props: {
          decorations: (state) => commentKey.getState(state)?.decorations,
          handleClick: (view, _pos, event) => {
            const state = commentKey.getState(view.state);
            if (!state) return false;
            const target = (event.target as HTMLElement).closest?.('[data-comment-id]');
            let id: string | null = null;
            // The innermost open one, when comments overlap.
            for (let el = target; el; el = el.parentElement?.closest('[data-comment-id]') ?? null) {
              const found = el.getAttribute('data-comment-id');
              if (found && state.open.has(found)) {
                id = found;
                break;
              }
            }
            if (id !== state.active) view.dispatch(view.state.tr.setMeta(commentKey, { active: id }).setMeta('addToHistory', false));
            return false;
          },
          transformPasted: (slice, view) => {
            const state = commentKey.getState(view.state);
            // Dragging moves the text, and until the drop it is still in the document.
            if (view.dragging?.move) return slice;
            const inDocument = commentRanges(view.state.doc);
            return cleanPasted(slice, (id) => !!state?.known.has(id) && !inDocument.has(id));
          },
        },
      }),
    ];
  },
});

function change(editor: Editor, value: Change) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(commentKey, value).setMeta('addToHistory', false));
}

export function commentState(editor: Editor): CommentPluginState | undefined {
  return editor.isDestroyed ? undefined : commentKey.getState(editor.state);
}

/** Tells the editor which comments exist and which of them to highlight. */
export function setKnownComments(editor: Editor, known: ReadonlySet<string>, open: ReadonlySet<string>) {
  change(editor, { known, open });
}

export function setActiveComment(editor: Editor, id: string | null) {
  change(editor, { active: id });
}

export function setPendingComment(editor: Editor, range: TextRange | null) {
  change(editor, { pending: range });
}

/** Adds a comment's mark. It is not a step of its own in the undo history. */
export function markComment(editor: Editor, id: string, from: number, to: number) {
  const { tr } = editor.state;
  addCommentMark(tr, id, from, to);
  editor.view.dispatch(tr.setMeta('addToHistory', false));
}

export function unmarkComment(editor: Editor, id: string) {
  const { tr } = editor.state;
  removeCommentMark(tr, id);
  if (tr.docChanged) editor.view.dispatch(tr.setMeta('addToHistory', false));
}

/** The nearest parent that scrolls. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Brings a place in the document to the middle of what can be seen, without selecting it.
 * If it can be seen already nothing moves, so what was just clicked stays under the pointer.
 */
export function scrollToPos(editor: Editor, pos: number) {
  if (editor.isDestroyed) return;
  const { view } = editor;
  const scroller = scrollParent(view.dom);
  if (!scroller) return;
  try {
    const at = view.coordsAtPos(Math.min(pos, view.state.doc.content.size));
    const box = scroller.getBoundingClientRect();
    if (at.top >= box.top && at.bottom <= box.bottom) return;
    scroller.scrollTop += at.top - (box.top + box.height / 2);
  } catch {
    // The position no longer exists, so there is nowhere to go.
  }
}

/** Highlights a comment's text and brings it into view. */
export function showComment(editor: Editor, id: string) {
  setActiveComment(editor, id);
  const [first] = commentRanges(editor.state.doc).get(id) ?? [];
  if (first) scrollToPos(editor, first.from);
}

/**
 * Starts a comment on the selection, or on the word at the cursor. False if there is
 * nothing there to comment on.
 */
export function startComment(editor: Editor): boolean {
  if (editor.isDestroyed || !commentState(editor)) return false;
  const { selection, doc } = editor.state;
  let { from, to } = selection;
  if (selection.empty) {
    const $from = selection.$from;
    if (!$from.parent.isTextblock) return false;
    const text = $from.parent.textBetween(0, $from.parent.content.size, undefined, '￼');
    const offset = $from.parentOffset;
    let start = offset;
    let end = offset;
    const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}'’\-]/u.test(c);
    while (isWord(text[start - 1])) start -= 1;
    while (isWord(text[end])) end += 1;
    if (start === end) return false;
    from = $from.start() + start;
    to = $from.start() + end;
  }
  if (!doc.textBetween(from, to, ' ', ' ').trim()) return false;
  // The highlight takes over from the selection, and the writer's place stays put.
  editor.view.dispatch(
    editor.state.tr
      .setSelection(TextSelection.create(doc, to))
      .setMeta(commentKey, { pending: { from, to } })
      .setMeta('addToHistory', false),
  );
  return true;
}
