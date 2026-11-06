/**
 * Typing `[[` opens a list of pages at the cursor. Choosing one inserts a `wikiLink`.
 * The list is plain DOM owned by a ProseMirror plugin, so it works in every editor and
 * never re-renders the document around the cursor.
 */

import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { findLinkQuery, INLINE_LEAF, isKnownName, rankTitles } from './linkSuggest';
import { useTitles } from '../state/project';
import { t } from '../lib/i18n';

interface ActiveLink {
  from: number;
  to: number;
  query: string;
  label: string | null;
}

interface LinkOption {
  /** The page the link points at. */
  target: string;
  /** What the link shows, unless the writer gave it a label. */
  text: string;
  primary: string;
  secondary: string;
  create: boolean;
}

const MAX_OPTIONS = 7;

function activeLink(state: EditorState): ActiveLink | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const block = $from.parent;
  if (!block.isTextblock || block.type.spec.code) return null;
  if ($from.marks().some((mark) => mark.type.name === 'code')) return null;
  const before = block.textBetween(0, $from.parentOffset, undefined, INLINE_LEAF);
  if (!before.includes('[[')) return null;
  const after = block.textBetween($from.parentOffset, block.content.size, undefined, INLINE_LEAF);
  const found = findLinkQuery(before, after);
  if (!found) return null;
  return {
    from: $from.start() + found.start,
    to: $from.pos + found.trailing,
    query: found.query,
    label: found.label,
  };
}

function optionsFor(query: string): LinkOption[] {
  const { entries } = useTitles.getState();
  const options: LinkOption[] = rankTitles(query, entries, MAX_OPTIONS).map(({ entry, alias }) => ({
    target: entry.title,
    text: alias ?? entry.title,
    primary: entry.title,
    secondary: alias ? t('also {name}', { name: alias }) : entry.pageType === 'article' ? '' : entry.pageType,
    create: false,
  }));
  if (query && !isKnownName(query, entries)) {
    options.push({
      target: query,
      text: query,
      primary: t('Create “{title}”', { title: query }),
      secondary: t('new page'),
      create: true,
    });
  }
  return options;
}

let popupCount = 0;

class LinkPopup {
  private readonly dom: HTMLDivElement;
  private active: ActiveLink | null = null;
  private options: LinkOption[] = [];
  private selected = 0;
  private shownQuery: string | null = null;
  /** The link the writer pressed Escape on. It stays closed until they leave it. */
  private dismissedFrom: number | null = null;

  constructor(private view: EditorView) {
    popupCount += 1;
    this.dom = document.createElement('div');
    this.dom.className = 'link-suggest';
    this.dom.id = `link-suggest-${popupCount}`;
    this.dom.setAttribute('role', 'listbox');
    this.dom.setAttribute('aria-label', t('Link to a page'));
    this.dom.hidden = true;
    // Keeps focus and the selection in the editor.
    this.dom.addEventListener('mousedown', this.onMouseDown);
    document.body.appendChild(this.dom);
    window.addEventListener('scroll', this.place, true);
    window.addEventListener('resize', this.place);
  }

  update(view: EditorView) {
    this.view = view;
    this.sync();
  }

  destroy() {
    window.removeEventListener('scroll', this.place, true);
    window.removeEventListener('resize', this.place);
    this.dom.remove();
  }

  sync() {
    const { view } = this;
    const active = view.editable && view.hasFocus() ? activeLink(view.state) : null;
    if (!active || active.from !== this.dismissedFrom) this.dismissedFrom = null;
    if (!active || this.dismissedFrom !== null) {
      this.hide();
      return;
    }
    const opening = !this.active;
    this.active = active;
    if (opening || active.query !== this.shownQuery) {
      this.shownQuery = active.query;
      this.options = optionsFor(active.query);
      this.selected = 0;
      this.render();
    }
    this.place();
  }

  hide() {
    this.active = null;
    this.shownQuery = null;
    this.dom.hidden = true;
    for (const attr of ['aria-activedescendant', 'aria-controls', 'aria-autocomplete']) {
      this.view.dom.removeAttribute(attr);
    }
  }

  /** Returns true if the key was for the list. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.active || event.isComposing) return false;
    switch (event.key) {
      case 'ArrowDown':
        this.select(this.selected + 1);
        return true;
      case 'ArrowUp':
        this.select(this.selected - 1);
        return true;
      case 'Enter':
      case 'Tab': {
        const option = this.options[this.selected];
        if (!option) return false;
        this.accept(option);
        return true;
      }
      case 'Escape':
        this.dismissedFrom = this.active.from;
        this.hide();
        return true;
      default:
        return false;
    }
  }

  private select(index: number) {
    const count = this.options.length;
    if (count === 0) return;
    this.selected = (index + count) % count;
    this.showSelected();
  }

  private showSelected() {
    const items = this.dom.querySelectorAll<HTMLElement>('[role="option"]');
    items.forEach((item, i) => {
      const on = i === this.selected;
      item.classList.toggle('is-selected', on);
      item.setAttribute('aria-selected', String(on));
      if (on) {
        item.scrollIntoView({ block: 'nearest' });
        this.view.dom.setAttribute('aria-activedescendant', item.id);
      }
    });
  }

  private render() {
    const items = this.options.map((option, index) => {
      const item = document.createElement('div');
      item.id = `${this.dom.id}-${index}`;
      item.setAttribute('role', 'option');
      item.dataset.index = String(index);
      item.className = `link-suggest-item${option.create ? ' is-create' : ''}`;
      const primary = document.createElement('span');
      primary.className = 'link-suggest-primary';
      primary.textContent = option.primary;
      item.append(primary);
      if (option.secondary) {
        const secondary = document.createElement('span');
        secondary.className = 'link-suggest-secondary';
        secondary.textContent = option.secondary;
        item.append(secondary);
      }
      return item;
    });
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'link-suggest-empty';
      empty.textContent = t('Type the name of a page');
      items.push(empty);
    }
    this.dom.replaceChildren(...items);
    this.dom.hidden = false;
    const dom = this.view.dom;
    dom.setAttribute('aria-autocomplete', 'list');
    dom.setAttribute('aria-controls', this.dom.id);
    this.showSelected();
  }

  private readonly place = () => {
    if (!this.active || this.dom.hidden) return;
    const margin = 8;
    const gap = 4;
    const at = this.view.coordsAtPos(this.active.from);
    const { width, height } = this.dom.getBoundingClientRect();
    const below = at.bottom + gap;
    const top = below + height > window.innerHeight - margin ? Math.max(margin, at.top - height - gap) : below;
    const left = Math.max(margin, Math.min(at.left, window.innerWidth - width - margin));
    this.dom.style.top = `${top}px`;
    this.dom.style.left = `${left}px`;
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    event.preventDefault();
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    const option = item ? this.options[Number(item.dataset.index)] : undefined;
    if (option) this.accept(option);
  };

  private accept(option: LinkOption) {
    const { view, active } = this;
    if (!active) return;
    const { state } = view;
    const type = state.schema.marks.wikiLink;
    const text = active.label?.trim() || option.text;
    const marks = type.create({ target: option.target }).addToSet(state.doc.resolve(active.from).marks());
    const tr = state.tr.replaceWith(active.from, active.to, state.schema.text(text, marks));
    tr.setSelection(TextSelection.create(tr.doc, active.from + text.length));
    // Typing straight after a link should not extend it.
    tr.removeStoredMark(type);
    this.hide();
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }
}

export const linkAutocomplete = Extension.create({
  name: 'linkAutocomplete',
  // Ahead of the keymaps, because Enter here chooses a page rather than splitting a line.
  priority: 1100,
  addProseMirrorPlugins() {
    let popup: LinkPopup | null = null;
    return [
      new Plugin({
        key: new PluginKey('linkAutocomplete'),
        view: (view) => {
          popup = new LinkPopup(view);
          return popup;
        },
        props: {
          handleKeyDown: (_view, event) => popup?.handleKey(event) ?? false,
          handleDOMEvents: {
            blur: () => {
              popup?.hide();
              return false;
            },
            focus: () => {
              popup?.sync();
              return false;
            },
          },
        },
      }),
    ];
  },
});

/**
 * Starts a link at the cursor. Selected text within one block becomes the link's label,
 * as `[[|label]]` with the cursor after the opening brackets, so nothing is lost if the
 * writer changes their mind.
 */
export function startWikiLink(editor: Editor) {
  const { state, view } = editor;
  const { from, to, empty, $from, $to } = state.selection;
  const tr = state.tr;
  if (!empty && $from.sameParent($to) && $from.parent.isTextblock) {
    const label = state.doc.textBetween(from, to, undefined, INLINE_LEAF);
    if (!/[[\]|￼]/.test(label)) {
      tr.insertText(']]', to).insertText('[[|', from);
      tr.setSelection(TextSelection.create(tr.doc, from + 2));
      view.dispatch(tr);
      view.focus();
      return;
    }
  }
  tr.setSelection(Selection.near(tr.doc.resolve(to))).insertText('[[');
  view.dispatch(tr);
  view.focus();
}
