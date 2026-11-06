/**
 * Saving for everything the writer types. Each document has one queue that holds the newest
 * value nobody has stored yet. A value leaves the queue only once a write of it has worked,
 * so a failed write, such as on a full disk, never throws text away: the queue tries again
 * with growing waits, the status bar says so, and saving or closing the project stops.
 *
 * A queue outlives the view that filled it. A view that opens the same document again, by
 * the same `key`, finds what is still waiting with `unwrittenValue` and carries on from it.
 */

import { useCallback, useEffect, useRef } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { useUi } from '../state/ui';

/** How long after the last keystroke an edit reaches the recovery copy. */
export const SAVE_DELAY_MS = 500;

/** The waits between tries after a failed write. The last one repeats. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/** The status bar key for the "not saved yet" message. */
export const UNWRITTEN_STATUS = 'unwritten';

interface Queue {
  key: string;
  label: () => string;
  /** The newest value not yet stored. It is cleared only by a write of that very value. */
  pending: { value: unknown } | null;
  write: (value: unknown) => Promise<unknown>;
  merge?: (older: unknown, newer: unknown) => unknown;
  /** Writes for one document run in order, so an older one cannot win. */
  chain: Promise<void>;
  timer?: number;
  /** Set while the timer is a retry rather than the wait after typing. */
  retrying: boolean;
  failures: number;
  reason: string;
  /** Views using this queue now. With none and nothing waiting, it goes. */
  views: number;
}

const queues = new Map<string, Queue>();
let anonymous = 0;

/** What a flush left behind. */
export interface FlushResult {
  /** True when everything typed has been stored. */
  ok: boolean;
  /** What is still waiting, named for the writer. */
  unwritten: string[];
  /** Why the last write failed. */
  reason: string;
}

function retryDelay(failures: number): number {
  return RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[0];
}

function anyFailing(): boolean {
  for (const queue of queues.values()) if (queue.pending && queue.failures > 0) return true;
  return false;
}

/** Keeps the status bar message up for as long as anything that failed is still waiting. */
function showStatus() {
  const text = anyFailing() ? t('Not saved yet, trying again') : null;
  const ui = useUi.getState();
  if ((ui.statusItems[UNWRITTEN_STATUS] ?? null) !== text) ui.setStatusItem(UNWRITTEN_STATUS, text);
}

function forgetIfDone(queue: Queue) {
  if (!queue.pending && queue.views === 0 && queues.get(queue.key) === queue) {
    window.clearTimeout(queue.timer);
    queues.delete(queue.key);
  }
}

function retryLater(queue: Queue) {
  window.clearTimeout(queue.timer);
  queue.retrying = true;
  queue.timer = window.setTimeout(() => void attempt(queue), retryDelay(queue.failures));
}

/** Writes what the queue holds, if anything. True if nothing is left waiting. */
function attempt(queue: Queue): Promise<boolean> {
  window.clearTimeout(queue.timer);
  queue.timer = undefined;
  queue.retrying = false;
  queue.chain = queue.chain.then(async () => {
    const item = queue.pending;
    if (!item) return;
    try {
      await queue.write(item.value);
      // Anything typed while this was on its way stays for the next write.
      if (queue.pending === item) queue.pending = null;
      if (queue.failures > 0) {
        queue.failures = 0;
        queue.reason = '';
        if (!anyFailing()) toast(t('Your changes are saved again.'), 'success');
      }
    } catch (e) {
      queue.failures += 1;
      queue.reason = errorMessage(e);
      // One message per problem, however many tries it takes. The status bar stays meanwhile.
      if (queue.failures === 1) {
        toast(t('Could not save your last change: {reason}', { reason: queue.reason }), 'error');
      }
      retryLater(queue);
    }
  });
  return queue.chain.then(() => {
    showStatus();
    const done = queue.pending === null;
    forgetIfDone(queue);
    return done;
  });
}

/**
 * Writes every pending editor change, and says whether that worked. Call before saving or
 * closing a project, and stop if it did not.
 */
export async function flushAllEditors(): Promise<FlushResult> {
  await Promise.all([...queues.values()].map((queue) => attempt(queue)));
  const left = [...queues.values()].filter((queue) => queue.pending);
  const unwritten = [...new Set(left.map((queue) => queue.label()))];
  return { ok: left.length === 0, unwritten, reason: left.find((queue) => queue.reason)?.reason ?? '' };
}

/** Thrown by `flushOrStop` when typed text could not be stored. */
export class UnwrittenError extends Error {
  constructor(readonly result: FlushResult) {
    super(
      t('LoreCraft could not store: {list}. Nothing was changed, and your text is still on screen.', {
        list: result.unwritten.join(', '),
      }) + (result.reason ? ' ' + t('Reason: {reason}', { reason: result.reason }) : ''),
    );
    this.name = 'UnwrittenError';
  }
}

/**
 * Writes every pending editor change, and throws an `UnwrittenError` if some of it could not
 * be stored. Call before anything that writes over a document, so it never writes over text
 * the writer still has on screen.
 */
export async function flushOrStop(): Promise<void> {
  const result = await flushAllEditors();
  if (!result.ok) throw new UnwrittenError(result);
}

/** True while something typed is waiting to be stored, or failed to be. */
export function hasUnwritten(key?: string): boolean {
  if (key !== undefined) return Boolean(queues.get(key)?.pending);
  for (const queue of queues.values()) if (queue.pending) return true;
  return false;
}

/** The value still waiting for a document, for a view that opens it again. */
export function unwrittenValue<T>(key: string): T | undefined {
  return queues.get(key)?.pending?.value as T | undefined;
}

export interface SaverOptions<T> {
  /**
   * Names the document, such as `page:<id>`. A view that opens it again carries on with what
   * is still waiting. Without one, the queue belongs to this view, and still lives until written.
   */
  key?: string;
  /** What this is, for the message when it cannot be stored, such as the page's title. */
  label?: () => string;
  /**
   * Combines a waiting value with a newer one. Without it, the newer one replaces it, which
   * suits a whole document. Patches of fields pass a merge, so no field is dropped.
   */
  merge?: (older: T, newer: T) => T;
}

/**
 * Debounced saving for one document. Pending changes are written when the delay passes,
 * when the view unmounts, and on `flush`. A failed write keeps the value and tries again.
 */
export function useDocSaver<T>(save: (value: T) => Promise<unknown>, options: SaverOptions<T> = {}) {
  const ownKey = useRef<string | null>(null);
  if (ownKey.current === null) {
    anonymous += 1;
    ownKey.current = `saver:${anonymous}`;
  }
  const key = options.key ?? ownKey.current;
  const saveRef = useRef(save);
  saveRef.current = save;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const queueFor = useCallback((): Queue => {
    let queue = queues.get(key);
    if (!queue) {
      queue = {
        key,
        label: () => t('a recent change'),
        pending: null,
        write: (value) => saveRef.current(value as T),
        chain: Promise.resolve(),
        retrying: false,
        failures: 0,
        reason: '',
        views: 0,
      };
      queues.set(key, queue);
    }
    // The newest view's way of writing and naming it is the one to use.
    const current = optionsRef.current;
    queue.write = (value) => saveRef.current(value as T);
    if (current.label) queue.label = current.label;
    queue.merge = current.merge as Queue['merge'];
    return queue;
  }, [key]);

  const flush = useCallback(() => attempt(queueFor()), [queueFor]);

  const schedule = useCallback(
    (value: T) => {
      const queue = queueFor();
      const { merge } = queue;
      queue.pending = { value: queue.pending && merge ? merge(queue.pending.value, value) : value };
      // After a failure the retry already on its way picks up the newest value.
      if (queue.retrying) return;
      window.clearTimeout(queue.timer);
      queue.timer = window.setTimeout(() => void attempt(queue), SAVE_DELAY_MS);
    },
    [queueFor],
  );

  /** Drops what is waiting, for when the writer takes the change back themselves. */
  const discard = useCallback(() => {
    const queue = queueFor();
    window.clearTimeout(queue.timer);
    queue.timer = undefined;
    queue.retrying = false;
    queue.pending = null;
    queue.failures = 0;
    queue.reason = '';
    showStatus();
  }, [queueFor]);

  useEffect(() => {
    const queue = queueFor();
    queue.views += 1;
    return () => {
      queue.views -= 1;
      // The last try for now. If it fails, the queue keeps the value and goes on trying.
      void attempt(queue);
    };
  }, [queueFor]);

  return { schedule, flush, discard };
}

/** For tests: drops every queue and timer. */
export function resetSavingForTests(): void {
  for (const queue of queues.values()) window.clearTimeout(queue.timer);
  queues.clear();
  showStatus();
}
