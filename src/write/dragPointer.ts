import { useEffect, useRef } from 'react';

import { t } from '../lib/i18n';

/**
 * Where the pointer really is during a drag. dnd-kit's own delta is adjusted for
 * scrolling, so it cannot answer this. Drop targets are found from this position with
 * `elementFromPoint`, which needs no measuring and no per-row bookkeeping, and that keeps
 * a drag in a book of hundreds of scenes as cheap as one in a book of ten.
 */
export function useDragPointer(active: boolean, onMove: () => void) {
  const pointer = useRef({ x: 0, y: 0 });
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  useEffect(() => {
    if (!active) return;
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      onMoveRef.current();
    };
    window.addEventListener('pointermove', move, { capture: true, passive: true });
    document.documentElement.classList.add('write-dragging');
    return () => {
      window.removeEventListener('pointermove', move, { capture: true });
      document.documentElement.classList.remove('write-dragging', 'write-drag-refused');
    };
  }, [active]);

  return pointer;
}

export function setDragRefused(refused: boolean) {
  document.documentElement.classList.toggle('write-drag-refused', refused);
}

/** The pointer position a drag started from. */
export function pointerFromEvent(event: Event | null): { x: number; y: number } {
  const e = event as PointerEvent | null;
  return { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
}

/** Plain screen reader messages. The defaults would read out ids. */
export function dragAnnouncements(nameOf: (id: string) => string) {
  const name = (id: unknown) => nameOf(String(id));
  return {
    onDragStart: ({ active }: { active: { id: unknown } }) => t('Picked up {name}.', { name: name(active.id) }),
    onDragOver: () => undefined,
    onDragEnd: ({ active }: { active: { id: unknown } }) => t('Dropped {name}.', { name: name(active.id) }),
    onDragCancel: ({ active }: { active: { id: unknown } }) => t('Put {name} back.', { name: name(active.id) }),
  };
}
