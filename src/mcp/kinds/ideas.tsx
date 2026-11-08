/**
 * The idea inbox, from add_idea, update_idea, resolve_idea and idea_to_page. Changes go
 * through the inbox's own RPCs in `src/inbox/api.ts`, so the Inbox screen and its count
 * update. A page made from an idea is made the way the Inbox makes one, with status idea and
 * the idea's text (`src/inbox/ideaToPage.ts`). Undo refuses if the idea has changed since.
 */

import * as api from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { useLocale } from '../../state/language';
import { compareTexts } from '../../wiki/diff';
import { templateBody, templateFor, templateInfobox } from '../../wiki/templates';
import { ideas, type Idea, type IdeaStatus } from '../../inbox/api';
import { bodyFromIdea } from '../../inbox/ideaToPage';
import type { AnyProposal } from '../api';
import { changedSince, DiffView, goneSince, undoCreated, type CreatedUndo } from './shared';
import { defineKind, type ApplyResult, type ProposalKind, type UndoResult } from './types';

export interface AddIdeaPayload {
  text: string;
}

export interface UpdateIdeaPayload {
  text: string;
  before: string;
}

export interface ResolveIdeaPayload {
  status: IdeaStatus;
  before: IdeaStatus;
}

export interface IdeaToPagePayload {
  title: string;
  pageType: string;
  text: string;
  before: IdeaStatus;
}

/** What Undo checks: the idea, as the change left it. */
interface IdeaUndo {
  id: string;
  updatedAt: string;
}

interface IdeaToPageUndo {
  idea: IdeaUndo;
  page: CreatedUndo;
}

async function findIdea(id: string): Promise<Idea | undefined> {
  return (await ideas.list()).find((idea) => idea.id === id);
}

function IdeaText({ text }: { text: string }) {
  return (
    <div className="mcp-new-page">
      {text.split(/\n+/).filter(Boolean).map((line, index) => (
        <p key={index}>{line}</p>
      ))}
    </div>
  );
}

function AddIdeaCard({ proposal }: { proposal: AnyProposal<AddIdeaPayload> }) {
  useLocale();
  return (
    <>
      <p className="mcp-proposal-title">{t('A new idea for the inbox')}</p>
      <IdeaText text={proposal.payload.text} />
    </>
  );
}

function UpdateIdeaCard({ proposal }: { proposal: AnyProposal<UpdateIdeaPayload> }) {
  useLocale();
  return (
    <>
      <p className="mcp-proposal-title">{t('Change to an idea')}</p>
      <DiffView lines={compareTexts(proposal.payload.before, proposal.payload.text)} />
    </>
  );
}

function ResolveIdeaCard({ proposal }: { proposal: AnyProposal<ResolveIdeaPayload> }) {
  useLocale();
  return (
    <p className="mcp-proposal-title">
      {proposal.payload.status === 'done' ? t('Mark an idea as done') : t('Open an idea again')}
    </p>
  );
}

function IdeaToPageCard({ proposal }: { proposal: AnyProposal<IdeaToPagePayload> }) {
  useLocale();
  return (
    <>
      <p className="mcp-proposal-title">{t('Turn an idea into the page {title}', { title: proposal.payload.title })}</p>
      <IdeaText text={proposal.payload.text} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Apply and undo
// ---------------------------------------------------------------------------

async function applyAdd(p: AnyProposal<AddIdeaPayload>): Promise<ApplyResult> {
  try {
    const idea = await ideas.add({ text: p.payload.text });
    const undo: IdeaUndo = { id: idea.id, updatedAt: idea.updatedAt };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** An idea the writer has not touched since goes again. */
async function undoAdd(_p: AnyProposal<AddIdeaPayload>, undo: unknown): Promise<UndoResult> {
  const info = undo as IdeaUndo | undefined;
  try {
    const idea = info?.id ? await findIdea(info.id) : undefined;
    if (!idea) return { ok: false, reason: goneSince() };
    if (idea.updatedAt !== info!.updatedAt) return { ok: false, reason: changedSince() };
    await ideas.remove(idea.id);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

async function applyUpdate(p: AnyProposal<UpdateIdeaPayload>): Promise<ApplyResult> {
  try {
    const idea = await findIdea(p.targetId ?? '');
    if (!idea) return { ok: false, reason: goneSince() };
    if (idea.text !== p.payload.before) return { ok: false, reason: t('The idea has changed since this was suggested.') };
    const after = await ideas.update(idea.id, { text: p.payload.text });
    const undo: IdeaUndo = { id: idea.id, updatedAt: after.updatedAt };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function undoUpdate(p: AnyProposal<UpdateIdeaPayload>): Promise<UndoResult> {
  try {
    const idea = await findIdea(p.targetId ?? '');
    if (!idea) return { ok: false, reason: goneSince() };
    if (idea.text !== p.payload.text) return { ok: false, reason: changedSince() };
    await ideas.update(idea.id, { text: p.payload.before });
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

async function applyResolve(p: AnyProposal<ResolveIdeaPayload>): Promise<ApplyResult> {
  try {
    const idea = await findIdea(p.targetId ?? '');
    if (!idea) return { ok: false, reason: goneSince() };
    if (idea.status === p.payload.status) return { ok: false, reason: t('The idea is already like that.') };
    const after = await ideas.update(idea.id, { status: p.payload.status });
    const undo: IdeaUndo = { id: idea.id, updatedAt: after.updatedAt };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function undoResolve(p: AnyProposal<ResolveIdeaPayload>): Promise<UndoResult> {
  try {
    const idea = await findIdea(p.targetId ?? '');
    if (!idea) return { ok: false, reason: goneSince() };
    if (idea.status !== p.payload.status) return { ok: false, reason: changedSince() };
    await ideas.update(idea.id, { status: p.payload.before });
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

/** As the Inbox's "Turn into a page": the page has status idea, and the idea is done. */
async function applyToPage(p: AnyProposal<IdeaToPagePayload>): Promise<ApplyResult> {
  const { title, pageType } = p.payload;
  try {
    const idea = await findIdea(p.targetId ?? '');
    if (!idea) return { ok: false, reason: goneSince() };
    const template = templateFor(pageType);
    const page = await api.pages.create({
      title,
      pageType,
      status: 'idea',
      content: bodyFromIdea(templateBody(template), idea.text, title),
      infobox: templateInfobox(template),
    });
    const after = await ideas.update(idea.id, { status: 'done' });
    const undo: IdeaToPageUndo = {
      idea: { id: idea.id, updatedAt: after.updatedAt },
      page: { kind: 'page', id: page.id, updatedAt: (await api.pages.get(page.id)).updatedAt },
    };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Moves the page to the trash, then puts the idea's status back if nobody has changed it. */
async function undoToPage(p: AnyProposal<IdeaToPagePayload>, undo: unknown): Promise<UndoResult> {
  const info = undo as IdeaToPageUndo | undefined;
  if (!info?.page) return { ok: false, reason: goneSince() };
  const result = await undoCreated(info.page);
  if (!result.ok) return result;
  try {
    const idea = await findIdea(info.idea.id);
    if (idea && idea.status === 'done' && idea.updatedAt === info.idea.updatedAt) {
      await ideas.update(idea.id, { status: p.payload.before });
    }
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

export const addIdeaKind = defineKind<AddIdeaPayload>({
  kind: 'addIdea',
  Card: AddIdeaCard,
  apply: applyAdd,
  undo: undoAdd,
  accepted: () => t('Idea added to the inbox.'),
});

export const updateIdeaKind = defineKind<UpdateIdeaPayload>({
  kind: 'updateIdea',
  Card: UpdateIdeaCard,
  apply: applyUpdate,
  undo: undoUpdate,
  accepted: () => t('Idea changed.'),
});

export const resolveIdeaKind = defineKind<ResolveIdeaPayload>({
  kind: 'resolveIdea',
  Card: ResolveIdeaCard,
  apply: applyResolve,
  undo: undoResolve,
  accepted: () => t('Idea changed.'),
});

export const ideaToPageKind = defineKind<IdeaToPagePayload>({
  kind: 'ideaToPage',
  Card: IdeaToPageCard,
  apply: applyToPage,
  undo: undoToPage,
  accepted: () => t('Page created from the idea.'),
});

export const ideasKinds: ProposalKind[] = [addIdeaKind, updateIdeaKind, resolveIdeaKind, ideaToPageKind];
