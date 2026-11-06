/**
 * Comments and to-dos attached to text. `addComment` is the stable way for other modules
 * to leave one, such as the AI beta reader and the MCP server.
 */

import type { Editor } from '@tiptap/core';

import { editorFor } from '../editor/ai/registry';
import { findQuote, markQuoteInStored, markRangeInStored, quoteOf, unmarkInStored, type TextRange } from '../editor/comments/anchor';
import { editorSaves, markComment, unmarkComment } from '../editor/comments/extension';
import { flushAllEditors } from '../editor/saving';
import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { rpc } from '../lib/rpc';
import type { PmNode } from '../lib/types';

export type CommentSourceKind = 'page' | 'node';

export interface Comment {
  id: string;
  sourceKind: CommentSourceKind;
  sourceId: string;
  body: string;
  /** `you`, `ai` or the name of a tool. */
  author: string;
  isTodo: boolean;
  done: boolean;
  resolved: boolean;
  /** The words it is attached to, or the words it was attached to once they have gone. */
  quote: string;
  /** Its mark is still in the stored document. */
  anchored: boolean;
  createdAt: string;
  updatedAt: string;
  sourceTitle: string;
  bookId: string | null;
  bookTitle: string;
  chapterTitle: string;
}

export interface CommentPatch {
  body?: string;
  isTodo?: boolean;
  done?: boolean;
  resolved?: boolean;
}

export const comments = {
  /** Every comment in the project, newest first. */
  all: () => rpc<Comment[]>('comments.list'),
  /** The comments of one document, oldest first. */
  of: (sourceKind: CommentSourceKind, sourceId: string) => rpc<Comment[]>('comments.list', { sourceKind, sourceId }),
  get: (id: string) => rpc<Comment>('comments.get', { id }),
  update: (id: string, patch: CommentPatch) => rpc<Comment>('comments.update', { id, patch }),
};

export interface NewComment {
  /** The document it belongs to. */
  kind: CommentSourceKind;
  id: string;
  body: string;
  /** `you`, `ai` or the name of a tool. Defaults to `you`. */
  author?: string;
  /** Words from the document to attach it to. Without them it is about the whole document. */
  quote?: string;
  isTodo?: boolean;
}

function liveEditor(kind: CommentSourceKind, id: string) {
  const entry = editorFor(kind, id);
  return entry && editorSaves(entry.editor) ? entry.editor : null;
}

async function loadStored(kind: CommentSourceKind, id: string): Promise<PmNode> {
  return kind === 'page' ? (await api.pages.get(id)).content : (await api.nodes.get(id)).content;
}

async function writeStored(kind: CommentSourceKind, id: string, content: PmNode): Promise<void> {
  if (kind === 'page') await api.pages.update(id, { content });
  else await api.nodes.update(id, { content });
}

/** Marks the first place these words appear. False if they are not in the document. */
async function anchorQuote(kind: CommentSourceKind, id: string, commentId: string, quote: string): Promise<boolean> {
  const editor = liveEditor(kind, id);
  if (editor) {
    const range = findQuote(editor.state.doc, quote);
    if (!range) return false;
    markComment(editor, commentId, range.from, range.to);
    return true;
  }
  try {
    // Something still on its way to storage must not be overwritten by the older copy.
    await flushAllEditors();
    const marked = markQuoteInStored(await loadStored(kind, id), commentId, quote);
    if (!marked) return false;
    await writeStored(kind, id, marked);
    return true;
  } catch {
    // The comment itself is stored by now, and it stays listed without a place in the text.
    return false;
  }
}

/**
 * Adds a comment. When `quote` is given and found in the open or stored document, the
 * comment is attached there, and `anchored` in the result says whether it was.
 */
export async function addComment(input: NewComment): Promise<Comment> {
  const quote = input.quote?.trim() ?? '';
  const comment = await rpc<Comment>('comments.add', {
    sourceKind: input.kind,
    sourceId: input.id,
    body: input.body,
    author: input.author ?? 'you',
    isTodo: input.isTodo ?? false,
    quote,
  });
  if (!quote) return comment;
  const anchored = await anchorQuote(input.kind, input.id, comment.id, quote);
  return { ...comment, anchored };
}

/**
 * Adds a comment on a stretch of an open document, where the positions are known. `range`
 * is asked again after the comment is stored, since the text may have moved by then.
 */
export async function addCommentAt(
  editor: Editor,
  input: Omit<NewComment, 'quote'>,
  range: () => TextRange | null,
): Promise<Comment> {
  const before = range();
  const quote = before ? quoteOf(editor.state.doc, before.from, before.to) : '';
  const comment = await rpc<Comment>('comments.add', {
    sourceKind: input.kind,
    sourceId: input.id,
    body: input.body,
    author: input.author ?? 'you',
    isTodo: input.isTodo ?? false,
    quote,
  });
  const now = range() ?? before;
  if (!now) return comment;
  if (editorSaves(editor)) {
    if (editor.isDestroyed) return comment;
    markComment(editor, comment.id, now.from, now.to);
    // The comment is stored at once, so its place in the text should not wait either.
    await flushAllEditors();
    return { ...comment, anchored: true, quote };
  }
  // A read-only copy of the text, so the mark goes straight into the stored document.
  await flushAllEditors();
  const marked = markRangeInStored(await loadStored(input.kind, input.id), comment.id, now, quote);
  if (marked) await writeStored(input.kind, input.id, marked);
  return { ...comment, anchored: !!marked, quote };
}

/** Deletes a comment and takes its mark out of the text. */
export async function deleteComment(comment: Pick<Comment, 'id' | 'sourceKind' | 'sourceId'>): Promise<void> {
  const { id, sourceKind, sourceId } = comment;
  const editor = liveEditor(sourceKind, sourceId);
  if (editor) {
    unmarkComment(editor, id);
  } else {
    await flushAllEditors();
    const clean = unmarkInStored(await loadStored(sourceKind, sourceId), id);
    if (clean) await writeStored(sourceKind, sourceId, clean);
  }
  await rpc<boolean>('comments.delete', { id });
}

/** A comment's author, as a person would say it. */
export function authorLabel(author: string): string {
  if (author === 'you') return t('You');
  if (author === 'ai') return t('AI');
  return author;
}

/** Still something to do or to read. */
export function isOpen(comment: Pick<Comment, 'resolved' | 'done' | 'isTodo'>): boolean {
  return !comment.resolved && !(comment.isTodo && comment.done);
}
