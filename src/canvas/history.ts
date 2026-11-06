/**
 * Undo and redo for a canvas. Each step keeps the whole canvas before and after. Canvas data
 * is never changed in place, so a step shares everything it did not change with its neighbors
 * and costs little.
 */

export const HISTORY_LIMIT = 200;

export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  /** Steps with the same key close together become one, such as typing in one card. */
  private lastKey: string | null = null;
  private lastAt = 0;

  constructor(private limit = HISTORY_LIMIT) {}

  /** Records that the state was `before`, before the change now being made. */
  record(before: T, key: string | null = null, now = Date.now()) {
    if (key !== null && key === this.lastKey && now - this.lastAt < 1500) {
      this.lastAt = now;
      this.future = [];
      return;
    }
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.lastKey = key;
    this.lastAt = now;
  }

  undo(current: T): T | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(current);
    this.lastKey = null;
    return previous;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    this.lastKey = null;
    return next;
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}
