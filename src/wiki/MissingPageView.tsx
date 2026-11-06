/**
 * A link target with no page yet, shown as Wikipedia shows a missing article. Clicking a red
 * link creates the page at once and opens it for writing, with Undo in the toast. This screen
 * shows when the name is reached another way, such as Back, or after that Undo.
 */

import { useEffect, useState } from 'react';

import { createFromTemplate, primePage, requestBodyFocus, restoreFromTrash } from './actions';
import { wikiPages } from './api';
import { PageLink, RouteLink } from './links';
import { usePageTypes } from './pageTypes';
import { DEFAULT_TYPE } from './templates';
import { flushAllEditors } from '../editor/saving';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useNav, type Route } from '../state/nav';
import { useTitles } from '../state/project';
import * as api from '../lib/api';
import { errorMessage } from '../lib/rpc';
import { t } from '../lib/i18n';
import { titleKey } from '../lib/text';
import type { Page } from '../lib/types';
import { useLocale } from '../state/language';

/** How long after a click on a red link arriving here still counts as following it. */
const CLICK_WINDOW_MS = 3000;
/** Red links clicked a moment ago, by title key. */
const clicked = new Map<string, number>();
/** Titles being created now, so a second mount cannot make the page twice. */
const creating = new Set<string>();

/**
 * Notes clicks on red links anywhere in the app, so following one creates its page. Editors
 * follow a link on mouseup and on Enter, before any click event, so those count as well.
 */
export function watchRedLinkClicks() {
  const note = (e: Event) => {
    if (e instanceof MouseEvent && e.type === 'mousedown' && e.button > 1) return;
    if (e instanceof KeyboardEvent && e.key !== 'Enter') return;
    const link = (e.target as Element | null)?.closest?.('[data-wiki-target]');
    const target = link?.getAttribute('data-wiki-target');
    if (target && !useTitles.getState().resolve(target)) clicked.set(titleKey(target), Date.now());
  };
  for (const type of ['mousedown', 'keydown', 'click']) document.addEventListener(type, note, true);
}

function followedRedLink(title: string): boolean {
  const at = clicked.get(titleKey(title));
  return at !== undefined && Date.now() - at < CLICK_WINDOW_MS;
}

/**
 * Takes the page back out. A page nobody has changed is removed for good. One with changes
 * goes to the trash, so nothing written in it is lost.
 */
async function undoCreate(page: Page) {
  try {
    await flushAllEditors();
    const now = await api.pages.get(page.id).catch(() => null);
    const untouched = !!now && now.updatedAt === page.updatedAt && !now.deletedAt;
    if (!now?.deletedAt) await api.pages.remove(page.id);
    if (untouched) await api.pages.purge(page.id);
    // The list of titles must not still hold the page, or this screen would go straight back.
    await useTitles.getState().refresh();
    const nav = useNav.getState();
    if (nav.route.view === 'page' && nav.route.id === page.id) nav.replace({ view: 'missing', title: page.title });
    toast(
      untouched
        ? t('Removed “{title}”.', { title: page.title })
        : t('Moved “{title}” to the trash, because it had changes.', { title: page.title }),
    );
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Creates the page, opens it for writing in place of this screen, and offers Undo. */
async function createAndOpen(title: string, type: string, replace: (route: Route) => void): Promise<boolean> {
  const key = titleKey(title);
  if (creating.has(key)) return true;
  creating.add(key);
  clicked.delete(key);
  try {
    const page = await createFromTemplate(title, type);
    primePage(page);
    requestBodyFocus(page.id);
    replace({ view: 'page', id: page.id, tab: 'edit' });
    toast(t('Created “{title}”.', { title: page.title }), 'success', { label: t('Undo'), run: () => void undoCreate(page) });
    return true;
  } catch (e) {
    toast(errorMessage(e), 'error');
    return false;
  } finally {
    creating.delete(key);
  }
}

export function MissingPageView({ title }: { title: string }) {
  useLocale();
  const version = useDataVersion('pages', 'pageContent', 'nodeContent');
  const { data: links } = useLoad(() => wikiPages.linksTo(title), [title, version]);
  const exists = useTitles((s) => s.resolve(title));
  const types = usePageTypes((s) => s.types);
  const [type, setType] = useState(DEFAULT_TYPE);
  // Arriving from a red link means "make this page", so it is made straight away.
  const [auto] = useState(() => followedRedLink(title));
  const [busy, setBusy] = useState(auto);
  const replace = useNav((s) => s.replace);

  // The page may appear while this is open, or the link may be followed after it exists.
  useEffect(() => {
    if (exists && !busy) replace({ view: 'page', id: exists.id });
  }, [exists, busy, replace]);

  const create = async (pageType: string) => {
    setBusy(true);
    if (!(await createAndOpen(title.trim(), pageType, replace))) setBusy(false);
  };

  useEffect(() => {
    if (auto) void create(DEFAULT_TYPE);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  const pages = links?.pages ?? [];
  const [noPageBefore, noPageAfter] = t('This project has no page called {title} yet.').split('{title}');
  const scenes = links?.scenes ?? [];

  if (auto && busy) {
    return (
      <article className="wiki-page wiki-missing" aria-busy="true">
        <header className="wiki-head">
          <h1 className="wiki-title">{title}</h1>
        </header>
        <p className="muted">{t('Creating the page…')}</p>
      </article>
    );
  }

  return (
    <article className="wiki-page wiki-missing">
      <header className="wiki-head">
        <h1 className="wiki-title">{title}</h1>
      </header>
      <div className="wiki-article">
        <div className="wiki-missing-notice">
          <p>{noPageBefore}<b>{title}</b>{noPageAfter}</p>
          <fieldset className="wiki-type-picker">
            <legend className="field-label">{t('Create it as')}</legend>
            {types.map((template) => (
              <label key={template.type} className={`wiki-type-chip${type === template.type ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name="missing-page-type"
                  value={template.type}
                  checked={type === template.type}
                  onChange={() => setType(template.type)}
                />
                <span>{template.label}</span>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="btn btn-primary btn-lg"
            autoFocus
            disabled={busy}
            onClick={() => void create(type)}
          >
            {t('Create this page')}
          </button>
          {links?.trashedId && (
            <p className="small">
              {t('A page with this name is in the trash.')}{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => void restoreFromTrash(links.trashedId!, title)}
              >
                {t('Restore it instead')}
              </button>
            </p>
          )}
        </div>
        <section aria-labelledby="wiki-links-there">
          <h2 id="wiki-links-there" className="wiki-section-title">{t('What links here')}</h2>
          {links && pages.length + scenes.length === 0 && (
            <p className="muted">{t('Nothing links to this name yet.')}</p>
          )}
          {pages.length > 0 && (
            <>
              <p className="muted small">{pages.length === 1 ? t('1 page') : t('{count} pages', { count: pages.length.toLocaleString() })}</p>
              <ul className="wiki-footer-list">
                {pages.map((page) => (
                  <li key={page.id}>
                    <PageLink id={page.id} title={page.title} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {scenes.length > 0 && (
            <>
              <p className="muted small">{scenes.length === 1 ? t('1 scene') : t('{count} scenes', { count: scenes.length.toLocaleString() })}</p>
              <ul className="wiki-footer-list">
                {scenes.map((scene) => (
                  <li key={scene.id}>
                    <RouteLink route={{ view: 'write', bookId: scene.bookId, nodeId: scene.id }}>
                      {scene.title || t('Untitled scene')}
                    </RouteLink>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </article>
  );
}
