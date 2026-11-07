//! Plain text for outside tools. It mirrors `pmToPlainText` in `src/editor/convert.ts`,
//! because the stored `content_text` has figure captions but not their numbers.

use std::collections::HashMap;

use serde_json::Value;

fn figure_name(kind: &str) -> &'static str {
    match kind {
        "picture" => "Picture",
        "table" => "Table",
        "video" => "Video",
        _ => "Figure",
    }
}

fn node_type(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

fn children(node: &Value) -> &[Value] {
    node.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn plain(node: &Value, counts: &mut HashMap<String, usize>, out: &mut String) {
    let kind = node_type(node);
    if kind == "figure" {
        let figure_kind = node
            .pointer("/attrs/kind")
            .and_then(Value::as_str)
            .unwrap_or("figure");
        let number = counts.entry(figure_kind.to_string()).or_insert(0);
        *number += 1;
        let number = *number;
        let caption = children(node)
            .iter()
            .find(|c| node_type(c) == "figcaption")
            .map(doc_to_text)
            .unwrap_or_default();
        let description = node
            .pointer("/attrs/description")
            .and_then(Value::as_str)
            .unwrap_or("");
        out.push('[');
        out.push_str(figure_name(figure_kind));
        out.push_str(&format!(" {number}: "));
        out.push_str(if caption.is_empty() { "no label" } else { &caption });
        if !description.is_empty() {
            out.push_str(&format!(" ({description})"));
        }
        out.push_str("]\n\n");
        // A table's cells are real text, so they stay. Other media have none.
        for child in children(node).iter().filter(|c| node_type(c) == "table") {
            plain(child, counts, out);
        }
        return;
    }
    match kind {
        "text" => out.push_str(node.get("text").and_then(Value::as_str).unwrap_or("")),
        "hardBreak" => out.push('\n'),
        _ => {}
    }
    for (index, child) in children(node).iter().enumerate() {
        if kind == "tableRow" && index > 0 {
            out.push('\t');
        }
        plain(child, counts, out);
    }
    if matches!(
        kind,
        "paragraph" | "heading" | "codeBlock" | "tableRow" | "horizontalRule"
    ) {
        out.push_str("\n\n");
    }
}

/// Plain text with blank lines between blocks. A figure becomes a line that names it, as
/// `[Figure 2: label (description)]`, so a reader knows it is there.
pub fn doc_to_text(doc: &Value) -> String {
    let mut out = String::new();
    plain(doc, &mut HashMap::new(), &mut out);
    let mut squeezed = String::with_capacity(out.len());
    let mut newlines = 0;
    for c in out.chars() {
        if c == '\n' {
            newlines += 1;
            if newlines > 2 {
                continue;
            }
        } else {
            newlines = 0;
        }
        squeezed.push(c);
    }
    squeezed.trim().to_string()
}

/// Characters a model cannot see and should not have to type.
fn is_invisible(c: char) -> bool {
    matches!(c, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}')
}

fn is_dash(c: char) -> bool {
    matches!(
        c,
        '-' | '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' | '\u{2212}'
    )
}

/// Text as compared, with where each of its characters came from in the original.
pub struct Normalized {
    pub text: String,
    /// For each character of `text`: its byte offset there, and the original bytes it covers.
    at: Vec<usize>,
    from: Vec<usize>,
    to: Vec<usize>,
}

impl Normalized {
    /// The original bytes behind `text[start..end]`.
    pub fn original(&self, start: usize, end: usize) -> (usize, usize) {
        if self.at.is_empty() || start >= end {
            return (0, 0);
        }
        let first = self.at.partition_point(|&a| a < start).min(self.at.len() - 1);
        let last = self.at.partition_point(|&a| a < end).saturating_sub(1).max(first);
        (self.from[first], self.to[last])
    }
}

/// How a quote is compared with a document. Must match `normalizeQuote` in
/// `src/mcp/apply.ts`, and `src/mcp/quote-cases.json` holds cases both sides check.
/// Models straighten curly quotes, rewrap lines, and type `--` or `...` for a dash or an
/// ellipsis, and none of that should make a quote fail. Every dash and run of dashes reads
/// as one `-`, with no space on either side; an ellipsis reads as three dots; invisible
/// characters are dropped; any run of spaces is one space.
pub fn normalize_with_map(text: &str) -> Normalized {
    let mut out = Normalized {
        text: String::with_capacity(text.len()),
        at: Vec::new(),
        from: Vec::new(),
        to: Vec::new(),
    };
    let mut space = false;
    let push = |out: &mut Normalized, c: char, from: usize, to: usize| {
        out.at.push(out.text.len());
        out.from.push(from);
        out.to.push(to);
        out.text.push(c);
    };
    for (index, raw) in text.char_indices() {
        let end = index + raw.len_utf8();
        if is_invisible(raw) {
            continue;
        }
        if raw.is_whitespace() {
            space = true;
            continue;
        }
        let last = out.text.chars().next_back();
        if is_dash(raw) {
            space = false;
            if last == Some('-') {
                if let Some(to) = out.to.last_mut() {
                    *to = end;
                }
            } else {
                push(&mut out, '-', index, end);
            }
            continue;
        }
        if space && last.is_some() && last != Some('-') {
            push(&mut out, ' ', index, index);
        }
        space = false;
        match raw {
            '\u{2018}' | '\u{2019}' => push(&mut out, '\'', index, end),
            '\u{201C}' | '\u{201D}' => push(&mut out, '"', index, end),
            '\u{2026}' => {
                for _ in 0..3 {
                    push(&mut out, '.', index, end);
                }
            }
            other => push(&mut out, other, index, end),
        }
    }
    out
}

pub fn normalize_quote(text: &str) -> String {
    normalize_with_map(text).text
}

/// A quote ready to look for in `haystack` (already normalized). Emphasis markers a model
/// adds are dropped when the text has none, since it reads plain text.
pub fn needle_for(quote: &str, haystack: &str) -> String {
    let mut needle = normalize_quote(quote);
    let mut stripped = false;
    for mark in ['*', '_'] {
        if needle.contains(mark) && !haystack.contains(mark) {
            needle = needle.replace(mark, "");
            stripped = true;
        }
    }
    if stripped {
        needle = normalize_quote(&needle);
    }
    needle
}

/// The byte offsets where `needle` starts, without overlaps.
pub fn find_all(haystack: &str, needle: &str) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    haystack.match_indices(needle).map(|(at, _)| at).collect()
}

fn word_key(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The passage of `original` most like `quote`, cut short, to tell a model what is really
/// there. None when nothing shares a word with it.
pub fn closest_passage(original: &str, quote: &str) -> Option<String> {
    let hay = normalize_with_map(original);
    let wanted: Vec<String> = normalize_quote(quote)
        .split(' ')
        .map(word_key)
        .filter(|w| !w.is_empty())
        .take(60)
        .collect();
    if wanted.is_empty() {
        return None;
    }
    let mut words: Vec<(usize, usize, String)> = Vec::new();
    let mut start = None;
    let ends = hay.text.char_indices().chain(std::iter::once((hay.text.len(), ' ')));
    for (i, c) in ends {
        if c == ' ' || c == '-' {
            if let Some(s) = start.take() {
                words.push((s, i, word_key(&hay.text[s..i])));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if words.is_empty() {
        return None;
    }
    let size = wanted.len().min(words.len());
    let mut need: HashMap<&str, i64> = HashMap::new();
    for w in &wanted {
        *need.entry(w.as_str()).or_insert(0) += 1;
    }
    let mut have: HashMap<&str, i64> = HashMap::new();
    let mut score = 0i64;
    let mut best = (0i64, 0usize);
    for i in 0..words.len() {
        let key = words[i].2.as_str();
        let count = have.entry(key).or_insert(0);
        *count += 1;
        if *count <= *need.get(key).unwrap_or(&0) {
            score += 1;
        }
        if i >= size {
            let gone = words[i - size].2.as_str();
            let count = have.entry(gone).or_insert(0);
            if *count <= *need.get(gone).unwrap_or(&0) {
                score -= 1;
            }
            *count -= 1;
        }
        if i + 1 >= size && score > best.0 {
            best = (score, i + 1 - size);
        }
    }
    if best.0 == 0 {
        return None;
    }
    let first = &words[best.1];
    let last = &words[best.1 + size - 1];
    let (from, to) = hay.original(first.0, last.1);
    let passage = original[from..to].split_whitespace().collect::<Vec<_>>().join(" ");
    let short = cut(&passage, 300);
    Some(if short.len() < passage.len() {
        format!("{short}...")
    } else {
        passage
    })
}

/// Cuts text to at most `limit` bytes without splitting a character.
pub fn cut(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn figures_become_numbered_lines_per_kind() {
        let doc = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "Before." }] },
            { "type": "figure", "attrs": { "kind": "figure", "description": "Aria at dawn" }, "content": [
                { "type": "image", "attrs": { "assetId": "a" } },
                { "type": "figcaption", "content": [{ "type": "text", "text": "The gate" }] },
            ]},
            { "type": "figure", "attrs": { "kind": "picture" }, "content": [
                { "type": "image", "attrs": { "assetId": "b" } },
            ]},
            { "type": "figure", "attrs": { "kind": "figure" }, "content": [
                { "type": "image", "attrs": { "assetId": "c" } },
                { "type": "figcaption", "content": [{ "type": "text", "text": "The wall" }] },
            ]},
            { "type": "paragraph", "content": [{ "type": "text", "text": "After." }] },
        ]});
        assert_eq!(
            doc_to_text(&doc),
            "Before.\n\n[Figure 1: The gate (Aria at dawn)]\n\n[Picture 1: no label]\n\n[Figure 2: The wall]\n\nAfter."
        );
    }

    #[test]
    fn quotes_ignore_curly_marks_and_line_wrapping() {
        assert_eq!(
            normalize_quote("  \u{201C}Don\u{2019}t\n\n go,\u{201D}  she said. "),
            "\"Don't go,\" she said."
        );
    }

    /// The same cases run against `normalizeQuote` in `src/mcp/apply.test.ts`.
    #[test]
    fn quote_cases_agree_with_the_app() {
        let cases: Vec<(String, String)> =
            serde_json::from_str(include_str!("../../../src/mcp/quote-cases.json")).unwrap();
        assert!(cases.len() > 5);
        for (input, expected) in cases {
            assert_eq!(normalize_quote(&input), expected, "{input:?}");
        }
    }

    #[test]
    fn emphasis_is_dropped_only_when_the_text_has_none() {
        assert_eq!(needle_for("the *old* gate", "the old gate"), "the old gate");
        assert_eq!(needle_for("2*3", "2*3 is six"), "2*3");
        assert_eq!(needle_for("a _b_ c", "a b c"), "a b c");
    }

    #[test]
    fn the_map_points_back_at_the_original() {
        let text = "Wait\u{2026} no \u{2014} go.";
        let n = normalize_with_map(text);
        assert_eq!(n.text, "Wait... no-go.");
        let at = n.text.find("no-go").unwrap();
        let (from, to) = n.original(at, at + "no-go".len());
        assert_eq!(&text[from..to], "no \u{2014} go");
    }

    #[test]
    fn the_closest_passage_is_found() {
        let text = "The rain fell on the old gate. Aria waited by the river until dusk. Then she left.";
        let hint = closest_passage(text, "Aria waited at the river till dusk").unwrap();
        assert!(hint.contains("Aria waited by the river"), "{hint}");
        assert!(closest_passage(text, "zebra quantum").is_none());
    }

    #[test]
    fn cutting_keeps_characters_whole() {
        assert_eq!(cut("caf\u{e9}", 4), "caf");
        assert_eq!(cut("cafe", 10), "cafe");
    }
}
