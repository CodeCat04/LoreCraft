import { randomPage, renameCurrentPage, trashCurrentPage } from './actions';
import { watchRedLinkClicks } from './MissingPageView';
import { openNewPageDialog } from './NewPageDialog';
import { openFindReplace, startRenameEverywhere } from './replaceStore';
import { openPageTypes } from './PageTypesDialog';
import { useWikiSession, type PageTab } from './session';
import { askForPageListQuery } from './PageListDialog';
import { activeEditor } from '../editor/ai/registry';
import { openFindInCurrentEditor } from '../editor/find';
import { insertPageList, registerPageListDialog } from '../editor/pageListView';
import { insertReference } from '../editor/references';
import { startWikiLink } from '../editor/linkAutocomplete';
import { subscribeLocale, t } from '../lib/i18n';
import { registerCommands, type Command } from '../shell/commands';
import { useNav, type Route } from '../state/nav';
import { useProject } from '../state/project';

const hasProject = () => useProject.getState().status.open;
const hasPage = () => useWikiSession.getState().pageId !== null;
const isEditing = () => {
  const { tab, editor } = useWikiSession.getState();
  return hasPage() && tab === 'edit' && editor !== null;
};

/** Escape goes back to where the cursor was, so a quick look-up does not lose the place. */
function focusSearch() {
  const input = document.querySelector<HTMLInputElement>('.top-search-input');
  if (!input || document.activeElement === input) return;
  const previous = document.activeElement as HTMLElement | null;
  input.focus();
  input.select();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') previous?.focus();
  };
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', () => input.removeEventListener('keydown', onKey), { once: true });
}

/** A short selection, such as a name in a scene, is the likely title of a new page. */
function selectedName(): string {
  const entry = activeEditor();
  if (!entry || entry.editor.isDestroyed) return '';
  const { from, to } = entry.editor.state.selection;
  if (from === to) return '';
  const text = entry.editor.state.doc.textBetween(from, to, '\n').trim();
  return text.length <= 80 && !text.includes('\n') ? text.replace(/\s+/g, ' ') : '';
}

function toggleEdit() {
  const { tab, switchTab } = useWikiSession.getState();
  switchTab?.(tab === 'edit' ? 'read' : 'edit');
}

function showTab(tab: PageTab) {
  useWikiSession.getState().switchTab?.(tab);
}

function special(id: string, title: string, route: Route, menu: Command['menu'], order: number, keywords?: string): Command {
  return {
    id: `wiki.${id}`,
    title,
    menu,
    order,
    keywords,
    when: hasProject,
    run: () => useNav.getState().go(route),
  };
}

export function registerWiki() {
  registerPageListDialog(askForPageListQuery);
  watchRedLinkClicks();
  registerWikiCommands();
  // Command titles are read when registered, so they register again in a new language.
  subscribeLocale(registerWikiCommands);
}

function registerWikiCommands() {
  registerCommands([
    { id: 'wiki.newPage', title: t('New page…'), shortcut: 'Ctrl+N', menu: 'File', order: 1, keywords: 'create article', when: hasProject, run: () => openNewPageDialog(selectedName()) },

    { id: 'wiki.toggleEdit', title: t('Edit or read this page'), shortcut: 'Ctrl+E', menu: 'Edit', order: 10, when: hasPage, run: toggleEdit },
    { id: 'wiki.rename', title: t('Rename this page…'), shortcut: 'F2', menu: 'Edit', order: 11, when: hasPage, run: renameCurrentPage },
    {
      id: 'wiki.renameEverywhere',
      title: t('Rename this page everywhere…'),
      menu: 'Edit',
      order: 12,
      when: hasPage,
      run: () => {
        const { pageId, title } = useWikiSession.getState();
        if (pageId) return startRenameEverywhere(pageId, title);
      },
    },
    { id: 'wiki.history', title: t("Show this page's history"), menu: 'View', order: 6, keywords: 'revisions versions changes', when: hasPage, run: () => showTab('history') },
    { id: 'wiki.talk', title: t("Show this page's talk"), menu: 'View', order: 7, keywords: 'discussion notes comments', when: hasPage, run: () => showTab('talk') },
    { id: 'wiki.replace', title: t('Find and replace…'), shortcut: 'Ctrl+Shift+F', menu: 'Edit', order: 20, keywords: 'search rename everywhere', when: hasProject, run: openFindReplace },
    {
      id: 'wiki.focusSearch',
      title: t('Find in this page'),
      shortcut: 'Ctrl+F',
      menu: 'Edit',
      order: 21,
      keywords: 'search highlight',
      when: hasProject,
      // With no document on screen, the nearest thing to find in is the whole project.
      run: () => {
        if (!openFindInCurrentEditor()) focusSearch();
      },
    },
    { id: 'wiki.focusSearch2', title: t('Search this project'), shortcut: 'Ctrl+L', menu: 'Edit', order: 22, when: hasProject, run: focusSearch },

    {
      id: 'wiki.insertLink',
      title: t('Link to a page'),
      // Ctrl+Shift+K is Ask AI wherever text is selected, this page included.
      shortcut: 'Ctrl+Alt+K',
      menu: 'Insert',
      order: 10,
      keywords: 'wiki link',
      when: isEditing,
      run: () => {
        const { editor } = useWikiSession.getState();
        if (editor) startWikiLink(editor);
      },
    },
    {
      id: 'wiki.insertReference',
      title: t('Reference…'),
      shortcut: 'Ctrl+Shift+R',
      menu: 'Insert',
      order: 11,
      keywords: 'citation footnote source',
      when: isEditing,
      run: () => {
        const { editor } = useWikiSession.getState();
        if (editor) return insertReference(editor);
      },
    },

    {
      id: 'wiki.insertList',
      title: t('List of pages…'),
      menu: 'Insert',
      order: 12,
      keywords: 'query category type automatic',
      when: isEditing,
      run: () => {
        const { editor } = useWikiSession.getState();
        if (editor) return insertPageList(editor);
      },
    },

    special('home', t('Main page'), { view: 'home' }, 'View', 1),
    special('allPages', t('All pages'), { view: 'allPages' }, 'View', 2, 'list index'),
    special('categories', t('Categories'), { view: 'categories' }, 'View', 3),
    special('recent', t('Recent changes'), { view: 'recent' }, 'View', 4, 'history'),
    { id: 'wiki.random', title: t('Random page'), menu: 'View', order: 5, when: hasProject, run: randomPage },

    special('wanted', t('Wanted pages'), { view: 'wanted' }, 'Tools', 10, 'red links missing'),
    special('orphans', t('Orphaned pages'), { view: 'orphans' }, 'Tools', 11, 'unlinked'),
    special('stubs', t('Short pages'), { view: 'stubs' }, 'Tools', 12, 'stubs'),
    special('trash', t('Trash'), { view: 'trash' }, 'Tools', 13, 'deleted restore'),
    { id: 'wiki.pageTypes', title: t('Page types…'), menu: 'Tools', order: 14, keywords: 'templates custom infobox', when: hasProject, run: () => void openPageTypes() },
    // Last, so that typing "trash" in the palette still goes to the Trash first.
    { id: 'wiki.trashPage', title: t('Move this page to the trash…'), shortcut: 'Ctrl+Shift+Delete', menu: 'Edit', order: 13, keywords: 'delete remove', when: hasPage, run: trashCurrentPage },
  ]);
}
