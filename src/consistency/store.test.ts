import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: () => new Promise(() => {}), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));

/** The project's meta table. */
const meta = new Map<string, string>();
vi.mock('../lib/api', () => ({
  project: {
    getMeta: async (key: string) => meta.get(key) ?? null,
    setMeta: async (key: string, value: string) => {
      meta.set(key, value);
      return true;
    },
  },
  snapshot: { get: () => Promise.reject(new Error('not in this test')) },
}));
vi.mock('../lib/storyDate', () => ({ getEras: async () => [] }));
const applied: string[] = [];
vi.mock('./ai/wikiUpdates', () => ({
  applyProposal: async (proposal: { id: string }) => void applied.push(proposal.id),
  proposeWikiUpdates: async () => {
    throw new Error('not in this test');
  },
}));

import type { AdditionProposal, ProposalResult } from './ai/wikiUpdates';
import {
  applyApproved,
  closeWikiUpdates,
  loadWikiUpdates,
  parseStoredUpdates,
  resetConsistency,
  useConsistency,
  WIKI_UPDATES_META_KEY,
  type StoredUpdates,
} from './store';

function addition(id: string, text: string): AdditionProposal {
  return { kind: 'addition', id, pageId: 'aria', pageTitle: 'Aria', text, quote: text, sceneId: 's1', sceneTitle: 'Market day' };
}

function result(proposals: AdditionProposal[]): ProposalResult {
  return { proposals, proposed: proposals.length, discarded: 0, dropped: 0, examples: [], skippedLocalOnly: 0 };
}

const stored = (): StoredUpdates[] => parseStoredUpdates(meta.get(WIKI_UPDATES_META_KEY) ?? null);

describe('proposed wiki updates', () => {
  beforeEach(() => {
    meta.clear();
    applied.length = 0;
    resetConsistency();
    const list: StoredUpdates[] = [
      { chapterId: 'c2', chapterTitle: 'Chapter 2', createdAt: '2026-11-05T10:00:00Z', result: result([addition('a', 'She sings.'), addition('b', 'She limps.')]) },
      { chapterId: 'c1', chapterTitle: 'Chapter 1', createdAt: '2026-11-04T10:00:00Z', result: result([addition('c', 'She was born in Tor.')]) },
    ];
    meta.set(WIKI_UPDATES_META_KEY, JSON.stringify(list));
  });

  it('come back from the project after it is opened again', async () => {
    expect(useConsistency.getState().updates).toBeNull();
    await loadWikiUpdates();
    const { updates } = useConsistency.getState();
    expect(updates?.chapterTitle).toBe('Chapter 2');
    expect(updates?.result?.proposals.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('keep what was not applied, in the project too', async () => {
    await loadWikiUpdates();
    const first = useConsistency.getState().updates!.result!.proposals[0];
    await applyApproved([{ proposal: first, how: 'change' }]);
    expect(applied).toEqual(['a']);
    expect(useConsistency.getState().updates?.result?.proposals.map((p) => p.id)).toEqual(['b']);
    expect(stored()[0].result.proposals.map((p) => p.id)).toEqual(['b']);

    // As after a restart: nothing in memory, and the project still has the rest.
    resetConsistency();
    await loadWikiUpdates();
    expect(useConsistency.getState().updates?.result?.proposals.map((p) => p.id)).toEqual(['b']);
  });

  it('go for good when closed, and the next chapter shows', async () => {
    await loadWikiUpdates();
    await closeWikiUpdates();
    expect(stored().map((item) => item.chapterId)).toEqual(['c1']);
    expect(useConsistency.getState().updates?.chapterTitle).toBe('Chapter 1');
    await closeWikiUpdates();
    expect(stored()).toEqual([]);
    expect(useConsistency.getState().updates).toBeNull();
  });

  it('ignore stored values that cannot be read', () => {
    expect(parseStoredUpdates('not json')).toEqual([]);
    expect(parseStoredUpdates('{"chapterId":"c1"}')).toEqual([]);
    expect(parseStoredUpdates('[{"chapterId":"c1"},null]')).toEqual([]);
  });
});
