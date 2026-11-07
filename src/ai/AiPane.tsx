/** The AI pane: conversations, streaming answers, and what goes with them. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import * as coreApi from '../lib/api';
import { t } from '../lib/i18n';
import { formatNumber } from '../lib/text';
import { toast } from '../shell/toasts';
import { renderMarkdownSafe } from '../editor/convert';
import { followWikiLink } from '../editor/RichEditor';
import { useDataVersion } from '../state/events';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { StylePicker } from '../writingStyles/StylePicker';
import * as api from './api';
import { providerLabel } from './client';
import { ContextView } from './ContextView';
import { BetaPanel } from './companions/BetaPanel';
import {
  CharacterBanner,
  CharacterEmptyChat,
  CharacterPicker,
  CharacterReplyActions,
  CharacterSpeaker,
  useChatCharacter,
} from './companions/CharacterUi';
import { PromptLibrary } from './PromptLibrary';
import { StoryPanel } from './summaries/StoryPanel';
import { PROPOSE_EDIT, PROPOSE_NEW_PAGE } from './tools';
import { versionsOf } from './versions';
import {
  createProposedPage,
  insertReply,
  isWithWords,
  replaceSelectionWith,
  reviewProposedEdit,
  usePane,
  usePaneProfile,
  type LiveTool,
} from './store';
import { deleteOpenChat, renameOpenChat } from './store';
import type { ContentBlock, ModelInfo, StoredMessage, ToolCallBlock, ToolResultBlock, UsageTotals } from './types';

// ---------------------------------------------------------------------------
// Rendering answers
// ---------------------------------------------------------------------------

/** AI output is untrusted, so it only reaches the page through `renderMarkdownSafe`. */
function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdownSafe(text), [text]);
  return <div className="ai-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Links in an answer open what they point at, and never navigate the app window. */
function handleLinks(e: ReactMouseEvent) {
  const link = (e.target as HTMLElement).closest('a');
  if (!link) return;
  e.preventDefault();
  const target = link.getAttribute('data-wiki-target');
  if (target !== null) {
    followWikiLink(target);
    return;
  }
  const href = link.getAttribute('href');
  if (href && /^https?:\/\//i.test(href)) void coreApi.app.openExternal(href).catch(() => {});
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  useLocale();
  const show = useSettings((s) => s.settings.ai.showThinking);
  if (!text) return null;
  return (
    <details className="ai-thinking" open={show}>
      <summary>{live ? t('Thinking…') : t('Thinking')}</summary>
      <div className="ai-thinking-body">{text}</div>
    </details>
  );
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function toolSummary(name: string, input: unknown): string {
  const value = asRecord(input);
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : '');
  switch (name) {
    case 'search_lore':
      return t('Searched for “{query}”', { query: text('query') });
    case 'get_page':
      return t('Read page: {title}', { title: text('title') });
    case 'get_scene':
      return t('Read scene: {title}', { title: text('title') || text('id') });
    case 'list_pages':
      return t('Listed pages');
    case 'get_backlinks':
      return t('Looked up links to {title}', { title: text('title') });
    case PROPOSE_EDIT:
      return t('Suggested an edit to {title}', { title: text('title') });
    case PROPOSE_NEW_PAGE:
      return t('Suggested a new page: {title}', { title: text('title') });
    default:
      return name;
  }
}

function ToolChip({ name, input, result, isError, pending }: { name: string; input?: unknown; result?: string; isError?: boolean; pending?: boolean }) {
  useLocale();
  return (
    <details className={`ai-tool${isError ? ' is-error' : ''}`} data-testid="ai-tool">
      <summary>
        {pending && <span className="ai-pulse" aria-hidden="true" />}
        {toolSummary(name, input)}
      </summary>
      {result !== undefined && <pre className="ai-tool-result">{result}</pre>}
    </details>
  );
}

function Proposal({ call }: { call: ToolCallBlock }) {
  useLocale();
  const input = asRecord(call.input);
  const [done, setDone] = useState(false);
  if (call.invalid !== undefined) return null;
  if (call.name === PROPOSE_EDIT) {
    return (
      <div className="ai-proposal">
        <div className="ai-proposal-title">{t('Suggested edit to {title}', { title: String(input.title ?? '') })}</div>
        {typeof input.reason === 'string' && <p className="muted small">{input.reason}</p>}
        <div className="ai-proposal-diff">
          <del>{String(input.find ?? '')}</del>
          <ins>{String(input.replace ?? '')}</ins>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            void reviewProposedEdit({
              kind: String(input.kind ?? 'page'),
              title: String(input.title ?? ''),
              find: String(input.find ?? ''),
              replace: String(input.replace ?? ''),
            })
          }
        >
          {t('Show in the document')}
        </button>
      </div>
    );
  }
  if (call.name === PROPOSE_NEW_PAGE) {
    return (
      <div className="ai-proposal">
        <div className="ai-proposal-title">{t('Suggested page: {title}', { title: String(input.title ?? '') })}</div>
        {typeof input.reason === 'string' && <p className="muted small">{input.reason}</p>}
        {typeof input.summary === 'string' && <p className="small">{input.summary}</p>}
        <details className="ai-proposal-body">
          <summary>{t('Read it')}</summary>
          <Markdown text={String(input.body ?? '')} />
        </details>
        <button
          type="button"
          className="btn btn-sm"
          disabled={done}
          onClick={() => {
            setDone(true);
            void createProposedPage({
              title: String(input.title ?? ''),
              type: typeof input.type === 'string' ? input.type : undefined,
              summary: typeof input.summary === 'string' ? input.summary : undefined,
              body: String(input.body ?? ''),
            });
          }}
        >
          {done ? t('Created') : t('Create this page')}
        </button>
      </div>
    );
  }
  return null;
}

function usageLine(message: StoredMessage): string {
  if (message.inputTokens === null && message.outputTokens === null) return '';
  const parts = [
    t('{tokens} in', { tokens: formatNumber(message.inputTokens ?? 0) }),
    t('{tokens} out', { tokens: formatNumber(message.outputTokens ?? 0) }),
  ];
  const cost = message.content.find((b) => b.type === 'cost');
  if (cost?.type === 'cost' && cost.costUsd > 0) parts.push(`$${cost.costUsd.toFixed(cost.costUsd < 0.01 ? 4 : 3)}`);
  if (message.model) parts.push(message.model);
  return parts.join(' · ');
}

function Actions({ text }: { text: string }) {
  useLocale();
  return (
    <div className="ai-actions" role="group" aria-label={t('Use this answer')}>
      <button type="button" className="btn btn-sm" title={t('Replace the selected text with this, as tracked changes')} onClick={() => replaceSelectionWith(text)}>
        {t('Replace selection')}
      </button>
      <button type="button" className="btn btn-sm" title={t('Add this at the cursor, as tracked changes')} onClick={() => insertReply(text)}>
        {t('Insert')}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => void navigator.clipboard.writeText(text).catch(() => toast(t('Could not copy that.'), 'error'))}
      >
        {t('Copy')}
      </button>
    </div>
  );
}

function statusNote(stopReason: string, block: Extract<ContentBlock, { type: 'status' }>): string | null {
  switch (stopReason) {
    case 'cancelled':
      return t('Stopped.');
    case 'max_tokens':
      return t('Cut off by the output limit.');
    case 'refusal':
      return block.discarded ? t('The model declined, and what it had started was discarded.') : t('The model declined this.');
    case 'error':
      return t('This answer was cut short by an error.');
    default:
      return null;
  }
}

/** Text blocks in a row are one passage, as when a fallback model finishes a sentence. */
function mergeAdjacentText(content: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of content) {
    const last = out[out.length - 1];
    if (block.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = { ...last, text: last.text + block.text };
    } else {
      out.push(block);
    }
  }
  return out;
}

/** "‹ 1 of 2 ›": steps between the versions of a message, when it has more than one. */
function VersionArrows({ message, label }: { message: StoredMessage; label: string }) {
  useLocale();
  const tree = usePane((s) => s.tree);
  const busy = usePane((s) => s.busy);
  const showVersion = usePane((s) => s.showVersion);
  const versions = useMemo(() => versionsOf(tree, message), [tree, message]);
  if (versions.count < 2) return null;
  return (
    <span className="ai-versions" role="group" aria-label={label} data-testid="ai-versions">
      <button
        type="button"
        className="icon-btn"
        aria-label={t('Previous version')}
        title={t('Previous version')}
        disabled={busy || versions.index === 0}
        onClick={() => void showVersion(message.id, -1)}
      >
        ‹
      </button>
      <span>{t('{number} of {count}', { number: versions.index + 1, count: versions.count })}</span>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('Next version')}
        title={t('Next version')}
        disabled={busy || versions.index === versions.count - 1}
        onClick={() => void showVersion(message.id, 1)}
      >
        ›
      </button>
    </span>
  );
}

/** Where a turn's reply ends: its versions, and asking for another. */
interface TurnEnd {
  /** The writer's message the reply answers. */
  questionId: string;
  /** The reply's first message, whose versions are the turn's. */
  head: StoredMessage;
}

function AssistantMessage({ message, results, turnEnd }: { message: StoredMessage; results: Map<string, ToolResultBlock>; turnEnd: TurnEnd | null }) {
  useLocale();
  const regenerate = usePane((s) => s.regenerate);
  const busy = usePane((s) => s.busy);
  const blocks = useMemo(() => mergeAdjacentText(message.content), [message.content]);
  const text = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');
  const status = message.content.find((b): b is Extract<ContentBlock, { type: 'status' }> => b.type === 'status');
  const note = status ? statusNote(status.stopReason, status) : null;
  const usage = usageLine(message);
  const character = useChatCharacter();
  return (
    <div className="ai-message ai-message-assistant" data-testid="ai-assistant">
      {character && text && <CharacterSpeaker character={character} />}
      {blocks.map((block, index) => {
        if (block.type === 'thinking') return <Thinking key={index} text={block.text} />;
        if (block.type === 'text' && block.text) return <Markdown key={index} text={block.text} />;
        if (block.type === 'toolCall') {
          const result = results.get(block.id);
          return (
            <div key={index}>
              <ToolChip name={block.name} input={block.input} result={result?.content} isError={result?.isError} />
              {!result?.isError && !character && <Proposal call={block} />}
            </div>
          );
        }
        return null;
      })}
      {note && <div className="ai-note">{note}</div>}
      {text && (character ? <CharacterReplyActions character={character} text={text} /> : <Actions text={text} />)}
      <div className="ai-message-foot">
        {usage && <span className="ai-usage faint" data-testid="ai-usage">{usage}</span>}
        {turnEnd && (
          <>
            <VersionArrows message={turnEnd.head} label={t('Versions of this reply')} />
            <button
              type="button"
              className="link-button small"
              disabled={busy}
              title={t('Ask for this reply again. This one is kept as an earlier version.')}
              onClick={() => void regenerate(turnEnd.questionId)}
            >
              {t('Regenerate')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Changes a message of the writer's in place. Ctrl+Enter saves and runs it, Escape cancels. */
function MessageEditor() {
  useLocale();
  const editing = usePane((s) => s.editing);
  const setEditText = usePane((s) => s.setEditText);
  const saveEdit = usePane((s) => s.saveEdit);
  const cancelEdit = usePane((s) => s.cancelEdit);
  const busy = usePane((s) => s.busy);
  if (!editing) return null;
  const canSave = !busy && editing.text.trim().length > 0;
  return (
    <div className="ai-message ai-message-user is-editing" data-testid="ai-user-editing">
      <textarea
        className="textarea ai-edit-input"
        rows={3}
        aria-label={t('Edit your message')}
        autoFocus
        value={editing.text}
        onChange={(e) => setEditText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (canSave) void saveEdit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancelEdit();
          }
        }}
      />
      <div className="ai-edit-actions">
        <span className="faint small">{t('Later replies are kept as an earlier version.')}</span>
        <button type="button" className="btn btn-sm" onClick={cancelEdit}>{t('Cancel')}</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!canSave} title="Ctrl+Enter" onClick={() => void saveEdit()}>
          {t('Save & run')}
        </button>
      </div>
    </div>
  );
}

function UserMessage({ message, editable }: { message: StoredMessage; editable: boolean }) {
  useLocale();
  const editingThis = usePane((s) => s.editing?.id === message.id);
  const startEdit = usePane((s) => s.startEdit);
  const busy = usePane((s) => s.busy);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  // After an edit is cancelled, the keyboard is back where it started.
  useEffect(() => {
    if (wasEditing.current && !editingThis) editButton.current?.focus();
    wasEditing.current = editingThis;
  }, [editingThis]);
  if (editingThis) return <MessageEditor />;
  const shown = message.content.flatMap((b) => (b.type === 'text' && !b.hidden ? [b.display ?? b.text] : []));
  const labels = message.content.flatMap((b) => (b.type === 'text' && b.hidden && b.label ? [b.label] : []));
  if (shown.length === 0 && labels.length === 0) return null;
  return (
    <div className="ai-message ai-message-user" data-testid="ai-user">
      {labels.length > 0 && (
        <div className="ai-sent-chips">
          {labels.map((label, index) => (
            <span key={index} className="ai-sent-chip">{label}</span>
          ))}
        </div>
      )}
      {shown.map((text, index) => (
        <div key={index} className="ai-user-text">{text}</div>
      ))}
      {editable && (
        <div className="ai-user-foot">
          <VersionArrows message={message} label={t('Versions of this message')} />
          <button
            ref={editButton}
            type="button"
            className="link-button small"
            disabled={busy}
            title={t('Change this message and run the chat again from here. Up arrow in an empty message box edits your last one.')}
            onClick={() => startEdit(message.id)}
          >
            {t('Edit')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Says a reply started and finished, in a few words. A screen reader would otherwise read
 * every streamed word as it arrives.
 */
function ReplyStatus() {
  useLocale();
  const replying = usePane((s) => !!s.live);
  const failed = usePane((s) => !!s.error);
  const was = useRef(replying);
  const [text, setText] = useState('');
  useEffect(() => {
    if (replying && !was.current) setText(t('Writing a reply…'));
    else if (!replying && was.current) setText(failed ? t('The reply stopped with a problem.') : t('Reply finished.'));
    was.current = replying;
  }, [replying, failed]);
  return (
    <div className="visually-hidden" role="status" aria-live="polite" data-testid="ai-reply-status">
      {text}
    </div>
  );
}

function LiveMessage() {
  useLocale();
  const live = usePane((s) => s.live);
  const character = useChatCharacter();
  if (!live) return null;
  const waiting =
    live.status === 'waiting' ? t('Waiting for the model…')
    : live.status === 'retrying' ? t('The server is busy. Trying again in {seconds} s…', { seconds: Math.ceil((live.retry?.delayMs ?? 0) / 1000) })
    : null;
  return (
    <div className="ai-message ai-message-assistant is-live" data-testid="ai-live">
      {waiting && (
        <div className="ai-waiting" role="status">
          <span className="ai-pulse" aria-hidden="true" />
          {waiting}
        </div>
      )}
      {character && live.text && <CharacterSpeaker character={character} />}
      <Thinking text={live.thinking} live={!live.text} />
      {live.tools.map((tool: LiveTool) => (
        <ToolChip key={tool.id} name={tool.name} input={tool.input} result={tool.result} isError={tool.isError} pending={tool.input === undefined} />
      ))}
      {live.text && <Markdown text={live.text} />}
      {live.fallback && <div className="ai-note">{t('{model} is finishing this answer.', { model: live.fallback.to })}</div>}
    </div>
  );
}

function ErrorCard() {
  useLocale();
  const error = usePane((s) => s.error);
  const retry = usePane((s) => s.retry);
  const clear = usePane((s) => s.clearError);
  const go = useNav((s) => s.go);
  const profile = usePaneProfile();
  if (!error) return null;
  return (
    <div className="ai-error" role="alert" data-testid="ai-error" data-code={error.code}>
      <p>{error.message}</p>
      {error.suggestSwitch && (
        <p className="muted small">
          {error.code === 'REFUSAL'
            ? t('You can try again with another profile, such as a local model, using the menu above.')
            : t('You can switch from {profile} using the menu above.', { profile: profile.name })}
        </p>
      )}
      <div className="ai-error-actions">
        {error.moreTokens !== undefined && (
          <button type="button" className="btn btn-sm" onClick={() => void retry({ maxTokens: error.moreTokens })}>
            {t('Try again with more room')}
          </button>
        )}
        {error.canRetry && error.moreTokens === undefined && (
          <button type="button" className="btn btn-sm" onClick={() => void retry()}>{t('Try again')}</button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => go({ view: 'settings', tab: 'ai' })}>{t('AI settings')}</button>
        <button type="button" className="btn btn-sm" onClick={clear}>{t('Dismiss')}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header() {
  useLocale();
  const conversations = usePane((s) => s.conversations);
  const conversation = usePane((s) => s.conversation);
  const openConversation = usePane((s) => s.openConversation);
  const newChat = usePane((s) => s.newChat);
  const view = usePane((s) => s.view);
  const setView = usePane((s) => s.setView);
  const update = useSettings((s) => s.update);

  return (
    <div className="ai-pane-head">
      <div className="ai-pane-row">
        <select
          className="select ai-conversation"
          aria-label={t('Conversation')}
          value={conversation?.id ?? ''}
          title={conversation ? t('F2 renames this chat. Delete removes it.') : undefined}
          onKeyDown={(e) => {
            // Keys for the chat picked here, so they work without the mouse.
            if (!conversation || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
            if (e.key === 'F2') {
              e.preventDefault();
              e.stopPropagation();
              void renameOpenChat();
            } else if (e.key === 'Delete') {
              e.preventDefault();
              e.stopPropagation();
              void deleteOpenChat();
            }
          }}
          onChange={(e) => {
            if (e.target.value) void openConversation(e.target.value);
            else newChat();
          }}
        >
          <option value="">{t('New chat')}</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>{c.title || t('Untitled')}</option>
          ))}
        </select>
        <button type="button" className="btn btn-sm" onClick={newChat}>{t('New')}</button>
        <CharacterPicker />
        {conversation && (
          <>
            <button
              type="button"
              className="icon-btn"
              title={t('Rename this chat')}
              aria-label={t('Rename this chat')}
              onClick={() => void renameOpenChat()}
            >
              ✎
            </button>
            <button
              type="button"
              className="icon-btn"
              title={t('Delete this chat')}
              aria-label={t('Delete this chat')}
              onClick={() => void deleteOpenChat()}
            >
              🗑
            </button>
          </>
        )}
        <button
          type="button"
          className="icon-btn ai-pane-close"
          title={t('Close the AI pane ({shortcut})', { shortcut: 'Ctrl+Shift+A' })}
          aria-label={t('Close the AI pane')}
          onClick={() => void update({ ai: { paneOpen: false } })}
        >
          ×
        </button>
      </div>
      <ProfilePicker />
      <ChatStylePicker />
      <div className="settings-tabs ai-pane-tabs" role="tablist" aria-label={t('AI pane views')}>
        {(['chat', 'context', 'prompts', 'story', 'feedback'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={view === tab}
            className={`settings-tab${view === tab ? ' is-active' : ''}`}
            onClick={() => setView(tab)}
          >
            {tab === 'chat' ? t('Chat') : tab === 'context' ? t('What is sent') : tab === 'prompts' ? t('Prompts') : tab === 'story' ? t('Story so far') : t('Feedback')}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A style for this chat alone. Otherwise the scene's, book's or project's applies. */
function ChatStylePicker() {
  useLocale();
  const styleId = usePane((s) => s.conversation?.context.styleId ?? s.pendingSettings.styleId ?? null);
  const updateSettings = usePane((s) => s.updateSettings);
  return (
    <div className="ai-pane-row">
      <StylePicker
        label={t('Writing style for this chat')}
        value={styleId}
        noneLabel={t('Project writing style')}
        onChange={(id) => void updateSettings({ styleId: id })}
      />
    </div>
  );
}

function ProfilePicker() {
  useLocale();
  const profiles = useSettings((s) => s.settings.ai.profiles);
  const profile = usePaneProfile();
  const updateSettings = usePane((s) => s.updateSettings);
  const stored = usePane((s) => s.conversation?.context.model ?? s.pendingSettings.model);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const load = useCallback(() => {
    void api.provider.listModels(profile.id).then(setModels).catch(() => setModels([]));
  }, [profile.id]);
  const shown = stored ?? profile.model;
  const options = useMemo(() => {
    const ids = models.map((m) => m.id);
    return shown && !ids.includes(shown) ? [shown, ...ids] : ids;
  }, [models, shown]);
  return (
    <div className="ai-pane-row">
      <select
        className="select ai-profile"
        aria-label={t('AI profile')}
        value={profile.id}
        onChange={(e) => {
          setModels([]);
          void updateSettings({ profileId: e.target.value, model: undefined });
        }}
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <select
        className="select ai-model"
        aria-label={t('Model')}
        value={shown}
        onFocus={load}
        onChange={(e) => void updateSettings({ model: e.target.value || undefined })}
      >
        {!shown && <option value="">{t('Automatic')}</option>}
        {options.map((id) => (
          <option key={id} value={id}>{id}</option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer() {
  useLocale();
  const draft = usePane((s) => s.draft);
  const setDraft = usePane((s) => s.setDraft);
  const chips = usePane((s) => s.chips);
  const removeChip = usePane((s) => s.removeChip);
  const send = usePane((s) => s.send);
  const stop = usePane((s) => s.stop);
  const busy = usePane((s) => s.busy);
  const startEdit = usePane((s) => s.startEdit);
  const profile = usePaneProfile();
  const character = useChatCharacter();
  const canSend = !busy && (draft.trim().length > 0 || chips.length > 0);
  return (
    <div className="ai-composer">
      {chips.length > 0 && (
        <div className="ai-chips">
          {chips.map((chip) => (
            <span key={chip.id} className="ai-chip" data-testid="ai-chip" title={chip.text}>
              <span className="ai-chip-title">{chip.title}</span>
              <span className="ai-chip-text">{chip.text}</span>
              <button type="button" className="ai-chip-remove" aria-label={t('Remove the selection from {title}', { title: chip.title })} onClick={() => removeChip(chip.id)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        className="textarea ai-input"
        rows={3}
        aria-label={t('Message the AI')}
        placeholder={
          character ? t('Say something to {name}', { name: character.title })
          : chips.length > 0 ? t('What about this selection?')
          : t('Ask about your world, or for help with your writing')
        }
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (canSend) void send();
          } else if (e.key === 'ArrowUp' && !busy && !draft && chips.length === 0) {
            // As in many chat apps, Up in an empty box edits your last message.
            const last = [...usePane.getState().messages].reverse().find(isWithWords);
            if (last) {
              e.preventDefault();
              startEdit(last.id);
            }
          }
        }}
      />
      <div className="ai-composer-foot">
        <span className="faint small truncate" title={profile.isCloud ? t('Your message goes to {provider}', { provider: providerLabel(profile) }) : t('This stays on your computer')}>
          {profile.isCloud ? t('Sent to {provider}', { provider: providerLabel(profile) }) : t('Stays on this computer')}
        </span>
        <span className="ai-ask-spacer" />
        {busy ? (
          <button type="button" className="btn btn-sm" onClick={stop}>{t('Stop')}</button>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" disabled={!canSend} onClick={() => void send()}>{t('Send')}</button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

function Conversation() {
  useLocale();
  const messages = usePane((s) => s.messages);
  const live = usePane((s) => s.live);
  const error = usePane((s) => s.error);
  const character = useChatCharacter();
  const scroller = useRef<HTMLDivElement>(null);
  // Follows new text only while the person is at the bottom. Scrolling up to read stops it.
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    atBottom.current = near;
    setShowJump(!near);
  };

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages, live, error]);

  const results = useMemo(() => {
    const map = new Map<string, ToolResultBlock>();
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'toolResult') map.set(block.toolCallId, block);
      }
    }
    return map;
  }, [messages]);

  // A turn is one of the writer's messages and the replies up to the next one. Its last
  // reply holds the turn's versions and "Regenerate".
  const turnEnds = useMemo(() => {
    const ends = new Map<string, TurnEnd>();
    let question: StoredMessage | null = null;
    messages.forEach((message, index) => {
      if (isWithWords(message)) question = message;
      const next = messages[index + 1];
      if (question && message.role === 'assistant' && (!next || isWithWords(next))) {
        const head = messages[messages.indexOf(question) + 1];
        if (head) ends.set(message.id, { questionId: question.id, head });
      }
    });
    return ends;
  }, [messages]);

  return (
    <div className="ai-conversation-wrap">
      <ReplyStatus />
      {/* The conversation is a log that is read on demand, never announced as it streams. */}
      <div className="ai-messages" ref={scroller} onScroll={onScroll} onClick={handleLinks} role="log" aria-live="off" aria-label={t('Conversation')}>
        {character && <CharacterBanner character={character} />}
        {messages.length === 0 && !live && character && <CharacterEmptyChat character={character} />}
        {messages.length === 0 && !live && !character && (
          <div className="ai-empty">
            <p>{t('Ask about your world, or select some text in a document and choose Send to pane.')}</p>
            <p className="faint small">{t('Lore relevant to what you ask is included automatically. Open “What is sent” to see it.')}</p>
          </div>
        )}
        {messages.map((message) =>
          message.role === 'user' ? (
            <UserMessage key={message.id} message={message} editable={isWithWords(message)} />
          ) : (
            <AssistantMessage key={message.id} message={message} results={results} turnEnd={turnEnds.get(message.id) ?? null} />
          ),
        )}
        <LiveMessage />
        <ErrorCard />
      </div>
      {showJump && (
        <button
          type="button"
          className="btn btn-sm ai-jump"
          onClick={() => {
            const element = scroller.current;
            if (element) element.scrollTop = element.scrollHeight;
            atBottom.current = true;
            setShowJump(false);
          }}
        >
          {t('Jump to latest')}
        </button>
      )}
    </div>
  );
}

function Totals() {
  useLocale();
  const version = useDataVersion('aiUsage');
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.usage.totals().then((value) => {
      if (!cancelled) setTotals(value);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [version]);
  if (!totals || totals.requests === 0) return null;
  const tokens = totals.inputTokens + totals.outputTokens;
  return (
    <div className="ai-totals faint small" data-testid="ai-totals">
      {totals.costUsd > 0
        ? t('This project: {tokens} tokens, about {cost}', { tokens: formatNumber(tokens), cost: `$${totals.costUsd.toFixed(2)}` })
        : t('This project: {tokens} tokens', { tokens: formatNumber(tokens) })}
    </div>
  );
}

export function AiPane() {
  const view = usePane((s) => s.view);
  const refreshList = usePane((s) => s.refreshList);
  const isOpen = useProject((s) => s.status.open);
  const version = useDataVersion('all');

  useEffect(() => {
    if (isOpen) void refreshList();
  }, [isOpen, refreshList, version]);

  return (
    <div className="ai-pane-body" data-testid="ai-pane">
      <Header />
      {view === 'chat' && <Conversation />}
      {view === 'context' && <ContextView />}
      {view === 'prompts' && <PromptLibrary />}
      {view === 'story' && <StoryPanel />}
      {view === 'feedback' && <BetaPanel />}
      {view !== 'feedback' && <Composer />}
      <Totals />
    </div>
  );
}
