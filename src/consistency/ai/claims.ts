/**
 * Step one of an AI check: the factual claims a passage makes. They are cached by content
 * hash, so text that has not changed is not read again. A claim whose quote is not really in
 * the text is thrown away here, before anything is built on it.
 */

import { estimateTokens } from '../../ai/context';
import { originalWords, quoteProblem } from '../quotes';
import { contentHash } from './lore';
import { CLAIMS_SCHEMA, EXTRACT_SYSTEM, pageBlock, sceneBlock } from './prompts';
import type { AiBackend, RunStats } from './types';

export interface Claim {
  subject: string;
  claim: string;
  quote: string;
}

/** What is stored for each source in `claims_cache`. */
export interface CachedSource {
  claims: Claim[];
  /** The lore and details a scene was last compared with, so that can be skipped too. */
  checkedAgainst?: string;
}

/** Bump this when the extraction prompt changes enough that old claims are worth redoing. */
const EXTRACTION_VERSION = 'v1';

export function claimsHash(text: string): string {
  return contentHash(text, EXTRACTION_VERSION);
}

function parseClaims(value: unknown): Claim[] {
  const list = Array.isArray(value) ? value : (value as { claims?: unknown } | null)?.claims;
  if (!Array.isArray(list)) throw new Error('Expected an object with a "claims" list.');
  const claims: Claim[] = [];
  for (const item of list) {
    const claim = item as Partial<Claim> | null;
    if (!claim || typeof claim.quote !== 'string' || typeof claim.subject !== 'string') continue;
    claims.push({ subject: claim.subject.trim(), claim: String(claim.claim ?? '').trim(), quote: claim.quote });
  }
  return claims;
}

/** Splits long text at paragraph breaks, so that one reply can cover it all. */
export function chunkText(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    const joined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && estimateTokens(joined) > maxTokens) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = joined;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Room for one passage to be read, whatever the profile's context. Long scenes get split. */
const CHUNK_TOKENS = 6000;

export interface ClaimSource {
  kind: 'node' | 'page';
  id: string;
  title: string;
  text: string;
  /** Page status, for pages. */
  status?: string;
}

/** The claims of one source, from the cache if its text has not changed. */
export async function claimsFor(
  source: ClaimSource,
  backend: AiBackend,
  stats: RunStats,
  signal?: AbortSignal,
): Promise<{ claims: Claim[]; cached: CachedSource | null; hash: string }> {
  const hash = claimsHash(source.text);
  const stored = await backend.getClaims(source.kind, source.id);
  if (stored && stored.contentHash === hash && stored.claims) {
    stats.claimsFromCache += 1;
    return { claims: stored.claims.claims ?? [], cached: stored.claims, hash };
  }

  const claims: Claim[] = [];
  const seen = new Set<string>();
  for (const chunk of chunkText(source.text, CHUNK_TOKENS)) {
    const block =
      source.kind === 'node'
        ? sceneBlock({ title: source.title }, chunk)
        : pageBlock(source.title, source.status ?? 'draft', chunk);
    const prompt = `List the factual claims in this passage.\n\n${block}`;
    const found = await backend.json({ task: 'extract', system: EXTRACT_SYSTEM, prompt, schema: CLAIMS_SCHEMA, signal }, parseClaims);
    for (const claim of found) {
      stats.claimsProposed += 1;
      const problem = quoteProblem(claim.quote, source.text);
      if (problem) {
        stats.claimsDiscarded += 1;
        continue;
      }
      const quote = originalWords(claim.quote, source.text);
      const key = `${claim.subject.toLowerCase()}\u0000${quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({ ...claim, quote });
    }
  }
  stats.claimsRead += 1;
  const fresh: CachedSource = { claims };
  await backend.putClaims(source.kind, source.id, hash, fresh);
  return { claims, cached: fresh, hash };
}
