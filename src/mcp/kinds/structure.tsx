/**
 * The manuscript's structure and its books, from `src-tauri/src/mcp/areas/structure.rs`:
 * book settings, moving, details, the trash, splitting and merging scenes, and plot
 * threads. Each one applies through the same calls and stores as the Write area, and keeps
 * what Undo needs. Undo refuses if what it would put back has changed since.
 */

import { getSchema } from '@tiptap/core';
import { Node as ProseNode, type Schema } from '@tiptap/pm/model';

import * as api from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage, RpcError, rpc } from '../../lib/rpc';
import type { Book, NodeMeta, NodeStatus } from '../../lib/types';
import { documentExtensions } from '../../editor/schema';
import { useLocale } from '../../state/language';
import { compareTexts } from '../../wiki/diff';
import { loadBookVoice, saveBookVoice, type BookPov, type BookTense, type BookVoice } from '../../write/bookVoice';
import { mergeScene, splitScene, threads, type Thread } from '../../write/api';
import { MERGED_TEXT_CHANGED, sceneUndo } from '../../write/history/api';
import { splitDocAt } from '../../write/splitDoc';
import { indexTree, neighborScene } from '../../write/tree';
import { getActiveStyle, listStyles, setActiveStyle } from '../../writingStyles/store';
import { findQuote } from '../apply';
import type { AnyProposal } from '../api';
import { changedSince, DiffView, flushFirst, goneSince, isLiveNode, useOpenRoute, withElement } from './shared';
import { defineKind, type ApplyResult, type UndoResult } from './types';

const fail = (reason: string) => ({ ok: false as const, reason });

async function guarded<T extends ApplyResult | UndoResult>(work: () => Promise<T>): Promise<T | { ok: false; reason: string }> {
  const problem = await flushFirst();
  if (problem) return fail(problem);
  try {
    return await work();
  } catch (error) {
    if (error instanceof RpcError && error.code === 'NOT_FOUND') return fail(goneSince());
    return fail(errorMessage(error));
  }
}

/** One fact per line, old to new where there is an old value. */
function Changes({ rows }: { rows: { label: string; before?: string; after: string }[] }) {
  return (
    <dl className="mcp-infobox mcp-details">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.before === undefined ? row.after : <DiffView lines={compareTexts(row.before, row.after)} />}</dd>
        </div>
      ))}
    </dl>
  );
}

const none = (value: unknown) => (value === undefined || value === null || value === '' || value === 0 ? t('(none)') : String(value));

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

interface BookFields {
  title?: string;
  subtitle?: string;
  author?: string;
  targetWords?: number;
  pov?: string;
  tense?: string;
  /** A style name or id. Empty means the same as the project. */
  style?: string;
}

interface BookSettingsPayload {
  changes: BookFields;
  before: BookFields & { styleName?: string };
}

interface BookCreatePayload {
  title: string;
  changes: BookFields;
}

function bookLabels(): Record<keyof BookFields, string> {
  return {
    title: t('Title'),
    subtitle: t('Subtitle'),
    author: t('Author'),
    targetWords: t('Target words'),
    pov: t('Point of view'),
    tense: t('Tense'),
    style: t('Writing style'),
  };
}

function BookCard({ proposal }: { proposal: AnyProposal<BookSettingsPayload | BookCreatePayload> }) {
  useLocale();
  const labels = bookLabels();
  const { changes } = proposal.payload;
  const before = 'before' in proposal.payload ? proposal.payload.before : undefined;
  const rows = (Object.keys(labels) as (keyof BookFields)[])
    .filter((key) => changes[key] !== undefined)
    .map((key) => ({
      label: labels[key],
      before: before ? none(key === 'style' ? before.styleName || before.style : before[key]) : undefined,
      after: none(changes[key]),
    }));
  return (
    <>
      <p className="mcp-proposal-title">
        {withElement(before ? t('Settings of the book {title}') : t('New book: {title}'), 'title', <strong>{proposal.title}</strong>)}
      </p>
      {rows.length > 0 && <Changes rows={rows} />}
    </>
  );
}

/** A style by id or name, or null for "same as the project". Undefined if there is none such. */
function styleIdFor(wanted: string): string | null | undefined {
  const clean = wanted.trim().toLowerCase();
  if (!clean) return null;
  const style = listStyles().find((s) => s.id.toLowerCase() === clean || s.name.toLowerCase() === clean);
  return style?.id;
}

/** Writes book fields through the same calls as the Book settings dialog. */
async function writeBook(bookId: string, fields: BookFields, styleId?: string | null): Promise<void> {
  const patch: Parameters<typeof api.books.update>[1] = {};
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.subtitle !== undefined) patch.subtitle = fields.subtitle;
  if (fields.author !== undefined) patch.author = fields.author;
  if (fields.targetWords !== undefined) patch.targetWords = fields.targetWords;
  if (Object.keys(patch).length) await api.books.update(bookId, patch);
  if (fields.pov !== undefined || fields.tense !== undefined) {
    const voice: BookVoice = { ...(await loadBookVoice(bookId)) };
    if (fields.pov !== undefined) voice.pov = (fields.pov || undefined) as BookPov | undefined;
    if (fields.tense !== undefined) voice.tense = (fields.tense || undefined) as BookTense | undefined;
    await saveBookVoice(bookId, voice);
  }
  if (styleId !== undefined) await setActiveStyle({ kind: 'book', bookId }, styleId);
}

async function readBook(bookId: string): Promise<Required<Omit<BookFields, 'style'>> & { style: string | null; book: Book | undefined }> {
  const book = (await api.books.list()).find((b) => b.id === bookId);
  const voice = await loadBookVoice(bookId);
  const style = await getActiveStyle({ kind: 'book', bookId });
  return {
    book,
    title: book?.title ?? '',
    subtitle: book?.subtitle ?? '',
    author: book?.author ?? '',
    targetWords: book?.targetWords ?? 0,
    pov: voice.pov ?? '',
    tense: voice.tense ?? '',
    style: style?.styleId ?? null,
  };
}

function unknownStyle(name: string) {
  return fail(t('There is no writing style called “{name}”.', { name }));
}

interface BookUndo {
  styleBefore?: string | null;
  styleAfter?: string | null;
}

export const bookSettingsKind = defineKind<BookSettingsPayload>({
  kind: 'bookSettings',
  Card: BookCard,
  apply: (p) =>
    guarded(async () => {
      const bookId = p.targetId ?? '';
      const now = await readBook(bookId);
      if (!now.book) return fail(goneSince());
      const { style, ...fields } = p.payload.changes;
      const styleId = style === undefined ? undefined : styleIdFor(style);
      if (styleId === undefined && style !== undefined) return unknownStyle(style);
      await writeBook(bookId, fields, styleId);
      const undo: BookUndo = style === undefined ? {} : { styleBefore: now.style, styleAfter: styleId };
      return { ok: true, undo };
    }),
  undo: (p, raw) =>
    guarded(async () => {
      const bookId = p.targetId ?? '';
      const info = (raw ?? {}) as BookUndo;
      const now = await readBook(bookId);
      if (!now.book) return fail(goneSince());
      const { style, ...fields } = p.payload.changes;
      for (const [key, value] of Object.entries(fields)) {
        if ((now as unknown as Record<string, unknown>)[key] !== value) return fail(changedSince());
      }
      if (style !== undefined && now.style !== (info.styleAfter ?? null)) return fail(changedSince());
      const restore: BookFields = {};
      for (const key of Object.keys(fields) as (keyof BookFields)[]) {
        (restore as Record<string, unknown>)[key] = p.payload.before[key];
      }
      await writeBook(bookId, restore, style === undefined ? undefined : (info.styleBefore ?? null));
      return { ok: true };
    }),
  accepted: () => t('Book settings changed.'),
});

interface BookCreateUndo {
  id: string;
  updatedAt: string;
}

export const bookCreateKind = defineKind<BookCreatePayload>({
  kind: 'bookCreate',
  Card: BookCard,
  apply: (p) =>
    guarded(async () => {
      const { style, ...fields } = p.payload.changes;
      const styleId = style === undefined ? undefined : styleIdFor(style);
      if (styleId === undefined && style !== undefined) return unknownStyle(style);
      const { id } = await api.books.create(p.payload.title);
      await writeBook(id, fields, styleId);
      const made = await readBook(id);
      const undo: BookCreateUndo = { id, updatedAt: made.book?.updatedAt ?? '' };
      return { ok: true, target: { targetKind: 'book', targetId: id }, undo };
    }),
  undo: (_p, raw) =>
    guarded(async () => {
      const info = raw as BookCreateUndo | undefined;
      if (!info?.id) return fail(goneSince());
      const now = await readBook(info.id);
      if (!now.book) return fail(goneSince());
      if (now.book.updatedAt !== info.updatedAt) return fail(changedSince());
      // The writer may have started writing in it.
      const tree = await api.nodes.tree(info.id);
      if (tree.length > 2 || tree.some((n) => n.wordCount > 0)) return fail(changedSince());
      await api.books.remove(info.id);
      return { ok: true };
    }),
  accepted: () => t('Book created.'),
});

// ---------------------------------------------------------------------------
// Moving a node
// ---------------------------------------------------------------------------

interface MovePayload {
  kind: string;
  bookId: string;
  from: { parentId: string | null; parentTitle: string | null; index: number };
  to: { parentId: string | null; parentTitle: string | null; beforeId?: string; afterId?: string; anchorTitle?: string; index?: number };
}

function MoveCard({ proposal }: { proposal: AnyProposal<MovePayload> }) {
  useLocale();
  const openRoute = useOpenRoute();
  const { to } = proposal.payload;
  const place = to.beforeId
    ? t('Before {name}.', { name: to.anchorTitle ?? '' })
    : to.afterId
      ? t('After {name}.', { name: to.anchorTitle ?? '' })
      : to.parentTitle
        ? t('Into {name}, at place {place}.', { name: to.parentTitle, place: to.index === undefined ? t('last') : String(to.index + 1) })
        : t('To the top level of the book, at place {place}.', { place: to.index === undefined ? t('last') : String(to.index + 1) });
  return (
    <>
      <p className="mcp-proposal-title">
        {withElement(
          t('Move {title}'),
          'title',
          <button type="button" className="link-button" onClick={() => openRoute({ view: 'write', nodeId: proposal.targetId ?? '' })}>
            {proposal.title || t('Untitled')}
          </button>,
        )}
      </p>
      <p className="muted small">{place}</p>
    </>
  );
}

/** The live children of a parent, in order. */
function childrenOf(tree: NodeMeta[], parentId: string | null): NodeMeta[] {
  return tree.filter((n) => (n.parentId ?? null) === parentId).sort((a, b) => a.position - b.position);
}

interface MoveUndo {
  index: number;
}

export const nodeMoveKind = defineKind<MovePayload>({
  kind: 'nodeMove',
  Card: MoveCard,
  apply: (p) =>
    guarded(async () => {
      const id = p.targetId ?? '';
      if (!(await isLiveNode(id))) return fail(t('What this suggestion changes has been deleted.'));
      const { to, bookId } = p.payload;
      const others = childrenOf(await api.nodes.tree(bookId), to.parentId).filter((n) => n.id !== id);
      let index = to.index ?? others.length;
      const anchor = to.beforeId ?? to.afterId;
      if (anchor) {
        const at = others.findIndex((n) => n.id === anchor);
        if (at < 0) return fail(t('The place it was to go has moved or been deleted.'));
        index = to.beforeId ? at : at + 1;
      }
      index = Math.min(index, others.length);
      await api.nodes.move(id, to.parentId, index);
      const undo: MoveUndo = { index };
      return { ok: true, undo };
    }),
  undo: (p, raw) =>
    guarded(async () => {
      const id = p.targetId ?? '';
      const info = raw as MoveUndo | undefined;
      const node = await api.nodes.get(id);
      if (node.deletedAt) return fail(goneSince());
      const { to, from, bookId } = p.payload;
      const tree = await api.nodes.tree(bookId);
      const at = childrenOf(tree, to.parentId).findIndex((n) => n.id === id);
      if ((node.parentId ?? null) !== to.parentId || at !== info?.index) return fail(changedSince());
      if (from.parentId && !tree.some((n) => n.id === from.parentId)) return fail(goneSince());
      await api.nodes.move(id, from.parentId, from.index);
      return { ok: true };
    }),
  accepted: () => t('Moved.'),
});

// ---------------------------------------------------------------------------
// A node's own details: title, status, synopsis, notes, word goal
// ---------------------------------------------------------------------------

interface NodeFields {
  title?: string;
  status?: NodeStatus;
  synopsis?: string;
  notes?: string;
  targetWords?: number;
}

interface NodeDetailsPayload {
  kind: string;
  changes: NodeFields;
  before: Required<NodeFields>;
}

function NodeDetailsCard({ proposal }: { proposal: AnyProposal<NodeDetailsPayload> }) {
  useLocale();
  const openRoute = useOpenRoute();
  const labels: Record<keyof NodeFields, string> = {
    title: t('Title'),
    status: t('Status'),
    synopsis: t('Synopsis'),
    notes: t('Notes'),
    targetWords: t('Target words'),
  };
  const { changes, before, kind } = proposal.payload;
  const sentence = kind === 'part' ? t('Details of the part {title}') : kind === 'chapter' ? t('Details of the chapter {title}') : t('Details of the scene {title}');
  const rows = (Object.keys(labels) as (keyof NodeFields)[])
    .filter((key) => changes[key] !== undefined)
    .map((key) => ({ label: labels[key], before: none(before[key]), after: none(changes[key]) }));
  return (
    <>
      <p className="mcp-proposal-title">
        {withElement(
          sentence,
          'title',
          <button type="button" className="link-button" onClick={() => openRoute({ view: 'write', nodeId: proposal.targetId ?? '' })}>
            {proposal.title || t('Untitled')}
          </button>,
        )}
      </p>
      <Changes rows={rows} />
    </>
  );
}

export const nodeDetailsKind = defineKind<NodeDetailsPayload>({
  kind: 'nodeDetails',
  Card: NodeDetailsCard,
  apply: (p) =>
    guarded(async () => {
      const id = p.targetId ?? '';
      if (!(await isLiveNode(id))) return fail(t('What this suggestion changes has been deleted.'));
      await api.nodes.update(id, p.payload.changes);
      return { ok: true };
    }),
  undo: (p) =>
    guarded(async () => {
      const id = p.targetId ?? '';
      const node = (await api.nodes.get(id)) as unknown as Record<string, unknown> & { deletedAt: string | null };
      if (node.deletedAt) return fail(goneSince());
      const restore: NodeFields = {};
      for (const [key, value] of Object.entries(p.payload.changes)) {
        if (node[key] !== value) return fail(changedSince());
        (restore as Record<string, unknown>)[key] = p.payload.before[key as keyof NodeFields];
      }
      await api.nodes.update(id, restore);
      return { ok: true };
    }),
  accepted: () => t('Details changed.'),
});

// ---------------------------------------------------------------------------
// The trash
// ---------------------------------------------------------------------------

interface TrashPayload {
  op: 'trash' | 'restore';
  kind: string;
  bookId: string;
}

function TrashCard({ proposal }: { proposal: AnyProposal<TrashPayload> }) {
  useLocale();
  const title = <strong>{proposal.title || t('Untitled')}</strong>;
  return (
    <p className="mcp-proposal-title">
      {proposal.payload.op === 'trash'
        ? withElement(t('Move {title} to the trash, with what is inside it.'), 'title', title)
        : withElement(t('Bring {title} back from the trash.'), 'title', title)}
    </p>
  );
}

async function restoreFromTrash(id: string): Promise<ApplyResult> {
  try {
    await sceneUndo.restore(id);
  } catch (error) {
    if (error instanceof RpcError && error.code === MERGED_TEXT_CHANGED) {
      return fail(t('This scene was merged into another one, which has changed since. Restore it yourself from the trash.'));
    }
    throw error;
  }
  return { ok: true };
}

interface TrashUndo {
  deletedAt: string | null;
}

export const nodeTrashKind = defineKind<TrashPayload>({
  kind: 'nodeTrash',
  Card: TrashCard,
  apply: (p) =>
    guarded(async () => {
      const id = p.targetId ?? '';
      const node = await api.nodes.get(id);
      if (p.payload.op === 'trash') {
        if (node.deletedAt) return fail(t('It is already in the trash.'));
        await api.nodes.remove(id);
        const undo: TrashUndo = { deletedAt: (await api.nodes.get(id)).deletedAt };
        return { ok: true, undo };
      }
      if (!node.deletedAt) return fail(t('It is no longer in the trash.'));
      return restoreFromTrash(id);
    }),
  undo: (p, raw) =>
    guarded(async () => {
      const id = p.targetId ?? '';
      const node = await api.nodes.get(id);
      if (p.payload.op === 'trash') {
        if (!node.deletedAt || node.deletedAt !== (raw as TrashUndo | undefined)?.deletedAt) return fail(changedSince());
        return restoreFromTrash(id);
      }
      if (node.deletedAt) return fail(goneSince());
      await api.nodes.remove(id);
      return { ok: true };
    }),
  accepted: () => t('Done. The trash keeps what was deleted.'),
});

// ---------------------------------------------------------------------------
// Splitting and merging scenes
// ---------------------------------------------------------------------------

let cachedSchema: Schema | null = null;
const schema = () => (cachedSchema ??= getSchema(documentExtensions()));

interface SplitPayload {
  quote: string;
  position: 'before' | 'after';
  newTitle?: string | null;
}

interface MergePayload {
  nextId: string;
  nextTitle: string;
}

function SplitCard({ proposal }: { proposal: AnyProposal<SplitPayload | MergePayload> }) {
  useLocale();
  const title = <strong>{proposal.title || t('Untitled')}</strong>;
  if (proposal.kind === 'sceneMerge') {
    const merge = proposal.payload as MergePayload;
    return (
      <>
        <p className="mcp-proposal-title">{withElement(t('Merge the next scene into {title}'), 'title', title)}</p>
        <p className="muted small">{t('“{next}” goes onto its end, and then to the trash.', { next: merge.nextTitle })}</p>
      </>
    );
  }
  const split = proposal.payload as SplitPayload;
  return (
    <>
      <p className="mcp-proposal-title">{withElement(t('Split the scene {title} in two'), 'title', title)}</p>
      <p className="muted small">
        {split.position === 'after'
          ? t('The new scene starts after “{quote}”.', { quote: split.quote.slice(0, 120) })
          : t('The new scene starts at “{quote}”.', { quote: split.quote.slice(0, 120) })}
      </p>
    </>
  );
}

interface SplitUndo {
  original: string;
  made: string;
}

/** True if `next` is the scene straight after `id` in its book's reading order. */
async function nextIs(id: string, next: string): Promise<boolean> {
  const node = await api.nodes.get(id);
  if (node.deletedAt) return false;
  return neighborScene(indexTree(await api.nodes.tree(node.bookId)), id, 1)?.id === next;
}

export const sceneSplitKind = defineKind<SplitPayload>({
  kind: 'sceneSplit',
  Card: SplitCard,
  apply: (p) =>
    guarded(async () => {
      const id = p.targetId ?? '';
      const node = await api.nodes.get(id);
      if (node.deletedAt) return fail(t('What this suggestion changes has been deleted.'));
      const doc = ProseNode.fromJSON(schema(), node.content);
      const found = findQuote(doc, p.payload.quote);
      if ('problem' in found) {
        return fail(found.problem === 'repeated'
          ? t('The quoted text now appears more than once, so it is not clear which to change.')
          : t('The quoted text is no longer there, because the document has changed since this was suggested.'));
      }
      const parts = splitDocAt(doc, p.payload.position === 'after' ? found.to : found.from);
      if (!parts) return fail(t('One half would be empty, so the scene was not split.'));
      const made = p.payload.newTitle
        ? await rpc<NodeMeta>('nodes.split', { id, before: parts.before, after: parts.after, title: p.payload.newTitle })
        : await splitScene(id, parts.before, parts.after);
      const undo: SplitUndo = { original: id, made: made.id };
      return { ok: true, target: { targetKind: 'node', targetId: id }, undo };
    }),
  // Merging the halves back gives the text exactly as it was, while neither has changed.
  undo: (_p, raw) =>
    guarded(async () => {
      const info = raw as SplitUndo | undefined;
      if (!info?.made || !(await isLiveNode(info.made))) return fail(goneSince());
      if (!(await nextIs(info.original, info.made))) {
        return fail(t('The two halves are no longer next to each other, so the split cannot be undone here. Each half has its history.'));
      }
      await mergeScene(info.original);
      return { ok: true };
    }),
  accepted: () => t('Scene split in two.'),
});

export const sceneMergeKind = defineKind<MergePayload>({
  kind: 'sceneMerge',
  Card: SplitCard,
  apply: (p) =>
    guarded(async () => {
      const id = p.targetId ?? '';
      if (!(await nextIs(id, p.payload.nextId))) return fail(t('These scenes are no longer next to each other.'));
      await mergeScene(id);
      return { ok: true, target: { targetKind: 'node', targetId: id } };
    }),
  // Restoring the merged scene takes its text back out of the one it went into.
  undo: (p) =>
    guarded(async () => {
      const node = await api.nodes.get(p.payload.nextId);
      if (!node.deletedAt) return fail(changedSince());
      try {
        await sceneUndo.restore(p.payload.nextId);
      } catch (error) {
        if (error instanceof RpcError && error.code === MERGED_TEXT_CHANGED) return fail(changedSince());
        throw error;
      }
      return { ok: true };
    }),
  accepted: () => t('Scenes merged. The old scene is in the trash.'),
});

// ---------------------------------------------------------------------------
// Plot threads
// ---------------------------------------------------------------------------

type ThreadPayload =
  | { op: 'create'; name: string; description: string }
  | { op: 'update'; changes: { name?: string; description?: string }; before: { name: string; description: string } }
  | { op: 'delete'; before: { name: string; color: string; description: string; position: number; sceneIds: string[] } }
  | { op: 'link'; on: boolean; threadId: string; threadName: string; nodeId: string; sceneTitle: string; bookTitle: string };

function ThreadCard({ proposal }: { proposal: AnyProposal<ThreadPayload> }) {
  useLocale();
  const p = proposal.payload;
  const name = <strong>{proposal.title}</strong>;
  if (p.op === 'create') {
    return (
      <>
        <p className="mcp-proposal-title">{withElement(t('New plot thread: {name}'), 'name', name)}</p>
        {p.description && <p>{p.description}</p>}
      </>
    );
  }
  if (p.op === 'update') {
    const rows = [
      p.changes.name !== undefined ? { label: t('Name'), before: p.before.name, after: p.changes.name } : null,
      p.changes.description !== undefined ? { label: t('Description'), before: none(p.before.description), after: none(p.changes.description) } : null,
    ].filter((row): row is { label: string; before: string; after: string } => !!row);
    return (
      <>
        <p className="mcp-proposal-title">{withElement(t('Plot thread {name}'), 'name', name)}</p>
        <Changes rows={rows} />
      </>
    );
  }
  if (p.op === 'delete') {
    return (
      <>
        <p className="mcp-proposal-title">{withElement(t('Delete the plot thread {name}'), 'name', name)}</p>
        <p className="muted small">{t('Its scenes stay as they are. Undo brings the thread back with them.')}</p>
      </>
    );
  }
  return (
    <p className="mcp-proposal-title">
      {p.on
        ? t('Add “{scene}” to the plot thread “{thread}”.', { scene: p.sceneTitle, thread: p.threadName })
        : t('Take “{scene}” out of the plot thread “{thread}”.', { scene: p.sceneTitle, thread: p.threadName })}
    </p>
  );
}

async function findThread(id: string): Promise<Thread | undefined> {
  return (await threads.list()).find((th) => th.id === id);
}

/** Whether a scene is in a thread now. */
async function linked(threadId: string, nodeId: string): Promise<boolean> {
  const node = await api.nodes.get(nodeId);
  return (await threads.links(node.bookId)).some((l) => l.threadId === threadId && l.nodeId === nodeId);
}

/** Every scene in a thread, across the books. */
async function threadScenes(threadId: string): Promise<string[]> {
  const out: string[] = [];
  for (const book of await api.books.list()) {
    for (const link of await threads.links(book.id)) if (link.threadId === threadId) out.push(link.nodeId);
  }
  return out;
}

interface ThreadUndo {
  id?: string;
}

export const threadKind = defineKind<ThreadPayload>({
  kind: 'thread',
  Card: ThreadCard,
  apply: (p) =>
    guarded(async () => {
      const payload = p.payload;
      if (payload.op === 'create') {
        const made = await threads.create(payload.name);
        if (payload.description) await threads.update(made.id, { description: payload.description });
        const undo: ThreadUndo = { id: made.id };
        return { ok: true, undo };
      }
      const id = payload.op === 'link' ? payload.threadId : (p.targetId ?? '');
      if (!(await findThread(id))) return fail(t('What this suggestion changes has been deleted.'));
      if (payload.op === 'update') await threads.update(id, payload.changes);
      else if (payload.op === 'delete') await threads.remove(id);
      else {
        if (!(await isLiveNode(payload.nodeId))) return fail(t('What this suggestion changes has been deleted.'));
        await threads.setLink(payload.nodeId, id, payload.on);
      }
      return { ok: true };
    }),
  undo: (p, raw) =>
    guarded(async () => {
      const payload = p.payload;
      if (payload.op === 'create') {
        const id = (raw as ThreadUndo | undefined)?.id ?? '';
        const now = await findThread(id);
        if (!now) return fail(goneSince());
        if (now.name !== payload.name || (await threadScenes(id)).length > 0) return fail(changedSince());
        await threads.remove(id);
        return { ok: true };
      }
      if (payload.op === 'delete') {
        // The old thread is gone for good, so a new one takes its name, place and scenes.
        const { before } = payload;
        const made = await threads.create(before.name, before.color);
        if (before.description) await threads.update(made.id, { description: before.description });
        for (const nodeId of before.sceneIds) {
          if (await isLiveNode(nodeId)) await threads.setLink(nodeId, made.id, true);
        }
        const order = (await threads.list()).map((th) => th.id).filter((id) => id !== made.id);
        order.splice(Math.min(before.position, order.length), 0, made.id);
        await threads.reorder(order);
        return { ok: true };
      }
      if (payload.op === 'update') {
        const now = await findThread(p.targetId ?? '');
        if (!now) return fail(goneSince());
        const restore: { name?: string; description?: string } = {};
        for (const key of Object.keys(payload.changes) as ('name' | 'description')[]) {
          if (now[key] !== payload.changes[key]) return fail(changedSince());
          restore[key] = payload.before[key];
        }
        await threads.update(now.id, restore);
        return { ok: true };
      }
      if (!(await findThread(payload.threadId)) || !(await isLiveNode(payload.nodeId))) return fail(goneSince());
      if ((await linked(payload.threadId, payload.nodeId)) !== payload.on) return fail(changedSince());
      await threads.setLink(payload.nodeId, payload.threadId, !payload.on);
      return { ok: true };
    }),
  accepted: () => t('Plot threads changed.'),
});

export const STRUCTURE_KINDS = [
  bookCreateKind,
  bookSettingsKind,
  nodeMoveKind,
  nodeDetailsKind,
  nodeTrashKind,
  sceneSplitKind,
  sceneMergeKind,
  threadKind,
];
