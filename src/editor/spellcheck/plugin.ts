/**
 * Draws misspellings in the editor. Finding them happens in a worker. This side keeps
 * typing cheap in three ways: a keystroke only remaps existing underlines, checks run
 * only after a pause, and a block is looked at only if its node object is new, which in
 * ProseMirror means its content actually changed.
 */

import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { writingLanguage } from '../../state/language';
import { useSettings } from '../../state/settings';
import '../../styles/extras.css';
import { blockText } from './blockText';
import { spellClient } from './client';
import type { SpellRange } from './engine';
import { closeSpellMenu, openSpellMenu, type MisspelledWord } from './menu';

/** How long typing must pause before a changed paragraph is checked. */
const CHECK_DELAY_MS = 250;

interface BlockUpdate {
  from: number;
  to: number;
  ranges: SpellRange[];
}

type SpellMeta = { updates: BlockUpdate[] } | { clear: true } | { refresh: true };

const key = new PluginKey<DecorationSet>('spellcheck');

function makeDecoration(from: number, to: number): Decoration {
  return Decoration.inline(
    from,
    to,
    { class: 'spell-error', 'aria-invalid': 'spelling' },
    { spell: true, inclusiveStart: false, inclusiveEnd: false },
  );
}

function applyUpdates(set: DecorationSet, doc: ProseNode, updates: BlockUpdate[]): DecorationSet {
  const stale: Decoration[] = [];
  const fresh: Decoration[] = [];
  for (const { from, to, ranges } of updates) {
    stale.push(...set.find(from, to));
    for (const [a, b] of ranges) fresh.push(makeDecoration(from + a, from + b));
  }
  return set.remove(stale).add(doc, fresh);
}

/** Whether a block already shows exactly these underlines. */
function sameDecorations(set: DecorationSet, update: BlockUpdate): boolean {
  const current = set.find(update.from, update.to);
  if (current.length !== update.ranges.length) return false;
  const expected = new Set(update.ranges.map(([a, b]) => `${update.from + a}:${update.from + b}`));
  return current.every((deco) => expected.has(`${deco.from}:${deco.to}`));
}

class SpellView {
  private view: EditorView;
  private timer: number | undefined;
  private refreshTimer: number | undefined;
  /**
   * Blocks whose underlines are up to date, against which word list version, and how many
   * there are. The count matters because a node object can come back without its
   * underlines: undo restores the very object that was deleted, and a block can be copied
   * by reusing its object.
   */
  private done = new WeakMap<ProseNode, { version: number; count: number }>();
  /** The caret is touching a misspelling that is not drawn yet. */
  private holding = false;
  private wasWanted = false;
  /** What the `spellcheck` attribute last said, since only a view update changes it. */
  private nativeShown: boolean;
  /** What the `lang` attribute last said, for the same reason. */
  private langShown: string;
  private unsubscribe: (() => void)[] = [];

  constructor(view: EditorView) {
    this.view = view;
    this.nativeShown = spellClient.useNativeFallback();
    this.langShown = writingLanguage();
    this.unsubscribe.push(spellClient.subscribe(() => this.refresh()));
    this.unsubscribe.push(
      useSettings.subscribe((state, previous) => {
        if (state.settings.editor.spellcheck !== previous.settings.editor.spellcheck) this.refresh();
      }),
    );
    // Lets end-to-end tests measure the cost of checking.
    (view.dom as unknown as { spellStats?: () => unknown }).spellStats = () => spellClient.statsSnapshot();
    // The view is still being built, so nothing can be dispatched from here.
    this.wasWanted = this.isWanted();
    if (this.wasWanted) this.schedule(0);
  }

  update(view: EditorView, previous: EditorState) {
    const wanted = this.isWanted();
    if (wanted !== this.wasWanted) {
      // Dispatching from inside a view update is not safe, so this waits for it to end.
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => this.refresh(), 0);
      return;
    }
    if (!wanted) return;
    if (view.state.doc !== previous.doc) this.schedule(CHECK_DELAY_MS);
    else if (this.holding && !view.state.selection.eq(previous.selection)) this.schedule(0);
  }

  destroy() {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.refreshTimer);
    this.unsubscribe.forEach((stop) => stop());
    closeSpellMenu();
  }

  private isWanted(): boolean {
    return this.view.editable && spellClient.isActive();
  }

  /** Brings everything in line with the setting, the checker's state and the word list. */
  private refresh() {
    const { view } = this;
    if (view.isDestroyed) return;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.refreshTimer);
    const wanted = this.isWanted();
    this.wasWanted = wanted;
    if (wanted) {
      this.schedule(0);
    } else {
      this.done = new WeakMap();
      this.holding = false;
    }
    const native = spellClient.useNativeFallback();
    const lang = writingLanguage();
    const hasMarks = key.getState(view.state) !== DecorationSet.empty;
    if (!wanted && hasMarks) this.dispatch({ clear: true });
    else if (native !== this.nativeShown || lang !== this.langShown) this.dispatch({ refresh: true });
    this.nativeShown = native;
    this.langShown = lang;
  }

  private dispatch(meta: SpellMeta) {
    const { view } = this;
    view.dispatch(view.state.tr.setMeta(key, meta).setMeta('addToHistory', false));
  }

  private schedule(delay: number) {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.reconcile(), delay);
  }

  /** Draws what is known and asks the worker about the rest. */
  private reconcile() {
    const { view } = this;
    if (view.isDestroyed || !this.isWanted()) return;
    // Started here rather than earlier, because a failed start updates this view.
    spellClient.start();
    if (!this.isWanted()) return;
    // Redrawing under an input method can break the text being composed.
    if (view.composing) {
      this.schedule(CHECK_DELAY_MS);
      return;
    }
    const started = performance.now();
    const version = spellClient.version();
    const { doc, selection } = view.state;
    const set = key.getState(view.state) ?? DecorationSet.empty;
    const updates: BlockUpdate[] = [];
    const unknown = new Set<string>();
    let holding = false;

    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      const from = pos + 1;
      const to = pos + 1 + node.content.size;
      const record = this.done.get(node);
      if (record?.version === version && (record.count === 0 || set.find(from, to).length === record.count)) {
        return false;
      }
      if (node.type.spec.code) {
        this.done.set(node, { version, count: 0 });
        const update = { from, to, ranges: [] };
        if (!sameDecorations(set, update)) updates.push(update);
        return false;
      }
      const text = blockText(node);
      const found = spellClient.lookup(text);
      if (!found) {
        unknown.add(text);
        return false;
      }
      // A word being typed is not wrong yet. Its underline waits for the caret to leave.
      // One that already has an underline keeps it, or clicking into a word could hide
      // the underline, and with it the menu, that the click was aiming for.
      let ranges = found;
      let held = false;
      if (selection.empty && view.hasFocus() && selection.$head.parent === node) {
        const caret = selection.$head.parentOffset;
        const shown = set.find(from, to);
        const isShown = (a: number, b: number) =>
          shown.some((deco) => deco.from === from + a && deco.to === from + b);
        ranges = found.filter(([a, b]) => !(a < caret && caret <= b) || isShown(a, b));
        held = ranges.length !== found.length;
      }
      if (held) holding = true;
      else this.done.set(node, { version, count: ranges.length });
      const update = { from, to, ranges };
      if (!sameDecorations(set, update)) updates.push(update);
      return false;
    });

    this.holding = holding;
    if (updates.length > 0) this.dispatch({ updates });
    spellClient.noteMainThreadWork(performance.now() - started);
    if (unknown.size > 0) {
      void spellClient.check([...unknown]).then(() => {
        if (!view.isDestroyed) this.schedule(0);
      });
    }
  }
}

function misspellingAt(view: EditorView, pos: number): MisspelledWord | null {
  const set = key.getState(view.state);
  const decoration = set?.find(pos, pos, (spec) => spec.spell === true)[0];
  if (!decoration) return null;
  const { from, to } = decoration;
  return { from, to, word: view.state.doc.textBetween(from, to) };
}

/** Underlines misspellings, with a menu of fixes on right-click. */
export const spellcheck = Extension.create({
  name: 'spellcheck',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set) => {
            const meta = tr.getMeta(key) as SpellMeta | undefined;
            if (meta && 'clear' in meta) return DecorationSet.empty;
            const mapped = tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
            if (meta && 'updates' in meta) return applyUpdates(mapped, tr.doc, meta.updates);
            return mapped;
          },
        },
        view: (view) => new SpellView(view),
        props: {
          decorations: (state) => key.getState(state),
          // Two sets of underlines would be worse than either. The browser's own checker
          // is only on as the fallback for when the custom one cannot run.
          // The language also picks the right forms of Han characters, which differ between
          // Chinese and Japanese.
          attributes: () => ({ spellcheck: String(spellClient.useNativeFallback()), lang: writingLanguage() }),
          handleDOMEvents: {
            contextmenu: (view, event) => {
              if (!view.editable) return false;
              const element = (event.target as HTMLElement | null)?.closest?.('.spell-error');
              // A click elsewhere is not about the word the caret happens to be in.
              if (!element && event.button === 2) return false;
              // A menu opened from the keyboard has no target word, so it uses the caret.
              const pos = element ? view.posAtDOM(element, 0) : view.state.selection.head;
              const target = misspellingAt(view, pos);
              if (!target) return false;
              event.preventDefault();
              let { clientX: x, clientY: y } = event;
              if (!element) {
                const caret = view.coordsAtPos(pos);
                x = caret.left;
                y = caret.bottom;
              }
              openSpellMenu(view, target, x, y);
              return true;
            },
          },
        },
      }),
    ];
  },
});
