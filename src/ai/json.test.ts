import { extractJson } from './json';

const value = (text: string) => extractJson(text)?.value;

describe('extractJson', () => {
  it('reads clean JSON without calling it repaired', () => {
    expect(extractJson('{"a":1}')).toEqual({ value: { a: 1 }, repaired: false });
    expect(extractJson('  [1, 2]  ')).toEqual({ value: [1, 2], repaired: false });
  });

  it('finds JSON in a code fence or surrounded by prose', () => {
    expect(value('Here you go:\n```json\n{"a":1}\n```\nHope that helps.')).toEqual({ a: 1 });
    expect(value('```\n[1]\n```')).toEqual([1]);
    expect(value('The answer is {"a": {"b": [1, 2]}} as requested.')).toEqual({ a: { b: [1, 2] } });
  });

  it('is not fooled by brackets inside strings', () => {
    expect(value('Result: {"text": "a } tricky ] string"} done')).toEqual({ text: 'a } tricky ] string' });
    expect(value('{"quote": "she said \\"hi\\" {ok}"}')).toEqual({ quote: 'she said "hi" {ok}' });
  });

  it('skips thinking tags', () => {
    expect(value('<think>maybe {"wrong": true}</think>{"right": true}')).toEqual({ right: true });
  });

  it('skips a stray bracket before the real JSON', () => {
    expect(value('Options [see below]: {"a": 1}')).toEqual({ a: 1 });
  });

  it('repairs trailing commas and comments', () => {
    const got = extractJson('{\n  "a": 1, // first\n  "b": [1, 2,],\n  /* note */\n}');
    expect(got).toEqual({ value: { a: 1, b: [1, 2] }, repaired: true });
  });

  it('leaves commas and slashes in strings alone', () => {
    expect(value('{"a": "one, two, //three,",}')).toEqual({ a: 'one, two, //three,' });
  });

  it('repairs curly quotes and bare or single-quoted keys', () => {
    expect(value('{“name”: “Aria”}')).toEqual({ name: 'Aria' });
    expect(value("{name: 'Aria', 'age': 30}")).toEqual({ name: 'Aria', age: 30 });
  });

  it('closes JSON cut off by a token limit', () => {
    expect(value('{"items": [{"a": 1}, {"a": 2')).toEqual({ items: [{ a: 1 }, { a: 2 }] });
    expect(value('{"a": "half a strin')).toEqual({ a: 'half a strin' });
    expect(value('{"a": 1, "b":')).toEqual({ a: 1, b: null });
    expect(value('{"a": 1, "b')).toEqual({ a: 1 });
    expect(value('[1, 2,')).toEqual([1, 2]);
  });

  it('returns null when there is nothing there', () => {
    expect(extractJson('I cannot do that.')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});
