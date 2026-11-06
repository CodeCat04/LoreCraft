/**
 * Lays families out in generations, top to bottom. Pure, and it cannot hang on bad data:
 * someone listed as their own grandparent is broken at one tie, which is reported
 * rather than drawn. All lengths are in rem.
 */

import type { FamilyData, FamilyPerson } from '../api';

export const CARD_WIDTH = 11;
export const CARD_HEIGHT = 3.5;
/** Between spouses, wide enough to show the line joining them. */
const SPOUSE_GAP = 1.5;
/**
 * Between couples or single people in a row. The same as between spouses, so that two
 * half-siblings fit square under the two marriages they come from.
 */
const GROUP_GAP = SPOUSE_GAP;
const ROW_GAP = 3.5;
/** Room above the first row for a line joining spouses who are not side by side. */
const TOP_PAD = 1;
/** Lines running along a gap between rows spread out, so they stay apart. */
const MAX_LANES = 5;
const LANE_STEP = 0.4;

const ORDER_SWEEPS = 4;
const PLACE_SWEEPS = 6;
/** A group with nothing above or below it gives way to one that has. */
const WEIGHT_FREE = 0.001;

export interface PlacedCard {
  person: FamilyPerson;
  generation: number;
  x: number;
  y: number;
}

export interface FamilyLoop {
  parent: FamilyPerson;
  child: FamilyPerson;
}

export interface PlacedFamily {
  /** Stable while the same people stay at the top. */
  key: string;
  /** Who the family goes by: the first person with a page, from the top. */
  label: string;
  /** In reading order: generation by generation, left to right. */
  cards: PlacedCard[];
  /** Person ids by generation, left to right. */
  rows: string[][];
  width: number;
  height: number;
  /** SVG path data, in the same units as the cards. */
  parentLines: string;
  spouseLines: string;
  /** Ties left out of the drawing because they would make a loop. */
  loops: FamilyLoop[];
  parentsOf: Map<string, string[]>;
  childrenOf: Map<string, string[]>;
  spousesOf: Map<string, string[]>;
}

class Sets {
  private parent = new Map<string, string>();

  add(id: string) {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    let node = id;
    while (node !== root) {
      const next = this.parent.get(node) as string;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  join(a: string, b: string) {
    this.parent.set(this.find(a), this.find(b));
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Cuts the data into groups of people who are connected to each other. */
export function splitFamilies(data: FamilyData): FamilyData[] {
  const sets = new Sets();
  const known = new Set(data.people.map((person) => person.id));
  for (const id of known) sets.add(id);
  const parents = data.parents.filter((e) => known.has(e.parent) && known.has(e.child) && e.parent !== e.child);
  const spouses = data.spouses.filter((e) => known.has(e.a) && known.has(e.b) && e.a !== e.b);
  for (const edge of parents) sets.join(edge.parent, edge.child);
  for (const edge of spouses) sets.join(edge.a, edge.b);

  const families = new Map<string, FamilyData>();
  const family = (id: string) => {
    const root = sets.find(id);
    let found = families.get(root);
    if (!found) {
      found = { people: [], parents: [], spouses: [] };
      families.set(root, found);
    }
    return found;
  };
  for (const person of data.people) family(person.id).people.push(person);
  for (const edge of parents) family(edge.parent).parents.push(edge);
  for (const edge of spouses) family(edge.a).spouses.push(edge);
  return [...families.values()];
}

/** Puts the person with the most spouses in the middle, and the others out to each side. */
function orderSpouses(
  members: string[],
  spousesOf: Map<string, string[]>,
  titleOf: (id: string) => string,
): string[] {
  const byTitle = [...members].sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
  if (byTitle.length <= 2) return byTitle;
  const degree = (id: string) => spousesOf.get(id)?.length ?? 0;
  const center = byTitle.reduce((best, id) => (degree(id) > degree(best) ? id : best));
  const left: string[] = [];
  const right: string[] = [];
  const seen = new Set([center]);
  const queue: { id: string; toLeft: boolean }[] = [];
  let toLeft = true;
  for (const id of spousesOf.get(center) ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push({ id, toLeft });
    toLeft = !toLeft;
  }
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    (item.toLeft ? left : right).push(item.id);
    for (const id of spousesOf.get(item.id) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push({ id, toLeft: item.toLeft });
    }
  }
  return [...left.reverse(), center, ...right];
}

interface Group {
  members: string[];
  width: number;
  generation: number;
  x: number;
  /** First reached walking down from the top, which keeps brothers and sisters together. */
  visit: number;
}

/** From the left of a group to the middle of its nth card. */
function offsetInGroup(index: number): number {
  return index * (CARD_WIDTH + SPOUSE_GAP) + CARD_WIDTH / 2;
}

/**
 * Places a row in the given order as close to where each group wants to be as the gaps
 * allow, by pooling groups that would overlap (isotonic regression). Linear time.
 */
function placeRow(row: Group[], wanted: Map<Group, { left: number; weight: number }>) {
  const blocks: { sum: number; weight: number; count: number }[] = [];
  const shifts: number[] = [];
  let shift = 0;
  for (const group of row) {
    const want = wanted.get(group) ?? { left: group.x, weight: WEIGHT_FREE };
    shifts.push(shift);
    let block = { sum: (want.left - shift) * want.weight, weight: want.weight, count: 1 };
    while (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      if (last.sum / last.weight < block.sum / block.weight) break;
      block = { sum: block.sum + last.sum, weight: block.weight + last.weight, count: block.count + last.count };
      blocks.pop();
    }
    blocks.push(block);
    shift += group.width + GROUP_GAP;
  }
  let index = 0;
  for (const block of blocks) {
    const left = block.sum / block.weight;
    for (let i = 0; i < block.count; i++, index++) row[index].x = left + shifts[index];
  }
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Lays out one connected family. */
export function layoutFamily(data: FamilyData): PlacedFamily {
  const personById = new Map(data.people.map((person) => [person.id, person]));
  const titleOf = (id: string) => personById.get(id)?.title ?? '';

  const spousesOf = new Map<string, string[]>();
  const spouseSets = new Sets();
  for (const person of data.people) spouseSets.add(person.id);
  for (const { a, b } of data.spouses) {
    spouseSets.join(a, b);
    push(spousesOf, a, b);
    push(spousesOf, b, a);
  }

  // ---- Groups: spouses share a row, whatever else is true of them.
  const membersByRoot = new Map<string, string[]>();
  const sortedPeople = [...data.people].sort((a, b) => a.title.localeCompare(b.title));
  for (const person of sortedPeople) push(membersByRoot, spouseSets.find(person.id), person.id);
  const groups: Group[] = [...membersByRoot.values()].map((members) => {
    const ordered = orderSpouses(members, spousesOf, titleOf);
    return {
      members: ordered,
      width: ordered.length * CARD_WIDTH + (ordered.length - 1) * SPOUSE_GAP,
      generation: 0,
      x: 0,
      visit: -1,
    };
  });
  const groupOf = new Map<string, Group>();
  const indexInGroup = new Map<string, number>();
  groups.forEach((group) => {
    group.members.forEach((id, index) => {
      groupOf.set(id, group);
      indexInGroup.set(id, index);
    });
  });
  const groupIndex = new Map(groups.map((group, index) => [group, index]));

  // ---- The ties that decide generations.
  const loops: FamilyLoop[] = [];
  const childGroups: number[][] = groups.map(() => []);
  const parentGroupCount = new Int32Array(groups.length);
  const tied = new Set<string>();
  const tieKey = (from: number, to: number) => `${from}>${to}`;
  for (const { parent, child } of data.parents) {
    const from = groupIndex.get(groupOf.get(parent) as Group) as number;
    const to = groupIndex.get(groupOf.get(child) as Group) as number;
    if (from === to) continue;
    const key = tieKey(from, to);
    if (tied.has(key)) continue;
    tied.add(key);
    childGroups[from].push(to);
    parentGroupCount[to]++;
  }

  // Walks down from the top, oldest first. A step back onto the path being walked is a loop.
  const broken = new Set<string>();
  const state = new Uint8Array(groups.length);
  const finished: number[] = [];
  let visits = 0;
  const walk = (start: number) => {
    if (state[start] !== 0) return;
    state[start] = 1;
    groups[start].visit = visits++;
    const stack: [number, number][] = [[start, 0]];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const kids = childGroups[top[0]];
      if (top[1] < kids.length) {
        const next = kids[top[1]++];
        if (state[next] === 1) {
          broken.add(tieKey(top[0], next));
        } else if (state[next] === 0) {
          state[next] = 1;
          groups[next].visit = visits++;
          stack.push([next, 0]);
        }
      } else {
        state[top[0]] = 2;
        finished.push(top[0]);
        stack.pop();
      }
    }
  };
  groups.forEach((_, index) => {
    if (parentGroupCount[index] === 0) walk(index);
  });
  groups.forEach((_, index) => walk(index));

  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  for (const { parent, child } of data.parents) {
    const from = groupIndex.get(groupOf.get(parent) as Group) as number;
    const to = groupIndex.get(groupOf.get(child) as Group) as number;
    if (from === to || broken.has(tieKey(from, to))) {
      loops.push({ parent: personById.get(parent) as FamilyPerson, child: personById.get(child) as FamilyPerson });
      continue;
    }
    push(parentsOf, child, parent);
    push(childrenOf, parent, child);
  }

  // ---- Generations: as far down as their parents require. `finished` lists children
  // before parents, so going backwards everyone's parents are already settled.
  const usedChildren: number[][] = childGroups.map((kids, from) => kids.filter((to) => !broken.has(tieKey(from, to))));
  const hasParents = new Uint8Array(groups.length);
  for (let i = finished.length - 1; i >= 0; i--) {
    const from = finished[i];
    for (const to of usedChildren[from]) {
      hasParents[to] = 1;
      groups[to].generation = Math.max(groups[to].generation, groups[from].generation + 1);
    }
  }
  // Someone whose own parents are unknown sits just above their children, rather than up
  // at the top of the tree. Going forwards, children are settled before their parents.
  for (const from of finished) {
    if (hasParents[from] || usedChildren[from].length === 0) continue;
    groups[from].generation = Math.min(...usedChildren[from].map((to) => groups[to].generation)) - 1;
  }
  const topGeneration = Math.min(...groups.map((group) => group.generation));
  for (const group of groups) group.generation -= topGeneration;

  const rowCount = Math.max(...groups.map((group) => group.generation)) + 1;
  const rows: Group[][] = Array.from({ length: rowCount }, () => []);
  for (const group of [...groups].sort((a, b) => a.visit - b.visit)) rows[group.generation].push(group);

  for (const row of rows) {
    let x = 0;
    for (const group of row) {
      group.x = x;
      x += group.width + GROUP_GAP;
    }
  }

  // ---- Where each group wants to be: under its parents, or over its children.
  const centerOf = (id: string) => {
    const group = groupOf.get(id) as Group;
    return group.x + offsetInGroup(indexInGroup.get(id) as number);
  };
  const wantedFrom = (row: Group[], relatives: Map<string, string[]>) => {
    const wanted = new Map<Group, { left: number; weight: number }>();
    for (const group of row) {
      let sum = 0;
      let weight = 0;
      group.members.forEach((id, index) => {
        for (const relative of relatives.get(id) ?? []) {
          sum += centerOf(relative) - offsetInGroup(index);
          weight++;
        }
      });
      if (weight > 0) wanted.set(group, { left: sum / weight, weight });
    }
    return wanted;
  };
  const sweep = (down: boolean, reorder: boolean) => {
    const relatives = down ? parentsOf : childrenOf;
    const order = rows.map((_, index) => (down ? index : rows.length - 1 - index));
    for (const index of order) {
      const row = rows[index];
      const wanted = wantedFrom(row, relatives);
      if (reorder) {
        const place = (group: Group) => wanted.get(group)?.left ?? group.x;
        row.sort((a, b) => place(a) + a.width / 2 - (place(b) + b.width / 2));
      }
      placeRow(row, wanted);
    }
  };
  for (let i = 0; i < ORDER_SWEEPS; i++) sweep(i % 2 === 0, true);
  // Ends going down, so children are the last to move and sit square under their parents.
  for (let i = 0; i < PLACE_SWEEPS; i++) sweep(i % 2 === 1, false);

  const left = Math.min(...groups.map((group) => group.x));
  for (const group of groups) group.x -= left;
  const width = Math.max(...groups.map((group) => group.x + group.width));

  const yOf = (generation: number) => TOP_PAD + generation * (CARD_HEIGHT + ROW_GAP);
  const height = yOf(rowCount - 1) + CARD_HEIGHT;

  // ---- Cards
  const cards: PlacedCard[] = [];
  const rowIds: string[][] = [];
  rows.forEach((row, generation) => {
    const ids: string[] = [];
    for (const group of row) {
      group.members.forEach((id, index) => {
        ids.push(id);
        cards.push({
          person: personById.get(id) as FamilyPerson,
          generation,
          x: round(group.x + index * (CARD_WIDTH + SPOUSE_GAP)),
          y: yOf(generation),
        });
      });
    }
    rowIds.push(ids);
  });

  // ---- Lines joining spouses
  const spousePaths: string[] = [];
  for (const { a, b } of data.spouses) {
    const group = groupOf.get(a) as Group;
    const y = yOf(group.generation);
    const [first, second] = [a, b].sort((p, q) => (indexInGroup.get(p) as number) - (indexInGroup.get(q) as number));
    const from = indexInGroup.get(first) as number;
    const to = indexInGroup.get(second) as number;
    if (to === from + 1) {
      const start = group.x + from * (CARD_WIDTH + SPOUSE_GAP) + CARD_WIDTH;
      spousePaths.push(`M${round(start)} ${y + CARD_HEIGHT / 2}H${round(start + SPOUSE_GAP)}`);
    } else {
      // Not side by side, so the line goes up and over whoever is between them.
      const top = y - 0.25 - 0.15 * Math.min(to - from - 2, 3);
      spousePaths.push(`M${round(centerOf(first))} ${y}V${round(top)}H${round(centerOf(second))}V${y}`);
    }
  }

  // ---- Lines from parents to children. Children of the same parents share one.
  const isCouple = (parents: string[]) => {
    const [one, two] = parents;
    return (
      parents.length === 2 &&
      groupOf.get(one) === groupOf.get(two) &&
      Math.abs((indexInGroup.get(one) as number) - (indexInGroup.get(two) as number)) === 1 &&
      (spousesOf.get(one) ?? []).includes(two)
    );
  };
  const households = new Map<string, { parents: string[]; children: string[]; row: number; min: number; max: number; lane: number; middle: number | null }>();
  for (const { generation, person } of cards) {
    const parents = parentsOf.get(person.id);
    if (!parents) continue;
    const key = `${generation}|${[...parents].sort().join('|')}`;
    let household = households.get(key);
    if (!household) {
      // A couple's line comes down from the middle of the one joining them, which reads
      // as a marriage's children. Anyone else's comes down from each parent.
      const middle = isCouple(parents) ? (centerOf(parents[0]) + centerOf(parents[1])) / 2 : null;
      const xs = middle === null ? parents.map(centerOf) : [middle];
      household = { parents, children: [], row: generation, min: Math.min(...xs), max: Math.max(...xs), lane: 0, middle };
      households.set(key, household);
    }
    household.children.push(person.id);
    household.min = Math.min(household.min, centerOf(person.id));
    household.max = Math.max(household.max, centerOf(person.id));
  }
  const lanesByRow = new Map<number, number[]>();
  for (const household of [...households.values()].sort((a, b) => a.min - b.min)) {
    const ends = lanesByRow.get(household.row) ?? [];
    lanesByRow.set(household.row, ends);
    let lane = ends.findIndex((end) => end + GROUP_GAP / 2 < household.min);
    if (lane < 0 && ends.length < MAX_LANES) {
      lane = ends.length;
      ends.push(-Infinity);
    }
    if (lane < 0) lane = ends.indexOf(Math.min(...ends));
    ends[lane] = Math.max(ends[lane], household.max);
    household.lane = lane;
  }
  const parentPaths: string[] = [];
  for (const household of households.values()) {
    const lanes = lanesByRow.get(household.row)?.length ?? 1;
    const bus = round(
      yOf(household.row) - ROW_GAP / 2 + (household.lane - (lanes - 1) / 2) * LANE_STEP,
    );
    if (household.middle !== null) {
      const y = yOf((groupOf.get(household.parents[0]) as Group).generation) + CARD_HEIGHT / 2;
      parentPaths.push(`M${round(household.middle)} ${y}V${bus}`);
    } else {
      for (const parent of household.parents) {
        const y = yOf((groupOf.get(parent) as Group).generation) + CARD_HEIGHT;
        parentPaths.push(`M${round(centerOf(parent))} ${y}V${bus}`);
      }
    }
    const [start, end] = [round(household.min), round(household.max)];
    if (end - start > 0.01) parentPaths.push(`M${start} ${bus}H${end}`);
    for (const child of household.children) {
      parentPaths.push(`M${round(centerOf(child))} ${bus}V${yOf(household.row)}`);
    }
  }

  // A name with no page is a poor one to call a family by, if there is anyone else.
  const namesake = cards.find((card) => !card.person.missing) ?? cards[0];
  return {
    key: rowIds[0][0],
    label: namesake.person.title,
    cards,
    rows: rowIds,
    width: round(width),
    height,
    parentLines: parentPaths.join(''),
    spouseLines: spousePaths.join(''),
    loops,
    parentsOf,
    childrenOf,
    spousesOf,
  };
}

/** Every family in the project, biggest first. */
export function layoutFamilies(data: FamilyData): PlacedFamily[] {
  return splitFamilies(data)
    .map(layoutFamily)
    .sort((a, b) => b.cards.length - a.cards.length || a.label.localeCompare(b.label));
}

export type FamilyKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/** Where a key moves to from a card: along the row, or to the nearest relative above or below. */
export function moveInFamily(family: PlacedFamily, id: string, key: FamilyKey): string | null {
  const generation = family.rows.findIndex((row) => row.includes(id));
  if (generation < 0) return null;
  const row = family.rows[generation];
  const index = row.indexOf(id);
  const xOf = new Map(family.cards.map((card) => [card.person.id, card.x]));
  const nearest = (ids: string[]) => {
    const x = xOf.get(id) as number;
    let best: string | null = null;
    let distance = Infinity;
    for (const other of ids) {
      const gap = Math.abs((xOf.get(other) as number) - x);
      if (gap < distance) {
        best = other;
        distance = gap;
      }
    }
    return best;
  };
  switch (key) {
    case 'ArrowLeft':
      return row[index - 1] ?? null;
    case 'ArrowRight':
      return row[index + 1] ?? null;
    case 'Home':
      return row[0];
    case 'End':
      return row[row.length - 1];
    case 'ArrowUp':
      return nearest(family.parentsOf.get(id) ?? family.rows[generation - 1] ?? []);
    case 'ArrowDown':
      return nearest(family.childrenOf.get(id) ?? family.rows[generation + 1] ?? []);
  }
}
