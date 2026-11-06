import { create } from 'zustand';

import type { ProjectStatus, TitleEntry } from '../lib/types';
import * as api from '../lib/api';
import { titleKey } from '../lib/text';

interface ProjectStore {
  status: ProjectStatus;
  setStatus: (status: ProjectStatus) => void;
}

export const useProject = create<ProjectStore>((set) => ({
  status: { open: false, name: '', path: null, dirty: false },
  setStatus: (status) => set({ status }),
}));

interface TitleStore {
  entries: TitleEntry[];
  /** title or alias key -> page */
  byKey: Map<string, TitleEntry>;
  byId: Map<string, TitleEntry>;
  refresh: () => Promise<void>;
  /** The page a wiki link points at, or undefined for a red link. */
  resolve: (target: string) => TitleEntry | undefined;
}

let latestRefresh = 0;

export const useTitles = create<TitleStore>((set, get) => ({
  entries: [],
  byKey: new Map(),
  byId: new Map(),
  refresh: async () => {
    latestRefresh += 1;
    const thisRefresh = latestRefresh;
    const entries = await api.pages.titles();
    // Responses can overtake each other, and an older list must not replace a newer one.
    if (thisRefresh !== latestRefresh) return;
    const byKey = new Map<string, TitleEntry>();
    const byId = new Map<string, TitleEntry>();
    // Aliases go first so that a real title always wins over someone's alias.
    for (const entry of entries) {
      for (const alias of entry.aliases) byKey.set(titleKey(alias), entry);
    }
    for (const entry of entries) {
      byKey.set(titleKey(entry.title), entry);
      byId.set(entry.id, entry);
    }
    set({ entries, byKey, byId });
  },
  resolve: (target) => get().byKey.get(titleKey(target)),
}));
