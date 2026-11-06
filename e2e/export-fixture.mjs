/**
 * A small world with awkward content, built through the same calls the app's own screens
 * use, so the tests below do not depend on import to set it up.
 */

import { deflateSync } from 'node:zlib';

import { rpc, addAsset } from './harness.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** A real PNG in one color, so it can be found again on a rendered page. */
export function solidPng(width, height, [r, g, b]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const text = (value, ...marks) => (marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const link = (label, target) => text(label, { type: 'wikiLink', attrs: { target } });
const para = (...content) => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const heading = (level, value) => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const doc = (...content) => ({ type: 'doc', content });

const AWKWARD = 'Quotes "double" and \'single\', <angle> & ampersand, ]]> end of CDATA, control\u0001char, emoji 🐉, Éowyn Þórr Łukasz 龍 Ελληνικά Русский العربية.';

const LONG = 'The road ran north through the cold valley, and the riders kept to the high ground where the snow lay thin. '.repeat(14);

function figure(kind, align, media, caption, description = '', width = null) {
  return {
    type: 'figure',
    attrs: { kind, align, width, description },
    content: [media, { type: 'figcaption', content: [text(caption)] }],
  };
}

function nested(depth) {
  const item = para(text(`Level ${depth}`));
  const inner = depth > 1 ? [nested(depth - 1)] : [];
  return { type: 'bulletList', content: [{ type: 'listItem', content: [item, ...inner] }] };
}

const table = {
  type: 'table',
  content: [
    {
      type: 'tableRow',
      content: [
        { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [para(text('Name'))] },
        { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [para(text('Rank | Order'))] },
      ],
    },
    {
      type: 'tableRow',
      content: [
        { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [para(text('Aria <Vale>'))] },
        { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [para(text('Ranger & scout'))] },
      ],
    },
  ],
};

const BLUE = [20, 60, 200];
const GREEN = [20, 180, 80];

/** Fills the open project. Returns what the tests need to find it again. */
export async function buildWorld(page) {
  const addImage = async (name, width, height, color) => {
    const base64 = solidPng(width, height, color).toString('base64');
    const { id } = await addAsset(page, { name, mime: 'image/png', base64, width, height });
    return id;
  };
  const portrait = await addImage('portrait of aria.png', 120, 160, GREEN);
  const mapImage = await addImage('map:north*.png', 200, 150, BLUE);

  const createPage = async (fields, content) => {
    const created = await rpc(page, 'pages.create', { ...fields, content });
    return created;
  };

  const home = await rpc(page, 'pages.home');
  await rpc(page, 'pages.update', {
    id: home.id,
    patch: {
      content: doc(para(text('Welcome to the Vale. Start with '), link('Aria', 'Aria Vale'), text(' or read about '), link('the missing place', 'Nowhere At All'), text('.'))),
    },
  });

  const aria = await createPage(
    {
      title: 'Aria Vale',
      pageType: 'character',
      status: 'canon',
      summary: 'A ranger of the north, and the last of her line.',
      aliases: ['The Ranger', 'Éowyn "Red" Þórr'],
      categories: ['Characters', 'Rangers & Scouts'],
      infobox: {
        imageAssetId: portrait,
        caption: 'Aria at the Silver Gate',
        fields: [
          { key: 'born', label: 'Born', kind: 'date', value: '12 Frost 1204' },
          { key: 'species', label: 'Species', kind: 'text', value: 'Human' },
          { key: 'location', label: 'Location', kind: 'page', value: 'Silver Vale' },
          { key: 'parents', label: 'Parents', kind: 'pages', value: 'Silver Vale, Nobody Known' },
        ],
      },
    },
    doc(
      para(text('Aria', { type: 'bold' }), text(' is '), text('the', { type: 'italic' }), text(' ranger of '), link('the Vale', 'Silver Vale'), text('.'), { type: 'reference', attrs: { text: 'Annals of the Vale, vol. 2' } }),
      heading(2, 'Early life'),
      figure('picture', 'right', { type: 'image', attrs: { assetId: mapImage, alt: '' } }, 'The road north, from the old maps', 'A blue map of the northern road'),
      para(text(LONG)),
      para(text(AWKWARD)),
      heading(2, 'Later years'),
      para(text('See '), link('a page that does not exist', 'Missing Page <Yet>'), text(' and '), text('the outside', { type: 'link', attrs: { href: 'https://example.com/a?b=1&c=2' } }), text('.')),
      figure('table', 'center', table, 'Her ranks'),
      figure('video', 'full', { type: 'video', attrs: { assetId: null, url: 'https://example.com/ride.mp4' } }, 'The ride to the Gate'),
      nested(8),
      { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [para(text('third'))] }] },
      { type: 'blockquote', content: [para(text('Quoted words.'))] },
      { type: 'codeBlock', attrs: { language: null }, content: [text('let x = "<&>";')] },
      { type: 'horizontalRule' },
      heading(3, 'Death'),
      para(text('Claimed by the snow.')),
    ),
  );

  await createPage(
    { title: 'Silver Vale', pageType: 'place', status: 'canon', categories: ['Places'], summary: 'A cold valley.' },
    doc(para(text('Home of '), link('Aria', 'The Ranger'), text('.'))),
  );
  await createPage({ title: 'CON', status: 'draft' }, doc(para(text('A page whose name Windows reserves.'))));
  await createPage({ title: 'What? Why: "Yes"', status: 'idea' }, doc(para(text('Forbidden characters in the name.'))));
  await createPage({ title: 'Old Tale', status: 'retconned' }, doc(para(text('No longer true.'))));
  await createPage({ title: 'Empty Page', status: 'draft' }, undefined);

  const books = await rpc(page, 'books.list');
  const book = books[0].id;
  await rpc(page, 'books.update', { id: book, patch: { title: 'The Silver Road', subtitle: 'Book One of the Vale', author: 'Élodie Writer', targetWords: 90000 } });
  const tree = await rpc(page, 'nodes.tree', { bookId: book });
  const firstChapter = tree.find((n) => n.kind === 'chapter');
  const firstScene = tree.find((n) => n.kind === 'scene');
  await rpc(page, 'nodes.update', { id: firstChapter.id, patch: { title: 'Arrival', synopsis: 'She comes home.' } });
  await rpc(page, 'nodes.update', {
    id: firstScene.id,
    patch: {
      title: 'The Gate',
      status: 'revised',
      povPageId: aria.id,
      storyDate: '1 Frost 1220',
      notes: 'Tighten this.',
      targetWords: 1500,
      content: doc(
        para(text('Aria Vale rode to the gate at dusk. ' + LONG)),
        figure('figure', 'left', { type: 'image', attrs: { assetId: portrait, alt: '' } }, 'Aria at the gate'),
        para(text(LONG)),
        para(text(AWKWARD)),
      ),
    },
  });
  const secondScene = await rpc(page, 'nodes.create', { bookId: book, parentId: firstChapter.id, kind: 'scene', title: 'Inside', content: doc(para(text('The hall was empty.'))), status: 'outline' });
  const part = await rpc(page, 'nodes.create', { bookId: book, kind: 'part', title: 'Part Two: The Long Night' });
  const partChapter = await rpc(page, 'nodes.create', { bookId: book, parentId: part.id, kind: 'chapter', title: 'Snowfall' });
  const firstSnow = await rpc(page, 'nodes.create', { bookId: book, parentId: partChapter.id, kind: 'scene', title: 'First Snow', content: doc(para(text('Snow fell on '), text('the', { type: 'italic' }), text(' road.'))) });
  // Marked never to go to a cloud AI. Books and sites keep them, data formats carry the mark,
  // and files for other AI tools leave them out unless asked.
  const con = await rpc(page, 'pages.getByTitle', { title: 'CON' });
  await rpc(page, 'pages.update', { id: con.id, patch: { localOnly: true } });
  await rpc(page, 'nodes.update', { id: firstSnow.id, patch: { localOnly: true } });

  const silver = await rpc(page, 'pages.getByTitle', { title: 'Silver Vale' });
  await rpc(page, 'nodes.update', { id: firstScene.id, patch: { locationPageId: silver.id } });
  await rpc(page, 'nodes.setCast', { id: firstScene.id, pageIds: [aria.id, silver.id] });
  const road = await rpc(page, 'threads.create', { name: 'The Long Road', color: 'green', description: 'Getting home.' });
  await rpc(page, 'threads.create', { name: 'Not Started Yet' });
  await rpc(page, 'threads.setLink', { nodeId: firstScene.id, threadId: road.id, on: true });
  await rpc(page, 'threads.setLink', { nodeId: secondScene.id, threadId: road.id, on: true });
  const withChange = (await rpc(page, 'pages.get', { id: aria.id })).infobox;
  await rpc(page, 'pages.update', {
    id: aria.id,
    patch: {
      infobox: {
        ...withChange,
        fields: withChange.fields.map((field) => (field.key === 'born' ? field : { ...field, changes: [{ nodeId: secondScene.id, value: 'Changed', note: 'Later on.' }] })),
      },
    },
  });
  // A custom page type lives in project meta, so it should travel with the rest.
  await rpc(page, 'project.setMeta', { key: 'pageTypes', value: JSON.stringify([{ type: 'guild', label: 'Guild', fields: [], sections: ['History'] }]) });
  await rpc(page, 'pages.update', { id: aria.id, patch: { notes: doc(para(text('Check her age.'))), revealNodeId: secondScene.id } });

  return { ariaId: aria.id, silverId: silver.id, bookId: book, portrait, mapImage, homeId: home.id };
}
