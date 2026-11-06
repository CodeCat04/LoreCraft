import type { Route } from '../state/nav';
import * as wiki from '../wiki';
import * as write from '../write';
import * as consistency from '../consistency';
import * as extras from '../extras';
import * as exporters from '../exporters';
import { ProposalsView } from '../mcp';
import * as inbox from '../inbox';
import { CanvasView } from '../canvas';
import { NotesView } from '../notes';
import { SettingsView } from '../settings';
import { StylesView } from '../writingStyles';
import { MediaLibraryView } from '../media/library';

/** Maps a route to its screen. Keys reset a screen's state when its subject changes. */
export function RouteView({ route }: { route: Route }) {
  switch (route.view) {
    case 'home':
      return <wiki.HomeView />;
    case 'page':
      return <wiki.PageView key={route.id} id={route.id} tab={route.tab ?? 'read'} />;
    case 'missing':
      return <wiki.MissingPageView key={route.title} title={route.title} />;
    case 'allPages':
      return <wiki.AllPagesView category={route.category} pageType={route.pageType} status={route.status} />;
    case 'categories':
      return <wiki.CategoriesView />;
    case 'recent':
      return <wiki.RecentView />;
    case 'wanted':
      return <wiki.WantedView />;
    case 'orphans':
      return <wiki.OrphansView />;
    case 'stubs':
      return <wiki.StubsView />;
    case 'trash':
      return <wiki.TrashView />;
    case 'inbox':
      return <inbox.InboxView />;
    case 'search':
      return <wiki.SearchView key={route.q} q={route.q} />;
    case 'replace':
      return <wiki.ReplaceView />;
    case 'write':
      return <write.WriteView bookId={route.bookId} nodeId={route.nodeId} />;
    case 'stats':
      return <write.StatsView bookId={route.bookId} />;
    case 'consistency':
      return <consistency.ConsistencyView />;
    case 'timeline':
      return <extras.TimelineView />;
    case 'graph':
      return <extras.GraphView pageId={route.pageId} />;
    case 'familyTree':
      return <extras.FamilyTreeView key={route.pageId ?? ''} pageId={route.pageId} />;
    case 'maps':
      return <extras.MapsView mapId={route.mapId} />;
    case 'canvas':
      return <CanvasView key={route.id} id={route.id} />;
    case 'notes':
      return <NotesView />;
    case 'export':
      return <exporters.ExportView />;
    case 'import':
      return <exporters.ImportView />;
    case 'proposals':
      return <ProposalsView />;
    case 'styles':
      return <StylesView tab={route.tab} />;
    case 'publishing':
      return <exporters.PublishingView bookId={route.bookId} />;
    case 'settings':
      return <SettingsView tab={route.tab} />;
    case 'media':
      return <MediaLibraryView />;
  }
}
