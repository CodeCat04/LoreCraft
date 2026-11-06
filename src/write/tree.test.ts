import { describe, expect, it } from 'vitest';

import type { NodeKind, NodeMeta } from '../lib/types';
import {
  applyMove,
  canContain,
  chaptersUnder,
  indexTree,
  moveStep,
  neighborScene,
  nextTitle,
  planCardDrop,
  planDrop,
  planDropAtEnd,
  planNewChapter,
  planNewScene,
  restorableNodes,
  scenesUnder,
  unsentFields,
  visibleRows,
  zoneAt,
  type TreeIndex,
} from './tree';

function node(id: string, kind: NodeKind, parentId: string | null, position: number, wordCount = 0): NodeMeta {
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
    wordCount,
    targetWords: 0,
    storyDate: '',
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  };
}

/**
 * P1 > C1 > S1 S2
 *      C2 > S3
 * C3 > S4
 * P2 (empty)
 */
function sample(): NodeMeta[] {
  return [
    node('P1', 'part', null, 0),
    node('C3', 'chapter', null, 1),
    node('P2', 'part', null, 2),
    node('C1', 'chapter', 'P1', 0),
    node('C2', 'chapter', 'P1', 1),
    node('S1', 'scene', 'C1', 0, 100),
    node('S2', 'scene', 'C1', 1, 20),
    node('S3', 'scene', 'C2', 0, 3),
    node('S4', 'scene', 'C3', 0, 4000),
  ];
}

const NONE: ReadonlySet<string> = new Set();

function titles(index: TreeIndex, parent: string | null) {
  return (index.childrenOf.get(parent) ?? []).map((n) => n.id);
}

describe('indexTree', () => {
  it('sums words up the tree and lists scenes in reading order', () => {
    const index = indexTree(sample());
    expect(index.totals.get('C1')).toBe(120);
    expect(index.totals.get('P1')).toBe(123);
    expect(index.totals.get('P2')).toBe(0);
    expect(index.words).toBe(4123);
    expect(index.scenes.map((s) => s.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(index.chapters.map((s) => s.id)).toEqual(['C1', 'C2', 'C3']);
  });

  it('orders children by position whatever order the rows arrive in', () => {
    const index = indexTree([...sample()].reverse());
    expect(titles(index, null)).toEqual(['P1', 'C3', 'P2']);
    expect(titles(index, 'C1')).toEqual(['S1', 'S2']);
  });

  it('keeps a node whose parent is missing at the top level', () => {
    const index = indexTree([node('S9', 'scene', 'gone', 0, 5)]);
    expect(titles(index, null)).toEqual(['S9']);
    expect(index.words).toBe(5);
  });

  it('handles an empty book and a book of only parts', () => {
    expect(indexTree([]).words).toBe(0);
    const parts = indexTree([node('P', 'part', null, 0)]);
    expect(parts.scenes).toEqual([]);
    expect(visibleRows(parts, NONE).map((r) => r.id)).toEqual(['P']);
  });

  it('stays fast for a book of 300 scenes', () => {
    const rows: NodeMeta[] = [];
    for (let c = 0; c < 60; c += 1) {
      rows.push(node(`c${c}`, 'chapter', null, c));
      for (let s = 0; s < 5; s += 1) rows.push(node(`s${c}-${s}`, 'scene', `c${c}`, s, 1000));
    }
    const start = performance.now();
    for (let i = 0; i < 100; i += 1) visibleRows(indexTree(rows), NONE);
    const each = (performance.now() - start) / 100;
    expect(indexTree(rows).words).toBe(300_000);
    expect(each).toBeLessThan(5);
  });
});

describe('visibleRows', () => {
  it('hides the children of collapsed nodes and reports depth and place', () => {
    const index = indexTree(sample());
    const rows = visibleRows(index, new Set(['C1', 'C3']));
    expect(rows.map((r) => r.id)).toEqual(['P1', 'C1', 'C2', 'S3', 'C3', 'P2']);
    const c2 = rows.find((r) => r.id === 'C2')!;
    expect(c2).toMatchObject({ depth: 1, place: 2, siblings: 2, hasChildren: true, open: true, words: 3 });
    expect(rows.find((r) => r.id === 'C1')).toMatchObject({ open: false, hasChildren: true });
    expect(rows.find((r) => r.id === 'P2')).toMatchObject({ hasChildren: false, depth: 0 });
  });
});

describe('moving around', () => {
  it('finds neighboring scenes across chapters and parts', () => {
    const index = indexTree(sample());
    expect(neighborScene(index, 'S2', 1)?.id).toBe('S3');
    expect(neighborScene(index, 'S3', 1)?.id).toBe('S4');
    expect(neighborScene(index, 'S1', -1)).toBeUndefined();
    expect(neighborScene(index, 'S4', 1)).toBeUndefined();
    expect(neighborScene(index, 'missing', 1)).toBeUndefined();
  });

  it('collects scenes and chapters under any node', () => {
    const index = indexTree(sample());
    expect(scenesUnder(index, 'P1').map((s) => s.id)).toEqual(['S1', 'S2', 'S3']);
    expect(chaptersUnder(index, 'P1').map((s) => s.id)).toEqual(['C1', 'C2']);
    expect(chaptersUnder(index, 'S3').map((s) => s.id)).toEqual(['C2']);
    expect(chaptersUnder(index, null).length).toBe(3);
    expect(chaptersUnder(index, 'P2')).toEqual([]);
  });
});

describe('canContain', () => {
  it('matches the rules in check_placement', () => {
    expect(canContain(null, 'part')).toBe(true);
    expect(canContain('part', 'part')).toBe(false);
    expect(canContain(null, 'chapter')).toBe(true);
    expect(canContain('part', 'chapter')).toBe(true);
    expect(canContain('chapter', 'chapter')).toBe(false);
    expect(canContain('chapter', 'scene')).toBe(true);
    expect(canContain('part', 'scene')).toBe(false);
    expect(canContain(null, 'scene')).toBe(false);
    expect(canContain('scene', 'scene')).toBe(false);
  });
});

describe('zoneAt', () => {
  it('splits a row in three when it can hold the dragged item, otherwise in two', () => {
    expect(zoneAt(0.1, true)).toBe('before');
    expect(zoneAt(0.5, true)).toBe('inside');
    expect(zoneAt(0.9, true)).toBe('after');
    expect(zoneAt(0.3, false)).toBe('before');
    expect(zoneAt(0.7, false)).toBe('after');
  });
});

describe('planDrop', () => {
  const index = indexTree(sample());
  const moved = (plan: ReturnType<typeof planDrop>) => {
    expect(plan.kind).toBe('move');
    return plan.kind === 'move' ? { parent: plan.parentId, index: plan.index } : null;
  };

  it('reorders a scene among its siblings', () => {
    expect(moved(planDrop(index, NONE, 'S2', 'S1', 'before'))).toEqual({ parent: 'C1', index: 0 });
    expect(moved(planDrop(index, NONE, 'S1', 'S2', 'after'))).toEqual({ parent: 'C1', index: 1 });
  });

  it('says nothing changes when a node is dropped where it already is', () => {
    expect(planDrop(index, NONE, 'S2', 'S1', 'after').kind).toBe('none');
    expect(planDrop(index, NONE, 'S1', 'S2', 'before').kind).toBe('none');
    expect(planDrop(index, NONE, 'S1', 'S1', 'after').kind).toBe('none');
  });

  it('moves a scene into another chapter', () => {
    expect(moved(planDrop(index, NONE, 'S1', 'C2', 'inside'))).toEqual({ parent: 'C2', index: 1 });
    expect(moved(planDrop(index, NONE, 'S1', 'S3', 'before'))).toEqual({ parent: 'C2', index: 0 });
    // Below an open chapter's heading is the first place in it.
    expect(moved(planDrop(index, NONE, 'S1', 'C2', 'after'))).toEqual({ parent: 'C2', index: 0 });
    // Below a closed chapter, nothing is visible, so it joins the end.
    expect(moved(planDrop(index, new Set(['C2']), 'S1', 'C2', 'after'))).toEqual({ parent: 'C2', index: 1 });
    // Above a chapter is the end of the chapter before it.
    expect(moved(planDrop(index, NONE, 'S4', 'C2', 'before'))).toEqual({ parent: 'C1', index: 2 });
    expect(moved(planDrop(index, NONE, 'S1', 'C3', 'before'))).toEqual({ parent: 'C2', index: 1 });
  });

  it('refuses to put a scene outside a chapter', () => {
    expect(planDrop(index, NONE, 'S1', 'P1', 'before')).toMatchObject({ kind: 'refused' });
    expect(planDrop(index, NONE, 'S1', 'P2', 'after')).toMatchObject({ kind: 'refused' });
    // Nothing comes before the first chapter.
    expect(planDrop(index, NONE, 'S4', 'C1', 'before')).toMatchObject({ kind: 'refused' });
  });

  it('moves chapters among parts and the top level', () => {
    expect(moved(planDrop(index, NONE, 'C3', 'P2', 'inside'))).toEqual({ parent: 'P2', index: 0 });
    expect(moved(planDrop(index, NONE, 'C3', 'C2', 'after'))).toEqual({ parent: 'P1', index: 2 });
    expect(moved(planDrop(index, NONE, 'C3', 'C1', 'before'))).toEqual({ parent: 'P1', index: 0 });
    expect(moved(planDrop(index, NONE, 'C1', 'P1', 'before'))).toEqual({ parent: null, index: 0 });
    // Below an open part's heading is its first place.
    expect(moved(planDrop(index, NONE, 'C3', 'P1', 'after'))).toEqual({ parent: 'P1', index: 0 });
    // Below a closed part is the top level again.
    expect(moved(planDrop(index, new Set(['P1']), 'C1', 'P1', 'after'))).toEqual({ parent: null, index: 1 });
  });

  it('allows a chapter below the last scene of a chapter, and nowhere else among scenes', () => {
    expect(planDrop(index, NONE, 'C3', 'S1', 'after')).toMatchObject({ kind: 'refused' });
    expect(planDrop(index, NONE, 'C3', 'S1', 'before')).toMatchObject({ kind: 'refused' });
    expect(moved(planDrop(index, NONE, 'C3', 'S2', 'after'))).toEqual({ parent: 'P1', index: 1 });
  });

  it('keeps parts at the top level', () => {
    expect(moved(planDrop(index, NONE, 'P2', 'P1', 'before'))).toEqual({ parent: null, index: 0 });
    expect(moved(planDrop(index, NONE, 'P1', 'P2', 'after'))).toEqual({ parent: null, index: 2 });
    expect(moved(planDrop(index, NONE, 'P2', 'C3', 'before'))).toEqual({ parent: null, index: 1 });
    expect(planDrop(index, NONE, 'P2', 'C1', 'before')).toMatchObject({ kind: 'refused' });
    expect(planDrop(index, NONE, 'P2', 'S1', 'after')).toMatchObject({ kind: 'refused' });
  });

  it('refuses to move a node into its own subtree', () => {
    expect(planDrop(index, NONE, 'P1', 'S1', 'before')).toMatchObject({ kind: 'refused' });
    expect(planDrop(index, NONE, 'C1', 'S2', 'after')).toMatchObject({ kind: 'refused' });
  });

  it('draws the line after the whole of an open node', () => {
    const plan = planDrop(index, NONE, 'C3', 'C2', 'after');
    expect(plan).toMatchObject({ kind: 'move', marker: { rowId: 'S3', edge: 'bottom', depth: 1 } });
    const part = planDrop(index, NONE, 'P2', 'P1', 'after');
    expect(part).toMatchObject({ kind: 'move', marker: { rowId: 'S3', edge: 'bottom', depth: 0 } });
    const closed = planDrop(index, new Set(['C2']), 'C3', 'C2', 'after');
    expect(closed).toMatchObject({ marker: { rowId: 'C2', edge: 'bottom', depth: 1 } });
  });

  it('never plans a move the backend would refuse', () => {
    // Every pair of rows and every zone, checked against the placement rules.
    const all = sample();
    for (const dragged of all) {
      for (const over of all) {
        for (const zone of ['before', 'inside', 'after'] as const) {
          const plan = planDrop(index, NONE, dragged.id, over.id, zone);
          if (plan.kind !== 'move') continue;
          const parent = plan.parentId === null ? null : index.byId.get(plan.parentId)!.kind;
          expect(canContain(parent, dragged.kind), `${dragged.id} on ${over.id} ${zone}`).toBe(true);
          if (plan.parentId !== null) {
            expect(plan.parentId).not.toBe(dragged.id);
          }
          const size = (index.childrenOf.get(plan.parentId) ?? []).filter((n) => n.id !== dragged.id).length;
          expect(plan.index).toBeGreaterThanOrEqual(0);
          expect(plan.index).toBeLessThanOrEqual(size);
        }
      }
    }
  });
});

describe('planCardDrop', () => {
  const index = indexTree(sample());

  it('reorders within a chapter', () => {
    expect(planCardDrop(index, 'S2', 'C1', 'S1', 'before')).toMatchObject({ parentId: 'C1', index: 0, cardId: 'S1', side: 'before' });
    expect(planCardDrop(index, 'S1', 'C1', 'S2', 'after')).toMatchObject({ parentId: 'C1', index: 1, cardId: 'S2', side: 'after' });
  });

  it('says nothing changes when a card stays where it is', () => {
    expect(planCardDrop(index, 'S1', 'C1', 'S2', 'before')).toBeNull();
    expect(planCardDrop(index, 'S2', 'C1', 'S1', 'after')).toBeNull();
    expect(planCardDrop(index, 'S1', 'C1', 'S1', 'after')).toBeNull();
    // The end of its own chapter is where the last card already is.
    expect(planCardDrop(index, 'S2', 'C1', null, 'after')).toBeNull();
    expect(planCardDrop(index, 'missing', 'C1', 'S1', 'after')).toBeNull();
  });

  it('moves to another chapter, beside a card or at the end', () => {
    expect(planCardDrop(index, 'S1', 'C2', 'S3', 'before')).toMatchObject({ parentId: 'C2', index: 0 });
    expect(planCardDrop(index, 'S1', 'C2', 'S3', 'after')).toMatchObject({ parentId: 'C2', index: 1 });
    expect(planCardDrop(index, 'S1', 'C2', null, 'after')).toMatchObject({ parentId: 'C2', index: 1, cardId: 'S3' });
  });

  it('moves into an empty chapter', () => {
    const empty = indexTree([...sample(), node('C9', 'chapter', null, 9)]);
    expect(planCardDrop(empty, 'S1', 'C9', null, 'after')).toEqual({ parentId: 'C9', index: 0, cardId: null, side: 'after' });
  });
});

describe('restorableNodes', () => {
  const gone = (id: string, kind: NodeKind, parentId: string | null, deletedAt: string) => ({
    ...node(id, kind, parentId, 0),
    deletedAt,
  });

  it('lists what was deleted on its own and counts what went with it', () => {
    const trash = [
      gone('C', 'chapter', 'P', 't2'),
      gone('S1', 'scene', 'C', 't2'),
      gone('S2', 'scene', 'C', 't2'),
      // Deleted earlier on its own, so it has its own line.
      gone('S3', 'scene', 'C', 't1'),
    ];
    const out = restorableNodes(trash);
    expect(out.map((n) => [n.id, n.carried])).toEqual([
      ['C', 2],
      ['S3', 0],
    ]);
  });

  it('follows a whole deleted part down', () => {
    const trash = [gone('P', 'part', null, 't'), gone('C', 'chapter', 'P', 't'), gone('S', 'scene', 'C', 't')];
    expect(restorableNodes(trash).map((n) => [n.id, n.carried])).toEqual([['P', 2]]);
  });

  it('handles an empty trash', () => {
    expect(restorableNodes([])).toEqual([]);
  });
});

describe('unsentFields', () => {
  it('keeps what changed after the write went out, and what the write did not carry', () => {
    type Fields = { title?: string; status?: string };
    const left = (collected: Fields, sent: Fields) => unsentFields(collected, sent);
    expect(left({ title: 'x' }, { title: 'x' })).toEqual({});
    expect(left({ title: 'xy' }, { title: 'x' })).toEqual({ title: 'xy' });
    expect(left({ title: 'x', status: 'final' }, { title: 'x' })).toEqual({ status: 'final' });
    expect(left({}, { title: 'x' })).toEqual({});
  });
});

describe('planDropAtEnd', () => {
  const index = indexTree(sample());

  it('puts a scene at the end of the last chapter, and others at the top level', () => {
    expect(planDropAtEnd(index, NONE, 'S1')).toMatchObject({ kind: 'move', parentId: 'C3', index: 1 });
    expect(planDropAtEnd(index, NONE, 'C1')).toMatchObject({ kind: 'move', parentId: null, index: 3 });
    expect(planDropAtEnd(index, NONE, 'P2')).toMatchObject({ kind: 'none' });
  });

  it('refuses a scene when no chapter exists', () => {
    const parts = indexTree([node('P', 'part', null, 0), node('S', 'scene', 'gone', 0)]);
    expect(planDropAtEnd(parts, NONE, 'S')).toMatchObject({ kind: 'refused' });
  });
});

describe('moveStep', () => {
  const index = indexTree(sample());

  it('moves a scene within its chapter, then into the next or previous one', () => {
    expect(moveStep(index, 'S1', 1)).toEqual({ parentId: 'C1', index: 1 });
    expect(moveStep(index, 'S2', 1)).toEqual({ parentId: 'C2', index: 0 });
    expect(moveStep(index, 'S3', -1)).toEqual({ parentId: 'C1', index: 2 });
    expect(moveStep(index, 'S1', -1)).toBeNull();
    expect(moveStep(index, 'S4', 1)).toBeNull();
  });

  it('moves a chapter into and out of parts', () => {
    expect(moveStep(index, 'C2', -1)).toEqual({ parentId: 'P1', index: 0 });
    // Last in its part, it steps out to just after the part.
    expect(moveStep(index, 'C2', 1)).toEqual({ parentId: null, index: 1 });
    // First in its part, it steps out to just before the part.
    expect(moveStep(index, 'C1', -1)).toEqual({ parentId: null, index: 0 });
    // Next to a part at the top level, it steps in at the near end.
    expect(moveStep(index, 'C3', -1)).toEqual({ parentId: 'P1', index: 2 });
    expect(moveStep(index, 'C3', 1)).toEqual({ parentId: 'P2', index: 0 });
  });

  it('keeps parts at the top level', () => {
    expect(moveStep(index, 'P2', -1)).toEqual({ parentId: null, index: 1 });
    expect(moveStep(index, 'P1', -1)).toBeNull();
    expect(moveStep(index, 'P2', 1)).toBeNull();
  });
});

describe('applyMove', () => {
  it('moves a node between parents and renumbers both', () => {
    const next = indexTree(applyMove(sample(), 'S1', 'C2', 1));
    expect(titles(next, 'C1')).toEqual(['S2']);
    expect(titles(next, 'C2')).toEqual(['S3', 'S1']);
    expect(next.byId.get('S1')).toMatchObject({ parentId: 'C2', position: 1 });
    expect(next.byId.get('S2')!.position).toBe(0);
    expect(next.totals.get('C1')).toBe(20);
    expect(next.totals.get('C2')).toBe(103);
  });

  it('reorders within a parent', () => {
    const next = indexTree(applyMove(sample(), 'S2', 'C1', 0));
    expect(titles(next, 'C1')).toEqual(['S2', 'S1']);
  });

  it('agrees with planDrop', () => {
    const index = indexTree(sample());
    const plan = planDrop(index, NONE, 'S4', 'S2', 'before');
    if (plan.kind !== 'move') throw new Error('expected a move');
    const next = indexTree(applyMove(sample(), 'S4', plan.parentId, plan.index));
    expect(titles(next, 'C1')).toEqual(['S1', 'S4', 'S2']);
  });

  it('leaves the rows alone for an unknown node', () => {
    const rows = sample();
    expect(applyMove(rows, 'missing', null, 0)).toBe(rows);
  });
});

describe('new nodes', () => {
  const index = indexTree(sample());

  it('places a new scene after the current one, or at the end of the current chapter', () => {
    expect(planNewScene(index, 'S1')).toEqual({ chapterId: 'C1', afterId: 'S1' });
    expect(planNewScene(index, 'C2')).toEqual({ chapterId: 'C2' });
    expect(planNewScene(index, 'P1')).toEqual({ chapterId: 'C2' });
    expect(planNewScene(index, null)).toEqual({ chapterId: 'C3' });
  });

  it('asks for a chapter when a scene has nowhere to go', () => {
    expect(planNewScene(index, 'P2')).toEqual({ chapter: { parentId: 'P2' } });
    expect(planNewScene(indexTree([]), null)).toEqual({ chapter: { parentId: null, afterId: undefined } });
    const parts = indexTree([node('P', 'part', null, 0)]);
    expect(planNewScene(parts, null)).toEqual({ chapter: { parentId: 'P' } });
  });

  it('places a new chapter after the current one, in the selected part, or last', () => {
    expect(planNewChapter(index, 'S1')).toEqual({ parentId: 'P1', afterId: 'C1' });
    expect(planNewChapter(index, 'C3')).toEqual({ parentId: null, afterId: 'C3' });
    expect(planNewChapter(index, 'P2')).toEqual({ parentId: 'P2' });
    expect(planNewChapter(index, null)).toEqual({ parentId: 'P2' });
  });

  it('numbers new nodes by what the book already has', () => {
    expect(nextTitle(index, 'part', null)).toBe('Part 3');
    expect(nextTitle(index, 'chapter', 'P1')).toBe('Chapter 4');
    expect(nextTitle(index, 'scene', 'C1')).toBe('Scene 3');
    expect(nextTitle(index, 'scene', 'C2')).toBe('Scene 2');
  });
});
