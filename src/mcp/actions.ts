/**
 * Accepting, rejecting, applying and undoing changes from outside tools. What each kind of
 * change does is in `kinds/`; this file runs a kind and moves the proposal on.
 */

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { waitForEditor } from '../editor/ai/registry';
import { addSuggestion, pendingSuggestions, suggestionsKey } from '../editor/ai/suggestions';
import type { Route } from '../state/nav';
import type { Transaction } from '@tiptap/pm/state';
import { planTextProposal } from './apply';
import { mcp, type AnyProposal, type Proposal, type TextProposal } from './api';
import { kindFor, type ApplyResult } from './kinds';

export type AcceptResult = { ok: true } | { ok: false; reason: string };

const unknownKind = () => t('This kind of change needs a newer version of LoreCraft.');

/** Runs a kind's apply, turning anything thrown into a reason. Does not resolve the proposal. */
export async function applyProposal(proposal: AnyProposal | Proposal): Promise<ApplyResult> {
  const kind = kindFor(proposal.kind);
  if (!kind) return { ok: false, reason: unknownKind() };
  try {
    return await kind.apply(proposal as AnyProposal);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** The writer's Accept. */
export async function acceptProposal(proposal: AnyProposal | Proposal): Promise<AcceptResult> {
  const result = await applyProposal(proposal);
  if (!result.ok) return result;
  await mcp.resolve(proposal.id, 'accepted', result.target);
  return { ok: true };
}

/**
 * The edit level: a change the window picked up (status `applying`) is applied through the
 * same code as Accept, then marked applied with what Undo needs, or failed with the reason.
 */
export async function applyDirectly(proposal: AnyProposal): Promise<ApplyResult> {
  const result = await applyProposal(proposal);
  if (result.ok) await mcp.resolve(proposal.id, 'applied', { ...result.target, undo: result.undo ?? null });
  else await mcp.resolve(proposal.id, 'failed', { error: result.reason });
  return result;
}

/** True if this applied change has an Undo. */
export function canUndo(proposal: AnyProposal): boolean {
  return !!kindFor(proposal.kind)?.undo;
}

/** Takes back a change applied at the edit level. Refuses, with the reason, if it has changed since. */
export async function undoProposal(proposal: AnyProposal): Promise<AcceptResult> {
  const kind = kindFor(proposal.kind);
  if (!kind?.undo) return { ok: false, reason: t('This change cannot be undone here. Open History to restore an older version.') };
  let result;
  try {
    result = await kind.undo(proposal, proposal.payload.undo);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  if (!result.ok) return result;
  const target = proposal.targetKind && proposal.targetId ? { targetKind: proposal.targetKind, targetId: proposal.targetId } : undefined;
  await mcp.resolve(proposal.id, 'undone', target);
  return { ok: true };
}

/**
 * Opens the document with the suggestion laid out as tracked changes, to accept or reject
 * one at a time. The suggestion counts as handled once none of its changes are left: as
 * accepted if any were taken, otherwise as rejected. Edits made inside it meanwhile leave
 * it waiting, so it can be reviewed again.
 */
export async function reviewInDocument(proposal: TextProposal, open: (route: Route) => void): Promise<AcceptResult> {
  const kind = proposal.targetKind;
  open(kind === 'page' ? { view: 'page', id: proposal.targetId } : { view: 'write', nodeId: proposal.targetId });
  const entry = await waitForEditor(kind, proposal.targetId, 8000);
  if (!entry) return { ok: false, reason: t('The document did not open, so the changes cannot be shown there.') };
  const { editor } = entry;
  const planned = planTextProposal(editor.state.doc, proposal, false);
  if ('stale' in planned) return { ok: false, reason: planned.stale };
  const suggestionId = addSuggestion(editor, {
    label: t('From {client}', { client: proposal.client }),
    from: planned.from,
    to: planned.to,
    hunks: planned.hunks,
    reply: '',
    instruction: '',
  });
  let accepted = 0;
  const stop = () => {
    editor.off('transaction', follow);
    editor.off('destroy', stop);
  };
  function follow({ transaction }: { transaction: Transaction }) {
    const action = transaction.getMeta(suggestionsKey) as { type?: string; suggestionId?: string; hunkIds?: string[] } | undefined;
    if (action?.type === 'accepted' && action.suggestionId === suggestionId) accepted += action.hunkIds?.length ?? 0;
    const still = pendingSuggestions(editor).find((s) => s.id === suggestionId);
    if (still && !still.stale) return;
    stop();
    if (!still) void mcp.resolve(proposal.id, accepted > 0 ? 'accepted' : 'rejected').catch(() => {});
  }
  editor.on('transaction', follow);
  editor.on('destroy', stop);
  return { ok: true };
}

export async function rejectProposal(proposal: AnyProposal | Proposal): Promise<void> {
  await mcp.resolve(proposal.id, 'rejected');
}
