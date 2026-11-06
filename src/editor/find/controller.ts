/**
 * One editor's Find session: the search, the current match, and replacing. It lives outside
 * React, and the find bar only redraws when the count changes, so typing in the box re-renders
 * neither the document nor the app around it.
 */

import type { Editor } from '@tiptap/core';
import { DecorationSet } from '@tiptap/pm/view';

import { findAnchor, highlights, setFindMeta } from './extension';
import { positionAfterReplacing, replaceAllMatches, replaceMatch } from './replace';
import { drawnSpan, findMatches, nextMatchFrom, seedFromSelection, type FindMatch, type FindOptions } from './search';

/** Long enough to skip the searches for a word still being typed. */
const SEARCH_DELAY_MS = 90;
/** After an edit in the document. Writing with the bar open should cost nothing. */
const RESEARCH_DELAY_MS = 220;
/** More highlights than this on screen would slow the document down for no benefit. */
const MAX_DRAWN = 1500;

export interface FindSnapshot {
  open: boolean;
  /** The query has been searched for. False while it waits, so the count is not misread. */
  settled: boolean;
  total: number;
  /** Index of the current match, or -1. */
  current: number;
  matchCase: boolean;
  wholeWord: boolean;
  /** Changes each time the box should take the keyboard. */
  focusRequest: number;
  /** Whether to open with the replace row showing. */
  replaceRequested: boolean;
  /** Set when opening seeds the box, for the bar to show. */
  query: string;
}

const CLOSED: FindSnapshot = {
  open: false,
  settled: true,
  total: 0,
  current: -1,
  matchCase: false,
  wholeWord: false,
  focusRequest: 0,
  replaceRequested: false,
  query: '',
};

/** The options people use once tend to be what they want next time, for this run of the app. */
let remembered = { query: '', matchCase: false, wholeWord: false };

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === 'auto' || overflowY === 'scroll') return parent;
  }
  return null;
}

function isShown(editor: Editor): boolean {
  return !editor.isDestroyed && editor.view.dom.isConnected && editor.view.dom.getClientRects().length > 0;
}

/** How much of this editor is on screen, in pixels of height. */
function visibleHeight(editor: Editor): number {
  const box = editor.view.dom.getBoundingClientRect();
  const port = scrollParent(editor.view.dom)?.getBoundingClientRect();
  const top = Math.max(box.top, port?.top ?? 0);
  const bottom = Math.min(box.bottom, port?.bottom ?? window.innerHeight);
  return Math.max(0, bottom - top);
}

export class FindController {
  private snapshot: FindSnapshot = { ...CLOSED };
  private readonly listeners = new Set<() => void>();
  private options: FindOptions = { query: '', matchCase: false, wholeWord: false };
  private matches: FindMatch[] = [];
  private current = -1;
  /** What a search waiting on its timer is for, if one is. */
  private pending: 'query' | 'document' | null = null;
  /** The current match has not been shown yet, so the next step only has to show it. */
  private unseen = false;
  private timer: number | undefined;
  private drawn: { from: number; to: number } | null = null;
  private frame = 0;
  private scroller: HTMLElement | null = null;
  private returnTo: {
    focus: HTMLElement | null;
    selection: Editor['state']['selection'];
    doc: Editor['state']['doc'];
    scrollTop: number;
  } | null = null;

  constructor(readonly editor: Editor) {}

  // ---- For the bar ------------------------------------------------------------

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  get isOpen(): boolean {
    return this.snapshot.open;
  }

  get scrollContainer(): HTMLElement | null {
    return this.scroller;
  }

  private publish(patch: Partial<FindSnapshot> = {}) {
    this.snapshot = {
      ...this.snapshot,
      total: this.matches.length,
      current: this.current,
      matchCase: this.options.matchCase,
      wholeWord: this.options.wholeWord,
      settled: !this.pending,
      ...patch,
    };
    this.listeners.forEach((listener) => listener());
  }

  // ---- Opening and closing ----------------------------------------------------

  /** Opens the bar, or takes the keyboard back to it if it is already open. */
  open(options: { replace?: boolean } = {}) {
    const { view, state } = this.editor;
    if (openController && openController !== this) openController.close(false);
    openController = this;
    const wasOpen = this.snapshot.open;
    if (!wasOpen) {
      this.scroller = scrollParent(view.dom);
      this.returnTo = {
        focus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        selection: state.selection,
        doc: state.doc,
        scrollTop: this.scroller?.scrollTop ?? 0,
      };
      this.options = { ...remembered };
      this.scroller?.addEventListener('scroll', this.onScroll, { passive: true });
      this.setAnchor(this.startingPoint());
    }
    // Selected text is what the writer means to look for, as in every other editor.
    const { from, to, empty } = state.selection;
    const seed = empty ? null : seedFromSelection(state.doc.textBetween(from, to, '\n', '￼'));
    if (seed !== null) {
      this.options = { ...this.options, query: seed };
      remembered = { ...this.options };
      this.setAnchor(from);
    }
    this.publish({
      open: true,
      query: this.options.query,
      focusRequest: this.snapshot.focusRequest + 1,
      replaceRequested: !!options.replace,
    });
    // Opening highlights what is there without moving the page, since the writer may be
    // about to type something else. The first Enter goes to the match if it is out of sight.
    if (!wasOpen || seed !== null) {
      this.refresh();
      this.unseen = seed === null && this.current >= 0;
    }
  }

  /** The cursor when editing. When reading, the top of what is on screen. */
  private startingPoint(): number {
    const { view, state, isEditable } = this.editor;
    if (isEditable && view.hasFocus()) return state.selection.from;
    const range = this.visibleRange();
    return range ? range.from : state.selection.from;
  }

  /**
   * Closes the bar. `giveBack` returns the keyboard to where it was, with the cursor where it
   * was, unless the writer has since put the cursor somewhere else themselves.
   */
  close(giveBack = true) {
    if (!this.snapshot.open) return;
    // Anywhere else, the keyboard has already moved on by itself and is left there.
    const active = document.activeElement;
    const barHasKeyboard = active === document.body || !!active?.closest('.find-bar');
    window.clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pending = null;
    this.scroller?.removeEventListener('scroll', this.onScroll);
    if (openController === this) openController = null;
    this.matches = [];
    this.current = -1;
    this.drawn = null;
    this.publish({ open: false });

    const { editor } = this;
    if (editor.isDestroyed) return;
    editor.view.dispatch(setFindMeta(editor.state.tr, { decorations: DecorationSet.empty }));
    const place = this.returnTo;
    this.returnTo = null;
    if (giveBack && barHasKeyboard && place) this.giveBack(place);
  }

  private giveBack(place: NonNullable<FindController['returnTo']>) {
    const { view, state, isEditable } = this.editor;
    // Opened from a menu or the palette, what had the keyboard has gone.
    const earlier = place.focus?.isConnected && place.focus !== document.body ? place.focus : null;
    if (earlier && !view.dom.contains(earlier) && earlier.matches('input, textarea, select')) {
      earlier.focus({ preventScroll: true });
      return;
    }
    if (isEditable) {
      const untouched = state.doc === place.doc && state.selection.eq(place.selection);
      view.focus();
      if (untouched && this.scroller) this.scroller.scrollTop = place.scrollTop;
      else view.dispatch(state.tr.scrollIntoView());
      return;
    }
    // When reading, keys such as Page Down should keep scrolling this page.
    (earlier ?? view.dom.closest<HTMLElement>('[tabindex]'))?.focus({ preventScroll: true });
  }

  // ---- Searching --------------------------------------------------------------

  setQuery(query: string) {
    this.update({ ...this.options, query }, query ? SEARCH_DELAY_MS : 0);
  }

  toggleCase() {
    this.update({ ...this.options, matchCase: !this.options.matchCase }, 0);
  }

  toggleWholeWord() {
    this.update({ ...this.options, wholeWord: !this.options.wholeWord }, 0);
  }

  private update(options: FindOptions, delay: number) {
    this.options = options;
    remembered = { ...options };
    this.schedule(delay);
  }

  private schedule(delay: number) {
    window.clearTimeout(this.timer);
    if (delay === 0) {
      this.search();
      return;
    }
    const wasSettled = this.pending === null;
    this.pending = 'query';
    // Once per word rather than once per key, since nothing else about the bar has changed.
    if (wasSettled) this.publish();
    this.timer = window.setTimeout(() => this.search(), delay);
  }

  /** Runs the search from where it had got to, and shows the match it lands on. */
  private search() {
    this.refresh();
    this.unseen = false;
    this.reveal();
  }

  /** As `search`, but does not move the page, because the writer is working somewhere. */
  private refresh() {
    window.clearTimeout(this.timer);
    this.pending = null;
    const { state } = this.editor;
    this.matches = findMatches(state.doc, this.options);
    this.current = nextMatchFrom(this.matches, findAnchor(state));
    this.draw();
    this.publish();
  }

  /** The document changed, so the matches may have. Only the highlights have moved so far. */
  documentChanged() {
    if (!this.snapshot.open) return;
    window.clearTimeout(this.timer);
    this.pending = 'document';
    this.timer = window.setTimeout(() => this.refresh(), RESEARCH_DELAY_MS);
  }

  /** Goes to the next or previous match, around the ends. */
  step(direction: 1 | -1) {
    // A search still waiting lands on the first match, and that was the point of the key.
    if (this.pending === 'query') {
      this.search();
      return;
    }
    if (this.pending === 'document') this.refresh();
    const total = this.matches.length;
    if (total === 0) return;
    const landOnly = this.unseen && direction === 1 && !this.currentIsInView();
    this.unseen = false;
    if (landOnly) {
      this.reveal();
      return;
    }
    this.current = (this.current + direction + total) % total;
    this.setAnchor(this.matches[this.current].from);
    this.draw();
    this.reveal();
    this.publish();
  }

  private setAnchor(anchor: number) {
    const { view, state } = this.editor;
    view.dispatch(setFindMeta(state.tr, { anchor }));
  }

  // ---- Showing ----------------------------------------------------------------

  /** What is on screen, as document positions. */
  private visibleRange(): { from: number; to: number } | null {
    const { view } = this.editor;
    const box = view.dom.getBoundingClientRect();
    const port = this.scroller?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const top = Math.max(box.top, port.top);
    const bottom = Math.min(box.bottom, port.bottom);
    if (bottom <= top) return null;
    const left = box.left + 2;
    const start = view.posAtCoords({ left, top: top + 1 });
    const end = view.posAtCoords({ left, top: bottom - 1 });
    if (!start || !end) return null;
    return { from: start.pos, to: end.pos };
  }

  private draw() {
    const { editor, matches, current } = this;
    const { state, view } = editor;
    if (matches.length <= MAX_DRAWN) {
      // All of them, so scrolling has nothing to do.
      this.drawn = null;
      view.dispatch(setFindMeta(state.tr, { decorations: highlights(state, matches, 0, matches.length, current) }));
      return;
    }
    const around = current >= 0 ? matches[current].from : 0;
    const visible = this.visibleRange() ?? { from: around, to: around };
    // A screenful to each side, so highlights are ready before they scroll into view.
    const reach = Math.max(visible.to - visible.from, 2000);
    const range = { from: visible.from - reach, to: visible.to + reach };
    const { start, end } = drawnSpan(matches, range, visible.from, MAX_DRAWN);
    this.drawn = range;
    view.dispatch(setFindMeta(state.tr, { decorations: highlights(state, matches, start, end, current) }));
  }

  private readonly onScroll = () => {
    if (!this.drawn || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.drawn || this.pending || this.editor.isDestroyed) return;
      const visible = this.visibleRange();
      if (!visible) return;
      // Redrawn before the edge of what has been drawn comes into view.
      const reach = (this.drawn.to - this.drawn.from) / 3;
      const nearEdge = visible.from - this.drawn.from < reach / 2 || this.drawn.to - visible.to < reach / 2;
      if (nearEdge) this.draw();
    });
  };

  /** The current match's place on screen, and the part of the screen free to show it. */
  private currentPlacement(): { box: DOMRect; port: DOMRect; inView: boolean } | null {
    const element = this.current < 0 ? null : this.editor.view.dom.querySelector('.find-match-current');
    if (!element || !this.scroller) return null;
    const box = element.getBoundingClientRect();
    const port = this.scroller.getBoundingClientRect();
    const covered = document.querySelector('.find-bar')?.getBoundingClientRect().bottom ?? port.top;
    const margin = 16;
    return { box, port, inView: box.top >= Math.max(port.top, covered) + margin && box.bottom <= port.bottom - margin };
  }

  private currentIsInView(): boolean {
    return this.currentPlacement()?.inView ?? false;
  }

  /** Brings the current match into view, leaving the page alone if it can already be seen. */
  private reveal() {
    const placement = this.currentPlacement();
    if (!placement || placement.inView || !this.scroller) return;
    this.scroller.scrollTop += placement.box.top - (placement.port.top + placement.port.height / 2);
  }

  // ---- Replacing --------------------------------------------------------------

  /** Replaces the current match and moves to the next. One undo step. */
  replaceCurrent(text: string) {
    if (!this.editor.isEditable) return;
    if (this.pending) this.refresh();
    const match = this.matches[this.current];
    if (!match) return;
    const { view, state } = this.editor;
    const tr = state.tr;
    replaceMatch(tr, match, text);
    setFindMeta(tr, { anchor: match.from + text.length });
    view.dispatch(tr);
    this.search();
  }

  /** Replaces every match in one undo step. Returns how many were replaced. */
  replaceAll(text: string): number {
    if (!this.editor.isEditable) return 0;
    if (this.pending) this.refresh();
    const { matches } = this;
    if (matches.length === 0) return 0;
    const { view, state } = this.editor;
    const tr = state.tr;
    replaceAllMatches(tr, matches, text);
    setFindMeta(tr, { anchor: positionAfterReplacing(findAnchor(state), matches, text.length) });
    view.dispatch(tr);
    this.search();
    return matches.length;
  }
}

// ---------------------------------------------------------------------------
// Which editor
// ---------------------------------------------------------------------------

const controllers = new WeakMap<Editor, FindController>();
const editors = new Set<Editor>();
const lastUsed = new WeakMap<Editor, number>();
let clock = 0;
let openController: FindController | null = null;

export function controllerFor(editor: Editor): FindController {
  let controller = controllers.get(editor);
  if (!controller) {
    controller = new FindController(editor);
    controllers.set(editor, controller);
  }
  return controller;
}

export function noteEditorCreated(editor: Editor) {
  editors.add(editor);
}

export function noteEditorUsed(editor: Editor) {
  clock += 1;
  lastUsed.set(editor, clock);
}

export function forgetEditor(editor: Editor) {
  editors.delete(editor);
  const controller = controllers.get(editor);
  if (controller?.isOpen) controller.close(false);
}

/** The controller of the open bar, if it can be seen. */
export function openFind(): FindController | null {
  return openController && isShown(openController.editor) ? openController : null;
}

/**
 * The editor Ctrl+F means: the one with the keyboard, then one whose bar is open, then the
 * one last worked in if it is on screen, then whichever shows the most. Editors on a tab
 * that is not showing do not count.
 */
export function currentFindEditor(): Editor | null {
  const shown = [...editors].filter(isShown);
  const active = document.activeElement;
  const focused = shown.find((editor) => editor.view.dom.contains(active));
  if (focused) return focused;
  const open = openFind();
  if (open) return open.editor;
  const seen = shown
    .map((editor) => ({ editor, height: visibleHeight(editor) }))
    .filter((entry) => entry.height > 0)
    .sort((a, b) => (lastUsed.get(b.editor) ?? 0) - (lastUsed.get(a.editor) ?? 0) || b.height - a.height);
  return seen[0]?.editor ?? shown[0] ?? null;
}

/** Opens Find on the current editor. False if there is no editor to find in. */
export function openFindInCurrentEditor(options: { replace?: boolean } = {}): boolean {
  // Everything behind a dialog is out of reach. The palette counts as gone, because it is
  // on its way out when it runs a command.
  if (document.querySelector('.dialog-backdrop:not(.palette-backdrop)')) return true;
  const editor = currentFindEditor();
  if (!editor) return false;
  controllerFor(editor).open(options);
  return true;
}
