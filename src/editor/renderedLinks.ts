/** Clicks on links in HTML from `renderMarkdownSafe`, such as model output. */

import type { MouseEvent as ReactMouseEvent } from 'react';

import * as api from '../lib/api';
import { followWikiLink } from './RichEditor';

/**
 * Put this on the element holding the HTML. A link never moves the app's window: a wiki link
 * opens its page, a web link opens in the browser, and anything else does nothing. The text
 * came from a model or an outside tool, so where its links point is not to be trusted.
 */
export function followRenderedLink(e: ReactMouseEvent) {
  const link = (e.target as HTMLElement).closest('a');
  if (!link) return;
  e.preventDefault();
  const target = link.getAttribute('data-wiki-target');
  if (target !== null) {
    followWikiLink(target);
    return;
  }
  const href = link.getAttribute('href');
  if (href && /^https?:\/\//i.test(href)) void api.app.openExternal(href).catch(() => {});
}
