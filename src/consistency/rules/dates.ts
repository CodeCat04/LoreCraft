/**
 * Comparing sort keys from `parseStoryDate`. "312" means some time in that year, so it does
 * not come before "312-04-15" or after it, even though its sort key is lower. The rules only
 * call one date earlier than another when that is certain.
 */

interface DateParts {
  year: number;
  /** 0 if the date does not say. */
  month: number;
  day: number;
}

function partsOf(sort: number): DateParts {
  const year = Math.floor(sort);
  // `within` is month / 100 + day / 10000, so these are whole numbers once rounded.
  const within = Math.round((sort - year) * 10000);
  return { year, month: Math.floor(within / 100), day: within % 100 };
}

/** True only if `a` is certainly earlier than `b`, whichever way either was written. */
export function certainlyBefore(a: number, b: number): boolean {
  const left = partsOf(a);
  const right = partsOf(b);
  if (left.year !== right.year) return left.year < right.year;
  if (left.month === 0 || right.month === 0) return false;
  if (left.month !== right.month) return left.month < right.month;
  if (left.day === 0 || right.day === 0) return false;
  return left.day < right.day;
}

/** Whole years from `from` to `to`. */
export function yearsBetween(from: number, to: number): number {
  return Math.floor(to) - Math.floor(from);
}
