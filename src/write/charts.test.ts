import { describe, expect, it } from 'vitest';

import type { BookPresence, Thread } from './api';
import { longestGap, presenceLevel, presenceRows, quietStretches, threadColor, threadRows } from './charts';
import { indexTree } from './tree';
import type { NodeKind, NodeMeta, TitleEntry } from '../lib/types';

function node(id: string, kind: NodeKind, parentId: string | null, position: number): NodeMeta {
  return {
    id,
    bookId: 'b',
    parentId,
    kind,
    title: id,
    position,
    status: 'draft',
    povPageId: null,
    locationPageId: null,
    synopsis: '',
    wordCount: 0,
    targetWords: 0,
    storyDate: '',
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  };
}

/** Six chapters with one scene each, and a seventh with none. */
function book() {
  const rows: NodeMeta[] = [];
  for (let c = 1; c <= 6; c += 1) {
    rows.push(node(`C${c}`, 'chapter', null, c));
    rows.push(node(`S${c}`, 'scene', `C${c}`, 0));
  }
  rows.push(node('C7', 'chapter', null, 7));
  return indexTree(rows);
}

function thread(id: string): Thread {
  return { id, name: id, color: 'accent', description: '', position: 0 };
}

function person(id: string, pageType = 'character'): TitleEntry {
  return { id, title: id, pageType, status: 'canon', summary: '', aliases: [] };
}

describe('quietStretches', () => {
  it('marks gaps after the first appearance, and the end, but not the time before', () => {
    const t = true;
    const f = false;
    expect(quietStretches([f, t, f, t, f], 1)).toEqual([f, f, t, f, t]);
    expect(quietStretches([f, f, f], 1)).toEqual([f, f, f]);
    expect(quietStretches([t, t], 1)).toEqual([f, f]);
  });

  it('leaves short gaps alone when asked for long ones', () => {
    const t = true;
    const f = false;
    expect(quietStretches([t, f, f, t, f, f, f, t], 3)).toEqual([f, f, f, f, t, t, t, f]);
    expect(quietStretches([t, f, f, f], 3)).toEqual([f, t, t, t]);
    expect(quietStretches([t, f, f], 3)).toEqual([f, f, f]);
  });
});

describe('longestGap', () => {
  it('measures from the first appearance on', () => {
    expect(longestGap([false, false, true, false, true, false, false])).toBe(2);
    expect(longestGap([true])).toBe(0);
    expect(longestGap([false, false])).toBe(0);
    expect(longestGap([])).toBe(0);
  });
});

describe('threadRows', () => {
  it('shows where a thread appears and where it goes quiet', () => {
    const links = [
      { nodeId: 'S2', threadId: 'A' },
      { nodeId: 'S4', threadId: 'A' },
      { nodeId: 'S1', threadId: 'B' },
    ];
    const [a, b, c] = threadRows([thread('A'), thread('B'), thread('C')], links, book());
    expect(a.cells.map((cell) => cell.sceneIds.length)).toEqual([0, 1, 0, 1, 0, 0, 0]);
    expect(a.cells.map((cell) => cell.quiet)).toEqual([false, false, true, false, true, true, true]);
    expect(a.appears).toBe(2);
    expect(b.cells[0].sceneIds).toEqual(['S1']);
    expect(c.appears).toBe(0);
    expect(c.cells.every((cell) => !cell.quiet)).toBe(true);
    expect(a.cells[6].scenes).toEqual([]);
  });

  it('copes with a book that has no chapters', () => {
    const [row] = threadRows([thread('A')], [], indexTree([]));
    expect(row.cells).toEqual([]);
  });
});

describe('presenceRows', () => {
  const presence: BookPresence = {
    mentions: [
      { nodeId: 'S2', pageId: 'late', count: 4 },
      { nodeId: 'S1', pageId: 'early', count: 2 },
      { nodeId: 'S5', pageId: 'early', count: 9 },
      { nodeId: 'gone', pageId: 'early', count: 99 },
      { nodeId: 'S1', pageId: 'place', count: 3 },
    ],
    cast: [{ nodeId: 'S3', pageId: 'late' }],
  };

  it('orders characters by first appearance and adds up each chapter', () => {
    const rows = presenceRows([person('late'), person('never'), person('early')], presence, book());
    expect(rows.map((r) => r.page.id)).toEqual(['early', 'late']);
    expect(rows[0].cells.map((c) => c.named)).toEqual([2, 0, 0, 0, 9, 0, 0]);
    expect(rows[1].cells.map((c) => c.cast)).toEqual([0, 0, 1, 0, 0, 0, 0]);
  });

  it('points out anyone away for several chapters', () => {
    const [early, late] = presenceRows([person('early'), person('late')], presence, book());
    // Chapters 2 to 4 are three away, and the last two are only two.
    expect(early.cells.map((c) => c.absent)).toEqual([false, true, true, true, false, false, false]);
    expect(early.longestAbsence).toBe(3);
    // In the cast counts as present, even when not named. Then gone for four.
    expect(late.cells.map((c) => c.absent)).toEqual([false, false, false, true, true, true, true]);
    expect(late.longestAbsence).toBe(4);
  });
});

describe('small helpers', () => {
  it('only ever uses theme tokens for thread colors', () => {
    expect(threadColor('success')).toBe('var(--success)');
    expect(threadColor('url(evil)')).toBe('var(--accent)');
  });

  it('puts counts into the legend steps', () => {
    expect([0, 1, 3, 8, 20].map(presenceLevel)).toEqual([0, 1, 2, 3, 4]);
  });
});
