//! Reads ProseMirror JSON. Everything derived from a document (text, word count,
//! links) is computed here, so it cannot drift from what was saved.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

/// Must match `titleKey` in `src/lib/text.ts`.
pub fn title_key(title: &str) -> String {
    title
        .replace('_', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// About this many letters make a word in Thai, Lao, Khmer and Burmese.
const LETTERS_PER_UNSPACED_WORD: i64 = 4;

/// Han, kana and Bopomofo. Must match `isCountedPerCharacter` in `src/lib/text.ts`.
fn is_counted_per_character(c: u32) -> bool {
    matches!(c,
        0x4E00..=0x9FFF
        | 0x3041..=0x3096
        | 0x30A1..=0x30FA
        | 0x30FC..=0x30FF
        | 0x3005..=0x3007
        | 0x3021..=0x3029
        | 0x3038..=0x303B
        | 0x309D..=0x309F
        | 0x3105..=0x312F
        | 0x31A0..=0x31BF
        | 0x31F0..=0x31FF
        | 0x3400..=0x4DBF
        | 0xF900..=0xFAFF
        | 0xFF66..=0xFF9D
        | 0x1AFF0..=0x1B16F
        | 0x20000..=0x3FFFF)
}

/// The letters of Thai, Lao, Burmese and Khmer. Must match `src/lib/text.ts`.
fn is_unspaced_letter(c: u32) -> bool {
    matches!(c,
        0x0E01..=0x0E30
        | 0x0E32..=0x0E33
        | 0x0E40..=0x0E46
        | 0x0E81..=0x0EB0
        | 0x0EB2..=0x0EB3
        | 0x0EBD..=0x0EC6
        | 0x1000..=0x102A
        | 0x103F
        | 0x1050..=0x1055
        | 0x1780..=0x17B3)
}

/// The digits of those scripts, which count like any other number.
fn is_unspaced_digit(c: u32) -> bool {
    matches!(c, 0x0E50..=0x0E59 | 0x0ED0..=0x0ED9 | 0x1040..=0x1049 | 0x17E0..=0x17E9)
}

/// Whether a character is in the Thai, Lao, Burmese or Khmer blocks.
fn is_in_unspaced_block(c: u32) -> bool {
    matches!(c, 0x0E00..=0x0EFF | 0x1000..=0x109F | 0x1780..=0x17FF)
}

/// Whether a character belongs to a script whose words have no dependable edges: Han, kana
/// and the scripts written without spaces, and Hangul, where particles join the word before
/// them. Search and name detection look inside runs of these. Must match `isUnspacedScript`
/// in `src/lib/text.ts`.
pub fn is_unspaced_script(ch: char) -> bool {
    let c = ch as u32;
    is_counted_per_character(c)
        || is_in_unspaced_block(c)
        || matches!(c,
            0xAC00..=0xD7A3
            | 0x1100..=0x11FF
            | 0x3131..=0x318E
            | 0xA960..=0xA97C
            | 0xD7B0..=0xD7FB)
}

/// The number of words in a text. Must match `wordCount` in `src/lib/text.ts`, and both are
/// checked against `src/lib/wordCountCases.json`, which explains the rule.
pub fn word_count(text: &str) -> i64 {
    let mut count = 0;
    let mut in_word = false;
    let mut letters = 0;
    for ch in text.chars() {
        let c = ch as u32;
        if ch.is_whitespace() {
            count += div_ceil(letters, LETTERS_PER_UNSPACED_WORD);
            letters = 0;
            in_word = false;
        } else if is_counted_per_character(c) {
            count += 1;
            in_word = false;
        } else if is_in_unspaced_block(c) && is_unspaced_letter(c) {
            letters += 1;
            in_word = false;
        } else if is_in_unspaced_block(c) && !is_unspaced_digit(c) {
            // A mark or punctuation of those scripts, some of which Rust calls alphabetic.
        } else if c == 0xFF9E || c == 0xFF9F {
            // The halfwidth voiced marks belong to the kana before them.
        } else if ch.is_alphanumeric() {
            if !in_word {
                count += 1;
            }
            in_word = true;
        }
    }
    count + div_ceil(letters, LETTERS_PER_UNSPACED_WORD)
}

fn div_ceil(value: i64, by: i64) -> i64 {
    (value + by - 1) / by
}

pub fn empty_doc() -> Value {
    json!({ "type": "doc", "content": [{ "type": "paragraph" }] })
}

#[derive(Debug, Default, PartialEq)]
pub struct Extracted {
    pub text: String,
    pub word_count: i64,
    /// title_key -> the title as written.
    pub links: BTreeMap<String, String>,
    /// Ids of the comments anchored in this document.
    pub comments: BTreeSet<String>,
}

/// Walking state, kept apart so figure text reaches `text` but not the word count.
#[derive(Default)]
struct Walk {
    out: Extracted,
    /// Text that counts as the writer's prose.
    counted: String,
}

impl Walk {
    fn push(&mut self, text: &str, in_figure: bool) {
        self.out.text.push_str(text);
        if !in_figure {
            self.counted.push_str(text);
        }
    }
}

pub fn extract(doc: &Value) -> Extracted {
    let mut state = Walk::default();
    walk(doc, &mut state, false);
    let mut out = state.out;
    out.text = out.text.trim_end().to_string();
    out.word_count = word_count(&state.counted);
    out
}

fn is_block(node_type: &str) -> bool {
    matches!(
        node_type,
        "paragraph"
            | "heading"
            | "codeBlock"
            | "tableCell"
            | "tableHeader"
            | "horizontalRule"
            | "figcaption"
    )
}

fn walk(node: &Value, state: &mut Walk, in_figure: bool) {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");
    let in_figure = in_figure || node_type == "figure";
    match node_type {
        "text" => {
            if let Some(text) = node.get("text").and_then(Value::as_str) {
                state.push(text, in_figure);
            }
            if let Some(marks) = node.get("marks").and_then(Value::as_array) {
                for mark in marks {
                    if mark.get("type").and_then(Value::as_str) == Some("comment") {
                        if let Some(id) = mark.pointer("/attrs/id").and_then(Value::as_str) {
                            if !id.is_empty() {
                                state.out.comments.insert(id.to_string());
                            }
                        }
                    }
                    if mark.get("type").and_then(Value::as_str) == Some("wikiLink") {
                        if let Some(target) = mark.pointer("/attrs/target").and_then(Value::as_str)
                        {
                            let key = title_key(target);
                            if !key.is_empty() {
                                state
                                    .out
                                    .links
                                    .entry(key)
                                    .or_insert_with(|| target.to_string());
                            }
                        }
                    }
                }
            }
        }
        "hardBreak" => state.push("\n", in_figure),
        _ => {}
    }
    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for child in children {
            walk(child, state, in_figure);
        }
    }
    // The description is searchable and can name things, as a caption can.
    if node_type == "figure" {
        if let Some(description) = node.pointer("/attrs/description").and_then(Value::as_str) {
            if !description.is_empty() {
                state.push(description, true);
                state.push("\n", true);
            }
        }
    }
    if is_block(node_type) {
        if !state.out.text.ends_with('\n') {
            state.out.text.push('\n');
        }
        if !in_figure && !state.counted.ends_with('\n') {
            state.counted.push('\n');
        }
    }
}

/// Takes `comment` marks out of a document, for anything leaving the project. Comments are
/// notes to the writer, and text that a comment had split into runs joins up again.
pub fn strip_comment_marks(node: &mut Value) {
    let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };
    let mut joined: Vec<Value> = Vec::with_capacity(children.len());
    for mut child in std::mem::take(children) {
        strip_comment_marks(&mut child);
        let mut emptied = false;
        if let Some(marks) = child.get_mut("marks").and_then(Value::as_array_mut) {
            let before = marks.len();
            marks.retain(|m| m.get("type").and_then(Value::as_str) != Some("comment"));
            emptied = marks.is_empty() && before > 0;
        }
        if emptied {
            if let Some(fields) = child.as_object_mut() {
                fields.remove("marks");
            }
        }
        if let Some(last) = joined.last_mut() {
            let both_text = last.get("type").and_then(Value::as_str) == Some("text")
                && child.get("type").and_then(Value::as_str) == Some("text");
            if both_text && last.get("marks") == child.get("marks") {
                let more = child.get("text").and_then(Value::as_str).unwrap_or("");
                let start = last.get("text").and_then(Value::as_str).unwrap_or("");
                last["text"] = Value::String(format!("{start}{more}"));
                continue;
            }
        }
        joined.push(child);
    }
    *children = joined;
}

/// Rewrites every wikiLink mark pointing at `old_key` to point at `new_title`.
/// Returns how many marks changed.
pub fn rewrite_link_targets(node: &mut Value, old_key: &str, new_title: &str) -> usize {
    let mut changed = 0;
    if let Some(marks) = node.get_mut("marks").and_then(Value::as_array_mut) {
        for mark in marks {
            if mark.get("type").and_then(Value::as_str) != Some("wikiLink") {
                continue;
            }
            let matches = mark
                .pointer("/attrs/target")
                .and_then(Value::as_str)
                .map(|t| title_key(t) == old_key)
                .unwrap_or(false);
            if matches {
                mark["attrs"]["target"] = json!(new_title);
                changed += 1;
            }
        }
    }
    if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
        for child in children {
            changed += rewrite_link_targets(child, old_key, new_title);
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Early life" }] },
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "Born in " },
                    { "type": "text", "text": "the Vale", "marks": [{ "type": "wikiLink", "attrs": { "target": "Silver  Vale" } }] },
                    { "type": "text", "text": ", she left." },
                    { "type": "hardBreak" },
                    { "type": "text", "text": "Never returned." }
                ]}
            ]
        })
    }

    #[test]
    fn comment_marks_do_not_change_the_text_and_can_be_stripped() {
        let plain = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [
            { "type": "text", "text": "The old " },
            { "type": "text", "text": "gate", "marks": [{ "type": "bold" }] },
            { "type": "text", "text": " held." }
        ] }] });
        let mut marked = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [
            { "type": "text", "text": "The " },
            { "type": "text", "text": "old ", "marks": [{ "type": "comment", "attrs": { "id": "c1" } }] },
            { "type": "text", "text": "ga", "marks": [{ "type": "bold" }, { "type": "comment", "attrs": { "id": "c1" } }] },
            { "type": "text", "text": "te", "marks": [{ "type": "bold" }] },
            { "type": "text", "text": " held." }
        ] }] });
        let found = extract(&marked);
        assert_eq!(found.text, extract(&plain).text);
        assert_eq!(found.word_count, 4);
        assert_eq!(found.comments.iter().collect::<Vec<_>>(), vec!["c1"]);
        strip_comment_marks(&mut marked);
        assert_eq!(marked, plain);
        assert!(extract(&marked).comments.is_empty());
    }

    #[test]
    fn title_key_normalizes() {
        assert_eq!(title_key("  Silver_Vale   Keep "), "silver vale keep");
        assert_eq!(title_key("ÉLAN"), "élan");
    }

    #[test]
    fn extract_finds_text_links_and_counts() {
        let e = extract(&sample());
        assert_eq!(e.text, "Early life\nBorn in the Vale, she left.\nNever returned.");
        assert_eq!(e.word_count, 10);
        assert_eq!(e.links.get("silver vale").unwrap(), "Silver  Vale");
    }

    #[test]
    fn word_count_ignores_punctuation_only_tokens() {
        assert_eq!(word_count("one - two -- three"), 3);
        assert_eq!(word_count(""), 0);
    }

    /// The same table runs in `src/lib/text.test.ts`, so the two counts cannot drift apart.
    #[test]
    fn word_count_agrees_with_the_shared_table() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../src/lib/wordCountCases.json")).unwrap();
        assert!(cases.len() > 40);
        for case in &cases {
            assert_eq!(
                word_count(case["text"].as_str().unwrap()),
                case["words"].as_i64().unwrap(),
                "{}: {:?}",
                case["note"],
                case["text"],
            );
        }
    }

    #[test]
    fn word_count_of_a_long_chinese_text_is_its_number_of_characters() {
        assert_eq!(word_count(&"天地玄黄，".repeat(5000)), 20_000);
    }

    #[test]
    fn chinese_counts_per_character_across_blocks_and_leaves_figures_out() {
        let doc = json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "第一章" }] },
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "林黛玉" },
                    { "type": "text", "text": "笑了。", "marks": [{ "type": "bold" }] }
                ]},
                { "type": "figure", "attrs": { "kind": "picture", "description": "一幅画" }, "content": [
                    { "type": "image", "attrs": { "assetId": "a" } },
                    { "type": "figcaption", "content": [{ "type": "text", "text": "大观园" }] }
                ]},
                { "type": "paragraph", "content": [{ "type": "text", "text": "Yes." }] }
            ]
        });
        let e = extract(&doc);
        assert_eq!(e.word_count, 3 + 5 + 1);
        assert!(e.text.contains("大观园"), "figure text is still searchable");
    }

    #[test]
    fn figures_are_searchable_and_linkable_but_not_counted_as_prose() {
        let doc = json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "One two three." }] },
                { "type": "figure", "attrs": { "kind": "picture", "description": "Aria at dawn" }, "content": [
                    { "type": "image", "attrs": { "assetId": "a" } },
                    { "type": "figcaption", "content": [
                        { "type": "text", "text": "The gate", "marks": [{ "type": "wikiLink", "attrs": { "target": "Silver Gate" } }] }
                    ]}
                ]},
                { "type": "paragraph", "content": [{ "type": "text", "text": "Four." }] }
            ]
        });
        let e = extract(&doc);
        assert_eq!(e.word_count, 4);
        assert_eq!(e.text, "One two three.\nThe gate\nAria at dawn\nFour.");
        assert!(e.links.contains_key("silver gate"));
    }

    #[test]
    fn rewrite_changes_only_matching_targets() {
        let mut doc = sample();
        assert_eq!(rewrite_link_targets(&mut doc, "silver vale", "Argent Vale"), 1);
        assert_eq!(rewrite_link_targets(&mut doc, "no such page", "X"), 0);
        let e = extract(&doc);
        assert!(e.links.contains_key("argent vale"));
        assert!(!e.links.contains_key("silver vale"));
    }
}
