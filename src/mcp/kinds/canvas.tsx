/**
 * Canvases from an outside AI: a new canvas, a new title, the trash, and edits to cards and
 * arrows. Edits go through the open board when there is one (`src/canvas/live.ts`), so the
 * writer sees them at once. Undo puts back the canvas as it was, unless it has changed since.
 */

import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { useLocale } from '../../state/language';
import { canvases } from '../../canvas/api';
import { currentCanvasData, writeCanvasData } from '../../canvas/live';
import { parseRef, type CanvasData, type CanvasEdge, type CanvasNode } from '../../canvas/model';
import { addNodes, removeItems, updateEdge, updateNode } from '../../canvas/ops';
import type { AnyProposal } from '../api';
import { changedSince, goneSince, useOpenRoute, withElement } from './shared';
import { defineKind, type ApplyResult, type UndoResult } from './types';

/** One change, by id, as the Rust tool worked it out. */
export type CanvasOp =
  | { type: 'add'; node: CanvasNode }
  | { type: 'update'; id: string; patch: Partial<CanvasNode> }
  | { type: 'remove'; id: string }
  | { type: 'addEdge'; edge: CanvasEdge }
  | { type: 'removeEdge'; id: string }
  | { type: 'updateEdge'; id: string; patch: Partial<CanvasEdge> };

export interface CanvasEditPayload {
  canvasId: string;
  ops: CanvasOp[];
}

export interface CanvasEditUndo {
  before: CanvasData;
  /** A fingerprint of the canvas just after, to tell whether it has changed since. */
  after: string;
}

/** Key order does not count, so a canvas read back from storage matches the one written. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function canvasPrint(data: CanvasData): string {
  return canonical({ nodes: data.nodes, edges: data.edges });
}

/** Applies the operations in order, or says why it cannot. */
export function applyCanvasOps(data: CanvasData, ops: CanvasOp[]): { ok: true; data: CanvasData } | { ok: false; reason: string } {
  let next = data;
  const nodeThere = (id: string) => next.nodes.some((n) => n.id === id);
  const edgeThere = (id: string) => next.edges.some((e) => e.id === id);
  const gone = () => ({ ok: false as const, reason: t('A card or arrow this change names is no longer on the canvas.') });
  for (const op of ops) {
    switch (op.type) {
      case 'add':
        if (nodeThere(op.node.id)) return gone();
        next = addNodes(next, [op.node]);
        break;
      case 'update':
        if (!nodeThere(op.id)) return gone();
        // A null from JSON clears the field, as `undefined` does here.
        next = updateNode(next, op.id, Object.fromEntries(Object.entries(op.patch).map(([k, v]) => [k, v ?? undefined])));
        break;
      case 'remove':
        if (!nodeThere(op.id)) return gone();
        next = removeItems(next, new Set([op.id]));
        break;
      case 'addEdge':
        if (!nodeThere(op.edge.fromNode) || !nodeThere(op.edge.toNode)) return gone();
        next = addNodes(next, [], [op.edge]);
        break;
      case 'removeEdge':
        if (!edgeThere(op.id)) return gone();
        next = removeItems(next, new Set(), new Set([op.id]));
        break;
      case 'updateEdge':
        if (!edgeThere(op.id)) return gone();
        next = updateEdge(next, op.id, Object.fromEntries(Object.entries(op.patch).map(([k, v]) => [k, v ?? undefined])));
        break;
    }
  }
  return { ok: true, data: next };
}

function OpenCanvas({ id, title }: { id: string; title: string }) {
  const openRoute = useOpenRoute();
  return (
    <button type="button" className="link-button" onClick={() => openRoute({ view: 'canvas', id })}>
      {title || t('Untitled')}
    </button>
  );
}

function opText(op: CanvasOp): string {
  switch (op.type) {
    case 'add': {
      const ref = parseRef(op.node.file);
      if (op.node.type === 'group') return t('Add a group: {label}', { label: op.node.label || t('(none)') });
      if (ref?.kind === 'page') return t('Add a page card');
      if (ref?.kind === 'scene') return t('Add a scene card');
      return t('Add a text card: {text}', { text: op.node.text ?? '' });
    }
    case 'update':
      if (op.patch.text !== undefined) return t('Change a card’s text to: {text}', { text: op.patch.text ?? '' });
      if (op.patch.label !== undefined) return t('Rename a group to: {label}', { label: op.patch.label ?? '' });
      if (op.patch.x !== undefined) return t('Move a card');
      if (op.patch.width !== undefined) return t('Resize a card');
      return t('Change a card’s color');
    case 'remove':
      return t('Remove a card');
    case 'addEdge':
      return op.edge.label ? t('Add an arrow: {label}', { label: op.edge.label }) : t('Add an arrow');
    case 'removeEdge':
      return t('Remove an arrow');
    case 'updateEdge':
      return t('Change an arrow’s color');
  }
}

function CanvasEditCard({ proposal }: { proposal: AnyProposal<CanvasEditPayload> }) {
  useLocale();
  const { canvasId, ops } = proposal.payload;
  return (
    <>
      <p className="mcp-proposal-title">{withElement(t('Changes to the canvas {title}'), 'title', <OpenCanvas id={canvasId} title={proposal.title} />)}</p>
      <ul className="mcp-canvas-ops">
        {ops.map((op, i) => (
          <li key={i}>{opText(op)}</li>
        ))}
      </ul>
    </>
  );
}

async function applyEdit(proposal: AnyProposal<CanvasEditPayload>): Promise<ApplyResult> {
  const { canvasId, ops } = proposal.payload;
  let before: CanvasData;
  try {
    before = await currentCanvasData(canvasId);
  } catch {
    return { ok: false, reason: goneSince() };
  }
  const result = applyCanvasOps(before, ops);
  if (!result.ok) return result;
  try {
    await writeCanvasData(canvasId, result.data);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  const undo: CanvasEditUndo = { before, after: canvasPrint(result.data) };
  return { ok: true, undo };
}

async function undoEdit(proposal: AnyProposal<CanvasEditPayload>, raw: unknown): Promise<UndoResult> {
  const undo = raw as CanvasEditUndo | undefined;
  if (!undo?.before) return { ok: false, reason: t('There is no earlier version to go back to.') };
  let now: CanvasData;
  try {
    now = await currentCanvasData(proposal.payload.canvasId);
  } catch {
    return { ok: false, reason: goneSince() };
  }
  if (canvasPrint(now) !== undo.after) return { ok: false, reason: changedSince() };
  await writeCanvasData(proposal.payload.canvasId, undo.before);
  return { ok: true };
}

export const canvasEditKind = defineKind<CanvasEditPayload>({
  kind: 'canvasEdit',
  Card: CanvasEditCard,
  apply: applyEdit,
  undo: undoEdit,
  accepted: () => t('Canvas changed.'),
});

// ---- A new canvas ----------------------------------------------------------------------

interface CreatePayload {
  title: string;
}

function CreateCard({ proposal }: { proposal: AnyProposal<CreatePayload> }) {
  useLocale();
  return <p className="mcp-proposal-title">{withElement(t('New canvas: {title}'), 'title', <strong>{proposal.payload.title}</strong>)}</p>;
}

export const canvasCreateKind = defineKind<CreatePayload>({
  kind: 'canvasCreate',
  Card: CreateCard,
  apply: async (p) => {
    try {
      const made = await canvases.create(p.payload.title);
      return { ok: true, undo: { id: made.id } };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  },
  // A canvas made new goes to the trash, where the writer can still find it.
  undo: async (_p, raw) => {
    const id = (raw as { id?: string } | undefined)?.id;
    if (!id) return { ok: false, reason: goneSince() };
    try {
      const canvas = await canvases.get(id);
      if (canvas.deletedAt) return { ok: false, reason: goneSince() };
      await canvases.trash(id);
      return { ok: true };
    } catch {
      return { ok: false, reason: goneSince() };
    }
  },
  accepted: () => t('Canvas made.'),
});

// ---- A new title ----------------------------------------------------------------------

interface RenamePayload {
  canvasId: string;
  title: string;
  before: string;
}

function RenameCard({ proposal }: { proposal: AnyProposal<RenamePayload> }) {
  useLocale();
  const { canvasId, title, before } = proposal.payload;
  return (
    <p className="mcp-proposal-title">
      {withElement(t('Rename the canvas {title} to “{name}”', { name: title }), 'title', <OpenCanvas id={canvasId} title={before} />)}
    </p>
  );
}

export const canvasRenameKind = defineKind<RenamePayload>({
  kind: 'canvasRename',
  Card: RenameCard,
  apply: async (p) => {
    try {
      await canvases.rename(p.payload.canvasId, p.payload.title);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  },
  undo: async (p) => {
    try {
      const canvas = await canvases.get(p.payload.canvasId);
      if (canvas.deletedAt) return { ok: false, reason: goneSince() };
      if (canvas.title !== p.payload.title) return { ok: false, reason: changedSince() };
      await canvases.rename(p.payload.canvasId, p.payload.before);
      return { ok: true };
    } catch {
      return { ok: false, reason: goneSince() };
    }
  },
  accepted: () => t('Canvas renamed.'),
});

// ---- To the trash ----------------------------------------------------------------------

interface TrashPayload {
  canvasId: string;
}

function TrashCard({ proposal }: { proposal: AnyProposal<TrashPayload> }) {
  useLocale();
  return (
    <p className="mcp-proposal-title">
      {withElement(t('Move the canvas {title} to the trash'), 'title', <OpenCanvas id={proposal.payload.canvasId} title={proposal.title} />)}
    </p>
  );
}

export const canvasTrashKind = defineKind<TrashPayload>({
  kind: 'canvasTrash',
  Card: TrashCard,
  apply: async (p) => {
    try {
      await canvases.trash(p.payload.canvasId);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  },
  undo: async (p) => {
    try {
      const canvas = await canvases.get(p.payload.canvasId);
      if (!canvas.deletedAt) return { ok: false, reason: changedSince() };
      await canvases.restore(p.payload.canvasId);
      return { ok: true };
    } catch {
      return { ok: false, reason: goneSince() };
    }
  },
  accepted: () => t('Canvas moved to the trash.'),
});
