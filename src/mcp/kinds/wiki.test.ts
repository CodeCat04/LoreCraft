/** The wiki kinds: apply goes through the app's own RPCs, and Undo refuses once things have moved on. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePage {
  id: string;
  title: string;
  summary: string;
  status: string;
  pageType: string;
  aliases: string[];
  categories: string[];
  infobox: { fields: { key: string; label: string; kind: string; value: string }[] };
  notes: unknown;
  deletedAt: string | null;
  updatedAt: string;
}

const fake = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  page: null as unknown as FakePage,
  relationships: [] as { id: string; fromPageId: string; toPageId: string; kind: string; note: string }[],
  pins: [] as { id: string; x: number; y: number; pageId: string | null; label: string }[],
  next: 0,
}));

vi.mock('../../editor/saving', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../editor/saving')>()),
  flushOrStop: vi.fn(async () => {}),
}));
vi.mock('../../lib/rpc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/rpc')>();
  return {
    ...real,
    rpc: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      fake.calls.push({ method, params });
      const id = () => `n${(fake.next += 1)}`;
      switch (method) {
        case 'pages.get':
          return structuredClone(fake.page);
        case 'pages.update':
          Object.assign(fake.page, structuredClone(params.patch));
          return {};
        case 'pages.rename':
          fake.page.title = params.newTitle as string;
          return { documentsChanged: 2 };
        case 'pages.delete':
          fake.page.deletedAt = 'now';
          return true;
        case 'pages.restore':
          fake.page.deletedAt = null;
          return true;
        case 'extras.relationshipList':
          return structuredClone(fake.relationships);
        case 'extras.relationshipAdd': {
          const row = { id: id(), ...(params as { fromPageId: string; toPageId: string; kind: string; note: string }) };
          fake.relationships.push(row);
          return row;
        }
        case 'extras.relationshipDelete':
          fake.relationships = fake.relationships.filter((r) => r.id !== params.id);
          return true;
        case 'extras.mapGet':
          return { id: 'm1', pins: structuredClone(fake.pins) };
        case 'extras.pinAdd': {
          const pin = { id: id(), pageId: (params.pageId as string) ?? null, label: params.label as string, x: params.x as number, y: params.y as number };
          fake.pins.push(pin);
          return pin;
        }
        case 'extras.pinUpdate': {
          const pin = fake.pins.find((p) => p.id === params.id)!;
          Object.assign(pin, { x: params.x ?? pin.x, y: params.y ?? pin.y });
          return pin;
        }
        case 'extras.pinDelete':
          fake.pins = fake.pins.filter((p) => p.id !== params.id);
          return true;
        default:
          return null;
      }
    }),
  };
});

import { kindFor } from './index';
import type { AnyProposal } from '../api';
import { withNote } from './wiki';

function proposal(kind: string, payload: Record<string, unknown>, title = 'Aria'): AnyProposal<Record<string, unknown>> {
  return { id: 'x1', client: 'Claude Code', kind, targetKind: 'page', targetId: 'p1', title, status: 'auto', createdAt: '2026-01-01T00:00:00Z', payload };
}

async function applyThenUndo(p: AnyProposal<Record<string, unknown>>) {
  const kind = kindFor(p.kind)!;
  const applied = await kind.apply(p);
  expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true });
  const undo = applied.ok ? applied.undo : undefined;
  return { kind, undo: () => kind.undo!({ ...p, status: 'applied', payload: { ...p.payload, undo } }, undo) };
}

const methods = () => fake.calls.map((c) => c.method);

beforeEach(() => {
  fake.calls = [];
  fake.next = 0;
  fake.page = {
    id: 'p1',
    title: 'Aria',
    summary: 'A smith.',
    status: 'draft',
    pageType: 'character',
    aliases: ['Ari'],
    categories: ['People'],
    infobox: { fields: [{ key: 'born', label: 'Born', kind: 'date', value: '312' }] },
    notes: null,
    deletedAt: null,
    updatedAt: 'u1',
  };
  fake.relationships = [];
  fake.pins = [{ id: 'pin1', x: 0.5, y: 0.5, pageId: 'p2', label: '' }];
});

describe('page details', () => {
  const p = () =>
    proposal('pageUpdate', {
      changes: { status: 'canon', aliases: ['Ari', 'The Smith'] },
      before: { summary: 'A smith.', status: 'draft', pageType: 'character', aliases: ['Ari'], categories: ['People'] },
    });

  it('sets only what changes, and undo puts the old values back', async () => {
    const { undo } = await applyThenUndo(p());
    expect(fake.page.status).toBe('canon');
    expect(fake.page.aliases).toEqual(['Ari', 'The Smith']);
    expect(fake.calls.find((c) => c.method === 'pages.update')?.params.patch).toEqual({ status: 'canon', aliases: ['Ari', 'The Smith'] });
    expect((await undo()).ok).toBe(true);
    expect(fake.page.status).toBe('draft');
    expect(fake.page.aliases).toEqual(['Ari']);
  });

  it('refuses to undo once the writer changed it, and to apply over their change', async () => {
    const { undo } = await applyThenUndo(p());
    fake.page.status = 'idea';
    expect((await undo()).ok).toBe(false);
    expect(fake.page.status).toBe('idea');
    fake.page.status = 'retconned';
    expect((await kindFor('pageUpdate')!.apply(p())).ok).toBe(false);
  });
});

describe('infobox fields', () => {
  const p = () =>
    proposal('infoboxFields', {
      before: [{ key: 'born', label: 'Born', kind: 'date', value: '312' }],
      fields: [
        { key: 'born', label: 'Born', kind: 'date', value: '300' },
        { key: 'home', label: 'Home', kind: 'page', value: 'Gate' },
      ],
    });

  it('writes the new fields and undo restores the old ones', async () => {
    const { undo } = await applyThenUndo(p());
    expect(fake.page.infobox.fields.map((f) => f.value)).toEqual(['300', 'Gate']);
    expect((await undo()).ok).toBe(true);
    expect(fake.page.infobox.fields).toEqual([{ key: 'born', label: 'Born', kind: 'date', value: '312' }]);
  });

  it('refuses when the infobox changed in between', async () => {
    const { undo } = await applyThenUndo(p());
    fake.page.infobox.fields[0].value = '1';
    expect((await undo()).ok).toBe(false);
    fake.page.infobox.fields = [];
    expect((await kindFor('infoboxFields')!.apply(p())).ok).toBe(false);
  });
});

describe('renaming', () => {
  it('renames with links, and undo renames back without keeping an alias', async () => {
    const { undo } = await applyThenUndo(proposal('pageRename', { oldTitle: 'Aria', newTitle: 'Aria Vale', updateLinks: true, keepAlias: true, documents: 2 }));
    expect(fake.page.title).toBe('Aria Vale');
    expect(fake.calls.find((c) => c.method === 'pages.rename')?.params).toMatchObject({ newTitle: 'Aria Vale', updateLinks: true, keepAlias: true });
    expect((await undo()).ok).toBe(true);
    expect(fake.page.title).toBe('Aria');
    expect(fake.calls.filter((c) => c.method === 'pages.rename').at(-1)?.params).toMatchObject({ newTitle: 'Aria', keepAlias: false });
  });

  it('refuses to undo after another rename', async () => {
    const { undo } = await applyThenUndo(proposal('pageRename', { oldTitle: 'Aria', newTitle: 'Aria Vale', updateLinks: true, keepAlias: true, documents: 0 }));
    fake.page.title = 'Someone';
    expect((await undo()).ok).toBe(false);
  });
});

describe('the trash', () => {
  it('trashes and undo restores; it never purges', async () => {
    const { undo } = await applyThenUndo(proposal('pageTrash', { action: 'trash' }));
    expect(fake.page.deletedAt).toBe('now');
    expect((await undo()).ok).toBe(true);
    expect(fake.page.deletedAt).toBeNull();
    expect(methods()).not.toContain('pages.purge');
  });

  it('restores and undo trashes again', async () => {
    fake.page.deletedAt = 'before';
    const { undo } = await applyThenUndo(proposal('pageTrash', { action: 'restore' }));
    expect(fake.page.deletedAt).toBeNull();
    expect((await undo()).ok).toBe(true);
    expect(fake.page.deletedAt).toBe('now');
  });
});

describe('talk notes', () => {
  it('adds after what is there, and undo takes it away unless the notes changed', async () => {
    const { undo } = await applyThenUndo(proposal('talkNote', { text: 'Check her age.', before: null }));
    expect(JSON.stringify(fake.page.notes)).toContain('Check her age.');
    expect((await undo()).ok).toBe(true);
    expect(JSON.stringify(fake.page.notes)).not.toContain('Check her age.');

    const again = await applyThenUndo(proposal('talkNote', { text: 'Second.', before: null }));
    fake.page.notes = withNote(fake.page.notes as never, 'The writer wrote more.');
    expect((await again.undo()).ok).toBe(false);
  });
});

describe('relationships', () => {
  const payload = { fromPageId: 'p1', fromTitle: 'Aria', toPageId: 'p2', toTitle: 'Gate', kind: 'ally', note: '' };

  it('adds one and undo removes it', async () => {
    const { undo } = await applyThenUndo(proposal('relationship', { action: 'add', ...payload }));
    expect(fake.relationships).toHaveLength(1);
    expect((await undo()).ok).toBe(true);
    expect(fake.relationships).toHaveLength(0);
  });

  it('removes one and undo adds it back', async () => {
    fake.relationships = [{ id: 'r1', ...payload }];
    const { undo } = await applyThenUndo(proposal('relationship', { action: 'remove', id: 'r1', ...payload }));
    expect(fake.relationships).toHaveLength(0);
    expect((await undo()).ok).toBe(true);
    expect(fake.relationships[0]).toMatchObject({ fromPageId: 'p1', toPageId: 'p2', kind: 'ally' });
  });
});

describe('map pins', () => {
  const base = { mapId: 'm1', mapTitle: 'Vale', pageId: 'p2', pageTitle: 'Gate', label: '' };

  it('adds a pin and undo takes it off', async () => {
    const { undo } = await applyThenUndo(proposal('mapPin', { action: 'add', ...base, x: 0.2, y: 0.3 }));
    expect(fake.pins).toHaveLength(2);
    expect((await undo()).ok).toBe(true);
    expect(fake.pins.map((p) => p.id)).toEqual(['pin1']);
  });

  it('moves a pin and undo moves it back, unless it moved again', async () => {
    const p = proposal('mapPin', { action: 'move', ...base, pinId: 'pin1', x: 0.9, y: 0.8, before: { x: 0.5, y: 0.5 } });
    const first = await applyThenUndo(p);
    expect(fake.pins[0]).toMatchObject({ x: 0.9, y: 0.8 });
    expect((await first.undo()).ok).toBe(true);
    expect(fake.pins[0]).toMatchObject({ x: 0.5, y: 0.5 });

    const second = await applyThenUndo(p);
    fake.pins[0].x = 0.1;
    expect((await second.undo()).ok).toBe(false);
  });

  it('removes a pin and undo puts it back where it was', async () => {
    const { undo } = await applyThenUndo(proposal('mapPin', { action: 'remove', ...base, pinId: 'pin1', x: 0.5, y: 0.5, before: { x: 0.5, y: 0.5 } }));
    expect(fake.pins).toHaveLength(0);
    expect((await undo()).ok).toBe(true);
    expect(fake.pins[0]).toMatchObject({ pageId: 'p2', x: 0.5, y: 0.5 });
  });
});
