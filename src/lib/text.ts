import { currentLocale, t } from './i18n';

/** Must match `title_key` in `src-tauri/src/content.rs`. */
export function titleKey(title: string): string {
  return title.replace(/_/g, ' ').trim().split(/\s+/).join(' ').toLowerCase();
}

const enum CharKind {
  /** Ends a word. */
  Space,
  /** Han or kana, where every character counts as a word. */
  PerCharacter,
  /** A letter of a script with no spaces between words, which is estimated. */
  Unspaced,
  /** Starts a word, or continues one. */
  Word,
  /** Neither ends nor starts a word: punctuation, emoji and marks. */
  Other,
}

/** About this many letters make a word in Thai, Lao, Khmer and Burmese. */
const LETTERS_PER_UNSPACED_WORD = 4;

/** Must match Rust's `char::is_whitespace` and `char::is_alphanumeric`. */
const WHITE_SPACE = /\p{White_Space}/u;
const ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;

/** Han, kana and Bopomofo. Must match `is_counted_per_character` in `content.rs`. */
function isCountedPerCharacter(c: number): boolean {
  return (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3041 && c <= 0x3096) ||
    (c >= 0x30a1 && c <= 0x30fa) ||
    (c >= 0x30fc && c <= 0x30ff) ||
    (c >= 0x3005 && c <= 0x3007) ||
    (c >= 0x3021 && c <= 0x3029) ||
    (c >= 0x3038 && c <= 0x303b) ||
    (c >= 0x309d && c <= 0x309f) ||
    (c >= 0x3105 && c <= 0x312f) ||
    (c >= 0x31a0 && c <= 0x31bf) ||
    (c >= 0x31f0 && c <= 0x31ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff66 && c <= 0xff9d) ||
    (c >= 0x1aff0 && c <= 0x1b16f) ||
    (c >= 0x20000 && c <= 0x3ffff)
  );
}

/** The letters of Thai, Lao, Burmese and Khmer. Must match `content.rs`. */
function isUnspacedLetter(c: number): boolean {
  return (
    (c >= 0x0e01 && c <= 0x0e30) ||
    (c >= 0x0e32 && c <= 0x0e33) ||
    (c >= 0x0e40 && c <= 0x0e46) ||
    (c >= 0x0e81 && c <= 0x0eb0) ||
    (c >= 0x0eb2 && c <= 0x0eb3) ||
    (c >= 0x0ebd && c <= 0x0ec6) ||
    (c >= 0x1000 && c <= 0x102a) ||
    c === 0x103f ||
    (c >= 0x1050 && c <= 0x1055) ||
    (c >= 0x1780 && c <= 0x17b3)
  );
}

/** The digits of those scripts, which count like any other number. */
function isUnspacedDigit(c: number): boolean {
  return (
    (c >= 0x0e50 && c <= 0x0e59) ||
    (c >= 0x0ed0 && c <= 0x0ed9) ||
    (c >= 0x1040 && c <= 0x1049) ||
    (c >= 0x17e0 && c <= 0x17e9)
  );
}

/** Whether a character is in the Thai, Lao, Burmese or Khmer blocks. */
function isInUnspacedBlock(c: number): boolean {
  return (c >= 0x0e00 && c <= 0x0eff) || (c >= 0x1000 && c <= 0x109f) || (c >= 0x1780 && c <= 0x17ff);
}

/**
 * Whether a character belongs to a script whose words have no dependable edges: Han, kana and
 * the scripts written without spaces, and Hangul, where particles join the word before them.
 * Search and name detection look inside runs of these. Must match `is_unspaced_script` in
 * `src-tauri/src/content.rs`.
 */
export function isUnspacedScript(c: number): boolean {
  if (c < 0x0e00) return false;
  return (
    isCountedPerCharacter(c) ||
    isInUnspacedBlock(c) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0x1100 && c <= 0x11ff) ||
    (c >= 0x3131 && c <= 0x318e) ||
    (c >= 0xa960 && c <= 0xa97c) ||
    (c >= 0xd7b0 && c <= 0xd7fb)
  );
}

function charKind(c: number): CharKind {
  if (c < 0x80) {
    if (c === 32 || (c >= 9 && c <= 13)) return CharKind.Space;
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return CharKind.Word;
    return CharKind.Other;
  }
  if (isCountedPerCharacter(c)) return CharKind.PerCharacter;
  if (isInUnspacedBlock(c)) {
    if (isUnspacedLetter(c)) return CharKind.Unspaced;
    return isUnspacedDigit(c) ? CharKind.Word : CharKind.Other;
  }
  // The halfwidth voiced marks belong to the kana before them.
  if (c === 0xff9e || c === 0xff9f) return CharKind.Other;
  const char = String.fromCodePoint(c);
  if (WHITE_SPACE.test(char)) return CharKind.Space;
  return ALPHANUMERIC.test(char) ? CharKind.Word : CharKind.Other;
}

/**
 * The number of words in a text. Must match `word_count` in `src-tauri/src/content.rs`, and
 * both are checked against `wordCountCases.json`.
 *
 * Words are runs between spaces that hold a letter or a number. Han and kana have no spaces,
 * so each of those characters counts as a word, as in Microsoft Word. Thai, Lao, Burmese and
 * Khmer have no spaces either, and finding their words takes a dictionary, which would not
 * give the same answer on both sides. They are estimated from their letters instead. Korean
 * has spaces, so it counts like English.
 *
 * `Intl.Segmenter` is not used, because its dictionaries disagree with Rust's
 * `unicode-segmentation` on these scripts, and because it splits "well-known" and "foo,bar",
 * which would change the count of existing English text.
 */
export function wordCount(text: string): number {
  let count = 0;
  let inWord = false;
  let letters = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.codePointAt(i) as number;
    if (c > 0xffff) i += 1;
    switch (charKind(c)) {
      case CharKind.Space:
        count += Math.ceil(letters / LETTERS_PER_UNSPACED_WORD);
        letters = 0;
        inWord = false;
        break;
      case CharKind.PerCharacter:
        count += 1;
        inWord = false;
        break;
      case CharKind.Unspaced:
        letters += 1;
        inWord = false;
        break;
      case CharKind.Word:
        if (!inWord) count += 1;
        inWord = true;
        break;
      case CharKind.Other:
        break;
    }
  }
  return count + Math.ceil(letters / LETTERS_PER_UNSPACED_WORD);
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** "2 minutes ago" for recent times, otherwise a short date. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (Number.isNaN(seconds)) return '';
  if (seconds < 45) return t('just now');
  const locale = currentLocale();
  const ago = new Intl.RelativeTimeFormat(locale);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return ago.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return ago.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 7) return ago.format(-days, 'day');
  // English keeps the computer's own date order, as Britain and America differ.
  const dateLocale = locale === 'en' ? undefined : locale;
  return then.toLocaleDateString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Splits a search snippet into plain and matched runs, without parsing any HTML. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf('\u0002');
    if (start < 0) {
      parts.push({ text: rest, match: false });
      break;
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), match: false });
    const end = rest.indexOf('\u0003', start);
    if (end < 0) {
      parts.push({ text: rest.slice(start + 1), match: true });
      break;
    }
    parts.push({ text: rest.slice(start + 1, end), match: true });
    rest = rest.slice(end + 1);
  }
  return parts;
}
