/**
 * Several versions of one rewrite, to compare before any reaches the document. Each is its
 * own request with its own angle, one at a time on a local server, which can only do one
 * thing at once, and together on a cloud provider. Nothing here touches the document:
 * choosing a version goes through the same step as any other edit, and ends in a suggestion.
 */

import { finishEdit, editPrompt, planEdit, type EditAction, type EditOutcome, type EditRequest } from '../../editor/ai/flow';
import { stripMarkers } from '../../editor/ai/hunks';
import { markRead, trackedRange } from '../../editor/ai/suggestions';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import type { AiProfile } from '../../lib/settings';
import { AiError, maxTokensMessage, refusalMessage, stream, type AiResult, type StreamHandle } from '../client';
import { frameBatcher } from '../frames';
import { fence } from '../prompts';
import type { AiMessage, ContentBlock } from '../types';
import { isSourceLocalOnly, withheldMessage } from '../limits/localOnly';

export const VERSION_COUNT = 3;
export const MIN_VERSIONS = 2;
export const MAX_VERSIONS = 5;

/** A stored count, kept between 2 and 5. */
export function versionCount(stored: unknown): number {
  const n = typeof stored === 'number' && Number.isFinite(stored) ? Math.round(stored) : VERSION_COUNT;
  return Math.min(MAX_VERSIONS, Math.max(MIN_VERSIONS, n));
}

/** Asking three times for the same thing tends to get the same thing, so each has an angle. */
const ANGLES = [
  'Stay closest to the original: the same structure and rhythm, with only what the request needs.',
  'Take a noticeably different approach to structure and rhythm, while doing what the request asks.',
  'Be bolder: the most distinctive take on the request you can write, keeping the same events and facts.',
  'Change the point of emphasis: bring forward what the original leaves in the background.',
  'Be as spare as you can: the fewest words that still do everything the request asks.',
];

/** The last thing a version's request says. Exact wording matters less than that they differ. */
export function versionPrompt(index: number, earlier?: string, count: number = VERSION_COUNT): string {
  const base = `This is version ${index + 1} of ${count}, and the author will compare them. ${ANGLES[index % ANGLES.length]} Reply with only the text of this version.`;
  if (!earlier) return base;
  return `${base}\n\nThe author did not take this attempt, so write something different from it:\n<selection from="an earlier attempt">\n${fence(earlier)}\n</selection>`;
}

/** How many can run at once with this profile. */
export function concurrencyFor(profile: Pick<AiProfile, 'isCloud'>, count: number = VERSION_COUNT): number {
  return profile.isCloud ? count : 1;
}

/** A model told which version it is writing may say so first, and that is not part of it. */
export function withoutVersionLabel(text: string): string {
  return text.replace(/^\s*(?:[*_#]+\s*)*version\s+\d+(?:\s+of\s+\d+)?\s*(?:[*_]+\s*)*[:.–—-]+\s*(?:[*_]+\s*)*\n*/i, '');
}

export type VersionStatus = 'queued' | 'starting' | 'thinking' | 'writing' | 'done' | 'stopped' | 'failed';

export interface VersionState {
  index: number;
  status: VersionStatus;
  /** What it has written so far, with figure markers taken out. */
  text: string;
  /** Why it cannot be used, in words for a person. */
  problem: string | null;
}

export interface VersionsRequest {
  instruction: string;
  label: string;
  action: EditAction;
  profileId?: string;
  /** A writing style for these versions, as for a single edit. */
  styleId?: string;
}

export function isBusy(status: VersionStatus): boolean {
  return status === 'queued' || status === 'starting' || status === 'thinking' || status === 'writing';
}

/** One run of the versions for one tracked range. */
export class VersionRun {
  states: VersionState[];

  private readonly results = new Map<number, AiResult>();
  /** Stops for what is under way, by version. A version asked for again has a new one. */
  private readonly running = new Map<number, () => void>();
  private readonly limit: number;
  private queue: { index: number; earlier?: string }[] = [];
  private prompt: Promise<{ system: string; content: ContentBlock[] }> | null = null;
  private readonly targetText: string;

  constructor(
    private readonly edit: Pick<EditRequest, 'editor' | 'source' | 'action' | 'instruction' | 'label' | 'styleId'>,
    private readonly profile: AiProfile,
    private readonly targetId: string,
    private readonly onChange: (states: VersionState[]) => void,
    private readonly count: number = VERSION_COUNT,
  ) {
    const range = trackedRange(edit.editor, targetId);
    const planned = range ? planEdit(edit.editor.state.doc, edit.action, range.from, range.to) : null;
    this.targetText = planned?.targetText ?? '';
    this.limit = concurrencyFor(profile, count);
    this.states = Array.from({ length: count }, (_, index): VersionState => ({ index, status: 'queued', text: '', problem: null }));
  }

  private update(index: number, patch: Partial<VersionState>): void {
    this.states = this.states.map((state) => (state.index === index ? { ...state, ...patch } : state));
    this.onChange(this.states);
  }

  /** Every version, in order. */
  start(): void {
    // What it reads now is what it answers about. Edits from here on make its answer stale.
    markRead(this.edit.editor, this.targetId);
    this.queue = this.states.map((state) => ({ index: state.index }));
    this.pump();
  }

  /** Built once, so every version reads the same lore. Built again only after a failure. */
  private promptNow(): Promise<{ system: string; content: ContentBlock[] }> {
    this.prompt ??= (async () => {
      if (this.profile.isCloud && (await isSourceLocalOnly(this.edit.source))) {
        throw new AiError('LOCAL_ONLY', withheldMessage(this.edit.source.title, this.profile));
      }
      return editPrompt(this.edit, this.profile, this.targetText);
    })();
    return this.prompt;
  }

  /** Asks for this one again, keeping the others as they are. */
  regenerate(index: number): void {
    const earlier = this.states[index].text.trim() || undefined;
    this.running.get(index)?.();
    this.running.delete(index);
    this.results.delete(index);
    this.queue = this.queue.filter((item) => item.index !== index);
    this.queue.push({ index, earlier });
    this.update(index, { status: 'queued', text: '', problem: null });
    this.pump();
  }

  /** Stops everything under way, and whatever has not started. */
  stopAll(): void {
    for (const { index } of this.queue) this.update(index, { status: 'stopped' });
    this.queue = [];
    for (const stop of this.running.values()) stop();
  }

  private pump(): void {
    while (this.running.size < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) void this.runOne(next.index, next.earlier);
    }
  }

  private async runOne(index: number, earlier?: string): Promise<void> {
    let handle: StreamHandle | null = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      handle?.cancel();
    };
    // Holds this one's place from now on, so the limit stays true while its prompt is built.
    this.running.set(index, stop);
    // Once this version is asked for again, a late reply from this request means nothing.
    const isCurrent = () => this.running.get(index) === stop;
    const show = (patch: Partial<VersionState>) => {
      if (isCurrent()) this.update(index, patch);
    };

    show({ status: 'starting', text: '', problem: null });
    let text = '';
    let thinking = false;
    const batch = frameBatcher(() => {
      show({ status: text ? 'writing' : thinking ? 'thinking' : 'starting', text: stripMarkers(withoutVersionLabel(text)), problem: null });
    });
    try {
      const prompt = await this.promptNow().catch((e: unknown) => {
        this.prompt = null;
        throw e;
      });
      if (stopped) {
        show({ status: 'stopped' });
        return;
      }
      const messages: AiMessage[] = [{ role: 'user', content: [...prompt.content, { type: 'text', text: versionPrompt(index, earlier, this.count) }] }];
      handle = stream(
        { task: 'rewrite', profileId: this.profile.id, system: prompt.system, messages },
        {
          onText: (piece) => {
            text += piece;
            batch.schedule();
          },
          onThinking: () => {
            thinking = true;
            batch.schedule();
          },
          onRetrying: (_attempt, delayMs) => {
            show({ problem: t('The server is busy. Trying again in {seconds} s…', { seconds: Math.ceil(delayMs / 1000) }) });
          },
        },
      );
      const result = await handle.done;
      batch.flush();
      if (isCurrent()) this.settle(index, result);
    } catch (e) {
      batch.flush();
      if (e instanceof AiError && e.code === 'DECLINED') show({ status: 'stopped', problem: null });
      else show({ status: 'failed', problem: e instanceof AiError ? e.message : errorMessage(e) });
    } finally {
      if (isCurrent()) this.running.delete(index);
      this.pump();
    }
  }

  private settle(index: number, result: AiResult): void {
    switch (result.stopReason) {
      case 'cancelled':
        this.update(index, { status: 'stopped', problem: null });
        return;
      case 'refusal':
        // What came before a refusal is discarded, never shown as if it were complete.
        this.update(index, { status: 'failed', text: '', problem: refusalMessage(result) });
        return;
      case 'max_tokens':
        this.update(index, { status: 'failed', problem: t('This one is incomplete, so it cannot be used. {reason}', { reason: maxTokensMessage() }) });
        return;
      default: {
        const clean = withoutVersionLabel(result.text);
        if (!clean.trim()) {
          this.update(index, { status: 'failed', problem: t('The model did not write anything.') });
          return;
        }
        this.results.set(index, { ...result, text: clean });
        this.update(index, { status: 'done', text: stripMarkers(clean), problem: null });
      }
    }
  }

  /** Stops the others, and turns this version into tracked changes to accept or reject. */
  choose(index: number): EditOutcome {
    const result = this.results.get(index);
    if (!result) return { kind: 'failed', code: 'NOT_READY', message: t('That version is not finished.') };
    this.stopAll();
    return finishEdit(result, this.edit, this.targetId, this.targetText);
  }
}
