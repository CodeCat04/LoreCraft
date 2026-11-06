/** The main area of Write: works out what the route asks for and shows that view. */

import { useEffect } from 'react';

import { Corkboard } from './Corkboard';
import { Outline } from './Outline';
import { PresenceChart } from './PresenceChart';
import { ReadThrough } from './ReadThrough';
import { SceneCopy } from './SceneCopy';
import { SceneEditor } from './SceneEditor';
import { WriteDataSync } from './shared';
import {
  goToMode,
  lastScene,
  newBook,
  newScene,
  rememberScene,
  routeState,
  selectBook,
  setDetailsOpen,
  stepScene,
  syncNow,
  useWrite,
} from './store';
import { chapterOf, neighborScene, scenesUnder } from './tree';
import { ThreadBoard } from './ThreadBoard';
import { TrashView } from './TrashView';
import * as api from './api';
import { t } from '../lib/i18n';
import { useDocClaim } from '../state/docs';
import { useLocale } from '../state/language';
import { isFocusedPane, useIsFocusedPane, useNav, usePaneId, type WriteMode } from '../state/nav';
import { activeTab } from '../state/tabs';
import { setProseOpen, useProse } from '../prose';
import { useUi } from '../state/ui';

function modes(): { mode: WriteMode; label: string; title: string }[] {
  return [
    { mode: 'scene', label: t('Scene'), title: t('Write one scene ({shortcut})', { shortcut: 'Ctrl+Alt+1' }) },
    { mode: 'read', label: t('Chapter'), title: t('Read a whole chapter ({shortcut})', { shortcut: 'Ctrl+Alt+2' }) },
    { mode: 'cork', label: t('Corkboard'), title: t('Scenes as index cards ({shortcut})', { shortcut: 'Ctrl+Alt+3' }) },
    { mode: 'outline', label: t('Outline'), title: t('The whole book as a table ({shortcut})', { shortcut: 'Ctrl+Alt+4' }) },
    { mode: 'threads', label: t('Threads'), title: t('Plot threads across the chapters ({shortcut})', { shortcut: 'Ctrl+Alt+5' }) },
    {
      mode: 'presence',
      label: t('Presence'),
      title: t('Which characters appear in which chapters ({shortcut})', { shortcut: 'Ctrl+Alt+6' }),
    },
  ];
}

export function toggleFocusMode() {
  const ui = useUi.getState();
  if (ui.focusMode) {
    ui.setFocusMode(false);
    return;
  }
  // Focus mode is for writing, so it always shows a scene. If this pane has none and the one
  // beside it does, that is the scene being written.
  const { mode } = routeState();
  const nav = useNav.getState();
  if (nav.route.view !== 'write' || mode !== 'scene') {
    const beside = nav.panes.find((p) => p.id !== nav.focusedPaneId);
    const route = beside ? activeTab(beside).route : null;
    if (beside && route?.view === 'write' && (route.mode ?? 'scene') === 'scene') nav.focusPane(beside.id);
    else switchMode('scene');
  }
  ui.setFocusMode(true);
}

/** Changes view while keeping to the same part of the book where that makes sense. */
export function switchMode(mode: WriteMode) {
  const { index, bookId } = useWrite.getState();
  const { nodeId } = routeState();
  const node = nodeId ? index.byId.get(nodeId) : undefined;
  const remembered = bookId ? lastScene(bookId) : undefined;
  switch (mode) {
    case 'scene': {
      // The selected scene, or the first in the selected chapter or part.
      const scene = (node ? scenesUnder(index, node.id)[0]?.id : undefined) ?? remembered;
      goToMode('scene', scene && index.byId.has(scene) ? scene : undefined);
      break;
    }
    case 'read':
      goToMode('read', nodeId ?? remembered);
      break;
    case 'cork': {
      // The corkboard starts at the chapter in hand, with the whole book one click away.
      const chapter = nodeId ? chapterOf(index, nodeId) : undefined;
      goToMode('cork', chapter?.id ?? (node?.kind === 'part' ? node.id : undefined));
      break;
    }
    default:
      goToMode(mode, nodeId);
  }
}

function WriteBar({ mode, sceneId }: { mode: WriteMode; sceneId: string | null }) {
  useLocale();
  const detailsOpen = useWrite((s) => s.detailsOpen);
  const proseOpen = useProse((s) => s.open);
  const hasPrevious = useWrite((s) => (sceneId ? !!neighborScene(s.index, sceneId, -1) : false));
  const hasNext = useWrite((s) => (sceneId ? !!neighborScene(s.index, sceneId, 1) : false));
  return (
    <div className="write-bar">
      <div className="write-modes" role="group" aria-label={t('View')}>
        {modes().map((m) => (
          <button
            key={m.mode}
            type="button"
            className={`write-mode${mode === m.mode ? ' is-active' : ''}`}
            aria-pressed={mode === m.mode}
            title={m.title}
            onClick={() => switchMode(m.mode)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <span className="write-bar-spacer" />
      {mode === 'scene' && sceneId && (
        <>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!hasPrevious}
            title={t('Previous scene ({shortcut})', { shortcut: 'Ctrl+Alt+Up' })}
            aria-label={t('Previous scene')}
            onClick={() => stepScene(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!hasNext}
            title={t('Next scene ({shortcut})', { shortcut: 'Ctrl+Alt+Down' })}
            aria-label={t('Next scene')}
            onClick={() => stepScene(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className={`btn btn-sm${detailsOpen ? ' is-on' : ''}`}
            aria-pressed={detailsOpen}
            title={t('Show or hide scene details ({shortcut})', { shortcut: 'Ctrl+Alt+D' })}
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            {t('Details')}
          </button>
          <button
            type="button"
            className={`btn btn-sm${proseOpen ? ' is-on' : ''}`}
            aria-pressed={proseOpen}
            title={t('Prose checks and read-aloud ({shortcut})', { shortcut: 'Ctrl+Alt+P' })}
            onClick={() => setProseOpen(!proseOpen)}
          >
            {t('Prose')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            title={t('Hide everything except the page ({shortcut})', { shortcut: 'F11' })}
            onClick={toggleFocusMode}
          >
            {t('Focus')}
          </button>
        </>
      )}
    </div>
  );
}

function EmptyBook() {
  useLocale();
  return (
    <div className="write-empty">
      <h1 className="write-empty-title">{t('Nothing written yet')}</h1>
      <p className="muted">{t('This book has no scenes. Add one and start writing.')}</p>
      <button type="button" className="btn btn-primary" onClick={() => void newScene()}>
        {t('Add a scene')}
      </button>
    </div>
  );
}

function OtherBook() {
  useLocale();
  return (
    <div className="write-empty">
      <p className="muted">{t('This view is of another book. Click in this pane to work on it.')}</p>
    </div>
  );
}

function NoBooks() {
  useLocale();
  return (
    <div className="write-empty">
      <h1 className="write-empty-title">{t('No books yet')}</h1>
      <p className="muted">{t('A project can hold a whole series. Add the first book to begin.')}</p>
      <button type="button" className="btn btn-primary" onClick={() => void newBook()}>
        {t('Add a book')}
      </button>
    </div>
  );
}

/**
 * One scene, editable unless another pane is already editing it. The second copy only reads,
 * so the two can never overwrite each other.
 */
function SceneSlot({ sceneId, bookId }: { sceneId: string; bookId: string }) {
  useLocale();
  const claim = useDocClaim(`node:${sceneId}`, true);
  // Focus mode shows only this pane, and it is for writing.
  const focusMode = useUi((s) => s.focusMode);
  const paneFocused = useIsFocusedPane();
  const writingHere = focusMode && paneFocused;
  const blocked = claim.state === 'blocked';
  const { takeOver } = claim;
  useEffect(() => {
    if (writingHere && blocked) takeOver();
    // `takeOver` is a new function each time, and stands for the same thing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writingHere, blocked]);
  if (blocked) {
    return (
      <SceneCopy
        sceneId={sceneId}
        note={t('This scene is being edited in the other pane. This copy follows along as the text is saved.')}
        action={{ label: t('Edit here'), run: claim.takeOver }}
      />
    );
  }
  return <SceneEditor sceneId={sceneId} bookId={bookId} />;
}

export function WriteView({ bookId: routeBook, nodeId }: { bookId?: string; nodeId?: string }) {
  useLocale();
  const mode = useNav((s) => (s.route.view === 'write' ? (s.route.mode ?? 'scene') : 'scene'));
  const replace = useNav((s) => s.replace);
  const paneId = usePaneId();
  const paneFocused = useIsFocusedPane();
  const ready = useWrite((s) => s.ready);
  const bookId = useWrite((s) => s.bookId);
  const hasBooks = useWrite((s) => s.books.length > 0);
  const hasScenes = useWrite((s) => s.index.scenes.length > 0);
  const focusMode = useUi((s) => s.focusMode);
  // Only plain values from the tree here. The tree changes as words are typed, and this
  // component holds the editor, which must not re-render with it.
  const nodeKind = useWrite((s) => (nodeId ? s.index.byId.get(nodeId)?.kind : undefined));
  const node = nodeKind ? nodeId : undefined;
  // The Write area is on one book at a time, the one in the focused pane. A pane in the
  // background that is on another book waits, showing what it can without the book's tree.
  const elsewhere =
    !paneFocused && ready && (routeBook ? routeBook !== bookId : Boolean(nodeId) && !nodeKind);

  // Follow the book the route names.
  useEffect(() => {
    if (routeBook && paneFocused) selectBook(routeBook);
  }, [routeBook, paneFocused]);

  // Fill in what the route leaves out, and correct what no longer exists.
  useEffect(() => {
    const state = useWrite.getState();
    if (!state.ready) return;
    if (routeBook && routeBook !== state.bookId) {
      if (state.books.some((b) => b.id === routeBook)) {
        if (paneFocused) selectBook(routeBook);
        return;
      }
      // The book it named is gone.
      replace({ view: 'write', bookId: state.bookId ?? undefined, mode });
      return;
    }
    const known = nodeId ? state.index.byId.get(nodeId) : undefined;
    if (nodeId && !known) {
      // The node may be in another book, because links from the wiki do not always say.
      // Or it may be brand new, and the tree here just has not been told yet.
      let cancelled = false;
      void api.nodes.get(nodeId).then(
        (found) => {
          if (cancelled) return;
          if (found.deletedAt) replace({ view: 'write', bookId: state.bookId ?? undefined, mode });
          // Only the focused pane decides which book the Write area is on.
          else if (!paneFocused) return;
          else if (found.bookId !== state.bookId) selectBook(found.bookId);
          else void syncNow();
        },
        () => {
          if (!cancelled) replace({ view: 'write', bookId: state.bookId ?? undefined, mode });
        },
      );
      return () => {
        cancelled = true;
      };
    }
    if (mode === 'scene' && state.bookId) {
      if (known && known.kind !== 'scene') {
        // Chapters and parts have no text of their own, so show what is in them.
        replace({
          view: 'write',
          bookId: state.bookId,
          nodeId: known.id,
          mode: known.kind === 'part' ? 'cork' : 'read',
        });
        return;
      }
      if (!known) {
        const remembered = lastScene(state.bookId);
        const scene =
          (remembered && state.index.byId.has(remembered) ? remembered : undefined) ?? state.index.scenes[0]?.id;
        if (scene) replace({ view: 'write', bookId: state.bookId, nodeId: scene });
        else if (!routeBook) replace({ view: 'write', bookId: state.bookId });
      }
    } else if (!routeBook && state.bookId) {
      replace({ view: 'write', bookId: state.bookId, nodeId, mode });
    }
    return undefined;
  }, [ready, bookId, routeBook, nodeId, mode, nodeKind, hasScenes, replace, paneFocused]);

  useEffect(() => {
    if (bookId && nodeKind === 'scene' && nodeId && paneFocused) rememberScene(bookId, nodeId);
  }, [bookId, nodeId, nodeKind, paneFocused]);

  // Focus mode belongs to the screen in the focused pane. Leaving it brings the rest back.
  useEffect(
    () => () => {
      if (isFocusedPane(paneId)) useUi.getState().setFocusMode(false);
    },
    [paneId],
  );
  useEffect(() => {
    if (paneFocused && focusMode && ready && (mode !== 'scene' || !hasScenes)) useUi.getState().setFocusMode(false);
  }, [paneFocused, focusMode, ready, mode, hasScenes]);
  useEffect(() => {
    if (!focusMode) return;
    // A dialog or the palette stops Escape before it reaches here. The editor marks every
    // Escape as handled even though it does nothing with it, so that cannot be the test.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) useUi.getState().setFocusMode(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode]);

  let body: React.ReactNode = <div className="write-loading" />;
  if (ready) {
    if (elsewhere && nodeId && mode === 'scene') {
      body = <SceneCopy sceneId={nodeId} note={t('This scene is in another book. Click in this pane to work on it.')} />;
    } else if (elsewhere) {
      body = <OtherBook />;
    } else if (!hasBooks) body = <NoBooks />;
    else if (mode === 'trash') body = <TrashView />;
    else if (mode === 'outline') body = <Outline />;
    else if (mode === 'threads') body = <ThreadBoard />;
    else if (mode === 'presence') body = <PresenceChart />;
    else if (mode === 'cork') body = <Corkboard nodeId={node} />;
    else if (mode === 'read') body = <ReadThrough nodeId={node} />;
    else if (nodeKind === 'scene' && node && bookId) body = <SceneSlot sceneId={node} bookId={bookId} />;
    else if (!hasScenes) body = <EmptyBook />;
  }

  return (
    <div className="write-view">
      <WriteDataSync />
      {!focusMode && hasBooks && !elsewhere && <WriteBar mode={mode} sceneId={nodeKind === 'scene' && node ? node : null} />}
      <div className="write-body">{body}</div>
    </div>
  );
}
