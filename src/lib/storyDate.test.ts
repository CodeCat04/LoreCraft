import { explainStoryDate, formatStoryYear, parseEras, parseStoryDate, storyYear } from './storyDate';

describe('parseStoryDate', () => {
  it('reads plain years and dates, in order', () => {
    expect(parseStoryDate('312')).toBe(312);
    expect(parseStoryDate('Year 312')).toBe(312);
    expect(parseStoryDate('312-04-15')!).toBeGreaterThan(parseStoryDate('312-04-02')!);
    expect(parseStoryDate('312/4')!).toBeGreaterThan(parseStoryDate('312')!);
    expect(parseStoryDate('313')!).toBeGreaterThan(parseStoryDate('312-12-31')!);
  });

  it('returns null instead of guessing', () => {
    expect(parseStoryDate('')).toBeNull();
    expect(parseStoryDate('the long winter')).toBeNull();
    expect(parseStoryDate('sometime in 312')).toBeNull();
  });

  it('orders eras using project settings', () => {
    const eras = [
      { name: 'BE', offset: 0, negative: true },
      { name: 'AE', offset: 0 },
      { name: 'Third Age', offset: 5000 },
    ];
    expect(parseStoryDate('40 BE', eras)).toBe(-40);
    expect(parseStoryDate('12 AE', eras)).toBe(12);
    expect(parseStoryDate('Third Age 3', eras)).toBe(5003);
    expect(parseStoryDate('third age 3', eras)).toBe(5003);
    expect(parseStoryDate('50 BE', eras)!).toBeLessThan(parseStoryDate('40 BE', eras)!);
  });

  it('keeps months in order inside a year that counts backwards', () => {
    const eras = [{ name: 'BE', offset: 0, negative: true }];
    const inOrder = ['-41', '-40', '-40-02', '-40-03', '-39'];
    const sorted = [...inOrder].sort((a, b) => parseStoryDate(a)! - parseStoryDate(b)!);
    expect(sorted).toEqual(inOrder);
    expect(parseStoryDate('40-02 BE', eras)!).toBeLessThan(parseStoryDate('40-03 BE', eras)!);
    expect(parseStoryDate('40-03 BE', eras)!).toBeLessThan(parseStoryDate('39 BE', eras)!);
  });

  it('puts every part of a year in that year', () => {
    const eras = [{ name: 'BE', offset: 0, negative: true }];
    expect(storyYear(parseStoryDate('312-12-31')!)).toBe(312);
    expect(storyYear(parseStoryDate('-40-02')!)).toBe(-40);
    expect(storyYear(parseStoryDate('40-02 BE', eras)!)).toBe(-40);
  });
});

describe('explainStoryDate', () => {
  it('points at era settings when a date names an era it does not know', () => {
    expect(explainStoryDate('312 AE')).toContain('"AE" is not a known era');
    expect(explainStoryDate('Third Age 3')).toContain('"Third Age" is not a known era');
  });

  it('asks for a better date otherwise', () => {
    expect(explainStoryDate('the long winter')).toContain('Use a year');
    expect(explainStoryDate('312 AE', [{ name: 'AE', offset: 0 }])).toContain('Use a year');
    expect(explainStoryDate('Year abc')).toContain('Use a year');
    expect(explainStoryDate('  ')).toBe('No date is set.');
  });
});

describe('formatStoryYear', () => {
  const eras = [
    { name: 'BE', offset: 0, negative: true },
    { name: 'AE', offset: 0 },
    { name: 'Third Age', offset: 5000 },
  ];

  it('writes years in the era they fall in', () => {
    expect(formatStoryYear(-40, eras)).toBe('40 BE');
    expect(formatStoryYear(12, eras)).toBe('12 AE');
    expect(formatStoryYear(5003, eras)).toBe('Third Age 3');
    expect(formatStoryYear(4999, eras)).toBe('4999 AE');
  });

  it('writes plain numbers without eras', () => {
    expect(formatStoryYear(312)).toBe('312');
    expect(formatStoryYear(-40)).toBe('-40');
  });

  it('reads back what it writes', () => {
    for (const year of [-40, 12, 5003]) {
      expect(parseStoryDate(formatStoryYear(year, eras), eras)).toBe(year);
    }
  });
});

describe('parseEras', () => {
  it('reads what was stored and drops what cannot be used', () => {
    const json = JSON.stringify([
      { name: ' AE ', offset: 0 },
      { name: 'BE', offset: 0, negative: true },
      { name: '', offset: 3 },
      { offset: 3 },
      { name: 'Bad', offset: 'many' },
      null,
    ]);
    expect(parseEras(json)).toEqual([
      { name: 'AE', offset: 0 },
      { name: 'BE', offset: 0, negative: true },
    ]);
  });

  it('survives anything else', () => {
    expect(parseEras(null)).toEqual([]);
    expect(parseEras('not json')).toEqual([]);
    expect(parseEras('{"name":"AE"}')).toEqual([]);
  });
});
