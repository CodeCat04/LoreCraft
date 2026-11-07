import { describe, expect, it } from 'vitest';

import { extractJson } from '../ai/json';
import {
  beatsToApply,
  buildCreationPlan,
  chaptersFromBeats,
  emptyPlan,
  mergeSuggestions,
  parseEntities,
  parseOutline,
  parseStored,
  resolveName,
  type PlanEntity,
  type PlanState,
} from './plan';
import { structureById, structures } from './templates';

describe('structure templates', () => {
  const list = structures();

  it('has the seven structures', () => {
    expect(list.map((s) => s.id)).toEqual(['threeAct', 'herosJourney', 'storyCircle', 'sevenPoint', 'beatSheet', 'romance', 'mystery']);
    expect(structureById('mystery')?.name).toBe('Mystery');
    expect(structureById('nope')).toBeUndefined();
    expect(structureById(null)).toBeUndefined();
  });

  it('gives every beat a name, guidance and a rising position from 0 to 100', () => {
    for (const s of list) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.beats.length).toBeGreaterThanOrEqual(5);
      const names = new Set(s.beats.map((b) => b.name));
      expect(names.size).toBe(s.beats.length);
      let last = -1;
      for (const b of s.beats) {
        expect(b.guidance.length).toBeGreaterThan(5);
        expect(b.at).toBeGreaterThan(last);
        expect(b.at).toBeLessThanOrEqual(100);
        last = b.at;
      }
      expect(s.beats[0].at).toBe(0);
    }
  });

  it('makes one chapter with an empty scene per beat', () => {
    const beats = structureById('storyCircle')!.beats;
    const chapters = chaptersFromBeats(beats);
    expect(chapters).toHaveLength(beats.length);
    expect(chapters[0].title).toBe(beats[0].name);
    expect(chapters[0].synopsis).toBe(beats[0].guidance);
    expect(chapters[0].scenes).toHaveLength(1);
  });

  it('leaves out beats a book already has a chapter for', () => {
    const beats = structureById('threeAct')!.beats;
    const rows = beatsToApply(beats, ['  midpoint ', 'Something else']);
    expect(rows.find((r) => r.beat.name === 'Midpoint')?.wanted).toBe(false);
    expect(rows.filter((r) => r.wanted)).toHaveLength(beats.length - 1);
  });
});

describe('reading model replies', () => {
  it('reads an outline from a tidy reply', () => {
    const chapters = parseOutline({
      chapters: [
        { title: 'The Gate', synopsis: 'Aria finds the gate open.', scenes: [{ title: 'Dawn', synopsis: 'She wakes.', pov: 'Aria', cast: ['Aria', 'Bren'] }] },
      ],
    });
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('The Gate');
    expect(chapters[0].scenes[0]).toMatchObject({ title: 'Dawn', synopsis: 'She wakes.', pov: 'Aria', cast: ['Aria', 'Bren'] });
  });

  it('reads an outline from the messy JSON a small model writes', () => {
    const reply = 'Sure! Here it is:\n```json\n{"outline": [{"name": "One", "summary": "Start", "scenes": ["A scene with no title", {"name": "B", "description": "Then this", "characters": "Aria, Bren"}],},]}\n```';
    const value = extractJson(reply)?.value;
    const chapters = parseOutline(value);
    expect(chapters[0].title).toBe('One');
    expect(chapters[0].synopsis).toBe('Start');
    expect(chapters[0].scenes[0].synopsis).toBe('A scene with no title');
    expect(chapters[0].scenes[0].title).toBe('1');
    expect(chapters[0].scenes[1]).toMatchObject({ title: 'B', synopsis: 'Then this', cast: ['Aria', 'Bren'] });
  });

  it('reads a bare array of chapters, and refuses a reply with none', () => {
    expect(parseOutline([{ title: 'Only' }])[0].scenes).toEqual([]);
    expect(() => parseOutline({ chapters: [] })).toThrow(/chapters/);
    expect(() => parseOutline('nothing')).toThrow();
  });

  it('reads characters and world items, keeping types to the allowed ones', () => {
    const list = parseEntities(
      { items: [{ name: 'Silver Gate', type: 'Place', role: 'The pass', description: 'Old.' }, { name: 'The Watch', type: 'spaceship' }, { name: 'silver gate' }, 'Lantern'] },
      ['place', 'faction', 'item'],
      'place',
    );
    expect(list.map((e) => e.name)).toEqual(['Silver Gate', 'The Watch', 'Lantern']);
    expect(list[0]).toMatchObject({ pageType: 'place', role: 'The pass', description: 'Old.' });
    expect(list[1].pageType).toBe('place');
    expect(() => parseEntities({ items: [] }, ['character'], 'character')).toThrow();
    expect(parseEntities({ characters: [{ title: 'Aria' }] }, ['character'], 'character')[0].name).toBe('Aria');
  });
});

describe('asking again', () => {
  const entity = (name: string, extra: Partial<PlanEntity> = {}): PlanEntity => ({ key: name, name, pageType: 'character', role: '', description: '', ...extra });

  it('keeps every entry the writer added or edited, replaces untouched suggestions, and skips repeated names', () => {
    const current = [
      entity('Aria', { touched: true, role: 'Edited by hand' }),
      entity('Old suggestion'),
      entity('Mira', { touched: true }),
      entity('Another old one'),
    ];
    const suggested = [entity('aria', { role: 'From the model' }), entity('Bren'), entity('  MIRA '), entity('Old suggestion'), entity('bren')];
    const merged = mergeSuggestions(current, suggested);
    expect(merged.map((e) => e.name)).toEqual(['Aria', 'Mira', 'Bren', 'Old suggestion']);
    expect(merged[0]).toEqual(current[0]);
    expect(merged[1]).toEqual(current[2]);
    expect(merged.slice(2).every((e) => !e.touched)).toBe(true);
  });

  it('keeps an empty entry the writer added', () => {
    const blank = entity('', { touched: true });
    expect(mergeSuggestions([blank], [entity('Bren')])).toEqual([blank, entity('Bren', { touched: undefined })]);
  });
});

describe('saved progress', () => {
  it('comes back as it was saved', () => {
    const plan: PlanState = { ...emptyPlan(), step: 'world', braindump: 'Ideas', structureId: 'romance', asked: ['synopsis'] };
    plan.characters = [{ key: 'a', name: 'Aria', pageType: 'character', role: 'Ranger', description: '', existingId: 'p1', touched: true }];
    plan.chapters = [{ key: 'c', title: 'One', synopsis: '', scenes: [{ key: 's', title: 'Dawn', synopsis: 'x', pov: 'Aria', cast: ['Aria'] }] }];
    const back = parseStored(JSON.stringify(plan));
    expect(back).toEqual(plan);
  });

  it('ignores damaged or unknown copies', () => {
    expect(parseStored(null)).toBeNull();
    expect(parseStored('{oops')).toBeNull();
    expect(parseStored('{"version": 2}')).toBeNull();
    expect(parseStored('{"version": 1, "step": "nowhere"}')?.step).toBe('braindump');
  });
});

describe('the creation plan', () => {
  const existing = [
    { id: 'p-aria', title: 'Aria Vale', aliases: ['Aria'], pageType: 'character' },
    { id: 'p-gate', title: 'Silver Gate', aliases: [], pageType: 'place' },
  ];

  function sample(): PlanState {
    return {
      ...emptyPlan(),
      synopsis: '  A ranger and a gate.  ',
      target: { kind: 'new', title: 'The Gate' },
      characters: [
        { key: '1', name: 'aria', pageType: 'character', role: 'Ranger', description: '' },
        { key: '2', name: 'Bren Holt', pageType: 'character', role: 'Smuggler', description: 'Charming.' },
        { key: '3', name: 'bren holt', pageType: 'character', role: 'Again', description: '' },
        { key: '4', name: '   ', pageType: 'character', role: 'No name', description: '' },
      ],
      world: [
        { key: '5', name: 'Silver Gate', pageType: 'place', role: '', description: '' },
        { key: '6', name: 'The Watch', pageType: 'faction', role: 'Guards', description: '' },
      ],
      chapters: [
        {
          key: 'c1',
          title: ' Arrival ',
          synopsis: 'They meet.',
          scenes: [
            { key: 's1', title: 'Dawn', synopsis: 'Bren arrives.', pov: 'Bren Holt', cast: ['Aria', 'Bren Holt', 'Aria', ' '] },
            { key: 's2', title: '', synopsis: '', pov: '', cast: [] },
          ],
        },
        { key: 'c2', title: '', synopsis: '', scenes: [] },
      ],
    };
  }

  it('makes each new name once, as a draft, and links names already in the wiki', () => {
    const plan = buildCreationPlan(sample(), existing);
    expect(plan.pages.map((p) => p.name)).toEqual(['Bren Holt', 'The Watch']);
    expect(plan.pages[0]).toMatchObject({ pageType: 'character', summary: 'Smuggler', description: 'Charming.' });
    expect(plan.pages[1].pageType).toBe('faction');
    expect(plan.linked).toEqual([
      { name: 'Aria Vale', pageId: 'p-aria' },
      { name: 'Silver Gate', pageId: 'p-gate' },
    ]);
    expect(plan.synopsis).toBe('A ranger and a gate.');
    expect(plan.target).toEqual({ kind: 'new', title: 'The Gate' });
  });

  it('keeps chapters and scenes with something in them, and tidies the cast', () => {
    const plan = buildCreationPlan(sample(), existing);
    expect(plan.chapters).toHaveLength(1);
    expect(plan.chapters[0].title).toBe('Arrival');
    expect(plan.chapters[0].scenes).toEqual([{ title: 'Dawn', synopsis: 'Bren arrives.', pov: 'Bren Holt', cast: ['Aria', 'Bren Holt'] }]);
  });

  it('finds point of view and cast among new pages first, then the wiki', () => {
    const made = new Map([['bren holt', 'new-bren']]);
    expect(resolveName('Bren  Holt', made, existing)).toBe('new-bren');
    expect(resolveName('Aria', made, existing)).toBe('p-aria');
    expect(resolveName('Nobody', made, existing)).toBeUndefined();
    expect(resolveName('', made, existing)).toBeUndefined();
  });

  it('links to the page an entry was matched with, even after a rename', () => {
    const state = sample();
    state.characters = [{ key: 'x', name: 'Old name', pageType: 'character', role: '', description: '', existingId: 'p-aria' }];
    state.world = [];
    const plan = buildCreationPlan(state, existing);
    expect(plan.pages).toEqual([]);
    expect(plan.linked).toEqual([{ name: 'Aria Vale', pageId: 'p-aria' }]);
  });
});
