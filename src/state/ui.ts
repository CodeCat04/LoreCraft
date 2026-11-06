import { create } from 'zustand';

interface UiStore {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** Distraction-free writing: hides everything except the page. */
  focusMode: boolean;
  setFocusMode: (on: boolean) => void;
  /** Short status text from modules, shown in the status bar by key. */
  statusItems: Record<string, string>;
  setStatusItem: (key: string, text: string | null) => void;
}

export const useUi = create<UiStore>((set) => ({
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  focusMode: false,
  setFocusMode: (focusMode) => set({ focusMode }),
  statusItems: {},
  setStatusItem: (key, text) =>
    set((s) => {
      const statusItems = { ...s.statusItems };
      if (text === null) delete statusItems[key];
      else statusItems[key] = text;
      return { statusItems };
    }),
}));
