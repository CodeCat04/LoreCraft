/** Deleted parts of the book, and deleted books, ready to come back. */

import * as api from './api';
import { emptyNodeTrash, purgeNode, restoreBook, restoreNode, useWrite } from './store';
import { displayTitle, restorableNodes } from './tree';
import { wordsText } from './WriteStatus';
import { t } from '../lib/i18n';
import { relativeTime } from '../lib/text';
import type { NodeMeta } from '../lib/types';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';

function kindLabel(kind: NodeMeta['kind']): string {
  if (kind === 'part') return t('Part');
  if (kind === 'chapter') return t('Chapter');
  return t('Scene');
}

export function TrashView() {
  useLocale();
  const bookId = useWrite((s) => s.bookId);
  const book = useWrite((s) => s.books.find((b) => b.id === s.bookId));
  const version = useDataVersion('books', 'nodes');
  const { data: nodes } = useLoad(() => (bookId ? api.nodes.trash(bookId) : Promise.resolve([])), [bookId, version]);
  const { data: books } = useLoad(() => api.books.trash(), [version]);
  const items = nodes ? restorableNodes(nodes) : [];

  return (
    <div className="write-scroll">
      <div className="view-pad trash-view">
        <h1 className="view-title">{t('Trash')}</h1>
        <h2 className="trash-heading">
          {book ? t('Deleted from {title}', { title: book.title }) : t('Deleted from this book')}
        </h2>
        {items.length === 0 ? (
          <p className="muted">{t('Nothing has been deleted from this book.')}</p>
        ) : (
          <ul className="trash-list">
            {items.map((node) => (
              <li key={node.id} className="trash-item">
                <div className="trash-info">
                  <span className="trash-title">{displayTitle(node)}</span>
                  <span className="muted small">
                    {kindLabel(node.kind)}
                    {node.kind === 'scene' ? `, ${wordsText(node.wordCount)}` : ''}
                    {node.carried > 0
                      ? `, ${node.carried === 1 ? t('with 1 more inside') : t('with {count} more inside', { count: node.carried })}`
                      : ''}
                    {node.deletedAt ? `, ${t('deleted {time}', { time: relativeTime(node.deletedAt) })}` : ''}
                  </span>
                </div>
                <div className="trash-actions">
                  <button type="button" className="btn btn-sm" onClick={() => void restoreNode(node.id)}>
                    {t('Restore')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    aria-label={t('Delete {title} forever', { title: displayTitle(node) })}
                    onClick={() => void purgeNode(node)}
                  >
                    {t('Delete forever')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {bookId && items.length > 0 && (
          <button
            type="button"
            className="btn btn-sm btn-danger trash-empty"
            onClick={() => void emptyNodeTrash(bookId, items.reduce((sum, n) => sum + 1 + n.carried, 0))}
          >
            {t('Empty trash')}
          </button>
        )}
        <h2 className="trash-heading">{t('Deleted books')}</h2>
        {!books || books.length === 0 ? (
          <p className="muted">{t('No books have been deleted.')}</p>
        ) : (
          <ul className="trash-list">
            {books.map((b) => (
              <li key={b.id} className="trash-item">
                <div className="trash-info">
                  <span className="trash-title">{b.title || t('Untitled book')}</span>
                  {b.deletedAt && (
                    <span className="muted small">{t('Deleted {time}', { time: relativeTime(b.deletedAt) })}</span>
                  )}
                </div>
                <button type="button" className="btn btn-sm" onClick={() => void restoreBook(b.id)}>
                  {t('Restore')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
