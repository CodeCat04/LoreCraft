/**
 * Actions on a whole page or scene. Each ends in a suggestion: tracked changes for text,
 * and a review dialog for a field, since fields are not part of the document. They work on
 * a brand-new page with only a title, which is often when they are most useful.
 */

import type { Editor } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';

import * as coreApi from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage, rpc } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { activeEditor, startEdit, whileRunning, type EditOutcome, type EditorEntry } from '../editor/ai';
import type { Infobox, InfoboxField, InfoboxFieldKind, NodeMeta, PageMeta, PmNode } from '../lib/types';
import { AiError, complete, completeJson, profileForTask } from './client';
import { asOfSource, assembleContext, contextBudget, contextToBlocks, estimateTokens } from './context';
import * as api from './api';
import { isSourceLocalOnly, withheldMessage } from './limits/localOnly';
import { FIELD_SYSTEM } from './prompts';
import { guidedInstruction } from './drafting/guided';
import { openGuidedContinue } from './drafting/store';
import { reviewField, reviewInfobox } from './reviewDialogs';
import type { ContentBlock } from './types';

type DocKind = 'page' | 'node';

/**
 * Saves a field the writer accepted from the AI. What was there goes into the page's or
 * scene's history first, in the same step, so the change can be taken back.
 */
export const acceptedFromAi = {
  page: (id: string, patch: coreApi.PagePatch) => rpc<PageMeta>('pages.update', { id, patch, snapshot: 'ai' }),
  node: (id: string, patch: coreApi.NodePatch) => rpc<NodeMeta>('nodes.update', { id, patch, snapshot: 'ai' }),
};

function currentDocument(kind: DocKind): EditorEntry | null {
  const entry = activeEditor();
  return entry && entry.source.kind === kind ? entry : null;
}

export function hasOpenPage(): boolean {
  return currentDocument('page') !== null;
}

export function hasOpenScene(): boolean {
  return currentDocument('node') !== null;
}

async function templateFor(id: string): Promise<string> {
  const prompts = await api.prompts.list().catch(() => []);
  const found = prompts.find((prompt) => prompt.id === id);
  if (!found) throw new AiError('NO_PROMPT', t('That prompt could not be found.'));
  return found.template;
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
      toast(t('The model suggested no changes.'));
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

/**
 * Runs a prompt over the whole document, or at its end, as tracked changes. `direction` is
 * what the writer added in the Guided Continue box, if anything.
 */
async function editWholeDocument(kind: DocKind, promptId: string, label: string, action: 'replace' | 'insert', direction = ''): Promise<void> {
  const entry = currentDocument(kind);
  if (!entry) return;
  const { editor, source } = entry;
  try {
    const instruction = guidedInstruction(await templateFor(promptId), direction);
    const { doc } = editor.state;
    // Adding goes at the end of the last text, so an empty last line is used, not left above.
    const end = Selection.atEnd(doc).to;
    const edit = startEdit({
      editor, source, label, action, instruction,
      from: action === 'insert' ? end : 0,
      to: action === 'insert' ? end : doc.content.size,
    });
    report(await whileRunning(editor, label, edit.cancel, () => edit.done));
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export const fleshOutPage = () => editWholeDocument('page', 'builtin:flesh-out', t('Flesh out this page'), 'replace');

/** Opens the Guided Continue box. Run with nothing typed and one version, it is Continue as it always was. */
export function continueScene(): void {
  const entry = currentDocument('node');
  if (!entry) return;
  openGuidedContinue(entry.editor, entry.source, {
    template: () => templateFor('builtin:scene-continue'),
    runOne: (direction) => editWholeDocument('node', 'builtin:scene-continue', t('Continue writing'), 'insert', direction),
  });
}

/** The context a field-filling request goes out with. */
async function fieldMessages(editor: Editor, entry: EditorEntry, instruction: string, task: 'rewrite' | 'extract') {
  const profile = profileForTask(task);
  if (profile.isCloud && (await isSourceLocalOnly(entry.source))) {
    throw new AiError('LOCAL_ONLY', withheldMessage(entry.source.title, profile));
  }
  const context = await assembleContext({
    budgetTokens: contextBudget(profile),
    reservedTokens: estimateTokens(FIELD_SYSTEM) + estimateTokens(instruction),
    source: entry.source,
    doc: editor.getJSON() as PmNode,
    instruction,
    forCloud: profile.isCloud,
    asOfNodeId: asOfSource(entry.source),
  });
  const content: ContentBlock[] = [...contextToBlocks(context), { type: 'text', text: instruction }];
  return [{ role: 'user' as const, content }];
}

async function fieldAction(kind: DocKind, promptId: string, label: string, apply: (entry: EditorEntry, text: string) => Promise<void>): Promise<void> {
  const entry = currentDocument(kind);
  if (!entry) return;
  const stopper = new AbortController();
  try {
    const result = await whileRunning(entry.editor, label, () => stopper.abort(), async () => {
      const instruction = await templateFor(promptId);
      const messages = await fieldMessages(entry.editor, entry, instruction, 'rewrite');
      return complete({ task: 'rewrite', system: FIELD_SYSTEM, messages, signal: stopper.signal });
    });
    await apply(entry, result.text.trim());
  } catch (e) {
    if (!(e instanceof AiError && (e.code === 'DECLINED' || e.code === 'CANCELLED'))) toast(errorMessage(e), 'error');
  }
}

export const summarizePage = () =>
  fieldAction('page', 'builtin:summary', t('Write a summary'), async (entry, text) => {
    const page = await coreApi.pages.get(entry.source.id);
    const accepted = await reviewField({ title: t('Summary of {title}', { title: page.title }), before: page.summary, after: text });
    if (accepted !== null) {
      await acceptedFromAi.page(page.id, { summary: accepted });
      toast(t('Summary updated.'), 'success');
    }
  });

export const describeSynopsis = () =>
  fieldAction('node', 'builtin:synopsis', t("Describe this scene's synopsis"), async (entry, text) => {
    const node = await coreApi.nodes.get(entry.source.id);
    const accepted = await reviewField({ title: t('Synopsis of {title}', { title: node.title }), before: node.synopsis, after: text });
    if (accepted !== null) {
      await acceptedFromAi.node(node.id, { synopsis: accepted });
      toast(t('Synopsis updated.'), 'success');
    }
  });

const FIELD_KINDS: InfoboxFieldKind[] = ['text', 'longtext', 'date', 'number', 'page', 'pages'];

function parseInfoboxFields(value: unknown): InfoboxField[] {
  const list = Array.isArray(value) ? value : (value as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(list)) throw new Error('Expected an object with a "fields" list.');
  return list.map((item, index) => {
    const field = item as Partial<InfoboxField> | null;
    if (!field || typeof field.label !== 'string' || !field.label.trim()) throw new Error(`Field ${index + 1} needs a "label".`);
    const kind = FIELD_KINDS.includes(field.kind as InfoboxFieldKind) ? (field.kind as InfoboxFieldKind) : 'text';
    return {
      key: field.label.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, ''),
      label: field.label.trim(),
      kind,
      // A field with no value yet is a real suggestion: it is there for the writer to fill in.
      value: String(field.value ?? '').trim(),
    };
  }).filter((field, index, all) => all.findIndex((other) => other.key === field.key) === index);
}

const INFOBOX_SCHEMA = {
  name: 'infobox_fields',
  schema: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
            kind: { type: 'string', enum: FIELD_KINDS },
          },
          required: ['label', 'value', 'kind'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields'],
    additionalProperties: false,
  },
};

export async function suggestInfobox(): Promise<void> {
  const entry = currentDocument('page');
  if (!entry) return;
  const stopper = new AbortController();
  try {
    const page = await coreApi.pages.get(entry.source.id);
    const fields = await whileRunning(entry.editor, t('Suggest infobox fields'), () => stopper.abort(), async () => {
      const known = (page.infobox?.fields ?? []).map((f) => `${f.label}: ${f.value}`).join('\n');
      const base = await templateFor('builtin:infobox');
      const instruction = `${base}\n\nThe page is called "${page.title}". Reply with JSON: {"fields": [{"label": "Born", "value": "...", "kind": "text"}]}. "kind" is one of ${FIELD_KINDS.join(', ')}. Use "page" for a link to one wiki page and "pages" for a comma-separated list of them.${known ? `\n\nIt already has these fields, so suggest others or better values:\n${known}` : ''}`;
      const messages = await fieldMessages(entry.editor, entry, instruction, 'extract');
      return completeJson({ task: 'extract', system: FIELD_SYSTEM, messages, schema: INFOBOX_SCHEMA, signal: stopper.signal }, parseInfoboxFields);
    });
    if (fields.length === 0) {
      toast(t('The model had no fields to suggest.'));
      return;
    }
    const chosen = await reviewInfobox({ pageTitle: page.title, existing: page.infobox?.fields ?? [], suggested: fields });
    if (!chosen || chosen.length === 0) return;
    const fresh = await coreApi.pages.get(page.id);
    const merged: InfoboxField[] = [...(fresh.infobox?.fields ?? [])];
    for (const field of chosen) {
      const at = merged.findIndex((f) => f.key === field.key);
      if (at >= 0) merged[at] = { ...merged[at], ...field };
      else merged.push(field);
    }
    const infobox: Infobox = { ...fresh.infobox, fields: merged };
    await acceptedFromAi.page(page.id, { infobox });
    toast(t('Infobox updated.'), 'success');
  } catch (e) {
    if (!(e instanceof AiError && (e.code === 'DECLINED' || e.code === 'CANCELLED'))) toast(errorMessage(e), 'error');
  }
}
