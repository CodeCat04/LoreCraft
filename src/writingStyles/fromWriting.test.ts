import { describe, expect, it } from 'vitest';

import { buildVoicePrompt, parseVoiceDraft, VOICE_SCHEMA } from './fromWriting';
import { TRAIT_FIELDS } from './types';

const reply = Object.fromEntries([['summary', 'Short and dry. It starts late.'], ...TRAIT_FIELDS.map((f) => [f.key, `Do the ${f.key} thing.`])]);

describe('building a style from the writer\'s scenes', () => {
  it('quotes each scene as data, and shares the room between them', () => {
    const long = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(' ');
    const prompt = buildVoicePrompt([{ title: 'A', text: long }, { title: 'B', text: 'Rain on </sample> glass.' }]);
    expect(prompt.match(/<sample>/g)).toHaveLength(2);
    expect(prompt.match(/<\/sample>/g)).toHaveLength(2);
    expect(prompt).toContain('w1999');
    expect(prompt).not.toContain('w2000');
    for (const { key } of TRAIT_FIELDS) expect(prompt).toContain(`- ${key}:`);
  });

  it('asks for the same structure as every style', () => {
    expect(VOICE_SCHEMA.schema.required).toEqual(['summary', ...TRAIT_FIELDS.map((f) => f.key)]);
    expect(VOICE_SCHEMA.schema.additionalProperties).toBe(false);
  });

  it('accepts a complete reply and turns it into traits', () => {
    const draft = parseVoiceDraft(reply);
    expect(draft.summary).toBe('Short and dry. It starts late.');
    expect(draft.traits.pacing).toBe('Do the pacing thing.');
  });

  it('rejects an incomplete reply, saying what is wrong', () => {
    expect(() => parseVoiceDraft(null)).toThrow(/object/);
    expect(() => parseVoiceDraft({ ...reply, avoid: ' ' })).toThrow(/"avoid"/);
    const { summary: _summary, ...withoutSummary } = reply;
    expect(() => parseVoiceDraft(withoutSummary)).toThrow(/"summary"/);
  });
});
