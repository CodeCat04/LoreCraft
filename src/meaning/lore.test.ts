import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type AiProfile, type Settings } from '../lib/settings';
import { useSettings } from '../state/settings';
import { meaningApi, type MeaningStatus } from './api';
import { searchForAi } from './lore';

const keyword = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({ search: { query: keyword } }));

const local: AiProfile = { id: 'local', name: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', model: '', isCloud: false };
const cloud: AiProfile = { id: 'cloud', name: 'Cloud', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', isCloud: true };
const keywordHit = { kind: 'page', id: 'k', title: 'By keyword', snippet: 'word', bookId: null };

function configure(enabled: boolean, routed: { chat: AiProfile; rewrite: AiProfile }) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ai: {
      ...DEFAULT_SETTINGS.ai,
      profiles: [local, cloud],
      routing: { chat: routed.chat.id, rewrite: routed.rewrite.id, extract: routed.chat.id, consistency: routed.chat.id },
      embeddings: { enabled, source: 'builtin', profileId: '', model: '' },
    },
  };
  useSettings.setState({ settings });
}

function provider(isCloud: boolean) {
  vi.spyOn(meaningApi, 'status').mockResolvedValue({ isCloud } as MeaningStatus);
}

describe('searchForAi', () => {
  const hybrid = vi.spyOn(meaningApi, 'hybrid');

  beforeEach(() => {
    vi.clearAllMocks();
    keyword.mockResolvedValue([keywordHit]);
    hybrid.mockResolvedValue({
      results: [{ kind: 'node', id: 'm', title: 'By meaning', bookId: 'b', snippet: 'passage', score: 0.5, matchedBy: ['meaning'] }],
      problem: null,
    });
  });

  it('is the keyword search while search by meaning is off', async () => {
    configure(false, { chat: local, rewrite: local });
    expect(await searchForAi('q', 5)).toEqual([keywordHit]);
    expect(hybrid).not.toHaveBeenCalled();
  });

  it('uses the merged results when the index is on', async () => {
    configure(true, { chat: local, rewrite: local });
    provider(false);
    expect(await searchForAi('q', 5, 'node')).toEqual([{ kind: 'node', id: 'm', title: 'By meaning', snippet: 'passage', bookId: 'b' }]);
    expect(hybrid).toHaveBeenCalledWith({ q: 'q', limit: 5, kinds: ['node'], perDoc: 1, excludeLocalOnly: false });
    expect(keyword).not.toHaveBeenCalled();
  });

  it('leaves out local-only results if any task can reach a cloud model', async () => {
    configure(true, { chat: local, rewrite: cloud });
    provider(false);
    await searchForAi('q', 5);
    expect(hybrid.mock.calls[0][0].excludeLocalOnly).toBe(true);
  });

  it('never asks a cloud embeddings provider unless every task is cloud already', async () => {
    configure(true, { chat: local, rewrite: cloud });
    provider(true);
    expect(await searchForAi('text from a local-only page', 5)).toEqual([keywordHit]);
    expect(hybrid).not.toHaveBeenCalled();

    configure(true, { chat: cloud, rewrite: cloud });
    await searchForAi('q', 5);
    expect(hybrid).toHaveBeenCalledTimes(1);
  });

  it('falls back to keywords if anything goes wrong', async () => {
    configure(true, { chat: local, rewrite: local });
    provider(false);
    hybrid.mockRejectedValue(new Error('no'));
    expect(await searchForAi('q', 5)).toEqual([keywordHit]);
  });
});
