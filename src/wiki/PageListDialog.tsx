/** Choosing what a list block shows, such as "all characters in the category Nobility". */

import { useState } from 'react';

import { STATUSES } from './actions';
import { usePageTypes } from './pageTypes';
import { typeLabel } from './templates';
import type { PageListQuery } from '../editor/convert';
import { showDialog } from '../shell/dialogs';
import { useLoad } from '../state/events';
import { useLocale } from '../state/language';
import * as api from '../lib/api';
import { t } from '../lib/i18n';

// Each label is read when shown, so it follows the interface language.
const SORTS = [
  { value: 'title', get label() { return t('Title'); } },
  { value: 'updated', get label() { return t('Recently edited'); } },
  { value: 'created', get label() { return t('Recently created'); } },
  { value: 'words', get label() { return t('Most words'); } },
];

function PageListForm(props: { current: PageListQuery | null; close: (query: PageListQuery | null) => void }) {
  useLocale();
  const types = usePageTypes((s) => s.types);
  const { data: categories } = useLoad(() => api.pages.categories(), []);
  const [query, setQuery] = useState<PageListQuery>(
    props.current ?? { pageType: '', category: '', status: '', sort: 'title', field: '', fieldValue: '' },
  );
  const change = (patch: Partial<PageListQuery>) => setQuery((q) => ({ ...q, ...patch }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.close(query);
      }}
    >
      <h2 id="dialog-title" className="dialog-title">{props.current ? t('Change this list') : t('Insert a list of pages')}</h2>
      <p className="dialog-message">{t('The list fills itself in, and stays up to date as pages change.')}</p>
      <div className="wiki-form-row">
        <label className="field">
          <span className="field-label">{t('Type')}</span>
          <select className="select" aria-label={t('Type')} autoFocus value={query.pageType} onChange={(e) => change({ pageType: e.target.value })}>
            <option value="">{t('Any type')}</option>
            {types.map((template) => (
              <option key={template.type} value={template.type}>{typeLabel(template.type)}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('Category')}</span>
          <select className="select" aria-label={t('Category')} value={query.category} onChange={(e) => change({ category: e.target.value })}>
            <option value="">{t('Any category')}</option>
            {(categories ?? []).map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
            {query.category && !(categories ?? []).some((c) => c.name === query.category) && (
              <option value={query.category}>{query.category}</option>
            )}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('Status')}</span>
          <select className="select" aria-label={t('Status')} value={query.status} onChange={(e) => change({ status: e.target.value })}>
            <option value="">{t('Any status')}</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('Sort by')}</span>
          <select className="select" aria-label={t('Sort by')} value={query.sort} onChange={(e) => change({ sort: e.target.value })}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="dialog-message">{t('To list only pages whose infobox holds a value, such as characters whose Home is a certain town, name the field and the value. The value is the one at the start of the story.')}</p>
      <div className="wiki-form-row">
        <label className="field">
          <span className="field-label">{t('Infobox field')}</span>
          <input className="input" aria-label={t('Infobox field')} value={query.field ?? ''} placeholder={t('Any field')} onChange={(e) => change({ field: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">{t('Field value')}</span>
          <input className="input" aria-label={t('Field value')} value={query.fieldValue ?? ''} onChange={(e) => change({ fieldValue: e.target.value })} />
        </label>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => props.close(null)}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary">{props.current ? t('Save') : t('Insert')}</button>
      </div>
    </form>
  );
}

export function askForPageListQuery(current: PageListQuery | null): Promise<PageListQuery | null> {
  return showDialog<PageListQuery | null>((close) => <PageListForm current={current} close={close} />, null);
}
