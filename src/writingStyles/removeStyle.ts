/**
 * Deleting a style, asked from My styles or Browse. Deleting one the open project uses also
 * stops using it here, so it is gone from view. Other projects keep their own copy.
 */

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { confirm } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { deleteCustomStyle, getStyle, stopUsingStyle, styleUsesHere } from './store';

interface Named {
  id: string;
  name: string;
}

/** Asks, then deletes one of the writer's own styles. True if it was deleted. */
export async function deleteStyleAsking(style: Named): Promise<boolean> {
  let uses = 0;
  try {
    uses = await styleUsesHere(style.id);
  } catch {
    // Without the project's choices, deleting still works. It just does not stop using it here.
  }
  const yes = await confirm({
    title: t('Delete {name}?', { name: style.name }),
    message: uses > 0
      ? t('This project uses it. Deleting it also stops using it here. Other projects that use it keep their own copy of the prompt.')
      : t('It leaves your styles on this computer. Any project that uses it keeps its own copy of the prompt.'),
    confirmLabel: t('Delete'),
    danger: true,
  });
  if (!yes) return false;
  try {
    await deleteCustomStyle(style.id);
    if (uses > 0) await stopUsingStyle(style.id);
    toast(t('Deleted {name}.', { name: style.name }));
    return true;
  } catch (e) {
    toast(errorMessage(e), 'error');
    return false;
  }
}

/** Asks, then removes a style the project carries a copy of but this computer does not have. */
export async function removeProjectCopyAsking(style: Named): Promise<boolean> {
  const yes = await confirm({
    title: t('Remove {name} from this project?', { name: style.name }),
    message: t('This project stops using it, wherever it was chosen, and its copy of the prompt is removed.'),
    confirmLabel: t('Remove'),
    danger: true,
  });
  if (!yes) return false;
  try {
    await stopUsingStyle(style.id);
    toast(t('Removed {name} from this project.', { name: style.name }));
    return true;
  } catch (e) {
    toast(errorMessage(e), 'error');
    return false;
  }
}

/** Whether a custom style is one of the writer's own, rather than a copy only the project has. */
export function isOwnStyle(id: string): boolean {
  return getStyle(id)?.kind === 'custom';
}
