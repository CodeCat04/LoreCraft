/** The request behind Describe with the senses: the selection, the lore around it, and one ask. */

import type { Editor } from '@tiptap/core';

import type { EditorSource } from '../../editor/RichEditor';
import { planRewrite, planToPlainText } from '../../editor/ai/hunks';
import { markRead, trackedRange } from '../../editor/ai/suggestions';
import { t } from '../../lib/i18n';
import type { PmNode } from '../../lib/types';
import { AiError, complete, profileForTask } from '../client';
import { asOfSource, assembleContext, contextBudget, contextToBlocks, estimateTokens } from '../context';
import { isSourceLocalOnly, withheldMessage } from '../limits/localOnly';
import type { ContentBlock } from '../types';
import { SENSES_SYSTEM } from './senses';

export interface SensesAsk {
  editor: Editor;
  source: EditorSource;
  targetId: string;
  /** The request, from `sensesRequest` or `moreRequest`. */
  request: string;
  signal?: AbortSignal;
}

/** The selected text as the model reads it. */
export function selectedText(editor: Editor, targetId: string): string {
  const range = trackedRange(editor, targetId);
  if (!range || editor.isDestroyed) return '';
  const doc = editor.state.doc;
  const plan = planRewrite(doc, range.from, range.to);
  return (plan ? planToPlainText(doc, plan) : doc.textBetween(range.from, range.to, '\n\n')).trim();
}

/** The reply's text. Rejects with an `AiError` when there is none, or it was stopped. */
export async function askSenses({ editor, source, targetId, request, signal }: SensesAsk): Promise<string> {
  const profile = profileForTask('rewrite');
  if (profile.isCloud && (await isSourceLocalOnly(source))) {
    throw new AiError('LOCAL_ONLY', withheldMessage(source.title, profile));
  }
  const text = selectedText(editor, targetId);
  if (!text) throw new AiError('NO_TEXT', t('There is no text there to describe.'));
  markRead(editor, targetId);
  const context = await assembleContext({
    budgetTokens: contextBudget(profile),
    reservedTokens: estimateTokens(SENSES_SYSTEM) + estimateTokens(request),
    source,
    doc: editor.getJSON() as PmNode,
    selections: [{ id: 'selection', title: source.title, text }],
    // The selection names the places, people and things whose lore matters here.
    instruction: text,
    asOfNodeId: asOfSource(source),
    forCloud: profile.isCloud,
  });
  const content: ContentBlock[] = [...contextToBlocks(context), { type: 'text', text: request }];
  const result = await complete({ task: 'rewrite', profileId: profile.id, system: SENSES_SYSTEM, messages: [{ role: 'user', content }], signal });
  if (result.stopReason === 'cancelled') throw new AiError('CANCELLED', t('Stopped.'));
  return result.text;
}
