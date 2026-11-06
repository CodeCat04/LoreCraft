/**
 * Pages and scenes marked "local only" never go to a cloud profile. Context assembly and the
 * lore tools each withhold them. This file holds what those and other callers share.
 */

import * as coreApi from '../../lib/api';
import { t } from '../../lib/i18n';
import type { AiProfile } from '../../lib/settings';
import { providerLabel } from '../client';
import type { StoredMessage } from '../types';

/** The one question to ask before sending something to a profile. */
export function canSendTo(profile: Pick<AiProfile, 'isCloud'>, item: { localOnly?: boolean }): boolean {
  return !(profile.isCloud && item.localOnly);
}

export function withheldMessage(title: string, profile: AiProfile): string {
  return t('"{title}" is marked local only, so it cannot be sent to {provider}. Choose a local profile, or remove the mark in the AI pane\'s "What is sent" tab.', {
    title,
    provider: providerLabel(profile),
  });
}

type Source = { kind: 'page' | 'node' | 'notes'; id: string };

/**
 * Notes belong to the page or scene they sit on, so they go by its mark. Something that
 * cannot be read counts as marked, since the safe mistake is to send too little.
 */
export async function isSourceLocalOnly(source: Source): Promise<boolean> {
  const page = () => coreApi.pages.get(source.id).then((found) => !!found.localOnly);
  const node = () => coreApi.nodes.get(source.id).then((found) => !!found.localOnly);
  try {
    if (source.kind === 'node') return await node();
    if (source.kind === 'page') return await page();
    return await page().catch(node);
  } catch {
    return true;
  }
}

export async function setSourceLocalOnly(source: Source, localOnly: boolean): Promise<void> {
  if (source.kind === 'node') await coreApi.nodes.update(source.id, { localOnly });
  else await coreApi.pages.update(source.id, { localOnly });
}

function carriesLocalOnly(message: Pick<StoredMessage, 'content'>): boolean {
  return message.content.some((block) => (block as { localOnly?: boolean }).localOnly === true);
}

/**
 * What of a conversation may go to this profile. A message that held local-only material
 * stays here, and so does anything a local model wrote after reading it, since its replies
 * can repeat what it read. What a cloud model wrote never saw it, so that can go.
 */
export function historyForProfile<T extends Pick<StoredMessage, 'role' | 'content' | 'profileId'>>(
  stored: T[],
  profile: Pick<AiProfile, 'isCloud'>,
  profiles: Pick<AiProfile, 'id' | 'isCloud'>[],
): { messages: T[]; withheld: number } {
  if (!profile.isCloud) return { messages: stored, withheld: 0 };
  const fromCloud = (message: T) => profiles.some((p) => p.id === message.profileId && p.isCloud);
  let tainted = false;
  let cut = -1;
  stored.forEach((message, index) => {
    if (carriesLocalOnly(message)) {
      tainted = true;
      cut = index;
    } else if (tainted && message.role === 'assistant' && !fromCloud(message)) {
      cut = index;
    }
  });
  // Tool results belong to the call before them, so they cannot start what is sent.
  while (cut >= 0 && stored[cut + 1]?.content.some((block) => block.type === 'toolResult')) cut += 1;
  return { messages: stored.slice(cut + 1), withheld: cut + 1 };
}
