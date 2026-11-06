/**
 * The Word export checked against the file format itself rather than read back: the
 * package's parts and relationships, the order WordprocessingML gives child elements,
 * and the references between parts. Word refuses a file that breaks these, even where
 * more forgiving readers such as mammoth or LibreOffice open it.
 */

import { readFileSync } from 'node:fs';

import { strFromU8, unzipSync } from 'fflate';

import type { BookPublishing } from '../lib/types';
import { exportDocx } from './novel/docx';
import { doc, fixtureInput, fixtureSnapshot, para, text } from './testFixture';
import type { ExportOptions, ExportSnapshot } from './types';

const NS: Record<string, string> = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  ep: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  vt: 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
};
const PREFIX = new Map(Object.entries(NS).map(([prefix, uri]) => [uri, prefix]));

/** An element's name with the prefixes above, whatever prefix the file itself uses. */
function nameOf(el: Element): string {
  const prefix = el.namespaceURI ? PREFIX.get(el.namespaceURI) : undefined;
  return prefix ? `${prefix}:${el.localName}` : `{${el.namespaceURI ?? ''}}${el.localName}`;
}

const children = (el: Element) => [...el.children];
const all = (root: Document | Element, name: string) => [...root.getElementsByTagName('*')].filter((e) => nameOf(e) === name);
const wAttr = (el: Element, name: string) => el.getAttributeNS(NS.w, name);

/**
 * Child order for each element, from the transitional schema of ECMA-376 Part 1
 * (wml.xsd for w:, dml-wordprocessingDrawing.xsd for wp:, dml-main.xsd for a:,
 * dml-picture.xsd for pic:). A string is one element that may appear once; a string
 * ending in `*` may repeat; an array is a choice whose members may come in any order
 * and repeat; `*` alone stands for every child not named in the same rule. Children
 * a rule does not name are left alone, as are mc: elements.
 */
type Slot = string | string[];
const SCHEMA_ORDER: Record<string, Slot[]> = {
  // CT_Document, CT_Body (block content, then the final sectPr)
  'w:document': ['w:background', 'w:body'],
  'w:body': ['*', 'w:sectPr'],
  // CT_P, CT_R
  'w:p': ['w:pPr', '*'],
  'w:r': ['w:rPr', '*'],
  // CT_PPr = CT_PPrBase + rPr, sectPr, pPrChange
  'w:pPr': [
    'w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl', 'w:numPr',
    'w:suppressLineNumbers', 'w:pBdr', 'w:shd', 'w:tabs', 'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap',
    'w:overflowPunct', 'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi', 'w:adjustRightInd',
    'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing', 'w:mirrorIndents', 'w:suppressOverlap', 'w:jc',
    'w:textDirection', 'w:textAlignment', 'w:textboxTightWrap', 'w:outlineLvl', 'w:divId', 'w:cnfStyle',
    'w:rPr', 'w:sectPr', 'w:pPrChange',
  ],
  // CT_ParaRPr's track changes, then EG_RPrBase in the order Word writes and validates, then rPrChange
  'w:rPr': [
    'w:ins', 'w:del', 'w:moveFrom', 'w:moveTo',
    'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps', 'w:strike', 'w:dstrike',
    'w:outline', 'w:shadow', 'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid', 'w:vanish', 'w:webHidden',
    'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position', 'w:sz', 'w:szCs', 'w:highlight', 'w:u', 'w:effect',
    'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout',
    'w:specVanish', 'w:oMath', 'w:rPrChange',
  ],
  'w:numPr': ['w:ilvl', 'w:numId', 'w:numberingChange', 'w:ins'],
  'w:pBdr': ['w:top', 'w:left', 'w:bottom', 'w:right', 'w:between', 'w:bar'],
  'w:tabs': ['w:tab*'],
  // CT_SectPr: EG_HdrFtrReferences, then EG_SectPrContents, then sectPrChange
  'w:sectPr': [
    ['w:headerReference', 'w:footerReference'],
    'w:footnotePr', 'w:endnotePr', 'w:type', 'w:pgSz', 'w:pgMar', 'w:paperSrc', 'w:pgBorders', 'w:lnNumType',
    'w:pgNumType', 'w:cols', 'w:formProt', 'w:vAlign', 'w:noEndnote', 'w:titlePg', 'w:textDirection', 'w:bidi',
    'w:rtlGutter', 'w:docGrid', 'w:printerSettings', 'w:sectPrChange',
  ],
  // CT_FtnProps / CT_EdnProps, and in settings CT_FtnDocProps / CT_EdnDocProps
  'w:footnotePr': ['w:pos', 'w:numFmt', 'w:numStart', 'w:numRestart', 'w:footnote*'],
  'w:endnotePr': ['w:pos', 'w:numFmt', 'w:numStart', 'w:numRestart', 'w:endnote*'],
  // CT_Tbl, CT_TblPr, CT_TblGrid, CT_Row, CT_TrPr (CT_TrPrBase is a choice), CT_Tc, CT_TcPr
  'w:tbl': ['w:tblPr', 'w:tblGrid', ['w:tr', 'w:customXml', 'w:sdt']],
  'w:tblPr': [
    'w:tblStyle', 'w:tblpPr', 'w:tblOverlap', 'w:bidiVisual', 'w:tblStyleRowBandSize', 'w:tblStyleColBandSize',
    'w:tblW', 'w:jc', 'w:tblCellSpacing', 'w:tblInd', 'w:tblBorders', 'w:shd', 'w:tblLayout', 'w:tblCellMar',
    'w:tblLook', 'w:tblCaption', 'w:tblDescription', 'w:tblPrChange',
  ],
  'w:tblBorders': ['w:top', ['w:left', 'w:start'], 'w:bottom', ['w:right', 'w:end'], 'w:insideH', 'w:insideV'],
  'w:tblCellMar': ['w:top', ['w:left', 'w:start'], 'w:bottom', ['w:right', 'w:end']],
  'w:tblGrid': ['w:gridCol*', 'w:tblGridChange'],
  'w:tr': ['w:tblPrEx', 'w:trPr', '*'],
  'w:trPr': [
    ['w:cnfStyle', 'w:divId', 'w:gridBefore', 'w:gridAfter', 'w:wBefore', 'w:wAfter', 'w:cantSplit', 'w:trHeight',
      'w:tblHeader', 'w:tblCellSpacing', 'w:jc', 'w:hidden'],
    'w:ins', 'w:del', 'w:trPrChange',
  ],
  'w:tc': ['w:tcPr', '*'],
  'w:tcPr': [
    'w:cnfStyle', 'w:tcW', 'w:gridSpan', 'w:hMerge', 'w:vMerge', 'w:tcBorders', 'w:shd', 'w:noWrap', 'w:tcMar',
    'w:textDirection', 'w:tcFitText', 'w:vAlign', 'w:hideMark', 'w:headers', ['w:cellIns', 'w:cellDel', 'w:cellMerge'],
    'w:tcPrChange',
  ],
  'w:tcBorders': ['w:top', ['w:left', 'w:start'], 'w:bottom', ['w:right', 'w:end'], 'w:insideH', 'w:insideV', 'w:tl2br', 'w:tr2bl'],
  'w:tcMar': ['w:top', ['w:left', 'w:start'], 'w:bottom', ['w:right', 'w:end']],
  // styles.xml: CT_Styles, CT_DocDefaults, CT_Style
  'w:styles': ['w:docDefaults', 'w:latentStyles', 'w:style*'],
  'w:docDefaults': ['w:rPrDefault', 'w:pPrDefault'],
  'w:rPrDefault': ['w:rPr'],
  'w:pPrDefault': ['w:pPr'],
  'w:latentStyles': ['w:lsdException*'],
  'w:style': [
    'w:name', 'w:aliases', 'w:basedOn', 'w:next', 'w:link', 'w:autoRedefine', 'w:hidden', 'w:uiPriority',
    'w:semiHidden', 'w:unhideWhenUsed', 'w:qFormat', 'w:locked', 'w:personal', 'w:personalCompose',
    'w:personalReply', 'w:rsid', 'w:pPr', 'w:rPr', 'w:tblPr', 'w:trPr', 'w:tcPr', 'w:tblStylePr*',
  ],
  // numbering.xml: CT_Numbering, CT_AbstractNum, CT_Lvl, CT_Num, CT_NumLvl
  'w:numbering': ['w:numPicBullet*', 'w:abstractNum*', 'w:num*', 'w:numIdMacAtCleanup'],
  'w:abstractNum': ['w:nsid', 'w:multiLevelType', 'w:tmpl', 'w:name', 'w:styleLink', 'w:numStyleLink', 'w:lvl*'],
  'w:lvl': [
    'w:start', 'w:numFmt', 'w:lvlRestart', 'w:pStyle', 'w:isLgl', 'w:suff', 'w:lvlText', 'w:lvlPicBulletId',
    'w:legacy', 'w:lvlJc', 'w:pPr', 'w:rPr',
  ],
  'w:num': ['w:abstractNumId', 'w:lvlOverride*'],
  'w:lvlOverride': ['w:startOverride', 'w:lvl'],
  // fontTable.xml: CT_FontsList, CT_Font
  'w:fonts': ['w:font*'],
  'w:font': [
    'w:altName', 'w:panose1', 'w:charset', 'w:family', 'w:notTrueType', 'w:pitch', 'w:sig', 'w:embedRegular',
    'w:embedBold', 'w:embedItalic', 'w:embedBoldItalic',
  ],
  'w:footnotes': ['w:footnote*'],
  'w:endnotes': ['w:endnote*'],
  // settings.xml: CT_Settings
  'w:settings': [
    'w:writeProtection', 'w:view', 'w:zoom', 'w:removePersonalInformation', 'w:removeDateAndTime',
    'w:doNotDisplayPageBoundaries', 'w:displayBackgroundShape', 'w:printPostScriptOverText',
    'w:printFractionalCharacterWidth', 'w:printFormsData', 'w:embedTrueTypeFonts', 'w:embedSystemFonts',
    'w:saveSubsetFonts', 'w:saveFormsData', 'w:mirrorMargins', 'w:alignBordersAndEdges',
    'w:bordersDoNotSurroundHeader', 'w:bordersDoNotSurroundFooter', 'w:gutterAtTop', 'w:hideSpellingErrors',
    'w:hideGrammaticalErrors', 'w:activeWritingStyle*', 'w:proofState', 'w:formsDesign', 'w:attachedTemplate',
    'w:linkStyles', 'w:stylePaneFormatFilter', 'w:stylePaneSortMethod', 'w:documentType', 'w:mailMerge',
    'w:revisionView', 'w:trackRevisions', 'w:doNotTrackMoves', 'w:doNotTrackFormatting', 'w:documentProtection',
    'w:autoFormatOverride', 'w:styleLockTheme', 'w:styleLockQFSet', 'w:defaultTabStop', 'w:autoHyphenation',
    'w:consecutiveHyphenLimit', 'w:hyphenationZone', 'w:doNotHyphenateCaps', 'w:showEnvelope', 'w:summaryLength',
    'w:clickAndTypeStyle', 'w:defaultTableStyle', 'w:evenAndOddHeaders', 'w:bookFoldRevPrinting',
    'w:bookFoldPrinting', 'w:bookFoldPrintingSheets', 'w:drawingGridHorizontalSpacing',
    'w:drawingGridVerticalSpacing', 'w:displayHorizontalDrawingGridEvery', 'w:displayVerticalDrawingGridEvery',
    'w:doNotUseMarginsForDrawingGridOrigin', 'w:drawingGridHorizontalOrigin', 'w:drawingGridVerticalOrigin',
    'w:doNotShadeFormData', 'w:noPunctuationKerning', 'w:characterSpacingControl', 'w:printTwoOnOne',
    'w:strictFirstAndLastChars', 'w:noLineBreaksAfter', 'w:noLineBreaksBefore', 'w:savePreviewPicture',
    'w:doNotValidateAgainstSchema', 'w:saveInvalidXml', 'w:ignoreMixedContent', 'w:alwaysShowPlaceholderText',
    'w:doNotDemarcateInvalidXml', 'w:saveXmlDataOnly', 'w:useXSLTWhenSaving', 'w:saveThroughXslt',
    'w:showXMLTags', 'w:alwaysMergeEmptyNamespace', 'w:updateFields', 'w:hdrShapeDefaults', 'w:footnotePr',
    'w:endnotePr', 'w:compat', 'w:docVars', 'w:rsids', '{http://schemas.openxmlformats.org/officeDocument/2006/math}mathPr',
    'w:attachedSchema*', 'w:themeFontLang', 'w:clrSchemeMapping', 'w:doNotIncludeSubdocsInStats',
    'w:doNotAutoCompressPictures', 'w:forceUpgrade', 'w:captions', 'w:readModeInkLockDown', 'w:smartTagType*',
    'w:schemaLibrary', 'w:shapeDefaults', 'w:doNotEmbedSmartTags', 'w:decimalSymbol', 'w:listSeparator',
  ],
  // CT_Compat: the named legacy options, then compatSetting
  'w:compat': ['*', 'w:compatSetting*'],
  // Pictures: CT_Drawing, CT_Inline, CT_Anchor, CT_NonVisualDrawingProps, CT_GraphicalObject,
  // CT_Picture, CT_PictureNonVisual, CT_BlipFillProperties, CT_ShapeProperties, CT_Transform2D
  'w:drawing': [['wp:inline', 'wp:anchor']],
  'wp:inline': ['wp:extent', 'wp:effectExtent', 'wp:docPr', 'wp:cNvGraphicFramePr', 'a:graphic'],
  'wp:anchor': [
    'wp:simplePos', 'wp:positionH', 'wp:positionV', 'wp:extent', 'wp:effectExtent',
    ['wp:wrapNone', 'wp:wrapSquare', 'wp:wrapTight', 'wp:wrapThrough', 'wp:wrapTopAndBottom'],
    'wp:docPr', 'wp:cNvGraphicFramePr', 'a:graphic',
  ],
  'wp:docPr': ['a:hlinkClick', 'a:hlinkHover', 'a:extLst'],
  'wp:cNvGraphicFramePr': ['a:graphicFrameLocks', 'a:extLst'],
  'a:graphic': ['a:graphicData'],
  'pic:pic': ['pic:nvPicPr', 'pic:blipFill', 'pic:spPr'],
  'pic:nvPicPr': ['pic:cNvPr', 'pic:cNvPicPr'],
  'pic:cNvPicPr': ['a:picLocks', 'a:extLst'],
  'pic:blipFill': ['a:blip', 'a:srcRect', ['a:tile', 'a:stretch']],
  'a:blip': ['*', 'a:extLst'],
  'pic:spPr': [
    'a:xfrm', ['a:custGeom', 'a:prstGeom'], ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'],
    'a:ln', ['a:effectLst', 'a:effectDag'], 'a:scene3d', 'a:sp3d', 'a:extLst',
  ],
  'a:xfrm': ['a:off', 'a:ext'],
  'a:prstGeom': ['a:avLst'],
};

interface Rule {
  slotOf: Map<string, { index: number; many: boolean }>;
  rest?: number;
}

const RULES = new Map<string, Rule>(
  Object.entries(SCHEMA_ORDER).map(([parent, slots]) => {
    const slotOf = new Map<string, { index: number; many: boolean }>();
    let rest: number | undefined;
    slots.forEach((slot, index) => {
      if (slot === '*') rest = index;
      else if (Array.isArray(slot)) for (const name of slot) slotOf.set(name, { index, many: true });
      else if (slot.endsWith('*')) slotOf.set(slot.slice(0, -1), { index, many: true });
      else slotOf.set(slot, { index, many: false });
    });
    return [parent, { slotOf, rest }];
  }),
);

/** Every place in a part where a child comes before one it must follow, or comes twice. */
function orderProblems(root: Element, part: string): string[] {
  const problems: string[] = [];
  const walk = (el: Element, path: string) => {
    const parent = nameOf(el);
    const rule = RULES.get(parent);
    if (rule) {
      let at = -1;
      let previous = '';
      for (const child of children(el)) {
        const name = nameOf(child);
        if (name.startsWith('mc:')) continue;
        const slot = rule.slotOf.get(name) ?? (rule.rest !== undefined ? { index: rule.rest, many: true } : undefined);
        if (!slot) continue;
        if (slot.index < at) problems.push(`${part} ${path}: <${name}> comes after <${previous}>`);
        else if (slot.index === at && !slot.many) problems.push(`${part} ${path}: <${name}> twice`);
        if (slot.index >= at) {
          at = slot.index;
          previous = name;
        }
      }
    }
    children(el).forEach((child, i) => walk(child, `${path}/${nameOf(child)}[${i}]`));
  };
  walk(root, nameOf(root));
  return problems;
}

type Files = Record<string, Uint8Array>;

function parse(files: Files, name: string): Document {
  const parsed = new DOMParser().parseFromString(strFromU8(files[name]), 'application/xml');
  const error = parsed.querySelector('parsererror');
  if (error) throw new Error(`${name} is not well-formed: ${error.textContent}`);
  return parsed;
}

const xmlParts = (files: Files) => Object.keys(files).filter((n) => /\.(xml|rels)$/.test(n));

/** Where a part's relationships live: word/document.xml has word/_rels/document.xml.rels. */
const relsOf = (part: string) => {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
};

/** The part a .rels file belongs to, or '' for the package's own. */
const sourceOf = (rels: string) => {
  const match = /^(.*?)_rels\/(.*)\.rels$/.exec(rels)!;
  return `${match[1]}${match[2]}`;
};

function resolveTarget(source: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = source.split('/').slice(0, -1);
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece !== '.' && piece !== '') parts.push(piece);
  }
  return parts.join('/');
}

function relationships(files: Files, rels: string) {
  return [...parse(files, rels).getElementsByTagNameNS(NS.rel, 'Relationship')].map((r) => ({
    id: r.getAttribute('Id') ?? '',
    type: r.getAttribute('Type') ?? '',
    target: r.getAttribute('Target') ?? '',
    external: r.getAttribute('TargetMode') === 'External',
  }));
}

const OFFICE = 'application/vnd.openxmlformats-officedocument';
/** The content type each kind of relationship must lead to (ECMA-376 Part 1, 11 and 15). */
const PART_TYPE: Record<string, string> = {
  officeDocument: `${OFFICE}.wordprocessingml.document.main+xml`,
  styles: `${OFFICE}.wordprocessingml.styles+xml`,
  numbering: `${OFFICE}.wordprocessingml.numbering+xml`,
  footnotes: `${OFFICE}.wordprocessingml.footnotes+xml`,
  endnotes: `${OFFICE}.wordprocessingml.endnotes+xml`,
  settings: `${OFFICE}.wordprocessingml.settings+xml`,
  fontTable: `${OFFICE}.wordprocessingml.fontTable+xml`,
  header: `${OFFICE}.wordprocessingml.header+xml`,
  footer: `${OFFICE}.wordprocessingml.footer+xml`,
  theme: `${OFFICE}.theme+xml`,
  'core-properties': 'application/vnd.openxmlformats-package.core-properties+xml',
  'extended-properties': `${OFFICE}.extended-properties+xml`,
  'custom-properties': `${OFFICE}.custom-properties+xml`,
  image: 'image/',
};

/** The structural checks, each a list of problems that should be empty. */
function packageProblems(files: Files): string[] {
  const problems: string[] = [];
  const names = Object.keys(files).filter((n) => !n.endsWith('/'));
  const types = parse(files, '[Content_Types].xml');
  const defaults = new Map(
    [...types.getElementsByTagNameNS(NS.ct, 'Default')].map((d) => [d.getAttribute('Extension')!.toLowerCase(), d.getAttribute('ContentType')!]),
  );
  const overrides = new Map(
    [...types.getElementsByTagNameNS(NS.ct, 'Override')].map((o) => [o.getAttribute('PartName')!, o.getAttribute('ContentType')!]),
  );
  for (const partName of overrides.keys()) {
    if (!names.includes(partName.slice(1))) problems.push(`[Content_Types].xml names ${partName}, which is not in the package`);
  }
  const typeOf = (name: string) => overrides.get(`/${name}`) ?? defaults.get(name.split('.').pop()!.toLowerCase());
  for (const name of names) {
    if (name !== '[Content_Types].xml' && !typeOf(name)) problems.push(`${name} has no content type`);
  }

  for (const rels of names.filter((n) => n.endsWith('.rels'))) {
    const source = sourceOf(rels);
    if (source && !names.includes(source)) problems.push(`${rels} belongs to ${source}, which is not in the package`);
    const list = relationships(files, rels);
    const ids = list.map((r) => r.id);
    if (new Set(ids).size !== ids.length) problems.push(`${rels} repeats a relationship Id: ${ids.join(', ')}`);
    for (const r of list) {
      if (!/^[A-Za-z_][\w.-]*$/.test(r.id)) problems.push(`${rels}: Id "${r.id}" is not an XML ID`);
      const kind = r.type.split('/').pop()!;
      if (kind === 'hyperlink' && !r.external) problems.push(`${rels}: hyperlink ${r.id} is not external`);
      if (r.external) continue;
      const target = resolveTarget(source, r.target);
      if (!names.includes(target)) problems.push(`${rels}: ${r.id} points at ${target}, which is not in the package`);
      const wanted = PART_TYPE[kind];
      const actual = typeOf(target) ?? '';
      if (wanted && !(wanted.endsWith('/') ? actual.startsWith(wanted) : actual === wanted)) {
        problems.push(`${rels}: ${r.id} is a ${kind} relationship to ${target}, whose content type is ${actual}`);
      }
    }
  }

  const root = relationships(files, '_rels/.rels');
  const main = root.find((r) => r.type === `${NS.r}/officeDocument`);
  if (!main || typeOf(resolveTarget('', main.target)) !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') {
    problems.push('The package has no main document of the right type');
  }

  // Every r:id, r:embed and r:link names a relationship of its own part.
  for (const part of xmlParts(files).filter((n) => n.endsWith('.xml'))) {
    const ids = new Set(names.includes(relsOf(part)) ? relationships(files, relsOf(part)).map((r) => r.id) : []);
    for (const el of parse(files, part).getElementsByTagName('*')) {
      for (const attr of el.attributes) {
        if (attr.namespaceURI === NS.r && !ids.has(attr.value)) problems.push(`${part}: ${attr.name}="${attr.value}" has no relationship`);
      }
    }
  }
  return problems;
}

function wellFormedProblems(files: Files): string[] {
  const problems: string[] = [];
  for (const name of xmlParts(files)) {
    try {
      parse(files, name);
    } catch (error) {
      problems.push(String(error));
    }
  }
  return problems;
}

function schemaOrderProblems(files: Files): string[] {
  return xmlParts(files)
    .filter((n) => n.startsWith('word/') && n.endsWith('.xml'))
    .flatMap((name) => orderProblems(parse(files, name).documentElement, name));
}

/** The WordprocessingML parts, leaving out the theme, which is DrawingML. */
const wordParts = (files: Files) => xmlParts(files).filter((n) => n.startsWith('word/') && n.endsWith('.xml') && !n.includes('/theme/'));

const BLOCKS = new Set(['w:p', 'w:tbl', 'w:sdt', 'w:customXml', 'w:altChunk']);
const RUN_LEVEL = new Set(['w:r', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:proofErr', 'w:ins', 'w:del', 'w:fldSimple', 'w:sdt', 'w:customXml', 'w:smartTag', 'w:permStart', 'w:permEnd', 'w:hyperlink']);

/** Cells end with a paragraph; headers, footers and notes hold one; tables are complete. */
function blockProblems(files: Files): string[] {
  const problems: string[] = [];
  for (const part of wordParts(files)) {
    const xml = parse(files, part);
    for (const cell of all(xml, 'w:tc')) {
      if (nameOf(cell.lastElementChild!) !== 'w:p') problems.push(`${part}: a table cell does not end with a paragraph`);
    }
    for (const holder of [...all(xml, 'w:hdr'), ...all(xml, 'w:ftr'), ...all(xml, 'w:footnote'), ...all(xml, 'w:endnote')]) {
      // A note in settings only names a separator, and is empty.
      if (nameOf(holder.parentElement ?? holder).endsWith('Pr')) continue;
      if (!children(holder).some((c) => BLOCKS.has(nameOf(c)))) problems.push(`${part}: <${nameOf(holder)}> holds no paragraph`);
    }
    for (const table of all(xml, 'w:tbl')) {
      const names = children(table).map(nameOf);
      if (!names.includes('w:tblPr') || !names.includes('w:tblGrid')) problems.push(`${part}: a table lacks tblPr or tblGrid`);
      const columns = all(table, 'w:gridCol').filter((c) => c.parentElement?.parentElement === table).length;
      for (const row of children(table).filter((c) => nameOf(c) === 'w:tr')) {
        const spanned = children(row)
          .filter((c) => nameOf(c) === 'w:tc')
          .reduce((sum, cell) => sum + Number(all(cell, 'w:gridSpan')[0] ? wAttr(all(cell, 'w:gridSpan')[0], 'val') : 1), 0);
        if (spanned !== columns) problems.push(`${part}: a row spans ${spanned} of ${columns} grid columns`);
      }
    }
  }
  return problems;
}

/** Links hold runs, bookmarks pair up, drawings have ids of their own, spaces are kept. */
function inlineProblems(files: Files): string[] {
  const problems: string[] = [];
  const docPrIds: string[] = [];
  for (const part of wordParts(files)) {
    const xml = parse(files, part);
    for (const link of all(xml, 'w:hyperlink')) {
      const names = children(link).map(nameOf);
      if (!names.includes('w:r') || names.some((n) => !RUN_LEVEL.has(n))) problems.push(`${part}: a hyperlink holds ${names.join(', ')}`);
    }
    const starts = all(xml, 'w:bookmarkStart').map((b) => wAttr(b, 'id'));
    const ends = all(xml, 'w:bookmarkEnd').map((b) => wAttr(b, 'id'));
    if (new Set(starts).size !== starts.length || [...starts].sort().join() !== [...ends].sort().join()) {
      problems.push(`${part}: bookmarks do not pair up (${starts.join()} / ${ends.join()})`);
    }
    docPrIds.push(...all(xml, 'wp:docPr').map((d) => d.getAttribute('id') ?? ''));
    for (const el of [...all(xml, 'w:t'), ...all(xml, 'w:instrText')]) {
      const value = el.textContent ?? '';
      if (value !== value.trim() && el.getAttribute('xml:space') !== 'preserve') problems.push(`${part}: "${value}" loses its spaces`);
    }
  }
  if (new Set(docPrIds).size !== docPrIds.length) problems.push(`drawing ids repeat: ${docPrIds.join(', ')}`);
  return problems;
}

/** Every reference has its note, every note is referenced once, and the separators exist. */
function noteProblems(files: Files): string[] {
  const problems: string[] = [];
  const settings = files['word/settings.xml'] ? parse(files, 'word/settings.xml') : null;
  for (const kind of ['footnote', 'endnote'] as const) {
    const notesPart = `word/${kind}s.xml`;
    const notes = files[notesPart] ? all(parse(files, notesPart), `w:${kind}`) : [];
    const ids = notes.map((n) => wAttr(n, 'id')!);
    if (new Set(ids).size !== ids.length) problems.push(`${notesPart}: note ids repeat`);
    const normal = notes.filter((n) => !wAttr(n, 'type') || wAttr(n, 'type') === 'normal').map((n) => wAttr(n, 'id')!);
    const references = wordParts(files).flatMap((p) => all(parse(files, p), `w:${kind}Reference`).map((r) => wAttr(r, 'id')!));
    for (const id of references) if (!normal.includes(id)) problems.push(`a ${kind} reference names ${id}, which is not a ${kind}`);
    if (new Set(references).size !== references.length) problems.push(`a ${kind} is referenced twice`);
    for (const id of normal) if (!references.includes(id)) problems.push(`${kind} ${id} is never referenced`);
    if (notes.length > 0) {
      const named = settings ? all(settings, `w:${kind}`).map((n) => wAttr(n, 'id')!) : [];
      for (const id of named.length > 0 ? named : ['-1', '0']) {
        const note = notes.find((n) => wAttr(n, 'id') === id);
        if (!note || !/^(separator|continuationSeparator|continuationNotice)$/.test(wAttr(note, 'type') ?? '')) {
          problems.push(`${notesPart}: separator ${kind} ${id} is missing`);
        }
      }
    }
  }
  return problems;
}

/** Every list names a numbering instance, and every instance an abstract one. */
function numberingProblems(files: Files): string[] {
  const problems: string[] = [];
  const numbering = files['word/numbering.xml'] ? parse(files, 'word/numbering.xml') : null;
  const nums = numbering ? all(numbering, 'w:num').map((n) => wAttr(n, 'numId')) : [];
  const abstracts = numbering ? all(numbering, 'w:abstractNum').map((n) => wAttr(n, 'abstractNumId')) : [];
  if (new Set(nums).size !== nums.length || new Set(abstracts).size !== abstracts.length) problems.push('numbering ids repeat');
  for (const num of numbering ? all(numbering, 'w:num') : []) {
    const abstract = wAttr(all(num, 'w:abstractNumId')[0], 'val');
    if (!abstracts.includes(abstract)) problems.push(`numbering ${wAttr(num, 'numId')} names abstract ${abstract}, which is missing`);
  }
  for (const part of wordParts(files)) {
    for (const numPr of all(parse(files, part), 'w:numPr')) {
      const id = all(numPr, 'w:numId')[0] ? wAttr(all(numPr, 'w:numId')[0], 'val') : null;
      const level = Number(all(numPr, 'w:ilvl')[0] ? wAttr(all(numPr, 'w:ilvl')[0], 'val') : 0);
      if (id !== null && id !== '0' && !nums.includes(id)) problems.push(`${part}: list ${id} has no numbering`);
      if (!(level >= 0 && level <= 8)) problems.push(`${part}: list level ${level} is out of range`);
    }
  }
  return problems;
}

/** Every style named, by a paragraph, a run or another style, exists with the right type. */
function styleProblems(files: Files): string[] {
  const problems: string[] = [];
  const styles = parse(files, 'word/styles.xml');
  const styleType = new Map<string, string>();
  for (const style of all(styles, 'w:style')) {
    const id = wAttr(style, 'styleId')!;
    if (styleType.has(id)) problems.push(`style ${id} is defined twice`);
    styleType.set(id, wAttr(style, 'type') ?? 'paragraph');
  }
  const check = (where: string, id: string | null, type: string) => {
    if (id && styleType.get(id) !== type) problems.push(`${where} names ${type} style ${id}, which ${styleType.has(id) ? `is a ${styleType.get(id)} style` : 'is not defined'}`);
  };
  for (const part of wordParts(files)) {
    const xml = parse(files, part);
    for (const el of all(xml, 'w:pStyle')) if (nameOf(el.parentElement!) === 'w:pPr') check(part, wAttr(el, 'val'), 'paragraph');
    for (const el of all(xml, 'w:rStyle')) check(part, wAttr(el, 'val'), 'character');
    for (const el of all(xml, 'w:tblStyle')) check(part, wAttr(el, 'val'), 'table');
  }
  for (const style of all(styles, 'w:style')) {
    const type = wAttr(style, 'type') ?? 'paragraph';
    for (const child of children(style)) {
      const where = `style ${wAttr(style, 'styleId')}`;
      if (nameOf(child) === 'w:basedOn' || nameOf(child) === 'w:next') check(where, wAttr(child, 'val'), type);
      if (nameOf(child) === 'w:link') check(where, wAttr(child, 'val'), type === 'paragraph' ? 'character' : 'paragraph');
    }
  }
  return problems;
}

/** Every section holds a paragraph of its own, as Word itself always writes. */
function sectionProblems(files: Files): string[] {
  const problems: string[] = [];
  const body = all(parse(files, 'word/document.xml'), 'w:body')[0];
  let sinceBreak = 0;
  for (const block of children(body)) {
    if (nameOf(block) === 'w:sectPr') {
      if (sinceBreak === 0) problems.push('the last section of the document is empty');
    } else {
      sinceBreak += 1;
      const properties = children(block).find((c) => nameOf(c) === 'w:pPr');
      if (properties && children(properties).some((c) => nameOf(c) === 'w:sectPr')) sinceBreak = 0;
    }
  }
  return problems;
}

const W3CDTF = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;

function propertiesProblems(files: Files): string[] {
  const problems: string[] = [];
  const core = parse(files, 'docProps/core.xml').documentElement;
  if (core.namespaceURI !== NS.cp || core.localName !== 'coreProperties') problems.push(`core.xml root is ${nameOf(core)}`);
  for (const el of children(core)) {
    const name = nameOf(el);
    if (!/^(dc|dcterms|cp):/.test(name)) problems.push(`core.xml holds ${name}`);
    if (name === 'dcterms:created' || name === 'dcterms:modified') {
      if (el.getAttributeNS(NS.xsi, 'type') !== 'dcterms:W3CDTF') problems.push(`core.xml ${name} is not typed dcterms:W3CDTF`);
      if (!W3CDTF.test(el.textContent ?? '')) problems.push(`core.xml ${name} "${el.textContent}" is not a W3CDTF date`);
    }
  }
  for (const name of ['dc:title', 'dc:creator', 'dcterms:created', 'dcterms:modified']) {
    if (!children(core).some((c) => nameOf(c) === name)) problems.push(`core.xml lacks ${name}`);
  }
  const app = parse(files, 'docProps/app.xml').documentElement;
  if (app.namespaceURI !== NS.ep || app.localName !== 'Properties') problems.push(`app.xml root is ${nameOf(app)}`);
  for (const el of app.getElementsByTagName('*')) {
    if (el.namespaceURI !== NS.ep && el.namespaceURI !== NS.vt) problems.push(`app.xml holds ${nameOf(el)}`);
  }
  return problems;
}

const matter = (words: string) => ({ include: true, content: doc(para(text(words))) });

const PUBLISHING: BookPublishing = {
  coverAssetId: 'asset-portrait',
  series: 'The Vale & Beyond',
  seriesNumber: '2',
  description: 'A ranger rides <north> & back.',
  publisher: 'Silver Gate Press',
  isbn: '978-1-234-56789-7',
  copyrightYear: '2026',
  copyright: { include: true, content: null },
  dedication: matter('For the riders.'),
  epigraph: matter('Not all roads run north.'),
  acknowledgments: matter('My thanks to the Wardens.'),
  aboutAuthor: matter('She lives by the sea.'),
  appendices: [
    { title: 'Who Is Who', kind: 'cast', categories: [], pageTypes: ['character'], canonOnly: true, hideSpoilers: true },
    { title: 'The Maps', kind: 'maps', categories: [], pageTypes: [], canonOnly: true, hideSpoilers: true },
  ],
};

/** The book, with every kind of block the wiki fixture holds put into its last scene. */
function everything(): ExportSnapshot {
  const snapshot = fixtureSnapshot();
  const aria = snapshot.pages.find((p) => p.id === 'aria')!;
  snapshot.nodes.find((n) => n.id === 'scene-snow')!.content = aria.content;
  snapshot.books[0].publishing = PUBLISHING;
  snapshot.maps = [{ id: 'm1', title: 'The North', assetId: 'asset-map', pins: [] }];
  return snapshot;
}

function emptyBook(): ExportSnapshot {
  const snapshot = fixtureSnapshot();
  snapshot.nodes = [];
  return snapshot;
}

const oneBook: Partial<ExportOptions> = { scope: 'book', bookId: 'book-1' };

const VARIANTS: [string, Partial<ExportOptions>, (() => ExportSnapshot)?][] = [
  ['one book', oneBook],
  ['one book with publishing details and every kind of block', { ...oneBook, bookMatter: true }, everything],
  ['the same without book matter', { ...oneBook, bookMatter: false }, everything],
  ['all books', { scope: 'books' }],
  ['a manuscript', { ...oneBook, manuscriptFormat: true }],
  ['a manuscript with every kind of block', { ...oneBook, manuscriptFormat: true }, everything],
  ['scene titles', { ...oneBook, sceneTitles: true }],
  ['an empty book', oneBook, emptyBook],
  ['an empty book with publishing details', oneBook, () => ({ ...emptyBook(), books: everything().books })],
];

// Documents made elsewhere, such as by the end-to-end tests into e2e/artifacts, can be held to
// the same checks: LORECRAFT_CHECK_DOCX="a.docx;b.docx" npx vitest run src/exporters/docxStructure.test.ts
const madeElsewhere = (process.env.LORECRAFT_CHECK_DOCX ?? '').split(';').filter(Boolean);

describe.each([
  ...VARIANTS.map(([name, options, snapshot]) => [name, async () => exportDocx(fixtureInput(options, snapshot?.()))] as const),
  ...madeElsewhere.map((path) => [path, async () => new Uint8Array(readFileSync(path))] as const),
])('a Word document: %s', (_name, make) => {
  let files: Files;

  beforeAll(async () => {
    files = unzipSync(await make());
  }, 60_000);

  it('is a complete package: content types, relationships and their targets agree', () => {
    expect(packageProblems(files)).toEqual([]);
  });

  it('has only well-formed XML parts', () => {
    expect(wellFormedProblems(files)).toEqual([]);
  });

  it('puts child elements in the order the WordprocessingML schema requires', () => {
    expect(schemaOrderProblems(files)).toEqual([]);
  });

  it('ends every cell with a paragraph, and gives headers, footers, notes and tables what they need', () => {
    expect(blockProblems(files)).toEqual([]);
  });

  it('holds only runs in links, pairs its bookmarks, and gives each drawing its own id', () => {
    expect(inlineProblems(files)).toEqual([]);
  });

  it('has a note for every note reference, and the separator notes', () => {
    expect(noteProblems(files)).toEqual([]);
  });

  it('numbers lists from numbering that exists', () => {
    expect(numberingProblems(files)).toEqual([]);
  });

  it('defines every style it names, with the right type', () => {
    expect(styleProblems(files)).toEqual([]);
  });

  it('never ends in an empty section', () => {
    expect(sectionProblems(files)).toEqual([]);
  });

  it('has document properties with the right namespaces and typed dates', () => {
    expect(propertiesProblems(files)).toEqual([]);
  });
});

it('gives Word a real language tag, whatever was typed', async () => {
  const lang = async (language: string) => {
    const styles = strFromU8(unzipSync(await exportDocx(fixtureInput({ ...oneBook, language })))['word/styles.xml']);
    return /<w:lang w:val="([^"]*)"/.exec(styles)?.[1];
  };
  expect(await lang('pt_BR')).toBe('pt-BR');
  expect(await lang(' fr ')).toBe('fr');
  expect(await lang('Français')).toBe('en');
}, 60_000);

it('the fullest variant really holds what the checks are meant to see', async () => {
  const files = unzipSync(await exportDocx(fixtureInput({ ...oneBook, bookMatter: true }, everything())));
  const document = parse(files, 'word/document.xml');
  const frames = all(document, 'w:framePr').map((f) => wAttr(f, 'xAlign'));
  expect(frames).toContain('left');
  expect(frames).toContain('right');
  expect(all(document, 'w:gridSpan').some((s) => wAttr(s, 'val') === '2')).toBe(true);
  expect(all(document, 'w:hyperlink').length).toBeGreaterThan(1);
  expect(all(document, 'w:footnoteReference').length).toBeGreaterThanOrEqual(3);
  expect(all(document, 'w:ilvl').some((l) => wAttr(l, 'val') === '8')).toBe(true);
  expect(all(document, 'w:drawing').length).toBeGreaterThanOrEqual(3);
  expect(all(document, 'w:sectPr')).toHaveLength(2);
  expect(all(document, 'w:br').length).toBeGreaterThan(0);
}, 60_000);

describe('the structure checks themselves', () => {
  const xml = (body: string) =>
    new DOMParser().parseFromString(`<w:document xmlns:w="${NS.w}"><w:body>${body}</w:body></w:document>`, 'application/xml').documentElement;

  it('catch properties out of schema order, repeated, or after content', () => {
    expect(orderProblems(xml('<w:p><w:pPr><w:jc w:val="center"/><w:pStyle w:val="A"/></w:pPr></w:p>'), 'x')).toHaveLength(1);
    expect(orderProblems(xml('<w:p><w:pPr><w:pStyle w:val="A"/><w:pStyle w:val="B"/></w:pPr></w:p>'), 'x')).toHaveLength(1);
    expect(orderProblems(xml('<w:p><w:r/><w:pPr/></w:p>'), 'x')).toHaveLength(1);
    expect(orderProblems(xml('<w:sectPr/><w:p/>'), 'x')).toHaveLength(1);
    expect(orderProblems(xml('<w:p><w:r><w:rPr><w:sz w:val="2"/><w:b/></w:rPr></w:r></w:p>'), 'x')).toHaveLength(1);
    expect(orderProblems(xml('<w:sectPr><w:footerReference/><w:headerReference/><w:pgSz/><w:titlePg/></w:sectPr>'), 'x')).toEqual([]);
    expect(orderProblems(xml('<w:sectPr><w:titlePg/><w:pgNumType/></w:sectPr>'), 'x')).toHaveLength(1);
  });

  it('catch order faults in styles, numbering, tables and settings', () => {
    const root = (tag: string, inner: string) =>
      new DOMParser().parseFromString(`<w:${tag} xmlns:w="${NS.w}">${inner}</w:${tag}>`, 'application/xml').documentElement;
    expect(orderProblems(root('styles', '<w:style/><w:docDefaults><w:pPrDefault/><w:rPrDefault/></w:docDefaults>'), 'x')).toHaveLength(2);
    expect(orderProblems(root('numbering', '<w:num/><w:abstractNum><w:lvl><w:lvlText/><w:numFmt/></w:lvl></w:abstractNum>'), 'x')).toHaveLength(2);
    expect(orderProblems(root('tbl', '<w:tblGrid/><w:tblPr/><w:tr><w:tc><w:p/><w:tcPr/></w:tc></w:tr>'), 'x')).toHaveLength(2);
    expect(orderProblems(root('settings', '<w:compat/><w:defaultTabStop/><w:displayBackgroundShape/>'), 'x')).toHaveLength(2);
    expect(orderProblems(root('trPr', '<w:tblHeader/><w:cantSplit/><w:trHeight/>'), 'x')).toEqual([]);
  });

  it('catch a broken package, a dangling style and an empty last section in a real export', async () => {
    const files = unzipSync(await exportDocx(fixtureInput(oneBook)));
    const broken: Files = { ...files };
    delete broken['word/numbering.xml'];
    broken['word/media/extra.webp'] = new Uint8Array(1);
    broken['word/document.xml'] = new TextEncoder().encode(strFromU8(files['word/document.xml']).replace('r:embed="', 'r:embed="nothing'));
    const found = packageProblems(broken).join('\n');
    expect(found).toContain('/word/numbering.xml, which is not in the package');
    expect(found).toContain('word/media/extra.webp has no content type');
    expect(found).toContain('points at word/numbering.xml');
    expect(found).toContain('has no relationship');

    const styles = strFromU8(files['word/styles.xml']).replace(/<w:style [^>]*w:styleId="DefaultParagraphFont"[^>]*>.*?<\/w:style>/, '');
    expect(styleProblems({ ...files, 'word/styles.xml': new TextEncoder().encode(styles) }).join()).toContain('DefaultParagraphFont, which is not defined');

    const sections = (body: string) =>
      sectionProblems({ 'word/document.xml': new TextEncoder().encode(`<w:document xmlns:w="${NS.w}"><w:body>${body}</w:body></w:document>`) });
    expect(sections('<w:p><w:pPr><w:sectPr/></w:pPr></w:p><w:sectPr/>')).toHaveLength(1);
    expect(sections('<w:p><w:pPr><w:sectPr/></w:pPr></w:p><w:p/><w:sectPr/>')).toEqual([]);
  });

  it('resolve relationship targets against the part that holds them', () => {
    expect(sourceOf('word/_rels/document.xml.rels')).toBe('word/document.xml');
    expect(sourceOf('_rels/.rels')).toBe('');
    expect(relsOf('word/footer1.xml')).toBe('word/_rels/footer1.xml.rels');
    expect(resolveTarget('word/document.xml', 'media/image1.png')).toBe('word/media/image1.png');
    expect(resolveTarget('word/document.xml', '../docProps/app.xml')).toBe('docProps/app.xml');
    expect(resolveTarget('', 'word/document.xml')).toBe('word/document.xml');
    expect(resolveTarget('word/document.xml', '/word/styles.xml')).toBe('word/styles.xml');
  });
});
