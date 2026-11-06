/**
 * Canvases: endless boards of cards stored as JSON Canvas 1.0 in the project.
 * Other modules may use `{ view: 'canvas', id }`, `CanvasLinks` for a sidebar, and
 * `REF_MIME` to make something draggable onto a board.
 */

import '../styles/canvas.css';

import * as api from '../lib/api';
import { subscribeLocale, t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { registerCommands } from '../shell/commands';
import { confirm, promptText } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import { canvases, useCanvasList } from './api';
import { parseCanvas } from './model';
import { refDragProps } from './refDrag';
import { insertCanvasEmbed } from './embedView';
import { useWikiSession } from '../wiki/session';

export { CanvasView } from './CanvasView';
export { REF_MIME, dropRefAt, refDragProps } from './refDrag';
export { canvases } from './api';

const hasProject = () => useProject.getState().status.open;
const onCanvas = () => hasProject() && useNav.getState().route.view === 'canvas';

export async function newCanvas(): Promise<void> {
  const title = await promptText({ title: t('New canvas'), label: t('Name'), initial: t('Untitled canvas') });
  if (!title?.trim()) return;
  try {
    const made = await canvases.create(title.trim());
    useNav.getState().go({ view: 'canvas', id: made.id });
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function importCanvasFile(): Promise<void> {
  const [path] = await api.files.pickOpen({ title: t('Import a .canvas file'), filters: [{ name: t('Canvas'), extensions: ['canvas', 'json'] }] });
  if (!path) return;
  try {
    const { text } = await api.files.readText(path);
    const data = parseCanvas(text);
    const name = path.split(/[\\/]/).pop()!.replace(/\.(canvas|json)$/i, '');
    const made = await canvases.create(name, data);
    useNav.getState().go({ view: 'canvas', id: made.id });
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

async function trashCurrent() {
  const route = useNav.getState().route;
  if (route.view !== 'canvas') return;
  const ok = await confirm({ title: t('Move this canvas to the trash?'), message: t('You can restore it from the Canvases list.'), confirmLabel: t('Move to trash') });
  if (!ok) return;
  await canvases.trash(route.id);
  useNav.getState().go({ view: 'timeline' });
  toast(t('Moved the canvas to the trash.'), 'info', { label: t('Undo'), run: () => void canvases.restore(route.id) });
}

/** The Canvases list for the Atlas sidebar, with the trash folded away. */
export function CanvasLinks({ activeId }: { activeId?: string }) {
  const list = useCanvasList(true);
  const go = useNav((s) => s.go);
  const live = list.filter((c) => !c.deletedAt);
  const trashed = list.filter((c) => c.deletedAt);
  return (
    <div className="canvas-links">
      <div className="nav-subtitle">
        {t('Canvases')}
        <button type="button" className="icon-btn" aria-label={t('New canvas')} title={t('New canvas')} onClick={() => void newCanvas()}>
          +
        </button>
      </div>
      {live.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`nav-link nav-sublink${activeId === c.id ? ' is-active' : ''}`}
          aria-current={activeId === c.id ? 'page' : undefined}
          onClick={() => go({ view: 'canvas', id: c.id })}
          {...refDragProps({ kind: 'canvas', id: c.id })}
        >
          {c.title}
        </button>
      ))}
      {trashed.length > 0 && (
        <details className="canvas-trash">
          <summary>{t('Trash ({count})', { count: trashed.length })}</summary>
          {trashed.map((c) => (
            <div key={c.id} className="canvas-trash-row">
              <span>{c.title}</span>
              <button type="button" className="btn btn-sm" onClick={() => void canvases.restore(c.id)}>
                {t('Restore')}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  if (await confirm({ title: t('Delete this canvas for good?'), message: c.title, confirmLabel: t('Delete') })) await canvases.purge(c.id);
                }}
              >
                {t('Delete')}
              </button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

export function registerCanvas() {
  registerCanvasCommands();
  subscribeLocale(registerCanvasCommands);
}

function registerCanvasCommands() {
  registerCommands([
    { id: 'canvas.new', title: t('New canvas…'), menu: 'File', order: 15, when: hasProject, keywords: 'board brainstorm whiteboard diagram', run: newCanvas },
    { id: 'canvas.import', title: t('Import a .canvas file…'), menu: 'File', order: 16, when: hasProject, keywords: 'json canvas obsidian', run: importCanvasFile },
    {
      id: 'canvas.rename',
      title: t('Rename this canvas…'),
      when: onCanvas,
      run: async () => {
        const route = useNav.getState().route;
        if (route.view !== 'canvas') return;
        const current = await canvases.get(route.id);
        const name = await promptText({ title: t('Rename canvas'), label: t('Name'), initial: current.title });
        if (name?.trim()) await canvases.rename(route.id, name.trim());
      },
    },
    {
      id: 'canvas.insertEmbed',
      title: t('Canvas…'),
      menu: 'Insert',
      order: 13,
      keywords: 'board embed preview',
      when: () => {
        const { tab, editor } = useWikiSession.getState();
        return hasProject() && useNav.getState().route.view === 'page' && tab === 'edit' && editor !== null;
      },
      run: () => {
        const { editor } = useWikiSession.getState();
        if (editor) return insertCanvasEmbed(editor);
      },
    },
    { id: 'canvas.trash', title: t('Move this canvas to the trash'), when: onCanvas, run: trashCurrent },
  ]);
}
