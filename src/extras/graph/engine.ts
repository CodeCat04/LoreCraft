/**
 * Runs and draws the graph on a canvas, outside React. The simulation only advances
 * inside animation frames, and frames are only requested while something is changing,
 * so a settled graph uses no CPU at all.
 */

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

import { t } from '../../lib/i18n';
import { ATLAS_TOKENS, shapePoints, typeStyle, type TypeShape } from '../common/pageTypes';
import { observeTheme, remPx, resolveCssColors, uiFontFamily } from '../common/theme';
import { neighborMap, type GraphEdgeView, type GraphViewData } from './graphData';
import { isSymmetric, kindLabel } from './relationKinds';

interface SimNode extends SimulationNodeDatum {
  id: string;
  title: string;
  linkCount: number;
  token: string;
  shape: TypeShape;
  /** In world units, before zoom. */
  radius: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: SimNode;
  target: SimNode;
  edge: GraphEdgeView;
  label: string;
  /** Which end the arrow points at, for kinds that read one way. */
  arrowTo: SimNode | null;
}

const THEME_TOKENS = [
  ...ATLAS_TOKENS,
  '--bg',
  '--text',
  '--text-muted',
  '--border-strong',
  '--accent',
] as const;

type ThemeColors = Record<(typeof THEME_TOKENS)[number], string>;

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 6;
const WHEEL_ZOOM_SPEED = 0.0016;
const KEY_PAN_PX = 60;
const KEY_ZOOM_FACTOR = 1.25;
/** A press that moves less than this is a click. */
const CLICK_SLOP_PX = 4;
const HIT_PADDING_PX = 4;
/** Simulation time allowed per frame, so a big graph settles fast and still pans smoothly. */
const TICK_BUDGET_MS = 8;
/** A small graph could settle in one frame. This keeps its movement visible. */
const MAX_TICKS_PER_FRAME = 4;
const FIT_MARGIN_PX = 48;
/** Framing a few pages should not blow them up to fill the window. */
const MAX_FIT_ZOOM = 1.6;
const MAX_LABELS_WHILE_MOVING = 60;
const DIMMED_ALPHA = 0.16;

/**
 * Where pages were last placed, kept across visits to the view. Ids are unique across
 * projects, so this cannot mix projects up.
 */
const layoutMemory = new Map<string, { x: number; y: number }>();

export interface GraphEngineEvents {
  onOpen: (id: string) => void;
  onHover: (id: string | null) => void;
  onContextMenu: (id: string, clientX: number, clientY: number) => void;
}

/** Sized from its connections, and scaled with the interface size like other chrome. */
function nodeRadius(linkCount: number, rem: number): number {
  return (5 + Math.min(16, Math.sqrt(linkCount) * 2.4)) * (rem / 16);
}

export class GraphEngine {
  private ctx: CanvasRenderingContext2D;
  private nodes: SimNode[] = [];
  private links: SimLink[] = [];
  private neighbors = new Map<string, Set<string>>();
  private byId = new Map<string, SimNode>();
  private sim: Simulation<SimNode, SimLink> | null = null;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private k = 1;
  private tx = 0;
  private ty = 0;
  /** Keeps everything in view until the user takes over the camera. */
  private autoFit = true;
  private followId: string | null = null;
  /** While following, also zoom so that every page stays in view. */
  private followFits = false;

  private colors: ThemeColors;
  private font = 'sans-serif';
  private rem = 16;

  private simRunning = false;
  private frame = 0;
  private ticks = 0;
  private draws = 0;

  private hovered: SimNode | null = null;
  private matches: ReadonlySet<string> | null = null;
  private centerId: string | null = null;

  private press: {
    id: number;
    x: number;
    y: number;
    moved: boolean;
    node: SimNode | null;
    tx: number;
    ty: number;
  } | null = null;

  private cleanups: (() => void)[] = [];
  private canvas: HTMLCanvasElement;
  private events: GraphEngineEvents;

  constructor(canvas: HTMLCanvasElement, events: GraphEngineEvents) {
    this.canvas = canvas;
    this.events = events;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(t('This window cannot draw on a canvas.'));
    this.ctx = ctx;
    this.colors = resolveCssColors(THEME_TOKENS);
    this.font = uiFontFamily();
    this.rem = remPx();
    this.syncSize();
    this.listen();
    // Lets end-to-end tests find pages on the canvas and check that it goes idle.
    (canvas as unknown as { graphEngine?: GraphEngine }).graphEngine = this;
  }

  destroy() {
    this.remember();
    this.stopFrame();
    this.simRunning = false;
    this.sim?.stop();
    this.cleanups.forEach((cleanup) => cleanup());
    this.cleanups = [];
    delete (this.canvas as unknown as { graphEngine?: GraphEngine }).graphEngine;
  }

  // ---- Data -------------------------------------------------------------------

  /**
   * Shows new data. Pages keep their place, so changing a filter does not reshuffle the
   * whole picture. Only a graph with new pages in it gets a full settle.
   */
  setGraph(view: GraphViewData, center: string | null) {
    this.remember();
    this.sim?.stop();
    this.centerId = center;
    this.followId = center;
    this.followFits = !!center;
    if (center) this.autoFit = false;

    const placed = new Set<string>();
    const oldNodes = this.byId;
    this.nodes = view.nodes.map((source) => {
      const style = typeStyle(source.pageType);
      const old = oldNodes.get(source.id) ?? layoutMemory.get(source.id);
      if (old) placed.add(source.id);
      return {
        id: source.id,
        title: source.title,
        linkCount: source.linkCount,
        token: style.token,
        shape: style.shape,
        radius: nodeRadius(source.linkCount, this.rem),
        x: old?.x,
        y: old?.y,
      };
    });
    this.byId = new Map(this.nodes.map((node) => [node.id, node]));

    this.links = view.edges.flatMap((edge) => {
      const source = this.byId.get(edge.source);
      const target = this.byId.get(edge.target);
      if (!source || !target) return [];
      const rel = edge.relationships.find((r) => !isSymmetric(r));
      const arrowTo = rel ? (rel.toPageId === target.id ? target : source) : null;
      const label = edge.relationships.map((r) => kindLabel(r.kind)).join(', ');
      return [{ source, target, edge, label, arrowTo }];
    });
    this.neighbors = neighborMap(view.edges);
    if (this.hovered) this.hovered = this.byId.get(this.hovered.id) ?? null;

    // A new page starts beside something it connects to, rather than in the middle.
    for (const node of this.nodes) {
      if (node.x !== undefined) continue;
      const neighbor = [...(this.neighbors.get(node.id) ?? [])]
        .map((id) => this.byId.get(id))
        .find((other) => other?.x !== undefined);
      if (neighbor?.x !== undefined && neighbor.y !== undefined) {
        node.x = neighbor.x + (Math.random() - 0.5) * 40;
        node.y = neighbor.y + (Math.random() - 0.5) * 40;
      }
    }

    const count = this.nodes.length;
    const repulsion = -Math.min(220, Math.max(40, 1400 / Math.sqrt(Math.max(1, count))));
    const newShare = count ? 1 - placed.size / count : 0;
    const sim = forceSimulation<SimNode, SimLink>(this.nodes)
      .force('charge', forceManyBody<SimNode>().strength(repulsion).theta(0.9).distanceMax(700))
      .force(
        'link',
        forceLink<SimNode, SimLink>(this.links)
          .id((node) => node.id)
          .distance((link) => 34 + link.source.radius + link.target.radius),
      )
      .force('collide', forceCollide<SimNode>((node) => node.radius + 4).iterations(1))
      .force('x', forceX<SimNode>(0).strength(0.05))
      .force('y', forceY<SimNode>(0).strength(0.05))
      .alpha(newShare > 0.02 ? 1 : 0.12)
      .alphaDecay(1 - Math.pow(0.001, 1 / 180))
      .velocityDecay(0.42)
      .stop();
    this.sim = sim;
    this.startSimulation();
  }

  /** Dims everything but these pages. Null shows them all normally. */
  setMatches(ids: readonly string[] | null) {
    this.matches = ids ? new Set(ids) : null;
    this.requestFrame();
  }

  // ---- Camera -----------------------------------------------------------------

  /** Frames every page. */
  fit() {
    this.followId = null;
    this.autoFit = false;
    this.applyFit();
    this.requestFrame();
  }

  /** Zooms around the middle of the view. */
  zoomBy(factor: number) {
    this.zoomAround(factor, this.width / 2, this.height / 2);
  }

  centerOn(id: string) {
    const node = this.byId.get(id);
    if (!node) return;
    this.autoFit = false;
    this.followId = this.simRunning ? id : null;
    this.followFits = false;
    this.lookAt(node);
    this.requestFrame();
  }

  private lookAt(node: SimNode) {
    this.tx = this.width / 2 - (node.x ?? 0) * this.k;
    this.ty = this.height / 2 - (node.y ?? 0) * this.k;
  }

  /** Zooms so that everything fits with this page in the middle. */
  private fitAround(center: SimNode) {
    if (this.width === 0 || this.height === 0) return;
    let reachX = 1;
    let reachY = 1;
    for (const node of this.nodes) {
      reachX = Math.max(reachX, Math.abs((node.x ?? 0) - (center.x ?? 0)) + node.radius);
      reachY = Math.max(reachY, Math.abs((node.y ?? 0) - (center.y ?? 0)) + node.radius);
    }
    const k = Math.min(
      MAX_FIT_ZOOM,
      (this.width / 2 - FIT_MARGIN_PX) / reachX,
      (this.height / 2 - FIT_MARGIN_PX) / reachY,
    );
    this.k = Math.max(MIN_ZOOM, k);
  }

  private applyFit() {
    if (this.nodes.length === 0 || this.width === 0 || this.height === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.nodes) {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      minX = Math.min(minX, x - node.radius);
      maxX = Math.max(maxX, x + node.radius);
      minY = Math.min(minY, y - node.radius);
      maxY = Math.max(maxY, y + node.radius);
    }
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const k = Math.min(
      MAX_FIT_ZOOM,
      (this.width - FIT_MARGIN_PX * 2) / spanX,
      (this.height - FIT_MARGIN_PX * 2) / spanY,
    );
    this.k = Math.max(MIN_ZOOM, k);
    this.tx = this.width / 2 - ((minX + maxX) / 2) * this.k;
    this.ty = this.height / 2 - ((minY + maxY) / 2) * this.k;
  }

  private zoomAround(factor: number, sx: number, sy: number) {
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.k * factor));
    const applied = k / this.k;
    this.tx = sx - (sx - this.tx) * applied;
    this.ty = sy - (sy - this.ty) * applied;
    this.k = k;
    this.takeCamera();
    this.requestFrame();
  }

  private takeCamera() {
    this.autoFit = false;
    this.followId = null;
  }

  // ---- Simulation -------------------------------------------------------------

  private startSimulation() {
    this.simRunning = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches && this.sim) {
      // No animation: work the layout out at once and show the result.
      while (this.sim.alpha() >= this.sim.alphaMin()) {
        this.sim.tick();
        this.ticks += 1;
      }
      this.simRunning = false;
      this.remember();
    }
    this.requestFrame();
  }

  private advance() {
    const { sim } = this;
    if (!sim || !this.simRunning) return;
    const started = performance.now();
    let ticks = 0;
    do {
      sim.tick();
      ticks += 1;
    } while (
      ticks < MAX_TICKS_PER_FRAME &&
      sim.alpha() >= sim.alphaMin() &&
      performance.now() - started < TICK_BUDGET_MS
    );
    this.ticks += ticks;
    if (sim.alpha() < sim.alphaMin() && !this.press?.node) {
      this.simRunning = false;
      this.remember();
    }
  }

  private reheat(alpha: number) {
    const { sim } = this;
    if (!sim) return;
    sim.alpha(Math.max(sim.alpha(), alpha));
    this.simRunning = true;
    this.requestFrame();
  }

  private remember() {
    for (const node of this.nodes) {
      if (node.x !== undefined && node.y !== undefined) layoutMemory.set(node.id, { x: node.x, y: node.y });
    }
  }

  // ---- Frames -----------------------------------------------------------------

  private requestFrame() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.advance();
      this.aimCamera();
      this.draw();
      if (this.simRunning) this.requestFrame();
    });
  }

  private aimCamera() {
    if (this.autoFit) this.applyFit();
    if (this.followId) {
      const node = this.byId.get(this.followId);
      if (node) {
        if (this.followFits) this.fitAround(node);
        this.lookAt(node);
      }
      if (!this.simRunning) this.followId = null;
    }
  }

  private stopFrame() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** Returns whether the canvas changed, which also clears it. */
  private syncSize(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(rect.width * this.dpr);
    const pixelHeight = Math.round(rect.height * this.dpr);
    if (this.canvas.width === pixelWidth && this.canvas.height === pixelHeight) return false;
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    return true;
  }

  // ---- Drawing ----------------------------------------------------------------

  private emphasis(node: SimNode): 'dim' | 'normal' | 'strong' {
    if (this.hovered) {
      if (node === this.hovered || this.neighbors.get(this.hovered.id)?.has(node.id)) return 'strong';
      return 'dim';
    }
    if (this.matches) return this.matches.has(node.id) ? 'strong' : 'dim';
    return 'normal';
  }

  private edgeIsStrong(link: SimLink): boolean {
    if (this.hovered) return link.source === this.hovered || link.target === this.hovered;
    if (this.matches) return this.matches.has(link.source.id) || this.matches.has(link.target.id);
    return true;
  }

  private tracePath(node: SimNode) {
    const { ctx } = this;
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    if (node.shape === 'circle') {
      ctx.moveTo(x + node.radius, y);
      ctx.arc(x, y, node.radius, 0, Math.PI * 2);
      return;
    }
    // Corners sit on a slightly larger circle, so shapes look the same size as circles.
    const reach = node.radius * 1.2;
    shapePoints(node.shape).forEach(([px, py], index) => {
      if (index === 0) ctx.moveTo(x + px * reach, y + py * reach);
      else ctx.lineTo(x + px * reach, y + py * reach);
    });
    ctx.closePath();
  }

  private drawArrow(link: SimLink, unit: number) {
    if (!link.arrowTo) return;
    const { ctx } = this;
    const to = link.arrowTo;
    const from = to === link.target ? link.source : link.target;
    const dx = (to.x ?? 0) - (from.x ?? 0);
    const dy = (to.y ?? 0) - (from.y ?? 0);
    const length = Math.hypot(dx, dy);
    if (length < 1) return;
    const ux = dx / length;
    const uy = dy / length;
    const tipX = (to.x ?? 0) - ux * (to.radius + 2 * unit);
    const tipY = (to.y ?? 0) - uy * (to.radius + 2 * unit);
    const size = 6 * unit;
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55);
    ctx.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55);
    ctx.closePath();
  }

  private draw() {
    this.draws += 1;
    const { ctx, colors, k, tx, ty, dpr, width, height } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);

    // One screen pixel in world units, so lines keep their weight at any zoom.
    const unit = 1 / k;
    const focused = !!this.hovered || !!this.matches;

    const strokeLinks = (keep: (link: SimLink) => boolean, color: string, weight: number, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = weight * unit;
      // One stroke per line on purpose. Thousands of lines in one path takes the GPU far
      // longer to prepare, which measured as 30 ms a frame at 500 pages.
      for (const link of this.links) {
        if (!keep(link)) continue;
        ctx.beginPath();
        ctx.moveTo(link.source.x ?? 0, link.source.y ?? 0);
        ctx.lineTo(link.target.x ?? 0, link.target.y ?? 0);
        ctx.stroke();
      }
    };
    const isRelationship = (link: SimLink) => link.edge.relationships.length > 0;
    if (focused) {
      strokeLinks((l) => !this.edgeIsStrong(l), colors['--border-strong'], 1, DIMMED_ALPHA);
      strokeLinks((l) => this.edgeIsStrong(l) && !isRelationship(l), colors['--text-muted'], 1.25, 1);
      strokeLinks((l) => this.edgeIsStrong(l) && isRelationship(l), colors['--accent'], 2, 1);
    } else {
      strokeLinks((l) => !isRelationship(l), colors['--border-strong'], 1, 1);
      strokeLinks(isRelationship, colors['--text-muted'], 1.75, 1);
    }

    // Arrows only mean something once they are big enough to see.
    if (k > 0.35) {
      ctx.beginPath();
      for (const link of this.links) {
        if (!focused || this.edgeIsStrong(link)) this.drawArrow(link, unit);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = focused ? colors['--accent'] : colors['--text-muted'];
      ctx.fill();
    }

    for (const pass of ['dim', 'normal', 'strong'] as const) {
      ctx.globalAlpha = pass === 'dim' ? DIMMED_ALPHA : 1;
      for (const node of this.nodes) {
        if (this.emphasis(node) !== pass) continue;
        ctx.beginPath();
        this.tracePath(node);
        ctx.fillStyle = colors[node.token as keyof ThemeColors] ?? colors['--text-muted'];
        ctx.fill();
        ctx.lineWidth = 1.5 * unit;
        ctx.strokeStyle = colors['--bg'];
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    const ringed = [this.hovered, this.centerId ? this.byId.get(this.centerId) : null];
    ctx.lineWidth = 2 * unit;
    ctx.strokeStyle = colors['--text'];
    for (const node of ringed) {
      if (!node) continue;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, node.radius * 1.25 + 3 * unit, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Text is drawn in screen space, where its size and crispness do not depend on zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawLabels(width, height);
    ctx.globalAlpha = 1;
  }

  private drawLabels(width: number, height: number) {
    const { ctx, colors, k, tx, ty } = this;
    const fontPx = 0.75 * this.rem;
    const lineHeight = fontPx * 1.35;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';

    // A grid of taken space keeps labels from landing on each other.
    const cellW = this.rem * 0.75;
    const taken = new Set<number>();
    const claim = (x: number, y: number, w: number, h: number): boolean => {
      const x0 = Math.floor((x - w / 2) / cellW);
      const x1 = Math.floor((x + w / 2) / cellW);
      const y0 = Math.floor(y / lineHeight);
      const y1 = Math.floor((y + h) / lineHeight);
      for (let cy = y0; cy <= y1; cy += 1) {
        for (let cx = x0; cx <= x1; cx += 1) {
          if (taken.has(cy * 100000 + cx)) return false;
        }
      }
      for (let cy = y0; cy <= y1; cy += 1) {
        for (let cx = x0; cx <= x1; cx += 1) taken.add(cy * 100000 + cx);
      }
      return true;
    };

    ctx.font = `${fontPx}px ${this.font}`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = colors['--bg'];
    ctx.fillStyle = colors['--text'];

    const ranked = [...this.nodes].sort((a, b) => {
      const pa = this.emphasis(a) === 'strong' ? 1 : 0;
      const pb = this.emphasis(b) === 'strong' ? 1 : 0;
      return pb - pa || b.linkCount - a.linkCount;
    });
    const limit = this.simRunning ? MAX_LABELS_WHILE_MOVING : ranked.length;
    let drawn = 0;
    for (const node of ranked) {
      if (drawn >= limit) break;
      const emphasis = this.emphasis(node);
      if (emphasis === 'dim') continue;
      const sx = (node.x ?? 0) * k + tx;
      const sy = (node.y ?? 0) * k + ty;
      if (sx < -80 || sx > width + 80 || sy < -20 || sy > height + 20) continue;
      const labelY = sy + node.radius * 1.2 * k + 3;
      const text = node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title;
      const textWidth = ctx.measureText(text).width;
      if (!claim(sx, labelY, textWidth, lineHeight) && emphasis !== 'strong') continue;
      if (emphasis === 'strong' || !this.simRunning) ctx.strokeText(text, sx, labelY);
      ctx.fillText(text, sx, labelY);
      drawn += 1;
    }

    // Relationship kinds, once there is room for them or when a page is hovered.
    if (this.simRunning) return;
    const edgeFontPx = 0.6875 * this.rem;
    ctx.font = `${edgeFontPx}px ${this.font}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors['--text-muted'];
    for (const link of this.links) {
      if (!link.label) continue;
      const hoverEdge = !!this.hovered && (link.source === this.hovered || link.target === this.hovered);
      if (!hoverEdge && (k < 0.75 || this.hovered || this.matches)) continue;
      const mx = (((link.source.x ?? 0) + (link.target.x ?? 0)) / 2) * k + tx;
      const my = (((link.source.y ?? 0) + (link.target.y ?? 0)) / 2) * k + ty;
      if (mx < -40 || mx > width + 40 || my < -10 || my > height + 10) continue;
      const textWidth = ctx.measureText(link.label).width;
      if (!claim(mx, my - lineHeight / 2, textWidth, lineHeight) && !hoverEdge) continue;
      ctx.strokeText(link.label, mx, my);
      ctx.fillText(link.label, mx, my);
    }
  }

  // ---- Input ------------------------------------------------------------------

  private toLocal(e: { clientX: number; clientY: number }) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private nodeAt(sx: number, sy: number): SimNode | null {
    let best: SimNode | null = null;
    let bestDistance = Infinity;
    for (const node of this.nodes) {
      const dx = (node.x ?? 0) * this.k + this.tx - sx;
      const dy = (node.y ?? 0) * this.k + this.ty - sy;
      const reach = node.radius * 1.2 * this.k + HIT_PADDING_PX;
      const distance = dx * dx + dy * dy;
      if (distance <= reach * reach && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  private setHovered(node: SimNode | null) {
    if (node === this.hovered) return;
    this.hovered = node;
    this.canvas.style.cursor = node ? 'pointer' : 'grab';
    this.events.onHover(node?.id ?? null);
    this.requestFrame();
  }

  private listen() {
    const { canvas } = this;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      canvas.addEventListener(type, handler, options);
      this.cleanups.push(() => canvas.removeEventListener(type, handler, options));
    };

    on('pointerdown', (e) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      const { x, y } = this.toLocal(e);
      this.press = { id: e.pointerId, x, y, moved: false, node: this.nodeAt(x, y), tx: this.tx, ty: this.ty };
      canvas.style.cursor = 'grabbing';
    });

    on('pointermove', (e) => {
      const { x, y } = this.toLocal(e);
      const { press } = this;
      if (!press || press.id !== e.pointerId) {
        this.setHovered(this.nodeAt(x, y));
        return;
      }
      if (!press.moved && Math.hypot(x - press.x, y - press.y) < CLICK_SLOP_PX) return;
      press.moved = true;
      if (press.node) {
        press.node.fx = (x - this.tx) / this.k;
        press.node.fy = (y - this.ty) / this.k;
        this.autoFit = false;
        this.followId = null;
        this.sim?.alphaTarget(0.25);
        this.reheat(0.25);
      } else {
        this.tx = press.tx + (x - press.x);
        this.ty = press.ty + (y - press.y);
        this.takeCamera();
        this.requestFrame();
      }
    });

    const release = (e: PointerEvent) => {
      const { press } = this;
      if (!press || press.id !== e.pointerId) return;
      this.press = null;
      if (press.node) {
        press.node.fx = null;
        press.node.fy = null;
        this.sim?.alphaTarget(0);
        if (!press.moved && e.type === 'pointerup') {
          this.events.onOpen(press.node.id);
          return;
        }
        this.requestFrame();
      }
      const { x, y } = this.toLocal(e);
      this.canvas.style.cursor = 'grab';
      this.setHovered(this.nodeAt(x, y));
    };
    on('pointerup', release);
    on('pointercancel', release);
    on('pointerleave', () => {
      if (!this.press) this.setHovered(null);
    });

    on(
      'wheel',
      (e) => {
        // Keeps the wheel from scrolling or zooming the page behind the canvas.
        e.preventDefault();
        const { x, y } = this.toLocal(e);
        this.zoomAround(Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED), x, y);
      },
      { passive: false },
    );

    on('contextmenu', (e) => {
      const { x, y } = this.toLocal(e);
      const node = this.nodeAt(x, y);
      if (!node) return;
      e.preventDefault();
      this.events.onContextMenu(node.id, e.clientX, e.clientY);
    });

    on('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const pan = (dx: number, dy: number) => {
        this.tx += dx;
        this.ty += dy;
        this.takeCamera();
        this.requestFrame();
      };
      switch (e.key) {
        case 'ArrowLeft':
          pan(KEY_PAN_PX, 0);
          break;
        case 'ArrowRight':
          pan(-KEY_PAN_PX, 0);
          break;
        case 'ArrowUp':
          pan(0, KEY_PAN_PX);
          break;
        case 'ArrowDown':
          pan(0, -KEY_PAN_PX);
          break;
        case '+':
        case '=':
          this.zoomBy(KEY_ZOOM_FACTOR);
          break;
        case '-':
        case '_':
          this.zoomBy(1 / KEY_ZOOM_FACTOR);
          break;
        case '0':
          this.fit();
          break;
        default:
          return;
      }
      e.preventDefault();
    });

    const parent = canvas.parentElement;
    if (parent) {
      const observer = new ResizeObserver(() => {
        // Observers run after this frame's animation callbacks, so waiting for the next
        // one would put a blank canvas on screen at every step of a resize.
        if (!this.syncSize()) return;
        this.aimCamera();
        this.draw();
      });
      observer.observe(parent);
      this.cleanups.push(() => observer.disconnect());
    }

    // The canvas keeps its own pixels, so it must be told when a theme changes them.
    this.cleanups.push(
      observeTheme(() => {
        this.colors = resolveCssColors(THEME_TOKENS);
        this.font = uiFontFamily();
        this.rem = remPx();
        for (const node of this.nodes) node.radius = nodeRadius(node.linkCount, this.rem);
        this.requestFrame();
      }),
    );

    // Moving the window to a screen with a different scale changes the pixel ratio.
    const watchScale = () => {
      const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const onChange = () => {
        this.syncSize();
        this.requestFrame();
        stop();
        watchScale();
      };
      const stop = () => query.removeEventListener('change', onChange);
      query.addEventListener('change', onChange);
      this.cleanups.push(stop);
    };
    watchScale();
  }

  // ---- For tests --------------------------------------------------------------

  /** Where a page is on the canvas, relative to the window. */
  screenPosition(id: string): { x: number; y: number } | null {
    const node = this.byId.get(id);
    if (!node) return null;
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + (node.x ?? 0) * this.k + this.tx,
      y: rect.top + (node.y ?? 0) * this.k + this.ty,
    };
  }

  debugState() {
    return {
      running: this.simRunning,
      framePending: this.frame !== 0,
      ticks: this.ticks,
      draws: this.draws,
      nodes: this.nodes.length,
      links: this.links.length,
      zoom: this.k,
      hovered: this.hovered?.id ?? null,
      pixelWidth: this.canvas.width,
      cssWidth: this.width,
      background: this.colors['--bg'],
    };
  }
}
