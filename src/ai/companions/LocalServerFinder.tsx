/** Settings > AI: looks for model servers on this computer, and offers to add what answers. */

import { useState } from 'react';

import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import type { AiProfile } from '../../lib/settings';
import { useLocale } from '../../state/language';
import * as api from '../api';
import type { FoundServer } from '../types';

const COMMON_NAMES: Record<number, string> = {
  8080: 'llama.cpp',
  11434: 'Ollama',
  1234: 'LM Studio',
  5000: 'text-generation-webui',
  5001: 'KoboldCpp',
  8000: 'vLLM',
};

/** What usually runs on a port. A guess, so it is only ever described as one. */
export function usualServer(port: number): string | null {
  return COMMON_NAMES[port] ?? null;
}

export function profileNameFor(server: FoundServer): string {
  // These two have ports of their own. The others are shared by many programs.
  if (server.port === 11434) return 'Ollama';
  if (server.port === 1234) return 'LM Studio';
  return t('Local server on port {port}', { port: server.port });
}

function sameAddress(a: string, b: string): boolean {
  const key = (url: string) => url.trim().replace(/\/+$/, '').replace('//localhost', '//127.0.0.1').toLowerCase();
  return key(a) === key(b);
}

export function isAlreadyAdded(server: FoundServer, profiles: AiProfile[]): boolean {
  return profiles.some((profile) => sameAddress(profile.baseUrl, server.baseUrl));
}

function modelsLine(server: FoundServer): string {
  if (server.needsKey) return t('It asks for an API key.');
  if (server.models.length === 0) return t('No model loaded.');
  const shown = server.models.slice(0, 3).join(', ');
  const more = server.models.length - 3;
  if (server.models.length === 1) return t('Model: {models}.', { models: shown });
  if (more <= 0) return t('Models: {models}.', { models: shown });
  return more === 1
    ? t('Models: {models} and 1 more.', { models: shown })
    : t('Models: {models} and {count} more.', { models: shown, count: more });
}

export function LocalServerFinder({ profiles, onAdd }: { profiles: AiProfile[]; onAdd: (server: FoundServer, name: string) => void }) {
  useLocale();
  const [found, setFound] = useState<FoundServer[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const look = async () => {
    setLooking(true);
    setProblem(null);
    try {
      setFound(await api.provider.findLocalServers());
    } catch (e) {
      setFound(null);
      setProblem(errorMessage(e));
    } finally {
      setLooking(false);
    }
  };

  return (
    <div className="ai-find" data-testid="ai-find-servers">
      <div className="ai-settings-test">
        <button type="button" className="btn" disabled={looking} onClick={() => void look()}>
          {looking ? t('Looking…') : t('Find local servers')}
        </button>
        <span className="field-hint">{t('Tries the usual ports on this computer only, and only when you press this.')}</span>
      </div>
      {problem && <p className="ai-settings-problem" role="alert">{problem}</p>}
      {found && found.length === 0 && (
        <p className="muted small" role="status">
          {t('Nothing answered on 127.0.0.1 at ports 8080, 11434, 1234, 5000, 5001 or 8000. Start your model server, then look again.')}
        </p>
      )}
      {found && found.length > 0 && (
        <ul className="ai-find-list" aria-label={t('Local servers found')}>
          {found.map((server) => {
            const added = isAlreadyAdded(server, profiles);
            const usual = usualServer(server.port);
            return (
              <li key={server.port} className="ai-find-item" data-testid="ai-found-server" data-port={server.port}>
                <div className="ai-find-text">
                  <strong>{server.baseUrl}</strong>
                  {usual && <span className="faint small"> {t('This port is often {name}.', { name: usual })}</span>}
                  <div className="faint small truncate">{modelsLine(server)}</div>
                </div>
                <button type="button" className="btn btn-sm" disabled={added} onClick={() => onAdd(server, profileNameFor(server))}>
                  {added ? t('Already added') : t('Add')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
