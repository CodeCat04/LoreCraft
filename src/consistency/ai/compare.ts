/**
 * Step two of an AI check: comparing what a scene says with the wiki and with other scenes.
 *
 * A model's answer is only a proposal. Each one has to survive being checked here: both of its
 * quotes must really be in their sources, the page it cites must state facts, and it must not
 * be two values a field holds at different moments. Everything thrown away is counted, because
 * whether this catches invented contradictions is a promise of the plan.
 */

import { estimateTokens } from '../../ai/context';
import { pmToPlainText } from '../../editor/convert';
import { allFieldValues, fieldValueAt, type StoryMoment } from '../../lib/facts';
import { t } from '../../lib/i18n';
import { titleKey } from '../../lib/text';
import { indexOfWhole, normalizeForQuote, originalWords, quoteProblem, sentenceHolding } from '../quotes';
import {
  momentOf,
  sceneDate,
  sceneEvidence,
  sceneTitle,
  pageEvidence,
  statesFacts,
  type World,
  type WorldNode,
  type WorldPage,
} from '../rules/world';
import type { Evidence, FindingDraft, FindingSeverity } from '../types';
import type { Claim } from './claims';
import { contentHash, pagesForPage, pagesForScene, renderPage, subjectPage, usablePage, usableScene } from './lore';
import { BETWEEN_SCHEMA, BETWEEN_SYSTEM, COMPARE_SCHEMA, COMPARE_SYSTEM, loreBlock, PAGE_COMPARE_SYSTEM, pageBlock, sceneBlock } from './prompts';
import type { AiBackend, RunStats } from './types';

type Confidence = 'high' | 'medium' | 'low';

interface LoreContradiction {
  sceneQuote: string;
  pageTitle: string;
  loreQuote: string;
  explanation: string;
  confidence: Confidence;
}

function asConfidence(value: unknown): Confidence {
  return value === 'high' || value === 'low' ? value : 'medium';
}

function parseLoreAnswer(value: unknown): LoreContradiction[] {
  const list = Array.isArray(value) ? value : (value as { contradictions?: unknown } | null)?.contradictions;
  if (!Array.isArray(list)) throw new Error('Expected an object with a "contradictions" list.');
  return list.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    return {
      sceneQuote: String(entry.sceneQuote ?? ''),
      pageTitle: String(entry.pageTitle ?? ''),
      loreQuote: String(entry.loreQuote ?? ''),
      explanation: String(entry.explanation ?? ''),
      confidence: asConfidence(entry.confidence),
    };
  });
}

/** A model explaining why something is fine, in a list of what is wrong. */
const SAYS_NO_CONFLICT =
  /\b(no (?:real |actual )?(?:contradiction|conflict|inconsistency)|not (?:a |an )?(?:contradiction|conflict|inconsistency)|does(?: not|n't) (?:contradict|conflict)|is consistent with|are consistent|consistent with|no issue|not contradictory)\b/i;

function noteDiscard(stats: RunStats, text: string) {
  stats.discardedQuotes += 1;
  if (stats.discardedExamples.length < 8) stats.discardedExamples.push(text.slice(0, 200));
}

/** The same sentence on both sides, whatever a model says about it. */
function sameWords(left: string, right: string): boolean {
  return normalizeForQuote(left) === normalizeForQuote(right);
}

/**
 * True if the two quotes hold values a field takes at different moments. A hair color in the
 * scene that is a value this field has at the scene's moment agrees with the wiki, even if
 * the other quote shows another of its values.
 */
export function isKnownChange(world: World, page: WorldPage, left: { quote: string; moment: StoryMoment | null }, right: { quote: string; moment: StoryMoment | null }): boolean {
  const leftText = normalizeForQuote(left.quote);
  const rightText = normalizeForQuote(right.quote);
  for (const field of page.infobox?.fields ?? []) {
    if (!field.changes?.length) continue;
    const values = allFieldValues(field).map((value) => normalizeForQuote(value)).filter(Boolean);
    const inLeft = values.filter((value) => indexOfWhole(leftText, value) >= 0);
    const inRight = values.filter((value) => indexOfWhole(rightText, value) >= 0);
    if (inLeft.length === 0 || inRight.length === 0) continue;
    const at = (moment: StoryMoment | null) => (moment ? normalizeForQuote(fieldValueAt(field, moment, world.resolver)) : null);
    const leftNow = at(left.moment);
    const rightNow = at(right.moment);
    const leftFits = leftNow === null || inLeft.includes(leftNow);
    const rightFits = rightNow === null || inRight.includes(rightNow);
    if (leftFits && rightFits) return true;
  }
  return false;
}

function severityFor(page: WorldPage, confidence: Confidence): FindingSeverity {
  if (page.status !== 'canon') return 'info';
  return confidence === 'high' ? 'error' : 'warning';
}

/** One page as it goes to the model, and the words its quotes are checked against. */
interface LoreBlock {
  page: WorldPage;
  block: string;
  text: string;
}

/** Splits pages into groups that each fit one request. */
function batchPages(blocks: LoreBlock[], room: number): LoreBlock[][] {
  const batches: LoreBlock[][] = [];
  let current: LoreBlock[] = [];
  let used = 0;
  for (const item of blocks) {
    const tokens = estimateTokens(item.block);
    if (current.length > 0 && used + tokens > room) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface SceneComparison {
  /** A fingerprint of everything this comparison read. Unchanged means skip it next time. */
  lorePrint: string;
  pages: WorldPage[];
  blocks: LoreBlock[];
  sceneAttrs: Record<string, string>;
  text: string;
  moment: StoryMoment;
}

/** Everything the model will read for a scene, without asking it anything yet. */
export function prepareComparison(world: World, node: WorldNode, claims: Claim[], cloud: boolean): SceneComparison {
  const moment = momentOf(world, node);
  const pages = pagesForScene(world, node, claims.map((claim) => claim.subject), cloud);
  const blocks = pages.map((page) => {
    const text = renderPage(world, page, moment, cloud);
    return { page, text, block: pageBlock(page.title, page.status, text) };
  });
  // Even the name of a local-only page stays here.
  const titleOf = (id: string | null | undefined) => {
    const page = id ? world.pageById.get(id) : undefined;
    return page && usablePage(page, cloud) ? page.title : '';
  };
  const sceneAttrs: Record<string, string> = {
    title: sceneTitle(node),
    'story-date': sceneDate(world, node),
    'point-of-view': titleOf(node.povPageId),
    location: titleOf(node.locationPageId),
    cast: (node.castPageIds ?? []).map(titleOf).filter(Boolean).join(', '),
  };
  const text = pmToPlainText(node.content);
  const lorePrint = contentHash([JSON.stringify(sceneAttrs), ...blocks.map((b) => b.block)].join('\n'), COMPARE_SYSTEM);
  return { lorePrint, pages, blocks, sceneAttrs, text, moment };
}

/** The claims already taken from this text, so that the model checks those first. */
function claimsSection(claims: Claim[]): string {
  if (claims.length === 0) return '';
  const lines = claims.slice(0, 60).map((claim) => `- ${claim.subject}: ${claim.claim}`);
  return `\n\nClaims found in this text, to compare first:\n${lines.join('\n')}`;
}

/** What is being checked, whether a scene or a wiki page. */
interface CheckedSource {
  id: string;
  title: string;
  text: string;
  moment: StoryMoment | null;
  evidence: (quote: string) => Evidence;
  /** How the rule and severity follow from the page it contradicts. */
  rule: (page: WorldPage) => string;
  severity: (page: WorldPage, confidence: Confidence) => FindingSeverity;
}

async function compareWithLore(
  world: World,
  source: CheckedSource,
  blocks: LoreBlock[],
  request: { system: string; intro: string; block: (body: string) => string },
  claims: Claim[],
  backend: AiBackend,
  stats: RunStats,
  signal?: AbortSignal,
): Promise<FindingDraft[]> {
  if (blocks.length === 0 || !source.text.trim()) return [];

  // Text longer than this is compared through its claims alone, since those were read in pieces.
  const claimsOnly = estimateTokens(source.text) > Math.floor(backend.contextTokens / 3);
  const body = claimsOnly
    ? `This is long, so these are the exact statements taken from it:\n${claims.map((claim) => `"${claim.quote}"`).join('\n')}`
    : source.text;
  const block = request.block(body);
  const room = Math.max(1000, backend.contextTokens - estimateTokens(block) - estimateTokens(request.system) - 1000);

  const findings: FindingDraft[] = [];
  const seen = new Set<string>();
  for (const batch of batchPages(blocks, room)) {
    const prompt = `${request.intro}\n\n${loreBlock(batch.map((item) => item.block))}\n\n${block}${claimsSection(claims)}`;
    const answer = await backend.json({ task: 'consistency', system: request.system, prompt, schema: COMPARE_SCHEMA, signal }, parseLoreAnswer);
    for (const item of answer) {
      stats.proposed += 1;
      const finding = checkLoreAnswer(world, source, item, batch, stats);
      if (finding && !seen.has(finding.fingerprint)) {
        seen.add(finding.fingerprint);
        findings.push(finding);
        stats.kept += 1;
      }
    }
  }
  return findings;
}

/** Compares a scene with the lore it mentions. Returns the findings that survive checking. */
export function compareSceneToLore(
  world: World,
  node: WorldNode,
  claims: Claim[],
  prepared: SceneComparison,
  backend: AiBackend,
  stats: RunStats,
  signal?: AbortSignal,
): Promise<FindingDraft[]> {
  const source: CheckedSource = {
    id: node.id,
    title: sceneTitle(node),
    text: prepared.text,
    moment: prepared.moment,
    evidence: (quote) => sceneEvidence(node, quote),
    rule: (page) => (page.status === 'canon' ? 'contradicts-lore' : 'contradicts-draft'),
    severity: severityFor,
  };
  return compareWithLore(
    world,
    source,
    prepared.blocks,
    {
      system: COMPARE_SYSTEM,
      intro: 'Check this scene against these wiki pages.',
      block: (body) => sceneBlock(prepared.sceneAttrs, body),
    },
    claims,
    backend,
    stats,
    signal,
  );
}

/** The canon pages a wiki page should agree with, and a fingerprint of what will be read. */
export function preparePageComparison(world: World, page: WorldPage, claims: Claim[], cloud: boolean): { lorePrint: string; blocks: LoreBlock[]; text: string } {
  const text = renderPage(world, page, null, cloud);
  const others = pagesForPage(world, page, claims.map((claim) => claim.subject), cloud);
  const blocks = others.map((other) => {
    const otherText = renderPage(world, other, null, cloud);
    return { page: other, text: otherText, block: pageBlock(other.title, other.status, otherText) };
  });
  return { lorePrint: contentHash(blocks.map((b) => b.block).join('\n'), PAGE_COMPARE_SYSTEM), blocks, text };
}

/** Compares a wiki page with the canon pages it mentions. */
export function comparePageToLore(
  world: World,
  page: WorldPage,
  claims: Claim[],
  prepared: { blocks: LoreBlock[]; text: string },
  backend: AiBackend,
  stats: RunStats,
  signal?: AbortSignal,
): Promise<FindingDraft[]> {
  const source: CheckedSource = {
    id: page.id,
    title: page.title,
    text: prepared.text,
    moment: null,
    evidence: (quote) => pageEvidence(page, quote),
    rule: () => 'page-vs-canon',
    // Two canon pages that disagree are an error. A draft may simply not be settled yet.
    severity: (_other, confidence) => (page.status === 'canon' && confidence === 'high' ? 'error' : 'warning'),
  };
  return compareWithLore(
    world,
    source,
    prepared.blocks,
    {
      system: PAGE_COMPARE_SYSTEM,
      intro: 'Check this wiki page against these other pages.',
      block: (body) => pageBlock(page.title, page.status, body),
    },
    claims,
    backend,
    stats,
    signal,
  );
}

function checkLoreAnswer(
  world: World,
  source: CheckedSource,
  item: LoreContradiction,
  batch: LoreBlock[],
  stats: RunStats,
): FindingDraft | null {
  if (item.confidence === 'low' || SAYS_NO_CONFLICT.test(item.explanation)) {
    stats.discardedWeak += 1;
    return null;
  }

  // Lore that was never sent, or no longer counts as fact, cannot be contradicted.
  const named = world.pageByName.get(titleKey(item.pageTitle));
  if (named && !statesFacts(named)) {
    stats.discardedStatus += 1;
    return null;
  }

  if (quoteProblem(item.sceneQuote, source.text)) {
    noteDiscard(stats, `Not in ${source.title}: "${item.sceneQuote}"`);
    return null;
  }

  // The model gets the title wrong more often than the words, so the words decide.
  const holder =
    batch.find((block) => block.page.id === named?.id && !quoteProblem(item.loreQuote, block.text)) ??
    batch.find((block) => !quoteProblem(item.loreQuote, block.text));
  if (!holder) {
    noteDiscard(stats, `Not in ${item.pageTitle || 'the wiki'}: "${item.loreQuote}"`);
    return null;
  }

  if (sameWords(item.sceneQuote, item.loreQuote)) {
    stats.discardedWeak += 1;
    return null;
  }
  const { moment } = source;
  if (isKnownChange(world, holder.page, { quote: item.sceneQuote, moment }, { quote: item.loreQuote, moment })) {
    stats.discardedChanges += 1;
    return null;
  }

  const page = holder.page;
  const rule = source.rule(page);
  return {
    source: 'ai',
    rule,
    severity: source.severity(page, item.confidence),
    title: t('{source} contradicts {page}', { source: source.title, page: page.title }),
    detail: item.explanation.trim(),
    evidence: [
      source.evidence(originalWords(item.sceneQuote, source.text)),
      pageEvidence(page, originalWords(item.loreQuote, holder.text)),
    ],
    fingerprint: `ai:${rule}:${source.id}:${page.id}:${contentHash(sentenceHolding(item.sceneQuote, source.text))}:${contentHash(sentenceHolding(item.loreQuote, holder.text))}`,
  };
}

// ---------------------------------------------------------------------------
// Between scenes
// ---------------------------------------------------------------------------

interface SceneClaim extends Claim {
  node: WorldNode;
}

interface Group {
  subject: string;
  page: WorldPage | null;
  items: SceneClaim[];
}

/** Claims grouped by what they are about, kept only if two scenes have something to say. */
export function groupBySubject(world: World, claims: SceneClaim[]): Group[] {
  const groups = new Map<string, Group>();
  for (const claim of claims) {
    const page = subjectPage(world, claim.subject);
    // An idea or a retconned page is still a subject, but it is not a known fact.
    const key = page ? `page:${page.id}` : `name:${titleKey(claim.subject)}`;
    if (!key || key === 'name:') continue;
    const group = groups.get(key) ?? { subject: page?.title ?? claim.subject, page: page ?? null, items: [] };
    group.items.push(claim);
    groups.set(key, group);
  }
  const order = (claim: SceneClaim) => world.orderOf.get(claim.node.id) ?? 0;
  return [...groups.values()]
    .filter((group) => new Set(group.items.map((item) => item.node.id)).size > 1)
    .map((group) => ({ ...group, items: [...group.items].sort((a, b) => order(a) - order(b)) }));
}

/** The claims of every subject that at least one of these scenes says something about. */
export function claimsTouching(world: World, claims: SceneClaim[], sceneIds: Set<string>): SceneClaim[] {
  return groupBySubject(world, claims)
    .filter((group) => group.items.some((item) => sceneIds.has(item.node.id)))
    .flatMap((group) => group.items);
}

interface BetweenContradiction {
  a: number;
  b: number;
  explanation: string;
  confidence: Confidence;
}

function parseBetweenAnswer(value: unknown): BetweenContradiction[] {
  const list = Array.isArray(value) ? value : (value as { contradictions?: unknown } | null)?.contradictions;
  if (!Array.isArray(list)) throw new Error('Expected an object with a "contradictions" list.');
  return list.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    return { a: Number(entry.a), b: Number(entry.b), explanation: String(entry.explanation ?? ''), confidence: asConfidence(entry.confidence) };
  });
}

function changesNote(world: World, page: WorldPage | null, cloud: boolean): string {
  if (page && !usablePage(page, cloud)) return '';
  const lines: string[] = [];
  for (const field of page?.infobox?.fields ?? []) {
    if (!field.changes?.length) continue;
    const steps = field.changes.map((change) => {
      const node = change.nodeId ? world.nodeById.get(change.nodeId) : undefined;
      const scene = node && usableScene(world, node, cloud) ? node.title : '';
      return `${change.value.trim() || 'nothing'}${change.date ? ` from ${change.date}` : ''}${scene ? ` from the scene "${scene}"` : ''}`;
    });
    lines.push(`${field.label} is known to change: first ${field.value.trim() || 'nothing'}, then ${steps.join(', then ')}.`);
  }
  return lines.join(' ');
}

/** A bound on how many statements go in one request, however large the model's context. */
const MAX_STATEMENTS = 120;

/**
 * Compares scenes with each other. The model answers with statement numbers, so it cannot
 * misquote, and the quotes are still checked against the scenes as they are now.
 */
export async function compareBetweenScenes(
  world: World,
  claims: SceneClaim[],
  backend: AiBackend,
  stats: RunStats,
  signal?: AbortSignal,
  onStep?: (done: number, total: number) => void,
): Promise<FindingDraft[]> {
  const groups = groupBySubject(world, claims);
  if (groups.length === 0) return [];

  // Fill requests group by group, so each stays small enough to be read well.
  const room = Math.max(1000, Math.floor(backend.contextTokens / 2));
  const requests: Group[][] = [];
  let current: Group[] = [];
  let used = 0;
  let statements = 0;
  for (const group of groups) {
    const tokens = group.items.reduce((sum, item) => sum + estimateTokens(item.quote) + estimateTokens(item.claim) + 12, 20);
    if (current.length > 0 && (used + tokens > room || statements + group.items.length > MAX_STATEMENTS)) {
      requests.push(current);
      current = [];
      used = 0;
      statements = 0;
    }
    current.push(group);
    used += tokens;
    statements += group.items.length;
  }
  if (current.length > 0) requests.push(current);

  const findings: FindingDraft[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < requests.length; index += 1) {
    onStep?.(index, requests.length);
    const numbered: { item: SceneClaim; group: Group }[] = [];
    const sections = requests[index].map((group) => {
      const lines = group.items.map((item) => {
        numbered.push({ item, group });
        const date = sceneDate(world, item.node);
        return `[${numbered.length}] Scene "${sceneTitle(item.node)}"${date ? `, story date ${date}` : ''}: "${item.quote}"`;
      });
      const note = changesNote(world, group.page, backend.cloud);
      return sceneBlock({ about: group.subject }, `${note ? `${note}\n` : ''}${lines.join('\n')}`);
    });
    const prompt = `Find statements that contradict each other.\n\n${sections.join('\n\n')}`;
    const answer = await backend.json({ task: 'consistency', system: BETWEEN_SYSTEM, prompt, schema: BETWEEN_SCHEMA, signal }, parseBetweenAnswer);

    for (const pair of answer) {
      stats.proposed += 1;
      const left = numbered[pair.a - 1];
      const right = numbered[pair.b - 1];
      if (!left || !right || left.item.node.id === right.item.node.id) {
        // Numbers that are not in the list, or a scene against itself, cite nothing checkable.
        noteDiscard(stats, `Statements ${pair.a} and ${pair.b} are not two scenes from the list.`);
        continue;
      }
      if (pair.confidence === 'low' || SAYS_NO_CONFLICT.test(pair.explanation)) {
        stats.discardedWeak += 1;
        continue;
      }
      const leftText = pmToPlainText(left.item.node.content);
      const rightText = pmToPlainText(right.item.node.content);
      if (quoteProblem(left.item.quote, leftText) || quoteProblem(right.item.quote, rightText)) {
        noteDiscard(stats, `A cached statement is no longer in its scene: "${left.item.quote}"`);
        continue;
      }
      if (sameWords(left.item.quote, right.item.quote)) {
        stats.discardedWeak += 1;
        continue;
      }
      const page = left.group.page ?? right.group.page;
      if (page && isKnownChange(world, page, { quote: left.item.quote, moment: momentOf(world, left.item.node) }, { quote: right.item.quote, moment: momentOf(world, right.item.node) })) {
        stats.discardedChanges += 1;
        continue;
      }
      const [first, second] = [left, right].sort((x, y) => (x.item.node.id < y.item.node.id ? -1 : 1));
      const fingerprint = `ai:scene-vs-scene:${first.item.node.id}:${second.item.node.id}:${contentHash(sentenceHolding(first.item.quote, pmToPlainText(first.item.node.content)))}:${contentHash(sentenceHolding(second.item.quote, pmToPlainText(second.item.node.content)))}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      stats.kept += 1;
      findings.push({
        source: 'ai',
        rule: 'scene-vs-scene',
        severity: pair.confidence === 'high' ? 'error' : 'warning',
        title: t('{first} and {second} disagree about {subject}', { first: sceneTitle(left.item.node), second: sceneTitle(right.item.node), subject: left.group.subject }),
        detail: pair.explanation.trim(),
        evidence: [sceneEvidence(left.item.node, left.item.quote), sceneEvidence(right.item.node, right.item.quote)],
        fingerprint,
      });
    }
  }
  return findings;
}

/** What says whether a between-scenes check would read anything new. */
export function betweenPrint(world: World, claims: SceneClaim[]): string {
  const groups = groupBySubject(world, claims);
  return contentHash(
    groups.map((group) => `${group.subject}\n${changesNote(world, group.page, false)}\n${group.items.map((item) => `${item.node.id}:${sceneDate(world, item.node)}:${item.quote}`).join('\n')}`).join('\n\n'),
    BETWEEN_SYSTEM,
  );
}

export type { SceneClaim };
