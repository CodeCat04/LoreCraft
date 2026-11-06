/** The native side of the consistency checks. */

import { rpc } from '../lib/rpc';
import type { Finding, FindingDraft, FindingSource, FindingStatus, UpsertSummary } from './types';

/** Which open findings a run looked at. Those it did not report get closed. */
export interface CloseScope {
  source: FindingSource;
  rules?: string[];
  /** Only findings citing one of these pages or scenes. */
  sourceIds?: string[];
}

export interface CachedClaims<T> {
  sourceKind: 'page' | 'node';
  sourceId: string;
  contentHash: string;
  claims: T;
  model: string;
  createdAt: string;
}

export const findings = {
  list: (filter: { status?: FindingStatus; source?: FindingSource; rule?: string } = {}) =>
    rpc<Finding[]>('consistency.list', filter),
  upsert: (drafts: FindingDraft[], close?: CloseScope) =>
    rpc<UpsertSummary>('consistency.upsert', { findings: drafts, close }),
  setStatus: (id: string, status: FindingStatus) => rpc<Finding>('consistency.setStatus', { id, status }),
};

export const claims = {
  get: <T>(sourceKind: 'page' | 'node', sourceId: string) =>
    rpc<CachedClaims<T> | null>('consistency.claimsGet', { sourceKind, sourceId }),
  put: (sourceKind: 'page' | 'node', sourceId: string, contentHash: string, value: unknown, model: string) =>
    rpc<boolean>('consistency.claimsPut', { sourceKind, sourceId, contentHash, claims: value, model }),
};
