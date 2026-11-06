/** What the AI checks need from the rest of the app, so that tests can stand in for it. */

import type { AiTask } from '../../lib/settings';
import type { CloseScope } from '../api';
import type { FindingDraft, UpsertSummary } from '../types';
import type { CachedSource } from './claims';

export interface JsonRequest {
  task: Extract<AiTask, 'extract' | 'consistency'>;
  system: string;
  prompt: string;
  schema: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}

export interface AiBackend {
  /** One model request that returns JSON which has passed the validator. */
  json: <T>(request: JsonRequest, validate: (value: unknown) => T) => Promise<T>;
  getClaims: (kind: 'node' | 'page', id: string) => Promise<{ contentHash: string; claims: CachedSource | null } | null>;
  putClaims: (kind: 'node' | 'page', id: string, hash: string, value: CachedSource) => Promise<unknown>;
  upsert: (drafts: FindingDraft[], close?: CloseScope) => Promise<UpsertSummary>;
  /** What a run remembers, kept with the project so that it can be resumed. */
  saveRun: (record: RunRecord) => Promise<unknown>;
  /** The context size of the model that will read this. */
  contextTokens: number;
  /** One request at a time for a local server. Cloud services can take a few. */
  concurrency: number;
  /** Local-only text must not go to this model. */
  cloud: boolean;
}

/** What a run did, for showing the writer and for honest reporting. */
export interface RunStats {
  /** Sources the model read for claims, and ones answered from the cache. */
  claimsRead: number;
  claimsFromCache: number;
  claimsProposed: number;
  /** Claims whose quote was not really in the text. */
  claimsDiscarded: number;
  /** Scenes whose text and lore had not changed since they were last compared. */
  comparisonsSkipped: number;
  /** Contradictions the model reported, before any checks. */
  proposed: number;
  /** Those that passed every check and became findings. */
  kept: number;
  /** Those with a quote that is not really in its source. */
  discardedQuotes: number;
  /** Examples of those, for the writer to see what was thrown away. */
  discardedExamples: string[];
  /** The model called it low confidence, or its own words said there was no conflict. */
  discardedWeak: number;
  /** The two sides were values a field holds at different moments, which is not a conflict. */
  discardedChanges: number;
  /** Cited a page that is not fact, such as an idea or a retconned page. */
  discardedStatus: number;
  /** Left out because they are local only and this profile is a cloud service. */
  skippedLocalOnly: number;
  /** Scenes the model could not give a usable answer for, which the run carried on past. */
  failedSources: string[];
}

export function emptyStats(): RunStats {
  return {
    claimsRead: 0,
    claimsFromCache: 0,
    claimsProposed: 0,
    claimsDiscarded: 0,
    comparisonsSkipped: 0,
    proposed: 0,
    kept: 0,
    discardedQuotes: 0,
    discardedExamples: [],
    discardedWeak: 0,
    discardedChanges: 0,
    discardedStatus: 0,
    skippedLocalOnly: 0,
    failedSources: [],
  };
}

export type RunScopeKind = 'scene' | 'chapter' | 'book' | 'page';

export type RunState = 'running' | 'cancelled' | 'failed' | 'finished';

/** One run over some scenes. Saved after every scene. */
export interface RunRecord {
  id: string;
  kind: RunScopeKind;
  /** The scene, chapter, book or wiki page. */
  targetId: string;
  label: string;
  /** The scenes in this run. */
  sceneIds: string[];
  /** The wiki pages in this run, for a check of a page rather than the manuscript. */
  pageIds?: string[];
  done: string[];
  betweenDone: boolean;
  state: RunState;
  stats: RunStats;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface RunProgress {
  /** Steps finished and how many there are in all. */
  done: number;
  total: number;
  /** What is happening, as a short phrase. */
  step: string;
  /** Shown while a model is working, which can be minutes on a local server. */
  thinking?: boolean;
}
