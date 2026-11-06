/**
 * XML: well-formed XML 1.0 with the structure described in docs/IMPORT_FORMAT.md.
 * Characters XML cannot hold, such as most control characters, are removed.
 */

import { describeFigures, pmToMarkdown, pmToPlainText } from '../../editor/convert';
import type { Node, PmNode } from '../../lib/types';
import { childrenByParent } from '../scope';
import type { ExportInput } from '../types';
import { utf8, xmlAttr, xmlSafeDoc, xmlText } from '../util';

const NAMESPACE = 'https://github.com/CodeCat04/LoreCraft/ns/export/1';

function attrs(values: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([name, value]) => ` ${name}="${xmlAttr(String(value))}"`)
    .join('');
}

function element(name: string, text: string, attributes: Parameters<typeof attrs>[0] = {}): string {
  const open = `${name}${attrs(attributes)}`;
  return text ? `<${open}>${xmlText(text)}</${name}>` : `<${open}/>`;
}

function list(wrapper: string, item: string, values: string[]): string {
  if (values.length === 0) return '';
  return `<${wrapper}>${values.map((v) => element(item, v)).join('')}</${wrapper}>`;
}

function figuresXml(doc: PmNode): string {
  const items = describeFigures(doc).map((f) =>
    `<figure${attrs({ name: f.name, kind: f.kind, media: f.media, align: f.align, width: f.width, asset: f.assetId, url: f.url })}>` +
    `${element('caption', f.caption)}${f.description ? element('description', f.description) : ''}</figure>`,
  );
  return items.length > 0 ? `<figures>${items.join('')}</figures>` : '';
}

function body(name: string, doc: PmNode, input: ExportInput): string {
  const clean = xmlSafeDoc(doc);
  const prosemirror = input.options.bodyFormat === 'prosemirror';
  const value = prosemirror ? JSON.stringify(clean) : pmToMarkdown(clean);
  return (
    `<${name} format="${prosemirror ? 'prosemirror-json' : 'markdown'}">${xmlText(value)}</${name}>` +
    `${element('text', pmToPlainText(clean))}${figuresXml(clean)}`
  );
}

export function exportXml(input: ExportInput): Uint8Array {
  const { snapshot } = input;
  const titleOf = new Map(snapshot.pages.map((p) => [p.id, p.title]));
  const children = childrenByParent(snapshot.nodes);

  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<!-- LoreCraft export. The structure is described in docs/IMPORT_FORMAT.md. -->\n',
    `<lorebook${attrs({ xmlns: NAMESPACE, version: 1, exportedAt: input.exportedAt, name: snapshot.meta.name })}>\n`,
  ];

  out.push('<pages>\n');
  for (const page of snapshot.pages) {
    const box = page.infobox;
    out.push(
      `<page${attrs({
        id: page.id, title: page.title, type: page.pageType, status: page.status, home: page.isHome || null,
        words: page.wordCount, created: page.createdAt, updated: page.updatedAt, revealNode: page.revealNodeId,
        localOnly: page.localOnly || null,
      })}>`,
      page.summary ? element('summary', page.summary) : '',
      list('aliases', 'alias', page.aliases),
      list('categories', 'category', page.categories),
      box?.fields?.length || box?.imageAssetId || box?.caption
        ? `<infobox${attrs({ image: box.imageAssetId, caption: box.caption })}>${(box.fields ?? [])
            .map((f) => element('field', f.value, { key: f.key, label: f.label, kind: f.kind }))
            .join('')}</infobox>`
        : '',
      body('body', page.content, input),
      page.notes ? `<talk>${body('body', page.notes, input)}</talk>` : '',
      '</page>\n',
    );
  }
  out.push('</pages>\n');

  const nodeXml = (node: Node): string => {
    const kids = (children.get(node.id) ?? []).map(nodeXml).join('');
    return (
      `<${node.kind}${attrs({
        id: node.id, title: node.title, status: node.status, pov: node.povPageId ? titleOf.get(node.povPageId) : null,
        storyDate: node.storyDate, words: node.wordCount || null, targetWords: node.targetWords || null,
        created: node.createdAt, updated: node.updatedAt, localOnly: node.localOnly || null,
      })}>` +
      (node.synopsis ? element('synopsis', node.synopsis) : '') +
      (node.notes ? element('notes', node.notes) : '') +
      (node.kind === 'scene' ? body('body', node.content, input) : '') +
      `${kids}</${node.kind}>\n`
    );
  };

  out.push('<books>\n');
  for (const book of snapshot.books) {
    out.push(
      `<book${attrs({
        id: book.id, title: book.title, subtitle: book.subtitle, author: book.author,
        targetWords: book.targetWords || null, created: book.createdAt, updated: book.updatedAt,
      })}>\n`,
      ...(children.get(null) ?? []).filter((n) => n.bookId === book.id).map(nodeXml),
      '</book>\n',
    );
  }
  out.push('</books>\n');

  out.push('<relationships>\n');
  for (const r of snapshot.relationships) {
    out.push(`${element('relationship', r.note, {
      from: titleOf.get(r.fromPageId), to: titleOf.get(r.toPageId), fromId: r.fromPageId, toId: r.toPageId, kind: r.kind,
    })}\n`);
  }
  out.push('</relationships>\n</lorebook>\n');
  return utf8(out.join(''));
}
