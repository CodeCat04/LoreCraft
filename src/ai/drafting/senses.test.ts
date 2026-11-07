import { getSchema } from '@tiptap/core';
import { Node as ProseNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import { documentExtensions } from '../../editor/schema';
import { applyHunks } from '../../editor/ai/hunks';
import {
  cleanOption,
  countOptions,
  freshOptions,
  joinOptions,
  MAX_PER_SENSE,
  moreRequest,
  parseOneSense,
  parseSenses,
  sensesInsertion,
  sentenceEndAfter,
} from './senses';

const schema = getSchema(documentExtensions());
const makeDoc = (...paragraphs: string[]) =>
  ProseNode.fromJSON(schema, { type: 'doc', content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

/** The position just after some text. */
function after(doc: ProseNode, needle: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(needle)) found = pos + node.text.indexOf(needle) + needle.length;
  });
  if (found < 0) throw new Error(`no "${needle}"`);
  return found;
}

const textOf = (doc: ProseNode) => doc.content.content.map((block) => block.textContent);

describe('parseSenses', () => {
  it('reads the JSON it asks for', () => {
    const parsed = parseSenses(JSON.stringify({
      sight: ['Lamplight pools on the cobbles.', 'Gulls wheel overhead.'],
      sound: ['A bell tolls twice.'],
      smell: ['Tar and wet rope.'],
      touch: ['The rail is slick with salt.'],
      taste: ['Brine on her lips.'],
      metaphor: ['The harbor breathes like a sleeping animal.'],
    }));
    expect(parsed.sight).toEqual(['Lamplight pools on the cobbles.', 'Gulls wheel overhead.']);
    expect(parsed.metaphor).toEqual(['The harbor breathes like a sleeping animal.']);
    expect(countOptions(parsed)).toBe(7);
  });

  it('is forgiving: fences, other names for the groups, nesting, objects and repeats', () => {
    const reply = 'Here you go:\n```json\n{"senses": {"Sights": [{"text": "Smoke over the roofs."}, "smoke over the roofs."], "Sounds": "A dog barks; a cart rattles", "Scent": ["- Wet ash"], "similes": ["Like a held breath."], "colour": ["ignored"]}}\n```';
    const parsed = parseSenses(reply);
    expect(parsed.sight).toEqual(['Smoke over the roofs.']);
    expect(parsed.sound).toEqual(['A dog barks', 'a cart rattles']);
    expect(parsed.smell).toEqual(['Wet ash']);
    expect(parsed.metaphor).toEqual(['Like a held breath.']);
    expect(parsed.touch).toEqual([]);
  });

  it('reads a list of tagged items', () => {
    const parsed = parseSenses('[{"sense": "taste", "option": "Iron in the air."}, {"category": "Touch", "text": "Cold stone."}]');
    expect(parsed.taste).toEqual(['Iron in the air.']);
    expect(parsed.touch).toEqual(['Cold stone.']);
  });

  it('falls back to prose with headings', () => {
    const reply = [
      '<think>Let me picture it.</think>',
      'Sure! Some ideas:',
      '',
      '**Sight:**',
      '- Lanterns sway on their hooks.',
      '- "Frost on the gate."',
      '## Sound',
      '1. Hooves on the bridge.',
      '2) A shutter bangs.',
      'Smell: woodsmoke; pine resin',
      '**Taste** - Ash on the tongue.',
      'Touch',
      '* Rough wool at her collar.',
      'Metaphor:',
      '- The gate stood like a judge.',
    ].join('\n');
    const parsed = parseSenses(reply);
    expect(parsed.sight).toEqual(['Lanterns sway on their hooks.', 'Frost on the gate.']);
    expect(parsed.sound).toEqual(['Hooves on the bridge.', 'A shutter bangs.']);
    expect(parsed.smell).toEqual(['woodsmoke', 'pine resin']);
    expect(parsed.taste).toEqual(['Ash on the tongue.']);
    expect(parsed.touch).toEqual(['Rough wool at her collar.']);
    expect(parsed.metaphor).toEqual(['The gate stood like a judge.']);
  });

  it('finds nothing in prose with no groups, rather than guessing', () => {
    expect(countOptions(parseSenses('I cannot help with that.'))).toBe(0);
    expect(countOptions(parseSenses(''))).toBe(0);
  });

  it('keeps no more than a few in each group', () => {
    const parsed = parseSenses(JSON.stringify({ sight: Array.from({ length: 9 }, (_, i) => `Thing ${i}.`) }));
    expect(parsed.sight).toHaveLength(MAX_PER_SENSE);
  });

  it('reads a reply about one sense, in any of the shapes it may take', () => {
    expect(parseOneSense('{"smell": ["Rain on dust."]}', 'smell')).toEqual(['Rain on dust.']);
    expect(parseOneSense('{"options": ["Rain on dust."]}', 'smell')).toEqual(['Rain on dust.']);
    expect(parseOneSense('["Rain on dust.", "Old leather."]', 'smell')).toEqual(['Rain on dust.', 'Old leather.']);
    expect(parseOneSense('{"scents": ["Rain on dust."]}', 'smell')).toEqual(['Rain on dust.']);
    expect(parseOneSense('Here are more:\n- Rain on dust.\n- Old leather.', 'smell')).toEqual(['Rain on dust.', 'Old leather.']);
  });
});

describe('choosing and inserting', () => {
  it('cleans an option the way a person would write it', () => {
    expect(cleanOption('  - **Frost on the gate.**  ')).toBe('Frost on the gate.');
    expect(cleanOption('“A cold wind.”')).toBe('A cold wind.');
    expect(cleanOption('"She said "no" twice."')).toBe('"She said "no" twice."');
  });

  it('leaves out what is already shown', () => {
    expect(freshOptions(['A bell.', 'A dog.'], ['a bell.', 'A cart.'])).toEqual(['A cart.']);
  });

  it('asks for more of one sense, different from what is shown', () => {
    const ask = moreRequest('sound', ['A bell tolls.']);
    expect(ask).toMatch(/sound only/);
    expect(ask).toMatch(/- A bell tolls\./);
    expect(ask).toMatch(/\{"sound": \["\.\.\."\]\}/);
  });

  it('joins the ticked options into sentences', () => {
    expect(joinOptions(['lamplight on the cobbles', 'A bell tolls twice.', '  the rail is cold!  ', ''])).toBe(
      'Lamplight on the cobbles. A bell tolls twice. The rail is cold!',
    );
    expect(joinOptions(['"Stay," she said."'])).toBe('"Stay," she said."');
  });

  it('goes straight after a selection that ends a sentence', () => {
    const doc = makeDoc('She reached the gate. The guards slept.');
    const at = after(doc, 'gate.');
    expect(sentenceEndAfter(doc, at)).toBe(at);
    const hunks = sensesInsertion(doc, at, 'Frost on the bars.');
    expect(textOf(applyHunks(doc, hunks).doc)).toEqual(['She reached the gate. Frost on the bars. The guards slept.']);
  });

  it('goes after the sentence a selection ends inside, so none is cut in half', () => {
    const doc = makeDoc('She reached the gate at dusk. The guards slept.');
    const hunks = sensesInsertion(doc, after(doc, 'the gate'), 'Frost on the bars.');
    expect(textOf(applyHunks(doc, hunks).doc)).toEqual(['She reached the gate at dusk. Frost on the bars. The guards slept.']);
  });

  it('adds to the end of a paragraph, with a space, as one change', () => {
    const doc = makeDoc('She reached the gate.', 'Next.');
    const hunks = sensesInsertion(doc, after(doc, 'gate.'), 'Frost on the bars. A crow called.');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].from).toBe(hunks[0].to);
    expect(textOf(applyHunks(doc, hunks).doc)).toEqual(['She reached the gate. Frost on the bars. A crow called.', 'Next.']);
  });

  it('adds nothing for nothing', () => {
    const doc = makeDoc('She reached the gate.');
    expect(sensesInsertion(doc, after(doc, 'gate.'), '  ')).toEqual([]);
  });
});
