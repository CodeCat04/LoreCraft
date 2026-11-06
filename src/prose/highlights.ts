/**
 * Prose check highlights in the editor. Decorations only: nothing here can change the
 * document, mark it as edited or enter the undo history.
 */

import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import type { CheckId, ProseMatch } from './analyze';

export interface ProseRange {
  from: number;
  to: number;
}

interface HighlightState {
  matches: readonly ProseMatch[];
  enabled: ReadonlySet<CheckId>;
  /** The match stepped to from the panel. */
  current: ProseRange | null;
  /** The sentence being read aloud. */
  reading: ProseRange | null;
  decorations: DecorationSet;
}

type Change = Partial<Pick<HighlightState, 'matches' | 'enabled' | 'current' | 'reading'>>;

export const proseKey = new PluginKey<HighlightState>('proseHighlights');

const NOTHING: ReadonlySet<CheckId> = new Set();

function build(doc: ProseNode, state: Omit<HighlightState, 'decorations'>): DecorationSet {
  const { matches, enabled, current, reading } = state;
  const size = doc.content.size;
  const fits = (range: ProseRange) => range.from < range.to && range.to <= size;
  const decorations: Decoration[] = [];
  for (const match of matches) {
    if (enabled.has(match.check) && fits(match)) {
      decorations.push(
        Decoration.inline(
          match.from,
          match.to,
          { class: `prose-hit prose-hit-${match.check}` },
          { inclusiveStart: false, inclusiveEnd: false },
        ),
      );
    }
  }
  if (current && fits(current)) decorations.push(Decoration.inline(current.from, current.to, { class: 'prose-current' }));
  if (reading && fits(reading)) decorations.push(Decoration.inline(reading.from, reading.to, { class: 'prose-reading' }));
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function mapRange<T extends ProseRange>(range: T, tr: Transaction): T {
  return { ...range, from: tr.mapping.map(range.from, 1), to: tr.mapping.map(range.to, -1) };
}

export const ProseHighlights = Extension.create({
  name: 'proseHighlights',
  addProseMirrorPlugins() {
    return [
      new Plugin<HighlightState>({
        key: proseKey,
        state: {
          init: () => ({ matches: [], enabled: NOTHING, current: null, reading: null, decorations: DecorationSet.empty }),
          apply: (tr, value) => {
            const change = tr.getMeta(proseKey) as Change | undefined;
            let next = value;
            if (tr.docChanged && (value.matches.length > 0 || value.current || value.reading)) {
              // Carried along with the text until the next reading replaces them.
              next = {
                ...value,
                matches: value.matches.map((match) => mapRange(match, tr)),
                current: value.current && mapRange(value.current, tr),
                reading: value.reading && mapRange(value.reading, tr),
                decorations: value.decorations.map(tr.mapping, tr.doc),
              };
            }
            if (!change) return next;
            const merged = { ...next, ...change };
            return { ...merged, decorations: build(tr.doc, merged) };
          },
        },
        props: {
          decorations: (state) => proseKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});

function change(editor: Editor, value: Change) {
  if (editor.isDestroyed || !proseKey.getState(editor.state)) return;
  editor.view.dispatch(editor.state.tr.setMeta(proseKey, value).setMeta('addToHistory', false));
}

/** Shows these matches for the checks that are switched on. */
export function setProseHighlights(editor: Editor, matches: readonly ProseMatch[], enabled: ReadonlySet<CheckId>) {
  change(editor, { matches, enabled });
}

export function setCurrentMatch(editor: Editor, current: ProseRange | null) {
  change(editor, { current });
}

export function setReadingRange(editor: Editor, reading: ProseRange | null) {
  change(editor, { reading });
}

export function clearProseHighlights(editor: Editor) {
  change(editor, { matches: [], enabled: NOTHING, current: null });
}
