/** Create, change and delete the writer's own page types, and copy the built-in ones. */

import { useState } from 'react';

import { FIELD_KINDS, keyFromLabel, moved } from './infobox';
import { extractHeadings } from './outline';
import { deletePageType, savePageType, usePageTypes } from './pageTypes';
import { SEMANTIC_FIELDS, fieldLabel, isBuiltInType, pluralOf, templateLabel, type PageTemplate } from './templates';
import { confirm, showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import type { Infobox, InfoboxFieldKind, PmNode } from '../lib/types';

/** A type being edited. `type` is empty until it has been saved once. */
export type TypeDraft = Omit<PageTemplate, 'type'> & { type: string };

const CUSTOM_FIELD = '__custom';

/** A page's infobox fields and top-level headings, ready to become a type. */
export function typeDraftFromPage(title: string, infobox: Infobox, doc: PmNode): TypeDraft {
  return {
    type: '',
    label: '',
    plural: '',
    description: t('Based on the layout of {title}.', { title }),
    fields: infobox.fields.map(({ key, label, kind }) => ({ key, label, kind, value: '' })),
    sections: extractHeadings(doc).filter((h) => h.level === 1).map((h) => h.text).filter(Boolean),
  };
}

function TypeEditor(props: { draft: TypeDraft; onDone: () => void }) {
  useLocale();
  const [draft, setDraft] = useState(props.draft);
  const [busy, setBusy] = useState(false);
  const change = (patch: Partial<TypeDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const allTypes = usePageTypes((s) => s.types);

  const setField = (index: number, patch: Partial<TypeDraft['fields'][number]>) =>
    change({ fields: draft.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)) });

  const addField = (choice: string) => {
    const taken = draft.fields.map((f) => f.key);
    const field =
      choice === CUSTOM_FIELD
        ? { key: keyFromLabel('New field', taken), label: t('New field'), kind: 'text' as InfoboxFieldKind, value: '' }
        : { key: choice, ...SEMANTIC_FIELDS[choice], label: fieldLabel(SEMANTIC_FIELDS[choice].label), value: '' };
    change({ fields: [...draft.fields, field] });
  };

  const save = async () => {
    const label = draft.label.trim();
    if (!label) return;
    setBusy(true);
    try {
      const type =
        draft.type ||
        keyFromLabel(label, allTypes.map((template) => template.type).concat('home'));
      // Keys must be unique, because other features look fields up by them.
      const seen: string[] = [];
      const fields = draft.fields.map((field) => {
        const key = !field.key.trim() || seen.includes(field.key.trim())
          ? keyFromLabel(field.label || 'field', seen)
          : field.key.trim();
        seen.push(key);
        return { ...field, key, value: '' };
      });
      await savePageType({
        type,
        label,
        plural: draft.plural.trim() || pluralOf(label),
        description: draft.description?.trim() ?? '',
        fields,
        sections: draft.sections.map((s) => s.trim()).filter(Boolean),
      });
      toast(t('Saved the type “{name}”.', { name: label }), 'success');
      props.onDone();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const unused = Object.entries(SEMANTIC_FIELDS).filter(([key]) => !draft.fields.some((f) => f.key === key));

  return (
    <form
      className="wiki-types-editor"
      aria-label={t('Page type')}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 id="dialog-title" className="dialog-title">{draft.type ? t('Change {name}', { name: draft.label }) : t('New page type')}</h2>
      <div className="wiki-form-row">
        <label className="field">
          <span className="field-label">{t('Name')}</span>
          <input className="input" autoFocus value={draft.label} onChange={(e) => change({ label: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">{t('Plural, for lists')}</span>
          <input
            className="input"
            value={draft.plural}
            placeholder={pluralOf(draft.label)}
            onChange={(e) => change({ plural: e.target.value })}
          />
        </label>
      </div>
      <label className="field">
        <span className="field-label">{t('Description')}</span>
        <input className="input" value={draft.description ?? ''} onChange={(e) => change({ description: e.target.value })} />
      </label>

      <h3 className="wiki-types-heading">{t('Infobox fields')}</h3>
      <p className="field-hint">{t('Changing a type leaves existing pages as they are.')}</p>
      <ul className="wiki-types-rows">
        {draft.fields.map((field, index) => (
          <li key={index} className="wiki-types-field" data-key={field.key}>
            <input
              className="input"
              aria-label={t('Label of field {number}', { number: index + 1 })}
              value={field.label}
              onChange={(e) => {
                const label = e.target.value;
                // A field the writer named follows its name. A semantic key keeps its meaning.
                const others = draft.fields.filter((_, i) => i !== index).map((f) => f.key);
                setField(index, field.key in SEMANTIC_FIELDS ? { label } : { label, key: keyFromLabel(label, others) });
              }}
            />
            <input
              className="input wiki-types-key"
              aria-label={t('Key of field {number}', { number: index + 1 })}
              value={field.key}
              onChange={(e) => setField(index, { key: e.target.value })}
            />
            <select
              className="select"
              aria-label={t('Kind of field {number}', { number: index + 1 })}
              value={field.kind}
              onChange={(e) => setField(index, { kind: e.target.value as InfoboxFieldKind })}
            >
              {FIELD_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>{k.label}</option>
              ))}
            </select>
            <span className="wiki-ibe-buttons">
              <button type="button" className="icon-btn" aria-label={t('Move field {number} up', { number: index + 1 })} disabled={index === 0} onClick={() => change({ fields: moved(draft.fields, index, -1) })}>↑</button>
              <button type="button" className="icon-btn" aria-label={t('Move field {number} down', { number: index + 1 })} disabled={index === draft.fields.length - 1} onClick={() => change({ fields: moved(draft.fields, index, 1) })}>↓</button>
              <button type="button" className="icon-btn" aria-label={t('Remove field {number}', { number: index + 1 })} onClick={() => change({ fields: draft.fields.filter((_, i) => i !== index) })}>×</button>
            </span>
          </li>
        ))}
      </ul>
      <select
        className="select"
        aria-label={t('Add a field')}
        value=""
        onChange={(e) => {
          if (e.target.value) addField(e.target.value);
        }}
      >
        <option value="">{t('Add a field…')}</option>
        <option value={CUSTOM_FIELD}>{t('A field of your own')}</option>
        {unused.map(([key, f]) => (
          <option key={key} value={key}>{fieldLabel(f.label)}</option>
        ))}
      </select>

      <h3 className="wiki-types-heading">{t('Starter sections')}</h3>
      <ul className="wiki-types-rows">
        {draft.sections.map((section, index) => (
          <li key={index} className="wiki-types-section">
            <input
              className="input"
              aria-label={t('Section {number}', { number: index + 1 })}
              value={section}
              onChange={(e) => change({ sections: draft.sections.map((s, i) => (i === index ? e.target.value : s)) })}
            />
            <span className="wiki-ibe-buttons">
              <button type="button" className="icon-btn" aria-label={t('Move section {number} up', { number: index + 1 })} disabled={index === 0} onClick={() => change({ sections: moved(draft.sections, index, -1) })}>↑</button>
              <button type="button" className="icon-btn" aria-label={t('Move section {number} down', { number: index + 1 })} disabled={index === draft.sections.length - 1} onClick={() => change({ sections: moved(draft.sections, index, 1) })}>↓</button>
              <button type="button" className="icon-btn" aria-label={t('Remove section {number}', { number: index + 1 })} onClick={() => change({ sections: draft.sections.filter((_, i) => i !== index) })}>×</button>
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-sm" onClick={() => change({ sections: [...draft.sections, ''] })}>{t('Add a section')}</button>

      <div className="dialog-actions">
        <button type="button" className="btn" onClick={props.onDone}>{t('Back')}</button>
        <button type="submit" className="btn btn-primary" disabled={!draft.label.trim() || busy}>{t('Save type')}</button>
      </div>
    </form>
  );
}

function TypeList(props: { onEdit: (draft: TypeDraft) => void; close: () => void }) {
  useLocale();
  const { types, custom } = usePageTypes();
  const builtIn = types.filter((template) => isBuiltInType(template.type));
  const copy = (type: PageTemplate) => {
    const builtInType = isBuiltInType(type.type);
    const name = builtInType ? (type.type === 'article' ? t('Article') : templateLabel(type)) : type.label;
    props.onEdit({
      ...type,
      type: '',
      label: t('{name} copy', { name }),
      plural: '',
      // A built-in type's labels start in the interface language, as a new page's would.
      fields: type.fields.map((f) => ({ ...f, label: builtInType ? fieldLabel(f.label) : f.label })),
      sections: [...type.sections],
    });
  };
  const remove = async (type: PageTemplate) => {
    const yes = await confirm({
      title: t('Delete the type “{name}”?', { name: type.label }),
      message: t('Pages of this type stay exactly as they are and keep showing it. It just stops being offered for new pages.'),
      confirmLabel: t('Delete type'),
      danger: true,
    });
    if (yes) await deletePageType(type.type);
  };
  return (
    <div className="wiki-types-list">
      <h2 id="dialog-title" className="dialog-title">{t('Page types')}</h2>
      <p className="dialog-message">
        {t('A type gives a new page its infobox fields and starter sections. Your types are saved in this project.')}
      </p>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => props.onEdit({ type: '', label: '', plural: '', description: '', fields: [], sections: [] })}
      >
        {t('New type')}
      </button>
      <h3 className="wiki-types-heading">{t('Your types')}</h3>
      {custom.length === 0 && <p className="muted small">{t('None yet. Start a new one, or copy a built-in type below.')}</p>}
      <ul className="wiki-types-rows">
        {custom.map((type) => (
          <li key={type.type} className="wiki-types-row">
            <span className="wiki-types-name">
              <b>{type.label}</b>
              {type.description && <span className="faint"> {type.description}</span>}
            </span>
            <button type="button" className="btn btn-sm" aria-label={t('Change {name}', { name: type.label })} onClick={() => props.onEdit(type)}>{t('Change')}</button>
            <button type="button" className="btn btn-sm" aria-label={t('Copy {name}', { name: type.label })} onClick={() => copy(type)}>{t('Copy')}</button>
            <button type="button" className="btn btn-sm btn-danger" aria-label={t('Delete {name}', { name: type.label })} onClick={() => void remove(type)}>{t('Delete')}</button>
          </li>
        ))}
      </ul>
      <h3 className="wiki-types-heading">{t('Built in')}</h3>
      <ul className="wiki-types-rows">
        {builtIn.map((type) => (
          <li key={type.type} className="wiki-types-row">
            <span className="wiki-types-name">{templateLabel(type)}</span>
            <button type="button" className="btn btn-sm" aria-label={t('Copy {name}', { name: templateLabel(type) })} onClick={() => copy(type)}>{t('Copy')}</button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={props.close}>{t('Done')}</button>
      </div>
    </div>
  );
}

function PageTypesBody(props: { initial?: TypeDraft; close: () => void }) {
  const [editing, setEditing] = useState<TypeDraft | null>(props.initial ?? null);
  return (
    <div className="wiki-types">
      {editing ? (
        <TypeEditor draft={editing} onDone={() => setEditing(null)} />
      ) : (
        <TypeList onEdit={setEditing} close={props.close} />
      )}
    </div>
  );
}

/** Opens the list of types, or goes straight to editing a draft. */
export function openPageTypes(initial?: TypeDraft) {
  return showDialog<null>((close) => <PageTypesBody initial={initial} close={() => close(null)} />, null);
}
