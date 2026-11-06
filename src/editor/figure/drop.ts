/**
 * Dropping and pasting into an editor. Figures sit between blocks, so while something
 * droppable is over an editor a line shows the block boundary it will land on.
 */

import type { Slice } from '@tiptap/pm/model';
import type { PluginView } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { recognizeVideoUrl, singleUrlFrom } from '../../media/urls';
import { nearestFigurePos } from './commands';
import { addFiles, addVideoLink } from './uploads';

/** Whether a drag from outside the app carries something that could become a figure. */
export function carriesMedia(data: DataTransfer | null): boolean {
  const types = data?.types ?? [];
  return types.includes('Files') || types.includes('text/uri-list');
}

/** The block boundary nearest a point in the window. Above or below the text counts too. */
export function positionAtPoint(view: EditorView, clientX: number, clientY: number): number {
  const { doc } = view.state;
  const rect = view.dom.getBoundingClientRect();
  const found = view.posAtCoords({
    left: Math.max(rect.left + 1, Math.min(clientX, rect.right - 1)),
    top: Math.max(rect.top + 1, Math.min(clientY, rect.bottom - 1)),
  });
  const raw = found?.pos ?? (clientY < rect.top ? 0 : doc.content.size);
  return nearestFigurePos(doc, raw);
}

function lineRect(view: EditorView, pos: number): { left: number; width: number; top: number } | null {
  const $pos = view.state.doc.resolve(pos);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  const domOf = (at: number) => view.nodeDOM(at) as HTMLElement | null;
  const beforeRect = before ? domOf(pos - before.nodeSize)?.getBoundingClientRect() : undefined;
  const afterRect = after ? domOf(pos)?.getBoundingClientRect() : undefined;
  const near = afterRect ?? beforeRect;
  if (!near) return null;
  const top =
    beforeRect && afterRect ? (beforeRect.bottom + afterRect.top) / 2 : afterRect ? afterRect.top : near.bottom;
  // At the top level, the full column reads better than the width of a floated neighbor.
  const column = $pos.depth === 0 ? view.dom.getBoundingClientRect() : near;
  return { left: column.left, width: column.width, top };
}

/** Shows where a drop will land. */
export function dropIndicatorView(view: EditorView): PluginView {
  let line: HTMLElement | null = null;

  const hide = () => {
    line?.remove();
    line = null;
  };

  const over = (event: DragEvent) => {
    if (view.dragging || !view.editable || !carriesMedia(event.dataTransfer)) return;
    // Handled here, so the default drop cursor does not mark a place inside the text.
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const rect = lineRect(view, positionAtPoint(view, event.clientX, event.clientY));
    if (!rect) return;
    if (!line) {
      line = document.createElement('div');
      line.className = 'figure-drop-line';
      document.body.append(line);
    }
    line.style.left = `${rect.left}px`;
    line.style.top = `${rect.top}px`;
    line.style.width = `${rect.width}px`;
  };

  const leave = (event: DragEvent) => {
    if (!view.dom.contains(event.relatedTarget as Node | null)) hide();
  };

  view.dom.addEventListener('dragover', over, true);
  view.dom.addEventListener('dragleave', leave);
  view.dom.addEventListener('drop', hide, true);
  window.addEventListener('dragend', hide);

  return {
    destroy() {
      hide();
      view.dom.removeEventListener('dragover', over, true);
      view.dom.removeEventListener('dragleave', leave);
      view.dom.removeEventListener('drop', hide, true);
      window.removeEventListener('dragend', hide);
    },
  };
}

export function handleDrop(view: EditorView, event: DragEvent): boolean {
  // A figure or text being moved within the editor is ProseMirror's own business.
  if (view.dragging) return false;
  const data = event.dataTransfer;
  if (!data) return false;
  const pos = positionAtPoint(view, event.clientX, event.clientY);
  if (data.files.length > 0) {
    addFiles(view, [...data.files], pos);
    return true;
  }
  const link = recognizeVideoUrl(singleUrlFrom(data) ?? '');
  if (link) {
    addVideoLink(view, link.url, pos);
    return true;
  }
  return false;
}

/** Word and others put a picture of the copied text on the clipboard beside the text itself. */
function isOnlyPicture(data: DataTransfer): boolean {
  const text = data.getData('text/plain').trim();
  if (!text) return true;
  const html = data.getData('text/html');
  return /<img\b/i.test(html) && !html.replace(/<(style|head)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '').trim();
}

export function handlePaste(view: EditorView, event: ClipboardEvent, slice: Slice): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  const { selection, schema, tr } = view.state;
  const { $from } = selection;
  const inLabel = $from.parent.type.name === 'figcaption';

  const files = [...data.files].filter((file) => /^(image|video)\//.test(file.type));
  if (files.length > 0 && isOnlyPicture(data)) {
    addFiles(view, files, selection.from);
    return true;
  }

  if (inLabel) {
    // A label is one run of text. More than one block would not fit, so join the lines.
    const { content } = slice;
    const fits = content.firstChild?.isInline || (content.childCount === 1 && content.firstChild?.isTextblock);
    if (fits) return false;
    const text = data.getData('text/plain').replace(/\s*\n+\s*/g, ' ').trim();
    if (text) view.dispatch(tr.insertText(text).scrollIntoView());
    return true;
  }

  if (selection.empty && !$from.parent.type.spec.code && !$from.marks().some((m) => m.type === schema.marks.code)) {
    const link = recognizeVideoUrl(data.getData('text/plain'));
    if (link) {
      addVideoLink(view, link.url, selection.from);
      return true;
    }
  }
  return false;
}
