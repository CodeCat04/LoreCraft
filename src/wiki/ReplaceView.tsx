/** Project-wide find and replace, and the second half of renaming a page everywhere. */

import { useState } from 'react';

import type { ReplaceDocument, ReplaceMatch } from './api';
import { PageLink, RouteLink } from './links';
import {
  applyReplace,
  cancelRename,
  matchKey,
  runPreview,
  setReplaceField,
  tickedCount,
  undoLastReplace,
  useReplace,
} from './replaceStore';
import { t } from '../lib/i18n';
import { confirm } from '../shell/dialogs';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';

/** A document's matches shown before "show more", which keeps huge previews responsive. */
const MATCHES_SHOWN = 50;

/** The badge for a match outside the running text, in the interface language. */
function blockName(block: string): string | undefined {
  switch (block) {
    case 'heading':
      return t('Heading');
    case 'reference':
      return t('Reference');
    case 'codeBlock':
      return t('Code');
    case 'summary':
      return t('Summary');
    case 'infobox':
      return t('Infobox');
    default:
      return undefined;
  }
}

function matchCount(count: number): string {
  return count === 1 ? t('1 match') : t('{count} matches', { count: count.toLocaleString() });
}

/** How many matches the preview found and where, with how many are ticked when that differs. */
function previewSummary(total: number, documents: number, ticked: number): string {
  const vars = { count: total.toLocaleString(), documents: documents.toLocaleString(), ticked: ticked.toLocaleString() };
  if (ticked === total) {
    if (total === 1) return t('1 match in 1 document.');
    if (documents === 1) return t('{count} matches in 1 document.', vars);
    return t('{count} matches in {documents} documents.', vars);
  }
  if (total === 1) return t('1 match in 1 document, {ticked} ticked.', vars);
  if (documents === 1) return t('{count} matches in 1 document, {ticked} ticked.', vars);
  return t('{count} matches in {documents} documents, {ticked} ticked.', vars);
}

function replacedSummary(replacements: number, documents: number): string {
  const vars = { count: replacements.toLocaleString(), documents: documents.toLocaleString() };
  if (replacements === 1 && documents === 1) {
    return t('Replaced 1 match in 1 document. Each one has a checkpoint in its history from just before.');
  }
  if (documents === 1) {
    return t('Replaced {count} matches in 1 document. Each one has a checkpoint in its history from just before.', vars);
  }
  return t('Replaced {count} matches in {documents} documents. Each one has a checkpoint in its history from just before.', vars);
}

function MatchRow({ doc, match }: { doc: ReplaceDocument; match: ReplaceMatch }) {
  useLocale();
  const key = matchKey(doc.kind, doc.id, match.index);
  const ticked = useReplace((s) => !s.unticked.has(key));
  const where = blockName(match.block);
  return (
    <li className="wiki-replace-match">
      <label>
        <input
          type="checkbox"
          checked={ticked}
          aria-label={t('Replace “{text}” in {name}, before “{after}”', {
            text: match.text,
            name: doc.title || t('Untitled scene'),
            after: match.after.slice(0, 30),
          })}
          onChange={(e) => {
            const unticked = new Set(useReplace.getState().unticked);
            if (e.target.checked) unticked.delete(key);
            else unticked.add(key);
            useReplace.setState({ unticked });
          }}
        />
        <span className="wiki-replace-context">
          {where && <span className="badge">{where}</span>} {match.before}
          <del>{match.text}</del>
          {ticked && match.replacement && <ins>{match.replacement}</ins>}
          {match.after}
        </span>
      </label>
    </li>
  );
}

function DocumentMatches({ doc }: { doc: ReplaceDocument }) {
  useLocale();
  const [showAll, setShowAll] = useState(false);
  const keys = doc.matches.map((m) => matchKey(doc.kind, doc.id, m.index));
  const tickedHere = useReplace((s) => keys.filter((k) => !s.unticked.has(k)).length);
  const shown = showAll ? doc.matches : doc.matches.slice(0, MATCHES_SHOWN);
  const name = doc.title || t('Untitled scene');
  return (
    <section className="wiki-replace-doc" aria-label={name}>
      <header className="wiki-replace-doc-head">
        <input
          type="checkbox"
          aria-label={t('Replace all matches in {name}', { name })}
          checked={tickedHere === keys.length}
          ref={(el) => {
            if (el) el.indeterminate = tickedHere > 0 && tickedHere < keys.length;
          }}
          onChange={(e) => {
            const unticked = new Set(useReplace.getState().unticked);
            for (const key of keys) {
              if (e.target.checked) unticked.delete(key);
              else unticked.add(key);
            }
            useReplace.setState({ unticked });
          }}
        />
        <span className="wiki-replace-doc-title">
          {doc.kind === 'page' ? (
            <PageLink id={doc.id} title={name} />
          ) : (
            <RouteLink route={{ view: 'write', bookId: doc.bookId ?? undefined, nodeId: doc.id }}>{name}</RouteLink>
          )}
        </span>
        {doc.kind === 'node' && <span className="badge">{t('Scene')}</span>}
        <span className="faint small">{matchCount(doc.matches.length)}</span>
      </header>
      <ul className="wiki-replace-matches">
        {shown.map((match) => (
          <MatchRow key={match.index} doc={doc} match={match} />
        ))}
      </ul>
      {!showAll && doc.matches.length > MATCHES_SHOWN && (
        <button type="button" className="link-button small" onClick={() => setShowAll(true)}>
          {t('Show all {count} matches', { count: doc.matches.length.toLocaleString() })}
        </button>
      )}
    </section>
  );
}

export function ReplaceView() {
  useLocale();
  const state = useReplace();
  const { find, replace, caseSensitive, wholeWord, regex, scope, preview, busy, problem, rename, lastResult } = state;
  const ticked = tickedCount(state);
  const documentsTicked = (preview?.documents ?? []).filter((doc) =>
    doc.matches.some((m) => !state.unticked.has(matchKey(doc.kind, doc.id, m.index))),
  ).length;

  const apply = async () => {
    if (rename) {
      await applyReplace();
      return;
    }
    const yes = await confirm({
      title: ticked === 1 ? t('Replace 1 match?') : t('Replace {count} matches?', { count: ticked.toLocaleString() }),
      message:
        documentsTicked === 1
          ? t('This changes 1 document. Each one gets a checkpoint in its history first, so it can be undone from there.')
          : t('This changes {count} documents. Each one gets a checkpoint in its history first, so it can be undone from there.', {
              count: documentsTicked.toLocaleString(),
            }),
      confirmLabel: t('Replace'),
    });
    if (yes) await applyReplace();
  };

  const setAll = (on: boolean) => {
    const unticked = new Set<string>();
    if (!on) {
      for (const doc of preview?.documents ?? []) {
        for (const match of doc.matches) unticked.add(matchKey(doc.kind, doc.id, match.index));
      }
    }
    useReplace.setState({ unticked });
  };

  const replaceLabel = ticked === 1 ? t('Replace 1 match') : t('Replace {count} matches', { count: ticked.toLocaleString() });
  const renameLabel =
    ticked === 0
      ? t('Rename without changing the text')
      : ticked === 1
        ? t('Rename and replace 1 match')
        : t('Rename and replace {count} matches', { count: ticked.toLocaleString() });

  return (
    <div className="view-pad wiki-special wiki-replace">
      <h1 className="view-title">
        {rename ? t('Rename “{title}” everywhere', { title: rename.oldTitle }) : t('Find and replace')}
      </h1>

      {rename && (
        <div className="wiki-banner wiki-banner-info" role="note">
          <span>
            {t('“{oldTitle}” becomes “{newTitle}”.', { oldTitle: rename.oldTitle, newTitle: rename.newTitle })}{' '}
            {rename.linkedDocuments > 0 && (
              <>
                {rename.linkedDocuments === 1
                  ? t('Links in 1 document follow automatically.')
                  : t('Links in {count} documents follow automatically.', { count: rename.linkedDocuments.toLocaleString() })}{' '}
              </>
            )}
            {t('Choose below where the name changes in the text.')}
          </span>
          <span className="wiki-banner-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const { pageId } = rename;
                cancelRename();
                useNav.getState().go({ view: 'page', id: pageId });
              }}
            >
              {t('Cancel rename')}
            </button>
          </span>
        </div>
      )}

      <form
        className="wiki-replace-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (find && !busy) void runPreview();
        }}
      >
        <div className="wiki-form-row">
          <label className="field">
            <span className="field-label">{t('Find')}</span>
            <input
              className="input"
              autoFocus={!rename}
              value={find}
              readOnly={Boolean(rename)}
              onChange={(e) => setReplaceField({ find: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('Replace with')}</span>
            <input
              className="input"
              value={replace}
              readOnly={Boolean(rename)}
              onChange={(e) => setReplaceField({ replace: e.target.value })}
            />
          </label>
        </div>
        <div className="wiki-replace-options">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setReplaceField({ caseSensitive: e.target.checked })}
            />
            <span>{t('Match case')}</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={wholeWord}
              onChange={(e) => setReplaceField({ wholeWord: e.target.checked })}
            />
            <span>{t('Whole word')}</span>
          </label>
          {!rename && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={regex}
                onChange={(e) => setReplaceField({ regex: e.target.checked })}
              />
              <span>{t('Regular expression')}</span>
            </label>
          )}
          {!rename && (
            <label className="wiki-replace-scope">
              <span>{t('Look in')}</span>{' '}
              <select
                className="select"
                aria-label={t('Look in')}
                value={scope}
                onChange={(e) => setReplaceField({ scope: e.target.value as typeof scope })}
              >
                <option value="all">{t('Pages and scenes')}</option>
                <option value="pages">{t('Pages')}</option>
                <option value="scenes">{t('Scenes')}</option>
              </select>
            </label>
          )}
          {rename && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={rename.keepAlias}
                onChange={(e) => useReplace.setState({ rename: { ...rename, keepAlias: e.target.checked } })}
              />
              <span>{t('Keep “{title}” as another name for the page', { title: rename.oldTitle })}</span>
            </label>
          )}
        </div>
        {regex && (
          <p className="field-hint">
            {t('In the replacement, {short} or {long} stands for the first group in parentheses.', { short: '$1', long: '${1}' })}
          </p>
        )}
        <div className="wiki-replace-actions">
          <button type="submit" className="btn" disabled={!find || busy}>
            {busy ? t('Working…') : preview ? t('Preview again') : t('Preview')}
          </button>
        </div>
      </form>

      {problem && <p className="field-error wiki-replace-problem" role="alert">{problem}</p>}

      {lastResult && (
        <div className="wiki-banner wiki-banner-done" role="status">
          <span>{replacedSummary(lastResult.replacements, lastResult.documents.length)}</span>
          {(lastResult.undo?.length ?? 0) > 0 && (
            <span className="wiki-banner-actions">
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void undoLastReplace()}>
                {t('Undo')}
              </button>
            </span>
          )}
        </div>
      )}

      {preview && (
        <section aria-label={t('Preview')}>
          <div className="wiki-replace-summary">
            <p role="status">
              {preview.total === 0 ? t('Nothing matches.') : previewSummary(preview.total, preview.documents.length, ticked)}
            </p>
            <span className="wiki-replace-bulk">
              {preview.total > 0 && (
                <>
                  <button type="button" className="btn btn-sm" onClick={() => setAll(true)}>{t('Tick all')}</button>
                  <button type="button" className="btn btn-sm" onClick={() => setAll(false)}>{t('Untick all')}</button>
                </>
              )}
              {(preview.total > 0 || rename) && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || (!rename && ticked === 0)}
                  onClick={() => void apply()}
                >
                  {rename ? renameLabel : replaceLabel}
                </button>
              )}
            </span>
          </div>
          {preview.truncated && (
            <p className="wiki-form-note" role="note">
              {t('This preview stops at {count} matches. Replace these, then preview again to find the rest.', {
                count: preview.total.toLocaleString(),
              })}
            </p>
          )}
          {preview.documents.map((doc) => (
            <DocumentMatches key={`${doc.kind}:${doc.id}`} doc={doc} />
          ))}
        </section>
      )}
    </div>
  );
}
