/**
 * Every saved version of a page or scene, comparison between any two, and restore. The wiki
 * shows it as a page's History tab, and the Write area shows it for a scene.
 */

import { useEffect, useId, useMemo, useState } from 'react';

import { wikiRevisions, type WikiRevision } from './api';
import { compareTexts, countChanges, foldUnchanged, versionText, type DiffLine } from './diff';
import { RichEditor } from '../editor/RichEditor';
import { flushAllEditors, flushOrStop } from '../editor/saving';
import { confirm, promptText } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import * as api from '../lib/api';
import { errorMessage } from '../lib/rpc';
import { formatNumber, relativeTime } from '../lib/text';
import type { PmNode, RevisionMeta } from '../lib/types';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

const CURRENT = 'current';

export type HistoryKind = 'page' | 'node';

export function reasonLabel(reason: string): string {
  switch (reason) {
    case 'auto':
      return t('Automatic');
    case 'save':
      return t('Saved to file');
    case 'ai':
      return t('Before an AI edit');
    case 'restore':
      return t('Before a restore');
    case 'manual':
      return t('Checkpoint');
    case 'replace':
      return t('Before find and replace');
    case 'import':
      return t('Before an import');
    case 'split':
      return t('Before a split');
    case 'split-off':
      return t('Split off from another scene');
    case 'merge':
      return t('Before a merge');
    case 'unmerge':
      return t('Before a merged scene came back');
    case 'undo':
      return t('Before an undo');
    default:
      return reason;
  }
}

function fullTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function DiffLineView({ line }: { line: DiffLine }) {
  return (
    <p className={`wiki-diff-line${line.kind === 'changed' ? ' is-changed' : ''}`}>
      {line.runs.map((run, index) =>
        run.kind === 'ins' ? (
          <ins key={index}>{run.text}</ins>
        ) : run.kind === 'del' ? (
          <del key={index}>{run.text}</del>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </p>
  );
}

function DiffBody({ lines }: { lines: DiffLine[] }) {
  useLocale();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const folded = useMemo(() => foldUnchanged(lines), [lines]);
  return (
    <div className="wiki-diff-body">
      {folded.map((item, index) => {
        if (item.kind !== 'skip') return <DiffLineView key={index} line={item} />;
        if (expanded.has(index)) {
          return item.lines.map((line, i) => <DiffLineView key={`${index}:${i}`} line={line} />);
        }
        return (
          <button
            key={index}
            type="button"
            className="link-button wiki-diff-skip"
            onClick={() => setExpanded((set) => new Set(set).add(index))}
          >
            {item.lines.length === 1
              ? t('Show 1 unchanged line')
              : t('Show {count} unchanged lines', { count: item.lines.length.toLocaleString() })}
          </button>
        );
      })}
    </div>
  );
}

/** What is stored now. A scene has no infobox or summary, so those stay undefined. */
interface Current {
  content: PmNode;
  infobox?: unknown;
  summary?: string;
  updatedAt: string;
}

type Loaded = { label: string; at: string; revision: WikiRevision | null; page: Current | null };

async function loadCurrent(kind: HistoryKind, id: string): Promise<Current> {
  await flushAllEditors();
  if (kind === 'page') {
    const page = await api.pages.get(id);
    return { content: page.content, infobox: page.infobox, summary: page.summary, updatedAt: page.updatedAt };
  }
  const node = await api.nodes.get(id);
  return { content: node.content, updatedAt: node.updatedAt };
}

async function loadVersion(kind: HistoryKind, id: string, version: string, list: RevisionMeta[]): Promise<Loaded> {
  if (version === CURRENT) {
    const page = await loadCurrent(kind, id);
    return { label: t('current version'), at: page.updatedAt, revision: null, page };
  }
  const revision = await wikiRevisions.get(version);
  const meta = list.find((r) => r.id === version);
  return {
    label: fullTime(meta?.createdAt ?? revision.createdAt),
    at: meta?.createdAt ?? revision.createdAt,
    revision,
    page: null,
  };
}

function CompareView(props: {
  kind: HistoryKind;
  id: string;
  older: string;
  newer: string;
  revisions: RevisionMeta[];
  onClose: () => void;
}) {
  useLocale();
  const { kind, id, older, newer, revisions } = props;
  const [sides, setSides] = useState<[Loaded, Loaded] | null>(null);
  const [markup, setMarkup] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSides(null);
    setProblem(null);
    Promise.all([loadVersion(kind, id, older, revisions), loadVersion(kind, id, newer, revisions)]).then(
      ([a, b]) => {
        if (cancelled) return;
        // Always older on the left, whichever way round they were picked.
        setSides(new Date(a.at) <= new Date(b.at) ? [a, b] : [b, a]);
      },
      (e) => {
        if (!cancelled) setProblem(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind, id, older, newer, revisions]);

  const lines = useMemo(() => {
    if (!sides) return null;
    const parts = sides.map((side) =>
      side.page
        ? { content: side.page.content, infobox: side.page.infobox, summary: side.page.summary }
        : {
            content: side.revision!.content,
            infobox: side.revision!.extra?.infobox,
            summary: side.revision!.extra?.summary,
          },
    );
    // Comparing with a revision too old to hold these would show them all as changes.
    const withExtras = parts.every((part) => part.infobox !== undefined);
    return compareTexts(versionText(parts[0], markup, withExtras), versionText(parts[1], markup, withExtras));
  }, [sides, markup]);

  const counts = lines ? countChanges(lines) : null;

  return (
    <section className="wiki-diff" aria-label={t('Comparison')}>
      <div className="wiki-diff-head">
        <h2 className="wiki-section-title">{t('Comparison')}</h2>
        <button type="button" className="btn btn-sm" onClick={props.onClose}>{t('Close comparison')}</button>
      </div>
      {problem && <p role="alert" className="field-error">{problem}</p>}
      {sides && lines && counts && (
        <>
          <p className="muted small">
            {t('From {older} to {newer}.', { older: sides[0].label, newer: sides[1].label })}{' '}
            {counts.inserted === 0 && counts.deleted === 0 ? (
              t('No differences in the text.')
            ) : (
              <>
                <span className="wiki-delta-up">
                  {counts.inserted === 1
                    ? t('1 word added')
                    : t('{count} words added', { count: counts.inserted.toLocaleString() })}
                </span>
                ,{' '}
                <span className="wiki-delta-down">
                  {counts.deleted === 1
                    ? t('1 word removed')
                    : t('{count} words removed', { count: counts.deleted.toLocaleString() })}
                </span>
                .
              </>
            )}
          </p>
          <label className="checkbox small">
            <input type="checkbox" checked={markup} onChange={(e) => setMarkup(e.target.checked)} />
            <span>{t('Show links and formatting')}</span>
          </label>
          <DiffBody lines={lines} />
        </>
      )}
    </section>
  );
}

function RevisionView(props: { kind: HistoryKind; id: string; onClose: () => void; onRestore: () => void }) {
  useLocale();
  const { data: revision } = useLoad(() => wikiRevisions.get(props.id), [props.id]);
  if (!revision) return null;
  const date = fullTime(revision.createdAt);
  return (
    <section className="wiki-old-version" aria-label={t('Old version')}>
      <div className="wiki-banner wiki-banner-info">
        <span>
          {props.kind === 'page'
            ? t('This is an old version, from {date}. It may differ from the current page.', { date })
            : t('This is an old version, from {date}. It may differ from the current scene.', { date })}
        </span>
        <span className="wiki-banner-actions">
          <button type="button" className="btn btn-sm" onClick={props.onRestore}>{t('Restore this version')}</button>
          <button type="button" className="btn btn-sm" onClick={props.onClose}>{t('Close')}</button>
        </span>
      </div>
      <RichEditor
        docKey={`revision:${revision.id}`}
        content={revision.content}
        editable={false}
        toolbar={false}
        comments={false}
        source={{ kind: props.kind, id: revision.entityId, title: revision.title }}
      />
    </section>
  );
}

export function HistoryTab(props: {
  pageId: string;
  title: string;
  updatedAt: string;
  wordCount: number;
  /** Shows the article again after a restore. */
  onRestored: () => void;
}) {
  const { pageId, ...rest } = props;
  return <VersionHistory kind="page" id={pageId} {...rest} />;
}

/** The history of one page or scene: its versions, comparison, checkpoints and restore. */
export function VersionHistory(props: {
  kind: HistoryKind;
  id: string;
  title: string;
  updatedAt: string;
  wordCount: number;
  /** Runs after a restore, to show the document again. */
  onRestored: () => void;
}) {
  useLocale();
  const { kind, id, title, updatedAt, wordCount } = props;
  // Two histories can be on screen at once, and each needs its own radio buttons.
  const group = useId();
  const version = useDataVersion(`doc:${kind}:${id}`, kind === 'page' ? 'pageContent' : 'nodeContent');
  const { data: revisions, reload } = useLoad(() => api.revisions.list(kind, id), [kind, id, version]);
  const [older, setOlder] = useState<string | null>(null);
  const [newer, setNewer] = useState(CURRENT);
  const [comparing, setComparing] = useState<{ older: string; newer: string } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const list = revisions ?? [];
  const oldSelected = older ?? list[0]?.id ?? null;

  const restore = async (revisionId: string) => {
    const revision = list.find((r) => r.id === revisionId);
    const yes = await confirm({
      title: t('Restore this version?'),
      message: revision
        ? t('“{title}” goes back to how it was on {date}. The current version stays in this history, so you can return to it.', {
            title,
            date: fullTime(revision.createdAt),
          })
        : t('“{title}” goes back to how it was on that date. The current version stays in this history, so you can return to it.', {
            title,
          }),
      confirmLabel: t('Restore'),
    });
    if (!yes) return;
    try {
      await flushOrStop();
      await api.revisions.restore(revisionId);
      toast(t('Restored that version.'), 'success');
      setComparing(null);
      setViewing(null);
      props.onRestored();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const checkpoint = async () => {
    const reason = await promptText({
      title: t('Save a checkpoint'),
      label: t('What makes this version worth keeping? (optional)'),
      placeholder: t('Before the rewrite'),
      confirmLabel: t('Save checkpoint'),
    });
    if (reason === null) return;
    try {
      await flushOrStop();
      const made = await api.revisions.checkpoint(kind, id, reason.trim() || undefined);
      if (made) {
        toast(t('Checkpoint saved.'), 'success');
        reload();
      } else {
        toast(t('Nothing has changed since the last version in this history.'));
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="wiki-history">
      <div className="wiki-history-actions">
        <p className="muted small">
          {t('Pick two versions with the Old and New buttons to compare them, or compare any version with the current one.')}
        </p>
        <span className="wiki-history-buttons">
          <button type="button" className="btn btn-sm" onClick={() => void checkpoint()}>{t('Save a checkpoint')}</button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!oldSelected || oldSelected === newer}
            onClick={() => {
              if (oldSelected) {
                setViewing(null);
                setComparing({ older: oldSelected, newer });
              }
            }}
          >
            {t('Compare selected versions')}
          </button>
        </span>
      </div>

      {viewing && (
        <RevisionView kind={kind} id={viewing} onClose={() => setViewing(null)} onRestore={() => void restore(viewing)} />
      )}
      {comparing && (
        <CompareView
          kind={kind}
          id={id}
          older={comparing.older}
          newer={comparing.newer}
          revisions={list}
          onClose={() => setComparing(null)}
        />
      )}

      <table className="data-table wiki-history-table">
        <thead>
          <tr>
            <th scope="col">{t('Old')}</th>
            <th scope="col">{t('New')}</th>
            <th scope="col">{t('When')}</th>
            <th scope="col">{t('Why')}</th>
            <th scope="col" className="wiki-num">{t('Words')}</th>
            <th scope="col"><span className="wiki-visually-hidden">{t('Actions')}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr className="wiki-history-current">
            <td />
            <td>
              <input
                type="radio"
                name={`${group}-new`}
                aria-label={t('Use the current version as the newer one')}
                checked={newer === CURRENT}
                onChange={() => setNewer(CURRENT)}
              />
            </td>
            <td title={fullTime(updatedAt)}>{t('Current version, edited {time}', { time: relativeTime(updatedAt) })}</td>
            <td />
            <td className="wiki-num">{formatNumber(wordCount)}</td>
            <td />
          </tr>
          {list.map((revision, index) => {
            const previous = list[index + 1];
            const delta = previous ? revision.wordCount - previous.wordCount : null;
            const when = fullTime(revision.createdAt);
            return (
              <tr key={revision.id} data-revision={revision.id}>
                <td>
                  <input
                    type="radio"
                    name={`${group}-old`}
                    aria-label={t('Use the version from {when} as the older one', { when })}
                    checked={oldSelected === revision.id}
                    onChange={() => setOlder(revision.id)}
                  />
                </td>
                <td>
                  <input
                    type="radio"
                    name={`${group}-new`}
                    aria-label={t('Use the version from {when} as the newer one', { when })}
                    checked={newer === revision.id}
                    onChange={() => setNewer(revision.id)}
                  />
                </td>
                <td title={relativeTime(revision.createdAt)}>{when}</td>
                <td>{reasonLabel(revision.reason)}</td>
                <td className="wiki-num">
                  {formatNumber(revision.wordCount)}
                  {delta !== null && delta !== 0 && (
                    <span className={delta > 0 ? 'wiki-delta-up' : 'wiki-delta-down'}>
                      {' '}
                      ({delta > 0 ? '+' : '−'}
                      {formatNumber(Math.abs(delta))})
                    </span>
                  )}
                </td>
                <td className="wiki-row-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={t('Compare the version from {when} with the current version', { when })}
                    onClick={() => {
                      setViewing(null);
                      setComparing({ older: revision.id, newer: CURRENT });
                    }}
                  >
                    {t('Compare')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={t('View the version from {when}', { when })}
                    onClick={() => {
                      setComparing(null);
                      setViewing(revision.id);
                    }}
                  >
                    {t('View')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={t('Restore the version from {when}', { when })}
                    onClick={() => void restore(revision.id)}
                  >
                    {t('Restore')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {revisions && list.length === 0 && (
        <p className="muted wiki-history-empty">
          {t('No earlier versions yet. Versions appear as you edit, each time you save the project, and when you save a checkpoint.')}
        </p>
      )}
    </div>
  );
}
