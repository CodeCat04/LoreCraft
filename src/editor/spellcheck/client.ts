/**
 * The editor's side of the spellchecker. One worker serves every open editor. Results
 * are cached by block text, so a paragraph is only sent to the worker when its text is
 * new, and the cache is emptied only when the word list changes.
 */

import { listen } from '@tauri-apps/api/event';

import { rpc } from '../../lib/rpc';
import { hasDictionary, languageInfo } from '../../lib/languages';
import { useProjectLanguage, writingLanguage } from '../../state/language';
import { useProject, useTitles } from '../../state/project';
import { useSettings } from '../../state/settings';
import { loadDictionary } from './dictionaries';
import type { SpellRange } from './engine';
import type { FromWorker, ToWorker } from './protocol';

/** A worker that has not answered by now is treated as failed. */
const START_TIMEOUT_MS = 20_000;
/** Page saves can come in quick succession. Only the last word list matters. */
const WORDS_DELAY_MS = 300;
/** Stops the cache growing without limit in a very long session. */
const MAX_CACHED_BLOCKS = 50_000;

export type SpellState = 'off' | 'starting' | 'ready' | 'failed';

export interface SpellStats {
  /** Blocks sent to the worker since the app started. */
  blocksChecked: number;
  /** Messages sent to the worker. */
  batches: number;
  /** Time the worker spent checking, in total and in its last batch. */
  workerMs: number;
  lastWorkerMs: number;
  /** Time the worker spent loading the dictionary. */
  loadMs: number;
  /** The longest single pass on the main thread: finding changed blocks and drawing. */
  longestMainThreadMs: number;
  state: SpellState;
  /** Bumps each time the word list changes. */
  version: number;
}

class SpellClient {
  private worker: Worker | null = null;
  private state: SpellState = 'off';
  private nextId = 1;
  private checks = new Map<number, string[]>();
  /** Callers waiting for blocks that are on their way to the worker. */
  private afterNextBatch: (() => void)[] = [];
  private suggestions = new Map<number, (list: string[]) => void>();
  private cache = new Map<string, SpellRange[]>();
  private queued = new Set<string>();
  private listeners = new Set<() => void>();
  private startTimer: number | undefined;
  private wordsTimer: number | undefined;
  private sentNames: string | null = null;
  private dictionary: string[] = [];
  /** Survives a change of worker, since it lasts until the project closes. */
  private ignored = new Set<string>();
  private wordsReady = false;
  private feedsStarted = false;
  /** How long reading the dictionary's files took, before the worker parsed them. */
  private readMs = 0;
  /** Checks wait here until the worker is up and knows the lore. */
  private waiting: (() => void)[] = [];
  private stats = {
    blocksChecked: 0,
    batches: 0,
    workerMs: 0,
    lastWorkerMs: 0,
    loadMs: 0,
    longestMainThreadMs: 0,
    version: 0,
  };

  constructor() {
    let language = writingLanguage();
    const check = () => {
      const next = writingLanguage();
      if (next === language) return;
      language = next;
      this.changeLanguage();
    };
    useProjectLanguage.subscribe(check);
    useSettings.subscribe(check);
  }

  /** Whether the custom checker is doing the job, so the browser's should stay out of it. */
  isActive(): boolean {
    return useSettings.getState().settings.editor.spellcheck && this.state !== 'failed' && hasDictionary(writingLanguage());
  }

  /** Whether the browser's checker has to stand in. With no dictionary, nothing does. */
  useNativeFallback(): boolean {
    return useSettings.getState().settings.editor.spellcheck && this.state === 'failed' && hasDictionary(writingLanguage());
  }

  /** The worker is built on first use. A setting left off never costs anything. */
  start() {
    if (this.state !== 'off') return;
    const language = writingLanguage();
    const script = languageInfo(language)?.dictionaryScript;
    if (!script) return;
    this.state = 'starting';
    this.startFeeds();
    try {
      // Vite finds and bundles the worker from this exact form, with the same content
      // security policy as the rest of the app.
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<FromWorker>) => {
        // A message from a worker that has since been replaced says nothing about the new one.
        if (this.worker === worker) this.receive(event.data);
      };
      worker.onerror = (event) => this.fail(event.message || 'The worker could not run.');
      worker.onmessageerror = () => this.fail('The worker sent a message that could not be read.');
      this.worker = worker;
      this.startTimer = window.setTimeout(() => this.fail('The worker did not start in time.'), START_TIMEOUT_MS);
      // Read here, because a worker cannot call Rust.
      const started = performance.now();
      loadDictionary(language).then(
        (files) => {
          // A change of language since then has a worker of its own.
          if (this.worker !== worker) return;
          this.readMs = performance.now() - started;
          worker.postMessage({ type: 'load', files, script } satisfies ToWorker);
        },
        (e) => {
          if (this.worker === worker) this.fail(e instanceof Error ? e.message : String(e));
        },
      );
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Drops the worker and everything it said. Editors asked through `notify` look again,
   * which starts a new worker for the new language if it has a dictionary. Each language gets
   * a fresh start, even if another one failed.
   */
  private changeLanguage() {
    window.clearTimeout(this.startTimer);
    this.worker?.terminate();
    this.worker = null;
    this.state = 'off';
    this.sentNames = null;
    this.suggestions.forEach((resolve) => resolve([]));
    this.suggestions.clear();
    // Those waiting are told there is news, and ask again if there is still a checker.
    const waiting = this.waiting;
    this.waiting = [];
    waiting.forEach((resume) => resume());
    this.invalidate();
  }

  private fail(reason: string) {
    if (this.state === 'failed') return;
    // Quiet by design: the writer still has the browser's checker, and can type.
    console.warn(`Spellcheck is using the browser's built-in checker instead: ${reason}`);
    window.clearTimeout(this.startTimer);
    this.state = 'failed';
    this.worker?.terminate();
    this.worker = null;
    this.waiting.forEach((resume) => resume());
    this.waiting = [];
    this.checks.clear();
    this.releaseWaiters();
    this.suggestions.forEach((resolve) => resolve([]));
    this.suggestions.clear();
    this.notify();
  }

  private receive(message: FromWorker) {
    switch (message.type) {
      case 'ready':
        window.clearTimeout(this.startTimer);
        this.stats.loadMs = this.readMs + message.loadMs;
        this.state = 'ready';
        this.ignored.forEach((word) => this.post({ type: 'ignore', word }));
        this.publishWords();
        this.resumeIfReady();
        this.notify();
        break;
      case 'failed':
        this.fail(message.message);
        break;
      case 'checked': {
        // Gone if the word list changed since it was sent, so its answers are out of date.
        const texts = this.checks.get(message.id);
        if (!texts) break;
        this.checks.delete(message.id);
        this.stats.workerMs += message.workerMs;
        this.stats.lastWorkerMs = message.workerMs;
        texts.forEach((text, index) => {
          this.cache.set(text, message.results[index] ?? []);
          this.queued.delete(text);
        });
        this.releaseWaiters();
        break;
      }
      case 'suggested': {
        this.suggestions.get(message.id)?.(message.suggestions);
        this.suggestions.delete(message.id);
        break;
      }
    }
  }

  private post(message: ToWorker) {
    this.worker?.postMessage(message);
  }

  private notify() {
    this.listeners.forEach((listener) => listener());
  }

  /** Calls back when results may have changed: the word list, or the checker's state. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- Checking ----------------------------------------------------------------

  version(): number {
    return this.stats.version;
  }

  lookup(text: string): SpellRange[] | undefined {
    return this.cache.get(text);
  }

  /**
   * Asks about these blocks, and resolves once there is news: results have arrived, the
   * word list has changed, or the checker has failed. Callers then look again. Blocks
   * already on their way are not sent twice.
   */
  check(texts: string[]): Promise<void> {
    return new Promise((resolve) => {
      const send = () => {
        if (this.state !== 'ready') {
          resolve();
          return;
        }
        const fresh = texts.filter((text) => !this.cache.has(text) && !this.queued.has(text));
        if (fresh.length > 0) {
          if (this.cache.size + fresh.length > MAX_CACHED_BLOCKS) this.cache.clear();
          fresh.forEach((text) => this.queued.add(text));
          const id = this.nextId;
          this.nextId += 1;
          this.checks.set(id, fresh);
          this.stats.blocksChecked += fresh.length;
          this.stats.batches += 1;
          this.post({ type: 'check', id, texts: fresh });
        }
        if (texts.some((text) => this.queued.has(text))) this.afterNextBatch.push(resolve);
        else resolve();
      };
      if (this.state === 'ready' && this.wordsReady) send();
      else if (this.state === 'failed') resolve();
      else this.waiting.push(send);
    });
  }

  private releaseWaiters() {
    const waiters = this.afterNextBatch;
    this.afterNextBatch = [];
    waiters.forEach((resolve) => resolve());
  }

  private resumeIfReady() {
    if (this.state !== 'ready' || !this.wordsReady) return;
    const waiting = this.waiting;
    this.waiting = [];
    waiting.forEach((resume) => resume());
  }

  suggest(word: string): Promise<string[]> {
    if (this.state !== 'ready') return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = this.nextId;
      this.nextId += 1;
      this.suggestions.set(id, resolve);
      this.post({ type: 'suggest', id, word });
    });
  }

  // ---- The word list -----------------------------------------------------------

  private startFeeds() {
    if (this.feedsStarted) return;
    this.feedsStarted = true;
    let entries = useTitles.getState().entries;
    useTitles.subscribe((state) => {
      if (state.entries !== entries) {
        entries = state.entries;
        this.scheduleWords();
      }
    });
    let wasOpen = useProject.getState().status.open;
    useProject.subscribe((state) => {
      const { open } = state.status;
      if (open === wasOpen) return;
      wasOpen = open;
      if (!open) this.forgetProject();
    });
    // Not available outside the app, such as in unit tests.
    void listen<{ entity: string }>('data://changed', (event) => {
      const { entity } = event.payload;
      // Opening a project over a saved one never passes through closed.
      if (entity === 'all') this.forgetProject();
      if (entity === 'dictionary' || entity === 'all') void this.loadDictionary();
    }).catch(() => {});
    void this.loadDictionary();
  }

  /**
   * Ignoring a word lasts for this session of this project. Nothing else would notice if
   * the same project is opened again, so results are dropped here too.
   */
  private forgetProject() {
    this.ignored.clear();
    this.post({ type: 'clearIgnored' });
    this.dictionary = [];
    this.sentNames = null;
    this.invalidate();
  }

  private async loadDictionary() {
    try {
      this.dictionary = useProject.getState().status.open
        ? await rpc<string[]>('extras.dictionaryList')
        : [];
    } catch {
      this.dictionary = [];
    }
    this.wordsReady = true;
    this.publishWords();
    this.resumeIfReady();
  }

  private scheduleWords() {
    window.clearTimeout(this.wordsTimer);
    this.wordsTimer = window.setTimeout(() => this.publishWords(), WORDS_DELAY_MS);
  }

  /** Sends the word list if it changed, which voids every cached result. */
  private publishWords() {
    if (this.state !== 'ready' || !this.wordsReady) return;
    window.clearTimeout(this.wordsTimer);
    const names: string[] = [...this.dictionary];
    for (const entry of useTitles.getState().entries) {
      names.push(entry.title, ...entry.aliases);
    }
    const key = names.join('\n');
    if (key === this.sentNames) return;
    this.sentNames = key;
    this.post({ type: 'names', names });
    this.invalidate();
  }

  private invalidate() {
    this.cache.clear();
    this.queued.clear();
    // Anything in flight was checked against the old list. Its callers will look again.
    this.checks.clear();
    this.releaseWaiters();
    this.stats.version += 1;
    this.notify();
  }

  /** Adds a word to the project's dictionary, for good. */
  async addWord(word: string): Promise<void> {
    await rpc('extras.dictionaryAdd', { word });
    // The change is announced to `loadDictionary`, but this makes it happen at once.
    await this.loadDictionary();
  }

  /** Accepts a word until the project closes. */
  ignoreWord(word: string) {
    this.ignored.add(word);
    this.post({ type: 'ignore', word });
    this.invalidate();
  }

  noteMainThreadWork(ms: number) {
    this.stats.longestMainThreadMs = Math.max(this.stats.longestMainThreadMs, ms);
  }

  statsSnapshot(): SpellStats {
    return { ...this.stats, state: this.state };
  }
}

export const spellClient = new SpellClient();
