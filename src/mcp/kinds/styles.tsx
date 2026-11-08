/**
 * Writing styles from the MCP style tools: a new custom style (or a blend), a change to one,
 * deleting one, and the default style for the project, a book or a scene. Every change goes
 * through the style store (`src/writingStyles/store.ts`), so the Writing styles screen, the
 * pickers and the project's stored copies stay in step. Each payload keeps the old values,
 * which Undo puts back unless the style or choice has changed since.
 */

import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { useLocale } from '../../state/language';
import { useSettings } from '../../state/settings';
import { compareTexts } from '../../wiki/diff';
import { blendStyles } from '../../writingStyles/prompt';
import { deleteCustomStyle, getActiveStyle, getStyle, saveCustomStyle, setActiveStyle, toggleFavorite } from '../../writingStyles/store';
import {
  GENRES,
  TRAIT_FIELDS,
  traitLabel,
  type BlendPart,
  type BlendWeight,
  type CustomStyle,
  type Genre,
  type StyleScope,
  type StyleTraits,
  type TraitKey,
} from '../../writingStyles/types';
import type { AnyProposal } from '../api';
import { changedSince, DiffView, goneSince, isLiveNode } from './shared';
import { defineKind, type ApplyResult, type ProposalKind, type UndoResult } from './types';

/** The fields a tool can give a style, as the Rust tools name them. */
interface StyleFields {
  name?: string;
  summary?: string;
  promptOverride?: string;
  traits?: Partial<StyleTraits>;
  genres?: string[];
}

export interface NewStylePayload extends StyleFields {
  name: string;
  blend?: { styleId: string; name: string; weight: BlendWeight }[];
}

export interface UpdateStylePayload {
  id: string;
  changes: StyleFields;
  before: CustomStyle;
}

export interface DeleteStylePayload {
  id: string;
  before: CustomStyle;
}

export interface DefaultStylePayload {
  scope: StyleScope;
  place: string;
  styleId: string | null;
  styleName: string | null;
  before: string | null;
}

/** JSON with sorted keys, so a style read back from the settings compares equal. */
export function stamp(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

const genreIds = new Set<string>(GENRES.map((g) => g.id));
const knownGenres = (list: string[] | undefined): Genre[] => (list ?? []).filter((g) => genreIds.has(g)) as Genre[];

function emptyTraits(): StyleTraits {
  return Object.fromEntries(TRAIT_FIELDS.map(({ key }) => [key, ''])) as unknown as StyleTraits;
}

function customNow(id: string): CustomStyle | null {
  const style = getStyle(id);
  return style?.kind === 'custom' ? style : null;
}

/** A style with a tool's changes in it. Traits merge; an empty prompt clears it. */
function withChanges(style: CustomStyle, changes: StyleFields): CustomStyle {
  const next: CustomStyle = { ...style };
  if (changes.name !== undefined) next.name = changes.name;
  if (changes.summary !== undefined) next.summary = changes.summary;
  if (changes.promptOverride !== undefined) next.promptOverride = changes.promptOverride.trim() || undefined;
  if (changes.traits) next.traits = { ...style.traits, ...changes.traits };
  if (changes.genres) next.genres = knownGenres(changes.genres);
  return next;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function Fields({ fields, before }: { fields: StyleFields; before?: CustomStyle }) {
  const rows: { label: string; old: string; now: string }[] = [];
  if (fields.name !== undefined) rows.push({ label: t('Name'), old: before?.name ?? '', now: fields.name });
  if (fields.summary !== undefined) rows.push({ label: t('Description'), old: before?.summary ?? '', now: fields.summary });
  if (fields.promptOverride !== undefined) rows.push({ label: t('Prompt'), old: before?.promptOverride ?? '', now: fields.promptOverride });
  for (const { key } of TRAIT_FIELDS) {
    const now = fields.traits?.[key];
    if (now !== undefined && now !== (before?.traits[key] ?? '')) rows.push({ label: traitLabel(key as TraitKey), old: before?.traits[key] ?? '', now });
  }
  if (fields.genres) rows.push({ label: t('Genres'), old: before?.genres.join(', ') ?? '', now: fields.genres.join(', ') });
  return (
    <dl className="mcp-infobox mcp-details">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>
            <DiffView lines={compareTexts(row.old, row.now)} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function NewStyleCard({ proposal }: { proposal: AnyProposal<NewStylePayload> }) {
  useLocale();
  const { name, blend } = proposal.payload;
  return (
    <>
      <p className="mcp-proposal-title">{t('New writing style: {name}', { name })}</p>
      {blend?.length ? (
        <p>{t('A blend of {styles}.', { styles: blend.map((part) => `${part.name} (${part.weight})`).join(', ') })}</p>
      ) : (
        <Fields fields={{ ...proposal.payload, name: undefined }} />
      )}
    </>
  );
}

function UpdateStyleCard({ proposal }: { proposal: AnyProposal<UpdateStylePayload> }) {
  useLocale();
  return (
    <>
      <p className="mcp-proposal-title">{t('Change to the writing style {name}', { name: proposal.payload.before.name })}</p>
      <Fields fields={proposal.payload.changes} before={proposal.payload.before} />
    </>
  );
}

function DeleteStyleCard({ proposal }: { proposal: AnyProposal<DeleteStylePayload> }) {
  useLocale();
  return (
    <>
      <p className="mcp-proposal-title">{t('Delete the writing style {name}', { name: proposal.payload.before.name })}</p>
      <p>{t('Projects that use it keep their own copy.')}</p>
    </>
  );
}

function DefaultStyleCard({ proposal }: { proposal: AnyProposal<DefaultStylePayload> }) {
  useLocale();
  const { styleName, before } = proposal.payload;
  const beforeName = before ? (getStyle(before)?.name ?? before) : t('None');
  return (
    <>
      <p className="mcp-proposal-title">{proposal.title}</p>
      <DiffView lines={compareTexts(beforeName, styleName ?? t('None'))} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Apply and undo
// ---------------------------------------------------------------------------

interface SavedUndo {
  id: string;
  after: string;
}

async function applyNew(p: AnyProposal<NewStylePayload>): Promise<ApplyResult> {
  const { name, blend } = p.payload;
  let style: CustomStyle;
  if (blend?.length) {
    const parts: BlendPart[] = [];
    for (const part of blend) {
      const found = getStyle(part.styleId);
      if (!found) return { ok: false, reason: t('The style {name} is no longer there.', { name: part.name }) };
      parts.push({ style: found, weight: part.weight });
    }
    style = { ...blendStyles(parts), id: '', name };
    if (p.payload.summary) style.summary = p.payload.summary;
  } else {
    style = withChanges({ id: '', kind: 'custom', name, genres: [], summary: '', traits: emptyTraits() }, p.payload);
  }
  try {
    const saved = await saveCustomStyle(style);
    const undo: SavedUndo = { id: saved.id, after: stamp(customNow(saved.id) ?? saved) };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function undoNew(_p: AnyProposal<NewStylePayload>, undo: unknown): Promise<UndoResult> {
  const info = undo as SavedUndo | undefined;
  const now = info?.id ? customNow(info.id) : null;
  if (!info || !now) return { ok: false, reason: goneSince() };
  if (stamp(now) !== info.after) return { ok: false, reason: changedSince() };
  try {
    await deleteCustomStyle(info.id);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

async function applyUpdate(p: AnyProposal<UpdateStylePayload>): Promise<ApplyResult> {
  const now = customNow(p.payload.id);
  if (!now) return { ok: false, reason: goneSince() };
  try {
    const saved = await saveCustomStyle(withChanges(now, p.payload.changes));
    const undo: SavedUndo & { was: CustomStyle } = { id: saved.id, after: stamp(customNow(saved.id) ?? saved), was: now };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function undoUpdate(p: AnyProposal<UpdateStylePayload>, undo: unknown): Promise<UndoResult> {
  const info = undo as (SavedUndo & { was?: CustomStyle }) | undefined;
  const now = customNow(p.payload.id);
  if (!now) return { ok: false, reason: goneSince() };
  if (!info || stamp(now) !== info.after) return { ok: false, reason: changedSince() };
  try {
    await saveCustomStyle(info.was ?? p.payload.before);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

interface DeletedUndo {
  style: CustomStyle;
  favorite: boolean;
}

async function applyDelete(p: AnyProposal<DeleteStylePayload>): Promise<ApplyResult> {
  const now = customNow(p.payload.id);
  if (!now) return { ok: false, reason: goneSince() };
  const favorite = useSettings.getState().settings.writingStyles.favorites.includes(now.id);
  try {
    await deleteCustomStyle(now.id);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  const undo: DeletedUndo = { style: now, favorite };
  return { ok: true, undo };
}

async function undoDelete(p: AnyProposal<DeleteStylePayload>, undo: unknown): Promise<UndoResult> {
  const info = undo as DeletedUndo | undefined;
  const style = info?.style ?? p.payload.before;
  if (customNow(style.id)) return { ok: false, reason: t('That style is back already.') };
  try {
    await saveCustomStyle(style);
    if (info?.favorite && !useSettings.getState().settings.writingStyles.favorites.includes(style.id)) await toggleFavorite(style.id);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

async function scopeIsLive(scope: StyleScope): Promise<boolean> {
  return scope.kind !== 'scene' || isLiveNode(scope.nodeId);
}

async function applyDefault(p: AnyProposal<DefaultStylePayload>): Promise<ApplyResult> {
  const { scope, styleId, styleName } = p.payload;
  if (!(await scopeIsLive(scope))) return { ok: false, reason: goneSince() };
  if (styleId && !getStyle(styleId)) return { ok: false, reason: t('The style {name} is no longer there.', { name: styleName ?? styleId }) };
  try {
    await setActiveStyle(scope, styleId);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

async function undoDefault(p: AnyProposal<DefaultStylePayload>): Promise<UndoResult> {
  const { scope, styleId, before } = p.payload;
  try {
    const active = await getActiveStyle(scope);
    if ((active?.styleId ?? null) !== styleId) return { ok: false, reason: changedSince() };
    await setActiveStyle(scope, before);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

export const newWritingStyleKind = defineKind<NewStylePayload>({
  kind: 'newWritingStyle',
  Card: NewStyleCard,
  apply: applyNew,
  undo: undoNew,
  accepted: () => t('Writing style created.'),
});

export const writingStyleKind = defineKind<UpdateStylePayload>({
  kind: 'writingStyle',
  Card: UpdateStyleCard,
  apply: applyUpdate,
  undo: undoUpdate,
  accepted: () => t('Writing style changed.'),
});

export const deleteWritingStyleKind = defineKind<DeleteStylePayload>({
  kind: 'deleteWritingStyle',
  Card: DeleteStyleCard,
  apply: applyDelete,
  undo: undoDelete,
  accepted: () => t('Writing style deleted.'),
});

export const defaultStyleKind = defineKind<DefaultStylePayload>({
  kind: 'defaultStyle',
  Card: DefaultStyleCard,
  apply: applyDefault,
  undo: undoDefault,
  accepted: () => t('Default style changed.'),
});

export const stylesKinds: ProposalKind[] = [newWritingStyleKind, writingStyleKind, deleteWritingStyleKind, defaultStyleKind];
