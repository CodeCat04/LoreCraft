/** What a tab or a history entry is called, shared by the tab bar and the Back and Forward menus. */

import type { Route } from '../state/nav';
import { useTitles } from '../state/project';
import { displayTitle } from '../write/tree';
import { useWrite } from '../write/store';
import { t } from '../lib/i18n';

/** Read when shown, so they follow the interface language. */
const WRITE_MODE_TITLES: Record<string, () => string> = {
  read: () => t('Chapter'),
  cork: () => t('Corkboard'),
  outline: () => t('Outline'),
  threads: () => t('Plot threads'),
  presence: () => t('Character presence'),
  trash: () => t('Manuscript trash'),
};

const PLAIN_TITLES: Record<string, () => string> = {
  home: () => t('Main page'),
  allPages: () => t('All pages'),
  categories: () => t('Categories'),
  recent: () => t('Recent changes'),
  wanted: () => t('Wanted pages'),
  orphans: () => t('Orphaned pages'),
  stubs: () => t('Short pages'),
  trash: () => t('Trash'),
  replace: () => t('Find and replace'),
  stats: () => t('Writing stats'),
  consistency: () => t('Consistency'),
  timeline: () => t('Timeline'),
  graph: () => t('Relationships'),
  maps: () => t('Maps'),
  export: () => t('Export'),
  import: () => t('Import'),
  settings: () => t('Settings'),
  write: () => t('Write'),
  proposals: () => t('Outside suggestions'),
};

/** The Write area knows one book at a time, and a tab can be on another one by now. */
const lastNodeTitles = new Map<string, string>();

/** Names that come from the project rather than from the route itself. */
export interface RouteNames {
  page?: string;
  canvas?: string;
  node?: string;
}

/** Remembers a scene's name, for a tab still on it after the Write area moved to another book. */
export function lastNodeTitle(nodeId: string | undefined, current: string | undefined): string | undefined {
  if (nodeId && current) lastNodeTitles.set(nodeId, current);
  return current ?? (nodeId ? lastNodeTitles.get(nodeId) : undefined);
}

/** What a tab or a history entry is called, as the tab bar shows it. */
export function routeTitle(route: Route, names: RouteNames = {}): string {
  switch (route.view) {
    case 'page':
      return names.page ?? t('Page');
    case 'missing':
      return route.title;
    case 'canvas':
      return names.canvas ?? t('Canvas');
    case 'search':
      return t('Search: {query}', { query: route.q });
    case 'allPages':
      return route.category ?? PLAIN_TITLES.allPages();
    case 'write':
      if (route.mode && route.mode !== 'scene' && !names.node) return WRITE_MODE_TITLES[route.mode]?.() ?? t('Write');
      return names.node ?? t('Write');
    default:
      return PLAIN_TITLES[route.view]?.() ?? sentenceCase(route.view);
  }
}

/** The names for a route as they are right now, for a list read once, such as a menu. */
export function routeNamesNow(route: Route, canvasList: { id: string; title: string }[] = []): RouteNames {
  if (route.view === 'page') return { page: useTitles.getState().byId.get(route.id)?.title };
  if (route.view === 'canvas') return { canvas: canvasList.find((c) => c.id === route.id)?.title };
  if (route.view === 'write' && route.nodeId) {
    const node = useWrite.getState().index.byId.get(route.nodeId);
    return { node: lastNodeTitle(route.nodeId, node ? displayTitle(node) : undefined) };
  }
  return {};
}

/** For a screen with no title of its own here yet. `someView` comes out as "Some view". */
function sentenceCase(name: string): string {
  const words = name.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
