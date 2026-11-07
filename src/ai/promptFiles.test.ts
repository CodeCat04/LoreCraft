import { describe, expect, it } from 'vitest';

import { planPromptImport, PromptFileError, promptFileName, promptFileText, readPromptFile, type PromptFileEntry } from './promptFiles';

const prompt = (name: string, extra: Partial<PromptFileEntry> = {}): PromptFileEntry => ({
  name,
  description: '',
  template: `Do ${name}.`,
  scope: 'selection',
  action: 'replace',
  ...extra,
});

describe('prompt files', () => {
  it('writes a versioned file that reads back the same', () => {
    const text = promptFileText([{ ...prompt('Tighten'), description: 'Shorter' }]);
    const parsed = JSON.parse(text);
    expect(parsed.lorecraft_prompts).toBe(1);
    expect(Object.keys(parsed.prompts[0]).sort()).toEqual(['action', 'description', 'name', 'scope', 'template']);
    expect(readPromptFile(text)).toEqual({ prompts: [{ ...prompt('Tighten'), description: 'Shorter' }], problems: [] });
  });

  it('leaves out only the prompts with a bad scope, action, name or text', () => {
    const file = JSON.stringify({
      lorecraft_prompts: 1,
      prompts: [
        prompt('Good'),
        { ...prompt('Bad scope'), scope: 'everything' },
        { ...prompt('Bad action'), action: 'delete' },
        { ...prompt(''), name: '  ' },
        { ...prompt('Empty'), template: ' ' },
        'not a prompt',
        { name: 'Chat default', template: 'Hi', scope: 'chat' },
      ],
    });
    const read = readPromptFile(file);
    expect(read.prompts.map((p) => p.name)).toEqual(['Good', 'Chat default']);
    expect(read.prompts[1].action).toBe('chat');
    expect(read.problems.map((p) => [p.index, p.message])).toEqual([
      [2, 'bad-scope'],
      [3, 'bad-action'],
      [4, 'no-name'],
      [5, 'no-text'],
      [6, 'not-a-prompt'],
    ]);
  });

  it('refuses what is not a prompt file, and a newer version', () => {
    expect(() => readPromptFile('nope')).toThrow(PromptFileError);
    expect(() => readPromptFile('{"format":"lorebook","version":1,"pages":[]}')).toThrow('not-prompts');
    expect(() => readPromptFile('{"lorecraft_prompts":2,"prompts":[]}')).toThrow('newer');
    // A byte-order mark from a Windows editor is fine.
    expect(readPromptFile('﻿{"lorecraft_prompts":1,"prompts":[]}').prompts).toEqual([]);
  });

  it('skips exact duplicates and renames name clashes', () => {
    const existing = [prompt('Tighten'), prompt('Expand'), prompt('Expand (2)', { template: 'Other' })];
    const plan = planPromptImport(
      [prompt('Tighten'), prompt('Expand', { template: 'Longer, please.' }), prompt('New one'), prompt('New one'), prompt('tighten', { scope: 'page' })],
      existing,
    );
    expect(plan.map((p) => [p.outcome, p.name])).toEqual([
      ['skip', 'Tighten'],
      ['rename', 'Expand (3)'],
      ['add', 'New one'],
      ['skip', 'New one'],
      ['rename', 'tighten (2)'],
    ]);
  });

  it('does not import again what an earlier import renamed', () => {
    const existing = [prompt('Expand', { template: 'Mine' }), prompt('Expand (2)', { template: 'Do Expand.' })];
    expect(planPromptImport([prompt('Expand')], existing).map((p) => p.outcome)).toEqual(['skip']);
  });

  it('makes a safe file name', () => {
    expect(promptFileName('Rewrite: “Darker” / tone?')).toBe('rewrite-darker-tone.prompts.json');
    expect(promptFileName('???')).toBe('prompt.prompts.json');
  });
});
