/** Accepting and rejecting suggestions from outside tools. */

import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage, RpcError } from '../lib/rpc';
import { flushOrStop } from '../editor/saving';
import { markdownToPm } from '../editor/convert';
import { withoutModelMedia } from '../editor/ai/hunks';
import { waitForEditor } from '../editor/ai/registry';
import { addSuggestion, pendingSuggestions, suggestionsKey } from '../editor/ai/suggestions';
import { keyFromLabel } from '../wiki/infobox';
import type { NodePatch } from '../lib/api';
import type { Infobox, NodeStatus, PmNode } from '../lib/types';
import type { Route } from '../state/nav';
import type { Transaction } from '@tiptap/pm/state';
import { applyTextProposal, planTextProposal } from './apply';
import { mcp, type PageRef, type Proposal, type TextProposal } from './api';

export type AcceptResult = { ok: true } | { ok: false; reason: string };

async function currentDocument(kind: 'page' | 'node', id: string): Promise<PmNode | null> {
  try {
    if (kind === 'page') {
      const page = await api.pages.get(id);
      return page.deletedAt ? null : page.content;
    }
    const node = await api.nodes.get(id);
    return node.deletedAt ? null : node.content;
  } catch (error) {
    if (error instanceof RpcError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

async function acceptEdit(proposal: TextProposal): Promise<AcceptResult> {
  const { targetKind, targetId } = proposal;
  // What the writer typed in the last moments counts as the document.
  try {
    await flushOrStop();
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  const content = await currentDocument(targetKind, targetId);
  if (!content) return { ok: false, reason: t('What this suggestion changes has been deleted.') };
  const result = applyTextProposal(content, proposal);
  if ('stale' in result) return { ok: false, reason: result.stale };
  await api.revisions.checkpoint(targetKind, targetId, 'ai');
  if (targetKind === 'page') await api.pages.update(targetId, { content: result.doc });
  else await api.nodes.update(targetId, { content: result.doc });
  await mcp.resolve(proposal.id, 'accepted', { targetKind, targetId });
  return { ok: true };
}

function newPageInfobox(fields: { label: string; value: string }[] | undefined): Infobox {
  const taken: string[] = [];
  return {
    fields: (fields ?? []).map(({ label, value }) => {
      const key = keyFromLabel(label, taken);
      taken.push(key);
      return { key, label, kind: 'text', value };
    }),
  };
}

async function acceptNewPage(proposal: Extract<Proposal, { kind: 'newPage' }>): Promise<AcceptResult> {
  const { payload } = proposal;
  const parsed = markdownToPm(payload.body);
  const content: PmNode = { type: 'doc', content: withoutModelMedia(parsed.content) };
  if (!content.content?.length) content.content = [{ type: 'paragraph' }];
  try {
    await api.pages.create({
      title: payload.title,
      pageType: payload.pageType,
      status: 'draft',
      summary: payload.summary ?? '',
      content,
      infobox: newPageInfobox(payload.infobox),
      aliases: payload.aliases ?? [],
      categories: payload.categories ?? [],
    });
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  await mcp.resolve(proposal.id, 'accepted');
  return { ok: true };
}

/** Text from an outside AI as a document, without any media it may have named. */
function markdownDoc(text: string | undefined): PmNode {
  const parsed = markdownToPm(text ?? '');
  const content = withoutModelMedia(parsed.content);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

async function isLive(id: string): Promise<boolean> {
  try {
    return !(await api.nodes.get(id)).deletedAt;
  } catch {
    return false;
  }
}

interface NewSceneFields {
  title: string;
  synopsis?: string;
  pov?: PageRef;
  location?: PageRef;
  cast?: PageRef[];
  text?: string;
}

async function createScene(bookId: string, chapterId: string, scene: NewSceneFields, afterId?: string): Promise<void> {
  const made = await api.nodes.create({
    bookId,
    parentId: chapterId,
    kind: 'scene',
    title: scene.title,
    afterId,
    content: markdownDoc(scene.text),
    synopsis: scene.synopsis ?? '',
  });
  if (scene.pov || scene.location) {
    await api.nodes.update(made.id, {
      ...(scene.pov ? { povPageId: scene.pov.id } : {}),
      ...(scene.location ? { locationPageId: scene.location.id } : {}),
    });
  }
  if (scene.cast?.length) await api.nodes.setCast(made.id, scene.cast.map((p) => p.id));
}

async function acceptNewScene(proposal: Extract<Proposal, { kind: 'newScene' }>): Promise<AcceptResult> {
  const { payload } = proposal;
  if (!(await isLive(payload.chapterId))) return { ok: false, reason: t('The chapter this scene goes in has been deleted.') };
  try {
    await createScene(payload.bookId, payload.chapterId, payload, payload.afterId);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  await mcp.resolve(proposal.id, 'accepted');
  return { ok: true };
}

async function acceptNewChapter(proposal: Extract<Proposal, { kind: 'newChapter' }>): Promise<AcceptResult> {
  const { payload } = proposal;
  if (payload.parentId && !(await isLive(payload.parentId))) return { ok: false, reason: t('The part this chapter goes in has been deleted.') };
  try {
    const chapter = await api.nodes.create({
      bookId: payload.bookId,
      parentId: payload.parentId ?? null,
      kind: 'chapter',
      title: payload.title,
      afterId: payload.afterId,
      synopsis: payload.synopsis ?? '',
    });
    await createScene(payload.bookId, chapter.id, payload.scene);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  await mcp.resolve(proposal.id, 'accepted');
  return { ok: true };
}

async function acceptSceneDetails(proposal: Extract<Proposal, { kind: 'sceneDetails' }>): Promise<AcceptResult> {
  const { changes } = proposal.payload;
  try {
    await flushOrStop();
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  if (!(await isLive(proposal.targetId))) return { ok: false, reason: t('What this suggestion changes has been deleted.') };
  const patch: NodePatch = {};
  if (changes.title !== undefined) patch.title = changes.title;
  if (changes.synopsis !== undefined) patch.synopsis = changes.synopsis;
  if (changes.status !== undefined) patch.status = changes.status as NodeStatus;
  if (changes.storyDate !== undefined) patch.storyDate = changes.storyDate;
  if (changes.notes !== undefined) patch.notes = changes.notes;
  if (changes.pov !== undefined) patch.povPageId = changes.pov?.id ?? '';
  if (changes.location !== undefined) patch.locationPageId = changes.location?.id ?? '';
  try {
    if (Object.keys(patch).length) await api.nodes.update(proposal.targetId, patch);
    if (changes.cast) await api.nodes.setCast(proposal.targetId, changes.cast.map((p) => p.id));
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  await mcp.resolve(proposal.id, 'accepted');
  return { ok: true };
}

export function acceptProposal(proposal: Proposal): Promise<AcceptResult> {
  switch (proposal.kind) {
    case 'edit':
    case 'rewrite':
    case 'insert':
      return acceptEdit(proposal);
    case 'newScene':
      return acceptNewScene(proposal);
    case 'newChapter':
      return acceptNewChapter(proposal);
    case 'sceneDetails':
      return acceptSceneDetails(proposal);
    case 'newPage':
      return acceptNewPage(proposal);
  }
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

export async function rejectProposal(proposal: Proposal): Promise<void> {
  await mcp.resolve(proposal.id, 'rejected');
}
