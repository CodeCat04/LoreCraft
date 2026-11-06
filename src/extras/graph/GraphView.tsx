import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';

import * as extras from '../api';
import { TypeMark, typeStyle } from '../common/pageTypes';
import { WindowedList } from '../common/WindowedList';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { formatNumber } from '../../lib/text';
import { runCommand } from '../../shell/commands';
import { useDataVersion, useLoad } from '../../state/events';
import { useLocale } from '../../state/language';
import { useNav } from '../../state/nav';
import { useTitles } from '../../state/project';
import { GraphEngine } from './engine';
import {
  buildGraph,
  graphCategories,
  graphTypes,
  matchNodes,
  type GraphNodeView,
  type GraphViewData,
} from './graphData';
import { kindLabel } from './relationKinds';
import { deleteRelationship, editRelationship, openRelationshipDialog } from './relationships';

const LIST_ROW_REM = 2.5;
const REL_ROW_REM = 2.5;
const MAX_CONNECTIONS_SHOWN = 8;
const BUTTON_ZOOM_FACTOR = 1.4;
/** Keeps a popup from touching the edge of the window. */
const MENU_MARGIN_PX = 8;

type GraphMode = 'graph' | 'list' | 'relationships';

/** Choices that should still be there after visiting a page and coming back. */
interface GraphUi {
  /** The main page links to everything, which only tangles the picture, so it starts hidden. */
  hiddenTypes: ReadonlySet<string>;
  category: string;
  mode: GraphMode;
  search: string;
  patch: (change: Partial<Omit<GraphUi, 'patch' | 'reset'>>) => void;
  reset: () => void;
}

const initialUi = () => ({ hiddenTypes: new Set(['home']), category: '', mode: 'graph' as GraphMode, search: '' });

const useGraphUi = create<GraphUi>((set) => ({
  ...initialUi(),
  patch: (change) => set(change),
  reset: () => set(initialUi()),
}));

/** Filters name things in one project, so they must not outlive it. */
export function resetGraphUi() {
  useGraphUi.getState().reset();
}

function pagesText(count: number): string {
  return count === 1 ? t('1 page') : t('{count} pages', { count: formatNumber(count) });
}

function connectionsCount(count: number): string {
  return count === 1 ? t('1 connection') : t('{count} connections', { count: formatNumber(count) });
}

function aliasesOf(id: string): string[] {
  return useTitles.getState().byId.get(id)?.aliases ?? [];
}

// ---- The canvas ----------------------------------------------------------------

interface CanvasProps {
  view: GraphViewData;
  center: string | null;
  matches: string[] | null;
  summary: string;
  onHover: (id: string | null) => void;
  onMenu: (id: string, x: number, y: number) => void;
}

/** Memoized, so hovering, which re-renders the status line, never touches the engine. */
const GraphCanvas = memo(function GraphCanvas(props: CanvasProps) {
  // The canvas draws relationship kinds, so a new language draws the graph again.
  const locale = useLocale();
  const { view, center, matches, summary, onHover, onMenu } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<GraphEngine | null>(null);
  const callbacks = useRef({ onHover, onMenu });
  callbacks.current = { onHover, onMenu };
  const go = useNav((s) => s.go);

  useEffect(() => {
    if (!canvas.current) return undefined;
    const created = new GraphEngine(canvas.current, {
      onOpen: (id) => go({ view: 'page', id }),
      onHover: (id) => callbacks.current.onHover(id),
      onContextMenu: (id, x, y) => callbacks.current.onMenu(id, x, y),
    });
    engine.current = created;
    return () => {
      created.destroy();
      engine.current = null;
    };
  }, [go]);

  useEffect(() => {
    engine.current?.setGraph(view, center);
  }, [view, center, locale]);

  useEffect(() => {
    engine.current?.setMatches(matches);
    // One match is worth moving to. Several are shown where they are.
    if (matches?.length === 1) engine.current?.centerOn(matches[0]);
  }, [matches]);

  return (
    <div className="graph-stage">
      <canvas
        ref={canvas}
        className="graph-canvas"
        tabIndex={0}
        role="application"
        aria-label={summary}
        aria-describedby="graph-help"
        data-testid="graph-canvas"
      />
      <div className="graph-camera">
        <button type="button" className="btn btn-sm" aria-label={t('Zoom out')} onClick={() => engine.current?.zoomBy(1 / BUTTON_ZOOM_FACTOR)}>−</button>
        <button type="button" className="btn btn-sm" aria-label={t('Zoom in')} onClick={() => engine.current?.zoomBy(BUTTON_ZOOM_FACTOR)}>+</button>
        <button type="button" className="btn btn-sm" onClick={() => engine.current?.fit()}>{t('Fit')}</button>
      </div>
    </div>
  );
});

// ---- The list alternatives -----------------------------------------------------

/** For each page, the pages it connects to and the relationship kinds on each connection. */
function connectionIndex(view: GraphViewData): Map<string, { other: string; kinds: string[] }[]> {
  const index = new Map<string, { other: string; kinds: string[] }[]>();
  const add = (id: string, other: string, kinds: string[]) => {
    const list = index.get(id);
    if (list) list.push({ other, kinds });
    else index.set(id, [{ other, kinds }]);
  };
  for (const edge of view.edges) {
    const kinds = edge.relationships.map((rel) => kindLabel(rel.kind));
    add(edge.source, edge.target, kinds);
    add(edge.target, edge.source, kinds);
  }
  return index;
}

function connectionsText(
  id: string,
  index: Map<string, { other: string; kinds: string[] }[]>,
  titles: Map<string, string>,
): string {
  const all = index.get(id) ?? [];
  if (all.length === 0) return t('No connections');
  // Named relationships say more than bare links, so they come first.
  const named = [...all]
    .sort((a, b) => b.kinds.length - a.kinds.length)
    .slice(0, MAX_CONNECTIONS_SHOWN)
    .map(({ other, kinds }) => (kinds.length ? `${titles.get(other)} (${kinds.join(', ')})` : titles.get(other)));
  const more = all.length - named.length;
  return more > 0 ? t('{list}, and {count} more', { list: named.join(', '), count: formatNumber(more) }) : named.join(', ');
}

function PageList({ view, search }: { view: GraphViewData; search: string }) {
  useLocale();
  const go = useNav((s) => s.go);
  const connections = useMemo(() => connectionIndex(view), [view]);
  const titles = useMemo(() => new Map(view.nodes.map((node) => [node.id, node.title])), [view]);
  const rows = useMemo(() => {
    const matched = search.trim() ? new Set(matchNodes(view.nodes, search, aliasesOf)) : null;
    return view.nodes
      .filter((node) => !matched || matched.has(node.id))
      .sort((a, b) => b.linkCount - a.linkCount || a.title.localeCompare(b.title));
  }, [view, search]);

  if (rows.length === 0) {
    return <div className="empty-state atlas-empty"><p>{t('No pages match.')}</p></div>;
  }
  const renderRow = (index: number, tabIndex: 0 | -1) => {
    const node: GraphNodeView = rows[index];
    const connected = connectionsText(node.id, connections, titles);
    return (
      <div className="graph-list-row" data-graph-row={node.title}>
        <TypeMark pageType={node.pageType} />
        <button
          type="button"
          className="link-button graph-list-title truncate"
          data-row-focus
          tabIndex={tabIndex}
          data-wiki-target={node.title}
          onClick={() => go({ view: 'page', id: node.id })}
        >
          {node.title}
        </button>
        <span className="graph-list-count">{connectionsCount(node.linkCount)}</span>
        <span className="graph-list-connections truncate" title={connected}>{connected}</span>
        <button
          type="button"
          className="btn btn-sm"
          tabIndex={tabIndex}
          aria-label={t('Show {title} in the graph', { title: node.title })}
          onClick={() => {
            useGraphUi.getState().patch({ mode: 'graph' });
            go({ view: 'graph', pageId: node.id });
          }}
        >
          {t('Center')}
        </button>
      </div>
    );
  };
  return (
    <WindowedList
      label={t('Pages and their connections')}
      className="graph-list"
      count={rows.length}
      rowRem={LIST_ROW_REM}
      rowKey={(i) => rows[i].id}
      renderRow={renderRow}
    />
  );
}

function RelationshipList({ view, search }: { view: GraphViewData; search: string }) {
  useLocale();
  const go = useNav((s) => s.go);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return view.edges
      .flatMap((edge) => edge.relationships)
      .filter(
        (rel) =>
          !needle ||
          rel.fromTitle.toLowerCase().includes(needle) ||
          rel.toTitle.toLowerCase().includes(needle) ||
          rel.kind.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.fromTitle.localeCompare(b.fromTitle) || a.toTitle.localeCompare(b.toTitle));
  }, [view, search]);

  if (rows.length === 0) {
    return (
      <div className="empty-state atlas-empty">
        <p>
          {search.trim()
            ? t('No relationships match.')
            : t('No relationships yet. Links in your text appear on the graph by themselves. A relationship says what the connection is, such as ally or parent of.')}
        </p>
      </div>
    );
  }
  return (
    <WindowedList
      label={t('Relationships')}
      className="graph-list"
      count={rows.length}
      rowRem={REL_ROW_REM}
      rowKey={(i) => rows[i].id}
      renderRow={(index, tabIndex) => {
        const rel = rows[index];
        return (
          <div className="rel-row" data-relationship={`${rel.fromTitle} ${rel.kind} ${rel.toTitle}`}>
            <button
              type="button"
              className="link-button truncate"
              data-row-focus
              tabIndex={tabIndex}
              data-wiki-target={rel.fromTitle}
              onClick={() => go({ view: 'page', id: rel.fromPageId })}
            >
              {rel.fromTitle}
            </button>
            <span className="rel-kind truncate">{kindLabel(rel.kind)}</span>
            <button
              type="button"
              className="link-button truncate"
              tabIndex={tabIndex}
              data-wiki-target={rel.toTitle}
              onClick={() => go({ view: 'page', id: rel.toPageId })}
            >
              {rel.toTitle}
            </button>
            <span className="rel-note truncate" title={rel.note}>{rel.note}</span>
            <button type="button" className="btn btn-sm" tabIndex={tabIndex} aria-label={t('Edit {from} {kind} {to}', { from: rel.fromTitle, kind: kindLabel(rel.kind), to: rel.toTitle })} onClick={() => void editRelationship(rel)}>
              {t('Edit')}
            </button>
            <button type="button" className="btn btn-sm" tabIndex={tabIndex} aria-label={t('Delete {from} {kind} {to}', { from: rel.fromTitle, kind: kindLabel(rel.kind), to: rel.toTitle })} onClick={() => void deleteRelationship(rel)}>
              {t('Delete')}
            </button>
          </div>
        );
      }}
    />
  );
}

// ---- The screen ----------------------------------------------------------------

function NodeMenu(props: { x: number; y: number; id: string; title: string; onClose: () => void }) {
  useLocale();
  const { x, y, id, title, onClose } = props;
  const go = useNav((s) => s.go);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    setPlace({
      left: Math.max(MENU_MARGIN_PX, Math.min(x, window.innerWidth - rect.width - MENU_MARGIN_PX)),
      top: Math.max(MENU_MARGIN_PX, Math.min(y, window.innerHeight - rect.height - MENU_MARGIN_PX)),
    });
  }, [x, y]);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <div ref={box} className="menu-popup atlas-context-menu" role="menu" aria-label={title} style={place}>
      <div className="menu-label truncate">{title}</div>
      <button type="button" className="menu-item" role="menuitem" onClick={run(() => go({ view: 'page', id }))}>
        {t('Open page')}
      </button>
      <button type="button" className="menu-item" role="menuitem" onClick={run(() => go({ view: 'graph', pageId: id }))}>
        {t('Show its neighborhood')}
      </button>
      <button
        type="button"
        className="menu-item"
        role="menuitem"
        onClick={run(() => void openRelationshipDialog({ from: { id, title } }))}
      >
        {t('Add relationship from here…')}
      </button>
    </div>
  );
}

function GraphScreen({ pageId }: { pageId?: string }) {
  useLocale();
  const version = useDataVersion('pages', 'pageContent', 'extras');
  const go = useNav((s) => s.go);
  const { hiddenTypes, category, mode, search, patch } = useGraphUi();
  const [hops, setHops] = useState<0 | 1 | 2>(pageId ? 1 : 0);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const { data, error } = useLoad(() => extras.graphData(), [version]);

  const view = useMemo(
    () => (data ? buildGraph(data, { hiddenTypes, category, center: pageId ?? null, hops }) : null),
    [data, hiddenTypes, category, pageId, hops],
  );
  const types = useMemo(() => (data ? graphTypes(data) : []), [data]);
  const categories = useMemo(() => (data ? graphCategories(data) : []), [data]);
  const matches = useMemo(() => {
    if (!view || !search.trim()) return null;
    return matchNodes(view.nodes, search, aliasesOf);
  }, [view, search]);
  const centerPage = data?.nodes.find((node) => node.id === pageId);

  const nodeById = useMemo(() => new Map(view?.nodes.map((node) => [node.id, node])), [view]);
  const hovered = hoverId ? nodeById.get(hoverId) : undefined;

  const onMenu = useCallback((id: string, x: number, y: number) => setMenu({ id, x, y }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  if (error) {
    return (
      <div className="view-pad">
        <h1 className="view-title">{t('Relationship graph')}</h1>
        <p className="error-detail">{t('Could not load the graph: {error}', { error: errorMessage(error) })}</p>
      </div>
    );
  }
  if (!data || !view) return <div className="atlas-view" />;

  const pagesInWorld = data.nodes.filter((node) => !node.isHome).length;
  const summary = t('Relationship graph of {pages} and {connections}. The list view gives the same information as text.', {
    pages: pagesText(view.nodes.length),
    connections: connectionsCount(view.edges.length),
  });

  return (
    <div className="atlas-view" data-testid="graph-view">
      <header className="atlas-header">
        <h1 className="atlas-title">{t('Relationship graph')}</h1>
        {pagesInWorld > 0 && (
          <p className="atlas-summary" role="status">
            {pagesText(view.nodes.length)}, {connectionsCount(view.edges.length)}
          </p>
        )}
        <span className="atlas-toolbar-spacer" />
        {pagesInWorld > 1 && (
          <div className="segmented" role="group" aria-label={t('View as')}>
            {([
              ['graph', t('Graph')],
              ['list', t('List')],
              ['relationships', t('Relationships')],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`btn btn-sm${mode === value ? ' btn-primary' : ''}`}
                aria-pressed={mode === value}
                onClick={() => patch({ mode: value })}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {pagesInWorld > 1 && (
          <button type="button" className="btn btn-sm" onClick={() => void openRelationshipDialog()}>
            {t('Add relationship')}
          </button>
        )}
      </header>

      {pagesInWorld === 0 ? (
        <div className="empty-state atlas-empty">
          <h2 className="atlas-empty-title">{t('Nothing to connect yet')}</h2>
          <p>
            {t('Every page becomes a point here, and every wiki link between pages becomes a line. Create a few pages and link them with [[double brackets]] to see your world take shape.')}
          </p>
          <div className="atlas-empty-actions">
            <button type="button" className="btn btn-primary" onClick={() => void runCommand('wiki.newPage')}>
              {t('New page')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="atlas-toolbar" role="group" aria-label={t('Graph filters')}>
            <input
              className="input graph-search"
              type="search"
              aria-label={t('Search pages in the graph')}
              placeholder={t('Search pages')}
              value={search}
              onChange={(e) => patch({ search: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && search) {
                  e.stopPropagation();
                  patch({ search: '' });
                }
              }}
            />
            <div className="atlas-chips" role="group" aria-label={t('Page types to show')}>
              {types.map(({ type, count }) => {
                const showing = !hiddenTypes.has(type);
                return (
                  <button
                    key={type}
                    type="button"
                    className={`chip${showing ? ' is-on' : ''}`}
                    aria-pressed={showing}
                    onClick={() => {
                      const next = new Set(hiddenTypes);
                      if (showing) next.add(type);
                      else next.delete(type);
                      patch({ hiddenTypes: next });
                    }}
                  >
                    <TypeMark pageType={type} />
                    {typeStyle(type).label} <span className="chip-count">{formatNumber(count)}</span>
                  </button>
                );
              })}
            </div>
            {categories.length > 0 && (
              <select
                className="select"
                aria-label={t('Category')}
                value={category}
                onChange={(e) => patch({ category: e.target.value })}
              >
                <option value="">{t('All categories')}</option>
                {categories.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            )}
            {pageId && (
              <>
                <select
                  className="select"
                  aria-label={
                    centerPage
                      ? t('How much to show around {title}', { title: centerPage.title })
                      : t('How much to show around this page')
                  }
                  value={hops}
                  onChange={(e) => setHops(Number(e.target.value) as 0 | 1 | 2)}
                >
                  <option value={1}>{t('One step away')}</option>
                  <option value={2}>{t('Two steps away')}</option>
                  <option value={0}>{t('Whole graph')}</option>
                </select>
                <button
                  type="button"
                  className="chip is-on"
                  aria-label={
                    centerPage
                      ? t('Stop centering on {title}', { title: centerPage.title })
                      : t('Stop centering on this page')
                  }
                  title={t('Stop centering on this page')}
                  onClick={() => go({ view: 'graph' })}
                >
                  {centerPage?.title ?? t('This page')} <span aria-hidden="true">×</span>
                </button>
              </>
            )}
          </div>

          {view.nodes.length === 0 ? (
            <div className="empty-state atlas-empty">
              <p>{t('No pages match these filters.')}</p>
              <div className="atlas-empty-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => patch({ hiddenTypes: new Set(['home']), category: '', search: '' })}
                >
                  {t('Clear filters')}
                </button>
              </div>
            </div>
          ) : mode === 'list' ? (
            <PageList view={view} search={search} />
          ) : mode === 'relationships' ? (
            <RelationshipList view={view} search={search} />
          ) : (
            <>
              <GraphCanvas
                view={view}
                center={pageId ?? null}
                matches={matches}
                summary={summary}
                onHover={setHoverId}
                onMenu={onMenu}
              />
              <p id="graph-help" className="graph-status" role="status">
                {hovered
                  ? t('{title} ({type}): {connections}. Click to open, right-click for more.', {
                      title: hovered.title,
                      type: hovered.pageType,
                      connections: connectionsCount(hovered.linkCount),
                    })
                  : matches
                    ? matches.length === 1
                      ? t('1 page found.')
                      : t('{count} pages found.', { count: formatNumber(matches.length) })
                    : view.edges.length === 0
                      ? t('No links yet. Link pages from their text, or add a relationship.')
                      : t('Drag to move around, scroll to zoom, drag a page to pull it, click to open. With the graph focused, arrow keys move, plus and minus zoom, and 0 fits.')}
              </p>
            </>
          )}
        </>
      )}
      {menu && nodeById.get(menu.id) && (
        <NodeMenu x={menu.x} y={menu.y} id={menu.id} title={nodeById.get(menu.id)?.title ?? ''} onClose={closeMenu} />
      )}
    </div>
  );
}

export function GraphView({ pageId }: { pageId?: string }) {
  return <GraphScreen key={pageId ?? 'whole'} pageId={pageId} />;
}
