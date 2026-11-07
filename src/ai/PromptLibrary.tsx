/** Saved prompts. Built-in ones can be edited, and restored by deleting the edit. */

import { useCallback, useEffect, useState } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { confirm } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useDataVersion } from '../state/events';
import { useLocale } from '../state/language';
import * as coreApi from '../lib/api';
import * as api from './api';
import { planPromptImport, PromptFileError, promptFileName, promptFileText, readPromptFile, type PlannedPrompt, type ReadPromptFile } from './promptFiles';
import { usePane } from './store';
import type { PromptAction, PromptScope, PromptTemplate } from './types';

// ---------------------------------------------------------------------------
// Prompt files: export one, export all custom, and import with a preview.
// ---------------------------------------------------------------------------

const fileFilters = () => [{ name: t('LoreCraft prompts'), extensions: ['json'] }];

async function exportPromptsToFile(list: PromptTemplate[], defaultName: string): Promise<void> {
  try {
    const path = await coreApi.files.pickSave({ title: t('Export prompts'), defaultName, filters: fileFilters() });
    if (!path) return;
    await coreApi.files.writeText(path, promptFileText(list));
    toast(list.length === 1 ? t('Exported 1 prompt.') : t('Exported {count} prompts.', { count: list.length }), 'success');
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

function fileErrorMessage(e: unknown): string {
  if (e instanceof PromptFileError) {
    if (e.message === 'newer') return t('This prompt file was made by a newer LoreCraft. Update LoreCraft to import it.');
    return t('This is not a LoreCraft prompt file.');
  }
  return errorMessage(e);
}

function problemMessage(problem: ReadPromptFile['problems'][number]): string {
  const which = problem.name ? t('Prompt {number} (“{name}”)', { number: problem.index, name: problem.name }) : t('Prompt {number}', { number: problem.index });
  switch (problem.message) {
    case 'no-name':
      return t('{which} has no name, so it is left out.', { which });
    case 'no-text':
      return t('{which} has no text, so it is left out.', { which });
    case 'bad-scope':
      return t('{which} has an unknown "scope", so it is left out.', { which });
    case 'bad-action':
      return t('{which} has an unknown "action", so it is left out.', { which });
    case 'too-many':
      return t('The file has more than 500 prompts. Only the first 500 are read.');
    default:
      return t('{which} is not a prompt, so it is left out.', { which });
  }
}

interface ImportPreview {
  fileName: string;
  plan: PlannedPrompt[];
  problems: ReadPromptFile['problems'];
}

function outcomeLabel(item: PlannedPrompt): string {
  if (item.outcome === 'skip') return t('Already in this project. Skipped.');
  if (item.outcome === 'rename') return t('A different prompt has this name, so it is added as “{name}”.', { name: item.name });
  return t('Added.');
}

function ImportPreviewPanel({ preview, onDone }: { preview: ImportPreview; onDone: () => void }) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const toAdd = preview.plan.filter((item) => item.outcome !== 'skip');
  const run = async () => {
    setBusy(true);
    let added = 0;
    try {
      for (const item of toAdd) {
        const { description, template, scope, action } = item.entry;
        await api.prompts.save({ name: item.name, description, template, scope, action });
        added += 1;
      }
      toast(added === 1 ? t('Imported 1 prompt.') : t('Imported {count} prompts.', { count: added }), 'success');
    } catch (e) {
      toast(`${t('Imported {count} prompts.', { count: added })} ${errorMessage(e)}`, 'error');
    }
    onDone();
  };
  return (
    <section className="ai-prompt-import" aria-labelledby="ai-prompt-import-title" data-testid="ai-prompt-import">
      <h3 id="ai-prompt-import-title" className="ai-prompt-name">{t('Import prompts from {file}', { file: preview.fileName })}</h3>
      {preview.plan.length === 0 && <p className="muted small">{t('There are no prompts to import in this file.')}</p>}
      <ul className="ai-prompt-list">
        {preview.plan.map((item, index) => (
          <li key={index} className={`ai-prompt-item${item.outcome === 'skip' ? ' is-skipped' : ''}`}>
            <div className="ai-prompt-name">{item.entry.name}</div>
            <div className="faint small">{outcomeLabel(item)}</div>
          </li>
        ))}
      </ul>
      {preview.problems.length > 0 && (
        <ul className="ai-prompt-problems small" aria-label={t('Problems')}>
          {preview.problems.map((problem, index) => (
            <li key={index} className="field-error">{problemMessage(problem)}</li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-sm" onClick={onDone}>{t('Cancel')}</button>
        <button type="button" className="btn btn-sm btn-primary" autoFocus disabled={busy || toAdd.length === 0} onClick={() => void run()}>
          {toAdd.length === 1 ? t('Import 1 prompt') : t('Import {count} prompts', { count: toAdd.length })}
        </button>
      </div>
    </section>
  );
}

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
  const [importing, setImporting] = useState<ImportPreview | null>(null);
  const setDraft = usePane((s) => s.setDraft);
  const setView = usePane((s) => s.setView);

  const load = useCallback(() => {
    void api.prompts.list().then(setPrompts).catch(() => {});
  }, []);
  useEffect(load, [load, version]);

  const custom = prompts.filter((prompt) => !prompt.builtin);
  const pickImport = async () => {
    try {
      const [path] = await coreApi.files.pickOpen({ title: t('Import prompts'), filters: fileFilters() });
      if (!path) return;
      const { text } = await coreApi.files.readText(path);
      const read = readPromptFile(text);
      const current = await api.prompts.list();
      setImporting({ fileName: path.split(/[\\/]/).pop() ?? path, plan: planPromptImport(read.prompts, current), problems: read.problems });
    } catch (e) {
      toast(fileErrorMessage(e), 'error');
    }
  };

  if (importing) {
    return (
      <div className="ai-prompts">
        <ImportPreviewPanel
          preview={importing}
          onDone={() => {
            setImporting(null);
            load();
          }}
        />
      </div>
    );
  }

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
      <div className="ai-prompt-row ai-prompt-files" role="group" aria-label={t('Prompt files')}>
        <button type="button" className="btn btn-sm" onClick={() => void pickImport()}>
          {t('Import…')}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={custom.length === 0}
          title={custom.length === 0 ? t('You have no prompts of your own yet.') : undefined}
          onClick={() => void exportPromptsToFile(custom, 'lorecraft-prompts.json')}
        >
          {t('Export all custom…')}
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
                aria-label={t('Export “{name}”', { name: prompt.name })}
                onClick={() => void exportPromptsToFile([prompt], promptFileName(prompt.name))}
              >
                {t('Export…')}
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
