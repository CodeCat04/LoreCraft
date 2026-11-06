/** Links to pages outside the document editor. All of them show hover cards. */

import type { MouseEvent, ReactNode } from 'react';

import { followWikiLink } from '../editor/RichEditor';
import { showRouteMenu } from '../shell/ContextMenu';
import { followRoute, useNav, type Route } from '../state/nav';
import { useTitles } from '../state/project';
import { t } from '../lib/i18n';

function follow(e: MouseEvent, action: () => void) {
  e.preventDefault();
  action();
}

/** A link by title: blue if the page exists, red if not. */
export function WikiLink({ target, children }: { target: string; children?: ReactNode }) {
  const status = useTitles((s) => s.resolve(target)?.status);
  const className = status ? `wiki-link wiki-link-ok status-${status}` : 'wiki-link wiki-link-red';
  return (
    <a href="#" className={className} data-wiki-target={target} onClick={(e) => follow(e, () => followWikiLink(target, e))}>
      {children ?? target}
    </a>
  );
}

/** A link to a page already known to exist, such as a row in a list. */
export function PageLink({ id, title }: { id: string; title: string }) {
  return (
    <a
      href="#"
      className="wiki-link wiki-link-ok"
      data-wiki-target={title}
      onClick={(e) => follow(e, () => followRoute({ view: 'page', id }, e))}
    >
      {title}
    </a>
  );
}

/** A link to any screen. */
export function RouteLink({ route, children }: { route: Route; children: ReactNode }) {
  return (
    <a
      href="#"
      onClick={(e) => follow(e, () => followRoute(route, e))}
      onMouseDown={(e) => {
        // A middle-click would otherwise start the browser's scrolling mode first.
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button === 1) follow(e, () => useNav.getState().openTab(route));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showRouteMenu(e, route, t('Open this link'));
      }}
    >
      {children}
    </a>
  );
}
