import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { renderMarkdownSafe } from '../editor/convert';
import { followRenderedLink } from '../editor/renderedLinks';
import { toast } from '../shell/toasts';
import { confirm } from '../shell/dialogs';
import { useDataVersion } from '../state/events';
import { useLocale } from '../state/language';
import { isFocusedPane, useNav, usePaneId, type Route } from '../state/nav';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { compareTexts, type DiffLine } from '../wiki/diff';
import { acceptProposal, rejectProposal, reviewInDocument } from './actions';
import { isTextProposal, mcp, type InsertPayload, type PageRef, type Proposal, type SceneDetails, type TextProposal } from './api';
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

/** Opens a route the way the list is shown: beside it when pinned or split, else in place. */
function useOpenRoute(): (route: Route, keepFocus?: boolean) => void {
  const go = useNav((s) => s.go);
  const split = useNav((s) => s.panes.length > 1);
  const pinned = useSettings((s) => s.settings.mcp.pinned);
  return (route, keepFocus = true) => {
    // Pinned or split, the list stays where it is and the page opens beside it.
    if (pinned || split) useNav.getState().openBeside(route, { keepFocus });
    else go(route);
  };
}

function targetRoute(proposal: { targetKind: 'page' | 'node'; targetId: string }): Route {
  return proposal.targetKind === 'page' ? { view: 'page', id: proposal.targetId } : { view: 'write', nodeId: proposal.targetId };
}

/** Long previews are cut, since the scene itself shows them in full. */
const PREVIEW_LINES = 60;

function LongDiff({ lines }: { lines: DiffLine[] }) {
  useLocale();
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, PREVIEW_LINES);
  return (
    <>
      <DiffView lines={shown} />
      {!all && lines.length > PREVIEW_LINES && (
        <button type="button" className="link-button small" onClick={() => setAll(true)}>
          {t('Show all {count} paragraphs', { count: lines.length })}
        </button>
      )}
    </>
  );
}

function insertPlace(payload: InsertPayload): string {
  if (payload.at === 'start') return t('Adds text at the start.');
  if (payload.at === 'end') return t('Adds text at the end.');
  const quote = (payload.quote ?? '').slice(0, 120);
  return payload.at === 'after' ? t('Adds text after “{quote}”.', { quote }) : t('Adds text before “{quote}”.', { quote });
}

function TextDetails({ proposal }: { proposal: TextProposal }) {
  useLocale();
  const openRoute = useOpenRoute();
  const lines = useMemo(() => {
    if (proposal.kind === 'edit') return compareTexts(proposal.payload.quote, proposal.payload.replacement);
    if (proposal.kind === 'insert') return compareTexts('', proposal.payload.text);
    return compareTexts(proposal.payload.original ?? '', proposal.payload.replacement);
  }, [proposal]);
  const sentence = proposal.targetKind === 'page' ? t('Change to the page {title}') : t('Change to the scene {title}');
  return (
    <>
      <p className="mcp-proposal-title">
        {withElement(
          sentence,
          'title',
          <button type="button" className="link-button" onClick={() => openRoute(targetRoute(proposal))}>
            {proposal.title || t('Untitled')}
          </button>,
        )}
      </p>
      {proposal.kind === 'insert' && <p className="muted small">{insertPlace(proposal.payload)}</p>}
      {proposal.kind === 'rewrite' && (
        <p className="muted small">{proposal.payload.mode === 'whole' ? t('Rewrites the whole text.') : t('Rewrites a passage.')}</p>
      )}
      {lines.length > 0 ? <LongDiff lines={lines} /> : <p className="muted">{t('Removes the quoted text.')}</p>}
    </>
  );
}

function peopleFacts(scene: { pov?: PageRef | null; location?: PageRef | null; cast?: PageRef[] }): string[] {
  return [
    scene.pov ? t('Point of view: {name}', { name: scene.pov.title }) : '',
    scene.location ? t('Location: {name}', { name: scene.location.title }) : '',
    scene.cast?.length ? t('Cast: {names}', { names: scene.cast.map((p) => p.title).join(', ') }) : '',
  ].filter(Boolean);
}

function MarkdownPreview({ text }: { text: string | undefined }) {
  const html = useMemo(() => renderMarkdownSafe(text ?? ''), [text]);
  if (!text?.trim()) return null;
  // renderMarkdownSafe escapes all HTML, since this text came from an outside AI.
  return <div className="mcp-new-page prose" onClick={followRenderedLink} dangerouslySetInnerHTML={{ __html: html }} />;
}

function NewSceneDetails({ proposal }: { proposal: Extract<Proposal, { kind: 'newScene' | 'newChapter' }> }) {
  useLocale();
  const { payload } = proposal;
  const isChapter = proposal.kind === 'newChapter';
  const scene = proposal.kind === 'newChapter' ? proposal.payload.scene : proposal.payload;
  let place: string;
  if (proposal.kind === 'newChapter') {
    place = proposal.payload.afterTitle
      ? t('After the chapter {name}, in {book}.', { name: proposal.payload.afterTitle, book: payload.bookTitle })
      : t('At the end of {book}.', { book: payload.bookTitle });
  } else {
    place = proposal.payload.afterTitle
      ? t('After the scene {name}, in {chapter}.', { name: proposal.payload.afterTitle, chapter: proposal.payload.chapterTitle })
      : t('At the end of the chapter {chapter}.', { chapter: proposal.payload.chapterTitle });
  }
  const facts = [
    place,
    isChapter ? t('First scene: {name}', { name: scene.title }) : '',
    ...peopleFacts(scene),
  ].filter(Boolean);
  return (
    <>
      <p className="mcp-proposal-title">
        {withElement(isChapter ? t('New chapter: {title}') : t('New scene: {title}'), 'title', <strong>{payload.title}</strong>)}
      </p>
      <p className="muted small">{facts.join(' ')}</p>
      {payload.synopsis && <p>{payload.synopsis}</p>}
      {isChapter && scene.synopsis && <p>{scene.synopsis}</p>}
      <MarkdownPreview text={scene.text} />
    </>
  );
}

function detailText(key: keyof SceneDetails, value: SceneDetails[keyof SceneDetails]): string {
  if (value === null || value === undefined || value === '') return t('(none)');
  if (key === 'cast') return (value as PageRef[]).map((p) => p.title).join(', ') || t('(none)');
  if (key === 'pov' || key === 'location') return (value as PageRef).title;
  return String(value);
}

function SceneDetailsCard({ proposal }: { proposal: Extract<Proposal, { kind: 'sceneDetails' }> }) {
  useLocale();
  const openRoute = useOpenRoute();
  const { changes, before } = proposal.payload;
  const labels: Record<keyof SceneDetails, string> = {
    title: t('Title'),
    synopsis: t('Synopsis'),
    pov: t('Point of view'),
    location: t('Location'),
    cast: t('Cast'),
    status: t('Status'),
    storyDate: t('Story date'),
    notes: t('Notes'),
  };
  const keys = (Object.keys(labels) as (keyof SceneDetails)[]).filter((key) => changes[key] !== undefined);
  return (
    <>
      <p className="mcp-proposal-title">
        {withElement(
          t('Details of the scene {title}'),
          'title',
          <button type="button" className="link-button" onClick={() => openRoute({ view: 'write', nodeId: proposal.targetId })}>
            {proposal.title || t('Untitled')}
          </button>,
        )}
      </p>
      <dl className="mcp-infobox mcp-details">
        {keys.map((key) => (
          <div key={key}>
            <dt>{labels[key]}</dt>
            <dd>
              <DiffView lines={compareTexts(detailText(key, before[key]), detailText(key, changes[key]))} />
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function ProposalDetails({ proposal }: { proposal: Proposal }) {
  if (isTextProposal(proposal)) return <TextDetails proposal={proposal} />;
  if (proposal.kind === 'newScene' || proposal.kind === 'newChapter') return <NewSceneDetails proposal={proposal} />;
  if (proposal.kind === 'sceneDetails') return <SceneDetailsCard proposal={proposal} />;
  return <NewPageDetails proposal={proposal} />;
}

function acceptedMessage(proposal: Proposal): string {
  switch (proposal.kind) {
    case 'newPage':
      return t('Page created as a draft.');
    case 'newScene':
      return t('Scene added.');
    case 'newChapter':
      return t('Chapter added.');
    case 'sceneDetails':
      return t('Scene details changed.');
    default:
      return t('Suggestion applied. The old version is in History.');
  }
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

function ProposalCard({ proposal, onHandled }: { proposal: Proposal; onHandled: (id: string) => void }) {
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
    if (!isTextProposal(proposal)) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await reviewInDocument(proposal, (route) => openRoute(route, false));
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
        {isTextProposal(proposal) && (
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
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      {proposals?.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} onHandled={onHandled} />)}
    </div>
  );
}
