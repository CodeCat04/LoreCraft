/** Menu items, the status bar item, and the searchable "Use a style" dialog. */

import { useEffect, useState } from 'react';

import * as api from '../lib/api';
import { subscribeLocale, t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { registerCommands } from '../shell/commands';
import { showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useNav, type Route } from '../state/nav';
import { useProject } from '../state/project';
import { useUi } from '../state/ui';
import type { Book, Node } from '../lib/types';
import { StyleSearchList } from './StylePicker';
import { StylesScreen } from './StylesView';
import { getStyle, onStyleChoicesChanged, resolveEffectiveStyle, setActiveStyle } from './store';
import type { StyleScope } from './types';
import { useStylesUi, type StylesTab } from './uiStore';

const STATUS_KEY = 'writing-style';

const hasProject = () => useProject.getState().status.open;

function StylesDialogTitle() {
  useLocale();
  return <h2 id="dialog-title" className="sr-only">{t('Writing styles')}</h2>;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  useLocale();
  return <button type="button" className="btn" onClick={onClose}>{t('Close')}</button>;
}

/**
 * Opens the screen. With no project open there is no main view to show it in, only the start
 * screen, so it opens over that with project-only actions turned off.
 */
export function openStylesPage(tab?: StylesTab) {
  const ui = useStylesUi.getState();
  if (tab) ui.set({ tab });
  if (hasProject()) {
    ui.set({ inDialog: false });
    useNav.getState().go({ view: 'styles', tab: tab ?? useStylesUi.getState().tab });
    return;
  }
  ui.set({ inDialog: true });
  void showDialog<void>((close) => (
    <div className="styles-modal">
      <StylesDialogTitle />
      <StylesScreen />
      <div className="dialog-actions"><CloseButton onClose={() => close()} /></div>
    </div>
  ), undefined).finally(() => useStylesUi.getState().set({ inDialog: false }));
}

/** What the writer is looking at, as far as styles are concerned. */
function contextOf(route: Route): { bookId?: string; nodeId?: string } {
  if (route.view === 'write') return { bookId: route.bookId, nodeId: route.nodeId };
  if (route.view === 'stats') return { bookId: route.bookId };
  return {};
}

function UseStyleBody({ onDone }: { onDone: () => void }) {
  useLocale();
  const route = useNav((s) => s.route);
  const { bookId, nodeId } = contextOf(route);
  const { data } = useLoad(async (): Promise<{ book: Book | null; scene: Node | null }> => {
    const scene = nodeId ? await api.nodes.get(nodeId).catch(() => null) : null;
    const books = await api.books.list();
    const wanted = bookId ?? scene?.bookId;
    return { book: (wanted ? books.find((b) => b.id === wanted) : books.length === 1 ? books[0] : null) ?? null, scene };
  }, [bookId, nodeId]);
  const [where, setWhere] = useState<'project' | 'book' | 'scene'>('project');
  useEffect(() => {
    if (data?.scene) setWhere('scene');
  }, [data?.scene]);

  const apply = async (styleId: string | null) => {
    const scope: StyleScope =
      where === 'scene' && data?.scene
        ? { kind: 'scene', nodeId: data.scene.id }
        : where === 'book' && data?.book
          ? { kind: 'book', bookId: data.book.id }
          : { kind: 'project' };
    try {
      await setActiveStyle(scope, styleId);
      const name = styleId ? getStyle(styleId)?.name : undefined;
      let done: string;
      if (!styleId) {
        done = t('No style chosen here now.');
      } else if (scope.kind === 'scene') {
        done = name ? t('Using {name} for this scene.', { name }) : t('Using that style for this scene.');
      } else if (scope.kind === 'book') {
        const book = data?.book?.title ?? '';
        done = name ? t('Using {name} for {book}.', { name, book }) : t('Using that style for {book}.', { book });
      } else {
        done = name ? t('Using {name} for this project.', { name }) : t('Using that style for this project.');
      }
      toast(done, 'success');
      onDone();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <>
      <h2 id="dialog-title" className="dialog-title">{t('Use a style')}</h2>
      <div className="style-use-scope" role="radiogroup" aria-label={t('Where to use it')}>
        <label className="checkbox">
          <input type="radio" name="style-use-scope" checked={where === 'project'} onChange={() => setWhere('project')} />
          <span>{t('This project')}</span>
        </label>
        {data?.book && (
          <label className="checkbox">
            <input type="radio" name="style-use-scope" checked={where === 'book'} onChange={() => setWhere('book')} />
            <span>{data.book.title}</span>
          </label>
        )}
        {data?.scene && (
          <label className="checkbox">
            <input type="radio" name="style-use-scope" checked={where === 'scene'} onChange={() => setWhere('scene')} />
            <span>{t('This scene')}</span>
          </label>
        )}
      </div>
      <StyleSearchList autoFocus value={null} noneLabel={t('No style here')} onChoose={(id) => void apply(id)} />
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onDone}>{t('Cancel')}</button>
      </div>
    </>
  );
}

function useStyleDialog() {
  void showDialog<void>((close) => <UseStyleBody onDone={() => close()} />, undefined);
}

let latestStatus = 0;

async function refreshStatus() {
  latestStatus += 1;
  const thisRefresh = latestStatus;
  const setStatusItem = useUi.getState().setStatusItem;
  if (!hasProject()) {
    setStatusItem(STATUS_KEY, null);
    return;
  }
  try {
    const effective = await resolveEffectiveStyle(contextOf(useNav.getState().route));
    if (thisRefresh !== latestStatus) return;
    setStatusItem(STATUS_KEY, effective?.name ? t('Style: {name}', { name: effective.name }) : t('Style: none'));
  } catch {
    // A project closing mid-read. The next change puts this right.
  }
}

/** Keeps the status bar current, and lets a click on it open the screen. */
function startStatusItem() {
  void refreshStatus();
  onStyleChoicesChanged(() => void refreshStatus());
  subscribeLocale(() => void refreshStatus());
  let lastPath = useProject.getState().status.path;
  let lastOpen = useProject.getState().status.open;
  let lastName = useProject.getState().status.name;
  useProject.subscribe(({ status }) => {
    if (status.open !== lastOpen || status.path !== lastPath || status.name !== lastName) {
      lastOpen = status.open;
      lastPath = status.path;
      lastName = status.name;
      void refreshStatus();
    }
  });
  let lastContext = JSON.stringify(contextOf(useNav.getState().route));
  useNav.subscribe(({ route }) => {
    const context = JSON.stringify(contextOf(route));
    if (context !== lastContext) {
      lastContext = context;
      void refreshStatus();
    }
  });
  // The status bar shows plain text, so this takes the click there. Commands cover the keyboard.
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(`[data-status="${STATUS_KEY}"]`)) openStylesPage();
  });
}

/** Runs again when the interface language changes, which replaces the titles. */
function registerStyleCommands() {
  registerCommands([
    {
      id: 'styles.open',
      title: t('Writing styles…'),
      menu: 'AI',
      order: 60,
      keywords: 'author voice prompt library blend',
      run: () => openStylesPage(),
    },
    {
      id: 'styles.guide',
      title: t('Your style guide…'),
      menu: 'AI',
      order: 61,
      when: hasProject,
      keywords: 'tense point of view words to avoid spelling',
      run: () => openStylesPage('guide'),
    },
    {
      id: 'styles.use',
      title: t('Use a style…'),
      menu: 'AI',
      order: 62,
      when: hasProject,
      keywords: 'author voice writing style choose',
      run: useStyleDialog,
    },
  ]);
}

export function registerWritingStyles() {
  registerStyleCommands();
  subscribeLocale(registerStyleCommands);
  startStatusItem();
}
