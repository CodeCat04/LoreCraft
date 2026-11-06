/**
 * Runs in the hidden print window. It takes the document from the native side, puts it
 * on the page, loads its pictures and fonts, and then asks for the PDF. A separate window
 * has its own renderer process, so a long layout does not freeze the main window.
 */

import { invoke } from '@tauri-apps/api/core';

import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/400-italic.css';
import '@fontsource/source-serif-4/700.css';
import '@fontsource/source-serif-4/700-italic.css';
import '@fontsource/libertinus-serif/400.css';
import '@fontsource/libertinus-serif/400-italic.css';
import '@fontsource/libertinus-serif/700.css';
import '@fontsource/courier-prime/400.css';
import '@fontsource/courier-prime/400-italic.css';
import '@fontsource/courier-prime/700.css';
import '@fontsource/courier-prime/700-italic.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';

import '../../styles/print.css';
import printCss from '../../styles/print.css?raw';

import { readAssetBase64 } from '../assets';
import { ASSET_URL_PREFIX, NO_HEAD_STYLE, RUNNING_HEAD_ATTRIBUTE, headStyles, headWords } from './constants';
import { glyphSampleText, marginBoxFonts, namedPageRules, pageNamesFromMarkers } from './native';

interface Job {
  title: string;
  language: string;
  css: string;
  html: string;
  /**
   * The engine draws no @page margin boxes and marks no link targets in the PDF (WebKitGTK
   * on Linux). Pages are then found from marker text, and the native side adds the boxes.
   */
  native?: boolean;
  /** For `native`: the @page box the engine should lay out, which is not the paper's. */
  layoutCss?: string;
}

interface Measured {
  pages: number;
  destinations: Record<string, number>;
  /** The page each marker fell on, by its number. Only when `native`. */
  markers?: Record<string, number>;
}

let native = false;
/** Every style sheet the page uses for its @page rules, for the native side. */
const pageCss: string[] = [];

/**
 * Takes no room, so placing markers does not move where pages break. The engine also draws
 * whatever reaches over a page's edge on the page beside it, so a marker's letters sit just
 * inside its element: below the top for a start, above the bottom for an end.
 */
const MARKER_STYLE = 'float: left; width: 0; height: 0; overflow: visible; white-space: nowrap; font: 6px/6px sans-serif;';
const END_MARKER_STYLE = `${MARKER_STYLE} position: relative; top: -8px;`;
let markerCount = 0;

function marker(end = false): { element: HTMLSpanElement; key: string } {
  markerCount += 1;
  const element = document.createElement('span');
  element.setAttribute('style', end ? END_MARKER_STYLE : MARKER_STYLE);
  element.textContent = `LCMK${markerCount}Q`;
  return { element, key: String(markerCount) };
}

/**
 * Chromium rounds each line's height to a whole pixel and WebKit drops the fraction, so
 * WebKit would fit about one more line on every page. Whole-pixel heights, read before any
 * is set so each comes from the style sheet, make both engines agree.
 */
function wholePixelLineHeights() {
  const elements = [...document.body.querySelectorAll<HTMLElement>('*')];
  const heights = elements.map((element) => getComputedStyle(element).lineHeight);
  elements.forEach((element, index) => {
    const height = heights[index];
    if (!height.endsWith('px')) return;
    const pixels = Number.parseFloat(height);
    if (Number.isFinite(pixels)) element.style.lineHeight = `${Math.round(pixels)}px`;
  });
}

/** The page each element starts on, from markers placed at its start. */
async function nativeMeasure(elements: HTMLElement[], idPrefix: string): Promise<Record<string, number>> {
  const placed = elements.map((element, index) => {
    element.id ||= `${idPrefix}-${index + 1}`;
    const mark = marker();
    element.prepend(mark.element);
    return { id: element.id, ...mark };
  });
  const measured = await call<Measured>('print.measure');
  const pages: Record<string, number> = {};
  for (const { id, element, key } of placed) {
    element.remove();
    const page = measured.markers?.[key];
    if (page && !(id in pages)) pages[id] = page;
  }
  return pages;
}

/**
 * One last measuring print, for what the native side needs to draw the margin boxes: the
 * named page of every page, and every letter the boxes use in each of their fonts, so the
 * PDF holds those fonts for it to borrow.
 */
async function nativeLayout(): Promise<{ css: string; pageNames: string[] }> {
  const css = pageCss.join('\n');
  const named: { element: HTMLElement; name: string }[] = [];
  for (const { selector, name } of namedPageRules(`${printCss}\n${css}`)) {
    let found: HTMLElement[] = [];
    try {
      found = [...document.querySelectorAll<HTMLElement>(selector)];
    } catch {
      continue;
    }
    for (const element of found) named.push({ element, name });
  }
  // In document order, so a named page inside another one wins.
  named.sort((a, b) =>
    a.element === b.element ? 0 : a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
  const placed = named.map(({ element, name }) => {
    const start = marker();
    const end = marker(true);
    element.prepend(start.element);
    element.append(end.element);
    return { name, start: start.key, end: end.key, elements: [start.element, end.element] };
  });
  const samples = document.createElement('div');
  samples.setAttribute('style', 'position: absolute; top: 0; left: 0; width: 0; height: 0; overflow: visible; white-space: nowrap;');
  const letters = glyphSampleText(css);
  for (const font of marginBoxFonts(css)) {
    const sample = document.createElement('span');
    sample.style.fontFamily = font.family;
    sample.style.fontStyle = font.italic ? 'italic' : 'normal';
    sample.style.fontWeight = font.bold ? '700' : '400';
    sample.style.fontSize = '6px';
    sample.textContent = letters;
    samples.append(sample);
  }
  document.body.prepend(samples);
  await document.fonts.ready;
  const measured = await call<Measured>('print.measure');
  samples.remove();
  placed.forEach((p) => p.elements.forEach((element) => element.remove()));
  return { css, pageNames: pageNamesFromMarkers(measured.pages, placed, measured.markers ?? {}) };
}

function call<T>(method: string, params?: unknown): Promise<T> {
  return invoke<T>('rpc', { method, params: params ?? null });
}

function blobUrl(base64: string, mime: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** A browser works out the real type of an image from its bytes, so this need not be exact. */
const ANY_IMAGE = 'image/png';

/** Each image's file is fetched once, however many times it appears. */
async function loadPictures(root: DocumentFragment) {
  const pictures = [...root.querySelectorAll('img')].filter((img) =>
    (img.getAttribute('src') ?? '').startsWith(ASSET_URL_PREFIX),
  );
  const urls = new Map<string, string | null>();
  for (const img of pictures) {
    const id = (img.getAttribute('src') ?? '').slice(ASSET_URL_PREFIX.length);
    if (!urls.has(id)) {
      const base64 = await readAssetBase64(id);
      urls.set(id, base64 === null ? null : blobUrl(base64, ANY_IMAGE));
    }
    const url = urls.get(id);
    if (url) {
      img.setAttribute('src', url);
    } else {
      const note = document.createElement('em');
      note.textContent = `[image: ${img.getAttribute('alt') ?? ''}]`;
      img.replaceWith(note);
    }
  }
}

async function settled() {
  const images = [...document.images];
  await Promise.all(images.map((img) => img.decode().catch(() => undefined)));
  // Reading a size forces layout, which is what starts any font that is needed.
  void document.body.offsetHeight;
  await document.fonts.ready;
}

/**
 * The PDF only marks where things are if something links to them, so this adds hidden
 * links to these elements, giving each an id if it has none. Remove them after measuring.
 */
function linkTo(elements: HTMLElement[], idPrefix: string): HTMLAnchorElement[] {
  return elements.map((element, index) => {
    element.id ||= `${idPrefix}-${index + 1}`;
    const probe = document.createElement('a');
    probe.href = `#${element.id}`;
    probe.hidden = true;
    document.body.append(probe);
    return probe;
  });
}

/**
 * The browser engine treats `break-before: right` as an ordinary page break, so this
 * measures where each page falls and adds the blank pages itself. A blank page cannot change
 * what comes after it, because left and right pages hold the same width of text.
 */
async function startOnRightHandPages() {
  const starts = [...document.querySelectorAll<HTMLElement>('[data-right-page]')];
  if (starts.length === 0) return;
  let destinations: Record<string, number>;
  if (native) {
    destinations = await nativeMeasure(starts, 'right-page');
  } else {
    const probes = linkTo(starts, 'right-page');
    const measured = await call<{ destinations: Record<string, number> }>('print.measure');
    probes.forEach((probe) => probe.remove());
    destinations = measured.destinations;
  }
  let added = 0;
  for (const start of starts) {
    const page = destinations[start.id];
    if (page && (page + added) % 2 === 0) {
      const blank = document.createElement('div');
      blank.className = 'blank-page new-page';
      start.before(blank);
      added += 1;
    }
  }
}

/**
 * Leaves the running heads off the page each chapter opens on, as books do. The heads are
 * counter styles of the page number (see `RUNNING_HEAD_ATTRIBUTE`), so this narrows each
 * pair to the pages after that one. It assumes the page counter is never reset, so that
 * counter(page) is the page's place in the PDF.
 */
function quietOpeningPages(openers: HTMLElement[], destinations: Record<string, number>) {
  const rules = openers.flatMap((opener) => {
    const name = opener.getAttribute(RUNNING_HEAD_ATTRIBUTE) ?? '';
    const page = destinations[opener.id];
    // The name goes into a style sheet, so it must be one the document builder made.
    if (!/^running-\d+$/.test(name) || !page) return [];
    const words = headWords(name);
    const styles = headStyles(name);
    const range = `range: ${page + 1} infinite; fallback: ${NO_HEAD_STYLE};`;
    return [
      `@counter-style ${styles.left} { system: extends ${words.left}; ${range} }`,
      `@counter-style ${styles.right} { system: extends ${words.right}; ${range} }`,
    ];
  });
  if (rules.length === 0) return;
  const style = document.createElement('style');
  style.textContent = rules.join('\n');
  document.head.append(style);
  pageCss.push(style.textContent);
}

/**
 * From one more pass at the layout: real page numbers in the table of contents, and no
 * running head where a chapter opens. Neither changes where the pages break.
 */
async function fillPageNumbers() {
  const slots = [...document.querySelectorAll<HTMLElement>('[data-page-of]')];
  const openers = [...document.querySelectorAll<HTMLElement>(`[${RUNNING_HEAD_ATTRIBUTE}]`)];
  if (slots.length === 0 && openers.length === 0) return;
  let destinations: Record<string, number>;
  if (native) {
    const targets = slots
      .map((slot) => document.getElementById(slot.dataset.pageOf ?? ''))
      .filter((target): target is HTMLElement => target !== null);
    destinations = await nativeMeasure([...openers, ...targets], 'chapter-start');
  } else {
    const probes = linkTo(openers, 'chapter-start');
    const measured = await call<{ pages: number; destinations: Record<string, number> }>('print.measure');
    probes.forEach((probe) => probe.remove());
    destinations = measured.destinations;
  }
  quietOpeningPages(openers, destinations);
  for (const slot of slots) {
    const page = destinations[slot.dataset.pageOf ?? ''];
    if (page) slot.textContent = String(page);
    // Without a number, the leader dots would point at nothing.
    else slot.parentElement?.querySelector('.toc-dots')?.remove();
    if (!page) slot.remove();
  }
  await document.fonts.ready;
}

async function run() {
  const job = await call<Job>('print.job');
  document.title = job.title;
  document.documentElement.lang = job.language;
  native = job.native === true;
  const style = document.createElement('style');
  style.textContent = job.css;
  document.head.append(style);
  pageCss.push(job.css);
  if (native) {
    // After the document's own rules, so these win. WebKit also drops a margin at the top
    // of a page even after a forced break, where Chromium keeps it, so a chapter title
    // would start higher. A block formatting context keeps the margin inside the section.
    const layout = document.createElement('style');
    layout.textContent = `.new-page, [data-right-page] { display: flow-root; }\n${job.layoutCss ?? ''}`;
    document.head.append(layout);
  }
  // Inside a template, nothing loads until it is ready.
  const template = document.createElement('template');
  template.innerHTML = job.html;
  await loadPictures(template.content);
  document.body.append(template.content);
  await settled();
  if (native) wholePixelLineHeights();
  await startOnRightHandPages();
  await fillPageNumbers();
  await call('print.finish', native ? await nativeLayout() : undefined);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : (error as { message?: string })?.message ?? String(error);
  void call('print.fail', { message });
});
