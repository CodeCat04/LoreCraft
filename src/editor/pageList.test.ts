import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';

import {
  describePageList,
  expandPageLists,
  pageListResults,
  pmToHtml,
  pmToMarkdown,
  pmToPlainText,
  type ListablePage,
} from './convert';
import { documentExtensions } from './schema';
import type { PmNode } from '../lib/types';

const pages: ListablePage[] = [
  { title: 'Morn', pageType: 'character', status: 'canon', categories: ['Nobility'], wordCount: 5, updatedAt: '2026-01-01' },
  { title: 'Aria', pageType: 'character', status: 'draft', categories: ['Nobility', 'Rangers'], wordCount: 9, updatedAt: '2026-01-03' },
  { title: 'Bram', pageType: 'character', status: 'canon', categories: [], wordCount: 1, updatedAt: '2026-01-02' },
  { title: 'Keep', pageType: 'place', status: 'canon', categories: ['Nobility'] },
  { title: 'Main Page', pageType: 'home', status: 'canon', categories: [], isHome: true },
];

const list = (attrs: Record<string, string>): PmNode => ({ type: 'pageList', attrs });

describe('page lists', () => {
  it('finds pages by type, category and status, and never the main page', () => {
    const q = { pageType: '', category: '', status: '', sort: 'title' };
    expect(pageListResults(q, pages)).toEqual(['Aria', 'Bram', 'Keep', 'Morn']);
    expect(pageListResults({ ...q, pageType: 'character', category: 'Nobility' }, pages)).toEqual(['Aria', 'Morn']);
    expect(pageListResults({ ...q, status: 'draft' }, pages)).toEqual(['Aria']);
    expect(pageListResults({ ...q, pageType: 'nothing' }, pages)).toEqual([]);
  });

  it('filters by an infobox field by key or label, ignoring case, at the start of the story', () => {
    const withHome: ListablePage[] = [
      ...pages,
      { title: 'Ash', pageType: 'character', status: 'canon', categories: [], infobox: { fields: [{ key: 'home', label: 'Home', value: 'Cray Landing' }] } },
      { title: 'Cy', pageType: 'character', status: 'canon', categories: [], infobox: { fields: [{ key: 'residence', label: 'Home', value: 'Mor, Cray Landing' }] } },
      { title: 'Dee', pageType: 'character', status: 'canon', categories: [], infobox: { fields: [{ key: 'home', label: 'Home', value: 'Elsewhere' }] } },
    ];
    const q = { pageType: '', category: '', status: '', sort: 'title' };
    expect(pageListResults({ ...q, field: 'HOME', fieldValue: 'cray landing' }, withHome)).toEqual(['Ash', 'Cy']);
    expect(pageListResults({ ...q, field: 'residence', fieldValue: 'Mor' }, withHome)).toEqual(['Cy']);
    // A field without a value does not filter.
    expect(pageListResults({ ...q, field: 'home', fieldValue: '' }, withHome)).toHaveLength(7);
    expect(describePageList({ ...q, field: 'Home', fieldValue: 'Cray Landing' })).toBe('All pages, where Home is Cray Landing');
  });

  it('reads old lists that have no field filter', () => {
    const doc: PmNode = { type: 'doc', content: [list({ pageType: 'place', category: '', status: '', sort: 'title' })] };
    expect(pmToMarkdown(expandPageLists(doc, pages))).toBe('- [[Keep]]');
  });

  it('sorts as asked', () => {
    const q = { pageType: 'character', category: '', status: '', sort: 'words' };
    expect(pageListResults(q, pages)).toEqual(['Aria', 'Morn', 'Bram']);
    expect(pageListResults({ ...q, sort: 'updated' }, pages)).toEqual(['Aria', 'Bram', 'Morn']);
  });

  it('says what it is in words', () => {
    expect(describePageList({ pageType: '', category: '', status: '', sort: '' })).toBe('All pages');
    expect(describePageList({ pageType: 'war_machine', category: 'Nobility', status: 'canon', sort: '' })).toBe(
      'All pages of type war machine in the category Nobility with the status canon',
    );
  });

  it('expands into an ordinary list of links, at any depth', () => {
    const doc: PmNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
        { type: 'blockquote', content: [list({ pageType: 'place' })] },
        list({ pageType: 'character', category: 'Nobility' }),
        list({ pageType: 'nothing' }),
      ],
    };
    const expanded = expandPageLists(doc, pages);
    expect(pmToMarkdown(expanded)).toBe(
      'Before\n\n> - [[Keep]]\n\n- [[Aria]]\n- [[Morn]]\n\nNo pages match yet.',
    );
    expect(pmToPlainText(expanded)).toContain('Aria');
    expect(pmToHtml(expanded)).toContain('<ul>');
    // The expanded document is one any editor can open.
    expect(() => getSchema(documentExtensions()).nodeFromJSON(expanded).check()).not.toThrow();
  });

  it('leaves a document with no lists alone', () => {
    const doc: PmNode = { type: 'doc', content: [{ type: 'paragraph' }] };
    expect(expandPageLists(doc, pages)).toBe(doc);
  });

  it('reads sensibly when not expanded', () => {
    const doc: PmNode = { type: 'doc', content: [list({ pageType: 'character', category: 'Nobility' })] };
    const line = '[List: All pages of type character in the category Nobility]';
    expect(pmToPlainText(doc)).toBe(line);
    expect(pmToHtml(doc)).toContain('All pages of type character');
    expect(pmToMarkdown(doc)).toContain('All pages of type character');
  });

  it('is a valid part of the document schema', () => {
    const schema = getSchema(documentExtensions());
    const node = schema.nodeFromJSON({ type: 'doc', content: [list({ pageType: 'character', category: 'Nobility', status: '', sort: 'title' })] });
    expect(() => node.check()).not.toThrow();
    expect(node.toJSON().content[0].attrs.category).toBe('Nobility');
  });
});
