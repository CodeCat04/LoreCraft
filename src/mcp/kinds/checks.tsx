/**
 * Consistency from an outside AI: a run of the rule checks, and a decision about a finding.
 * The run is the app's own (`runRules`), so it reads what is on screen. Undo puts back the
 * statuses the run or the decision changed, unless the writer has changed them since.
 */

import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { useLocale } from '../../state/language';
import { findings } from '../../consistency/api';
import { runRules, useConsistency } from '../../consistency/store';
import { isNodeLocalOnly, type World } from '../../consistency/rules/world';
import type { Finding, FindingStatus } from '../../consistency/types';
import type { AnyProposal } from '../api';
import { changedSince, goneSince, useOpenRoute, withElement } from './shared';
import { defineKind, type ApplyResult, type UndoResult } from './types';

type Statuses = Record<string, FindingStatus>;

export interface RunUndo {
  before: Statuses;
  after: Statuses;
  /** Said to the outside AI after "Done". */
  report: string;
}

function statusesOf(list: Finding[]): Statuses {
  return Object.fromEntries(list.map((f) => [f.id, f.status]));
}

/** A finding that quotes a local-only page or scene, which the outside AI may not hear of. */
function touchesLocalOnly(world: World | null, finding: Finding): boolean {
  if (!world) return false;
  return finding.evidence.some((e) => {
    if (e.sourceKind === 'page') return !!world.pageById.get(e.sourceId)?.localOnly;
    const node = world.nodeById.get(e.sourceId);
    return !!node && isNodeLocalOnly(world, node);
  });
}

/** For the outside AI, in English like every tool reply. */
export function runReport(open: Finding[]): string {
  if (open.length === 0) return 'There are no open findings.';
  const count = (severity: string, one: string, many: string) => {
    const n = open.filter((f) => f.severity === severity).length;
    return n === 0 ? null : `${n} ${n === 1 ? one : many}`;
  };
  const parts = [count('error', 'error', 'errors'), count('warning', 'warning', 'warnings'), count('info', 'note', 'notes')].filter(Boolean);
  const noun = open.length === 1 ? 'open finding' : 'open findings';
  return `${open.length} ${noun}: ${parts.join(', ')}. Read them with list_findings.`;
}

function RunCard() {
  useLocale();
  const openRoute = useOpenRoute();
  return (
    <p className="mcp-proposal-title">
      {withElement(
        t('Run the rule checks and update {findings}'),
        'findings',
        <button type="button" className="link-button" onClick={() => openRoute({ view: 'consistency' })}>
          {t('the findings')}
        </button>,
      )}
    </p>
  );
}

async function applyRun(): Promise<ApplyResult> {
  try {
    const before = statusesOf(await findings.list());
    await runRules();
    const { rulesError, world } = useConsistency.getState();
    if (rulesError) return { ok: false, reason: rulesError };
    const all = await findings.list();
    const open = all.filter((f) => f.status === 'open' && !touchesLocalOnly(world, f));
    const undo: RunUndo = { before, after: statusesOf(all), report: runReport(open) };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function undoRun(_p: AnyProposal, raw: unknown): Promise<UndoResult> {
  const undo = raw as RunUndo | undefined;
  if (!undo?.after) return { ok: false, reason: goneSince() };
  const now = statusesOf(await findings.list());
  for (const [id, status] of Object.entries(undo.after)) {
    if (now[id] !== undefined && now[id] !== status) return { ok: false, reason: changedSince() };
  }
  for (const [id, status] of Object.entries(undo.after)) {
    // What the run found new goes away as closed; what it reopened or closed goes back.
    const back: FindingStatus = undo.before[id] ?? (status === 'open' ? 'fixed' : status);
    if (now[id] !== undefined && back !== status) await findings.setStatus(id, back);
  }
  return { ok: true };
}

export const consistencyRunKind = defineKind<object>({
  kind: 'consistencyRun',
  Card: RunCard,
  apply: applyRun,
  undo: undoRun,
  accepted: () => t('Rule checks run.'),
});

// ---- A decision about one finding ------------------------------------------------------

export interface FindingStatusPayload {
  findingId: string;
  status: FindingStatus;
  before: FindingStatus;
}

function statusName(status: FindingStatus): string {
  switch (status) {
    case 'open':
      return t('Open');
    case 'fixed':
      return t('Fixed');
    case 'intentional':
      return t('Intentional');
    case 'ignored':
      return t('Ignored');
  }
}

function FindingCard({ proposal }: { proposal: AnyProposal<FindingStatusPayload> }) {
  useLocale();
  const { status, before } = proposal.payload;
  return (
    <>
      <p className="mcp-proposal-title">{withElement(t('Finding: {title}'), 'title', <strong>{proposal.title}</strong>)}</p>
      <p className="muted small">{t('From {before} to {after}', { before: statusName(before), after: statusName(status) })}</p>
    </>
  );
}

async function findingNow(id: string): Promise<Finding | undefined> {
  return (await findings.list()).find((f) => f.id === id);
}

export const findingStatusKind = defineKind<FindingStatusPayload>({
  kind: 'findingStatus',
  Card: FindingCard,
  apply: async (p) => {
    try {
      if (!(await findingNow(p.payload.findingId))) return { ok: false, reason: goneSince() };
      await findings.setStatus(p.payload.findingId, p.payload.status);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  },
  undo: async (p) => {
    const now = await findingNow(p.payload.findingId);
    if (!now) return { ok: false, reason: goneSince() };
    if (now.status !== p.payload.status) return { ok: false, reason: changedSince() };
    await findings.setStatus(p.payload.findingId, p.payload.before);
    return { ok: true };
  },
  accepted: () => t('Finding updated.'),
});
