/**
 * The prompt library, from create_prompt, update_prompt and delete_prompt. Changes go through
 * the library's own RPCs in `src/ai/api.ts`, as the Prompt library screen makes them, so the
 * AI menus update. Only the writer's own prompts are touched: the server refuses built-ins.
 * Undo compares the prompt with what the change left, and refuses if it has changed since.
 */

import * as aiApi from '../../ai/api';
import type { PromptAction, PromptScope, PromptTemplate } from '../../ai/types';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { useLocale } from '../../state/language';
import { compareTexts } from '../../wiki/diff';
import type { AnyProposal } from '../api';
import { changedSince, DiffView, goneSince } from './shared';
import { defineKind, type ApplyResult, type ProposalKind, type UndoResult } from './types';

export interface PromptFields {
  name: string;
  description: string;
  template: string;
  scope: PromptScope;
  action: PromptAction;
}

export interface NewPromptPayload {
  fields: PromptFields;
}

export interface UpdatePromptPayload {
  fields: PromptFields;
  before: PromptFields;
}

export interface DeletePromptPayload {
  before: PromptFields;
}

/** The prompt a change made or left, to find and compare later. */
interface PromptUndo {
  id: string;
}

const KEYS: (keyof PromptFields)[] = ['name', 'description', 'template', 'scope', 'action'];

function same(prompt: PromptTemplate, fields: PromptFields): boolean {
  return KEYS.every((key) => (prompt[key] ?? '') === (fields[key] ?? ''));
}

async function findPrompt(id: string): Promise<PromptTemplate | undefined> {
  return (await aiApi.prompts.list()).find((prompt) => prompt.id === id);
}

function scopeLabel(scope: PromptScope): string {
  switch (scope) {
    case 'selection': return t('Selection menu');
    case 'page': return t('Wiki pages');
    case 'scene': return t('Scenes');
    case 'chat': return t('Chat');
  }
}

function FieldsView({ fields, before }: { fields: PromptFields; before?: PromptFields }) {
  const diff = (key: keyof PromptFields) => <DiffView lines={compareTexts(before?.[key] ?? fields[key] ?? '', fields[key] ?? '')} />;
  return (
    <dl className="mcp-infobox mcp-details">
      <div>
        <dt>{t('Name')}</dt>
        <dd>{before ? diff('name') : fields.name}</dd>
      </div>
      {(fields.description || before?.description) && (
        <div>
          <dt>{t('Description')}</dt>
          <dd>{before ? diff('description') : fields.description}</dd>
        </div>
      )}
      <div>
        <dt>{t('Shows in')}</dt>
        <dd>{scopeLabel(fields.scope)}</dd>
      </div>
      <div>
        <dt>{t('Prompt')}</dt>
        <dd>{before ? diff('template') : <DiffView lines={compareTexts('', fields.template)} />}</dd>
      </div>
    </dl>
  );
}

function NewPromptCard({ proposal }: { proposal: AnyProposal<NewPromptPayload> }) {
  useLocale();
  return (
    <>
      <p className="mcp-proposal-title">{t('New prompt: {name}', { name: proposal.payload.fields.name })}</p>
      <FieldsView fields={proposal.payload.fields} />
    </>
  );
}

function UpdatePromptCard({ proposal }: { proposal: AnyProposal<UpdatePromptPayload> }) {
  useLocale();
  return (
    <>
      <p className="mcp-proposal-title">{t('Change to the prompt {name}', { name: proposal.payload.before.name })}</p>
      <FieldsView fields={proposal.payload.fields} before={proposal.payload.before} />
    </>
  );
}

function DeletePromptCard({ proposal }: { proposal: AnyProposal<DeletePromptPayload> }) {
  useLocale();
  return (
    <>
      <p className="mcp-proposal-title">{t('Delete the prompt {name}', { name: proposal.payload.before.name })}</p>
      <FieldsView fields={proposal.payload.before} />
    </>
  );
}

const save = (fields: PromptFields, id?: string) => aiApi.prompts.save({ ...fields, ...(id ? { id } : {}) });

async function applyNew(p: AnyProposal<NewPromptPayload>): Promise<ApplyResult> {
  try {
    const saved = await save(p.payload.fields);
    const undo: PromptUndo = { id: saved.id };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function undoNew(p: AnyProposal<NewPromptPayload>, undo: unknown): Promise<UndoResult> {
  const info = undo as PromptUndo | undefined;
  try {
    const prompt = info?.id ? await findPrompt(info.id) : undefined;
    if (!prompt) return { ok: false, reason: goneSince() };
    if (!same(prompt, p.payload.fields)) return { ok: false, reason: changedSince() };
    await aiApi.prompts.remove(prompt.id);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

async function applyUpdate(p: AnyProposal<UpdatePromptPayload>): Promise<ApplyResult> {
  const id = p.targetId ?? '';
  try {
    const prompt = await findPrompt(id);
    if (!prompt) return { ok: false, reason: goneSince() };
    if (prompt.builtin) return { ok: false, reason: t('Built-in prompts cannot be changed by outside tools.') };
    if (!same(prompt, p.payload.before)) return { ok: false, reason: t('The prompt has changed since this was suggested.') };
    await save(p.payload.fields, id);
    const undo: PromptUndo = { id };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function undoUpdate(p: AnyProposal<UpdatePromptPayload>): Promise<UndoResult> {
  const id = p.targetId ?? '';
  try {
    const prompt = await findPrompt(id);
    if (!prompt) return { ok: false, reason: goneSince() };
    if (!same(prompt, p.payload.fields)) return { ok: false, reason: changedSince() };
    await save(p.payload.before, id);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

async function applyDelete(p: AnyProposal<DeletePromptPayload>): Promise<ApplyResult> {
  const id = p.targetId ?? '';
  try {
    const prompt = await findPrompt(id);
    if (!prompt) return { ok: false, reason: goneSince() };
    // Deleting a built-in restores it, which is the writer's choice alone.
    if (prompt.builtin) return { ok: false, reason: t('Built-in prompts cannot be changed by outside tools.') };
    if (!same(prompt, p.payload.before)) return { ok: false, reason: t('The prompt has changed since this was suggested.') };
    await aiApi.prompts.remove(id);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true, undo: { id } satisfies PromptUndo };
}

/** The library cannot make a prompt with a chosen id, so Undo makes it again as a new one. */
async function undoDelete(p: AnyProposal<DeletePromptPayload>): Promise<UndoResult> {
  try {
    const all = await aiApi.prompts.list();
    if (all.some((prompt) => prompt.id === p.targetId)) return { ok: false, reason: changedSince() };
    await save(p.payload.before);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

export const newPromptKind = defineKind<NewPromptPayload>({
  kind: 'newPrompt',
  Card: NewPromptCard,
  apply: applyNew,
  undo: undoNew,
  accepted: () => t('Prompt added.'),
});

export const updatePromptKind = defineKind<UpdatePromptPayload>({
  kind: 'updatePrompt',
  Card: UpdatePromptCard,
  apply: applyUpdate,
  undo: undoUpdate,
  accepted: () => t('Prompt changed.'),
});

export const deletePromptKind = defineKind<DeletePromptPayload>({
  kind: 'deletePrompt',
  Card: DeletePromptCard,
  apply: applyDelete,
  undo: undoDelete,
  accepted: () => t('Prompt deleted.'),
});

export const promptsKinds: ProposalKind[] = [newPromptKind, updatePromptKind, deletePromptKind];
