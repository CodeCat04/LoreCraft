/** Search by meaning, on the native side. See `src-tauri/src/embeddings/`. */

import { rpc } from '../lib/rpc';

export type MeaningState =
  | 'off'
  | 'notSetUp'
  | 'downloading'
  | 'noProject'
  | 'indexing'
  | 'paused'
  | 'ready'
  | 'failed';

export interface MeaningStatus {
  state: MeaningState;
  /** While turned off: passages still kept in the project file. */
  leftoverPassages: number;
  source: string;
  model: string;
  /** Text goes off this computer to make the index. */
  isCloud: boolean;
  /** Passages indexed so far, and how many there are in all. */
  done: number;
  total: number;
  /** Local-only documents left out, because the provider is a cloud one. */
  skippedLocalOnly: number;
  downloaded: number;
  downloadTotal: number;
  builtinPresent: boolean;
  /** Why it failed, or what is missing. */
  message: string | null;
}

export interface MeaningHit {
  kind: 'page' | 'node';
  id: string;
  title: string;
  bookId: string | null;
  snippet: string;
  score: number;
  matchedBy?: ('keyword' | 'meaning')[];
}

export interface MeaningQuery {
  q: string;
  limit?: number;
  kinds?: ('page' | 'node')[];
  perDoc?: number;
  excludeLocalOnly?: boolean;
}

export const meaningApi = {
  status: () => rpc<MeaningStatus>('embeddings.status'),
  step: () => rpc<MeaningStatus>('embeddings.step'),
  cancel: () => rpc<MeaningStatus>('embeddings.cancel'),
  resume: () => rpc<MeaningStatus>('embeddings.resume'),
  clear: () => rpc<MeaningStatus>('embeddings.clear'),
  /** Runs until the model has arrived. Only after the writer has agreed to it. */
  download: () => rpc<MeaningStatus>('embeddings.download'),
  cancelDownload: () => rpc<MeaningStatus>('embeddings.cancelDownload'),
  removeModel: () => rpc<MeaningStatus>('embeddings.removeModel'),
  test: (profileId: string, model: string) => rpc<{ dimensions: number }>('embeddings.test', { profileId, model }),
  search: (query: MeaningQuery) => rpc<MeaningHit[]>('embeddings.search', query),
  /** Keyword and meaning results merged. With no index, this is the keyword results. */
  hybrid: (query: MeaningQuery) => rpc<{ results: MeaningHit[]; problem: string | null }>('embeddings.hybrid', query),
};
