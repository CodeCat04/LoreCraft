/** The writer's view of the summaries: read them, edit them, and see how far along they are. */

import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import * as coreApi from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import type { Book } from '../../lib/types';
import { toast } from '../../shell/toasts';
import { useLocale } from '../../state/language';
import { useSettings } from '../../state/settings';
import { activeEditor } from '../../editor/ai';
import { profileForTask } from '../client';
import { confirmRun } from '../limits/confirmRun';
import { summaries, type SummaryRow } from './api';
import { resumeSummaries, runSummaries, stopSummaries, useSummaryStatus } from './worker';

function SummaryItem({ row, onChanged }: { row: SummaryRow; onChanged: () => void }) {
  useLocale();
  const [draft, setDraft] = useState<string | null>(null);
  const save = async () => {
    try {
      await summaries.edit(row.kind, row.id, draft ?? '');
      setDraft(null);
      onChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const again = async () => {
    try {
      await summaries.regenerate(row.kind, row.id);
      onChanged();
      void runSummaries();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="ai-story-item" style={{ marginInlineStart: `${row.depth * 0.75}rem` }} data-testid="ai-story-item" data-title={row.title}>
      <div className="ai-context-line">
        <span className="ai-context-title truncate">{row.title || t('Untitled')}</span>
        <span className="faint small">{levelName(row.level)}</span>
        {row.edited && <span className="badge ai-context-badge">{t('edited by you')}</span>}
        {row.localOnly && <span className="badge ai-context-badge">{t('local only')}</span>}
      </div>
      {draft === null ? (
        <>
          {row.summary ? <p className="ai-story-text">{row.summary}</p> : <p className="faint small">{row.empty ? t('No text yet.') : t('Not summarized yet.')}</p>}
          {row.stale && <p className="ai-note">{row.edited ? t('The text changed after you edited this. It stays as you wrote it unless you make a new one.') : t('The text has changed, and this will be redone.')}</p>}
          {!row.empty && (
            <div className="ai-story-actions">
              <button type="button" className="btn btn-sm" aria-label={t('Edit the summary of {title}', { title: row.title })} onClick={() => setDraft(row.summary)}>{t('Edit')}</button>
              {(row.summary || row.edited) && (
                <button type="button" className="btn btn-sm" aria-label={t('Make a new summary of {title}', { title: row.title })} onClick={() => void again()}>{t('Make a new one')}</button>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <textarea
            className="textarea"
            rows={4}
            value={draft}
            aria-label={t('Summary of {title}', { title: row.title })}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDraft(null);
            }}
          />
          <div className="ai-story-actions">
            <button type="button" className="btn btn-sm" onClick={() => setDraft(null)}>{t('Cancel')}</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void save()}>{t('Save')}</button>
          </div>
        </>
      )}
    </div>
  );
}

function levelName(level: SummaryRow['level']): string {
  switch (level) {
    case 'scene':
      return t('scene');
    case 'chapter':
      return t('chapter');
    case 'part':
      return t('part');
    case 'book':
      return t('book');
    default:
      return level;
  }
}

function statusText(state: ReturnType<typeof useSummaryStatus.getState>): string {
  switch (state.state) {
    case 'running':
      return state.total > 0
        ? t('Summarizing {title} ({number} of {total})…', { title: state.current ?? '', number: state.done + 1, total: state.total })
        : t('Summarizing {title}…', { title: state.current ?? '' });
    case 'stopped':
      return t('Stopped. Nothing more is summarized until you resume.');
    case 'waiting':
    case 'off':
      return state.message ?? (state.state === 'off' ? t('Summaries are turned off in Settings > AI.') : t('Paused.'));
    default:
      return t('Summaries are made in the background once you pause.');
  }
}

export function StoryPanel() {
  useLocale();
  const [books, setBooks] = useState<Book[]>([]);
  const [bookId, setBookId] = useState<string | null>(null);
  const [rows, setRows] = useState<SummaryRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const status = useSummaryStatus();
  const enabled = useSettings((s) => s.settings.ai.summaries.enabled);

  const load = useCallback(async () => {
    try {
      const list = [...(await coreApi.books.list())].sort((a, b) => a.position - b.position);
      setBooks(list);
      let chosen = bookId && list.some((b) => b.id === bookId) ? bookId : null;
      if (!chosen) {
        const open = activeEditor();
        if (open?.source.kind === 'node') {
          chosen = await coreApi.nodes.get(open.source.id).then((node) => node.bookId).catch(() => null);
        }
      }
      chosen = chosen ?? list[0]?.id ?? null;
      setBookId(chosen);
      setRows(chosen ? await summaries.list(chosen) : []);
      setProblem(null);
    } catch (e) {
      setProblem(errorMessage(e));
    }
  }, [bookId]);

  useEffect(() => {
    void load();
    const stop = listen<{ entity: string }>('data://changed', (event) => {
      if (['summaries', 'nodes', 'books', 'all'].includes(event.payload.entity)) void load();
    });
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, [load]);

  const summarizeNow = async () => {
    const profile = profileForTask('extract');
    if (profile.isCloud && useSettings.getState().settings.ai.summaries.allowCloud) {
      // A whole book may be about to go somewhere that charges for it.
      const scenes = await Promise.all(books.map((book) => coreApi.nodes.tree(book.id)));
      const words = scenes.flat().reduce((sum, node) => sum + (node.kind === 'scene' ? node.wordCount : 0), 0);
      const go = await confirmRun({ label: t('Summarize your books'), text: 'word '.repeat(words), profile, outputShare: 0.15 });
      if (!go) return;
    }
    resumeSummaries();
  };

  return (
    <div className="ai-context" data-testid="ai-story">
      <div className="ai-story-status" role="status" data-testid="ai-story-status" data-state={status.state}>
        <span className="ai-bar-text">{statusText(status)}</span>
        {status.state === 'running' ? (
          <button type="button" className="btn btn-sm" onClick={stopSummaries}>{t('Stop')}</button>
        ) : (
          enabled && <button type="button" className="btn btn-sm" onClick={() => void summarizeNow()}>{status.state === 'stopped' ? t('Resume') : t('Summarize now')}</button>
        )}
      </div>
      {problem && <div className="ai-error" role="alert">{problem}</div>}
      {books.length > 1 && (
        <label className="ai-context-limit">
          <span>{t('Book')}</span>
          <select className="select" value={bookId ?? ''} onChange={(e) => setBookId(e.target.value)}>
            {books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
          </select>
        </label>
      )}
      {rows?.map((row) => <SummaryItem key={`${row.kind}:${row.id}`} row={row} onChanged={() => void load()} />)}
    </div>
  );
}
