import { describe, expect, it } from 'vitest';

import type { PmNode } from '../lib/types';
import { bodyFromIdea, titleFromIdea } from './ideaToPage';

describe('titleFromIdea', () => {
  it('takes the first line', () => {
    expect(titleFromIdea('  The salt market\nIt moves at night.')).toBe('The salt market');
  });

  it('drops what ends a sentence', () => {
    expect(titleFromIdea('A guild of smugglers.')).toBe('A guild of smugglers');
    expect(titleFromIdea('What if Bram lied?')).toBe('What if Bram lied');
    expect(titleFromIdea('Keep the trail going…')).toBe('Keep the trail going');
  });

  it('cuts long lines at a word', () => {
    const line = `${'word '.repeat(30)}end`;
    const title = titleFromIdea(line);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('word')).toBe(true);
    expect(titleFromIdea('x'.repeat(100))).toHaveLength(80);
  });
});

describe('bodyFromIdea', () => {
  const template: PmNode = {
    type: 'doc',
    content: [
      { type: 'paragraph' },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'History' }] },
      { type: 'paragraph' },
    ],
  };

  it('puts the idea where the lead paragraph was', () => {
    const body = bodyFromIdea(template, 'The salt market\n\nIt moves at night.', 'The salt market');
    expect(body.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'The salt market' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'It moves at night.' }] },
      template.content![1],
      template.content![2],
    ]);
  });

  it('leaves the template alone when the idea is only the title', () => {
    expect(bodyFromIdea(template, 'The salt market.', 'The salt market')).toBe(template);
  });

  it('keeps everything when the page has no empty lead', () => {
    const blank: PmNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kept' }] }] };
    const body = bodyFromIdea(blank, 'New text', 'Title');
    expect(body.content).toHaveLength(2);
    expect(body.content![1]).toEqual(blank.content![0]);
  });
});
