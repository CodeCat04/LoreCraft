/** Output limits. Thinking counts against these on every provider, so they run generous. */

import type { AiProfile } from '../lib/settings';

const DEFAULTS: Record<AiProfile['kind'], number> = {
  anthropic: 64_000,
  openai: 32_000,
  'openai-compatible': 16_384,
};

export function defaultMaxTokens(kind: AiProfile['kind']): number {
  return DEFAULTS[kind] ?? 16_384;
}

/** How much room to try next after a response was cut off. */
export function nextMaxTokens(current: number | undefined, profile: AiProfile): number {
  const used = current ?? profile.maxTokens ?? defaultMaxTokens(profile.kind);
  return Math.min(used * 2, 200_000);
}
