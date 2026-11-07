/**
 * Guided Continue: what the writer adds to Continue. The built-in prompt stays as it is,
 * and the writer's direction, if any, goes after it as one more part of the request.
 */

export const MIN_CONTINUE_VERSIONS = 1;
export const MAX_CONTINUE_VERSIONS = 3;

/** A count from the box, kept between 1 and 3. */
export function continueVersions(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return MIN_CONTINUE_VERSIONS;
  return Math.min(MAX_CONTINUE_VERSIONS, Math.max(MIN_CONTINUE_VERSIONS, n));
}

/** The Continue prompt, with what the writer wants to happen next, if anything. */
export function guidedInstruction(base: string, direction: string): string {
  const wish = direction.trim();
  if (!wish) return base;
  return `${base}\n\nWhat should happen next, in the author's words: ${wish}`;
}

/** What makes each version of a continuation differ. The ones for a rewrite compare with an original. */
export const CONTINUE_ANGLES: readonly string[] = [
  'Write the most natural next step from where the text stops.',
  'Take the story in a less obvious direction, still true to what came before.',
  'Be bolder: a surprising turn that still fits the characters and the lore.',
];
