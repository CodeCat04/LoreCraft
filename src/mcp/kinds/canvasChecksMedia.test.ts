/** Apply and Undo for the canvas, consistency and media kinds, against a fake native side. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  canvas: null as unknown as { title: string; data: unknown; deletedAt: string | null },
  findings: [] as { id: string; status: string; severity: string; evidence: unknown[] }[],
  asset: { label: '', description: '' },
  calls: [] as string[],
}));

vi.mock('../../lib/rpc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/rpc')>();
  return {
    ...real,
    rpc: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      fake.calls.push(method);
      switch (method) {
        case 'canvases.get':
          return { id: 'c1', createdAt: '', updatedAt: '', ...fake.canvas };
        case 'canvases.update':
          fake.canvas.data = JSON.parse(JSON.stringify(params.data));
          return { updatedAt: 'u' };
        case 'canvases.rename':
          fake.canvas.title = params.title as string;
          return true;
        case 'canvases.trash':
          fake.canvas.deletedAt = 'now';
          return true;
        case 'canvases.restore':
          fake.canvas.deletedAt = null;
          return true;
        case 'consistency.list':
          return fake.findings.map((f) => ({ ...f }));
        case 'consistency.setStatus': {
          const f = fake.findings.find((x) => x.id === params.id)!;
          f.status = params.status as string;
          return f;
        }
        case 'media.get':
          return { id: params.id, ...fake.asset };
        case 'media.setLabel':
          fake.asset = { label: params.label as string, description: params.description as string };
          return true;
        default:
          return null;
      }
    }),
  };
});
vi.mock('../../consistency/store', () => ({
  runRules: vi.fn(async () => {
    // The run reports one new finding and closes an old one.
    fake.findings.find((f) => f.id === 'old')!.status = 'fixed';
    fake.findings.push({ id: 'new', status: 'open', severity: 'error', evidence: [] });
  }),
  useConsistency: { getState: () => ({ rulesError: null, world: null }) },
}));

import { registerBoard } from '../../canvas/live';
import type { CanvasData } from '../../canvas/model';
import type { AnyProposal } from '../api';
import { applyCanvasOps, canvasEditKind, canvasRenameKind, canvasTrashKind, type CanvasOp } from './canvas';
import { consistencyRunKind, findingStatusKind, runReport } from './checks';
import { mediaLabelKind } from './media';

const proposal = <P extends object>(kind: string, payload: P): AnyProposal<P> => ({
  id: 'x1',
  client: 'Claude Code',
  kind,
  targetKind: null,
  targetId: null,
  title: 'War board',
  status: 'auto',
  createdAt: '2026-01-01T00:00:00Z',
  payload,
});

const board = (): CanvasData => ({
  nodes: [{ id: 't1', type: 'text', text: 'The war', x: 0, y: 0, width: 260, height: 80 }],
  edges: [],
});

const ops: CanvasOp[] = [
  { type: 'add', node: { id: 'n2', type: 'text', text: 'Thaw', x: 320, y: 0, width: 260, height: 80 } },
  { type: 'addEdge', edge: { id: 'e1', fromNode: 'n2', toNode: 't1', label: 'leads' } },
  { type: 'update', id: 't1', patch: { color: '1' } },
];

beforeEach(() => {
  fake.canvas = { title: 'War board', data: board(), deletedAt: null };
  fake.calls = [];
});

describe('canvas kinds', () => {
  it('applies operations in order and refuses when a card has gone', () => {
    const result = applyCanvasOps(board(), ops);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.nodes.map((n) => n.id)).toEqual(['t1', 'n2']);
    expect(result.data.nodes[0].color).toBe('1');
    expect(result.data.edges[0].label).toBe('leads');
    // Clearing a color from JSON null.
    const cleared = applyCanvasOps(result.data, [{ type: 'update', id: 't1', patch: { color: null as unknown as string } }]);
    expect(cleared.ok && 'color' in cleared.data.nodes[0]).toBe(false);
    expect(applyCanvasOps(board(), [{ type: 'remove', id: 'gone' }]).ok).toBe(false);
  });

  it('edits a stored canvas and undoes it, unless it changed since', async () => {
    const p = proposal('canvasEdit', { canvasId: 'c1', ops });
    const applied = await canvasEditKind.apply(p);
    expect(applied.ok).toBe(true);
    expect((fake.canvas.data as CanvasData).nodes).toHaveLength(2);
    const undo = applied.ok ? applied.undo : null;
    expect(await canvasEditKind.undo!(p, undo)).toEqual({ ok: true });
    expect(fake.canvas.data).toEqual(board());
    // Again, then the writer moves a card: Undo refuses.
    const again = await canvasEditKind.apply(p);
    (fake.canvas.data as CanvasData).nodes[0].x = 99;
    const refused = await canvasEditKind.undo!(p, again.ok ? again.undo : null);
    expect(refused.ok).toBe(false);
  });

  it('goes through the open board, so it shows at once', async () => {
    let shown = board();
    const flush = vi.fn(async () => {});
    const stop = registerBoard('c1', { data: () => shown, commit: (next) => (shown = next), flush });
    const p = proposal('canvasEdit', { canvasId: 'c1', ops });
    const applied = await canvasEditKind.apply(p);
    expect(shown.nodes).toHaveLength(2);
    expect(flush).toHaveBeenCalled();
    expect(fake.calls).not.toContain('canvases.update');
    expect(await canvasEditKind.undo!(p, applied.ok ? applied.undo : null)).toEqual({ ok: true });
    expect(shown).toEqual(board());
    stop();
  });

  it('renames and trashes, and Undo puts each back', async () => {
    const rename = proposal('canvasRename', { canvasId: 'c1', title: 'The war', before: 'War board' });
    expect((await canvasRenameKind.apply(rename)).ok).toBe(true);
    expect(fake.canvas.title).toBe('The war');
    expect(await canvasRenameKind.undo!(rename, null)).toEqual({ ok: true });
    expect(fake.canvas.title).toBe('War board');
    const trash = proposal('canvasTrash', { canvasId: 'c1' });
    await canvasTrashKind.apply(trash);
    expect(fake.canvas.deletedAt).toBe('now');
    expect(await canvasTrashKind.undo!(trash, null)).toEqual({ ok: true });
    expect(fake.canvas.deletedAt).toBeNull();
    expect((await canvasTrashKind.undo!(trash, null)).ok).toBe(false);
  });
});

describe('consistency kinds', () => {
  beforeEach(() => {
    fake.findings = [{ id: 'old', status: 'open', severity: 'warning', evidence: [] }];
  });

  it('runs the rule checks, reports, and Undo puts the statuses back', async () => {
    const p = proposal('consistencyRun', {});
    const applied = await consistencyRunKind.apply(p);
    expect(applied.ok).toBe(true);
    const undo = applied.ok ? (applied.undo as { report: string }) : null;
    expect(undo?.report).toBe('1 open finding: 1 error. Read them with list_findings.');
    expect(await consistencyRunKind.undo!(p, undo)).toEqual({ ok: true });
    expect(fake.findings.map((f) => [f.id, f.status])).toEqual([
      ['old', 'open'],
      ['new', 'fixed'],
    ]);
    expect(runReport([])).toBe('There are no open findings.');
  });

  it('dismisses a finding, and Undo reopens it unless the writer decided since', async () => {
    const p = proposal('findingStatus', { findingId: 'old', status: 'ignored', before: 'open' });
    expect((await findingStatusKind.apply(p)).ok).toBe(true);
    expect(fake.findings[0].status).toBe('ignored');
    expect(await findingStatusKind.undo!(p, null)).toEqual({ ok: true });
    expect(fake.findings[0].status).toBe('open');
    await findingStatusKind.apply(p);
    fake.findings[0].status = 'fixed';
    expect((await findingStatusKind.undo!(p, null)).ok).toBe(false);
    expect((await findingStatusKind.apply(proposal('findingStatus', { findingId: 'gone', status: 'fixed', before: 'open' }))).ok).toBe(false);
  });
});

describe('media kind', () => {
  it('labels a picture, and Undo puts the old words back unless changed since', async () => {
    fake.asset = { label: '', description: '' };
    const p = proposal('mediaLabel', {
      assetId: 'a1',
      name: 'north.jpg',
      mediaKind: 'image',
      label: 'Map of the north',
      description: 'A hand-drawn map.',
      before: { label: '', description: '' },
    });
    expect((await mediaLabelKind.apply(p)).ok).toBe(true);
    expect(fake.asset.label).toBe('Map of the north');
    expect(await mediaLabelKind.undo!(p, null)).toEqual({ ok: true });
    expect(fake.asset).toEqual({ label: '', description: '' });
    await mediaLabelKind.apply(p);
    fake.asset.description = 'The writer’s words.';
    expect((await mediaLabelKind.undo!(p, null)).ok).toBe(false);
  });
});
