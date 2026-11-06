import { getSchema } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { documentExtensions } from '../editor/schema';
import type { PmNode } from '../lib/types';
import {
  analyze,
  countText,
  findOverused,
  LEAF_NODES,
  mergeCounts,
  segmentsFromDoc,
  sentenceRanges,
  splitSentences,
  syllables,
  tokenize,
  wordKey,
  type ProseSegment,
} from './analyze';

const schema = getSchema(documentExtensions());

const paragraph = (text: string, from = 1): ProseSegment => ({ text, from });

function segmentsOf(...texts: string[]): ProseSegment[] {
  let from = 1;
  return texts.map((text) => {
    const segment = { text, from };
    from += text.length + 2;
    return segment;
  });
}

const texts = (matches: { text: string }[]) => matches.map((m) => m.text);
const sentencesIn = (text: string) => splitSentences(text).map((s) => text.slice(s.start, s.end));

describe('tokenize', () => {
  it('keeps apostrophes and hyphens inside a word', () => {
    expect(tokenize("Mara's well-worn don’t, no.").map((t) => t.key)).toEqual(["mara's", 'well-worn', "don't", 'no']);
  });

  it('gives each word its place in the text', () => {
    const [first, second] = tokenize('  One two');
    expect(first).toEqual({ key: 'one', start: 2, end: 5 });
    expect(second).toEqual({ key: 'two', start: 6, end: 9 });
  });

  it('reads letters from any language', () => {
    expect(tokenize('Çà va, 北京 Ωmega').map((t) => t.key)).toEqual(['çà', 'va', '北京', 'ωmega']);
  });

  it('folds case and curly apostrophes', () => {
    expect(wordKey('DON’T')).toBe("don't");
  });
});

describe('splitSentences', () => {
  it('splits on ends of sentences', () => {
    expect(sentencesIn('She ran. He stayed! Why? Nobody knew.')).toEqual(['She ran.', 'He stayed!', 'Why?', 'Nobody knew.']);
  });

  it('is not fooled by titles, initials or decimals', () => {
    expect(sentencesIn('Dr. Vale met Mr. Hart at 3.14 past. J. R. Tolkien wrote it.')).toEqual([
      'Dr. Vale met Mr. Hart at 3.14 past.',
      'J. R. Tolkien wrote it.',
    ]);
  });

  it('ends a sentence on "I", which is not an initial', () => {
    expect(sentencesIn('So do I. She left.')).toEqual(['So do I.', 'She left.']);
  });

  it('keeps a closing quote with its sentence', () => {
    expect(sentencesIn('"Stop." She turned. “Now!” The door shut.')).toEqual(['"Stop."', 'She turned.', '“Now!”', 'The door shut.']);
  });

  it('carries on when a lower-case word follows', () => {
    expect(sentencesIn('"Stop!" he said. "Wait..." she began, and stopped.')).toEqual([
      '"Stop!" he said.',
      '"Wait..." she began, and stopped.',
    ]);
  });

  it('treats a run of marks and an ellipsis as one end', () => {
    expect(sentencesIn('What?! Really… Yes.')).toEqual(['What?!', 'Really…', 'Yes.']);
  });

  it('treats a line break as an end, so verse is not one long sentence', () => {
    expect(sentencesIn('The moon is high\nThe road is long')).toEqual(['The moon is high', 'The road is long']);
  });

  it('includes a last sentence with no full stop', () => {
    expect(sentencesIn('One. And then')).toEqual(['One.', 'And then']);
  });

  it('finds nothing in blank text', () => {
    expect(splitSentences('   ')).toEqual([]);
    expect(splitSentences('')).toEqual([]);
  });
});

describe('syllables', () => {
  it('estimates plausible counts', () => {
    expect(syllables('cat')).toBe(1);
    expect(syllables('walked')).toBe(1);
    expect(syllables('table')).toBe(2);
    expect(syllables('reading')).toBe(2);
    expect(syllables('elephant')).toBe(3);
    expect(syllables('')).toBe(0);
  });
});

describe('doubled words', () => {
  it('finds a word typed twice, across any case', () => {
    const { matches } = analyze([paragraph('She closed the the door. The The end.')]);
    expect(texts(matches.doubled)).toEqual(['the the', 'The The']);
  });

  it('gives document positions', () => {
    const { matches } = analyze([paragraph('Go to to bed', 10)]);
    expect(matches.doubled[0]).toMatchObject({ from: 13, to: 18, check: 'doubled' });
  });

  it('allows the doubles that are correct English', () => {
    expect(analyze([paragraph('She had had enough, and said that that was that.')]).matches.doubled).toEqual([]);
  });

  it('does not count words with punctuation between them', () => {
    expect(analyze([paragraph('No, no. Go. Go.')]).matches.doubled).toEqual([]);
  });
});

describe('words repeated close together', () => {
  it('marks both uses', () => {
    const { matches } = analyze([paragraph('The lantern swung and the lantern went out.')]);
    expect(texts(matches.repeated)).toEqual(['lantern', 'lantern']);
  });

  it('marks each use once in a run of them', () => {
    const { matches } = analyze([paragraph('Stone by stone and stone on stone.')]);
    expect(matches.repeated.length).toBe(4);
  });

  it('notices across paragraphs', () => {
    const { matches } = analyze(segmentsOf('The lantern swung.', 'A lantern fell.'));
    expect(matches.repeated.length).toBe(2);
    expect(matches.repeated[1].from).toBeGreaterThan(matches.repeated[0].to);
  });

  it('leaves far-apart uses alone', () => {
    const filler = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(analyze([paragraph(`lantern ${filler} lantern`)]).matches.repeated).toEqual([]);
  });

  it('honours the window setting', () => {
    const near = 'lantern alpha bravo charlie delta lantern';
    expect(analyze([paragraph(near)], { repeatWindow: 3 }).matches.repeated).toEqual([]);
    expect(analyze([paragraph(near)], { repeatWindow: 5 }).matches.repeated.length).toBe(2);
  });

  it('ignores short and common words', () => {
    expect(analyze([paragraph('The cat and the cat and the cat.')]).matches.repeated).toEqual([]);
  });

  it('does not count names', () => {
    const { matches } = analyze([paragraph('Mara looked at Mara and Mara laughed.')], { names: ['Mara Vale'] });
    expect(matches.repeated).toEqual([]);
  });
});

describe('long sentences', () => {
  const long = `Now ${Array.from({ length: 39 }, () => 'word').join(' ')}.`;

  it('flags sentences over the limit, whole', () => {
    const { matches, longestSentenceWords } = analyze([paragraph(`Short one. ${long} Another short one.`)]);
    expect(matches.longSentence.length).toBe(1);
    expect(matches.longSentence[0].text).toBe(long);
    expect(longestSentenceWords).toBe(40);
  });

  it('honours the limit setting', () => {
    expect(analyze([paragraph(long)], { longSentenceWords: 50 }).matches.longSentence).toEqual([]);
    expect(analyze([paragraph('One two three four.')], { longSentenceWords: 3 }).matches.longSentence.length).toBe(1);
  });
});

describe('adverbs and filter words', () => {
  it('finds adverbs and leaves alone words that only end the same way', () => {
    const { matches } = analyze([paragraph('She quickly fled the family home, slowly and only early. It was lovely.')]);
    expect(texts(matches.adverb)).toEqual(['quickly', 'slowly']);
  });

  it('does not take a name for an adverb', () => {
    expect(analyze([paragraph('Sorely missed, Kelly left.')], { names: ['Kelly', 'Sorely'] }).matches.adverb).toEqual([]);
  });

  it('finds filter words in any tense', () => {
    const { matches } = analyze([paragraph('She felt the cold. He saw it, and it seemed wrong. They noticed.')]);
    expect(texts(matches.filter)).toEqual(['felt', 'saw', 'seemed', 'noticed']);
  });
});

describe('passive-looking phrases', () => {
  it('finds forms of "to be" with a participle', () => {
    const { matches } = analyze([paragraph('The gate was opened. Letters were written. It is being rebuilt.')]);
    expect(texts(matches.passive)).toEqual(['was opened', 'were written', 'is being rebuilt']);
  });

  it('allows a word between them', () => {
    const { matches } = analyze([paragraph('It was quickly closed, and it was never found.')]);
    expect(texts(matches.passive)).toEqual(['was quickly closed', 'was never found']);
  });

  it('leaves descriptions and other verbs alone', () => {
    const { matches } = analyze([paragraph('She was tired. He was walking. The door opened. They were supposed to go.')]);
    expect(matches.passive).toEqual([]);
  });

  it('does not reach across punctuation', () => {
    expect(analyze([paragraph('It was, opened.')]).matches.passive).toEqual([]);
  });
});

describe('overused words and phrases', () => {
  const repeats = (word: string, times: number) => Array.from({ length: times }, () => word).join(' ');
  const filler = (count: number, stem = 'filler') =>
    Array.from({ length: count }, (_, i) => `${stem}${i}`).join(' ');

  it('compares with the rest of the text', () => {
    const rest = countText([paragraph(`${filler(2000)} ember`)]);
    const scope = [paragraph(`${filler(50, 'here')} ember ember ember ember ember.`)];
    const { overused, matches } = analyze(scope, { rest });
    expect(overused.map((t) => t.text)).toContain('ember');
    const term = overused.find((t) => t.text === 'ember');
    expect(term?.count).toBe(5);
    expect(term?.restPerThousand).toBeCloseTo(0.5, 0);
    expect(texts(matches.overused).filter((t) => t === 'ember').length).toBe(5);
  });

  it('accepts a word that is just as common elsewhere', () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `ember filler${i}`).join(' ');
    const rest = countText([paragraph(body(1000))]);
    const { overused } = analyze([paragraph(`${body(50)}.`)], { rest });
    expect(overused.map((t) => t.text)).not.toContain('ember');
  });

  it('never counts a name, even with the rest of the text to compare against', () => {
    const rest = countText([paragraph(filler(2000))]);
    const scope = [paragraph(`Mara ${repeats('mara', 8)} Vale ${repeats('vale', 8)} ember ${repeats('ember', 8)}.`)];
    const { overused } = analyze(scope, { rest, names: ['Mara Vale'] });
    const terms = overused.map((t) => t.text);
    expect(terms).toContain('ember');
    expect(terms).not.toContain('mara');
    expect(terms).not.toContain('vale');
    expect(terms.some((t) => t.includes('mara') || t.includes('vale'))).toBe(false);
  });

  it('counts an alias as a name too', () => {
    const { overused } = analyze([paragraph(`${repeats('stormcrow', 12)} ${filler(20)}.`)], { names: ['The Stormcrow'] });
    expect(overused.map((t) => t.text)).not.toContain('stormcrow');
  });

  it('with nothing to compare against, uses the share of the text', () => {
    const scope = [paragraph(`${repeats('ember', 8)} ${filler(200)}.`)];
    const { overused } = analyze(scope);
    expect(overused[0].text).toBe('ember');
    expect(overused[0].restPerThousand).toBeNull();
  });

  it('ignores common words whatever their count', () => {
    const { overused } = analyze([paragraph(`${repeats('the', 40)}.`)]);
    expect(overused).toEqual([]);
  });

  it('needs a word to come up a few times', () => {
    const { overused } = analyze([paragraph('Ember ember ember.')]);
    expect(overused).toEqual([]);
  });

  it('finds repeated phrases, and prefers the longest with the same count', () => {
    const line = 'A flicker of old stone gate. Then filler words here go.';
    const scope = [paragraph(Array.from({ length: 5 }, () => line).join(' '))];
    const { overused, matches } = analyze(scope);
    const terms = overused.map((t) => t.text);
    expect(terms).toContain('old stone gate');
    expect(terms).not.toContain('old stone');
    expect(terms).not.toContain('stone gate');
    expect(texts(matches.overused).filter((t) => t === 'old stone gate').length).toBe(5);
  });

  it('does not build phrases across sentences', () => {
    const { overused } = analyze([paragraph('Ember glow. Ember glow. Ember glow.')], { rest: undefined });
    expect(overused.map((t) => t.text)).toEqual(['ember glow']);
    const across = analyze([paragraph('Dark ember. Glow dark ember. Glow dark ember. Glow.')]);
    expect(across.overused.map((t) => t.text)).not.toContain('ember glow');
  });

  it('keeps uses in reading order across scenes, whose positions restart', () => {
    const line = `Ember and more ember. ${filler(20)}.`;
    const later = { text: line, from: 1, scene: 'second' };
    // The first scene's text sits at higher positions than the second's.
    const earlier = { text: `${line} Ember ember ember.`, from: 500, scene: 'first' };
    const { matches } = analyze([earlier, later]);
    const scenes = matches.overused.map((m) => m.scene);
    expect(scenes.indexOf('second')).toBeGreaterThan(scenes.lastIndexOf('first'));
    expect(matches.overused[0].from).toBe(500);
  });

  it('names the term each use belongs to, even with punctuation inside a phrase', () => {
    const line = 'A flicker of old, stone gate. Then filler words here go.';
    const { overused, matches } = analyze([paragraph(Array.from({ length: 5 }, () => line).join(' '))]);
    expect(overused.map((t) => t.text)).toContain('old stone gate');
    const uses = matches.overused.filter((m) => m.term === 'old stone gate');
    expect(uses.length).toBe(5);
    expect(uses[0].text).toBe('old, stone gate');
  });

  it('merges counts from several scenes', () => {
    const merged = mergeCounts([countText([paragraph('one two')]), countText([paragraph('two three')])]);
    expect(merged.total).toBe(4);
    expect(merged.counts.get('two')).toBe(2);
  });

  it('finds nothing in empty text', () => {
    expect(findOverused({ total: 0, counts: new Map() }, undefined, new Set())).toEqual([]);
  });
});

describe('figures for the whole text', () => {
  it('counts words, sentences and paragraphs', () => {
    const report = analyze(segmentsOf('One two three. Four five.', 'Six.'));
    expect(report).toMatchObject({ words: 6, sentences: 3, paragraphs: 2, longestSentenceWords: 3 });
    expect(report.averageSentenceWords).toBe(2);
  });

  it('sorts sentences by length', () => {
    const report = analyze([paragraph('One two. Three four five six seven eight nine.')]);
    expect(report.sentenceLengths.find((b) => b.label === '1 to 5')?.count).toBe(1);
    expect(report.sentenceLengths.find((b) => b.label === '6 to 10')?.count).toBe(1);
    expect(report.sentenceLengths.reduce((sum, b) => sum + b.count, 0)).toBe(2);
  });

  it('estimates reading level, with simple text scoring lower', () => {
    const simple = analyze([paragraph(Array.from({ length: 12 }, () => 'The cat sat on the mat.').join(' '))]);
    const dense = analyze([
      paragraph(
        Array.from(
          { length: 6 },
          () => 'Institutional considerations notwithstanding, administrative responsibilities necessitate comprehensive organizational reconsideration.',
        ).join(' '),
      ),
    ]);
    expect(simple.gradeLevel).not.toBeNull();
    expect(dense.gradeLevel).not.toBeNull();
    expect(simple.gradeLevel ?? 0).toBeLessThan(dense.gradeLevel ?? 0);
    expect(simple.readingEase ?? 0).toBeGreaterThan(dense.readingEase ?? 0);
    expect(simple.readingLevel).toBe('Very easy');
    expect(dense.readingLevel).toBe('Very difficult');
  });

  it('declines to judge reading level on very short text or other scripts', () => {
    expect(analyze([paragraph('Too short.')]).gradeLevel).toBeNull();
    const cjk = Array.from({ length: 40 }, () => '北京').join(' ');
    expect(analyze([paragraph(`${cjk}。`)]).readingLevel).toBeNull();
  });

  it('estimates reading and speaking time', () => {
    const report = analyze([paragraph(Array.from({ length: 476 }, () => 'word').join(' '))]);
    expect(report.readingMinutes).toBeCloseTo(2, 5);
    expect(report.speakingMinutes).toBeCloseTo(476 / 150, 5);
  });

  it('copes with empty input', () => {
    expect(analyze([])).toMatchObject({ words: 0, sentences: 0, averageSentenceWords: 0, gradeLevel: null });
  });

  it('labels matches with their scene', () => {
    const { matches } = analyze([{ text: 'She felt it.', from: 1, scene: 'scene-1' }]);
    expect(matches.filter[0].scene).toBe('scene-1');
  });

  it('reads a large text in reasonable time', () => {
    const line = 'The lantern swung slowly as she felt the old stone gate was opened by nobody at all. ';
    const big = Array.from({ length: 12000 }, (_, i) => ({ text: line, from: 1 + i * (line.length + 2) }));
    const start = performance.now();
    const report = analyze(big, { rest: countText(big.slice(0, 2000)) });
    expect(report.words).toBeGreaterThan(190000);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

describe('segmentsFromDoc', () => {
  it('knows every kind of node with no content, or positions after one would be wrong', () => {
    const leaves = Object.values(schema.nodes)
      .filter((type) => type.isLeaf && type.name !== 'text')
      .map((type) => type.name);
    expect(leaves.filter((name) => !LEAF_NODES.has(name))).toEqual([]);
  });

  const doc: PmNode = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A heading felt skipped' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'She ' },
          { type: 'text', text: 'felt', marks: [{ type: 'bold' }] },
          { type: 'hardBreak' },
          { type: 'text', text: 'it' },
          { type: 'reference', attrs: { text: 'a source' } },
          { type: 'text', text: ' here.' },
        ],
      },
      { type: 'paragraph' },
      { type: 'horizontalRule' },
      {
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted words.' }] }],
      },
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Listed.' }] }] }],
      },
      { type: 'codeBlock', content: [{ type: 'text', text: 'code felt' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Last one.' }] },
    ],
  };

  it('puts each character at the position an editor gives it', () => {
    const real = schema.nodeFromJSON(doc);
    const segments = segmentsFromDoc(doc);
    expect(segments.map((s) => s.text.replace('\n', '|').replace('￼', '*'))).toEqual([
      'She felt|it* here.',
      'Quoted words.',
      'Listed.',
      'Last one.',
    ]);
    for (const segment of segments) {
      for (let i = 0; i < segment.text.length; i += 1) {
        const char = segment.text[i];
        if (char === '\n' || char === '￼') continue;
        expect(real.textBetween(segment.from + i, segment.from + i + 1)).toBe(char);
      }
    }
  });

  it('leaves out headings, code, figures and tables', () => {
    const report = analyze(segmentsFromDoc(doc));
    expect(texts(report.matches.filter)).toEqual(['felt']);
  });

  it('labels a scene when asked', () => {
    expect(segmentsFromDoc(doc, 'abc')[0].scene).toBe('abc');
    expect(segmentsFromDoc(doc)[0].scene).toBeUndefined();
  });

  it('highlights land on the right words in a real document', () => {
    const real = schema.nodeFromJSON(doc);
    const { matches } = analyze(segmentsFromDoc(doc));
    expect(real.textBetween(matches.filter[0].from, matches.filter[0].to)).toBe('felt');
  });

  it('gives sentence ranges for reading aloud', () => {
    const real = schema.nodeFromJSON(doc);
    const ranges = sentenceRanges(segmentsFromDoc(doc));
    expect(ranges.map((r) => real.textBetween(r.from, r.to, ' ', ' '))).toEqual([
      'She felt',
      'it  here.',
      'Quoted words.',
      'Listed.',
      'Last one.',
    ]);
  });
});
