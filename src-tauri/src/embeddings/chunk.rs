//! Splits a page or scene into passages small enough to embed, by paragraphs, and by
//! sentences where a paragraph is long.

use sha2::{Digest, Sha256};

/// A passage grows until it reaches this many words, then the next paragraph starts another.
/// Small passages are found far more reliably: a sentence that matches a search stands out less
/// the more unrelated text shares its vector. On a book of 100,000 words with fourteen planted
/// passages (`bench.rs`), this size found the most of them, against 8, 12, 25 and 50, and the
/// time to index is about the same, since that goes by words.
const TARGET_WORDS: usize = 18;
/// Well within the built-in model's limit of 256 tokens.
const MAX_WORDS: usize = 45;
/// Words of the passage before that the model also reads. None, because in the same
/// measurement eight of them halved how often a passage was found: they are usually about
/// something else, and they blur what the passage itself says.
const OVERLAP_WORDS: usize = 0;
/// What is kept to show in results. A whole passage nearly always fits.
const SNIPPET_CHARS: usize = 800;

/// How passages are cut: one grows until it has `target` words and never passes `max`, and
/// the model also reads the last `overlap` words of the one before.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    pub target: usize,
    pub max: usize,
    pub overlap: usize,
}

pub const SHAPE: Shape = Shape { target: TARGET_WORDS, max: MAX_WORDS, overlap: OVERLAP_WORDS };

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    /// What the model reads.
    pub text: String,
    /// What a reader sees.
    pub snippet: String,
    /// Identifies `text`, so unchanged text is never embedded twice.
    pub hash: String,
}

pub fn hash_text(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(32);
    for byte in &digest[..16] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2FA1F)
}

/// How long a text is. A Chinese or Japanese character counts as a word, since those scripts
/// have no spaces to count, and that is about how many tokens each one becomes.
fn words(text: &str) -> usize {
    text.split_whitespace()
        .map(|word| word.chars().filter(|c| is_cjk(*c)).count().max(1))
        .sum()
}

/// Ends of sentences, so a long paragraph breaks between sentences where it can.
fn sentences(paragraph: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut chars = paragraph.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        if !matches!(c, '.' | '!' | '?' | '\u{2026}' | '\u{3002}' | '\u{ff01}' | '\u{ff1f}') {
            continue;
        }
        // Closing quotes and brackets belong to the sentence they end.
        let mut end = at + c.len_utf8();
        while let Some((next_at, next)) = chars.peek().copied() {
            if matches!(next, '"' | '\'' | ')' | ']' | '\u{201d}' | '\u{2019}' | '.' | '!' | '?') {
                end = next_at + next.len_utf8();
                chars.next();
            } else {
                break;
            }
        }
        let followed_by_space = paragraph[end..].chars().next().is_none_or(char::is_whitespace);
        if followed_by_space || matches!(c, '\u{3002}' | '\u{ff01}' | '\u{ff1f}') {
            out.push(paragraph[start..end].trim());
            start = end;
        }
    }
    if !paragraph[start..].trim().is_empty() {
        out.push(paragraph[start..].trim());
    }
    out
}

/// Breaks text with no sentence ends at word boundaries, since nothing else is available.
fn hard_split(text: &str, max: usize, out: &mut Vec<String>) {
    let mut current = String::new();
    let mut count = 0;
    for word in text.split_whitespace() {
        // A long run of Chinese or Japanese has no spaces, so it breaks between characters.
        let characters: Vec<char> = word.chars().collect();
        let parts: Vec<String> = if words(word) > max {
            characters.chunks(max).map(|part| part.iter().collect()).collect()
        } else {
            vec![word.to_string()]
        };
        for part in parts {
            let n = words(&part);
            if count > 0 && count + n > max {
                out.push(std::mem::take(&mut current));
                count = 0;
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(&part);
            count += n;
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
}

/// A paragraph, as one or more pieces of at most `shape.max` words.
fn paragraph_pieces(paragraph: &str, shape: Shape, out: &mut Vec<String>) {
    if words(paragraph) <= shape.max {
        out.push(paragraph.to_string());
        return;
    }
    let mut current = String::new();
    let mut count = 0;
    for sentence in sentences(paragraph) {
        let n = words(sentence);
        if n > shape.max {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
                count = 0;
            }
            hard_split(sentence, shape.max, out);
            continue;
        }
        if count > 0 && (count >= shape.target || count + n > shape.max) {
            out.push(std::mem::take(&mut current));
            count = 0;
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(sentence);
        count += n;
    }
    if !current.is_empty() {
        out.push(current);
    }
}

fn last_words(text: &str, n: usize) -> String {
    let mut taken: Vec<String> = Vec::new();
    let mut count = 0;
    for word in text.split_whitespace().rev() {
        let weight = words(word);
        if count + weight > n {
            if weight > 1 {
                let tail: Vec<char> = word.chars().rev().take(n - count).collect();
                taken.push(tail.into_iter().rev().collect());
            }
            break;
        }
        taken.push(word.to_string());
        count += weight;
    }
    taken.reverse();
    taken.join(" ")
}

/// One passage: its own text, and what the model reads, which begins with the end of the
/// passage before.
struct Passage {
    own: String,
    with_overlap: String,
}

/// The passages of a text, whose paragraphs are separated by line breaks.
fn passages(text: &str, shape: Shape) -> Vec<Passage> {
    let mut pieces = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.is_empty() {
            paragraph_pieces(line, shape, &mut pieces);
        }
    }
    let mut groups: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut count = 0;
    for piece in pieces {
        let n = words(&piece);
        if count > 0 && (count >= shape.target || count + n > shape.max) {
            groups.push(std::mem::take(&mut current));
            count = 0;
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(&piece);
        count += n;
    }
    if !current.is_empty() {
        groups.push(current);
    }
    let mut out = Vec::with_capacity(groups.len());
    for (i, group) in groups.iter().enumerate() {
        let with_overlap = if i == 0 || shape.overlap == 0 {
            group.clone()
        } else {
            format!("{}\n{group}", last_words(&groups[i - 1], shape.overlap))
        };
        out.push(Passage { own: group.clone(), with_overlap });
    }
    out
}

fn snippet_of(passage: &str) -> String {
    let joined = passage.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() <= SNIPPET_CHARS {
        return joined;
    }
    let cut: String = joined.chars().take(SNIPPET_CHARS).collect();
    let cut = cut.rfind(' ').map_or(cut.as_str(), |at| &cut[..at]);
    format!("{cut}\u{2026}")
}

/// The chunks of one document. A page's title goes in front of each passage, because a page
/// is about its title even where the text only says "she". A scene's title is usually just a
/// label, so `title` is `None` for scenes.
pub fn chunk_document(title: Option<&str>, body: &str) -> Vec<Chunk> {
    chunk_document_shaped(SHAPE, title, body)
}

/// `chunk_document`, cut another way, for measuring.
pub fn chunk_document_shaped(shape: Shape, title: Option<&str>, body: &str) -> Vec<Chunk> {
    passages(body, shape)
        .into_iter()
        .map(|passage| {
            let text = match title {
                Some(title) if !title.trim().is_empty() => format!("{}: {}", title.trim(), passage.with_overlap),
                _ => passage.with_overlap,
            };
            Chunk {
                hash: hash_text(&text),
                snippet: snippet_of(&passage.own),
                text,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split_text(text: &str) -> Vec<String> {
        passages(text, SHAPE).into_iter().map(|p| p.with_overlap).collect()
    }

    fn numbered(n: usize, prefix: &str) -> String {
        (0..n).map(|i| format!("{prefix}{i}")).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn short_text_is_one_chunk_and_blank_text_is_none() {
        assert_eq!(split_text("One.\n\nTwo."), vec!["One.\nTwo.".to_string()]);
        assert!(split_text("  \n \n").is_empty());
        assert!(chunk_document(Some("Aria"), "").is_empty());
    }

    #[test]
    fn paragraphs_group_up_to_the_target_then_start_a_new_chunk() {
        let short = TARGET_WORDS / 2 + 1;
        let text = format!("{}\n{}\n{}", numbered(short, "a"), numbered(short, "b"), numbered(short, "c"));
        let chunks = split_text(&text);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].starts_with("a0 "));
        assert!(chunks[0].contains(&format!("b{}", short - 1)));
        assert!(!chunks[0].contains("c0"));
        // Nothing of the first is read again with the second.
        assert!(chunks[1].starts_with("c0 "));
        assert!(chunks[1].contains(&format!("c{}", short - 1)));
    }

    #[test]
    fn an_overlap_when_asked_for_begins_with_the_end_of_the_passage_before() {
        let short = TARGET_WORDS / 2 + 1;
        let text = format!("{}\n{}\n{}", numbered(short, "a"), numbered(short, "b"), numbered(short, "c"));
        let chunks: Vec<String> = passages(&text, Shape { overlap: 3, ..SHAPE }).into_iter().map(|p| p.with_overlap).collect();
        assert_eq!(chunks.len(), 2);
        assert!(chunks[1].starts_with(&last_words(&chunks[0], 3)));
        assert!(chunks[1].contains("c0"));
    }

    #[test]
    fn a_long_paragraph_breaks_between_sentences_and_keeps_every_word() {
        let sentence = |i: usize| format!("{}.", numbered(MAX_WORDS / 4, &format!("s{i}w")));
        let text = (0..12).map(sentence).collect::<Vec<_>>().join(" ");
        let chunks = split_text(&text);
        assert!(chunks.len() >= 2);
        for chunk in &chunks {
            assert!(words(chunk) <= MAX_WORDS + OVERLAP_WORDS, "{}", words(chunk));
        }
        for i in 0..12 {
            assert!(chunks.iter().any(|c| c.contains(&format!("s{i}w{}.", MAX_WORDS / 4 - 1))), "sentence {i}");
        }
    }

    #[test]
    fn text_with_no_sentence_ends_is_still_split() {
        let chunks = split_text(&numbered(1000, "w"));
        assert!(chunks.len() >= 1000 / MAX_WORDS);
        assert!(chunks.iter().all(|c| words(c) <= MAX_WORDS + OVERLAP_WORDS));
        assert!(chunks.iter().any(|c| c.contains("w999")));
    }

    #[test]
    fn sentence_ends_inside_quotes_and_abbreviations_are_handled_without_panicking() {
        let parts = sentences("\u{201c}Stop.\u{201d} She ran! Why? e.g. this \u{2026} and that");
        assert_eq!(parts[0], "\u{201c}Stop.\u{201d}");
        assert_eq!(parts[1], "She ran!");
        assert_eq!(parts[2], "Why?");
        assert_eq!(parts.last().unwrap(), &"and that");
    }

    #[test]
    fn the_hash_follows_the_text_and_the_title_counts_for_pages() {
        let a = chunk_document(Some("Aria"), "She guarded the door.");
        let b = chunk_document(Some("Aria"), "She guarded the door.");
        let c = chunk_document(Some("Lyra"), "She guarded the door.");
        let d = chunk_document(None, "She guarded the door.");
        assert_eq!(a[0].hash, b[0].hash);
        assert_ne!(a[0].hash, c[0].hash);
        assert_eq!(a[0].text, "Aria: She guarded the door.");
        assert_eq!(a[0].snippet, "She guarded the door.");
        // What a reader sees leaves out any overlap with the passage before.
        let long = format!("{}\n{}", numbered(MAX_WORDS - 5, "x"), "The second paragraph.");
        let two = chunk_document_shaped(Shape { overlap: 4, ..SHAPE }, None, &long);
        assert_eq!(two.len(), 2);
        assert!(two[1].text.starts_with(&last_words(&numbered(MAX_WORDS - 5, "x"), 4)));
        assert_eq!(two[1].snippet, "The second paragraph.");
        assert_eq!(chunk_document(None, &long)[1].text, "The second paragraph.");
        assert_eq!(d[0].text, "She guarded the door.");
    }

    #[test]
    fn chinese_and_japanese_text_with_no_spaces_is_still_split() {
        let sentence = "\u{4e16}".repeat(MAX_WORDS / 4) + "\u{3002}";
        let chunks = split_text(&sentence.repeat(20));
        assert!(chunks.len() >= 3, "{}", chunks.len());
        assert!(chunks.iter().all(|c| words(c) <= MAX_WORDS + OVERLAP_WORDS));

        let chunks = split_text(&"\u{4e16}".repeat(1000));
        assert!(chunks.len() >= 3, "{}", chunks.len());
        assert!(chunks.iter().all(|c| words(c) <= MAX_WORDS + OVERLAP_WORDS));
        assert_eq!(last_words(&"\u{4e16}".repeat(100), 5), "\u{4e16}".repeat(5));
    }

    #[test]
    fn long_snippets_are_cut_on_a_word_boundary_even_in_other_scripts() {
        let long = "\u{e9}t\u{e9} ".repeat(1000);
        let snippet = snippet_of(&long);
        assert!(snippet.ends_with('\u{2026}'));
        assert!(snippet.chars().count() <= SNIPPET_CHARS + 1);
    }
}
