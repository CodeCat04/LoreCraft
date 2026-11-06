/** Starting an AI check, watching it, stopping it, resuming it, and what it found. */

import { useEffect, useMemo, useState } from 'react';

import { profileForTask } from '../ai/client';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useTitles } from '../state/project';
import type { RunRecord, RunScopeKind } from './ai/types';
import { statesFacts, type World, type WorldNode } from './rules/world';
import { cancelAiCheck, resumeAiCheck, startAiCheck, startWikiUpdates, useConsistency } from './store';

function sceneLabel(world: World, node: WorldNode): string {
  const parent = node.parentId ? world.nodeById.get(node.parentId) : undefined;
  const title = node.title?.trim() || t('Untitled scene');
  return parent?.title ? `${parent.title}: ${title}` : title;
}

function chapterOf(world: World, node: WorldNode | undefined): WorldNode | undefined {
  let at = node?.parentId ? world.nodeById.get(node.parentId) : undefined;
  for (let depth = 0; at && depth < 8; depth += 1) {
    if (at.kind === 'chapter') return at;
    at = at.parentId ? world.nodeById.get(at.parentId) : undefined;
  }
  return undefined;
}

/** The scene the writer was last in, to check by default. */
function lastScene(): string | null {
  const { route, back } = useNav.getState();
  for (const entry of [route, ...[...back].reverse()]) {
    if (entry.view === 'write' && entry.nodeId) return entry.nodeId;
  }
  return null;
}

/** The wiki page the writer was last on, to check by default. */
function lastPage(): string | null {
  const { route, back } = useNav.getState();
  for (const entry of [route, ...[...back].reverse()]) {
    if (entry.view === 'page') return entry.id;
  }
  return null;
}

function RunSummary({ record }: { record: RunRecord }) {
  useLocale();
  const { stats } = record;
  const dropped = stats.discardedQuotes;
  const sourceCount = record.sceneIds.length + (record.pageIds?.length ?? 0);
  const progressVars = { label: record.label, done: record.done.length, total: sourceCount };
  const stateLine =
    record.state === 'finished'
      ? t('Last AI check, {label}: finished.', { label: record.label })
      : record.state === 'cancelled'
        ? t('Last AI check, {label}: stopped with {done} of {total} done.', progressVars)
        : record.state === 'failed'
          ? `${t('Last AI check, {label}: stopped with {done} of {total} done.', progressVars)} ${record.error ?? ''}`
          : t('Last AI check, {label}: cut off with {done} of {total} done.', progressVars);
  return (
    <div className="cons-run-summary" data-testid="run-summary">
      <p>{stateLine}</p>
      <p data-testid="run-counts">
        {stats.kept === 1
          ? t('1 finding kept of {proposed} the model proposed.', { proposed: stats.proposed })
          : t('{count} findings kept of {proposed} the model proposed.', { count: stats.kept, proposed: stats.proposed })}{' '}
        <strong data-testid="run-discarded">
          {dropped === 1
            ? t('1 discarded because a quote was not really in its source.')
            : t('{count} discarded because a quote was not really in its source.', { count: dropped })}
        </strong>
        {stats.discardedWeak > 0 &&
          ` ${stats.discardedWeak === 1 ? t('1 dropped as weak.') : t('{count} dropped as weak.', { count: stats.discardedWeak })}`}
        {stats.discardedChanges > 0 &&
          ` ${stats.discardedChanges === 1 ? t('1 dropped as a fact that changes over time.') : t('{count} dropped as facts that change over time.', { count: stats.discardedChanges })}`}
        {stats.discardedStatus > 0 &&
          ` ${stats.discardedStatus === 1 ? t('1 dropped for citing a page that is not fact.') : t('{count} dropped for citing a page that is not fact.', { count: stats.discardedStatus })}`}
      </p>
      <p className="muted">
        {stats.claimsRead === 1
          ? t('1 scene read, {cached} unchanged and answered from the cache.', { cached: stats.claimsFromCache })
          : t('{count} scenes read, {cached} unchanged and answered from the cache.', { count: stats.claimsRead, cached: stats.claimsFromCache })}
        {stats.claimsDiscarded > 0 &&
          ` ${stats.claimsDiscarded === 1 ? t('1 extracted claim thrown away for quoting words not in the text.') : t('{count} extracted claims thrown away for quoting words not in the text.', { count: stats.claimsDiscarded })}`}
        {stats.comparisonsSkipped > 0 &&
          ` ${stats.comparisonsSkipped === 1 ? t('1 comparison skipped, since neither side had changed.') : t('{count} comparisons skipped, since neither side had changed.', { count: stats.comparisonsSkipped })}`}
        {stats.skippedLocalOnly > 0 &&
          ` ${stats.skippedLocalOnly === 1 ? t('1 local-only scene left out for this cloud profile.') : t('{count} local-only scenes left out for this cloud profile.', { count: stats.skippedLocalOnly })}`}
      </p>
      {stats.failedSources.length > 0 && (
        <p className="cons-error">{t('The model gave no usable answer for: {sources}. Run those again, or try another profile.', { sources: stats.failedSources.join(', ') })}</p>
      )}
      {stats.discardedExamples.length > 0 && (
        <details className="cons-discarded">
          <summary>{t('What was discarded')}</summary>
          <ul>
            {stats.discardedExamples.map((example, index) => (
              <li key={index}>{example}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function RunPanel() {
  useLocale();
  const world = useConsistency((s) => s.world);
  const aiRunning = useConsistency((s) => s.aiRunning);
  const progress = useConsistency((s) => s.progress);
  const record = useConsistency((s) => s.record);
  const updates = useConsistency((s) => s.updates);
  const titles = useTitles((s) => s.entries);
  const [bookId, setBookId] = useState('');
  const [sceneId, setSceneId] = useState('');
  const [pageId, setPageId] = useState('');

  const books = useMemo(() => [...(world?.books ?? [])].sort((a, b) => a.position - b.position), [world]);

  // Start on the scene the writer was last in.
  useEffect(() => {
    if (!world) return;
    const last = lastScene();
    const known = last ? world.nodeById.get(last) : undefined;
    setSceneId((current) => (current && world.nodeById.has(current) ? current : known?.kind === 'scene' ? known.id : (world.scenes[0]?.id ?? '')));
    setBookId((current) => (current && world.books.some((book) => book.id === current) ? current : (known?.bookId ?? world.scenes[0]?.bookId ?? world.books[0]?.id ?? '')));
  }, [world]);

  // Pages that state facts, since those are the ones that can contradict anything.
  const checkablePages = useMemo(
    () => [...(world?.pages ?? [])].filter((page) => statesFacts(page) && !page.isHome).sort((a, b) => a.title.localeCompare(b.title)),
    [world],
  );
  useEffect(() => {
    setPageId((current) => {
      if (current && checkablePages.some((page) => page.id === current)) return current;
      const last = lastPage();
      return last && checkablePages.some((page) => page.id === last) ? last : (checkablePages[0]?.id ?? '');
    });
  }, [checkablePages]);
  const checkedPage = checkablePages.find((page) => page.id === pageId);

  const scenes = useMemo(() => world?.scenes.filter((node) => node.bookId === bookId) ?? [], [world, bookId]);
  const scene = world?.nodeById.get(sceneId);
  const chapter = world && scene ? chapterOf(world, scene) : undefined;
  const book = books.find((b) => b.id === bookId);

  const run = (kind: RunScopeKind) => {
    if (!world) return;
    if (kind === 'scene' && scene) void startAiCheck('scene', scene.id, t('scene "{title}"', { title: scene.title || t('Untitled scene') }));
    if (kind === 'chapter' && chapter) void startAiCheck('chapter', chapter.id, t('chapter "{title}"', { title: chapter.title || t('Untitled chapter') }));
    if (kind === 'book' && book) void startAiCheck('book', book.id, t('book "{title}"', { title: book.title }));
  };

  // One request at a time for a local server, so these wait for each other.
  const busy = aiRunning || !!updates?.running;
  const canResume = !busy && record && record.state !== 'finished';
  const noPages = titles.length === 0;
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const slowHint = aiRunning && !profileForTask('consistency').isCloud ? t('… a local model can take a few minutes') : '…';

  return (
    <section className="cons-panel" aria-label={t('AI checks')}>
      <h2 className="cons-panel-title">{t('AI checks')}</h2>
      <p className="muted cons-panel-hint">
        {t('An AI check compares what the manuscript says with the wiki and with other scenes. Canon pages count as fact and draft pages as tentative. Every finding quotes both sources, and any quote that is not really there is thrown away.')}
      </p>
      <div className="cons-pickers">
        <label className="cons-filter">
          <span>{t('Book to check')}</span>
          <select
            className="select"
            value={bookId}
            onChange={(e) => {
              setBookId(e.target.value);
              setSceneId(world?.scenes.find((node) => node.bookId === e.target.value)?.id ?? '');
            }}
          >
            {books.map((b) => (
              <option key={b.id} value={b.id}>{b.title}</option>
            ))}
          </select>
        </label>
        <label className="cons-filter cons-filter-grow">
          <span>{t('Scene to check')}</span>
          <select className="select" value={sceneId} onChange={(e) => setSceneId(e.target.value)}>
            {scenes.length === 0 && <option value="">{t('No scenes in this book')}</option>}
            {world && scenes.map((node) => (
              <option key={node.id} value={node.id}>{sceneLabel(world, node)}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="cons-buttons">
        <button type="button" className="btn" disabled={busy || !scene} onClick={() => run('scene')}>{t('Run AI check on this scene')}</button>
        <button type="button" className="btn" disabled={busy || !chapter} onClick={() => run('chapter')}>{t('Run AI check on this chapter')}</button>
        <button type="button" className="btn" disabled={busy || scenes.length === 0} onClick={() => run('book')}>{t('Run AI check on this book')}</button>
        <button
          type="button"
          className="btn"
          disabled={busy || !chapter}
          title={t('The AI proposes new pages, infobox values and additions. Nothing changes until you approve it.')}
          onClick={() => chapter && void startWikiUpdates(chapter.id, chapter.title || t('Untitled chapter'))}
        >
          {t('Suggest wiki updates from this chapter')}
        </button>
      </div>
      <div className="cons-pickers cons-page-check">
        <label className="cons-filter cons-filter-grow">
          <span>{t('Wiki page to check against canon')}</span>
          <select className="select" value={pageId} onChange={(e) => setPageId(e.target.value)}>
            {checkablePages.length === 0 && <option value="">{t('No canon or draft pages yet')}</option>}
            {checkablePages.map((page) => (
              <option key={page.id} value={page.id}>{page.title}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy || !checkedPage}
          onClick={() => checkedPage && void startAiCheck('page', checkedPage.id, t('page "{title}"', { title: checkedPage.title }))}
        >
          {t('Run AI check on this page')}
        </button>
      </div>
      {noPages && <p className="muted">{t('There are no wiki pages yet, so an AI check has nothing to compare with.')}</p>}

      {aiRunning && progress && (
        <div className="cons-progress" data-testid="run-progress">
          <div className="cons-progress-row">
            <span role="status">{progress.step}{progress.thinking ? slowHint : ''}</span>
            <span className="muted">{t('{done} of {total} steps', { done: progress.done, total: progress.total })}</span>
            <button type="button" className="btn btn-sm" onClick={cancelAiCheck}>{t('Stop')}</button>
          </div>
          <div className="cons-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t('AI check progress')}>
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}

      {canResume && (
        <div className="cons-resume">
          <button type="button" className="btn btn-primary" onClick={() => void resumeAiCheck()}>{t('Resume AI check')}</button>
          <span className="muted"> {t('{done} of {total} done, and those will not be read again.', { done: record.done.length, total: record.sceneIds.length + (record.pageIds?.length ?? 0) })}</span>
        </div>
      )}
      {!aiRunning && record && <RunSummary record={record} />}
    </section>
  );
}
