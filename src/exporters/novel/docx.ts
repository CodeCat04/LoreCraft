/**
 * The novel as a Word document, with real heading styles so Word's navigation pane
 * works. Book layout by default, or standard manuscript format: 12 point, double spaced,
 * one-inch margins, a running head with author, title and page number.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  Footer,
  FrameAnchorType,
  FrameWrap,
  Header,
  HeadingLevel,
  HorizontalPositionAlign,
  ImageRun,
  LevelFormat,
  LineRuleType,
  NumberFormat,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  VerticalPositionAlign,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx';

import { figureInfo, figureToLine, type FigureInfo } from '../../editor/convert';
import { t } from '../../lib/i18n';
import type { PmNode } from '../../lib/types';
import type { AssetMeta, ExportInput } from '../types';
import { languageTag, xmlSafe } from '../util';
import { loadImage, type LoadedImage } from './images';
import type { MatterSection } from './matter';
import { figureNumberer, outlineBooks, roundedWords, type BookOutline, type ChapterOutline } from './structure';

/** Twips per inch, and pixels per inch at Word's assumed resolution. */
const TWIPS = 1440;
const PIXELS = 96;

const BOOK_FONT = 'Georgia';
const MANUSCRIPT_FONT = 'Times New Roman';
const CODE_FONT = 'Consolas';

/** Text width on a Letter page with one-inch margins. */
const COLUMN_INCHES = 6.5;

const STYLE = {
  first: 'FirstParagraph',
  body: 'BodyText',
  sceneBreak: 'SceneBreak',
  caption: 'Caption',
  quote: 'Quote',
  code: 'CodeBlock',
  author: 'Author',
  manuscriptHead: 'ManuscriptHead',
  matter: 'MatterText',
  matterCentered: 'MatterCentered',
};

/** A cover fills this much of a Letter page with one-inch margins. */
const COVER_INCHES = { width: 6.5, height: 8.75 };

interface Ctx {
  input: ExportInput;
  manuscript: boolean;
  images: Map<string, LoadedImage | null>;
  assets: Map<string, AssetMeta>;
  next: (kind: string) => number;
  notes: Record<string, { children: Paragraph[] }>;
  noteCount: number;
  /** A separate numbering instance per list, so each ordered list restarts. */
  listInstance: number;
}

function runOptions(node: PmNode) {
  const marks = new Set((node.marks ?? []).map((m) => m.type));
  return {
    bold: marks.has('bold') || undefined,
    italics: marks.has('italic') || undefined,
    underline: marks.has('underline') ? {} : undefined,
    strike: marks.has('strike') || undefined,
    font: marks.has('code') ? CODE_FONT : undefined,
  };
}

function inlineRuns(nodes: PmNode[] | undefined, ctx: Ctx): ParagraphChild[] {
  const runs: ParagraphChild[] = [];
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') {
      runs.push(new TextRun({ break: 1 }));
    } else if (node.type === 'reference') {
      ctx.noteCount += 1;
      ctx.notes[String(ctx.noteCount)] = {
        children: [new Paragraph({ children: [new TextRun(xmlSafe(String(node.attrs?.text ?? '')))] })],
      };
      runs.push(new FootnoteReferenceRun(ctx.noteCount));
    } else if (node.type === 'text') {
      const link = node.marks?.find((m) => m.type === 'link');
      const run = new TextRun({ text: node.text ?? '', ...runOptions(node) });
      const href = link ? String(link.attrs?.href ?? '') : '';
      if (/^(https?:|mailto:)/i.test(href)) {
        runs.push(new ExternalHyperlink({ link: href, children: [new TextRun({ text: node.text ?? '', style: 'Hyperlink', ...runOptions(node) })] }));
      } else {
        runs.push(run);
      }
    }
  }
  return runs;
}

/** How wide a figure sits, as a share of the column. */
function figureShare(info: FigureInfo): number {
  if (info.width) return Math.min(100, info.width) / 100;
  if (info.align === 'full') return 1;
  if (info.align === 'center') return 0.6;
  return 0.4;
}

function imageParagraphs(node: PmNode, info: FigureInfo, media: PmNode, ctx: Ctx): Paragraph[] {
  const captionNode = node.content?.find((c) => c.type === 'figcaption');
  const assetId = String(media.attrs?.assetId ?? '');
  const image = assetId ? ctx.images.get(assetId) : null;
  const captionRuns: ParagraphChild[] = [
    new TextRun({ text: `${info.name}. `, bold: true }),
    ...inlineRuns(captionNode?.content, ctx),
  ];
  if (!image) {
    if (assetId) {
      const name = ctx.assets.get(assetId)?.name;
      ctx.input.warn?.(
        name
          ? t('{name} could not be placed in the document, so its label stands in for it.', { name })
          : t('A picture could not be placed in the document, so its label stands in for it.'),
      );
    }
    return [new Paragraph({ style: STYLE.caption, children: [new TextRun({ text: figureToLine(info) })] })];
  }
  const share = figureShare(info);
  const widthPx = Math.round(COLUMN_INCHES * PIXELS * share);
  const heightPx = Math.round(widthPx * (image.height / Math.max(1, image.width)));
  const run = new ImageRun({
    type: image.type,
    data: image.bytes,
    transformation: { width: widthPx, height: heightPx },
    altText: { name: info.name, title: info.name, description: info.description || info.caption || info.name },
  });
  // A manuscript stays in one plain column, whatever the figure asks for.
  const wraps = !ctx.manuscript && (info.align === 'left' || info.align === 'right');
  // Two paragraphs with the same frame share it, so the label stays with the picture
  // and the text wraps around both.
  const frame: IParagraphOptions['frame'] = wraps
    ? {
        type: 'alignment',
        width: Math.round(widthPx * (TWIPS / PIXELS)),
        wrap: FrameWrap.AROUND,
        anchor: { horizontal: FrameAnchorType.MARGIN, vertical: FrameAnchorType.TEXT },
        alignment: {
          x: info.align === 'left' ? HorizontalPositionAlign.LEFT : HorizontalPositionAlign.RIGHT,
          y: VerticalPositionAlign.TOP,
        },
        space: { horizontal: 200, vertical: 100 },
      }
    : undefined;
  const alignment = wraps ? undefined : AlignmentType.CENTER;
  return [
    new Paragraph({ frame, alignment, keepNext: true, children: [run] }),
    new Paragraph({ frame, alignment, style: STYLE.caption, children: captionRuns }),
  ];
}

/** Word requires every table cell to hold at least one paragraph. */
function cellContent(cell: PmNode, ctx: Ctx): Paragraph[] {
  const blocks = blocksToDocx(cell.content, ctx, { inCell: true, header: cell.type === 'tableHeader' });
  const paragraphs = blocks.filter((b) => b instanceof Paragraph);
  return paragraphs.length > 0 ? paragraphs : [new Paragraph({})];
}

function tableToDocx(table: PmNode, ctx: Ctx): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: '888888' };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: (table.content ?? []).map(
      (row) =>
        new TableRow({
          children: (row.content ?? []).map(
            (cell) =>
              new TableCell({
                columnSpan: Number(cell.attrs?.colspan ?? 1),
                rowSpan: Number(cell.attrs?.rowspan ?? 1),
                children: cellContent(cell, ctx),
              }),
          ),
        }),
    ),
  });
}

function figureToDocx(node: PmNode, ctx: Ctx): (Paragraph | Table)[] {
  const info = figureInfo(node, ctx.next(String(node.attrs?.kind ?? 'figure')));
  const media = node.content?.find((c) => c.type !== 'figcaption');
  const captionNode = node.content?.find((c) => c.type === 'figcaption');
  const caption = () =>
    new Paragraph({
      style: STYLE.caption,
      children: [new TextRun({ text: `${info.name}. `, bold: true }), ...inlineRuns(captionNode?.content, ctx)],
    });
  if (media?.type === 'table') return [tableToDocx(media, ctx), caption()];
  if (media?.type === 'image') return imageParagraphs(node, info, media, ctx);
  if (media?.attrs?.url) {
    const url = String(media.attrs.url);
    return [
      new Paragraph({
        style: STYLE.caption,
        children: [
          new TextRun({ text: `${info.name}. `, bold: true }),
          ...inlineRuns(captionNode?.content, ctx),
          new TextRun({ text: ' ' }),
          new ExternalHyperlink({ link: url, children: [new TextRun({ text: url, style: 'Hyperlink' })] }),
        ],
      }),
    ];
  }
  // A Word document cannot play a video, so it says what was here.
  const asset = media?.attrs?.assetId ? ctx.assets.get(String(media.attrs.assetId)) : undefined;
  const file = asset ? ` (video file: ${xmlSafe(asset.name)})` : '';
  return [new Paragraph({ style: STYLE.caption, children: [new TextRun({ text: `${figureToLine(info)}${file}` })] })];
}

interface BlockOptions {
  /** A chapter's first paragraph and any after a break have no indent. */
  noIndent?: boolean;
  inCell?: boolean;
  header?: boolean;
  quote?: boolean;
  /** Every paragraph takes this style, for pages that are not running prose. */
  paragraphStyle?: string;
}

function listToDocx(list: PmNode, ctx: Ctx, level: number, options: BlockOptions): (Paragraph | Table)[] {
  const ordered = list.type === 'orderedList';
  const instance = ordered ? (ctx.listInstance += 1) : 0;
  const out: (Paragraph | Table)[] = [];
  for (const item of list.content ?? []) {
    let first = true;
    for (const block of item.content ?? []) {
      if (block.type === 'bulletList' || block.type === 'orderedList') {
        out.push(...listToDocx(block, ctx, level + 1, options));
      } else if (block.type === 'paragraph' && first) {
        out.push(
          new Paragraph({
            numbering: { reference: ordered ? 'ordered-list' : 'bullet-list', level: Math.min(level, 8), instance },
            children: inlineRuns(block.content, ctx),
          }),
        );
      } else {
        out.push(...blocksToDocx([block], ctx, { ...options, noIndent: true }));
      }
      first = false;
    }
  }
  return out;
}

function blocksToDocx(nodes: PmNode[] | undefined, ctx: Ctx, options: BlockOptions = {}): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  let noIndent = options.noIndent ?? false;
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'paragraph': {
        const children = inlineRuns(node.content, ctx);
        if (options.inCell) {
          const shown = options.header
            ? (node.content ?? []).map((n) => (n.type === 'text' ? new TextRun({ text: n.text ?? '', bold: true }) : null)).filter((r): r is TextRun => r !== null)
            : children;
          out.push(new Paragraph({ children: shown }));
        } else if (options.quote) {
          out.push(new Paragraph({ style: STYLE.quote, children }));
        } else if (options.paragraphStyle) {
          out.push(new Paragraph({ style: options.paragraphStyle, children }));
        } else {
          out.push(new Paragraph({ style: noIndent ? STYLE.first : STYLE.body, children }));
          noIndent = false;
        }
        break;
      }
      case 'heading':
        out.push(new Paragraph({ heading: HeadingLevel.HEADING_4, keepNext: true, children: inlineRuns(node.content, ctx) }));
        noIndent = true;
        break;
      case 'blockquote':
        out.push(...blocksToDocx(node.content, ctx, { ...options, quote: true }));
        noIndent = true;
        break;
      case 'bulletList':
      case 'orderedList':
        out.push(...listToDocx(node, ctx, 0, options));
        noIndent = true;
        break;
      case 'codeBlock': {
        const lines = (node.content ?? []).map((c) => c.text ?? '').join('').split('\n');
        out.push(
          new Paragraph({
            style: STYLE.code,
            children: lines.map((line, i) => new TextRun({ text: line, break: i > 0 ? 1 : undefined })),
          }),
        );
        noIndent = true;
        break;
      }
      case 'horizontalRule':
        out.push(new Paragraph({ style: STYLE.sceneBreak, children: [new TextRun(ctx.manuscript ? '#' : '* * *')] }));
        noIndent = true;
        break;
      case 'figure':
        out.push(...figureToDocx(node, ctx));
        noIndent = true;
        break;
      case 'table':
        out.push(tableToDocx(node, ctx), new Paragraph({ style: STYLE.first }));
        noIndent = true;
        break;
      case 'image':
        out.push(...figureToDocx({ type: 'figure', attrs: { kind: 'figure', align: 'center' }, content: [node, { type: 'figcaption' }] }, ctx));
        noIndent = true;
        break;
      case 'video':
        out.push(...figureToDocx({ type: 'figure', attrs: { kind: 'video', align: 'center' }, content: [node, { type: 'figcaption' }] }, ctx));
        noIndent = true;
        break;
      default:
        break;
    }
  }
  return out;
}

/** Which heading style each level of the book uses, so Word's outline nests properly. */
function headingLevels(outline: BookOutline, manyBooks: boolean) {
  const order = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
  const base = manyBooks ? 1 : 0;
  return {
    book: order[0],
    part: order[base],
    chapter: order[base + (outline.hasParts ? 1 : 0)],
    scene: order[base + (outline.hasParts ? 2 : 1)],
  };
}

function coverChildren(outline: BookOutline, ctx: Ctx): Paragraph[] {
  const id = outline.book.matter?.coverAssetId;
  const image = id ? ctx.images.get(id) : null;
  if (!id) return [];
  if (!image) {
    ctx.input.warn?.(t('The cover of {book} could not be placed in the document.', { book: outline.book.title }));
    return [];
  }
  const scale = Math.min((COVER_INCHES.width * PIXELS) / image.width, (COVER_INCHES.height * PIXELS) / image.height);
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new ImageRun({
          type: image.type,
          data: image.bytes,
          transformation: { width: Math.round(image.width * scale), height: Math.round(image.height * scale) },
          altText: { name: 'Cover', title: 'Cover', description: `Cover of ${xmlSafe(outline.book.title)}` },
        }),
      ],
    }),
  ];
}

/** A page of front matter, which has no heading. Dedications sit a little way down the page. */
function frontMatterChildren(section: MatterSection, ctx: Ctx): (Paragraph | Table)[] {
  const centered = section.key !== 'copyright';
  return [
    new Paragraph({ pageBreakBefore: true, spacing: { after: centered ? 2400 : 4800 } }),
    ...blocksToDocx(section.doc.content, ctx, { paragraphStyle: centered ? STYLE.matterCentered : STYLE.matter }),
  ];
}

function backMatterChildren(section: MatterSection, ctx: Ctx, heading: ReturnType<typeof headingLevels>['chapter']): (Paragraph | Table)[] {
  return [
    new Paragraph({ heading, pageBreakBefore: true, children: [new TextRun(xmlSafe(section.title))] }),
    ...blocksToDocx(section.doc.content, ctx, { paragraphStyle: STYLE.matter }),
  ];
}

/** Everything before the first chapter: cover, title page and front matter. */
function frontChildren(outline: BookOutline, ctx: Ctx, manyBooks: boolean): (Paragraph | Table)[] {
  const { book } = outline;
  const levels = headingLevels(outline, manyBooks);
  const out: (Paragraph | Table)[] = coverChildren(outline, ctx);
  const title = xmlSafe(book.title);
  const author = xmlSafe(book.author);
  const hasCover = out.length > 0;

  if (ctx.manuscript) {
    out.push(
      new Paragraph({
        style: STYLE.manuscriptHead,
        tabStops: [{ type: TabStopType.RIGHT, position: COLUMN_INCHES * TWIPS }],
        children: [new TextRun(author || 'Author'), new TextRun({ text: `\tabout ${roundedWords(outline.wordCount)} words` })],
      }),
    );
  }
  if (book.matter?.titlePage !== false) {
    out.push(
      new Paragraph({
        heading: manyBooks ? levels.book : HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        pageBreakBefore: hasCover,
        spacing: { before: ctx.manuscript ? 3600 : 2400 },
        children: [new TextRun(title)],
      }),
    );
    if (book.subtitle) {
      out.push(new Paragraph({ style: 'Subtitle', alignment: AlignmentType.CENTER, children: [new TextRun(xmlSafe(book.subtitle))] }));
    }
    if (author) {
      out.push(new Paragraph({ style: STYLE.author, children: [new TextRun(`by ${author}`)] }));
    }
  }
  for (const section of book.matter?.front ?? []) out.push(...frontMatterChildren(section, ctx));
  return out;
}

/** The chapters and back matter. The first needs no break if a new section starts here. */
function bodyChildren(outline: BookOutline, ctx: Ctx, manyBooks: boolean, breakFirst: boolean): (Paragraph | Table)[] {
  const { book } = outline;
  const levels = headingLevels(outline, manyBooks);
  const out: (Paragraph | Table)[] = [];
  let first = !breakFirst;
  const pageBreak = () => {
    const needed = !first;
    first = false;
    return needed;
  };

  const addChapter = (chapter: ChapterOutline) => {
    out.push(
      new Paragraph({
        heading: levels.chapter,
        pageBreakBefore: pageBreak(),
        children: [new TextRun(xmlSafe(chapter.title))],
      }),
    );
    chapter.scenes.forEach((scene, index) => {
      const titled = ctx.input.options.sceneTitles && scene.node.title.trim();
      if (titled) {
        out.push(new Paragraph({ heading: levels.scene, keepNext: true, children: [new TextRun(xmlSafe(scene.node.title.trim()))] }));
      } else if (index > 0) {
        out.push(new Paragraph({ style: STYLE.sceneBreak, children: [new TextRun(ctx.manuscript ? '#' : '* * *')] }));
      }
      out.push(...blocksToDocx(scene.doc.content, ctx, { noIndent: true }));
    });
  };

  for (const item of outline.items) {
    if (item.type === 'part') {
      out.push(
        new Paragraph({
          heading: levels.part,
          pageBreakBefore: pageBreak(),
          alignment: AlignmentType.CENTER,
          spacing: { before: 2400 },
          children: [new TextRun(xmlSafe(item.title))],
        }),
      );
      item.chapters.forEach(addChapter);
    } else {
      addChapter(item);
    }
  }
  if (ctx.manuscript) {
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 480 }, children: [new TextRun('THE END')] }));
  }
  for (const section of book.matter?.back ?? []) out.push(...backMatterChildren(section, ctx, levels.chapter));
  return out;
}

function runningHead(book: BookOutline['book']): Header {
  const surname = xmlSafe(book.author).trim().split(/\s+/).pop() ?? '';
  const parts = [surname, xmlSafe(book.title)].filter(Boolean).join(' / ');
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { line: 240, lineRule: LineRuleType.AUTO },
        children: [new TextRun({ text: `${parts} / ` }), new TextRun({ children: [PageNumber.CURRENT] })],
      }),
    ],
  });
}

function pageNumberFooter(): Footer {
  return new Footer({
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT] })] })],
  });
}

export async function exportDocx(input: ExportInput): Promise<Uint8Array> {
  const { snapshot, options } = input;
  const manuscript = options.manuscriptFormat;
  const font = manuscript ? MANUSCRIPT_FONT : BOOK_FONT;
  const line = manuscript ? 480 : 300;
  const size = manuscript ? 24 : 23;
  const indent = manuscript ? TWIPS / 2 : TWIPS / 4;

  const outlines = outlineBooks(snapshot);
  const assets = new Map(snapshot.assets.map((a) => [a.id, a]));
  const images = new Map<string, LoadedImage | null>();
  for (const asset of snapshot.assets) {
    if (asset.mime.startsWith('image/')) images.set(asset.id, await loadImage(asset, input));
  }

  const ctx: Ctx = {
    input,
    manuscript,
    images,
    assets,
    next: figureNumberer(),
    notes: {},
    noteCount: 0,
    listInstance: 0,
  };

  const manyBooks = outlines.length > 1;
  const page = {
    size: { width: 12240, height: 15840 },
    margin: { top: TWIPS, right: TWIPS, bottom: TWIPS, left: TWIPS, header: 708, footer: 708 },
  };
  const sections = outlines.flatMap((outline, index) => {
    ctx.next = figureNumberer();
    const front = frontChildren(outline, ctx, manyBooks);
    // Front matter goes in a section of its own, so that it has no numbers and the first
    // chapter starts at page 1. A plain book or manuscript keeps its title page with its text,
    // and so does a book with nothing after it, which would otherwise end in an empty section.
    const hasMatter = Boolean(outline.book.matter) && front.length > 0;
    const body = bodyChildren(outline, ctx, manyBooks, !hasMatter);
    const separate = hasMatter && body.length > 0;
    input.progress?.(index + 1, outlines.length);
    const main = {
      properties: {
        titlePage: true,
        page: separate ? { ...page, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } } : page,
      },
      // Word requires a paragraph in every header and footer, even an empty one.
      headers: manuscript ? { default: runningHead(outline.book), first: new Header({ children: [new Paragraph({})] }) } : undefined,
      footers: manuscript ? undefined : { default: pageNumberFooter(), first: new Footer({ children: [new Paragraph({})] }) },
      children: separate ? body : [...front, ...body],
    };
    return separate ? [{ properties: { page }, children: front }, main] : [main];
  });

  const first = outlines[0]?.book;
  const projectName = xmlSafe(snapshot.meta.name ?? '');
  const heading = (points: number, extra: Record<string, unknown> = {}) => ({
    run: { font, size: points * 2, bold: !manuscript, color: '000000' },
    paragraph: { keepNext: true, spacing: { before: 240, after: 240, line: 276, lineRule: LineRuleType.AUTO }, ...extra },
  });

  const doc = new Document({
    title: outlines.length === 1 ? xmlSafe(first?.title ?? '') : projectName,
    creator: first ? xmlSafe(first.author) || 'LoreCraft' : 'LoreCraft',
    lastModifiedBy: 'LoreCraft',
    description: xmlSafe(outlines.length === 1 ? (first?.publishing?.description ?? '') : '') || 'Exported from LoreCraft',
    subject: xmlSafe(outlines.length === 1 ? (first?.publishing?.series ?? '') : '') || undefined,
    footnotes: ctx.notes,
    styles: {
      default: {
        document: {
          // Word checks spelling by this tag, so "pt_BR" becomes "pt-BR", and "English" becomes "en".
          run: { font, size, language: { value: languageTag(options.language).tag } },
          paragraph: { spacing: { line, lineRule: LineRuleType.AUTO } },
        },
        title: { run: { font, size: 56, bold: !manuscript, color: '000000' }, paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 240, line: 276, lineRule: LineRuleType.AUTO } } },
        heading1: heading(manuscript ? 12 : 20, manuscript ? { alignment: AlignmentType.CENTER, spacing: { before: 2880, after: 480, line: 240, lineRule: LineRuleType.AUTO } } : { alignment: AlignmentType.CENTER, spacing: { before: 1200, after: 480, line: 276, lineRule: LineRuleType.AUTO } }),
        heading2: heading(manuscript ? 12 : 16, manuscript ? { alignment: AlignmentType.CENTER, spacing: { before: 2880, after: 480, line: 240, lineRule: LineRuleType.AUTO } } : { alignment: AlignmentType.CENTER }),
        heading3: heading(manuscript ? 12 : 14),
        heading4: heading(12),
      },
      paragraphStyles: [
        { id: STYLE.body, name: 'Body Text', basedOn: 'Normal', quickFormat: true, paragraph: { indent: { firstLine: indent }, alignment: manuscript ? AlignmentType.LEFT : AlignmentType.JUSTIFIED } },
        { id: STYLE.first, name: 'First Paragraph', basedOn: 'Normal', quickFormat: true, paragraph: { indent: { firstLine: manuscript ? indent : 0 }, alignment: manuscript ? AlignmentType.LEFT : AlignmentType.JUSTIFIED } },
        { id: STYLE.sceneBreak, name: 'Scene Break', basedOn: 'Normal', quickFormat: true, paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 240, after: 240 } } },
        { id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal', quickFormat: true, run: { size: 32, italics: true }, paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 240, line: 276, lineRule: LineRuleType.AUTO } } },
        { id: STYLE.author, name: 'Author', basedOn: 'Normal', quickFormat: true, run: { size: manuscript ? 24 : 28 }, paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 480 } } },
        { id: STYLE.matter, name: 'Matter Text', basedOn: 'Normal', quickFormat: true, paragraph: { spacing: { after: 120 } } },
        { id: STYLE.matterCentered, name: 'Dedication', basedOn: 'Normal', quickFormat: true, paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 120 } } },
        { id: STYLE.manuscriptHead, name: 'Manuscript Head', basedOn: 'Normal', paragraph: { spacing: { line: 240, lineRule: LineRuleType.AUTO } } },
        { id: STYLE.caption, name: 'Caption', basedOn: 'Normal', quickFormat: true, run: { size: 19 }, paragraph: { spacing: { before: 60, after: 160, line: 240, lineRule: LineRuleType.AUTO } } },
        { id: STYLE.quote, name: 'Quote', basedOn: 'Normal', quickFormat: true, run: { italics: true }, paragraph: { indent: { left: 576, right: 576 }, spacing: { before: 120, after: 120 } } },
        { id: STYLE.code, name: 'Code Block', basedOn: 'Normal', run: { font: CODE_FONT, size: 19 }, paragraph: { spacing: { before: 120, after: 120, line: 240, lineRule: LineRuleType.AUTO } } },
      ],
      // The library's own character styles (Hyperlink, the note references) are based on
      // this one but leave it out. Word always defines it, so a reference to it resolves.
      characterStyles: [{ id: 'DefaultParagraphFont', name: 'Default Paragraph Font', uiPriority: 1, semiHidden: true, unhideWhenUsed: true }],
    },
    numbering: {
      config: [
        {
          reference: 'bullet-list',
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.BULLET,
            text: ['•', '◦', '▪'][level % 3],
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
          })),
        },
        {
          reference: 'ordered-list',
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 300 } } },
          })),
        },
      ],
    },
    sections,
  });
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}
