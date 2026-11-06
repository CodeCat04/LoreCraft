/** Help: the shortcuts list, About, Getting started, the sample world and the first-run guide. */

import { subscribeLocale, t } from '../lib/i18n';
import { registerCommands } from '../shell/commands';
import '../styles/help.css';
import { openAbout, openGettingStarted, openShortcuts } from './dialogs';
import { reopenGuide } from './FirstRunGuide';
import { openSampleWorld } from './openSample';

export { FirstRunGuide, startFirstRunGuide } from './FirstRunGuide';
export { openAbout, openGettingStarted, openShortcuts, openSampleWorld };

/** Titles are read when a command is registered, so this runs again when the language changes. */
function registerHelpCommands() {
  registerCommands([
    { id: 'help.gettingStarted', title: t('Getting started'), menu: 'Help', order: 1, keywords: 'tutorial how to learn', run: openGettingStarted },
    { id: 'help.shortcuts', title: t('Keyboard shortcuts'), shortcut: 'F1', menu: 'Help', order: 2, keywords: 'keys hotkeys', run: openShortcuts },
    { id: 'help.guide', title: t('Show the first-run guide'), menu: 'Help', order: 3, keywords: 'tour tutorial welcome', run: reopenGuide },
    { id: 'help.sampleWorld', title: t('Open sample world'), menu: 'Help', order: 5, keywords: 'example demo', run: openSampleWorld },
    // The GitHub link sits at order 10, with the shell's other Help command.
    { id: 'help.about', title: t('About LoreCraft'), menu: 'Help', order: 11, keywords: 'version license data folder', run: openAbout },
  ]);
}

export function registerHelp() {
  registerHelpCommands();
  subscribeLocale(registerHelpCommands);
}
