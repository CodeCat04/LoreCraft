/**
 * The interface other modules use to talk to a model.
 *
 *   stream(request, handlers)  Streams one response. Returns `{ id, cancel, done }`.
 *   complete(request)          One response as a whole. Rejects if it has no usable text.
 *   completeJson(request, validate, options)
 *                              JSON that has passed your validator, retrying with a repair
 *                              prompt if not. Uses structured output where available.
 *
 * Every call is routed by `request.task` through `settings.ai.routing`, unless it names a
 * `profileId`. All of them record usage and ask before the first send to a cloud provider.
 * Failures reject with an `AiError`, whose `code` is stable and `message` is for people.
 *
 * The usual call from another module:
 *
 *   const claims = await completeJson(
 *     { task: 'consistency', system: '...', prompt: '...', schema: { name: 'claims', schema: {...} } },
 *     (value) => { if (!Array.isArray(value)) throw new Error('Expected a list.'); return value as Claim[]; },
 *   );
 *
 * A `validate` function throws to reject a value, and its message is what the model is told.
 */

import { Channel, invoke } from '@tauri-apps/api/core';

import { useSettings } from '../state/settings';
import { useProject } from '../state/project';
import { choose } from '../shell/dialogs';
import { LOCAL_PROFILE_ID, type AiProfile, type AiTask } from '../lib/settings';
import * as api from './api';
import { extractJson } from './json';
import { t } from '../lib/i18n';
import { askToOverride, limitMessage, limitReached, recordSpend } from './limits/spending';
import type {
  AiMessage,
  ContentBlock,
  StopDetails,
  StopReason,
  StreamEvent,
  ToolCallBlock,
  ToolDef,
  Usage,
} from './types';

export interface AiRequest {
  /** Chooses the profile through `settings.ai.routing`. */
  task: AiTask;
  /** Overrides routing. */
  profileId?: string;
  /** Overrides the profile's model. */
  model?: string;
  /** Keep this identical across a conversation: thinking and caching both depend on it. */
  system?: string;
  /** The conversation so far. Append only. Earlier turns must not change. */
  messages?: AiMessage[];
  /** Shorthand for one user message with this text. */
  prompt?: string;
  tools?: ToolDef[];
  /** `auto` by default. No provider here can force a call, so steer from the prompt. */
  toolChoice?: 'auto' | 'none';
  /** Output limit. Thinking counts against it, so leave room. */
  maxTokens?: number;
  effort?: string;
  /** JSON Schema for structured output, where the provider supports it. */
  schema?: { name: string; schema: Record<string, unknown> };
  /** Let the growing end of a multi-turn chat be cached. */
  autoCache?: boolean;
  /** A stable id for a conversation, used as a caching hint. */
  cacheKey?: string;
  signal?: AbortSignal;
  /** Nobody is waiting: never ask the person anything, and step aside for their requests. */
  background?: boolean;
}

export interface StreamHandlers {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  /** A tool call began. Its input is not there yet. */
  onToolStart?: (id: string, name: string) => void;
  /** A tool call's input is complete. Check `invalid` before using it. */
  onToolCall?: (call: ToolCallBlock) => void;
  onUsage?: (usage: Usage) => void;
  /** The server is busy and the request will be sent again after a wait. */
  onRetrying?: (attempt: number, delayMs: number, reason: string) => void;
  /** A fallback model is finishing this response. */
  onFallback?: (from: string, to: string) => void;
}

export interface AiResult {
  /** All text of the response. For a refusal, this is what arrived before it. */
  text: string;
  thinking: string;
  /** The assistant turn as blocks, to store and to send back on the next turn. */
  content: ContentBlock[];
  toolCalls: ToolCallBlock[];
  /**
   * `end_turn`, `tool_use`, `max_tokens`, `pause_turn`, `refusal` or `cancelled`. Always
   * check it: a refusal is not an error, and tools must not run on a `max_tokens` turn.
   */
  stopReason: StopReason;
  stopDetails: StopDetails | null;
  usage: Usage | null;
  /** An estimate from the profile's rates, or null if it has none. */
  costUsd: number | null;
  model: string;
  profileId: string;
  provider: string;
  fallback: { from: string; to: string } | null;
}

export interface StreamHandle {
  id: string;
  /** Stops the response. `done` then resolves with `stopReason: 'cancelled'`. */
  cancel: () => void;
  done: Promise<AiResult>;
}

/**
 * Codes include `SERVER_DOWN`, `NO_KEY`, `BAD_KEY`, `UNKNOWN_MODEL`, `NO_MODEL`,
 * `CONTEXT_TOO_LONG`, `RATE_LIMITED`, `OVERLOADED`, `BILLING`, `BAD_REQUEST`, `IDLE_TIMEOUT`,
 * `STREAM_BROKEN`, `SERVER_ERROR`, `IMAGES_NOT_SUPPORTED`, and from this file `DECLINED`
 * (the person said no to a cloud send), `REFUSAL`, `CANCELLED`, `MAX_TOKENS`, `EMPTY`,
 * `BAD_JSON`.
 */
export class AiError extends Error {
  readonly code: string;
  /** Whatever arrived before the failure. */
  readonly partial: ContentBlock[];
  /** The full result, when a response finished but could not be used. */
  readonly result?: AiResult;
  constructor(code: string, message: string, partial: ContentBlock[] = [], result?: AiResult) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.partial = partial;
    this.result = result;
  }
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export function allProfiles(): AiProfile[] {
  return useSettings.getState().settings.ai.profiles;
}

/** The profile a task goes to. A missing one falls back rather than failing outright. */
export function profileForTask(task: AiTask, profileId?: string): AiProfile {
  const { profiles, routing } = useSettings.getState().settings.ai;
  const wanted = profileId ?? routing[task];
  const found = profiles.find((p) => p.id === wanted) ?? profiles.find((p) => p.id === LOCAL_PROFILE_ID) ?? profiles[0];
  if (!found) {
    throw new AiError('NO_PROFILE', t('No AI profile is set up. Add one in Settings > AI.'));
  }
  return found;
}

export function providerLabel(profile: AiProfile): string {
  if (profile.kind === 'anthropic') return 'Anthropic';
  if (profile.kind === 'openai') return 'OpenAI';
  return profile.name || t('the model server');
}

/** What a response cost, by the profile's rates. Cached input is billed at a fraction. */
export function estimateCost(usage: Usage, profile: AiProfile): number | null {
  const input = profile.inputCostPerMTok;
  const output = profile.outputCostPerMTok;
  if (input === undefined && output === undefined) return null;
  const inRate = input ?? 0;
  const outRate = output ?? 0;
  const plain = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const inputCost = plain * inRate + usage.cacheWriteTokens * inRate * 1.25 + usage.cacheReadTokens * inRate * 0.1;
  return (inputCost + usage.outputTokens * outRate) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Asking before anything leaves the computer
// ---------------------------------------------------------------------------

const confirmedThisRun = new Set<string>();
const openConsents = new Map<string, Promise<void>>();

async function askConsent(profile: AiProfile): Promise<void> {
  const provider = providerLabel(profile);
  const choice = await choose<'no' | 'yes' | 'always'>({
    title: t('Send this to {provider}?', { provider }),
    message: t(
      '"{profile}" sends your request, and the lore and text that go with it, to {provider}\'s servers. Your project stays on this computer otherwise. The context view shows exactly what is included.',
      { profile: profile.name, provider },
    ),
    dismissValue: 'no',
    choices: [
      { label: t('Cancel'), value: 'no' },
      { label: t("Send, and don't ask again"), value: 'always' },
      { label: t('Send'), value: 'yes', tone: 'primary' },
    ],
  });
  if (choice === 'no') throw new AiError('DECLINED', t('Nothing was sent to {provider}.', { provider }));
  confirmedThisRun.add(profile.id);
  if (choice === 'always') await useSettings.getState().update({ ai: { cloudWarningDismissed: true } });
}

/** Asks once per run, per cloud profile, unless the person has turned the question off. */
export function ensureCloudConsent(profile: AiProfile): Promise<void> {
  if (!profile.isCloud) return Promise.resolve();
  if (useSettings.getState().settings.ai.cloudWarningDismissed) return Promise.resolve();
  if (confirmedThisRun.has(profile.id)) return Promise.resolve();
  let open = openConsents.get(profile.id);
  if (!open) {
    open = askConsent(profile).finally(() => openConsents.delete(profile.id));
    openConsents.set(profile.id, open);
  }
  return open;
}

// ---------------------------------------------------------------------------
// Who has answered lately
// ---------------------------------------------------------------------------

export interface AiActivity {
  profileId: string;
  /** The model that answered. Empty if that is not known yet. */
  model: string;
  /** `stopped` means the person stopped it before any answer, so it says nothing either way. */
  state: 'asking' | 'answered' | 'failed' | 'stopped';
  at: number;
}

const activityListeners = new Set<(activity: AiActivity) => void>();

/** Calls back as requests start and end, for the status bar. Returns how to stop. */
export function onAiActivity(listener: (activity: AiActivity) => void): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

function reportActivity(profileId: string, model: string, state: AiActivity['state']): void {
  activityListeners.forEach((listener) => listener({ profileId, model, state, at: Date.now() }));
}

// ---------------------------------------------------------------------------
// Spending, and work that nobody is waiting for
// ---------------------------------------------------------------------------

async function ensureWithinLimit(profile: AiProfile, background: boolean): Promise<void> {
  const state = limitReached(profile);
  if (!state) return;
  if (background || !(await askToOverride(state))) throw new AiError('SPENDING_LIMIT', limitMessage(state));
}

const foregroundListeners = new Set<(profileId: string) => void>();

/** Called when the person asks a model for something, so background work can step aside. */
export function onForegroundRequest(listener: (profileId: string) => void): () => void {
  foregroundListeners.add(listener);
  return () => {
    foregroundListeners.delete(listener);
  };
}

export { estimateRunCost, type RunCostEstimate } from './limits/estimate';

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

let nextStream = 1;

function newStreamId(): string {
  nextStream += 1;
  return `s${Date.now().toString(36)}-${nextStream.toString(36)}`;
}

function toWire(request: AiRequest, id: string, profile: AiProfile) {
  const messages =
    request.messages ??
    (request.prompt !== undefined ? [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }] : []);
  return {
    streamId: id,
    profileId: profile.id,
    model: request.model,
    system: request.system,
    messages,
    tools: request.tools ?? [],
    toolChoice: request.toolChoice,
    maxTokens: request.maxTokens,
    effort: request.effort,
    jsonSchema: request.schema,
    autoCache: request.autoCache ?? false,
    cacheKey: request.cacheKey,
  };
}

function recordUsage(request: AiRequest, profile: AiProfile, model: string, usage: Usage | null, cost: number | null) {
  recordSpend(profile, usage ? cost : null);
  if (!usage || !useProject.getState().status.open) return;
  void api.usage
    .record({
      profileId: profile.id,
      model: model || profile.model,
      task: request.task,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: cost ?? 0,
    })
    .catch(() => {});
}

/**
 * Streams one response. Handlers can fire many times a second, so batch any UI work.
 * `done` resolves with the finished response, including a cancelled or refused one, and
 * rejects with an `AiError` if it failed.
 */
export function stream(request: AiRequest, handlers: StreamHandlers = {}): StreamHandle {
  const id = newStreamId();
  let cancelled = false;
  let started = false;
  const cancel = () => {
    cancelled = true;
    if (started) void invoke('ai_cancel', { streamId: id }).catch(() => {});
  };
  if (request.signal?.aborted) cancel();
  request.signal?.addEventListener('abort', cancel);

  const run = async (): Promise<AiResult> => {
    const profile = profileForTask(request.task, request.profileId);
    if (!request.background) {
      foregroundListeners.forEach((listener) => listener(profile.id));
      await ensureCloudConsent(profile);
    }
    await ensureWithinLimit(profile, request.background ?? false);

    return new Promise<AiResult>((resolve, reject) => {
      if (cancelled) {
        resolve({
          text: '', thinking: '', content: [], toolCalls: [], stopReason: 'cancelled', stopDetails: null,
          usage: null, costUsd: null, model: request.model ?? profile.model, profileId: profile.id, provider: '', fallback: null,
        });
        return;
      }
      let text = '';
      let thinking = '';
      let usage: Usage | null = null;
      const toolCalls: ToolCallBlock[] = [];
      reportActivity(profile.id, request.model ?? profile.model, 'asking');
      const channel = new Channel<StreamEvent>();
      channel.onmessage = (event) => {
        switch (event.type) {
          case 'text':
            text += event.text;
            handlers.onText?.(event.text);
            break;
          case 'thinking':
            thinking += event.text;
            handlers.onThinking?.(event.text);
            break;
          case 'toolStart':
            handlers.onToolStart?.(event.id, event.name);
            break;
          case 'toolCall': {
            const call: ToolCallBlock = { type: 'toolCall', id: event.id, name: event.name, input: event.input, invalid: event.invalid };
            toolCalls.push(call);
            handlers.onToolCall?.(call);
            break;
          }
          case 'usage':
            usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cacheReadTokens: event.cacheReadTokens,
              cacheWriteTokens: event.cacheWriteTokens,
              reasoningTokens: event.reasoningTokens,
            };
            handlers.onUsage?.(usage);
            break;
          case 'retrying':
            handlers.onRetrying?.(event.attempt, event.delayMs, event.reason);
            break;
          case 'fallback':
            handlers.onFallback?.(event.from, event.to);
            break;
          case 'done': {
            const model = event.model || (request.model ?? profile.model);
            const cost = usage ? estimateCost(usage, profile) : null;
            recordUsage(request, profile, model, usage, cost);
            reportActivity(profile.id, model, event.stopReason === 'cancelled' && !text ? 'stopped' : 'answered');
            resolve({
              text,
              thinking,
              content: event.content,
              toolCalls,
              stopReason: event.stopReason,
              stopDetails: event.stopDetails,
              usage,
              costUsd: cost,
              model,
              profileId: profile.id,
              provider: event.provider,
              fallback: event.fallback,
            });
            break;
          }
          case 'error':
            recordUsage(request, profile, request.model ?? profile.model, usage, usage ? estimateCost(usage, profile) : null);
            reportActivity(profile.id, request.model ?? profile.model, 'failed');
            reject(new AiError(event.code, event.message, event.partial));
            break;
        }
      };
      started = true;
      invoke('ai_stream', { request: toWire(request, id, profile), onEvent: channel }).catch((e: unknown) => {
        reject(new AiError('INTERNAL', t('The AI request could not start: {reason}', { reason: String(e) })));
      });
    });
  };

  const done = run();
  done.catch(() => {}).finally(() => request.signal?.removeEventListener('abort', cancel));
  return { id, cancel, done };
}

/** Why a finished response has no usable answer, in words for a person. */
export function refusalMessage(result: Pick<AiResult, 'stopDetails' | 'model'>): string {
  const explanation = result.stopDetails?.explanation;
  const base = result.model ? t('{model} declined this request.', { model: result.model }) : t('The model declined this request.');
  return explanation ? `${base} ${explanation}` : base;
}

/** Always in English. Use `maxTokensMessage()` for what people see. */
export const MAX_TOKENS_MESSAGE =
  'The model reached its output limit before it finished. Raise "Max tokens" in Settings > AI, or lower the effort.';

/** `MAX_TOKENS_MESSAGE` in the interface language. */
export function maxTokensMessage(): string {
  return t('The model reached its output limit before it finished. Raise "Max tokens" in Settings > AI, or lower the effort.');
}

/**
 * One whole response. Rejects with an `AiError` if there is no usable answer: a refusal
 * (`REFUSAL`), a cancel (`CANCELLED`), a limit reached with nothing written (`MAX_TOKENS`),
 * or no text at all (`EMPTY`). A response cut short that has text resolves, so check
 * `stopReason` if a partial answer matters.
 */
export async function complete(request: AiRequest, handlers: StreamHandlers = {}): Promise<AiResult> {
  const result = await stream(request, handlers).done;
  if (result.stopReason === 'refusal') throw new AiError('REFUSAL', refusalMessage(result), [], result);
  if (result.stopReason === 'cancelled') throw new AiError('CANCELLED', t('Stopped.'), result.content, result);
  if (!result.text.trim()) {
    if (result.stopReason === 'max_tokens') throw new AiError('MAX_TOKENS', maxTokensMessage(), [], result);
    throw new AiError('EMPTY', t('The model did not write anything. Try again, or try another profile.'), [], result);
  }
  return result;
}

export interface CompleteJsonOptions {
  /** How many times to ask again after a bad reply. Two by default. */
  repairs?: number;
  handlers?: StreamHandlers;
}

/**
 * JSON that has passed your validator. `validate` gets the parsed value and returns it,
 * possibly narrowed, or throws an `Error` saying what is wrong. The model is shown that
 * message on a retry, so make it specific.
 *
 * `request.schema` is used where the provider supports structured output. Otherwise, or
 * if a server refuses it, JSON is extracted from the text, which also fixes the usual
 * mistakes such as code fences, trailing commas and truncation. Rejects with `BAD_JSON`
 * if every attempt fails.
 */
export async function completeJson<T>(
  request: AiRequest,
  validate: (value: unknown) => T,
  options: CompleteJsonOptions = {},
): Promise<T> {
  const repairs = options.repairs ?? 2;
  const asJson =
    'Reply with only the JSON value, with no commentary and no code fence.';
  const system = request.system ? `${request.system}\n\n${asJson}` : asJson;
  const messages: AiMessage[] = [
    ...(request.messages ?? []),
    ...(request.prompt !== undefined ? [{ role: 'user' as const, content: [{ type: 'text' as const, text: request.prompt }] }] : []),
  ];

  let lastProblem = 'The reply was not valid JSON.';
  for (let attempt = 0; attempt <= repairs; attempt += 1) {
    const result = await complete({ ...request, system, messages, prompt: undefined }, options.handlers);
    const extracted = extractJson(result.text);
    if (extracted) {
      try {
        return validate(extracted.value);
      } catch (e) {
        lastProblem = e instanceof Error ? e.message : String(e);
      }
    } else {
      lastProblem = result.stopReason === 'max_tokens'
        ? 'The reply was cut off by the output limit. Reply again with less.'
        : 'The reply did not contain JSON.';
    }
    // Append only: the failed reply goes back as it was, then the correction.
    messages.push(
      { role: 'assistant', content: result.content },
      {
        role: 'user',
        content: [{ type: 'text', text: `That reply could not be used: ${lastProblem}\nReply again with only the corrected JSON.` }],
      },
    );
  }
  const tries = repairs + 1;
  throw new AiError(
    'BAD_JSON',
    tries === 1
      ? t('The model did not produce usable data after 1 try. {problem}', { problem: lastProblem })
      : t('The model did not produce usable data after {count} tries. {problem}', { count: tries, problem: lastProblem }),
  );
}
