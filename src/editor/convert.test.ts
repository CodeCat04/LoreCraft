import { getSchema } from '@tiptap/core';
import { Node as ProseNode } from '@tiptap/pm/model';

import {
  describeFigures,
  escapeHtml,
  markdownToPm,
  pmToHtml,
  pmToMarkdown,
  pmToPlainText,
  renderMarkdownSafe,
  safeUrl,
} from './convert';
import { documentExtensions } from './schema';
import type { PmNode } from '../lib/types';

const schema = getSchema(documentExtensions());

/** Throws if the JSON does not fit the editor's schema. */
function assertValid(doc: PmNode) {
  ProseNode.fromJSON(schema, doc).check();
}

function para(...content: PmNode[]): PmNode {
  return { type: 'paragraph', content };
}

function text(value: string, ...marks: NonNullable<PmNode['marks']>): PmNode {
  return marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value };
}

describe('markdownToPm', () => {
  it('produces documents the editor accepts for every construct', () => {
    const doc = markdownToPm(`# Title

Some **bold** and *italic* and ~~gone~~ and \`code\` and [a link](https://example.com).

> A quote
>
> with two paragraphs

- one
- two
  - nested

3. three
4. four

\`\`\`js
const x = 1;
\`\`\`

---

| A | B |
|---|---|
| 1 | 2 |

![alt](asset:abc)

Line one
line two ^[A citation] and [[Aria Vale|Aria]] and [[Silver Vale]].
`);
    assertValid(doc);
  });

  it('accepts a list item that starts with something other than a paragraph', () => {
    assertValid(markdownToPm('- > quoted item\n- ```\n  code\n  ```\n'));
  });

  it('makes a valid document from empty input', () => {
    const doc = markdownToPm('');
    assertValid(doc);
    expect(doc.content).toEqual([{ type: 'paragraph' }]);
  });

  it('reads wiki links with and without labels', () => {
    const doc = markdownToPm('[[Aria Vale|Aria]] met [[Silver Vale]].');
    expect(doc.content![0].content).toEqual([
      text('Aria', { type: 'wikiLink', attrs: { target: 'Aria Vale' } }),
      text(' met '),
      text('Silver Vale', { type: 'wikiLink', attrs: { target: 'Silver Vale' } }),
      text('.'),
    ]);
  });

  it('keeps raw HTML as literal text rather than interpreting it', () => {
    const doc = markdownToPm('<script>alert(1)</script>');
    expect(pmToPlainText(doc)).toContain('<script>');
    expect(JSON.stringify(doc)).not.toContain('"type":"html');
  });
});

describe('pmToMarkdown round trip', () => {
  const cases: [string, PmNode][] = [
    ['marks', { type: 'doc', content: [para(text('plain '), text('bold', { type: 'bold' }), text(' and '), text('both', { type: 'bold' }, { type: 'italic' }))] }],
    ['wiki links', { type: 'doc', content: [para(text('Aria', { type: 'wikiLink', attrs: { target: 'Aria Vale' } }), text(' and '), text('Vale', { type: 'wikiLink', attrs: { target: 'Vale' } }))] }],
    ['references', { type: 'doc', content: [para(text('Claim'), { type: 'reference', attrs: { text: 'Book 1, ch. 2' } })] }],
    ['headings', { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [text('Early life')] }, para(text('Text'))] }],
    ['special characters', { type: 'doc', content: [para(text('Costs *five* [coins] at 2_3 and # not a heading'))] }],
    ['line-start markers', { type: 'doc', content: [para(text('# not a heading')), para(text('- not a list')), para(text('1. not a list'))] }],
  ];

  it.each(cases)('preserves %s', (_name, doc) => {
    expect(markdownToPm(pmToMarkdown(doc))).toEqual(doc);
  });

  it('keeps nested lists valid', () => {
    const md = pmToMarkdown(markdownToPm('- a\n  - b\n  - c\n- d\n'));
    const doc = markdownToPm(md);
    assertValid(doc);
    expect(doc.content![0].content!.length).toBe(2);
  });

  it('keeps tables', () => {
    const doc = markdownToPm('| A | B |\n|---|---|\n| 1 | 2 |\n');
    expect(markdownToPm(pmToMarkdown(doc))).toEqual(doc);
  });

  it('keeps a figure label, description and image', () => {
    const doc = markdownToPm('![Map of the Vale](asset:x1 "Hand-drawn, north is up")');
    assertValid(doc);
    const figure = doc.content![0];
    expect(figure.type).toBe('figure');
    expect(figure.attrs?.description).toBe('Hand-drawn, north is up');
    expect(figure.content![0].attrs?.assetId).toBe('x1');
    expect(pmToMarkdown(doc)).toBe('![Map of the Vale](asset:x1 "Hand-drawn, north is up")');
  });

  it('keeps stored and linked videos', () => {
    const stored = markdownToPm('![Reference](video:asset:v1)');
    assertValid(stored);
    expect(stored.content![0].attrs?.kind).toBe('video');
    expect(stored.content![0].content![0]).toEqual({ type: 'video', attrs: { assetId: 'v1', url: null } });
    expect(pmToMarkdown(stored)).toBe('![Reference](video:asset:v1)');

    const linked = markdownToPm('![Sword forms](video:https://example.com/watch?v=1)');
    assertValid(linked);
    expect(linked.content![0].content![0].attrs?.url).toBe('https://example.com/watch?v=1');
    expect(pmToMarkdown(linked)).toBe('![Sword forms](video:https://example.com/watch?v=1)');
  });

  it('turns a Table line after a table into that table\'s label', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\nTable: Noble houses';
    const doc = markdownToPm(md);
    assertValid(doc);
    expect(doc.content).toHaveLength(1);
    expect(doc.content![0].type).toBe('figure');
    expect(doc.content![0].attrs?.kind).toBe('table');
    expect(pmToMarkdown(doc)).toBe(md);
  });

  it('leaves a plain paragraph after a table alone', () => {
    const doc = markdownToPm('| A |\n|---|\n| 1 |\n\nNot a label.');
    expect(doc.content!.map((n) => n.type)).toEqual(['table', 'paragraph']);
  });

  it('splits an image out of the paragraph around it', () => {
    const doc = markdownToPm('Before ![x](asset:a) after');
    assertValid(doc);
    expect(doc.content!.map((n) => n.type)).toEqual(['paragraph', 'figure', 'paragraph']);
  });
});

function figure(kind: string, caption: string, attrs: Record<string, unknown> = {}): PmNode {
  const media: PmNode =
    kind === 'video'
      ? { type: 'video', attrs: { assetId: 'v', url: null } }
      : kind === 'table'
        ? { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('cell text'))] }] }] }
        : { type: 'image', attrs: { assetId: 'i', alt: '' } };
  return {
    type: 'figure',
    attrs: { kind, align: 'right', width: null, description: '', ...attrs },
    content: [media, caption ? { type: 'figcaption', content: [text(caption)] } : { type: 'figcaption' }],
  };
}

describe('figures', () => {
  const doc: PmNode = {
    type: 'doc',
    content: [
      figure('picture', 'The gate', { description: 'Aria at dawn' }),
      para(text('Story.')),
      figure('table', 'Houses'),
      figure('picture', ''),
      figure('video', 'Sword forms'),
    ],
  };

  it('fits the editor schema for every kind', () => assertValid(doc));

  it('numbers each kind on its own, in order', () => {
    expect(describeFigures(doc).map((f) => f.name)).toEqual(['Picture 1', 'Table 1', 'Picture 2', 'Video 1']);
  });

  it('reports what each one holds', () => {
    const [picture, table, , video] = describeFigures(doc);
    expect(picture).toMatchObject({ media: 'image', assetId: 'i', caption: 'The gate', description: 'Aria at dawn' });
    expect(table).toMatchObject({ media: 'table', assetId: null });
    expect(video).toMatchObject({ media: 'video', assetId: 'v' });
  });

  it('names figures in plain text so the AI knows they are there', () => {
    const plain = pmToPlainText(doc);
    expect(plain).toContain('[Picture 1: The gate (Aria at dawn)]');
    expect(plain).toContain('[Table 1: Houses]');
    expect(plain).toContain('cell text');
    expect(plain).toContain('[Picture 2: no label]');
    expect(plain).toContain('[Video 1: Sword forms]');
  });

  it('renders HTML with layout, numbering, and escaped text', () => {
    const html = pmToHtml(
      {
        type: 'doc',
        content: [figure('picture', 'A <b>', { align: 'left', width: 40, description: 'alt "text"' })],
      },
      { assetSrc: (id) => `media/${id}.png` },
    );
    expect(html).toContain('<figure class="figure figure-left" style="width: 40%">');
    expect(html).toContain('<img src="media/i.png" alt="alt &quot;text&quot;"/>');
    expect(html).toContain('<span class="figure-name">Picture 1.</span> A &lt;b&gt;');
  });

  it('refuses an unknown alignment rather than writing it into a class', () => {
    const html = pmToHtml({ type: 'doc', content: [figure('picture', 'x', { align: 'x" onload="y' })] });
    expect(html).toContain('figure-right');
    expect(html).not.toContain('onload');
  });

  it('renders a stored video only when given its address, and a linked one as a link', () => {
    const stored: PmNode = { type: 'doc', content: [figure('video', 'x')] };
    expect(pmToHtml(stored)).toContain('[video]');
    expect(pmToHtml(stored, { videoSrc: (id) => `media/${id}.mp4` })).toContain('<video controls="controls" src="media/v.mp4">');

    const linked: PmNode = {
      type: 'doc',
      content: [
        {
          type: 'figure',
          attrs: { kind: 'video' },
          content: [{ type: 'video', attrs: { assetId: null, url: 'javascript:alert(1)' } }, { type: 'figcaption' }],
        },
      ],
    };
    expect(pmToHtml(linked)).not.toContain('javascript:');
  });
});

describe('pmToPlainText', () => {
  it('separates blocks and keeps link labels', () => {
    const doc: PmNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
        para(text('Aria', { type: 'wikiLink', attrs: { target: 'Aria Vale' } }), text(' went.')),
      ],
    };
    expect(pmToPlainText(doc)).toBe('Title\n\nAria went.');
  });
});

describe('pmToHtml', () => {
  it('escapes text and attributes', () => {
    const doc: PmNode = { type: 'doc', content: [para(text('<b>&"'))] };
    expect(pmToHtml(doc)).toBe('<p>&lt;b&gt;&amp;&quot;</p>');
  });

  it('drops dangerous link schemes', () => {
    const doc: PmNode = { type: 'doc', content: [para(text('x', { type: 'link', attrs: { href: 'javascript:alert(1)' } }))] };
    expect(pmToHtml(doc)).toBe('<p>x</p>');
  });

  // A browser drops tabs and line breaks from an address, and control characters around it.
  it('drops dangerous schemes however they are disguised', () => {
    const hostile = [
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'jav\r\nascript:alert(1)',
      '\u0001javascript:alert(1)',
      '\u0000 javascript:alert(1)',
      'javascript\t:alert(1)',
      'JaVaScRiPt:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///C:/Windows/win.ini',
      // Another computer, which from a page opened from disk is a network share.
      '//attacker.example/share/x.html',
      '\\\\attacker.example\\share\\x.html',
      '/\\attacker.example/x',
    ];
    for (const href of hostile) {
      const link: PmNode = { type: 'doc', content: [para(text('x', { type: 'link', attrs: { href } }))] };
      expect(pmToHtml(link), JSON.stringify(href)).toBe('<p>x</p>');
      const image: PmNode = { type: 'doc', content: [{ type: 'image', attrs: { src: href, alt: 'a' } }] };
      expect(pmToHtml(image), JSON.stringify(href)).not.toContain('<img');
      const video: PmNode = { type: 'doc', content: [{ type: 'video', attrs: { url: href } }] };
      expect(pmToHtml(video), JSON.stringify(href)).not.toContain('<a');
    }
  });

  it('keeps web, mail and same-site addresses', () => {
    for (const href of ['https://example.com/a?b=c', 'http://example.com', 'mailto:a@example.com', '#notes', 'pages/aria.html', '/index.html', './a.html', '../b.html']) {
      const doc: PmNode = { type: 'doc', content: [para(text('x', { type: 'link', attrs: { href } }))] };
      expect(pmToHtml(doc)).toBe(`<p><a href="${escapeHtml(href)}">x</a></p>`);
    }
    // What is written is what was checked.
    expect(safeUrl(' https://example.com/\n')).toBe('https://example.com/');
  });

  // A space is fine to a browser but makes the XHTML of an EPUB invalid.
  it('writes spaces and other characters an address cannot hold as escapes', () => {
    const link = (href: string) => pmToHtml({ type: 'doc', content: [para(text('x', { type: 'link', attrs: { href } }))] });
    expect(link('https://example.com/my file.pdf')).toBe('<p><a href="https://example.com/my%20file.pdf">x</a></p>');
    expect(link('notes/the gate.html#first sight')).toBe('<p><a href="notes/the%20gate.html#first%20sight">x</a></p>');
    expect(link('mailto:a@example.com?subject=The gate')).toBe('<p><a href="mailto:a@example.com?subject=The%20gate">x</a></p>');
    // An escape already there is kept, and a lone percent sign is escaped.
    expect(link('https://example.com/a%20b/100%')).toBe('<p><a href="https://example.com/a%20b/100%25">x</a></p>');
    expect(link('https://example.com/"q"<b>{|}^`\u0001\u007f')).toBe(
      '<p><a href="https://example.com/%22q%22%3Cb%3E%7B%7C%7D%5E%60%01%7F">x</a></p>',
    );
    const video = pmToHtml({ type: 'doc', content: [{ type: 'video', attrs: { url: 'https://example.com/a clip.mp4' } }] });
    expect(video).toContain('href="https://example.com/a%20clip.mp4"');
    const image = pmToHtml({ type: 'doc', content: [{ type: 'image', attrs: { src: 'pictures/the gate.png', alt: 'a' } }] });
    expect(image).toBe('<img src="pictures/the%20gate.png" alt="a"/>');
    // Nothing a browser would read differently.
    for (const href of ['https://example.com/a?b=c&d=e#f', 'https://example.com/café', '../b.html']) {
      expect(safeUrl(href)).toBe(href);
    }
  });

  it('resolves wiki links through the callback and marks broken ones', () => {
    const doc: PmNode = {
      type: 'doc',
      content: [
        para(
          text('good', { type: 'wikiLink', attrs: { target: 'Good' } }),
          text('bad', { type: 'wikiLink', attrs: { target: 'Bad' } }),
        ),
      ],
    };
    const html = pmToHtml(doc, { wikiHref: (t) => (t === 'Good' ? 'good.html' : null) });
    expect(html).toContain('<a class="wiki-link" href="good.html">good</a>');
    expect(html).toContain('<span class="wiki-link-red">bad</span>');
  });
});

describe('renderMarkdownSafe', () => {
  it('escapes raw HTML', () => {
    const html = renderMarkdownSafe('<img src=x onerror=alert(1)> <script>x</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
  });

  it('refuses javascript links', () => {
    expect(renderMarkdownSafe('[x](javascript:alert(1))')).not.toContain('href="javascript');
  });

  it('keeps only web and mail addresses as links', () => {
    expect(renderMarkdownSafe('[a](https://example.com/x) [b](http://example.com) [c](mailto:a@example.com)')).toBe(
      '<p><a href="https://example.com/x">a</a> <a href="http://example.com">b</a> <a href="mailto:a@example.com">c</a></p>\n',
    );
    for (const url of ['ms-msdt:/id%20PCWDiagnostic', 'search-ms:query=x', 'file:///C:/x', 'lbasset://localhost/x', '/settings', '#top', '<ms-settings:privacy>']) {
      const html = renderMarkdownSafe(`[open](${url}) and <${url.replace(/[<>]/g, '')}>`);
      expect(html, url).not.toContain('<a');
    }
  });

  it('does not render remote images', () => {
    expect(renderMarkdownSafe('![x](https://evil.example/a.png)')).not.toContain('<img');
  });

  it('renders wiki links with escaped targets', () => {
    const html = renderMarkdownSafe('[[A"><b>|label]]');
    expect(html).toContain('data-wiki-target="A&quot;&gt;&lt;b&gt;"');
    expect(html).not.toContain('<b>');
  });
});
