/**
 * Drafting a scene. Like every AI edit, it ends in tracked changes and never touches the
 * text itself. A long draft for a local model is written in parts, each one given the draft
 * so far, and the parts arrive together as one suggestion. Stop ends it at any point, and
 * nothing is suggested then.
 */

import type { Editor } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';

import * as coreApi from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import type { AiProfile } from '../../lib/settings';
import type { NodeMeta, PmNode } from '../../lib/types';
import { toast } from '../../shell/toasts';
import { useNav } from '../../state/nav';
import { useTitles } from '../../state/project';
import { editorFor, waitForEditor } from '../../editor/ai/registry';
import { whileRunning } from '../../editor/ai/running';
import { finishEdit, planEdit, type EditAction, type EditOutcome, type RunningEdit } from '../../editor/ai/flow';
import { cleanReply, stripMarkers } from '../../editor/ai/hunks';
import { setPreviewText, trackRange, untrack } from '../../editor/ai/suggestions';
import type { EditorSource } from '../../editor/RichEditor';
import { AiError, profileForTask, stream, type AiResult, type StreamHandle } from '../client';
import { asOfSource, assembleContext, buildReadingOrder, contextBudget, contextToBlocks, estimateTokens } from '../context';
import { frameBatcher } from '../frames';
import { isSourceLocalOnly, withheldMessage } from '../limits/localOnly';
import { INSERT_SYSTEM, REWRITE_SYSTEM } from '../prompts';
import type { ContentBlock } from '../types';
import { draftInstruction, draftParts, type DraftLength, type DraftMode, type SceneBrief } from './prompts';

export interface DraftRequest {
  editor: Editor;
  source: EditorSource;
  /** `replace` turns the range (the notes) into the scene. `insert` adds at `to`. */
  action: EditAction;
  from: number;
  to: number;
  mode: DraftMode;
  length: DraftLength;
  /** The synopsis or premise. */
  plan?: string;
  label: string;
  profileId?: string;
}

/** Two pieces of a draft, as paragraphs one after the other. */
export function joinParts(soFar: string, next: string): string {
  const a = soFar.trim();
  const b = next.trim();
  return a && b ? `${a}\n\n${b}` : a || b;
}

/** The scene's point of view, cast, place and neighbours, and the pages to send as lore. */
export async function loadSceneBrief(nodeId: string, forCloud: boolean): Promise<{ brief: SceneBrief; pinned: string[] }> {
  const node = await coreApi.nodes.get(nodeId);
  const titles = new Map(useTitles.getState().entries.map((entry) => [entry.id, entry.title]));
  const cast = await coreApi.nodes.cast(nodeId).catch(() => [] as string[]);
  const tree = await coreApi.nodes.tree(node.bookId).catch(() => [] as NodeMeta[]);
  const order = buildReadingOrder([{ nodes: tree }]);
  const scenes = tree
    .filter((n) => n.kind === 'scene' && !n.deletedAt)
    .sort((a, b) => (order.index.get(a.id) ?? 0) - (order.index.get(b.id) ?? 0));
  const at = scenes.findIndex((n) => n.id === nodeId);
  // A scene marked local only is not described to a cloud model, even in passing.
  const around = (n: NodeMeta | undefined) => (n && !(forCloud && n.localOnly) ? n.synopsis.trim() || null : null);
  const brief: SceneBrief = {
    title: node.title,
    pov: node.povPageId ? titles.get(node.povPageId) ?? null : null,
    cast: cast.map((id) => titles.get(id)).filter((title): title is string => !!title),
    location: node.locationPageId ? titles.get(node.locationPageId) ?? null : null,
    before: at > 0 ? around(scenes[at - 1]) : null,
    after: at >= 0 ? around(scenes[at + 1]) : null,
  };
  const pinned = [node.povPageId, node.locationPageId, ...cast].filter((id): id is string => !!id);
  return { brief, pinned: [...new Set(pinned)] };
}

/** What one part of a draft is sent with: the context of an edit, plus the scene's own pages. */
async function draftPrompt(
  request: DraftRequest,
  profile: AiProfile,
  instruction: string,
  targetText: string,
  pinned: string[],
): Promise<{ system: string; content: ContentBlock[] }> {
  const { editor, source, action } = request;
  const system = action === 'insert' ? INSERT_SYSTEM : REWRITE_SYSTEM;
  const context = await assembleContext({
    budgetTokens: contextBudget(profile),
    reservedTokens: estimateTokens(system) + estimateTokens(instruction),
    source,
    doc: editor.getJSON() as PmNode,
    selections: action === 'replace' && targetText ? [{ id: 'selection', title: source.title, text: targetText }] : [],
    instruction,
    pinned,
    asOfNodeId: asOfSource(source),
    forCloud: profile.isCloud,
  });
  return { system, content: [...contextToBlocks(context), { type: 'text', text: instruction }] };
}

/** Starts a draft. `done` always resolves. */
export function startDraft(request: DraftRequest): RunningEdit {
  const { editor, source } = request;
  const profile = profileForTask('rewrite', request.profileId);
  const planned = planEdit(editor.state.doc, request.action, request.from, request.to);
  if (!planned || (request.action === 'replace' && !planned.targetText.trim())) {
    return { cancel: () => {}, done: Promise.resolve({ kind: 'failed', code: 'NO_TEXT', message: t('There is no text there to change.') }) };
  }
  const { from, to, targetText } = planned;
  const targetId = trackRange(editor, from, to, true);
  let cancelled = false;
  let current: StreamHandle | null = null;

  const run = async (): Promise<EditOutcome> => {
    if (source.kind !== 'node') return { kind: 'failed', code: 'NOT_SCENE', message: t('Open a scene first.') };
    if (profile.isCloud && (await isSourceLocalOnly(source))) {
      return { kind: 'failed', code: 'LOCAL_ONLY', message: withheldMessage(source.title, profile) };
    }
    const { brief, pinned } = await loadSceneBrief(source.id, profile.isCloud);
    const of = draftParts(request.length, profile.isCloud);
    const finishWith = { editor, action: request.action, label: request.label, instruction: '' };
    let soFar = '';
    let last: AiResult | null = null;
    for (let index = 1; index <= of; index += 1) {
      if (cancelled) return { kind: 'cancelled' };
      const instruction = draftInstruction({
        mode: request.mode, length: request.length, brief, plan: request.plan,
        part: of > 1 ? { index, of, soFar } : undefined,
      });
      if (index === 1) finishWith.instruction = instruction;
      const { system, content } = await draftPrompt(request, profile, instruction, targetText, pinned);
      if (cancelled) return { kind: 'cancelled' };

      let text = '';
      const written = soFar;
      const preview = frameBatcher(() => setPreviewText(targetId, stripMarkers(joinParts(written, text))));
      const handle = stream(
        { task: 'rewrite', profileId: profile.id, system, messages: [{ role: 'user', content }] },
        {
          onText: (piece) => {
            text += piece;
            preview.schedule();
          },
        },
      );
      current = handle;
      if (cancelled) handle.cancel();
      let result: AiResult;
      try {
        result = await handle.done;
      } catch (e) {
        preview.flush();
        if (e instanceof AiError) {
          if (e.code === 'DECLINED' || e.code === 'CANCELLED') return { kind: 'cancelled' };
          return { kind: 'failed', code: e.code, message: e.message };
        }
        throw e;
      }
      preview.flush();
      // Stopped, refused or cut off: what came before is not used, as with any edit.
      if (result.stopReason === 'cancelled' || result.stopReason === 'refusal' || result.stopReason === 'max_tokens') {
        return finishEdit(result, finishWith, targetId, targetText);
      }
      soFar = joinParts(soFar, cleanReply(result.text));
      last = result;
    }
    if (!last) return { kind: 'cancelled' };
    return finishEdit({ ...last, text: soFar }, finishWith, targetId, targetText);
  };

  const done = run()
    .catch((e: unknown): EditOutcome => ({ kind: 'failed', code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) }))
    .finally(() => {
      setPreviewText(targetId, '');
      if (!editor.isDestroyed) untrack(editor, targetId);
    });

  return {
    cancel: () => {
      cancelled = true;
      current?.cancel();
    },
    done,
  };
}

function report(outcome: EditOutcome): void {
  switch (outcome.kind) {
    case 'suggested':
      toast(
        outcome.changes === 1
          ? t('1 suggested change added. Review them in the document.')
          : t('{count} suggested changes added. Review them in the document.', { count: outcome.changes }),
        'success',
      );
      break;
    case 'unchanged':
      toast(t('The model had nothing to add.'));
      break;
    case 'stale':
      toast(t('The text changed while the AI was working, so its suggestion cannot be applied.'));
      break;
    case 'cancelled':
      break;
    case 'refused':
    case 'cutoff':
    case 'failed':
      toast(outcome.message, 'error');
      break;
  }
}

/** Runs a draft with a Stop button under the document, and says how it went. */
export async function runDraft(request: DraftRequest): Promise<EditOutcome> {
  const edit = startDraft(request);
  const outcome = await whileRunning(request.editor, request.label, edit.cancel, () => edit.done);
  report(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// The three ways in
// ---------------------------------------------------------------------------

/** Turns the selected notes into a scene, as tracked changes over them. */
export function writeSelectionAsScene(
  editor: Editor,
  source: EditorSource,
  range: { from: number; to: number },
  length: DraftLength,
): Promise<EditOutcome> {
  const running = runDraft({
    editor, source, action: 'replace', from: range.from, to: range.to,
    mode: 'notes', length, label: t('Write as a scene'),
  });
  // A selection left over the notes would hide the changes behind its highlight.
  try {
    if (!editor.isDestroyed) editor.commands.setTextSelection(range.to);
  } catch {
    // The range no longer resolves, so there is nothing to move.
  }
  return running;
}

/** The scene's editor, opening the scene first if it is not on screen. */
async function sceneEditor(nodeId: string) {
  const open = editorFor('node', nodeId);
  if (open) return open;
  const node = await coreApi.nodes.get(nodeId);
  useNav.getState().go({ view: 'write', bookId: node.bookId, nodeId });
  return waitForEditor('node', nodeId, 5000);
}

async function draftAtEnd(nodeId: string, mode: DraftMode, plan: string, length: DraftLength, label: string): Promise<EditOutcome | null> {
  try {
    const entry = await sceneEditor(nodeId);
    if (!entry || entry.editor.isDestroyed) {
      toast(t('That scene could not be opened.'), 'error');
      return null;
    }
    // After the last text, so an empty last line is used rather than left above the draft.
    const end = Selection.atEnd(entry.editor.state.doc).to;
    return await runDraft({ editor: entry.editor, source: entry.source, action: 'insert', from: end, to: end, mode, length, plan, label });
  } catch (e) {
    toast(errorMessage(e), 'error');
    return null;
  }
}

/**
 * Writes a scene from its synopsis, cast, location and the scenes around it, and adds the
 * draft at the end of the scene as tracked changes. Opens the scene if it is not open.
 * Resolves with how it went, or null if it could not start.
 */
export async function draftSceneFromSynopsis(nodeId: string, options: { length?: DraftLength } = {}): Promise<EditOutcome | null> {
  const node = await coreApi.nodes.get(nodeId).catch(() => null);
  if (!node) {
    toast(t('That scene could not be opened.'), 'error');
    return null;
  }
  if (!node.synopsis.trim()) {
    toast(t('This scene has no synopsis yet. Write one in its details first.'));
    return null;
  }
  return draftAtEnd(nodeId, 'synopsis', node.synopsis, options.length ?? 'medium', t('Draft from synopsis'));
}

/** A first draft of a scene from a premise the writer typed, added as tracked changes. */
export function firstDraft(nodeId: string, premise: string, length: DraftLength = 'medium'): Promise<EditOutcome | null> {
  if (!premise.trim()) return Promise.resolve(null);
  return draftAtEnd(nodeId, 'premise', premise, length, t('First draft'));
}
