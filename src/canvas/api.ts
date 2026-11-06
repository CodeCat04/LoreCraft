/** The canvas module's wrapper over the native RPC (`src-tauri/src/rpc/canvas.rs`). */

import { rpc } from '../lib/rpc';
import { useDataVersion, useLoad } from '../state/events';
import type { CanvasData } from './model';

export interface CanvasMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Canvas extends CanvasMeta {
  data: CanvasData;
}

export const canvases = {
  list: (includeDeleted = false) => rpc<CanvasMeta[]>('canvases.list', { includeDeleted }),
  get: (id: string) => rpc<Canvas>('canvases.get', { id }),
  create: (title: string, data?: CanvasData) => rpc<Canvas>('canvases.create', { title, data }),
  update: (id: string, data: CanvasData) => rpc<{ updatedAt: string }>('canvases.update', { id, data }),
  rename: (id: string, title: string) => rpc<boolean>('canvases.rename', { id, title }),
  trash: (id: string) => rpc<boolean>('canvases.trash', { id }),
  restore: (id: string) => rpc<boolean>('canvases.restore', { id }),
  purge: (id: string) => rpc<boolean>('canvases.purge', { id }),
};

/** Every canvas not in the trash, kept up to date. */
export function useCanvasList(includeDeleted = false): CanvasMeta[] {
  const version = useDataVersion('canvases');
  const { data } = useLoad(() => canvases.list(includeDeleted), [version, includeDeleted]);
  return data ?? [];
}
