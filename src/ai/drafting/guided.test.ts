import { describe, expect, it } from 'vitest';

import { versionPrompt } from '../companions/versions';
import { CONTINUE_ANGLES, continueVersions, guidedInstruction } from './guided';

describe('Guided Continue', () => {
  const base = 'Continue this scene from where it stops, in the same voice, tense and point of view.';

  it('is the Continue prompt unchanged when nothing is typed', () => {
    expect(guidedInstruction(base, '')).toBe(base);
    expect(guidedInstruction(base, '   \n ')).toBe(base);
  });

  it('adds the direction after the prompt, as one more part', () => {
    const instruction = guidedInstruction(base, ' she finds the letter; end on a cliffhanger ');
    expect(instruction.startsWith(`${base}\n\n`)).toBe(true);
    expect(instruction).toMatch(/she finds the letter; end on a cliffhanger$/);
  });

  it('writes one, two or three versions', () => {
    expect(continueVersions(1)).toBe(1);
    expect(continueVersions(2)).toBe(2);
    expect(continueVersions('3')).toBe(3);
    expect(continueVersions(7)).toBe(3);
    expect(continueVersions(0)).toBe(1);
    expect(continueVersions('none')).toBe(1);
  });

  it('gives each version of a continuation its own angle, not one for a rewrite', () => {
    const prompts = [0, 1, 2].map((i) => versionPrompt(i, undefined, 3, CONTINUE_ANGLES));
    prompts.forEach((prompt, i) => {
      expect(prompt).toMatch(new RegExp(`version ${i + 1} of 3`));
      expect(prompt).toContain(CONTINUE_ANGLES[i]);
      expect(prompt).not.toMatch(/closest to the original/);
    });
    expect(versionPrompt(0)).toMatch(/closest to the original/);
  });
});
