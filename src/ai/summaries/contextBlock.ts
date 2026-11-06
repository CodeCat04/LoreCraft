/** The story so far, as it goes into a request made while working in a scene. */

import type { ContextItem, ContextRequest, LoreSource } from '../context';
import { estimateTokens, hashText } from '../context';
import { t } from '../../lib/i18n';
import { fence } from '../prompts';

export interface StoryBlock {
  text: string;
  items: ContextItem[];
  tokens: number;
}

/** At most a quarter of what room is left, since the lore and the scene matter more. */
export async function storyForContext(request: ContextRequest, lore: LoreSource, roomTokens: number): Promise<StoryBlock | null> {
  const { source } = request;
  if (source?.kind !== 'node' || !lore.storySoFar || roomTokens < 200) return null;
  const story = await lore
    .storySoFar({
      nodeId: source.id,
      asOfNodeId: request.asOfNodeId,
      includeLocalOnly: !request.forCloud,
      maxTokens: Math.floor(roomTokens / 4),
    })
    .catch(() => null);
  if (!story) return null;

  const items: ContextItem[] = story.withheld.map((entry) => ({
    id: `story:withheld:${entry.id}`, kind: 'story', title: t('Summary of {title}', { title: entry.title }), reason: 'story',
    state: 'localOnly', text: '', tokens: 0, shortened: false, hash: '',
  }));
  if (!story.text) return { text: '', items, tokens: 0 };

  const text = `<book title="The story so far, before this scene">\n${fence(story.text)}\n</book>`;
  const tokens = estimateTokens(text);
  items.unshift({
    id: `story:${source.id}`, kind: 'story', title: t('The story so far'), reason: 'story',
    state: 'included', text, tokens, shortened: story.omitted > 0, hash: hashText(text), localOnly: story.holdsLocalOnly,
  });
  return { text, items, tokens };
}
