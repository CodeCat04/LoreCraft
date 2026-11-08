/** A scene's details: title, synopsis, point of view and the like. Undo restores the old values kept in the payload. */

import * as api from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { useLocale } from '../../state/language';
import { compareTexts } from '../../wiki/diff';
import type { NodePatch } from '../../lib/api';
import type { NodeStatus } from '../../lib/types';
import type { AnyProposal, PageRef, SceneDetails, SceneDetailsPayload } from '../api';
import { changedSince, DiffView, flushFirst, goneSince, isLiveNode, useOpenRoute, withElement } from './shared';
import { defineKind, type ApplyResult, type UndoResult } from './types';

function detailText(key: keyof SceneDetails, value: SceneDetails[keyof SceneDetails]): string {
  if (value === null || value === undefined || value === '') return t('(none)');
  if (key === 'cast') return (value as PageRef[]).map((p) => p.title).join(', ') || t('(none)');
  if (key === 'pov' || key === 'location') return (value as PageRef).title;
  return String(value);
}

function SceneDetailsCard({ proposal }: { proposal: AnyProposal<SceneDetailsPayload> }) {
  useLocale();
  const openRoute = useOpenRoute();
  const { changes, before } = proposal.payload;
  const labels: Record<keyof SceneDetails, string> = {
    title: t('Title'),
    synopsis: t('Synopsis'),
    pov: t('Point of view'),
    location: t('Location'),
    cast: t('Cast'),
    status: t('Status'),
    storyDate: t('Story date'),
    notes: t('Notes'),
  };
  const keys = (Object.keys(labels) as (keyof SceneDetails)[]).filter((key) => changes[key] !== undefined);
  return (
    <>
      <p className="mcp-proposal-title">
        {withElement(
          t('Details of the scene {title}'),
          'title',
          <button type="button" className="link-button" onClick={() => openRoute({ view: 'write', nodeId: proposal.targetId ?? '' })}>
            {proposal.title || t('Untitled')}
          </button>,
        )}
      </p>
      <dl className="mcp-infobox mcp-details">
        {keys.map((key) => (
          <div key={key}>
            <dt>{labels[key]}</dt>
            <dd>
              <DiffView lines={compareTexts(detailText(key, before[key]), detailText(key, changes[key]))} />
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** The patch that sets these details. */
function patchFor(details: SceneDetails): NodePatch {
  const patch: NodePatch = {};
  if (details.title !== undefined) patch.title = details.title;
  if (details.synopsis !== undefined) patch.synopsis = details.synopsis;
  if (details.status !== undefined) patch.status = details.status as NodeStatus;
  if (details.storyDate !== undefined) patch.storyDate = details.storyDate;
  if (details.notes !== undefined) patch.notes = details.notes;
  if (details.pov !== undefined) patch.povPageId = details.pov?.id ?? '';
  if (details.location !== undefined) patch.locationPageId = details.location?.id ?? '';
  return patch;
}

async function setDetails(id: string, details: SceneDetails): Promise<void> {
  const patch = patchFor(details);
  if (Object.keys(patch).length) await api.nodes.update(id, patch);
  if (details.cast) await api.nodes.setCast(id, details.cast.map((p) => p.id));
}

async function apply(proposal: AnyProposal<SceneDetailsPayload>): Promise<ApplyResult> {
  const problem = await flushFirst();
  if (problem) return { ok: false, reason: problem };
  const id = proposal.targetId ?? '';
  if (!(await isLiveNode(id))) return { ok: false, reason: t('What this suggestion changes has been deleted.') };
  try {
    await setDetails(id, proposal.payload.changes);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

/** Puts the old values back, if each field still holds what the change set. */
async function undo(proposal: AnyProposal<SceneDetailsPayload>): Promise<UndoResult> {
  const problem = await flushFirst();
  if (problem) return { ok: false, reason: problem };
  const id = proposal.targetId ?? '';
  if (!(await isLiveNode(id))) return { ok: false, reason: goneSince() };
  const node = await api.nodes.get(id);
  const now = node as unknown as Record<string, unknown>;
  const wanted = patchFor(proposal.payload.changes) as Record<string, unknown>;
  for (const [key, value] of Object.entries(wanted)) {
    if (key in now && (now[key] ?? '') !== (value ?? '')) return { ok: false, reason: changedSince() };
  }
  const { before, changes } = proposal.payload;
  const restore: SceneDetails = {};
  for (const key of Object.keys(changes) as (keyof SceneDetails)[]) {
    (restore as Record<string, unknown>)[key] = before[key] ?? (key === 'cast' ? [] : key === 'pov' || key === 'location' ? null : '');
  }
  try {
    await setDetails(id, restore);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

export const sceneDetailsKind = defineKind<SceneDetailsPayload>({
  kind: 'sceneDetails',
  Card: SceneDetailsCard,
  apply,
  undo,
  accepted: () => t('Scene details changed.'),
});
