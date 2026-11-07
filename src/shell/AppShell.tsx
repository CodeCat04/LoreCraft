import { useCallback, useEffect, useRef, useState } from 'react';

import { ContextMenuHost } from './ContextMenu';
import { MenuBar } from './MenuBar';
import { NavButtons, useMouseNavigation } from './NavButtons';
import { Panes } from './Panes';
import { ErrorBoundary } from './ErrorBoundary';
import { useNav, areaOf, type Area, type Route } from '../state/nav';
import { useProject, useTitles } from '../state/project';
import { useSettings } from '../state/settings';
import { useUi } from '../state/ui';
import { titleKey } from '../lib/text';
import { WikiSidebar } from '../wiki';
import { WriteSidebar } from '../write';
import { AtlasSidebar } from '../extras';
import { AiPane, AiStatus } from '../ai';
import { ProposalsBadge } from '../mcp';
import { MeaningStatusItem } from '../meaning';
import { UNWRITTEN_STATUS } from '../editor/saving';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

const TABS: { area: Area; label: () => string; route: Route }[] = [
  { area: 'wiki', label: () => t('Wiki'), route: { view: 'home' } },
  { area: 'write', label: () => t('Write'), route: { view: 'write' } },
  { area: 'consistency', label: () => t('Consistency'), route: { view: 'consistency' } },
  { area: 'atlas', label: () => t('Atlas'), route: { view: 'timeline' } },
];

function TopSearch() {
  useLocale();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const titles = useTitles((s) => s.entries);
  const go = useNav((s) => s.go);
  const key = titleKey(q);
  const suggestions = key
    ? titles
        .filter((t) => [t.title, ...t.aliases].some((name) => titleKey(name).includes(key)))
        .slice(0, 8)
    : [];
  // The last option searches all text, so a title that matches exactly cannot hide the search
  // page, which is where results by meaning are.
  const searchIndex = suggestions.length;
  const showing = open && key !== '';
  const searchAll = () => go({ view: 'search', q: q.trim() });
  return (
    <form
      className="top-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (!q.trim()) return;
        const chosen = showing && active >= 0 ? suggestions[active] : undefined;
        const everything = showing && active === searchIndex;
        const exact = chosen ?? (everything ? undefined : useTitles.getState().resolve(q));
        if (exact) go({ view: 'page', id: exact.id });
        else searchAll();
        setOpen(false);
        setActive(-1);
        setQ('');
        // The search is done, so keys now belong to the page it opened.
        e.currentTarget.querySelector('input')?.blur();
      }}
    >
      <input
        className="input top-search-input"
        type="search"
        placeholder={t('Search this project')}
        aria-label={t('Search this project')}
        role="combobox"
        aria-expanded={showing}
        aria-controls="top-search-list"
        aria-autocomplete="list"
        aria-activedescendant={showing && active >= 0 ? `top-search-${active}` : undefined}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            setActive(-1);
          } else if (e.key === 'Enter' && e.shiftKey && q.trim()) {
            // Shift+Enter always searches, even for a title that matches exactly.
            e.preventDefault();
            searchAll();
            setOpen(false);
            setActive(-1);
            setQ('');
            e.currentTarget.blur();
          } else if (showing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            const count = suggestions.length + 1;
            setActive((i) => (i + step + count + (i < 0 && step < 0 ? 1 : 0)) % count);
          }
        }}
      />
      {showing && (
        <div className="top-search-popup" id="top-search-list" role="listbox">
          {suggestions.map((t, i) => (
            <button
              key={t.id}
              id={`top-search-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              className={`menu-item${i === active ? ' is-active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                go({ view: 'page', id: t.id });
                setOpen(false);
                setQ('');
              }}
            >
              <span>{t.title}</span>
              {t.summary && <span className="menu-shortcut truncate">{t.summary}</span>}
            </button>
          ))}
          <button
            id={`top-search-${searchIndex}`}
            type="button"
            role="option"
            aria-selected={active === searchIndex}
            tabIndex={-1}
            className={`menu-item${active === searchIndex ? ' is-active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              searchAll();
              setOpen(false);
              setQ('');
            }}
          >
            <span className="truncate">{t('Search all text for “{q}”', { q: q.trim() })}</span>
            <span className="menu-shortcut">Shift+Enter</span>
          </button>
        </div>
      )}
    </form>
  );
}

function StatusBar() {
  useLocale();
  const status = useProject((s) => s.status);
  const items = useUi((s) => s.statusItems);
  const contentScale = useSettings((s) => s.settings.appearance.contentScale);
  const go = useNav((s) => s.go);
  // While a write keeps failing, the latest typing is neither in the recovery copy nor in the
  // file, so the save state must not say it is saved or kept safe. It says what is happening.
  const unwritten = items[UNWRITTEN_STATUS];
  return (
    <footer className="statusbar">
      <span
        className={status.dirty || unwritten ? 'status-dirty' : 'status-clean'}
        data-testid="save-state"
        data-status={unwritten ? UNWRITTEN_STATUS : undefined}
      >
        {unwritten
          ? unwritten
          : status.dirty
            ? status.path
              ? t('Unsaved changes, kept safe until you save')
              : t('Not saved to a file yet, kept safe until you save')
            : t('All changes saved')}
      </span>
      <span className="statusbar-spacer" />
      <MeaningStatusItem />
      {Object.entries(items).filter(([key]) => key !== UNWRITTEN_STATUS).map(([key, text]) => (
        <span key={key} className="status-item" data-status={key}>{text}</span>
      ))}
      <AiStatus />
      <button type="button" className="link-button status-item" title={t('Change text size in Settings')} onClick={() => go({ view: 'settings' })}>
        {t('Text {percent}%', { percent: Math.round(contentScale * 100) })}
      </button>
    </footer>
  );
}

const MIN_PANE = 280;
const MAX_PANE = 900;

function PaneResizer({ onResize, onDone }: { onResize: (width: number) => void; onDone: () => void }) {
  useLocale();
  return (
    <div
      className="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Resize AI pane')}
      onPointerDown={(e) => {
        e.preventDefault();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
          const width = Math.min(MAX_PANE, Math.max(MIN_PANE, window.innerWidth - ev.clientX));
          onResize(width);
        };
        const up = () => {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', up);
          onDone();
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
      }}
    />
  );
}

export function AppShell() {
  useLocale();
  const route = useNav((s) => s.route);
  const go = useNav((s) => s.go);
  const split = useNav((s) => s.panes.length > 1);
  const focusMode = useUi((s) => s.focusMode);
  const paneOpen = useSettings((s) => s.settings.ai.paneOpen);
  const savedWidth = useSettings((s) => s.settings.ai.paneWidth);
  const update = useSettings((s) => s.update);
  const [paneWidth, setPaneWidth] = useState(savedWidth);
  const widthRef = useRef(paneWidth);
  widthRef.current = paneWidth;
  const area = areaOf(route);
  useMouseNavigation();

  useEffect(() => setPaneWidth(savedWidth), [savedWidth]);

  const finishResize = useCallback(() => {
    void update({ ai: { paneWidth: widthRef.current } });
  }, [update]);

  return (
    <div className={`app${focusMode ? ' is-focus-mode' : ''}`}>
      {!focusMode && (
        <header className="topbar">
          <MenuBar />
          <NavButtons />
          <nav className="area-tabs" aria-label={t('Sections')}>
            {TABS.map((tab) => (
              <button
                key={tab.area}
                type="button"
                className={`area-tab${area === tab.area ? ' is-active' : ''}`}
                aria-current={area === tab.area ? 'page' : undefined}
                onClick={() => go(tab.route)}
              >
                {tab.label()}
              </button>
            ))}
          </nav>
          <span className="topbar-spacer" />
          <TopSearch />
          <ProposalsBadge />
          <button
            type="button"
            className={`btn btn-ai${paneOpen ? ' is-active' : ''}`}
            title={t('Toggle AI pane ({shortcut})', { shortcut: 'Ctrl+Shift+A' })}
            aria-pressed={paneOpen}
            onClick={() => void update({ ai: { paneOpen: !paneOpen } })}
          >
            {t('AI')}
          </button>
        </header>
      )}
      <div className={`workspace${split ? ' is-split' : ''}`}>
        {!focusMode && (
          <aside className="sidebar">
            {area === 'write' ? <WriteSidebar /> : area === 'atlas' ? <AtlasSidebar /> : <WikiSidebar />}
          </aside>
        )}
        <Panes />
        {paneOpen && !focusMode && (
          <>
            <PaneResizer onResize={setPaneWidth} onDone={finishResize} />
            <aside className="ai-pane" style={{ width: paneWidth }} aria-label={t('AI assistant')}>
              <ErrorBoundary>
                <AiPane />
              </ErrorBoundary>
            </aside>
          </>
        )}
      </div>
      {!focusMode && <StatusBar />}
      <ContextMenuHost />
    </div>
  );
}
