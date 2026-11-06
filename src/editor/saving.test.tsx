import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RETRY_DELAYS_MS,
  SAVE_DELAY_MS,
  UNWRITTEN_STATUS,
  flushAllEditors,
  hasUnwritten,
  resetSavingForTests,
  unwrittenValue,
  useDocSaver,
  type SaverOptions,
} from './saving';
import { useUi } from '../state/ui';

vi.mock('../shell/toasts', () => ({ toast: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Saver<T> = ReturnType<typeof useDocSaver<T>>;

/** Mounts a component using the saver, and hands back its `schedule` and `flush`. */
function mountSaver<T>(save: (value: T) => Promise<unknown>, options?: SaverOptions<T>) {
  const box: { saver: Saver<T> | null } = { saver: null };
  function Probe() {
    box.saver = useDocSaver<T>(save, options);
    return null;
  }
  const host = document.createElement('div');
  const root: Root = createRoot(host);
  act(() => root.render(<Probe />));
  return {
    get saver() {
      return box.saver!;
    },
    unmount: () => act(() => root.unmount()),
  };
}

/** A write that fails while `failing` is set, as on a full disk, and records what it stored. */
function flakyDisk<T>() {
  const disk = { failing: true, stored: [] as T[], tries: 0 };
  const save = async (value: T) => {
    disk.tries += 1;
    if (disk.failing) throw new Error('There is not enough space on the disk.');
    disk.stored.push(value);
  };
  return { disk, save };
}

const status = () => useUi.getState().statusItems[UNWRITTEN_STATUS];

describe('useDocSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSavingForTests();
  });
  afterEach(() => {
    resetSavingForTests();
    vi.useRealTimers();
  });

  it('keeps a value whose write failed, and stores it once writing works again', async () => {
    const { disk, save } = flakyDisk<string>();
    const view = mountSaver(save, { key: 'doc:a' });
    view.saver.schedule('typed text');
    await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS));

    expect(disk.tries).toBe(1);
    expect(disk.stored).toEqual([]);
    expect(unwrittenValue('doc:a')).toBe('typed text');
    expect(status()).toBe('Not saved yet, trying again');

    // It tries again by itself, waiting longer each time.
    await act(() => vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]));
    expect(disk.tries).toBe(2);
    expect(unwrittenValue('doc:a')).toBe('typed text');

    disk.failing = false;
    await act(() => vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]));
    expect(disk.stored).toEqual(['typed text']);
    expect(hasUnwritten('doc:a')).toBe(false);
    expect(status()).toBeUndefined();
    view.unmount();
  });

  it('says a flush failed while anything is unwritten, and names what', async () => {
    const { disk, save } = flakyDisk<string>();
    const view = mountSaver(save, { key: 'doc:b', label: () => 'the page “Alice”' });
    view.saver.schedule('one');
    const failed = await flushAllEditors();
    expect(failed.ok).toBe(false);
    expect(failed.unwritten).toEqual(['the page “Alice”']);
    expect(failed.reason).toMatch(/not enough space/);

    disk.failing = false;
    const worked = await flushAllEditors();
    expect(worked.ok).toBe(true);
    expect(disk.stored).toEqual(['one']);
    view.unmount();
  });

  it('never drops a field of a patch before a write of it has worked', async () => {
    const { disk, save } = flakyDisk<Record<string, string>>();
    const merge = (older: Record<string, string>, newer: Record<string, string>) => ({ ...older, ...newer });
    const view = mountSaver(save, { key: 'page:c', merge });
    view.saver.schedule({ summary: 'A short summary' });
    await flushAllEditors();
    view.saver.schedule({ title: 'New title' });
    disk.failing = false;
    await flushAllEditors();
    expect(disk.stored.at(-1)).toEqual({ summary: 'A short summary', title: 'New title' });
    view.unmount();
  });

  it('keeps what it holds after the view closes, for the view that opens it next', async () => {
    const { disk, save } = flakyDisk<string>();
    const first = mountSaver(save, { key: 'node:d' });
    first.saver.schedule('the scene so far');
    first.unmount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(disk.tries).toBe(1);
    expect(unwrittenValue('node:d')).toBe('the scene so far');
    expect((await flushAllEditors()).ok).toBe(false);

    const second = mountSaver(save, { key: 'node:d' });
    second.saver.schedule('the scene so far, and more');
    disk.failing = false;
    expect((await flushAllEditors()).ok).toBe(true);
    expect(disk.stored).toEqual(['the scene so far, and more']);
    second.unmount();
  });

  it('keeps a value typed while a write was on its way, even if that write worked', async () => {
    let finish: () => void = () => {};
    const stored: string[] = [];
    const save = (value: string) =>
      new Promise<void>((resolve) => {
        finish = () => {
          stored.push(value);
          resolve();
        };
      });
    const view = mountSaver(save, { key: 'doc:e' });
    view.saver.schedule('first');
    const flushing = view.saver.flush();
    await act(() => vi.advanceTimersByTimeAsync(0));
    view.saver.schedule('second');
    finish();
    await flushing;
    expect(unwrittenValue('doc:e')).toBe('second');
    const rest = flushAllEditors();
    await act(() => vi.advanceTimersByTimeAsync(0));
    finish();
    await rest;
    expect(stored).toEqual(['first', 'second']);
    view.unmount();
  });
});
