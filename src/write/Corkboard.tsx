/**
 * Scenes as index cards, one section per chapter. Drag a card to reorder it or move it to
 * another chapter, with a line showing where it will land. `Alt` and the arrow keys do the
 * same from the keyboard.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import { dragAnnouncements, pointerFromEvent, useDragPointer } from './dragPointer';
import { StatusMarker, statusLabel } from './shared';
import { goToMode, moveNode, newScene, openScene, useWrite } from './store';
import { chaptersUnder, childrenOf, displayTitle, moveStep, planCardDrop, type CardDrop, type TreeIndex } from './tree';
import { wordsText } from './WriteStatus';
import { t } from '../lib/i18n';
import type { NodeMeta, NodeStatus } from '../lib/types';
import { useLocale } from '../state/language';

/** Out here so that dnd-kit does not see a new sensor, and wake every card, each render. */
const POINTER_OPTIONS = { activationConstraint: { distance: 6 } };

interface CardProps {
  id: string;
  title: string;
  kind: NodeMeta['kind'];
  synopsis: string;
  status: NodeStatus;
  words: number;
  target: number;
  selected: boolean;
  dropSide: 'before' | 'after' | null;
}

const Card = memo(function Card(props: CardProps) {
  useLocale();
  const { id, title, kind, synopsis, status, words, target, selected, dropSide } = props;
  const { setNodeRef, listeners, isDragging } = useDraggable({ id });
  const shown = displayTitle({ title, kind });
  return (
    <article
      ref={setNodeRef}
      {...listeners}
      className={`cork-card${isDragging ? ' is-dragging' : ''}${selected ? ' is-selected' : ''}${dropSide ? ` is-drop-${dropSide}` : ''}`}
      data-card-id={id}
      tabIndex={0}
      role="button"
      aria-label={t('{title}, {status}, {words}. Enter opens. Alt and the arrow keys move it.', {
        title: shown,
        status: statusLabel(status).toLowerCase(),
        words: wordsText(words),
      })}
      onClick={() => openScene(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          openScene(id);
          return;
        }
        // Only Alt alone. Ctrl+Alt with these arrows goes to another scene.
        if (!e.altKey || e.ctrlKey || e.metaKey) return;
        const direction = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0;
        if (direction === 0) return;
        e.preventDefault();
        // Alt with the side arrows would otherwise go back and forward in history.
        e.stopPropagation();
        const step = moveStep(useWrite.getState().index, id, direction);
        if (step) {
          void moveNode(id, step.parentId, step.index).then(() => {
            document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)?.focus();
          });
        }
      }}
    >
      <h3 className="cork-card-title">{shown}</h3>
      <p className={`cork-card-synopsis${synopsis ? '' : ' is-empty'}`}>{synopsis || t('No synopsis yet')}</p>
      <footer className="cork-card-foot">
        <span className="cork-card-status">
          <StatusMarker status={status} />
          {statusLabel(status)}
        </span>
        <span>
          {target > 0
            ? t('{words} of {target}', { words: wordsText(words), target: target.toLocaleString() })
            : wordsText(words)}
        </span>
      </footer>
    </article>
  );
});

function chaptersInScope(index: TreeIndex, nodeId: string | undefined): NodeMeta[] {
  return chaptersUnder(index, nodeId ?? null);
}

function scopeLabel(index: TreeIndex, nodeId: string | undefined): string | null {
  if (!nodeId) return null;
  const node = index.byId.get(nodeId);
  if (!node) return null;
  if (node.kind === 'scene') {
    const chapter = chaptersUnder(index, nodeId)[0];
    return chapter ? displayTitle(chapter) : null;
  }
  return displayTitle(node);
}

export function Corkboard({ nodeId }: { nodeId?: string }) {
  const locale = useLocale();
  const index = useWrite((s) => s.index);
  const selectedScene = nodeId && index.byId.get(nodeId)?.kind === 'scene' ? nodeId : null;
  const chapters = useMemo(() => chaptersInScope(index, nodeId), [index, nodeId]);
  const label = scopeLabel(index, nodeId);
  // One chapter on its own needs no section heading under its own title.
  const single = chapters.length === 1 && index.byId.get(nodeId ?? '')?.kind !== 'part' && Boolean(nodeId);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [drop, setDrop] = useState<CardDrop | null>(null);
  const dropRef = useRef<CardDrop | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS));

  const updateDrop = useCallback(() => {
    if (!draggingId) return;
    const { x, y } = pointer.current;
    const under = document.elementFromPoint(x, y);
    const state = useWrite.getState();
    const cardEl = under?.closest<HTMLElement>('[data-card-id]');
    const sectionEl = under?.closest<HTMLElement>('[data-chapter-id]');
    let next: CardDrop | null = null;
    const chapterId = sectionEl?.getAttribute('data-chapter-id');
    if (chapterId) {
      const overId = cardEl?.getAttribute('data-card-id') ?? null;
      if (cardEl && overId) {
        const box = cardEl.getBoundingClientRect();
        next = planCardDrop(state.index, draggingId, chapterId, overId, x < box.left + box.width / 2 ? 'before' : 'after');
      } else {
        next = planCardDrop(state.index, draggingId, chapterId, null, 'after');
      }
    }
    dropRef.current = next;
    // Most pointer moves stay over the same side of the same card, and change nothing.
    setDrop((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    // `pointer` is stable, and `draggingId` restarts this whenever it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingId]);

  const pointer = useDragPointer(draggingId !== null, updateDrop);

  const onDragStart = (e: DragStartEvent) => {
    pointer.current = pointerFromEvent(e.activatorEvent);
    dropRef.current = null;
    setDraggingId(String(e.active.id));
  };
  const finish = () => {
    setDraggingId(null);
    setDrop(null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const plan = dropRef.current;
    if (plan) void moveNode(String(e.active.id), plan.parentId, plan.index);
    finish();
  };

  // A scene selected from the binder should be on screen.
  useEffect(() => {
    if (!selectedScene) return;
    boardRef.current?.querySelector(`[data-card-id="${selectedScene}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedScene]);

  const nameOf = useCallback((id: string) => {
    const node = useWrite.getState().index.byId.get(id);
    return node ? displayTitle(node) : t('card');
  }, [locale]);
  const accessibility = useMemo(
    () => ({
      announcements: dragAnnouncements(nameOf),
      screenReaderInstructions: { draggable: t('Alt with the arrow keys moves the focused card.') },
    }),
    [nameOf],
  );

  const dragged = draggingId ? index.byId.get(draggingId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      accessibility={accessibility}
      onDragStart={onDragStart}
      onDragMove={updateDrop}
      onDragEnd={onDragEnd}
      onDragCancel={finish}
    >
      <div className="write-scroll" ref={boardRef}>
        <div className="cork-board">
          <header className="cork-head">
            <h1 className="cork-title">{label ?? t('Whole book')}</h1>
            {single && <span className="muted small">{wordsText(index.totals.get(chapters[0].id) ?? 0)}</span>}
            <span className="binder-spacer" />
            {nodeId && (
              <button type="button" className="btn btn-sm" onClick={() => goToMode('cork')}>
                {t('Show whole book')}
              </button>
            )}
          </header>
          {chapters.length === 0 && (
            <div className="write-empty">
              <h2 className="write-empty-title">{t('No chapters here yet')}</h2>
              <button type="button" className="btn btn-primary" onClick={() => void newScene(nodeId ?? null)}>
                {t('Add a scene')}
              </button>
            </div>
          )}
          {chapters.map((chapter) => {
            const scenes = childrenOf(index, chapter.id).filter((c) => c.kind === 'scene');
            const isTarget = drop?.parentId === chapter.id;
            return (
              <section
                key={chapter.id}
                className={`cork-section${isTarget ? ' is-target' : ''}`}
                data-chapter-id={chapter.id}
                aria-label={displayTitle(chapter)}
              >
                {!single && (
                  <header className="cork-section-head">
                    <button type="button" className="link-button cork-section-title" onClick={() => goToMode('cork', chapter.id)}>
                      {displayTitle(chapter)}
                    </button>
                    <span className="muted small">{wordsText(index.totals.get(chapter.id) ?? 0)}</span>
                  </header>
                )}
                <div className="cork-grid">
                  {scenes.map((scene) => (
                    <Card
                      key={scene.id}
                      id={scene.id}
                      title={scene.title}
                      kind={scene.kind}
                      synopsis={scene.synopsis}
                      status={scene.status}
                      words={scene.wordCount}
                      target={scene.targetWords}
                      selected={scene.id === selectedScene}
                      dropSide={isTarget && drop?.cardId === scene.id ? drop.side : null}
                    />
                  ))}
                  <button
                    type="button"
                    className="cork-add"
                    onClick={() => void newScene(scenes.at(-1)?.id ?? chapter.id)}
                  >
                    {t('Add a scene')}
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      </div>
      {/* The pointer has to reach the cards underneath, to find what it is over. */}
      <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }}>
        {dragged && (
          <div className="cork-card cork-card-preview">
            <h3 className="cork-card-title">{displayTitle(dragged)}</h3>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
