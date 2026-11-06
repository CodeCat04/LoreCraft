/**
 * Prose checks with no network and no model: pure functions over text. Nothing here reads
 * or changes a document. Text comes in as segments, one per paragraph, and each result
 * says where it is in document positions, so an editor can highlight it directly.
 */

import type { PmNode } from '../lib/types';

/** One paragraph of prose. `from` is the document position of its first character. */
export interface ProseSegment {
  text: string;
  from: number;
  /** The scene it belongs to, when text from several scenes is read together. */
  scene?: string;
}

export const CHECKS = ['overused', 'repeated', 'doubled', 'longSentence', 'adverb', 'filter', 'passive'] as const;
export type CheckId = (typeof CHECKS)[number];

export interface ProseMatch {
  check: CheckId;
  scene?: string;
  from: number;
  to: number;
  text: string;
  /** For an overused word or phrase, the term in the report's list that this is a use of. */
  term?: string;
}

export interface OverusedTerm {
  text: string;
  count: number;
  /** How often per thousand words, here and in the rest of the text. */
  perThousand: number;
  restPerThousand: number | null;
}

export interface LengthBucket {
  /** In English, as a code. The panel names a row from `min` and `max` in the interface language. */
  label: string;
  min: number;
  max: number;
  count: number;
}

export interface ProseReport {
  words: number;
  sentences: number;
  paragraphs: number;
  matches: Record<CheckId, ProseMatch[]>;
  overused: OverusedTerm[];
  sentenceLengths: LengthBucket[];
  averageSentenceWords: number;
  longestSentenceWords: number;
  /** Flesch-Kincaid. Null when the text is too short or not in a language this can judge. */
  gradeLevel: number | null;
  readingEase: number | null;
  readingLevel: ReadingLevel | null;
  readingMinutes: number;
  speakingMinutes: number;
}

export interface ProseOptions {
  /** Page titles and aliases. These are names, so they never count as overused. */
  names?: readonly string[];
  /** Word and phrase counts from the rest of the text, to compare against. */
  rest?: TextCounts;
  /** Sentences longer than this many words are flagged. */
  longSentenceWords?: number;
  /** Two uses of a word within this many words count as close together. */
  repeatWindow?: number;
}

export const DEFAULT_LONG_SENTENCE_WORDS = 35;
export const DEFAULT_REPEAT_WINDOW = 15;

const READING_WORDS_PER_MINUTE = 238;
const SPEAKING_WORDS_PER_MINUTE = 150;

/** Below this much text elsewhere, a comparison with it says nothing. */
const MIN_REST_WORDS = 1000;
const MIN_WORD_COUNT = 4;
const MIN_PHRASE_COUNT = 3;
const MAX_OVERUSED_TERMS = 40;
/** How many times more often than elsewhere before something counts as overused. */
const OVERUSE_RATIO = 2.5;
/** With nothing to compare against, the share of the text that counts as overuse. */
const OVERUSE_SHARE_WORD = 0.005;
const OVERUSE_SHARE_PHRASE = 0.002;
const PHRASE_LENGTHS = [2, 3, 4];

// ---------------------------------------------------------------------------
// Word lists
// ---------------------------------------------------------------------------

function words(list: string): Set<string> {
  return new Set(list.split(/\s+/).filter(Boolean));
}

/** Words nobody hears as repetition, including the ones fiction leans on by design. */
const COMMON = words(`
  a about above after again against all also am an and any are around as at away back be
  because been before being below between both but by can could did do does doing down during
  each even ever every few for from further get got had has have having he her here hers herself
  him himself his how i if in into is it its itself just like me more most my myself no nor not
  now of off on once one only or other our ours out over own said same say says she should so
  some still such than that the their theirs them themselves then there these they this those
  through to too two under until up upon very was we were what when where which while who whom
  why will with would yet you your yours yourself
  don't didn't doesn't isn't wasn't weren't won't wouldn't couldn't shouldn't can't haven't hasn't
  hadn't i'm i'd i'll i've he'd he'll he's she'd she'll she's it's it'd they'd they'll they're
  they've we'd we'll we're we've you'd you'll you're you've that's there's what's who's let's
`);

const NOT_ADVERBS = words(`
  ally anomaly apply assembly belly bully butterfly comply contumely courtly curly daily deadly
  dolly early elderly family fly folly friendly ghastly ghostly gully holy homely hourly imply
  jelly jolly kindly lily lively lonely lovely lowly melancholy monopoly multiply nightly oily
  only panoply reply rely silly sly smelly stately supply tally ugly unlikely unruly weekly wily
  wobbly woolly worldly yearly likely italy july rally sally billy molly polly
`);

const FILTER_WORDS = words(`
  feel feels felt feeling see sees saw seen seeing seem seems seemed seeming hear hears heard
  hearing notice notices noticed noticing watch watches watched watching realize realizes realized
  realizing realise realises realised realising wonder wonders wondered wondering think thinks
  thought thinking know knows knew knowing decide decides decided deciding look looks looked looking
  remember remembers remembered remembering
`);

const TO_BE = words('am is are was were be been being');

/** Adverbs and such that can sit between "was" and its participle. */
const PASSIVE_GAP = words('not never always also just being');

const IRREGULAR_PARTICIPLES = words(`
  beaten become begun bent bitten blown born borne bought bound broken brought built burnt burst
  caught chosen cut dealt done drawn driven drunk dug eaten fallen fed felt fought found flown
  forgotten forgiven frozen given gone grown hanged held hidden hit hung hurt kept known laid led
  left lent let lit lost made meant met paid put read rebuilt rung risen run said sat seen sent set shaken
  shed shot shown shut slain slept sold sought spent split spoken spread stolen struck stuck sung
  sunk swept sworn taken taught thought thrown told torn understood woken won worn woven written
`);

/** Words that look like participles but after "was" are usually describing someone. */
const DESCRIPTIVE_PARTICIPLES = words(`
  aged annoyed ashamed bored concerned confused crowded delighted depressed determined disappointed
  disgusted embarrassed excited exhausted frightened hundred interested married naked pleased
  relieved satisfied scared shocked sacred supposed surprised tired wicked worried used
`);

const DOUBLES_ALLOWED = words('had that');

const ABBREVIATIONS = words(`
  mr mrs ms mx dr prof st mt sr jr vs etc gen col capt lt sgt rev hon pres gov sen rep inc ltd co
  ave blvd rd dept fig vol pp e.g i.e cf al
`);

// ---------------------------------------------------------------------------
// Tokens and sentences
// ---------------------------------------------------------------------------

export interface WordToken {
  key: string;
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

/** Lower case, with a typed apostrophe and a curly one treated alike. */
export function wordKey(word: string): string {
  return word.toLowerCase().replace(/’/g, "'");
}

export function tokenize(text: string): WordToken[] {
  const out: WordToken[] = [];
  for (const match of text.matchAll(WORD)) {
    out.push({ key: wordKey(match[0]), start: match.index, end: match.index + match[0].length });
  }
  return out;
}

const TERMINATOR = /[.!?…]/;
const CLOSER = /["'”’)\]»]/;

function endsWithAbbreviation(text: string, dot: number): boolean {
  let start = dot;
  while (start > 0 && /[\p{L}.]/u.test(text[start - 1])) start -= 1;
  const word = text.slice(start, dot);
  // An initial, as in J. R. Tolkien. "I" is far more often the end of "So do I."
  if (word.length === 1 && word !== 'I' && /\p{Lu}/u.test(word)) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * The sentences in a paragraph, as ranges of its text. A closing quote stays with the
 * sentence it closes, and a lower-case word after one carries it on, as in
 * "Stop!" he said.
 */
export function splitSentences(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const push = (start: number, end: number) => {
    let from = start;
    let to = end;
    while (from < to && /\s/.test(text[from])) from += 1;
    while (to > from && /\s/.test(text[to - 1])) to -= 1;
    if (from < to) out.push({ start: from, end: to });
  };
  let sentenceStart = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') {
      push(sentenceStart, i);
      sentenceStart = i + 1;
      i += 1;
      continue;
    }
    if (!TERMINATOR.test(c)) {
      i += 1;
      continue;
    }
    let end = i + 1;
    let onlyOneDot = c === '.';
    while (end < text.length && TERMINATOR.test(text[end])) {
      onlyOneDot = false;
      end += 1;
    }
    while (end < text.length && CLOSER.test(text[end])) end += 1;
    const next = text[end];
    let after = end;
    while (after < text.length && text[after] === ' ') after += 1;
    const following = text[after];
    const atEnd = next === undefined || next === '\n';
    const boundary =
      atEnd ||
      (/\s/.test(next) &&
        !(onlyOneDot && endsWithAbbreviation(text, i)) &&
        !(following !== undefined && /\p{Ll}/u.test(following)));
    if (boundary) {
      push(sentenceStart, end);
      sentenceStart = end;
    }
    i = end;
  }
  push(sentenceStart, text.length);
  return out;
}

/** A plain estimate of a word's syllables in English. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return trimmed.match(/[aeiouy]{1,2}/g)?.length ?? 1;
}

/**
 * A reading level, named in English. This runs in a worker, which has no interface language,
 * so the name doubles as a code that the panel translates.
 */
export type ReadingLevel = 'Very easy' | 'Easy' | 'Average' | 'Difficult' | 'Very difficult';

function levelName(grade: number): ReadingLevel {
  if (grade < 6) return 'Very easy';
  if (grade < 9) return 'Easy';
  if (grade < 13) return 'Average';
  if (grade < 17) return 'Difficult';
  return 'Very difficult';
}

// ---------------------------------------------------------------------------
// Reading a document
// ---------------------------------------------------------------------------

/** Nodes with no content of their own. Each takes one position, like any inline atom. */
export const LEAF_NODES = new Set(['hardBreak', 'horizontalRule', 'image', 'video', 'reference', 'pageList', 'canvasEmbed']);
/** Holds no prose, so nothing in it is checked. */
const SKIPPED_BLOCKS = new Set(['codeBlock', 'heading', 'figure', 'table']);
/** Stands in for an inline object, one position wide. Never part of a word. */
const OBJECT = '￼';

/**
 * The prose in a stored document, with the positions an editor would give it. Each
 * character of a segment's text sits at `from` plus its offset.
 */
export function segmentsFromDoc(doc: PmNode, scene?: string): ProseSegment[] {
  const out: ProseSegment[] = [];
  const size = (node: PmNode): number => {
    if (node.type === 'text') return node.text?.length ?? 0;
    if (LEAF_NODES.has(node.type)) return 1;
    return (node.content ?? []).reduce((sum, child) => sum + size(child), 2);
  };
  const walk = (node: PmNode, start: number) => {
    let pos = start;
    for (const child of node.content ?? []) {
      if (child.type === 'paragraph') {
        let text = '';
        for (const inline of child.content ?? []) {
          if (inline.type === 'text') text += inline.text ?? '';
          else text += inline.type === 'hardBreak' ? '\n' : OBJECT;
        }
        if (text.trim()) out.push(scene === undefined ? { text, from: pos + 1 } : { text, from: pos + 1, scene });
      } else if (!SKIPPED_BLOCKS.has(child.type) && !LEAF_NODES.has(child.type) && child.type !== 'text') {
        walk(child, pos + 1);
      }
      pos += size(child);
    }
  };
  walk(doc, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Counting, for comparing one part of a text with the rest
// ---------------------------------------------------------------------------

export interface TextCounts {
  total: number;
  /** Word and phrase keys, with phrases written with single spaces. */
  counts: Map<string, number>;
}

/** Tokens with what can be a phrase: runs inside one sentence. */
function sentencesOf(segment: ProseSegment): { start: number; end: number; tokens: WordToken[] }[] {
  const all = tokenize(segment.text);
  let index = 0;
  return splitSentences(segment.text).map((sentence) => {
    const tokens: WordToken[] = [];
    while (index < all.length && all[index].start < sentence.end) {
      if (all[index].start >= sentence.start) tokens.push(all[index]);
      index += 1;
    }
    return { ...sentence, tokens };
  });
}

function eachPhrase(tokens: WordToken[], visit: (key: string, first: number, last: number) => void) {
  for (let i = 0; i < tokens.length; i += 1) {
    for (const length of PHRASE_LENGTHS) {
      const last = i + length - 1;
      if (last >= tokens.length) break;
      // A phrase starts and ends on a word that carries meaning, so "of the" is not one.
      if (COMMON.has(tokens[i].key) || COMMON.has(tokens[last].key)) continue;
      let key = tokens[i].key;
      for (let j = i + 1; j <= last; j += 1) key += ` ${tokens[j].key}`;
      visit(key, i, last);
    }
  }
}

export function countText(segments: readonly ProseSegment[]): TextCounts {
  const counts = new Map<string, number>();
  let total = 0;
  for (const segment of segments) {
    for (const { tokens } of sentencesOf(segment)) {
      total += tokens.length;
      for (const token of tokens) counts.set(token.key, (counts.get(token.key) ?? 0) + 1);
      eachPhrase(tokens, (key) => counts.set(key, (counts.get(key) ?? 0) + 1));
    }
  }
  return { total, counts };
}

/** Adds counts together. */
export function mergeCounts(parts: readonly TextCounts[]): TextCounts {
  const counts = new Map<string, number>();
  let total = 0;
  for (const part of parts) {
    total += part.total;
    for (const [key, count] of part.counts) counts.set(key, (counts.get(key) ?? 0) + count);
  }
  return { total, counts };
}

function nameWords(names: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    for (const token of tokenize(name)) out.add(token.key);
  }
  return out;
}

/** What this text says more often than it should, most striking first. */
export function findOverused(scope: TextCounts, rest: TextCounts | undefined, names: Set<string>): OverusedTerm[] {
  const compare = rest && rest.total >= MIN_REST_WORDS ? rest : null;
  const found: (OverusedTerm & { weight: number })[] = [];
  if (scope.total === 0) return [];
  for (const [key, count] of scope.counts) {
    const parts = key.split(' ');
    const isPhrase = parts.length > 1;
    if (count < (isPhrase ? MIN_PHRASE_COUNT : MIN_WORD_COUNT)) continue;
    if (parts.some((part) => names.has(part))) continue;
    if (!isPhrase && (COMMON.has(key) || key.length < 3)) continue;
    // A word said over and over is reported as that word, not as a phrase.
    if (isPhrase && parts.every((part) => part === parts[0])) continue;
    const rate = count / scope.total;
    const perThousand = rate * 1000;
    let weight: number;
    let restPerThousand: number | null = null;
    if (compare) {
      const other = compare.counts.get(key) ?? 0;
      const otherRate = (other + 0.5) / compare.total;
      restPerThousand = (other / compare.total) * 1000;
      weight = rate / otherRate;
      if (weight < OVERUSE_RATIO) continue;
    } else {
      const share = isPhrase ? OVERUSE_SHARE_PHRASE : OVERUSE_SHARE_WORD;
      if (rate < share) continue;
      weight = rate / share;
    }
    found.push({ text: key, count, perThousand, restPerThousand, weight });
  }
  // "the old stone gate" repeated says more than "old stone" with the same count.
  const phrases = found.filter((term) => term.text.includes(' '));
  const kept = found.filter(
    (term) =>
      !phrases.some(
        (longer) =>
          longer !== term &&
          longer.count >= term.count &&
          longer.text.length > term.text.length &&
          ` ${longer.text} `.includes(` ${term.text} `),
      ),
  );
  return kept
    .sort((a, b) => b.count * Math.min(b.weight, 10) - a.count * Math.min(a.weight, 10) || a.text.localeCompare(b.text))
    .slice(0, MAX_OVERUSED_TERMS)
    .map(({ weight: _weight, ...term }) => term);
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const LENGTH_BUCKETS: [string, number, number][] = [
  ['1 to 5', 1, 5],
  ['6 to 10', 6, 10],
  ['11 to 15', 11, 15],
  ['16 to 20', 16, 20],
  ['21 to 30', 21, 30],
  ['31 to 40', 31, 40],
  ['Over 40', 41, Number.POSITIVE_INFINITY],
];

function emptyMatches(): Record<CheckId, ProseMatch[]> {
  return { overused: [], repeated: [], doubled: [], longSentence: [], adverb: [], filter: [], passive: [] };
}

function isParticiple(key: string): boolean {
  if (DESCRIPTIVE_PARTICIPLES.has(key)) return false;
  if (IRREGULAR_PARTICIPLES.has(key)) return true;
  return key.length >= 5 && key.endsWith('ed');
}

function isAdverb(key: string, names: Set<string>): boolean {
  return key.length > 4 && key.endsWith('ly') && !NOT_ADVERBS.has(key) && !names.has(key) && !key.includes('-');
}

function onlySpaceBetween(text: string, a: WordToken, b: WordToken): boolean {
  return /^\s+$/.test(text.slice(a.end, b.start));
}

/** Runs every check. Takes time in proportion to the text, so large texts belong in a worker. */
export function analyze(segments: readonly ProseSegment[], options: ProseOptions = {}): ProseReport {
  const longLimit = options.longSentenceWords ?? DEFAULT_LONG_SENTENCE_WORDS;
  const repeatWindow = options.repeatWindow ?? DEFAULT_REPEAT_WINDOW;
  const names = nameWords(options.names ?? []);
  const matches = emptyMatches();
  const buckets: LengthBucket[] = LENGTH_BUCKETS.map(([label, min, max]) => ({ label, min, max, count: 0 }));

  let totalWords = 0;
  let totalSentences = 0;
  let totalSyllables = 0;
  let lettersWords = 0;
  let longest = 0;
  const lastSeen = new Map<string, { index: number; segment: ProseSegment; token: WordToken }>();
  const repeatedDone = new Set<string>();
  const pushMatch = (check: CheckId, segment: ProseSegment, start: number, end: number, term?: string) => {
    const match: ProseMatch = {
      check,
      from: segment.from + start,
      to: segment.from + end,
      text: segment.text.slice(start, end),
    };
    if (segment.scene !== undefined) match.scene = segment.scene;
    if (term !== undefined) match.term = term;
    matches[check].push(match);
  };
  const pushRepeated = (segment: ProseSegment, token: WordToken) => {
    const id = `${segment.scene ?? ''}:${segment.from + token.start}`;
    if (repeatedDone.has(id)) return;
    repeatedDone.add(id);
    pushMatch('repeated', segment, token.start, token.end);
  };

  const scopeCounts: TextCounts = { total: 0, counts: new Map() };
  const parsed = segments.map((segment) => ({ segment, sentences: sentencesOf(segment) }));

  for (const { segment, sentences } of parsed) {
    const { text } = segment;
    for (const sentence of sentences) {
      const { tokens } = sentence;
      if (tokens.length === 0) continue;
      totalSentences += 1;
      longest = Math.max(longest, tokens.length);
      const bucket = buckets.find((b) => tokens.length >= b.min && tokens.length <= b.max);
      if (bucket) bucket.count += 1;
      if (tokens.length > longLimit) pushMatch('longSentence', segment, sentence.start, sentence.end);

      scopeCounts.total += tokens.length;
      eachPhrase(tokens, (key) => scopeCounts.counts.set(key, (scopeCounts.counts.get(key) ?? 0) + 1));

      tokens.forEach((token, i) => {
        const { key } = token;
        const index = totalWords;
        totalWords += 1;
        scopeCounts.counts.set(key, (scopeCounts.counts.get(key) ?? 0) + 1);
        if (/[a-z]/.test(key)) lettersWords += 1;
        totalSyllables += syllables(key);

        const previous = tokens[i - 1];
        if (previous && previous.key === key && !DOUBLES_ALLOWED.has(key) && onlySpaceBetween(text, previous, token)) {
          pushMatch('doubled', segment, previous.start, token.end);
        }

        if (isAdverb(key, names)) pushMatch('adverb', segment, token.start, token.end);
        if (FILTER_WORDS.has(key) && !names.has(key)) pushMatch('filter', segment, token.start, token.end);

        if (TO_BE.has(key) && !(previous && TO_BE.has(previous.key))) {
          let next = tokens[i + 1];
          let gapOk = next && onlySpaceBetween(text, token, next);
          if (next && gapOk && (PASSIVE_GAP.has(next.key) || isAdverb(next.key, names))) {
            const after = tokens[i + 2];
            gapOk = !!after && onlySpaceBetween(text, next, after);
            next = after;
          }
          if (next && gapOk && isParticiple(next.key)) pushMatch('passive', segment, token.start, next.end);
        }

        // A word close to its last use. Words like "the" do not echo, and names repeat on purpose.
        if (key.length >= 4 && !COMMON.has(key) && !names.has(key)) {
          const seen = lastSeen.get(key);
          if (seen && index - seen.index <= repeatWindow) {
            pushRepeated(seen.segment, seen.token);
            pushRepeated(segment, token);
          }
          lastSeen.set(key, { index, segment, token });
        }
      });
    }
  }

  const overused = findOverused(scopeCounts, options.rest, names);
  if (overused.length > 0) {
    const terms = new Set(overused.map((term) => term.text));
    for (const { segment, sentences } of parsed) {
      for (const { tokens } of sentences) {
        const found: { start: number; end: number; term: string }[] = [];
        for (const token of tokens) {
          if (terms.has(token.key)) found.push({ start: token.start, end: token.end, term: token.key });
        }
        eachPhrase(tokens, (key, first, last) => {
          if (terms.has(key)) found.push({ start: tokens[first].start, end: tokens[last].end, term: key });
        });
        // Segments are in reading order already, and positions restart in each scene, so
        // only the words of one sentence need putting in order.
        found.sort((a, b) => a.start - b.start);
        for (const hit of found) pushMatch('overused', segment, hit.start, hit.end, hit.term);
      }
    }
  }

  const judged = totalWords >= 30 && totalSentences > 0 && lettersWords >= totalWords / 2;
  const wordsPerSentence = totalSentences > 0 ? totalWords / totalSentences : 0;
  const syllablesPerWord = totalWords > 0 ? totalSyllables / totalWords : 0;
  const grade = judged ? 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59 : null;
  const ease = judged ? 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord : null;

  return {
    words: totalWords,
    sentences: totalSentences,
    paragraphs: segments.length,
    matches,
    overused,
    sentenceLengths: buckets,
    averageSentenceWords: wordsPerSentence,
    longestSentenceWords: longest,
    gradeLevel: grade === null ? null : Math.max(0, grade),
    readingEase: ease,
    readingLevel: grade === null ? null : levelName(grade),
    readingMinutes: totalWords / READING_WORDS_PER_MINUTE,
    speakingMinutes: totalWords / SPEAKING_WORDS_PER_MINUTE,
  };
}

/** Sentences of a stretch of a document, for reading aloud. Positions are the document's. */
export function sentenceRanges(segments: readonly ProseSegment[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const segment of segments) {
    for (const sentence of splitSentences(segment.text)) {
      if (/[\p{L}\p{N}]/u.test(segment.text.slice(sentence.start, sentence.end))) {
        out.push({ from: segment.from + sentence.start, to: segment.from + sentence.end });
      }
    }
  }
  return out;
}
