/**
 * The canvas data model: JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/), read and written
 * here and nowhere else. Anything the file holds that we do not understand is kept as it was,
 * so a canvas made elsewhere survives a round trip through LoreCraft.
 *
 * LoreCraft things go in a `file` node as `lorecraft:<kind>/<id>`, with an optional
 * `#heading` on a page or scene, which shows just that section.
 */

export type NodeType = 'text' | 'file' | 'link' | 'group';
export type Side = 'top' | 'right' | 'bottom' | 'left';
export type End = 'none' | 'arrow';

/** A preset ("1" to "6") or a hex color such as "#ff8800". */
export type CanvasColor = string;

export interface CanvasNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  background?: string;
  backgroundStyle?: 'cover' | 'ratio' | 'repeat';
  /** Fields from other apps, kept as they were. */
  [extra: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: Side;
  fromEnd?: End;
  toNode: string;
  toSide?: Side;
  toEnd?: End;
  color?: CanvasColor;
  label?: string;
  [extra: string]: unknown;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [extra: string]: unknown;
}

export const EMPTY_CANVAS: CanvasData = { nodes: [], edges: [] };

const TYPES = new Set<NodeType>(['text', 'file', 'link', 'group']);
const SIDES = new Set<Side>(['top', 'right', 'bottom', 'left']);
const ENDS = new Set<End>(['none', 'arrow']);

export class CanvasParseError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A valid color, or undefined. */
export function cleanColor(value: unknown): CanvasColor | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^[1-6]$/.test(value)) return value;
  if (/^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{3}$/i.test(value)) return value.toLowerCase();
  return undefined;
}

/**
 * Reads a JSON Canvas object, from a file or from storage. Nodes without an id or with an
 * unknown type, and edges to nodes that are not there, are dropped. Throws only when the
 * text is not a canvas at all.
 */
export function parseCanvas(input: string | unknown): CanvasData {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = input.trim() ? JSON.parse(input) : {};
    } catch {
      throw new CanvasParseError('This is not a canvas file.');
    }
  }
  if (!isObject(raw)) throw new CanvasParseError('This is not a canvas file.');
  const { nodes: rawNodes, edges: rawEdges, ...rest } = raw;
  if ((rawNodes !== undefined && !Array.isArray(rawNodes)) || (rawEdges !== undefined && !Array.isArray(rawEdges))) {
    throw new CanvasParseError('This is not a canvas file.');
  }
  const seen = new Set<string>();
  const nodes: CanvasNode[] = [];
  for (const item of (rawNodes as unknown[] | undefined) ?? []) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
    if (!TYPES.has(item.type as NodeType)) continue;
    const node: CanvasNode = {
      ...item,
      id: item.id,
      type: item.type as NodeType,
      x: Math.round(finite(item.x, 0)),
      y: Math.round(finite(item.y, 0)),
      width: Math.max(1, Math.round(finite(item.width, 250))),
      height: Math.max(1, Math.round(finite(item.height, 60))),
    };
    const color = cleanColor(item.color);
    if (color) node.color = color;
    else delete node.color;
    for (const key of ['text', 'file', 'subpath', 'url', 'label', 'background'] as const) {
      if (key in node && typeof node[key] !== 'string') delete node[key];
    }
    if (node.type === 'text' && node.text === undefined) node.text = '';
    if (node.type === 'file' && node.file === undefined) node.file = '';
    if (node.type === 'link' && node.url === undefined) node.url = '';
    seen.add(node.id);
    nodes.push(node);
  }
  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  for (const item of (rawEdges as unknown[] | undefined) ?? []) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || edgeIds.has(item.id)) continue;
    if (typeof item.fromNode !== 'string' || typeof item.toNode !== 'string') continue;
    if (!seen.has(item.fromNode) || !seen.has(item.toNode)) continue;
    const edge: CanvasEdge = { ...item, id: item.id, fromNode: item.fromNode, toNode: item.toNode };
    for (const key of ['fromSide', 'toSide'] as const) if (key in edge && !SIDES.has(edge[key] as Side)) delete edge[key];
    for (const key of ['fromEnd', 'toEnd'] as const) if (key in edge && !ENDS.has(edge[key] as End)) delete edge[key];
    const color = cleanColor(item.color);
    if (color) edge.color = color;
    else delete edge.color;
    if ('label' in edge && typeof edge.label !== 'string') delete edge.label;
    edgeIds.add(edge.id);
    edges.push(edge);
  }
  return { ...rest, nodes, edges };
}

/** Writes a canvas as a .canvas file. Tabs, as other JSON Canvas apps write. */
export function serializeCanvas(data: CanvasData): string {
  return JSON.stringify({ ...data, nodes: data.nodes, edges: data.edges }, null, '\t');
}

/**
 * Reads a JSON Canvas fragment pasted as text, as LoreCraft and other apps copy cards, or
 * null if the text is not one. Plain text that happens to be JSON stays plain text.
 */
export function readFragment(text: string): CanvasData | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"nodes"')) return null;
  try {
    const data = parseCanvas(trimmed);
    return data.nodes.length ? { nodes: data.nodes, edges: data.edges } : null;
  } catch {
    return null;
  }
}

/** The arrowhead at each end, with the spec's defaults: none at the start, an arrow at the end. */
export function edgeEnds(edge: CanvasEdge): { from: End; to: End } {
  return { from: edge.fromEnd ?? 'none', to: edge.toEnd ?? 'arrow' };
}

// ---- LoreCraft references --------------------------------------------------------------

export type RefKind = 'page' | 'scene' | 'asset' | 'canvas';

export interface LoreRef {
  kind: RefKind;
  id: string;
  /** A heading to narrow a page or scene to. */
  heading?: string;
}

const REF = /^lorecraft:(page|scene|asset|canvas)\/([^#\s]+)(?:#(.+))?$/;

export function parseRef(file: string | undefined): LoreRef | null {
  if (!file) return null;
  const match = REF.exec(file);
  if (!match) return null;
  const ref: LoreRef = { kind: match[1] as RefKind, id: decodeURIComponent(match[2]) };
  if (match[3]) ref.heading = decodeURIComponent(match[3]);
  return ref;
}

export function formatRef(ref: LoreRef): string {
  const base = `lorecraft:${ref.kind}/${encodeURIComponent(ref.id)}`;
  return ref.heading ? `${base}#${encodeURIComponent(ref.heading)}` : base;
}

// ---- Ids --------------------------------------------------------------------------------

/** A 16-hex-digit id, the length other JSON Canvas apps use. */
export function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Web addresses ------------------------------------------------------------------------

/** Only http and https may ever load in a card. */
export function safeWebUrl(text: string | undefined): string | null {
  if (!text) return null;
  try {
    const url = new URL(text.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The privacy-enhanced embed address for a YouTube video, or null if this is not one. */
export function youtubeEmbedUrl(text: string | undefined): string | null {
  const href = safeWebUrl(text);
  if (!href) return null;
  const url = new URL(href);
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const parts = url.pathname.split('/').filter(Boolean);
  let id: string | null = null;
  if (host === 'youtu.be') id = parts[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1] ?? null;
  }
  if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  return `https://www.youtube-nocookie.com/embed/${id}`;
}
