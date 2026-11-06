/**
 * Turns a style into the text given to the AI. Every prompt in the app comes from
 * `buildStylePrompt`, so there is one source of truth and one reliable structure, short and
 * direct enough for a modest local model as well as a frontier one.
 */

import { BLEND_WEIGHTS, TRAIT_FIELDS, type BlendPart, type BlendWeight, type CustomStyle, type Genre, type TraitKey, type WritingStyle } from './types';

/** Library prompts must stay under this. */
export const PROMPT_WORD_LIMIT = 300;

/** Sentences every prompt closes on. Tests and stored prompts look for these. */
export const CLOSING_START = 'Write original prose in this manner.';
export const CLOSING_END = "If the writer's lore defines a fact, the lore wins over style.";

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function closingFor(style: WritingStyle): string {
  const middle =
    style.kind === 'author'
      ? "Do not reuse this author's text, characters, settings or invented terms, and never name the author in the story text."
      : style.kind === 'custom' && style.namesAuthors
        ? 'Do not reuse the text, characters, settings or invented terms of any author this style draws on, and never name them in the story text.'
        : 'Do not reuse text, characters, settings or invented terms from any published work.';
  return `${CLOSING_START} ${middle} ${CLOSING_END}`;
}

function openingFor(style: WritingStyle): string {
  const lead = style.kind === 'author' ? `Write in the manner of ${style.name}.` : `Write in this style: ${style.name.replace(/[.\s]+$/, '')}.`;
  return `${lead} Follow these instructions in all the prose you write.`;
}

/** Removes closing paragraphs, and any stray closing sentence, from an edited prompt. */
function stripClosings(text: string): string {
  let rest = text;
  for (;;) {
    const start = rest.indexOf(CLOSING_START);
    const end = start < 0 ? -1 : rest.indexOf(CLOSING_END, start);
    if (end < 0) break;
    rest = rest.slice(0, start) + rest.slice(end + CLOSING_END.length);
  }
  return rest.split(CLOSING_END).join('').trim();
}

/** The text to give the AI for this style. */
export function buildStylePrompt(style: WritingStyle): string {
  const closing = closingFor(style);
  if (style.kind === 'custom') {
    // Any closing in the edited text is swapped for the real one, so the originality guard
    // is always there and always right.
    const body = stripClosings(style.promptOverride?.trim() ?? '');
    if (body) return `${body}\n\n${closing}`;
  }
  const lines = TRAIT_FIELDS.flatMap(({ key, label }) => {
    const text = style.traits[key]?.trim();
    return text ? [`${label}: ${text}`] : [];
  });
  if (style.kind === 'custom' && style.priority?.trim()) lines.push(`Priority: ${style.priority.trim()}`);
  if (lines.length === 0) return `${openingFor(style)}\n\n${closing}`;
  return `${openingFor(style)}\n\n${lines.join('\n')}\n\n${closing}`;
}

// ---------------------------------------------------------------------------
// Blending
// ---------------------------------------------------------------------------

const POINTS: Record<BlendWeight, number> = { mostly: 4, some: 2, touch: 1 };

/** A blend also says what takes priority, so it may run a little over a single style. */
const BLEND_WORD_TARGET = 330;

/** The areas one style can own. The lead takes the ones that shape the book most. */
const AREAS: TraitKey[] = ['narration', 'pacing', 'sentences', 'description', 'diction', 'dialogue'];

const AREA_NAMES: Record<string, string> = Object.fromEntries(
  TRAIT_FIELDS.map((field) => [field.key, field.label.toLowerCase()]),
);

function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/);
  return match ? match[0] : text;
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** How many of the areas each part owns. A touch owns none, unless it leads. */
function shareOutAreas(parts: BlendPart[]): number[] {
  const owning = parts.map((part, i) => (i === 0 || part.weight !== 'touch' ? POINTS[part.weight] : 0));
  const total = owning.reduce((sum, points) => sum + points, 0);
  const exact = owning.map((points) => (points / total) * AREAS.length);
  const counts = exact.map(Math.floor);
  let left = AREAS.length - counts.reduce((sum, count) => sum + count, 0);
  const order = exact
    .map((value, i) => ({ i, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    if (owning[i] > 0) {
      counts[i] += 1;
      left -= 1;
    }
  }
  return counts;
}

function weightPhrase(part: BlendPart, index: number): string {
  const name = part.style.name;
  if (part.weight === 'mostly') return `${index === 0 ? 'Mostly' : 'mostly'} ${name}`;
  if (part.weight === 'some') return `${index === 0 ? 'Some' : 'some'} ${name}`;
  return `${index === 0 ? 'A touch' : 'a touch'} of ${name}`;
}

export function blendName(parts: BlendPart[]): string {
  return orderParts(parts).map(weightPhrase).join(', ');
}

/** Heaviest first. Equal weights keep the order they were chosen in. */
function orderParts(parts: BlendPart[]): BlendPart[] {
  return parts
    .map((part, i) => ({ part, i }))
    .sort((a, b) => POINTS[b.part.weight] - POINTS[a.part.weight] || a.i - b.i)
    .map(({ part }) => part);
}

/**
 * Combines up to three styles into one. Each area of the prose has exactly one owner, so
 * two instructions can never compete for it, and the lead style's limits apply throughout.
 * The result is an unsaved custom style, so `buildStylePrompt` gives its prompt.
 */
export function blendStyles(parts: BlendPart[]): CustomStyle {
  if (parts.length === 0) throw new Error('A blend needs at least one style.');
  if (parts.length > 3) throw new Error('A blend can hold up to three styles.');
  const ordered = orderParts(parts);
  const lead = ordered[0].style;
  const counts = shareOutAreas(ordered);

  const traits = { ...lead.traits };
  const owns: TraitKey[][] = ordered.map(() => []);
  let next = 0;
  counts.forEach((count, i) => {
    for (const area of AREAS.slice(next, next + count)) {
      traits[area] = ordered[i].style.traits[area];
      owns[i].push(area);
    }
    next += count;
  });

  const extras = ordered.slice(1).map(({ style, weight }) => {
    const device = firstSentence(style.traits.signature);
    return weight === 'touch' ? `Very rarely: ${device}` : `From time to time: ${device}`;
  });
  traits.signature = [lead.traits.signature, ...extras].join(' ');

  const roles = ordered.map((part, i) => {
    if (owns[i].length > 0) return `${part.style.name} decides ${joinWords(owns[i].map((a) => AREA_NAMES[a]))}.`;
    return `${part.style.name} adds only an occasional signature move.`;
  });
  const priority =
    ordered.length === 1
      ? ''
      : `${roles.join(' ')} If two instructions seem to conflict, ${lead.name} wins.`;

  const seen = new Set<Genre>();
  const genres = ordered.flatMap(({ style }) => style.genres).filter((g) => {
    if (seen.has(g)) return false;
    seen.add(g);
    return true;
  });

  const weightLabels = new Map(BLEND_WEIGHTS.map((w) => [w.id, w.label.toLowerCase()]));
  const blend: CustomStyle = {
    id: '',
    kind: 'custom',
    name: blendName(parts),
    genres,
    summary: `A blend led by ${lead.name}: ${ordered
      .map(({ style, weight }) => `${weightLabels.get(weight)} ${style.name}`)
      .join(', ')}. ${lead.summary}`,
    traits,
    priority,
    namesAuthors: ordered.some(({ style }) => style.kind === 'author' || (style.kind === 'custom' && style.namesAuthors)),
  };

  // A local model should not get far more than a single style would give it, so areas give
  // up their second sentences until it fits, the lightest style's first and the lead's last.
  const lightestFirst = [...owns.slice(1).flat().reverse(), ...[...owns[0]].reverse()];
  for (const area of lightestFirst) {
    if (countWords(buildStylePrompt(blend)) <= BLEND_WORD_TARGET) break;
    traits[area] = firstSentence(traits[area]);
  }
  return blend;
}
