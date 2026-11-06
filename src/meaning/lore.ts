/**
 * Lets the AI look things up by meaning: what `search_lore` and context assembly call. With
 * no index, or if anything goes wrong, this is the plain keyword search.
 *
 * Two rules about where text goes. Results may carry local-only text, so they leave it out
 * if any task may go to a cloud model. And a query may itself be text from a local-only
 * page, so a cloud embeddings provider is only asked if every task is cloud already.
 */

import * as coreApi from '../lib/api';
import type { SearchHit } from '../lib/types';
import { useSettings } from '../state/settings';
import { meaningApi } from './api';

export async function searchForAi(query: string, limit: number, kind?: 'page' | 'node'): Promise<SearchHit[]> {
  const keywords = () => coreApi.search.query(query, kind, limit);
  const { ai } = useSettings.getState().settings;
  if (!ai.embeddings.enabled) return keywords();
  const routed = Object.values(ai.routing).map((id) => ai.profiles.find((profile) => profile.id === id));
  const anyCloud = routed.some((profile) => profile?.isCloud);
  const allCloud = routed.every((profile) => profile?.isCloud);
  try {
    const status = await meaningApi.status();
    if (status.isCloud && !allCloud) return await keywords();
    const { results } = await meaningApi.hybrid({
      q: query,
      limit,
      kinds: kind ? [kind] : undefined,
      perDoc: 1,
      excludeLocalOnly: anyCloud,
    });
    return results.map((hit) => ({ kind: hit.kind, id: hit.id, title: hit.title, snippet: hit.snippet, bookId: hit.bookId ?? null }));
  } catch {
    return keywords();
  }
}
