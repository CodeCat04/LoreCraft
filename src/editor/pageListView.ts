/**
 * How a `pageList` block looks in an editor: the pages that match its query right now, as
 * links. The list is read fresh, so it is never stored in the document. Choosing a query
 * belongs to the wiki, which registers its dialog here.
 */

import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';

import { hasFieldFilter, pageListQuery, type PageListQuery } from './convert';
import { t } from '../lib/i18n';
import { rpc } from '../lib/rpc';
import type { PageMeta } from '../lib/types';
import { subscribeDataChanges } from '../state/events';
import { useNav } from '../state/nav';
import { useTitles } from '../state/project';

type AskForQuery = (current: PageListQuery | null) => Promise<PageListQuery | null>;

let askForQuery: AskForQuery | null = null;

export function registerPageListDialog(ask: AskForQuery) {
  askForQuery = ask;
}

/** Asks what the list should show, then adds it at the cursor. */
export async function insertPageList(editor: Editor) {
  const query = await askForQuery?.(null);
  const chain = editor.chain().focus();
  if (query) chain.insertContent({ type: 'pageList', attrs: { ...query } });
  chain.run();
}

/** A list's query in words for its caption, as one whole sentence in each language. */
function pageListCaption(query: PageListQuery): string {
  const base = pageListBase(query);
  if (!hasFieldFilter(query)) return base;
  return t('{list}, where {field} is {value}', { list: base, field: query.field!.trim(), value: query.fieldValue!.trim() });
}

function pageListBase(query: PageListQuery): string {
  const type = query.pageType.replace(/_/g, ' ');
  const { category, status } = query;
  if (type && category && status) return t('All pages of type {type} in the category {category} with the status {status}', { type, category, status });
  if (type && category) return t('All pages of type {type} in the category {category}', { type, category });
  if (type && status) return t('All pages of type {type} with the status {status}', { type, status });
  if (category && status) return t('All pages in the category {category} with the status {status}', { category, status });
  if (type) return t('All pages of type {type}', { type });
  if (category) return t('All pages in the category {category}', { category });
  if (status) return t('All pages with the status {status}', { status });
  return t('All pages');
}

const LIST_LIMIT = 500;
const RELOAD_DELAY_MS = 600;

function follow(title: string) {
  const entry = useTitles.getState().resolve(title);
  useNav.getState().go(entry ? { view: 'page', id: entry.id } : { view: 'missing', title });
}

class PageListView implements NodeView {
  readonly dom: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly items: HTMLElement;
  private readonly change: HTMLButtonElement;
  private query: PageListQuery;
  private timer: number | undefined;
  private latest = 0;
  private readonly unsubscribe: () => void;

  constructor(
    node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.query = pageListQuery({ type: 'pageList', attrs: node.attrs });
    this.dom = document.createElement('div');
    this.dom.className = 'page-list';
    this.dom.dataset.pageList = '';
    const head = document.createElement('div');
    head.className = 'page-list-head';
    this.caption = document.createElement('span');
    this.caption.className = 'page-list-caption';
    this.change = document.createElement('button');
    this.change.type = 'button';
    this.change.className = 'link-button page-list-change';
    this.change.textContent = t('Change list');
    this.change.addEventListener('click', () => void this.edit());
    head.append(this.caption, this.change);
    this.items = document.createElement('ul');
    this.items.className = 'page-list-items';
    this.dom.append(head, this.items);
    this.dom.addEventListener('click', this.onClick);
    this.unsubscribe = subscribeDataChanges(this.reloadSoon);
    void this.load();
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== 'pageList') return false;
    const next = pageListQuery({ type: 'pageList', attrs: node.attrs });
    if (JSON.stringify(next) !== JSON.stringify(this.query)) {
      this.query = next;
      void this.load();
    }
    return true;
  }

  // The list is rendered here, not by ProseMirror, and its controls are its own.
  ignoreMutation() {
    return true;
  }

  stopEvent(event: Event) {
    const target = event.target as HTMLElement;
    return target.closest('a, button') !== null;
  }

  destroy() {
    window.clearTimeout(this.timer);
    this.unsubscribe();
    this.dom.removeEventListener('click', this.onClick);
  }

  private readonly onClick = (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest('a');
    if (!link) return;
    event.preventDefault();
    // While editing, a plain click selects the block, as elsewhere in the editor.
    const title = link.getAttribute('data-wiki-target');
    if (title && (!this.view.editable || event.ctrlKey || event.metaKey)) follow(title);
  };

  private readonly reloadSoon = () => {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.load(), RELOAD_DELAY_MS);
  };

  private async edit() {
    const next = await askForQuery?.(this.query);
    const pos = this.getPos();
    if (!next || pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...next }));
  }

  private async load() {
    this.latest += 1;
    const thisLoad = this.latest;
    const { pageType, category, status, sort } = this.query;
    const byField = hasFieldFilter(this.query);
    let pages: PageMeta[];
    try {
      pages = await rpc<PageMeta[]>('pages.list', {
        pageType: pageType || undefined,
        category: category || undefined,
        status: status || undefined,
        field: byField ? this.query.field : undefined,
        fieldValue: byField ? this.query.fieldValue : undefined,
        sort: sort || 'title',
        excludeHome: true,
        limit: LIST_LIMIT,
      });
    } catch {
      return;
    }
    if (thisLoad !== this.latest) return;
    this.caption.textContent = `${pageListCaption(this.query)} (${pages.length.toLocaleString()})`;
    this.change.textContent = t('Change list');
    if (pages.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'page-list-empty';
      empty.textContent = t('No pages match yet.');
      this.items.replaceChildren(empty);
      return;
    }
    this.items.replaceChildren(
      ...pages.map((page) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'wiki-link wiki-link-ok';
        link.dataset.wikiTarget = page.title;
        link.textContent = page.title;
        item.append(link);
        return item;
      }),
    );
  }
}

/** Gives `pageList` blocks their live view. Part of every `RichEditor`. */
export const pageListViews = Extension.create({
  name: 'pageListViews',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('pageListViews'),
        props: {
          nodeViews: {
            pageList: (node, view, getPos) => new PageListView(node, view, getPos),
          },
        },
      }),
    ];
  },
});
