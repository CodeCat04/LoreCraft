/** The arithmetic behind the stats screen. Days are local calendar days, `YYYY-MM-DD`. */

export interface DayCount {
  day: string;
  added: number;
  removed: number;
}

export function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Calendar arithmetic, which daylight saving cannot throw off the way adding hours can. */
function shiftDay(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  return isoDay(new Date(year, month - 1, day + days));
}

/** The last `count` days ending today, oldest first, with days of no writing filled in. */
export function lastDays(days: DayCount[], count: number, today: string): DayCount[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  return Array.from({ length: count }, (_, i) => {
    const day = shiftDay(today, i - count + 1);
    const found = byDay.get(day);
    return { day, added: found?.added ?? 0, removed: found?.removed ?? 0 };
  });
}

/**
 * Runs of consecutive days with words written. Today not having been written yet does
 * not break the current streak, because the day is not over.
 */
export function writingStreaks(days: DayCount[], today: string): { current: number; longest: number } {
  const written = new Set(days.filter((d) => d.added > 0).map((d) => d.day));

  let current = 0;
  let cursor = written.has(today) ? today : shiftDay(today, -1);
  while (written.has(cursor)) {
    current += 1;
    cursor = shiftDay(cursor, -1);
  }

  let longest = 0;
  for (const day of written) {
    // Only count from the start of a run.
    if (written.has(shiftDay(day, -1))) continue;
    let length = 1;
    let next = shiftDay(day, 1);
    while (written.has(next)) {
      length += 1;
      next = shiftDay(next, 1);
    }
    longest = Math.max(longest, length);
  }
  return { current, longest };
}

export interface ChartScale {
  /** The value at the top of the plot. */
  top: number;
  /** The size of the part of the scale below the baseline. */
  bottom: number;
  /** Tick values from top to bottom. Below the baseline they are negative. */
  ticks: number[];
}

/** One scale for both directions, in round steps, so up and down compare fairly. */
export function chartScale(maxAdded: number, maxRemoved: number): ChartScale {
  const range = maxAdded + maxRemoved;
  const rough = Math.max(range, 100) / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = rough / power;
  const step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
  const top = Math.max(Math.ceil(maxAdded / step), 1) * step;
  const bottom = Math.ceil(maxRemoved / step) * step;
  const ticks: number[] = [];
  for (let value = top; value >= -bottom; value -= step) ticks.push(value);
  return { top, bottom, ticks };
}

/** In full below 10,000, in thousands from there, the same across one axis. */
export function tickLabel(value: number, scale: ChartScale): string {
  const size = Math.abs(value);
  if (Math.max(scale.top, scale.bottom) >= 10000) return size === 0 ? '0' : `${size / 1000}K`;
  return size.toLocaleString();
}
