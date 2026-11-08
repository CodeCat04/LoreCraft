/**
 * The canvases open on screen, so a change made from elsewhere (an outside AI's edit, say)
 * goes through the open board: it shows at once, joins the board's own undo, and is saved
 * the way the writer's own changes are. A canvas that is not open is read and written
 * through the RPC.
 */

import { unwrittenValue } from '../editor/saving';
import { canvases } from './api';
import { parseCanvas, type CanvasData } from './model';

export interface LiveBoard {
  /** What the board shows now, including what is not saved yet. */
  data: () => CanvasData;
  /** Makes a change as the writer's own: recorded for undo, then saved. */
  commit: (next: CanvasData) => void;
  /** Writes what is waiting. */
  flush: () => Promise<unknown>;
}

const boards = new Map<string, LiveBoard>();

/** Called by an open board. Returns the call that unregisters it. */
export function registerBoard(id: string, board: LiveBoard): () => void {
  boards.set(id, board);
  return () => {
    if (boards.get(id) === board) boards.delete(id);
  };
}

export function isBoardOpen(id: string): boolean {
  return boards.has(id);
}

/** The canvas as it is now: the open board's data, or what is stored, with any unsaved change. */
export async function currentCanvasData(id: string): Promise<CanvasData> {
  const board = boards.get(id);
  if (board) return board.data();
  const canvas = await canvases.get(id);
  if (canvas.deletedAt) throw new Error('gone');
  return parseCanvas(unwrittenValue<CanvasData>(`canvas:${id}`) ?? canvas.data);
}

/** Replaces the canvas's data: through the open board if there is one, so it updates live. */
export async function writeCanvasData(id: string, next: CanvasData): Promise<void> {
  const board = boards.get(id);
  if (board) {
    board.commit(next);
    await board.flush();
    return;
  }
  await canvases.update(id, next);
}
