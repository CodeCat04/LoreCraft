/**
 * Marks known page names in manuscript text with a dotted underline and
 * `data-wiki-target`, which the wiki's hover card picks up by event delegation. Ctrl+click
 * follows a name to its page.
 *
 * Only the blocks an edit touched are scanned again. Everything else is carried along by
 * mapping the existing decorations, so typing costs the same in a long scene as a short
 * one. The whole document is scanned only when the set of names changes.
 */

import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { followWikiLink } from '../editor/RichEditor';
import type { NameMatcher } from './nameMatcher';

interface HighlightState {
  matcher: NameMatcher | null;
  decorations: DecorationSet;
}

export const nameHighlightKey = new PluginKey<HighlightState>('nameHighlight');

/** Stands in for an inline node that is not text, one position wide like the node. */
const OBJECT = '￼';

function blockDecorations(block: ProseNode, contentStart: number, matcher: NameMatcher): Decoration[] {
  // Each character of the string sits at the same offset as in the block, which holds
  // because text counts UTF-16 units and every other inline node has size one.
  let text = '';
  const linked: { from: number; to: number }[] = [];
  block.forEach((child, offset) => {
    if (child.isText) {
      text += child.text ?? '';
      // A name the author linked by hand is already a link to its page.
      if (child.marks.some((m) => m.type.name === 'wikiLink')) {
        linked.push({ from: offset, to: offset + child.nodeSize });
      }
    } else {
      text += child.type.name === 'hardBreak' ? '\n' : OBJECT;
    }
  });
  const out: Decoration[] = [];
  for (const match of matcher.find(text)) {
    if (linked.some((l) => match.start < l.to && match.end > l.from)) continue;
    out.push(
      Decoration.inline(
        contentStart + match.start,
        contentStart + match.end,
        { class: 'name-mention', 'data-wiki-target': match.title },
        { inclusiveStart: false, inclusiveEnd: false, title: match.title },
      ),
    );
  }
  return out;
}

/** True if the marks already there are the ones a fresh scan found, as with most keys. */
function sameMarks(current: Decoration[], fresh: Decoration[]): boolean {
  if (current.length !== fresh.length) return false;
  const byStart = (a: Decoration, b: Decoration) => a.from - b.from;
  const sorted = [...current].sort(byStart);
  return sorted.every((d, i) => {
    const other = fresh[i];
    return d.from === other.from && d.to === other.to && d.spec.title === other.spec.title;
  });
}

function scanAll(doc: ProseNode, matcher: NameMatcher | null): DecorationSet {
  if (!matcher) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    decorations.push(...blockDecorations(node, pos + 1, matcher));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** The ranges of the new document that this transaction changed. */
export function changedRanges(tr: Transaction): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  tr.mapping.maps.forEach((map, stepIndex) => {
    const later = tr.mapping.slice(stepIndex + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push({ from: later.map(newStart, -1), to: later.map(newEnd, 1) });
    });
    // Mark steps change no positions, but a wiki link appearing or going changes
    // which names are highlighted.
    const step = tr.steps[stepIndex];
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      ranges.push({ from: later.map(step.from, -1), to: later.map(step.to, 1) });
    }
  });
  return ranges;
}

function update(previous: DecorationSet, tr: Transaction, matcher: NameMatcher): DecorationSet {
  const doc = tr.doc;
  let decorations = previous.map(tr.mapping, doc);
  const size = doc.content.size;
  const seen = new Set<number>();
  for (const range of changedRanges(tr)) {
    // A step of one past each side also catches a block whose edge was touched.
    const from = Math.max(0, range.from - 1);
    const to = Math.min(size, range.to + 1);
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      if (!seen.has(pos)) {
        seen.add(pos);
        const start = pos + 1;
        const current = decorations.find(start, start + node.content.size);
        const fresh = blockDecorations(node, start, matcher);
        if (!sameMarks(current, fresh)) {
          if (current.length > 0) decorations = decorations.remove(current);
          if (fresh.length > 0) decorations = decorations.add(doc, fresh);
        }
      }
      return false;
    });
  }
  return decorations;
}

let trackingCtrl = false;

/** While Ctrl is held the names look clickable, because they are. */
function trackCtrlKey() {
  if (trackingCtrl) return;
  trackingCtrl = true;
  const root = document.documentElement;
  const update = (e: KeyboardEvent) => root.classList.toggle('write-ctrl-held', e.ctrlKey || e.metaKey);
  window.addEventListener('keydown', update, true);
  window.addEventListener('keyup', update, true);
  window.addEventListener('blur', () => root.classList.remove('write-ctrl-held'));
}

export function nameHighlightPlugin(getMatcher: () => NameMatcher | null): Plugin<HighlightState> {
  return new Plugin<HighlightState>({
    key: nameHighlightKey,
    view: () => {
      trackCtrlKey();
      return {};
    },
    state: {
      init: (_config, state) => {
        const matcher = getMatcher();
        return { matcher, decorations: scanAll(state.doc, matcher) };
      },
      apply: (tr, value) => {
        const change = tr.getMeta(nameHighlightKey) as { matcher: NameMatcher | null } | undefined;
        if (change) return { matcher: change.matcher, decorations: scanAll(tr.doc, change.matcher) };
        if (!tr.docChanged || !value.matcher) return value;
        return { matcher: value.matcher, decorations: update(value.decorations, tr, value.matcher) };
      },
    },
    props: {
      decorations: (state) => nameHighlightKey.getState(state)?.decorations,
      handleClick: (_view, _pos, event) => {
        if (!event.ctrlKey && !event.metaKey) return false;
        const target = (event.target as HTMLElement).closest?.('.name-mention');
        const title = target?.getAttribute('data-wiki-target');
        if (!title) return false;
        event.preventDefault();
        followWikiLink(title, event);
        return true;
      },
    },
  });
}

/** Passes `getMatcher` the current names, or null while highlighting is off. */
export function nameHighlightExtension(getMatcher: () => NameMatcher | null) {
  return Extension.create({
    name: 'nameHighlight',
    addProseMirrorPlugins() {
      return [nameHighlightPlugin(getMatcher)];
    },
  });
}

/** Applies a new set of names, or turns highlighting off. Does nothing if unchanged. */
export function setNameMatcher(view: EditorView, matcher: NameMatcher | null) {
  const current = nameHighlightKey.getState(view.state);
  if (!current || current.matcher === matcher) return;
  view.dispatch(view.state.tr.setMeta(nameHighlightKey, { matcher }).setMeta('addToHistory', false));
}
