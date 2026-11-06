/**
 * The idea inbox's wrapper over the native RPC. `ideas.add` is the one way in, for the
 * capture box and anything added later, such as a tool for an outside AI.
 */

import { rpc } from '../lib/rpc';
import { useDataVersion, useLoad } from '../state/events';

export type IdeaStatus = 'open' | 'done';
export type IdeaSourceKind = 'page' | 'node';

export interface Idea {
  id: string;
  text: string;
  sourceKind: IdeaSourceKind | null;
  sourceId: string | null;
  status: IdeaStatus;
  createdAt: string;
  updatedAt: string;
  /** Null when there is no source, or it has been deleted. Scenes can have an empty title. */
  sourceTitle: string | null;
  /** The book a scene belongs to, needed to open it. */
  sourceBookId: string | null;
}

export interface NewIdea {
  text: string;
  sourceKind?: IdeaSourceKind;
  sourceId?: string;
}

export interface IdeaCounts {
  open: number;
  done: number;
}

export const ideas = {
  add: (idea: NewIdea) => rpc<Idea>('ideas.add', idea),
  list: (status?: IdeaStatus) => rpc<Idea[]>('ideas.list', { status }),
  count: () => rpc<IdeaCounts>('ideas.count'),
  update: (id: string, patch: { text?: string; status?: IdeaStatus }) => rpc<Idea>('ideas.update', { id, ...patch }),
  remove: (id: string) => rpc<boolean>('ideas.delete', { id }),
};

/** How many ideas are waiting, kept up to date. Zero until it is known. */
export function useOpenIdeaCount(): number {
  const version = useDataVersion('ideas');
  const { data } = useLoad(() => ideas.count(), [version]);
  return data?.open ?? 0;
}
