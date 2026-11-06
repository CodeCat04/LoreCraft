/**
 * "Update the wiki from this chapter". The model proposes new pages, infobox values and
 * additions, each with the quote it came from, checked the same way as a finding. Nothing here
 * changes the wiki: `applyProposal` is only ever called on what the writer approved.
 */

import { estimateTokens } from '../../ai/context';
import { pmToPlainText } from '../../editor/convert';
import * as coreApi from '../../lib/api';
import { allFieldValues, fieldValueAt, type FieldChange } from '../../lib/facts';
import { titleKey } from '../../lib/text';
import type { Infobox, InfoboxField, InfoboxFieldKind, PmNode } from '../../lib/types';
import { SEMANTIC_FIELDS, TEMPLATES, templateBody, templateFor, templateInfobox } from '../../wiki/templates';
import { normalizeForQuote, originalWords, quoteProblem } from '../quotes';
import { momentOf, sceneDate, sceneTitle, type World, type WorldNode, type WorldPage } from '../rules/world';
import { pagesForScene, renderPage, usableScene } from './lore';
import { loreBlock, pageBlock, sceneBlock, WIKI_UPDATE_SCHEMA, WIKI_UPDATE_SYSTEM } from './prompts';
import { scenesWithin } from './run';
import type { AiBackend } from './types';

interface ProposalBase {
  id: string;
  quote: string;
  sceneId: string;
  sceneTitle: string;
}

export interface NewPageProposal extends ProposalBase {
  kind: 'newPage';
  title: string;
  pageType: string;
  summary: string;
}

export interface FieldProposal extends ProposalBase {
  kind: 'field';
  pageId: string;
  pageTitle: string;
  key: string;
  label: string;
  fieldKind: InfoboxFieldKind;
  value: string;
  /** What the field says at that scene. Not empty means this is a conflict to decide. */
  existing: string;
  sceneDate: string;
}

export interface AdditionProposal extends ProposalBase {
  kind: 'addition';
  pageId: string;
  pageTitle: string;
  text: string;
}

export type Proposal = NewPageProposal | FieldProposal | AdditionProposal;

export interface ProposalResult {
  proposals: Proposal[];
  /** Everything the model suggested. */
  proposed: number;
  /** Thrown away because the quote is not really in the chapter. */
  discarded: number;
  /** Already in the wiki, or naming a page that does not exist. */
  dropped: number;
  examples: string[];
  skippedLocalOnly: number;
}

interface RawProposals {
  newPages: { title: string; type: string; summary: string; quote: string }[];
  fieldValues: { page: string; field: string; value: string; quote: string }[];
  additions: { page: string; text: string; quote: string }[];
}

function listOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function parseAnswer(value: unknown): RawProposals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object with "newPages", "fieldValues" and "additions" lists.');
  }
  const answer = value as Record<string, unknown>;
  const text = (item: Record<string, unknown>, name: string) => String(item[name] ?? '').trim();
  return {
    newPages: listOf(answer.newPages).map((item) => ({ title: text(item, 'title'), type: text(item, 'type'), summary: text(item, 'summary'), quote: text(item, 'quote') })),
    fieldValues: listOf(answer.fieldValues).map((item) => ({ page: text(item, 'page'), field: text(item, 'field'), value: text(item, 'value'), quote: text(item, 'quote') })),
    additions: listOf(answer.additions).map((item) => ({ page: text(item, 'page'), text: text(item, 'text'), quote: text(item, 'quote') })),
  };
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '');
}

/** Finds the field a name means on a page, or describes the field it would be. */
export function matchField(page: WorldPage, name: string): { key: string; label: string; kind: InfoboxFieldKind; field?: InfoboxField } {
  const wanted = slug(name);
  const fields = page.infobox?.fields ?? [];
  const found = fields.find((field) => field.key === wanted || slug(field.label) === wanted);
  if (found) return { key: found.key, label: found.label, kind: found.kind, field: found };
  const semantic = SEMANTIC_FIELDS[wanted];
  if (semantic) return { key: wanted, label: semantic.label, kind: semantic.kind };
  return { key: wanted, label: name.trim(), kind: 'text' };
}

function sameValue(left: string, right: string): boolean {
  return normalizeForQuote(left) === normalizeForQuote(right);
}

let nextProposal = 0;

/** Asks the model about a chapter, and keeps what can be checked against the chapter's text. */
export async function proposeWikiUpdates(world: World, chapterId: string, backend: AiBackend, signal?: AbortSignal): Promise<ProposalResult> {
  const all = scenesWithin(world, chapterId);
  const scenes = all.filter((node) => usableScene(world, node, backend.cloud) && pmToPlainText(node.content).trim());
  const result: ProposalResult = {
    proposals: [],
    proposed: 0,
    discarded: 0,
    dropped: 0,
    examples: [],
    skippedLocalOnly: all.filter((node) => !usableScene(world, node, backend.cloud)).length,
  };
  if (scenes.length === 0) return result;

  // One request per stretch of the chapter that fits, each with the lore it mentions.
  const room = Math.floor(backend.contextTokens / 2);
  const stretches: WorldNode[][] = [];
  let current: WorldNode[] = [];
  let used = 0;
  for (const node of scenes) {
    const tokens = estimateTokens(pmToPlainText(node.content));
    if (current.length > 0 && used + tokens > room) {
      stretches.push(current);
      current = [];
      used = 0;
    }
    current.push(node);
    used += tokens;
  }
  if (current.length > 0) stretches.push(current);

  const taken = new Set<string>();
  for (const stretch of stretches) {
    const pages = new Map<string, WorldPage>();
    for (const node of stretch) {
      for (const page of pagesForScene(world, node, [], backend.cloud)) pages.set(page.id, page);
    }
    const last = stretch[stretch.length - 1];
    const lore = loreBlock([...pages.values()].map((page) => pageBlock(page.title, page.status, renderPage(world, page, momentOf(world, last), backend.cloud))));
    const sceneBlocks = stretch.map((node) => sceneBlock({ title: sceneTitle(node), 'story-date': sceneDate(world, node) }, pmToPlainText(node.content)));
    const prompt = `Propose wiki updates from this chapter.\n\n${lore}\n\n${sceneBlocks.join('\n\n')}`;
    const answer = await backend.json({ task: 'extract', system: WIKI_UPDATE_SYSTEM, prompt, schema: WIKI_UPDATE_SCHEMA, signal }, parseAnswer);

    const holderOf = (quote: string): WorldNode | undefined =>
      stretch.find((node) => !quoteProblem(quote, pmToPlainText(node.content)));
    // Proposals are kept with the project, so ids must not repeat after a restart either.
    const nextId = () => {
      nextProposal += 1;
      return `p${Date.now().toString(36)}-${nextProposal}`;
    };
    const check = (quote: string, about: string): WorldNode | null => {
      result.proposed += 1;
      const holder = holderOf(quote);
      if (!holder) {
        result.discarded += 1;
        if (result.examples.length < 8) result.examples.push(`${about}: "${quote}"`);
        return null;
      }
      return holder;
    };

    for (const item of answer.newPages) {
      const holder = check(item.quote, item.title);
      if (!holder) continue;
      const key = titleKey(item.title);
      if (!key || world.pageByName.has(key) || taken.has(`new:${key}`)) {
        result.dropped += 1;
        continue;
      }
      taken.add(`new:${key}`);
      const text = pmToPlainText(holder.content);
      result.proposals.push({
        kind: 'newPage',
        id: nextId(),
        title: item.title.trim(),
        pageType: TEMPLATES.some((template) => template.type === item.type) ? item.type : 'article',
        summary: item.summary,
        quote: originalWords(item.quote, text),
        sceneId: holder.id,
        sceneTitle: sceneTitle(holder),
      });
    }

    for (const item of answer.fieldValues) {
      const holder = check(item.quote, `${item.page}, ${item.field}`);
      if (!holder) continue;
      const page = world.pageByName.get(titleKey(item.page));
      if (!page || !item.field || !item.value) {
        result.dropped += 1;
        continue;
      }
      const match = matchField(page, item.field);
      const existing = match.field ? fieldValueAt(match.field, momentOf(world, holder), world.resolver) : '';
      const known = match.field ? allFieldValues(match.field) : [];
      const key = `field:${page.id}:${match.key}:${normalizeForQuote(item.value)}`;
      if (known.some((value) => sameValue(value, item.value)) || taken.has(key)) {
        result.dropped += 1;
        continue;
      }
      taken.add(key);
      result.proposals.push({
        kind: 'field',
        id: nextId(),
        pageId: page.id,
        pageTitle: page.title,
        key: match.key,
        label: match.label,
        fieldKind: match.kind,
        value: item.value,
        existing: existing.trim(),
        quote: originalWords(item.quote, pmToPlainText(holder.content)),
        sceneId: holder.id,
        sceneTitle: sceneTitle(holder),
        sceneDate: sceneDate(world, holder),
      });
    }

    for (const item of answer.additions) {
      const holder = check(item.quote, item.page);
      if (!holder) continue;
      const page = world.pageByName.get(titleKey(item.page));
      if (!page || !item.text) {
        result.dropped += 1;
        continue;
      }
      result.proposals.push({
        kind: 'addition',
        id: nextId(),
        pageId: page.id,
        pageTitle: page.title,
        text: item.text,
        quote: originalWords(item.quote, pmToPlainText(holder.content)),
        sceneId: holder.id,
        sceneTitle: sceneTitle(holder),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Applying what the writer approved
// ---------------------------------------------------------------------------

/** Puts a new value on an infobox, as a change over time or replacing what is there. */
export function withFieldValue(infobox: Infobox, proposal: FieldProposal, how: 'change' | 'replace'): Infobox {
  const fields = [...(infobox.fields ?? [])];
  const at = fields.findIndex((field) => field.key === proposal.key);
  if (at < 0) {
    fields.push({ key: proposal.key, label: proposal.label, kind: proposal.fieldKind, value: proposal.value });
    return { ...infobox, fields };
  }
  const field = fields[at];
  if (!field.value.trim() && !field.changes?.length) {
    fields[at] = { ...field, value: proposal.value };
  } else if (how === 'replace') {
    fields[at] = { ...field, value: proposal.value };
  } else {
    const change: FieldChange = { nodeId: proposal.sceneId, value: proposal.value, note: `From ${proposal.sceneTitle}` };
    if (proposal.sceneDate) change.date = proposal.sceneDate;
    fields[at] = { ...field, changes: [...(field.changes ?? []), change] };
  }
  return { ...infobox, fields };
}

/** Adds a paragraph to the end of a document, in place of an empty last one. */
export function withParagraph(doc: PmNode, text: string): PmNode {
  const content = [...(doc.content ?? [])];
  const last = content[content.length - 1];
  if (last?.type === 'paragraph' && !last.content?.length) content.pop();
  content.push({ type: 'paragraph', content: [{ type: 'text', text }] });
  return { ...doc, content };
}

/** Makes one approved change. Reads the page fresh, so it cannot undo a later edit. */
export async function applyProposal(proposal: Proposal, how: 'change' | 'replace' = 'change'): Promise<void> {
  switch (proposal.kind) {
    case 'newPage': {
      const template = templateFor(proposal.pageType);
      await coreApi.pages.create({
        title: proposal.title,
        pageType: template.type,
        status: 'draft',
        summary: proposal.summary,
        content: templateBody(template),
        infobox: templateInfobox(template),
      });
      return;
    }
    case 'field': {
      const page = await coreApi.pages.get(proposal.pageId);
      await coreApi.revisions.checkpoint('page', page.id, 'ai').catch(() => null);
      await coreApi.pages.update(page.id, { infobox: withFieldValue(page.infobox, proposal, how) });
      return;
    }
    case 'addition': {
      const page = await coreApi.pages.get(proposal.pageId);
      await coreApi.revisions.checkpoint('page', page.id, 'ai').catch(() => null);
      await coreApi.pages.update(page.id, { content: withParagraph(page.content, proposal.text) });
      return;
    }
  }
}
