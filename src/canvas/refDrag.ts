/**
 * Dragging project things onto a canvas board. Lists set `REF_MIME` on a native drag. The
 * binder moves its rows with its own pointer drag, so it calls `dropRefAt` when one ends
 * over a board instead. Kept free of the board's code, so any list can import it cheaply.
 */

import { formatRef, type LoreRef } from './model';

/** Drags of pages, scenes, assets and canvases from elsewhere in the app carry this. */
export const REF_MIME = 'application/x-lorecraft-ref';

/** The event a board listens for when something is dropped on it without a native drag. */
export const REF_DROP_EVENT = 'lorecraft-ref-drop';

export interface RefDropDetail {
  ref: LoreRef;
  clientX: number;
  clientY: number;
}

/** Props that make an element draggable onto a board. */
export function refDragProps(ref: LoreRef | null | undefined) {
  if (!ref) return {};
  return {
    draggable: true,
    onDragStart: (e: { dataTransfer: DataTransfer }) => {
      const text = formatRef(ref);
      e.dataTransfer.setData(REF_MIME, text);
      e.dataTransfer.effectAllowed = 'copyMove';
    },
  };
}

/** Drops a reference on the board under this point. Returns whether there was one. */
export function dropRefAt(clientX: number, clientY: number, ref: LoreRef): boolean {
  const hit = document.elementFromPoint(clientX, clientY);
  const board = hit?.closest<HTMLElement>('.canvas-board');
  if (!board) return false;
  board.dispatchEvent(new CustomEvent<RefDropDetail>(REF_DROP_EVENT, { detail: { ref, clientX, clientY } }));
  return true;
}
