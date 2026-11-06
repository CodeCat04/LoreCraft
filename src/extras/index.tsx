/**
 * Timeline, relationship graph, family tree and maps. What other modules may want:
 * - `PageRelationships` and `AppearsOnMaps`, to show on a page.
 * - `getEras` and `parseStoryDate` from `src/lib/storyDate.ts`, to order dates.
 * - `{ view: 'graph', pageId }` to center the graph on a page.
 * - `{ view: 'familyTree', pageId }` to show one person's family.
 */

import '../styles/extras.css';

import { listen } from '@tauri-apps/api/event';

import { t, subscribeLocale } from '../lib/i18n';
import { registerCommands } from '../shell/commands';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import { toast } from '../shell/toasts';
import { openDictionaryDialog } from './DictionaryDialog';
import { FamilyTreeView, resetFamilyUi } from './family/FamilyTreeView';
import { familyNotices, type FamilyChange } from './family/syncNotice';
import { openRelationshipDialog } from './graph/relationships';
import { GraphView, resetGraphUi } from './graph/GraphView';
import { AppearsOnMaps, MapLinks, MapsView, newMapFromFile } from './maps/MapsView';
import { openEraSettings } from './timeline/EraSettings';
import { TimelineView, resetTimelineUi } from './timeline/TimelineView';
import { CanvasLinks } from '../canvas';

export { AppearsOnMaps, FamilyTreeView, GraphView, MapsView, TimelineView };
export { PageRelationships } from './graph/relationships';

export function AtlasSidebar() {
  useLocale();
  const route = useNav((s) => s.route);
  const go = useNav((s) => s.go);
  const link = (view: 'timeline' | 'graph' | 'familyTree' | 'maps', label: string) => (
    <button
      type="button"
      className={`nav-link${route.view === view ? ' is-active' : ''}`}
      aria-current={route.view === view ? 'page' : undefined}
      onClick={() => go({ view })}
    >
      {label}
    </button>
  );
  return (
    <nav className="nav-section" aria-label={t('Atlas')}>
      <div className="nav-title">{t('Atlas')}</div>
      {link('timeline', t('Timeline'))}
      {link('graph', t('Relationship graph'))}
      {link('familyTree', t('Family tree'))}
      {link('maps', t('Maps'))}
      <MapLinks activeId={route.view === 'maps' ? route.mapId : undefined} />
      <CanvasLinks activeId={route.view === 'canvas' ? route.id : undefined} />
    </nav>
  );
}

const hasProject = () => useProject.getState().status.open;

/**
 * The window now accepts drops, which it needs for dragging inside editors. A file
 * dropped anywhere nothing handles it would otherwise make the window navigate to it,
 * replacing the whole app. This runs after any handler that does want the drop.
 */
function guardFileDrops() {
  const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  window.addEventListener('dragover', (e) => {
    if (carriesFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (carriesFiles(e)) e.preventDefault();
  });
}

/** Titles are read when registered, so this runs again when the language changes. */
function registerExtraCommands() {
  const { go } = useNav.getState();
  const onPage = () => hasProject() && useNav.getState().route.view === 'page';
  registerCommands([
    {
      id: 'atlas.timeline',
      title: t('Timeline'),
      menu: 'View',
      order: 60,
      when: hasProject,
      keywords: 'atlas dates history chronology',
      run: () => useNav.getState().go({ view: 'timeline' }),
    },
    {
      id: 'atlas.graph',
      title: t('Relationship graph'),
      menu: 'View',
      order: 61,
      when: hasProject,
      keywords: 'atlas network links connections',
      run: () => useNav.getState().go({ view: 'graph' }),
    },
    {
      id: 'atlas.maps',
      title: t('Maps'),
      menu: 'View',
      order: 62,
      when: hasProject,
      keywords: 'atlas pins places',
      run: () => useNav.getState().go({ view: 'maps' }),
    },
    {
      id: 'atlas.pageInGraph',
      title: t('Show this page in the graph'),
      menu: 'View',
      order: 63,
      when: onPage,
      keywords: 'atlas neighbors neighborhood connections',
      run: () => {
        const { route } = useNav.getState();
        if (route.view === 'page') go({ view: 'graph', pageId: route.id });
      },
    },
    {
      id: 'atlas.familyTree',
      title: t('Family tree'),
      menu: 'View',
      order: 64,
      when: hasProject,
      keywords: 'atlas genealogy parents children spouse ancestors',
      run: () => useNav.getState().go({ view: 'familyTree' }),
    },
    {
      id: 'atlas.pageInFamilyTree',
      title: t("Show this page's family tree"),
      menu: 'View',
      order: 65,
      when: onPage,
      keywords: 'atlas genealogy parents children spouse ancestors',
      run: () => {
        const { route } = useNav.getState();
        if (route.view === 'page') go({ view: 'familyTree', pageId: route.id });
      },
    },
    {
      id: 'atlas.newMap',
      title: t('New map…'),
      menu: 'Tools',
      order: 30,
      when: hasProject,
      keywords: 'atlas upload image',
      run: newMapFromFile,
    },
    {
      id: 'atlas.addRelationship',
      title: t('Add relationship…'),
      menu: 'Tools',
      order: 31,
      when: hasProject,
      keywords: 'atlas graph ally enemy parent',
      run: async () => {
        await openRelationshipDialog();
      },
    },
    {
      id: 'atlas.eras',
      title: t('Era settings…'),
      menu: 'Tools',
      order: 32,
      when: hasProject,
      keywords: 'atlas timeline calendar dates',
      run: openEraSettings,
    },
    {
      id: 'tools.dictionary',
      title: t('Custom dictionary…'),
      menu: 'Tools',
      order: 33,
      when: hasProject,
      keywords: 'spellcheck spelling words',
      run: async () => {
        await openDictionaryDialog();
      },
    },
  ]);
}

export function registerExtras() {
  registerExtraCommands();
  subscribeLocale(registerExtraCommands);

  guardFileDrops();

  // Filters name things in one project, so they must not outlive it. Opening a project
  // over a saved one never passes through closed, so `all` has to be watched as well.
  const forgetFilters = () => {
    resetTimelineUi();
    resetGraphUi();
    resetFamilyUi();
  };
  let wasOpen = useProject.getState().status.open;
  useProject.subscribe((state) => {
    const { open } = state.status;
    if (open === wasOpen) return;
    wasOpen = open;
    if (!open) forgetFilters();
  });
  void listen<{ entity: string }>('data://changed', (event) => {
    if (event.payload.entity === 'all') forgetFilters();
  });
  // A save on one page can change another's family fields, which the writer should hear.
  void listen<{ changes: FamilyChange[] }>('family://synced', (event) => {
    for (const { text, kind } of familyNotices(event.payload.changes)) toast(text, kind);
  });
}
