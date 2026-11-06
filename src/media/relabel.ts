/**
 * Changing a picture's label from the library. A figure that shares the old label, or has
 * none, follows the change. A figure with words of its own keeps them: its label was
 * written for where it stands. So does a label holding links, which plain text would lose.
 */

import type { PmNode } from '../lib/types';

export interface LabelChange {
  oldLabel: string;
  newLabel: string;
  oldDescription: string;
  newDescription: string;
}

export interface RelabelResult {
  doc: PmNode;
  /** Figures that changed. */
  changed: number;
  /** Figures of this asset left as they were, because they say something else. */
  kept: number;
}

function textOf(node: PmNode | undefined): string {
  return (node?.content ?? []).map((child) => child.text ?? '').join('');
}

function isPlainText(node: PmNode | undefined): boolean {
  return (node?.content ?? []).every((child) => child.type === 'text' && !child.marks?.length);
}

export function relabelFigures(doc: PmNode, assetId: string, change: LabelChange): RelabelResult {
  let changed = 0;
  let kept = 0;

  const figure = (node: PmNode): PmNode => {
    const children = node.content ?? [];
    const caption = children.find((child) => child.type === 'figcaption');
    const label = textOf(caption);
    const followsLabel = label === '' || (label === change.oldLabel && isPlainText(caption));
    const description = String(node.attrs?.description ?? '');
    const followsDescription = description === '' || description === change.oldDescription;

    const newLabel = followsLabel ? change.newLabel : label;
    const newDescription = followsDescription ? change.newDescription : description;
    if (!followsLabel || !followsDescription) kept += 1;
    if (newLabel === label && newDescription === description) return node;
    changed += 1;
    return {
      ...node,
      attrs: { ...node.attrs, description: newDescription },
      content: children.map((child) => {
        if (child.type !== 'figcaption' || newLabel === label) return child;
        const { content: _content, ...rest } = child;
        return newLabel ? { ...rest, content: [{ type: 'text', text: newLabel }] } : rest;
      }),
    };
  };

  const walk = (node: PmNode): PmNode => {
    if (node.type === 'figure' && node.content?.some((child) => child.attrs?.assetId === assetId)) return figure(node);
    if (!node.content) return node;
    let same = true;
    const content = node.content.map((child) => {
      const next = walk(child);
      if (next !== child) same = false;
      return next;
    });
    return same ? node : { ...node, content };
  };

  return { doc: walk(doc), changed, kept };
}
