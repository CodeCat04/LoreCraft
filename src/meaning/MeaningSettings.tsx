/** Settings > AI: turning on search by meaning, and where its vectors come from. */

import { useEffect, useRef, useState } from 'react';

import { toast } from '../shell/toasts';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { formatNumber } from '../lib/text';
import { useLocale } from '../state/language';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { meaningApi, type MeaningStatus } from './api';
import { takeMeaningFocus } from './discover';
import { megabytes } from './StatusItem';
import { clearIndex, downloadModel, removeModel, resumeIndexing, saveMeaningSettings, stopDownload, stopIndexing, useMeaning } from './store';

function StateLine({ status }: { status: MeaningStatus }) {
  useLocale();
  switch (status.state) {
    case 'notSetUp':
      return <span>{t('Not set up.')} {status.message ?? ''}</span>;
    case 'downloading':
      return (
        <>
          <span>
            {t('Downloading the model, {done} of {total}.', { done: megabytes(status.downloaded), total: megabytes(status.downloadTotal) })}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => void stopDownload()}>{t('Stop')}</button>
        </>
      );
    case 'noProject':
      return <span>{t('Open a project to index it.')}</span>;
    case 'indexing':
      return (
        <>
          <span>
            {t('Indexing {done} of {total}. You can keep working.', { done: formatNumber(status.done), total: formatNumber(status.total) })}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => void stopIndexing()}>{t('Stop')}</button>
        </>
      );
    case 'paused':
      return (
        <>
          <span>{t('Stopped at {done} of {total}.', { done: formatNumber(status.done), total: formatNumber(status.total) })}</span>
          <button type="button" className="btn btn-sm" onClick={() => void resumeIndexing()}>{t('Resume')}</button>
        </>
      );
    case 'failed':
      return (
        <>
          <span className="ai-settings-problem" role="alert">{t('Failed.')} {status.message}</span>
          <button type="button" className="btn btn-sm" onClick={() => void resumeIndexing()}>{t('Try again')}</button>
        </>
      );
    case 'ready':
      return (
        <>
          <span className="ai-settings-ok">
            {status.done === 1
              ? t('Ready. 1 passage indexed with {model}.', { model: status.model ?? '' })
              : t('Ready. {count} passages indexed with {model}.', { count: formatNumber(status.done), model: status.model ?? '' })}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => void clearIndex()}>{t('Rebuild the index')}</button>
        </>
      );
    default:
      return <span>{t('Off.')}</span>;
  }
}

function ProfileChoice() {
  useLocale();
  const ai = useSettings((s) => s.settings.ai);
  const config = ai.embeddings;
  const choices = ai.profiles.filter((profile) => profile.kind !== 'anthropic');
  const [model, setModel] = useState(config.model);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => setModel(config.model), [config.model]);
  useEffect(() => setResult(null), [config.profileId, model]);

  const selected = choices.find((profile) => profile.id === config.profileId) ?? choices[0];
  // Settings always name the profile in use, so what is shown is what runs.
  useEffect(() => {
    if (selected && selected.id !== config.profileId) void saveMeaningSettings({ profileId: selected.id });
  }, [selected, config.profileId]);

  const test = async () => {
    if (!selected) return;
    setTesting(true);
    setResult(null);
    try {
      const { dimensions } = await meaningApi.test(selected.id, model);
      setResult({ ok: true, text: t('It works, and answers with {count} numbers per passage.', { count: dimensions }) });
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  if (!selected) {
    return <p className="field-hint">{t('No profile here can make embeddings. Anthropic has no such service. Add an OpenAI or local profile above.')}</p>;
  }
  return (
    <>
      <div className="ai-settings-grid">
        <label className="field">
          <span className="field-label">{t('Profile')}</span>
          <select
            className="select"
            value={selected.id}
            onChange={(e) => void saveMeaningSettings({ profileId: e.target.value })}
          >
            {choices.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name || t('Unnamed')}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('Embeddings model')}</span>
          <input
            className="input"
            spellCheck={false}
            placeholder={t('For example, {model}', { model: 'text-embedding-3-small' })}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => {
              if (model !== config.model) void saveMeaningSettings({ model });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </label>
      </div>
      <div className="ai-settings-test">
        <button type="button" className="btn" disabled={testing || !model.trim()} onClick={() => void test()}>
          {testing ? t('Testing…') : t('Test this model')}
        </button>
        {result && (
          <span className={result.ok ? 'ai-settings-ok' : 'ai-settings-problem'} role="status" data-testid="meaning-test-result">
            {result.text}
          </span>
        )}
      </div>
    </>
  );
}

/** Says what a cloud provider receives, and how many local-only items it does not. */
function cloudNote(skipped: number): string {
  const lead = t('Your pages and scenes, and whatever you search for, go to this provider to be indexed.');
  if (skipped === 0) return `${lead} ${t('Anything marked local only is left out.')}`;
  const rest =
    skipped === 1
      ? t('1 marked local only is left out, so it cannot be found this way.')
      : t('{count} marked local only are left out, so they cannot be found this way.', { count: formatNumber(skipped) });
  return `${lead} ${rest}`;
}

export function MeaningSettings() {
  useLocale();
  const config = useSettings((s) => s.settings.ai.embeddings);
  const status = useMeaning((s) => s.status);
  const projectOpen = useProject((s) => s.status.open);

  useEffect(() => {
    void meaningApi.status().then((fresh) => useMeaning.setState({ status: fresh })).catch(() => {});
  }, [config, projectOpen]);

  // Arriving from a hint or the command: show this section and put the cursor on the switch.
  const switchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!takeMeaningFocus()) return;
    switchRef.current?.closest('section')?.scrollIntoView({ block: 'start' });
    switchRef.current?.focus();
  }, []);

  const builtin = config.source !== 'profile';
  const size = status ? megabytes(status.downloadTotal) : '91 MB';
  return (
    <section className="meaning-settings" data-testid="meaning-settings">
      <h2 className="ai-settings-head">{t('Search by meaning')}</h2>
      <p className="muted">
        {t('Finds passages by what they say, even when they share no words with your search, and lets the AI look things up the same way.')}
      </p>
      <label className="checkbox">
        <input
          ref={switchRef}
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => void saveMeaningSettings({ enabled: e.target.checked })}
        />
        <span>{t('Index this project so it can be searched by meaning')}</span>
      </label>
      {!config.enabled && status && status.leftoverPassages > 0 && (
        <div className="ai-settings-test">
          <button type="button" className="btn btn-sm" onClick={() => void clearIndex()}>{t('Remove the index from this project')}</button>
          <span className="field-hint">
            {status.leftoverPassages === 1
              ? t('1 indexed passage is still kept in the project.')
              : t('{count} indexed passages are still kept in the project.', { count: formatNumber(status.leftoverPassages) })}
          </span>
        </div>
      )}
      {config.enabled && (
        <div className="ai-settings-card meaning-card">
          <div className="meaning-source" role="radiogroup" aria-label={t('What makes the index')}>
            <label className="checkbox">
              <input
                type="radio"
                name="meaning-source"
                checked={builtin}
                onChange={() => void saveMeaningSettings({ source: 'builtin' })}
              />
              <span>
                {t('The built-in model')}
                <span className="field-hint">
                  {t('Runs on this computer and sends nothing anywhere. It is {size}, downloaded once, and works offline afterwards.', { size })}
                </span>
              </span>
            </label>
            <label className="checkbox">
              <input
                type="radio"
                name="meaning-source"
                checked={!builtin}
                onChange={() => void saveMeaningSettings({ source: 'profile' })}
              />
              <span>
                {t('A provider profile')}
                <span className="field-hint">{t('A server with an embeddings service, such as OpenAI, LM Studio or Ollama.')}</span>
              </span>
            </label>
          </div>

          {!builtin && <ProfileChoice />}

          {builtin && status && !status.builtinPresent && status.state !== 'downloading' && (
            <div className="ai-settings-test">
              <button type="button" className="btn btn-primary" onClick={() => void downloadModel()}>
                {t('Download the model ({size})', { size })}
              </button>
              <span className="field-hint">{t("From Hugging Face, into this app's data folder. Its checksum is verified when it arrives.")}</span>
            </div>
          )}

          {builtin && status?.builtinPresent && (
            <div className="ai-settings-test">
              <button type="button" className="btn btn-sm" onClick={() => void removeModel().catch((e: unknown) => toast(errorMessage(e), 'error'))}>
                {t('Remove the model')}
              </button>
              <span className="field-hint">{t('Frees {size}. You would download it again to index anything new.', { size })}</span>
            </div>
          )}

          {status?.isCloud && (
            <p className="ai-settings-problem" role="note">
              {cloudNote(status.skippedLocalOnly)}
            </p>
          )}

          <div className="meaning-state" role="status" data-testid="meaning-state">
            {status ? <StateLine status={status} /> : <span>{t('Off.')}</span>}
          </div>
          <p className="field-hint">
            {t('The index is kept in the project file and adds about 9 MB for a 100,000-word book. Building it does not count as a change to save.')}
          </p>
        </div>
      )}
    </section>
  );
}
