import { explainStoryDate, parseStoryDate } from './storyDate';

const calendar = { months: [{ name: 'Frostmoot', days: 30 }, { name: 'Thawing', days: 30 }] };

describe('everyday dates, in a project without its own months', () => {
  it('reads real dates the way people write them', () => {
    const key = parseStoryDate('2022-10-13');
    for (const text of [
      'Thursday, October 13, 2022',
      'October 13, 2022',
      'October 13 2022',
      'Oct 13, 2022',
      'Oct. 13, 2022',
      '13 October 2022',
      'the 13th of October, 2022',
      'Thu 13 Oct 2022',
      'thursday, october 13th, 2022',
    ]) {
      expect(parseStoryDate(text)).toBe(key);
    }
    expect(parseStoryDate('October 2022')).toBe(parseStoryDate('2022-10'));
    expect(parseStoryDate('Sept 1, 1999')).toBe(parseStoryDate('1999-09-01'));
  });

  it('puts them in order', () => {
    const inOrder = ['December 31, 2021', 'Thursday, October 13, 2022', 'October 14, 2022', 'November 2022', '2023'];
    const sorted = [...inOrder].reverse().sort((a, b) => parseStoryDate(a)! - parseStoryDate(b)!);
    expect(sorted).toEqual(inOrder);
  });

  it('still returns null instead of guessing', () => {
    expect(parseStoryDate('Thursday')).toBeNull();
    expect(parseStoryDate('October')).toBeNull();
    expect(parseStoryDate('October 32, 2022')).toBeNull();
    expect(parseStoryDate('Mayday 312')).toBeNull();
    expect(parseStoryDate('sometime in 312')).toBeNull();
  });

  it('says what is wrong', () => {
    expect(explainStoryDate('October 32, 2022')).toBe('October has 31 days, so it has no day 32.');
    expect(explainStoryDate('Thursday, October')).toContain('Add a year');
    expect(explainStoryDate('the long winter')).toContain('Use a year');
  });

  it('keeps eras working alongside them', () => {
    const eras = [{ name: 'AE', offset: 0 }];
    expect(parseStoryDate('13 October 312 AE', eras)).toBe(parseStoryDate('312-10-13'));
    expect(parseStoryDate('312 AE', eras)).toBe(312);
  });
});

describe('a project with its own months', () => {
  it('uses only those months', () => {
    expect(parseStoryDate('15 Thawing 312', [], calendar)).toBe(parseStoryDate('312-02-15'));
    expect(parseStoryDate('October 13, 2022', [], calendar)).toBeNull();
  });

  it('still leaves out a weekday in front', () => {
    expect(parseStoryDate('Thursday, 15 Thawing 312', [], calendar)).toBe(parseStoryDate('312-02-15'));
  });

  it('reads a day before the year without a comma, and a year alone with an era', () => {
    const eras = [{ name: 'AE', offset: 0 }];
    expect(parseStoryDate('Thawing 15 312', [], calendar)).toBe(parseStoryDate('312-02-15'));
    expect(parseStoryDate('Thawing 15 AE', eras, calendar)).toBe(parseStoryDate('15-02'));
  });
});
