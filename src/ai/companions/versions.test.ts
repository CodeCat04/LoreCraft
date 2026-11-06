import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiProfile } from '../../lib/settings';
import type { AiResult, StreamHandlers } from '../client';
import type { EditRequest } from '../../editor/ai/flow';
import { VersionRun, withoutVersionLabel, type VersionState } from './versions';

interface FakeStream {
  prompt: string;
  handlers: StreamHandlers;
  cancelled: boolean;
  finish: (text: string, stopReason?: string) => void;
  fail: (error: Error) => void;
}

const streams: FakeStream[] = [];
const finishEdit = vi.fn();

function resultOf(text: string, stopReason: string): AiResult {
  return {
    text, thinking: '', content: [], toolCalls: [], stopReason, stopDetails: null, usage: null,
    costUsd: null, model: 'm', profileId: 'p', provider: 'x', fallback: null,
  };
}

vi.mock('../client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../client')>();
  return {
    ...original,
    stream: (request: { messages: { content: { text: string }[] }[] }, handlers: StreamHandlers) => {
      let resolve: (result: AiResult) => void = () => {};
      let reject: (error: Error) => void = () => {};
      const done = new Promise<AiResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const content = request.messages[0].content;
      const fake: FakeStream = {
        prompt: content[content.length - 1].text,
        handlers,
        cancelled: false,
        finish: (text, stopReason = 'end_turn') => resolve(resultOf(text, stopReason)),
        fail: reject,
      };
      streams.push(fake);
      return {
        id: String(streams.length),
        done,
        cancel: () => {
          fake.cancelled = true;
          resolve(resultOf('', 'cancelled'));
        },
      };
    },
  };
});

vi.mock('../frames', () => ({
  frameBatcher: (apply: () => void) => ({ schedule: apply, flush: apply }),
}));

vi.mock('../../editor/ai/flow', () => ({
  editPrompt: async () => ({ system: 'S', content: [{ type: 'text', text: 'the request' }] }),
  planEdit: () => ({ from: 1, to: 2, targetText: 'the text' }),
  finishEdit: (...args: unknown[]) => finishEdit(...args),
}));

vi.mock('../../editor/ai/suggestions', () => ({
  markRead: () => {},
  trackedRange: () => ({ from: 1, to: 2, touched: false }),
}));

let markedLocalOnly = false;

vi.mock('../limits/localOnly', () => ({
  isSourceLocalOnly: async () => markedLocalOnly,
  withheldMessage: (title: string) => `${title} is marked local only.`,
}));

const edit = { editor: { state: { doc: {} } }, source: {}, action: 'replace', instruction: 'x', label: 'x' } as unknown as Pick<EditRequest, 'editor' | 'source' | 'action' | 'instruction' | 'label'>;
const profile = (isCloud: boolean) => ({ id: 'p', isCloud }) as AiProfile;

/** Lets everything waiting on a promise go ahead. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function makeRun(isCloud: boolean) {
  let latest: VersionState[] = [];
  const run = new VersionRun(edit, profile(isCloud), 't1', (states) => {
    latest = states;
  });
  return { run, states: () => latest, statuses: () => latest.map((s) => s.status) };
}

beforeEach(() => {
  streams.length = 0;
  finishEdit.mockReset();
  markedLocalOnly = false;
});

describe('several versions at work', () => {
  it('runs one at a time on a local server', async () => {
    const { run, statuses } = makeRun(false);
    run.start();
    await settle();
    expect(streams).toHaveLength(1);
    expect(streams[0].prompt).toContain('version 1 of 3');
    expect(statuses()).toEqual(['starting', 'queued', 'queued']);

    streams[0].finish('One.');
    await settle();
    expect(streams).toHaveLength(2);
    expect(streams[1].prompt).toContain('version 2 of 3');
    expect(statuses()).toEqual(['done', 'starting', 'queued']);

    streams[1].finish('Two.');
    await settle();
    streams[2].finish('Three.');
    await settle();
    expect(statuses()).toEqual(['done', 'done', 'done']);
  });

  it('runs them all at once on a cloud provider', async () => {
    const { run } = makeRun(true);
    run.start();
    await settle();
    expect(streams).toHaveLength(3);
  });

  it('streams text as it comes, with figure markers out of sight', async () => {
    const { run, states } = makeRun(false);
    run.start();
    await settle();
    streams[0].handlers.onThinking?.('hmm');
    expect(states()[0].status).toBe('thinking');
    streams[0].handlers.onText?.('First part.\n\n{{KEEP 1: [Figure 1: x]}}\n\nSecond part.');
    expect(states()[0].status).toBe('writing');
    expect(states()[0].text).toBe('First part.\n\nSecond part.');
  });

  it('stops what is running and what has not started', async () => {
    const { run, statuses } = makeRun(false);
    run.start();
    await settle();
    run.stopAll();
    await settle();
    expect(streams[0].cancelled).toBe(true);
    expect(streams).toHaveLength(1);
    expect(statuses()).toEqual(['stopped', 'stopped', 'stopped']);
  });

  it('asks for one again, leaving the rest alone, and tells it what not to repeat', async () => {
    const { run, states, statuses } = makeRun(true);
    run.start();
    await settle();
    streams.forEach((s, i) => s.finish(`Take ${i + 1}.`));
    await settle();
    run.regenerate(1);
    await settle();
    expect(streams).toHaveLength(4);
    expect(streams[3].prompt).toContain('Take 2.');
    expect(statuses()).toEqual(['done', 'starting', 'done']);
    streams[3].finish('A new take.');
    await settle();
    expect(states()[1].text).toBe('A new take.');
    expect(states()[0].text).toBe('Take 1.');
  });

  it('ignores a reply that comes after that version was asked for again', async () => {
    const { run, states, statuses } = makeRun(true);
    run.start();
    await settle();
    streams[0].handlers.onText?.('Old words');
    run.regenerate(0);
    await settle();
    expect(streams[0].cancelled).toBe(true);
    expect(streams).toHaveLength(4);
    streams[0].handlers.onText?.(' arriving late');
    expect(states()[0].text).toBe('');
    expect(statuses()[0]).toBe('starting');
    streams[3].finish('New words.');
    await settle();
    expect(statuses()[0]).toBe('done');
    expect(states()[0].text).toBe('New words.');
  });

  it('keeps to the limit when one running is asked for again', async () => {
    const { run } = makeRun(false);
    run.start();
    await settle();
    run.regenerate(0);
    await settle();
    // The old request is over, so its place goes to the next in line.
    expect(streams).toHaveLength(2);
    expect(streams[1].prompt).toContain('version 2 of 3');
  });

  it('will not offer what is cut off, refused, failed or empty', async () => {
    const { run, states, statuses } = makeRun(true);
    run.start();
    await settle();
    streams[0].finish('Half a sent', 'max_tokens');
    streams[1].finish('I started and then', 'refusal');
    streams[2].fail(new Error('Nothing is answering.'));
    await settle();
    expect(statuses()).toEqual(['failed', 'failed', 'failed']);
    expect(states()[0].problem).toContain('incomplete');
    expect(states()[1].text).toBe('');
    expect(states()[1].problem).toContain('declined');
    expect(states()[2].problem).toContain('Nothing is answering.');
    expect(run.choose(0)).toEqual({ kind: 'failed', code: 'NOT_READY', message: 'That version is not finished.' });
    expect(finishEdit).not.toHaveBeenCalled();
  });

  it('counts a person saying no to a cloud send as stopped, not as a failure', async () => {
    const { AiError } = await import('../client');
    const { run, statuses } = makeRun(true);
    run.start();
    await settle();
    streams.forEach((s) => s.fail(new AiError('DECLINED', 'Nothing was sent.')));
    await settle();
    expect(statuses()).toEqual(['stopped', 'stopped', 'stopped']);
  });

  it('sends nothing to a cloud profile from a document marked local only', async () => {
    markedLocalOnly = true;
    const { run, states, statuses } = makeRun(true);
    run.start();
    await settle();
    expect(streams).toHaveLength(0);
    expect(statuses()).toEqual(['failed', 'failed', 'failed']);
    expect(states()[0].problem).toContain('local only');

    const local = makeRun(false);
    local.run.start();
    await settle();
    expect(streams).toHaveLength(1);
  });

  it('choosing one stops the others and goes through the usual step to a suggestion', async () => {
    finishEdit.mockReturnValue({ kind: 'suggested', suggestionId: 's', changes: 2 });
    const { run } = makeRun(true);
    run.start();
    await settle();
    streams[1].finish('**Version 2:** The chosen words.');
    await settle();
    expect(run.choose(1)).toEqual({ kind: 'suggested', suggestionId: 's', changes: 2 });
    expect(streams[0].cancelled).toBe(true);
    expect(streams[2].cancelled).toBe(true);
    const [result, request, targetId, targetText] = finishEdit.mock.calls[0];
    expect(result.text).toBe('The chosen words.');
    expect(request).toBe(edit);
    expect(targetId).toBe('t1');
    expect(targetText).toBe('the text');
  });
});

describe('withoutVersionLabel', () => {
  it('takes off what a model says about which version it is', () => {
    expect(withoutVersionLabel('Version 2: The words.')).toBe('The words.');
    expect(withoutVersionLabel('**Version 2 of 3:**\nThe words.')).toBe('The words.');
    expect(withoutVersionLabel('## Version 1 -\n\nThe words.')).toBe('The words.');
  });

  it('leaves the text alone otherwise', () => {
    expect(withoutVersionLabel('The words.')).toBe('The words.');
    expect(withoutVersionLabel('Version 2 of the plan was worse.')).toBe('Version 2 of the plan was worse.');
    expect(withoutVersionLabel('The version 2: it worked.')).toBe('The version 2: it worked.');
  });
});
