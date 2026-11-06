import {
  ageAt,
  ageFactAt,
  ageFactFromFields,
  allFieldValues,
  changeApplies,
  changeInEffect,
  changeIsPlaced,
  fieldValueAt,
  formatAge,
  formatDeath,
  normalizeChanges,
  orderedChanges,
  type MomentResolver,
} from './facts';
import { parseStoryDate, type Calendar, type Era } from './storyDate';
import type { InfoboxField } from './types';

const resolve: MomentResolver = {
  nodeOrder: (id) => ({ ch1: 1, ch10: 10, ch20: 20 } as Record<string, number>)[id] ?? null,
  dateSort: (date) => (/^\d+$/.test(date) ? Number(date) : null),
};

function field(changes: InfoboxField['changes']): InfoboxField {
  return { key: 'hair', label: 'Hair', kind: 'text', value: 'blonde', changes };
}

describe('fieldValueAt', () => {
  const hair = field([
    { nodeId: 'ch10', value: 'black', note: 'Dyed it to hide' },
    { nodeId: 'ch20', value: 'grey' },
  ]);

  it('gives the starting value before any change', () => {
    expect(fieldValueAt(hair, { nodeOrder: 1 }, resolve)).toBe('blonde');
  });

  it('gives the latest change by that point', () => {
    expect(fieldValueAt(hair, { nodeOrder: 10 }, resolve)).toBe('black');
    expect(fieldValueAt(hair, { nodeOrder: 15 }, resolve)).toBe('black');
    expect(fieldValueAt(hair, { nodeOrder: 25 }, resolve)).toBe('grey');
  });

  it('works for a field that has never changed', () => {
    expect(fieldValueAt(field(undefined), { nodeOrder: 5 }, resolve)).toBe('blonde');
  });

  it('prefers in-world dates, since scenes can be told out of order', () => {
    const rank = field([{ nodeId: 'ch20', date: '300', value: 'Knight' }]);
    expect(fieldValueAt(rank, { nodeOrder: 1, dateSort: 310 }, resolve)).toBe('Knight');
    expect(fieldValueAt(rank, { nodeOrder: 25, dateSort: 290 }, resolve)).toBe('blonde');
  });

  it('falls back to reading order when a date cannot be used', () => {
    const rank = field([{ nodeId: 'ch10', date: 'the long winter', value: 'Knight' }]);
    expect(fieldValueAt(rank, { nodeOrder: 11, dateSort: 310 }, resolve)).toBe('Knight');
  });

  it('applies changes in story order, whatever order they were entered in', () => {
    const rank = field([
      { nodeId: 'ch20', value: 'Lord' },
      { nodeId: 'ch10', value: 'Knight' },
    ]);
    expect(fieldValueAt(rank, { nodeOrder: 25 }, resolve)).toBe('Lord');
  });
});

describe('changeApplies', () => {
  it('does not treat a change as having happened when nothing places it', () => {
    expect(changeApplies({ value: 'x' }, { nodeOrder: 5 }, resolve)).toBe(false);
    expect(changeApplies({ nodeId: 'deleted', value: 'x' }, { nodeOrder: 5 }, resolve)).toBe(false);
    expect(changeApplies({ nodeId: 'ch1', value: 'x' }, {}, resolve)).toBe(false);
  });
});

describe('allFieldValues', () => {
  it('lists each value once and skips blanks', () => {
    const hair = field([{ nodeId: 'ch10', value: 'black' }, { nodeId: 'ch20', value: 'blonde' }, { value: ' ' }]);
    expect(allFieldValues(hair)).toEqual(['blonde', 'black']);
  });
});

describe('changes in a scene with a date of its own', () => {
  const withSceneDates: MomentResolver = {
    ...resolve,
    nodeDateSort: (id) => ({ ch10: 312, ch20: 300 } as Record<string, number>)[id] ?? null,
  };

  it('happen on that date, so a flashback told later sees the old value', () => {
    const hair = field([{ nodeId: 'ch10', value: 'black' }]);
    expect(fieldValueAt(hair, { nodeOrder: 15, dateSort: 310 }, withSceneDates)).toBe('blonde');
    expect(fieldValueAt(hair, { nodeOrder: 15, dateSort: 312 }, withSceneDates)).toBe('black');
  });

  it('still go by reading order for a scene with no date', () => {
    const hair = field([{ nodeId: 'ch10', value: 'black' }]);
    expect(fieldValueAt(hair, { nodeOrder: 15 }, withSceneDates)).toBe('black');
    expect(fieldValueAt(hair, { nodeOrder: 5 }, withSceneDates)).toBe('blonde');
  });

  it('let a written date win over the scene date', () => {
    const hair = field([{ nodeId: 'ch10', date: '200', value: 'black' }]);
    expect(fieldValueAt(hair, { nodeOrder: 5, dateSort: 250 }, withSceneDates)).toBe('black');
  });

  it('put a flashback in date order among the changes', () => {
    const rank = field([{ nodeId: 'ch10', value: 'Lord' }, { nodeId: 'ch20', value: 'Knight' }]);
    expect(orderedChanges(rank, withSceneDates).map((c) => c.value)).toEqual(['Knight', 'Lord']);
    expect(fieldValueAt(rank, { nodeOrder: 25, dateSort: 320 }, withSceneDates)).toBe('Lord');
  });
});

describe('orderedChanges and changeInEffect', () => {
  it('leaves what nothing places at the end, in the order written', () => {
    const rank = field([
      { value: 'first unplaced' },
      { nodeId: 'ch20', value: 'Lord' },
      { nodeId: 'deleted', value: 'second unplaced' },
      { nodeId: 'ch10', value: 'Knight' },
    ]);
    expect(orderedChanges(rank, resolve).map((c) => c.value)).toEqual(['Knight', 'Lord', 'first unplaced', 'second unplaced']);
  });

  it('orders by date when both have one, even against reading order', () => {
    const rank = field([{ nodeId: 'ch10', date: '300', value: 'later' }, { nodeId: 'ch20', date: '200', value: 'earlier' }]);
    expect(orderedChanges(rank, resolve).map((c) => c.value)).toEqual(['earlier', 'later']);
  });

  it('says which change gave the value', () => {
    const rank = field([{ nodeId: 'ch10', value: 'Knight' }]);
    expect(changeInEffect(rank, { nodeOrder: 1 }, resolve)).toBeNull();
    expect(changeInEffect(rank, { nodeOrder: 10 }, resolve)?.value).toBe('Knight');
  });

  it('knows when nothing places a change', () => {
    expect(changeIsPlaced({ value: 'x' }, resolve)).toBe(false);
    expect(changeIsPlaced({ value: 'x', date: 'the long winter' }, resolve)).toBe(false);
    expect(changeIsPlaced({ value: 'x', nodeId: 'deleted' }, resolve)).toBe(false);
    expect(changeIsPlaced({ value: 'x', nodeId: 'ch10' }, resolve)).toBe(true);
    expect(changeIsPlaced({ value: 'x', date: '300' }, resolve)).toBe(true);
  });
});

describe('normalizeChanges', () => {
  it('keeps what is good and drops the rest', () => {
    expect(normalizeChanges([
      { nodeId: 'a', date: '312', value: 'x', note: 'n', extra: 1 },
      { value: 7 },
      {},
      null,
      'nonsense',
      { nodeId: null, date: null, note: '', value: 'y' },
    ])).toEqual([
      { nodeId: 'a', date: '312', value: 'x', note: 'n' },
      { value: '7' },
      { value: '' },
      { value: 'y' },
    ]);
  });

  it('gives nothing when there is nothing', () => {
    expect(normalizeChanges(undefined)).toBeUndefined();
    expect(normalizeChanges('x')).toBeUndefined();
    expect(normalizeChanges([])).toBeUndefined();
  });
});

describe('ageAt', () => {
  const calendar: Calendar = {
    months: [
      { name: 'Thawing', days: 30 },
      { name: 'Frostmoot', days: 30 },
    ],
  };
  const eras: Era[] = [{ name: 'AE', offset: 0 }, { name: 'BE', offset: 0, negative: true }];

  it('counts years between plain dates', () => {
    expect(ageAt('290', '312')).toBe(22);
    expect(ageAt('Year 290', 'Year 312')).toBe(22);
  });

  it('takes a moment as well as a written date', () => {
    expect(ageAt('290', { dateSort: parseStoryDate('312') })).toBe(22);
    expect(ageAt('290-06', { dateSort: parseStoryDate('312-09') })).toBeCloseTo(22.25, 10);
  });

  it('is fractional when months and days are known', () => {
    expect(ageAt('1 Thawing 300', '1 Frostmoot 312', { calendar })).toBe(12.5);
    expect(ageAt('300-01-01', '312-07-01')).toBe(12.5);
    expect(ageAt('16 Frostmoot 290', '15 Frostmoot 312', { calendar })!).toBeLessThan(22);
  });

  it('crosses eras', () => {
    expect(ageAt('40 BE', '12 AE', { eras })).toBe(52);
    expect(ageAt('Thawing 40 BE', 'Thawing 12 AE', { eras, calendar })).toBe(52);
  });

  it('returns null rather than guessing', () => {
    expect(ageAt('', '312')).toBeNull();
    expect(ageAt(null, '312')).toBeNull();
    expect(ageAt(undefined, '312')).toBeNull();
    expect(ageAt('290', '')).toBeNull();
    expect(ageAt('290', null)).toBeNull();
    expect(ageAt('290', {})).toBeNull();
    expect(ageAt('290', { nodeOrder: 5, dateSort: null })).toBeNull();
    expect(ageAt('the long winter', '312')).toBeNull();
    expect(ageAt('290', 'the long winter')).toBeNull();
    expect(ageAt('290 AE', '312')).toBeNull();
    expect(ageAt('15 Frostmoot 290', '312')).toBeNull();
  });

  it('does not work out an age from a date the story has only reached', () => {
    expect(ageAt('290', { dateSort: 312, dateInferred: true })).toBeNull();
  });

  it('returns null before they are born', () => {
    expect(ageAt('320', '312')).toBeNull();
    expect(ageFactAt('320', '312')).toEqual({ state: 'unborn', born: '320' });
    expect(ageFactAt('312-06-15', '312-03-01')).toEqual({ state: 'unborn', born: '312-06-15' });
  });

  it('allows that a year alone could be either side of a date in that year', () => {
    expect(ageAt('312', '312-03')).toBe(0);
    expect(ageAt('312-06', '312')).toBe(0);
  });

  it('returns null once they have died, and says when', () => {
    expect(ageAt('290', '312', { died: '312' })).toBeNull();
    expect(ageAt('290', '320', { died: '312' })).toBeNull();
    expect(ageAt('290', '311', { died: '312' })).toBe(21);
    expect(ageFactAt('290', '320', { died: '312' })).toEqual({ state: 'dead', died: '312', ageAtDeath: 22 });
    expect(ageFactAt('', '320', { died: '312' })).toEqual({ state: 'dead', died: '312', ageAtDeath: null });
    expect(ageFactAt('the long winter', '320', { died: '312' })).toEqual({ state: 'dead', died: '312', ageAtDeath: null });
  });

  it('does not count a death it cannot place', () => {
    expect(ageAt('290', '312', { died: 'the long winter' })).toBe(22);
    expect(ageAt('290', '312', { died: '  ' })).toBe(22);
    expect(ageAt('290', 'the long winter', { died: '312' })).toBeNull();
  });

  it('uses the calendar for a death date', () => {
    const options = { calendar, died: '15 Frostmoot 312' };
    expect(ageAt('300', '14 Frostmoot 312', options)).toBe(12);
    expect(ageAt('300', '15 Frostmoot 312', options)).toBeNull();
  });
});

describe('ageFactFromFields', () => {
  const dated = (key: string, value: string, changes?: InfoboxField['changes']): InfoboxField => ({ key, label: key, kind: 'date', value, changes });

  it('reads the semantic fields', () => {
    expect(ageFactFromFields([dated('born', '290')], { dateSort: 312 }, resolve, {})).toEqual({ state: 'alive', years: 22 });
    expect(ageFactFromFields([], { dateSort: 312 }, resolve, {})).toEqual({ state: 'unknown' });
  });

  it('follows a death that a change records', () => {
    const fields = [dated('born', '290'), dated('died', '', [{ nodeId: 'ch20', date: '312', value: '312' }])];
    expect(ageFactFromFields(fields, { nodeOrder: 10, dateSort: 311 }, resolve, {})).toEqual({ state: 'alive', years: 21 });
    expect(ageFactFromFields(fields, { nodeOrder: 25, dateSort: 320 }, resolve, {}).state).toBe('dead');
  });
});

describe('formatAge and formatDeath', () => {
  it('counts completed years', () => {
    expect(formatAge(22)).toBe('22');
    expect(formatAge(21.99)).toBe('21');
    expect(formatAge(0.5)).toBe('under a year');
    expect(formatAge(0)).toBe('under a year');
  });

  it('says how they died by how exact the date is', () => {
    const calendar: Calendar = { months: [{ name: 'Frostmoot', days: 30 }] };
    expect(formatDeath('312', null)).toBe('Died in 312');
    expect(formatDeath('312', 22)).toBe('Died in 312, aged 22');
    expect(formatDeath('312', 21.99)).toBe('Died in 312, aged 21');
    expect(formatDeath('312', 0.5)).toBe('Died in 312');
    expect(formatDeath('Frostmoot 312', null, { calendar })).toBe('Died in Frostmoot 312');
    expect(formatDeath('15 Frostmoot 312', null, { calendar })).toBe('Died on 15 Frostmoot 312');
    expect(formatDeath('312-04-15', null)).toBe('Died on 312-04-15');
  });
});
