/** Reviewing suggestions for fields, which are not part of a document's text. */

import { useMemo, useState } from 'react';
import { diffWords } from 'diff';

import { showDialog } from '../shell/dialogs';
import { t } from '../lib/i18n';
import type { InfoboxField } from '../lib/types';
import { useLocale } from '../state/language';

function WordDiff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffWords(before, after), [before, after]);
  return (
    <div className="ai-review-diff" data-testid="ai-review-diff">
      {parts.map((part, index) =>
        part.added ? <ins key={index}>{part.value}</ins> : part.removed ? <del key={index}>{part.value}</del> : <span key={index}>{part.value}</span>,
      )}
    </div>
  );
}

/** Shows a suggested value against the old one. Returns what to save, or null for neither. */
export function reviewField(options: { title: string; before: string; after: string }): Promise<string | null> {
  return showDialog<string | null>(
    (close) => <FieldReview {...options} onDone={close} />,
    null,
  );
}

function FieldReview({ title, before, after, onDone }: { title: string; before: string; after: string; onDone: (value: string | null) => void }) {
  useLocale();
  const [text, setText] = useState(after);
  return (
    <div data-testid="ai-review">
      <h2 className="dialog-title">{title}</h2>
      <WordDiff before={before} after={text} />
      <label className="field">
        <span className="field-label">{t('Suggested text, which you can change')}</span>
        <textarea className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => onDone(null)}>{t('Reject')}</button>
        <button type="button" className="btn btn-primary" autoFocus onClick={() => onDone(text.trim())}>{t('Accept')}</button>
      </div>
    </div>
  );
}

/** Offers suggested infobox fields. Returns the ones chosen, or null. */
export function reviewInfobox(options: { pageTitle: string; existing: InfoboxField[]; suggested: InfoboxField[] }): Promise<InfoboxField[] | null> {
  return showDialog<InfoboxField[] | null>(
    (close) => <InfoboxReview {...options} onDone={close} />,
    null,
  );
}

function InfoboxReview({ pageTitle, existing, suggested, onDone }: {
  pageTitle: string;
  existing: InfoboxField[];
  suggested: InfoboxField[];
  onDone: (value: InfoboxField[] | null) => void;
}) {
  useLocale();
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(suggested.map((f) => f.key)));
  const toggle = (key: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div data-testid="ai-review">
      <h2 className="dialog-title">{t('Suggested infobox fields for {title}', { title: pageTitle })}</h2>
      <p className="dialog-message">{t('Choose which to add. Nothing is saved unless you accept.')}</p>
      <div className="ai-review-fields">
        {suggested.map((field) => {
          const old = existing.find((f) => f.key === field.key);
          return (
            <label key={field.key} className="checkbox">
              <input type="checkbox" checked={chosen.has(field.key)} onChange={() => toggle(field.key)} />
              <span>
                <strong>{field.label}:</strong> {field.value || <span className="faint small">{t('empty, for you to fill in')}</span>}
                {old && <span className="faint small"> {t('(replaces “{value}”)', { value: old.value })}</span>}
              </span>
            </label>
          );
        })}
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => onDone(null)}>{t('Reject')}</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={chosen.size === 0}
          onClick={() => onDone(suggested.filter((f) => chosen.has(f.key)))}
        >
          {chosen.size === 1 ? t('Add 1 field') : t('Add {count} fields', { count: chosen.size })}
        </button>
      </div>
    </div>
  );
}
