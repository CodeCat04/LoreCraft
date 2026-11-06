/** What the styles screen remembers while the app is open, and how to reach it. */

import { create } from 'zustand';

import { t } from '../lib/i18n';
import { useNav } from '../state/nav';
import type { BlendWeight, CustomStyle, WritingStyle } from './types';

export type StylesTab = 'browse' | 'blend' | 'mine' | 'guide' | 'build';

export type KindFilter = 'all' | 'author' | 'technique' | 'custom';

export interface BlendSlot {
  styleId: string | null;
  weight: BlendWeight;
}

const EMPTY_SLOTS: BlendSlot[] = [
  { styleId: null, weight: 'mostly' },
  { styleId: null, weight: 'some' },
  { styleId: null, weight: 'touch' },
];

interface StylesUi {
  tab: StylesTab;
  /** True when the screen is showing in a dialog, because no project is open. */
  inDialog: boolean;
  query: string;
  genre: string;
  kind: KindFilter;
  favoritesOnly: boolean;
  selectedId: string | null;
  slots: BlendSlot[];
  /** The custom style open for editing. An empty id means it has not been saved yet. */
  editing: CustomStyle | null;
  set: (patch: Partial<Omit<StylesUi, 'set'>>) => void;
}

export const useStylesUi = create<StylesUi>((set) => ({
  tab: 'browse',
  inDialog: false,
  query: '',
  genre: '',
  kind: 'all',
  favoritesOnly: false,
  selectedId: null,
  slots: EMPTY_SLOTS,
  editing: null,
  set: (patch) => set(patch),
}));

/** Moves between tabs of the screen, wherever it is showing. */
export function goToTab(tab: StylesTab) {
  useStylesUi.getState().set({ tab });
  if (!useStylesUi.getState().inDialog) useNav.getState().replace({ view: 'styles', tab });
}

/** A new, unsaved custom style that starts as a copy of another. */
export function copyOf(style: WritingStyle): CustomStyle {
  return {
    id: '',
    kind: 'custom',
    name: t('{name} (my copy)', { name: style.name }),
    genres: [...style.genres],
    summary: style.summary,
    traits: { ...style.traits },
    basedOn: style.id,
    namesAuthors: style.kind === 'author' || (style.kind === 'custom' && style.namesAuthors),
    promptOverride: style.kind === 'custom' ? style.promptOverride : undefined,
    priority: style.kind === 'custom' ? style.priority : undefined,
  };
}

export function blankStyle(): CustomStyle {
  return {
    id: '',
    kind: 'custom',
    name: '',
    genres: [],
    summary: '',
    traits: { narration: '', sentences: '', diction: '', dialogue: '', description: '', pacing: '', signature: '', avoid: '' },
  };
}
