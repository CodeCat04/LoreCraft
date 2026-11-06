import { openBackups } from './BackupsDialog';
import { closeProject, handleWindowClose, newProject, openProject, saveProject, saveProjectAs } from './fileActions';
import { registerCommands, type Command } from './commands';
import { useProject } from '../state/project';
import { useNav } from '../state/nav';
import { useSettings } from '../state/settings';
import { focusedPane } from '../state/tabs';
import { useUi } from '../state/ui';
import { THEMES, type ThemeId } from '../lib/settings';
import * as api from '../lib/api';
import { t } from '../lib/i18n';

const hasProject = () => useProject.getState().status.open;
const canUseTabs = () => hasProject() && !useUi.getState().focusMode;

function themeCommand(id: ThemeId, name: string, order: number): Command {
  return {
    id: `view.theme.${id}`,
    // The names are in the catalogs, from the theme picker in Settings.
    title: t('Theme: {name}', { name: t(name) }),
    menu: 'View',
    order,
    run: () => useSettings.getState().update({ appearance: { theme: id } }),
  };
}

/** Runs again when the interface language changes, which replaces the titles. */
export function registerCoreCommands() {
  const settings = () => useSettings.getState();
  registerCommands([
    // File
    { id: 'file.new', title: t('New project…'), shortcut: 'Ctrl+Shift+N', menu: 'File', order: 10, run: newProject },
    { id: 'file.open', title: t('Open project…'), shortcut: 'Ctrl+O', menu: 'File', order: 11, run: () => openProject() },
    { id: 'file.save', title: t('Save'), shortcut: 'Ctrl+S', menu: 'File', order: 20, when: hasProject, run: async () => { await saveProject(); } },
    { id: 'file.saveAs', title: t('Save as…'), shortcut: 'Ctrl+Shift+S', menu: 'File', order: 21, when: hasProject, run: async () => { await saveProjectAs(); } },
    { id: 'file.backups', title: t('Backups…'), menu: 'File', order: 22, keywords: 'restore previous version recover', run: openBackups },
    { id: 'file.close', title: t('Close project'), menu: 'File', order: 30, when: hasProject, run: closeProject },
    { id: 'file.quit', title: t('Exit'), menu: 'File', order: 90, run: handleWindowClose },

    // View
    { id: 'view.back', title: t('Back'), shortcut: 'Alt+ArrowLeft', menu: 'View', order: 10, when: hasProject, run: () => useNav.getState().goBack() },
    { id: 'view.forward', title: t('Forward'), shortcut: 'Alt+ArrowRight', menu: 'View', order: 11, when: hasProject, run: () => useNav.getState().goForward() },
    { id: 'view.newTab', title: t('New tab'), shortcut: 'Ctrl+T', menu: 'View', order: 12, when: canUseTabs, keywords: 'document open', run: () => useNav.getState().openTab({ view: 'home' }) },
    { id: 'view.closeTab', title: t('Close tab'), shortcut: 'Ctrl+W', menu: 'View', order: 13, when: canUseTabs, keywords: 'document', run: () => useNav.getState().closeTab() },
    { id: 'view.nextTab', title: t('Next tab'), shortcut: 'Ctrl+Tab', menu: 'View', order: 14, when: canUseTabs, keywords: 'document cycle switch', run: () => useNav.getState().cycleTab(1) },
    { id: 'view.previousTab', title: t('Previous tab'), shortcut: 'Ctrl+Shift+Tab', menu: 'View', order: 15, when: canUseTabs, keywords: 'document cycle switch', run: () => useNav.getState().cycleTab(-1) },
    { id: 'view.split', title: t('Split view'), shortcut: 'Ctrl+\\', menu: 'View', order: 16, when: canUseTabs, keywords: 'open beside second pane side by side', run: () => useNav.getState().toggleSplit() },
    {
      id: 'view.openBeside',
      title: t('Open this tab beside'),
      menu: 'View',
      order: 17,
      when: canUseTabs,
      keywords: 'split second pane side by side move',
      run: () => {
        const nav = useNav.getState();
        const pane = focusedPane(nav);
        nav.moveTabBeside(pane.activeTabId);
      },
    },
    {
      id: 'view.otherPane',
      title: t('Go to the other pane'),
      // With Shift held, the key for Ctrl+\ reports itself as |.
      shortcut: 'Ctrl+Shift+|',
      menu: 'View',
      order: 18,
      when: () => canUseTabs() && useNav.getState().panes.length > 1,
      keywords: 'split second switch focus',
      run: () => {
        const nav = useNav.getState();
        const other = nav.focusedPaneId === 'main' ? 'side' : 'main';
        nav.focusPane(other);
        const pane = document.querySelector(`[data-pane-id="${other}"]`);
        // The document if there is one, otherwise the tab, so the keyboard has somewhere to start.
        const target =
          pane?.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]') ??
          pane?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
        target?.focus();
      },
    },
    { id: 'view.textBigger', title: t('Larger writing text'), shortcut: 'Ctrl+=', menu: 'View', order: 30, run: () => settings().bumpContentScale(1) },
    { id: 'view.textBigger2', title: t('Larger writing text'), shortcut: 'Ctrl++', palette: false, run: () => settings().bumpContentScale(1) },
    { id: 'view.textSmaller', title: t('Smaller writing text'), shortcut: 'Ctrl+-', menu: 'View', order: 31, run: () => settings().bumpContentScale(-1) },
    { id: 'view.textReset', title: t('Reset writing text size'), shortcut: 'Ctrl+0', menu: 'View', order: 32, run: () => settings().bumpContentScale(0) },
    { id: 'view.uiBigger', title: t('Larger interface'), shortcut: 'Ctrl+Shift+=', menu: 'View', order: 33, run: () => settings().bumpUiScale(1) },
    { id: 'view.uiBigger2', title: t('Larger interface'), shortcut: 'Ctrl+Shift++', palette: false, run: () => settings().bumpUiScale(1) },
    { id: 'view.uiSmaller', title: t('Smaller interface'), shortcut: 'Ctrl+Shift+-', menu: 'View', order: 34, run: () => settings().bumpUiScale(-1) },
    { id: 'view.uiSmaller2', title: t('Smaller interface'), shortcut: 'Ctrl+Shift+_', palette: false, run: () => settings().bumpUiScale(-1) },
    { id: 'view.uiReset', title: t('Reset interface size'), shortcut: 'Ctrl+Shift+0', menu: 'View', order: 35, run: () => settings().bumpUiScale(0) },
    ...THEMES.map((theme, i) => themeCommand(theme.id, theme.name, 40 + i)),
    {
      id: 'view.toggleMode',
      title: t('Switch between light and dark'),
      shortcut: 'Ctrl+Shift+L',
      menu: 'View',
      order: 50,
      keywords: 'theme mode night day',
      run: () => {
        const mode = settings().settings.appearance.mode === 'dark' ? 'light' : 'dark';
        return settings().update({ appearance: { mode } });
      },
    },
    {
      id: 'view.palette',
      title: t('Command palette…'),
      shortcut: 'Ctrl+K',
      menu: 'View',
      order: 20,
      palette: false,
      run: () => useUi.getState().setPaletteOpen(true),
    },

    // Tools
    { id: 'tools.settings', title: t('Settings…'), shortcut: 'Ctrl+,', menu: 'Tools', order: 90, run: () => useNav.getState().go({ view: 'settings' }) },

    // Help
    {
      id: 'help.github',
      title: t('Project on GitHub'),
      menu: 'Help',
      order: 10,
      run: async () => { await api.app.openExternal('https://github.com/CodeCat04/LoreCraft'); },
    },
  ]);
}
