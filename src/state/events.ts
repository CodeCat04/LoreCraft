import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';

import { useProject, useTitles } from './project';
import { useSettings } from './settings';
import * as api from '../lib/api';
import { withDefaults, DEFAULT_SETTINGS } from '../lib/settings';
import type { ProjectStatus } from '../lib/types';

/**
 * Data kinds the native side announces:
 * `pages` (titles or aliases changed), `pageContent`, `books`, `nodes`,
 * `nodeContent`, `meta`, `findings`, `extras`, `ai`, `ideas`, and `all` on project change.
 */
export type DataKind = string;

interface VersionStore {
  versions: Record<string, number>;
  bump: (kind: string) => void;
}

const useVersions = create<VersionStore>((set) => ({
  versions: {},
  bump: (kind) =>
    set((s) => {
      const versions = { ...s.versions, [kind]: (s.versions[kind] ?? 0) + 1 };
      if (kind === 'all') {
        for (const key of Object.keys(versions)) {
          if (key !== 'all') versions[key] = versions[key] + 1;
        }
      }
      return { versions };
    }),
}));

/**
 * A number that changes when the given data changes. Put it in a dependency list
 * to reload: `useEffect(load, [useDataVersion('pages')])`.
 */
export function useDataVersion(...kinds: DataKind[]): number {
  return useVersions((s) => {
    let total = s.versions.all ?? 0;
    for (const kind of kinds) total += s.versions[kind] ?? 0;
    return total;
  });
}

/** For code outside React, such as an editor's node view. Returns how to stop listening. */
export function subscribeDataChanges(listener: () => void): () => void {
  return useVersions.subscribe(listener);
}

/** Starts listening. Call once at startup. */
export async function startEventBridge(): Promise<void> {
  await listen<ProjectStatus>('project://status', (event) => {
    useProject.getState().setStatus(event.payload);
  });
  await listen<{ entity: string }>('data://changed', (event) => {
    const { entity } = event.payload;
    useVersions.getState().bump(entity);
    if (entity === 'recent') {
      // The native side keeps this list. Everything else in settings starts in the UI.
      void api.settings.get().then((stored) => {
        const { recent } = withDefaults(stored, DEFAULT_SETTINGS);
        useSettings.setState((s) => ({ settings: { ...s.settings, recent } }));
      });
    }
    if ((entity === 'pages' || entity === 'all') && useProject.getState().status.open) {
      void useTitles.getState().refresh();
    }
  });
}

/** Loads something and reloads it when the data changes. */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | undefined; error: Error | undefined; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => {
        if (!cancelled) setState({ data, loading: false });
      },
      (error: Error) => {
        if (!cancelled) setState({ error, loading: false });
      },
    );
    return () => {
      cancelled = true;
    };
    // The caller decides when to reload, through `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data: state.data, error: state.error, loading: state.loading, reload: () => setTick((t) => t + 1) };
}
