import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/rpc', async (original) => ({
  ...(await original<typeof import('../../lib/rpc')>()),
  rpc: rpcMock,
}));
vi.mock('../../shell/toasts', () => ({ toast: toastMock }));
vi.mock('../../editor/saving', () => ({ flushAllEditors: vi.fn(async () => undefined) }));

import { canUndo, sceneUndo, undoBulkChange } from './api';
import { acceptedFromAi } from '../../ai/docActions';

describe('undoing big changes', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    toastMock.mockReset();
  });

  it('only offers an undo when there is something to take back', () => {
    expect(canUndo(undefined)).toBe(false);
    expect(canUndo({ changes: [], created: [], removed: [] })).toBe(false);
    expect(canUndo({ created: [{ kind: 'page', id: 'p' }] })).toBe(true);
  });

  it('sends the plan and names what was left alone because it was edited since', async () => {
    rpcMock.mockResolvedValue({ restored: 1, trashed: 0, kept: [{ kind: 'page', id: 'b', title: 'Gate' }] });
    const plan = { changes: [{ kind: 'page' as const, id: 'a', revisionId: 'r', after: 'h' }] };
    expect(await undoBulkChange(plan)).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith('revisions.undo', plan);
    expect(toastMock.mock.calls[0][0]).toContain('“Gate”');
  });

  it('says so when the undo fails, and reports it', async () => {
    rpcMock.mockRejectedValue(new Error('The disk is full'));
    expect(await undoBulkChange({ created: [{ kind: 'page', id: 'p' }] })).toBe(false);
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('The disk is full'), 'error');
  });

  it('restores a merged scene, and only forces it when asked', async () => {
    rpcMock.mockResolvedValue(true);
    await sceneUndo.restore('s');
    await sceneUndo.restore('s', true);
    expect(rpcMock.mock.calls).toEqual([
      ['nodes.restore', { id: 's', force: false }],
      ['nodes.restore', { id: 's', force: true }],
    ]);
  });

  it('saves what the AI wrote only after putting the old field in the history', async () => {
    rpcMock.mockResolvedValue({});
    await acceptedFromAi.page('p', { summary: 'From the model.' });
    await acceptedFromAi.node('n', { synopsis: 'From the model.' });
    expect(rpcMock.mock.calls).toEqual([
      ['pages.update', { id: 'p', patch: { summary: 'From the model.' }, snapshot: 'ai' }],
      ['nodes.update', { id: 'n', patch: { synopsis: 'From the model.' }, snapshot: 'ai' }],
    ]);
  });
});
