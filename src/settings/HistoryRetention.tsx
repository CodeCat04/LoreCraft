/** Settings > Saving: how long the open project keeps the history of its pages and scenes. */

import { useEffect, useState } from 'react';

import { revisions, type Retention } from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { useLocale } from '../state/language';
import { useProject } from '../state/project';
import { toast } from '../shell/toasts';

/** The same limits the backend clamps to, in src-tauri/src/rpc/revisions.rs. */
export const LIMITS = {
  keepAllDays: { min: 1, max: 3650 },
  dailyForDays: { min: 1, max: 36500 },
  keepLatest: { min: 1, max: 1000 },
} as const;

type Field = keyof typeof LIMITS;
export type RetentionDraft = { enabled: boolean } & Record<Field, string>;

/** The problem with each field, in the interface language. No problems means it can be saved. */
export function validateRetention(draft: RetentionDraft): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  for (const field of Object.keys(LIMITS) as Field[]) {
    const text = draft[field].trim();
    const value = Number(text);
    const { min, max } = LIMITS[field];
    if (!/^\d+$/.test(text) || value < min || value > max) {
      errors[field] = t('Enter a whole number from {min} to {max}.', { min, max });
    }
  }
  if (!errors.keepAllDays && !errors.dailyForDays && Number(draft.dailyForDays) < Number(draft.keepAllDays)) {
    errors.dailyForDays = t('This must be at least the days that keep every version.');
  }
  return errors;
}

const toDraft = (value: Retention): RetentionDraft => ({
  enabled: value.enabled,
  keepAllDays: String(value.keepAllDays),
  dailyForDays: String(value.dailyForDays),
  keepLatest: String(value.keepLatest),
});

export function HistoryRetention() {
  useLocale();
  const open = useProject((s) => s.status.open);
  const path = useProject((s) => s.status.path);
  const [draft, setDraft] = useState<RetentionDraft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(null);
    if (!open) return;
    let live = true;
    revisions
      .retention()
      .then((value) => {
        if (live) setDraft(toDraft(value));
      })
      .catch((error) => toast(t('Could not read the history settings: {reason}', { reason: errorMessage(error) }), 'error'));
    return () => {
      live = false;
    };
  }, [open, path]);

  const errors = draft ? validateRetention(draft) : {};
  const invalid = Object.keys(errors).length > 0;
  const disabled = !open || !draft;

  const save = async () => {
    if (!draft || invalid) return;
    setSaving(true);
    try {
      const stored = await revisions.setRetention({
        enabled: draft.enabled,
        keepAllDays: Number(draft.keepAllDays),
        dailyForDays: Number(draft.dailyForDays),
        keepLatest: Number(draft.keepLatest),
      });
      setDraft(toDraft(stored));
      toast(t('History settings saved.'));
    } catch (error) {
      toast(t('Could not save the history settings: {reason}', { reason: errorMessage(error) }), 'error');
    } finally {
      setSaving(false);
    }
  };

  const number = (field: Field, label: string, hint: string) => {
    const id = `retention-${field}`;
    const error = errors[field];
    return (
      <label className="field" style={{ maxWidth: '24rem' }}>
        <span className="field-label">{label}</span>
        <input
          className="input"
          type="number"
          inputMode="numeric"
          data-testid={id}
          min={LIMITS[field].min}
          max={LIMITS[field].max}
          value={draft?.[field] ?? ''}
          disabled={disabled || !draft?.enabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            if (draft) setDraft({ ...draft, [field]: e.target.value });
          }}
        />
        <span className="field-hint" id={`${id}-hint`} role={error ? 'alert' : undefined}>
          {error ?? hint}
        </span>
      </label>
    );
  };

  return (
    <fieldset className="settings-group" disabled={!open} data-testid="history-retention" style={{ marginTop: '1.5rem' }}>
      <legend className="settings-legend">{t('History for this project')}</legend>
      {!open && <p className="muted">{t('Open a project to change how long it keeps its history.')}</p>}
      <p className="muted" style={{ maxWidth: '40rem' }}>
        {t(
          'Each page and scene keeps earlier versions you can go back to. To save space, old versions can be thinned out. Snapshots taken before an import, merge, split or restore, and checkpoints you make yourself, are always kept.',
        )}
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          data-testid="retention-enabled"
          checked={draft?.enabled ?? false}
          disabled={disabled}
          onChange={(e) => {
            if (draft) setDraft({ ...draft, enabled: e.target.checked });
          }}
        />
        <span>{t('Thin out old history')}</span>
      </label>
      {draft && !draft.enabled && <p className="field-hint">{t('Every version is kept for ever.')}</p>}
      {number('keepAllDays', t('Days that keep every version'), t('Every version younger than this is kept.'))}
      {number('dailyForDays', t('Days that keep one version a day'), t('After that, one version a week is kept.'))}
      {number('keepLatest', t('Newest versions always kept'), t('For each page and scene, however old they are.'))}
      <button
        type="button"
        className="btn btn-primary"
        data-testid="retention-save"
        disabled={disabled || invalid || saving}
        onClick={() => void save()}
      >
        {t('Save history settings')}
      </button>
    </fieldset>
  );
}
