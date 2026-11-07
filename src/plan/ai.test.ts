import { describe, expect, it } from 'vitest';

import { planBlock, wikiLines } from './ai';
import { emptyPlan } from './plan';
import { structureById } from './templates';

const entry = (title: string, extra: Record<string, unknown> = {}) => ({
  id: title,
  title,
  pageType: 'character',
  status: 'canon' as const,
  summary: '',
  aliases: [],
  ...extra,
});

describe('what the wizard sends', () => {
  it('lists the wiki, without local-only pages for a cloud profile, or retconned ones', () => {
    const entries = [entry('Aria', { summary: 'A ranger.' }), entry('Secret', { localOnly: true }), entry('Gone', { status: 'retconned' })];
    expect(wikiLines(entries, false)).toBe('- Aria (character): A ranger.\n- Secret (character)');
    expect(wikiLines(entries, true)).toBe('- Aria (character): A ranger.');
  });

  it('includes only the earlier steps', () => {
    const plan = { ...emptyPlan(), braindump: 'Ideas', synopsis: 'Story', characters: [{ key: 'a', name: 'Aria', pageType: 'character', role: 'Ranger', description: '' }] };
    const forSynopsis = planBlock(plan, 'synopsis');
    expect(forSynopsis).toContain('Ideas');
    expect(forSynopsis).not.toContain('Story');
    expect(planBlock(plan, 'characters')).not.toContain('Aria');
    const forOutline = planBlock(plan, 'outline', structureById('mystery'));
    expect(forOutline).toContain('- Aria: Ranger');
    expect(forOutline).toContain('The crime (0%)');
  });
});
