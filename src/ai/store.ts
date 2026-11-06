/**
 * The AI pane's state. It lives outside the pane so a response keeps going if the pane is
 * closed, and so an editor can send a selection to it. Conversations are stored as they
 * happen: a response cut off halfway leaves the conversation in a state that still works.
 */

import { create } from 'zustand';

import * as coreApi from '../lib/api';
import { relationshipList } from '../extras/api';
import { errorMessage } from '../lib/rpc';
import type { AiProfile } from '../lib/settings';
import { useSettings } from '../state/settings';
import { useNav } from '../state/nav';
import { useUi } from '../state/ui';
import { markdownToPm, pmToPlainText } from '../editor/convert';
import type { EditorSource } from '../editor/RichEditor';
import { cleanReply, computeHunks, computeInsertion, planRewrite } from '../editor/ai/hunks';
import { activeEditor, editorFor, waitForEditor } from '../editor/ai/registry';
import { addSuggestion, trackedRange, untrack } from '../editor/ai/suggestions';
import { toast } from '../shell/toasts';
import { promptText } from '../shell/dialogs';
import { titleKey } from '../lib/text';
import { t } from '../lib/i18n';
import type { PmNode } from '../lib/types';
import * as api from './api';
import { AiError,
  allProfiles,
  providerLabel, maxTokensMessage, profileForTask, refusalMessage, type AiResult, type StreamHandle } from './client';
import { frameBatcher } from './frames';
import {
  assembleContext,
  bookOutline,
  contextBudget,
  contextToBlocks,
  defaultLore,
  estimateTokens,
  loadReadingOrder,
  sentItems,
  spoilerLimit,
  type AssembledContext,
} from './context';
import { prepareHistory } from './history';
import { canSendTo, historyForProfile, isSourceLocalOnly } from './limits/localOnly';
import { nextMaxTokens } from './limits';
import { runToolLoop } from './loop';
import { CHAT_SYSTEM, expandTemplate, usesVariable } from './prompts';
import { LORE_TOOLS } from './tools';
import { CHARACTER_SYSTEM, CHARACTER_TOOL_NAMES, CHARACTER_TOOLS, characterBrief, characterReminder } from './companions/persona';
import type { AiMessage, ContentBlock, ConversationSettings, StoredConversation, StoredMessage, ToolDef, ToolResultBlock, Usage } from './types';

export interface SelectionChip {
  id: string;
  title: string;
  /** Plain text, with figures as their numbered lines. What the person sees. */
  text: string;
  /**
   * What the model sees: Markdown with a marker for each figure. A reply that keeps the
   * markers lines up around them when it replaces the selection.
   */
  markdown: string;
  source: EditorSource;
  /** Follows the text in its document, so "Replace selection" still finds it. */
  anchorId: string;
  /** False for a selection that is only figures, which can be discussed but not replaced. */
  editable: boolean;
}

export interface LiveTool {
  id: string;
  name: string;
  input?: unknown;
  invalid?: string;
  result?: string;
  isError?: boolean;
}

export interface LiveTurn {
  status: 'waiting' | 'thinking' | 'writing' | 'tools' | 'retrying';
  text: string;
  thinking: string;
  tools: LiveTool[];
  retry?: { delayMs: number; reason: string };
  fallback?: { from: string; to: string };
  usage?: Usage;
}

export interface PaneError {
  code: string;
  message: string;
  /** What can be done about it. */
  canRetry: boolean;
  /** Another profile might do this, as after a refusal. */
  suggestSwitch: boolean;
  /** Try again with this much room, after a response hit its limit. */
  moreTokens?: number;
}

export type PaneView = 'chat' | 'context' | 'prompts' | 'story' | 'feedback';

interface PaneStore {
  conversations: StoredConversation[];
  conversation: StoredConversation | null;
  messages: StoredMessage[];
  live: LiveTurn | null;
  /** What is being typed. Never lost to a failed request. */
  draft: string;
  chips: SelectionChip[];
  /** Selections the last message was about, for "Replace selection". */
  lastChips: SelectionChip[];
  busy: boolean;
  error: PaneError | null;
  view: PaneView;
  /** For a conversation not yet started: what it will use when it is. */
  pendingSettings: ConversationSettings;
  /** Choices, on the conversation or on what it will become. */
  settings: () => ConversationSettings;
  setView: (view: PaneView) => void;
  setDraft: (draft: string) => void;
  refreshList: () => Promise<void>;
  newChat: () => void;
  openConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  updateSettings: (patch: ConversationSettings) => Promise<void>;
  attachSelection: (chip: Omit<SelectionChip, 'id'>) => void;
  removeChip: (id: string) => void;
  send: () => Promise<void>;
  stop: () => void;
  retry: (options?: { maxTokens?: number }) => Promise<void>;
  clearError: () => void;
  /** Forgets everything, when the project changes. */
  reset: () => void;
  /** What sending the current draft would include. For the context view. */
  previewContext: () => Promise<PreparedTurn>;
}

/** Makes a deleted chat again, with the same name, settings and messages. */
export async function restoreConversation(saved: { conversation: StoredConversation; messages: StoredMessage[] }): Promise<StoredConversation> {
  const { conversation, messages } = saved;
  const restored = await api.conversations.create(conversation.title, conversation.context);
  for (const message of messages) {
    await api.messages.add({
      conversationId: restored.id,
      role: message.role,
      content: message.content,
      profileId: message.profileId ?? undefined,
      model: message.model ?? undefined,
      inputTokens: message.inputTokens ?? undefined,
      outputTokens: message.outputTokens ?? undefined,
    });
  }
  return restored;
}

/** Asks for a new name for the open chat, and saves it. */
export async function renameOpenChat(): Promise<void> {
  const { conversation, renameConversation } = usePane.getState();
  if (!conversation) return;
  const title = await promptText({ title: t('Rename chat'), label: t('Name'), initial: conversation.title, confirmLabel: t('Rename') });
  if (title?.trim()) await renameConversation(conversation.id, title.trim());
}

/** Deletes the open chat. A toast offers to undo it. */
export async function deleteOpenChat(): Promise<void> {
  const { conversation, deleteConversation } = usePane.getState();
  if (conversation) await deleteConversation(conversation.id);
}

let nextChip = 1;
let current: { handle: StreamHandle | null; stopped: boolean } | null = null;

export function paneProfile(settings: ConversationSettings): AiProfile {
  return profileForTask('chat', settings.profileId);
}

export function usePaneProfile(): AiProfile {
  const stored = usePane((s) => s.conversation?.context.profileId ?? s.pendingSettings.profileId);
  useSettings((s) => s.settings.ai.profiles);
  useSettings((s) => s.settings.ai.routing.chat);
  return profileForTask('chat', stored);
}

function isWithWords(message: { role: string; content: ContentBlock[] }): boolean {
  return message.role === 'user' && message.content.some((b) => b.type === 'text');
}

function titleFrom(text: string, chips: SelectionChip[]): string {
  const source = text.trim() || chips[0]?.title || t('New chat');
  const line = source.split('\n')[0];
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function chipsAsSelections(chips: SelectionChip[], localOnly: boolean[]) {
  return chips.map((chip, index) => ({ id: chip.id, title: chip.title, text: chip.markdown, localOnly: localOnly[index] }));
}

/** The document in front of the person, with any edits that are not saved yet. */
function openDocument(): { source: EditorSource; doc: PmNode } | null {
  const entry = activeEditor();
  if (!entry || entry.editor.isDestroyed) return null;
  return { source: entry.source, doc: entry.editor.getJSON() as PmNode };
}

export interface PreparedTurn {
  profile: AiProfile;
  history: AiMessage[];
  historyTokens: number;
  historyTrimmed: boolean;
  /** Messages kept back, because they held local-only material. */
  historyWithheld: number;
  context: AssembledContext;
  /** The person's words, with any prompt variables filled in. */
  text: string;
  blocks: ContentBlock[];
  system: string;
  tools: ToolDef[];
  systemTokens: number;
  toolTokens: number;
  totalTokens: number;
}

/** The instructions and tools for a conversation. Both stay the same for its whole length. */
function roleOf(settings: ConversationSettings): { system: string; tools: ToolDef[] } {
  return settings.character ? { system: CHARACTER_SYSTEM, tools: CHARACTER_TOOLS } : { system: CHAT_SYSTEM, tools: LORE_TOOLS };
}

/** Everything one message will send. The context view and sending both use this. */
async function prepareTurn(text: string, chips: SelectionChip[], settings: ConversationSettings, stored: StoredMessage[]): Promise<PreparedTurn> {
  const profile = paneProfile(settings);
  const budget = contextBudget(profile);
  const { system, tools } = roleOf(settings);
  const systemTokens = estimateTokens(system);
  const toolTokens = estimateTokens(JSON.stringify(tools));
  // History gets at most six tenths, so a long chat still leaves room for lore.
  const allowed = historyForProfile(stored, profile, allProfiles());
  const history = prepareHistory(allowed.messages, Math.floor(budget * 0.6));

  // A character chat is about the character, whatever happens to be open. Their page takes
  // the place of the open document, so the lore gathered is what is around them.
  const brief = settings.character
    ? await characterBrief(settings.character, {
        asOfNodeId: settings.asOfNodeId,
        alreadySent: sentItems(history.messages),
        budgetTokens: budget,
        relationships: relationshipList,
        profile,
      })
    : null;
  const open = brief
    ? { source: { kind: 'page' as const, id: brief.page.id, title: brief.page.title }, doc: brief.page.content }
    : openDocument();
  const chipsLocal = await Promise.all(chips.map((chip) => isSourceLocalOnly(chip.source)));
  const pageWithheld = !!open && profile.isCloud && (await isSourceLocalOnly(open.source));
  const values = {
    selection: chips.filter((_, index) => canSendTo(profile, { localOnly: chipsLocal[index] })).map((chip) => chip.markdown).join('\n\n'),
    page: open && !pageWithheld ? pmToPlainText(open.doc) : '',
    book: usesVariable(text, 'book') ? await bookOutline(undefined, profile.isCloud) : '',
  };
  const expanded = expandTemplate(text, values);
  const selectionPlaced = usesVariable(text, 'selection');
  const reserved = systemTokens + toolTokens + history.tokens + estimateTokens(expanded) + (brief?.tokens ?? 0);

  const context = await assembleContext({
    budgetTokens: budget,
    reservedTokens: reserved,
    source: open?.source,
    doc: open?.doc,
    skipDocument: !!brief || (usesVariable(text, 'page') && !pageWithheld),
    selections: selectionPlaced ? [] : chipsAsSelections(chips, chipsLocal),
    instruction: text,
    pinned: brief ? [...brief.relatedIds, ...(settings.pinned ?? [])] : settings.pinned,
    excluded: settings.excluded,
    asOfNodeId: settings.asOfNodeId,
    styleId: settings.styleId,
    alreadySent: sentItems(history.messages),
    forCloud: profile.isCloud,
  });
  const blocks: ContentBlock[] = [...(brief?.blocks ?? []), ...contextToBlocks(context)];
  if (brief) blocks.push(characterReminder(brief.page.title));
  if (expanded) {
    // The conversation shows the person's own words, not the filled-in prompt.
    blocks.push(expanded === text ? { type: 'text', text } : { type: 'text', text: expanded, display: text });
  }
  return {
    profile,
    history: history.messages,
    historyTokens: history.tokens,
    historyTrimmed: history.trimmed,
    historyWithheld: allowed.withheld,
    context,
    text,
    blocks,
    system,
    tools,
    systemTokens,
    toolTokens,
    totalTokens: reserved + context.addedTokens,
  };
}

export const usePane = create<PaneStore>((set, get) => {
  /** Adds to the conversation, on disk and on screen. */
  const remember = async (conversationId: string, input: Omit<Parameters<typeof api.messages.add>[0], 'conversationId'>) => {
    const stored = await api.messages.add({ conversationId, ...input });
    if (get().conversation?.id === conversationId) set((s) => ({ messages: [...s.messages, stored] }));
    return stored;
  };

  const costBlock = (result: AiResult): ContentBlock[] =>
    result.usage && result.costUsd !== null
      ? [{ type: 'cost', costUsd: result.costUsd, cacheReadTokens: result.usage.cacheReadTokens, cacheWriteTokens: result.usage.cacheWriteTokens }]
      : [];

  const runTurn = async (
    conversation: StoredConversation,
    profile: AiProfile,
    messages: AiMessage[],
    options: { maxTokens?: number; onFailureBeforeOutput?: () => Promise<void> },
  ): Promise<void> => {
    const live: LiveTurn = { status: 'waiting', text: '', thinking: '', tools: [] };
    const run: { handle: StreamHandle | null; stopped: boolean } = { handle: null, stopped: false };
    current = run;
    const batch = frameBatcher(() => set({ live: { ...live, tools: [...live.tools] } }));
    set({ live: { ...live }, busy: true, error: null });

    const conversationId = conversation.id;
    let anyOutput = false;
    try {
      const lore = defaultLore();
      const asOf = conversation.context.asOfNodeId;
      const limit = asOf ? spoilerLimit(await loadReadingOrder(lore), asOf) : null;
      const { system, tools } = roleOf(conversation.context);

      const result = await runToolLoop(
        {
          task: 'chat',
          profileId: profile.id,
          model: conversation.context.model,
          system,
          messages,
          tools,
          autoCache: true,
          cacheKey: conversationId,
          maxTokens: options.maxTokens,
        },
        {
          context: { lore, limit, forCloud: profile.isCloud, allowed: conversation.context.character ? CHARACTER_TOOL_NAMES : undefined },
          isStopped: () => run.stopped,
          onStream: (handle) => {
            run.handle = handle;
            if (run.stopped) handle.cancel();
          },
          handlers: {
            onText: (text) => {
              anyOutput = true;
              live.text += text;
              live.status = 'writing';
              batch.schedule();
            },
            onThinking: (text) => {
              live.thinking += text;
              if (live.status === 'waiting' || live.status === 'retrying') live.status = 'thinking';
              batch.schedule();
            },
            onToolStart: (id, name) => {
              anyOutput = true;
              live.status = 'tools';
              live.tools.push({ id, name });
              batch.schedule();
            },
            onToolCall: (call) => {
              const tool = live.tools.find((t) => t.id === call.id);
              if (tool) {
                tool.input = call.input;
                tool.invalid = call.invalid;
              }
              batch.schedule();
            },
            onUsage: (usage) => {
              live.usage = usage;
              batch.schedule();
            },
            onRetrying: (_attempt, delayMs, reason) => {
              live.status = 'retrying';
              live.retry = { delayMs, reason };
              batch.schedule();
            },
            onFallback: (from, to) => {
              live.fallback = { from, to };
              batch.schedule();
            },
          },
          onAssistantTurn: async (content, turn) => {
            batch.flush();
            await remember(conversationId, {
              role: 'assistant',
              content: [...content, ...costBlock(turn)],
              profileId: profile.id,
              model: turn.model,
              inputTokens: turn.usage?.inputTokens,
              outputTokens: turn.usage?.outputTokens,
            });
            // That round is on screen as stored now, and the next one starts clean.
            live.text = '';
            live.thinking = '';
            live.tools = [];
            live.status = 'waiting';
            batch.flush();
          },
          onToolResults: async (results: ToolResultBlock[]) => {
            await remember(conversationId, { role: 'user', content: results });
          },
        },
      );
      batch.flush();
      await finishTurn(conversationId, profile, result, options.maxTokens);
    } catch (e) {
      batch.flush();
      // The project may have changed underneath this, and then there is nothing to report.
      if (get().conversation?.id === conversationId) {
        await failTurn(conversationId, e, anyOutput || live.text.length > 0, options.onFailureBeforeOutput).catch(() => {});
      }
    } finally {
      if (current === run) current = null;
      set({ live: null, busy: false });
      void get().refreshList();
    }
  };

  const finishTurn = async (conversationId: string, profile: AiProfile, result: AiResult, maxTokens: number | undefined) => {
    const base = {
      profileId: profile.id,
      model: result.model,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    };
    switch (result.stopReason) {
      case 'refusal': {
        const message = refusalMessage(result);
        // What arrived before a refusal is discarded, never kept as if it were complete.
        await remember(conversationId, {
          ...base,
          role: 'assistant',
          content: [
            {
              type: 'status',
              stopReason: 'refusal',
              explanation: result.stopDetails?.explanation ?? undefined,
              category: result.stopDetails?.category ?? null,
              discarded: result.text || undefined,
            },
            ...costBlock(result),
          ],
        });
        set({ error: { code: 'REFUSAL', message, canRetry: true, suggestSwitch: true } });
        return;
      }
      case 'cancelled': {
        if (result.content.length === 0) return;
        await remember(conversationId, { ...base, role: 'assistant', content: [...result.content, { type: 'status', stopReason: 'cancelled' }, ...costBlock(result)] });
        return;
      }
      case 'max_tokens': {
        await remember(conversationId, { ...base, role: 'assistant', content: [...result.content, { type: 'status', stopReason: 'max_tokens' }, ...costBlock(result)] });
        set({
          error: {
            code: 'MAX_TOKENS',
            message: maxTokensMessage(),
            canRetry: true,
            suggestSwitch: false,
            moreTokens: nextMaxTokens(maxTokens, profile),
          },
        });
        return;
      }
      default:
        await remember(conversationId, { ...base, role: 'assistant', content: [...result.content, ...costBlock(result)] });
    }
  };

  const failTurn = async (conversationId: string, e: unknown, anyOutput: boolean, onFailureBeforeOutput?: () => Promise<void>) => {
    const failure = e instanceof AiError ? e : new AiError('INTERNAL', errorMessage(e));
    if (failure.code === 'DECLINED') {
      await onFailureBeforeOutput?.();
      return;
    }
    if (failure.partial.length > 0) {
      await remember(conversationId, { role: 'assistant', content: [...failure.partial, { type: 'status', stopReason: 'error' }] });
    } else if (!anyOutput) {
      await onFailureBeforeOutput?.();
    }
    set({
      error: {
        code: failure.code,
        message: failure.message,
        canRetry: failure.code !== 'NO_KEY',
        suggestSwitch: ['UNKNOWN_MODEL', 'SERVER_DOWN', 'BAD_KEY', 'NO_KEY', 'BILLING', 'CONTEXT_TOO_LONG', 'REFUSAL'].includes(failure.code),
      },
    });
  };

  return {
    conversations: [],
    conversation: null,
    messages: [],
    live: null,
    draft: '',
    chips: [],
    lastChips: [],
    busy: false,
    error: null,
    view: 'chat',
    pendingSettings: {},

    settings: () => get().conversation?.context ?? get().pendingSettings,
    setView: (view) => set({ view }),
    setDraft: (draft) => set({ draft }),
    clearError: () => set({ error: null }),

    refreshList: async () => {
      const conversations = await api.conversations.list().catch(() => null);
      if (conversations) set({ conversations });
    },

    newChat: () => {
      get().stop();
      set({ conversation: null, messages: [], error: null, view: 'chat', pendingSettings: {}, lastChips: [] });
    },

    openConversation: async (id) => {
      get().stop();
      const { conversation, messages } = await api.conversations.get(id);
      set({ conversation, messages, error: null, view: 'chat', lastChips: [] });
    },

    deleteConversation: async (id) => {
      // A copy is kept first, so the toast can put the chat back.
      const saved = await api.conversations.get(id).catch(() => null);
      await api.conversations.remove(id);
      if (get().conversation?.id === id) get().newChat();
      await get().refreshList();
      if (!saved) return;
      const title = saved.conversation.title || t('Untitled');
      toast(t('Deleted the chat "{title}".', { title }), 'info', {
        label: t('Undo'),
        run: () => {
          void restoreConversation(saved).then(
            (restored) => get().openConversation(restored.id).then(() => get().refreshList()),
            (e) => toast(errorMessage(e), 'error'),
          );
        },
      });
    },

    renameConversation: async (id, title) => {
      const updated = await api.conversations.update(id, { title });
      if (get().conversation?.id === id) set({ conversation: updated });
      await get().refreshList();
    },

    updateSettings: async (patch) => {
      const open = get().conversation;
      if (!open) {
        set((s) => ({ pendingSettings: { ...s.pendingSettings, ...patch } }));
        return;
      }
      const context = { ...open.context, ...patch };
      set({ conversation: { ...open, context } });
      await api.conversations.update(open.id, { context });
    },

    attachSelection: (chip) => {
      nextChip += 1;
      set((s) => ({ chips: [...s.chips, { ...chip, id: `chip${nextChip}` }], view: 'chat' }));
      void useSettings.getState().update({ ai: { paneOpen: true } });
      // The pane cannot show in distraction-free mode, and the person just asked for it.
      if (useUi.getState().focusMode) useUi.getState().setFocusMode(false);
    },

    removeChip: (id) => {
      const chip = get().chips.find((c) => c.id === id);
      if (chip) {
        const entry = editorFor(chip.source.kind, chip.source.id);
        if (entry) untrack(entry.editor, chip.anchorId);
      }
      set((s) => ({ chips: s.chips.filter((c) => c.id !== id) }));
    },

    previewContext: () => {
      const { draft, chips, messages } = get();
      return prepareTurn(draft.trim(), chips, get().settings(), messages);
    },

    send: async () => {
      const { draft, chips, busy, messages } = get();
      if (busy) return;
      const text = draft.trim();
      if (!text && chips.length === 0) return;
      set({ busy: true, draft: '', chips: [], lastChips: chips, error: null });

      const restoreDraft = () => set({ draft, chips, lastChips: [] });
      try {
        let conversation = get().conversation;
        if (!conversation) {
          const pending = get().pendingSettings;
          const title = pending.character ? t('Talk to {name}', { name: pending.character.title }) : titleFrom(text, chips);
          conversation = await api.conversations.create(title, pending);
          set({ conversation, messages: [], pendingSettings: {} });
        }
        const turn = await prepareTurn(text, chips, conversation.context, messages);
        const stored = await remember(conversation.id, { role: 'user', content: turn.blocks });
        const openId = conversation.id;
        await runTurn(conversation, turn.profile, [...turn.history, { role: 'user', content: turn.blocks }], {
          onFailureBeforeOutput: async () => {
            // Nothing happened, so the message goes back to being a draft to try again.
            await api.messages.removeFrom(stored.id).catch(() => {});
            if (get().conversation?.id === openId) {
              set((s) => ({ messages: s.messages.filter((m) => m.id !== stored.id) }));
            }
            restoreDraft();
          },
        });
      } catch (e) {
        restoreDraft();
        set({
          busy: false,
          live: null,
          error: { code: 'INTERNAL', message: errorMessage(e), canRetry: true, suggestSwitch: false },
        });
      }
    },

    stop: () => {
      if (!current) return;
      current.stopped = true;
      current.handle?.cancel();
    },

    retry: async (options = {}) => {
      if (get().busy) return;
      set({ error: null });
      const { conversation, messages, draft, chips } = get();
      // A failure that restored the draft is retried by sending it again.
      if (draft.trim() || chips.length > 0) {
        const lastIsWords = messages.length > 0 && isWithWords(messages[messages.length - 1]);
        if (!lastIsWords) {
          await get().send();
          return;
        }
      }
      if (!conversation) return;
      let last = -1;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (isWithWords(messages[i])) {
          last = i;
          break;
        }
      }
      if (last < 0) return;
      const after = messages[last + 1];
      const kept = messages.slice(0, last + 1);
      const profile = paneProfile(conversation.context);
      // The profile may have changed since. What it must not see cannot be asked again here.
      const allowed = historyForProfile(kept, profile, allProfiles());
      if (allowed.withheld > last) {
        set({
          error: {
            code: 'LOCAL_ONLY',
            message: t(
              'That message held local-only material, so it cannot be sent to {provider}. Choose a local profile, or write a new message.',
              { provider: providerLabel(profile) },
            ),
            canRetry: false,
            suggestSwitch: true,
          },
        });
        return;
      }
      if (after) await api.messages.removeFrom(after.id);
      set({ messages: kept });
      const budget = contextBudget(profile);
      const history = prepareHistory(allowed.messages, Math.floor(budget * 0.8));
      await runTurn(conversation, profile, history.messages, { maxTokens: options.maxTokens });
    },

    reset: () => {
      get().stop();
      set({
        conversations: [], conversation: null, messages: [], live: null, draft: '', chips: [], lastChips: [],
        busy: false, error: null, view: 'chat', pendingSettings: {},
      });
    },
  };
});

// ---------------------------------------------------------------------------
// Sending a reply to a document, always as tracked changes
// ---------------------------------------------------------------------------

/** Replaces the attached selection, or else the current one, as tracked changes. */
export function replaceSelectionWith(reply: string): void {
  const text = cleanReply(reply);
  for (const chip of usePane.getState().lastChips) {
    if (!chip.editable) continue;
    const entry = editorFor(chip.source.kind, chip.source.id);
    const range = entry ? trackedRange(entry.editor, chip.anchorId) : null;
    if (entry && range) {
      suggestOver(entry.editor, range.from, range.to, text);
      return;
    }
  }
  const entry = activeEditor();
  if (!entry) {
    toast(t('Open a page or scene and select the text to replace.'));
    return;
  }
  const { from, to } = entry.selection;
  if (from >= to) {
    toast(t('Select the text to replace first.'));
    return;
  }
  suggestOver(entry.editor, from, to, text);
}

function suggestOver(editor: Parameters<typeof untrack>[0], from: number, to: number, reply: string) {
  const doc = editor.state.doc;
  const plan = planRewrite(doc, from, to);
  if (!plan) {
    toast(t('There is no text there to replace.'));
    return;
  }
  try {
    const hunks = computeHunks(doc, plan, reply);
    if (hunks.length === 0) {
      toast(t('That is the same as what is there.'));
      return;
    }
    addSuggestion(editor, { label: t('From the AI pane'), from: plan.from, to: plan.to, hunks, reply, instruction: '' });
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Adds a reply at the cursor, or the end of the document, as a tracked change. */
export function insertReply(reply: string): void {
  const entry = activeEditor();
  if (!entry) {
    toast(t('Open a page or scene to insert this into.'));
    return;
  }
  const { editor } = entry;
  const doc = editor.state.doc;
  const position = entry.selection.to > 0 ? entry.selection.to : doc.content.size;
  try {
    const hunks = computeInsertion(doc, position, cleanReply(reply));
    if (hunks.length === 0) return;
    addSuggestion(editor, { label: t('From the AI pane'), from: hunks[0].from, to: hunks[0].to, hunks, reply, instruction: '' });
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

// ---------------------------------------------------------------------------
// Proposals from the model's tools. Nothing happens until the person chooses this.
// ---------------------------------------------------------------------------

function findText(doc: ReturnType<typeof activeDoc>, needle: string): { from: number; to: number } | null {
  if (!doc) return null;
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found || !node.isTextblock) return !found;
    const text = node.textContent;
    const at = text.indexOf(needle);
    if (at < 0) return false;
    // Offsets in the text match positions while every inline node is text. A non-text
    // atom takes one position and no characters, which this walks past.
    let offset = 0;
    let start = -1;
    let end = -1;
    node.forEach((child, childOffset) => {
      const length = child.isText ? (child.text ?? '').length : 0;
      const childStart = pos + 1 + childOffset;
      if (start < 0 && at >= offset && at <= offset + length && (length > 0 || at === offset)) start = childStart + (at - offset);
      if (end < 0 && at + needle.length >= offset && at + needle.length <= offset + length) end = childStart + (at + needle.length - offset);
      offset += length;
    });
    if (start >= 0 && end >= 0) found = { from: start, to: end };
    return false;
  });
  return found;
}

function activeDoc() {
  return activeEditor()?.editor.state.doc ?? null;
}

/** Opens the page or scene, and shows the proposed edit as tracked changes. */
export async function reviewProposedEdit(input: { kind: string; title: string; find: string; replace: string }): Promise<void> {
  const go = useNav.getState().go;
  let kind: 'page' | 'node';
  let id: string;
  if (input.kind === 'page') {
    const page = await coreApi.pages.getByTitle(input.title);
    if (!page) {
      toast(t('There is no page called "{title}" any more.', { title: input.title }), 'error');
      return;
    }
    kind = 'page';
    id = page.id;
    go({ view: 'page', id, tab: 'edit' });
  } else {
    const key = titleKey(input.title);
    const books = await coreApi.books.list();
    let scene: { id: string; bookId: string } | undefined;
    for (const book of books) {
      const tree = await coreApi.nodes.tree(book.id);
      scene = tree.find((n) => n.kind === 'scene' && titleKey(n.title) === key);
      if (scene) break;
    }
    if (!scene) {
      toast(t('There is no scene called "{title}" any more.', { title: input.title }), 'error');
      return;
    }
    kind = 'node';
    id = scene.id;
    go({ view: 'write', bookId: scene.bookId, nodeId: id });
  }
  const entry = await waitForEditor(kind, id);
  if (!entry) {
    toast(t('That document could not be opened for editing.'), 'error');
    return;
  }
  const range = findText(entry.editor.state.doc, input.find);
  if (!range) {
    toast(t('The text this would change is no longer there.'), 'error');
    return;
  }
  suggestOver(entry.editor, range.from, range.to, input.replace);
}

/** Creates the page a proposal describes, if the person chooses to. */
export async function createProposedPage(input: { title: string; type?: string; summary?: string; body?: string }): Promise<void> {
  try {
    // Only what the model wrote goes in: no media, since it has none to place.
    const parsed = markdownToPm(input.body ?? '');
    const content = { ...parsed, content: (parsed.content ?? []).filter((n) => n.type !== 'figure' && n.type !== 'image') };
    const page = await coreApi.pages.create({
      title: input.title,
      pageType: input.type,
      summary: input.summary,
      status: 'draft',
      content: content.content.length > 0 ? content : undefined,
    });
    useNav.getState().go({ view: 'page', id: page.id });
    toast(t('Created "{title}" as a draft.', { title: page.title }), 'success');
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}
