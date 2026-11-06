/**
 * What the infobox shows of facts that change: a short history beside each value, and a
 * control that shows the infobox as of a chapter. That is only a way of looking. Nothing here
 * writes anything.
 */

import { useMemo, useState, type ReactNode } from 'react';

import { ageFactFromFields, changeInEffect, fieldValueAt, formatAge, type MomentResolver, type StoryMoment } from '../lib/facts';
import { t } from '../lib/i18n';
import type { DateContext } from '../lib/storyDate';
import type { Infobox, InfoboxField } from '../lib/types';
import { useLocale } from '../state/language';
import { historySteps, whenOf, type StoryNames } from './history';
import { useStoryIndex, useStoryNames } from './hooks';
import { chapterEndMoment, nodeLabel, type StoryIndex } from './storyIndex';

type RenderValue = (value: string) => ReactNode;

function FieldHistory(props: { field: InfoboxField; names: StoryNames; renderValue: RenderValue }) {
  const { field, names, renderValue } = props;
  const started = field.value.trim() !== '';
  return (
    <span className="facts-history" data-facts-history>
      {historySteps(field, names).map(({ change, from }, i) => (
        <span key={i}>
          {started || i > 0 ? ', then ' : ''}
          {change.value.trim() ? renderValue(change.value) : 'none'}
          {from ? ` ${from}` : <span className="facts-note"> (not yet placed in the story)</span>}
          {change.note?.trim() && <span className="facts-note"> ({change.note.trim()})</span>}
        </span>
      ))}
    </span>
  );
}

function AsOfControl(props: { index: StoryIndex; value: string; onChange: (nodeId: string) => void }) {
  useLocale();
  const { index, value, onChange } = props;
  const severalBooks = index.bookTitles.size > 1;
  return (
    <label className="facts-asof">
      <span className="facts-asof-label">{t('As of')}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('Whole story')}</option>
        {index.chapters.map((chapter) => (
          <option key={chapter.id} value={chapter.id}>
            {severalBooks ? `${index.bookTitles.get(chapter.bookId)}: ` : ''}
            {chapter.title || 'Untitled chapter'}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The fields as they stood at a moment, with the age worked out. */
export function fieldsAsOf(
  fields: InfoboxField[],
  moment: StoryMoment,
  resolve: MomentResolver,
  dates: DateContext,
): InfoboxField[] {
  const fact = ageFactFromFields(fields, moment, resolve, dates);
  const shown = fields.flatMap(({ changes, ...field }): InfoboxField[] => {
    // A typed age cannot keep up with the story, and a death still to come has not happened.
    if (field.key === 'age' && fact.state !== 'unknown') return [];
    if (field.key === 'died' && (fact.state === 'alive' || fact.state === 'unborn')) return [];
    return [{ ...field, value: fieldValueAt({ ...field, changes }, moment, resolve) }];
  });
  const age = fact.state === 'alive' ? formatAge(fact.years) : fact.state === 'unborn' ? 'not born yet' : null;
  if (!age) return shown;
  const label = fields.find((f) => f.key === 'age')?.label || 'Age';
  const after = shown.findIndex((f) => f.key === 'born') + 1;
  return [...shown.slice(0, after), { key: 'age', label, kind: 'text', value: age }, ...shown.slice(after)];
}

export interface InfoboxFactsView {
  /** The infobox as it should be drawn, as of the chosen chapter if there is one. */
  shown: Infobox;
  /** The "as of" control, or null if nothing on this page depends on the story. */
  control: ReactNode;
  /** What to show after a field's value. */
  history: (key: string, renderValue: RenderValue) => ReactNode;
}

export function useInfoboxFacts(infobox: Infobox): InfoboxFactsView {
  const changing = infobox.fields.some(
    (f) => (f.changes?.length ?? 0) > 0 || ((f.key === 'born' || f.key === 'died') && f.value.trim() !== ''),
  );
  const index = useStoryIndex(changing);
  const names = useStoryNames(index);
  const [asOfId, setAsOfId] = useState('');
  const chapterId = index?.nodes.has(asOfId) ? asOfId : '';

  const moment = useMemo(() => (index && chapterId ? chapterEndMoment(index, chapterId) : null), [index, chapterId]);

  const shown = useMemo(() => {
    if (!index || !moment) return infobox;
    return { ...infobox, fields: fieldsAsOf(infobox.fields, moment, index.resolve, index.dates) };
  }, [infobox, index, moment]);

  const control =
    changing && index && index.chapters.length > 0 ? (
      <>
        <AsOfControl index={index} value={chapterId} onChange={setAsOfId} />
        {chapterId && (
          <p className="facts-asof-note" role="status">
            Shown as of the end of {nodeLabel(index, chapterId)}.
          </p>
        )}
      </>
    ) : null;

  const history = (key: string, renderValue: RenderValue): ReactNode => {
    const field = infobox.fields.find((f) => f.key === key);
    if (!field?.changes?.length || !names) return null;
    if (!moment) return <FieldHistory field={field} names={names} renderValue={renderValue} />;
    const change = changeInEffect(field, moment, names.resolve);
    const when = change && whenOf(change, names.nodeLabel);
    return when ? <span className="facts-note facts-since"> since {when}</span> : null;
  };

  return { shown, control, history };
}
