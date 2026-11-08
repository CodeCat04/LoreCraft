/**
 * Changes to the wiki from outside tools: a page's details and infobox, a rename, the trash,
 * a Talk note, relationships and map pins. Each applies through the same RPCs the app's own
 * views use, and Undo puts the old values back unless the target has changed since.
 */

import * as api from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage, RpcError } from '../../lib/rpc';
import * as extras from '../../extras/api';
import { useLocale } from '../../state/language';
import { compareTexts } from '../../wiki/diff';
import type { PagePatch } from '../../lib/api';
import type { InfoboxField, Page, PmNode } from '../../lib/types';
import type { AnyProposal } from '../api';
import { changedSince, DiffView, fingerprint, flushFirst, goneSince, markdownDoc, MarkdownPreview, useOpenRoute, withElement } from './shared';
import { defineKind, type ApplyResult, type UndoResult } from './types';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** JSON with its keys sorted, so two copies of the same data compare equal. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

async function livePage(id: string | null): Promise<Page | null> {
  if (!id) return null;
  try {
    const page = await api.pages.get(id);
    return page.deletedAt ? null : page;
  } catch (error) {
    if (error instanceof RpcError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

async function attempt(run: () => Promise<ApplyResult>): Promise<ApplyResult> {
  const problem = await flushFirst();
  if (problem) return { ok: false, reason: problem };
  try {
    return await run();
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function attemptUndo(run: () => Promise<UndoResult>): Promise<UndoResult> {
  const problem = await flushFirst();
  if (problem) return { ok: false, reason: problem };
  try {
    return await run();
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

const pageTarget = (p: AnyProposal) => ({ targetKind: 'page', targetId: p.targetId ?? '' });

function PageTitle({ proposal, template }: { proposal: AnyProposal; template: string }) {
  const openRoute = useOpenRoute();
  return (
    <p className="mcp-proposal-title">
      {withElement(
        template,
        'title',
        <button type="button" className="link-button" onClick={() => openRoute({ view: 'page', id: proposal.targetId ?? '' })}>
          {proposal.title}
        </button>,
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// A page's details
// ---------------------------------------------------------------------------

interface PageDetails {
  summary?: string;
  status?: string;
  pageType?: string;
  aliases?: string[];
  categories?: string[];
}
export interface PageUpdatePayload {
  changes: PageDetails;
  before: Required<PageDetails>;
}

const DETAIL_KEYS = ['summary', 'status', 'pageType', 'aliases', 'categories'] as const;

function detailText(value: PageDetails[keyof PageDetails]): string {
  if (Array.isArray(value)) return value.join(', ') || t('(none)');
  return value ? String(value) : t('(none)');
}

function sameDetail(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const norm = (list: unknown[]) => list.map((s) => String(s).toLowerCase()).sort().join('\n');
    return norm(a) === norm(b);
  }
  return (a ?? '') === (b ?? '');
}

function PageUpdateCard({ proposal }: { proposal: AnyProposal<PageUpdatePayload> }) {
  useLocale();
  const { changes, before } = proposal.payload;
  const labels: Record<(typeof DETAIL_KEYS)[number], string> = {
    summary: t('Summary'),
    status: t('Status'),
    pageType: t('Page type'),
    aliases: t('Aliases'),
    categories: t('Categories'),
  };
  return (
    <>
      <PageTitle proposal={proposal} template={t('Details of the page {title}')} />
      <dl className="mcp-infobox mcp-details">
        {DETAIL_KEYS.filter((key) => changes[key] !== undefined).map((key) => (
          <div key={key}>
            <dt>{labels[key]}</dt>
            <dd>
              <DiffView lines={compareTexts(detailText(before[key]), detailText(changes[key]))} />
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export const pageUpdateKind = defineKind<PageUpdatePayload>({
  kind: 'pageUpdate',
  Card: PageUpdateCard,
  apply: (p) =>
    attempt(async () => {
      const page = await livePage(p.targetId);
      if (!page) return { ok: false, reason: goneSince() };
      const { changes, before } = p.payload;
      // A detail the writer changed since the suggestion was made is theirs.
      if (DETAIL_KEYS.some((key) => changes[key] !== undefined && !sameDetail(page[key], before[key]))) {
        return { ok: false, reason: t('The page has changed since this was suggested.') };
      }
      await api.pages.update(page.id, changes as PagePatch);
      return { ok: true, target: pageTarget(p) };
    }),
  undo: (p) =>
    attemptUndo(async () => {
      const page = await livePage(p.targetId);
      if (!page) return { ok: false, reason: goneSince() };
      const { changes, before } = p.payload;
      const keys = DETAIL_KEYS.filter((key) => changes[key] !== undefined);
      if (keys.some((key) => !sameDetail(page[key], changes[key]))) return { ok: false, reason: changedSince() };
      const patch: PageDetails = {};
      for (const key of keys) (patch as Record<string, unknown>)[key] = before[key];
      await api.pages.update(page.id, patch as PagePatch);
      return { ok: true };
    }),
  accepted: () => t('Page details changed.'),
});

// ---------------------------------------------------------------------------
// Infobox fields
// ---------------------------------------------------------------------------

export interface InfoboxFieldsPayload {
  fields: InfoboxField[];
  before: InfoboxField[];
}

function InfoboxFieldsCard({ proposal }: { proposal: AnyProposal<InfoboxFieldsPayload> }) {
  useLocale();
  const { fields, before } = proposal.payload;
  const line = (f: InfoboxField) => `${f.label}: ${f.value}`;
  return (
    <>
      <PageTitle proposal={proposal} template={t('Infobox of {title}')} />
      <DiffView lines={compareTexts(before.map(line).join('\n\n'), fields.map(line).join('\n\n'))} />
    </>
  );
}

async function setFields(page: Page, fields: InfoboxField[]): Promise<void> {
  await api.pages.update(page.id, { infobox: { ...page.infobox, fields } });
}

export const infoboxFieldsKind = defineKind<InfoboxFieldsPayload>({
  kind: 'infoboxFields',
  Card: InfoboxFieldsCard,
  apply: (p) =>
    attempt(async () => {
      const page = await livePage(p.targetId);
      if (!page) return { ok: false, reason: goneSince() };
      if (stable(page.infobox.fields ?? []) !== stable(p.payload.before)) {
        return { ok: false, reason: t('The infobox has changed since this was suggested.') };
      }
      await setFields(page, p.payload.fields);
      return { ok: true, target: pageTarget(p) };
    }),
  undo: (p) =>
    attemptUndo(async () => {
      const page = await livePage(p.targetId);
      if (!page) return { ok: false, reason: goneSince() };
      if (stable(page.infobox.fields ?? []) !== stable(p.payload.fields)) return { ok: false, reason: changedSince() };
      await setFields(page, p.payload.before);
      return { ok: true };
    }),
  accepted: () => t('Infobox changed.'),
});

// ---------------------------------------------------------------------------
// Renaming
// ---------------------------------------------------------------------------

export interface PageRenamePayload {
  oldTitle: string;
  newTitle: string;
  updateLinks: boolean;
  keepAlias: boolean;
  documents: number;
  linking?: string[];
}

function PageRenameCard({ proposal }: { proposal: AnyProposal<PageRenamePayload> }) {
  useLocale();
  const { newTitle, documents, linking, updateLinks } = proposal.payload;
  return (
    <>
      <PageTitle proposal={proposal} template={t('Rename {title}')} />
      <p>{withElement(t('New title: {title}'), 'title', <strong>{newTitle}</strong>)}</p>
      <p className="muted small">
        {!updateLinks || documents === 0
          ? t('No links change.')
          : documents === 1
            ? t('Links in 1 document change.')
            : t('Links in {count} documents change.', { count: documents })}
        {linking && linking.length > 0 ? ` ${linking.join(', ')}` : ''}
      </p>
    </>
  );
}

export const pageRenameKind = defineKind<PageRenamePayload>({
  kind: 'pageRename',
  Card: PageRenameCard,
  apply: (p) =>
    attempt(async () => {
      const page = await livePage(p.targetId);
      if (!page) return { ok: false, reason: goneSince() };
      if (page.title !== p.payload.oldTitle) return { ok: false, reason: t('The page has been renamed since this was suggested.') };
      const done = await api.pages.rename(page.id, p.payload.newTitle, p.payload.updateLinks, p.payload.keepAlias);
      return { ok: true, target: pageTarget(p), undo: { documentsChanged: done.documentsChanged } };
    }),
  undo: (p) =>
    attemptUndo(async () => {
      const page = await livePage(p.targetId);
      if (!page) return { ok: false, reason: goneSince() };
      if (page.title !== p.payload.newTitle) return { ok: false, reason: changedSince() };
      // Links follow back, and the new title is not kept as an alias.
      await api.pages.rename(page.id, p.payload.oldTitle, p.payload.updateLinks, false);
      return { ok: true };
    }),
  accepted: () => t('Page renamed.'),
});

// ---------------------------------------------------------------------------
// The trash
// ---------------------------------------------------------------------------

export interface PageTrashPayload {
  action: 'trash' | 'restore';
}

function PageTrashCard({ proposal }: { proposal: AnyProposal<PageTrashPayload> }) {
  useLocale();
  return (
    <PageTitle
      proposal={proposal}
      template={proposal.payload.action === 'trash' ? t('Move {title} to the trash') : t('Restore {title} from the trash')}
    />
  );
}

async function pageState(id: string | null): Promise<'live' | 'trashed' | 'gone'> {
  if (!id) return 'gone';
  try {
    return (await api.pages.get(id)).deletedAt ? 'trashed' : 'live';
  } catch (error) {
    if (error instanceof RpcError && error.code === 'NOT_FOUND') return 'gone';
    throw error;
  }
}

export const pageTrashKind = defineKind<PageTrashPayload>({
  kind: 'pageTrash',
  Card: PageTrashCard,
  apply: (p) =>
    attempt(async () => {
      const id = p.targetId ?? '';
      const state = await pageState(id);
      if (p.payload.action === 'trash') {
        if (state !== 'live') return { ok: false, reason: goneSince() };
        await api.pages.remove(id);
      } else {
        if (state !== 'trashed') return { ok: false, reason: t('The page is not in the trash.') };
        await api.pages.restore(id);
      }
      return { ok: true, target: pageTarget(p) };
    }),
  undo: (p) =>
    attemptUndo(async () => {
      const id = p.targetId ?? '';
      const state = await pageState(id);
      if (p.payload.action === 'trash') {
        if (state !== 'trashed') return { ok: false, reason: changedSince() };
        await api.pages.restore(id);
      } else {
        if (state !== 'live') return { ok: false, reason: changedSince() };
        await api.pages.remove(id);
      }
      return { ok: true };
    }),
  accepted: () => t('Done.'),
});

// ---------------------------------------------------------------------------
// Talk
// ---------------------------------------------------------------------------

export interface TalkNotePayload {
  text: string;
  before: PmNode | null;
}

const EMPTY_NOTES: PmNode = { type: 'doc', content: [{ type: 'paragraph' }] };

/** The notes with the new note after them. An empty first paragraph is dropped. */
export function withNote(notes: PmNode | null, text: string): PmNode {
  const old = (notes?.content ?? []).filter((n, _i, all) => !(all.length === 1 && n.type === 'paragraph' && !n.content?.length));
  return { type: 'doc', content: [...old, ...(markdownDoc(text).content ?? [])] };
}

function TalkNoteCard({ proposal }: { proposal: AnyProposal<TalkNotePayload> }) {
  useLocale();
  return (
    <>
      <PageTitle proposal={proposal} template={t('A note on the Talk tab of {title}')} />
      <MarkdownPreview text={proposal.payload.text} />
    </>
  );
}

export const talkNoteKind = defineKind<TalkNotePayload>({
  kind: 'talkNote',
  Card: TalkNoteCard,
  apply: (p) =>
    attempt(async () => {
      const page = await livePage(p.targetId);
      if (!page) return { ok: false, reason: goneSince() };
      const notes = withNote(page.notes, p.payload.text);
      await api.pages.update(page.id, { notes });
      const after = await livePage(page.id);
      return { ok: true, target: pageTarget(p), undo: { before: page.notes, after: fingerprint(after?.notes ?? null) } };
    }),
  undo: (p, undo) =>
    attemptUndo(async () => {
      const info = undo as { before: PmNode | null; after: string } | undefined;
      const page = await livePage(p.targetId);
      if (!page || !info) return { ok: false, reason: goneSince() };
      if (fingerprint(page.notes ?? null) !== info.after) return { ok: false, reason: changedSince() };
      await api.pages.update(page.id, { notes: info.before ?? EMPTY_NOTES });
      return { ok: true };
    }),
  accepted: () => t('Note added to the Talk tab.'),
});

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export interface RelationshipPayload {
  action: 'add' | 'remove';
  id?: string;
  fromPageId: string;
  fromTitle: string;
  toPageId: string;
  toTitle: string;
  kind: string;
  note: string;
}

function RelationshipCard({ proposal }: { proposal: AnyProposal<RelationshipPayload> }) {
  useLocale();
  const { action, fromTitle, toTitle, kind, note } = proposal.payload;
  const fact = `${fromTitle} — ${kind} — ${toTitle}`;
  return (
    <>
      <p className="mcp-proposal-title">{action === 'add' ? t('New relationship: {fact}', { fact }) : t('Remove the relationship: {fact}', { fact })}</p>
      {note && <p className="muted small">{note}</p>}
    </>
  );
}

async function relationshipExists(pageId: string, id: string): Promise<boolean> {
  return (await extras.relationshipList(pageId)).some((r) => r.id === id);
}

async function addRelationship(p: RelationshipPayload): Promise<string> {
  const row = await extras.relationshipAdd({ fromPageId: p.fromPageId, toPageId: p.toPageId, kind: p.kind, note: p.note });
  return row.id;
}

export const relationshipKind = defineKind<RelationshipPayload>({
  kind: 'relationship',
  Card: RelationshipCard,
  apply: (p) =>
    attempt(async () => {
      const payload = p.payload;
      if (payload.action === 'add') {
        const id = await addRelationship(payload);
        return { ok: true, undo: { id } };
      }
      if (!payload.id || !(await relationshipExists(payload.fromPageId, payload.id))) return { ok: false, reason: goneSince() };
      await extras.relationshipDelete(payload.id);
      return { ok: true };
    }),
  undo: (p, undo) =>
    attemptUndo(async () => {
      const payload = p.payload;
      if (payload.action === 'add') {
        const id = (undo as { id?: string } | undefined)?.id;
        if (!id || !(await relationshipExists(payload.fromPageId, id))) return { ok: false, reason: goneSince() };
        await extras.relationshipDelete(id);
        return { ok: true };
      }
      await addRelationship(payload);
      return { ok: true };
    }),
  accepted: () => t('Relationship changed.'),
});

// ---------------------------------------------------------------------------
// Map pins
// ---------------------------------------------------------------------------

export interface MapPinPayload {
  action: 'add' | 'move' | 'remove';
  mapId: string;
  mapTitle: string;
  pinId?: string;
  pageId: string | null;
  pageTitle: string | null;
  label: string;
  x: number;
  y: number;
  before?: { x: number; y: number };
}

function MapPinCard({ proposal }: { proposal: AnyProposal<MapPinPayload> }) {
  useLocale();
  const { action, x, y, before } = proposal.payload;
  const where = (pos: { x: number; y: number }) => t('{x} across, {y} down', { x: `${Math.round(pos.x * 100)}%`, y: `${Math.round(pos.y * 100)}%` });
  const text =
    action === 'add'
      ? t('New pin: {title}', { title: proposal.title })
      : action === 'move'
        ? t('Move the pin: {title}', { title: proposal.title })
        : t('Remove the pin: {title}', { title: proposal.title });
  return (
    <>
      <p className="mcp-proposal-title">{text}</p>
      <p className="muted small">
        {action === 'move' && before ? `${where(before)} → ${where({ x, y })}` : where(action === 'remove' && before ? before : { x, y })}
      </p>
    </>
  );
}

async function findPin(mapId: string, id: string) {
  try {
    return (await extras.mapGet(mapId)).pins.find((pin) => pin.id === id) ?? null;
  } catch (error) {
    if (error instanceof RpcError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

async function addPin(p: MapPinPayload, at: { x: number; y: number }): Promise<string> {
  const pin = await extras.pinAdd({ mapId: p.mapId, pageId: p.pageId ?? undefined, label: p.label, x: at.x, y: at.y });
  return pin.id;
}

const samePlace = (pin: { x: number; y: number }, at: { x: number; y: number }) => Math.abs(pin.x - at.x) < 1e-9 && Math.abs(pin.y - at.y) < 1e-9;

export const mapPinKind = defineKind<MapPinPayload>({
  kind: 'mapPin',
  Card: MapPinCard,
  apply: (p) =>
    attempt(async () => {
      const payload = p.payload;
      if (payload.action === 'add') return { ok: true, undo: { id: await addPin(payload, payload) } };
      const pin = payload.pinId ? await findPin(payload.mapId, payload.pinId) : null;
      if (!pin) return { ok: false, reason: goneSince() };
      if (payload.before && !samePlace(pin, payload.before)) return { ok: false, reason: t('The pin has moved since this was suggested.') };
      if (payload.action === 'move') {
        await extras.pinUpdate(pin.id, { x: payload.x, y: payload.y });
        return { ok: true, undo: { id: pin.id } };
      }
      await extras.pinDelete(pin.id);
      return { ok: true };
    }),
  undo: (p, undo) =>
    attemptUndo(async () => {
      const payload = p.payload;
      if (payload.action === 'remove') {
        await addPin(payload, payload.before ?? payload);
        return { ok: true };
      }
      const id = (undo as { id?: string } | undefined)?.id;
      const pin = id ? await findPin(payload.mapId, id) : null;
      if (!pin) return { ok: false, reason: goneSince() };
      if (!samePlace(pin, payload)) return { ok: false, reason: changedSince() };
      if (payload.action === 'add') await extras.pinDelete(pin.id);
      else if (payload.before) await extras.pinUpdate(pin.id, { x: payload.before.x, y: payload.before.y });
      return { ok: true };
    }),
  accepted: () => t('Map changed.'),
});

export const WIKI_KINDS = [pageUpdateKind, infoboxFieldsKind, pageRenameKind, pageTrashKind, talkNoteKind, relationshipKind, mapPinKind];
