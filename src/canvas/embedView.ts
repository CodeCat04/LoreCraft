/**
 * How a `canvasEmbed` block looks in a page: a small read-only drawing of the canvas, its
 * name, and "Open canvas". The canvas is read fresh, so the preview never goes stale.
 */

import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { NodeView } from '@tiptap/pm/view';

import { t } from '../lib/i18n';
import { titleKey } from '../lib/text';
import { promptText } from '../shell/dialogs';
import { subscribeDataChanges } from '../state/events';
import { useNav } from '../state/nav';
import { canvases } from './api';
import { colorVar } from './colors';
import { boundsOf, drawingOrder } from './geometry';
import type { CanvasData } from './model';

const SVG = 'http://www.w3.org/2000/svg';

/** A miniature of the canvas: boxes and lines only, nothing loaded. */
export function previewSvg(data: CanvasData): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'canvas-embed-preview');
  svg.setAttribute('aria-hidden', 'true');
  const box = boundsOf(data.nodes);
  if (!box) return svg;
  svg.setAttribute('viewBox', `${box.x - 20} ${box.y - 20} ${box.width + 40} ${box.height + 40}`);
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  for (const edge of data.edges) {
    const a = byId.get(edge.fromNode);
    const b = byId.get(edge.toNode);
    if (!a || !b) continue;
    const line = document.createElementNS(SVG, 'line');
    line.setAttribute('x1', String(a.x + a.width / 2));
    line.setAttribute('y1', String(a.y + a.height / 2));
    line.setAttribute('x2', String(b.x + b.width / 2));
    line.setAttribute('y2', String(b.y + b.height / 2));
    line.setAttribute('class', 'canvas-embed-edge');
    svg.append(line);
  }
  for (const node of drawingOrder(data.nodes)) {
    const rect = document.createElementNS(SVG, 'rect');
    for (const [k, v] of Object.entries({ x: node.x, y: node.y, width: node.width, height: node.height, rx: 8 })) rect.setAttribute(k, String(v));
    rect.setAttribute('class', node.type === 'group' ? 'canvas-embed-group' : 'canvas-embed-card');
    const color = colorVar(node.color);
    if (color) rect.style.stroke = color;
    svg.append(rect);
  }
  return svg;
}

class CanvasEmbedView implements NodeView {
  readonly dom: HTMLElement;
  private id: string;
  private readonly unsubscribe: () => void;
  private timer: number | undefined;

  constructor(node: ProseNode) {
    this.id = String(node.attrs.canvasId ?? '');
    this.dom = document.createElement('div');
    this.dom.className = 'canvas-embed';
    this.dom.dataset.canvasEmbed = '';
    this.dom.contentEditable = 'false';
    this.unsubscribe = subscribeDataChanges(() => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.load(), 600);
    });
    void this.load();
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== 'canvasEmbed') return false;
    if (node.attrs.canvasId !== this.id) {
      this.id = String(node.attrs.canvasId ?? '');
      void this.load();
    }
    return true;
  }

  ignoreMutation() {
    return true;
  }

  stopEvent(event: Event) {
    return (event.target as HTMLElement).closest('button') !== null;
  }

  destroy() {
    window.clearTimeout(this.timer);
    this.unsubscribe();
  }

  private async load() {
    const head = document.createElement('div');
    head.className = 'canvas-embed-head';
    const name = document.createElement('strong');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-sm';
    open.textContent = t('Open canvas');
    open.addEventListener('click', () => useNav.getState().go({ view: 'canvas', id: this.id }));
    head.append(name, open);
    try {
      const canvas = await canvases.get(this.id);
      if (canvas.deletedAt) throw new Error('trashed');
      name.textContent = t('Canvas: {title}', { title: canvas.title });
      this.dom.replaceChildren(head, previewSvg(canvas.data));
    } catch {
      name.textContent = t('This canvas was deleted or is in the trash.');
      open.hidden = true;
      this.dom.replaceChildren(head);
    }
  }
}

/** Gives `canvasEmbed` blocks their preview. Part of every `RichEditor`. */
export const canvasEmbedViews = Extension.create({
  name: 'canvasEmbedViews',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('canvasEmbedViews'),
        props: { nodeViews: { canvasEmbed: (node) => new CanvasEmbedView(node) } },
      }),
    ];
  },
});

/** Asks which canvas, then adds it at the cursor. */
export async function insertCanvasEmbed(editor: Editor) {
  const list = await canvases.list();
  if (list.length === 0) return;
  const name = await promptText({
    title: t('Insert a canvas'),
    label: t('Canvas name'),
    initial: list[0].title,
    validate: (v) => (list.some((c) => titleKey(c.title) === titleKey(v)) ? null : t('There is no canvas with that name.')),
  });
  const found = list.find((c) => name && titleKey(c.title) === titleKey(name));
  if (found) editor.chain().focus().insertContent({ type: 'canvasEmbed', attrs: { canvasId: found.id } }).run();
}
