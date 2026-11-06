import { relativeTime, snippetParts, titleKey, wordCount } from './text';
import wordCountCases from './wordCountCases.json';

describe('titleKey', () => {
  it('normalizes the way the Rust side does', () => {
    expect(titleKey('  Silver_Vale   Keep ')).toBe('silver vale keep');
    expect(titleKey('ÉLAN')).toBe('élan');
  });
});

describe('wordCount', () => {
  it('ignores punctuation-only tokens, matching the Rust side', () => {
    expect(wordCount('one - two -- three')).toBe(3);
    expect(wordCount('')).toBe(0);
    expect(wordCount('  naïve café  ')).toBe(2);
  });

  // The same table runs in `content.rs`, so the two counts cannot drift apart.
  it.each(wordCountCases)('$note', ({ text, words }) => {
    expect(wordCount(text)).toBe(words);
  });

  it('matches the old rule for text in spaced scripts', () => {
    const old = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    const samples = [
      'The rain in Spain, it said—falls mainly (mostly) on the plain; "does it?" Yes!',
      "It's 3.14 o'clock, mother-in-law: e.g. foo,bar & baz... -- ok",
      'Привет, мир! ¿Qué tal? Schöne Grüße. كتب الولد שלום',
    ];
    for (const sample of samples) expect(wordCount(sample)).toBe(old(sample));
  });

  it('stays fast on a long text in any script', () => {
    const text = ['天地玄黄，', 'Привет мир ', 'The quick fox '].map((s) => s.repeat(20000)).join('');
    const started = performance.now();
    expect(wordCount(text)).toBe(80000 + 40000 + 60000);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-01-10T12:00:00Z');
  it('uses words for recent times', () => {
    expect(relativeTime('2026-01-10T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-01-10T11:59:00Z', now)).toBe('1 minute ago');
    expect(relativeTime('2026-01-10T09:00:00Z', now)).toBe('3 hours ago');
  });
  it('returns nothing for invalid input', () => {
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('snippetParts', () => {
  it('splits marked matches', () => {
    expect(snippetParts('a \u0002b\u0003 c')).toEqual([
      { text: 'a ', match: false },
      { text: 'b', match: true },
      { text: ' c', match: false },
    ]);
  });
  it('treats angle brackets as plain text', () => {
    expect(snippetParts('<img src=x>')).toEqual([{ text: '<img src=x>', match: false }]);
  });
});
