/**
 * The infobox in Edit mode. It normally looks like the finished table, with Tab going
 * straight from value to value, because filling it in is the common job. "Arrange
 * fields" swaps in the controls for naming, moving and removing them.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { TitleInput, TitlesInput } from './fields';
import { FIELD_KINDS, keyFromLabel, moved, normalizeInfobox } from './infobox';
import { useAssetUrl } from './InfoboxView';
import { SEMANTIC_FIELDS, fieldLabel, templateFor } from './templates';
import { flushAllEditors } from '../editor/saving';
import { FieldChangesEditor } from '../facts';
import * as api from '../lib/api';
import { addAsset } from '../lib/assets';
import { t } from '../lib/i18n';
import { errorMessage, rpc } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import type { Infobox, InfoboxField, InfoboxFieldKind } from '../lib/types';

const IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp,image/avif';
const CUSTOM_FIELD = '__custom';

/**
 * Saving one of these keeps relationships and the other page's field in step. That waits
 * until the writer leaves the field, so a pause in the middle of a name links nobody.
 */
const FAMILY_KEYS = new Set(['parents', 'spouse', 'children']);

/** What goes to the page's saver: the infobox, and which family field is still being typed in. */
type SentInfobox = Infobox & { familyTyping?: string[] };

/**
 * Puts a picture on a page whose editor has gone, as when the page reloaded while it uploaded.
 * It goes on the stored infobox as it is now, after anything still waiting to be saved, and
 * the open editor reloads to show it.
 */
async function attachImage(pageId: string, imageAssetId: string): Promise<void> {
  await flushAllEditors();
  const page = await api.pages.get(pageId);
  await api.pages.update(pageId, { infobox: { ...normalizeInfobox(page.infobox), imageAssetId } });
}

/** Rows carry an id of their own, so typing in a field never remounts its input. */
interface Row extends InfoboxField {
  uid: number;
}

let nextUid = 1;

function toRow(field: InfoboxField): Row {
  nextUid += 1;
  return { ...field, uid: nextUid };
}

function FieldValueInput(props: { row: Pick<InfoboxField, 'kind' | 'label' | 'value'>; onChange: (value: string) => void }) {
  const { row, onChange } = props;
  useLocale();
  const label = row.label || t('Field value');
  switch (row.kind) {
    case 'page':
      return <TitleInput value={row.value} onChange={onChange} label={label} />;
    case 'pages':
      return <TitlesInput value={row.value} onChange={onChange} label={label} />;
    case 'longtext':
      return (
        <textarea
          className="textarea"
          rows={3}
          aria-label={label}
          value={row.value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <input
          className="input"
          inputMode="decimal"
          aria-label={label}
          aria-invalid={row.value.trim() !== '' && Number.isNaN(Number(row.value))}
          value={row.value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
      return (
        <input
          className="input"
          aria-label={label}
          placeholder={t('Such as Year 312')}
          value={row.value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return (
        <input
          className="input"
          aria-label={label}
          value={row.value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

export function InfoboxEditor(props: {
  value: Infobox;
  pageType: string;
  onChange: (next: Infobox) => void;
}) {
  const { value, pageType, onChange } = props;
  useLocale();
  const [rows, setRows] = useState<Row[]>(() => value.fields.map(toRow));
  const [arranging, setArranging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const image = useAssetUrl(value.imageAssetId);

  // Something that finishes later, such as an upload, must build on the infobox as it is then,
  // not as it was when it started, or it would undo what changed in between.
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const mounted = useRef(true);
  // Only a page's own route edits it, so this is the page shown here.
  const route = useNav((s) => s.route);
  const pageId = useRef<string | null>(null);
  if (route.view === 'page') pageId.current = route.id;

  /** The family field the writer is typing in, whose sync waits until they leave it. */
  const typing = useRef<string | null>(null);

  const send = (next: Infobox) => {
    const { familyTyping: _earlier, ...infobox } = next as SentInfobox;
    const sent: SentInfobox = typing.current ? { ...infobox, familyTyping: [typing.current] } : infobox;
    latest.current.onChange(sent);
  };

  /** The writer is done with a family field, so what it says now reaches the other pages. */
  const settle = () => {
    const id = pageId.current;
    if (!typing.current || !id) return;
    typing.current = null;
    // What was typed is saved first, and so is anything waiting in other open pages, so the
    // sync reads the last word and nothing about to be saved can land on top of what it writes.
    void flushAllEditors()
      .then(() => rpc('pages.settleFamily', { id }))
      .catch(() => {
        // The project closed, and with it everything there was to keep in step.
      });
  };
  const settleOnLeave = useRef(settle);
  settleOnLeave.current = settle;
  useEffect(() => {
    mounted.current = true;
    // Leaving Edit with a shortcut, or the page reloading, takes the field away without a blur.
    return () => {
      mounted.current = false;
      settleOnLeave.current();
    };
  }, []);

  // A type change adds its template's fields from outside this component.
  const lastSent = useRef(value.fields);
  if (value.fields !== lastSent.current) {
    lastSent.current = value.fields;
    const known = new Map(rows.map((r) => [r.key, r]));
    setRows(
      value.fields.map((field) => {
        const row = known.get(field.key);
        return row ? { ...field, uid: row.uid } : toRow(field);
      }),
    );
  }

  // Moving a row re-attaches its DOM node, which drops focus, so it is put back.
  const focusAfter = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!focusAfter.current) return;
    const element = rootRef.current?.querySelector<HTMLElement>(focusAfter.current);
    element?.focus();
    // Naming a new field means typing over "New field".
    if (element instanceof HTMLInputElement) element.select();
    focusAfter.current = null;
  });

  const commitRows = (next: Row[]) => {
    setRows(next);
    const fields = next.map(({ uid: _uid, ...field }) => field);
    lastSent.current = fields;
    send({ ...value, fields });
  };

  const changeRow = (uid: number, patch: Partial<InfoboxField>) => {
    commitRows(rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  };

  const typeValue = (row: Row, text: string) => {
    if (FAMILY_KEYS.has(row.key)) typing.current = row.key;
    changeRow(row.uid, { value: text });
  };

  const changeLabel = (row: Row, label: string) => {
    // A field the writer named follows its name. A semantic key keeps its meaning.
    if (row.key in SEMANTIC_FIELDS) {
      changeRow(row.uid, { label });
      return;
    }
    const others = rows.filter((r) => r.uid !== row.uid).map((r) => r.key);
    changeRow(row.uid, { label, key: keyFromLabel(label, others) });
  };

  const addField = (choice: string) => {
    const taken = rows.map((r) => r.key);
    const base =
      choice === CUSTOM_FIELD
        ? { key: keyFromLabel('New field', taken), label: t('New field'), kind: 'text' as InfoboxFieldKind }
        : { key: choice, ...SEMANTIC_FIELDS[choice], label: fieldLabel(SEMANTIC_FIELDS[choice].label) };
    const row = toRow({ ...base, value: '' });
    if (choice === CUSTOM_FIELD) {
      setArranging(true);
      focusAfter.current = `[data-row="${row.uid}"] .wiki-ibe-label`;
    } else {
      focusAfter.current = arranging ? `[data-row="${row.uid}"] .wiki-ibe-label` : `[data-row="${row.uid}"] input, [data-row="${row.uid}"] textarea`;
    }
    commitRows([...rows, row]);
  };

  const uploadImage = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    const id = pageId.current;
    try {
      const imageAssetId = await addAsset(file);
      // Only the image changes, on the infobox as it is now. Fields typed and family names
      // filled in from other pages during the upload stay.
      if (mounted.current) send({ ...latest.current.value, imageAssetId });
      else if (id) await attachImage(id, imageAssetId);
    } catch (e) {
      toast(t('Could not add that image: {reason}', { reason: errorMessage(e) }), 'error');
    } finally {
      if (mounted.current) setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeImage = () => {
    const { imageAssetId: _image, caption: _caption, ...rest } = value;
    send(rest);
  };

  const have = new Set(rows.map((r) => r.key));
  const suggested = templateFor(pageType).fields.filter((f) => !have.has(f.key));
  const otherKnown = Object.entries(SEMANTIC_FIELDS).filter(
    ([key]) => !have.has(key) && !suggested.some((f) => f.key === key),
  );

  return (
    <aside className="wiki-infobox wiki-infobox-edit" aria-label={t('Infobox editor')} ref={rootRef}>
      <div className="wiki-infobox-title">{t('Infobox')}</div>

      <div className="wiki-ibe-image">
        {value.imageAssetId && image && <img src={image} alt={value.caption || t('Infobox')} />}
        <div className="wiki-ibe-image-actions">
          <button type="button" className="btn btn-sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? t('Adding…') : value.imageAssetId ? t('Change image') : t('Add image')}
          </button>
          {value.imageAssetId && (
            <button type="button" className="btn btn-sm" onClick={removeImage}>{t('Remove image')}</button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_TYPES}
            hidden
            aria-label={t('Infobox image file')}
            onChange={(e) => void uploadImage(e.target.files?.[0])}
          />
        </div>
        {value.imageAssetId && (
          <input
            className="input"
            aria-label={t('Image caption')}
            placeholder={t('Caption')}
            value={value.caption ?? ''}
            onChange={(e) => send({ ...value, caption: e.target.value })}
          />
        )}
      </div>

      {rows.length > 0 && (
        <ul className="wiki-ibe-rows">
          {rows.map((row, index) => {
            const name = row.label || t('this field');
            if (!arranging) {
              return (
                <li
                  key={row.uid}
                  className="wiki-ibe-row"
                  data-row={row.uid}
                  data-key={row.key}
                  onBlur={() => {
                    if (typing.current === row.key) settle();
                  }}
                >
                  <span className="wiki-ibe-name">{row.label}</span>
                  <FieldValueInput row={row} onChange={(v) => typeValue(row, v)} />
                  <FieldChangesEditor
                    field={row}
                    onChange={(changes) => changeRow(row.uid, { changes: changes.length > 0 ? changes : undefined })}
                    renderValue={(v, label, set) => (
                      <FieldValueInput row={{ kind: row.kind, label, value: v }} onChange={set} />
                    )}
                  />
                </li>
              );
            }
            return (
              <li key={row.uid} className="wiki-ibe-row is-arranging" data-row={row.uid} data-key={row.key}>
                <input
                  className="input wiki-ibe-label"
                  aria-label={t('Name of field {number}', { number: index + 1 })}
                  value={row.label}
                  onChange={(e) => changeLabel(row, e.target.value)}
                />
                <select
                  className="select wiki-ibe-kind"
                  aria-label={t('Kind of {name}', { name })}
                  value={row.kind}
                  onChange={(e) => changeRow(row.uid, { kind: e.target.value as InfoboxFieldKind })}
                >
                  {FIELD_KINDS.map((k) => (
                    <option key={k.kind} value={k.kind}>{k.label}</option>
                  ))}
                </select>
                <span className="wiki-ibe-buttons">
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t('Move {name} up', { name })}
                    title={t('Move up')}
                    disabled={index === 0}
                    data-action="up"
                    onClick={() => {
                      focusAfter.current =
                        index > 1 ? `[data-row="${row.uid}"] [data-action="up"]` : `[data-row="${row.uid}"] [data-action="down"]`;
                      commitRows(moved(rows, index, -1));
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t('Move {name} down', { name })}
                    title={t('Move down')}
                    disabled={index === rows.length - 1}
                    data-action="down"
                    onClick={() => {
                      focusAfter.current =
                        index < rows.length - 2 ? `[data-row="${row.uid}"] [data-action="down"]` : `[data-row="${row.uid}"] [data-action="up"]`;
                      commitRows(moved(rows, index, 1));
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t('Remove {name}', { name })}
                    title={t('Remove')}
                    onClick={() => {
                      const neighbor = rows[index + 1] ?? rows[index - 1];
                      focusAfter.current = neighbor ? `[data-row="${neighbor.uid}"] .wiki-ibe-label` : '.wiki-ibe-add';
                      commitRows(rows.filter((r) => r.uid !== row.uid));
                    }}
                  >
                    ×
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="wiki-ibe-footer">
        <select
          className="select wiki-ibe-add"
          aria-label={t('Add a field')}
          value=""
          onChange={(e) => {
            if (e.target.value) addField(e.target.value);
          }}
        >
          <option value="">{t('Add a field…')}</option>
          {suggested.length > 0 && (
            <optgroup label={t('For this type of page')}>
              {suggested.map((f) => (
                <option key={f.key} value={f.key}>{fieldLabel(f.label)}</option>
              ))}
            </optgroup>
          )}
          {otherKnown.length > 0 && (
            <optgroup label={t('Other known fields')}>
              {otherKnown.map(([key, f]) => (
                <option key={key} value={key}>{fieldLabel(f.label)}</option>
              ))}
            </optgroup>
          )}
          <option value={CUSTOM_FIELD}>{t('A field of your own')}</option>
        </select>
        {rows.length > 0 && (
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={arranging}
            onClick={() => setArranging(!arranging)}
          >
            {arranging ? t('Done arranging') : t('Arrange fields')}
          </button>
        )}
      </div>
    </aside>
  );
}
