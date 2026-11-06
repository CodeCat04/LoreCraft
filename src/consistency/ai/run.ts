/**
 * A whole AI check: claims, then lore, then between scenes. The run is saved after every scene,
 * so stopping or a crash loses nothing: the next run picks up from there, and the claims cache
 * means nothing already read is read again.
 */

import { AiError } from '../../ai/client';
import { pmToPlainText } from '../../editor/convert';
import { t } from '../../lib/i18n';
import { everythingOnPage, renderPage, usablePage, usableScene } from './lore';
import { quoteProblem } from '../quotes';
import type { World, WorldNode, WorldPage } from '../rules/world';
import { sceneTitle, statesFacts } from '../rules/world';
import type { Finding } from '../types';
import { claimsFor, claimsHash, type CachedSource, type Claim } from './claims';
import {
  betweenPrint,
  claimsTouching,
  compareBetweenScenes,
  comparePageToLore,
  compareSceneToLore,
  prepareComparison,
  preparePageComparison,
  type SceneClaim,
} from './compare';
import { emptyStats, type AiBackend, type RunProgress, type RunRecord, type RunScopeKind } from './types';

export const RUN_META_KEY = 'consistency.aiRun';
export const BETWEEN_META_KEY = 'consistency.betweenChecked';

/** The scenes in a chapter or part, in reading order. */
export function scenesWithin(world: World, targetId: string): WorldNode[] {
  const inside = (node: WorldNode): boolean => {
    let at: WorldNode | undefined = node;
    for (let depth = 0; at && depth < 8; depth += 1) {
      if (at.id === targetId) return true;
      at = at.parentId ? world.nodeById.get(at.parentId) : undefined;
    }
    return false;
  };
  return world.scenes.filter(inside);
}

export function scenesInScope(world: World, kind: RunScopeKind, targetId: string): WorldNode[] {
  if (kind === 'scene') return world.scenes.filter((node) => node.id === targetId);
  if (kind === 'chapter') return scenesWithin(world, targetId);
  if (kind === 'page') return [];
  return world.scenes.filter((node) => node.bookId === targetId);
}

export function newRun(kind: RunScopeKind, targetId: string, label: string, scenes: WorldNode[], pages: WorldPage[] = []): RunRecord {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    targetId,
    label,
    sceneIds: scenes.map((node) => node.id),
    pageIds: pages.map((page) => page.id),
    done: [],
    betweenDone: false,
    state: 'running',
    stats: emptyStats(),
    startedAt: new Date().toISOString(),
  };
}

/** Errors that end the run, since the next scene would get the same answer. */
function endsRun(e: unknown): boolean {
  if (!(e instanceof AiError)) return true;
  return !['BAD_JSON', 'EMPTY', 'REFUSAL', 'MAX_TOKENS', 'CONTEXT_TOO_LONG'].includes(e.code);
}

function isStop(e: unknown): boolean {
  return e instanceof AiError && (e.code === 'CANCELLED' || e.code === 'DECLINED');
}

export interface RunOptions {
  world: World;
  backend: AiBackend;
  record: RunRecord;
  signal?: AbortSignal;
  onProgress?: (progress: RunProgress) => void;
  /** Remembers what the last between-scenes check read. */
  betweenChecked?: { get: () => Promise<string | null>; set: (print: string) => Promise<unknown> };
}

/** Runs or resumes a check. Resolves with the record however it ended. */
export async function runAiCheck(options: RunOptions): Promise<RunRecord> {
  const { world, backend, record, signal, onProgress, betweenChecked } = options;
  const { stats } = record;
  record.state = 'running';
  delete record.error;
  delete record.finishedAt;

  const scenes = record.sceneIds
    .map((id) => world.nodeById.get(id))
    .filter((node): node is WorldNode => !!node && node.kind === 'scene');
  const pages = (record.pageIds ?? [])
    .map((id) => world.pageById.get(id))
    .filter((page): page is WorldPage => !!page);
  // The last step compares scenes with each other, which a check of one page does not do.
  const betweenStep = scenes.length > 0 ? 1 : 0;
  const total = scenes.length + pages.length + betweenStep;
  const left: WorldNode[] = [];
  for (const node of scenes) {
    if (record.done.includes(node.id)) continue;
    if (usableScene(world, node, backend.cloud)) {
      left.push(node);
    } else {
      stats.skippedLocalOnly += 1;
      record.done.push(node.id);
    }
  }

  const report = (step: string, thinking = true) =>
    onProgress?.({ done: Math.min(record.done.length, scenes.length + pages.length) + (record.betweenDone && betweenStep ? 1 : 0), total, step, thinking });

  const finish = async (state: RunRecord['state'], error?: string) => {
    record.state = state;
    if (error) record.error = error;
    if (state === 'finished') record.finishedAt = new Date().toISOString();
    await backend.saveRun(record);
    return record;
  };

  /** One scene: its claims, then the lore. Failing on one does not stop the others. */
  const checkScene = async (node: WorldNode) => {
    if (signal?.aborted) return;
    const title = sceneTitle(node);
    const text = pmToPlainText(node.content);
    if (!text.trim()) {
      record.done.push(node.id);
      return;
    }
    try {
      report(t('Reading {title}', { title }));
      const { claims, cached, hash } = await claimsFor({ kind: 'node', id: node.id, title, text }, backend, stats, signal);
      const prepared = prepareComparison(world, node, claims, backend.cloud);
      if (cached?.checkedAgainst === prepared.lorePrint) {
        stats.comparisonsSkipped += 1;
      } else {
        report(t('Comparing {title} with the wiki', { title }));
        const findings = await compareSceneToLore(world, node, claims, prepared, backend, stats, signal);
        await backend.upsert(findings, { source: 'ai', rules: ['contradicts-lore', 'contradicts-draft'], sourceIds: [node.id] });
        const updated: CachedSource = { claims, checkedAgainst: prepared.lorePrint };
        await backend.putClaims('node', node.id, hash, updated);
      }
      record.done.push(node.id);
      await backend.saveRun(record);
      report(t('Finished {title}', { title }), false);
    } catch (e) {
      if (isStop(e) || endsRun(e)) throw e;
      stats.failedSources.push(title);
      record.done.push(node.id);
      await backend.saveRun(record);
    }
  };

  /** One wiki page against the canon pages it mentions. */
  const checkPage = async (page: WorldPage) => {
    if (signal?.aborted || record.done.includes(page.id)) return;
    if (!usablePage(page, backend.cloud)) {
      stats.skippedLocalOnly += 1;
      record.done.push(page.id);
      return;
    }
    const text = renderPage(world, page, null, backend.cloud);
    try {
      report(t('Reading {title}', { title: page.title }));
      const { claims, cached, hash } = await claimsFor({ kind: 'page', id: page.id, title: page.title, text, status: page.status }, backend, stats, signal);
      const prepared = preparePageComparison(world, page, claims, backend.cloud);
      if (cached?.checkedAgainst === prepared.lorePrint) {
        stats.comparisonsSkipped += 1;
      } else {
        report(t('Comparing {title} with canon pages', { title: page.title }));
        const findings = await comparePageToLore(world, page, claims, prepared, backend, stats, signal);
        await backend.upsert(findings, { source: 'ai', rules: ['page-vs-canon'], sourceIds: [page.id] });
        await backend.putClaims('page', page.id, hash, { claims, checkedAgainst: prepared.lorePrint });
      }
      record.done.push(page.id);
      await backend.saveRun(record);
    } catch (e) {
      if (isStop(e) || endsRun(e)) throw e;
      stats.failedSources.push(page.title);
      record.done.push(page.id);
      await backend.saveRun(record);
    }
  };

  await backend.saveRun(record);
  try {
    for (const page of pages) await checkPage(page);
    if (signal?.aborted) return await finish('cancelled');
    const workers = Array.from({ length: Math.max(1, backend.concurrency) }, async () => {
      for (;;) {
        const node = left.shift();
        if (!node || signal?.aborted) return;
        await checkScene(node);
      }
    });
    await Promise.all(workers);
    if (signal?.aborted) return await finish('cancelled');

    // ---- Between scenes -------------------------------------------------------------
    if (!record.betweenDone && scenes.length > 0) {
      report(t('Comparing scenes with each other'));
      const ids = new Set(record.sceneIds);
      const all: SceneClaim[] = [];
      // Other scenes count if their claims are current, without reading them to get any.
      for (const node of world.scenes) {
        if (!usableScene(world, node, backend.cloud)) continue;
        const text = pmToPlainText(node.content);
        const stored = text.trim() ? await backend.getClaims('node', node.id) : null;
        if (!stored?.claims || stored.contentHash !== claimsHash(text)) continue;
        for (const claim of stored.claims.claims as Claim[]) all.push({ ...claim, node });
      }
      // A subject is only worth asking about if a scene in this run says something about it.
      const relevant = claimsTouching(world, all, ids);
      const print = betweenPrint(world, relevant);
      const unchanged = (await betweenChecked?.get()) === print;
      if (!unchanged) {
        const findings = await compareBetweenScenes(world, relevant, backend, stats, signal, (done, count) => {
          if (count > 1) report(t('Comparing scenes with each other, part {part} of {count}', { part: done + 1, count }));
        });
        await backend.upsert(findings, { source: 'ai', rules: ['scene-vs-scene'], sourceIds: record.sceneIds });
        await betweenChecked?.set(print);
      }
      record.betweenDone = true;
    }
    report(t('Finished'), false);
    return await finish('finished');
  } catch (e) {
    if (isStop(e)) return await finish('cancelled');
    return await finish('failed', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Closes AI findings that have gone away by themselves: the quoted words have been edited out,
 * the scene or page is gone, or the page is no longer canon or draft. Returns their ids.
 */
export function staleAiFindings(world: World, findings: Finding[]): string[] {
  const stale: string[] = [];
  for (const finding of findings) {
    if (finding.source !== 'ai' || finding.status !== 'open') continue;
    const gone = finding.evidence.some((evidence) => {
      if (evidence.sourceKind === 'node') {
        const node = world.nodeById.get(evidence.sourceId);
        return !node || quoteProblem(evidence.quote, pmToPlainText(node.content)) !== null;
      }
      const page = world.pageById.get(evidence.sourceId);
      return !page || !statesFacts(page) || quoteProblem(evidence.quote, everythingOnPage(world, page)) !== null;
    });
    if (gone) stale.push(finding.id);
  }
  return stale;
}
