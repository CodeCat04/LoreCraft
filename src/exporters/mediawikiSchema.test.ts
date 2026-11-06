/**
 * MediaWiki XML held to what https://www.mediawiki.org/xml/export-0.11.xsd says, without a schema
 * validator: the namespace and schema location, each type's child sequence, required children,
 * value formats (xsd:dateTime, positive integers, model and format patterns), sha1 and bytes,
 * unique ids, and that every title's namespace prefix agrees with its <ns> as siteinfo names them.
 * The fixture's files also pass System.Xml.Schema against the real XSD.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Page } from '../lib/types';
import { doc, fixtureInput, fixtureSnapshot, para, text } from './testFixture';
import type { ExportOptions, ExportSnapshot } from './types';
import { utf8 } from './util';
import { exportMediaWiki } from './wiki/mediawiki';

const MW = 'http://www.mediawiki.org/xml/export-0.11/';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

interface Particle {
  names: string[];
  min: number;
  max: number;
}
const one = (name: string): Particle => ({ names: [name], min: 1, max: 1 });
const optional = (name: string): Particle => ({ names: [name], min: 0, max: 1 });
const many = (...names: string[]): Particle => ({ names, min: 0, max: Infinity });

/** Each complex type's <sequence> in the XSD, in its order. */
const SEQUENCES: Record<string, Particle[]> = {
  mediawiki: [optional('siteinfo'), many('page'), many('logitem')],
  siteinfo: [optional('sitename'), optional('dbname'), optional('base'), optional('generator'), optional('case'), optional('namespaces')],
  namespaces: [many('namespace')],
  page: [one('title'), one('ns'), one('id'), optional('redirect'), optional('restrictions'), many('revision', 'upload'), optional('discussionthreadinginfo')],
  revision: [
    one('id'), optional('parentid'), one('timestamp'), one('contributor'), optional('minor'), optional('comment'),
    one('origin'), one('model'), one('format'), one('text'), many('content'), one('sha1'),
  ],
  contributor: [optional('username'), optional('id'), optional('ip')],
};

/** Simple content: text only, no child elements. */
const SIMPLE = new Set([
  'sitename', 'dbname', 'base', 'generator', 'case', 'namespace', 'title', 'ns', 'id', 'redirect', 'restrictions',
  'parentid', 'timestamp', 'comment', 'origin', 'model', 'format', 'text', 'sha1', 'username', 'ip',
]);

const CASES = ['first-letter', 'case-sensitive', 'case-insensitive'];
const POSITIVE = /^\+?0*[1-9]\d*$/;
const NON_NEGATIVE = /^\+?\d+$/;
/** xsd:dateTime (XML Schema 1.0, where year 0000 does not exist). */
const DATE_TIME = /^-?(?!0000)(\d{4}|[1-9]\d{4,})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?|24:00:00(\.0+)?)(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00))?$/;
/** What MediaWiki itself writes and reads back (TS_ISO_8601): four-digit years, whole seconds, UTC. */
const MEDIAWIKI_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const MODEL = /^[a-zA-Z][-+./a-zA-Z0-9]*$/;
const FORMAT = /^[a-zA-Z][-+.a-zA-Z0-9]*\/[a-zA-Z][-+.a-zA-Z0-9]*$/;
const SHA1 = /^[0-9a-z]{31}$/;
/** Canonical names MediaWiki always reads besides the local ones siteinfo lists. */
const CANONICAL_ALIASES: [string, number][] = [['image', 6], ['image talk', 7], ['project', 4], ['project talk', 5]];

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sha1Base36 = (value: string) => BigInt(`0x${createHash('sha1').update(value, 'utf8').digest('hex')}`).toString(36).padStart(31, '0');

function parseXml(xml: string): Document {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  const error = parsed.querySelector('parsererror');
  if (error) throw new Error(`Not well-formed: ${error.textContent}`);
  return parsed;
}

const kids = (element: Element, name: string) => [...element.children].filter((c) => c.localName === name);
const kid = (element: Element, name: string) => kids(element, name)[0];

/** Title text as MediaWiki reads it: bidi marks dropped, runs of spaces and underscores made one space. */
function normalTitle(title: string): string {
  return title.replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/[\s_\u180e]+/g, ' ').trim();
}

function upperFirst(value: string): string {
  const [first = '', ...rest] = [...value];
  return first.toUpperCase() + rest.join('');
}

function checkSequence(element: Element, where: string, problems: string[]) {
  const sequence = SEQUENCES[element.localName];
  for (const node of element.childNodes) {
    if (node.nodeType === node.TEXT_NODE && node.textContent!.trim()) problems.push(`${where}: text "${node.textContent!.trim().slice(0, 20)}" in element-only content`);
  }
  let at = 0;
  let count = 0;
  for (const child of element.children) {
    if (child.namespaceURI !== MW) {
      problems.push(`${where}: <${child.tagName}> is not in ${MW}`);
      continue;
    }
    while (at < sequence.length && !sequence[at].names.includes(child.localName)) {
      if (count < sequence[at].min) problems.push(`${where}: <${sequence[at].names.join('|')}> missing before <${child.localName}>`);
      at += 1;
      count = 0;
    }
    if (at === sequence.length) {
      problems.push(`${where}: <${child.localName}> is not allowed here, or out of order`);
      return;
    }
    count += 1;
    if (count > sequence[at].max) problems.push(`${where}: more than ${sequence[at].max} <${child.localName}>`);
    if (SEQUENCES[child.localName]) checkSequence(child, `${where}/${child.localName}`, problems);
    else if (SIMPLE.has(child.localName) && child.children.length) problems.push(`${where}/${child.localName}: holds elements`);
  }
  for (; at < sequence.length; at += 1, count = 0) {
    if (count < sequence[at].min) problems.push(`${where}: <${sequence[at].names.join('|')}> missing`);
  }
}

/** Everything the XSD, and MediaWiki's importer, would refuse. An empty list means a clean file. */
function schemaProblems(xml: string): string[] {
  const problems: string[] = [];
  const root = parseXml(xml).documentElement;
  if (root.localName !== 'mediawiki' || root.namespaceURI !== MW) problems.push(`root is {${root.namespaceURI}}${root.localName}`);
  if (root.getAttribute('version') !== '0.11') problems.push(`version ${root.getAttribute('version')}`);
  if (root.getAttributeNS(XSI, 'schemaLocation') !== `${MW} http://www.mediawiki.org/xml/export-0.11.xsd`) {
    problems.push(`xsi:schemaLocation ${root.getAttributeNS(XSI, 'schemaLocation')}`);
  }
  if (!/^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/.test(root.getAttributeNS(XML_NS, 'lang') ?? '')) problems.push('xml:lang missing or not a language');
  checkSequence(root, 'mediawiki', problems);

  // siteinfo: the namespaces every title is read against.
  const siteinfo = kid(root, 'siteinfo');
  const nsByName = new Map<string, number>(CANONICAL_ALIASES);
  if (siteinfo) {
    const caseValue = kid(siteinfo, 'case')?.textContent;
    if (caseValue !== undefined && !CASES.includes(caseValue!)) problems.push(`siteinfo case ${caseValue}`);
    const keys = new Set<string>();
    for (const namespace of kid(siteinfo, 'namespaces')?.children ?? []) {
      const key = namespace.getAttribute('key') ?? '';
      if (!/^[-+]?\d+$/.test(key)) problems.push(`namespace key "${key}" is not an integer`);
      if (keys.has(key)) problems.push(`namespace key ${key} twice`);
      keys.add(key);
      const nsCase = namespace.getAttribute('case');
      if (nsCase !== null && !CASES.includes(nsCase)) problems.push(`namespace ${key} case ${nsCase}`);
      const name = normalTitle(namespace.textContent ?? '').toLowerCase();
      if (name) nsByName.set(name, Number(key));
    }
    if (nsByName.get('talk') !== 1 || nsByName.get('template') !== 10) problems.push('siteinfo lacks the Talk and Template namespaces the pages use');
  }

  const pageIds = new Set<string>();
  const revisionIds = new Set<string>();
  const titles = new Map<string, string>();
  const redirects: [string, string][] = [];
  for (const page of kids(root, 'page')) {
    const title = kid(page, 'title')?.textContent ?? '';
    const ns = kid(page, 'ns')?.textContent ?? '';
    const pageId = kid(page, 'id')?.textContent ?? '';
    const where = `page "${title}"`;
    if (!NON_NEGATIVE.test(ns)) problems.push(`${where}: ns "${ns}" is not a nonNegativeInteger`);
    if (!POSITIVE.test(pageId)) problems.push(`${where}: id "${pageId}" is not a positiveInteger`);
    if (pageIds.has(pageId)) problems.push(`${where}: page id ${pageId} twice`);
    pageIds.add(pageId);

    // The title's prefix decides its namespace on import, whatever <ns> says.
    if (title !== normalTitle(title)) problems.push(`${where}: title is not in text form (underscores, marks or spare spaces)`);
    const read = normalTitle(title).replace(/^: ?/, '');
    const match = /^(.+?) ?: ?(.*)$/.exec(read);
    const prefixNs = match ? nsByName.get(match[1].toLowerCase()) : undefined;
    const expectedNs = prefixNs ?? 0;
    const rest = prefixNs === undefined ? read : match![2];
    if (expectedNs < 0) problems.push(`${where}: lands in namespace ${expectedNs}, which holds no pages`);
    if (String(expectedNs) !== ns) problems.push(`${where}: MediaWiki reads namespace ${expectedNs} from the title, the dump says ${ns}`);
    if (!rest) problems.push(`${where}: nothing after the namespace`);
    if (utf8(rest).length > 255) problems.push(`${where}: ${utf8(rest).length} bytes, more than 255`);
    const key = `${expectedNs}:${upperFirst(rest)}`;
    if (titles.has(key)) problems.push(`${where}: MediaWiki sees the same page as "${titles.get(key)}"`);
    titles.set(key, title);
    const redirect = kid(page, 'redirect');
    if (redirect) redirects.push([where, redirect.getAttribute('title') ?? '']);

    for (const revision of kids(page, 'revision')) {
      const revisionId = kid(revision, 'id')?.textContent ?? '';
      if (!POSITIVE.test(revisionId)) problems.push(`${where}: revision id "${revisionId}" is not a positiveInteger`);
      if (revisionIds.has(revisionId)) problems.push(`${where}: revision id ${revisionId} twice`);
      revisionIds.add(revisionId);
      const parent = kid(revision, 'parentid')?.textContent;
      if (parent !== undefined && !POSITIVE.test(parent!)) problems.push(`${where}: parentid "${parent}"`);
      const time = kid(revision, 'timestamp')?.textContent ?? '';
      if (!DATE_TIME.test(time) || Number.isNaN(Date.parse(time))) problems.push(`${where}: timestamp "${time}" is not an xsd:dateTime`);
      else if (!MEDIAWIKI_TIME.test(time)) problems.push(`${where}: timestamp "${time}" is not in the form MediaWiki reads`);
      const contributor = kid(revision, 'contributor');
      if (contributor && !kid(contributor, 'username')?.textContent && !kid(contributor, 'ip')?.textContent) problems.push(`${where}: contributor has no name`);
      const origin = kid(revision, 'origin')?.textContent ?? '';
      if (!POSITIVE.test(origin)) problems.push(`${where}: origin "${origin}" is not a positiveInteger`);
      const model = kid(revision, 'model')?.textContent ?? '';
      const format = kid(revision, 'format')?.textContent ?? '';
      if (!MODEL.test(model) || model !== 'wikitext') problems.push(`${where}: model "${model}"`);
      if (!FORMAT.test(format) || format !== 'text/x-wiki') problems.push(`${where}: format "${format}"`);
      const textElement = kid(revision, 'text');
      if (!textElement) continue;
      const value = textElement.textContent ?? '';
      const space = textElement.getAttributeNS(XML_NS, 'space');
      if (space !== null && space !== 'preserve') problems.push(`${where}: xml:space="${space}"`);
      const bytes = textElement.getAttribute('bytes');
      if (bytes !== null && (!NON_NEGATIVE.test(bytes) || Number(bytes) !== utf8(value).length)) {
        problems.push(`${where}: bytes="${bytes}" but the text is ${utf8(value).length} bytes`);
      }
      const sum = sha1Base36(value);
      if (textElement.hasAttribute('sha1') && textElement.getAttribute('sha1') !== sum) problems.push(`${where}: text sha1 is not the text's`);
      const revisionSha1 = kid(revision, 'sha1')?.textContent ?? '';
      if (!SHA1.test(revisionSha1) || revisionSha1 !== sum) problems.push(`${where}: sha1 "${revisionSha1}" is not the base 36 SHA-1 of the text`);
    }
  }
  for (const [where, target] of redirects) {
    const read = normalTitle(target);
    const match = /^(.+?) ?: ?(.*)$/.exec(read);
    const prefixNs = match ? nsByName.get(match[1].toLowerCase()) : undefined;
    const key = prefixNs === undefined ? `0:${upperFirst(read)}` : `${prefixNs}:${upperFirst(match![2])}`;
    if (!titles.has(key)) problems.push(`${where}: redirects to "${target}", which the dump does not hold`);
  }
  return problems;
}

const exportXml = (options: Partial<ExportOptions>, snapshot?: ExportSnapshot) => decode(exportMediaWiki(fixtureInput(options, snapshot)));

/** Titles and dates MediaWiki reads differently from how they look. */
function trickySnapshot(): ExportSnapshot {
  const snapshot = fixtureSnapshot();
  const plain = snapshot.pages.find((p) => p.id === 'silver')!;
  const add = (id: string, title: string, fields: Partial<Page> = {}): Page => ({
    ...plain,
    id,
    title,
    aliases: [],
    categories: [],
    infobox: { fields: [] },
    content: doc(para(text(`About ${id}.`))),
    notes: null,
    ...fields,
  });
  snapshot.pages.push(
    add('under', '_Talk:Under'),
    add('double', 'User__talk:Double'),
    add('spaced', 'Category_:Spaced'),
    add('mixed', 'Help _ talk:Mixed'),
    add('marked', 'Talk\u200e:Marked'),
    add('lowline', 'Silver_Vale'),
    add('trailing', 'Rough Draft_'),
    add('aliased', 'Aliased', { aliases: ['_Template:Sneaky', 'Aliased_'], notes: doc(para(text('A talk page too.'))) }),
    add('long1', 'x'.repeat(300)),
    add('long2', 'x'.repeat(300)),
    add('future', 'Far Future', { updatedAt: '+010000-01-01T00:00:00.000Z' }),
    add('zero', 'Year Zero', { updatedAt: '0000-06-01T00:00:00.000Z' }),
    add('nodate', 'No Date', { updatedAt: 'whenever' }),
  );
  return snapshot;
}

describe('MediaWiki XML against the export-0.11 schema', () => {
  const OPTION_SETS: [string, Partial<ExportOptions>][] = [
    ['the wiki', { scope: 'wiki' }],
    ['the whole project', { scope: 'project' }],
    ['one page', { scope: 'page', pageId: 'aria' }],
    ['the wiki without drafts', { scope: 'wiki', includeDrafts: false }],
  ];

  it.each(OPTION_SETS)('%s is valid, in order, with every required element', (_name, options) => {
    const xml = exportXml(options);
    expect(schemaProblems(xml)).toEqual([]);
    expect(parseXml(xml).getElementsByTagNameNS(MW, 'page').length).toBeGreaterThan(0);
  });

  it('an empty wiki is valid: siteinfo and no pages', () => {
    const xml = exportXml({ scope: 'wiki' }, { ...fixtureSnapshot(), pages: [] });
    expect(schemaProblems(xml)).toEqual([]);
    const root = parseXml(xml).documentElement;
    expect([...root.children].map((c) => c.localName)).toEqual(['siteinfo']);
  });

  it('the checks find what the schema refuses', () => {
    const good = exportXml({ scope: 'page', pageId: 'aria' });
    expect(schemaProblems(good)).toEqual([]);
    const broken: [string, string, RegExp][] = [
      ['<model>wikitext</model>', '', /<model> missing before <format>/],
      ['<origin>', '<minor/><origin>', /<minor> is not allowed here/],
      ['<ns>0</ns>', '<ns>-1</ns>', /not a nonNegativeInteger/],
      ['<timestamp>2024-03-01T10:20:30Z', '<timestamp>2024-03-01 10:20:30', /not an xsd:dateTime/],
      ['<timestamp>2024-03-01T10:20:30Z', '<timestamp>+10000-03-01T10:20:30Z', /not an xsd:dateTime/],
      ['<timestamp>2024-03-01T10:20:30Z', '<timestamp>0000-03-01T10:20:30Z', /not an xsd:dateTime/],
      ['<format>text/x-wiki', '<format>x-wiki', /format "x-wiki"/],
      ['<namespace key="-2"', '<namespace key="abc"', /not an integer/],
      ['<case>first-letter', '<case>First-letter', /siteinfo case/],
      ['<title>Aria Vale</title>\n<ns>0</ns>', '<title>Aria Vale</title>\n<ns>1</ns>', /reads namespace 0 from the title, the dump says 1/],
      ['<title>Aria Vale</title>', '<title>Aria_Vale</title>', /not in text form/],
      ['bytes="', 'bytes="1', /bytes=/],
      ['<sha1>', '<sha1>x', /sha1 "x/],
      [' xml:lang="en"', '', /xml:lang/],
    ];
    for (const [from, to, problem] of broken) {
      expect(good.includes(from), from).toBe(true);
      expect(schemaProblems(good.replace(from, to)).join('\n'), `${from} -> ${to}`).toMatch(problem);
    }
  });

  it('keeps titles that only look like a namespace in the main namespace, and apart', () => {
    const xml = exportXml({ scope: 'wiki' }, trickySnapshot());
    expect(schemaProblems(xml)).toEqual([]);
    const pages = [...parseXml(xml).getElementsByTagNameNS(MW, 'page')];
    const titleOf = (id: string) => pages.map((p) => kid(p, 'title').textContent!).find((t) => t.includes(id));
    expect(titleOf('Under')).toBe('Talk - Under');
    expect(titleOf('Double')).toBe('User talk - Double');
    expect(titleOf('Spaced')).toBe('Category - Spaced');
    expect(titleOf('Mixed')).toBe('Help talk - Mixed');
    expect(titleOf('Marked')).toBe('Talk - Marked');
    // Silver_Vale and Silver Vale are one page to MediaWiki.
    expect(pages.map((p) => kid(p, 'title').textContent)).toContain('Silver Vale (2)');
    const long = pages.map((p) => kid(p, 'title').textContent!).filter((t) => t.startsWith('xxx'));
    expect(long).toHaveLength(2);
    for (const title of long) expect(utf8(title).length).toBeLessThanOrEqual(255);
  });

  it('writes a timestamp MediaWiki reads for any date, even one it cannot read', () => {
    const xml = exportXml({ scope: 'wiki' }, trickySnapshot());
    const pages = [...parseXml(xml).getElementsByTagNameNS(MW, 'page')];
    const time = (title: string) => kid(kid(pages.find((p) => kid(p, 'title').textContent === title)!, 'revision'), 'timestamp').textContent;
    // Out of range or unreadable, the export time stands in.
    expect(time('Far Future')).toBe('2024-06-01T12:00:00Z');
    expect(time('Year Zero')).toBe('2024-06-01T12:00:00Z');
    expect(time('No Date')).toBe('2024-06-01T12:00:00Z');
    expect(time('Silver Vale')).toBe('2024-03-01T10:20:30Z');
    const input = { ...fixtureInput({ scope: 'wiki' }, trickySnapshot()), exportedAt: 'not a date either' };
    expect(schemaProblems(decode(exportMediaWiki(input)))).toEqual([]);
  });
});
