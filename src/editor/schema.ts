/**
 * The document schema, defined once. See docs/ARCHITECTURE.md for the node list.
 * Stored documents depend on these names, so renaming a node or mark needs a
 * migration.
 */

import { Mark, Node, mergeAttributes, markInputRule, type Extensions } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';

/**
 * Lets each block of text take its direction from that text, so Arabic and Hebrew run right
 * to left beside English. It only affects how a block is drawn, so it is never stored. Lists
 * and quotes hold no text of their own, so `prose.css` has them follow their first block.
 */
const AUTO_DIRECTION = { dir: 'auto' };

/** A link to a wiki page. Stores the target title, so red links can exist. */
export const WikiLink = Mark.create({
  name: 'wikiLink',
  priority: 1001,
  // Typing at the edge of a link should not extend it.
  inclusive: false,
  addAttributes() {
    return {
      target: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-wiki-target') ?? '',
        renderHTML: (attrs) => ({ 'data-wiki-target': attrs.target }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'a[data-wiki-target]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['a', mergeAttributes(HTMLAttributes, { class: 'wiki-link' }), 0];
  },
  addInputRules() {
    return [
      // [[Target|Label]] or [[Target]], converted when the closing brackets are typed.
      markInputRule({
        find: /\[\[([^\[\]|]+)\|([^\[\]]+)\]\]$/,
        type: this.type,
        getAttributes: (match) => ({ target: match[1].trim() }),
      }),
      markInputRule({
        find: /\[\[([^\[\]|]+)\]\]$/,
        type: this.type,
        getAttributes: (match) => ({ target: match[1].trim() }),
      }),
    ];
  },
});

/**
 * A comment or to-do on this stretch of text. The comment's words live in a table, so this
 * holds only its id. It is a note to the writer, and exports and plain text ignore it.
 */
export const CommentMark = Mark.create({
  name: 'comment',
  // Typing at the edge of a comment should not extend it.
  inclusive: false,
  // Comments can overlap, so one must not replace another.
  excludes: '',
  addAttributes() {
    return {
      id: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-comment-id') ?? '',
        renderHTML: (attrs) => ({ 'data-comment-id': attrs.id }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },
});

/** An inline citation. Rendered as a number. The wiki lists them under the article. */
export const Reference = Node.create({
  name: 'reference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      text: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-text') ?? '',
        renderHTML: (attrs) => ({ 'data-text': attrs.text, title: attrs.text }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'sup[data-reference]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { 'data-reference': '', class: 'reference' })];
  },
});

/**
 * A list of pages that fills itself in from a query, such as "all characters in the
 * category Nobility". Only the query is stored, so the list is never out of date.
 */
export const PageList = Node.create({
  name: 'pageList',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    const attr = (name: string, fallback = '') => ({
      default: fallback,
      parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) ?? fallback,
      renderHTML: (attrs: Record<string, string>) => ({ [`data-${name}`]: attrs[name] }),
    });
    return {
      pageType: attr('pageType'),
      category: attr('category'),
      status: attr('status'),
      sort: attr('sort', 'title'),
      field: attr('field'),
      fieldValue: attr('fieldValue'),
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-page-list]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-page-list': '' })];
  },
});

/**
 * A canvas shown inside a page, read-only, with a way to open it. Only the canvas id is
 * stored, so the preview always shows the canvas as it is now.
 */
export const CanvasEmbed = Node.create({
  name: 'canvasEmbed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      canvasId: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-canvas-id') ?? '',
        renderHTML: (attrs: Record<string, string>) => ({ 'data-canvas-id': attrs.canvasId }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-canvas-embed]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-canvas-embed': '' })];
  },
});

/**
 * An image stored in the project. `assetId` is the durable identity. `width` and `height`
 * are its size in pixels, which lets a picture hold its space before it has loaded. Not
 * draggable by itself: inside a figure, dragging moves the whole figure.
 */
export const AssetImage = Image.extend({
  draggable: false,
  addAttributes() {
    return {
      ...this.parent?.(),
      assetId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-asset-id'),
        renderHTML: (attrs) => (attrs.assetId ? { 'data-asset-id': attrs.assetId } : {}),
      },
    };
  },
  parseHTML() {
    // A stored image has no `src`, and copying one must keep it.
    return [{ tag: 'img[data-asset-id]' }, ...(this.parent?.() ?? [])];
  },
});

/** A video stored in the project (`assetId`), or a link to one elsewhere (`url`). */
export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-asset-id'),
        renderHTML: (attrs) => (attrs.assetId ? { 'data-asset-id': attrs.assetId } : {}),
      },
      url: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-url'),
        renderHTML: (attrs) => (attrs.url ? { 'data-url': attrs.url } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-video]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-video': '', class: 'video-placeholder' })];
  },
});

export const Figcaption = Node.create({
  name: 'figcaption',
  content: 'inline*',
  // Ctrl+click selects the figure. A label on its own could only be deleted, and a figure needs one.
  selectable: false,
  parseHTML() {
    return [{ tag: 'figcaption' }];
  },
  renderHTML() {
    return ['figcaption', AUTO_DIRECTION, 0];
  },
});

/** How a figure is numbered and named. The writer can change it. */
export const FIGURE_KINDS = ['figure', 'picture', 'table', 'video'] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

/** `left` and `right` let text wrap around the figure. */
export const FIGURE_ALIGNS = ['left', 'right', 'center', 'full'] as const;
export type FigureAlign = (typeof FIGURE_ALIGNS)[number];

/**
 * A labeled picture, video or table. The caption is the label the writer sees and the
 * AI reads. `description` holds any further detail about what it shows.
 */
export const Figure = Node.create({
  name: 'figure',
  group: 'block',
  content: '(image | video | table) figcaption',
  isolating: true,
  draggable: true,
  addAttributes() {
    return {
      kind: {
        default: 'figure',
        parseHTML: (el) => el.getAttribute('data-kind') ?? 'figure',
        renderHTML: (attrs) => ({ 'data-kind': attrs.kind }),
      },
      align: {
        default: 'right',
        parseHTML: (el) => el.getAttribute('data-align') ?? 'right',
        renderHTML: (attrs) => ({ 'data-align': attrs.align }),
      },
      /** Percent of the text column. Null uses the default for the alignment. */
      width: {
        default: null,
        parseHTML: (el) => {
          const value = parseFloat(el.getAttribute('data-width') ?? '');
          return Number.isFinite(value) ? value : null;
        },
        renderHTML: (attrs) =>
          attrs.width ? { 'data-width': attrs.width, style: `width: ${attrs.width}%` } : {},
      },
      description: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-description') ?? '',
        renderHTML: (attrs) => (attrs.description ? { 'data-description': attrs.description } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'figure' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes, { class: 'figure' }), 0];
  },
});

export function documentExtensions(): Extensions {
  return [
    StarterKit.configure({
      dropcursor: { color: 'var(--accent)', width: 2 },
      paragraph: { HTMLAttributes: AUTO_DIRECTION },
      heading: { levels: [1, 2, 3, 4], HTMLAttributes: AUTO_DIRECTION },
      link: { openOnClick: false, autolink: true, HTMLAttributes: { class: 'external-link', rel: 'noopener', target: null } },
    }),
    TableKit.configure({ table: { resizable: false } }),
    AssetImage,
    Video,
    Figcaption,
    Figure,
    WikiLink,
    CommentMark,
    Reference,
    PageList,
    CanvasEmbed,
  ];
}
