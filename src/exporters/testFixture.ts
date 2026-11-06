/**
 * A project built to be awkward, used by every exporter's tests: accented and non-Latin
 * names, characters that mean something to each format, control characters, emoji, empty
 * pages, deep lists, tables, red links, references and one figure of each kind.
 */

import type { Node, Page, PmNode } from '../lib/types';
import { applyScope } from './scope';
import { DEFAULT_OPTIONS, type ExportInput, type ExportOptions, type ExportSnapshot } from './types';
import { bytesToBase64 } from './util';

export const AWKWARD_TEXT =
  'Quotes "double" and \'single\', <angle> & ampersand, ]]> CDATA end, [[not a link]], {{not a template}}, control\u0001char\u000B, emoji 🐉, Éowyn Þórr Łukasz 龍 Ελληνικά Русский العربية.';

/** A real 1 by 1 PNG. */
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const VIDEO = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

const when = '2024-03-01T10:20:30.000Z';

export const text = (value: string, ...marks: NonNullable<PmNode['marks']>): PmNode =>
  marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value };
export const link = (label: string, target: string): PmNode => text(label, { type: 'wikiLink', attrs: { target } });
export const para = (...content: PmNode[]): PmNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
export const heading = (level: number, value: string): PmNode => ({ type: 'heading', attrs: { level }, content: [text(value)] });
export const doc = (...content: PmNode[]): PmNode => ({ type: 'doc', content });

function figure(kind: string, align: string, media: PmNode, caption: PmNode[], description = '', width: number | null = null): PmNode {
  return {
    type: 'figure',
    attrs: { kind, align, width, description },
    content: [media, caption.length ? { type: 'figcaption', content: caption } : { type: 'figcaption' }],
  };
}

function nestedList(depth: number): PmNode {
  const item: PmNode[] = [para(text(`Level ${depth}`))];
  if (depth > 1) item.push(nestedList(depth - 1));
  return { type: depth % 2 ? 'orderedList' : 'bulletList', content: [{ type: 'listItem', content: item }] };
}

const cell = (type: string, value: PmNode[], colspan = 1): PmNode => ({ type, attrs: { colspan, rowspan: 1 }, content: [para(...value)] });

export const TABLE: PmNode = {
  type: 'table',
  content: [
    { type: 'tableRow', content: [cell('tableHeader', [text('Name')]), cell('tableHeader', [text('Rank | Order')])] },
    { type: 'tableRow', content: [cell('tableCell', [text('Aria <Vale> & Co')]), cell('tableCell', [link('Silver', 'Silver Vale')])] },
    { type: 'tableRow', content: [cell('tableCell', [text('Across both')], 2)] },
  ],
};

export const ALL_FIGURES: PmNode[] = [
  figure('figure', 'right', { type: 'image', attrs: { assetId: 'asset-map', alt: '' } }, [text('The road north')], 'A map of the northern road', 45),
  figure('picture', 'left', { type: 'image', attrs: { assetId: 'asset-portrait', alt: '' } }, [text('Aria, by '), link('Silver', 'Silver Vale')]),
  figure('table', 'center', TABLE, [text('Her ranks')]),
  figure('video', 'full', { type: 'video', attrs: { assetId: 'asset-video', url: null } }, [text('The ride to the gate')], 'Riders in snow'),
  figure('video', 'center', { type: 'video', attrs: { assetId: null, url: 'https://example.com/ride.mp4' } }, [text('Linked ride')]),
  figure('video', 'center', { type: 'video', attrs: { assetId: 'asset-huge', url: null } }, [text('Too large to carry')]),
  figure('figure', 'center', { type: 'image', attrs: { assetId: 'asset-webp', alt: '' } }, [text('A WebP picture')]),
];

function page(fields: Partial<Page> & { title: string; id: string }): Page {
  return {
    pageType: 'article',
    status: 'canon',
    summary: '',
    wordCount: 0,
    isHome: false,
    revealNodeId: null,
    createdAt: when,
    updatedAt: when,
    deletedAt: null,
    aliases: [],
    categories: [],
    content: doc(para()),
    infobox: { fields: [] },
    notes: null,
    ...fields,
  };
}

function node(
  fields: Partial<Node> & { id: string; bookId: string; kind: Node['kind']; title: string; position: number; castPageIds?: string[] },
): Node & { castPageIds?: string[] } {
  return {
    parentId: null,
    status: 'draft',
    povPageId: null,
    locationPageId: null,
    synopsis: '',
    wordCount: 0,
    targetWords: 0,
    storyDate: '',
    createdAt: when,
    updatedAt: when,
    deletedAt: null,
    content: doc(para()),
    notes: '',
    ...fields,
  };
}

const LONG = 'The road ran north through the cold valley, and the riders kept to the high ground. ';

export function fixtureSnapshot(): ExportSnapshot {
  const pages: Page[] = [
    page({ id: 'home', title: 'Main Page', pageType: 'home', isHome: true, content: doc(para(text('Welcome. Start with '), link('Aria', 'Aria Vale'), text('.'))) }),
    page({
      id: 'aria',
      title: 'Aria Vale',
      pageType: 'character',
      summary: 'A ranger of the north & beyond.',
      wordCount: 120,
      aliases: ['The Ranger', 'Éowyn "Red" Þórr'],
      categories: ['Characters', 'Rangers & Scouts'],
      revealNodeId: 'scene-gate',
      infobox: {
        imageAssetId: 'asset-portrait',
        caption: 'Aria at the <Gate>',
        fields: [
          { key: 'born', label: 'Born', kind: 'date', value: '12 Frost 1204' },
          { key: 'location', label: 'Location', kind: 'page', value: 'Silver Vale' },
          { key: 'parents', label: 'Parents', kind: 'pages', value: 'Silver Vale, Nobody Known' },
          { key: 'note', label: 'Note', kind: 'longtext', value: 'Line one\nLine | two = x' },
          { key: 'empty', label: 'Empty', kind: 'text', value: '' },
        ],
      },
      content: doc(
        para(
          text('Aria', { type: 'bold' }),
          text(' is '),
          text('the', { type: 'italic' }),
          text(' '),
          text('both', { type: 'bold' }, { type: 'italic' }),
          text(' ranger of '),
          link('the Vale', 'Silver Vale'),
          text(' and '),
          link('Ranger', 'The Ranger'),
          text('.'),
          { type: 'reference', attrs: { text: 'Annals of the <Vale> & more, vol. 2' } },
        ),
        heading(2, 'Early life'),
        ALL_FIGURES[0],
        para(text(AWKWARD_TEXT)),
        heading(2, 'Later "years" & <more>'),
        ALL_FIGURES[1],
        ALL_FIGURES[2],
        para(text('See '), link('a missing page', 'Missing <Page> & Co'), text(', '), text('the outside', { type: 'link', attrs: { href: 'https://example.com/a?b=1&c=2' } }), text(', '), text('danger', { type: 'link', attrs: { href: 'javascript:alert(1)' } }), text(' and '), text('CON', { type: 'wikiLink', attrs: { target: 'CON' } }), text('.')),
        ALL_FIGURES[3],
        ALL_FIGURES[4],
        ALL_FIGURES[5],
        ALL_FIGURES[6],
        { type: 'image', attrs: { src: 'https://evil.example/tracker.png', alt: 'remote', assetId: null } },
        nestedList(10),
        { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [para(text('third item'))] }] },
        { type: 'blockquote', content: [para(text('Quoted '), text('words', { type: 'underline' }), text(' and '), text('gone', { type: 'strike' }), text(' and '), text('`code`', { type: 'code' }))] },
        { type: 'codeBlock', attrs: { language: 'js' }, content: [text('let x = "<&>";\n</pre> ]]>')] },
        { type: 'horizontalRule' },
        heading(3, 'Death'),
        para(text('Line one'), { type: 'hardBreak' }, text('line two')),
        para(text("It's ''quoted'' and the '"), text("bold'", { type: 'bold' }), text(' ok'), { type: 'reference', attrs: { text: 'Second | note' } }),
        para(text('* not a list')),
        para(text('= not a heading =')),
      ),
      notes: doc(para(text('Check her age. See '), link('Vale', 'Silver Vale'))),
    }),
    page({ id: 'silver', title: 'Silver Vale', pageType: 'place', summary: 'A cold valley.', categories: ['Places'], content: doc(para(text('Home of '), link('Aria', 'The Ranger'), text('.'))) }),
    page({ id: 'con', title: 'CON', status: 'draft', content: doc(para(text('Windows reserves this name.'))) }),
    page({ id: 'aux', title: 'aux.txt', status: 'idea', content: doc(para(text('This one too, even with an extension.'))) }),
    page({ id: 'why', title: 'What? Why: "Yes"', content: doc(para(text('Forbidden characters.'))) }),
    page({ id: 'why2', title: 'What* Why| "Yes"', content: doc(para(text('The same name once cleaned.'))) }),
    page({ id: 'tag', title: 'A|B [draft] <x> #1', aliases: ['Tricky {name}'], content: doc(para(link('self', 'A|B [draft] <x> #1'))) }),
    page({ id: 'ns', title: 'Category: Trick', content: doc(para(text('Looks like a namespace.'))) }),
    page({ id: 'dots', title: '...dots...', content: doc(para(text('Leading and trailing dots.'))) }),
    page({ id: 'cjk', title: '龍の名前', categories: ['世界'], content: doc(para(text('日本語の本文。'))) }),
    page({ id: 'old', title: 'Old Tale', status: 'retconned', categories: ['Tales'], content: doc(para(text('No longer true.'))) }),
    page({ id: 'draft', title: 'Rough Draft', status: 'draft', content: doc(para(text('Unfinished.'))) }),
    page({ id: 'empty', title: 'Empty Page', content: doc(para()) }),
    page({ id: 'formula', title: '=SUM(A1:A9)', summary: '+1 sword', content: doc(para(text('-5 cold, "quoted", and,\ncommas'))) }),
  ];

  const books = [
    { id: 'book-1', title: 'The Silver Road', subtitle: 'Book One', author: 'Élodie "E." Writer', position: 0, targetWords: 90000, createdAt: when, updatedAt: when },
    { id: 'book-2', title: 'Second & Last', subtitle: '', author: '', position: 1, targetWords: 0, createdAt: when, updatedAt: when },
  ];

  const nodes: Node[] = [
    node({ id: 'ch-1', bookId: 'book-1', kind: 'chapter', title: 'Arrival', position: 0, synopsis: 'She comes home.' }),
    node({
      id: 'scene-gate',
      bookId: 'book-1',
      parentId: 'ch-1',
      kind: 'scene',
      title: 'The Gate',
      position: 0,
      status: 'revised',
      povPageId: 'aria',
      storyDate: '1 Frost 1220',
      locationPageId: 'silver',
      castPageIds: ['aria', 'silver'],
      notes: 'Tighten <this>.',
      targetWords: 1500,
      wordCount: 40,
      content: doc(
        para(text(`Aria rode to the gate. ${LONG}`), link('Vale', 'Silver Vale'), text('.')),
        ALL_FIGURES[1],
        para(text(AWKWARD_TEXT), { type: 'reference', attrs: { text: 'A source' } }),
        { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('one'))] }, { type: 'listItem', content: [para(text('two'))] }] },
        { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [para(text('first'))] }] },
        { type: 'blockquote', content: [para(text('A letter.'))] },
      ),
    }),
    node({ id: 'scene-in', bookId: 'book-1', parentId: 'ch-1', kind: 'scene', title: 'Inside', position: 1, status: 'outline', content: doc(para(text('The hall was empty.')), ALL_FIGURES[3], ALL_FIGURES[4], ALL_FIGURES[2]) }),
    node({ id: 'part-2', bookId: 'book-1', kind: 'part', title: 'Part Two: Night', position: 1 }),
    node({ id: 'ch-2', bookId: 'book-1', parentId: 'part-2', kind: 'chapter', title: 'Snow & Ice', position: 0 }),
    node({ id: 'scene-snow', bookId: 'book-1', parentId: 'ch-2', kind: 'scene', title: 'First Snow', position: 0, status: 'final', content: doc(para(text('Snow fell on '), text('the', { type: 'italic' }), text(' road.'))) }),
    node({ id: 'ch-3', bookId: 'book-2', kind: 'chapter', title: 'Only Chapter', position: 0 }),
    node({ id: 'scene-b2', bookId: 'book-2', parentId: 'ch-3', kind: 'scene', title: 'Only Scene', position: 0, content: doc(para(text('The end of it all.'))) }),
    node({ id: 'ch-empty', bookId: 'book-2', kind: 'chapter', title: '', position: 1 }),
  ];

  return {
    meta: { app: 'lorebook', project_id: '01900000-0000-7000-8000-000000000001', name: 'The Vale & <Co>', created_at: when, 'wiki.setting': 'kept' },
    pages,
    books,
    nodes,
    relationships: [
      { fromPageId: 'aria', toPageId: 'silver', kind: 'born in', note: 'North "side", <here>', createdAt: when },
      { fromPageId: 'silver', toPageId: 'old', kind: 'related', note: '', createdAt: when },
    ],
    mentions: [{ sourceKind: 'node', sourceId: 'scene-gate', pageId: 'aria', count: 1 }],
    assets: [
      { id: 'asset-map', name: 'map:north*.png', mime: 'image/png', width: 400, height: 300, createdAt: when, size: PNG.length },
      { id: 'asset-portrait', name: 'portrait of aria.png', mime: 'image/png', width: 120, height: 160, createdAt: when, size: PNG.length },
      { id: 'asset-webp', name: 'pic.webp', mime: 'image/webp', width: 10, height: 10, createdAt: when, size: WEBP.length },
      { id: 'asset-video', name: 'ride.mp4', mime: 'video/mp4', width: null, height: null, createdAt: when, size: VIDEO.length },
      { id: 'asset-huge', name: 'whole film.mp4', mime: 'video/mp4', width: null, height: null, createdAt: when, size: 4 * 1024 * 1024 * 1024 },
      { id: 'asset-unused', name: 'unused.png', mime: 'image/png', width: 1, height: 1, createdAt: when, size: PNG.length },
    ],
    maps: [
      { id: 'map-1', title: 'The North', assetId: 'asset-map', createdAt: when, updatedAt: when, pins: [{ pageId: 'silver', label: 'Vale', x: 0.25, y: 0.5, createdAt: when }, { pageId: null, label: 'Unnamed', x: 1, y: 0, createdAt: when }] },
    ],
    dictionary: ['Aelindor', 'Þórr'],
    writingLog: [{ day: '2024-03-01', bookId: 'book-1', wordsAdded: 500, wordsRemoved: 20 }],
    prompts: [{ name: 'Tone', description: 'Keep the tone', template: 'Rewrite: {{text}}', scope: 'selection', position: 0 }],
    threads: [
      { id: 'thread-road', name: 'The Long Road', color: 'green', description: 'Getting home.', position: 0 },
      { id: 'thread-unused', name: 'Not Started', color: 'accent', description: '', position: 1 },
    ],
    nodeThreads: [{ nodeId: 'scene-gate', threadId: 'thread-road' }],
  };
}

/** Everything but the video too large to load, as the runner would hand over. */
export function fixtureAssetData(): Map<string, string> {
  return new Map([
    ['asset-map', bytesToBase64(PNG)],
    ['asset-portrait', bytesToBase64(PNG)],
    ['asset-webp', bytesToBase64(WEBP)],
    ['asset-video', bytesToBase64(VIDEO)],
    ['asset-unused', bytesToBase64(PNG)],
  ]);
}

export const EXPORTED_AT = '2024-06-01T12:00:00.000Z';

/** What an exporter receives, after the same narrowing the app does. */
export function fixtureInput(
  overrides: Partial<ExportOptions> = {},
  snapshot: ExportSnapshot = fixtureSnapshot(),
  warnings?: string[],
): ExportInput {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const scoped = applyScope(snapshot, options);
  return {
    snapshot: scoped.snapshot,
    excludedPages: scoped.excludedPages,
    assetData: fixtureAssetData(),
    options,
    exportedAt: EXPORTED_AT,
    warn: warnings ? (message) => warnings.push(message) : undefined,
  };
}

/** A book of about the given length, in 40 chapters of 5 scenes each. */
export function bigBookSnapshot(words: number): ExportSnapshot {
  const base = fixtureSnapshot();
  const sentence = 'The riders crossed the frozen river at Éowyn’s ford, and “nobody” spoke of what they had seen. ';
  const wordsPerSentence = sentence.trim().split(/\s+/).length;
  const scenes = 200;
  const sentencesPerParagraph = 6;
  const paragraphsPerScene = Math.max(1, Math.round(words / scenes / (wordsPerSentence * sentencesPerParagraph)));
  const nodes: Node[] = [];
  for (let c = 0; c < 40; c += 1) {
    const chapter = `big-ch-${c}`;
    nodes.push(node({ id: chapter, bookId: 'big', kind: 'chapter', title: `Chapter ${c + 1}`, position: c }));
    for (let s = 0; s < 5; s += 1) {
      const content = doc(
        ...Array.from({ length: paragraphsPerScene }, (_, p) =>
          para(text(`${sentence.repeat(sentencesPerParagraph - 1)}`), text(`Paragraph ${p} `, { type: 'italic' }), text(sentence)),
        ),
      );
      nodes.push(node({ id: `big-${c}-${s}`, bookId: 'big', parentId: chapter, kind: 'scene', title: `Scene ${s + 1}`, position: s, content, wordCount: paragraphsPerScene * sentencesPerParagraph * wordsPerSentence }));
    }
  }
  return {
    ...base,
    pages: [],
    relationships: [],
    mentions: [],
    maps: [],
    assets: [],
    books: [{ id: 'big', title: 'A Very Long Book', subtitle: '', author: 'Long Winded', position: 0, targetWords: 0 }],
    nodes,
  };
}
