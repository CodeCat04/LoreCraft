import { useEffect, useRef, useState, type ReactNode } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { confirm } from '../shell/dialogs';
import { useDataVersion } from '../state/events';
import { useLocale } from '../state/language';
import { isFocusedPane, useNav, usePaneId } from '../state/nav';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { acceptProposal, canUndo, rejectProposal, reviewInDocument, undoProposal } from './actions';
import { mcp, type AnyProposal, type TextProposal } from './api';
import { kindFor } from './kinds';
import { useOpenRoute } from './kinds/shared';
import { listInSight, nextReady, showListIn, useListFocus } from './pin';

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

/** The pinned list: brought to the front where it is open, or opened in the pane beside. */
export function showPinnedList() {
  const nav = useNav.getState();
  const where = showListIn(nav);
  if (where.kind === 'activate') {
    nav.activateTab(where.tabId);
    nav.focusPane(where.paneId);
  } else {
    nav.openBeside({ view: 'proposals' });
  }
  useListFocus.getState().ask();
}

export function setProposalsPinned(pinned: boolean) {
  return useSettings.getState().update({ mcp: { pinned } });
}

function countLabel(count: number): string {
  if (count === 0) return t('No outside suggestions waiting');
  return count === 1 ? t('1 outside suggestion') : t('{count} outside suggestions', { count });
}

/**
 * Sits in the top bar while something is waiting. Pinned, it stays there with the count,
 * even at none, and opens the list beside the writing.
 */
export function ProposalsBadge() {
  useLocale();
  const count = useProposalCount();
  const open = useProject((s) => s.status.open);
  const pinned = useSettings((s) => s.settings.mcp.pinned);
  const go = useNav((s) => s.go);
  const [seen, setSeen] = useState(0);
  // Pinned, the count in sight says enough, so a new one is only read out, not shown again.
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    if (count > seen) {
      if (pinned) setAnnounced(countLabel(count));
      else if (!listInSight(useNav.getState())) toast(t('An outside AI tool left a suggestion for you to review.'));
    }
    setSeen(count);
  }, [count, seen, pinned]);
  const label = countLabel(count);
  if (pinned && open) {
    return (
      <>
        <span className="mcp-live" role="status">
          {announced}
        </span>
        <button
          type="button"
          className={`btn mcp-badge is-pinned${count === 0 ? ' is-empty' : ''}`}
          title={t('Review suggestions from AI tools outside LoreCraft')}
          aria-label={label}
          data-testid="mcp-pinned-badge"
          onClick={showPinnedList}
        >
          <span aria-hidden="true">{t('Suggestions')}</span>
          <span className="mcp-badge-count" aria-hidden="true">
            {count}
          </span>
        </button>
      </>
    );
  }
  if (count === 0) return null;
  return (
    <button type="button" className="btn mcp-badge" title={t('Review suggestions from AI tools outside LoreCraft')} onClick={() => go({ view: 'proposals' })}>
      {label}
    </button>
  );
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The card body its kind declares, or a plain line for a kind this version does not know. */
function ProposalDetails({ proposal }: { proposal: AnyProposal }) {
  const kind = kindFor(proposal.kind);
  if (!kind) return <p className="mcp-proposal-title">{proposal.title || t('Untitled')}</p>;
  const Card = kind.Card;
  return <Card proposal={proposal} />;
}

function acceptedMessage(proposal: AnyProposal): string {
  return kindFor(proposal.kind)?.accepted() ?? t('Suggestion applied. The old version is in History.');
}


function ProposalCard({ proposal, onHandled }: { proposal: AnyProposal; onHandled: (id: string) => void }) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const openRoute = useOpenRoute();

  const accept = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await acceptProposal(proposal);
      if (result.ok) {
        onHandled(proposal.id);
        toast(acceptedMessage(proposal), 'success');
      } else setProblem(result.reason);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const review = async () => {
    if (!kindFor(proposal.kind)?.reviewable) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await reviewInDocument(proposal as unknown as TextProposal, (route) => openRoute(route, false));
      if (!result.ok) setProblem(result.reason);
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
      onHandled(proposal.id);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className="mcp-proposal"
      data-proposal={proposal.id}
      tabIndex={-1}
      aria-label={proposal.title ? t('Suggestion: {name}', { name: proposal.title }) : t('Suggestion')}
    >
      <header className="mcp-proposal-from muted small">
        {t('From {client}, {time}', { client: proposal.client, time: when(proposal.createdAt) })}
      </header>
<ProposalDetails proposal={proposal} />
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
        {kindFor(proposal.kind)?.reviewable && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            title={t('Open it with each change marked, to accept or reject them one by one.')}
            aria-label={
              proposal.title
                ? t('Review in the document: {name}', { name: proposal.title })
                : t('Review in the document: this suggestion')
            }
            onClick={() => void review()}
          >
            {proposal.targetKind === 'page' ? t('Review in the page') : t('Review in the scene')}
          </button>
        )}
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

/** One change an outside AI made directly, with Undo. */
function AppliedCard({ proposal }: { proposal: AnyProposal }) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = proposal.title || t('this change');
  const undo = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await undoProposal(proposal);
      if (result.ok) toast(t('Undone.'), 'success');
      else setProblem(result.reason);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="mcp-proposal is-applied" data-applied={proposal.id} aria-label={t('Applied: {name}', { name })}>
      <header className="mcp-proposal-from muted small">
        {t('Made by {client}, {time}', { client: proposal.client, time: when(proposal.createdAt) })}
      </header>
      <ProposalDetails proposal={proposal} />
      {problem && (
        <p className="mcp-stale small" role="alert">
          {problem}
        </p>
      )}
      {canUndo(proposal) && (
        <div className="mcp-actions">
          <button type="button" className="btn" disabled={busy} aria-label={t('Undo: {name}', { name })} onClick={() => void undo()}>
            {t('Undo')}
          </button>
        </div>
      )}
    </article>
  );
}

/** Changes made directly at the edit level, newest first. They never count on the badge. */
function AppliedList() {
  useLocale();
  const version = useDataVersion('proposals');
  const [applied, setApplied] = useState<AnyProposal[]>([]);
  useEffect(() => {
    let alive = true;
    void mcp.proposals('applied').then(
      (list) => {
        if (alive) setApplied(list);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [version]);
  if (applied.length === 0) return null;
  return (
    <section className="mcp-applied" aria-labelledby="mcp-applied-heading">
      <h2 id="mcp-applied-heading" className="mcp-applied-title">
        {t('Applied by outside AI ({count})', { count: applied.length })}
      </h2>
      <p className="muted small">{t('An outside AI made these changes directly, as you allowed in Settings. Undo takes one back if nothing has changed it since.')}</p>
      {applied.map((proposal) => (
        <AppliedCard key={proposal.id} proposal={proposal} />
      ))}
    </section>
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
  proposals: AnyProposal[],
  handle: (proposal: AnyProposal) => Promise<boolean>,
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

function BulkActions({ proposals }: { proposals: AnyProposal[] }) {
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

/** The pin, which keeps the count in the top bar and opens the list beside the writing. */
function PinButton() {
  useLocale();
  const pinned = useSettings((s) => s.settings.mcp.pinned);
  return (
    <button
      type="button"
      className={`btn btn-sm mcp-pin${pinned ? ' btn-primary' : ''}`}
      aria-pressed={pinned}
      title={
        pinned
          ? t('The count stays in the top bar. Click it to open this list beside your writing.')
          : t('Keep the count in the top bar, and open this list beside your writing.')
      }
      onClick={() => void setProposalsPinned(!pinned)}
    >
      {t('Pin to top bar')}
    </button>
  );
}

function cardIn(root: HTMLElement | null, id: string): HTMLElement | null {
  if (!root) return null;
  return [...root.querySelectorAll<HTMLElement>('[data-proposal]')].find((el) => el.dataset.proposal === id) ?? null;
}

export function ProposalsView() {
  useLocale();
  const version = useDataVersion('proposals');
  const go = useNav((s) => s.go);
  const paneId = usePaneId();
  const focusPending = useListFocus((s) => s.pending);
  const [proposals, setProposals] = useState<AnyProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mcpVersion = useDataVersion('mcp', 'all');
  const [permission, setPermission] = useState<string | null>(null);
  useEffect(() => {
    void mcp.status().then((status) => setPermission(status.permission), () => setPermission(null));
  }, [mcpVersion]);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The ids shown now and just before, so the next suggestion can be found once one goes.
  const shown = useRef<string[]>([]);
  const previous = useRef<string[]>([]);
  const handled = useRef<{ id: string; before: string[] } | null>(null);

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

  /** Puts the keyboard on a suggestion, or on the heading when none is left. */
  const ready = (id: string | null, always = false) => {
    if (!isFocusedPane(paneId)) return;
    // The writer may have gone on to something else while the list caught up.
    const active = document.activeElement;
    const elsewhere = active && active !== document.body && !rootRef.current?.contains(active);
    if (elsewhere && !always) return;
    const card = id ? cardIn(rootRef.current, id) : null;
    const target = card ?? headingRef.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  };

  useEffect(() => {
    if (!proposals) return;
    previous.current = shown.current;
    shown.current = proposals.map((p) => p.id);
    const done = handled.current;
    if (done && !shown.current.includes(done.id)) {
      handled.current = null;
      ready(nextReady(done.before, done.id, shown.current));
    }
    // `ready` reads only refs and the pane, which do not change while this is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposals]);

  useEffect(() => {
    if (!focusPending || !proposals || !isFocusedPane(paneId)) return;
    useListFocus.getState().done();
    ready(proposals[0]?.id ?? null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPending, proposals, paneId]);

  /** Accepting or rejecting one keeps the writer here, with the next one ready. */
  const onHandled = (id: string) => {
    if (shown.current.includes(id)) handled.current = { id, before: shown.current };
    else ready(nextReady(previous.current, id, shown.current));
  };

  return (
    <div className="view-pad mcp-proposals" ref={rootRef}>
      <div className="mcp-proposals-head">
        <h1 className="view-title" tabIndex={-1} ref={headingRef}>
          {proposals && proposals.length > 0 ? t('Outside suggestions ({count})', { count: proposals.length }) : t('Outside suggestions')}
        </h1>
        <PinButton />
      </div>
      <p className="muted mcp-intro">
        {permission === 'edit'
          ? t('AI tools outside LoreCraft may make changes directly. Each change is listed under Applied by outside AI, where you can undo it. You can change this in Settings.')
          : t('AI tools outside LoreCraft can suggest changes, and nothing changes until you accept one. Accepting saves the old version in History first.')}
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
      {proposals?.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} onHandled={onHandled} />)}
      <AppliedList />
    </div>
  );
}
