/**
 * How a figure looks and behaves in the editor. The picture, video or table and the label
 * are the node's real children, rendered by ProseMirror inside `contentDOM`. Everything
 * else here is chrome outside it: the toolbar and the resize handle. CSS hides the chrome
 * in Read mode, so one layout serves both.
 */

import type { Node as ProseNode } from '@tiptap/pm/model';
import { NodeSelection, Selection } from '@tiptap/pm/state';
import type { EditorView, NodeView, ViewMutationRecord } from '@tiptap/pm/view';
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow } from '@tiptap/pm/tables';

import { FIGURE_ALIGNS, FIGURE_KINDS, type FigureAlign } from '../schema';
import {
  clampWidth,
  deleteFigureTr,
  MAX_FIGURE_WIDTH,
  MIN_FIGURE_WIDTH,
  setFigureAttrs,
} from './commands';
import { openDescribePopover } from './describe';
import { ICONS, type IconName } from './icons';
import { editorAt } from './registry';
import { t } from '../../lib/i18n';

/** Built when a toolbar is, so the titles are in the current interface language. */
function alignButtons(): Record<FigureAlign, { icon: IconName; title: string }> {
  return {
    left: { icon: 'wrapLeft', title: t('Wrap left') },
    right: { icon: 'wrapRight', title: t('Wrap right') },
    center: { icon: 'center', title: t('Center') },
    full: { icon: 'full', title: t('Full width') },
  };
}

function kindLabels(): Record<string, string> {
  return {
    figure: t('Figure'),
    picture: t('Picture'),
    table: t('Table'),
    video: t('Video'),
  };
}

const KEY_RESIZE_STEP = 5;

function iconButton(icon: IconName, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'figure-tool';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = ICONS[icon];
  // Keeps the selection in the editor when a button is clicked.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  return button;
}

export class FigureView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private node: ProseNode;
  private readonly alignButtons = new Map<FigureAlign, HTMLButtonElement>();
  private readonly kindSelect: HTMLSelectElement;
  private readonly describeButton: HTMLButtonElement;
  private readonly resizeHandle: HTMLElement;
  private closeDescribe: (() => void) | null = null;

  constructor(
    node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    this.dom = document.createElement('figure');
    this.dom.className = 'figure';
    this.dom.classList.toggle('has-table', node.firstChild?.type.name === 'table');
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'figure-body';

    const toolbar = document.createElement('div');
    toolbar.className = 'figure-toolbar figure-chrome';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', t('Figure'));
    toolbar.contentEditable = 'false';

    // Not a button: pressing a button to drag it does nothing in some engines, and it has
    // nothing to offer the keyboard, which moves a figure by cut and paste.
    const grip = document.createElement('div');
    grip.className = 'figure-tool figure-grip';
    grip.title = t('Drag to move');
    grip.draggable = true;
    grip.setAttribute('aria-hidden', 'true');
    grip.innerHTML = ICONS.grip;
    toolbar.append(grip);

    const aligns = alignButtons();
    for (const align of FIGURE_ALIGNS) {
      const { icon, title } = aligns[align];
      const button = iconButton(icon, title);
      button.addEventListener('click', () => this.setAlign(align));
      this.alignButtons.set(align, button);
      toolbar.append(button);
    }

    this.kindSelect = document.createElement('select');
    this.kindSelect.className = 'figure-kind';
    this.kindSelect.title = t('How it is named and numbered');
    this.kindSelect.setAttribute('aria-label', t('Kind'));
    const labels = kindLabels();
    for (const kind of FIGURE_KINDS) {
      const option = document.createElement('option');
      option.value = kind;
      option.textContent = labels[kind];
      this.kindSelect.append(option);
    }
    this.kindSelect.addEventListener('change', () => {
      this.changeAttrs({ kind: this.kindSelect.value });
      view.focus();
    });
    toolbar.append(this.kindSelect);

    this.describeButton = iconButton('describe', t('More detail for the AI'));
    this.describeButton.setAttribute('aria-haspopup', 'dialog');
    this.describeButton.addEventListener('click', () => this.openDescribe());
    toolbar.append(this.describeButton);

    if (node.firstChild?.type.name === 'table') toolbar.append(...this.tableTools());

    const remove = iconButton('remove', t('Delete'));
    remove.addEventListener('click', () => this.remove());
    toolbar.append(remove);
    toolbar.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        view.focus();
      }
    });

    this.resizeHandle = document.createElement('div');
    this.resizeHandle.className = 'figure-resize figure-chrome';
    this.resizeHandle.contentEditable = 'false';
    this.resizeHandle.tabIndex = 0;
    this.resizeHandle.title = t('Drag to resize');
    this.resizeHandle.setAttribute('role', 'slider');
    this.resizeHandle.setAttribute('aria-label', t('Width'));
    this.resizeHandle.setAttribute('aria-valuemin', String(MIN_FIGURE_WIDTH));
    this.resizeHandle.setAttribute('aria-valuemax', String(MAX_FIGURE_WIDTH));
    this.resizeHandle.addEventListener('focus', () => this.announceWidth());
    this.resizeHandle.addEventListener('pointerdown', this.onResizeStart);
    this.resizeHandle.addEventListener('keydown', this.onResizeKey);

    this.dom.append(this.contentDOM, toolbar, this.resizeHandle);
    this.dom.addEventListener('dragstart', this.onDragStart);
    this.sync();
  }

  private tableTools(): HTMLButtonElement[] {
    const tool = (icon: IconName, title: string, command: typeof addRowAfter) => {
      const button = iconButton(icon, title);
      button.addEventListener('click', () => {
        this.withCursorInTable();
        command(this.view.state, this.view.dispatch);
        this.view.focus();
      });
      return button;
    };
    return [
      tool('addRow', t('Add a row'), addRowAfter),
      tool('addColumn', t('Add a column'), addColumnAfter),
      tool('removeRow', t('Delete this row'), deleteRow),
      tool('removeColumn', t('Delete this column'), deleteColumn),
    ];
  }

  /** The table commands act on the cell with the cursor, so make sure there is one. */
  private withCursorInTable() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const { selection, tr, doc } = this.view.state;
    const end = pos + 1 + (this.node.firstChild?.nodeSize ?? 0);
    if (!(selection instanceof NodeSelection) && selection.from > pos + 1 && selection.to < end) return;
    // Past the openings of the table, its first row and its first cell.
    this.view.dispatch(tr.setSelection(Selection.near(doc.resolve(pos + 4))));
  }

  private sync() {
    const { kind, align, width, description } = this.node.attrs as {
      kind: string;
      align: FigureAlign;
      width: number | null;
      description: string;
    };
    const { dataset, style } = this.dom;
    dataset.kind = kind;
    dataset.align = align;
    if (width) {
      dataset.width = String(width);
      style.width = `${width}%`;
    } else {
      delete dataset.width;
      style.width = '';
    }
    if (description) dataset.description = description;
    else delete dataset.description;
    if (document.activeElement === this.resizeHandle) this.announceWidth();

    for (const [value, button] of this.alignButtons) {
      const on = value === align;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', String(on));
    }
    if (this.kindSelect.value !== kind) this.kindSelect.value = kind;
    this.describeButton.classList.toggle('has-value', !!description);
    this.resizeHandle.hidden = align === 'full';
    this.syncAlt();
  }

  /** A picture's alt text is the description, or failing that the label. */
  private syncAlt() {
    const image = this.contentDOM.querySelector<HTMLImageElement>('.media-frame img');
    if (image) image.alt = this.altText();
  }

  /** Measuring takes a layout pass, so only when someone is on the slider to hear it. */
  private announceWidth() {
    this.resizeHandle.setAttribute('aria-valuenow', String(Math.round(this.currentWidth())));
  }

  private altText(): string {
    return String(this.node.attrs.description || this.node.lastChild?.textContent || '');
  }

  private currentWidth(): number {
    const stored = this.node.attrs.width as number | null;
    if (stored) return stored;
    const column = this.columnWidth();
    return column ? (this.dom.getBoundingClientRect().width / column) * 100 : 0;
  }

  /** What a percent of width is a percent of. */
  private columnWidth(): number {
    const parent = this.dom.parentElement;
    if (!parent) return 0;
    const style = getComputedStyle(parent);
    return parent.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  }

  private changeAttrs(attrs: Record<string, unknown>) {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(setFigureAttrs(this.view.state.tr, pos, attrs));
  }

  private setAlign(align: FigureAlign) {
    if (this.node.attrs.align !== align) this.changeAttrs({ align });
    // Someone in the middle of typing the label stays there.
    const pos = this.getPos();
    const { from } = this.view.state.selection;
    if (pos === undefined || from <= pos || from >= pos + this.node.nodeSize) this.selectFigure();
    this.view.focus();
  }

  private selectFigure() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const { state } = this.view;
    if (state.selection instanceof NodeSelection && state.selection.from === pos) return;
    this.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
  }

  private remove() {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(deleteFigureTr(this.view.state.tr, pos).scrollIntoView());
    this.view.focus();
  }

  /** The stored picture this figure shows, if it shows one. Videos and tables have none. */
  private pictureAssetId(): string | null {
    const media = this.node.firstChild;
    if (media?.type.name !== 'image') return null;
    const id = media.attrs.assetId as string | null;
    return id || null;
  }

  private openDescribe() {
    const assetId = this.pictureAssetId();
    this.closeDescribe = openDescribePopover({
      anchor: this.describeButton,
      value: String(this.node.attrs.description ?? ''),
      picture: assetId
        ? {
            assetId,
            caption: () => this.node.lastChild?.textContent ?? '',
            source: editorAt(this.view.dom)?.source ?? null,
          }
        : undefined,
      onChange: (value) => this.changeAttrs({ description: value }),
      onClose: () => {
        this.closeDescribe = null;
        this.describeButton.focus();
      },
    });
  }

  private readonly onDragStart = (event: DragEvent) => {
    if (!this.view.editable) {
      event.preventDefault();
      return;
    }
    // Text dragged out of the label or a table cell stays an ordinary text drag.
    const raw = event.target as Node;
    const element = raw.nodeType === Node.ELEMENT_NODE ? (raw as Element) : raw.parentElement;
    if (element?.closest('figcaption, td, th')) return;
    this.selectFigure();
    if (event.dataTransfer && element?.closest('.figure-grip')) {
      event.dataTransfer.setDragImage(this.dom, 16, 16);
    }
  };

  private readonly onResizeStart = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = this.resizeHandle;
    handle.setPointerCapture(event.pointerId);
    const column = this.columnWidth();
    if (!column) return;
    const startX = event.clientX;
    const startWidth = this.dom.getBoundingClientRect().width;
    const align = this.node.attrs.align as FigureAlign;
    // A right-aligned figure grows leftward, and a centered one grows both ways.
    const direction = (align === 'right' ? -1 : 1) * (align === 'center' ? 2 : 1);
    let width: number | null = null;
    this.dom.classList.add('is-resizing');

    const move = (e: PointerEvent) => {
      width = clampWidth(((startWidth + (e.clientX - startX) * direction) / column) * 100);
      this.dom.style.width = `${width}%`;
    };
    const finish = (commit: boolean) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', cancel);
      this.dom.classList.remove('is-resizing');
      // One undo step for the whole drag. A click with no movement changes nothing.
      if (commit && width !== null && width !== this.node.attrs.width) this.changeAttrs({ width });
      else this.sync();
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', cancel);
  };

  private readonly onResizeKey = (event: KeyboardEvent) => {
    const sign = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (!sign) return;
    event.preventDefault();
    this.changeAttrs({ width: clampWidth(this.currentWidth() + sign * KEY_RESIZE_STEP) });
  };

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    // The tools for a table are built once, so a change of media needs a fresh view.
    if ((node.firstChild?.type.name === 'table') !== (this.node.firstChild?.type.name === 'table')) return false;
    this.node = node;
    this.sync();
    return true;
  }

  /** Only changes inside the media and label are edits. The chrome changes on its own. */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target);
  }

  /** Events on the chrome are not the editor's business, apart from dragging by the grip. */
  stopEvent(event: Event): boolean {
    const target = event.target as Element | null;
    if (!target?.closest?.('.figure-chrome')) return false;
    return !event.type.startsWith('drag');
  }

  destroy() {
    this.closeDescribe?.();
  }
}
