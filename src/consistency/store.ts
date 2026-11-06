/**
 * Running the checks. A run belongs to the project rather than to the screen, so it keeps
 * going while the writer looks at something else, and the screen picks it up on return.
 */

import { create } from 'zustand';

import { AiError, completeJson, profileForTask } from '../ai/client';
import { contextBudget } from '../ai/context';
import { flushAllEditors } from '../editor/saving';
import * as coreApi from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { getEras } from '../lib/storyDate';
import type { AiProfile } from '../lib/settings';
import { confirmRun } from '../ai/limits/confirmRun';
import { toast } from '../shell/toasts';
import * as api from './api';
import { textToSend } from './ai/estimate';
import { usablePage, usableScene } from './ai/lore';
import { BETWEEN_META_KEY, newRun, RUN_META_KEY, runAiCheck, scenesInScope, staleAiFindings } from './ai/run';
import type { AiBackend, RunProgress, RunRecord, RunScopeKind } from './ai/types';
import { applyProposal, proposeWikiUpdates, type Proposal, type ProposalResult } from './ai/wikiUpdates';
import { buildWorld, runRuleChecks, type World, type WorldInput, type WorldNode, type WorldPage } from './rules';
import type { UpsertSummary } from './types';

interface UpdatesState {
  running: boolean;
  chapterId: string;
  chapterTitle: string;
  result: ProposalResult | null;
  error: string | null;
}

/** Proposed wiki updates waiting for the writer, kept in the project so they outlive a restart. */
export const WIKI_UPDATES_META_KEY = 'consistency.wikiUpdates';

/** One chapter's proposals. The newest comes first in what is stored. */
export interface StoredUpdates {
  chapterId: string;
  chapterTitle: string;
  createdAt: string;
  result: ProposalResult;
}

interface ConsistencyStore {
  world: World | null;
  rulesRunning: boolean;
  rulesRanAt: string | null;
  rulesSummary: UpsertSummary | null;
  rulesError: string | null;
  aiRunning: boolean;
  progress: RunProgress | null;
  /** The current or last AI run. */
  record: RunRecord | null;
  updates: UpdatesState | null;
}

export const useConsistency = create<ConsistencyStore>(() => ({
  world: null,
  rulesRunning: false,
  rulesRanAt: null,
  rulesSummary: null,
  rulesError: null,
  aiRunning: false,
  progress: null,
  record: null,
  updates: null,
}));

let aiStopper: AbortController | null = null;
let updatesStopper: AbortController | null = null;
/** Goes up when another project opens, so that a run from the last one cannot write to it. */
let generation = 0;

/** Everything remembered about a project goes when another one opens. */
export function resetConsistency(): void {
  generation += 1;
  aiStopper?.abort();
  aiStopper = null;
  updatesStopper?.abort();
  updatesStopper = null;
  storedUpdates = [];
  useConsistency.setState({
    world: null,
    rulesRunning: false,
    rulesRanAt: null,
    rulesSummary: null,
    rulesError: null,
    aiRunning: false,
    progress: null,
    record: null,
    updates: null,
  });
}

async function loadWorld(): Promise<World> {
  // What is on screen counts, including the last half second of typing.
  await flushAllEditors();
  const [snapshot, eras] = await Promise.all([coreApi.snapshot.get(), getEras()]);
  const world = buildWorld(snapshot as unknown as WorldInput, eras);
  useConsistency.setState({ world });
  return world;
}

// ---------------------------------------------------------------------------
// Rule checks
// ---------------------------------------------------------------------------

let rulesAgain = false;

/** Runs the rule checks and stores what they find. Fast enough to run on opening the screen. */
export async function runRules(): Promise<void> {
  if (useConsistency.getState().rulesRunning) {
    rulesAgain = true;
    return;
  }
  useConsistency.setState({ rulesRunning: true, rulesError: null });
  try {
    const world = await loadWorld();
    const summary = await api.findings.upsert(runRuleChecks(world), { source: 'rule' });
    // AI findings whose quoted words have since been edited out have gone away too.
    const open = await api.findings.list({ status: 'open', source: 'ai' });
    for (const id of staleAiFindings(world, open)) await api.findings.setStatus(id, 'fixed');
    useConsistency.setState({ rulesRanAt: new Date().toISOString(), rulesSummary: summary });
  } catch (e) {
    useConsistency.setState({ rulesError: errorMessage(e) });
  } finally {
    useConsistency.setState({ rulesRunning: false });
    if (rulesAgain) {
      rulesAgain = false;
      void runRules();
    }
  }
}

// ---------------------------------------------------------------------------
// AI checks
// ---------------------------------------------------------------------------

function activeProfiles(): AiProfile[] {
  return [profileForTask('extract'), profileForTask('consistency')];
}

function backendFor(profiles: AiProfile[]): AiBackend {
  const cloud = profiles.some((profile) => profile.isCloud);
  const started = generation;
  /** A run outlives its project only long enough to notice, and must not touch the next one. */
  const stale = () => started !== generation;
  const unchanged: UpsertSummary = { added: 0, updated: 0, reopened: 0, closed: 0, unchanged: 0, decisionsKept: 0 };
  return {
    cloud,
    // A local server handles one request at a time, whatever else it claims.
    concurrency: profiles.every((profile) => profile.isCloud) ? 3 : 1,
    contextTokens: Math.min(...profiles.map(contextBudget)),
    json: (request, validate) => {
      if (stale()) return Promise.reject(new AiError('CANCELLED', 'Stopped.'));
      return completeJson(request, validate);
    },
    getClaims: (kind, id) => (stale() ? Promise.resolve(null) : api.claims.get(kind, id)),
    putClaims: (kind, id, hash, value) => (stale() ? Promise.resolve(false) : api.claims.put(kind, id, hash, value, profiles[0].model)),
    upsert: (drafts, close) => (stale() ? Promise.resolve(unchanged) : api.findings.upsert(drafts, close)),
    saveRun: (record) => {
      if (stale()) return Promise.resolve(false);
      useConsistency.setState({ record: { ...record } });
      return coreApi.project.setMeta(RUN_META_KEY, JSON.stringify(record));
    },
  };
}

/**
 * Before spending money: the AI module's own question, with what this will send and roughly
 * what it will cost. It asks only for a cloud profile.
 */
async function approveCloudRun(world: World, profiles: AiProfile[], label: string, scenes: WorldNode[], pages: WorldPage[] = []): Promise<boolean> {
  const profile = profiles.find((p) => p.isCloud);
  if (!profile) return true;
  // Claims are short, so replies are a fraction of what is sent.
  return confirmRun({ label, text: textToSend(world, scenes, true, pages), profile, outputShare: 0.3 });
}

function reportFinish(record: RunRecord): void {
  const { stats } = record;
  if (record.state === 'failed') {
    toast(record.error ?? t('The AI check stopped.'), 'error');
  } else if (record.state === 'finished') {
    toast(
      stats.kept === 0
        ? t('AI check finished with no contradictions.')
        : stats.kept === 1
          ? t('AI check finished with 1 finding.')
          : t('AI check finished with {count} findings.', { count: stats.kept }),
      'success',
    );
  } else if (record.state === 'cancelled') {
    toast(t('AI check stopped. You can resume it.'));
  }
}

async function executeRun(world: World, record: RunRecord, backend: AiBackend): Promise<void> {
  aiStopper = new AbortController();
  const stopper = aiStopper;
  const started = generation;
  useConsistency.setState({ aiRunning: true, progress: { done: record.done.length, total: record.sceneIds.length + (record.pageIds?.length ?? 0) + (record.sceneIds.length > 0 ? 1 : 0), step: t('Starting') }, record: { ...record } });
  const finished = await runAiCheck({
    world,
    backend,
    record,
    signal: stopper.signal,
    onProgress: (progress) => {
      if (aiStopper === stopper) useConsistency.setState({ progress });
    },
    betweenChecked: {
      get: async () => {
        if (started !== generation) return null;
        const stored = await coreApi.project.getMeta(BETWEEN_META_KEY);
        return (stored ? (JSON.parse(stored) as Record<string, string>) : {})[`${record.kind}:${record.targetId}`] ?? null;
      },
      set: async (print) => {
        if (started !== generation) return false;
        const stored = await coreApi.project.getMeta(BETWEEN_META_KEY);
        const map = stored ? (JSON.parse(stored) as Record<string, string>) : {};
        map[`${record.kind}:${record.targetId}`] = print;
        return coreApi.project.setMeta(BETWEEN_META_KEY, JSON.stringify(map));
      },
    },
  });
  if (aiStopper !== stopper) return;
  aiStopper = null;
  useConsistency.setState({ aiRunning: false, progress: null, record: { ...finished } });
  reportFinish(finished);
}

/** Starts a check on a scene, a chapter or a book. */
export async function startAiCheck(kind: RunScopeKind, targetId: string, label: string): Promise<void> {
  if (useConsistency.getState().aiRunning) return;
  try {
    const profiles = activeProfiles();
    const backend = backendFor(profiles);
    const world = await loadWorld();
    if (kind === 'page') {
      const page = world.pageById.get(targetId);
      if (!page) {
        toast(t('That page no longer exists.'), 'error');
        return;
      }
      if (!usablePage(page, backend.cloud)) {
        toast(t('This page is marked local only, so it cannot go to a cloud profile. Choose a local profile for this task in Settings > AI.'), 'error');
        return;
      }
      if (!(await approveCloudRun(world, profiles, t('Run an AI check on {label}', { label }), [], [page]))) return;
      await executeRun(world, newRun(kind, targetId, label, [], [page]), backend);
      return;
    }
    const scenes = scenesInScope(world, kind, targetId);
    const usable = scenes.filter((node) => usableScene(world, node, backend.cloud));
    if (scenes.length === 0) {
      toast(t('There are no scenes in {label} to check.', { label }));
      return;
    }
    if (usable.length === 0) {
      toast(t('These scenes are marked local only, so they cannot go to a cloud profile. Choose a local profile for this task in Settings > AI.'), 'error');
      return;
    }
    if (!(await approveCloudRun(world, profiles, t('Run an AI check on {label}', { label }), usable))) return;
    await executeRun(world, newRun(kind, targetId, label, scenes), backend);
  } catch (e) {
    if (!(e instanceof AiError && e.code === 'DECLINED')) toast(errorMessage(e), 'error');
    useConsistency.setState({ aiRunning: false, progress: null });
  }
}

/** Picks up a run that was stopped, failed or was cut off when the app closed. */
export async function resumeAiCheck(): Promise<void> {
  const { record, aiRunning } = useConsistency.getState();
  if (aiRunning || !record || record.state === 'finished') return;
  try {
    const profiles = activeProfiles();
    const backend = backendFor(profiles);
    const world = await loadWorld();
    const remaining = record.sceneIds
      .filter((id) => !record.done.includes(id))
      .map((id) => world.nodeById.get(id))
      .filter((node): node is NonNullable<typeof node> => !!node && usableScene(world, node, backend.cloud));
    const remainingPages = (record.pageIds ?? [])
      .filter((id) => !record.done.includes(id))
      .map((id) => world.pageById.get(id))
      .filter((page): page is WorldPage => !!page && usablePage(page, backend.cloud));
    if (!(await approveCloudRun(world, profiles, t('Resume the AI check on {label}', { label: record.label }), remaining, remainingPages))) return;
    await executeRun(world, { ...record, stats: { ...record.stats } }, backend);
  } catch (e) {
    toast(errorMessage(e), 'error');
    useConsistency.setState({ aiRunning: false, progress: null });
  }
}

export function cancelAiCheck(): void {
  aiStopper?.abort();
  useConsistency.setState((state) => (state.progress ? { progress: { ...state.progress, step: t('Stopping'), thinking: false } } : state));
}

/** Reads back the last run, so an interrupted one can be resumed after reopening a project. */
export async function loadLastRun(): Promise<void> {
  if (useConsistency.getState().aiRunning) return;
  try {
    const stored = await coreApi.project.getMeta(RUN_META_KEY);
    const record = stored ? (JSON.parse(stored) as RunRecord) : null;
    useConsistency.setState({ record });
  } catch {
    useConsistency.setState({ record: null });
  }
}

// ---------------------------------------------------------------------------
// Wiki updates
// ---------------------------------------------------------------------------

/** What is stored, newest first, or nothing for a value that cannot be read. */
export function parseStoredUpdates(raw: string | null): StoredUpdates[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(
      (item): item is StoredUpdates =>
        !!item &&
        typeof item === 'object' &&
        typeof item.chapterId === 'string' &&
        typeof item.chapterTitle === 'string' &&
        Array.isArray(item.result?.proposals),
    );
  } catch {
    return [];
  }
}

/** The stored list with one chapter's proposals put first, or taken out when `next` is null. */
export function withStoredUpdates(list: StoredUpdates[], chapterId: string, next: StoredUpdates | null): StoredUpdates[] {
  const others = list.filter((item) => item.chapterId !== chapterId);
  return next ? [next, ...others] : others;
}

let storedUpdates: StoredUpdates[] = [];

function showStored(): void {
  const first = storedUpdates[0];
  useConsistency.setState({
    updates: first ? { running: false, chapterId: first.chapterId, chapterTitle: first.chapterTitle, result: first.result, error: null } : null,
  });
}

async function saveStored(list: StoredUpdates[], started: number): Promise<void> {
  if (started !== generation) return;
  storedUpdates = list;
  await coreApi.project.setMeta(WIKI_UPDATES_META_KEY, JSON.stringify(list));
}

/** Reads back proposals the writer has not dealt with yet, as after reopening a project. */
export async function loadWikiUpdates(): Promise<void> {
  if (useConsistency.getState().updates?.running) return;
  const started = generation;
  try {
    const list = parseStoredUpdates(await coreApi.project.getMeta(WIKI_UPDATES_META_KEY));
    if (started !== generation || useConsistency.getState().updates?.running) return;
    storedUpdates = list;
    showStored();
  } catch {
    // No project, or it closed meanwhile.
  }
}

export async function startWikiUpdates(chapterId: string, chapterTitle: string): Promise<void> {
  if (useConsistency.getState().updates?.running) return;
  updatesStopper = new AbortController();
  const stopper = updatesStopper;
  const started = generation;
  useConsistency.setState({ updates: { running: true, chapterId, chapterTitle, result: null, error: null } });
  try {
    const profiles = [profileForTask('extract')];
    const backend = backendFor(profiles);
    const world = await loadWorld();
    const label = t('Suggest wiki updates from {chapter}', { chapter: chapterTitle });
    if (!(await approveCloudRun(world, profiles, label, scenesInScope(world, 'chapter', chapterId)))) {
      if (updatesStopper === stopper) showStored();
      return;
    }
    const result = await proposeWikiUpdates(world, chapterId, backend, stopper.signal);
    if (updatesStopper !== stopper) return;
    updatesStopper = null;
    // Kept in the project at once, so closing the app does not lose them.
    const entry: StoredUpdates = { chapterId, chapterTitle, createdAt: new Date().toISOString(), result };
    await saveStored(withStoredUpdates(storedUpdates, chapterId, entry), started);
    if (started === generation) showStored();
  } catch (e) {
    if (updatesStopper !== stopper) return;
    updatesStopper = null;
    if (e instanceof AiError && (e.code === 'CANCELLED' || e.code === 'DECLINED')) {
      showStored();
    } else {
      useConsistency.setState({ updates: { running: false, chapterId, chapterTitle, result: null, error: errorMessage(e) } });
    }
  }
}

/** Stops a run. Proposals from earlier runs stay. */
export function cancelWikiUpdates(): void {
  updatesStopper?.abort();
  updatesStopper = null;
  showStored();
}

/** Puts the proposals on screen away for good, and shows the next chapter's, if any. */
export async function closeWikiUpdates(): Promise<void> {
  const updates = useConsistency.getState().updates;
  if (!updates || updates.running) return;
  const started = generation;
  if (storedUpdates.some((item) => item.chapterId === updates.chapterId)) {
    try {
      await saveStored(withStoredUpdates(storedUpdates, updates.chapterId, null), started);
    } catch (e) {
      toast(errorMessage(e), 'error');
      return;
    }
  }
  showStored();
}

/** Makes the approved changes, one at a time, and keeps whatever could not be made in the list. */
export async function applyApproved(chosen: { proposal: Proposal; how: 'change' | 'replace' }[]): Promise<void> {
  const started = generation;
  let applied = 0;
  const done = new Set<string>();
  for (const { proposal, how } of chosen) {
    try {
      await applyProposal(proposal, how);
      done.add(proposal.id);
      applied += 1;
    } catch (e) {
      toast(t('Could not apply a change to {title}: {error}', { title: proposal.kind === 'newPage' ? proposal.title : proposal.pageTitle, error: errorMessage(e) }), 'error');
    }
  }
  const updates = useConsistency.getState().updates;
  if (updates?.result && started === generation) {
    const result = { ...updates.result, proposals: updates.result.proposals.filter((p) => !done.has(p.id)) };
    useConsistency.setState({ updates: { ...updates, result } });
    const stored = storedUpdates.find((item) => item.chapterId === updates.chapterId);
    if (stored && done.size > 0) {
      await saveStored(withStoredUpdates(storedUpdates, updates.chapterId, { ...stored, result }), started).catch((e: unknown) => toast(errorMessage(e), 'error'));
    }
  }
  if (applied > 0) {
    toast(applied === 1 ? t('1 change made to the wiki.') : t('{count} changes made to the wiki.', { count: applied }), 'success');
    void runRules();
  }
}
