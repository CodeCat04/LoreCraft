/** Shapes shared across the AI module. Blocks match `src-tauri/src/ai/types.rs`. */

import type { AiTask } from '../lib/settings';

export type { AiTask };

/** Your words or the model's. `hidden` text is sent to the model but not shown as chat. */
export interface TextBlock {
  type: 'text';
  text: string;
  /** Marks the end of the stable part of a prompt, for provider caching. */
  cache?: boolean;
  provider?: string;
  model?: string;
  /** The provider's own block, replayed unchanged to that provider. */
  raw?: unknown;
  hidden?: boolean;
  /** A short name for hidden text, shown as a chip. */
  label?: string;
  /** What the conversation shows instead of `text`, as when a prompt was filled in. */
  display?: string;
  /** What this block delivered, so a later turn does not send it again. */
  contextItems?: { id: string; hash: string }[];
  /** Holds local-only material, so this message never goes to a cloud profile. */
  localOnly?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  provider?: string;
  model?: string;
  raw?: unknown;
}

export interface ToolCallBlock {
  type: 'toolCall';
  id: string;
  name: string;
  input: unknown;
  /** The raw text, if the model's input was not valid JSON. Such a call never runs. */
  invalid?: string;
  provider?: string;
  model?: string;
  raw?: unknown;
}

export interface ToolResultBlock {
  type: 'toolResult';
  toolCallId: string;
  name?: string;
  content: string;
  isError?: boolean;
  /** Holds local-only material, so this message never goes to a cloud profile. */
  localOnly?: boolean;
}

/** A picture for a vision model. See `describeImage` in `vision.ts`. */
export interface ImageBlock {
  type: 'image';
  mime: string;
  base64: string;
}

/** A provider block with nothing to show, kept only so it can be replayed. */
export interface OpaqueBlock {
  type: 'opaque';
  provider: string;
  model?: string;
  raw: unknown;
}

/** How a turn ended, for the conversation view. Not sent to any model. */
export interface StatusBlock {
  type: 'status';
  stopReason: StopReason;
  explanation?: string;
  category?: string | null;
  /** Text from a refused response. Shown as gone, and never replayed. */
  discarded?: string;
}

export interface CostBlock {
  type: 'cost';
  costUsd: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | ImageBlock
  | OpaqueBlock
  | StatusBlock
  | CostBlock;

export interface AiMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'pause_turn'
  | 'refusal'
  | 'stop_sequence'
  | 'cancelled'
  | (string & {});

export interface Usage {
  /** All input, including anything read from or written to a cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface StopDetails {
  category: string | null;
  explanation: string | null;
  recommendedModel: string | null;
}

/** Normalized events from `ai_stream`. */
export type StreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'toolStart'; id: string; name: string }
  | { type: 'toolCall'; id: string; name: string; input: unknown; invalid?: string }
  | ({ type: 'usage' } & Usage)
  | { type: 'retrying'; attempt: number; delayMs: number; reason: string }
  | { type: 'fallback'; from: string; to: string }
  | {
      type: 'done';
      stopReason: StopReason;
      stopDetails: StopDetails | null;
      content: ContentBlock[];
      model: string;
      provider: string;
      fallback: { from: string; to: string } | null;
    }
  | { type: 'error'; code: string; message: string; partial: ContentBlock[] };

export interface StoredConversation {
  id: string;
  title: string;
  context: ConversationSettings;
  createdAt: string;
  updatedAt: string;
}

/** The page a conversation's model plays. */
export interface CharacterRef {
  pageId: string;
  title: string;
}

/** Choices that belong to one conversation. */
export interface ConversationSettings {
  pinned?: string[];
  excluded?: string[];
  /** Spoiler control: nothing after this node is known. */
  asOfNodeId?: string | null;
  profileId?: string;
  model?: string;
  /** The model plays this character, rather than being the assistant. */
  character?: CharacterRef;
  /** A writing style for this chat alone, over the scene's, book's and project's. */
  styleId?: string | null;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: ContentBlock[];
  profileId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

export type PromptScope = 'selection' | 'page' | 'scene' | 'chat';
/** `replace` rewrites the target, `insert` adds after it, `metadata` fills in a field. */
export type PromptAction = 'replace' | 'insert' | 'metadata' | 'chat';

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  template: string;
  scope: PromptScope;
  action: PromptAction;
  builtin: boolean;
  position: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
}

/** A model server that answered on this computer. */
export interface FoundServer {
  port: number;
  baseUrl: string;
  models: string[];
  needsKey: boolean;
}

export interface ConnectionResult {
  ok: boolean;
  code?: string;
  message: string;
  models?: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requests: number;
  byModel: {
    profileId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    requests: number;
  }[];
}
