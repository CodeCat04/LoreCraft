/** Every open comment and to-do in the project, with filters, each one a step from its text. */

import { useMemo, useState } from 'react';

import { authorLabel, comments as commentsApi, deleteComment, isOpen, type Comment, type CommentPatch } from './api';
import { goToComment } from './navigate';
import { TodoTick } from './TodoTick';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { formatNumber, relativeTime } from '../lib/text';
import { confirm } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';

type StateFilter = 'open' | 'closed' | 'all';
type TypeFilter = 'all' | 'comments' | 'todos';

async function act(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    toast(t('That did not work: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

function placeOf(comment: Comment): string {
  if (comment.sourceKind === 'page') return comment.sourceTitle || t('Untitled page');
  const scene = comment.sourceTitle || t('Untitled scene');
  return [comment.bookTitle, comment.chapterTitle, scene].filter(Boolean).join(' › ');
}

function Item({ comment }: { comment: Comment }) {
  useLocale();
  const update = (patch: CommentPatch) => void act(() => commentsApi.update(comment.id, patch));
  const remove = async () => {
    const yes = await confirm({
      title: comment.isTodo ? t('Delete this to-do?') : t('Delete this comment?'),
      message: t('It cannot be brought back. The text stays as it is.'),
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (yes) await act(() => deleteComment(comment));
  };
  const closed = !isOpen(comment);
  return (
    <li className={`notes-item${closed ? ' is-closed' : ''}`} data-comment={comment.id}>
      {comment.isTodo && <TodoTick className="notes-item-tick" done={comment.done} onChange={(done) => update({ done })} />}
      <div className="notes-item-main">
        <button type="button" className="notes-item-body" title={t('Go to this text')} onClick={() => void goToComment(comment)}>
          {comment.body}
        </button>
        {comment.quote && comment.anchored && <p className="notes-item-quote">“{comment.quote}”</p>}
        {!comment.anchored && comment.quote && <p className="notes-item-removed">{t('Text removed: “{quote}”', { quote: comment.quote })}</p>}
        {!comment.anchored && !comment.quote && <p className="notes-item-quote">{t('About this whole document')}</p>}
        <p className="notes-item-meta">
          <span className="notes-item-place">{placeOf(comment)}</span>
          <span> · {authorLabel(comment.author)}</span>
          <span> · {relativeTime(comment.updatedAt)}</span>
          {comment.isTodo && <span className="badge notes-item-badge">{t('To-do')}</span>}
          {comment.resolved && <span className="badge notes-item-badge">{t('Resolved')}</span>}
        </p>
      </div>
      <div className="notes-item-actions">
        <button type="button" className="btn btn-sm" onClick={() => void goToComment(comment)}>{t('Go to')}</button>
        <button type="button" className="btn btn-sm" onClick={() => update({ resolved: !comment.resolved })}>
          {comment.resolved ? t('Reopen') : t('Resolve')}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void remove()}>{t('Delete')}</button>
      </div>
    </li>
  );
}

export function NotesView() {
  useLocale();
  // Editing a document can take a comment's text away, or bring it back.
  const version = useDataVersion('comments', 'pageContent', 'nodeContent', 'pages', 'nodes');
  const { data, error } = useLoad(() => commentsApi.all(), [version]);
  const [state, setState] = useState<StateFilter>('open');
  const [type, setType] = useState<TypeFilter>('all');
  const [where, setWhere] = useState('all');
  const [author, setAuthor] = useState('all');
  const [text, setText] = useState('');

  const all = useMemo(() => data ?? [], [data]);
  const books = useMemo(() => {
    const found = new Map<string, string>();
    for (const comment of all) {
      if (comment.bookId) found.set(comment.bookId, comment.bookTitle || t('Untitled book'));
    }
    return [...found.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);
  const authors = useMemo(() => [...new Set(all.map((c) => c.author))].sort(), [all]);

  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return all.filter((comment) => {
      if (state === 'open' && !isOpen(comment)) return false;
      if (state === 'closed' && isOpen(comment)) return false;
      if (type === 'comments' && comment.isTodo) return false;
      if (type === 'todos' && !comment.isTodo) return false;
      if (where === 'wiki' && comment.sourceKind !== 'page') return false;
      if (where !== 'all' && where !== 'wiki' && comment.bookId !== where) return false;
      if (author !== 'all' && comment.author !== author) return false;
      if (needle) {
        const haystack = `${comment.body}\n${comment.quote}\n${placeOf(comment)}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [all, author, state, text, type, where]);

  const openCount = useMemo(() => all.filter(isOpen).length, [all]);

  return (
    <div className="view-pad notes-view">
      <h1 className="view-title">{t('Comments and to-dos')}</h1>
      <p className="muted notes-intro">
        {data
          ? t('{count} open across this project. Select text in a page or scene and press {shortcut} to add one.', {
              count: formatNumber(openCount),
              shortcut: 'Ctrl+Alt+C',
            })
          : t('Loading… Select text in a page or scene and press {shortcut} to add one.', { shortcut: 'Ctrl+Alt+C' })}
      </p>
      <form className="notes-filters" aria-label={t('Filter comments and to-dos')} onSubmit={(e) => e.preventDefault()}>
        <label className="notes-filter">
          <span className="field-label">{t('Show')}</span>
          <select className="select" value={state} onChange={(e) => setState(e.target.value as StateFilter)}>
            <option value="open">{t('Open')}</option>
            <option value="closed">{t('Resolved or done')}</option>
            <option value="all">{t('Everything')}</option>
          </select>
        </label>
        <label className="notes-filter">
          <span className="field-label">{t('Kind')}</span>
          <select className="select" value={type} onChange={(e) => setType(e.target.value as TypeFilter)}>
            <option value="all">{t('Comments and to-dos')}</option>
            <option value="comments">{t('Comments')}</option>
            <option value="todos">{t('To-dos')}</option>
          </select>
        </label>
        <label className="notes-filter">
          <span className="field-label">{t('Where')}</span>
          <select className="select" value={where} onChange={(e) => setWhere(e.target.value)}>
            <option value="all">{t('Everywhere')}</option>
            <option value="wiki">{t('The wiki')}</option>
            {books.map(([id, title]) => (
              <option key={id} value={id}>{title}</option>
            ))}
          </select>
        </label>
        <label className="notes-filter">
          <span className="field-label">{t('From')}</span>
          <select className="select" value={author} onChange={(e) => setAuthor(e.target.value)}>
            <option value="all">{t('Anyone')}</option>
            {authors.map((name) => (
              <option key={name} value={name}>{authorLabel(name)}</option>
            ))}
          </select>
        </label>
        <label className="notes-filter notes-filter-grow">
          <span className="field-label">{t('Containing')}</span>
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      </form>
      {error && <p role="alert">{t('The list could not be loaded: {reason}', { reason: error.message })}</p>}
      {data && shown.length === 0 && (
        <div className="empty-state">
          {all.length === 0 ? t('No comments or to-dos yet.') : t('Nothing matches these filters.')}
        </div>
      )}
      {shown.length > 0 && (
        <ul className="notes-list" aria-label={t('Comments and to-dos')}>
          {shown.map((comment) => (
            <Item key={comment.id} comment={comment} />
          ))}
        </ul>
      )}
    </div>
  );
}
