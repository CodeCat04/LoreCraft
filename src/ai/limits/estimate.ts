/** What a run over a lot of text should cost, for showing before it starts. */

import type { AiProfile } from '../../lib/settings';
import { estimateTokens } from '../context';

export interface RunCostEstimate {
  inputTokens: number;
  outputTokens: number;
  /** In US dollars, or null if the profile has no prices set. */
  usd: number | null;
}

export interface EstimateOptions {
  /** Output as a share of input. A quarter by default, which suits summaries and checks. */
  outputShare?: number;
}

/** An estimate for sending this text once. Use `outputShare` if replies run long or short. */
export function estimateRunCost(text: string, profile: AiProfile, options: EstimateOptions = {}): RunCostEstimate {
  const inputTokens = estimateTokens(text);
  const outputTokens = Math.ceil(inputTokens * (options.outputShare ?? 0.25));
  const hasPrices = profile.inputCostPerMTok !== undefined || profile.outputCostPerMTok !== undefined;
  const usd = hasPrices ? (inputTokens * (profile.inputCostPerMTok ?? 0) + outputTokens * (profile.outputCostPerMTok ?? 0)) / 1_000_000 : null;
  return { inputTokens, outputTokens, usd };
}
