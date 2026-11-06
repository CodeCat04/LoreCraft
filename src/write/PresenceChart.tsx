/**
 * Characters by chapter, from the names in the text and each scene's cast. It is a table,
 * so every number is there to read, with heavier cells for more mentions. Anyone away for
 * several chapters has those chapters marked and says so at the end of the row.
 */

import { useMemo } from 'react';

import { bookPresence } from './api';
import { ABSENT_CHAPTERS, presenceLevel, presenceRows, type PresenceCell } from './charts';
import { useWrite } from './store';
import { displayTitle } from './tree';
import { t } from '../lib/i18n';
import { formatNumber } from '../lib/text';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useTitles } from '../state/project';

function describe(name: string, chapter: string, cell: PresenceCell): string {
  if (cell.absent) return t('{name} is absent from {chapter}', { name, chapter });
  const parts: string[] = [];
  if (cell.named > 0) {
    parts.push(cell.named === 1 ? t('named 1 time') : t('named {count} times', { count: formatNumber(cell.named) }));
  }
  if (cell.cast > 0) {
    parts.push(cell.cast === 1 ? t('in the cast of 1 scene') : t('in the cast of {count} scenes', { count: cell.cast }));
  }
  return parts.length > 0
    ? t('{name} in {chapter}: {details}', { name, chapter, details: parts.join(', ') })
    : t('{name} is not in {chapter}', { name, chapter });
}

export function PresenceChart() {
  useLocale();
  const bookId = useWrite((s) => s.bookId);
  const index = useWrite((s) => s.index);
  const entries = useTitles((s) => s.entries);
  const go = useNav((s) => s.go);
  const version = useDataVersion('nodes', 'nodeContent', 'pages');
  const { data } = useLoad(
    () => (bookId ? bookPresence(bookId) : Promise.resolve({ mentions: [], cast: [] })),
    [bookId, version],
  );
  const characters = useMemo(() => entries.filter((e) => e.pageType.toLowerCase() === 'character'), [entries]);
  const rows = useMemo(() => (data ? presenceRows(characters, data, index) : []), [characters, data, index]);

  return (
    <div className="write-scroll">
      <div className="chart-page">
        <header className="chart-page-head">
          <div>
            <h1 className="chart-page-title">{t('Character presence')}</h1>
            <p className="muted small">{t("Who appears in each chapter, from the names in the text and each scene's cast.")}</p>
          </div>
        </header>
        {data && rows.length === 0 && (
          <div className="write-empty">
            <p className="muted">
              {t("No characters appear in this book yet. Name a page made with the character template in a scene, or add it to the scene's cast.")}
            </p>
          </div>
        )}
        {rows.length > 0 && (
          <>
            <div className="chart-legend presence-legend">
              <span>
                {t('Times named')}
                <span className="presence-swatch level-1" aria-hidden="true" />
                <span className="presence-swatch level-2" aria-hidden="true" />
                <span className="presence-swatch level-3" aria-hidden="true" />
                <span className="presence-swatch level-4" aria-hidden="true" />
              </span>
              <span>{t('• In the cast, not named')}</span>
              <span><span className="presence-swatch is-absent" aria-hidden="true" />{t('Absent for {count} chapters or more', { count: ABSENT_CHAPTERS })}</span>
            </div>
            <div className="chart-table-wrap">
              <table className="chart-table presence-table">
                <thead>
                  <tr>
                    <th scope="col" className="chart-table-corner">{t('Character')}</th>
                    {index.chapters.map((chapter) => (
                      <th key={chapter.id} scope="col" className="chart-table-column" title={displayTitle(chapter)}>
                        <span className="truncate">{displayTitle(chapter)}</span>
                      </th>
                    ))}
                    <th scope="col" className="chart-table-note">{t('Longest away')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ page, cells, longestAbsence }) => (
                    <tr key={page.id}>
                      <th scope="row" className="chart-table-row">
                        <button
                          type="button"
                          className="link-button thread-name"
                          data-wiki-target={page.title}
                          onClick={() => go({ view: 'page', id: page.id })}
                        >
                          <span className="truncate">{page.title}</span>
                        </button>
                      </th>
                      {cells.map((cell) => {
                        const description = describe(page.title, displayTitle(cell.chapter), cell);
                        return (
                          <td
                            key={cell.chapter.id}
                            className={`presence-cell level-${presenceLevel(cell.named)}${cell.absent ? ' is-absent' : ''}`}
                            title={description}
                            aria-label={description}
                          >
                            {cell.named > 0 ? formatNumber(cell.named) : cell.cast > 0 ? '•' : ''}
                          </td>
                        );
                      })}
                      <td className={`chart-table-note${longestAbsence >= ABSENT_CHAPTERS ? ' is-long' : ''}`}>
                        {longestAbsence === 1
                          ? t('1 chapter')
                          : longestAbsence > 0
                            ? t('{count} chapters', { count: longestAbsence })
                            : t('None')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
