import type { GraphData, GraphPage, Relationship } from '../api';
import { buildGraph, graphCategories, graphTypes, matchNodes, neighborMap, type GraphFilter } from './graphData';
import { isFamilyKind, isSymmetric, kindSides, kindSuggestions, readRelationship } from './relationKinds';

function node(id: string, pageType = 'article', categories: string[] = []): GraphPage {
  return { id, title: id.toUpperCase(), pageType, status: 'draft', isHome: false, categories };
}

function rel(from: string, to: string, kind: string, inverse: string | null = null): Relationship {
  return {
    id: `${from}-${kind}-${to}`,
    fromPageId: from,
    fromTitle: from.toUpperCase(),
    toPageId: to,
    toTitle: to.toUpperCase(),
    kind,
    inverse,
    note: '',
    createdAt: '',
  };
}

const ALL: GraphFilter = { hiddenTypes: new Set(), category: '', center: null, hops: 0 };

// a - b - c - d, and e on its own. a and b are also family.
const data: GraphData = {
  nodes: [
    node('a', 'character', ['North']),
    node('b', 'character', ['North', 'Old']),
    node('c', 'place'),
    node('d', 'event', ['Old']),
    node('e', 'item'),
  ],
  links: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'a' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
  ],
  relationships: [rel('a', 'b', 'parent of'), rel('b', 'a', 'ally')],
};

const ids = (list: { id: string }[]) => list.map((item) => item.id);

describe('buildGraph', () => {
  it('draws one edge per pair of pages, whatever runs between them', () => {
    const { edges } = buildGraph(data, ALL);
    expect(edges).toHaveLength(3);
    const ab = edges[0];
    expect(ab.linked).toBe(true);
    expect(ab.relationships.map((r) => r.kind)).toEqual(['parent of', 'ally']);
    expect(edges[1].relationships).toEqual([]);
  });

  it('counts connections by page, not by link', () => {
    const { nodes } = buildGraph(data, ALL);
    expect(nodes.map((n) => [n.id, n.linkCount])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 2],
      ['d', 1],
      ['e', 0],
    ]);
  });

  it('filters by type and drops edges that lose an end, keeping counts from the whole project', () => {
    const view = buildGraph(data, { ...ALL, hiddenTypes: new Set(['place']) });
    expect(ids(view.nodes)).toEqual(['a', 'b', 'd', 'e']);
    expect(view.edges).toHaveLength(1);
    expect(view.nodes.find((n) => n.id === 'b')?.linkCount).toBe(2);
  });

  it('filters by category', () => {
    const view = buildGraph(data, { ...ALL, category: 'Old' });
    expect(ids(view.nodes)).toEqual(['b', 'd']);
    expect(view.edges).toHaveLength(0);
  });

  it('shows the neighborhood of a page, one or two hops out', () => {
    const one = buildGraph(data, { ...ALL, center: 'b', hops: 1 });
    expect(ids(one.nodes)).toEqual(['a', 'b', 'c']);
    expect(one.edges).toHaveLength(2);
    const two = buildGraph(data, { ...ALL, center: 'b', hops: 2 });
    expect(ids(two.nodes)).toEqual(['a', 'b', 'c', 'd']);
    expect(two.edges).toHaveLength(3);
  });

  it('keeps the center on screen even when a filter would hide it', () => {
    const view = buildGraph(data, { ...ALL, hiddenTypes: new Set(['character']), center: 'a', hops: 2 });
    expect(ids(view.nodes)).toEqual(['a']);
    expect(view.edges).toEqual([]);
  });

  it('does not walk through hidden pages', () => {
    const view = buildGraph(data, { ...ALL, hiddenTypes: new Set(['place']), center: 'b', hops: 2 });
    expect(ids(view.nodes)).toEqual(['a', 'b']);
  });

  it('shows everything around a center when no hop limit is set', () => {
    expect(buildGraph(data, { ...ALL, center: 'b' }).nodes).toHaveLength(5);
  });

  it('ignores edges with a missing end', () => {
    const broken: GraphData = {
      nodes: [node('a')],
      links: [{ from: 'a', to: 'gone' }, { from: 'a', to: 'a' }],
      relationships: [rel('gone', 'a', 'ally')],
    };
    const view = buildGraph(broken, ALL);
    expect(view.edges).toEqual([]);
    expect(view.nodes[0].linkCount).toBe(0);
  });

  it('handles 500 pages and thousands of edges quickly', () => {
    const nodes = Array.from({ length: 500 }, (_, i) => node(`n${i}`, i % 2 ? 'character' : 'place'));
    const links = Array.from({ length: 4000 }, (_, i) => ({
      from: `n${i % 500}`,
      to: `n${(i * 31 + 7) % 500}`,
    }));
    const started = performance.now();
    const view = buildGraph({ nodes, links, relationships: [] }, { ...ALL, center: 'n0', hops: 2 });
    expect(view.nodes.length).toBeGreaterThan(1);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('graph helpers', () => {
  it('finds neighbors in both directions', () => {
    const { edges } = buildGraph(data, ALL);
    const neighbors = neighborMap(edges);
    expect([...(neighbors.get('b') ?? [])].sort()).toEqual(['a', 'c']);
    expect(neighbors.get('e')).toBeUndefined();
  });

  it('lists types by size and categories by name', () => {
    expect(graphTypes(data)[0]).toEqual({ type: 'character', count: 2 });
    expect(graphCategories(data)).toEqual(['North', 'Old']);
  });

  it('matches titles and aliases, ignoring case', () => {
    const { nodes } = buildGraph(data, ALL);
    expect(matchNodes(nodes, 'b')).toEqual(['b']);
    expect(matchNodes(nodes, 'lady', (id) => (id === 'c' ? ['The Lady'] : []))).toEqual(['c']);
    expect(matchNodes(nodes, '   ')).toEqual([]);
  });
});

describe('readRelationship', () => {
  it('reads a directional kind from both ends', () => {
    const parent = rel('a', 'b', 'parent of', 'child of');
    expect(readRelationship(parent, 'a')).toMatchObject({ before: 'Parent of ', otherTitle: 'B' });
    expect(readRelationship(parent, 'b')).toMatchObject({ before: 'Child of ', otherTitle: 'A' });
  });

  it('reads a symmetric kind the same from both ends', () => {
    const ally = rel('a', 'b', 'Ally', 'ally');
    expect(isSymmetric(ally)).toBe(true);
    expect(isSymmetric(rel('a', 'b', 'parent of', 'child of'))).toBe(false);
    expect(isSymmetric(rel('a', 'b', 'vassal of'))).toBe(false);
    expect(readRelationship(ally, 'a')).toMatchObject({ before: 'Ally: ', otherTitle: 'B' });
    expect(readRelationship(ally, 'b')).toMatchObject({ before: 'Ally: ', otherTitle: 'A' });
  });

  it('is not fooled by kinds that JavaScript objects already have', () => {
    expect(readRelationship(rel('a', 'b', 'constructor'), 'b').after).toBe(' (constructor this page)');
  });

  it('reads a custom kind from its other end once it has an inverse', () => {
    const liege = rel('a', 'b', 'liege of', 'vassal of');
    expect(readRelationship(liege, 'b')).toMatchObject({ before: 'Vassal of ', otherTitle: 'A', after: '' });
  });

  it('does not invent an opposite for a kind it does not know', () => {
    const liege = rel('a', 'b', 'liege of');
    expect(readRelationship(liege, 'a')).toMatchObject({ before: 'Liege of ', otherTitle: 'B' });
    expect(readRelationship(liege, 'b')).toMatchObject({
      before: '',
      otherTitle: 'A',
      after: ' (liege of this page)',
    });
  });
});

describe('what a typed kind means', () => {
  const kinds = [
    { kind: 'parent of', inverse: 'child of', builtin: true },
    { kind: 'spouse', inverse: 'spouse', builtin: true },
    { kind: 'liege of', inverse: 'vassal of', builtin: false },
  ];

  it('knows a kind by either of its names, ignoring case and spaces', () => {
    expect(kindSides(kinds, 'parent of')).toEqual({ other: 'child of', builtin: true });
    expect(kindSides(kinds, '  Child   Of ')).toEqual({ other: 'parent of', builtin: true });
    expect(kindSides(kinds, 'vassal of')).toEqual({ other: 'liege of', builtin: false });
    expect(kindSides(kinds, 'spouse')).toEqual({ other: 'spouse', builtin: true });
  });

  it('does not claim to know anything else', () => {
    expect(kindSides(kinds, 'cousin')).toEqual({ other: null, builtin: false });
    expect(kindSides(kinds, 'constructor')).toEqual({ other: null, builtin: false });
  });

  it('suggests every name once', () => {
    expect(kindSuggestions(kinds)).toEqual(['parent of', 'child of', 'spouse', 'liege of', 'vassal of']);
  });

  it('knows which kinds also appear in infoboxes', () => {
    expect(['Parent of', 'child of', 'SPOUSE', 'ally'].map(isFamilyKind)).toEqual([true, true, true, false]);
  });
});
