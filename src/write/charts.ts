/** The arithmetic behind the thread board and the character presence chart. */

import type { BookPresence, Thread, ThreadLink } from './api';
import { childrenOf, type TreeIndex } from './tree';
import type { NodeMeta, TitleEntry } from '../lib/types';

/** Thread colors are theme tokens, so they work in every theme. */
export const THREAD_COLORS = ['accent', 'success', 'warning', 'danger', 'link', 'text-muted'] as const;

export function threadColor(name: string): string {
  return `var(--${(THREAD_COLORS as readonly string[]).includes(name) ? name : 'accent'})`;
}

/**
 * Which places count as gone quiet: every stretch of at least `longest` with nothing in it,
 * once it has appeared at all. Before the first appearance, it simply has not begun.
 */
export function quietStretches(present: boolean[], longest: number): boolean[] {
  const quiet = present.map(() => false);
  const first = present.indexOf(true);
  if (first < 0) return quiet;
  let i = first;
  while (i < present.length) {
    if (present[i]) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < present.length && !present[end]) end += 1;
    if (end - i >= longest) quiet.fill(true, i, end);
    i = end;
  }
  return quiet;
}

/** The longest stretch with nothing in it, once it has appeared at all. */
export function longestGap(present: boolean[]): number {
  const first = present.indexOf(true);
  if (first < 0) return 0;
  let longest = 0;
  let run = 0;
  for (let i = first; i < present.length; i += 1) {
    run = present[i] ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

export interface ThreadCell {
  chapter: NodeMeta;
  scenes: NodeMeta[];
  sceneIds: string[];
  quiet: boolean;
}

export interface ThreadRow {
  thread: Thread;
  cells: ThreadCell[];
  appears: number;
}

function scenesOf(index: TreeIndex, chapter: NodeMeta): NodeMeta[] {
  return childrenOf(index, chapter.id).filter((n) => n.kind === 'scene');
}

/** One row per thread and one cell per chapter, saying which of its scenes are on the thread. */
export function threadRows(threads: Thread[], links: ThreadLink[], index: TreeIndex): ThreadRow[] {
  return threads.map((thread) => {
    const tagged = new Set(links.filter((l) => l.threadId === thread.id).map((l) => l.nodeId));
    const cells = index.chapters.map((chapter) => {
      const scenes = scenesOf(index, chapter);
      return { chapter, scenes, sceneIds: scenes.filter((s) => tagged.has(s.id)).map((s) => s.id) };
    });
    const quiet = quietStretches(cells.map((c) => c.sceneIds.length > 0), 1);
    return {
      thread,
      cells: cells.map((cell, i) => ({ ...cell, quiet: quiet[i] })),
      appears: cells.filter((c) => c.sceneIds.length > 0).length,
    };
  });
}

/** How many chapters away counts as absent enough to point out. */
export const ABSENT_CHAPTERS = 3;

export interface PresenceCell {
  chapter: NodeMeta;
  /** Times the character is named in this chapter's scenes. */
  named: number;
  /** Scenes of this chapter with the character in their cast. */
  cast: number;
  absent: boolean;
}

export interface PresenceRow {
  page: TitleEntry;
  cells: PresenceCell[];
  /** The longest time away in chapters, once the character has appeared. */
  longestAbsence: number;
}

/** Characters who appear at all, in order of first appearance, with a cell per chapter. */
export function presenceRows(
  characters: TitleEntry[],
  presence: BookPresence,
  index: TreeIndex,
  absentAfter = ABSENT_CHAPTERS,
): PresenceRow[] {
  const chapterAt = new Map<string, number>();
  index.chapters.forEach((chapter, at) => {
    for (const scene of scenesOf(index, chapter)) chapterAt.set(scene.id, at);
  });
  // Once through the mentions, because a long book has a great many of them.
  const counts = new Map<string, { named: number[]; cast: number[] }>();
  const countsOf = (pageId: string) => {
    let found = counts.get(pageId);
    if (!found) {
      found = { named: index.chapters.map(() => 0), cast: index.chapters.map(() => 0) };
      counts.set(pageId, found);
    }
    return found;
  };
  for (const m of presence.mentions) {
    const at = chapterAt.get(m.nodeId);
    if (at !== undefined) countsOf(m.pageId).named[at] += m.count;
  }
  for (const c of presence.cast) {
    const at = chapterAt.get(c.nodeId);
    if (at !== undefined) countsOf(c.pageId).cast[at] += 1;
  }
  const rows: { row: PresenceRow; first: number }[] = [];
  for (const page of characters) {
    const { named, cast } = counts.get(page.id) ?? { named: [], cast: [] };
    const present = named.map((count, i) => count > 0 || cast[i] > 0);
    const first = present.indexOf(true);
    if (first < 0) continue;
    const absent = quietStretches(present, absentAfter);
    rows.push({
      first,
      row: {
        page,
        cells: index.chapters.map((chapter, i) => ({ chapter, named: named[i], cast: cast[i], absent: absent[i] })),
        longestAbsence: longestGap(present),
      },
    });
  }
  return rows.sort((a, b) => a.first - b.first).map((r) => r.row);
}

/** Heavier for more mentions, in the four steps the legend shows. */
export function presenceLevel(named: number): 0 | 1 | 2 | 3 | 4 {
  if (named <= 0) return 0;
  if (named < 3) return 1;
  if (named < 8) return 2;
  if (named < 20) return 3;
  return 4;
}
