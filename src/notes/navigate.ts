import { waitForEditor } from '../editor/ai/registry';
import { showComment } from '../editor/comments/extension';
import { useNav } from '../state/nav';

import type { Comment } from './api';

/** Opens a comment's document and shows its text, if the text is still there. */
export async function goToComment(comment: Pick<Comment, 'id' | 'sourceKind' | 'sourceId' | 'bookId'>): Promise<void> {
  const { go } = useNav.getState();
  if (comment.sourceKind === 'page') go({ view: 'page', id: comment.sourceId });
  else go({ view: 'write', bookId: comment.bookId ?? undefined, nodeId: comment.sourceId });
  const entry = await waitForEditor(comment.sourceKind, comment.sourceId);
  if (!entry) return;
  // The editor has only just appeared, and the page around it is still settling.
  window.requestAnimationFrame(() => showComment(entry.editor, comment.id));
}
