/**
 * Progress: today against the goal, the book against its target, the writing streak and
 * the last 30 days. The chart is one column per day on one scale: words written rise from
 * the baseline in the accent color, and words removed hang below it in gray, so the
 * writing is what stands out and the two can never be mistaken for each other.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { openBookSettings } from './BookSettings';
import { WriteDataSync } from './shared';
import { refreshStats, selectBook, useWrite } from './store';
import { chartScale, isoDay, lastDays, tickLabel, writingStreaks, type ChartScale, type DayCount } from './progress';
import { wordsText } from './WriteStatus';
import { t } from '../lib/i18n';
import { formatNumber } from '../lib/text';
import { useLocale } from '../state/language';
import { useSettings } from '../state/settings';

const CHART_DAYS = 30;

function shortDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Meter(props: { value: number; max: number; label: string }) {
  const { value, max, label } = props;
  const share = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div
      className="meter"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
    >
      <div className={`meter-fill${value >= max ? ' is-done' : ''}`} style={{ width: `${share * 100}%` }} />
    </div>
  );
}

function Tile(props: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <section className="stat-tile">
      <h2 className="stat-label">{props.label}</h2>
      <p className="stat-value" data-testid={`stat-${props.label.toLowerCase().replace(/\s+/g, '-')}`}>
        {props.value}
      </p>
      <div className="stat-detail">{props.children}</div>
    </section>
  );
}

function dayDescription(day: DayCount, isToday: boolean): string {
  const when = isToday ? t('Today') : shortDate(day.day);
  return t('{day}: {written} written, {removed} removed', {
    day: when,
    written: formatNumber(day.added),
    removed: formatNumber(day.removed),
  });
}

function DayChart({ bars, today, scale }: { bars: DayCount[]; today: string; scale: ChartScale }) {
  useLocale();
  const [activeAt, setActiveAt] = useState<number | null>(null);
  // The one column Tab lands on. The arrows move along the rest.
  const [tabAt, setTabAt] = useState(bars.length - 1);
  const columnsRef = useRef<HTMLDivElement>(null);
  const total = scale.top + scale.bottom;
  const percent = (value: number) => (value / total) * 100;
  const baseline = percent(scale.top);
  const peak = bars.reduce((best, d, i) => (d.added > (bars[best]?.added ?? 0) ? i : best), 0);
  const active = activeAt === null ? null : bars[activeAt];

  const focusColumn = (at: number) => {
    const next = Math.max(0, Math.min(bars.length - 1, at));
    setTabAt(next);
    setActiveAt(next);
    columnsRef.current?.querySelector<HTMLElement>(`[data-column="${next}"]`)?.focus();
  };

  return (
    <div className="chart">
      <div className="chart-yaxis" aria-hidden="true">
        {scale.ticks.map((tick) => (
          <span key={tick} className="chart-tick" style={{ top: `${percent(scale.top - tick)}%` }}>
            {tickLabel(tick, scale)}
          </span>
        ))}
      </div>
      <div className="chart-plot">
        {scale.ticks.map((tick) => (
          <div
            key={tick}
            className={`chart-grid${tick === 0 ? ' is-baseline' : ''}`}
            style={{ top: `${percent(scale.top - tick)}%` }}
          />
        ))}
        <div
          ref={columnsRef}
          className="chart-columns"
          role="list"
          aria-label={t('Words written and removed each day, last {count} days', { count: CHART_DAYS })}
          onMouseLeave={() => setActiveAt(null)}
          onKeyDown={(e) => {
            if (e.altKey || e.ctrlKey) return;
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              focusColumn(tabAt + 1);
            } else if (e.key === 'ArrowLeft') {
              e.preventDefault();
              focusColumn(tabAt - 1);
            } else if (e.key === 'Home') {
              e.preventDefault();
              focusColumn(0);
            } else if (e.key === 'End') {
              e.preventDefault();
              focusColumn(bars.length - 1);
            }
          }}
        >
          {bars.map((day, i) => (
            <div
              key={day.day}
              className={`chart-column${activeAt === i ? ' is-active' : ''}`}
              role="listitem"
              data-column={i}
              tabIndex={i === tabAt ? 0 : -1}
              aria-label={dayDescription(day, day.day === today)}
              onMouseEnter={() => setActiveAt(i)}
              onFocus={() => {
                setTabAt(i);
                setActiveAt(i);
              }}
              onBlur={() => setActiveAt(null)}
            >
              {day.added > 0 && (
                <div
                  className="chart-bar chart-bar-up"
                  data-testid={day.day === today ? 'chart-today-added' : undefined}
                  style={{ bottom: `${100 - baseline}%`, height: `${percent(day.added)}%` }}
                />
              )}
              {day.removed > 0 && (
                <div
                  className="chart-bar chart-bar-down"
                  style={{ top: `${baseline}%`, height: `${percent(day.removed)}%` }}
                />
              )}
              {/* The single best day carries its number, and the axis covers the rest. */}
              {i === peak && day.added > 0 && (
                <span
                  className="chart-peak"
                  style={{ bottom: `calc(${100 - baseline + percent(day.added)}% + 0.125rem)` }}
                >
                  {formatNumber(day.added)}
                </span>
              )}
            </div>
          ))}
        </div>
        {active && activeAt !== null && (
          <div
            className={`chart-tooltip${activeAt < 6 ? ' is-start' : activeAt > bars.length - 7 ? ' is-end' : ''}`}
            style={{ left: `${((activeAt + 0.5) / bars.length) * 100}%` }}
            aria-hidden="true"
          >
            <div className="chart-tooltip-day">{active.day === today ? t('Today') : shortDate(active.day)}</div>
            <div className="chart-tooltip-row">
              <span className="chart-key chart-key-up" />
              <strong>{formatNumber(active.added)}</strong> {t('written')}
            </div>
            <div className="chart-tooltip-row">
              <span className="chart-key chart-key-down" />
              <strong>{formatNumber(active.removed)}</strong> {t('removed')}
            </div>
          </div>
        )}
      </div>
      <div className="chart-xaxis" aria-hidden="true">
        {bars.map((day, i) =>
          // Today and every week back from it.
          (bars.length - 1 - i) % 7 === 0 ? (
            <span
              key={day.day}
              className={`chart-xlabel${i === bars.length - 1 ? ' is-last' : ''}`}
              style={{ left: `${((i + 0.5) / bars.length) * 100}%` }}
            >
              {i === bars.length - 1 ? t('Today') : shortDate(day.day)}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

export function StatsView({ bookId: routeBook }: { bookId?: string }) {
  useLocale();
  const books = useWrite((s) => s.books);
  const bookId = useWrite((s) => s.bookId);
  const ready = useWrite((s) => s.ready);
  const stats = useWrite((s) => s.stats);
  const words = useWrite((s) => s.index.words);
  const goal = useSettings((s) => s.settings.editor.dailyWordGoal);

  useEffect(() => {
    if (routeBook) selectBook(routeBook);
  }, [routeBook]);

  // Coming here should show today as it stands, not as of the last pause in typing.
  useEffect(() => {
    if (ready) void refreshStats();
  }, [ready, bookId]);

  const book = books.find((b) => b.id === bookId);
  const today = isoDay(new Date());
  const days = useMemo(() => stats?.days ?? [], [stats]);
  const bars = useMemo(() => lastDays(days, CHART_DAYS, today), [days, today]);
  const streak = useMemo(() => writingStreaks(days, today), [days, today]);
  const scale = useMemo(
    () => chartScale(Math.max(...bars.map((b) => b.added)), Math.max(...bars.map((b) => b.removed))),
    [bars],
  );
  const written = bars.reduce((sum, b) => sum + b.added, 0);
  const removed = bars.reduce((sum, b) => sum + b.removed, 0);
  const target = book?.targetWords ?? 0;
  const writtenToday = stats?.writtenToday ?? 0;

  if (!ready) return <WriteDataSync />;
  if (!book) {
    return (
      <div className="view-pad">
        <WriteDataSync />
        <h1 className="view-title">{t('Writing stats')}</h1>
        <p className="muted">{t('Add a book to see your progress.')}</p>
      </div>
    );
  }

  return (
    <div className="view-pad stats-view">
      <WriteDataSync />
      <header className="stats-header">
        <h1 className="view-title stats-title">{t('Writing stats: {title}', { title: book.title })}</h1>
        <button type="button" className="btn btn-sm" onClick={() => void openBookSettings()}>
          {t('Book settings')}
        </button>
      </header>

      <div className="stat-row">
        <Tile label={t('Today')} value={wordsText(writtenToday)}>
          {goal > 0 ? (
            <>
              <Meter value={writtenToday} max={goal} label={t('Daily word goal')} />
              <span>
                {writtenToday >= goal
                  ? t('Goal reached: {goal} a day', { goal: formatNumber(goal) })
                  : t('Goal: {goal} a day', { goal: formatNumber(goal) })}
              </span>
            </>
          ) : (
            <span>{t('No daily goal set')}</span>
          )}
        </Tile>
        <Tile
          label={t('Writing streak')}
          value={
            streak.current === 1
              ? t('{count} day', { count: formatNumber(streak.current) })
              : t('{count} days', { count: formatNumber(streak.current) })
          }
        >
          <span>
            {streak.longest === 1
              ? t('Longest {count} day', { count: formatNumber(streak.longest) })
              : t('Longest {count} days', { count: formatNumber(streak.longest) })}
          </span>
        </Tile>
        <Tile label={t('Book total')} value={wordsText(words)}>
          {target > 0 ? (
            <>
              <Meter value={words} max={target} label={t('Book word target')} />
              <span>
                {words >= target
                  ? t('Target reached: {target}', { target: formatNumber(target) })
                  : t('Target: {target} ({percent}%)', {
                      target: formatNumber(target),
                      percent: Math.round((words / target) * 100),
                    })}
              </span>
            </>
          ) : (
            <button type="button" className="link-button" onClick={() => void openBookSettings()}>
              {t('Set a target')}
            </button>
          )}
        </Tile>
      </div>

      <section className="stats-chart" aria-labelledby="stats-chart-title">
        <div className="stats-chart-head">
          <div>
            <h2 id="stats-chart-title" className="stats-chart-title">{t('Last {count} days', { count: CHART_DAYS })}</h2>
            <p className="muted small">
              {t('{written} written, {removed} removed', { written: formatNumber(written), removed: formatNumber(removed) })}
            </p>
          </div>
          <div className="chart-legend">
            <span><span className="chart-swatch chart-swatch-up" />{t('Written')}</span>
            <span><span className="chart-swatch chart-swatch-down" />{t('Removed')}</span>
          </div>
        </div>
        <DayChart bars={bars} today={today} scale={scale} />
      </section>

      <details className="stats-table">
        <summary>{t('Show as a table')}</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('Day')}</th>
              <th scope="col" className="is-number">{t('Written')}</th>
              <th scope="col" className="is-number">{t('Removed')}</th>
            </tr>
          </thead>
          <tbody>
            {[...bars].reverse().map((day) => (
              <tr key={day.day}>
                <td>{day.day === today ? t('Today') : shortDate(day.day)}</td>
                <td className="is-number">{formatNumber(day.added)}</td>
                <td className="is-number">{formatNumber(day.removed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
