/** Settings > AI: provider profiles, routing, and what stays local and what is sent. */

import { useCallback, useEffect, useState } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { LOCAL_PROFILE_ID, type AiProfile, type AiTask, type ProviderKind } from '../lib/settings';
import { confirm } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { useSettings } from '../state/settings';
import { MeaningSettings } from '../meaning/MeaningSettings';
import * as api from './api';
import { LocalServerFinder } from './companions/LocalServerFinder';
import { contextBudget } from './context';
import { defaultMaxTokens } from './limits';
import type { ConnectionResult, ModelInfo } from './types';
import { SpendingSettings } from './limits/SpendingSettings';
import { SummarySettings } from './summaries/SummarySettings';
import { versionCount } from './companions/versions';

interface Preset {
  label: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  isCloud: boolean;
  inputCostPerMTok?: number;
  outputCostPerMTok?: number;
  effort?: string;
}

/** Built when shown, so the labels follow the interface language. */
const presets = (): Preset[] => [
  {
    label: t('Local model'),
    kind: 'openai-compatible',
    name: t('Local model'),
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: '',
    isCloud: false,
  },
  {
    label: 'OpenAI',
    kind: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6-astra',
    isCloud: true,
    inputCostPerMTok: 10,
    outputCostPerMTok: 50,
    effort: 'medium',
  },
  {
    label: 'Anthropic',
    kind: 'anthropic',
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5-5',
    isCloud: true,
    inputCostPerMTok: 4,
    outputCostPerMTok: 20,
    effort: 'medium',
  },
];

const tasks = (): { id: AiTask; label: string; hint: string }[] => [
  { id: 'chat', label: t('Chat'), hint: t('The AI pane') },
  { id: 'rewrite', label: t('Rewriting'), hint: t('Ask AI on selected text, and whole-page actions') },
  { id: 'extract', label: t('Extracting'), hint: t('Pulling facts out of text') },
  { id: 'consistency', label: t('Consistency checks'), hint: t('Comparing the story with the wiki') },
];

const kinds = (): { id: ProviderKind; label: string }[] => [
  { id: 'openai-compatible', label: t('Local or OpenAI-compatible server') },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
];

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function newProfileId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function isOnThisComputer(address: string): boolean {
  return /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])([:/]|$)/i.test(address.trim());
}

function NumberField(props: { label: string; hint?: string; value: number | undefined; placeholder?: string; step?: number; onChange: (value: number | undefined) => void }) {
  return (
    <label className="field ai-settings-number">
      <span className="field-label">{props.label}</span>
      <input
        className="input"
        type="number"
        min={0}
        step={props.step ?? 1}
        value={props.value ?? ''}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)))}
      />
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

function KeyField({ profile }: { profile: AiProfile }) {
  useLocale();
  const [has, setHas] = useState<boolean | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.keys.has(profile.id).then((result) => {
      if (!cancelled) setHas(result);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  const save = async () => {
    setBusy(true);
    try {
      await api.keys.set(profile.id, value);
      setHas(true);
      setValue('');
      toast(t('API key saved.'), 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const required = profile.kind !== 'openai-compatible';
  return (
    <div className="field">
      <label className="field-label" htmlFor={`key-${profile.id}`}>{required ? t('API key') : t('API key (if the server needs one)')}</label>
      <div className="ai-settings-inline">
        <input
          id={`key-${profile.id}`}
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={has ? t('A key is saved. Type here to replace it.') : t('Paste your key')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) {
              e.preventDefault();
              void save();
            }
          }}
        />
        <button type="button" className="btn" disabled={busy || !value.trim()} onClick={() => void save()}>{t('Save key')}</button>
        {has && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              await api.keys.remove(profile.id);
              setHas(false);
            }}
          >
            {t('Remove')}
          </button>
        )}
      </div>
      <span className="field-hint" data-testid="key-status">
        {has === null ? ' ' : has ? t('A key is saved. It cannot be shown again.') : t('No key saved.')}{' '}
        {t("It stays in your system's credential store, and is only ever sent to this profile's address.")}
      </span>
    </div>
  );
}

function ImageSupport({ profile, onChange }: { profile: AiProfile; onChange: (value: boolean | undefined) => void }) {
  useLocale();
  const [detected, setDetected] = useState<{ supported: boolean; source: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDetected(null);
    void api.provider.imageSupport(profile.id).then((result) => {
      if (!cancelled) setDetected(result);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profile.id, profile.baseUrl, profile.kind, profile.supportsImages]);
  const current = profile.supportsImages === undefined ? 'auto' : profile.supportsImages ? 'yes' : 'no';
  const auto =
    detected?.source === 'detected'
      ? detected.supported ? t('Automatic: the server says yes') : t('Automatic: the server says no')
      : profile.kind === 'openai-compatible'
        ? t('Automatic: no, unless the server says it can')
        : t('Automatic: yes');
  return (
    <label className="field ai-settings-select">
      <span className="field-label">{t('Can read images')}</span>
      <select
        className="select"
        value={current}
        onChange={(e) => onChange(e.target.value === 'auto' ? undefined : e.target.value === 'yes')}
      >
        <option value="auto">{auto}</option>
        <option value="yes">{t('Yes')}</option>
        <option value="no">{t('No')}</option>
      </select>
      <span className="field-hint">{t('Lets this profile be shown pictures, for describing them.')}</span>
    </label>
  );
}

function ModelField({ profile, onChange }: { profile: AiProfile; onChange: (model: string) => void }) {
  useLocale();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const listId = `models-${profile.id}`;

  const load = useCallback(() => {
    setLoading(true);
    setProblem(null);
    api.provider
      .listModels(profile.id)
      .then(setModels)
      .catch((e: unknown) => {
        setModels([]);
        setProblem(errorMessage(e));
      })
      .finally(() => setLoading(false));
  }, [profile.id]);

  const found = models.find((m) => m.id === profile.model);
  return (
    <div className="field">
      <label className="field-label" htmlFor={`model-${profile.id}`}>{t('Model')}</label>
      <div className="ai-settings-inline">
        <input
          id={`model-${profile.id}`}
          className="input"
          list={listId}
          placeholder={profile.kind === 'openai-compatible' ? t('Leave empty to use whichever the server has loaded') : t('A model name')}
          value={profile.model}
          onFocus={() => {
            if (models.length === 0 && !loading) load();
          }}
          onChange={(e) => onChange(e.target.value)}
        />
        <datalist id={listId}>
          {models.map((model) => (
            <option key={model.id} value={model.id}>{model.name ?? model.id}</option>
          ))}
        </datalist>
        <button type="button" className="btn" disabled={loading} onClick={load}>{loading ? t('Loading…') : t('List models')}</button>
      </div>
      {problem && <span className="field-hint ai-settings-problem" role="alert">{problem}</span>}
      {!problem && models.length > 0 && (
        <span className="field-hint">
          {models.length === 1 ? t('1 available.') : t('{count} available.', { count: models.length })}
          {found?.contextTokens ? ` ${t("This model's context window is {count} tokens.", { count: found.contextTokens.toLocaleString() })}` : ''}
        </span>
      )}
    </div>
  );
}

function TestConnection({ profile }: { profile: AiProfile }) {
  useLocale();
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => setResult(null), [profile.id, profile.baseUrl, profile.model, profile.kind]);
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.provider.testConnection(profile.id));
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="ai-settings-test">
      <button type="button" className="btn" disabled={testing} onClick={() => void test()}>
        {testing ? t('Testing…') : t('Test connection')}
      </button>
      {result && (
        <span className={result.ok ? 'ai-settings-ok' : 'ai-settings-problem'} role="status" data-testid="connection-result">
          {result.message}
        </span>
      )}
    </div>
  );
}

function ProfileCard({ profile, onChange, onDelete, canDelete }: {
  profile: AiProfile;
  onChange: (patch: Partial<AiProfile>) => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  useLocale();
  const budget = contextBudget({ ...profile, contextTokens: undefined });
  return (
    <div className="ai-settings-card" data-testid="ai-profile-card">
      <div className="ai-settings-grid">
        <label className="field">
          <span className="field-label">{t('Name')}</span>
          <input className="input" value={profile.name} onChange={(e) => onChange({ name: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">{t('Type')}</span>
          <select
            className="select"
            value={profile.kind}
            onChange={(e) => onChange({ kind: e.target.value as ProviderKind })}
          >
            {kinds().map((kind) => (
              <option key={kind.id} value={kind.id}>{kind.label}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span className="field-label">{t('Address')}</span>
        <input
          className="input"
          spellCheck={false}
          value={profile.baseUrl}
          // An address off this computer means text leaves it, so the warning comes on.
          onChange={(e) => onChange({ baseUrl: e.target.value, isCloud: profile.isCloud || !isOnThisComputer(e.target.value) })}
        />
      </label>
      <KeyField profile={profile} />
      <ModelField profile={profile} onChange={(model) => onChange({ model })} />
      <TestConnection profile={profile} />

      <label className="checkbox ai-settings-cloud">
        <input type="checkbox" checked={profile.isCloud} onChange={(e) => onChange({ isCloud: e.target.checked })} />
        <span>{t('This sends text off this computer, so ask before sending')}</span>
      </label>

      <div className="ai-settings-grid ai-settings-numbers">
        <NumberField
          label={t('Context size')}
          hint={t('Tokens of lore, text and history to send')}
          value={profile.contextTokens}
          placeholder={budget.toLocaleString()}
          step={1000}
          onChange={(contextTokens) => onChange({ contextTokens })}
        />
        <NumberField
          label={t('Max tokens')}
          hint={t('Output limit. Thinking counts against it.')}
          value={profile.maxTokens}
          placeholder={defaultMaxTokens(profile.kind).toLocaleString()}
          step={1000}
          onChange={(maxTokens) => onChange({ maxTokens })}
        />
        {profile.kind !== 'openai-compatible' && (
          <label className="field ai-settings-select">
            <span className="field-label">{t('Effort')}</span>
            <select
              className="select"
              value={profile.effort ?? ''}
              onChange={(e) => onChange({ effort: e.target.value || undefined })}
            >
              <option value="">{t("The model's default")}</option>
              {EFFORTS.map((effort) => (
                <option key={effort} value={effort}>{effort}</option>
              ))}
            </select>
            <span className="field-hint">{t('More effort means more thinking, time and cost.')}</span>
          </label>
        )}
        <NumberField
          label={t('Input cost')}
          hint={t('Dollars per million tokens')}
          value={profile.inputCostPerMTok}
          placeholder="0"
          step={0.1}
          onChange={(inputCostPerMTok) => onChange({ inputCostPerMTok })}
        />
        <NumberField
          label={t('Output cost')}
          hint={t('Dollars per million tokens')}
          value={profile.outputCostPerMTok}
          placeholder="0"
          step={0.1}
          onChange={(outputCostPerMTok) => onChange({ outputCostPerMTok })}
        />
        <ImageSupport profile={profile} onChange={(supportsImages) => onChange({ supportsImages })} />
      </div>

      {canDelete && (
        <div className="dialog-actions">
          <button type="button" className="btn btn-danger btn-sm" onClick={onDelete}>{t('Delete this profile')}</button>
        </div>
      )}
    </div>
  );
}

export function AiSettings() {
  useLocale();
  const ai = useSettings((s) => s.settings.ai);
  const update = useSettings((s) => s.update);
  const [openId, setOpenId] = useState<string>(ai.profiles[0]?.id ?? LOCAL_PROFILE_ID);

  const saveProfiles = (profiles: AiProfile[]) => update({ ai: { profiles } });
  const patchProfile = (id: string, patch: Partial<AiProfile>) => {
    void saveProfiles(ai.profiles.map((p) => (p.id === id ? cleaned({ ...p, ...patch }) : p)));
  };

  const addPreset = (preset: Preset) => {
    const profile: AiProfile = {
      id: newProfileId(),
      name: preset.name,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      model: preset.model,
      isCloud: preset.isCloud,
      inputCostPerMTok: preset.inputCostPerMTok,
      outputCostPerMTok: preset.outputCostPerMTok,
      effort: preset.effort,
    };
    void saveProfiles([...ai.profiles, cleaned(profile)]);
    setOpenId(profile.id);
  };

  const removeProfile = async (profile: AiProfile) => {
    const yes = await confirm({
      title: t('Delete “{name}”?', { name: profile.name }),
      message: t('Its saved API key is removed too.'),
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!yes) return;
    await api.keys.remove(profile.id).catch(() => {});
    const remaining = ai.profiles.filter((p) => p.id !== profile.id);
    const fallback = remaining[0]?.id ?? LOCAL_PROFILE_ID;
    const routing = { ...ai.routing };
    for (const task of tasks()) {
      if (routing[task.id] === profile.id) routing[task.id] = fallback;
    }
    await update({ ai: { profiles: remaining, routing } });
    setOpenId(fallback);
  };

  const open = ai.profiles.find((p) => p.id === openId) ?? ai.profiles[0];

  return (
    <section className="ai-settings" data-testid="ai-settings">
      <div className="ai-settings-plain">
        <h2 className="ai-settings-head">{t('What stays here and what is sent')}</h2>
        <p>
          {t('Your project stays on this computer. A local profile sends text only to the server at its address, so if that is on this computer, nothing leaves it.')}
        </p>
        <p>
          {t('A cloud profile sends your request to that company when you use it: what you typed, the text you selected, and the lore that goes with it. The “What is sent” tab in the AI pane shows exactly that before you send, and you are asked the first time.')}
        </p>
        <p>{t("API keys are kept in your system's credential store, not in your project or settings.")}</p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={ai.cloudWarningDismissed}
            onChange={(e) => void update({ ai: { cloudWarningDismissed: e.target.checked } })}
          />
          <span>{t('Do not ask before sending to a cloud provider')}</span>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={ai.showThinking}
            onChange={(e) => void update({ ai: { showThinking: e.target.checked } })}
          />
          <span>{t("Show the model's thinking, instead of collapsing it")}</span>
        </label>
        <label className="field">
          <span className="field-label">{t('Versions of a rewrite')}</span>
          <select
            className="select"
            data-testid="ai-rewrite-versions"
            value={versionCount(ai.rewriteVersions)}
            onChange={(e) => void update({ ai: { rewriteVersions: versionCount(Number(e.target.value)) } })}
          >
            {[2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      <h2 className="ai-settings-head">{t('Provider profiles')}</h2>
      <div className="ai-settings-profiles" role="tablist" aria-label={t('Provider profiles')}>
        {ai.profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            role="tab"
            aria-selected={open?.id === profile.id}
            className={`settings-tab${open?.id === profile.id ? ' is-active' : ''}`}
            onClick={() => setOpenId(profile.id)}
          >
            {profile.name || t('Unnamed')}
          </button>
        ))}
        <span className="ai-settings-add">
          <span className="faint small">{t('Add:')}</span>
          {presets().map((preset) => (
            <button key={preset.label} type="button" className="btn btn-sm" onClick={() => addPreset(preset)}>{preset.label}</button>
          ))}
        </span>
      </div>
      <LocalServerFinder
        profiles={ai.profiles}
        onAdd={(server, name) =>
          addPreset({ label: name, kind: 'openai-compatible', name, baseUrl: server.baseUrl, model: '', isCloud: false })
        }
      />
      {open ? (
        <ProfileCard
          key={open.id}
          profile={open}
          onChange={(patch) => patchProfile(open.id, patch)}
          onDelete={() => void removeProfile(open)}
          canDelete={ai.profiles.length > 1}
        />
      ) : (
        <p className="muted">{t('No profiles yet. Add one above.')}</p>
      )}

      <h2 className="ai-settings-head">{t('Cloud spending')}</h2>
      <SpendingSettings />

      <h2 className="ai-settings-head">{t('Story so far')}</h2>
      <SummarySettings />

      <h2 className="ai-settings-head">{t('Which profile does what')}</h2>
      <div className="ai-settings-routing">
        {tasks().map((task) => (
          <label key={task.id} className="field">
            <span className="field-label">{task.label}</span>
            <select
              className="select"
              value={ai.routing[task.id]}
              onChange={(e) => void update({ ai: { routing: { [task.id]: e.target.value } } })}
            >
              {ai.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
            <span className="field-hint">{task.hint}</span>
          </label>
        ))}
      </div>

      <MeaningSettings />
    </section>
  );
}

/** Settings keep no empty fields, so a cleared number returns to its default. */
function cleaned(profile: AiProfile): AiProfile {
  const out = { ...profile } as Record<string, unknown>;
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined) delete out[key];
  }
  return out as unknown as AiProfile;
}
