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

/// How a quote is compared with a document. Must match `normalizeQuote` in
/// `src/mcp/apply.ts`. Models often straighten curly quotes and rewrap lines when they
/// quote, and neither should make a quote fail.
pub fn normalize_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        let c = match c {
            '\u{2018}' | '\u{2019}' => '\'',
            '\u{201C}' | '\u{201D}' => '"',
            other => other,
        };
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    out
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

    #[test]
    fn cutting_keeps_characters_whole() {
        assert_eq!(cut("caf\u{e9}", 4), "caf");
        assert_eq!(cut("cafe", 10), "cafe");
    }
}
