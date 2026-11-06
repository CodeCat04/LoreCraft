/** What the exporters and importers need from the converter, beyond its everyday use. */

import { getSchema } from '@tiptap/core';
import { Node as ProseNode } from '@tiptap/pm/model';

import { markdownToPm, pmToHtml, pmToMarkdown, pmToPlainText } from './convert';
import { documentExtensions } from './schema';
import type { PmNode } from '../lib/types';

const schema = getSchema(documentExtensions());

function assertValid(doc: PmNode) {
  ProseNode.fromJSON(schema, doc).check();
}

function para(...content: PmNode[]): PmNode {
  return { type: 'paragraph', content };
}

function text(value: string, ...marks: NonNullable<PmNode['marks']>): PmNode {
  return marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value };
}

function doc(...content: PmNode[]): PmNode {
  return { type: 'doc', content };
}

describe('Markdown keeps awkward text literal', () => {
  const literal: [string, string][] = [
    ['angle brackets', 'a <script>alert(1)</script> b'],
    ['an autolink lookalike', 'see <http://example.com> here'],
    ['ampersand entities', 'AT&amp;T and &#65; and &copy; stay as typed'],
    ['a lone ampersand', 'salt & pepper'],
    ['a CDATA end', 'odd ]]> text'],
    ['a rule made of dashes', '---'],
    ['a rule made of equals', '==='],
    ['a bare hash', '#'],
    ['a bare dash', '-'],
    ['backslashes', 'C:\\temp\\new'],
    ['a citation lookalike', 'x ^[not a note] y'],
    ['a wiki link lookalike', 'x [[not a link]] y'],
    ['underscores', '_a_ __b__ snake_case'],
    ['emoji and marks', '🐉 Éowyn’s “quote” — 龍 العربية'],
  ];

  it.each(literal)('keeps %s', (_name, value) => {
    const original = doc(para(text(value)));
    expect(markdownToPm(pmToMarkdown(original))).toEqual(original);
  });

  it('keeps a code span holding backticks', () => {
    const original = doc(para(text('a ``b` c', { type: 'code' })));
    expect(markdownToPm(pmToMarkdown(original))).toEqual(original);
    const edge = doc(para(text('`edge`', { type: 'code' })));
    expect(markdownToPm(pmToMarkdown(edge))).toEqual(edge);
  });

  it('keeps a code block holding a fence', () => {
    const original = doc({ type: 'codeBlock', attrs: { language: null }, content: [text('```\nx\n```')] });
    expect(markdownToPm(pmToMarkdown(original))).toEqual(original);
  });

  it('does not let a hard break start a list or heading', () => {
    const original = doc(para(text('first'), { type: 'hardBreak' }, text('- not a list'), { type: 'hardBreak' }, text('# not a heading')));
    expect(markdownToPm(pmToMarkdown(original))).toEqual(original);
    const setext = doc(para(text('first'), { type: 'hardBreak' }, text('---')));
    expect(markdownToPm(pmToMarkdown(setext))).toEqual(setext);
  });

  it('keeps emphasis working when a run has spaces at its edges', () => {
    const md = pmToMarkdown(doc(para(text('a '), text(' bold ', { type: 'bold' }), text('b'))));
    const back = markdownToPm(md);
    expect(pmToPlainText(back)).toBe('a  bold b');
    expect(JSON.stringify(back)).toContain('"type":"bold"');
    expect(md).toContain('**bold**');
  });

  it('does not treat text as code because it starts with spaces', () => {
    const back = markdownToPm(pmToMarkdown(doc(para(text('    indented')))));
    expect(back.content![0].type).toBe('paragraph');
    expect(pmToPlainText(back)).toBe('indented');
  });

  it('does not break a heading or table with a hard break', () => {
    const heading = doc({ type: 'heading', attrs: { level: 2 }, content: [text('one'), { type: 'hardBreak' }, text('two')] });
    const back = markdownToPm(pmToMarkdown(heading));
    expect(back.content!.length).toBe(1);
    expect(pmToPlainText(back)).toBe('one two');

    const table = doc({ type: 'table', content: [{ type: 'tableRow', content: [
      { type: 'tableHeader', content: [para(text('a|b'), { type: 'hardBreak' }, text('c'))] },
    ]}]});
    const backTable = markdownToPm(pmToMarkdown(table));
    expect(backTable.content!.length).toBe(1);
    expect(pmToPlainText(backTable)).toBe('a|b c');
  });
});

describe('wiki links and citations with brackets', () => {
  it('round-trips targets and labels holding brackets and pipes', () => {
    const original = doc(para(
      text('Aria [the first]', { type: 'wikiLink', attrs: { target: 'Aria [draft] | old' } }),
      text(' and '),
      text('C:\\x', { type: 'wikiLink', attrs: { target: 'C:\\x' } }),
    ));
    expect(markdownToPm(pmToMarkdown(original))).toEqual(original);
  });

  it('round-trips citations holding brackets', () => {
    const original = doc(para(text('Claim'), { type: 'reference', attrs: { text: 'Vol. [2], p. 3 ] end \\ slash' } }));
    expect(markdownToPm(pmToMarkdown(original))).toEqual(original);
  });

  it('still reads links the way people type them', () => {
    expect(markdownToPm('[[A]b]]').content![0].content![0].marks![0].attrs!.target).toBe('A]b');
    expect(pmToPlainText(markdownToPm('[[ not [ a link ]]'))).toBe('[[ not [ a link ]]');
    expect(pmToPlainText(markdownToPm('[[unclosed'))).toBe('[[unclosed');
  });
});

describe('links and images with awkward addresses', () => {
  it('keeps a link with spaces and parentheses', () => {
    const original = doc(para(text('x', { type: 'link', attrs: { href: 'https://example.com/a(b) c' } })));
    const back = markdownToPm(pmToMarkdown(original));
    expect(back.content![0].content![0].marks![0].attrs!.href).toBe('https://example.com/a%28b%29%20c');
  });
});

describe('figure labels', () => {
  const figure = (caption: string, description = ''): PmNode => ({
    type: 'doc',
    content: [{
      type: 'figure',
      attrs: { kind: 'figure', align: 'right', width: null, description },
      content: [
        { type: 'image', attrs: { assetId: 'a', alt: caption } },
        { type: 'figcaption', content: [text(caption)] },
      ],
    }],
  });

  it.each([
    ['brackets', 'The [old] map'],
    ['asterisks', 'A *very* old map'],
    ['underscores', '_old_ map'],
    ['quotes', 'The "old" map'],
    ['angle brackets', 'The <old> map & more'],
    ['backslashes', 'C:\\maps\\old'],
  ])('keeps %s through Markdown', (_name, caption) => {
    expect(markdownToPm(pmToMarkdown(figure(caption, 'Says "what" it shows')))).toEqual(figure(caption, 'Says "what" it shows'));
  });
});

describe('markdownToPm always produces valid documents', () => {
  const samples: [string, string][] = [
    ['bold and italic together', '***both*** **bold *mixed***'],
    ['a link with marks', '[**bold link**](https://example.com) and [[Page|*styled*]]'],
    ['code in bold', '**`code`**'],
    ['a code link', '[`code`](https://example.com)'],
    ['an image in a heading', '# Title ![cap](asset:a) end'],
    ['an image in a table', '| A |\n|---|\n| ![cap](asset:a) |\n'],
    ['an image in a list', '- ![cap](asset:a)\n- text ![cap](asset:b) more\n'],
    ['an image in a quote', '> ![cap](asset:a)\n'],
    ['a video', '![cap](video:asset:v)\n\n![cap](video:https://example.com/v.mp4 "desc")\n'],
    ['a table with a label', '| A |\n|---|\n| 1 |\n\nTable: The label\n'],
    ['a citation in a heading', '## Early life ^[Source]\n'],
    ['deep lists', '- a\n  - b\n    - c\n      - d\n        - e\n          1. f\n             - g\n'],
    ['raw html', '<div class="x">hi</div>\n\n<img src=x onerror=alert(1)>\n'],
    ['a figure caption with an alt', '![A *styled* cap](asset:a)'],
    ['an empty list item', '- \n- b\n'],
    ['a heading with nothing', '##\n'],
  ];

  it.each(samples)('for %s', (_name, markdown) => {
    assertValid(markdownToPm(markdown));
  });
});

describe('pmToHtml options for exporters', () => {
  it('gives headings ids and numbers citations through hooks', () => {
    let notes = 0;
    const html = pmToHtml(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('Early "life"')] },
        para(text('Claim'), { type: 'reference', attrs: { text: 'A <source>' } }),
      ),
      {
        headingId: (value, level) => `s${level}-${value.length}`,
        reference: (value) => {
          notes += 1;
          return `<sup>[${notes}:${value.length}]</sup>`;
        },
      },
    );
    expect(html).toContain('<h2 id="s2-12">Early &quot;life&quot;</h2>');
    expect(html).toContain('<sup>[1:10]</sup>');
  });

  it('keeps the default citation without hooks', () => {
    const html = pmToHtml(doc(para({ type: 'reference', attrs: { text: 'x' } })));
    expect(html).toBe('<p><sup class="reference" title="x">*</sup></p>');
  });

  it('refuses remote images when asked, and keeps project images', () => {
    const remote = doc({ type: 'image', attrs: { src: 'https://evil.example/x.png', alt: 'x' } });
    expect(pmToHtml(remote)).toContain('<img src="https://evil.example/x.png"');
    expect(pmToHtml(remote, { remoteImages: false })).toBe('<em>[image: x]</em>');
    const local = doc({ type: 'image', attrs: { assetId: 'a', alt: 'x' } });
    expect(pmToHtml(local, { remoteImages: false, assetSrc: (id) => `images/${id}.png` })).toContain('src="images/a.png"');
  });

  it('keeps a list start and cell spans', () => {
    const html = pmToHtml(doc(
      { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [para(text('c'))] }] },
      { type: 'table', content: [{ type: 'tableRow', content: [
        { type: 'tableCell', attrs: { colspan: 2, rowspan: 1 }, content: [para(text('wide'))] },
      ]}]},
    ));
    expect(html).toContain('<ol start="3">');
    expect(html).toContain('<td colspan="2">');
    expect(pmToHtml(doc({ type: 'orderedList', attrs: { start: 1 }, content: [] }))).toBe('<ol></ol>');
  });
});
