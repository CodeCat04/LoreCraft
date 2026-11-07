/** The dialogs for "Draft from synopsis" and "First draft": what to write from, and how long. */

import { useId, useState } from 'react';

import { t } from '../../lib/i18n';
import { showDialog } from '../../shell/dialogs';
import { useLocale } from '../../state/language';
import { profileForTask } from '../client';
import { DRAFT_LENGTHS, DRAFT_WORDS, draftParts, isDraftLength, type DraftLength } from './prompts';

const LENGTH_KEY = 'lorecraft.draftLength';

/** The length last chosen on this computer, or medium. */
export function lastDraftLength(): DraftLength {
  try {
    const stored = window.localStorage.getItem(LENGTH_KEY);
    return isDraftLength(stored) ? stored : 'medium';
  } catch {
    return 'medium';
  }
}

export function rememberDraftLength(length: DraftLength): void {
  try {
    window.localStorage.setItem(LENGTH_KEY, length);
  } catch {
    // Not remembered, which only means medium next time.
  }
}

export function lengthLabel(length: DraftLength): string {
  switch (length) {
    case 'short': return t('Short');
    case 'medium': return t('Medium');
    case 'long': return t('Long');
  }
}

export function lengthHint(length: DraftLength): string {
  return t('About {count} words', { count: DRAFT_WORDS[length].toLocaleString() });
}

export function LengthChoice({ value, onChange }: { value: DraftLength; onChange: (length: DraftLength) => void }) {
  useLocale();
  const name = useId();
  const parts = draftParts(value, profileForTask('rewrite').isCloud);
  return (
    <fieldset className="draft-lengths">
      <legend className="field-label">{t('Length')}</legend>
      {DRAFT_LENGTHS.map((length) => (
        <label key={length} className="checkbox" title={lengthHint(length)}>
          <input type="radio" name={name} value={length} checked={value === length} onChange={() => onChange(length)} />
          <span>{lengthLabel(length)}</span>
          <span className="faint">{` (${lengthHint(length)})`}</span>
        </label>
      ))}
      {parts > 1 && (
        <span className="field-hint">{t('The local model writes this in {count} parts, one after another.', { count: parts })}</span>
      )}
    </fieldset>
  );
}

export interface DraftChoice {
  plan: string;
  length: DraftLength;
}

function DraftForm(props: { mode: 'synopsis' | 'premise'; synopsis?: string; close: (choice: DraftChoice | null) => void }) {
  useLocale();
  const { mode, close } = props;
  const [plan, setPlan] = useState(props.synopsis ?? '');
  const [length, setLength] = useState<DraftLength>(lastDraftLength);
  const ready = plan.trim().length > 0;
  const submit = () => {
    if (!ready) return;
    rememberDraftLength(length);
    close({ plan: plan.trim(), length });
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 id="dialog-title" className="dialog-title">{mode === 'synopsis' ? t('Draft from synopsis') : t('First draft')}</h2>
      {mode === 'synopsis' ? (
        <div className="field">
          <span className="field-label">{t('Synopsis')}</span>
          <div className="draft-plan" data-testid="draft-synopsis">{plan}</div>
          <span className="field-hint">{t('The draft follows the synopsis, cast, location and the scenes around it.')}</span>
        </div>
      ) : (
        <label className="field">
          <span className="field-label">{t('What should happen?')}</span>
          <textarea
            className="textarea"
            rows={5}
            autoFocus
            value={plan}
            placeholder={t('A premise or a few lines. For example: Mara finds the letter and decides to leave that night.')}
            onChange={(e) => setPlan(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </label>
      )}
      <LengthChoice value={length} onChange={setLength} />
      <p className="field-hint">{t('The draft arrives as suggested changes, for you to accept or reject.')}</p>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => close(null)}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={!ready} autoFocus={mode === 'synopsis'}>
          {t('Write the draft')}
        </button>
      </div>
    </form>
  );
}

/** Asks what to draft from, and how long. Null if the writer cancels. */
export function askForDraft(mode: 'synopsis' | 'premise', synopsis?: string): Promise<DraftChoice | null> {
  return showDialog<DraftChoice | null>((close) => <DraftForm mode={mode} synopsis={synopsis} close={close} />, null);
}
