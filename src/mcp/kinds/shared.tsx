/** Pieces every kind can use: card parts, and the checks and writes that keep apply and undo safe. */

import { useMemo, useState, type ReactNode } from 'react';

import * as api from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage, RpcError } from '../../lib/rpc';
import { renderMarkdownSafe, markdownToPm } from '../../editor/convert';
import { followRenderedLink } from '../../editor/renderedLinks';
import { withoutModelMedia } from '../../editor/ai/hunks';
import { flushOrStop } from '../../editor/saving';
import { useLocale } from '../../state/language';
import { useNav, type Route } from '../../state/nav';
import { useSettings } from '../../state/settings';
import { type DiffLine } from '../../wiki/diff';
import type { PmNode } from '../../lib/types';
import type { UndoResult } from './types';

/** A translated sentence with an element, such as a link, where `{name}` is. */
export function withElement(template: string, name: string, element: ReactNode): ReactNode {
  const [before, after = ''] = template.split(`{${name}}`);
  return (
    <>
      {before}
      {element}
      {after}
    </>
  );
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="mcp-diff">
      {lines.map((line, index) => (
        <p key={index} className="mcp-diff-line">
          {line.runs.map((run, i) =>
            run.kind === 'ins' ? <ins key={i}>{run.text}</ins> : run.kind === 'del' ? <del key={i}>{run.text}</del> : <span key={i}>{run.text}</span>,
          )}
        </p>
      ))}
    </div>
  );
}

/** Long previews are cut, since the scene itself shows them in full. */
const PREVIEW_LINES = 60;

export function LongDiff({ lines }: { lines: DiffLine[] }) {
  useLocale();
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, PREVIEW_LINES);
  return (
    <>
      <DiffView lines={shown} />
      {!all && lines.length > PREVIEW_LINES && (
        <button type="button" className="link-button small" onClick={() => setAll(true)}>
          {t('Show all {count} paragraphs', { count: lines.length })}
        </button>
      )}
    </>
  );
}

export function MarkdownPreview({ text }: { text: string | undefined }) {
  const html = useMemo(() => renderMarkdownSafe(text ?? ''), [text]);
  if (!text?.trim()) return null;
  // renderMarkdownSafe escapes all HTML, since this text came from an outside AI.
  return <div className="mcp-new-page prose" onClick={followRenderedLink} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Opens a route the way the list is shown: beside it when pinned or split, else in place. */
export function useOpenRoute(): (route: Route, keepFocus?: boolean) => void {
  const go = useNav((s) => s.go);
  const split = useNav((s) => s.panes.length > 1);
  const pinned = useSettings((s) => s.settings.mcp.pinned);
  return (route, keepFocus = true) => {
    if (pinned || split) useNav.getState().openBeside(route, { keepFocus });
    else go(route);
  };
}

export function targetRoute(proposal: { targetKind: string | null; targetId: string | null }): Route {
  return proposal.targetKind === 'page' ? { view: 'page', id: proposal.targetId ?? '' } : { view: 'write', nodeId: proposal.targetId ?? '' };
}

// ---------------------------------------------------------------------------
// Applying and undoing
// ---------------------------------------------------------------------------

/** What the writer typed in the last moments counts. Returns a reason if saving failed. */
export async function flushFirst(): Promise<string | null> {
  try {
    await flushOrStop();
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

/** A page's or scene's text now, or null if it has been deleted. */
export async function currentDocument(kind: 'page' | 'node', id: string): Promise<PmNode | null> {
  try {
    if (kind === 'page') {
      const page = await api.pages.get(id);
      return page.deletedAt ? null : page.content;
    }
    const node = await api.nodes.get(id);
    return node.deletedAt ? null : node.content;
  } catch (error) {
    if (error instanceof RpcError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export async function isLiveNode(id: string): Promise<boolean> {
  try {
    return !(await api.nodes.get(id)).deletedAt;
  } catch {
    return false;
  }
}

/** Text from an outside AI as a document, without any media it may have named. */
export function markdownDoc(text: string | undefined): PmNode {
  const parsed = markdownToPm(text ?? '');
  const content = withoutModelMedia(parsed.content);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** A short fingerprint of a document, to tell later whether it has changed. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export const changedSince = () => t('This has changed since the outside AI made the change, so undoing it could lose newer work. Open History to restore an older version.');
export const goneSince = () => t('What this change made or changed has been deleted.');

/** What a text change keeps to be undone: the revision saved just before, and the text after. */
export interface TextUndo {
  kind: 'page' | 'node';
  id: string;
  revision: string | null;
  after: string;
}

/**
 * Writes a new text over a page or scene, with the old version saved in History first, the
 * way Accept always has. Returns what Undo needs.
 */
export async function writeText(kind: 'page' | 'node', id: string, doc: PmNode): Promise<TextUndo> {
  let revision = await api.revisions.checkpoint(kind, id, 'ai');
  // Nothing new to save means the latest revision already holds this text.
  if (!revision) revision = (await api.revisions.list(kind, id))[0]?.id ?? null;
  if (kind === 'page') await api.pages.update(id, { content: doc });
  else await api.nodes.update(id, { content: doc });
  const after = await currentDocument(kind, id);
  return { kind, id, revision, after: fingerprint(after) };
}

/** Puts back the revision saved before a text change, unless the text has changed since. */
export async function undoText(undo: unknown): Promise<UndoResult> {
  const info = undo as TextUndo | undefined;
  if (!info?.revision) return { ok: false, reason: t('There is no earlier version to go back to.') };
  const problem = await flushFirst();
  if (problem) return { ok: false, reason: problem };
  const now = await currentDocument(info.kind, info.id);
  if (!now) return { ok: false, reason: goneSince() };
  if (fingerprint(now) !== info.after) return { ok: false, reason: changedSince() };
  await api.revisions.restore(info.revision);
  return { ok: true };
}

/** What a creation keeps to be undone: what it made, and when that was last changed. */
export interface CreatedUndo {
  kind: 'page' | 'node';
  id: string;
  updatedAt: string;
}

/** Moves something an outside AI created to the trash, unless it has changed since. */
export async function undoCreated(undo: unknown): Promise<UndoResult> {
  const info = undo as CreatedUndo | undefined;
  if (!info?.id) return { ok: false, reason: goneSince() };
  const problem = await flushFirst();
  if (problem) return { ok: false, reason: problem };
  try {
    const item = info.kind === 'page' ? await api.pages.get(info.id) : await api.nodes.get(info.id);
    if (item.deletedAt) return { ok: false, reason: goneSince() };
    if (item.updatedAt !== info.updatedAt) return { ok: false, reason: changedSince() };
    if (info.kind === 'page') await api.pages.remove(info.id);
    else await api.nodes.remove(info.id);
  } catch (error) {
    if (error instanceof RpcError && error.code === 'NOT_FOUND') return { ok: false, reason: goneSince() };
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}
