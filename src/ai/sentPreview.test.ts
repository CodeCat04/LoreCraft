import { describe, expect, it } from 'vitest';

import { sentParts } from './SentPreview';

describe('what an in-document request sends', () => {
  it('lists the instructions, each named block and the request, in order', () => {
    const parts = sentParts('Rewrite as asked.', [
      { type: 'text', text: 'Mira is a pilot.', hidden: true, label: 'Mira' },
      { type: 'text', text: 'Make it shorter.' },
    ]);
    expect(parts.map((part) => part.label)).toEqual(['Instructions for the model', 'Mira', 'Your request']);
    expect(parts[1].text).toBe('Mira is a pilot.');
    expect(parts.every((part) => part.tokens > 0)).toBe(true);
  });
});
