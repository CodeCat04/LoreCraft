/** Exactly what will be sent with the next message, with pins and exclusions. */

import { useCallback, useEffect, useState } from 'react';

import * as coreApi from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { formatNumber } from '../lib/text';
import { useLocale } from '../state/language';
import { useSettings } from '../state/settings';
import { activeEditor } from '../editor/ai';
import { LocalOnlyToggle } from './limits/LocalOnlyToggle';
import { providerLabel } from './client';
import { isCharacterReminder } from './companions/persona';
import { contextBudget, estimateTokens, type ContextItem } from './context';
import { usePane, type PreparedTurn } from './store';
import type { TextBlock } from './types';

/** Why an item is sent. Built when shown, so it follows the interface language. */
function reasonText(reason: string): string | undefined {
  const reasons: Record<string, string> = {
    language: t('the language of this project'),
    selection: t('you selected it'),
    document: t('it is open'),
    pinned: t('pinned'),
    named: t('named in the text'),
    linked: t('linked from the text'),
    related: t('related'),
    style: t('your style guide and writing style'),
    story: t('summaries of what came before this scene'),
  };
  return reasons[reason];
}

/** Why an item is not sent. */
function stateText(state: string): string | undefined {
  const states: Record<string, string> = {
    already: t('already in this conversation'),
    excluded: t('excluded by you'),
    spoiler: t('hidden by the “knows up to” limit'),
    idea: t('an idea page, sent only when asked about'),
    budget: t('left out for lack of room'),
    localOnly: t('withheld: marked local only, and this goes to a cloud provider'),
  };
  return states[state];
}

function tokenCount(count: number): string {
  return count === 1 ? t('1 token') : t('{count} tokens', { count: formatNumber(count) });
}

function ContextRow({ item, pinned, excluded, onPin, onExclude }: {
  item: ContextItem;
  pinned: boolean;
  excluded: boolean;
  onPin: () => void;
  onExclude: () => void;
}) {
  useLocale();
  const sent = item.state === 'included';
  const why = (sent ? reasonText(item.reason) : stateText(item.state)) ?? '';
  return (
    <div className={`ai-context-item${sent ? '' : ' is-out'}`} data-testid="ai-context-item" data-state={item.state}>
      <div className="ai-context-line">
        <span className="ai-context-title truncate">
          {item.title}
          {item.status && <span className={`badge badge-${item.status} ai-context-badge`}>{item.status}</span>}
        </span>
        <span className="faint small ai-context-tokens">{sent ? tokenCount(item.tokens) : ''}</span>
        {item.pageId && (
          <>
            <button type="button" className={`btn btn-sm${pinned ? ' btn-primary' : ''}`} aria-pressed={pinned} onClick={onPin}>
              {pinned ? t('Pinned') : t('Pin')}
            </button>
            <button type="button" className="btn btn-sm" aria-pressed={excluded} onClick={onExclude}>
              {excluded ? t('Include') : t('Exclude')}
            </button>
          </>
        )}
      </div>
      <div className="faint small">
        {item.shortened ? t('{reason}, shortened to fit', { reason: why }) : why}
      </div>
      {sent && (
        <details className="ai-context-text">
          <summary>{t('Show the text')}</summary>
          <pre>{item.text}</pre>
        </details>
      )}
    </div>
  );
}

export function StoryLimit({ value, onChange }: { value: string | null | undefined; onChange: (id: string | null) => void }) {
  useLocale();
  const [options, setOptions] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const books = await coreApi.books.list();
      const list: { id: string; label: string }[] = [];
      for (const book of books) {
        const tree = await coreApi.nodes.tree(book.id);
        const chapters = tree.filter((node) => node.kind === 'chapter').sort((a, b) => a.position - b.position);
        for (const chapter of chapters) list.push({ id: chapter.id, label: `${book.title}: ${chapter.title}` });
      }
      if (!cancelled) setOptions(list);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <label className="ai-context-limit">
      <span>{t('The AI knows up to')}</span>
      <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{t('Everything')}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>{t('The end of {chapter}', { chapter: option.label })}</option>
        ))}
      </select>
    </label>
  );
}

export function ContextView() {
  useLocale();
  const draft = usePane((s) => s.draft);
  const chips = usePane((s) => s.chips);
  const messages = usePane((s) => s.messages);
  const conversation = usePane((s) => s.conversation);
  const pending = usePane((s) => s.pendingSettings);
  const previewContext = usePane((s) => s.previewContext);
  const updateSettings = usePane((s) => s.updateSettings);
  const dismissed = useSettings((s) => s.settings.ai.cloudWarningDismissed);
  const update = useSettings((s) => s.update);
  const settings = conversation?.context ?? pending;
  const [turn, setTurn] = useState<PreparedTurn | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    previewContext()
      .then((prepared) => {
        setTurn(prepared);
        setProblem(null);
      })
      .catch((e: unknown) => setProblem(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [previewContext]);

  // Reads again when anything that changes the answer changes.
  useEffect(() => {
    const timer = window.setTimeout(load, 200);
    return () => window.clearTimeout(timer);
  }, [load, draft, chips, messages, settings]);

  if (problem) return <div className="ai-context ai-error" role="alert">{problem}</div>;
  if (!turn) return <div className="ai-context muted" role="status">{t('Working it out…')}</div>;

  const pinned = settings.pinned ?? [];
  const excluded = settings.excluded ?? [];
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const budget = contextBudget(turn.profile);
  const share = Math.min(100, Math.round((turn.totalTokens / budget) * 100));
  const items = turn.context.items;
  const playing = turn.blocks.find(
    (block): block is TextBlock => block.type === 'text' && !!block.contextItems?.some((item) => item.id.startsWith('character:')),
  );
  const reminder = turn.blocks.find((block): block is TextBlock => block.type === 'text' && isCharacterReminder(block));
  const openSource = activeEditor()?.source;

  return (
    <div className="ai-context" data-testid="ai-context" aria-busy={loading}>
      <div className={`ai-context-where${turn.profile.isCloud ? ' is-cloud' : ''}`}>
        {turn.profile.isCloud ? (
          <>
            <strong>{t('This is sent to {provider}.', { provider: providerLabel(turn.profile) })}</strong>{' '}
            {t("Everything below leaves this computer when you send, under {provider}'s terms.", { provider: providerLabel(turn.profile) })}
            {dismissed && (
              <button type="button" className="link-button small ai-context-reask" onClick={() => void update({ ai: { cloudWarningDismissed: false } })}>
                {t('Ask me first again')}
              </button>
            )}
          </>
        ) : (
          <>
            <strong>{t('This stays on this computer.')}</strong>{' '}
            {t('{name} runs at {address}.', { name: turn.profile.name, address: turn.profile.baseUrl })}
          </>
        )}
      </div>

      <div className="ai-context-total">
        <div>
          {t('About {used} of {budget} tokens', { used: formatNumber(turn.totalTokens), budget: formatNumber(budget) })}
        </div>
        <div className="ai-context-bar" role="progressbar" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100} aria-label={t('Context used')}>
          <div style={{ width: `${share}%` }} className={share >= 100 ? 'is-over' : ''} />
        </div>
      </div>

      <StoryLimit value={settings.asOfNodeId} onChange={(id) => void updateSettings({ asOfNodeId: id })} />
      {openSource && openSource.kind !== 'notes' && <LocalOnlyToggle source={openSource} onChanged={load} />}

      {turn.context.warnings.map((warning) => (
        <div key={warning} className="ai-note" role="status">{warning}</div>
      ))}
      {turn.historyTrimmed && <div className="ai-note">{t('The oldest parts of this chat no longer fit, so they are left out.')}</div>}
      {turn.historyWithheld > 0 && (
        <div className="ai-note" data-testid="ai-history-withheld">
          {turn.historyWithheld === 1
            ? t('The first message of this chat held local-only material, so it is not sent to {provider}.', { provider: providerLabel(turn.profile) })
            : t('The first {count} messages of this chat held local-only material, so they are not sent to {provider}.', {
                count: formatNumber(turn.historyWithheld),
                provider: providerLabel(turn.profile),
              })}
        </div>
      )}

      <h3 className="ai-context-head">{t('Always included')}</h3>
      <div className="ai-context-item">
        <div className="ai-context-line">
          <span className="ai-context-title">{t('Instructions to the model')}</span>
          <span className="faint small ai-context-tokens">{tokenCount(turn.systemTokens)}</span>
        </div>
        <details className="ai-context-text">
          <summary>{t('Show the text')}</summary>
          <pre>{turn.system}</pre>
        </details>
      </div>
      <div className="ai-context-item">
        <div className="ai-context-line">
          <span className="ai-context-title">{t('Lore lookup tools')}</span>
          <span className="faint small ai-context-tokens">{tokenCount(turn.toolTokens)}</span>
        </div>
        <div className="faint small">{t('{tools}. They only read, or suggest.', { tools: turn.tools.map((tool) => tool.name).join(', ') })}</div>
      </div>
      {turn.historyTokens > 0 && (
        <div className="ai-context-item">
          <div className="ai-context-line">
            <span className="ai-context-title">{t('This conversation so far')}</span>
            <span className="faint small ai-context-tokens">{tokenCount(turn.historyTokens)}</span>
          </div>
        </div>
      )}

      <h3 className="ai-context-head">{t('For this message')}</h3>
      {playing && (
        <div className="ai-context-item" data-testid="ai-context-character">
          <div className="ai-context-line">
            <span className="ai-context-title truncate">{playing.label}</span>
            <span className="faint small ai-context-tokens">{tokenCount(estimateTokens(playing.text))}</span>
          </div>
          <div className="faint small">{t('Who the model plays: their page, relationships and scenes')}</div>
          <details className="ai-context-text">
            <summary>{t('Show the text')}</summary>
            <pre>{playing.text}</pre>
          </details>
        </div>
      )}
      {reminder && (
        <div className="ai-context-item">
          <div className="ai-context-line">
            <span className="ai-context-title truncate">{t('A reminder to stay in character')}</span>
            <span className="faint small ai-context-tokens">{tokenCount(estimateTokens(reminder.text))}</span>
          </div>
          <details className="ai-context-text">
            <summary>{t('Show the text')}</summary>
            <pre>{reminder.text}</pre>
          </details>
        </div>
      )}
      {items.length === 0 && !playing && <p className="muted small">{t('Nothing yet. Name a page or open a document, or pin a page.')}</p>}
      {items.map((item) => (
        <ContextRow
          key={item.id}
          item={item}
          pinned={!!item.pageId && pinned.includes(item.pageId)}
          excluded={!!item.pageId && excluded.includes(item.pageId)}
          onPin={() => item.pageId && void updateSettings({ pinned: toggle(pinned, item.pageId), excluded: excluded.filter((id) => id !== item.pageId) })}
          onExclude={() => item.pageId && void updateSettings({ excluded: toggle(excluded, item.pageId), pinned: pinned.filter((id) => id !== item.pageId) })}
        />
      ))}
    </div>
  );
}
