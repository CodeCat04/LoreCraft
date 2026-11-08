/**
 * Comments from add_comment and resolve_comment. They go through the app's own comment code
 * in `src/notes/api.ts`, so the mark appears in an open editor and the margin updates. A
 * comment changes no text, so Undo takes the comment and its mark away again, or puts its
 * resolved state back, unless someone has changed the comment since.
 */

import { t } from '../../lib/i18n';
import { errorMessage, RpcError } from '../../lib/rpc';
import { addComment, comments, deleteComment, type Comment, type CommentSourceKind } from '../../notes/api';
import { useLocale } from '../../state/language';
import type { AnyProposal } from '../api';
import { changedSince, goneSince, targetRoute, useOpenRoute, withElement } from './shared';
import { defineKind, type ApplyResult, type ProposalKind, type UndoResult } from './types';

export interface AddCommentPayload {
  sourceKind: CommentSourceKind;
  sourceId: string;
  quote: string;
  body: string;
  isTodo?: boolean;
}

export interface ResolveCommentPayload {
  commentId: string;
  resolved: boolean;
  before: boolean;
}

/** What Undo checks: the comment, as it was right after the change. */
interface CommentUndo {
  commentId: string;
  updatedAt: string;
}

async function current(id: string): Promise<Comment | null> {
  try {
    return await comments.get(id);
  } catch (error) {
    if (error instanceof RpcError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

function Where({ proposal, template }: { proposal: AnyProposal<object>; template: string }) {
  const openRoute = useOpenRoute();
  return (
    <p className="mcp-proposal-title">
      {withElement(
        template,
        'title',
        <button type="button" className="link-button" onClick={() => openRoute(targetRoute(proposal))}>
          {proposal.title || t('Untitled')}
        </button>,
      )}
    </p>
  );
}

function AddCommentCard({ proposal }: { proposal: AnyProposal<AddCommentPayload> }) {
  useLocale();
  const { quote, body, isTodo } = proposal.payload;
  return (
    <>
      <Where proposal={proposal} template={isTodo ? t('A to-do on {title}') : t('A comment on {title}')} />
      <div className="mcp-diff">
        <p className="mcp-diff-line">{t('On: “{quote}”', { quote })}</p>
      </div>
      <div className="mcp-new-page">
        <p className="mcp-diff-line">{body}</p>
      </div>
    </>
  );
}

function ResolveCommentCard({ proposal }: { proposal: AnyProposal<ResolveCommentPayload> }) {
  useLocale();
  return <Where proposal={proposal} template={proposal.payload.resolved ? t('Resolve a comment on {title}') : t('Open a comment on {title} again')} />;
}

async function applyAdd(p: AnyProposal<AddCommentPayload>): Promise<ApplyResult> {
  const { sourceKind, sourceId, quote, body, isTodo } = p.payload;
  try {
    const comment = await addComment({ kind: sourceKind, id: sourceId, body, quote, isTodo: !!isTodo, author: p.client });
    if (!comment.anchored) {
      // A comment that lost its passage would be about nothing in particular.
      await deleteComment(comment);
      return { ok: false, reason: t('The quoted words are no longer in the text.') };
    }
    const undo: CommentUndo = { commentId: comment.id, updatedAt: comment.updatedAt };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function undoAdd(_p: AnyProposal<AddCommentPayload>, undo: unknown): Promise<UndoResult> {
  const info = undo as CommentUndo | undefined;
  if (!info?.commentId) return { ok: false, reason: goneSince() };
  try {
    const comment = await current(info.commentId);
    if (!comment) return { ok: false, reason: goneSince() };
    if (comment.updatedAt !== info.updatedAt) return { ok: false, reason: changedSince() };
    await deleteComment(comment);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

async function applyResolve(p: AnyProposal<ResolveCommentPayload>): Promise<ApplyResult> {
  const { commentId, resolved } = p.payload;
  try {
    const comment = await current(commentId);
    if (!comment) return { ok: false, reason: goneSince() };
    if (comment.resolved === resolved) return { ok: false, reason: t('That comment is already like that.') };
    const after = await comments.update(commentId, { resolved });
    const undo: CommentUndo = { commentId, updatedAt: after.updatedAt };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function undoResolve(p: AnyProposal<ResolveCommentPayload>, undo: unknown): Promise<UndoResult> {
  const { commentId, resolved, before } = p.payload;
  try {
    const comment = await current(commentId);
    if (!comment) return { ok: false, reason: goneSince() };
    const info = undo as CommentUndo | undefined;
    if (comment.resolved !== resolved || (info?.updatedAt && comment.updatedAt !== info.updatedAt)) {
      return { ok: false, reason: changedSince() };
    }
    await comments.update(commentId, { resolved: before });
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

export const addCommentKind = defineKind<AddCommentPayload>({
  kind: 'addComment',
  Card: AddCommentCard,
  apply: applyAdd,
  undo: undoAdd,
  accepted: () => t('Comment added.'),
});

export const resolveCommentKind = defineKind<ResolveCommentPayload>({
  kind: 'resolveComment',
  Card: ResolveCommentCard,
  apply: applyResolve,
  undo: undoResolve,
  accepted: () => t('Comment changed.'),
});

export const commentsKinds: ProposalKind[] = [addCommentKind, resolveCommentKind];
