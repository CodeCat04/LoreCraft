/** Apply and Undo for the structure kinds, against a fake native side with one small book. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const doc = (...paras: string[]) => ({ type: 'doc', content: paras.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

interface FakeNode {
  id: string;
  bookId: string;
  parentId: string | null;
  kind: string;
  title: string;
  position: number;
  status: string;
  synopsis: string;
  notes: string;
  targetWords: number;
  wordCount: number;
  deletedAt: string | null;
  updatedAt: string;
  content?: unknown;
}

const fake = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  nodes: [] as FakeNode[],
  book: { id: 'b1', title: 'Book One', subtitle: '', author: '', targetWords: 0, updatedAt: 'u1', deletedAt: null as string | null },
  meta: {} as Record<string, string>,
  links: [] as { nodeId: string; threadId: string }[],
  threads: [] as { id: string; name: string; color: string; description: string; position: number }[],
}));

vi.mock('../../editor/saving', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../editor/saving')>()),
  flushOrStop: vi.fn(async () => {}),
}));
vi.mock('../../shell/toasts', () => ({ toast: vi.fn() }));
vi.mock('../../lib/rpc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/rpc')>();
  const node = (id: unknown) => {
    const found = fake.nodes.find((n) => n.id === id);
    if (!found) throw new real.RpcError('NOT_FOUND', 'That item was not found.');
    return found;
  };
  const reorder = (parentId: string | null) =>
    fake.nodes
      .filter((n) => n.parentId === parentId && !n.deletedAt)
      .sort((a, b) => a.position - b.position)
      .forEach((n, i) => (n.position = i));
  return {
    ...real,
    rpc: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      fake.calls.push({ method, params });
      switch (method) {
        case 'nodes.get':
          return { ...node(params.id) };
        case 'nodes.tree':
          return fake.nodes.filter((n) => !n.deletedAt).map((n) => ({ ...n }));
        case 'nodes.update':
          Object.assign(node(params.id), params.patch);
          return { ...node(params.id) };
        case 'nodes.move': {
          const moved = node(params.id);
          const parentId = (params.parentId as string | null) ?? null;
          const others = fake.nodes.filter((n) => n.parentId === parentId && !n.deletedAt && n.id !== moved.id).sort((a, b) => a.position - b.position);
          others.splice(params.index as number, 0, moved);
          const old = moved.parentId;
          moved.parentId = parentId;
          others.forEach((n, i) => (n.position = i));
          reorder(old);
          return true;
        }
        case 'nodes.delete':
          node(params.id).deletedAt = 'd1';
          return true;
        case 'nodes.restore':
          node(params.id).deletedAt = null;
          return true;
        case 'nodes.split': {
          const original = node(params.id);
          original.content = params.before;
          const made: FakeNode = { ...original, id: 'made', title: `${original.title} (continued)`, position: original.position + 0.5, content: params.after };
          fake.nodes.push(made);
          reorder(original.parentId);
          return { ...made };
        }
        case 'nodes.merge':
          node('made').deletedAt = 'd2';
          return { ...node(params.id) };
        case 'books.list':
          return fake.book.deletedAt ? [] : [{ ...fake.book }];
        case 'books.update':
          Object.assign(fake.book, params.patch, { updatedAt: 'u2' });
          return true;
        case 'project.getMeta':
          return fake.meta[params.key as string] ?? null;
        case 'project.setMeta':
          fake.meta[params.key as string] = params.value as string;
          return null;
        case 'threads.list':
          return fake.threads.map((th) => ({ ...th }));
        case 'threads.links':
          return fake.links.map((l) => ({ ...l }));
        case 'threads.setLink':
          fake.links = fake.links.filter((l) => !(l.nodeId === params.nodeId && l.threadId === params.threadId));
          if (params.on) fake.links.push({ nodeId: params.nodeId as string, threadId: params.threadId as string });
          return true;
        case 'threads.create': {
          const made = { id: `t${fake.threads.length + 1}`, name: params.name as string, color: 'accent', description: '', position: fake.threads.length };
          fake.threads.push(made);
          return { ...made };
        }
        case 'threads.update':
          Object.assign(fake.threads.find((th) => th.id === params.id)!, params.patch);
          return true;
        case 'threads.delete':
          fake.threads = fake.threads.filter((th) => th.id !== params.id);
          fake.links = fake.links.filter((l) => l.threadId !== params.id);
          return true;
        default:
          return null;
      }
    }),
  };
});

import { kindFor } from './index';
import type { AnyProposal } from '../api';
import { useProject } from '../../state/project';

function proposal(kind: string, targetId: string | null, payload: Record<string, unknown>, title = 'Scene 2'): AnyProposal<Record<string, unknown>> {
  return { id: 'x', client: 'Claude Code', kind, targetKind: 'node', targetId, title, status: 'auto', createdAt: '2026-01-01T00:00:00Z', payload };
}

/** Applies, then undoes with what apply kept, as the edit level does. */
async function applyThenUndo(p: AnyProposal<Record<string, unknown>>, between?: () => void) {
  const kind = kindFor(p.kind)!;
  const applied = await kind.apply(p);
  expect(applied).toMatchObject({ ok: true });
  between?.();
  const undo = applied.ok ? applied.undo : undefined;
  return kind.undo!({ ...p, status: 'applied', payload: { ...p.payload, undo } }, undo);
}

const sceneTitles = () =>
  fake.nodes
    .filter((n) => n.kind === 'scene' && !n.deletedAt)
    .sort((a, b) => a.position - b.position)
    .map((n) => n.title);

const base = (id: string, kind: string, parentId: string | null, position: number, title: string): FakeNode => ({
  id, bookId: 'b1', parentId, kind, title, position, status: 'draft', synopsis: '', notes: '', targetWords: 0, wordCount: 0, deletedAt: null, updatedAt: 'u1',
});

beforeEach(() => {
  fake.calls = [];
  fake.nodes = [
    base('c1', 'chapter', null, 0, 'Chapter 1'),
    { ...base('s1', 'scene', 'c1', 0, 'Scene 1'), content: doc('The gate is old.', 'Rain fell on the keep.') },
    base('s2', 'scene', 'c1', 1, 'Scene 2'),
  ];
  fake.book = { id: 'b1', title: 'Book One', subtitle: '', author: '', targetWords: 0, updatedAt: 'u1', deletedAt: null };
  fake.meta = {};
  fake.links = [];
  fake.threads = [{ id: 't1', name: 'The succession', color: 'accent', description: '', position: 0 }];
  useProject.setState((s) => ({ status: { ...s.status, open: true } }));
});

describe('structure kinds', () => {
  it('moves a node before another, and Undo puts it back unless it moved again', async () => {
    const move = proposal('nodeMove', 's2', {
      kind: 'scene',
      bookId: 'b1',
      from: { parentId: 'c1', parentTitle: 'Chapter 1', index: 1 },
      to: { parentId: 'c1', parentTitle: 'Chapter 1', beforeId: 's1', anchorTitle: 'Scene 1' },
    });
    const undone = await applyThenUndo(move, () => expect(sceneTitles()).toEqual(['Scene 2', 'Scene 1']));
    expect(undone.ok).toBe(true);
    expect(sceneTitles()).toEqual(['Scene 1', 'Scene 2']);

    await applyThenUndo(move, () => {
      fake.nodes.find((n) => n.id === 's2')!.position = 5;
    }).then((r) => expect(r.ok).toBe(false));
  });

  it('renames a chapter and sets its status, and Undo restores both', async () => {
    const details = proposal('nodeDetails', 'c1', {
      kind: 'chapter',
      changes: { title: 'Opening', status: 'final' },
      before: { title: 'Chapter 1', status: 'draft', synopsis: '', notes: '', targetWords: 0 },
    });
    const undone = await applyThenUndo(details, () => expect(fake.nodes[0]).toMatchObject({ title: 'Opening', status: 'final' }));
    expect(undone.ok).toBe(true);
    expect(fake.nodes[0]).toMatchObject({ title: 'Chapter 1', status: 'draft' });

    const refused = await applyThenUndo(details, () => (fake.nodes[0].title = 'The writer renamed it'));
    expect(refused).toMatchObject({ ok: false });
    expect(fake.nodes[0].title).toBe('The writer renamed it');
  });

  it('changes book settings through the same stores as the dialog, voice included', async () => {
    const settings = {
      ...proposal('bookSettings', 'b1', {
        changes: { title: 'The Ash', pov: 'first', tense: 'past' },
        before: { title: 'Book One', subtitle: '', author: '', targetWords: 0, pov: '', tense: '', style: '' },
      }, 'Book One'),
      targetKind: 'book',
    };
    const undone = await applyThenUndo(settings, () => {
      expect(fake.book.title).toBe('The Ash');
      expect(JSON.parse(fake.meta['books.voice'])).toEqual({ b1: { pov: 'first', tense: 'past' } });
    });
    expect(undone.ok).toBe(true);
    expect(fake.book.title).toBe('Book One');
    expect(JSON.parse(fake.meta['books.voice'])).toEqual({});
  });

  it('refuses a writing style it does not know', async () => {
    const result = await kindFor('bookSettings')!.apply({
      ...proposal('bookSettings', 'b1', { changes: { style: 'No such style at all' }, before: { style: '' } }, 'Book One'),
      targetKind: 'book',
    });
    expect(result).toMatchObject({ ok: false });
    expect(fake.calls.map((c) => c.method)).not.toContain('project.setMeta');
  });

  it('moves a node to the trash and Undo brings it back; nothing is purged', async () => {
    const trash = proposal('nodeTrash', 's2', { op: 'trash', kind: 'scene', bookId: 'b1' });
    const undone = await applyThenUndo(trash, () => expect(fake.nodes[2].deletedAt).toBe('d1'));
    expect(undone.ok).toBe(true);
    expect(fake.nodes[2].deletedAt).toBeNull();
    expect(fake.calls.map((c) => c.method)).not.toContain('nodes.purge');
  });

  it('splits a scene at the quote, and Undo merges the halves back', async () => {
    const split = proposal('sceneSplit', 's1', { quote: 'Rain fell', position: 'before' }, 'Scene 1');
    const undone = await applyThenUndo(split, () => {
      const call = fake.calls.find((c) => c.method === 'nodes.split')!;
      expect(JSON.stringify(call.params.before)).toContain('The gate is old.');
      expect(JSON.stringify(call.params.before)).not.toContain('Rain');
      expect(JSON.stringify(call.params.after)).toContain('Rain fell on the keep.');
      expect(sceneTitles()).toEqual(['Scene 1', 'Scene 1 (continued)', 'Scene 2']);
    });
    expect(undone.ok).toBe(true);
    expect(fake.calls.at(-1)).toMatchObject({ method: 'nodes.merge', params: { id: 's1' } });
  });

  it('refuses to split when the quote is gone', async () => {
    const result = await kindFor('sceneSplit')!.apply(proposal('sceneSplit', 's1', { quote: 'Snow came', position: 'before' }, 'Scene 1'));
    expect(result).toMatchObject({ ok: false });
    expect(fake.calls.map((c) => c.method)).not.toContain('nodes.split');
  });

  it('adds a scene to a thread, and Undo takes it out again', async () => {
    const link = proposal('thread', 's2', { op: 'link', on: true, threadId: 't1', threadName: 'The succession', nodeId: 's2', sceneTitle: 'Scene 2', bookTitle: 'Book One' });
    const undone = await applyThenUndo(link, () => expect(fake.links).toEqual([{ nodeId: 's2', threadId: 't1' }]));
    expect(undone.ok).toBe(true);
    expect(fake.links).toEqual([]);
  });

  it('deletes a thread, and Undo brings it back with its scenes', async () => {
    fake.links = [{ nodeId: 's1', threadId: 't1' }];
    const del = { ...proposal('thread', 't1', { op: 'delete', before: { name: 'The succession', color: 'accent', description: 'Who rules.', position: 0, sceneIds: ['s1'] } }), targetKind: 'meta' };
    const undone = await applyThenUndo(del, () => expect(fake.threads).toEqual([]));
    expect(undone.ok).toBe(true);
    expect(fake.threads).toMatchObject([{ name: 'The succession', description: 'Who rules.' }]);
    expect(fake.links).toEqual([{ nodeId: 's1', threadId: fake.threads[0].id }]);
  });

  it('creates a thread, and Undo removes it only while it is unused', async () => {
    const create = proposal('thread', null, { op: 'create', name: 'The war', description: 'Who wins.' });
    expect((await applyThenUndo(create)).ok).toBe(true);
    expect(fake.threads.map((th) => th.name)).toEqual(['The succession']);
    const refused = await applyThenUndo(create, () => fake.links.push({ nodeId: 's1', threadId: fake.threads[1].id }));
    expect(refused.ok).toBe(false);
  });
});
