import { vi } from 'vitest';

import { project } from './api';
import {
  calendarFor,
  explainStoryDate,
  formatStoryDate,
  getDateContext,
  getEras,
  parseCalendar,
  parseStoryDate,
  parseStoryDateParts,
  partsOfSort,
  storyYear,
  yearsBetween,
  type Calendar,
  type Era,
} from './storyDate';

const calendar: Calendar = {
  months: [
    { name: 'Thawing', days: 30 },
    { name: 'Greenmoot', days: 31 },
    { name: 'High Sun', days: 28 },
    { name: 'Frostmoot', days: 30 },
    { name: 'Frost', days: 10 },
  ],
};

const eras: Era[] = [
  { name: 'BE', offset: 0, negative: true },
  { name: 'AE', offset: 0 },
  { name: 'Third Age', offset: 5000 },
];

describe('named months', () => {
  it('reads a day, month and year, and a month and year', () => {
    expect(parseStoryDateParts('15 Frostmoot 312', [], calendar)).toEqual({ year: 312, month: 4, day: 15 });
    expect(parseStoryDateParts('Frostmoot 312', [], calendar)).toEqual({ year: 312, month: 4, day: 0 });
  });

  it('sorts exactly where the numbered form of the same date does', () => {
    expect(parseStoryDate('15 Frostmoot 312', [], calendar)).toBe(parseStoryDate('312-04-15', [], calendar));
    expect(parseStoryDate('Frostmoot 312', [], calendar)).toBe(parseStoryDate('312-04', [], calendar));
  });

  it('puts dates in order, within a month, across months and across years', () => {
    const inOrder = [
      '311',
      '312',
      'Thawing 312',
      '1 Thawing 312',
      '30 Thawing 312',
      '1 Greenmoot 312',
      'High Sun 312',
      'Frostmoot 312',
      '2 Frostmoot 312',
      '15 Frostmoot 312',
      '313',
    ];
    const sorted = [...inOrder].reverse().sort((a, b) => parseStoryDate(a, [], calendar)! - parseStoryDate(b, [], calendar)!);
    expect(sorted).toEqual(inOrder);
  });

  it('keeps the whole date inside its year', () => {
    expect(storyYear(parseStoryDate('30 Frostmoot 312', [], calendar)!)).toBe(312);
    expect(storyYear(parseStoryDate('10 Frost -40', [], calendar)!)).toBe(-40);
  });

  it('ignores case and spacing', () => {
    expect(parseStoryDate('  15   frostmoot   312 ', [], calendar)).toBe(parseStoryDate('312-04-15'));
    expect(parseStoryDate('15 FROSTMOOT 312', [], calendar)).toBe(parseStoryDate('312-04-15'));
    expect(parseStoryDate('3 high  sun 312', [], calendar)).toBe(parseStoryDate('312-03-03'));
  });

  it('prefers the longer name, and does not read a longer word as a month', () => {
    expect(parseStoryDateParts('5 Frost 312', [], calendar)?.month).toBe(5);
    expect(parseStoryDateParts('5 Frostmoot 312', [], calendar)?.month).toBe(4);
    expect(parseStoryDate('5 Frosty 312', [], calendar)).toBeNull();
    expect(parseStoryDate('5 Frostmoots 312', [], calendar)).toBeNull();
  });

  it('understands the other common ways of writing one', () => {
    const expected = parseStoryDate('312-04-15');
    for (const written of ['15th Frostmoot 312', '15th of Frostmoot 312', 'the 15th of Frostmoot, 312', 'Frostmoot 15, 312', '15 Frostmoot, 312', '15 Frostmoot Year 312']) {
      expect(parseStoryDate(written, [], calendar), written).toBe(expected);
    }
  });

  it('reads an era anywhere it can go', () => {
    expect(parseStoryDate('15 Frostmoot 312 AE', eras, calendar)).toBe(parseStoryDate('312-04-15'));
    expect(parseStoryDate('15 Frostmoot Third Age 3', eras, calendar)).toBeCloseTo(5003.0415, 8);
    expect(parseStoryDate('15 Frostmoot, Third Age 3', eras, calendar)).toBeCloseTo(5003.0415, 8);
    expect(parseStoryDate('Third Age 15 Frostmoot 3', eras, calendar)).toBeCloseTo(5003.0415, 8);
    expect(parseStoryDate('Frostmoot Third Age 3', eras, calendar)).toBeCloseTo(5003.04, 8);
  });

  it('runs months forward inside a year that counts backwards', () => {
    expect(parseStoryDate('Thawing 40 BE', eras, calendar)!).toBeLessThan(parseStoryDate('Frostmoot 40 BE', eras, calendar)!);
    expect(parseStoryDate('Frostmoot 40 BE', eras, calendar)!).toBeLessThan(parseStoryDate('39 BE', eras, calendar)!);
    expect(storyYear(parseStoryDate('Frostmoot 40 BE', eras, calendar)!)).toBe(-40);
  });

  it('tells a month from an era whose name it begins with', () => {
    const shared: Era[] = [{ name: 'Frost', offset: 1000 }];
    const months: Calendar = { months: [{ name: 'Frost Moon', days: 30 }] };
    expect(parseStoryDate('Frost 12', shared, months)).toBe(1012);
    expect(parseStoryDate('Frost Moon 12', shared, months)).toBeCloseTo(12.01, 8);
    expect(parseStoryDate('3 Frost Moon Frost 12', shared, months)).toBeCloseTo(1012.0103, 8);
  });
});

describe('returning null rather than guessing', () => {
  it('refuses a day the month does not have', () => {
    expect(parseStoryDate('31 Frostmoot 312', [], calendar)).toBeNull();
    expect(parseStoryDate('30 Frostmoot 312', [], calendar)).not.toBeNull();
    expect(parseStoryDate('11 Frost 312', [], calendar)).toBeNull();
    expect(parseStoryDate('0 Frostmoot 312', [], calendar)).toBeNull();
    expect(parseStoryDate('Frostmoot 0, 312', [], calendar)).toBeNull();
    expect(parseStoryDate('Frostmoot 31, 312', [], calendar)).toBeNull();
  });

  it('refuses what is not a date', () => {
    for (const text of ['Frostmoot', '15 Frostmoot', '15 Nomonth 312', 'Nomonth 312', 'Frostmoot of 312', '15 16 Frostmoot 312', 'Frostmoot 312 Greenmoot', '100 Frostmoot 312', '']) {
      expect(parseStoryDate(text, [], calendar), text).toBeNull();
    }
  });

  it('needs the calendar to read a month', () => {
    expect(parseStoryDate('15 Frostmoot 312')).toBeNull();
    expect(parseStoryDate('15 Frostmoot 312', [], null)).toBeNull();
    expect(parseStoryDate('15 Frostmoot 312', [], { months: [] })).toBeNull();
    expect(parseStoryDate('Frostmoot 312', eras)).toBeNull();
  });
});

describe('existing formats', () => {
  it('reads the same with or without a calendar', () => {
    const dates = ['312', '312-04-15', '312/4', '312.4.15', 'Year 312', '-40', '-40-02', '312 AE', '40 BE', '40-02 BE', 'Third Age 3', 'Third Age 3-04-15', 'year 7'];
    for (const date of dates) {
      expect(parseStoryDate(date, eras, calendar), date).toBe(parseStoryDate(date, eras));
    }
  });

  it('keeps numbered dates that go past the calendar, which is the writer to fix', () => {
    expect(parseStoryDate('312-40-99', [], calendar)).toBe(parseStoryDate('312-40-99'));
  });

  it('leaves two-argument calls as they were', () => {
    expect(parseStoryDate('12 AE', eras)).toBe(12);
    expect(parseStoryDate('the long winter', eras)).toBeNull();
    expect(parseStoryDate('sometime in 312', eras, calendar)).toBeNull();
    expect(parseStoryDate('the long winter', eras, calendar)).toBeNull();
  });
});

describe('formatStoryDate', () => {
  it('writes named months when the calendar has them', () => {
    expect(formatStoryDate(312.0415, [], calendar)).toBe('15 Frostmoot 312');
    expect(formatStoryDate(312.04, [], calendar)).toBe('Frostmoot 312');
    expect(formatStoryDate(312, [], calendar)).toBe('312');
    expect(formatStoryDate(312.0303, [], calendar)).toBe('3 High Sun 312');
  });

  it('writes numbers without a calendar', () => {
    expect(formatStoryDate(312.0415)).toBe('312-04-15');
    expect(formatStoryDate(312.04)).toBe('312-04');
    expect(formatStoryDate(312)).toBe('312');
    expect(formatStoryDate(-40.02)).not.toBe('');
  });

  it('writes the year in its era', () => {
    expect(formatStoryDate(312.0415, eras, calendar)).toBe('15 Frostmoot 312 AE');
    expect(formatStoryDate(5003.0415, eras, calendar)).toBe('15 Frostmoot Third Age 3');
    expect(formatStoryDate(parseStoryDate('Frostmoot 40 BE', eras, calendar)!, eras, calendar)).toBe('Frostmoot 40 BE');
    expect(formatStoryDate(312.0415, eras)).toBe('312-04-15 AE');
    expect(formatStoryDate(5003.0415, eras)).toBe('Third Age 3-04-15');
  });

  it('falls back to numbers for a month or day the calendar does not have', () => {
    expect(formatStoryDate(parseStoryDate('312-40-02')!, [], calendar)).toBe('312-40-02');
    expect(formatStoryDate(parseStoryDate('312-04-31')!, [], calendar)).toBe('312-04-31');
  });
});

describe('round trips', () => {
  const contexts: [string, Era[], Calendar | null][] = [
    ['no eras, no calendar', [], null],
    ['eras only', eras, null],
    ['a calendar only', [], calendar],
    ['eras and a calendar', eras, calendar],
  ];

  it.each(contexts)('every written date reads back to the same point: %s', (_name, usedEras, usedCalendar) => {
    const keys: number[] = [];
    for (const year of [-5000, -40, -1, 0, 1, 12, 312, 4999, 5000, 5003, 12345]) {
      keys.push(year);
      for (let month = 1; month <= 12; month += 1) {
        keys.push(year + month / 100);
        for (const day of [1, 2, 9, 10, 15, 28, 30, 31, 99]) keys.push(year + month / 100 + day / 10000);
      }
    }
    for (const key of keys) {
      const written = formatStoryDate(key, usedEras, usedCalendar);
      const back = parseStoryDate(written, usedEras, usedCalendar);
      expect(back, `${key} written as "${written}"`).not.toBeNull();
      expect(back!, `${key} written as "${written}"`).toBeCloseTo(key, 8);
      expect(formatStoryDate(back!, usedEras, usedCalendar)).toBe(written);
    }
  });

  it('takes a sort key apart exactly', () => {
    for (const [sort, parts] of [
      [312.0415, { year: 312, month: 4, day: 15 }],
      [312.04, { year: 312, month: 4, day: 0 }],
      [312, { year: 312, month: 0, day: 0 }],
      [-40 + 0.02, { year: -40, month: 2, day: 0 }],
      [5003.1231, { year: 5003, month: 12, day: 31 }],
      [312.9999, { year: 312, month: 99, day: 99 }],
    ] as const) {
      expect(partsOfSort(sort)).toEqual(parts);
    }
  });

  it('gives back every day of every month by name', () => {
    calendar.months.forEach((month) => {
      for (let day = 1; day <= month.days; day += 1) {
        const written = `${day} ${month.name} 312`;
        expect(formatStoryDate(parseStoryDate(written, [], calendar)!, [], calendar)).toBe(written);
      }
    });
  });
});

describe('explainStoryDate with a calendar', () => {
  it('says what is wrong with a month date', () => {
    expect(explainStoryDate('31 Frostmoot 312', [], calendar)).toContain('Frostmoot has 30 days');
    expect(explainStoryDate('15 Nomonth 312', [], calendar)).toContain('"Nomonth" is not a month');
    expect(explainStoryDate('Frostmoot', [], calendar)).toContain('Add a year');
    expect(explainStoryDate('15 Frostmoot', [], calendar)).toContain('Add a year');
  });

  it('allows for a mistyped month or era', () => {
    expect(explainStoryDate('Nomonth 312', [], calendar)).toContain('not a known era or month');
    expect(explainStoryDate('Nomonth 312')).toContain('not a known era.');
  });

  it('suggests the calendar form', () => {
    expect(explainStoryDate('the long winter', [], calendar)).toContain('15 Thawing 312');
    expect(explainStoryDate('the long winter')).not.toContain('Thawing');
  });
});

describe('parseCalendar', () => {
  it('reads what was stored, and tidies names', () => {
    expect(parseCalendar(JSON.stringify({ months: [{ name: '  High   Sun ', days: 30 }] }))).toEqual({
      months: [{ name: 'High Sun', days: 30 }],
    });
  });

  it('takes nothing rather than renumbering the months around a bad one', () => {
    for (const months of [
      [{ name: 'A', days: 30 }, { name: '', days: 30 }],
      [{ name: 'A', days: 30 }, { name: 'B', days: 0 }],
      [{ name: 'A', days: 30 }, { name: 'B', days: 100 }],
      [{ name: 'A', days: 30 }, { name: 'B', days: 1.5 }],
      [{ name: 'A', days: 30 }, { name: '12', days: 3 }],
      [{ name: 'A', days: 30 }, null],
      [],
    ]) {
      expect(parseCalendar(JSON.stringify({ months }))).toBeNull();
    }
    expect(parseCalendar(JSON.stringify({ months: new Array(100).fill({ name: 'A', days: 1 }) }))).toBeNull();
  });

  it('survives anything else', () => {
    expect(parseCalendar(null)).toBeNull();
    expect(parseCalendar('')).toBeNull();
    expect(parseCalendar('not json')).toBeNull();
    expect(parseCalendar('[]')).toBeNull();
    expect(parseCalendar('null')).toBeNull();
  });
});

describe('yearsBetween', () => {
  const at = (date: string) => parseStoryDateParts(date, [], calendar)!;

  it('counts whole years when a side gives only the year', () => {
    expect(yearsBetween(at('290'), at('312'), calendar)).toBe(22);
    expect(yearsBetween(at('290'), at('15 Frostmoot 312'), calendar)).toBe(22);
    expect(yearsBetween(at('15 Frostmoot 290'), at('312'), calendar)).toBe(22);
  });

  it('is exact on the day itself', () => {
    expect(yearsBetween(at('15 Frostmoot 290'), at('15 Frostmoot 312'), calendar)).toBe(22);
  });

  it('counts months and days by the calendar', () => {
    // The months hold 30, 31, 28, 30 and 10 days, 129 in all.
    expect(yearsBetween(at('1 Thawing 290'), at('1 Greenmoot 290'), calendar)).toBeCloseTo(30 / 129, 10);
    expect(yearsBetween(at('1 Thawing 290'), at('1 High Sun 291'), calendar)).toBeCloseTo(1 + 61 / 129, 10);
    expect(yearsBetween(at('1 Greenmoot 290'), at('1 Thawing 291'), calendar)).toBeCloseTo(1 - 30 / 129, 10);
  });

  it('never rounds up past a birthday', () => {
    const before = yearsBetween(at('16 Frostmoot 290'), at('15 Frostmoot 312'), calendar);
    expect(before).toBeLessThan(22);
    expect(Math.floor(before)).toBe(21);
    expect(Math.floor(yearsBetween(at('16 Frostmoot 290'), at('16 Frostmoot 312'), calendar))).toBe(22);
  });

  it('works to the month when a side gives no day', () => {
    expect(yearsBetween(at('Frostmoot 290'), at('15 Frostmoot 312'), calendar)).toBe(22);
    expect(yearsBetween(at('15 Frostmoot 290'), at('Frostmoot 312'), calendar)).toBe(22);
    expect(yearsBetween(at('Frostmoot 290'), at('Greenmoot 312'), calendar)).toBeLessThan(22);
  });

  it('runs negative when the order is reversed', () => {
    expect(yearsBetween(at('15 Frostmoot 312'), at('14 Frostmoot 312'), calendar)).toBeLessThan(0);
    expect(yearsBetween(at('312'), at('290'), calendar)).toBe(-22);
  });

  it('crosses eras', () => {
    const parts = (date: string) => parseStoryDateParts(date, eras, calendar)!;
    expect(yearsBetween(parts('40 BE'), parts('12 AE'), calendar)).toBe(52);
    expect(yearsBetween(parts('15 Frostmoot 40 BE'), parts('15 Frostmoot 12 AE'), calendar)).toBe(52);
    expect(yearsBetween(parts('4999 AE'), parts('Third Age 1'), calendar)).toBe(2);
  });

  it('uses twelve months for plain numbered dates', () => {
    const plain = (date: string) => parseStoryDateParts(date)!;
    expect(yearsBetween(plain('300-01'), plain('312-07'))).toBe(12.5);
    expect(yearsBetween(plain('300-04-15'), plain('312-04-15'))).toBe(12);
    expect(Math.floor(yearsBetween(plain('300-04-15'), plain('312-04-14')))).toBe(11);
    expect(Math.floor(yearsBetween(plain('300-01-31'), plain('312-02-01')))).toBe(12);
  });

  it('keeps birthdays right past anything a plain year holds', () => {
    const plain = (date: string) => parseStoryDateParts(date)!;
    expect(Math.floor(yearsBetween(plain('300-15-01'), plain('312-14-99')))).toBe(11);
    expect(Math.floor(yearsBetween(plain('300-15-01'), plain('312-15-01')))).toBe(12);
    expect(yearsBetween(plain('300-15-01'), plain('312-14-99'))).toBeGreaterThan(11);
  });

  it('keeps them right when a numbered date falls outside the calendar', () => {
    expect(Math.floor(yearsBetween(at('15 Frostmoot 290'), at('312-40-01'), calendar))).toBe(22);
    expect(Math.floor(yearsBetween(at('312-40-01'), at('15 Frostmoot 330'), calendar))).toBe(17);
  });
});

describe('eras read from the project', () => {
  const stored: Record<string, string> = {
    eras: JSON.stringify([{ name: 'AE', offset: 0 }]),
    calendar: JSON.stringify({ months: [{ name: 'Frostmoot', days: 30 }] }),
  };

  it('bring the calendar along, so code that knows only about eras reads named months', async () => {
    const getMeta = vi.spyOn(project, 'getMeta').mockImplementation(async (key) => stored[key] ?? null);
    const eras = await getEras();
    expect(parseStoryDate('15 Frostmoot 312 AE', eras)).toBeCloseTo(312.0115, 8);
    expect(formatStoryDate(312.0115, eras)).toBe('15 Frostmoot 312 AE');
    expect(explainStoryDate('31 Frostmoot 312', eras)).toContain('Frostmoot has 30 days');
    // But an explicit answer wins.
    expect(parseStoryDate('15 Frostmoot 312 AE', eras, null)).toBeNull();
    expect(calendarFor(eras, null)).toBeNull();
    // A list made some other way has none.
    expect(parseStoryDate('15 Frostmoot 312 AE', [...eras])).toBeNull();
    expect((await getDateContext()).calendar).toEqual({ months: [{ name: 'Frostmoot', days: 30 }] });
    getMeta.mockRestore();
  });

  it('bring nothing when the project has no calendar', async () => {
    const getMeta = vi.spyOn(project, 'getMeta').mockImplementation(async (key) => (key === 'eras' ? stored.eras : null));
    const context = await getDateContext();
    expect(context.calendar).toBeNull();
    expect(parseStoryDate('312 AE', context.eras)).toBe(312);
    getMeta.mockRestore();
  });
});
