/**
 * Finds page names in manuscript text. This must agree with `MentionMatcher` in
 * `src-tauri/src/indexing.rs`, so the highlights and the "In this scene" list show the
 * same names: exact case, whole words, leftmost and longest, three or more characters.
 * Scripts written without spaces have no whole words to look for, so a name in one matches
 * anywhere, from two characters, and a character of one counts as a word edge.
 *
 * Aho-Corasick in leftmost-longest mode reports, from left to right, the longest name
 * starting at the first position where any name starts, then carries on after it, and
 * only then does the Rust code test for word boundaries. A trie walked from each
 * position gives exactly those matches. Most characters start no name, so this is fast
 * enough to run on a block per keystroke.
 */

import { isUnspacedScript } from '../lib/text';
import type { TitleEntry } from '../lib/types';

const MIN_NAME_CHARS = 3;
const MIN_UNSPACED_NAME_CHARS = 2;

interface TrieNode {
  next: Map<number, TrieNode> | null;
  /** The page title, if a name ends here. */
  title: string | null;
}

export interface NameMatch {
  start: number;
  end: number;
  title: string;
}

/** The first page to claim a name keeps it, as the first pattern does in Rust. */
function insert(root: Map<number, TrieNode>, name: string, title: string) {
  let level = root;
  let node: TrieNode | undefined;
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    node = level.get(code);
    if (!node) {
      node = { next: null, title: null };
      level.set(code, node);
    }
    if (i < name.length - 1) {
      node.next ??= new Map();
      level = node.next;
    }
  }
  if (node && node.title === null) node.title = title;
}

const ALPHANUMERIC = /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u;

/** Must match Rust's `char::is_alphanumeric`. */
function isAlphanumeric(code: number): boolean {
  if (code < 128) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }
  return ALPHANUMERIC.test(String.fromCodePoint(code));
}

/** The whole character before a position, allowing for surrogate pairs. */
function codePointBefore(text: string, at: number): number {
  const low = text.charCodeAt(at - 1);
  if (low >= 0xdc00 && low <= 0xdfff && at >= 2) {
    const high = text.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return ((high - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
  }
  return low;
}

function isUsableName(name: string): boolean {
  const chars = [...name];
  return (
    chars.length >= MIN_NAME_CHARS ||
    (chars.length >= MIN_UNSPACED_NAME_CHARS && chars.some((c) => isUnspacedScript(c.codePointAt(0) as number)))
  );
}

/**
 * Whether a name can end here, as `is_name_edge` in Rust. `inner` is the name's own character
 * at this edge and `outer` the one beyond it, or -1 at the end of the text.
 */
function isNameEdge(inner: number, outer: number): boolean {
  return isUnspacedScript(inner) || outer < 0 || !isAlphanumeric(outer) || isUnspacedScript(outer);
}

export class NameMatcher {
  private readonly root = new Map<number, TrieNode>();

  /** Names in a stable form, so two matchers can be compared without rebuilding. */
  readonly signature: string;

  constructor(entries: readonly TitleEntry[]) {
    const names: string[] = [];
    // Titles go first, so that a real title always wins over someone's alias. The query
    // behind `MentionMatcher::build` lists its names in the same order.
    for (const entry of entries) {
      if (isUsableName(entry.title)) {
        insert(this.root, entry.title, entry.title);
        names.push(`${entry.title}\u0000${entry.title}`);
      }
    }
    for (const entry of entries) {
      for (const alias of entry.aliases) {
        if (isUsableName(alias)) {
          insert(this.root, alias, entry.title);
          names.push(`${alias}\u0000${entry.title}`);
        }
      }
    }
    this.signature = names.sort().join('\u0001');
  }

  find(text: string): NameMatch[] {
    const matches: NameMatch[] = [];
    const length = text.length;
    let i = 0;
    while (i < length) {
      let node = this.root.get(text.charCodeAt(i));
      if (!node) {
        i += 1;
        continue;
      }
      let end = -1;
      let title: string | null = null;
      let j = i;
      while (node) {
        j += 1;
        if (node.title !== null) {
          end = j;
          title = node.title;
        }
        if (j >= length || !node.next) break;
        node = node.next.get(text.charCodeAt(j));
      }
      if (end < 0 || title === null) {
        i += 1;
        continue;
      }
      const before = i === 0 ? -1 : codePointBefore(text, i);
      const after = end >= length ? -1 : (text.codePointAt(end) ?? -1);
      const first = text.codePointAt(i) ?? -1;
      const last = codePointBefore(text, end);
      if (isNameEdge(first, before) && isNameEdge(last, after)) {
        matches.push({ start: i, end, title });
      }
      i = end;
    }
    return matches;
  }
}

let cached: { entries: readonly TitleEntry[]; matcher: NameMatcher } | null = null;

/** One matcher per list of titles. It only changes when the names themselves change. */
export function matcherFor(entries: readonly TitleEntry[]): NameMatcher {
  if (cached?.entries === entries) return cached.matcher;
  const fresh = new NameMatcher(entries);
  const matcher = cached && cached.matcher.signature === fresh.signature ? cached.matcher : fresh;
  cached = { entries, matcher };
  return matcher;
}
