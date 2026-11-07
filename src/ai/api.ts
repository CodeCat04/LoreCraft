/** Typed wrappers over the `ai.*` RPC. API keys go in and never come back. */

import { rpc } from '../lib/rpc';
import type {
  ConnectionResult,
  ContentBlock,
  ConversationSettings,
  FoundServer,
  ModelInfo,
  PromptAction,
  PromptScope,
  PromptTemplate,
  StoredConversation,
  StoredMessage,
  UsageTotals,
} from './types';

export const keys = {
  set: (profileId: string, key: string) => rpc<boolean>('ai.setKey', { profileId, key }),
  has: (profileId: string) => rpc<boolean>('ai.hasKey', { profileId }),
  remove: (profileId: string) => rpc<boolean>('ai.deleteKey', { profileId }),
};

export const provider = {
  listModels: (profileId: string) => rpc<ModelInfo[]>('ai.listModels', { profileId }),
  testConnection: (profileId: string) => rpc<ConnectionResult>('ai.testConnection', { profileId }),
  imageSupport: (profileId: string) =>
    rpc<{ supported: boolean; source: 'setting' | 'default' | 'detected' }>('ai.imageSupport', { profileId }),
  /** Tries the usual ports on 127.0.0.1. Only ever called because the person asked. */
  findLocalServers: () => rpc<FoundServer[]>('ai.findLocalServers'),
};

export const conversations = {
  list: () => rpc<StoredConversation[]>('ai.listConversations'),
  create: (title: string, context: ConversationSettings = {}) =>
    rpc<StoredConversation>('ai.createConversation', { title, context }),
  get: (id: string) =>
    rpc<{ conversation: StoredConversation; messages: StoredMessage[] }>('ai.getConversation', { id }),
  update: (id: string, patch: { title?: string; context?: ConversationSettings; leafId?: string }) =>
    rpc<StoredConversation>('ai.updateConversation', { id, ...patch }),
  remove: (id: string) => rpc<boolean>('ai.deleteConversation', { id }),
};

export const messages = {
  add: (input: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: ContentBlock[];
    profileId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    /** What this follows: null starts the chat, and leaving it out follows the version on screen. */
    parentId?: string | null;
  }) => rpc<StoredMessage>('ai.addMessage', input),
  /** Removes this message and everything that follows it, for retrying. Other versions stay. */
  removeFrom: (id: string) => rpc<number>('ai.deleteMessagesFrom', { id }),
};

export const prompts = {
  list: (scope?: PromptScope) => rpc<PromptTemplate[]>('ai.listPrompts', { scope }),
  save: (input: {
    id?: string;
    name: string;
    description?: string;
    template: string;
    scope: PromptScope;
    action?: PromptAction;
  }) => rpc<PromptTemplate>('ai.savePrompt', input),
  /** Removes a prompt. Doing this to a built-in restores its original text. */
  remove: (id: string) => rpc<boolean>('ai.deletePrompt', { id }),
};

export const usage = {
  record: (input: {
    profileId: string;
    model: string;
    task: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }) => rpc<boolean>('ai.recordUsage', input),
  totals: () => rpc<UsageTotals>('ai.usageTotals'),
};
