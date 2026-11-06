/** Accepting and rejecting suggestions from outside tools. */

import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage, RpcError } from '../lib/rpc';
import { flushOrStop } from '../editor/saving';
import { markdownToPm } from '../editor/convert';
import { withoutModelMedia } from '../editor/ai/hunks';
import { keyFromLabel } from '../wiki/infobox';
import type { Infobox, PmNode } from '../lib/types';
import { applyEdit } from './apply';
import { mcp, type Proposal } from './api';

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

async function acceptEdit(proposal: Extract<Proposal, { kind: 'edit' }>): Promise<AcceptResult> {
  const { targetKind, targetId, payload } = proposal;
  // What the writer typed in the last moments counts as the document.
  try {
    await flushOrStop();
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  const content = await currentDocument(targetKind, targetId);
  if (!content) return { ok: false, reason: t('What this suggestion changes has been deleted.') };
  const result = applyEdit(content, payload.quote, payload.replacement);
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

export function acceptProposal(proposal: Proposal): Promise<AcceptResult> {
  return proposal.kind === 'edit' ? acceptEdit(proposal) : acceptNewPage(proposal);
}

export async function rejectProposal(proposal: Proposal): Promise<void> {
  await mcp.resolve(proposal.id, 'rejected');
}
