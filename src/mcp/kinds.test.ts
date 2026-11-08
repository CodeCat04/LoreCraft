/**
 * The registry of proposal kinds, the edit level's auto-apply, and Undo, against a fake
 * native side that keeps one page and one proposal.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const fake = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  page: null as unknown,
  status: 'auto',
  guide: '{}',
}));

vi.mock('../editor/saving', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../editor/saving')>()),
  flushOrStop: vi.fn(async () => {}),
}));
vi.mock('../shell/toasts', () => ({ toast: vi.fn() }));
vi.mock('../lib/rpc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/rpc')>();
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
        case 'revisions.checkpoint':
          return 'rev1';
        case 'revisions.restore':
          fake.page = doc('She said no twice.');
          return { kind: 'page', id: 'p1' };
        case 'project.getMeta':
          return params.key === 'writingStyles.guide' ? fake.guide : null;
        case 'project.setMeta':
          if (params.key === 'writingStyles.guide') fake.guide = params.value as string;
          return null;
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

import { KINDS, kindFor } from './kinds';
import { applyOne } from './auto';
import { undoProposal } from './actions';
import type { AnyProposal } from './api';
import { useProject } from '../state/project';

function edit(): AnyProposal<Record<string, unknown>> {
  return {
    id: 'x1',
    client: 'Claude Code',
    kind: 'edit',
    targetKind: 'page',
    targetId: 'p1',
    title: 'Aria',
    status: 'auto',
    createdAt: '2026-01-01T00:00:00Z',
    payload: { quote: 'She said no twice.', replacement: 'She refused.' },
  };
}

const resolves = () => fake.calls.filter((c) => c.method === 'mcp.proposalResolve').map((c) => c.params);

beforeEach(() => {
  fake.calls = [];
  fake.page = doc('She said no twice.');
  fake.status = 'auto';
  fake.guide = '{}';
  useProject.setState((s) => ({ status: { ...s.status, open: true } }));
});

describe('the kind registry', () => {
  it('has one entry per kind, each with a card and an apply', () => {
    const names = KINDS.map((k) => k.kind);
    expect(new Set(names).size).toBe(names.length);
    for (const kind of KINDS) {
      expect(typeof kind.apply, kind.kind).toBe('function');
      expect(kind.Card, kind.kind).toBeTruthy();
      expect(kind.accepted(), kind.kind).not.toBe('');
    }
    expect(kindFor('nothing')).toBeUndefined();
  });

  it('knows every kind a Rust write tool can store', () => {
    const dir = join(__dirname, '../../src-tauri/src/mcp/areas');
    const kinds = new Set<string>();
    for (const file of readdirSync(dir)) {
      const code = readFileSync(join(dir, file), 'utf8');
      for (const m of code.matchAll(/Draft::new\(\s*"(\w+)"|store\(target, "(\w+)"/g)) kinds.add(m[1] ?? m[2]);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(8);
    for (const kind of kinds) expect(kindFor(kind), kind).toBeDefined();
  });
});

describe('the edit level', () => {
  it('applies a change through the same code as Accept, and keeps what Undo needs', async () => {
    expect(await applyOne(edit())).toBe(true);
    expect(fake.calls.map((c) => c.method)).toContain('revisions.checkpoint');
    expect(JSON.stringify(fake.page)).toContain('She refused.');
    const [claim, done] = resolves();
    expect(claim.status).toBe('applying');
    expect(done.status).toBe('applied');
    expect(done.targetId).toBe('p1');
    expect((done.undo as { revision: string }).revision).toBe('rev1');
  });

  it('does nothing with a change it could not pick up', async () => {
    fake.status = 'pending';
    expect(await applyOne(edit())).toBe(false);
    expect(fake.calls.map((c) => c.method)).not.toContain('pages.update');
  });

  it('reports the real reason when a change cannot be made', async () => {
    fake.page = doc('Something else entirely.');
    expect(await applyOne(edit())).toBe(false);
    const failed = resolves().find((r) => r.status === 'failed');
    expect(failed?.error).toMatch(/no longer there/);
    expect(fake.calls.map((c) => c.method)).not.toContain('pages.update');
  });

  it('undoes a text change by restoring the revision saved before, unless it changed since', async () => {
    await applyOne(edit());
    const done = resolves().find((r) => r.status === 'applied')!;
    const applied = { ...edit(), status: 'applied', payload: { ...edit().payload, undo: done.undo } };

    const saved = fake.page;
    fake.page = doc('The writer kept typing.');
    const refused = await undoProposal(applied);
    expect(refused.ok).toBe(false);
    expect(fake.calls.map((c) => c.method)).not.toContain('revisions.restore');

    fake.page = saved;
    expect((await undoProposal(applied)).ok).toBe(true);
    expect(fake.calls.map((c) => c.method)).toContain('revisions.restore');
    expect(resolves().at(-1)?.status).toBe('undone');
  });

  it('sets the style guide through the store, and undo puts the old text back', async () => {
    fake.guide = JSON.stringify({ project: { voice: 'Wry.' } });
    const proposal: AnyProposal<Record<string, unknown>> = {
      ...edit(),
      kind: 'styleGuide',
      targetKind: 'meta',
      targetId: 'writingStyles.guide',
      title: 'Style guide',
      payload: { mode: 'replace', changes: { voice: 'Plain.' }, before: { voice: 'Wry.' } },
    };
    expect(await applyOne(proposal)).toBe(true);
    expect(JSON.parse(fake.guide).project.voice).toBe('Plain.');
    const applied = { ...proposal, status: 'applied' };
    expect((await undoProposal(applied)).ok).toBe(true);
    expect(JSON.parse(fake.guide).project.voice).toBe('Wry.');
  });
});
