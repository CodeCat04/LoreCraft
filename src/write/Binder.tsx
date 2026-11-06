/**
 * The sidebar: book switcher, the part, chapter and scene tree, and progress.
 *
 * The tree is one flat list of rows with fixed height, marked up as a flat ARIA tree.
 * Rows only re-render when their own values change, and all of a drag's feedback is one
 * line drawn over the list, so a book of hundreds of scenes stays smooth.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';

import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { dropRefAt } from '../canvas/refDrag';
import { CSS } from '@dnd-kit/utilities';

import { openBookSettings } from './BookSettings';
import { dragAnnouncements, pointerFromEvent, setDragRefused, useDragPointer } from './dragPointer';
import { openSceneHistory } from './history/SceneHistory';
import { StatusMarker, WriteDataSync, statusLabel } from './shared';
import {
  deleteNode,
  dismissUndo,
  expandTo,
  focusOpenEditor,
  goToMode,
  mergeWithNext,
  moveBook,
  moveNode,
  newBook,
  newChapter,
  newPart,
  newScene,
  openNode,
  openSceneId,
  renameNode,
  reorderBooks,
  routeState,
  selectBook,
  splitOpenScene,
  toggleCollapsed,
  undoLastDelete,
  useWrite,
} from './store';
import {
  canContain,
  displayTitle,
  moveStep,
  neighborScene,
  planDrop,
  planDropAtEnd,
  refusalText,
  visibleRows,
  zoneAt,
  type BinderRow,
  type DropMarker,
  type DropPlan,
} from './tree';
import { WriteStatus } from './WriteStatus';
import { t } from '../lib/i18n';
import { formatNumber } from '../lib/text';
import type { NodeKind, NodeStatus } from '../lib/types';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useSettings } from '../state/settings';

function renameLabel(kind: NodeKind): string {
  if (kind === 'part') return t('Rename part');
  if (kind === 'chapter') return t('Rename chapter');
  return t('Rename scene');
}

/**
 * Lives out here because a new object each render would make dnd-kit treat its sensors
 * as changed, and that wakes up every row in the tree.
 */
const POINTER_OPTIONS = { activationConstraint: { distance: 5 } };

/** Words in a label: "1 word", "2 words". */
function wordsLabel(words: number): string {
  return words === 1 ? t('{count} word', { count: formatNumber(words) }) : t('{count} words', { count: formatNumber(words) });
}

/** How a screen reader names a row: its title, what it is, its words and a scene's status. */
function rowLabel(title: string, kind: NodeKind, words: string, status: string): string {
  if (kind === 'part') return t('{title}, part, {words}', { title, words });
  if (kind === 'chapter') return t('{title}, chapter, {words}', { title, words });
  return t('{title}, scene, {words}, {status}', { title, words, status });
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

interface RowProps {
  id: string;
  kind: NodeKind;
  title: string;
  status: NodeStatus;
  depth: number;
  words: number;
  hasChildren: boolean;
  open: boolean;
  place: number;
  siblings: number;
  selected: boolean;
  tabbable: boolean;
  renaming: boolean;
  onRename: (id: string | null) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onFocusRow: (id: string) => void;
}

const Row = memo(function Row(props: RowProps) {
  const { id, kind, title, status, depth, words, hasChildren, open, selected, tabbable, renaming } = props;
  useLocale();
  const { setNodeRef, listeners, isDragging } = useDraggable({ id, disabled: renaming });
  const shown = displayTitle({ title, kind });
  const statusText = statusLabel(status).toLowerCase();
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      className={`binder-row binder-row-${kind}${selected ? ' is-selected' : ''}${isDragging ? ' is-dragging' : ''}`}
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={props.place}
      aria-setsize={props.siblings}
      aria-selected={selected}
      aria-expanded={hasChildren ? open : undefined}
      aria-label={rowLabel(shown, kind, wordsLabel(words), statusText)}
      tabIndex={tabbable ? 0 : -1}
      data-row-id={id}
      style={{ paddingLeft: `${0.25 + depth * 0.875}rem` }}
      title={shown}
      onClick={() => {
        if (!renaming) openNode(id);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        props.onRename(id);
      }}
      onFocus={(e) => {
        if (e.target === e.currentTarget) props.onFocusRow(id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(id, e.clientX, e.clientY);
      }}
    >
      {hasChildren ? (
        <button
          type="button"
          className="binder-twisty"
          tabIndex={-1}
          aria-hidden="true"
          // Opening a branch while writing should leave the cursor in the text.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            toggleCollapsed(id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <span className={`binder-chevron${open ? ' is-open' : ''}`} />
        </button>
      ) : (
        <span className="binder-twisty" aria-hidden="true" />
      )}
      {kind === 'scene' && <StatusMarker status={status} />}
      {renaming ? (
        <RenameInput
          initial={title}
          label={renameLabel(kind)}
          onDone={(value) => {
            if (value !== null) void renameNode(id, value);
            props.onRename(null);
          }}
        />
      ) : (
        <span className="binder-title truncate">{shown}</span>
      )}
      {!renaming && <span className="binder-words">{formatNumber(words)}</span>}
    </div>
  );
});

function RenameInput(props: { initial: string; label: string; onDone: (value: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const finish = (value: string | null) => {
    if (finished.current) return;
    finished.current = true;
    props.onDone(value);
  };
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="input binder-rename"
      aria-label={props.label}
      defaultValue={props.initial}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.stopPropagation();
          finish(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// The menu on a row
// ---------------------------------------------------------------------------

interface MenuState {
  id: string;
  x: number;
  y: number;
}

function RowMenu(props: { menu: MenuState; onClose: () => void; onRename: (id: string) => void }) {
  useLocale();
  const { menu, onClose, onRename } = props;
  const ref = useRef<HTMLDivElement>(null);
  const index = useWrite((s) => s.index);
  const node = index.byId.get(menu.id);

  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    // Keep the whole menu on screen.
    setPosition({
      left: Math.min(menu.x, window.innerWidth - box.width - 8),
      top: Math.min(menu.y, window.innerHeight - box.height - 8),
    });
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);

  if (!node) return null;
  const up = moveStep(index, node.id, -1);
  const down = moveStep(index, node.id, 1);
  const act = (run: () => void) => () => {
    onClose();
    run();
  };

  return (
    <div
      ref={ref}
      className="menu-popup binder-menu"
      role="menu"
      aria-label={t('Actions for {title}', { title: displayTitle(node) })}
      style={{ position: 'fixed', left: position.left, top: position.top }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'Escape') onClose();
        else if (e.key === 'ArrowDown') {
          e.preventDefault();
          items[(at + 1) % items.length]?.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          items[(at - 1 + items.length) % items.length]?.focus();
        } else if (e.key === 'Tab') {
          onClose();
        }
      }}
    >
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => openNode(node.id))}>
        {t('Open')}
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => onRename(node.id))}>
        <span>{t('Rename')}</span>
        <span className="menu-shortcut">F2</span>
      </button>
      <div className="menu-sep" />
      {node.kind !== 'part' && (
        <button type="button" role="menuitem" className="menu-item" onClick={act(() => void newScene(node.id))}>
          {node.kind === 'scene' ? t('Add scene after this') : t('Add scene in this chapter')}
        </button>
      )}
      {node.kind !== 'scene' && (
        <button type="button" role="menuitem" className="menu-item" onClick={act(() => void newChapter(node.id))}>
          {node.kind === 'part' ? t('Add chapter in this part') : t('Add chapter after this')}
        </button>
      )}
      {node.kind === 'scene' && (
        <>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={openSceneId() !== node.id}
            title={openSceneId() === node.id ? undefined : t('Open this scene and put the cursor where the new one should begin')}
            onClick={act(() => void splitOpenScene())}
          >
            <span>{t('Split at the cursor')}</span>
            <span className="menu-shortcut">Ctrl+Alt+S</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!neighborScene(index, node.id, 1)}
            onClick={act(() => void mergeWithNext(node.id))}
          >
            <span>{t('Merge with next scene')}</span>
            <span className="menu-shortcut">Ctrl+Alt+M</span>
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={act(() => void openSceneHistory(node.id))}>
            {t('History…')}
          </button>
        </>
      )}
      <div className="menu-sep" />
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        disabled={!up}
        onClick={act(() => up && void moveNode(node.id, up.parentId, up.index))}
      >
        <span>{t('Move up')}</span>
        <span className="menu-shortcut">Alt+Up</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        disabled={!down}
        onClick={act(() => down && void moveNode(node.id, down.parentId, down.index))}
      >
        <span>{t('Move down')}</span>
        <span className="menu-shortcut">Alt+Down</span>
      </button>
      <div className="menu-sep" />
      <button type="button" role="menuitem" className="menu-item" onClick={act(() => void deleteNode(node.id))}>
        <span>{t('Delete')}</span>
        <span className="menu-shortcut">Del</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

interface DragState {
  id: string;
  plan: DropPlan;
  line: { top: number; left: number; refused: boolean; inside: boolean; height: number } | null;
}

/** How long a closed branch must be hovered during a drag before it opens. */
const OPEN_DELAY_MS = 650;

function BinderTree() {
  const locale = useLocale();
  const index = useWrite((s) => s.index);
  const collapsed = useWrite((s) => s.collapsed);
  const selectedId = useNav((s) => (s.route.view === 'write' ? (s.route.nodeId ?? null) : null));
  const rows = useMemo(() => visibleRows(index, collapsed), [index, collapsed]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<{ id: string; timer: number } | null>(null);
  const typed = useRef({ text: '', at: 0 });

  // The row that Tab lands on: the last one focused, or the open item, or the first.
  const tabId = useMemo(() => {
    if (focusId && rows.some((r) => r.id === focusId)) return focusId;
    if (selectedId && rows.some((r) => r.id === selectedId)) return selectedId;
    return rows[0]?.id ?? null;
  }, [rows, focusId, selectedId]);

  const rowElement = useCallback(
    (id: string) => treeRef.current?.querySelector<HTMLElement>(`[data-row-id="${id}"]`) ?? null,
    [],
  );

  // The open item's row should be visible, whichever way it was opened. Only when it
  // changes, though: closing the branch around it afterwards is the person's choice.
  const ready = useWrite((s) => s.ready);
  useEffect(() => {
    if (!selectedId || !ready) return undefined;
    expandTo(selectedId);
    const frame = requestAnimationFrame(() => rowElement(selectedId)?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [selectedId, ready, rowElement]);

  const focusRow = useCallback(
    (id: string | undefined) => {
      if (!id) return;
      setFocusId(id);
      const el = rowElement(id);
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    },
    [rowElement],
  );

  const openMenuAt = useCallback((id: string, x: number, y: number) => setMenu({ id, x, y }), []);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const closeMenu = useCallback(() => {
    const id = menuRef.current?.id;
    setMenu(null);
    // Back to the row, unless the chosen action has already moved focus somewhere.
    window.setTimeout(() => {
      const active = document.activeElement;
      if (id && (!active || active === document.body)) rowElement(id)?.focus();
    }, 0);
  }, [rowElement]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // During a drag the keys belong to dnd-kit, which listens for Escape further up.
    if (renamingId || draggingId || (e.target as HTMLElement).tagName === 'INPUT') return;
    const at = rows.findIndex((r) => r.id === tabId);
    const row = rows[at];
    if (!row) return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    // Only Alt alone. Ctrl+Alt with these arrows goes to another scene, and must get through.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      handled();
      const step = moveStep(index, row.id, e.key === 'ArrowUp' ? -1 : 1);
      if (step) void moveNode(row.id, step.parentId, step.index).then(() => focusRow(row.id));
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowDown':
        handled();
        focusRow(rows[at + 1]?.id);
        break;
      case 'ArrowUp':
        handled();
        focusRow(rows[at - 1]?.id);
        break;
      case 'Home':
        handled();
        focusRow(rows[0]?.id);
        break;
      case 'End':
        handled();
        focusRow(rows[rows.length - 1]?.id);
        break;
      case 'ArrowRight':
        handled();
        if (row.hasChildren && !row.open) toggleCollapsed(row.id, true);
        else if (row.hasChildren) focusRow(rows[at + 1]?.id);
        break;
      case 'ArrowLeft':
        handled();
        if (row.hasChildren && row.open) toggleCollapsed(row.id, false);
        else if (row.parentId) focusRow(row.parentId);
        break;
      case 'Enter':
        handled();
        openNode(row.id);
        break;
      case 'Escape':
        handled();
        focusOpenEditor();
        break;
      case 'F2':
        handled();
        setRenamingId(row.id);
        break;
      case 'Delete':
        handled();
        void deleteNode(row.id).then(() => {
          // Whatever now sits in its place, read after the fact: the row below may have
          // been inside the branch that just went.
          const state = useWrite.getState();
          const left = visibleRows(state.index, state.collapsed);
          focusRow(left[Math.min(at, left.length - 1)]?.id);
        });
        break;
      case 'ContextMenu': {
        handled();
        const box = rowElement(row.id)?.getBoundingClientRect();
        if (box) setMenu({ id: row.id, x: box.left + 24, y: box.bottom });
        break;
      }
      default:
        if (e.key === 'F10' && e.shiftKey) {
          handled();
          const box = rowElement(row.id)?.getBoundingClientRect();
          if (box) setMenu({ id: row.id, x: box.left + 24, y: box.bottom });
        } else if (e.key.length === 1 && e.key !== ' ') {
          // Typing jumps to the next row that starts with those letters.
          handled();
          const now = performance.now();
          const text = now - typed.current.at > 800 ? e.key : typed.current.text + e.key;
          typed.current = { text, at: now };
          const lower = text.toLowerCase();
          const ordered = [...rows.slice(at + (text.length === 1 ? 1 : 0)), ...rows.slice(0, at)];
          focusRow(ordered.find((r) => displayTitle(r).toLowerCase().startsWith(lower))?.id);
        }
    }
  };

  // ---- Dragging ------------------------------------------------------------

  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS));
  const draggingId = drag?.id ?? null;
  // The drop acts on the plan from the last pointer move, whether or not React has drawn it.
  const planRef = useRef<DropPlan>({ kind: 'none' });

  const lineFor = useCallback(
    (marker: DropMarker | undefined, refused: boolean): DragState['line'] => {
      if (!marker) return null;
      const el = rowElement(marker.rowId);
      if (!el) return null;
      const height = el.offsetHeight;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return {
        top: marker.edge === 'bottom' ? el.offsetTop + height : el.offsetTop,
        left: (0.25 + marker.depth * 0.875) * rem,
        refused,
        inside: marker.edge === 'inside',
        height,
      };
    },
    [rowElement],
  );

  const updateDrop = useCallback(() => {
    if (!draggingId) return;
    const { x, y } = pointer.current;
    const state = useWrite.getState();
    const dragged = state.index.byId.get(draggingId);
    if (!dragged) return;
    const under = document.elementFromPoint(x, y);
    const inTree = under?.closest('.binder-tree');
    let plan: DropPlan = { kind: 'none' };
    let hoverClosed: string | null = null;
    if (inTree) {
      const rowEl = under?.closest<HTMLElement>('[data-row-id]');
      const overId = rowEl?.getAttribute('data-row-id');
      const over = overId ? state.index.byId.get(overId) : undefined;
      if (rowEl && over) {
        const box = rowEl.getBoundingClientRect();
        const zone = zoneAt((y - box.top) / box.height, canContain(over.kind, dragged.kind));
        plan = planDrop(state.index, state.collapsed, draggingId, over.id, zone);
        if (zone === 'inside' && state.collapsed.has(over.id)) hoverClosed = over.id;
      } else {
        plan = planDropAtEnd(state.index, state.collapsed, draggingId);
      }
    }
    // A closed chapter opens when held over, like folders in a file manager.
    if (openTimer.current?.id !== hoverClosed) {
      if (openTimer.current) window.clearTimeout(openTimer.current.timer);
      openTimer.current = hoverClosed
        ? {
            id: hoverClosed,
            timer: window.setTimeout(() => {
              if (hoverClosed) toggleCollapsed(hoverClosed, true);
              openTimer.current = null;
            }, OPEN_DELAY_MS),
          }
        : null;
    }
    const refused = plan.kind === 'refused';
    setDragRefused(refused);
    planRef.current = plan;
    const marker = plan.kind === 'none' ? undefined : plan.marker;
    const line = lineFor(marker, refused);
    // Most pointer moves stay over the same part of the same row, and change nothing.
    setDrag((current) =>
      current && JSON.stringify(current.plan) === JSON.stringify(plan) && JSON.stringify(current.line) === JSON.stringify(line)
        ? current
        : { id: draggingId, plan, line },
    );
  }, [draggingId, lineFor]);

  const pointer = useDragPointer(draggingId !== null, updateDrop);

  const onDragStart = (e: DragStartEvent) => {
    pointer.current = pointerFromEvent(e.activatorEvent);
    planRef.current = { kind: 'none' };
    setMenu(null);
    setDrag({ id: String(e.active.id), plan: { kind: 'none' }, line: null });
  };

  const finishDrag = () => {
    if (openTimer.current) window.clearTimeout(openTimer.current.timer);
    openTimer.current = null;
    setDrag(null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const plan = planRef.current;
    const id = String(e.active.id);
    const { x, y } = pointer.current;
    // A scene let go over an open canvas goes onto the board, not into the tree.
    const overTree = treeRef.current?.contains(document.elementFromPoint(x, y));
    if (!overTree && useWrite.getState().index.byId.get(id)?.kind === 'scene' && dropRefAt(x, y, { kind: 'scene', id })) {
      finishDrag();
      return;
    }
    if (plan.kind === 'move') void moveNode(id, plan.parentId, plan.index);
    finishDrag();
  };

  const nameOf = useCallback((id: string) => {
    const node = useWrite.getState().index.byId.get(id);
    return node ? displayTitle(node) : t('item');
  }, [locale]);
  const accessibility = useMemo(
    () => ({
      announcements: dragAnnouncements(nameOf),
      screenReaderInstructions: {
        draggable: t('Use Alt with the up and down arrows to move the focused item.'),
      },
    }),
    [nameOf],
  );

  const draggedNode = draggingId ? index.byId.get(draggingId) : undefined;
  const refusedReason = drag?.plan.kind === 'refused' ? refusalText(drag.plan.reason) : null;

  return (
    <DndContext
      sensors={sensors}
      accessibility={accessibility}
      onDragStart={onDragStart}
      onDragMove={updateDrop}
      onDragEnd={onDragEnd}
      onDragCancel={finishDrag}
    >
      <div className="binder-tree" role="tree" aria-label={t('Book contents')} ref={treeRef} onKeyDown={onKeyDown}>
        <div className="binder-rows">
          {rows.map((row: BinderRow) => (
            <Row
              key={row.id}
              id={row.id}
              kind={row.kind}
              title={row.title}
              status={row.status}
              depth={row.depth}
              words={row.words}
              hasChildren={row.hasChildren}
              open={row.open}
              place={row.place}
              siblings={row.siblings}
              selected={row.id === selectedId}
              tabbable={row.id === tabId}
              renaming={row.id === renamingId}
              onRename={setRenamingId}
              onMenu={openMenuAt}
              onFocusRow={setFocusId}
            />
          ))}
          {drag?.line && !drag.line.inside && (
            <div
              className={`binder-drop-line${drag.line.refused ? ' is-refused' : ''}`}
              style={{ top: drag.line.top, left: drag.line.left }}
            />
          )}
          {drag?.line?.inside && (
            <div
              className={`binder-drop-box${drag.line.refused ? ' is-refused' : ''}`}
              style={{ top: drag.line.top, height: drag.line.height }}
            />
          )}
        </div>
      </div>
      {/* The pointer has to reach the rows underneath, to find what it is over. */}
      <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }}>
        {draggedNode && (
          <div className={`binder-drag-preview${refusedReason ? ' is-refused' : ''}`}>
            <span className="truncate">{displayTitle(draggedNode)}</span>
            {refusedReason && <span className="binder-drag-reason">{refusedReason}</span>}
          </div>
        )}
      </DragOverlay>
      {menu && <RowMenu menu={menu} onClose={closeMenu} onRename={setRenamingId} />}
    </DndContext>
  );
}

// ---------------------------------------------------------------------------
// Everything around the tree
// ---------------------------------------------------------------------------

function BookSwitcher() {
  useLocale();
  const books = useWrite((s) => s.books);
  const bookId = useWrite((s) => s.bookId);
  const ready = useWrite((s) => s.ready);
  const go = useNav((s) => s.go);
  const [arranging, setArranging] = useState(false);
  return (
    <div className="binder-book">
      <select
        className="select binder-book-select"
        aria-label={t('Book')}
        value={bookId ?? ''}
        onChange={(e) => {
          selectBook(e.target.value);
          go({ view: 'write', bookId: e.target.value });
        }}
      >
        {books.length === 0 && <option value="">{ready ? t('No books') : ''}</option>}
        {books.map((b) => (
          <option key={b.id} value={b.id}>
            {b.title || t('Untitled book')}
          </option>
        ))}
      </select>
      {books.length > 1 && (
        <button
          type="button"
          className={`icon-btn${arranging ? ' active' : ''}`}
          title={t('Arrange books')}
          aria-label={t('Arrange books')}
          aria-expanded={arranging}
          onClick={() => setArranging((v) => !v)}
        >
          ⇅
        </button>
      )}
      <button type="button" className="icon-btn" title={t('New book')} aria-label={t('New book')} onClick={() => void newBook()}>
        +
      </button>
      {arranging && books.length > 1 && <BookOrder />}
    </div>
  );
}

/** The books in series order. Drag one, or use its arrows, to move it. */
function BookOrder() {
  const books = useWrite((s) => s.books);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const ids = books.map((b) => b.id);
  const onDragEnd = (e: DragEndEvent) => {
    const from = ids.indexOf(String(e.active.id));
    const to = e.over ? ids.indexOf(String(e.over.id)) : -1;
    if (from < 0 || to < 0 || from === to) return;
    void reorderBooks(arrayMove(ids, from, to));
  };
  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="binder-book-order" aria-label={t('Book order')}>
          {books.map((b, i) => (
            <BookOrderRow key={b.id} id={b.id} title={b.title || t('Untitled book')} first={i === 0} last={i === books.length - 1} />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function BookOrderRow({ id, title, first, last }: { id: string; title: string; first: boolean; last: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      className={`binder-book-order-row${isDragging ? ' dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-book={title}
    >
      <span className="binder-book-order-title" {...attributes} {...listeners}>
        {title}
      </span>
      <button type="button" className="icon-btn" disabled={first} aria-label={t('Move {title} up', { title })} title={t('Move book up')} onClick={() => void moveBook(id, -1)}>
        ↑
      </button>
      <button type="button" className="icon-btn" disabled={last} aria-label={t('Move {title} down', { title })} title={t('Move book down')} onClick={() => void moveBook(id, 1)}>
        ↓
      </button>
    </li>
  );
}

function AddButtons() {
  useLocale();
  const hasBook = useWrite((s) => s.bookId !== null);
  return (
    <div className="binder-add" role="group" aria-label={t('Add to this book')}>
      <button type="button" className="btn btn-sm" disabled={!hasBook} onClick={() => void newScene()} title={t('Add a scene ({shortcut})', { shortcut: 'Ctrl+Alt+Enter' })}>
        {t('+ Scene')}
      </button>
      <button type="button" className="btn btn-sm" disabled={!hasBook} onClick={() => void newChapter()} title={t('Add a chapter ({shortcut})', { shortcut: 'Ctrl+Alt+Shift+N' })}>
        {t('+ Chapter')}
      </button>
      <button type="button" className="btn btn-sm" disabled={!hasBook} onClick={() => void newPart()} title={t('Add a part')}>
        {t('+ Part')}
      </button>
    </div>
  );
}

function UndoNotice() {
  useLocale();
  const undo = useWrite((s) => s.undo);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(dismissUndo, 12000);
    return () => window.clearTimeout(timer);
  }, [undo]);
  if (!undo) return null;
  return (
    <div className="binder-undo" role="status">
      <span className="binder-undo-text">{undo.label}</span>
      <button type="button" className="link-button" onClick={undoLastDelete}>
        {t('Undo')}
      </button>
      <button type="button" className="toast-close" aria-label={t('Dismiss')} onClick={dismissUndo}>
        ×
      </button>
    </div>
  );
}

function GoalProgress() {
  useLocale();
  const stats = useWrite((s) => s.stats);
  const goal = useSettings((s) => s.settings.editor.dailyWordGoal);
  const written = stats?.writtenToday ?? 0;
  if (goal <= 0) return null;
  const share = Math.min(1, written / goal);
  return (
    <div className="binder-goal">
      <div className="binder-goal-text">
        <span>{t('Today')}</span>
        <span>{t('{written} of {goal}', { written: formatNumber(written), goal: formatNumber(goal) })}</span>
      </div>
      <div
        className="meter"
        role="progressbar"
        aria-label={t('Daily word goal')}
        aria-valuemin={0}
        aria-valuemax={goal}
        aria-valuenow={Math.min(written, goal)}
      >
        <div className={`meter-fill${written >= goal ? ' is-done' : ''}`} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

function BinderLinks() {
  useLocale();
  const go = useNav((s) => s.go);
  const bookId = useWrite((s) => s.bookId);
  const route = useNav((s) => s.route);
  const onStats = route.view === 'stats';
  const onTrash = route.view === 'write' && route.mode === 'trash';
  return (
    <nav className="binder-links" aria-label={t('Book')}>
      <button
        type="button"
        className={`nav-link${onStats ? ' is-active' : ''}`}
        onClick={() => go({ view: 'stats', bookId: bookId ?? undefined })}
      >
        {t('Writing stats')}
      </button>
      <button type="button" className="nav-link" onClick={() => go({ view: 'notes' })}>
        {t('Comments and to-dos')}
      </button>
      <button type="button" className="nav-link" disabled={!bookId} onClick={() => void openBookSettings()}>
        {t('Book settings')}
      </button>
      <button
        type="button"
        className={`nav-link${onTrash ? ' is-active' : ''}`}
        onClick={() => {
          goToMode('trash', routeState().nodeId);
        }}
      >
        {t('Trash')}
      </button>
    </nav>
  );
}

export function WriteSidebar() {
  useLocale();
  const ready = useWrite((s) => s.ready);
  const hasRows = useWrite((s) => s.base.length > 0);
  return (
    <div className="binder">
      <WriteDataSync />
      <WriteStatus />
      <BookSwitcher />
      <AddButtons />
      {ready && !hasRows && <p className="binder-empty">{t('Nothing here yet. Add a scene to start.')}</p>}
      <BinderTree />
      <UndoNotice />
      <GoalProgress />
      <BinderLinks />
    </div>
  );
}
