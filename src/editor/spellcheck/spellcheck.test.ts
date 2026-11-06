import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getSchema } from '@tiptap/core';
import { Node as ProseNode } from '@tiptap/pm/model';

import { documentExtensions } from '../schema';
import { SpellEngine, typingDistance } from './engine';
import { blockText } from './blockText';
import { Hunspell } from './hunspell';
import { hyphenParts, normalizeWord, tokenize, wordsInName } from './tokenize';

function load(name: string): Hunspell {
  return new Hunspell({
    aff: readFileSync(resolve(`node_modules/dictionary-${name}/index.aff`), 'utf8'),
    dic: readFileSync(resolve(`node_modules/dictionary-${name}/index.dic`), 'utf8'),
  });
}

const dictionary = load('en');

function engine(...names: string[]): SpellEngine {
  const spell = new SpellEngine(dictionary);
  spell.setNames(names);
  return spell;
}

/** The misspelled words in a text. */
function flagged(spell: SpellEngine, text: string): string[] {
  return spell.check(text).map(([from, to]) => text.slice(from, to));
}

const words = (text: string) => tokenize(text).map((token) => token.word);

describe('tokenize', () => {
  it('finds words and their positions', () => {
    expect(tokenize('Two words.')).toEqual([
      { from: 0, to: 3, word: 'Two' },
      { from: 4, to: 9, word: 'words' },
    ]);
  });

  it('keeps apostrophes and hyphens inside a word, and leaves them off the edges', () => {
    expect(words("Kel'Thuzad's well-known 'quote' dogs' don’t")).toEqual([
      "Kel'Thuzad's",
      'well-known',
      'quote',
      'dogs',
      'don’t',
    ]);
  });

  it('splits on dashes that are punctuation', () => {
    expect(words('winter—spring and north–south -- done')).toEqual([
      'winter',
      'spring',
      'and',
      'north',
      'south',
      'done',
    ]);
  });

  it('skips anything with a digit in it', () => {
    expect(words('the 3rd of 1920s A1 mid-1920s hour')).toEqual(['the', 'of', 'hour']);
  });

  it('skips web and email addresses', () => {
    expect(words('see https://exmple.com/pth or www.exmple.org and me@exmple.net now')).toEqual([
      'see',
      'or',
      'and',
      'now',
    ]);
  });

  it('leaves other scripts alone, since only English can be checked', () => {
    expect(words('Москва and 東京 and café')).toEqual(['and', 'and', 'café']);
  });

  it('counts positions in the original text, including accents and emoji', () => {
    const text = '\u{1F409} café zqx';
    const last = tokenize(text).at(-1)!;
    expect(text.slice(last.from, last.to)).toBe('zqx');
  });

  it('stays fast on a long block', () => {
    const text = 'the quick brown fox jumps over the lazy dog '.repeat(2500);
    const started = performance.now();
    expect(tokenize(text)).toHaveLength(22500);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('hyphenParts', () => {
  it('gives each part its own range', () => {
    expect(hyphenParts({ from: 10, to: 20, word: 'well-knwon' })).toEqual([
      { from: 10, to: 14, word: 'well' },
      { from: 15, to: 20, word: 'knwon' },
    ]);
    expect(hyphenParts({ from: 0, to: 3, word: 'one' })).toHaveLength(1);
  });
});

describe('tokenize with another script', () => {
  it('finds the words of that script and leaves the others alone', () => {
    expect(tokenize('Москва and 東京 и café', 'cyrillic').map((t) => t.word)).toEqual(['Москва', 'и']);
    expect(wordsInName('Анна-Мария and Aria', 'cyrillic')).toEqual(['Анна-Мария', 'Анна', 'Мария']);
  });
});

describe('dictionaries for other languages', () => {
  const flaggedIn = (spell: SpellEngine, text: string) => spell.check(text).map(([from, to]) => text.slice(from, to));

  it('accepts British spelling in en-GB and American spelling in en-US', () => {
    expect(flaggedIn(new SpellEngine(load('en-gb')), 'The colour of the harbour')).toEqual([]);
    expect(flaggedIn(new SpellEngine(load('en')), 'The colour of the harbour')).toEqual(['colour', 'harbour']);
  });

  it('accepts Spanish and flags what is not Spanish', () => {
    const spell = new SpellEngine(load('es'));
    expect(flaggedIn(spell, '¿Dónde está el niño? La mañana es muy bonita, corazón.')).toEqual([]);
    expect(flaggedIn(spell, 'The brother walked')).toEqual(['The', 'brother', 'walked']);
  });

  it('accepts French, with its elisions', () => {
    const spell = new SpellEngine(load('fr'));
    expect(flaggedIn(spell, "L'homme qu'il a vu aujourd'hui, c'est mon frère. D'accord, ils sont ici.")).toEqual([]);
    expect(flaggedIn(spell, 'Les chevaux ont mangé. Nous parlerons.')).toEqual([]);
    expect(flaggedIn(spell, 'Le chat mangee')).toEqual(['mangee']);
  });

  it('accepts Italian, with its elisions', () => {
    const spell = new SpellEngine(load('it'));
    expect(flaggedIn(spell, "L'amore dell'acqua è per un'altra città, perché parlarono di bambini.")).toEqual([]);
    expect(flaggedIn(spell, 'La casa bellla')).toEqual(['bellla']);
  });

  it('accepts Portuguese', () => {
    const spell = new SpellEngine(load('pt'));
    expect(flaggedIn(spell, 'Você não vai falar da casa amanhã, coração. Eles falaram dos livros.')).toEqual([]);
    expect(flaggedIn(spell, 'A cidadee bonita')).toEqual(['cidadee']);
  });

  it('checks Russian, and leaves Latin words alone there', () => {
    const spell = new SpellEngine(load('ru'), 'cyrillic');
    expect(flaggedIn(spell, 'Привет, мир! Я читаю книгу про Paris.')).toEqual([]);
    expect(flaggedIn(spell, 'Превет мир')).toEqual(['Превет']);
    spell.setNames(['Превет']);
    expect(flaggedIn(spell, 'Превет мир')).toEqual([]);
  });

  it('accepts German, with its compounds', () => {
    const spell = new SpellEngine(load('de'));
    expect(flaggedIn(spell, 'Das schöne Mädchen in der Straße. Ich gehe, du gehst, wir gehen.')).toEqual([]);
    expect(flaggedIn(spell, 'Der Kindergarten und die Handschuhe des Fußballspielers')).toEqual([]);
    expect(flaggedIn(spell, 'Das Haus ist schoen')).toEqual(['schoen']);
    expect(flaggedIn(spell, 'Xylofonhaus')).toEqual(['Xylofonhaus']);
  });

  it('suggests fixes in each language', () => {
    const suggest = (name: string, script: 'latin' | 'cyrillic', word: string) =>
      new SpellEngine(load(name), script).suggest(word);
    expect(suggest('es', 'latin', 'manzanna')).toContain('manzana');
    expect(suggest('fr', 'latin', 'maisson')).toContain('maison');
    expect(suggest('de', 'latin', 'Strase')).toContain('Straße');
    expect(suggest('pt', 'latin', 'cidadee')).toContain('cidade');
    expect(suggest('it', 'latin', 'bellla')).toContain('bella');
    expect(suggest('ru', 'cyrillic', 'Превет')).toContain('Привет');
  });

  it('loads every dictionary quickly, and checks without holding up a long scene', () => {
    for (const name of ['en', 'en-gb', 'es', 'fr', 'de', 'pt', 'it', 'ru']) {
      const started = performance.now();
      const spell = load(name);
      expect(performance.now() - started, `loading ${name}`).toBeLessThan(3000);
      expect(spell.correct('zzzqqq')).toBe(false);
    }
  });
});

describe('Hunspell', () => {
  const small = (aff: string, dic: string) => new Hunspell({ aff, dic });

  it('applies suffixes with their conditions and stripped endings', () => {
    const spell = small('SFX A Y 2\nSFX A y ies [^aeiou]y\nSFX A 0 s [aeiou]y', '2\nfly/A\nboy/A');
    for (const word of ['fly', 'flies', 'boy', 'boys']) expect(spell.correct(word), word).toBe(true);
    for (const word of ['flys', 'boies']) expect(spell.correct(word), word).toBe(false);
  });

  it('combines prefixes and suffixes only where both allow it', () => {
    const aff = 'PFX U Y 1\nPFX U 0 un .\nPFX N N 1\nPFX N 0 non .\nSFX S Y 1\nSFX S 0 s .';
    const spell = small(aff, '2\ndo/US\ngo/NS');
    for (const word of ['undo', 'dos', 'undos', 'nongo', 'gos']) expect(spell.correct(word), word).toBe(true);
    expect(spell.correct('nongos')).toBe(false);
  });

  it('allows two suffixes when the first says the second may follow', () => {
    const aff = 'SFX A Y 1\nSFX A 0 er/B .\nSFX B Y 1\nSFX B 0 s .';
    const spell = small(aff, '1\nwalk/A');
    for (const word of ['walk', 'walker', 'walkers']) expect(spell.correct(word), word).toBe(true);
    expect(spell.correct('walks')).toBe(false);
  });

  it('reads long, numeric and aliased flags', () => {
    expect(small('FLAG long\nSFX Aa Y 1\nSFX Aa 0 s .', '1\ndog/Aa').correct('dogs')).toBe(true);
    expect(small('FLAG num\nSFX 12 Y 1\nSFX 12 0 s .', '1\ndog/3,12').correct('dogs')).toBe(true);
    expect(small('AF 2\nAF A\nAF B\nSFX B Y 1\nSFX B 0 s .', '1\ndog/2').correct('dogs')).toBe(true);
    expect(small('FLAG UTF-8\nSFX é Y 1\nSFX é 0 s .', '1\ndog/é').correct('dogs')).toBe(true);
  });

  it('honours forbidden words and words that need an affix', () => {
    const aff = 'FORBIDDENWORD X\nNEEDAFFIX N\nSFX S Y 1\nSFX S 0 s .';
    const spell = small(aff, '3\nbad/X\nstem/NS\ngood/S');
    expect(spell.correct('bad')).toBe(false);
    expect(spell.correct('stem')).toBe(false);
    expect(spell.correct('stems')).toBe(true);
    expect(spell.correct('good')).toBe(true);
  });

  it('follows the capitalization rules of a spellchecker', () => {
    const spell = small('', '2\nword\nParis');
    for (const word of ['word', 'Word', 'WORD', 'Paris', 'PARIS']) expect(spell.correct(word), word).toBe(true);
    for (const word of ['paris', 'wOrd', 'PaRiS']) expect(spell.correct(word), word).toBe(false);
  });

  it('converts input and removes ignored characters', () => {
    const spell = small('ICONV 1\nICONV ’ \'\nIGNORE -', "2\ndon't\nco-op");
    expect(spell.correct('don’t')).toBe(true);
    expect(spell.correct('coop')).toBe(true);
    expect(spell.correct('co-op')).toBe(true);
  });

  it('builds compounds from words marked for each position', () => {
    const aff = 'COMPOUNDBEGIN x\nCOMPOUNDMIDDLE y\nCOMPOUNDEND z\nONLYINCOMPOUND o\nCOMPOUNDMIN 2';
    const spell = small(aff, '4\nHaus/xy\nboot/xyz\ntür/z\nnur/xyzo');
    for (const word of ['Haustür', 'Haus', 'boottür', 'Hausboottür', 'nurtür']) expect(spell.correct(word), word).toBe(true);
    for (const word of ['türhaus', 'nur', 'Hausx']) expect(spell.correct(word), word).toBe(false);
  });

  it('suggests through replacement tables and small edits, skipping words marked not to suggest', () => {
    const aff = 'TRY abcdefgh\nREP 1\nREP f ph\nNOSUGGEST N\n';
    const spell = small(aff, '4\nphone\ncat\nbat/N\nParis');
    expect(spell.suggest('fone')).toContain('phone');
    expect(spell.suggest('cta')).toContain('cat');
    expect(spell.suggest('at')).toContain('cat');
    expect(spell.suggest('at')).not.toContain('bat');
    expect(spell.suggest('paris')).toContain('Paris');
  });
});

describe('wordsInName', () => {
  it('takes every word from a title, with possessives and hyphens opened up', () => {
    expect(wordsInName('The Silver Vale')).toEqual(['The', 'Silver', 'Vale']);
    expect(wordsInName("Aria's Keep")).toEqual(["Aria's", 'Aria', 'Keep']);
    expect(wordsInName('Anne-Marie')).toEqual(['Anne-Marie', 'Anne', 'Marie']);
    expect(wordsInName('Kel’Thuzad')).toEqual(["Kel'Thuzad"]);
    expect(wordsInName('Route 66')).toEqual(['Route']);
  });
});

describe('SpellEngine.check', () => {
  it('flags misspellings and accepts ordinary English in any sentence position', () => {
    const spell = engine();
    expect(flagged(spell, 'The quick brown fox.')).toEqual([]);
    expect(flagged(spell, 'She will recieve teh letter.')).toEqual(['recieve', 'teh']);
    expect(flagged(spell, 'THE END')).toEqual([]);
  });

  it('flags an invented name until it is lore', () => {
    const text = 'Zephyrine rode to Karthholm.';
    expect(flagged(engine(), text)).toEqual(['Zephyrine', 'Karthholm']);
    expect(flagged(engine('Zephyrine'), text)).toEqual(['Karthholm']);
    expect(flagged(engine('Zephyrine', 'Fort Karthholm'), text)).toEqual([]);
  });

  it('accepts lore in any capitalization', () => {
    const spell = engine('Dragonglass');
    expect(flagged(spell, 'dragonglass Dragonglass DRAGONGLASS')).toEqual([]);
  });

  it('accepts possessives and plurals of lore names, with either apostrophe', () => {
    const spell = engine('Zephyrine', 'Silmaril', 'Kwass');
    expect(flagged(spell, "Zephyrine's ship and Zephyrine’s oath")).toEqual([]);
    expect(flagged(spell, 'three Silmarils and two Kwasses')).toEqual([]);
    expect(flagged(spell, 'the Zephyrinez')).toEqual(['Zephyrinez']);
  });

  it('accepts a name with an inner apostrophe as a whole', () => {
    const spell = engine("Kel'Thuzad");
    expect(flagged(spell, 'Kel’Thuzad spoke, and Kel’Thuzad’s words carried.')).toEqual([]);
    expect(flagged(spell, "Kel'Thuzod spoke.")).toEqual(["Kel'Thuzod"]);
  });

  it('checks each part of a hyphenated word and flags only the bad part', () => {
    const spell = engine('Karth');
    expect(flagged(spell, 'A well-known mother-in-law.')).toEqual([]);
    expect(flagged(spell, 'A well-knwon fact.')).toEqual(['knwon']);
    expect(flagged(spell, 'The Karth-born smith.')).toEqual([]);
    const text = 'A well-knwon fact.';
    expect(spell.check(text)).toEqual([[7, 12]]);
  });

  it('allows a hyphenated name that is lore as a whole', () => {
    expect(flagged(engine('Zyx-Qor'), 'Zyx-Qor and zyx-qor')).toEqual([]);
  });

  it('allows common prefixes in front of a hyphen', () => {
    expect(flagged(engine(), 're-enter non-human pre-war')).toEqual([]);
  });

  it('accepts contractions, including with a curly apostrophe', () => {
    expect(flagged(engine(), "don't won’t they're I'm dog's")).toEqual([]);
  });

  it('accepts elisions only with their apostrophe', () => {
    const spell = engine();
    expect(flagged(spell, "'Tis true, ’tis so.")).toEqual([]);
    expect(flagged(spell, 'tis')).toEqual(['tis']);
  });

  it('leaves acronyms, numerals and single letters alone', () => {
    expect(flagged(engine(), 'NPC XIV x I')).toEqual([]);
    expect(flagged(engine(), 'BRIGHTSWORDSMAN')).toEqual(['BRIGHTSWORDSMAN']);
  });

  it('forgets lore that is gone', () => {
    const spell = engine('Zephyrine');
    spell.setNames([]);
    expect(flagged(spell, 'Zephyrine')).toEqual(['Zephyrine']);
  });

  it('ignores a word for the session, in any case', () => {
    const spell = engine();
    spell.ignore('Qwertyz');
    expect(flagged(spell, 'qwertyz QWERTYZ Qwertyz')).toEqual([]);
    spell.clearIgnored();
    expect(flagged(spell, 'qwertyz')).toEqual(['qwertyz']);
  });

  it('is fast on 20,000 words, including the misspelled ones', () => {
    const spell = engine('Zephyrine');
    const base = 'Zephyrine recieved the quick brown fox and thought about tomorrow '.split(' ');
    const text = Array.from({ length: 20000 }, (_, i) => `${base[i % base.length]}${i % 97 === 0 ? 'q' : ''}`).join(' ');
    const started = performance.now();
    expect(spell.check(text).length).toBeGreaterThan(100);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('SpellEngine.suggest', () => {
  it('offers the likely fix first', () => {
    expect(engine().suggest('teh')[0]).toBe('the');
    expect(engine().suggest('recieve')[0]).toBe('receive');
  });

  it('offers lore names, as they are written', () => {
    expect(engine('Zephyrine').suggest('Zephyrin')[0]).toBe('Zephyrine');
    expect(engine('Zephyrine').suggest('zephirine')[0]).toBe('Zephyrine');
  });

  it('matches the capitalization of the word', () => {
    expect(engine().suggest('Recieve')[0]).toBe('Receive');
    expect(engine().suggest('RECIEVE')[0]).toBe('RECEIVE');
  });

  it('keeps a possessive on the end', () => {
    expect(engine('Zephyrine').suggest("Zephyrin's")[0]).toBe("Zephyrine's");
  });

  it('does not offer far-off names', () => {
    expect(engine('Zephyrine').suggest('cat')).not.toContain('Zephyrine');
  });

  it('gives few enough to fit in a small menu', () => {
    expect(engine().suggest('teh').length).toBeLessThanOrEqual(6);
  });
});

describe('typingDistance', () => {
  it('counts a swap as less than a change', () => {
    expect(typingDistance('teh', 'the')).toBe(0.5);
    expect(typingDistance('teh', 'ten')).toBe(1);
    expect(typingDistance('cat', 'cat')).toBe(0);
    expect(typingDistance('', 'ab')).toBe(2);
  });
});

describe('normalizeWord', () => {
  it('straightens apostrophes and composes accents', () => {
    expect(normalizeWord('don’t')).toBe("don't");
    expect(normalizeWord('café')).toBe('café');
  });
});

describe('blockText', () => {
  const schema = getSchema(documentExtensions());
  const para = (...content: object[]) =>
    ProseNode.fromJSON(schema, { type: 'paragraph', content });

  it('lines text up with document positions', () => {
    const block = para(
      { type: 'text', text: 'Before ' },
      { type: 'reference', attrs: { text: 'A source' } },
      { type: 'text', text: ' after' },
      { type: 'hardBreak' },
      { type: 'text', text: 'end' },
    );
    const text = blockText(block);
    expect(text).toHaveLength(block.content.size);
    expect(text.indexOf('after')).toBe(9);
    expect(text.indexOf('end')).toBe(15);
  });

  it('masks code and wiki links, so they are not checked', () => {
    const block = para(
      { type: 'text', text: 'Run ' },
      { type: 'text', text: 'npmx', marks: [{ type: 'code' }] },
      { type: 'text', text: ' near ' },
      { type: 'text', text: 'Karthhold', marks: [{ type: 'wikiLink', attrs: { target: 'Karth' } }] },
      { type: 'text', text: "'s gate" },
    );
    const text = blockText(block);
    expect(text).toHaveLength(block.content.size);
    expect(text).not.toContain('npmx');
    expect(text).not.toContain('Karthhold');
    expect(flagged(engine(), text)).toEqual([]);
  });

  it('checks ordinary marks like any other text', () => {
    const block = para({ type: 'text', text: 'recieve', marks: [{ type: 'bold' }] });
    expect(flagged(engine(), blockText(block))).toEqual(['recieve']);
  });
});
