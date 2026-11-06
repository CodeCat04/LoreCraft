import type { FamilyData, FamilyPerson } from '../api';
import { CARD_HEIGHT, CARD_WIDTH, layoutFamilies, layoutFamily, moveInFamily, splitFamilies } from './layout';

function person(title: string, missing = false): FamilyPerson {
  return { id: title, title, pageType: 'character', status: 'draft', born: null, died: null, missing };
}

/** `parents` as "parent>child", `spouses` as "a=b". Everyone they name exists. */
function family(ties: string[]): FamilyData {
  const names = new Set<string>();
  const data: FamilyData = { people: [], parents: [], spouses: [] };
  for (const tie of ties) {
    const [left, right] = tie.split(/[>=]/);
    names.add(left);
    names.add(right);
    if (tie.includes('>')) data.parents.push({ parent: left, child: right });
    else data.spouses.push({ a: left, b: right });
  }
  data.people = [...names].sort().map((name) => person(name));
  return data;
}

function generations(data: FamilyData): string[][] {
  return layoutFamily(data).rows.map((row) => [...row].sort());
}

function cardOf(placed: ReturnType<typeof layoutFamily>, id: string) {
  const card = placed.cards.find((c) => c.person.id === id);
  if (!card) throw new Error(`${id} is not placed`);
  return card;
}

function expectNoOverlaps(placed: ReturnType<typeof layoutFamily>) {
  for (const row of placed.rows) {
    const xs = row.map((id) => cardOf(placed, id).x);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(CARD_WIDTH);
    }
  }
}

describe('splitFamilies', () => {
  it('keeps people who are not connected apart', () => {
    const parts = splitFamilies(family(['A>B', 'C=D', 'B=E']));
    expect(parts.map((part) => part.people.map((p) => p.id).sort()).sort()).toEqual([
      ['A', 'B', 'E'],
      ['C', 'D'],
    ]);
  });

  it('ignores ties to people it was not given', () => {
    const data = family(['A>B']);
    data.parents.push({ parent: 'A', child: 'Nobody' }, { parent: 'B', child: 'B' });
    data.spouses.push({ a: 'Nobody', b: 'A' });
    const [only] = splitFamilies(data);
    expect(only.parents).toEqual([{ parent: 'A', child: 'B' }]);
    expect(only.spouses).toEqual([]);
  });
});

describe('layoutFamily', () => {
  it('puts each generation below the last', () => {
    expect(generations(family(['A>B', 'B>C', 'C>D']))).toEqual([['A'], ['B'], ['C'], ['D']]);
  });

  it('places a parent above a child and a child under a single parent', () => {
    const placed = layoutFamily(family(['A>B']));
    const [a, b] = [cardOf(placed, 'A'), cardOf(placed, 'B')];
    expect(b.y).toBeGreaterThanOrEqual(a.y + CARD_HEIGHT);
    expect(b.x).toBeCloseTo(a.x, 3);
  });

  it('centers children under a couple', () => {
    const placed = layoutFamily(family(['A=B', 'A>C', 'B>C']));
    const [a, b, c] = [cardOf(placed, 'A'), cardOf(placed, 'B'), cardOf(placed, 'C')];
    expect(a.y).toBe(b.y);
    expect(c.x).toBeCloseTo((a.x + b.x) / 2, 3);
    // The line starts on the one joining them, rather than at each parent.
    expect(placed.parentLines.match(/M/g)).toHaveLength(2);
  });

  it('keeps someone who married in beside their spouse, with their parents above', () => {
    const rows = generations(family(['G>A', 'A=B', 'A>C', 'B>C']));
    expect(rows).toEqual([['G'], ['A', 'B'], ['C']]);
  });

  it('brings parents of someone who married in down to just above them', () => {
    // K's line is long, and M's parent P has no parents of their own.
    const rows = generations(family(['R>S', 'S>K', 'K=M', 'P>M']));
    expect(rows).toEqual([['R'], ['P', 'S'], ['K', 'M']]);
  });

  it('handles several spouses, with one person between two of them', () => {
    const placed = layoutFamily(family(['X=A', 'X=B', 'X>C', 'A>C', 'X>D', 'B>D']));
    expect(placed.rows[0]).toHaveLength(3);
    expect(placed.rows[0][1]).toBe('X');
    expectNoOverlaps(placed);
    // Each marriage's child is under that marriage.
    const [a, x, b] = placed.rows[0].map((id) => cardOf(placed, id));
    const left = cardOf(placed, a.person.id === 'A' ? 'C' : 'D');
    const right = cardOf(placed, a.person.id === 'A' ? 'D' : 'C');
    expect(left.x).toBeLessThan(right.x);
    expect(left.x).toBeLessThan(x.x);
    expect(right.x).toBeGreaterThan(x.x);
    expect(b.x).toBeGreaterThan(x.x);
  });

  it('reaches over whoever stands between a person and a third spouse', () => {
    const placed = layoutFamily(family(['X=A', 'X=B', 'X=C']));
    expect(placed.rows[0]).toHaveLength(4);
    // Three lines, one of which goes up and over.
    expect(placed.spouseLines.match(/M/g)).toHaveLength(3);
    expect(placed.spouseLines).toMatch(/V[\d.]+H[\d.]+V/);
  });

  it('shows someone with one known parent, and someone with none at the top', () => {
    const rows = generations(family(['A>B', 'C>D', 'A=C', 'B=E']));
    expect(rows).toEqual([['A', 'C'], ['B', 'D', 'E']]);
  });

  it('shows two parents who never married, and joins them to the child', () => {
    const placed = layoutFamily(family(['A>C', 'B>C']));
    expect(placed.rows[0].sort()).toEqual(['A', 'B']);
    expect(placed.spouseLines).toBe('');
    expect(placed.parentLines.match(/M/g)).toHaveLength(4);
    expect(placed.loops).toEqual([]);
  });

  it('breaks a cycle at one tie, and says which', () => {
    const placed = layoutFamily(family(['A>B', 'B>C', 'C>A']));
    expect(placed.cards).toHaveLength(3);
    expect(placed.rows.flat().sort()).toEqual(['A', 'B', 'C']);
    expect(placed.loops).toHaveLength(1);
    const [loop] = placed.loops;
    expect(placed.parentsOf.get(loop.child.id) ?? []).not.toContain(loop.parent.id);
    // What remains still runs downhill.
    for (const [child, parents] of placed.parentsOf) {
      for (const parent of parents) {
        expect(cardOf(placed, parent).generation).toBeLessThan(cardOf(placed, child).generation);
      }
    }
  });

  it('does not hang on two people each listed as the parent of the other', () => {
    const placed = layoutFamily(family(['A>B', 'B>A']));
    expect(placed.rows.flat().sort()).toEqual(['A', 'B']);
    expect(placed.loops).toHaveLength(1);
  });

  it('keeps a parent who is also a spouse side by side, and reports the tie', () => {
    const placed = layoutFamily(family(['J>O', 'J=O', 'J>A', 'O>A']));
    expect(generations(family(['J>O', 'J=O', 'J>A', 'O>A']))).toEqual([['J', 'O'], ['A']]);
    expect(placed.loops.map((loop) => `${loop.parent.id}>${loop.child.id}`)).toEqual(['J>O']);
  });

  it('does not hang on a cycle among spouses', () => {
    const placed = layoutFamily(family(['A=B', 'B=C', 'C=A']));
    expect(placed.rows).toHaveLength(1);
    expect(placed.rows[0].sort()).toEqual(['A', 'B', 'C']);
  });

  it('keeps cards from overlapping in a wide, tangled family', () => {
    const ties: string[] = [];
    for (let i = 0; i < 6; i++) {
      ties.push(`G${i}=H${i}`);
      for (let k = 0; k < 4; k++) ties.push(`G${i}>C${i}${k}`, `H${i}>C${i}${k}`);
      ties.push(`C${i}0=C${(i + 1) % 6}1`);
    }
    const placed = layoutFamily(family(ties));
    expect(placed.rows).toHaveLength(2);
    expectNoOverlaps(placed);
    for (const card of placed.cards) {
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.x + CARD_WIDTH).toBeLessThanOrEqual(placed.width + 0.01);
    }
  });

  it('gives the same result for the same data', () => {
    const data = family(['G>A', 'A=B', 'A>C', 'B>C', 'B>D', 'P>B']);
    expect(JSON.stringify(layoutFamily(data).cards)).toBe(JSON.stringify(layoutFamily(data).cards));
  });

  it('stays quick on a very large family and on a very deep one', () => {
    const wide: string[] = [];
    let id = 0;
    const queue = ['P0'];
    while (id < 5000) {
      const parent = queue.shift() as string;
      wide.push(`${parent}=S${parent}`);
      for (let k = 0; k < 3; k++) {
        id++;
        wide.push(`${parent}>P${id}`, `S${parent}>P${id}`);
        queue.push(`P${id}`);
      }
    }
    const started = performance.now();
    const placed = layoutFamily(family(wide));
    expect(placed.cards.length).toBeGreaterThan(5000);
    expect(performance.now() - started).toBeLessThan(5000);

    const deep = Array.from({ length: 20000 }, (_, i) => `D${i}>D${i + 1}`);
    deep.push('D20000>D0');
    const deepStarted = performance.now();
    const long = layoutFamily(family(deep));
    expect(long.rows.length).toBeGreaterThan(1000);
    expect(long.loops).toHaveLength(1);
    expect(performance.now() - deepStarted).toBeLessThan(5000);
  });
});

describe('layoutFamilies', () => {
  it('lists the biggest family first', () => {
    const families = layoutFamilies(family(['X=Y', 'A>B', 'B>C']));
    expect(families.map((f) => f.label)).toEqual(['A', 'X']);
  });

  it('calls a family after someone with a page', () => {
    const data = family(['Ghost>Child']);
    data.people = [person('Ghost', true), person('Child')];
    expect(layoutFamilies(data)[0].label).toBe('Child');
  });

  it('has nothing to draw when nobody is related', () => {
    expect(layoutFamilies({ people: [], parents: [], spouses: [] })).toEqual([]);
  });
});

describe('moveInFamily', () => {
  const placed = layoutFamily(family(['A=B', 'A>C', 'B>C', 'A>D', 'B>D', 'C=E', 'C>F', 'E>F']));

  it('moves along a row, and stops at its ends', () => {
    const [first, second] = placed.rows[0];
    expect(moveInFamily(placed, first, 'ArrowRight')).toBe(second);
    expect(moveInFamily(placed, second, 'ArrowLeft')).toBe(first);
    expect(moveInFamily(placed, first, 'ArrowLeft')).toBeNull();
    expect(moveInFamily(placed, second, 'ArrowRight')).toBeNull();
    expect(moveInFamily(placed, second, 'Home')).toBe(first);
    expect(moveInFamily(placed, first, 'End')).toBe(second);
  });

  it('goes to a parent above and a child below', () => {
    expect(['A', 'B']).toContain(moveInFamily(placed, 'C', 'ArrowUp'));
    expect(moveInFamily(placed, 'C', 'ArrowDown')).toBe('F');
    expect(['C', 'D']).toContain(moveInFamily(placed, 'A', 'ArrowDown'));
  });

  it('goes to the nearest card when there is no such relative', () => {
    // E married in, so has no parents here, but there is still a row above.
    expect(['A', 'B']).toContain(moveInFamily(placed, 'E', 'ArrowUp'));
    // D has no children here, but there is still a row below.
    expect(moveInFamily(placed, 'D', 'ArrowDown')).toBe('F');
  });

  it('stops at the top and the bottom', () => {
    expect(moveInFamily(placed, 'A', 'ArrowUp')).toBeNull();
    expect(moveInFamily(placed, 'F', 'ArrowDown')).toBeNull();
  });

  it('says nothing about someone not in the family', () => {
    expect(moveInFamily(placed, 'Nobody', 'ArrowUp')).toBeNull();
  });
});
