/**
 * Anything that writes over a document must stop when typed text could not be stored first,
 * or it would write over text the writer still has on screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const flush = vi.hoisted(() => ({ ok: true }));
const calls = vi.hoisted(() => ({ rpc: [] as string[] }));

vi.mock('./saving', async (importOriginal) => {
  const real = await importOriginal<typeof import('./saving')>();
  const result = () =>
    flush.ok ? { ok: true, unwritten: [], reason: '' } : { ok: false, unwritten: ['the page “Alice”'], reason: 'disk full' };
  return {
    ...real,
    flushAllEditors: vi.fn(async () => result()),
    flushOrStop: vi.fn(async () => {
      const r = result();
      if (!r.ok) throw new real.UnwrittenError(r);
    }),
  };
});
vi.mock('../shell/toasts', () => ({ toast: vi.fn() }));
vi.mock('../shell/dialogs', () => ({
  confirm: vi.fn(async () => true),
  promptText: vi.fn(async () => null),
  showDialog: vi.fn(async () => ({ keepAlias: true })),
  choose: vi.fn(),
}));
vi.mock('../lib/rpc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/rpc')>();
  return {
    ...real,
    rpc: vi.fn(async (method: string) => {
      calls.rpc.push(method);
      if (method === 'pages.renamePreview') return { newTitle: 'Alicia', documents: [{ kind: 'page', id: 'p2', title: 'B', count: 1 }] };
      if (method === 'pages.rename' && rename.failing) throw new real.RpcError(rename.code, 'no');
      if (method === 'pages.get') return { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old words' }] }] } };
      return { documentsChanged: 1 };
    }),
  };
});
const rename = vi.hoisted(() => ({ failing: false, code: 'IO' }));

import { UnwrittenError, flushOrStop } from './saving';
import { acceptProposal } from '../mcp/actions';
import { renamePage, trashPage } from '../wiki/actions';
import { toast } from '../shell/toasts';

beforeEach(() => {
  flush.ok = true;
  rename.failing = false;
  rename.code = 'IO';
  calls.rpc = [];
});

describe('flushOrStop', () => {
  it('names what could not be stored', async () => {
    flush.ok = false;
    await expect(flushOrStop()).rejects.toBeInstanceOf(UnwrittenError);
    await expect(flushOrStop()).rejects.toThrow(/Alice.*disk full/s);
  });
});

describe('callers stop when typed text is not stored', () => {
  it('an outside tool’s edit is not applied', async () => {
    flush.ok = false;
    const result = await acceptProposal({
      id: 'x',
      kind: 'edit',
      targetKind: 'page',
      targetId: 'p1',
      payload: { quote: 'old', replacement: 'new' },
    } as never);
    expect(result.ok).toBe(false);
    expect(calls.rpc).not.toContain('pages.update');
    expect(calls.rpc).not.toContain('revisions.checkpoint');
  });

  it('a page is not trashed, and the writer is told', async () => {
    flush.ok = false;
    await trashPage('p1', 'Alice');
    expect(calls.rpc).not.toContain('pages.remove');
    expect(vi.mocked(toast).mock.calls.at(-1)?.[1]).toBe('error');
  });

  it('a rename is not written', async () => {
    flush.ok = false;
    expect(await renamePage('p1', 'Alice', 'Alicia')).toBe(false);
    expect(calls.rpc).not.toContain('pages.rename');
  });
});

describe('renamePage', () => {
  it('hands a failed write to the retry with the typed title and the alias answer', async () => {
    rename.failing = true;
    const retry = vi.fn();
    expect(await renamePage('p1', 'Alice', 'Alicia', retry)).toBe(true);
    expect(retry).toHaveBeenCalledWith('Alicia', true);
  });

  it('does not retry a refused title', async () => {
    rename.failing = true;
    rename.code = 'TITLE_EXISTS';
    const retry = vi.fn();
    expect(await renamePage('p1', 'Alice', 'Alicia', retry)).toBe(false);
    expect(retry).not.toHaveBeenCalled();
  });
});
