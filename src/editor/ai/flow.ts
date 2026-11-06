/**
 * One AI edit of a document, from request to suggestion. The document is not touched at
 * any point in here: the most this does is add a suggestion for the person to look at.
 * Stopping, a failure, or a slow response all leave the document as it was.
 */

import type { Editor } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';

import type { AiProfile } from '../../lib/settings';
import { t } from '../../lib/i18n';
import { AiError, maxTokensMessage, profileForTask, refusalMessage, stream, type AiResult } from '../../ai/client';
import { asOfSource, assembleContext, bookOutline, contextBudget, contextToBlocks, estimateTokens } from '../../ai/context';
import { isSourceLocalOnly, withheldMessage } from '../../ai/limits/localOnly';
import { frameBatcher } from '../../ai/frames';
import { expandTemplate, INSERT_SYSTEM, REWRITE_SYSTEM, usesVariable } from '../../ai/prompts';
import type { AiMessage, ContentBlock } from '../../ai/types';
import { pmToPlainText } from '../convert';
import type { EditorSource } from '../RichEditor';
import type { PmNode } from '../../lib/types';
import {
  cleanReply,
  computeHunks,
  computeInsertion,
  FigureSafetyError,
  hasText,
  planRewrite,
  planToMarkdown,
  stripMarkers,
} from './hunks';
import { addSuggestion, markRead, setPreviewText, trackRange, trackedRange, untrack } from './suggestions';

export type EditAction = 'replace' | 'insert';

export interface EditRequest {
  editor: Editor;
  source: EditorSource;
  from: number;
  to: number;
  /** What was asked for, as written. May use `{{selection}}`, `{{page}}` and `{{book}}`. */
  instruction: string;
  /** A short name for the bar. */
  label: string;
  action: EditAction;
  profileId?: string;
  maxTokens?: number;
  /** A writing style for this edit, over the scene's, book's and project's. */
  styleId?: string;
  /** A range already being tracked and shown, which stays with the caller afterward. */
  targetId?: string;
  onStatus?: (status: EditStatus) => void;
}

export type EditStatus =
  | { phase: 'starting' }
  | { phase: 'thinking'; thinking: string }
  | { phase: 'writing'; text: string }
  | { phase: 'retrying'; delayMs: number; reason: string };

export type EditOutcome =
  | { kind: 'suggested'; suggestionId: string; changes: number }
  | { kind: 'unchanged' }
  | { kind: 'stale'; suggestionId: string }
  | { kind: 'cancelled' }
  /** Declined by the model. `message` says so, and another profile may do it. */
  | { kind: 'refused'; message: string; profileId: string }
  /** Hit the output limit, so what it wrote is incomplete and was not used. */
  | { kind: 'cutoff'; message: string; maxTokens: number | undefined }
  | { kind: 'failed'; code: string; message: string };

export interface RunningEdit {
  cancel: () => void;
  done: Promise<EditOutcome>;
}

/** A selection this request can act on: the range was plain figures with no text around. */
export function canEditRange(editor: Editor, from: number, to: number): boolean {
  const doc = editor.state.doc;
  const plan = planRewrite(doc, from, to);
  return !!plan && hasText(doc, plan);
}

/** Turns a finished response into a suggestion, or says why it cannot be one. */
export function finishEdit(
  result: AiResult,
  request: Pick<EditRequest, 'editor' | 'action' | 'label' | 'instruction' | 'maxTokens'>,
  targetId: string,
  targetText: string,
): EditOutcome {
  const { editor, action, label, instruction } = request;
  const target = trackedRange(editor, targetId);
  if (!target || editor.isDestroyed) return { kind: 'failed', code: 'GONE', message: t('That document is no longer open.') };

  if (result.stopReason === 'cancelled') return { kind: 'cancelled' };
  if (result.stopReason === 'refusal') {
    // Any text before a refusal is discarded rather than treated as finished.
    return { kind: 'refused', message: refusalMessage(result), profileId: result.profileId };
  }
  if (result.stopReason === 'max_tokens') {
    return { kind: 'cutoff', message: maxTokensMessage(), maxTokens: request.maxTokens };
  }
  const reply = cleanReply(result.text, targetText);
  if (!reply) return { kind: 'failed', code: 'EMPTY', message: t('The model did not write anything. Try again, or try another profile.') };

  // What the model read has since changed, so its answer may not fit what is there now.
  if (target.touched) {
    const suggestionId = addSuggestion(editor, {
      label, from: target.from, to: target.to, hunks: [], reply, instruction, stale: true,
    });
    return { kind: 'stale', suggestionId };
  }

  const doc = editor.state.doc;
  try {
    if (action === 'insert') {
      const hunks = computeInsertion(doc, target.to, reply);
      if (hunks.length === 0) return { kind: 'unchanged' };
      const suggestionId = addSuggestion(editor, { label, from: hunks[0].from, to: hunks[0].to, hunks, reply, instruction });
      return { kind: 'suggested', suggestionId, changes: 1 };
    }
    const plan = planRewrite(doc, target.from, target.to);
    if (!plan) return { kind: 'failed', code: 'NO_TEXT', message: t('There is no text there to change.') };
    const hunks = computeHunks(doc, plan, reply);
    if (hunks.length === 0) return { kind: 'unchanged' };
    const suggestionId = addSuggestion(editor, { label, from: plan.from, to: plan.to, hunks, reply, instruction });
    return { kind: 'suggested', suggestionId, changes: hunks.length };
  } catch (e) {
    if (e instanceof FigureSafetyError) return { kind: 'failed', code: 'FIGURE', message: e.message };
    return { kind: 'failed', code: 'INTERNAL', message: t('That reply could not be turned into changes: {reason}', { reason: String(e) }) };
  }
}

/** The range an edit works on and the text the model is given. Null if there is no text. */
export function planEdit(
  doc: ProseNode,
  action: EditAction,
  from: number,
  to: number,
): { from: number; to: number; targetText: string } | null {
  if (action === 'replace') {
    const plan = planRewrite(doc, from, to);
    return plan ? { from: plan.from, to: plan.to, targetText: planToMarkdown(doc, plan) } : null;
  }
  const plan = from < to ? planRewrite(doc, from, to) : null;
  return { from, to, targetText: plan ? stripMarkers(planToMarkdown(doc, plan)) : '' };
}

/** What the model is sent for an edit: the instructions, then the lore, text and request. */
export async function editPrompt(
  request: Pick<EditRequest, 'editor' | 'source' | 'action' | 'instruction' | 'styleId'>,
  profile: AiProfile,
  targetText: string,
): Promise<{ system: string; content: ContentBlock[] }> {
  const { editor, source, action, instruction } = request;
  const docJson = editor.getJSON() as PmNode;
  const system = action === 'insert' ? INSERT_SYSTEM : REWRITE_SYSTEM;
  const expanded = expandTemplate(instruction, {
    selection: targetText,
    page: pmToPlainText(docJson),
    book: usesVariable(instruction, 'book') ? await bookOutline(undefined, profile.isCloud) : undefined,
  });
  const selectionPlaced = usesVariable(instruction, 'selection');
  const context = await assembleContext({
    budgetTokens: contextBudget(profile),
    reservedTokens: estimateTokens(system) + estimateTokens(expanded),
    source,
    doc: docJson,
    skipDocument: usesVariable(instruction, 'page'),
    selections: targetText && !selectionPlaced ? [{ id: 'selection', title: source.title, text: targetText }] : [],
    instruction,
    styleId: request.styleId,
    asOfNodeId: asOfSource(source),
    forCloud: profile.isCloud,
  });
  return { system, content: [...contextToBlocks(context), { type: 'text', text: expanded }] };
}

/** Starts an edit. `done` always resolves, so a caller has one path to handle. */
export function startEdit(request: EditRequest): RunningEdit {
  const { editor } = request;
  const doc = editor.state.doc;
  const profile = profileForTask('rewrite', request.profileId);

  const planned = planEdit(doc, request.action, request.from, request.to);
  if (!planned) {
    return { cancel: () => {}, done: Promise.resolve({ kind: 'failed', code: 'NO_TEXT', message: t('There is no text there to change.') }) };
  }
  const { from, to, targetText } = planned;

  const borrowed = request.targetId;
  const targetId = borrowed ?? trackRange(editor, from, to, true);
  if (borrowed) markRead(editor, borrowed);
  let cancelled = false;
  let handleCancel: (() => void) | null = null;

  const run = async (): Promise<EditOutcome> => {
    if (profile.isCloud && (await isSourceLocalOnly(request.source))) {
      return { kind: 'failed', code: 'LOCAL_ONLY', message: withheldMessage(request.source.title, profile) };
    }
    const { system, content } = await editPrompt(request, profile, targetText);
    if (cancelled) return { kind: 'cancelled' };

    const messages: AiMessage[] = [{ role: 'user', content }];

    let text = '';
    let thinking = '';
    const preview = frameBatcher(() => {
      setPreviewText(targetId, stripMarkers(text));
      request.onStatus?.(text ? { phase: 'writing', text } : { phase: 'thinking', thinking });
    });
    const handle = stream(
      {
        task: 'rewrite',
        profileId: profile.id,
        system,
        messages,
        maxTokens: request.maxTokens,
      },
      {
        onText: (piece) => {
          text += piece;
          preview.schedule();
        },
        onThinking: (piece) => {
          thinking += piece;
          preview.schedule();
        },
        onRetrying: (_attempt, delayMs, reason) => request.onStatus?.({ phase: 'retrying', delayMs, reason }),
      },
    );
    handleCancel = handle.cancel;
    if (cancelled) handle.cancel();
    try {
      const result = await handle.done;
      preview.flush();
      return finishEdit(result, request, targetId, targetText);
    } catch (e) {
      preview.flush();
      if (e instanceof AiError) {
        if (e.code === 'DECLINED') return { kind: 'cancelled' };
        return { kind: 'failed', code: e.code, message: e.message };
      }
      throw e;
    }
  };

  const done = run()
    .catch((e: unknown): EditOutcome => ({ kind: 'failed', code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      setPreviewText(targetId, '');
      if (!borrowed && !editor.isDestroyed) untrack(editor, targetId);
    });

  return {
    cancel: () => {
      cancelled = true;
      handleCancel?.();
    },
    done,
  };
}
