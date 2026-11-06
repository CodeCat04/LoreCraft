import { describe, expect, it } from 'vitest';

import { handleAll } from './ProposalsView';
import type { Proposal } from './api';

const proposal = (id: string) => ({ id }) as unknown as Proposal;

describe('handling every outside suggestion at once', () => {
  it('goes on past one that cannot be applied, and counts it', async () => {
    const seen: string[] = [];
    const outcome = await handleAll([proposal('a'), proposal('b'), proposal('c')], async (p) => {
      seen.push(p.id);
      if (p.id === 'b') return false;
      if (p.id === 'c') throw new Error('gone');
      return true;
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(outcome).toEqual({ done: 1, skipped: 2 });
  });
});
