/** The whole book as a table, with status and synopsis editable in place. */

import { memo, useMemo } from 'react';

import { InlineText, statuses } from './shared';
import { openNode, showPatch, useWrite, writeNode } from './store';
import { childrenOf, displayTitle, type TreeIndex } from './tree';
import { t } from '../lib/i18n';
import { formatNumber } from '../lib/text';
import { errorMessage } from '../lib/rpc';
import type { NodeMeta, NodeStatus } from '../lib/types';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { useTitles } from '../state/project';
import { ApplyStructureButton } from '../plan/PlanButtons';

function save(id: string, patch: { status?: NodeStatus; synopsis?: string }) {
  showPatch(id, patch);
  void writeNode(id, patch).catch((e) => toast(t('Could not save that change: {reason}', { reason: errorMessage(e) }), 'error'));
}

interface RowProps {
  id: string;
  kind: NodeMeta['kind'];
  title: string;
  depth: number;
  status: NodeStatus;
  pov: string;
  date: string;
  words: number;
  target: number;
  synopsis: string;
}

const OutlineRow = memo(function OutlineRow(props: RowProps) {
  useLocale();
  const { id, kind, title, depth, status, pov, date, words, target, synopsis } = props;
  const shown = displayTitle({ title, kind });
  const isScene = kind === 'scene';
  return (
    <tr className={`outline-row outline-${kind}`} data-outline-id={id}>
      <td className="outline-title" style={{ paddingLeft: `${0.625 + depth * 1}rem` }}>
        <button type="button" className="link-button" onClick={() => openNode(id)}>
          {shown}
        </button>
      </td>
      <td>
        {isScene && (
          <select
            className="select outline-status"
            aria-label={t('Status of {title}', { title: shown })}
            value={status}
            onChange={(e) => save(id, { status: e.target.value as NodeStatus })}
          >
            {statuses().map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        )}
      </td>
      <td>
        <InlineText
          value={synopsis}
          label={t('Synopsis of {title}', { title: shown })}
          placeholder={isScene ? t('Add a synopsis') : ''}
          onCommit={(value) => save(id, { synopsis: value })}
        />
      </td>
      <td className="outline-text">{isScene ? pov : ''}</td>
      <td className="outline-text">{isScene ? date : ''}</td>
      <td className="is-number">{formatNumber(words)}</td>
      <td className="is-number">{target > 0 ? formatNumber(target) : ''}</td>
    </tr>
  );
});

interface Line {
  node: NodeMeta;
  depth: number;
}

function linesOf(index: TreeIndex): Line[] {
  const out: Line[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const node of childrenOf(index, parent)) {
      out.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** A chapter or part's target is the sum of its scenes' targets, unless set itself. */
function targetOf(index: TreeIndex, node: NodeMeta): number {
  if (node.kind === 'scene' || node.targetWords > 0) return node.targetWords;
  return childrenOf(index, node.id).reduce((sum, child) => sum + targetOf(index, child), 0);
}

export function Outline() {
  useLocale();
  const index = useWrite((s) => s.index);
  const book = useWrite((s) => s.books.find((b) => b.id === s.bookId));
  const titles = useTitles((s) => s.byId);
  const lines = useMemo(() => linesOf(index), [index]);

  return (
    <div className="write-scroll">
      <div className="outline">
        <div className="plan-heading-row">
          <h1 className="outline-heading">{book?.title ?? t('Outline')}</h1>
          <ApplyStructureButton />
        </div>
        {lines.length === 0 ? (
          <p className="muted">{t('This book is empty.')}</p>
        ) : (
          <table className="data-table outline-table">
            <thead>
              <tr>
                <th scope="col">{t('Title')}</th>
                <th scope="col">{t('Status')}</th>
                <th scope="col">{t('Synopsis')}</th>
                <th scope="col">{t('Point of view')}</th>
                <th scope="col">{t('Date')}</th>
                <th scope="col" className="is-number">{t('Words')}</th>
                <th scope="col" className="is-number">{t('Target')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ node, depth }) => (
                <OutlineRow
                  key={node.id}
                  id={node.id}
                  kind={node.kind}
                  title={node.title}
                  depth={depth}
                  status={node.status}
                  pov={node.povPageId ? (titles.get(node.povPageId)?.title ?? '') : ''}
                  date={node.storyDate}
                  words={index.totals.get(node.id) ?? 0}
                  target={targetOf(index, node)}
                  synopsis={node.synopsis}
                />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={5}>{t('Book total')}</th>
                <td className="is-number">{formatNumber(index.words)}</td>
                <td className="is-number">{book && book.targetWords > 0 ? formatNumber(book.targetWords) : ''}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
