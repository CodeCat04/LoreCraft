import { cleanQuote, normalizeForQuote, originalWords, quoteOccurs, quoteProblem, sentenceHolding } from './quotes';

describe('normalizeForQuote', () => {
  it('evens out whitespace, quote marks, dashes and case', () => {
    expect(normalizeForQuote('  “Her   EYES,”\n she said — quietly…  ')).toBe('"her eyes," she said - quietly...');
    expect(normalizeForQuote('it’s')).toBe("it's");
  });

  it('removes invisible characters and emphasis marks', () => {
    expect(normalizeForQuote('gr​een *eyes*')).toBe('green eyes');
  });
});

describe('cleanQuote', () => {
  it('drops marks around a quote', () => {
    expect(cleanQuote('"her green eyes."')).toBe('her green eyes');
    expect(cleanQuote('…her green eyes,')).toBe('her green eyes');
  });
});

describe('quoteOccurs', () => {
  const source = 'Aria turned. “Her eyes were green,” said Bram — quietly.\n\nThe hall was   cold.';

  it('accepts the words as they are', () => {
    expect(quoteOccurs('Her eyes were green', source)).toBe(true);
  });

  it('forgives whitespace, quote marks, dashes and case', () => {
    expect(quoteOccurs('"her eyes were GREEN," said Bram - quietly', source)).toBe(true);
    expect(quoteOccurs('the hall was cold', source)).toBe(true);
  });

  it('forgives a quote that runs over a paragraph end', () => {
    expect(quoteOccurs('quietly. The hall', source)).toBe(true);
  });

  it('refuses words that are not there', () => {
    expect(quoteOccurs('Her eyes were blue', source)).toBe(false);
    expect(quoteProblem('Her eyes were blue', source)).toBe('not-found');
    expect(quoteProblem('Her eyes were green and bright', source)).toBe('not-found');
  });

  it('refuses a quote that stops partway through a word', () => {
    expect(quoteOccurs('hall was col', source)).toBe(false);
  });

  it('refuses nothing, and a single word, which prove nothing', () => {
    expect(quoteProblem('', source)).toBe('empty');
    expect(quoteProblem('   ...  ', source)).toBe('empty');
    expect(quoteProblem(undefined, source)).toBe('empty');
    expect(quoteProblem('green', source)).toBe('too-short');
  });

  it('asks for the three words the prompts ask for, or a whole infobox line', () => {
    const text = 'Her eyes were green as glass. Eyes: green';
    expect(quoteProblem('eyes were', text)).toBe('too-short');
    expect(quoteProblem('eyes were green', text)).toBeNull();
    expect(quoteProblem('Eyes: green', text)).toBeNull();
  });
});

describe('originalWords', () => {
  it('gives the words as the writer has them', () => {
    const source = 'Aria said, “Her eyes were   green.”';
    expect(originalWords('her eyes were green', source)).toBe('Her eyes were   green');
  });

  it('gives back the quote if it is not there', () => {
    expect(originalWords('nothing here', 'Other text')).toBe('nothing here');
  });
});

describe('sentenceHolding', () => {
  const source = 'She came in. Her green eyes shone in the dark. She left.\nA new line.';

  it('finds the whole sentence around any part of it', () => {
    expect(sentenceHolding('green eyes', source)).toBe('her green eyes shone in the dark.');
    expect(sentenceHolding('Her green eyes shone', source)).toBe(sentenceHolding('in the dark', source));
  });

  it('copes with the first and last sentences', () => {
    expect(sentenceHolding('She came', source)).toBe('she came in.');
    expect(sentenceHolding('new line', source)).toBe('a new line.');
  });
});
