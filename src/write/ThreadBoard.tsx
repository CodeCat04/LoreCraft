/**
 * Plot threads across the book: threads as rows and chapters as columns. A filled cell says
 * how many of that chapter's scenes carry the thread. A cell marked quiet is a chapter
 * after the thread began where nothing happens with it. Click a cell to change which scenes
 * are on the thread.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { threads as threadsApi, type Thread } from './api';
import { threadColor, threadRows, THREAD_COLORS, type ThreadCell } from './charts';
import { openScene, useWrite } from './store';
import { addThread, useThreadData } from './threadData';
import { displayTitle } from './tree';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { confirm, showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';

function report(what: string) {
  return (e: unknown) => toast(t('{what}: {reason}', { what, reason: errorMessage(e) }), 'error');
}

function ThreadForm({ thread, close }: { thread: Thread; close: (changed: boolean) => void }) {
  useLocale();
  const [name, setName] = useState(thread.name);
  const [description, setDescription] = useState(thread.description);
  const [color, setColor] = useState(thread.color);
  const clean = name.trim();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!clean) return;
        threadsApi.update(thread.id, { name: clean, description, color }).then(
          () => close(true),
          report(t('Could not save the thread')),
        );
      }}
    >
      <h2 id="dialog-title" className="dialog-title">{t('Plot thread')}</h2>
      <label className="field">
        <span className="field-label">{t('Name')}</span>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {!clean && <div className="field-error">{t('A thread needs a name.')}</div>}
      <label className="field">
        <span className="field-label">{t('Description')}</span>
        <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <fieldset className="settings-group">
        <legend className="field-label">{t('Color')}</legend>
        <div className="thread-colors">
          {THREAD_COLORS.map((token, i) => (
            <button
              key={token}
              type="button"
              className={`thread-color${color === token ? ' is-active' : ''}`}
              style={{ background: threadColor(token) }}
              aria-label={t('Color {number}', { number: i + 1 })}
              aria-pressed={color === token}
              onClick={() => setColor(token)}
            />
          ))}
        </div>
      </fieldset>
      <div className="dialog-actions book-settings-actions">
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            void confirm({
              title: t('Delete “{title}”?', { title: thread.name }),
              message: t('Its place in each scene goes with it. The scenes themselves stay as they are.'),
              confirmLabel: t('Delete thread'),
              danger: true,
            }).then((yes) => {
              if (!yes) return;
              threadsApi.remove(thread.id).then(() => close(true), report(t('Could not delete the thread')));
            });
          }}
        >
          {t('Delete thread')}
        </button>
        <span className="binder-spacer" />
        <button type="button" className="btn" onClick={() => close(false)}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={!clean}>{t('Save')}</button>
      </div>
    </form>
  );
}

function openThreadForm(thread: Thread) {
  void showDialog<boolean>((close) => <ThreadForm thread={thread} close={close} />, false);
}

interface OpenCell {
  thread: Thread;
  cell: ThreadCell;
  x: number;
  y: number;
}

/** The scenes of one chapter, with a box for each to put it on the thread or take it off. */
function CellPopup(props: {
  open: OpenCell;
  onClose: (refocus?: boolean) => void;
  setLink: (nodeId: string, threadId: string, on: boolean) => void;
}) {
  useLocale();
  const { open, onClose, setLink } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: open.x, top: open.y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.max(8, Math.min(open.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(open.y, window.innerHeight - box.height - 8)),
    });
    ref.current?.querySelector<HTMLElement>('input')?.focus();
    // Only when it opens. Ticking a box must not move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.thread.id, open.cell.chapter.id]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="menu-popup thread-popup"
      role="dialog"
      aria-label={t('Scenes of {chapter} on {thread}', { chapter: displayTitle(open.cell.chapter), thread: open.thread.name })}
      style={{ position: 'fixed', left: position.left, top: position.top }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose(true);
        }
      }}
      onBlur={(e) => {
        // Tabbing out of it means done with it.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) onClose();
      }}
    >
      <div className="menu-label">{displayTitle(open.cell.chapter)}</div>
      {open.cell.scenes.map((scene) => (
        <div key={scene.id} className="thread-popup-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={open.cell.sceneIds.includes(scene.id)}
              onChange={(e) => setLink(scene.id, open.thread.id, e.target.checked)}
            />
            <span className="truncate">{displayTitle(scene)}</span>
          </label>
          <button type="button" className="link-button small" onClick={() => openScene(scene.id)}>
            {t('Open')}
          </button>
        </div>
      ))}
    </div>
  );
}

export function ThreadBoard() {
  useLocale();
  const bookId = useWrite((s) => s.bookId);
  const index = useWrite((s) => s.index);
  const { threads, links, setLink } = useThreadData(bookId);
  const rows = useMemo(() => threadRows(threads, links, index), [threads, links, index]);
  const moveThread = (id: string, by: -1 | 1) => {
    const ids = rows.map((row) => row.thread.id);
    const from = ids.indexOf(id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    threadsApi.reorder(ids).catch(report(t('Could not move the thread')));
  };
  const [openAt, setOpenAt] = useState<{ threadId: string; chapterId: string; x: number; y: number } | null>(null);
  const openedFrom = useRef<HTMLElement | null>(null);
  const onClose = useCallback((refocus?: boolean) => {
    setOpenAt(null);
    if (refocus) openedFrom.current?.focus();
  }, []);

  // Read fresh on each change, so a ticked box shows at once in the popup and the cell.
  const open = useMemo<OpenCell | null>(() => {
    if (!openAt) return null;
    const row = rows.find((r) => r.thread.id === openAt.threadId);
    const cell = row?.cells.find((c) => c.chapter.id === openAt.chapterId);
    return row && cell ? { thread: row.thread, cell, x: openAt.x, y: openAt.y } : null;
  }, [rows, openAt]);

  return (
    <div className="write-scroll">
      <div className="chart-page">
        <header className="chart-page-head">
          <div>
            <h1 className="chart-page-title">{t('Plot threads')}</h1>
            <p className="muted small">{t('Where each thread appears, and where it goes quiet. Threads are shared by every book in this project.')}</p>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => void addThread()}>{t('Add a thread')}</button>
        </header>
        {threads.length === 0 && (
          <div className="write-empty">
            <p className="muted">{t('No plot threads yet. Add one, then mark the scenes it runs through.')}</p>
          </div>
        )}
        {threads.length > 0 && index.chapters.length === 0 && (
          <p className="muted">{t('This book has no chapters yet, so there is nothing to show across.')}</p>
        )}
        {threads.length > 0 && index.chapters.length > 0 && (
          <>
            <div className="chart-legend thread-legend">
              <span><span className="thread-legend-on" aria-hidden="true" />{t('In this chapter')}</span>
              <span><span className="thread-legend-quiet" aria-hidden="true" />{t('Quiet')}</span>
            </div>
            <div className="chart-table-wrap">
              <table className="chart-table thread-table">
                <thead>
                  <tr>
                    <th scope="col" className="chart-table-corner">{t('Thread')}</th>
                    {index.chapters.map((chapter) => (
                      <th key={chapter.id} scope="col" className="chart-table-column" title={displayTitle(chapter)}>
                        <span className="truncate">{displayTitle(chapter)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ thread, cells }, rowIndex) => (
                    <tr key={thread.id}>
                      <th scope="row" className="chart-table-row" title={thread.description || thread.name}>
                        <button type="button" className="link-button thread-name" onClick={() => openThreadForm(thread)}>
                          <span className="thread-swatch" style={{ background: threadColor(thread.color) }} aria-hidden="true" />
                          <span className="truncate">{thread.name}</span>
                        </button>
                        <span className="thread-move">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={rowIndex === 0}
                            aria-label={t('Move {thread} up', { thread: thread.name })}
                            title={t('Move up')}
                            onClick={() => moveThread(thread.id, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={rowIndex === rows.length - 1}
                            aria-label={t('Move {thread} down', { thread: thread.name })}
                            title={t('Move down')}
                            onClick={() => moveThread(thread.id, 1)}
                          >
                            ↓
                          </button>
                        </span>
                      </th>
                      {cells.map((cell) => {
                        const count = cell.sceneIds.length;
                        const chapter = displayTitle(cell.chapter);
                        const vars = { thread: thread.name, chapter, count, total: cell.scenes.length };
                        const description = count > 0
                          ? cell.scenes.length === 1
                            ? t('{thread} in {chapter}: {count} of {total} scene', vars)
                            : t('{thread} in {chapter}: {count} of {total} scenes', vars)
                          : cell.quiet
                            ? t('{thread} in {chapter}: quiet', vars)
                            : t('{thread} in {chapter}: not begun', vars);
                        return (
                          <td key={cell.chapter.id} className="thread-cell-wrap">
                            <button
                              type="button"
                              className={`thread-cell${count > 0 ? ' is-on' : ''}${cell.quiet ? ' is-quiet' : ''}`}
                              style={count > 0 ? { background: threadColor(thread.color) } : undefined}
                              disabled={cell.scenes.length === 0}
                              aria-label={description}
                              title={description}
                              aria-haspopup="dialog"
                              data-thread-cell={`${thread.name}|${chapter}`}
                              onClick={(e) => {
                                const box = e.currentTarget.getBoundingClientRect();
                                openedFrom.current = e.currentTarget;
                                setOpenAt({ threadId: thread.id, chapterId: cell.chapter.id, x: box.left, y: box.bottom + 4 });
                              }}
                            >
                              {count > 0 && <span className="thread-count">{count}</span>}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {open && <CellPopup open={open} onClose={onClose} setLink={setLink} />}
    </div>
  );
}
