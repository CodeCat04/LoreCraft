/**
 * Describe with the senses: short options for a selected moment, under Sight, Sound, Smell,
 * Touch, Taste and Metaphor, drawn from the lore about what is there. The writer ticks the
 * ones they like, and those go in after the selection as one tracked change.
 *
 * One request gets every group. Small local models get the JSON wrong, or answer in prose,
 * so the reply is read loosely and nothing here asks again on its own.
 */

import { Fragment, Slice, type Node as ProseNode } from '@tiptap/pm/model';

import { computeInsertion, isProtected, type Hunk } from '../../editor/ai/hunks';
import { extractJson } from '../json';
import { READING_THE_MATERIAL } from '../prompts';

export const SENSES = ['sight', 'sound', 'smell', 'touch', 'taste', 'metaphor'] as const;
export type Sense = (typeof SENSES)[number];
export type SenseOptions = Record<Sense, string[]>;

/** No more than this in one group, however many come back. */
export const MAX_PER_SENSE = 5;

const ALIASES: Record<string, Sense> = {
  sight: 'sight', sights: 'sight', see: 'sight', seeing: 'sight', look: 'sight', looks: 'sight', visual: 'sight', visuals: 'sight', vision: 'sight',
  sound: 'sound', sounds: 'sound', hear: 'sound', hearing: 'sound', audio: 'sound', noise: 'sound', noises: 'sound',
  smell: 'smell', smells: 'smell', scent: 'smell', scents: 'smell', odor: 'smell', odors: 'smell', odour: 'smell', odours: 'smell',
  touch: 'touch', touches: 'touch', feel: 'touch', feeling: 'touch', texture: 'touch', textures: 'touch', tactile: 'touch',
  taste: 'taste', tastes: 'taste', flavor: 'taste', flavour: 'taste',
  metaphor: 'metaphor', metaphors: 'metaphor', simile: 'metaphor', similes: 'metaphor', comparison: 'metaphor', comparisons: 'metaphor', figurative: 'metaphor', image: 'metaphor', imagery: 'metaphor',
};

export function emptyOptions(): SenseOptions {
  return { sight: [], sound: [], smell: [], touch: [], taste: [], metaphor: [] };
}

function senseOf(key: string): Sense | null {
  return ALIASES[key.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

/** One option as the writer will read it: no bullet, number, quotes or bold around it. */
export function cleanOption(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text.replace(/^(?:[-*•–—]+|\d+[.)]|[a-z][.)])\s+/i, '');
  text = text.replace(/^(\*\*|__)(.*)\1$/, '$2').trim();
  const open = text[0];
  const close = text[text.length - 1];
  if (text.length > 1 && ((open === '"' && close === '"') || (open === '“' && close === '”')) && !/["“”]/.test(text.slice(1, -1))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function optionText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['text', 'option', 'value', 'detail', 'description', 'sentence']) {
      if (typeof object[key] === 'string') return object[key] as string;
    }
  }
  return null;
}

function add(into: SenseOptions, sense: Sense, values: unknown): void {
  const list = Array.isArray(values) ? values : typeof values === 'string' ? values.split(/\n|;\s*/) : [values];
  for (const value of list) {
    const text = optionText(value);
    if (!text) continue;
    const clean = cleanOption(text);
    if (!clean || into[sense].length >= MAX_PER_SENSE) continue;
    if (into[sense].some((other) => other.toLowerCase() === clean.toLowerCase())) continue;
    into[sense].push(clean);
  }
}

function fromJson(value: unknown): SenseOptions {
  const out = emptyOptions();
  if (Array.isArray(value)) {
    // A list of {"sense": "sight", "text": "..."} items.
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const object = item as Record<string, unknown>;
      const key = [object.sense, object.category, object.type, object.group].find((k) => typeof k === 'string') as string | undefined;
      const sense = key ? senseOf(key) : null;
      if (sense) add(out, sense, object.options ?? object.items ?? optionText(item));
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    // Some models nest the groups one level down.
    const inner = ['senses', 'options', 'details'].map((k) => object[k]).find((v) => v && typeof v === 'object' && !Array.isArray(v));
    for (const [key, values] of Object.entries((inner as Record<string, unknown>) ?? object)) {
      const sense = senseOf(key);
      if (sense) add(out, sense, values);
    }
  }
  return out;
}

/** "Sight", "## Sound", "**Smell:** ...", "- Touch - ...": a word alone, or a word and then a colon or dash. */
const HEADING = /^\s*(?:#{1,6}\s*)?(?:[-*•]\s*)?(?:\*\*|__)?\s*([A-Za-z]+)\s*(?:\*\*|__)?\s*(?:(?::|-|–|—)\s*(?:\*\*|__)?\s*(.*))?$/;

/** Reads groups written as prose: a "Sight:" line, then options under it or after it. */
function fromProse(text: string): SenseOptions {
  const out = emptyOptions();
  let current: Sense | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const heading = HEADING.exec(line);
    const sense = heading ? senseOf(heading[1]) : null;
    if (heading && sense) {
      current = sense;
      if (heading[2]?.trim()) add(out, current, heading[2]);
      continue;
    }
    if (current) add(out, current, line);
  }
  return out;
}

/** Every option in a reply, by sense. JSON if there is any, prose otherwise. */
export function parseSenses(reply: string): SenseOptions {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, '');
  const json = extractJson(text);
  if (json) {
    const parsed = fromJson(json.value);
    if (countOptions(parsed) > 0) return parsed;
  }
  return fromProse(text);
}

/**
 * The options for one sense, from a reply asked for that sense alone. Any group the reply
 * uses counts, and so does a bare list.
 */
export function parseOneSense(reply: string, sense: Sense): string[] {
  const parsed = parseSenses(reply);
  if (parsed[sense].length > 0) return parsed[sense];
  const others = SENSES.filter((s) => parsed[s].length > 0);
  if (others.length === 1) return parsed[others[0]];
  const out = emptyOptions();
  const json = extractJson(reply);
  if (json && Array.isArray(json.value)) add(out, sense, json.value);
  else if (json && json.value && typeof json.value === 'object') {
    const list = Object.values(json.value as Record<string, unknown>).find(Array.isArray);
    if (list) add(out, sense, list);
  }
  if (out[sense].length === 0 && !json) {
    add(out, sense, reply.replace(/<think>[\s\S]*?<\/think>/g, '').split(/\r?\n/).filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)));
  }
  return out[sense];
}

export function countOptions(options: SenseOptions): number {
  return SENSES.reduce((sum, sense) => sum + options[sense].length, 0);
}

/** Options that are not already shown. */
export function freshOptions(have: string[], incoming: string[]): string[] {
  const seen = new Set(have.map((text) => text.toLowerCase()));
  return incoming.filter((text) => !seen.has(text.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Inserting
// ---------------------------------------------------------------------------

/** The ticked options as prose: each a sentence, in the order they are listed. */
export function joinOptions(options: string[]): string {
  return options
    .map((option) => option.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((option) => {
      const first = option[0].toUpperCase() + option.slice(1);
      return /[.!?…]["'”’)\]]*$/.test(first) ? first : `${first}.`;
    })
    .join(' ');
}

const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s|$)/;

/**
 * Where the new sentences go: straight after the selection if it ends a sentence,
 * otherwise after the sentence it ends in, so none is cut in half.
 */
export function sentenceEndAfter(doc: ProseNode, position: number): number {
  const $pos = doc.resolve(position);
  const parent = $pos.parent;
  if (!parent.isTextblock) return position;
  const before = parent.textBetween(0, $pos.parentOffset, undefined, '￼');
  const rest = parent.textBetween($pos.parentOffset, parent.content.size, undefined, '￼');
  if (rest.trim() === '' || /[.!?…]["'”’)\]]*$/.test(before.trimEnd())) return position;
  const match = SENTENCE_END.exec(rest);
  return match ? position + match.index + match[0].length : position + rest.length;
}

let nextId = 0;

/** One change that adds the sentences after the selection, in the same paragraph where it can. */
export function sensesInsertion(doc: ProseNode, position: number, text: string): Hunk[] {
  if (!text.trim()) return [];
  const $pos = doc.resolve(position);
  let protectedHere = false;
  for (let depth = 1; depth <= $pos.depth; depth += 1) if (isProtected($pos.node(depth))) protectedHere = true;
  // A caption or something else that is not plain text gets new blocks after it instead.
  if (protectedHere || !$pos.parent.isTextblock || $pos.parent.type.name !== 'paragraph') return computeInsertion(doc, position, text);

  const at = sentenceEndAfter(doc, position);
  const $at = doc.resolve(at);
  const before = $at.parent.textBetween(0, $at.parentOffset, undefined, '￼');
  const after = $at.parent.textBetween($at.parentOffset, $at.parent.content.size, undefined, '￼');
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';
  const trail = after !== '' && !/^\s/.test(after) ? ' ' : '';
  nextId += 1;
  const node = doc.type.schema.text(`${lead}${text.trim()}${trail}`);
  return [{ id: `senses${nextId}`, from: at, to: at, slice: new Slice(Fragment.from(node), 0, 0) }];
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

export const SENSES_SYSTEM = `You suggest sensory details for a moment in a novel, in LoreCraft, where the novelist keeps a wiki of their invented world beside their manuscript. The moment is in a <selection> block.

${READING_THE_MATERIAL}

How to answer:
- Reply with JSON only, like {"sight": ["..."], "sound": ["..."], "smell": ["..."], "touch": ["..."], "taste": ["..."], "metaphor": ["..."]}.
- Each option is one short sentence, under 15 words, that could follow the selection, in its tense and point of view.
- Use the lore: what the places, people and objects there look, sound, smell and feel like. Do not contradict it.
- "metaphor" holds comparisons: a simile or metaphor for something in the moment.`;

/** The request for every group at once. */
export function sensesRequest(): string {
  return 'Give 3 or 4 options for each of sight, sound, smell, touch, taste and metaphor, for this moment. Reply with only the JSON.';
}

/** The request for more of one group, different from those already shown. */
export function moreRequest(sense: Sense, shown: string[]): string {
  const list = shown.length > 0 ? `\nDifferent from these:\n${shown.map((text) => `- ${text}`).join('\n')}` : '';
  return `Give 4 new options for ${sense} only, for this moment.${list}\nReply with only JSON like {"${sense}": ["..."]}.`;
}
