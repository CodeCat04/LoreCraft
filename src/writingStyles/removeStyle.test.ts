/**
 * Deleting a style from My styles or Browse, against a fake native side that keeps the settings'
 * custom styles and the project's style choices.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ choices: '{}', answer: true, asked: [] as { title: string; message: string }[] }));

vi.mock('../shell/toasts', () => ({ toast: vi.fn() }));
vi.mock('../shell/dialogs', () => ({
  confirm: vi.fn(async (options: { title: string; message: string }) => {
    fake.asked.push(options);
    return fake.answer;
  }),
}));
vi.mock('../lib/rpc', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/rpc')>();
  return {
    ...real,
    rpc: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'project.getMeta') return params.key === 'writingStyles.choices' ? fake.choices : null;
      if (method === 'project.setMeta' && params.key === 'writingStyles.choices') fake.choices = params.value as string;
      return null;
    }),
  };
});

import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { deleteStyleAsking, isOwnStyle, removeProjectCopyAsking } from './removeStyle';
import { countStyleUses, getStyle } from './store';
import type { CustomStyle, StoredChoices } from './types';

const mine: CustomStyle = {
  id: 'custom-1',
  kind: 'custom',
  name: 'Ashen voice',
  genres: [],
  summary: 'Spare.',
  traits: { narration: '', sentences: 'Short.', diction: '', dialogue: '', description: '', pacing: '', signature: '', avoid: '' },
};

const copy = { styleId: 'custom-1', name: 'Ashen voice', prompt: 'Write short.' };
const choices = (): StoredChoices => JSON.parse(fake.choices) as StoredChoices;

beforeEach(() => {
  fake.choices = '{}';
  fake.answer = true;
  fake.asked = [];
  useProject.setState((s) => ({ status: { ...s.status, open: true } }));
  useSettings.setState((s) => ({ settings: { ...s.settings, writingStyles: { custom: [mine], favorites: ['custom-1'] } } }));
});

describe('deleting a style', () => {
  it('deletes a style no project here uses, and leaves the choices alone', async () => {
    fake.choices = JSON.stringify({ project: { styleId: 'hemingway' } });
    expect(await deleteStyleAsking(mine)).toBe(true);
    expect(getStyle('custom-1')).toBeUndefined();
    expect(useSettings.getState().settings.writingStyles.favorites).toEqual([]);
    expect(choices()).toEqual({ project: { styleId: 'hemingway' } });
    expect(fake.asked[0].message).toContain('leaves your styles');
  });

  it('says so when this project uses it, and stops using it everywhere here', async () => {
    fake.choices = JSON.stringify({
      project: copy,
      books: { b1: copy, b2: { styleId: 'hemingway' } },
      scenes: { s1: copy, s2: copy },
    });
    expect(await deleteStyleAsking(mine)).toBe(true);
    expect(fake.asked[0].message).toContain('This project uses it');
    expect(getStyle('custom-1')).toBeUndefined();
    expect(choices()).toEqual({ books: { b2: { styleId: 'hemingway' } }, scenes: {} });
  });

  it('changes nothing when the writer says no', async () => {
    fake.choices = JSON.stringify({ project: copy });
    fake.answer = false;
    expect(await deleteStyleAsking(mine)).toBe(false);
    expect(getStyle('custom-1')).toBeDefined();
    expect(choices().project).toEqual(copy);
  });
});

describe('removing a copy only the project has', () => {
  it('stops using it wherever it was chosen', async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, writingStyles: { custom: [], favorites: [] } } }));
    fake.choices = JSON.stringify({ books: { b1: copy }, scenes: { s1: copy } });
    expect(isOwnStyle('custom-1')).toBe(false);
    expect(await removeProjectCopyAsking({ id: 'custom-1', name: 'Ashen voice' })).toBe(true);
    expect(countStyleUses(choices(), 'custom-1')).toBe(0);
  });
});

describe('countStyleUses', () => {
  it('counts the project, each book and each scene', () => {
    expect(countStyleUses({ project: copy, books: { b1: copy }, scenes: { s1: copy, s2: { styleId: 'x' } } }, 'custom-1')).toBe(3);
    expect(countStyleUses({}, 'custom-1')).toBe(0);
  });
});
