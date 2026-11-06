/** Which profile sees a picture. A local-only one never goes to a cloud profile. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shell/toasts', () => ({ toast: vi.fn() }));
vi.mock('../shell/dialogs', () => ({ choose: vi.fn() }));
vi.mock('../lib/api', () => ({ settings: { update: vi.fn(async () => ({})) }, app: {} }));

const reads = new Set<string>();
vi.mock('./api', () => ({
  provider: { imageSupport: vi.fn(async (profileId: string) => ({ supported: reads.has(profileId), source: 'setting' })) },
}));
vi.mock('./assets', () => ({
  readAsset: vi.fn(async () => ({ mime: 'image/png', base64: 'iVBORw0KGgo=', width: 1, height: 1 })),
}));
const complete = vi.fn();
vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>();
  return { ...actual, complete: (...args: unknown[]) => complete(...args) };
});

import { DEFAULT_SETTINGS, type AiProfile } from '../lib/settings';
import { useSettings } from '../state/settings';
import { describeImage } from './vision';

const cloud = { id: 'cloud', name: 'Claude', kind: 'anthropic', baseUrl: '', model: 'm', isCloud: true } as AiProfile;
const local = { id: 'local', name: 'Local', kind: 'openai-compatible', baseUrl: '', model: 'm', isCloud: false } as AiProfile;

function profiles(list: AiProfile[], chat: string) {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, profiles: list, routing: { ...DEFAULT_SETTINGS.ai.routing, chat } } },
  });
}

/** Which profile the request went to. */
const sentTo = () => (complete.mock.calls.at(-1)?.[0] as { profileId: string }).profileId;

describe('describeImage', () => {
  beforeEach(() => {
    reads.clear();
    complete.mockReset();
    complete.mockResolvedValue({ text: ' A red banner. ' });
  });

  it('uses the chat profile when it reads images', async () => {
    profiles([cloud, local], 'cloud');
    reads.add('cloud').add('local');
    expect(await describeImage('a')).toBe('A red banner.');
    expect(sentTo()).toBe('cloud');
  });

  it('sends a local-only picture to a local profile, never the cloud one', async () => {
    profiles([cloud, local], 'cloud');
    reads.add('cloud').add('local');
    await describeImage('a', { localOnly: true });
    expect(sentTo()).toBe('local');
    // Even when the cloud profile is asked for by name.
    await describeImage('a', { localOnly: true, profileId: 'cloud' });
    expect(sentTo()).toBe('local');
  });

  it('refuses a local-only picture when no local profile reads images', async () => {
    profiles([cloud, local], 'cloud');
    reads.add('cloud');
    await expect(describeImage('a', { localOnly: true })).rejects.toMatchObject({ code: 'LOCAL_ONLY' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('says so when nothing can read images', async () => {
    profiles([local], 'local');
    await expect(describeImage('a')).rejects.toMatchObject({ code: 'IMAGES_NOT_SUPPORTED' });
    expect(complete).not.toHaveBeenCalled();
  });
});
