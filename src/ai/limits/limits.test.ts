import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shell/toasts', () => ({ toast: vi.fn() }));
vi.mock('../../shell/dialogs', () => ({ choose: vi.fn() }));
vi.mock('../../lib/api', () => ({ settings: { update: vi.fn(async () => ({})) }, app: {} }));

import { toast } from '../../shell/toasts';
import { DEFAULT_SETTINGS, type AiProfile } from '../../lib/settings';
import { useSettings } from '../../state/settings';
import { estimateRunCost } from './estimate';
import { canSendTo, historyForProfile } from './localOnly';
import { currentMonth, limitReached, recordSpend, spendingState } from './spending';

const cloud = { id: 'c', name: 'C', kind: 'anthropic', baseUrl: '', model: 'm', isCloud: true, inputCostPerMTok: 4, outputCostPerMTok: 20 } as AiProfile;
const local = { id: 'l', name: 'L', kind: 'openai-compatible', baseUrl: '', model: '', isCloud: false } as AiProfile;

function spending(patch: Partial<typeof DEFAULT_SETTINGS.ai.spending>) {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, spending: { ...DEFAULT_SETTINGS.ai.spending, ...patch } } },
  });
}

describe('the spending limit', () => {
  beforeEach(() => {
    vi.mocked(toast).mockClear();
    spending({});
  });

  it('does nothing without a limit, and never stops a local profile', () => {
    spending({ limitUsd: 0, month: currentMonth(), spentUsd: 1000 });
    expect(limitReached(cloud)).toBeNull();
    spending({ limitUsd: 5, month: currentMonth(), spentUsd: 1000 });
    expect(limitReached(local)).toBeNull();
    expect(limitReached(cloud)).not.toBeNull();
  });

  it('warns once at 80 percent, and adds up only what went to the cloud', () => {
    spending({ limitUsd: 10, month: currentMonth(), spentUsd: 7 });
    recordSpend(local, 5);
    expect(spendingState().spentUsd).toBe(7);
    recordSpend(cloud, 0.5);
    expect(toast).not.toHaveBeenCalled();
    recordSpend(cloud, 0.5);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0][0]).toMatch(/80%/);
    recordSpend(cloud, 0.5);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(spendingState().spentUsd).toBeCloseTo(8.5);
  });

  it('stops at the limit, until overridden for this month only', () => {
    spending({ limitUsd: 10, month: currentMonth(), spentUsd: 10 });
    expect(limitReached(cloud)).not.toBeNull();
    spending({ limitUsd: 10, month: currentMonth(), spentUsd: 10, overrideMonth: currentMonth() });
    expect(limitReached(cloud)).toBeNull();
    spending({ limitUsd: 10, month: currentMonth(), spentUsd: 10, overrideMonth: '2001-01' });
    expect(limitReached(cloud)).not.toBeNull();
  });

  it('starts again at nothing in a new month', () => {
    spending({ limitUsd: 10, month: '2001-01', spentUsd: 500 });
    expect(spendingState().spentUsd).toBe(0);
    expect(limitReached(cloud)).toBeNull();
    recordSpend(cloud, 1);
    expect(useSettings.getState().settings.ai.spending.month).toBe(currentMonth());
    expect(spendingState().spentUsd).toBe(1);
  });
});

describe('estimateRunCost', () => {
  it('prices the text and an expected reply', () => {
    const estimate = estimateRunCost('a'.repeat(4_000_000), cloud);
    expect(estimate.inputTokens).toBe(1_000_000);
    expect(estimate.outputTokens).toBe(250_000);
    expect(estimate.usd).toBeCloseTo(4 + 5);
    expect(estimateRunCost('a'.repeat(4_000_000), cloud, { outputShare: 0 }).usd).toBeCloseTo(4);
  });

  it('says it does not know when a profile has no prices', () => {
    expect(estimateRunCost('abcd', local).usd).toBeNull();
  });
});

describe('local only', () => {
  const text = (value: string, localOnly = false) => ({ type: 'text' as const, text: value, ...(localOnly ? { localOnly } : {}) });
  const message = (role: 'user' | 'assistant', profileId: string | null, ...content: never[]) => ({ role, profileId, content });
  const profiles = [cloud, local];

  it('blocks only local-only material going to a cloud profile', () => {
    expect(canSendTo(cloud, { localOnly: true })).toBe(false);
    expect(canSendTo(cloud, { localOnly: false })).toBe(true);
    expect(canSendTo(local, { localOnly: true })).toBe(true);
  });

  it('sends a local profile everything', () => {
    const stored = [message('user', null, text('secret', true) as never)];
    expect(historyForProfile(stored, local, profiles)).toEqual({ messages: stored, withheld: 0 });
  });

  it('keeps back what held it, and what a local model wrote after reading it', () => {
    const stored = [
      message('user', null, text('before') as never),
      message('assistant', 'l', text('fine') as never),
      message('user', null, text('secret', true) as never),
      message('assistant', 'l', text('it repeats the secret') as never),
      message('user', null, text('and more?') as never),
      message('assistant', 'l', text('it can still repeat it') as never),
      message('user', null, text('now for the cloud') as never),
      message('assistant', 'c', text('never saw it') as never),
    ];
    const { messages, withheld } = historyForProfile(stored, cloud, profiles);
    expect(withheld).toBe(6);
    expect(messages).toEqual(stored.slice(6));
  });

  it('sends everything if none of it held anything local only', () => {
    const stored = [message('user', null, text('a') as never), message('assistant', 'l', text('b') as never)];
    expect(historyForProfile(stored, cloud, profiles).withheld).toBe(0);
  });

  it('does not start with tool results that have lost their call', () => {
    const stored = [
      message('user', null, text('secret', true) as never),
      message('assistant', 'l', { type: 'toolCall', id: 't', name: 'x', input: {} } as never),
      message('user', null, { type: 'toolResult', toolCallId: 't', content: 'r' } as never),
      message('user', null, text('next') as never),
    ];
    const { messages } = historyForProfile(stored, cloud, profiles);
    expect(messages).toEqual(stored.slice(3));
  });
});
