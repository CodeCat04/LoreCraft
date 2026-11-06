import { useLayoutEffect, useRef, useState } from 'react';

import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import {
  explainStoryDate,
  formatStoryDate,
  getCalendar,
  getEras,
  MAX_MONTH_DAYS,
  MAX_MONTHS,
  parseStoryDate,
  setCalendar,
  setEras,
  type Calendar,
  type Era,
} from '../../lib/storyDate';
import { showDialog } from '../../shell/dialogs';
import { toast } from '../../shell/toasts';
import { useLocale } from '../../state/language';

interface Row {
  key: number;
  name: string;
  offset: string;
  negative: boolean;
}

interface MonthRow {
  key: number;
  name: string;
  days: string;
}

let nextKey = 1;

function toRow(era: Era): Row {
  nextKey += 1;
  return { key: nextKey, name: era.name, offset: String(era.offset), negative: !!era.negative };
}

function toMonthRow(name: string, days: number): MonthRow {
  nextKey += 1;
  return { key: nextKey, name, days: String(days) };
}

function problemWith(rows: Row[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim().toLowerCase();
    if (!name) return t('Every era needs a name.');
    if (seen.has(name)) return t('There are two eras called "{name}".', { name: row.name.trim() });
    seen.add(name);
    if (row.offset.trim() === '' || !Number.isFinite(Number(row.offset))) {
      return t('The offset for "{name}" must be a number.', { name: row.name.trim() });
    }
  }
  return null;
}

function problemWithMonths(months: MonthRow[], rows: Row[]): string | null {
  if (months.length > MAX_MONTHS) return t('A calendar can have at most {count} months.', { count: MAX_MONTHS });
  const eras = new Set(rows.map((row) => row.name.trim().toLowerCase()));
  const seen = new Set<string>();
  for (const month of months) {
    const shown = month.name.trim();
    const name = shown.toLowerCase();
    if (!name) return t('Every month needs a name.');
    if (!/\p{L}/u.test(name)) {
      return t('"{name}" needs a letter in it, so it cannot be mistaken for a number.', { name: shown });
    }
    if (seen.has(name)) return t('There are two months called "{name}".', { name: shown });
    if (eras.has(name)) return t('"{name}" is the name of an era too, so dates would be unclear.', { name: shown });
    seen.add(name);
    const days = Number(month.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_MONTH_DAYS) {
      return t('"{name}" needs a length from 1 to {max} days.', { name: shown, max: MAX_MONTH_DAYS });
    }
  }
  return null;
}

function toEras(rows: Row[]): Era[] {
  return rows.map((row) => {
    const era: Era = { name: row.name.trim(), offset: Number(row.offset) };
    if (row.negative) era.negative = true;
    return era;
  });
}

function toCalendar(months: MonthRow[]): Calendar | null {
  if (months.length === 0) return null;
  return { months: months.map((m) => ({ name: m.name.trim().replace(/\s+/g, ' '), days: Number(m.days) })) };
}

function CalendarEditor(props: { months: MonthRow[]; onChange: (months: MonthRow[]) => void }) {
  useLocale();
  const { months, onChange } = props;
  const patch = (key: number, change: Partial<MonthRow>) =>
    onChange(months.map((month) => (month.key === key ? { ...month, ...change } : month)));

  // Moving a row re-attaches its DOM node, which drops focus, so it is put back.
  const rootRef = useRef<HTMLElement>(null);
  const focusAfter = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!focusAfter.current) return;
    rootRef.current?.querySelector<HTMLElement>(focusAfter.current)?.focus();
    focusAfter.current = null;
  });

  const move = (index: number, delta: -1 | 1) => {
    const next = [...months];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    const reachedEnd = index + delta === 0 || index + delta === months.length - 1;
    const stays = delta < 0 ? 'up' : 'down';
    const other = delta < 0 ? 'down' : 'up';
    focusAfter.current = `[data-month="${months[index].key}"] [data-action="${reachedEnd ? other : stays}"]`;
    onChange(next);
  };
  return (
    <section className="calendar-section" aria-labelledby="calendar-title" ref={rootRef}>
      <h3 id="calendar-title" className="calendar-title">{t('Calendar')}</h3>
      <p className="field-hint">
        {t(
          'Name your months, in order, to write dates such as 15 Frostmoot 312 or Frostmoot 312. Numbered dates such as 312-04-15 keep working. With no months here, dates stay numbered.',
        )}
      </p>
      {months.length > 0 && (
        <table className="data-table era-table">
          <thead>
            <tr>
              <th scope="col">{t('Month')}</th>
              <th scope="col">{t('Days')}</th>
              <th scope="col"><span className="visually-hidden">{t('Move or remove')}</span></th>
            </tr>
          </thead>
          <tbody>
            {months.map((month, index) => (
              <tr key={month.key} data-month={month.key}>
                <td>
                  <input
                    className="input"
                    aria-label={t('Name of month {number}', { number: index + 1 })}
                    placeholder="Frostmoot"
                    value={month.name}
                    onChange={(e) => patch(month.key, { name: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="input calendar-days"
                    aria-label={t('Days in month {number}', { number: index + 1 })}
                    inputMode="numeric"
                    value={month.days}
                    onChange={(e) => patch(month.key, { days: e.target.value })}
                  />
                </td>
                <td>
                  <span className="calendar-move">
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={t('Move month {number} up', { number: index + 1 })}
                      data-action="up"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={t('Move month {number} down', { number: index + 1 })}
                      data-action="down"
                      disabled={index === months.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={t('Remove month {number}', { number: index + 1 })}
                      onClick={() => {
                        focusAfter.current = '.calendar-add';
                        onChange(months.filter((other) => other.key !== month.key));
                      }}
                    >
                      {t('Remove')}
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button
        type="button"
        className="btn btn-sm era-add calendar-add"
        onClick={() => {
          const added = toMonthRow('', 30);
          focusAfter.current = `[data-month="${added.key}"] input`;
          onChange([...months, added]);
        }}
      >
        {t('Add month')}
      </button>
    </section>
  );
}

function EraEditor(props: { initial: Era[]; initialCalendar: Calendar | null; close: (saved: boolean) => void }) {
  useLocale();
  const { initial, initialCalendar, close } = props;
  const [rows, setRows] = useState<Row[]>(() => initial.map(toRow));
  const [months, setMonths] = useState<MonthRow[]>(() =>
    (initialCalendar?.months ?? []).map((month) => toMonthRow(month.name, month.days)),
  );
  const [sample, setSample] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = problemWith(rows) ?? problemWithMonths(months, rows);
  const patch = (key: number, change: Partial<Row>) =>
    setRows((list) => list.map((row) => (row.key === key ? { ...row, ...change } : row)));

  const sampleEras = problem ? [] : toEras(rows);
  const sampleCalendar = problem ? null : toCalendar(months);
  const sampleSort = sample.trim() ? parseStoryDate(sample, sampleEras, sampleCalendar) : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (problem) return;
        setBusy(true);
        Promise.all([setEras(toEras(rows)), setCalendar(toCalendar(months))]).then(
          () => close(true),
          (err) => {
            setBusy(false);
            toast(t('Could not save the eras: {reason}', { reason: errorMessage(err) }), 'error');
          },
        );
      }}
    >
      <h2 className="dialog-title">{t('Era settings')}</h2>
      <p className="dialog-message">
        {t(
          'Eras let dates such as "312 AE" or "Third Age 3" be put in order. A date without a known era is listed apart from the timeline until it can be placed.',
        )}
      </p>

      {rows.length === 0 ? (
        <p className="muted era-empty">
          {t('No eras yet. Plain years such as 312 and -40 work without any.')}
        </p>
      ) : (
        <table className="data-table era-table">
          <thead>
            <tr>
              <th scope="col">{t('Name, as written in dates')}</th>
              <th scope="col">{t('Offset')}</th>
              <th scope="col">{t('Counts backwards')}</th>
              <th scope="col"><span className="visually-hidden">{t('Remove')}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key}>
                <td>
                  <input
                    className="input"
                    aria-label={t('Name of era {number}', { number: index + 1 })}
                    placeholder="AE"
                    value={row.name}
                    onChange={(e) => patch(row.key, { name: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="input era-offset"
                    aria-label={t('Offset of era {number}', { number: index + 1 })}
                    inputMode="numeric"
                    value={row.offset}
                    onChange={(e) => patch(row.key, { offset: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t('Era {number} counts backwards, like BC', { number: index + 1 })}
                    checked={row.negative}
                    onChange={(e) => patch(row.key, { negative: e.target.checked })}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={t('Remove era {number}', { number: index + 1 })}
                    onClick={() => setRows((list) => list.filter((other) => other.key !== row.key))}
                  >
                    {t('Remove')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="field-hint">
        {t(
          'The offset is added to each year, so eras sort against each other. Third Age with an offset of 5000 puts Third Age 3 at 5003, after every lower era.',
        )}
      </p>
      <button
        type="button"
        className="btn btn-sm era-add"
        onClick={() => setRows((list) => [...list, toRow({ name: '', offset: 0 })])}
      >
        {t('Add era')}
      </button>

      <CalendarEditor months={months} onChange={setMonths} />

      <label className="field era-sample">
        <span className="field-label">{t('Try a date')}</span>
        <input
          className="input"
          placeholder={months[0]?.name.trim() ? `15 ${months[0].name.trim()} 312` : t('Third Age 3')}
          value={sample}
          onChange={(e) => setSample(e.target.value)}
        />
        {sample.trim() && (
          <span className="field-hint" role="status">
            {sampleSort === null
              ? explainStoryDate(sample, sampleEras, sampleCalendar)
              : t('Sorts at {sort}. Reads as {date}.', {
                  sort: Number(sampleSort.toFixed(4)),
                  date: formatStoryDate(sampleSort, sampleEras, sampleCalendar),
                })}
          </span>
        )}
      </label>

      {problem && <div className="field-error">{problem}</div>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => close(false)}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={!!problem || busy}>{t('Save')}</button>
      </div>
    </form>
  );
}

/** Opens the editor for the project's eras and calendar. */
export async function openEraSettings(): Promise<void> {
  try {
    const [eras, calendar] = await Promise.all([getEras(), getCalendar()]);
    await showDialog<boolean>(
      (close) => <EraEditor initial={eras} initialCalendar={calendar} close={close} />,
      false,
    );
  } catch (e) {
    toast(t('Could not open era settings: {reason}', { reason: errorMessage(e) }), 'error');
  }
}
