import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { renderMarkdownSafe } from '../editor/convert';
import { followRenderedLink } from '../editor/renderedLinks';
import { toast } from '../shell/toasts';
import { confirm } from '../shell/dialogs';
import { useDataVersion } from '../state/events';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import { compareTexts, type DiffLine } from '../wiki/diff';
import { acceptProposal, rejectProposal } from './actions';
import { mcp, type Proposal } from './api';

/** A translated sentence with an element, such as a link, where `{name}` is. */
function withElement(template: string, name: string, element: ReactNode): ReactNode {
  const [before, after = ''] = template.split(`{${name}}`);
  return (
    <>
      {before}
      {element}
      {after}
    </>
  );
}

/** How many suggestions are waiting. Zero with no project open. */
export function useProposalCount(): number {
  const open = useProject((s) => s.status.open);
  const version = useDataVersion('proposals');
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!open) {
      setCount(0);
      return;
    }
    let alive = true;
    void mcp.proposalCount().then(
      (n) => {
        if (alive) setCount(n);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [open, version]);
  return count;
}

/** Sits in the top bar, and only there while something is waiting. */
export function ProposalsBadge() {
  useLocale();
  const count = useProposalCount();
  const go = useNav((s) => s.go);
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    if (count > seen && useNav.getState().route.view !== 'proposals') {
      toast(t('An outside AI tool left a suggestion for you to review.'));
    }
    setSeen(count);
  }, [count, seen]);
  if (count === 0) return null;
  const label = count === 1 ? t('1 outside suggestion') : t('{count} outside suggestions', { count });
  return (
    <button type="button" className="btn mcp-badge" title={t('Review suggestions from AI tools outside LoreCraft')} onClick={() => go({ view: 'proposals' })}>
      {label}
    </button>
  );
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="mcp-diff">
      {lines.map((line, index) => (
        <p key={index} className="mcp-diff-line">
          {line.runs.map((run, i) =>
            run.kind === 'ins' ? (
              <ins key={i}>{run.text}</ins>
            ) : run.kind === 'del' ? (
              <del key={i}>{run.text}</del>
            ) : (
              <span key={i}>{run.text}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function EditDetails({ proposal }: { proposal: Extract<Proposal, { kind: 'edit' }> }) {
  useLocale();
  const go = useNav((s) => s.go);
  const lines = useMemo(() => compareTexts(proposal.payload.quote, proposal.payload.replacement), [proposal]);
  const open = () => {
    if (proposal.targetKind === 'page') go({ view: 'page', id: proposal.targetId });
    else go({ view: 'write', nodeId: proposal.targetId });
  };
  const sentence = proposal.targetKind === 'page' ? t('Change to the page {title}') : t('Change to the scene {title}');
  return (
    <>
      <p className="mcp-proposal-title">
        {withElement(
          sentence,
          'title',
          <button type="button" className="link-button" onClick={open}>
            {proposal.title || t('Untitled')}
          </button>,
        )}
      </p>
      {lines.length > 0 ? <DiffView lines={lines} /> : <p className="muted">{t('Removes the quoted text.')}</p>}
    </>
  );
}

function NewPageDetails({ proposal }: { proposal: Extract<Proposal, { kind: 'newPage' }> }) {
  useLocale();
  const { payload } = proposal;
  const html = useMemo(() => renderMarkdownSafe(payload.body), [payload.body]);
  // Each part is a whole sentence, so they join with a full stop.
  const facts = [
    t('Type: {type}', { type: payload.pageType }),
    t('Starts as a draft'),
    payload.aliases?.length ? t('Also known as {names}', { names: payload.aliases.join(', ') }) : '',
    payload.categories?.length ? t('Categories: {names}', { names: payload.categories.join(', ') }) : '',
  ].filter(Boolean);
  return (
    <>
      <p className="mcp-proposal-title">{withElement(t('New page: {title}'), 'title', <strong>{payload.title}</strong>)}</p>
      <p className="muted small">{facts.join('. ')}</p>
      {payload.summary && <p>{payload.summary}</p>}
      {payload.infobox && payload.infobox.length > 0 && (
        <dl className="mcp-infobox">
          {payload.infobox.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {/* renderMarkdownSafe escapes all HTML, since this text came from an outside AI. */}
      <div className="mcp-new-page prose" onClick={followRenderedLink} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await acceptProposal(proposal);
      if (result.ok) {
        toast(proposal.kind === 'edit' ? t('Suggestion applied. The old version is in History.') : t('Page created as a draft.'), 'success');
      } else setProblem(result.reason);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    setBusy(true);
    try {
      await rejectProposal(proposal);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="mcp-proposal" data-proposal={proposal.id}>
      <header className="mcp-proposal-from muted small">
        {t('From {client}, {time}', { client: proposal.client, time: when(proposal.createdAt) })}
      </header>
      {proposal.kind === 'edit' ? <EditDetails proposal={proposal} /> : <NewPageDetails proposal={proposal} />}
      {proposal.payload.reason && <p className="mcp-reason small">{t('Why: {reason}', { reason: proposal.payload.reason })}</p>}
      {problem && (
        <p className="mcp-stale small" role="alert">
          {problem} {t('You can reject this suggestion.')}
        </p>
      )}
      <div className="mcp-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          aria-label={proposal.title ? t('Accept: {name}', { name: proposal.title }) : t('Accept: this suggestion')}
          onClick={() => void accept()}
        >
          {t('Accept')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          aria-label={proposal.title ? t('Reject: {name}', { name: proposal.title }) : t('Reject: this suggestion')}
          onClick={() => void reject()}
        >
          {t('Reject')}
        </button>
      </div>
    </article>
  );
}

/** What happened when many were handled at once. */
export interface BulkOutcome {
  done: number;
  /** Ones that could not be applied, such as an edit to text that has since changed. */
  skipped: number;
}

/** Handles each in turn. One that fails is counted and left waiting; the rest go on. */
export async function handleAll(
  proposals: Proposal[],
  handle: (proposal: Proposal) => Promise<boolean>,
): Promise<BulkOutcome> {
  let done = 0;
  let skipped = 0;
  for (const proposal of proposals) {
    try {
      if (await handle(proposal)) done += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { done, skipped };
}

function BulkActions({ proposals }: { proposals: Proposal[] }) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const count = proposals.length;

  const run = async (kind: 'accept' | 'reject') => {
    const accepting = kind === 'accept';
    const yes = await confirm({
      title: accepting ? t('Accept all {count} suggestions?', { count }) : t('Reject all {count} suggestions?', { count }),
      message: accepting
        ? t('Each change is made, and the old version of each page goes into History first.')
        : t('Every waiting suggestion is thrown away. Your pages do not change.'),
      confirmLabel: accepting ? t('Accept all') : t('Reject all'),
      danger: !accepting,
    });
    if (!yes) return;
    setBusy(true);
    try {
      const outcome = await handleAll(proposals, async (proposal) => {
        if (!accepting) {
          await rejectProposal(proposal);
          return true;
        }
        return (await acceptProposal(proposal)).ok;
      });
      const doneText = accepting
        ? t('Accepted {count} suggestions.', { count: outcome.done })
        : t('Rejected {count} suggestions.', { count: outcome.done });
      const skippedText = outcome.skipped > 0 ? ` ${t('{count} could not be applied and are still waiting.', { count: outcome.skipped })}` : '';
      toast(`${doneText}${skippedText}`, outcome.skipped > 0 ? 'info' : 'success');
    } finally {
      setBusy(false);
    }
  };

  if (count < 2) return null;
  return (
    <div className="mcp-actions mcp-bulk">
      <button type="button" className="btn" disabled={busy} onClick={() => void run('accept')}>{t('Accept all')}</button>
      <button type="button" className="btn" disabled={busy} onClick={() => void run('reject')}>{t('Reject all')}</button>
    </div>
  );
}

export function ProposalsView() {
  useLocale();
  const version = useDataVersion('proposals');
  const go = useNav((s) => s.go);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void mcp.proposals().then(
      (list) => {
        if (alive) setProposals(list);
      },
      (e) => {
        if (alive) setError(errorMessage(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [version]);

  return (
    <div className="view-pad mcp-proposals">
      <h1 className="view-title">
        {proposals && proposals.length > 0 ? t('Outside suggestions ({count})', { count: proposals.length }) : t('Outside suggestions')}
      </h1>
      <p className="muted mcp-intro">
        {t('AI tools outside LoreCraft can suggest changes, and nothing changes until you accept one. Accepting saves the old version in History first.')}
      </p>
      {error && <p className="field-error">{error}</p>}
      {proposals && proposals.length === 0 && (
        <p className="muted">
          {withElement(
            t('Nothing is waiting. Outside tools are set up in {settings}.'),
            'settings',
            <button type="button" className="link-button" onClick={() => go({ view: 'settings', tab: 'mcp' })}>
              {t('Settings')}
            </button>,
          )}
        </p>
      )}
      {proposals && <BulkActions proposals={proposals} />}
      {proposals?.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} />)}
    </div>
  );
}
