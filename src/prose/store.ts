/**
 * The Prose panel's state, and running the checks. Text from the open scene comes from its
 * editor, so it is always current, and other scenes come from storage as they change.
 */

import type { Editor } from '@tiptap/core';
import { create } from 'zustand';

import { CHECKS, type CheckId, type ProseMatch, type ProseReport } from './analyze';
import { proseClient } from './client';
import { clearProseHighlights, setCurrentMatch, setProseHighlights } from './highlights';
import { stopReading } from './readAloud';
import { waitForEditor } from '../editor/ai/registry';
import { scrollToPos } from '../editor/comments/extension';
import * as api from '../lib/api';
import { errorMessage } from '../lib/rpc';
import type { PmNode } from '../lib/types';
import { useTitles } from '../state/project';
import { openScene, useWrite } from '../write/store';
import { chapterOf, scenesUnder, type TreeIndex } from '../write/tree';

export type ProseScope = 'scene' | 'chapter' | 'book';

interface ProseState {
  open: boolean;
  scope: ProseScope;
  enabled: Record<CheckId, boolean>;
  report: ProseReport | null;
  /** The scope the report describes, so it is not shown against a different one. */
  reportScope: ProseScope | null;
  busy: boolean;
  problem: string | null;
  /** Where stepping has got to, per check or per overused term. */
  steps: Record<string, number>;
}

const PREFS_KEY = 'prose.prefs';

/** On at first are the ones that are nearly always worth a look. */
const DEFAULT_ENABLED: Record<CheckId, boolean> = {
  overused: true,
  repeated: false,
  doubled: true,
  longSentence: true,
  adverb: false,
  filter: false,
  passive: false,
};

function loadPrefs(): { scope: ProseScope; enabled: Record<CheckId, boolean> } {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { scope?: ProseScope; enabled?: Partial<Record<CheckId, boolean>> };
    return {
      scope: stored.scope === 'chapter' || stored.scope === 'book' ? stored.scope : 'scene',
      enabled: { ...DEFAULT_ENABLED, ...stored.enabled },
    };
  } catch {
    return { scope: 'scene', enabled: DEFAULT_ENABLED };
  }
}

function savePrefs(scope: ProseScope, enabled: Record<CheckId, boolean>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope, enabled }));
  } catch {
    // It only means the choice is not remembered next time.
  }
}

export const useProse = create<ProseState>(() => ({
  open: false,
  ...loadPrefs(),
  report: null,
  reportScope: null,
  busy: false,
  problem: null,
  steps: {},
}));

export function setProseOpen(open: boolean) {
  useProse.setState({ open });
  // Its controls are in the panel, so a voice should not carry on with no way to stop it.
  if (!open) stopReading();
}

export function setProseScope(scope: ProseScope) {
  const { enabled } = useProse.getState();
  savePrefs(scope, enabled);
  useProse.setState({ scope, steps: {} });
}

export function setCheckEnabled(check: CheckId, on: boolean) {
  const { scope, enabled } = useProse.getState();
  const next = { ...enabled, [check]: on };
  savePrefs(scope, next);
  useProse.setState({ enabled: next });
}

export function enabledSet(enabled: Record<CheckId, boolean>): ReadonlySet<CheckId> {
  return new Set(CHECKS.filter((check) => enabled[check]));
}

/** Everything to do with the current project goes when another one opens. */
export function resetProse() {
  proseClient.reset();
  useProse.setState({ report: null, reportScope: null, busy: false, problem: null, steps: {} });
}

function namesNow(): string[] {
  return useTitles.getState().entries.flatMap((entry) => [entry.title, ...entry.aliases]);
}

function scopeScenes(index: TreeIndex, sceneId: string, scope: ProseScope): string[] {
  if (scope === 'scene') return [sceneId];
  if (scope === 'chapter') {
    const chapter = chapterOf(index, sceneId);
    return chapter ? scenesUnder(index, chapter.id).map((s) => s.id) : [sceneId];
  }
  return index.scenes.map((s) => s.id);
}

/** Reads any scene the worker does not have yet, a few at a time. */
async function loadScenes(index: TreeIndex, ids: string[], cancelled: () => boolean) {
  const missing = ids.filter((id) => {
    const meta = index.byId.get(id);
    return meta && !proseClient.has(id, meta.updatedAt);
  });
  let next = 0;
  const worker = async () => {
    while (next < missing.length && !cancelled()) {
      const id = missing[next];
      next += 1;
      const node = await api.nodes.get(id);
      if (!cancelled()) proseClient.setScene(id, index.byId.get(id)?.updatedAt ?? node.updatedAt, node.content);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

let latestRun = 0;
let liveVersion = 0;

/** Checks the current scope. Keeps quiet if the text changes while it works, as a new run will come. */
export async function runChecks(sceneId: string, editor: Editor): Promise<void> {
  latestRun += 1;
  const thisRun = latestRun;
  const cancelled = () => thisRun !== latestRun || editor.isDestroyed;
  const { scope } = useProse.getState();
  const { index } = useWrite.getState();
  const inScope = scopeScenes(index, sceneId, scope);
  const allScenes = index.scenes.map((s) => s.id);
  const rest = allScenes.filter((id) => !inScope.includes(id));
  useProse.setState({ busy: true });
  try {
    await loadScenes(index, allScenes.filter((id) => id !== sceneId), cancelled);
    if (cancelled()) return;
    const doc = editor.state.doc;
    liveVersion += 1;
    proseClient.setScene(sceneId, `live:${liveVersion}`, editor.getJSON() as PmNode);
    const report = await proseClient.analyze({ scope: inScope, rest, names: namesNow() });
    if (!report || cancelled() || editor.state.doc !== doc) return;
    useProse.setState({ report, reportScope: scope, busy: false, problem: null });
    showHighlights(sceneId, editor);
  } catch (e) {
    if (!cancelled()) useProse.setState({ busy: false, problem: errorMessage(e) });
  }
}

/** Draws the current report's matches for this scene, for the checks that are on. */
export function showHighlights(sceneId: string, editor: Editor) {
  const { report, enabled } = useProse.getState();
  if (!report) return;
  const here: ProseMatch[] = [];
  for (const check of CHECKS) {
    if (!enabled[check]) continue;
    for (const match of report.matches[check]) {
      if (match.scene === sceneId) here.push(match);
    }
  }
  setProseHighlights(editor, here, enabledSet(enabled));
}

export function hideHighlights(editor: Editor) {
  clearProseHighlights(editor);
}

function matchesFor(report: ProseReport, check: CheckId, term?: string): ProseMatch[] {
  const list = report.matches[check];
  return term ? list.filter((match) => match.term === term) : list;
}

/** The place stepping is at, as a person counts it, with the total. */
export function stepKey(check: CheckId, term?: string): string {
  return term ? `${check}:${term}` : check;
}

/** Moves to the next or previous match, opening its scene if it is in another one. */
export async function stepMatch(check: CheckId, direction: 1 | -1, currentScene: string, term?: string): Promise<void> {
  const { report, steps } = useProse.getState();
  if (!report) return;
  const list = matchesFor(report, check, term);
  if (list.length === 0) return;
  const key = stepKey(check, term);
  const previous = steps[key] ?? (direction === 1 ? -1 : 0);
  const index = (previous + direction + list.length) % list.length;
  useProse.setState({ steps: { ...steps, [key]: index } });
  const match = list[index];
  const scene = match.scene ?? currentScene;
  if (scene !== currentScene) openScene(scene, { keepFocus: true });
  const entry = await waitForEditor('node', scene);
  if (!entry) return;
  setCurrentMatch(entry.editor, { from: match.from, to: match.to });
  window.requestAnimationFrame(() => scrollToPos(entry.editor, match.from));
}
