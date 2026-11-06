/**
 * Draws a canvas to a PNG. The web view cannot photograph its own page, so cards are drawn
 * again on a 2D canvas: boxes, text, titles and connections, in the theme's colors. Text cards
 * keep their headings, lists and line breaks (`exportText.ts`). Pictures are read through
 * `media_read` into a blob first: drawn from the lbasset scheme they would taint the canvas,
 * which could then not be saved. A PDF shows its first page; web pages show their address,
 * since nothing is loaded.
 */

import * as api from '../lib/api';
import { assetInfo, readAssetBytes } from '../lib/assets';
import { t } from '../lib/i18n';
import { useTitles } from '../state/project';
import { drawFirstPage } from '../media/pdf';
import { colorVar } from './colors';
import { cssFont, layoutText, wrapWords } from './exportText';
import { anchor, boundsOf, chooseSides, drawingOrder, type Rect, type Viewport } from './geometry';
import { edgeEnds, parseRef, type CanvasData, type CanvasNode } from './model';

const MAX_SIDE = 8000;

function resolve(board: HTMLElement, value: string): string {
  const probe = document.createElement('span');
  probe.style.color = value;
  board.appendChild(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((done) => {
    const img = new Image();
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = src;
  });
}

/** A project picture, from its bytes, so it is same-origin and leaves the canvas clean. */
async function loadAssetImage(id: string, mime: string): Promise<HTMLImageElement | null> {
  const bytes = await readAssetBytes(id).catch(() => null);
  if (!bytes) return null;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const img = await loadImage(url);
    await img?.decode().catch(() => {});
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Fits a picture inside a box, keeping its shape, as `object-fit: contain` does. */
function contain(width: number, height: number, box: Rect): Rect {
  const scale = Math.min(box.width / width, box.height / height);
  const w = width * scale;
  const h = height * scale;
  return { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h };
}

/** Renders and asks where to save. `area` null means the whole canvas. Returns false if cancelled. */
export async function exportCanvasPng(
  board: HTMLElement,
  data: CanvasData,
  area: { view: Viewport; width: number; height: number } | null,
  title: string,
): Promise<boolean> {
  let rect: Rect | null;
  if (area) rect = { x: -area.view.x / area.view.zoom, y: -area.view.y / area.view.zoom, width: area.width / area.view.zoom, height: area.height / area.view.zoom };
  else {
    const b = boundsOf(data.nodes);
    rect = b && { x: b.x - 40, y: b.y - 40, width: b.width + 80, height: b.height + 80 };
  }
  if (!rect) throw new Error(t('The canvas is empty.'));
  const scale = Math.min(2, MAX_SIDE / Math.max(rect.width, rect.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(rect.width * scale));
  out.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = out.getContext('2d')!;
  const css = getComputedStyle(board);
  const token = (name: string) => resolve(board, css.getPropertyValue(name).trim() || 'gray');
  const bg = token('--bg');
  const surface = token('--surface');
  const border = token('--border-strong');
  const text = token('--text');
  const muted = token('--text-muted');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.scale(scale, scale);
  ctx.translate(-rect.x, -rect.y);
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const colorOf = (n: { color?: string }) => (n.color ? resolve(board, colorVar(n.color)!) : null);

  ctx.lineWidth = 2;
  for (const edge of data.edges) {
    const a = byId.get(edge.fromNode);
    const b = byId.get(edge.toNode);
    if (!a || !b) continue;
    const sides = chooseSides(a, b);
    const p = anchor(a, edge.fromSide ?? sides.from);
    const q = anchor(b, edge.toSide ?? sides.to);
    ctx.strokeStyle = colorOf(edge) ?? muted;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
    const ends = edgeEnds(edge);
    const head = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - 12 * Math.cos(angle - 0.4), to.y - 12 * Math.sin(angle - 0.4));
      ctx.lineTo(to.x - 12 * Math.cos(angle + 0.4), to.y - 12 * Math.sin(angle + 0.4));
      ctx.fill();
    };
    if (ends.to === 'arrow') head(p, q);
    if (ends.from === 'arrow') head(q, p);
    if (edge.label) {
      ctx.fillStyle = text;
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(edge.label, (p.x + q.x) / 2, (p.y + q.y) / 2 - 6);
      ctx.textAlign = 'left';
    }
  }

  const titles = useTitles.getState().byId;
  const family = getComputedStyle(board).fontFamily || 'sans-serif';
  for (const node of drawingOrder(data.nodes)) {
    const color = colorOf(node);
    ctx.strokeStyle = color ?? border;
    if (node.type === 'group') {
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(node.x, node.y, node.width, node.height);
      ctx.setLineDash([]);
      ctx.fillStyle = text;
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText(node.label ?? '', node.x + 8, node.y - 8);
      continue;
    }
    ctx.fillStyle = surface;
    ctx.fillRect(node.x, node.y, node.width, node.height);
    ctx.strokeRect(node.x, node.y, node.width, node.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(node.x, node.y, node.width, node.height);
    ctx.clip();
    ctx.fillStyle = text;
    ctx.font = '14px sans-serif';
    await drawBody(ctx, node, titles, family, muted);
    ctx.restore();
  }

  const path = await api.files.pickSave({ title: t('Export as PNG'), defaultName: `${title}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (!path) return false;
  const base64 = out.toDataURL('image/png').split(',')[1];
  await api.files.writeBytes(path, base64);
  return true;
}

const PAD = 10;

/** Draws Markdown into a box, as `layoutText` lays it out. */
function drawText(ctx: CanvasRenderingContext2D, markdown: string, box: Rect, family: string) {
  const measure = (text: string, style: Parameters<typeof cssFont>[0]) => {
    ctx.font = cssFont(style, family);
    return ctx.measureText(text).width;
  };
  for (const line of layoutText(markdown, box.width, box.height, measure)) {
    ctx.font = cssFont(line.style, family);
    ctx.fillText(line.text, box.x + line.x, box.y + line.y);
  }
}

/** A small kind label and a name, for cards whose contents cannot be drawn. */
function drawNamed(ctx: CanvasRenderingContext2D, node: CanvasNode, kind: string, name: string, family: string, muted: string) {
  const fill = ctx.fillStyle;
  ctx.fillStyle = muted;
  ctx.font = cssFont({ size: 12, bold: false }, family);
  ctx.fillText(kind, node.x + PAD, node.y + 20);
  ctx.fillStyle = fill;
  // Drawn as it is: an address or a title is not Markdown.
  ctx.font = cssFont({ size: 15, bold: true }, family);
  let y = node.y + 44;
  for (const line of wrapWords(name, node.width - PAD * 2, (text) => ctx.measureText(text).width)) {
    if (y > node.y + node.height - 6) break;
    ctx.fillText(line, node.x + PAD, y);
    y += 21;
  }
}

async function drawBody(
  ctx: CanvasRenderingContext2D,
  node: CanvasNode,
  titles: Map<string, { title: string }>,
  family: string,
  muted: string,
) {
  const inner: Rect = { x: node.x + PAD, y: node.y + PAD, width: node.width - PAD * 2, height: node.height - PAD * 2 };
  if (node.type === 'text') return drawText(ctx, node.text ?? '', inner, family);
  if (node.type === 'link') return drawNamed(ctx, node, t('Web page'), node.url ?? '', family, muted);
  const ref = parseRef(node.file);
  if (ref?.kind === 'asset') {
    const info = await assetInfo(ref.id).catch(() => null);
    if (info?.kind === 'image') {
      const img = await loadAssetImage(ref.id, info.mime);
      if (img?.naturalWidth) {
        const at = contain(img.naturalWidth, img.naturalHeight, node);
        ctx.drawImage(img, at.x, at.y, at.width, at.height);
        return;
      }
    }
    if (info?.kind === 'pdf') {
      const page = document.createElement('canvas');
      const drawn = await drawFirstPage(ref.id, page, node.width).then(() => true, () => false);
      if (drawn && page.width) {
        const at = contain(page.width, page.height, { x: node.x, y: node.y + 28, width: node.width, height: node.height - 28 });
        ctx.drawImage(page, at.x, at.y, at.width, at.height);
        ctx.fillStyle = muted;
        ctx.font = cssFont({ size: 12, bold: false }, family);
        ctx.fillText(info.label || info.name, node.x + PAD, node.y + 20);
        return;
      }
    }
    const kind = { image: t('Picture'), video: t('Video'), audio: t('Sound'), pdf: t('PDF') }[info?.kind ?? 'image'];
    return drawNamed(ctx, node, kind, info ? info.label || info.name : (node.file ?? ''), family, muted);
  }
  const name = ref?.kind === 'page' ? titles.get(ref.id)?.title : undefined;
  const kind = ref?.kind === 'scene' ? t('Scene') : ref?.kind === 'canvas' ? t('Canvas') : t('Page');
  drawNamed(ctx, node, kind, name ?? node.file ?? '', family, muted);
}

