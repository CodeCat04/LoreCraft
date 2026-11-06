/**
 * Writing one scene. A scene's editor, autosave and scroll area all live in a component
 * keyed by the scene, so nothing can carry over from one scene to the next. Unmounting
 * writes whatever is pending, and the write is recorded so that coming straight back to
 * the scene waits for it.
 *
 * Typing must stay fast, so nothing here sets React state per keystroke, and the editor
 * itself does not re-render as the rest of the screen changes. Counts are worked out on a
 * timer after typing pauses, by parts of the screen that subscribe to them separately.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';

import { DetailsPanel } from './DetailsPanel';
import { sceneKeys, scrollRoom, typewriterScroll } from './editorExtensions';
import { nameHighlightExtension, setNameMatcher } from './nameHighlight';
import { matcherFor, type NameMatcher } from './nameMatcher';
import { sceneLabel, sceneSaverKey, useNodePatcher } from './shared';
import { splitDocAt } from './splitDoc';
import {
  clearLiveCounts,
  forgetSceneWork,
  knownUpdate,
  loadScene,
  markSceneDirty,
  newScene,
  openScene,
  rememberCursor,
  rememberKnownUpdate,
  rememberScene,
  rememberScroll,
  registerEditorFocuser,
  registerOpenScene,
  routeState,
  saveSceneContent,
  sceneHasUnsavedWork,
  scenePlace,
  setLiveCounts,
  takeLeaveFocusAlone,
  trackFlush,
  useLive,
  useWrite,
} from './store';
import { displayTitle, neighborScene } from './tree';
import { docWordCount, rangeWordCount } from './wordCount';
import { wordsText } from './WriteStatus';
import { RichEditor } from '../editor';
import { isUnreadableEditor } from '../editor/RichEditor';
import { hasUnwritten, unwrittenValue, useDocSaver } from '../editor/saving';
import { ProsePanelHost, useProse } from '../prose';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { formatNumber } from '../lib/text';
import type { Node, PmNode } from '../lib/types';
import { toast } from '../shell/toasts';
import { useDataVersion } from '../state/events';
import { useLocale } from '../state/language';
import { isFocusedPane, useIsFocusedPane, usePaneId } from '../state/nav';
import { useTitles } from '../state/project';
import { useSettings } from '../state/settings';
import { useUi } from '../state/ui';

/** How long after a change the counts catch up. Short enough to feel live. */
const COUNT_DELAY_MS = 120;

function currentMatcher(): NameMatcher | null {
  // Names are always found, so hover cards work; the setting only hides the underline.
  document.documentElement.classList.toggle('names-quiet', !useSettings.getState().settings.editor.highlightNames);
  return matcherFor(useTitles.getState().entries);
}

/** The name highlighting extension, set up from the current names and setting. */
export function nameHighlightForScene() {
  return nameHighlightExtension(currentMatcher);
}

/** Keeps an editor's highlights current as pages come and go or the setting changes. */
export function useNameHighlightSync(getEditor: () => Editor | null) {
  const entries = useTitles((s) => s.entries);
  const enabled = useSettings((s) => s.settings.editor.highlightNames);
  useEffect(() => {
    const editor = getEditor();
    document.documentElement.classList.toggle('names-quiet', !enabled);
    if (editor && !editor.isDestroyed) setNameMatcher(editor.view, matcherFor(entries));
  }, [entries, enabled, getEditor]);
}

/** Puts focus in the editor, unless the person is busy in another field or dialog. */
function focusUnlessBusy(editor: Editor) {
  const active = document.activeElement as HTMLElement | null;
  if (active?.matches('input, textarea, select') || active?.closest('.dialog, .palette')) return;
  editor.view.focus();
}

/** A click in the page's margins or under the text goes to the nearest place in the text. */
function focusNearest(editor: Editor, x: number, y: number) {
  const box = editor.view.dom.getBoundingClientRect();
  const at = editor.view.posAtCoords({
    left: Math.max(box.left + 1, Math.min(box.right - 1, x)),
    top: Math.max(box.top + 1, Math.min(box.bottom - 1, y)),
  });
  editor.commands.setTextSelection(at?.pos ?? editor.state.doc.content.size);
  editor.view.focus();
}

/** Puts back a remembered selection, finding the nearest text if the document has changed. */
function restoreSelection(editor: Editor, anchor: number, head: number) {
  const { doc, tr } = editor.state;
  const inside = (pos: number) => doc.resolve(Math.max(0, Math.min(doc.content.size, pos)));
  editor.view.dispatch(tr.setSelection(TextSelection.between(inside(anchor), inside(head))));
}

function neighborLabel(sceneId: string, direction: 1 | -1) {
  return (s: ReturnType<typeof useWrite.getState>) => {
    const node = neighborScene(s.index, sceneId, direction);
    return node ? `${node.id}\n${displayTitle(node)}` : '';
  };
}

/** The scenes before and after, under the text. It re-renders only if those change. */
const SceneNav = memo(function SceneNav({ sceneId }: { sceneId: string }) {
  useLocale();
  const [previousId, previousTitle] = useWrite(neighborLabel(sceneId, -1)).split('\n');
  const [nextId, nextTitle] = useWrite(neighborLabel(sceneId, 1)).split('\n');
  return (
    <nav className="scene-nav" aria-label={t('Scenes')}>
      {previousId ? (
        <button type="button" className="link-button scene-nav-link" onClick={() => openScene(previousId)}>
          <span aria-hidden="true">←</span>
          <span className="truncate">{previousTitle}</span>
        </button>
      ) : (
        <span />
      )}
      {nextId ? (
        <button type="button" className="link-button scene-nav-link scene-nav-next" onClick={() => openScene(nextId)}>
          <span className="truncate">{nextTitle}</span>
          <span aria-hidden="true">→</span>
        </button>
      ) : (
        <button type="button" className="link-button scene-nav-link scene-nav-next" onClick={() => void newScene(sceneId)}>
          <span>{t('New scene')}</span>
          <span aria-hidden="true">→</span>
        </button>
      )}
    </nav>
  );
});

/** A word count that fades in when the mouse moves, and Esc to leave. */
function FocusHud({ sceneId }: { sceneId: string }) {
  useLocale();
  const words = useLive((s) => (s.sceneId === sceneId ? s.words : 0));
  const selected = useLive((s) => (s.sceneId === sceneId ? s.selected : 0));
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let timer = 0;
    const onMove = () => {
      setVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setVisible(false), 1800);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <div className={`focus-hud${visible ? ' is-visible' : ''}`} data-testid="focus-hud">
      <span>
        {selected === 1
          ? t('{count} word selected', { count: formatNumber(selected) })
          : selected > 0
            ? t('{count} words selected', { count: formatNumber(selected) })
            : wordsText(words)}
      </span>
      <button type="button" className="link-button focus-hud-exit" onClick={() => useUi.getState().setFocusMode(false)}>
        {t('Esc to exit')}
      </button>
    </div>
  );
}

const SceneTitle = memo(function SceneTitle(props: {
  sceneId: string;
  titleRef: React.RefObject<HTMLTextAreaElement | null>;
  patch: (change: { title: string }) => void;
  onLeave: () => void;
}) {
  useLocale();
  const title = useWrite((s) => s.index.byId.get(props.sceneId)?.title) ?? '';
  return (
    <textarea
      ref={props.titleRef}
      className="scene-title"
      aria-label={t('Scene title')}
      placeholder={t('Untitled scene')}
      rows={1}
      spellCheck
      value={title}
      onChange={(e) => props.patch({ title: e.target.value.replace(/\s*\n\s*/g, ' ') })}
      onKeyDown={(e) => {
        const box = e.currentTarget;
        const atEnd = box.selectionStart === box.value.length;
        if (e.key === 'Enter' || (e.key === 'ArrowDown' && atEnd)) {
          e.preventDefault();
          props.onLeave();
        }
      }}
    />
  );
});

/**
 * True if the editor shows this stored text. Text this version cannot read never matches,
 * so the scene opens again and shows it read-only rather than failing here.
 */
function sameDoc(editor: Editor, content: PmNode): boolean {
  try {
    return editor.schema.nodeFromJSON(content).eq(editor.state.doc);
  } catch {
    return false;
  }
}

/**
 * Notices when something other than this editor changed the stored text: a restored
 * revision, a renamed page, a project-wide replace. It shows the new text, unless the
 * person has typed since, in which case what they typed is the newest version.
 */
function ChangedElsewhereWatcher(props: {
  id: string;
  editorRef: React.RefObject<Editor | null>;
  onChanged: (node: Node) => void;
}) {
  const { id, editorRef, onChanged } = props;
  const rowUpdatedAt = useWrite((s) => s.index.byId.get(id)?.updatedAt);
  const pagesVersion = useDataVersion('pages');
  const checkedPages = useRef(pagesVersion);
  useEffect(() => {
    // Renaming a page rewrites links in the text without touching the scene's date.
    const pagesChanged = checkedPages.current !== pagesVersion;
    checkedPages.current = pagesVersion;
    const moved = rowUpdatedAt !== undefined && rowUpdatedAt !== knownUpdate(id);
    // Text still waiting to be stored, or failing to be, is newer than anything stored.
    const unsaved = () => sceneHasUnsavedWork(id) || hasUnwritten(sceneSaverKey(id));
    if ((!moved && !pagesChanged) || unsaved()) return;
    let cancelled = false;
    loadScene(id).then(
      (stored) => {
        const editor = editorRef.current;
        if (cancelled || !editor || editor.isDestroyed || unsaved()) return;
        rememberKnownUpdate(id, stored.updatedAt);
        if (!sameDoc(editor, stored.content)) onChanged(stored);
      },
      () => {
        // The scene was deleted or the project closed, and whoever did that also moves on.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, rowUpdatedAt, pagesVersion, editorRef, onChanged]);
  return null;
}

function LoadedScene(props: { node: Node; onChangedElsewhere: (node: Node) => void }) {
  const { node, onChangedElsewhere } = props;
  const id = node.id;
  const editorRef = useRef<Editor | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const countTimer = useRef(0);
  const detailsOpen = useWrite((s) => s.detailsOpen);
  const proseOpen = useProse((s) => s.open);
  const focusMode = useUi((s) => s.focusMode);
  const showBar = useSettings((s) => s.settings.editor.showFormattingBar);
  const typewriter = useSettings((s) => s.settings.editor.typewriterScroll);
  const notesRef = useRef(node.notes);
  const paneId = usePaneId();
  const paneFocused = useIsFocusedPane();
  const { patch, flush: flushPatch } = useNodePatcher(id);

  const { schedule, flush } = useDocSaver<PmNode>((doc) => saveSceneContent(id, doc), {
    key: sceneSaverKey(id),
    label: () => sceneLabel(id),
  });
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const flushPatchRef = useRef(flushPatch);
  flushPatchRef.current = flushPatch;
  const onChangedElsewhereRef = useRef(onChangedElsewhere);
  onChangedElsewhereRef.current = onChangedElsewhere;

  const refreshCounts = useCallback(() => {
    countTimer.current = 0;
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    const { doc, selection } = editor.state;
    setLiveCounts(id, docWordCount(doc), selection.empty ? 0 : rangeWordCount(doc, selection.from, selection.to));
  }, [id]);

  const scheduleCounts = useCallback(() => {
    if (!countTimer.current) countTimer.current = window.setTimeout(refreshCounts, COUNT_DELAY_MS);
  }, [refreshCounts]);

  const extensions = useMemo(
    () => [
      nameHighlightForScene(),
      sceneKeys({
        onEndOfScene: () => {
          // This editor stays up for a moment after the next scene has been asked for.
          if (routeState().nodeId === id) void newScene(id);
        },
        onLeaveTop: () => {
          const box = titleRef.current;
          box?.focus();
          box?.setSelectionRange(box.value.length, box.value.length);
        },
      }),
      scrollRoom(),
      typewriterScroll(() => useSettings.getState().settings.editor.typewriterScroll),
    ],
    [id],
  );

  const onReady = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;
      // The names may have changed in the moment before the editor was ready.
      setNameMatcher(editor.view, currentMatcher());
      const place = scenePlace(id);
      if (place && place.anchor > 0) restoreSelection(editor, place.anchor, place.head);
      editor.on('selectionUpdate', () => {
        const { anchor, head } = editor.state.selection;
        rememberCursor(id, anchor, head);
        scheduleCounts();
      });
      // A scene opening in the pane beside must not take over the status bar or the keyboard.
      const inFocusedPane = isFocusedPane(paneId);
      if (inFocusedPane) refreshCounts();
      registerEditorFocuser(paneId, () => {
        if (!editor.isDestroyed) editor.view.focus();
      });
      registerOpenScene(paneId, {
        id,
        pause: () => editor.setEditable(false, false),
        resume: () => {
          if (editor.isDestroyed) return;
          // Text this version cannot read stays read-only.
          editor.setEditable(!isUnreadableEditor(editor), false);
          editor.view.focus();
        },
        // What shows of a scene this version cannot read is not the scene, so it never splits.
        partsAtCursor: () =>
          isUnreadableEditor(editor) ? null : splitDocAt(editor.state.doc, editor.state.selection.from),
        flush: () => Promise.all([flushRef.current(), flushPatchRef.current()]),
        reload: () => {
          loadScene(id).then(
            (stored) => {
              rememberKnownUpdate(id, stored.updatedAt);
              onChangedElsewhereRef.current(stored);
            },
            // It stays read-only, because what it shows is out of date.
            (e) => toast(t('Could not show the new text of this scene: {reason}', { reason: errorMessage(e) }), 'error'),
          );
        },
      });
      if (!takeLeaveFocusAlone() && inFocusedPane) focusUnlessBusy(editor);
      if (place && place.scrollTop < 0) editor.commands.scrollIntoView();
      else if (place && scrollerRef.current) scrollerRef.current.scrollTop = place.scrollTop;
    },
    [id, paneId, refreshCounts, scheduleCounts],
  );

  const onChange = useCallback(
    (doc: PmNode) => {
      markSceneDirty(id);
      schedule(doc);
      scheduleCounts();
    },
    [id, schedule, scheduleCounts],
  );

  useLayoutEffect(() => {
    const place = scenePlace(id);
    if (place && place.scrollTop > 0 && scrollerRef.current) scrollerRef.current.scrollTop = place.scrollTop;
  }, [id]);

  useEffect(() => {
    rememberKnownUpdate(id, node.updatedAt);
    return () => {
      window.clearTimeout(countTimer.current);
      trackFlush(id, Promise.all([flush(), flushPatch()]).finally(() => forgetSceneWork(id)));
      clearLiveCounts(id);
      registerEditorFocuser(paneId, null);
      registerOpenScene(paneId, null);
      editorRef.current = null;
    };
    // Runs once per scene. `node` is fixed for the life of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // The counts in the status bar follow the pane in use.
  useEffect(() => {
    if (paneFocused && editorRef.current) refreshCounts();
  }, [paneFocused, refreshCounts]);

  useNameHighlightSync(useCallback(() => editorRef.current, []));

  // Whatever was clicked to go in or out of focus mode has just disappeared, and the page
  // has changed width, so the line being written may have moved out of sight.
  const wasFocusMode = useRef(focusMode);
  useEffect(() => {
    const editor = editorRef.current;
    if (wasFocusMode.current !== focusMode && editor) {
      focusUnlessBusy(editor);
      editor.commands.scrollIntoView();
    }
    wasFocusMode.current = focusMode;
  }, [focusMode]);

  const toolbar = showBar && !focusMode;
  const source = useMemo(() => ({ kind: 'node' as const, id, title: displayTitle(node) }), [id, node]);
  // Only what the editor really depends on can re-render it.
  const editor = useMemo(
    () => (
      <RichEditor
        docKey={id}
        content={node.content}
        editable
        variant="manuscript"
        placeholder={t('Start writing this scene…')}
        toolbar={toolbar}
        source={source}
        extensions={extensions}
        onChange={onChange}
        onReady={onReady}
      />
    ),
    [id, node.content, toolbar, source, extensions, onChange, onReady],
  );

  const focusText = useCallback(() => editorRef.current?.view.focus(), []);

  return (
    <div className={`scene-layout${focusMode ? ' is-focus' : ''}`}>
      <ChangedElsewhereWatcher id={id} editorRef={editorRef} onChanged={onChangedElsewhere} />
      <div
        className={`write-scroll${typewriter ? ' is-typewriter' : ''}`}
        ref={scrollerRef}
        onScroll={(e) => rememberScroll(id, e.currentTarget.scrollTop)}
        onMouseDown={(e) => {
          // The margins and the space under the text act like part of the page. The
          // scrollbar belongs to this element too, and has to be left alone.
          const scroller = e.currentTarget;
          const onScrollbar = e.clientX >= scroller.getBoundingClientRect().left + scroller.clientWidth;
          const target = e.target as HTMLElement;
          if (!onScrollbar && editorRef.current && (target === scroller || target.classList.contains('write-page'))) {
            e.preventDefault();
            focusNearest(editorRef.current, e.clientX, e.clientY);
          }
        }}
      >
        <div className="write-page">
          <SceneTitle sceneId={id} titleRef={titleRef} patch={patch} onLeave={focusText} />
          {editor}
          {!focusMode && <SceneNav sceneId={id} />}
        </div>
      </div>
      {detailsOpen && !proseOpen && !focusMode && <DetailsPanel node={node} notesRef={notesRef} patch={patch} />}
      <ProsePanelHost sceneId={id} />
      {focusMode && <FocusHud sceneId={id} />}
    </div>
  );
}

/** Loads a scene. The old one stays on screen until the new one is ready, to avoid a flash. */
export const SceneEditor = memo(function SceneEditor({ sceneId, bookId }: { sceneId: string; bookId: string }) {
  const [loaded, setLoaded] = useState<{ node: Node; revision: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    rememberScene(bookId, sceneId);
  }, [bookId, sceneId]);

  useEffect(() => {
    setProblem(null);
    if (loaded?.node.id === sceneId) return;
    let cancelled = false;
    loadScene(sceneId).then(
      (stored) => {
        // Text that could not be stored yet is the newest, so it is what opens.
        const unwritten = unwrittenValue<PmNode>(sceneSaverKey(sceneId));
        const node = unwritten ? { ...stored, content: unwritten } : stored;
        if (!cancelled) setLoaded({ node, revision: 0 });
      },
      (e) => {
        if (!cancelled) setProblem(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sceneId, loaded?.node.id]);

  const onChangedElsewhere = useCallback((node: Node) => {
    setLoaded((current) => (current?.node.id === node.id ? { node, revision: current.revision + 1 } : current));
  }, []);

  if (problem) {
    return (
      <div className="view-pad" role="alert">
        <p>This scene could not be opened: {problem}</p>
      </div>
    );
  }
  if (!loaded) return <div className="write-loading" />;
  return (
    <LoadedScene
      key={`${loaded.node.id}:${loaded.revision}`}
      node={loaded.node}
      onChangedElsewhere={onChangedElsewhere}
    />
  );
});
