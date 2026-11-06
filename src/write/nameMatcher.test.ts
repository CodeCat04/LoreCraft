import { describe, expect, it } from 'vitest';

import type { TitleEntry } from '../lib/types';
import { NameMatcher, matcherFor } from './nameMatcher';

function entry(title: string, aliases: string[] = []): TitleEntry {
  return { id: title, title, pageType: 'article', status: 'draft', summary: '', aliases };
}

function found(matcher: NameMatcher, text: string) {
  return matcher.find(text).map((m) => [text.slice(m.start, m.end), m.title]);
}

describe('NameMatcher', () => {
  it('matches the same names as the Rust test does', () => {
    // From `matches_whole_words_exactly_and_prefers_longest` in indexing.rs.
    const matcher = new NameMatcher([entry('Aria'), entry('Aria Vale'), entry('Will')]);
    expect(found(matcher, 'Aria Vale met Aria. Ariadne will go. Will went.')).toEqual([
      ['Aria Vale', 'Aria Vale'],
      ['Aria', 'Aria'],
      ['Will', 'Will'],
    ]);
  });

  it('ignores names shorter than three characters', () => {
    const matcher = new NameMatcher([entry('Ed', ['Al']), entry('Eda')]);
    expect(found(matcher, 'Ed and Al met Eda')).toEqual([['Eda', 'Eda']]);
  });

  it('counts characters rather than code units for the minimum length', () => {
    const matcher = new NameMatcher([entry('𝒜𝒷'), entry('𝒜𝒷𝒸')]);
    expect(found(matcher, '𝒜𝒷 𝒜𝒷𝒸')).toEqual([['𝒜𝒷𝒸', '𝒜𝒷𝒸']]);
  });

  it('points an alias at the page title', () => {
    const matcher = new NameMatcher([entry('Aria Vale', ['The Pale Queen'])]);
    expect(found(matcher, 'She was The Pale Queen.')).toEqual([['The Pale Queen', 'Aria Vale']]);
  });

  it('lets a title win over another page with the same alias', () => {
    const matcher = new NameMatcher([entry('Aria Vale', ['Vale']), entry('Vale')]);
    expect(found(matcher, 'Vale')).toEqual([['Vale', 'Vale']]);
  });

  it('gives a name two pages share to the first of them, whichever comes first', () => {
    const matcher = new NameMatcher([entry('Bran Stone', ['Bran']), entry('Bran the Elder', ['Bran'])]);
    expect(found(matcher, 'Bran')).toEqual([['Bran', 'Bran Stone']]);
    // A title still beats an alias from a page listed earlier.
    const titled = new NameMatcher([entry('Aria Vale', ['Vale']), entry('Vale')]);
    expect(found(titled, 'Vale')).toEqual([['Vale', 'Vale']]);
  });

  it('treats punctuation and non-Latin letters correctly at word edges', () => {
    const matcher = new NameMatcher([entry('Aria')]);
    expect(found(matcher, "Aria's horse, (Aria) Aria-like “Aria”").map((m) => m[0])).toEqual([
      'Aria',
      'Aria',
      'Aria',
      'Aria',
    ]);
    expect(found(matcher, 'ÉAria Ariaé Aria1 2Aria')).toEqual([]);
    expect(found(matcher, 'Привет АриаAria')).toEqual([]);
  });

  it('matches the same names as the Rust tests for Chinese, Japanese and Korean', () => {
    // From `chinese_names_match_inside_a_sentence_and_may_be_two_characters` in indexing.rs.
    const chinese = new NameMatcher([entry('林黛玉'), entry('李白'), entry('秦'), entry('大观园')]);
    expect(found(chinese, '那天林黛玉和李白一起去了大观园，林黛玉笑了。秦王不在。').map((m) => m[0])).toEqual([
      '林黛玉',
      '李白',
      '大观园',
      '林黛玉',
    ]);
    // From `japanese_and_korean_names_match_with_their_particles_attached`.
    const others = new NameMatcher([entry('夏目漱石'), entry('철수'), entry('สมชาย')]);
    expect(found(others, '夏目漱石は猫が好きだ。철수가 학교에 갔다. สมชายไปโรงเรียน').map((m) => m[0])).toEqual([
      '夏目漱石',
      '철수',
      'สมชาย',
    ]);
  });

  it('treats a character of a script without spaces as a word edge for a Latin name', () => {
    // From `english_names_still_need_word_boundaries_except_beside_unspaced_scripts`.
    const matcher = new NameMatcher([entry('Aria')]);
    expect(found(matcher, '我看到Aria走了')).toEqual([['Aria', 'Aria']]);
    expect(found(matcher, '水Aria')).toEqual([['Aria', 'Aria']]);
    expect(found(matcher, 'Ariadne Ariaé ÉAria Aria1 2Aria')).toEqual([]);
  });

  it('handles a name made of characters outside the basic plane', () => {
    const matcher = new NameMatcher([entry('𠮷野')]);
    expect(matcher.find('私は𠮷野です')).toEqual([{ start: 2, end: 5, title: '𠮷野' }]);
  });

  it('treats a character outside the basic plane as part of a word', () => {
    const matcher = new NameMatcher([entry('Aria')]);
    // U+10400, a letter written as a surrogate pair.
    expect(found(matcher, '\u{10400}Aria')).toEqual([]);
    expect(found(matcher, 'Aria\u{10400}')).toEqual([]);
    // An emoji is not alphanumeric.
    expect(found(matcher, '🦊Aria🦊')).toEqual([['Aria', 'Aria']]);
  });

  it('does not back off to a shorter name when the longest fails the word test', () => {
    // Rust takes "Aria Val" first, sees it ends inside a word, discards it and carries
    // on after it, so plain "Aria" does not match here either.
    const matcher = new NameMatcher([entry('Aria'), entry('Aria Val')]);
    expect(found(matcher, 'Aria Vale')).toEqual([]);
    expect(found(matcher, 'Aria Val')).toEqual([['Aria Val', 'Aria Val']]);
    expect(found(matcher, 'Aria Vanished')).toEqual([['Aria', 'Aria']]);
  });

  it('resumes after a failed match', () => {
    const matcher = new NameMatcher([entry('Ariadne'), entry('Aria')]);
    expect(found(matcher, 'Ariadnes Aria')).toEqual([['Aria', 'Aria']]);
  });

  it('is case exact', () => {
    const matcher = new NameMatcher([entry('Will')]);
    expect(found(matcher, 'will WILL Will')).toEqual([['Will', 'Will']]);
  });

  it('finds nothing with no names or no text', () => {
    expect(new NameMatcher([]).find('anything')).toEqual([]);
    expect(new NameMatcher([entry('Aria')]).find('')).toEqual([]);
  });

  it('handles a name at the very start and end', () => {
    const matcher = new NameMatcher([entry('Aria'), entry('Vale')]);
    expect(matcher.find('Aria and Vale')).toEqual([
      { start: 0, end: 4, title: 'Aria' },
      { start: 9, end: 13, title: 'Vale' },
    ]);
  });

  it('scans a long scene quickly with many names', () => {
    const names = Array.from({ length: 2000 }, (_, i) => entry(`Name${i} Surname${i}`, [`Name${i}`]));
    const matcher = new NameMatcher(names);
    const words = Array.from({ length: 20000 }, (_, i) => (i % 40 === 0 ? `Name${i % 2000}` : 'word'));
    const text = words.join(' ');
    const start = performance.now();
    const matches = matcher.find(text);
    const elapsed = performance.now() - start;
    expect(matches.length).toBe(500);
    expect(elapsed).toBeLessThan(100);
  });
});

describe('matcherFor', () => {
  it('reuses the matcher while the names stay the same', () => {
    const first = [entry('Aria', ['Vale'])];
    const matcher = matcherFor(first);
    expect(matcherFor(first)).toBe(matcher);
    // A new list with the same names, for example after a summary was edited.
    const edited = [{ ...entry('Aria', ['Vale']), summary: 'New summary' }];
    expect(matcherFor(edited)).toBe(matcher);
    expect(matcherFor([entry('Aria', ['Valley'])])).not.toBe(matcher);
  });
});
