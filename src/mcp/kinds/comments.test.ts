/**
 * add_comment and resolve_comment as the app applies and undoes them, against a fake native
 * side that keeps one page and its comments.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

interface FakeComment {
  id: string;
  sourceKind: string;
  sourceId: string;
  body: string;
  author: string;
  quote: string;
  resolved: boolean;
  updatedAt: string;
}

const fake = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  page: null as unknown,
  status: 'auto',
  comments: new Map<string, FakeComment>(),
  clock: 0,
}));

vi.mock('../../editor/saving', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../editor/saving')>()),
  flushOrStop: vi.fn(async () => {}),
  flushAllEditors: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../shell/toasts', () => ({ toast: vi.fn() }));
vi.mock('../../lib/rpc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/rpc')>();
  const stamp = () => `t${(fake.clock += 1)}`;
  const anchored = (c: FakeComment) => ({ ...c, anchored: JSON.stringify(fake.page).includes(`"id":"${c.id}"`) });
  return {
    ...real,
    rpc: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      fake.calls.push({ method, params });
      switch (method) {
        case 'pages.get':
          return { id: 'p1', content: fake.page, deletedAt: null, updatedAt: 'u1' };
        case 'pages.update':
          fake.page = (params.patch as { content: unknown }).content;
          return {};
        case 'comments.add': {
          const id = `c${fake.comments.size + 1}`;
          const c: FakeComment = {
            id,
            sourceKind: params.sourceKind as string,
            sourceId: params.sourceId as string,
            body: params.body as string,
            author: params.author as string,
            quote: params.quote as string,
            resolved: false,
            updatedAt: stamp(),
          };
          fake.comments.set(id, c);
          return anchored(c);
        }
        case 'comments.get': {
          const c = fake.comments.get(params.id as string);
          if (!c) throw new real.RpcError('NOT_FOUND', 'That comment was not found.');
          return anchored(c);
        }
        case 'comments.update': {
          const c = fake.comments.get(params.id as string)!;
          Object.assign(c, params.patch, { updatedAt: stamp() });
          return anchored(c);
        }
        case 'comments.delete':
          fake.comments.delete(params.id as string);
          return true;
        case 'mcp.proposalResolve': {
          const from: Record<string, string> = { applying: 'auto', applied: 'applying', failed: 'applying', undone: 'applied', accepted: 'pending' };
          const ok = from[params.status as string] === fake.status;
          if (ok) fake.status = params.status as string;
          return { changed: ok };
        }
        default:
          return null;
      }
    }),
  };
});

import { applyOne } from '../auto';
import { undoProposal } from '../actions';
import type { AnyProposal } from '../api';
import { useProject } from '../../state/project';

function proposal(kind: string, payload: Record<string, unknown>): AnyProposal<Record<string, unknown>> {
  return {
    id: 'x1',
    client: 'Claude Code',
    kind,
    targetKind: 'page',
    targetId: 'p1',
    title: 'Aria',
    status: 'auto',
    createdAt: '2026-01-01T00:00:00Z',
    payload,
  };
}

const addPayload = { sourceKind: 'page', sourceId: 'p1', quote: 'the gate', body: 'Which gate?', isTodo: false };
const resolves = () => fake.calls.filter((c) => c.method === 'mcp.proposalResolve').map((c) => c.params);
const applied = (p: AnyProposal<Record<string, unknown>>) => {
  const done = resolves().find((r) => r.status === 'applied')!;
  return { ...p, status: 'applied', payload: { ...p.payload, undo: done.undo } };
};

beforeEach(() => {
  fake.calls = [];
  fake.page = doc('She waited at the gate till dusk.');
  fake.status = 'auto';
  fake.comments = new Map();
  fake.clock = 0;
  useProject.setState((s) => ({ status: { ...s.status, open: true } }));
});

describe('add_comment', () => {
  it('adds the comment through the app, marks the quote, and undo takes both away', async () => {
    const p = proposal('addComment', addPayload);
    expect(await applyOne(p)).toBe(true);
    const [comment] = fake.comments.values();
    expect(comment.body).toBe('Which gate?');
    expect(comment.author).toBe('Claude Code');
    expect(JSON.stringify(fake.page)).toContain(`"id":"${comment.id}"`);
    // The text itself is the same; only a mark was added.
    const words = (fake.page as { content: { content: { text: string }[] }[] }).content[0].content.map((n) => n.text).join('');
    expect(words).toBe('She waited at the gate till dusk.');

    expect((await undoProposal(applied(p))).ok).toBe(true);
    expect(fake.comments.size).toBe(0);
    expect(JSON.stringify(fake.page)).not.toContain('"comment"');
    expect(resolves().at(-1)?.status).toBe('undone');
  });

  it('refuses to undo a comment the writer has changed since', async () => {
    const p = proposal('addComment', addPayload);
    await applyOne(p);
    const [comment] = fake.comments.values();
    Object.assign(comment, { body: 'I answered this.', updatedAt: 'later' });
    const result = await undoProposal(applied(p));
    expect(result.ok).toBe(false);
    expect(fake.comments.size).toBe(1);
  });

  it('fails, and leaves no comment, when the quote has gone', async () => {
    fake.page = doc('Something else entirely.');
    expect(await applyOne(proposal('addComment', addPayload))).toBe(false);
    expect(resolves().find((r) => r.status === 'failed')?.error).toMatch(/no longer in the text/);
    expect(fake.comments.size).toBe(0);
  });
});

describe('resolve_comment', () => {
  it('resolves through the app, and undo opens it again unless it changed since', async () => {
    fake.comments.set('c9', { id: 'c9', sourceKind: 'page', sourceId: 'p1', body: 'Hm.', author: 'you', quote: '', resolved: false, updatedAt: 't0' });
    const p = proposal('resolveComment', { commentId: 'c9', resolved: true, before: false });
    expect(await applyOne(p)).toBe(true);
    expect(fake.comments.get('c9')!.resolved).toBe(true);
    const undoable = applied(p);

    fake.comments.get('c9')!.resolved = false;
    expect((await undoProposal(undoable)).ok).toBe(false);

    fake.comments.get('c9')!.resolved = true;
    fake.status = 'applied';
    const stamp = (undoable.payload.undo as { updatedAt: string }).updatedAt;
    fake.comments.get('c9')!.updatedAt = stamp;
    expect((await undoProposal(undoable)).ok).toBe(true);
    expect(fake.comments.get('c9')!.resolved).toBe(false);
  });
});
