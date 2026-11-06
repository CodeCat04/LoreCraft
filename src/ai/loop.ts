/**
 * Runs a response through as many tool rounds as it needs, up to a limit. History only
 * ever grows, as thinking and caching both require.
 */

import { stream, type AiRequest, type AiResult, type StreamHandle, type StreamHandlers } from './client';
import { runTool, type ToolContext } from './tools';
import type { AiMessage, ContentBlock, ToolCallBlock, ToolResultBlock } from './types';

/** Rounds of tool calls before the model must answer with what it has. */
export const MAX_TOOL_ROUNDS = 8;
/** Resuming a paused turn is bounded too, so a stuck one cannot loop forever. */
const MAX_CONTINUATIONS = 5;

export interface LoopOptions {
  handlers?: StreamHandlers;
  context: ToolContext;
  maxRounds?: number;
  /** Called with each stream as it starts, so the caller can stop it. */
  onStream?: (handle: StreamHandle) => void;
  /** Called with each finished assistant turn, before any of its tools run. */
  onAssistantTurn?: (content: ContentBlock[], result: AiResult) => void | Promise<void>;
  /** Called with a turn's tool results, when they are ready. */
  onToolResults?: (results: ToolResultBlock[]) => void | Promise<void>;
  /** True once the person has asked to stop. */
  isStopped?: () => boolean;
}

function callsIn(content: ContentBlock[]): ToolCallBlock[] {
  return content.flatMap((block) => (block.type === 'toolCall' ? [block] : []));
}

/** Runs to the final response. Rejects if a request fails. Tools run only on `tool_use`. */
export async function runToolLoop(request: AiRequest, options: LoopOptions): Promise<AiResult> {
  const messages: AiMessage[] = [...(request.messages ?? [])];
  const maxRounds = options.maxRounds ?? MAX_TOOL_ROUNDS;
  let rounds = 0;
  let continuations = 0;

  for (;;) {
    const handle = stream(
      {
        ...request,
        messages,
        prompt: undefined,
        // Out of rounds: the tools stay declared, so the prefix holds, but it must answer.
        toolChoice: rounds >= maxRounds ? 'none' : request.toolChoice,
      },
      options.handlers,
    );
    options.onStream?.(handle);
    const result = await handle.done;

    // A refused or cut-off turn must not run its tools: its input may be incomplete.
    if (result.stopReason !== 'tool_use' && result.stopReason !== 'pause_turn') return result;

    await options.onAssistantTurn?.(result.content, result);
    messages.push({ role: 'assistant', content: result.content });

    if (result.stopReason === 'pause_turn') {
      // The provider resumes from what it is sent back. A new user message is not needed.
      continuations += 1;
      if (continuations > MAX_CONTINUATIONS) return result;
      continue;
    }

    const calls = callsIn(result.content);
    if (calls.length === 0) return result;
    rounds += 1;

    const stopped = options.isStopped?.() ?? false;
    const results: ToolResultBlock[] = stopped
      ? calls.map((call) => ({
          type: 'toolResult', toolCallId: call.id, name: call.name, isError: true,
          content: 'The author stopped this before it ran.',
        }))
      : await Promise.all(calls.map((call) => runTool(call, options.context)));
    // Results for one turn go back together, in one message.
    await options.onToolResults?.(results);
    messages.push({ role: 'user', content: results });
    if (stopped) return { ...result, stopReason: 'cancelled', text: '', content: [] };
  }
}
