/**
 * What to tell the writer after a save changed family details on other pages. The
 * ordinary case can be one short line. Anything they may want to act on gets its own.
 */

import { currentLocale, t } from '../../lib/i18n';
import type { ToastKind } from '../../shell/toasts';

export interface FamilyChange {
  type: 'added' | 'removed' | 'kept' | 'noRoom';
  pageId: string;
  title: string;
  field: string;
  other: string;
  /** What else the field holds now. */
  alongside: string[];
}

export interface FamilyNotice {
  text: string;
  kind: ToastKind;
}

function listOf(names: string[]): string {
  if (names.length <= 1) return names.join('');
  // Each language joins a list its own way.
  if (currentLocale() !== 'en') return new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(names);
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Past this, naming each one would bury the screen, as when a long list is pasted in. */
const MOST_SPELLED_OUT = 3;

export function familyNotices(changes: FamilyChange[]): FamilyNotice[] {
  const notices: FamilyNotice[] = [];
  const plain: FamilyChange[] = [];
  const alongsides = changes.filter((change) => change.type === 'added' && change.alongside.length > 0);
  const spellOut = alongsides.length <= MOST_SPELLED_OUT;
  for (const change of changes) {
    const { type, title, field, other, alongside } = change;
    if (type === 'added' && alongside.length > 0 && spellOut) {
      notices.push({
        text: t("{title}'s {field} field already lists {names}, so {other} was added next to it.", {
          title,
          field,
          names: listOf(alongside),
          other,
        }),
        kind: 'info',
      });
    } else if (type === 'kept') {
      notices.push({
        text: t('The relationship between {title} and {other} has a note, so it was kept. Delete it on the page if it no longer holds.', { title, other }),
        kind: 'info',
      });
    } else if (type === 'noRoom') {
      notices.push({
        text: t("{other} could not be added to {title}'s {field} field, because a name with a comma cannot share a field with others. The relationship is saved.", { other, title, field }),
        kind: 'error',
      });
    } else {
      plain.push(change);
    }
  }
  if (plain.length === 1) {
    const [{ type, title, field, other }] = plain;
    notices.unshift({
      text:
        type === 'added'
          ? t("{other} was added to {title}'s {field} field.", { other, title, field })
          : t("{other} was removed from {title}'s {field} field.", { other, title, field }),
      kind: 'info',
    });
  } else if (plain.length > 1) {
    const titles = [...new Set(plain.map((change) => change.title))];
    notices.unshift({ text: t('Family details updated on {names}.', { names: listOf(titles) }), kind: 'info' });
  }
  return notices;
}
