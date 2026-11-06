/**
 * How pictures and videos appear in an editor. Pictures load lazily, so a long article
 * only reads what is near the screen. When something cannot be shown, the view says why
 * rather than leaving a blank box.
 */

import type { Node as ProseNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';

import { assetInfo, assetUrl, onAssetChanged, relinkVideo, type AssetInfo } from '../../lib/assets';
import * as api from '../../lib/api';
import { errorMessage, rpc } from '../../lib/rpc';
import { parseWebUrl, videoSiteName } from '../../media/urls';
import { VIDEO_FILTERS } from '../../media/filters';
import { toast } from '../../shell/toasts';
import { t } from '../../lib/i18n';
import { openImageViewer } from './viewer';

function isFigureChild(view: EditorView, getPos: () => number | undefined): ProseNode | null {
  const pos = getPos();
  if (pos === undefined) return null;
  const parent = view.state.doc.resolve(pos).parent;
  return parent.type.name === 'figure' ? parent : null;
}

function notice(text: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'media-notice';
  box.setAttribute('role', 'status');
  const line = document.createElement('p');
  line.textContent = text;
  box.append(line);
  return box;
}

const STOPPED_EVENTS = new Set(['mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup']);

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** In Read mode a picture is a control that opens the viewer. */
export function syncImageReadMode(image: HTMLImageElement, editable: boolean) {
  if (editable) {
    image.removeAttribute('tabindex');
    image.removeAttribute('role');
  } else {
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
  }
  image.title = editable ? '' : t('View full size');
}

export class ImageView implements NodeView {
  readonly dom: HTMLElement;
  private readonly image: HTMLImageElement;
  private node: ProseNode;
  private shown: string | null = null;
  private readonly stopListening: () => void;

  constructor(
    node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'media-frame';
    this.dom.dataset.media = 'image';
    this.image = document.createElement('img');
    this.image.loading = 'lazy';
    this.image.decoding = 'async';
    this.image.addEventListener('load', () => this.dom.classList.add('is-loaded'));
    this.image.addEventListener('error', () => void this.showProblem());
    this.image.addEventListener('click', this.onClick);
    this.image.addEventListener('dblclick', () => void this.openViewer());
    this.image.addEventListener('keydown', this.onKey);
    this.dom.addEventListener('dragstart', this.onDragStart);
    this.dom.append(this.image);
    this.syncSize();
    this.syncAlt();
    syncImageReadMode(this.image, view.editable);
    void this.load();
    // Replacing a picture keeps its id, so the new bytes come with a new address.
    this.stopListening = onAssetChanged((id) => {
      if (id === this.node.attrs.assetId) void this.load();
    });
  }

  destroy() {
    this.stopListening();
  }

  /** Reserves the picture's space before it loads, so the page does not jump around. */
  private syncSize() {
    const { width, height } = this.node.attrs;
    if (width && height) {
      this.image.width = Number(width);
      this.image.height = Number(height);
    }
  }

  private syncAlt() {
    const figure = isFigureChild(this.view, this.getPos);
    const fromFigure = figure
      ? String(figure.attrs.description || figure.lastChild?.textContent || '')
      : '';
    this.image.alt = fromFigure || String(this.node.attrs.alt ?? '');
  }

  private async load() {
    const { assetId, src } = this.node.attrs as { assetId: string | null; src: string | null };
    this.clearProblem();
    if (assetId) {
      const url = await assetUrl(assetId);
      this.shown = url;
      this.image.src = url;
    } else if (src && /^(data:image\/|blob:)/i.test(src)) {
      this.shown = src;
      this.image.src = src;
    } else {
      this.shown = null;
      this.image.removeAttribute('src');
      // Remote pictures are never fetched. The web view has no business reaching the network.
      this.showNotice(
        src
          ? t('This picture is on the web, so it is not shown here: {address}', { address: src })
          : t('This picture has no image.'),
      );
    }
  }

  private clearProblem() {
    this.dom.querySelector('.media-notice')?.remove();
    this.image.hidden = false;
  }

  private showNotice(text: string) {
    this.clearProblem();
    this.image.hidden = true;
    this.dom.append(notice(text));
  }

  private async showProblem() {
    const { assetId } = this.node.attrs as { assetId: string | null };
    if (!assetId) {
      this.showNotice(t('This picture could not be shown.'));
      return;
    }
    try {
      await assetInfo(assetId);
      this.showNotice(t('This picture is stored in the project, but its format could not be shown here.'));
    } catch {
      this.showNotice(t('This picture is no longer in the project.'));
    }
  }

  private async openViewer() {
    if (!this.shown) return;
    const figure = isFigureChild(this.view, this.getPos);
    openImageViewer(this.shown, figure?.lastChild?.textContent ?? '', this.image.alt);
  }

  private readonly onClick = () => {
    if (!this.view.editable) void this.openViewer();
  };

  private readonly onKey = (event: KeyboardEvent) => {
    if (!this.view.editable && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      void this.openViewer();
    }
  };

  private readonly onDragStart = (event: DragEvent) => {
    if (!this.view.editable) {
      event.preventDefault();
      return;
    }
    // Inside a figure, the figure's own handler moves the whole thing.
    if (isFigureChild(this.view, this.getPos)) return;
    const pos = this.getPos();
    if (pos !== undefined) {
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
    }
  };

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.assetId !== this.node.attrs.assetId || node.attrs.src !== this.node.attrs.src;
    this.node = node;
    this.syncSize();
    if (changed) void this.load();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

/**
 * Whether this is an MP4 or QuickTime file on a Windows computer that cannot play H.264, the
 * usual codec in them. Windows plays it through its own media features, which the N editions
 * leave out until the Media Feature Pack is added, so the writer is told that instead of
 * blaming the file.
 */
function lacksMp4Player(mime: string): boolean {
  if (!/^video\/(mp4|quicktime|x-m4v)$/i.test(mime) || !navigator.userAgent.includes('Windows')) return false;
  return document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') === '';
}

/** One observer for every video: a video attaches its source when it comes on screen. */
const offScreen = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;

function whenOnScreen(element: Element, callback: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    callback();
    return () => {};
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        offScreen.get(entry.target)?.();
        offScreen.delete(entry.target);
        observer?.unobserve(entry.target);
      }
    }
  });
  offScreen.set(element, callback);
  observer.observe(element);
  return () => {
    offScreen.delete(element);
    observer?.unobserve(element);
  };
}

export class VideoView implements NodeView {
  readonly dom: HTMLElement;
  private node: ProseNode;
  private video: HTMLVideoElement | null = null;
  private stopWatching: () => void = () => {};
  private revision = 0;

  constructor(node: ProseNode, private readonly view: EditorView) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'media-frame';
    this.dom.dataset.media = 'video';
    this.dom.addEventListener('dragstart', (event) => {
      if (!this.view.editable) event.preventDefault();
    });
    this.render();
  }

  private render() {
    this.stopWatching();
    this.dom.replaceChildren();
    this.video = null;
    const { assetId, url } = this.node.attrs as { assetId: string | null; url: string | null };
    if (url) this.renderCard(url);
    else if (assetId) this.renderStored(assetId);
    else this.dom.append(notice(t('This video has no file.')));
  }

  /** A link to a video elsewhere. Only the address is shown, and nothing is loaded. */
  private renderCard(url: string) {
    this.dom.dataset.media = 'video-link';
    const card = document.createElement('div');
    card.className = 'video-card';
    const parsed = parseWebUrl(url);
    const site = document.createElement('div');
    site.className = 'video-card-site';
    site.textContent = (parsed ? videoSiteName(parsed) : null) ?? t('Video on the web');
    const address = document.createElement('div');
    address.className = 'video-card-address';
    address.textContent = url;
    address.title = url;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-sm video-card-open';
    open.textContent = t('Open in browser');
    open.addEventListener('click', () => {
      void api.app.openExternal(url).catch((e) => toast(errorMessage(e), 'error'));
    });
    card.append(site, address, open);
    this.dom.append(card);
  }

  private renderStored(assetId: string) {
    this.dom.dataset.media = 'video';
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.addEventListener('error', () => void this.showProblem(assetId));
    video.addEventListener('loadedmetadata', () => {
      // Sound with no picture is a codec the web view cannot show, not a blank clip.
      if (video.videoWidth === 0) {
        this.addNote(t("This video's picture cannot be shown here. Its sound may still play."));
      }
      void this.fillMeasure(assetId, video);
    });
    this.video = video;
    this.dom.append(video);
    void this.showLinkedState(assetId, video);
    this.stopWatching = whenOnScreen(this.dom, () => void this.attachSource(assetId));
  }

  private async attachSource(assetId: string) {
    if (!this.video) return;
    const url = await assetUrl(assetId);
    // Relinking keeps the id, so a fresh address makes the media stack start over.
    this.video.src = this.revision ? `${url}?r=${this.revision}` : url;
  }

  private async fillMeasure(assetId: string, video: HTMLVideoElement) {
    if (!this.view.editable || !Number.isFinite(video.duration)) return;
    const info = await assetInfo(assetId).catch(() => null);
    if (!info || info.duration) return;
    await rpc('media.setMeasure', {
      id: assetId,
      width: video.videoWidth || undefined,
      height: video.videoHeight || undefined,
      duration: video.duration,
    }).catch(() => {});
  }

  private async showLinkedState(assetId: string, video: HTMLVideoElement) {
    const info = await assetInfo(assetId).catch(() => null);
    if (!info?.linked || this.video !== video) return;
    if (info.missing) {
      this.showMissing(info);
      return;
    }
    const badge = document.createElement('div');
    badge.className = 'media-linked';
    badge.textContent = t('Linked file');
    badge.title = `${info.path ?? ''}\n${t('This file is not stored in the project, so it will not travel with it.')}`;
    this.dom.append(badge);
  }

  private addNote(text: string) {
    if (this.dom.querySelector('.media-notice')) return;
    this.dom.append(notice(text));
  }

  private replaceVideoWith(box: HTMLElement) {
    this.stopWatching();
    this.video?.removeAttribute('src');
    this.video?.remove();
    this.video = null;
    this.dom.querySelector('.media-notice')?.remove();
    this.dom.querySelector('.media-linked')?.remove();
    this.dom.append(box);
  }

  private showMissing(info: AssetInfo) {
    const box = notice(t('The linked file is missing: {path}', { path: info.path ?? info.name }));
    const relink = document.createElement('button');
    relink.type = 'button';
    relink.className = 'btn btn-sm media-relink';
    relink.textContent = t('Relink…');
    relink.addEventListener('click', () => void this.relink(info.id));
    box.append(relink);
    this.replaceVideoWith(box);
  }

  private async relink(assetId: string) {
    try {
      const picked = await api.files.pickOpen({ title: t('Find the video'), filters: VIDEO_FILTERS });
      if (picked.length === 0) return;
      await relinkVideo(assetId, picked[0]);
      this.revision += 1;
      this.render();
    } catch (e) {
      toast(t('Could not relink: {error}', { error: errorMessage(e) }), 'error');
    }
  }

  private async showProblem(assetId: string) {
    let info: AssetInfo;
    try {
      info = await assetInfo(assetId);
    } catch {
      this.replaceVideoWith(notice(t('This video is no longer in the project.')));
      return;
    }
    if (info.missing) {
      this.showMissing(info);
      return;
    }
    if (lacksMp4Player(info.mime)) {
      this.replaceVideoWith(
        notice(
          info.linked
            ? t('This video cannot be played here, because this computer cannot play MP4 videos. On Windows N editions, adding the Media Feature Pack in Settings > Apps > Optional features fixes this. The file is safe where it is.')
            : t('This video cannot be played here, because this computer cannot play MP4 videos. On Windows N editions, adding the Media Feature Pack in Settings > Apps > Optional features fixes this. It is still stored in the project.'),
        ),
      );
      return;
    }
    this.replaceVideoWith(
      notice(
        info.linked
          ? t('This video cannot be played here, possibly because of an unusual format. The file is safe where it is.')
          : t('This video cannot be played here, possibly because of an unusual format. It is still stored in the project.'),
      ),
    );
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.assetId !== this.node.attrs.assetId || node.attrs.url !== this.node.attrs.url;
    this.node = node;
    if (changed) this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  /** The player's controls and the buttons belong to themselves, not the editor. */
  stopEvent(event: Event): boolean {
    const target = event.target as Element | null;
    if (!target?.closest?.('video, button')) return false;
    return STOPPED_EVENTS.has(event.type);
  }

  destroy() {
    this.stopWatching();
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
  }
}
