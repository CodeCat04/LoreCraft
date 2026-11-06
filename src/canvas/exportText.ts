/**
 * Lays out a text card's Markdown for the PNG export, as the card shows it: headings larger
 * and bold, list items with their bullet or number and a hanging indent, paragraphs apart,
 * and words wrapped at the card's width. Words too long for a line are broken.
 * Pure, given a way to measure text, so it can be tested without a canvas.
 */

export interface TextStyle {
  size: number;
  bold: boolean;
  italic?: boolean;
  mono?: boolean;
}

export interface LaidLine {
  text: string;
  x: number;
  /** The baseline, from the top of the text area. */
  y: number;
  style: TextStyle;
}

export type Measure = (text: string, style: TextStyle) => number;

const BODY: TextStyle = { size: 14, bold: false };
const HEADING_SIZES = [22, 19, 17, 15, 14, 14];
const LINE_HEIGHT = 1.45;

/** Inline Markdown reduced to the words a reader sees. */
export function plainInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '');
}

interface Block {
  text: string;
  style: TextStyle;
  /** Drawn before the first line, in the indent. */
  marker?: string;
  indent: number;
  gapBefore: number;
}

function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let fence = false;
  let gap = 0;
  const flush = () => {
    if (paragraph.length) blocks.push({ text: paragraph.join(' '), style: BODY, indent: 0, gapBefore: gap });
    paragraph = [];
    gap = 0.5;
  };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) {
      blocks.push({ text: line, style: { size: 13, bold: false, mono: true }, indent: 0, gapBefore: 0 });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const size = HEADING_SIZES[heading[1].length - 1];
      blocks.push({ text: plainInline(heading[2].replace(/\s+#+\s*$/, '')), style: { size, bold: true }, indent: 0, gapBefore: blocks.length ? 0.6 : 0 });
      gap = 0.3;
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (item) {
      flush();
      const depth = Math.floor(item[1].replace(/\t/g, '  ').length / 2);
      const box = item[3] === undefined ? null : item[3] === ' ' ? '☐' : '☑';
      const marker = box ?? (/\d/.test(item[2]) ? item[2] : '•');
      blocks.push({ text: plainInline(item[4]), style: BODY, marker, indent: depth, gapBefore: 0 });
      gap = 0.5;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push({ text: plainInline(quote[1]), style: { ...BODY, italic: true }, marker: '│', indent: 0, gapBefore: 0 });
      gap = 0.5;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      continue;
    }
    paragraph.push(plainInline(line.trim()));
  }
  flush();
  return blocks;
}

/** Splits `text` into lines no wider than `width`. */
export function wrapWords(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  let row = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = row ? `${row} ${word}` : word;
    if (measure(test) <= width) {
      row = test;
      continue;
    }
    if (row) lines.push(row);
    row = '';
    if (measure(word) <= width) {
      row = word;
      continue;
    }
    // A word wider than the line: break it where it must.
    let piece = '';
    for (const char of word) {
      if (piece && measure(piece + char) > width) {
        lines.push(piece);
        piece = '';
      }
      piece += char;
    }
    row = piece;
  }
  if (row) lines.push(row);
  return lines.length ? lines : [''];
}

/** Every line of a text card, until `maxHeight` is reached. */
export function layoutText(markdown: string, width: number, maxHeight: number, measure: Measure): LaidLine[] {
  const out: LaidLine[] = [];
  let y = 0;
  for (const block of blocksOf(markdown)) {
    const lineHeight = block.style.size * LINE_HEIGHT;
    y += block.gapBefore * BODY.size;
    const indent = block.indent * 16 + (block.marker ? Math.max(16, measure(`${block.marker} `, block.style)) : 0);
    const lines = wrapWords(block.text, Math.max(10, width - indent), (text) => measure(text, block.style));
    for (const [i, text] of lines.entries()) {
      if (y + lineHeight > maxHeight) return out;
      const baseline = y + block.style.size;
      if (i === 0 && block.marker) out.push({ text: block.marker, x: block.indent * 16, y: baseline, style: block.style });
      out.push({ text, x: indent, y: baseline, style: block.style });
      y += lineHeight;
    }
  }
  return out;
}

/** The canvas `font` for a style, in the board's own font family. */
export function cssFont(style: TextStyle, family: string): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.size}px ${style.mono ? 'monospace' : family}`;
}
