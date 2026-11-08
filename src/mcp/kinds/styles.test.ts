/**
 * Applying and undoing the writing-style kinds, against a fake native side that keeps the
 * settings' custom styles and the project's style choices.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ choices: '{}' }));

vi.mock('../../editor/saving', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../editor/saving')>()),
  flushOrStop: vi.fn(async () => {}),
}));
vi.mock('../../shell/toasts', () => ({ toast: vi.fn() }));
vi.mock('../../lib/rpc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/rpc')>();
  return {
    ...real,
    rpc: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      switch (method) {
        case 'project.getMeta':
          return params.key === 'writingStyles.choices' ? fake.choices : null;
        case 'project.setMeta':
          if (params.key === 'writingStyles.choices') fake.choices = params.value as string;
          return null;
        case 'nodes.get':
          return { id: params.id, deletedAt: null, bookId: 'b1' };
        default:
          return null;
      }
    }),
  };
});

import { useProject } from '../../state/project';
import { useSettings } from '../../state/settings';
import { getStyle } from '../../writingStyles/store';
import type { CustomStyle } from '../../writingStyles/types';
import type { AnyProposal } from '../api';
import { defaultStyleKind, deleteWritingStyleKind, newWritingStyleKind, writingStyleKind } from './styles';
import type { ProposalKind } from './types';

const mine = (): CustomStyle => ({
  id: 'custom-1',
  kind: 'custom',
  name: 'Ashen voice',
  genres: [],
  summary: 'Spare.',
  traits: { narration: 'Close third.', sentences: 'Short.', diction: '', dialogue: '', description: '', pacing: '', signature: '', avoid: '' },
});

function proposal<P extends object>(kind: string, payload: P, targetKind: string | null = null, targetId: string | null = null): AnyProposal<P> {
  return { id: "x", client: "Claude Code", kind, targetKind, targetId, title: "t", status: "auto", createdAt: "2026-01-01T00:00:00Z", payload: payload as AnyProposal<P>["payload"] };
}

async function applied(kind: ProposalKind, p: AnyProposal<object>) {
  const result = await kind.apply(p);
  if (!result.ok) throw new Error(result.reason);
  return result.undo;
}

const customs = () => useSettings.getState().settings.writingStyles.custom;

beforeEach(() => {
  fake.choices = '{}';
  useProject.setState((s) => ({ status: { ...s.status, open: true } }));
  useSettings.setState((s) => ({ settings: { ...s.settings, writingStyles: { custom: [mine()], favorites: ['custom-1'] } } }));
});

describe('writing styles from outside tools', () => {
  it('creates a style through the store, and Undo deletes it unless it changed', async () => {
    const p = proposal('newWritingStyle', { name: 'Glass', promptOverride: 'Bright.', genres: ['fantasy', 'nonsense'] });
    const undo = await applied(newWritingStyleKind, p);
    const made = customs().find((s) => s.name === 'Glass')!;
    expect(made.promptOverride).toBe('Bright.');
    expect(made.genres).toEqual(['fantasy']);
    expect((await newWritingStyleKind.undo!(p, undo)).ok).toBe(true);
    expect(customs().some((s) => s.name === 'Glass')).toBe(false);

    const again = await applied(newWritingStyleKind, p);
    const id = customs().find((s) => s.name === 'Glass')!.id;
    useSettings.setState((s) => ({ settings: { ...s.settings, writingStyles: { ...s.settings.writingStyles, custom: s.settings.writingStyles.custom.map((c) => (c.id === id ? { ...c, summary: 'Edited.' } : c)) } } }));
    const refused = await newWritingStyleKind.undo!(p, again);
    expect(refused.ok).toBe(false);
  });

  it('makes a blend from existing styles', async () => {
    const p = proposal('newWritingStyle', { name: 'Mix', blend: [{ styleId: 'agatha-christie', name: 'Agatha Christie', weight: 'mostly' }, { styleId: 'custom-1', name: 'Ashen voice', weight: 'some' }] });
    await applied(newWritingStyleKind, p);
    const blend = customs().find((s) => s.name === 'Mix')!;
    expect(blend.priority).toContain('Agatha Christie');
    expect(blend.namesAuthors).toBe(true);
  });

  it('changes a custom style, and Undo puts the old one back', async () => {
    const p = proposal('writingStyle', { id: 'custom-1', changes: { traits: { sentences: 'Very short.' } }, before: mine() });
    const undo = await applied(writingStyleKind, p);
    expect(getStyle('custom-1')!.traits.sentences).toBe('Very short.');
    expect(getStyle('custom-1')!.traits.narration).toBe('Close third.');
    expect((await writingStyleKind.undo!(p, undo)).ok).toBe(true);
    expect(getStyle('custom-1')!.traits.sentences).toBe('Short.');
  });

  it('deletes a custom style, and Undo brings it back as a favorite', async () => {
    const p = proposal('deleteWritingStyle', { id: 'custom-1', before: mine() });
    const undo = await applied(deleteWritingStyleKind, p);
    expect(getStyle('custom-1')).toBeUndefined();
    expect(useSettings.getState().settings.writingStyles.favorites).not.toContain('custom-1');
    expect((await deleteWritingStyleKind.undo!(p, undo)).ok).toBe(true);
    expect(getStyle('custom-1')!.name).toBe('Ashen voice');
    expect(useSettings.getState().settings.writingStyles.favorites).toContain('custom-1');
    expect((await deleteWritingStyleKind.undo!(p, undo)).ok).toBe(false);
  });

  it('sets a default style for a scope, and Undo restores the old choice unless it changed', async () => {
    fake.choices = JSON.stringify({ project: { styleId: 'custom-1' } });
    const p = proposal('defaultStyle', { scope: { kind: 'project' }, place: 'the project', styleId: 'agatha-christie', styleName: 'Agatha Christie', before: 'custom-1' }, 'meta', 'writingStyles.choices');
    await applied(defaultStyleKind, p);
    expect(JSON.parse(fake.choices).project.styleId).toBe('agatha-christie');
    expect((await defaultStyleKind.undo!(p, undefined)).ok).toBe(true);
    expect(JSON.parse(fake.choices).project.styleId).toBe('custom-1');
    // The writer chose again since: Undo leaves it.
    expect((await defaultStyleKind.undo!(p, undefined)).ok).toBe(false);

    const scene = proposal('defaultStyle', { scope: { kind: 'scene', nodeId: 'n1' }, place: 'the scene', styleId: 'custom-1', styleName: 'Ashen voice', before: null }, 'node', 'n1');
    await applied(defaultStyleKind, scene);
    expect(JSON.parse(fake.choices).scenes.n1.prompt).toContain('Ashen voice');
    expect((await defaultStyleKind.undo!(scene, undefined)).ok).toBe(true);
    expect(JSON.parse(fake.choices).scenes.n1).toBeUndefined();
  });

  it('refuses a style that is no longer there', async () => {
    const p = proposal('defaultStyle', { scope: { kind: 'project' }, place: 'the project', styleId: 'custom-gone', styleName: 'Gone', before: null });
    const result = await defaultStyleKind.apply(p);
    expect(result.ok).toBe(false);
  });
});
