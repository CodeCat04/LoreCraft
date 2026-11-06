/** What the checks produce and what the native side stores. */

import { t } from '../lib/i18n';

export type FindingSource = 'rule' | 'ai';
export type FindingSeverity = 'info' | 'warning' | 'error';
export type FindingStatus = 'open' | 'fixed' | 'intentional' | 'ignored';

/** One side of a finding: where it is, and the words that show it. */
export interface Evidence {
  sourceKind: 'page' | 'node';
  sourceId: string;
  title: string;
  quote: string;
  /** The page's status when this was found, for pages. */
  status?: string;
}

/** A finding as a check reports it, before it is stored. */
export interface FindingDraft {
  source: FindingSource;
  rule: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  evidence: Evidence[];
  /** Stable across runs, so a rerun finds the same row and keeps the writer's decision. */
  fingerprint: string;
}

export interface Finding extends FindingDraft {
  id: string;
  status: FindingStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface UpsertSummary {
  added: number;
  updated: number;
  reopened: number;
  closed: number;
  unchanged: number;
  decisionsKept: number;
}

/** How each rule is named where findings are grouped, read each time so it follows the language. */
const RULE_LABELS: Record<string, () => string> = {
  'date-order': () => t('Dates in the wrong order'),
  'after-death': () => t('Characters after their death'),
  'before-birth': () => t('Characters before their birth'),
  'age-vs-born': () => t('Ages that do not fit the birth date'),
  'parent-order': () => t('Children born before a parent'),
  'born-after-parent-died': () => t('Children born after a parent died'),
  'contradicts-lore': () => t('Text that contradicts canon'),
  'contradicts-draft': () => t('Text that differs from a draft page'),
  'scene-vs-scene': () => t('Scenes that disagree'),
  'page-vs-canon': () => t('Wiki pages that contradict canon'),
  'similar-names': () => t('Names that look alike'),
  'shared-alias': () => t('Names used by two pages'),
  'missing-reference': () => t('Scenes pointing at missing pages'),
  'retconned-link': () => t('Canon pages relying on retconned ones'),
  'broken-field-link': () => t('Infobox fields pointing nowhere'),
  'broken-link': () => t('Links to pages that do not exist'),
};

export function ruleLabel(rule: string): string {
  return RULE_LABELS[rule]?.() ?? rule;
}

export function severityLabel(severity: FindingSeverity): string {
  switch (severity) {
    case 'error':
      return t('Errors');
    case 'warning':
      return t('Warnings');
    case 'info':
      return t('Notes');
  }
}

export function statusLabel(status: FindingStatus): string {
  switch (status) {
    case 'open':
      return t('Open');
    case 'fixed':
      return t('Fixed');
    case 'intentional':
      return t('Intentional');
    case 'ignored':
      return t('Ignored');
  }
}
