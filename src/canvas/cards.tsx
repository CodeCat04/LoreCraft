/**
 * What each kind of card shows. Everything from the project or the writer goes through
 * `renderMarkdownSafe` or `pmToHtml`. Web pages load only in sandboxed frames, and only once
 * the writer asks, because loading one contacts that site.
 */

import { memo, useEffect, useState, type CSSProperties } from 'react';

import * as api from '../lib/api';
import { assetInfo, assetUrlNow, type AssetInfo } from '../lib/assets';
import { t } from '../lib/i18n';
import type { PmNode } from '../lib/types';
import { pmToHtml, renderMarkdownSafe } from '../editor/convert';
import { followRenderedLink } from '../editor/renderedLinks';
import { useDataVersion } from '../state/events';
import { useTitles } from '../state/project';
import { canvases } from './api';
import { DocCardEditor } from './docEditor';
import { AudioCard } from './cards/AudioCard';
import { PdfCard } from './cards/PdfCard';
import { colorVar } from './colors';
import { parseRef, safeWebUrl, youtubeEmbedUrl, type CanvasNode, type LoreRef } from './model';

/**
 * The most a web card's frame may do. No same-origin: the page gets an opaque origin, so it
 * can keep nothing and reach nothing of ours. No top navigation, so it can never replace the
 * app, and no popups, which would open windows of their own.
 */
export const WEB_SANDBOX = 'allow-scripts allow-forms';
/** YouTube's player needs its own origin to play. The address is always youtube-nocookie.com. */
export const VIDEO_SANDBOX = 'allow-scripts allow-same-origin';

/** Only part of a document: from a heading to the next heading at its level or above. */
export function sliceToHeading(doc: PmNode, heading: string | undefined): PmNode {
  const range = headingRange(doc, heading);
  if (!range) return doc;
  return { ...doc, content: (doc.content ?? []).slice(range[0], range[1]) };
}

/** The blocks `sliceToHeading` takes, as [start, end), or null if the heading is not there. */
export function headingRange(doc: PmNode, heading: string | undefined): [number, number] | null {
  if (!heading) return null;
  const blocks = doc.content ?? [];
  const textOf = (n: PmNode): string => (n.text ?? '') + (n.content ?? []).map(textOf).join('');
  const key = heading.trim().toLowerCase();
  const start = blocks.findIndex((b) => b.type === 'heading' && textOf(b).trim().toLowerCase() === key);
  if (start < 0) return null;
  const level = Number(blocks[start].attrs?.level ?? 1);
  let end = start + 1;
  while (end < blocks.length && !(blocks[end].type === 'heading' && Number(blocks[end].attrs?.level ?? 1) <= level)) end++;
  return [start, end];
}

/**
 * Puts an edited section back into the whole document, in place of the blocks it came from.
 * The range is taken once when editing starts, so renaming the heading itself still works.
 * Without a range, the edit was of the whole document.
 */
export function spliceRange(doc: PmNode, range: [number, number] | null, part: PmNode): PmNode {
  if (!range) return part;
  const blocks = doc.content ?? [];
  return { ...doc, content: [...blocks.slice(0, range[0]), ...(part.content ?? []), ...blocks.slice(range[1])] };
}

/** The headings in a document, for narrowing a card to one. */
export function headingsOf(doc: PmNode): string[] {
  const textOf = (n: PmNode): string => (n.text ?? '') + (n.content ?? []).map(textOf).join('');
  return (doc.content ?? []).filter((b) => b.type === 'heading').map((b) => textOf(b).trim()).filter(Boolean);
}

function docHtml(doc: PmNode): string {
  return pmToHtml(doc, { assetSrc: (id) => assetUrlNow(id), remoteImages: false, wikiHref: () => '#' });
}

export interface CardProps {
  node: CanvasNode;
  editing: boolean;
  /** The new text, and how much taller the card must be to show it all. */
  onEditText: (text: string, grow: number) => void;
  onStopEditing: () => void;
  onOpen: (ref: LoreRef) => void;
}

function TextCard({ node, editing, onEditText, onStopEditing }: CardProps) {
  if (editing) {
    return (
      <textarea
        className="canvas-text-editor"
        aria-label={t('Card text')}
        autoFocus
        defaultValue={node.text ?? ''}
        onChange={(e) => onEditText(e.target.value, Math.max(0, e.target.scrollHeight - e.target.clientHeight))}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onStopEditing();
        }}
        onBlur={onStopEditing}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      />
    );
  }
  const text = node.text ?? '';
  return text.trim() ? (
    <div className="canvas-md" onClick={followRenderedLink} dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(text) }} />
  ) : (
    <div className="canvas-placeholder">{t('Double-click to write')}</div>
  );
}

function PageCard({ loreRef, onOpen }: { loreRef: LoreRef; onOpen: CardProps['onOpen'] }) {
  const version = useDataVersion(loreRef.kind === 'page' ? 'pageContent' : 'nodeContent', 'pages', 'nodes');
  const [state, setState] = useState<{ title: string; html: string } | null | 'missing'>(null);
  useEffect(() => {
    let cancelled = false;
    const load = loreRef.kind === 'page' ? api.pages.get(loreRef.id) : api.nodes.get(loreRef.id);
    load.then(
      (doc) => {
        if (cancelled) return;
        if (doc.deletedAt) return setState('missing');
        setState({ title: doc.title || t('Untitled scene'), html: docHtml(sliceToHeading(doc.content, loreRef.heading)) });
      },
      () => !cancelled && setState('missing'),
    );
    return () => {
      cancelled = true;
    };
  }, [loreRef.kind, loreRef.id, loreRef.heading, version]);
  if (state === 'missing') return <div className="canvas-placeholder">{t('This was deleted or is in the trash.')}</div>;
  if (!state) return <div className="canvas-placeholder">{t('Loading…')}</div>;
  return (
    <>
      <div className="canvas-card-head">
        <span className="canvas-kind">{loreRef.kind === 'page' ? t('Page') : t('Scene')}</span>
        <button type="button" className="canvas-card-title linklike" onClick={() => onOpen(loreRef)}>
          {state.title}
          {loreRef.heading ? ` › ${loreRef.heading}` : ''}
        </button>
      </div>
      <div className="canvas-md canvas-doc" onClick={followRenderedLink} dangerouslySetInnerHTML={{ __html: state.html }} />
    </>
  );
}

function AssetCard({ id }: { id: string }) {
  const [info, setInfo] = useState<AssetInfo | null | 'missing'>(null);
  useEffect(() => {
    let cancelled = false;
    assetInfo(id).then(
      (found) => !cancelled && setInfo(found),
      () => !cancelled && setInfo('missing'),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (info === 'missing') return <div className="canvas-placeholder">{t('This file is not in the project.')}</div>;
  if (!info) return <div className="canvas-placeholder">{t('Loading…')}</div>;
  const src = assetUrlNow(id);
  if (info.kind === 'pdf') return <PdfCard info={info} />;
  if (info.kind === 'audio') return <AudioCard info={info} />;
  if (info.kind === 'video') return <video className="canvas-media" src={src} controls preload="metadata" aria-label={info.label || info.name} />;
  return <img className="canvas-media" src={src} alt={info.description || info.label || info.name} draggable={false} />;
}

function CanvasRefCard({ id, onOpen }: { id: string; onOpen: CardProps['onOpen'] }) {
  const version = useDataVersion('canvases');
  const [title, setTitle] = useState<string | null | false>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    canvases.get(id).then(
      (c) => {
        if (cancelled) return;
        setTitle(c.deletedAt ? false : c.title);
        setCount(c.data.nodes.length);
      },
      () => !cancelled && setTitle(false),
    );
    return () => {
      cancelled = true;
    };
  }, [id, version]);
  if (title === false) return <div className="canvas-placeholder">{t('This was deleted or is in the trash.')}</div>;
  return (
    <div className="canvas-nested">
      <span className="canvas-kind">{t('Canvas')}</span>
      <strong>{title ?? '…'}</strong>
      <span className="canvas-faint">{t('{count} cards', { count })}</span>
      <button type="button" className="btn btn-sm" onClick={() => onOpen({ kind: 'canvas', id })}>
        {t('Open canvas')}
      </button>
    </div>
  );
}

function FileCard(props: CardProps) {
  const ref = parseRef(props.node.file);
  if (!ref) return <div className="canvas-placeholder">{t('A file outside the project: {name}', { name: props.node.file ?? '' })}</div>;
  if ((ref.kind === 'page' || ref.kind === 'scene') && props.editing) return <DocCardEditor loreRef={ref} onStop={props.onStopEditing} />;
  if (ref.kind === 'page' || ref.kind === 'scene') return <PageCard loreRef={ref} onOpen={props.onOpen} />;
  if (ref.kind === 'canvas') return <CanvasRefCard id={ref.id} onOpen={props.onOpen} />;
  return <AssetCard id={ref.id} />;
}

/** Remembers which web cards the writer has chosen to load, for this session only. */
const loadedWeb = new Set<string>();

function LinkCard({ node }: CardProps) {
  const url = safeWebUrl(node.url);
  const video = youtubeEmbedUrl(node.url);
  const [loaded, setLoaded] = useState(() => loadedWeb.has(node.id));
  if (!url) return <div className="canvas-placeholder">{t('Only web addresses that start with http or https can be shown.')}</div>;
  const host = new URL(url).hostname;
  if (!loaded) {
    return (
      <div className="canvas-web-gate">
        <span className="canvas-kind">{video ? t('YouTube video') : t('Web page')}</span>
        <strong className="canvas-url">{host}</strong>
        <span className="canvas-faint">{t('Loading it contacts {site}.', { site: host })}</span>
        <button
          type="button"
          className="btn btn-sm"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            loadedWeb.add(node.id);
            setLoaded(true);
          }}
        >
          {video ? t('Load this video') : t('Load this page')}
        </button>
      </div>
    );
  }
  return (
    <iframe
      className="canvas-frame"
      title={video ? t('YouTube video') : host}
      src={video ?? url}
      sandbox={video ? VIDEO_SANDBOX : WEB_SANDBOX}
      referrerPolicy="no-referrer"
      allow={video ? 'encrypted-media; picture-in-picture; fullscreen' : ''}
      loading="lazy"
    />
  );
}

function CardBody(props: CardProps) {
  switch (props.node.type) {
    case 'text':
      return <TextCard {...props} />;
    case 'file':
      return <FileCard {...props} />;
    case 'link':
      return <LinkCard {...props} />;
    default:
      return null;
  }
}

/** A short name for a card, for screen readers. */
export function describeNode(node: CanvasNode, titleOf: (ref: LoreRef) => string | undefined): string {
  if (node.type === 'group') return t('Group: {label}', { label: node.label || t('Untitled group') });
  if (node.type === 'link') return t('Web card: {url}', { url: node.url ?? '' });
  if (node.type === 'file') {
    const ref = parseRef(node.file);
    return t('Card: {name}', { name: (ref && titleOf(ref)) || node.file || '' });
  }
  const first = (node.text ?? '').trim().split('\n')[0].slice(0, 60);
  return t('Text card: {text}', { text: first || t('empty') });
}

export interface NodeViewProps extends CardProps {
  selected: boolean;
  onLabel?: (label: string) => void;
}

/** One card or group on the board. Drawn only when its node or selection changes. */
export const NodeView = memo(function NodeView(props: NodeViewProps) {
  const { node, selected } = props;
  const titles = useTitles((s) => s.byId);
  const style: CSSProperties = {
    transform: `translate(${node.x}px, ${node.y}px)`,
    width: node.width,
    height: node.height,
  };
  const color = colorVar(node.color);
  if (color) (style as Record<string, string>)['--card-color'] = color;
  const label = describeNode(node, (ref) => (ref.kind === 'page' ? titles.get(ref.id)?.title : undefined));
  const handles = (
    <>
      {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
        <span key={side} className={`canvas-handle canvas-handle-${side}`} data-handle={side} aria-hidden="true" />
      ))}
      <span className="canvas-resize" data-resize="1" aria-hidden="true" />
    </>
  );
  if (node.type === 'group') {
    return (
      <div
        className={`canvas-node canvas-group${selected ? ' is-selected' : ''}${color ? ' has-color' : ''}`}
        style={style}
        data-node-id={node.id}
        tabIndex={0}
        role="group"
        aria-label={label}
        aria-selected={selected}
      >
        {props.editing ? (
          <input
            className="canvas-group-label-edit"
            aria-label={t('Group name')}
            autoFocus
            defaultValue={node.label ?? ''}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' || e.key === 'Escape') props.onStopEditing();
            }}
            onChange={(e) => props.onLabel?.(e.target.value)}
            onBlur={props.onStopEditing}
          />
        ) : (
          <div className="canvas-group-label" data-group-label="1">
            {node.label || t('Untitled group')}
          </div>
        )}
        {handles}
      </div>
    );
  }
  return (
    <div
      className={`canvas-node canvas-card canvas-card-${node.type}${selected ? ' is-selected' : ''}${color ? ' has-color' : ''}${props.editing ? ' is-editing' : ''}`}
      style={style}
      data-node-id={node.id}
      tabIndex={0}
      role="article"
      aria-label={label}
      aria-selected={selected}
    >
      <div className="canvas-card-body">
        <CardBody {...props} />
      </div>
      {handles}
    </div>
  );
});
