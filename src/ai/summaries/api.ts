/**
 * Typed wrappers over the `summaries.*` RPC, and `getStorySoFar` for anything that wants the
 * story up to a point: context assembly, the consistency module, and the MCP server, which
 * can call the same RPC natively with the app's window closed.
 */

import { rpc } from '../../lib/rpc';

export type SummaryKind = 'node' | 'book';
export type SummaryLevel = 'scene' | 'chapter' | 'part' | 'book';

export interface StoryParams {
  bookId?: string;
  /** The story up to, and not including, this node. Absent means the whole book. */
  nodeId?: string;
  /** A spoiler limit: nothing past the end of this node is used. */
  asOfNodeId?: string | null;
  /** Off unless asked for, since the reader may be a cloud model. */
  includeLocalOnly?: boolean;
  /** Over this, the oldest entries go first. */
  maxTokens?: number;
}

export interface StoryEntry {
  kind: SummaryKind;
  id: string;
  level: SummaryLevel;
  title: string;
  summary: string;
  /** The text changed since this was written, and it has not been redone yet. */
  stale: boolean;
  edited: boolean;
  localOnly: boolean;
}

export interface StorySoFar {
  /** The entries as one piece of text. */
  text: string;
  /** Something in it is marked local only, or was made from something that is. */
  holdsLocalOnly: boolean;
  entries: StoryEntry[];
  /** Left out because they are marked local only. */
  withheld: { kind: SummaryKind; id: string; title: string }[];
  /** Scenes before this point with no summary yet. */
  missing: number;
  /** Entries dropped to fit `maxTokens`. */
  omitted: number;
}

/** The story so far, as summaries at the highest level that fits the point asked about. */
export function getStorySoFar(params: StoryParams): Promise<StorySoFar> {
  return rpc<StorySoFar>('summaries.storySoFar', params as unknown as Record<string, unknown>);
}

export interface SummaryWork {
  kind: SummaryKind;
  id: string;
  level: SummaryLevel;
  title: string;
  contentHash: string;
  input: string;
  remaining: number;
  total: number;
}

export interface SummaryRow {
  kind: SummaryKind;
  id: string;
  level: SummaryLevel;
  title: string;
  depth: number;
  localOnly: boolean;
  summary: string;
  edited: boolean;
  model: string;
  updatedAt: string;
  /** The scene's text changed since this was written. */
  stale: boolean;
  /** A scene with no text yet, so there is nothing to summarize. */
  empty: boolean;
}

export const summaries = {
  next: (includeLocalOnly: boolean, skip: string[]) => rpc<SummaryWork | null>('summaries.next', { includeLocalOnly, skip }),
  save: (work: SummaryWork, summary: string, model: string) =>
    rpc<boolean>('summaries.save', { kind: work.kind, id: work.id, contentHash: work.contentHash, summary, model }),
  edit: (kind: SummaryKind, id: string, summary: string) => rpc<boolean>('summaries.edit', { kind, id, summary }),
  regenerate: (kind: SummaryKind, id: string) => rpc<boolean>('summaries.regenerate', { kind, id }),
  list: (bookId: string) => rpc<SummaryRow[]>('summaries.list', { bookId }),
};
