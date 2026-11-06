/** Saved prompts. Built-in ones can be edited, and restored by deleting the edit. */

import { useCallback, useEffect, useState } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { confirm } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useDataVersion } from '../state/events';
import { useLocale } from '../state/language';
import * as api from './api';
import { usePane } from './store';
import type { PromptAction, PromptScope, PromptTemplate } from './types';

/** Built when shown, so the labels follow the interface language. */
const scopes = (): { id: PromptScope; label: string }[] => [
  { id: 'selection', label: t('Selected text') },
  { id: 'page', label: t('Wiki page') },
  { id: 'scene', label: t('Scene') },
  { id: 'chat', label: t('Chat') },
];

const actions = (): { id: PromptAction; label: string }[] => [
  { id: 'replace', label: t('Replaces the text') },
  { id: 'insert', label: t('Adds after the text') },
  { id: 'chat', label: t('Answers in the pane') },
];

interface Editing {
  id?: string;
  name: string;
  description: string;
  template: string;
  scope: PromptScope;
  action: PromptAction;
  builtin: boolean;
}

function PromptEditor({ value, onChange, onDone }: { value: Editing; onChange: (next: Editing) => void; onDone: () => void }) {
  useLocale();
  const save = async () => {
    try {
      await api.prompts.save({
        id: value.id,
        name: value.name,
        description: value.description,
        template: value.template,
        scope: value.scope,
        action: value.action,
      });
      onDone();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <form
      className="ai-prompt-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="field">
        <span className="field-label">{t('Name')}</span>
        <input className="input" autoFocus value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">{t('Description')}</span>
        <input className="input" value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">{t('Prompt')}</span>
        <textarea className="textarea" rows={6} value={value.template} onChange={(e) => onChange({ ...value, template: e.target.value })} />
        <span className="field-hint">
          {t('{{selection}} is the selected text, {{page}} the open page or scene, and {{book}} an outline of your books.')}
        </span>
      </label>
      <div className="ai-prompt-row">
        <label className="field">
          <span className="field-label">{t('Used for')}</span>
          <select className="select" value={value.scope} onChange={(e) => onChange({ ...value, scope: e.target.value as PromptScope })}>
            {scopes().map((scope) => (
              <option key={scope.id} value={scope.id}>{scope.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('What it does')}</span>
          <select className="select" value={value.action} onChange={(e) => onChange({ ...value, action: e.target.value as PromptAction })}>
            {actions().map((action) => (
              <option key={action.id} value={action.id}>{action.label}</option>
            ))}
            {value.action === 'metadata' && <option value="metadata">{t('Fills in a field')}</option>}
          </select>
        </label>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-sm" onClick={onDone}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!value.name.trim() || !value.template.trim()}>{t('Save')}</button>
      </div>
    </form>
  );
}

export function PromptLibrary() {
  useLocale();
  const version = useDataVersion('ai');
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [scope, setScope] = useState<PromptScope | 'all'>('all');
  const [editing, setEditing] = useState<Editing | null>(null);
  const setDraft = usePane((s) => s.setDraft);
  const setView = usePane((s) => s.setView);

  const load = useCallback(() => {
    void api.prompts.list().then(setPrompts).catch(() => {});
  }, []);
  useEffect(load, [load, version]);

  if (editing) {
    return (
      <div className="ai-prompts">
        <PromptEditor
          value={editing}
          onChange={setEditing}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      </div>
    );
  }

  const shown = prompts.filter((prompt) => scope === 'all' || prompt.scope === scope);
  return (
    <div className="ai-prompts" data-testid="ai-prompts">
      <div className="ai-prompt-row ai-prompt-head">
        <select className="select" aria-label={t('Show prompts for')} value={scope} onChange={(e) => setScope(e.target.value as PromptScope | 'all')}>
          <option value="all">{t('All prompts')}</option>
          {scopes().map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setEditing({ name: '', description: '', template: '', scope: 'selection', action: 'replace', builtin: false })}
        >
          {t('New prompt')}
        </button>
      </div>
      <ul className="ai-prompt-list">
        {shown.map((prompt) => (
          <li key={prompt.id} className="ai-prompt-item">
            <div className="ai-prompt-name">{prompt.name}</div>
            <div className="faint small">{prompt.description || prompt.template}</div>
            <div className="ai-prompt-actions">
              <button
                type="button"
                className="btn btn-sm"
                title={t('Put this in the message box')}
                onClick={() => {
                  setDraft(prompt.template);
                  setView('chat');
                }}
              >
                {t('Use')}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  setEditing({
                    id: prompt.id, name: prompt.name, description: prompt.description, template: prompt.template,
                    scope: prompt.scope, action: prompt.action, builtin: prompt.builtin,
                  })
                }
              >
                {t('Edit')}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  const yes = await confirm(
                    prompt.builtin
                      ? { title: t('Restore “{name}”?', { name: prompt.name }), message: t('This puts back its original text.'), confirmLabel: t('Restore') }
                      : { title: t('Delete “{name}”?', { name: prompt.name }), confirmLabel: t('Delete'), danger: true },
                  );
                  if (yes) {
                    await api.prompts.remove(prompt.id);
                    load();
                  }
                }}
              >
                {prompt.builtin ? t('Restore') : t('Delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
