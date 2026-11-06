/**
 * "Changes during the story" under an infobox field in Edit mode. It stays folded until it is
 * wanted, and the story is only read once it is open, because a page can have many fields.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { changeIsPlaced, type FieldChange } from '../lib/facts';
import { t } from '../lib/i18n';
import { explainStoryDate, parseStoryDate } from '../lib/storyDate';
import type { InfoboxField, NodeMeta } from '../lib/types';
import { useLocale } from '../state/language';
import { useStoryIndex } from './hooks';
import type { StoryIndex } from './storyIndex';

export type RenderValueInput = (value: string, label: string, onChange: (value: string) => void) => ReactNode;

interface SceneGroup {
  label: string;
  scenes: NodeMeta[];
}

/** Scenes in reading order, grouped by chapter. */
function sceneGroups(index: StoryIndex): SceneGroup[] {
  const groups: (SceneGroup & { parent: string | null })[] = [];
  for (const scene of index.scenes) {
    const last = groups[groups.length - 1];
    if (last && last.parent === scene.parentId) {
      last.scenes.push(scene);
      continue;
    }
    const parent = scene.parentId ? index.nodes.get(scene.parentId) : undefined;
    const book = index.bookTitles.size > 1 ? index.bookTitles.get(scene.bookId) : undefined;
    const name = parent?.title || t('No chapter');
    groups.push({ parent: scene.parentId, label: book ? t('{book}: {chapter}', { book, chapter: name }) : name, scenes: [scene] });
  }
  return groups;
}

/** What is cleared is stored as absent. Unknown data stays, for a newer version's sake. */
function withoutEmpties(change: FieldChange): FieldChange {
  const kept = { ...change };
  if (!kept.nodeId) delete kept.nodeId;
  if (!kept.date) delete kept.date;
  if (!kept.note) delete kept.note;
  return kept;
}

function ChangeRow(props: {
  change: FieldChange;
  position: number;
  fieldLabel: string;
  index: StoryIndex | null;
  renderValue: RenderValueInput;
  onChange: (next: FieldChange) => void;
  onRemove: () => void;
}) {
  useLocale();
  const { change, position, fieldLabel, index, renderValue, onChange, onRemove } = props;
  const named = { number: position, field: fieldLabel };
  const dates = index?.dates;
  const firstMonth = dates?.calendar?.months[0]?.name;
  const dateText = change.date?.trim() ?? '';
  const dateProblem =
    dates && dateText && parseStoryDate(dateText, dates.eras, dates.calendar) === null
      ? explainStoryDate(dateText, dates.eras, dates.calendar)
      : null;
  const unplaced = index && !dateProblem && !changeIsPlaced(change, index.resolve);
  const sceneGone = !!change.nodeId && !!index && !index.nodes.has(change.nodeId);

  return (
    <li className="facts-change">
      <label className="facts-change-part">
        <span className="facts-change-label">{t('Scene')}</span>
        <select
          className="select"
          aria-label={t('Scene of change {number} to {field}', named)}
          value={change.nodeId ?? ''}
          disabled={!index}
          onChange={(e) => onChange({ ...change, nodeId: e.target.value || null })}
        >
          <option value="">{t('No scene')}</option>
          {sceneGone && <option value={change.nodeId ?? ''}>{t('A scene that was removed')}</option>}
          {index &&
            sceneGroups(index).map((group, i) => (
              <optgroup key={`${group.label}:${i}`} label={group.label}>
                {group.scenes.map((scene) => (
                  <option key={scene.id} value={scene.id}>
                    {scene.title || t('Untitled scene')}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      </label>
      <label className="facts-change-part">
        <span className="facts-change-label">{t('In-world date')}</span>
        <input
          className="input"
          aria-label={t('In-world date of change {number} to {field}', named)}
          aria-invalid={dateProblem ? true : undefined}
          placeholder={firstMonth ? `15 ${firstMonth} 312` : '312-04-15'}
          value={change.date ?? ''}
          onChange={(e) => onChange({ ...change, date: e.target.value })}
        />
      </label>
      <div className="facts-change-part">
        <span className="facts-change-label" aria-hidden="true">{t('Value')}</span>
        {renderValue(change.value, t('New value of change {number} to {field}', named), (value) => onChange({ ...change, value }))}
      </div>
      <label className="facts-change-part">
        <span className="facts-change-label">{t('Note')}</span>
        <input
          className="input"
          aria-label={t('Note on change {number} to {field}', named)}
          placeholder={t('Optional')}
          value={change.note ?? ''}
          onChange={(e) => onChange({ ...change, note: e.target.value })}
        />
      </label>
      {dateProblem && <p className="facts-change-hint" role="status">{dateProblem}</p>}
      {unplaced && (
        <p className="facts-change-hint" role="status">{t('Give this a scene or a date, or it will never take effect.')}</p>
      )}
      <button
        type="button"
        className="btn btn-sm facts-change-remove"
        aria-label={t('Remove change {number} to {field}', named)}
        onClick={onRemove}
      >
        {t('Remove')}
      </button>
    </li>
  );
}

function ChangesForm(props: {
  field: InfoboxField;
  renderValue: RenderValueInput;
  onChange: (changes: FieldChange[]) => void;
}) {
  useLocale();
  const { field, renderValue, onChange } = props;
  const index = useStoryIndex();
  const changes = field.changes ?? [];
  const label = field.label || t('this field');

  // A new change is ready to fill in, and removing one leaves focus nearby, not lost.
  const rootRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<'new' | 'add' | null>(null);
  useLayoutEffect(() => {
    if (!focusAfter.current) return;
    const selector = focusAfter.current === 'new' ? '.facts-change:last-child select' : '.facts-add';
    rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
    focusAfter.current = null;
  });

  return (
    <div ref={rootRef}>
      <p className="facts-intro">{t('The value above holds until the first change.')}</p>
      {changes.length > 0 && (
        <ol className="facts-changes">
          {changes.map((change, i) => (
            <ChangeRow
              key={i}
              change={change}
              position={i + 1}
              fieldLabel={label}
              index={index}
              renderValue={renderValue}
              onChange={(next) => onChange(changes.map((c, at) => (at === i ? withoutEmpties(next) : c)))}
              onRemove={() => {
                focusAfter.current = 'add';
                onChange(changes.filter((_, at) => at !== i));
              }}
            />
          ))}
        </ol>
      )}
      <button
        type="button"
        className="btn btn-sm facts-add"
        aria-label={t('Add a change to {field}', { field: label })}
        onClick={() => {
          focusAfter.current = 'new';
          onChange([...changes, { value: '' }]);
        }}
      >
        {t('Add a change')}
      </button>
    </div>
  );
}

export function FieldChangesEditor(props: {
  field: InfoboxField;
  renderValue: RenderValueInput;
  onChange: (changes: FieldChange[]) => void;
}) {
  useLocale();
  const { field, renderValue, onChange } = props;
  const count = field.changes?.length ?? 0;
  const [open, setOpen] = useState(false);
  const label = field.label || t('this field');
  return (
    <details className="facts-edit" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary
        aria-label={
          count > 0
            ? t('Changes during the story to {field}, {count} so far', { field: label, count })
            : t('Changes during the story to {field}', { field: label })
        }
      >
        {count > 0 ? t('Changes during the story ({count})', { count }) : t('Changes during the story')}
      </summary>
      {open && <ChangesForm field={field} renderValue={renderValue} onChange={onChange} />}
    </details>
  );
}
