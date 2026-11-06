/**
 * Turns a stored conversation into messages for the next request.
 *
 * On providers that preserve thinking, a thinking block is only valid while everything
 * before it is unchanged, so history is append-only. Past turns are sent exactly as they
 * were stored. The one time something is removed is when a conversation outgrows its
 * budget: the oldest whole turns go, and since that invalidates any thinking replayed
 * after them, all of it is dropped along with them.
 */

import { estimateTokens } from './context';
import type { AiMessage, ContentBlock, StoredMessage, ToolResultBlock } from './types';

function hasWords(content: ContentBlock[]): boolean {
  return content.some((b) => b.type === 'text' && b.text.trim().length > 0);
}

/** True for a message that begins a new turn, rather than continuing a tool loop. */
function startsTurn(message: { role: string; content: ContentBlock[] }): boolean {
  return message.role === 'user' && hasWords(message.content);
}

function blockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
    case 'thinking':
      return estimateTokens(block.text);
    case 'toolCall':
      return estimateTokens(JSON.stringify(block.input ?? {})) + 12;
    case 'toolResult':
      return estimateTokens(block.content) + 8;
    case 'image':
      return 1500;
    default:
      return 0;
  }
}

export function messagesTokens(messages: { content: ContentBlock[] }[]): number {
  return messages.reduce((sum, message) => sum + message.content.reduce((n, block) => n + blockTokens(block), 8), 0);
}

/**
 * A tool call must be answered before the next turn. A call can be left unanswered if the
 * person stopped the loop, the response hit its limit, or the app closed mid-loop.
 */
export function answerOpenCalls(messages: AiMessage[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    out.push(message);
    if (message.role !== 'assistant') continue;
    const calls = message.content.flatMap((b) => (b.type === 'toolCall' ? [b] : []));
    if (calls.length === 0) continue;
    const next = messages[i + 1];
    const answered = new Set(
      next?.role === 'user' ? next.content.flatMap((b) => (b.type === 'toolResult' ? [b.toolCallId] : [])) : [],
    );
    const missing = calls.filter((c) => !answered.has(c.id));
    if (missing.length > 0) {
      const results: ToolResultBlock[] = missing.map((call) => ({
        type: 'toolResult', toolCallId: call.id, name: call.name, isError: true,
        content: 'This call did not run, because the turn ended first.',
      }));
      if (next?.role === 'user' && next.content.some((b) => b.type === 'toolResult')) {
        messages[i + 1] = { ...next, content: [...results, ...next.content] };
      } else {
        out.push({ role: 'user', content: results });
      }
    }
  }
  return out;
}

/**
 * What can go to a provider from one stored message. A refused response is dropped, since
 * it must not be treated as complete. So is a turn with no output, which has nothing to
 * replay and which some providers refuse.
 */
function replayable(message: StoredMessage): AiMessage | null {
  const content = message.content;
  if (message.role === 'user') return { role: 'user', content };
  if (content.some((b) => b.type === 'status' && b.stopReason === 'refusal')) return null;
  const hasOutput = content.some(
    (b) => (b.type === 'text' && b.text.length > 0) || b.type === 'toolCall' || (b.type === 'opaque' && isServerToolUse(b.raw)),
  );
  return hasOutput ? { role: 'assistant', content } : null;
}

function isServerToolUse(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { type?: string }).type === 'server_tool_use';
}

export interface PreparedHistory {
  messages: AiMessage[];
  tokens: number;
  /** Older turns had to go to fit the budget. */
  trimmed: boolean;
}

function stripThinking(messages: AiMessage[]): AiMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.filter((b) => b.type !== 'thinking' && b.type !== 'opaque'),
  }));
}

/** Stored messages as a valid history that fits in `budgetTokens`. */
export function prepareHistory(stored: StoredMessage[], budgetTokens: number): PreparedHistory {
  let messages = answerOpenCalls(stored.flatMap((m) => replayable(m) ?? []));
  let tokens = messagesTokens(messages);
  let trimmed = false;
  while (tokens > budgetTokens && messages.length > 1) {
    // Whole turns only, so a tool call is never separated from its result.
    let next = -1;
    for (let i = 1; i < messages.length; i += 1) {
      if (startsTurn(messages[i])) {
        next = i;
        break;
      }
    }
    if (next < 0) break;
    messages = messages.slice(next);
    tokens = messagesTokens(messages);
    trimmed = true;
  }
  if (trimmed) {
    messages = stripThinking(messages);
    tokens = messagesTokens(messages);
  }
  return { messages, tokens, trimmed };
}
