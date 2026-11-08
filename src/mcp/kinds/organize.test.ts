/**
 * The prompt library and idea inbox kinds: apply, and undo that refuses once the prompt or
 * idea has changed since. Against a fake native side that keeps prompts, ideas and pages.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePrompt {
  id: string;
  name: string;
  description: string;
  template: string;
  scope: string;
  action: string;
  builtin: boolean;
  position: number;
}
interface FakeIdea {
  id: string;
  text: string;
  status: string;
  updatedAt: string;
}

const fake = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  prompts: [] as FakePrompt[],
  ideas: [] as FakeIdea[],
  pages: [] as { id: string; title: string; status: string; deletedAt: string | null; updatedAt: string }[],
  seq: 0,
  status: 'auto',
}));

vi.mock('../../editor/saving', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../editor/saving')>()),
  flushOrStop: vi.fn(async () => {}),
}));
vi.mock('../../shell/toasts', () => ({ toast: vi.fn() }));
vi.mock('../../lib/rpc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/rpc')>();
  const stamp = () => `t${++fake.seq}`;
  return {
    ...real,
    rpc: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      fake.calls.push({ method, params });
      switch (method) {
        case 'ai.listPrompts':
          return fake.prompts.map((p) => ({ ...p }));
        case 'ai.savePrompt': {
          const fields = { name: params.name, description: params.description ?? '', template: params.template, scope: params.scope, action: params.action } as Omit<FakePrompt, 'id' | 'builtin' | 'position'>;
          if (params.id) {
            const p = fake.prompts.find((x) => x.id === params.id)!;
            Object.assign(p, fields);
            return { ...p };
          }
          const p: FakePrompt = { ...fields, id: `pr${++fake.seq}`, builtin: false, position: 9 };
          fake.prompts.push(p);
          return { ...p };
        }
        case 'ai.deletePrompt':
          fake.prompts = fake.prompts.filter((p) => p.id !== params.id);
          return true;
        case 'ideas.list':
          return fake.ideas.map((i) => ({ ...i }));
        case 'ideas.add': {
          const idea = { id: `i${++fake.seq}`, text: params.text as string, status: 'open', updatedAt: stamp() };
          fake.ideas.push(idea);
          return { ...idea };
        }
        case 'ideas.update': {
          const idea = fake.ideas.find((i) => i.id === params.id)!;
          if (params.text !== undefined) idea.text = params.text as string;
          if (params.status !== undefined) idea.status = params.status as string;
          idea.updatedAt = stamp();
          return { ...idea };
        }
        case 'ideas.delete':
          fake.ideas = fake.ideas.filter((i) => i.id !== params.id);
          return true;
        case 'pages.create': {
          const page = { id: `pg${++fake.seq}`, title: params.title as string, status: params.status as string, deletedAt: null, updatedAt: stamp() };
          fake.pages.push(page);
          return { ...page };
        }
        case 'pages.get':
          return { ...fake.pages.find((p) => p.id === params.id)! };
        case 'pages.delete':
        case 'pages.remove': {
          const page = fake.pages.find((p) => p.id === params.id)!;
          page.deletedAt = 'now';
          return true;
        }
        case 'mcp.proposalResolve': {
          const from: Record<string, string> = { applying: 'auto', applied: 'applying', failed: 'applying', undone: 'applied' };
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

import { kindFor } from './index';
import { applyOne } from '../auto';
import type { AnyProposal } from '../api';
import { useProject } from '../../state/project';

function proposal(kind: string, payload: Record<string, unknown>, targetId: string | null = null): AnyProposal<Record<string, unknown>> {
  return {
    id: 'x1',
    client: 'Claude Code',
    kind,
    targetKind: targetId ? (kind.includes('Prompt') ? 'prompt' : 'idea') : null,
    targetId,
    title: 'T',
    status: 'auto',
    createdAt: '2026-01-01T00:00:00Z',
    payload,
  };
}

async function applied(p: AnyProposal<Record<string, unknown>>) {
  const result = await kindFor(p.kind)!.apply(p);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.ok ? result.undo : undefined;
}

const undo = (p: AnyProposal<Record<string, unknown>>, info: unknown) => kindFor(p.kind)!.undo!(p, info);

const fields = (template: string) => ({ name: 'Darker', description: '', template, scope: 'selection', action: 'replace' });

beforeEach(() => {
  fake.calls = [];
  fake.prompts = [{ id: 'mine', ...fields('Make this darker.'), builtin: false, position: 0 }];
  fake.ideas = [{ id: 'i0', text: 'The gate remembers', status: 'open', updatedAt: 't0' }];
  fake.pages = [];
  fake.status = 'auto';
  useProject.setState((s) => ({ status: { ...s.status, open: true } }));
});

describe('prompt kinds', () => {
  it('creates a prompt, and undo deletes it unless it changed', async () => {
    const p = proposal('newPrompt', { fields: { ...fields('Brighter.'), name: 'Brighter' } });
    const info = await applied(p);
    const made = fake.prompts.find((x) => x.name === 'Brighter')!;
    made.template = 'Edited by the writer.';
    expect((await undo(p, info)).ok).toBe(false);
    made.template = 'Brighter.';
    expect((await undo(p, info)).ok).toBe(true);
    expect(fake.prompts.some((x) => x.name === 'Brighter')).toBe(false);
  });

  it('changes a prompt, and undo puts the old fields back', async () => {
    const p = proposal('updatePrompt', { fields: fields('Much darker.'), before: fields('Make this darker.') }, 'mine');
    const info = await applied(p);
    expect(fake.prompts[0].template).toBe('Much darker.');
    expect((await undo(p, info)).ok).toBe(true);
    expect(fake.prompts[0].template).toBe('Make this darker.');
  });

  it('will not change a prompt that changed since it was suggested, or a built-in', async () => {
    const p = proposal('updatePrompt', { fields: fields('Much darker.'), before: fields('Something else.') }, 'mine');
    expect((await kindFor('updatePrompt')!.apply(p)).ok).toBe(false);
    fake.prompts[0].builtin = true;
    const q = proposal('updatePrompt', { fields: fields('Much darker.'), before: fields('Make this darker.') }, 'mine');
    expect((await kindFor('updatePrompt')!.apply(q)).ok).toBe(false);
    expect(fake.calls.map((c) => c.method)).not.toContain('ai.savePrompt');
  });

  it('deletes a prompt at the edit level, and undo makes it again', async () => {
    const p = proposal('deletePrompt', { before: fields('Make this darker.') }, 'mine');
    expect(await applyOne(p)).toBe(true);
    expect(fake.prompts).toHaveLength(0);
    fake.status = 'applied';
    expect((await undo(p, { id: 'mine' })).ok).toBe(true);
    expect(fake.prompts.map((x) => x.template)).toEqual(['Make this darker.']);
  });
});

describe('idea kinds', () => {
  it('adds an idea, and undo takes it away unless the writer edited it', async () => {
    const p = proposal('addIdea', { text: 'A new moon\n\n(From Claude Code)' });
    const info = await applied(p);
    const idea = fake.ideas.find((i) => i.text.startsWith('A new moon'))!;
    idea.text = 'A new moon, edited';
    expect((await undo(p, info)).ok).toBe(false);
    idea.text = 'A new moon\n\n(From Claude Code)';
    idea.status = 'done';
    expect((await undo(p, info)).ok).toBe(false);
    // Marked done and opened again since: it is as it was added.
    idea.status = 'open';
    idea.updatedAt = 'later';
    expect((await undo(p, info)).ok).toBe(true);
    expect(fake.ideas.some((i) => i.text.startsWith('A new moon'))).toBe(false);
  });

  it('changes an idea, and undo puts the old text back unless it changed', async () => {
    const p = proposal('updateIdea', { text: 'The gate forgets', before: 'The gate remembers' }, 'i0');
    const info = await applied(p);
    expect(fake.ideas[0].text).toBe('The gate forgets');
    fake.ideas[0].text = 'Writer rewrote it';
    expect((await undo(p, info)).ok).toBe(false);
    fake.ideas[0].text = 'The gate forgets';
    expect((await undo(p, info)).ok).toBe(true);
    expect(fake.ideas[0].text).toBe('The gate remembers');
  });

  it('marks an idea done, and undo opens it again', async () => {
    const p = proposal('resolveIdea', { status: 'done', before: 'open' }, 'i0');
    const info = await applied(p);
    expect(fake.ideas[0].status).toBe('done');
    expect((await undo(p, info)).ok).toBe(true);
    expect(fake.ideas[0].status).toBe('open');
  });

  it('turns an idea into a page with status idea, and undo trashes the page and reopens the idea', async () => {
    const p = proposal('ideaToPage', { title: 'The gate', pageType: 'article', text: 'The gate remembers', before: 'open' }, 'i0');
    const info = await applied(p);
    expect(fake.pages).toHaveLength(1);
    expect(fake.pages[0].status).toBe('idea');
    expect(fake.ideas[0].status).toBe('done');
    expect((await undo(p, info)).ok).toBe(true);
    expect(fake.pages[0].deletedAt).not.toBeNull();
    expect(fake.ideas[0].status).toBe('open');
  });

  it('will not change an idea that has gone', async () => {
    fake.ideas = [];
    const p = proposal('updateIdea', { text: 'x', before: 'The gate remembers' }, 'i0');
    expect((await kindFor('updateIdea')!.apply(p)).ok).toBe(false);
  });
});
