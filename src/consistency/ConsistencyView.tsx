/** The findings of the checks, and what the writer does about them. */

import { useEffect, useMemo, useRef, useState } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { relativeTime } from '../lib/text';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { RunPanel } from './RunPanel';
import { WikiUpdatesPanel } from './WikiUpdatesPanel';
import * as api from './api';
import { fixInManuscript, pageEvidenceOf, sceneEvidenceOf, updateWiki } from './fixes';
import { openEvidence } from './openAt';
import { loadLastRun, loadWikiUpdates, runRules, useConsistency } from './store';
import {
  ruleLabel,
  severityLabel,
  statusLabel,
  type Evidence,
  type Finding,
  type FindingSeverity,
  type FindingStatus,
} from './types';

type StatusFilter = FindingStatus | 'all';

const STATUSES: FindingStatus[] = ['open', 'intentional', 'ignored', 'fixed'];
const SEVERITIES: FindingSeverity[] = ['error', 'warning', 'info'];

/** A status with how many findings have it, whole, since "Open" alone is also a verb elsewhere. */
function statusOption(status: FindingStatus, count: number): string {
  switch (status) {
    case 'open':
      return t('Open ({count})', { count });
    case 'fixed':
      return t('Fixed ({count})', { count });
    case 'intentional':
      return t('Intentional ({count})', { count });
    case 'ignored':
      return t('Ignored ({count})', { count });
  }
}

function EvidenceCard({ evidence }: { evidence: Evidence }) {
  useLocale();
  const kind = evidence.sourceKind === 'page' ? t('Wiki page') : t('Scene');
  return (
    <div className="cons-quote">
      <button
        type="button"
        className="link-button cons-quote-source"
        title={t('Open {title} at this spot', { title: evidence.title })}
        onClick={() => {
          void openEvidence(evidence).then(({ entry }) => {
            if (!entry) toast(t('{title} could not be opened. It may have been deleted.', { title: evidence.title }), 'error');
          });
        }}
      >
        {evidence.title}
      </button>
      <span className="cons-quote-kind">
        {kind}
        {evidence.status ? `, ${evidence.status}` : ''}
      </span>
      <blockquote>{evidence.quote}</blockquote>
    </div>
  );
}

function FindingCard({ finding, onStatus }: { finding: Finding; onStatus: (finding: Finding, status: FindingStatus) => void }) {
  useLocale();
  const closed = finding.status !== 'open';
  const scene = sceneEvidenceOf(finding);
  const page = pageEvidenceOf(finding);
  return (
    <article className={`cons-finding cons-finding-${finding.severity}`} data-finding={finding.id} data-rule={finding.rule} tabIndex={-1} aria-label={finding.title}>
      <h4 className="cons-finding-title">
        {finding.title}
        <span className="badge">{finding.source === 'ai' ? t('AI') : t('Rule')}</span>
        {closed && <span className="badge">{statusLabel(finding.status)}</span>}
      </h4>
      {finding.detail && <p className="cons-finding-detail">{finding.detail}</p>}
      {finding.evidence.length > 0 && (
        <div className={`cons-quotes cons-quotes-${Math.min(finding.evidence.length, 2)}`}>
          {finding.evidence.map((evidence, index) => (
            <EvidenceCard key={`${evidence.sourceId}:${index}`} evidence={evidence} />
          ))}
        </div>
      )}
      <div className="cons-actions">
        {closed ? (
          <button type="button" className="btn btn-sm" onClick={() => onStatus(finding, 'open')}>{t('Reopen')}</button>
        ) : (
          <>
            {scene && (
              <button type="button" className="btn btn-sm" onClick={() => void fixInManuscript(finding)}>{t('Fix in manuscript')}</button>
            )}
            {page && (
              <button type="button" className="btn btn-sm" onClick={() => void updateWiki(finding)}>{t('Update wiki')}</button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => onStatus(finding, 'fixed')}>{t('Mark fixed')}</button>
            <button type="button" className="btn btn-sm" onClick={() => onStatus(finding, 'intentional')}>{t('Mark intentional')}</button>
            <button type="button" className="btn btn-sm" onClick={() => onStatus(finding, 'ignored')}>{t('Ignore')}</button>
          </>
        )}
      </div>
    </article>
  );
}

/** The books a finding belongs to, through the scenes it cites. */
function booksOf(finding: Finding, bookOfNode: Map<string, string>): string[] {
  return finding.evidence
    .filter((evidence) => evidence.sourceKind === 'node')
    .map((evidence) => bookOfNode.get(evidence.sourceId))
    .filter((id): id is string => !!id);
}

export function ConsistencyView() {
  useLocale();
  const version = useDataVersion('findings');
  const { data: findings, error } = useLoad(() => api.findings.list(), [version]);
  const world = useConsistency((s) => s.world);
  const rulesRunning = useConsistency((s) => s.rulesRunning);
  const rulesRanAt = useConsistency((s) => s.rulesRanAt);
  const rulesError = useConsistency((s) => s.rulesError);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [bookFilter, setBookFilter] = useState('all');
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<number | null>(null);
  const isHere = useNav((s) => s.route.view === 'consistency');

  // Fast and quiet, and an unchanged result writes nothing, so it does not mark the project changed.
  useEffect(() => {
    if (!isHere) return;
    void runRules();
    void loadLastRun();
    void loadWikiUpdates();
  }, [isHere]);

  const bookOfNode = useMemo(() => new Map((world?.nodes ?? []).map((node) => [node.id, node.bookId])), [world]);
  const books = world?.books ?? [];

  const counts = useMemo(() => {
    const out: Record<FindingStatus, number> = { open: 0, fixed: 0, intentional: 0, ignored: 0 };
    for (const finding of findings ?? []) {
      if (bookFilter === 'all' || booksOf(finding, bookOfNode).includes(bookFilter)) out[finding.status] += 1;
    }
    return out;
  }, [findings, bookFilter, bookOfNode]);

  const shown = useMemo(
    () =>
      (findings ?? []).filter(
        (finding) =>
          (statusFilter === 'all' || finding.status === statusFilter) &&
          (bookFilter === 'all' || booksOf(finding, bookOfNode).includes(bookFilter)),
      ),
    [findings, statusFilter, bookFilter, bookOfNode],
  );

  const grouped = useMemo(() => {
    return SEVERITIES.map((severity) => {
      const inSeverity = shown.filter((finding) => finding.severity === severity);
      const rules = new Map<string, Finding[]>();
      for (const finding of inSeverity) rules.set(finding.rule, [...(rules.get(finding.rule) ?? []), finding]);
      return { severity, count: inSeverity.length, rules: [...rules.entries()] };
    }).filter((group) => group.count > 0);
  }, [shown]);

  // A finding that leaves the list takes the keyboard with it, so hand focus on to the next one.
  useEffect(() => {
    if (focusAfter.current === null) return;
    const cards = listRef.current?.querySelectorAll<HTMLElement>('[data-finding]');
    if (cards && cards.length > 0) cards[Math.min(focusAfter.current, cards.length - 1)].focus({ preventScroll: true });
    focusAfter.current = null;
  }, [shown]);

  const setStatus = (finding: Finding, status: FindingStatus) => {
    const cards = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-finding]') ?? [])];
    focusAfter.current = cards.findIndex((card) => card.dataset.finding === finding.id);
    api.findings.setStatus(finding.id, status).catch((e: unknown) => toast(errorMessage(e), 'error'));
  };

  const nothingAtAll = findings !== undefined && findings.length === 0;

  return (
    <div className="view-pad cons-view">
      <h1 className="view-title">{t('Consistency')}</h1>

      <div className="cons-toolbar">
        <button type="button" className="btn" disabled={rulesRunning} onClick={() => void runRules()}>
          {rulesRunning ? t('Running rule checks…') : t('Run rule checks')}
        </button>
        <span className="muted cons-toolbar-note" role="status">
          {rulesError
            ? t('Rule checks could not run: {error}', { error: rulesError })
            : rulesRanAt
              ? t('Rule checks ran {when}. They run each time this screen opens.', { when: relativeTime(rulesRanAt) })
              : ''}
        </span>
      </div>

      <RunPanel />
      <WikiUpdatesPanel />

      <div className="cons-filters">
        <label className="cons-filter">
          <span>{t('Status')}</span>
          <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
            {STATUSES.map((status) => (
              <option key={status} value={status}>{statusOption(status, counts[status])}</option>
            ))}
            <option value="all">{t('All ({count})', { count: counts.open + counts.fixed + counts.intentional + counts.ignored })}</option>
          </select>
        </label>
        <label className="cons-filter">
          <span>{t('Book')}</span>
          <select className="select" value={bookFilter} onChange={(e) => setBookFilter(e.target.value)}>
            <option value="all">{t('All books and the wiki')}</option>
            {books.map((book) => (
              <option key={book.id} value={book.id}>{book.title}</option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="cons-error" role="alert">{t('The findings could not be loaded: {message}', { message: error.message })}</p>}

      <div ref={listRef} data-testid="findings">
        {grouped.map((group) => (
          <section key={group.severity} className="cons-severity" aria-label={severityLabel(group.severity)}>
            <h2 className={`cons-severity-title cons-severity-${group.severity}`}>
              {severityLabel(group.severity)} <span className="cons-count">{group.count}</span>
            </h2>
            {group.rules.map(([rule, list]) => (
              <section key={rule} className="cons-rule" aria-label={ruleLabel(rule)}>
                <h3 className="cons-rule-title">
                  {ruleLabel(rule)} <span className="cons-count">{list.length}</span>
                </h3>
                {list.map((finding) => (
                  <FindingCard key={finding.id} finding={finding} onStatus={setStatus} />
                ))}
              </section>
            ))}
          </section>
        ))}
      </div>

      {findings !== undefined && shown.length === 0 && (
        <div className="empty-state" data-testid="findings-empty">
          {nothingAtAll ? (
            rulesRanAt ? (
              <>
                <p><strong>{t('No problems found.')}</strong></p>
                <p>{t('The rule checks looked at names, dates, links and scene details and found nothing wrong. To compare what the manuscript says with the wiki, run an AI check above.')}</p>
              </>
            ) : (
              <p>{t('Running the rule checks…')}</p>
            )
          ) : statusFilter === 'open' ? (
            <>
              <p><strong>{bookFilter === 'all' ? t('Nothing open.') : t('Nothing open in this book.')}</strong></p>
              <p>{t('Everything found so far has been fixed or decided. Choose another status above to see it again.')}</p>
            </>
          ) : (
            <p>{t('No findings here. Choose another status or book above.')}</p>
          )}
        </div>
      )}
    </div>
  );
}
