/** Starting a character chat, and copying a reply to the page's Talk tab. */

import * as coreApi from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import type { PmNode, TitleEntry } from '../../lib/types';
import { markdownToPm } from '../../editor/convert';
import { withoutModelMedia } from '../../editor/ai/hunks';
import { flushAllEditors } from '../../editor/saving';
import { toast } from '../../shell/toasts';
import { useNav } from '../../state/nav';
import { useTitles } from '../../state/project';
import { useSettings } from '../../state/settings';
import { useUi } from '../../state/ui';
import { usePane } from '../store';
import type { CharacterRef } from '../types';
import { CHARACTER_PAGE_TYPE } from './persona';

/** Pages offered in the picker, in title order. */
export function characterPages(entries: TitleEntry[]): TitleEntry[] {
  return entries.filter((entry) => entry.pageType === CHARACTER_PAGE_TYPE).sort((a, b) => a.title.localeCompare(b.title));
}

function isBlank(node: PmNode): boolean {
  return node.type === 'paragraph' && !(node.content?.length ?? 0);
}

/**
 * The page's notes with a reply added at the end, labeled as what it is. The reply came from
 * a model, so it goes through the same rules as any other: no pictures or remote addresses.
 */
export function appendNote(existing: PmNode | null | undefined, title: string, reply: string): PmNode {
  const parsed = withoutModelMedia(markdownToPm(reply).content);
  const body = parsed.length > 0 ? parsed : [{ type: 'paragraph', content: [{ type: 'text', text: reply.trim() }] }];
  const label: PmNode = {
    type: 'paragraph',
    content: [{ type: 'text', text: t('From a chat with {name}, played by the AI. This is not canon.', { name: title }), marks: [{ type: 'italic' }] }],
  };
  const kept = (existing?.content ?? []).filter((node) => !isBlank(node));
  return { type: 'doc', content: [...kept, label, { type: 'blockquote', content: body }] };
}

/** Copies a reply to the Talk tab. The article and everything else about the page stay as they are. */
export async function saveReplyAsNote(character: CharacterRef, reply: string): Promise<void> {
  try {
    // A note being typed on the Talk tab goes first, so it is not overwritten.
    await flushAllEditors();
    const page = await coreApi.pages.get(character.pageId);
    await coreApi.pages.update(page.id, { notes: appendNote(page.notes, page.title, reply) });
    toast(t('Saved to the Talk tab of {name}.', { name: page.title }), 'success');
  } catch (e) {
    toast(t('That note could not be saved: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

/** Opens a new chat with this character. It is stored once the first message is sent. */
export function startCharacterChat(character: CharacterRef): void {
  const pane = usePane.getState();
  pane.stop();
  usePane.setState({
    conversation: null,
    messages: [],
    error: null,
    view: 'chat',
    lastChips: [],
    pendingSettings: { character: { pageId: character.pageId, title: character.title } },
  });
  void useSettings.getState().update({ ai: { paneOpen: true } });
  // The pane cannot show in distraction-free mode, and the person just asked for it.
  if (useUi.getState().focusMode) useUi.getState().setFocusMode(false);
}

/** The character page being read, if that is what is open. */
export function characterOnScreen(): CharacterRef | null {
  const { route } = useNav.getState();
  if (route.view !== 'page') return null;
  const entry = useTitles.getState().byId.get(route.id);
  return entry?.pageType === CHARACTER_PAGE_TYPE ? { pageId: entry.id, title: entry.title } : null;
}
