//! BERT's uncased tokenizer: clean, lower-case, strip accents, split on punctuation, then
//! greedy longest-match WordPiece. Matches `BertTokenizer` for the text a novel holds. The
//! standard library has no Unicode normalization or punctuation tables, so the accents and
//! punctuation of the scripts in the vocabulary are listed here instead.

use std::collections::HashMap;

/// A word longer than this is one unknown token, as in the original.
const MAX_CHARS_PER_WORD: usize = 100;

pub struct Tokenizer {
    vocab: HashMap<String, u32>,
    unk: u32,
    cls: u32,
    sep: u32,
}

fn is_control(c: char) -> bool {
    !matches!(c, '\t' | '\n' | '\r') && (c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}'))
}

fn is_chinese(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x20000..=0x2A6DF | 0x2A700..=0x2B73F
        | 0x2B740..=0x2B81F | 0x2B820..=0x2CEAF | 0xF900..=0xFAFF | 0x2F800..=0x2FA1F)
}

fn is_punctuation(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_punctuation();
    }
    matches!(c as u32,
        0xA1 | 0xA7 | 0xAB | 0xB6 | 0xB7 | 0xBB | 0xBF
        | 0x2010..=0x2027 | 0x2030..=0x205E | 0x2E00..=0x2E7F
        | 0x3001..=0x3003 | 0x3008..=0x3011 | 0x3014..=0x301F | 0x30FB
        | 0xFE10..=0xFE19 | 0xFE30..=0xFE52 | 0xFF01..=0xFF03 | 0xFF05..=0xFF0A
        | 0xFF0C..=0xFF0F | 0xFF1A | 0xFF1B | 0xFF1F | 0xFF20 | 0xFF3B..=0xFF3D
        | 0xFF3F | 0xFF5B | 0xFF5D | 0xFF5F..=0xFF65)
}

fn is_combining_mark(c: char) -> bool {
    matches!(c as u32, 0x300..=0x36F | 0x483..=0x489 | 0x591..=0x5BD | 0x610..=0x61A | 0x64B..=0x65F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

/// What is left of a lower-case letter once its accent is gone.
fn without_accent(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' | 'ǎ' => 'a',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ď' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' | 'ẽ' => 'e',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ĥ' => 'h',
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ǐ' => 'i',
        'ĵ' => 'j',
        'ķ' => 'k',
        'ĺ' | 'ļ' | 'ľ' => 'l',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ō' | 'ŏ' | 'ő' | 'ǒ' => 'o',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'ś' | 'ŝ' | 'ş' | 'š' | 'ș' => 's',
        'ţ' | 'ť' | 'ț' => 't',
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' | 'ǔ' => 'u',
        'ŵ' => 'w',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        'ά' => 'α',
        'έ' => 'ε',
        'ή' => 'η',
        'ί' | 'ϊ' | 'ΐ' => 'ι',
        'ό' => 'ο',
        'ύ' | 'ϋ' | 'ΰ' => 'υ',
        'ώ' => 'ω',
        'й' => 'и',
        'ё' => 'е',
        'ї' => 'і',
        other => other,
    }
}

impl Tokenizer {
    /// Reads `vocab.txt`: one token per line, with its line number as its id.
    pub fn from_vocab(text: &str) -> Result<Self, String> {
        let vocab: HashMap<String, u32> = text
            .lines()
            .enumerate()
            .map(|(id, token)| (token.trim_end_matches('\r').to_string(), id as u32))
            .collect();
        let find = |name: &str| vocab.get(name).copied().ok_or_else(|| format!("The vocabulary has no {name} token."));
        let (unk, cls, sep) = (find("[UNK]")?, find("[CLS]")?, find("[SEP]")?);
        Ok(Self { vocab, unk, cls, sep })
    }

    fn word_pieces(&self, word: &str, out: &mut Vec<u32>) {
        let chars: Vec<char> = word.chars().collect();
        if chars.len() > MAX_CHARS_PER_WORD {
            out.push(self.unk);
            return;
        }
        let first = out.len();
        let mut start = 0;
        let mut piece = String::new();
        while start < chars.len() {
            let mut end = chars.len();
            let mut found = None;
            while start < end {
                piece.clear();
                if start > 0 {
                    piece.push_str("##");
                }
                piece.extend(&chars[start..end]);
                if let Some(id) = self.vocab.get(piece.as_str()) {
                    found = Some(*id);
                    break;
                }
                end -= 1;
            }
            let Some(id) = found else {
                // One part with no match makes the whole word unknown.
                out.truncate(first);
                out.push(self.unk);
                return;
            };
            out.push(id);
            start = end;
        }
    }

    /// Token ids including the start and end markers, at most `max_len` in all.
    pub fn encode(&self, text: &str, max_len: usize) -> Vec<u32> {
        let room = max_len.saturating_sub(2);
        let mut ids = vec![self.cls];
        let mut word = String::new();
        let mut done = false;
        {
            let finish = |word: &mut String, ids: &mut Vec<u32>| {
                if !word.is_empty() {
                    self.word_pieces(word, ids);
                    word.clear();
                }
            };
            for original in text.chars() {
                if ids.len() > room {
                    done = true;
                    break;
                }
                if is_control(original) || original == '\u{fffd}' {
                    continue;
                }
                if original.is_whitespace() {
                    finish(&mut word, &mut ids);
                    continue;
                }
                if is_chinese(original) {
                    finish(&mut word, &mut ids);
                    word.push(original);
                    finish(&mut word, &mut ids);
                    continue;
                }
                for lower in original.to_lowercase() {
                    if is_combining_mark(lower) {
                        continue;
                    }
                    if is_punctuation(lower) {
                        finish(&mut word, &mut ids);
                        word.push(lower);
                        finish(&mut word, &mut ids);
                    } else {
                        word.push(without_accent(lower));
                    }
                }
            }
            if !done {
                finish(&mut word, &mut ids);
            }
        }
        ids.truncate(room + 1);
        ids.push(self.sep);
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokenizer() -> Tokenizer {
        let vocab = "[PAD]\n[UNK]\n[CLS]\n[SEP]\nthe\nknight\nat\n##s\ngate\n,\n.\n\u{2019}\neowyn\nun\n##want\n##ed\n\u{4e16}";
        Tokenizer::from_vocab(vocab).unwrap()
    }

    #[test]
    fn splits_words_and_punctuation_and_folds_case_and_accents() {
        let t = tokenizer();
        assert_eq!(t.encode("The KNIGHTS, at the gate.", 32), vec![2, 4, 5, 7, 9, 6, 4, 8, 10, 3]);
        assert_eq!(t.encode("\u{c9}owyn", 32), vec![2, 12, 3]);
        assert_eq!(t.encode("E\u{301}owyn", 32), vec![2, 12, 3], "a separate combining accent too");
        assert_eq!(t.encode("the\u{2019}s", 32), vec![2, 4, 11, 1, 3], "curly quotes are punctuation");
    }

    #[test]
    fn unknown_parts_make_the_whole_word_unknown() {
        let t = tokenizer();
        assert_eq!(t.encode("unwanted", 32), vec![2, 13, 14, 15, 3]);
        assert_eq!(t.encode("unwantedx", 32), vec![2, 1, 3]);
        assert_eq!(t.encode(&"a".repeat(101), 32), vec![2, 1, 3]);
    }

    #[test]
    fn stays_within_the_limit_and_keeps_both_markers() {
        let t = tokenizer();
        let ids = t.encode(&"the ".repeat(100), 8);
        assert_eq!(ids.len(), 8);
        assert_eq!(ids[0], 2);
        assert_eq!(ids[7], 3);
        assert_eq!(t.encode("", 8), vec![2, 3]);
    }

    #[test]
    fn chinese_characters_stand_alone() {
        assert_eq!(tokenizer().encode("\u{4e16}\u{4e16}", 8), vec![2, 16, 16, 3]);
    }
}
