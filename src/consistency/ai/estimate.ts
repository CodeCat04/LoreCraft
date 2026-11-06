/** How much a run will send, so a cloud profile can show a cost before anything is spent. */

import { estimateTokens } from '../../ai/context';
import { pmToPlainText } from '../../editor/convert';
import type { AiProfile } from '../../lib/settings';
import type { World, WorldNode, WorldPage } from '../rules/world';
import { pagesForPage, pagesForScene, renderPage } from './lore';
import { COMPARE_SYSTEM, EXTRACT_SYSTEM } from './prompts';

export interface RunEstimate {
  inputTokens: number;
  outputTokens: number;
  /** In US dollars, or null if the profile has no rates. */
  costUsd: number | null;
}

/** Claims are a fraction of the text they come from. */
const CLAIMS_SHARE = 0.3;

export function estimateRunTokens(world: World, scenes: WorldNode[], cloud: boolean, pages: WorldPage[] = []): { inputTokens: number; outputTokens: number } {
  const system = estimateTokens(EXTRACT_SYSTEM) + estimateTokens(COMPARE_SYSTEM);
  let input = 0;
  let output = 0;
  let allClaims = 0;
  for (const node of scenes) {
    const text = estimateTokens(pmToPlainText(node.content));
    if (text === 0) continue;
    const lore = pagesForScene(world, node, [], cloud).reduce((sum, page) => sum + estimateTokens(renderPage(world, page, null)), 0);
    // Read once for claims, once with the lore.
    input += system + text * 2 + lore + text * CLAIMS_SHARE;
    output += text * CLAIMS_SHARE + 300;
    allClaims += text * CLAIMS_SHARE;
  }
  for (const page of pages) {
    const text = estimateTokens(renderPage(world, page, null, cloud));
    const lore = pagesForPage(world, page, [], cloud).reduce((sum, other) => sum + estimateTokens(renderPage(world, other, null, cloud)), 0);
    input += system + text * 2 + lore + text * CLAIMS_SHARE;
    output += text * CLAIMS_SHARE + 300;
  }
  if (scenes.length > 1) {
    input += allClaims + estimateTokens(COMPARE_SYSTEM);
    output += 300;
  }
  return { inputTokens: Math.ceil(input), outputTokens: Math.ceil(output) };
}

/** Roughly everything a run sends, for `confirmRun` in the AI module to estimate from. */
export function textToSend(world: World, scenes: WorldNode[], cloud: boolean, pages: WorldPage[] = []): string {
  const parts: string[] = [];
  for (const node of scenes) {
    const text = pmToPlainText(node.content);
    if (!text.trim()) continue;
    // Read once for claims, and once more with its lore.
    parts.push(EXTRACT_SYSTEM, text, COMPARE_SYSTEM, text);
    for (const page of pagesForScene(world, node, [], cloud)) parts.push(renderPage(world, page, null, cloud));
  }
  for (const page of pages) {
    const text = renderPage(world, page, null, cloud);
    parts.push(EXTRACT_SYSTEM, text, COMPARE_SYSTEM, text);
    for (const other of pagesForPage(world, page, [], cloud)) parts.push(renderPage(world, other, null, cloud));
  }
  return parts.join('\n');
}

export function estimateRunCost(tokens: { inputTokens: number; outputTokens: number }, profile: AiProfile): RunEstimate {
  const input = profile.inputCostPerMTok;
  const output = profile.outputCostPerMTok;
  const costUsd =
    input === undefined && output === undefined
      ? null
      : (tokens.inputTokens * (input ?? 0) + tokens.outputTokens * (output ?? 0)) / 1_000_000;
  return { ...tokens, costUsd };
}
