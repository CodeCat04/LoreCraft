import { useCallback, useEffect, useMemo, useState } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { confirm } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useDataVersion } from '../state/events';
import { useLocale } from '../state/language';
import { mcp, type McpClient, type McpPermission, type McpStatus } from './api';
import { setupSnippets } from './setup';

const TOKEN_MASK = '•'.repeat(24);

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast(t('Copied.'), 'success'),
    () => toast(t('Could not copy that.'), 'error'),
  );
}

/** `secret` stays out of what is on screen unless asked for, but is always in the copy. */
function Snippet({ label, text, hint, secret }: { label: string; text: string; hint?: string; secret?: string }) {
  useLocale();
  return (
    <div className="mcp-snippet">
      <div className="mcp-snippet-head">
        <span className="field-label">{label}</span>
        <button type="button" className="btn btn-sm" aria-label={t('Copy: {label}', { label })} onClick={() => copy(text)}>
          {t('Copy')}
        </button>
      </div>
      <pre className="mcp-code" tabIndex={0}>{secret ? text.split(secret).join(TOKEN_MASK) : text}</pre>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function clientLine(client: McpClient): string {
  const name = client.version ? `${client.name} ${client.version}` : client.name;
  return client.connected
    ? t('{name}, connected', { name })
    : t('{name}, last active {time}', { name, time: time(client.lastSeen) });
}

function SetupGuide({ status, showToken }: { status: McpStatus; showToken: boolean }) {
  useLocale();
  const secret = showToken ? undefined : status.token;
  const snippets = useMemo(
    () =>
      setupSnippets({
        exePath: status.exePath ?? 'lorecraft',
        projectPath: status.projectPath,
        url: status.url,
        token: status.token,
      }),
    [status.exePath, status.projectPath, status.url, status.token],
  );
  const overHttp = (tool: string) => t('{tool}, connecting directly over HTTP', { tool });
  const httpHint = t('Holds your token, and works only while LoreCraft is open.');
  return (
    <section className="mcp-section">
      <h2 className="mcp-heading">{t('Connect a tool')}</h2>
      <p className="muted small mcp-intro">
        {status.projectPath
          ? t('These use this copy of LoreCraft and the file for “{name}”. Run one once, then ask the tool to catch up on your book.', {
              name: status.projectName ?? '',
            })
          : t('Save this project to a file to get a setup that also works while LoreCraft is closed. Until then these use whatever is open in LoreCraft.')}
      </p>
      <Snippet
        label="Claude Code"
        text={snippets.claudeLocal}
        hint={t('Run this in a terminal. With LoreCraft open the tool sees your live work, and with it closed, the last saved file.')}
      />
      {snippets.claudeRemote && <Snippet label={overHttp('Claude Code')} text={snippets.claudeRemote} secret={secret} hint={httpHint} />}
      <Snippet
        label="OpenCode"
        text={snippets.opencodeLocal}
        hint={t('Add to opencode.json. A local model needs tool-calling support, so check that your server has it turned on.')}
      />
      {snippets.opencodeRemote && <Snippet label={overHttp('OpenCode')} text={snippets.opencodeRemote} secret={secret} hint={httpHint} />}
      <Snippet label={t('Any other tool')} text={snippets.generic} secret={secret} />
    </section>
  );
}

export function McpSettings() {
  useLocale();
  const version = useDataVersion('mcp', 'all');
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

  const load = useCallback(() => {
    void mcp.status().then(setStatus, (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load, version]);

  const apply = (change: Promise<McpStatus>) => {
    setError(null);
    void change.then(setStatus, (e) => {
      setError(errorMessage(e));
      load();
    });
  };
  /** Shows the choice at once, since starting the server takes a moment. */
  const set = (patch: { enabled?: boolean; permission?: McpPermission; shareLocalOnly?: boolean }) => {
    setStatus((current) => (current ? { ...current, ...patch } : current));
    apply(mcp.update(patch));
  };

  if (!status) return error ? <p className="field-error">{error}</p> : <p className="muted">{t('Loading…')}</p>;

  const rotate = async () => {
    const yes = await confirm({
      title: t('Replace the token?'),
      message: t('Tools connecting directly over HTTP stop working until you give them the new one. Tools set up with the command keep working.'),
      confirmLabel: t('Replace'),
    });
    if (yes) apply(mcp.rotateToken());
  };

  return (
    <section className="mcp-settings">
      <p className="muted mcp-intro">
        {t('Let AI tools outside LoreCraft, such as Claude Code or OpenCode with a local model, read your lore and your book. You choose below whether they can only read, suggest changes for you to accept, or make changes directly. It works only from this computer.')}
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={status.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>{t('Let outside AI tools connect')}</span>
      </label>
      <p className="mcp-status small" data-testid="mcp-status" role="status">
        {status.running
          ? t('On. Listening on this computer only, at {url}', { url: status.url ?? '' })
          : status.enabled
            ? t('Turned on, but not listening.')
            : t('Off. No outside tool can read anything.')}
      </p>
      {(error || status.error) && <p className="field-error">{error ?? status.error}</p>}

      <label className="field mcp-narrow">
        <span className="field-label">{t('What outside tools can do')}</span>
        <select
          className="select"
          value={status.permission}
          onChange={(e) => set({ permission: e.target.value as McpPermission })}
        >
          <option value="suggest">{t('Read and suggest changes')}</option>
          <option value="edit">{t('Make changes directly')}</option>
          <option value="read">{t('Read only')}</option>
        </select>
        <span className="field-hint" data-testid="mcp-permission-hint">
          {status.permission === 'edit'
            ? t('Changes are made at once, without asking you first. Each one is saved in History and listed under Outside suggestions, where you can undo it. Tools still cannot change these settings, your AI providers or keys, or what is local only.')
            : status.permission === 'read'
              ? t('Tools can read, but cannot suggest or make any change.')
              : t('Each change waits under Outside suggestions until you accept or reject it.')}
        </span>
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={status.shareLocalOnly}
          onChange={(e) => set({ shareLocalOnly: e.target.checked })}
        />
        <span>
          {t('Share local-only content with outside tools')}
          <span className="field-hint">
            {t('Leave this off to keep pages and scenes marked local only hidden from every tool. The AI behind a tool may be a cloud model.')}
          </span>
        </span>
      </label>

      {status.enabled && (
        <section className="mcp-section">
          <h2 className="mcp-heading">{t('Token')}</h2>
          <p className="muted small mcp-intro">{t('Tools connecting directly over HTTP need this. Treat it like a password.')}</p>
          <div className="mcp-token-row">
            <code className="mcp-code mcp-token" data-testid="mcp-token">{showToken ? status.token : TOKEN_MASK}</code>
            <button type="button" className="btn btn-sm" aria-pressed={showToken} onClick={() => setShowToken(!showToken)}>
              {showToken ? t('Hide') : t('Show')}
            </button>
            <button type="button" className="btn btn-sm" aria-label={t('Copy the token')} onClick={() => copy(status.token)}>
              {t('Copy')}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void rotate()}>
              {t('Replace')}
            </button>
          </div>
        </section>
      )}

      {status.enabled && <SetupGuide status={status} showToken={showToken} />}

      {status.enabled && (
        <section className="mcp-section">
          <h2 className="mcp-heading">{t('Connected tools')}</h2>
          {status.clients.length === 0 ? (
            <p className="muted small">{t('None right now. A tool set up with the command connects when it first needs LoreCraft.')}</p>
          ) : (
            <ul className="mcp-list small" data-testid="mcp-clients">
              {status.clients.map((client) => (
                <li key={`${client.name} ${client.version}`}>{clientLine(client)}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {status.enabled && (
        <section className="mcp-section">
          <h2 className="mcp-heading">{t('Recent activity')}</h2>
          {status.activity.length === 0 ? (
            <p className="muted small">{t('Nothing since LoreCraft started. This shows which tools were called, never any of your text.')}</p>
          ) : (
            <ul className="mcp-list small" data-testid="mcp-activity">
              {status.activity.slice(0, 30).map((entry, index) => (
                <li key={`${entry.at} ${index}`}>
                  {entry.ok
                    ? t('{time}: {client} called {tool}', { time: time(entry.at), client: entry.client, tool: entry.tool })
                    : t('{time}: {client} called {tool}, which was refused', { time: time(entry.at), client: entry.client, tool: entry.tool })}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
