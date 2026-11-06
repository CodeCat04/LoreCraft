import { glyphSampleText, marginBoxFonts, namedPageRules, pageNamesFromMarkers } from './native';

const CSS = `
/* .commented { page: nope; } */
.title-page { page: title-page; text-align: center; }
.doc-print .part-page { page: part-divider; }
.plain { page: auto; }
@page :left { margin-left: 1in; @bottom-left { content: counter(page); font-family: 'Source Serif 4', serif; font-size: 9pt; } }
@page :left { @top-left { content: "The \\"Salt\\" march"; font-family: 'Source Serif 4', serif; font-style: italic; } }
@page :right { @bottom-right { content: counter(page); font-family: 'Source Serif 4', serif; } }
`;

describe('native print helpers', () => {
  it('finds the rules that name pages', () => {
    expect(namedPageRules(CSS)).toEqual([
      { selector: '.title-page', name: 'title-page' },
      { selector: '.doc-print .part-page', name: 'part-divider' },
    ]);
  });

  it('lists each margin box font once', () => {
    expect(marginBoxFonts(CSS)).toEqual([
      { family: "'Source Serif 4', serif", italic: false, bold: false },
      { family: "'Source Serif 4', serif", italic: true, bold: false },
    ]);
  });

  it('samples the digits and every letter of the heads', () => {
    const text = glyphSampleText(CSS);
    for (const letter of '0123456789/"Saltmrch') expect(text).toContain(letter);
    expect(new Set(text).size).toBe(text.length);
  });

  it('gives inner named pages priority and leaves unmarked pages unnamed', () => {
    const names = pageNamesFromMarkers(
      6,
      [
        { name: 'running-1', start: '1', end: '2' },
        { name: 'blank-page', start: '3', end: '4' },
        { name: 'lost', start: '9', end: '10' },
      ],
      { '1': 2, '2': 5, '3': 4, '4': 3 },
    );
    expect(names).toEqual(['', 'running-1', 'running-1', 'blank-page', 'running-1', '']);
  });
});
