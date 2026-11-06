import { layoutText, plainInline, wrapWords } from './exportText';

/** Every character is as wide as its font size times 0.5, so widths are easy to reason about. */
const measure = (text: string, style: { size: number }) => [...text].length * style.size * 0.5;

describe('PNG export text layout', () => {
  it('wraps at the width and breaks words too long for a line', () => {
    const w = (text: string) => text.length;
    expect(wrapWords('the quick brown fox', 10, w)).toEqual(['the quick', 'brown fox']);
    expect(wrapWords('abcdefghijklmnop end', 6, w)).toEqual(['abcdef', 'ghijkl', 'mnop', 'end']);
    expect(wrapWords('', 6, w)).toEqual(['']);
  });

  it('reduces inline Markdown to what the reader sees', () => {
    expect(plainInline('**Aria** meets [[Bran|the smith]] at [the inn](https://x.y) `now`')).toBe('Aria meets the smith at the inn now');
  });

  it('draws headings larger, bullets in the margin and keeps paragraphs apart', () => {
    const lines = layoutText('# Siege\n\nThe walls fall on the third day\n\n- Aria flees\n- Bran stays', 140, 1000, measure);
    expect(lines[0]).toMatchObject({ text: 'Siege', style: { size: 22, bold: true }, x: 0 });
    const body = lines.filter((l) => l.style.size === 14 && !l.style.bold);
    // 140 wide at 7 per character is 20 characters a line.
    expect(body.slice(0, 2).map((l) => l.text)).toEqual(['The walls fall on', 'the third day']);
    const bullets = lines.filter((l) => l.text === '•');
    expect(bullets).toHaveLength(2);
    const aria = lines.find((l) => l.text === 'Aria flees')!;
    expect(aria.x).toBeGreaterThan(0);
    expect(aria.y).toBeGreaterThan(body[1].y);
  });

  it('stops at the bottom of the card', () => {
    const lines = layoutText(Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n\n'), 200, 100, measure);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(10);
    expect(Math.max(...lines.map((l) => l.y))).toBeLessThanOrEqual(100);
  });
});
