/** Export and import. The screens and everything they use load when first opened. */

import { lazy, Suspense } from 'react';

import { registerCommands } from '../shell/commands';
import * as api from '../lib/api';
import { subscribeLocale, t } from '../lib/i18n';
import { platform } from '../lib/platform';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import '../styles/exporters.css';

const ExportScreen = lazy(() => import('./ExportView'));
const ImportScreen = lazy(() => import('./ImportView'));
const PublishingScreen = lazy(() => import('./PublishingView'));

export function ExportView() {
  return (
    <Suspense fallback={null}>
      <ExportScreen />
    </Suspense>
  );
}

export function ImportView() {
  return (
    <Suspense fallback={null}>
      <ImportScreen />
    </Suspense>
  );
}

export function PublishingView({ bookId }: { bookId?: string }) {
  return (
    <Suspense fallback={null}>
      <PublishingScreen bookId={bookId} />
    </Suspense>
  );
}

const hasProject = () => useProject.getState().status.open;

function onAPage(): boolean {
  const { view } = useNav.getState().route;
  return hasProject() && (view === 'page' || view === 'home');
}

function canExportPagePdf(): boolean {
  return onAPage() && platform().pdf;
}

/** Opens the export screen ready to make a PDF of what is on screen. */
async function exportThisPage() {
  const { route, go } = useNav.getState();
  const pageId = route.view === 'page' ? route.id : (await api.pages.home())?.id;
  const { presetExport } = await import('./ExportView');
  presetExport('wiki-pdf', pageId);
  go({ view: 'export' });
}

/** Titles are read when registered, so a change of language registers them again. */
let followsLanguage = false;

export function registerExporters() {
  if (!followsLanguage) {
    followsLanguage = true;
    subscribeLocale(registerExporters);
  }
  registerCommands([
    {
      id: 'file.export',
      title: t('Export…'),
      menu: 'File',
      order: 40,
      when: hasProject,
      keywords: 'json markdown csv yaml xml mediawiki html site sillytavern sqlite docx word epub pdf backup',
      run: () => useNav.getState().go({ view: 'export' }),
    },
    {
      id: 'file.exportPagePdf',
      title: t('Export this page as PDF…'),
      menu: 'File',
      order: 41,
      when: canExportPagePdf,
      keywords: 'print pdf',
      run: exportThisPage,
    },
    {
      id: 'file.import',
      title: t('Import…'),
      menu: 'File',
      order: 42,
      when: hasProject,
      keywords: 'json markdown obsidian docx word text lore',
      run: () => useNav.getState().go({ view: 'import' }),
    },
    {
      id: 'file.publishing',
      title: t('Publishing details…'),
      menu: 'File',
      order: 43,
      when: hasProject,
      keywords: 'cover series isbn copyright dedication epigraph acknowledgments about author appendix glossary cast',
      run: () => {
        const { route, go } = useNav.getState();
        go({ view: 'publishing', bookId: route.view === 'write' ? route.bookId : undefined });
      },
    },
  ]);
}
