/**
 * A picture or video's label and description (alt text), set in the media library by an
 * outside AI. Figures with their own caption keep it. Undo puts back the old words, unless
 * they have changed since.
 */

import { t } from '../../lib/i18n';
import { errorMessage, rpc } from '../../lib/rpc';
import { useLocale } from '../../state/language';
import { compareTexts } from '../../wiki/diff';
import type { AnyProposal } from '../api';
import { changedSince, DiffView, goneSince, withElement } from './shared';
import { defineKind } from './types';

export interface MediaLabelPayload {
  assetId: string;
  name: string;
  mediaKind: string;
  label: string;
  description: string;
  before: { label: string; description: string };
}

/** The words stored for the asset itself, which the library falls back to. */
async function storedWords(id: string): Promise<{ label: string; description: string } | null> {
  const asset = await rpc<{ label?: string; description?: string } | null>('media.get', { id }).catch(() => null);
  if (!asset) return null;
  return { label: asset.label ?? '', description: asset.description ?? '' };
}

async function setWords(id: string, label: string, description: string): Promise<void> {
  await rpc('media.setLabel', { id, label, description });
}

function MediaLabelCard({ proposal }: { proposal: AnyProposal<MediaLabelPayload> }) {
  useLocale();
  const { name, label, description, before } = proposal.payload;
  return (
    <>
      <p className="mcp-proposal-title">{withElement(t('Label and description of {name}'), 'name', <strong>{name}</strong>)}</p>
      <dl className="mcp-infobox mcp-details">
        <div>
          <dt>{t('Label')}</dt>
          <dd>
            <DiffView lines={compareTexts(before.label, label)} />
          </dd>
        </div>
        <div>
          <dt>{t('Description')}</dt>
          <dd>
            <DiffView lines={compareTexts(before.description, description)} />
          </dd>
        </div>
      </dl>
    </>
  );
}

export const mediaLabelKind = defineKind<MediaLabelPayload>({
  kind: 'mediaLabel',
  Card: MediaLabelCard,
  apply: async (p) => {
    try {
      if (!(await storedWords(p.payload.assetId))) return { ok: false, reason: goneSince() };
      await setWords(p.payload.assetId, p.payload.label, p.payload.description);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  },
  undo: async (p) => {
    const now = await storedWords(p.payload.assetId);
    if (!now) return { ok: false, reason: goneSince() };
    if (now.label !== p.payload.label || now.description !== p.payload.description) return { ok: false, reason: changedSince() };
    await setWords(p.payload.assetId, p.payload.before.label, p.payload.before.description);
    return { ok: true };
  },
  accepted: () => t('Label saved.'),
});
