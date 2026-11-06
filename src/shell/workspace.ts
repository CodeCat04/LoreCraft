/**
 * Remembers the tabs, panes and places in each project, so that opening it again finds things
 * as they were. All of this lives in the app's settings, keyed by the project's id, because
 * writing it to the project file would mark the project as changed.
 */

import { create } from 'zustand';

import { allPlaces, resetPlaces, rememberTabScroll, subscribePlaces, tabScrollOf } from '../state/docs';
import { useNav, type Route } from '../state/nav';
import { useProject, useTitles } from '../state/project';
import { useSettings } from '../state/settings';
import { restoreLayout, saveLayout } from '../state/tabs';
import * as api from '../lib/api';
import type { SavedWorkspace } from '../lib/settings';

/** Tabs changing is rare and worth keeping soon. A cursor moves with every key typed. */
const LAYOUT_DELAY_MS = 800;
const PLACE_DELAY_MS = 4000;
const MAX_PROJECTS = 12;
const MAX_PLACES = 100;

/**
 * True while a project is being opened and its tabs put back, so the window shows neither the
 * old project's screens nor a flash of the main page.
 */
export const useProjectSwitching = create<{ switching: boolean }>(() => ({ switching: false }));

export function setProjectSwitching(switching: boolean) {
  useProjectSwitching.setState({ switching });
}

let projectKey: string | null = null;
let lastSaved = '';
let timer: number | undefined;
let timerDue = 0;

function reopenEnabled(): boolean {
  return useSettings.getState().settings.save.reopenLast;
}

function snapshot() {
  const layout = saveLayout(useNav.getState(), tabScrollOf);
  // The most recently added places are at the end. Older ones go first.
  const places = Object.fromEntries(Object.entries(allPlaces()).slice(-MAX_PLACES));
  return { layout, places };
}

/** Writes the current layout now, if it has changed since the last time. */
export async function saveWorkspace(): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  if (!projectKey || !reopenEnabled()) return;
  const current = snapshot();
  const text = JSON.stringify(current);
  if (text === lastSaved) return;
  lastSaved = text;
  const { session } = useSettings.getState().settings;
  const entry: SavedWorkspace = { key: projectKey, savedAt: new Date().toISOString(), ...current };
  const others = session.workspaces.filter((w) => w.key !== projectKey);
  const workspaces = [entry, ...others].slice(0, MAX_PROJECTS);
  // Not through `update`, which also applies the theme. This can run while someone is typing.
  useSettings.setState((s) => ({ settings: { ...s.settings, session: { ...s.settings.session, workspaces } } }));
  try {
    await api.settings.update({ session: { workspaces } });
  } catch {
    // Only a convenience. The next change tries again.
    lastSaved = '';
  }
}

function saveSoon(delayMs: number) {
  if (!projectKey) return;
  const due = Date.now() + delayMs;
  if (timer !== undefined && timerDue <= due) return;
  window.clearTimeout(timer);
  timerDue = due;
  timer = window.setTimeout(() => void saveWorkspace(), delayMs);
}

function stillThere(route: Route): boolean {
  // A page that was deleted is not worth a message. Its tab just does not come back. Other
  // screens check for themselves, as they do when anything disappears from under them.
  return route.view !== 'page' || useTitles.getState().byId.has(route.id);
}

async function currentKey(): Promise<string | null> {
  const id = await api.project.getMeta('project_id').catch(() => null);
  return id || useProject.getState().status.path;
}

/**
 * Sets up the window for the project that has just opened: its remembered tabs if it has any
 * and `restore` allows it, otherwise one tab on the main page. Call with the titles loaded.
 */
export async function startWorkspace(restore: boolean): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  projectKey = null;
  const key = await currentKey();
  const { settings } = useSettings.getState();
  const saved = restore && settings.save.reopenLast ? settings.session.workspaces.find((w) => w.key === key) : undefined;
  resetPlaces(saved?.places);
  const layout = saved ? restoreLayout(saved.layout, stillThere, rememberTabScroll) : null;
  useNav.getState().resetLayout(layout ?? undefined);
  lastSaved = '';
  projectKey = key;
}

/** Follows the project and the layout from now on. Call once at startup. */
export function startWorkspaceTracking() {
  useNav.subscribe(() => saveSoon(LAYOUT_DELAY_MS));
  subscribePlaces(() => saveSoon(PLACE_DELAY_MS));
  useProject.subscribe((state, previous) => {
    const { open, path } = state.status;
    // Closing still has the layout on hand, so it is written under the old key first.
    if (!open && previous.status.open) {
      void saveWorkspace().then(() => {
        if (!useProject.getState().status.open) projectKey = null;
      });
    }
    if (open && path !== useSettings.getState().settings.session.lastProject) {
      void useSettings.getState().update({ session: { lastProject: path } }).catch(() => {});
    }
  });
}

/** The writer closed the project on purpose, so the next start begins at the start screen. */
export function forgetLastProject() {
  void useSettings.getState().update({ session: { lastProject: null } }).catch(() => {});
}
