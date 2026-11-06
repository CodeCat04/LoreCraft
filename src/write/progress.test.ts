import { describe, expect, it } from 'vitest';

import { chartScale, isoDay, lastDays, tickLabel, writingStreaks } from './progress';

function day(iso: string, added = 100, removed = 0) {
  return { day: iso, added, removed };
}

describe('isoDay', () => {
  it('uses the local calendar date', () => {
    expect(isoDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(isoDay(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31');
  });
});

describe('lastDays', () => {
  it('fills in the days with no writing, oldest first', () => {
    const out = lastDays([day('2026-03-01', 5, 1)], 4, '2026-03-02');
    expect(out).toEqual([
      { day: '2026-02-27', added: 0, removed: 0 },
      { day: '2026-02-28', added: 0, removed: 0 },
      { day: '2026-03-01', added: 5, removed: 1 },
      { day: '2026-03-02', added: 0, removed: 0 },
    ]);
  });

  it('crosses years and leap days', () => {
    expect(lastDays([], 2, '2026-01-01').map((d) => d.day)).toEqual(['2025-12-31', '2026-01-01']);
    expect(lastDays([], 2, '2024-03-01').map((d) => d.day)).toEqual(['2024-02-29', '2024-03-01']);
  });

  it('gives every day exactly once across a daylight saving change', () => {
    const out = lastDays([], 30, '2026-11-15').map((d) => d.day);
    expect(new Set(out).size).toBe(30);
    expect(out[0]).toBe('2026-10-17');
    expect(out.at(-1)).toBe('2026-11-15');
  });
});

describe('writingStreaks', () => {
  it('counts back from today', () => {
    const days = [day('2026-03-03'), day('2026-03-02'), day('2026-03-01')];
    expect(writingStreaks(days, '2026-03-03').current).toBe(3);
  });

  it('does not break the streak because today has no words yet', () => {
    const days = [day('2026-03-02'), day('2026-03-01')];
    expect(writingStreaks(days, '2026-03-03').current).toBe(2);
  });

  it('is broken by a whole day missed', () => {
    const days = [day('2026-03-01'), day('2026-02-28')];
    expect(writingStreaks(days, '2026-03-03').current).toBe(0);
  });

  it('does not count a day of only deleting', () => {
    const days = [day('2026-03-03', 0, 50), day('2026-03-02')];
    // It does not add to the streak, and once that day is over it has broken it.
    expect(writingStreaks(days, '2026-03-03').current).toBe(1);
    expect(writingStreaks(days, '2026-03-04').current).toBe(0);
  });

  it('finds the longest run, past or present', () => {
    const days = [
      day('2026-03-03'),
      day('2026-02-20'),
      day('2026-02-19'),
      day('2026-02-18'),
      day('2026-01-01'),
    ];
    expect(writingStreaks(days, '2026-03-03')).toEqual({ current: 1, longest: 3 });
  });

  it('is zero with no writing', () => {
    expect(writingStreaks([], '2026-03-03')).toEqual({ current: 0, longest: 0 });
  });

  it('runs across a month end', () => {
    const days = [day('2026-03-01'), day('2026-02-28')];
    expect(writingStreaks(days, '2026-03-01')).toEqual({ current: 2, longest: 2 });
  });
});

describe('chartScale', () => {
  it('uses round steps that contain the data', () => {
    const scale = chartScale(1234, 0);
    expect(scale.top).toBeGreaterThanOrEqual(1234);
    expect(scale.bottom).toBe(0);
    expect(scale.ticks.at(-1)).toBe(0);
    const step = scale.ticks[0] - scale.ticks[1];
    expect([500, 1000]).toContain(step);
  });

  it('shares one step above and below the baseline, with a tick at zero', () => {
    const scale = chartScale(2300, 700);
    expect(scale.ticks).toContain(0);
    expect(scale.top).toBeGreaterThanOrEqual(2300);
    expect(scale.bottom).toBeGreaterThanOrEqual(700);
    const steps = scale.ticks.slice(1).map((t, i) => scale.ticks[i] - t);
    expect(new Set(steps).size).toBe(1);
    expect(scale.ticks.at(-1)).toBe(-scale.bottom);
  });

  it('still draws an axis with no data', () => {
    const scale = chartScale(0, 0);
    expect(scale.top).toBeGreaterThan(0);
    expect(scale.bottom).toBe(0);
    expect(scale.ticks).toContain(0);
  });

  it('keeps a handful of ticks at any size', () => {
    for (const size of [1, 37, 990, 12_000, 250_000]) {
      const scale = chartScale(size, size / 3);
      expect(scale.ticks.length).toBeGreaterThanOrEqual(3);
      expect(scale.ticks.length).toBeLessThanOrEqual(7);
    }
  });
});

describe('tickLabel', () => {
  it('keeps one style across an axis', () => {
    const small = chartScale(2000, 0);
    expect(tickLabel(1000, small)).toBe((1000).toLocaleString());
    const large = chartScale(20000, 5000);
    expect(tickLabel(20000, large)).toBe('20K');
    expect(tickLabel(-5000, large)).toBe('5K');
    expect(tickLabel(0, large)).toBe('0');
  });
});
