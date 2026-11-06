//! Project-wide full-text search over pages and scenes, and find and replace over
//! their stored documents.

use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::{Regex, RegexBuilder};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{pages, parse, revisions, unknown};
use crate::content;
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::indexing::{self, MentionMatcher, KIND_NODE, KIND_PAGE};

/// Turns free text into a safe FTS5 query. Every term is quoted so punctuation
/// cannot be read as query syntax, and the last term matches as a prefix so
/// results appear while typing. A term in Chinese and the like is split as the index
/// is, which makes it a phrase, so it matches anywhere in a run of characters.
pub fn to_fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .map(|t| format!("\"{}\"", indexing::search_index_text(t).replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(format!("{}*", terms.join(" ")))
}

/// How much text a search result shows, in tokens. A character of Chinese is a token, so
/// it takes more of them to show a useful amount. FTS5 allows no more than 64.
const SNIPPET_TOKENS: i64 = 24;
const SNIPPET_TOKENS_UNSPACED: i64 = 64;

// ---------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------

/// A preview stops listing at this many matches, and says so.
const MAX_MATCHES: usize = 5000;
const MAX_PATTERN_CHARS: usize = 2000;
/// The regex crate runs in linear time for a given compiled size, so limiting that
/// size and the matches collected keeps a hostile pattern from hanging the app.
const REGEX_SIZE_LIMIT: usize = 1 << 20;
/// A backstop for huge projects, checked between blocks of text.
const SCAN_TIME_LIMIT: Duration = Duration::from_secs(20);
/// How much surrounding text a preview shows on each side of a match.
const CONTEXT_CHARS: usize = 60;

/// What to look for. Preview and apply must get the same options.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FindOptions {
    find: String,
    replace: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    /// `pages`, `scenes`, or absent for both.
    scope: Option<String>,
}

/// The same as `\w` in a regular expression, which counts a combining accent as part of a word.
fn is_word_char(c: char) -> bool {
    static WORD: OnceLock<Regex> = OnceLock::new();
    let word = WORD.get_or_init(|| Regex::new(r"^\w$").expect("a valid pattern"));
    word.is_match(c.encode_utf8(&mut [0; 4]))
}

/// The regex crate reads `$1st` as a group named "1st", which would quietly become
/// nothing. People mean group 1 followed by "st", so that is what it says here.
fn explicit_group_numbers(replacement: &str) -> String {
    let mut out = String::with_capacity(replacement.len());
    let mut chars = replacement.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if c != '$' {
            continue;
        }
        match chars.peek() {
            Some('$') => {
                out.push('$');
                chars.next();
            }
            Some(d) if d.is_ascii_digit() => {
                out.push('{');
                while let Some(d) = chars.peek().copied().filter(char::is_ascii_digit) {
                    out.push(d);
                    chars.next();
                }
                out.push('}');
            }
            _ => {}
        }
    }
    out
}

struct Finder {
    re: Regex,
    replacement: String,
    /// In regex mode, `$1` in the replacement means a captured group.
    expand: bool,
    /// A literal search that must not be part of a longer word. A regular expression
    /// cannot say this, because Chinese has words with no boundaries between them.
    whole_word_literal: bool,
}

/// Whether a match in `text` stands as a whole word, as names in `MentionMatcher` do.
fn is_whole_word(text: &str, start: usize, end: usize) -> bool {
    let found = &text[start..end];
    let edge = |inner: Option<char>, outer: Option<char>| {
        inner.is_some_and(content::is_unspaced_script)
            || !outer.is_some_and(|c| is_word_char(c) && !content::is_unspaced_script(c))
    };
    edge(found.chars().next(), text[..start].chars().next_back())
        && edge(found.chars().next_back(), text[end..].chars().next())
}

struct Hit {
    start: usize,
    end: usize,
    replacement: String,
}

impl Finder {
    fn new(options: &FindOptions) -> AppResult<Self> {
        if options.find.is_empty() {
            return Err(AppError::invalid("Enter something to find."));
        }
        if options.find.chars().count() > MAX_PATTERN_CHARS {
            return Err(AppError::invalid("That search is too long."));
        }
        let pattern = if options.regex {
            if options.whole_word {
                format!(r"\b(?:{})\b", options.find)
            } else {
                options.find.clone()
            }
        } else {
            regex::escape(&options.find)
        };
        let re = RegexBuilder::new(&pattern)
            .case_insensitive(!options.case_sensitive)
            .multi_line(true)
            .size_limit(REGEX_SIZE_LIMIT)
            .dfa_size_limit(REGEX_SIZE_LIMIT)
            .build()
            .map_err(|e| {
                AppError::invalid(match e {
                    regex::Error::CompiledTooBig(_) => {
                        "That regular expression is too large.".to_string()
                    }
                    other => format!("That regular expression is not valid. {other}"),
                })
            })?;
        Ok(Self {
            re,
            replacement: if options.regex {
                explicit_group_numbers(&options.replace)
            } else {
                options.replace.clone()
            },
            expand: options.regex,
            whole_word_literal: options.whole_word && !options.regex,
        })
    }

    /// Non-overlapping matches, at most `max`. A pattern that can match nothing, such
    /// as `x*`, would otherwise "match" between every pair of letters.
    fn hits(&self, text: &str, max: usize) -> Vec<Hit> {
        let mut hits = Vec::new();
        if self.expand {
            for caps in self.re.captures_iter(text) {
                let whole = caps.get(0).expect("group 0 always exists");
                if whole.is_empty() {
                    continue;
                }
                let mut replacement = String::new();
                caps.expand(&self.replacement, &mut replacement);
                hits.push(Hit {
                    start: whole.start(),
                    end: whole.end(),
                    replacement,
                });
                if hits.len() >= max {
                    break;
                }
            }
        } else {
            let mut from = 0;
            while let Some(found) = self.re.find_at(text, from) {
                if found.is_empty() {
                    break;
                }
                if self.whole_word_literal && !is_whole_word(text, found.start(), found.end()) {
                    // A later match may overlap this one, so look again one character on.
                    from = found.start()
                        + text[found.start()..].chars().next().map_or(1, char::len_utf8);
                    continue;
                }
                from = found.end();
                hits.push(Hit {
                    start: found.start(),
                    end: found.end(),
                    replacement: self.replacement.clone(),
                });
                if hits.len() >= max {
                    break;
                }
            }
        }
        hits
    }
}

// ---------------------------------------------------------------------------
// Walking a ProseMirror document
// ---------------------------------------------------------------------------

/// One match, as a preview shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Found {
    /// Its position among the document's matches, which is how apply refers to it.
    index: usize,
    /// The kind of block it sits in, such as `heading` or `reference`.
    block: String,
    before: String,
    text: String,
    after: String,
    replacement: String,
}

struct Scan<'a> {
    finder: &'a Finder,
    /// The matches to rewrite. `None` only lists them.
    selected: Option<&'a HashSet<usize>>,
    /// Stops once this many matches have been seen in this document.
    budget: usize,
    deadline: Instant,
    next_index: usize,
    found: Vec<Found>,
    rewritten: usize,
    out_of_time: bool,
}

impl<'a> Scan<'a> {
    fn new(
        finder: &'a Finder,
        selected: Option<&'a HashSet<usize>>,
        budget: usize,
        deadline: Instant,
    ) -> Self {
        Self {
            finder,
            selected,
            budget,
            deadline,
            next_index: 0,
            found: Vec::new(),
            rewritten: 0,
            out_of_time: false,
        }
    }

    fn finished(&self) -> bool {
        self.out_of_time || self.next_index >= self.budget
    }

    /// Finds the matches in a stretch of text and returns those to rewrite.
    fn take_hits(&mut self, text: &str, block: &str) -> Vec<Hit> {
        if self.finished() {
            return Vec::new();
        }
        if Instant::now() > self.deadline {
            self.out_of_time = true;
            return Vec::new();
        }
        let mut picked = Vec::new();
        for hit in self.finder.hits(text, self.budget - self.next_index) {
            let index = self.next_index;
            self.next_index += 1;
            match self.selected {
                Some(selected) => {
                    if selected.contains(&index) {
                        self.rewritten += 1;
                        picked.push(hit);
                    }
                }
                None => self.found.push(describe(index, block, text, &hit)),
            }
        }
        picked
    }
}

fn describe(index: usize, block: &str, text: &str, hit: &Hit) -> Found {
    let head = &text[..hit.start];
    let tail = &text[hit.end..];
    let before_start = head
        .char_indices()
        .rev()
        .nth(CONTEXT_CHARS - 1)
        .map_or(0, |(i, _)| i);
    let after_end = tail
        .char_indices()
        .nth(CONTEXT_CHARS)
        .map_or(tail.len(), |(i, _)| i);
    let mut before = head[before_start..].to_string();
    if before_start > 0 {
        before.insert(0, '…');
    }
    let mut after = tail[..after_end].to_string();
    if after_end < tail.len() {
        after.push('…');
    }
    Found {
        index,
        block: block.to_string(),
        before,
        text: shortened(&text[hit.start..hit.end]),
        after,
        replacement: shortened(&hit.replacement),
    }
}

/// A preview only shows a match, and one regex can match a whole chapter. Applying it
/// works the text out again from what is stored, so this loses nothing.
fn shortened(text: &str) -> String {
    let count = text.chars().count();
    if count <= CONTEXT_CHARS * 4 {
        return text.to_string();
    }
    let head: String = text.chars().take(CONTEXT_CHARS * 2).collect();
    let tail: String = text.chars().skip(count - CONTEXT_CHARS * 2).collect();
    format!("{head}…{tail}")
}

fn node_type(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

fn text_of(node: &Value) -> &str {
    node.get("text").and_then(Value::as_str).unwrap_or("")
}

/// A node's marks, treating no marks and an empty list as the same thing.
fn marks_of(node: &Value) -> Option<&Value> {
    node.get("marks")
        .filter(|m| m.as_array().is_some_and(|a| !a.is_empty()))
}

/// Adds text to a list of inline nodes. ProseMirror allows no empty text nodes and
/// keeps neighbours with the same marks as one node, so the output does too.
fn push_piece(out: &mut Vec<Value>, text: &str, marks: Option<&Value>) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut() {
        if marks_of(last) == marks {
            let joined = format!("{}{text}", text_of(last));
            last["text"] = json!(joined);
            return;
        }
    }
    let mut node = json!({ "type": "text", "text": text });
    if let Some(marks) = marks {
        node["marks"] = marks.clone();
    }
    out.push(node);
}

/// Copies part of a run of text nodes, given byte offsets into their joined text.
fn copy_range(run: &[Value], from: usize, to: usize, out: &mut Vec<Value>) {
    let mut start = 0;
    for node in run {
        let text = text_of(node);
        let end = start + text.len();
        let a = from.max(start);
        let b = to.min(end);
        if a < b {
            push_piece(out, &text[a - start..b - start], marks_of(node));
        }
        start = end;
    }
}

fn marks_at(run: &[Value], offset: usize) -> Option<&Value> {
    let mut start = 0;
    for node in run {
        start += text_of(node).len();
        if offset < start {
            return marks_of(node);
        }
    }
    None
}

/// Handles one stretch of adjacent text nodes, so a match may span a change of marks.
/// The replacement takes the marks of the first matched character.
fn scan_run(run: &mut Vec<Value>, out: &mut Vec<Value>, block: &str, scan: &mut Scan) {
    if run.is_empty() {
        return;
    }
    let nodes = std::mem::take(run);
    let joined: String = nodes.iter().map(text_of).collect();
    let picked = scan.take_hits(&joined, block);
    if picked.is_empty() {
        out.extend(nodes);
        return;
    }
    let mut pieces = Vec::with_capacity(nodes.len() + picked.len() * 2);
    let mut pos = 0;
    for hit in &picked {
        copy_range(&nodes, pos, hit.start, &mut pieces);
        push_piece(&mut pieces, &hit.replacement, marks_at(&nodes, hit.start));
        pos = hit.end;
    }
    copy_range(&nodes, pos, joined.len(), &mut pieces);
    out.extend(pieces);
}

/// Handles text that is one plain string. Returns whether it changed.
fn scan_string(text: &mut String, block: &str, scan: &mut Scan) -> bool {
    let picked = scan.take_hits(text, block);
    if picked.is_empty() {
        return false;
    }
    let mut rewritten = String::with_capacity(text.len());
    let mut pos = 0;
    for hit in &picked {
        rewritten.push_str(&text[pos..hit.start]);
        rewritten.push_str(&hit.replacement);
        pos = hit.end;
    }
    rewritten.push_str(&text[pos..]);
    *text = rewritten;
    true
}

/// A citation's text lives in an attribute, not a text node, but readers still see it.
fn scan_reference(node: &mut Value, scan: &mut Scan) {
    let Some(mut text) = node
        .pointer("/attrs/text")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    if scan_string(&mut text, "reference", scan) {
        node["attrs"]["text"] = json!(text);
    }
}

/// The text a reader sees around an article. Revisions keep these too, so a replace
/// stays undoable. Page fields hold link targets, which only a rename changes.
fn scan_page_extras(summary: &mut String, infobox: &mut Value, scan: &mut Scan) {
    scan_string(summary, "summary", scan);
    let Some(fields) = infobox.get_mut("fields").and_then(Value::as_array_mut) else {
        return;
    };
    for field in fields {
        if matches!(field.get("kind").and_then(Value::as_str), Some("page" | "pages")) {
            continue;
        }
        scan_field_text(field, "value", scan);
        // What a field becomes during the story reads the same as its first value.
        if let Some(changes) = field.get_mut("changes").and_then(Value::as_array_mut) {
            for change in changes {
                scan_field_text(change, "value", scan);
                scan_field_text(change, "note", scan);
            }
        }
    }
}

fn scan_field_text(holder: &mut Value, name: &str, scan: &mut Scan) {
    let Some(mut text) = holder.get(name).and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    if scan_string(&mut text, "infobox", scan) {
        holder[name] = json!(text);
    }
}

fn visit(node: &mut Value, scan: &mut Scan) {
    if scan.finished() {
        return;
    }
    let block = node_type(node).to_string();
    let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };
    let has_inline = children
        .iter()
        .any(|c| matches!(node_type(c), "text" | "hardBreak" | "reference"));
    if !has_inline {
        for child in children {
            visit(child, scan);
        }
        return;
    }
    // Anything that is not text ends a run, so no match can reach across a line break.
    let nodes = std::mem::take(children);
    let mut run = Vec::new();
    for mut child in nodes {
        if node_type(&child) == "text" {
            run.push(child);
            continue;
        }
        scan_run(&mut run, children, &block, scan);
        if node_type(&child) == "reference" {
            scan_reference(&mut child, scan);
        }
        children.push(child);
    }
    scan_run(&mut run, children, &block, scan);
    // ProseMirror writes an empty block with no content at all.
    if children.is_empty() {
        if let Some(object) = node.as_object_mut() {
            object.remove("content");
        }
    }
}

// ---------------------------------------------------------------------------
// Preview and apply
// ---------------------------------------------------------------------------

struct Doc {
    kind: &'static str,
    id: String,
    title: String,
    book_id: Option<String>,
    content: String,
    /// Pages only.
    summary: String,
    /// Pages only.
    infobox: String,
}

impl Doc {
    /// Identifies everything a replace can touch, to notice changes after a preview.
    fn hash(&self) -> String {
        revisions::hash(&format!("{}\u{0}{}\u{0}{}", self.content, self.summary, self.infobox))
    }
}

/// Calls `each` for every live document in scope until it returns false.
fn for_each_document(
    conn: &Connection,
    scope: Option<&str>,
    mut each: impl FnMut(Doc) -> AppResult<bool>,
) -> AppResult<()> {
    if scope != Some("scenes") {
        let mut stmt = conn.prepare(
            "SELECT id, title, content, summary, infobox FROM pages
             WHERE deleted_at IS NULL ORDER BY title_key",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let doc = Doc {
                kind: KIND_PAGE,
                id: r.get(0)?,
                title: r.get(1)?,
                book_id: None,
                content: r.get(2)?,
                summary: r.get(3)?,
                infobox: r.get(4)?,
            };
            if !each(doc)? {
                return Ok(());
            }
        }
    }
    if scope != Some("pages") {
        let mut stmt = conn.prepare(
            "SELECT n.id, n.title, n.book_id, n.content FROM nodes n
             JOIN books b ON b.id = n.book_id
             WHERE n.kind = 'scene' AND n.deleted_at IS NULL AND b.deleted_at IS NULL
             ORDER BY b.position, n.parent_id, n.position",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let doc = Doc {
                kind: KIND_NODE,
                id: r.get(0)?,
                title: r.get(1)?,
                book_id: r.get(2)?,
                content: r.get(3)?,
                summary: String::new(),
                infobox: String::new(),
            };
            if !each(doc)? {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn replace_preview(conn: &Connection, options: &FindOptions) -> AppResult<Value> {
    let finder = Finder::new(options)?;
    let deadline = Instant::now() + SCAN_TIME_LIMIT;
    let mut documents = Vec::new();
    let mut total = 0;
    let mut truncated = false;
    for_each_document(conn, options.scope.as_deref(), |doc| {
        let mut parsed = serde_json::from_str::<Value>(&doc.content).unwrap_or(Value::Null);
        let mut scan = Scan::new(&finder, None, MAX_MATCHES - total, deadline);
        visit(&mut parsed, &mut scan);
        if doc.kind == KIND_PAGE {
            let mut summary = doc.summary.clone();
            let mut infobox = serde_json::from_str::<Value>(&doc.infobox).unwrap_or(Value::Null);
            scan_page_extras(&mut summary, &mut infobox, &mut scan);
        }
        if !scan.found.is_empty() {
            total += scan.found.len();
            documents.push(json!({
                "kind": doc.kind,
                "id": doc.id,
                "title": doc.title,
                "bookId": doc.book_id,
                "hash": doc.hash(),
                "matches": scan.found,
            }));
        }
        if scan.out_of_time || total >= MAX_MATCHES {
            truncated = true;
            return Ok(false);
        }
        Ok(true)
    })?;
    Ok(json!({ "documents": documents, "total": total, "truncated": truncated }))
}

/// The matches to replace in one document, as listed by a preview of its `hash`.
#[derive(Debug, Deserialize)]
struct Chosen {
    kind: String,
    id: String,
    hash: String,
    indexes: Vec<usize>,
}

struct Applied {
    replacements: usize,
    /// (kind, id, title)
    documents: Vec<(String, String, String)>,
    /// What undoing it needs, one for each document.
    undo: Vec<revisions::BulkChange>,
}

fn stale() -> AppError {
    AppError::new(
        "STALE_PREVIEW",
        "The text has changed since this preview. Preview again before replacing.",
    )
}

/// Replaces the chosen matches inside the caller's transaction. A document that has
/// changed since the preview fails the whole call, so nothing is replaced by guesswork.
fn apply_replacements(
    conn: &Connection,
    finder: &Finder,
    chosen: &[Chosen],
) -> AppResult<Applied> {
    let deadline = Instant::now() + SCAN_TIME_LIMIT;
    let matcher = MentionMatcher::build(conn)?;
    let mut applied = Applied {
        replacements: 0,
        documents: Vec::new(),
        undo: Vec::new(),
    };
    for choice in chosen {
        let Some(last) = choice.indexes.iter().max() else {
            continue;
        };
        let table = match choice.kind.as_str() {
            KIND_PAGE => "pages",
            KIND_NODE => "nodes",
            other => return Err(AppError::invalid(format!("Unknown entity kind: {other}"))),
        };
        let extras = if choice.kind == KIND_PAGE { "summary, infobox" } else { "'', ''" };
        let stored: Option<Doc> = conn
            .query_row(
                &format!(
                    "SELECT title, content, {extras} FROM {table} WHERE id = ?1 AND deleted_at IS NULL"
                ),
                [&choice.id],
                |r| {
                    Ok(Doc {
                        kind: KIND_PAGE,
                        id: choice.id.clone(),
                        title: r.get(0)?,
                        book_id: None,
                        content: r.get(1)?,
                        summary: r.get(2)?,
                        infobox: r.get(3)?,
                    })
                },
            )
            .optional()?;
        let Some(stored) = stored else {
            return Err(stale());
        };
        if stored.hash() != choice.hash {
            return Err(stale());
        }
        let mut doc = serde_json::from_str::<Value>(&stored.content).unwrap_or(Value::Null);
        let mut summary = stored.summary.clone();
        let mut infobox = serde_json::from_str::<Value>(&stored.infobox).unwrap_or(Value::Null);
        let selected: HashSet<usize> = choice.indexes.iter().copied().collect();
        let mut scan = Scan::new(finder, Some(&selected), last + 1, deadline);
        visit(&mut doc, &mut scan);
        if choice.kind == KIND_PAGE {
            scan_page_extras(&mut summary, &mut infobox, &mut scan);
        }
        if scan.out_of_time {
            return Err(AppError::new(
                "TOO_SLOW",
                "That search took too long to apply, so nothing was changed.",
            ));
        }
        if scan.rewritten == 0 {
            continue;
        }
        let rewritten = scan.rewritten;
        // The revision holds the text as it was, so the whole replace can be undone.
        let revision = revisions::snapshot(conn, &choice.kind, &choice.id, "replace")?;
        let now = db::now();
        if choice.kind == KIND_PAGE {
            conn.execute(
                "UPDATE pages SET content = ?1, summary = ?2, infobox = ?3, updated_at = ?4
                 WHERE id = ?5",
                params![doc.to_string(), summary, infobox.to_string(), now, choice.id],
            )?;
            pages::reindex_page(conn, &matcher, &choice.id)?;
        } else {
            let extracted = content::extract(&doc);
            conn.execute(
                "UPDATE nodes SET content = ?1, content_text = ?2, word_count = ?3, updated_at = ?4
                 WHERE id = ?5",
                params![doc.to_string(), extracted.text, extracted.word_count, now, choice.id],
            )?;
            indexing::sync_with(
                conn,
                &matcher,
                KIND_NODE,
                &choice.id,
                &stored.title,
                &extracted,
                &extracted.text,
            )?;
        }
        applied.replacements += rewritten;
        applied
            .documents
            .push((choice.kind.clone(), choice.id.clone(), stored.title));
        applied.undo.push(revisions::BulkChange {
            kind: choice.kind.clone(),
            id: choice.id.clone(),
            revision_id: revision,
            after: revisions::state_hash(conn, &choice.kind, &choice.id)?,
        });
    }
    Ok(applied)
}

fn applied_json(applied: &Applied) -> Value {
    let documents: Vec<Value> = applied
        .documents
        .iter()
        .map(|(kind, id, title)| json!({ "kind": kind, "id": id, "title": title }))
        .collect();
    json!({ "replacements": applied.replacements, "documents": documents, "undo": applied.undo })
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "query" => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct P {
                q: String,
                /// `page`, `node`, or absent for both.
                kind: Option<String>,
                limit: Option<i64>,
            }
            let p: P = parse(params)?;
            let Some(query) = to_fts_query(&p.q) else {
                return Ok(json!([]));
            };
            let limit = p.limit.unwrap_or(50).clamp(1, 500);
            let snippet_tokens = if p.q.chars().any(content::is_unspaced_script) {
                SNIPPET_TOKENS_UNSPACED
            } else {
                SNIPPET_TOKENS
            };
            engine.read(|c| {
                let mut stmt = c.prepare(
                    "SELECT f.entity_kind, f.entity_id, f.title,
                            snippet(search_fts, 3, char(2), char(3), '…', ?4),
                            n.book_id
                     FROM search_fts f
                     LEFT JOIN nodes n ON f.entity_kind = 'node' AND n.id = f.entity_id
                     WHERE search_fts MATCH ?1 AND (?2 IS NULL OR f.entity_kind = ?2)
                     ORDER BY bm25(search_fts, 0, 0, 10.0, 1.0) LIMIT ?3",
                )?;
                let params = rusqlite::params![query, p.kind, limit, snippet_tokens];
                let rows = stmt.query_map(params, |r| {
                    Ok(json!({
                        "kind": r.get::<_, String>(0)?,
                        "id": r.get::<_, String>(1)?,
                        "title": indexing::search_display_text(&r.get::<_, String>(2)?),
                        // \u{2} and \u{3} mark matches. The UI turns them into
                        // highlights, so the text never needs to be parsed as HTML.
                        "snippet": indexing::search_display_text(&r.get::<_, String>(3)?),
                        "bookId": r.get::<_, Option<String>>(4)?,
                    }))
                })?;
                Ok(Value::Array(rows.collect::<Result<_, _>>()?))
            })
        }
        "replacePreview" => {
            let options: FindOptions = parse(params)?;
            engine.read(|c| replace_preview(c, &options))
        }
        "replaceApply" => {
            #[derive(Deserialize)]
            struct P {
                #[serde(flatten)]
                options: FindOptions,
                documents: Vec<Chosen>,
            }
            let p: P = parse(params)?;
            let finder = Finder::new(&p.options)?;
            let applied = engine.write(|tx| apply_replacements(tx, &finder, &p.documents))?;
            let changed: Vec<(String, String)> = applied
                .documents
                .iter()
                .map(|(kind, id, _)| (kind.clone(), id.clone()))
                .collect();
            if changed.iter().any(|(kind, _)| kind == KIND_PAGE) {
                // A summary may have changed, and hover cards show those.
                engine.notify("pages");
            }
            pages::notify_replaced(engine, &changed);
            Ok(applied_json(&applied))
        }
        // One transaction, so a rename that cannot happen leaves the text alone too.
        "renameEverywhere" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                id: String,
                new_title: String,
                #[serde(default)]
                keep_alias: bool,
                #[serde(flatten)]
                options: FindOptions,
                #[serde(default)]
                documents: Vec<Chosen>,
            }
            let p: P = parse(params)?;
            let finder = Finder::new(&p.options)?;
            let (applied, relinked) = engine.write(|tx| {
                let applied = apply_replacements(tx, &finder, &p.documents)?;
                let relinked = pages::rename_page(tx, &p.id, &p.new_title, true, p.keep_alias)?;
                Ok((applied, relinked))
            })?;
            let mut changed: Vec<(String, String)> = applied
                .documents
                .iter()
                .map(|(kind, id, _)| (kind.clone(), id.clone()))
                .collect();
            for document in &relinked {
                if !changed.contains(document) {
                    changed.push(document.clone());
                }
            }
            engine.notify("pages");
            pages::notify_replaced(engine, &changed);
            let mut result = applied_json(&applied);
            result["documentsChanged"] = json!(changed.len());
            Ok(result)
        }
        _ => Err(unknown(&format!("search.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Engine, TestDir};
    use crate::rpc::{call, dispatch};
    use std::sync::Arc;

    fn project() -> (Arc<Engine>, Arc<crate::engine::TestHost>, TestDir) {
        let (engine, host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        (engine, host, dir)
    }

    fn para(children: Value) -> Value {
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": children }] })
    }

    fn doc(text: &str) -> Value {
        para(json!([{ "type": "text", "text": text }]))
    }

    fn page_with(engine: &Engine, title: &str, content: Value) -> Value {
        let page = call(engine, "pages.create", json!({ "title": title }));
        call(
            engine,
            "pages.update",
            json!({ "id": page["id"], "patch": { "content": content } }),
        );
        page
    }

    fn first_scene(engine: &Engine) -> Value {
        let books = call(engine, "books.list", json!({}));
        let tree = call(engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        tree.as_array()
            .unwrap()
            .iter()
            .find(|n| n["kind"] == "scene")
            .unwrap()
            .clone()
    }

    fn all_of(preview: &Value) -> Value {
        let documents: Vec<Value> = preview["documents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| {
                let indexes: Vec<Value> =
                    d["matches"].as_array().unwrap().iter().map(|m| m["index"].clone()).collect();
                json!({ "kind": d["kind"], "id": d["id"], "hash": d["hash"], "indexes": indexes })
            })
            .collect();
        Value::Array(documents)
    }

    /// Previews and then replaces every match, as the UI does with nothing unticked.
    fn replace_all(engine: &Engine, options: Value) -> (Value, Value) {
        let preview = call(engine, "search.replacePreview", options.clone());
        let mut params = options;
        params["documents"] = all_of(&preview);
        let applied = call(engine, "search.replaceApply", params);
        (preview, applied)
    }

    fn content_of(engine: &Engine, page: &Value) -> Value {
        call(engine, "pages.get", json!({ "id": page["id"] }))["content"].clone()
    }

    #[test]
    fn hostile_input_is_quoted() {
        assert_eq!(to_fts_query("  "), None);
        assert_eq!(to_fts_query("aria"), Some("\"aria\"*".to_string()));
        assert_eq!(
            to_fts_query("a\"b OR NEAR("),
            Some("\"a\"\"b\" \"OR\" \"NEAR(\"*".to_string())
        );
    }

    #[test]
    fn search_finds_titles_and_bodies_and_tolerates_syntax_characters() {
        let (engine, _host, _dir) = project();
        let page = call(&engine, "pages.create", json!({ "title": "Silver Vale" }));
        call(&engine, "pages.update", json!({ "id": page["id"], "patch": { "content": {
            "type": "doc", "content": [{ "type": "paragraph", "content": [
                { "type": "text", "text": "A hidden valley of moonlit rivers." }
            ]}]
        }}}));
        assert_eq!(call(&engine, "search.query", json!({ "q": "silver" }))[0]["title"], "Silver Vale");
        let by_body = call(&engine, "search.query", json!({ "q": "moonl" }));
        assert_eq!(by_body[0]["id"], page["id"]);
        assert!(by_body[0]["snippet"].as_str().unwrap().contains('\u{2}'));
        // Must return nothing rather than a syntax error.
        call(&engine, "search.query", json!({ "q": "\"unterminated AND ( *" }));
    }

    #[test]
    fn search_finds_chinese_inside_a_sentence_and_shows_it_as_written() {
        let (engine, _host, _dir) = project();
        let page = page_with(
            &engine,
            "红楼梦人物",
            doc("那天林黛玉和贾宝玉一起去了大观园，大家都很高兴。"),
        );
        let scene = first_scene(&engine);
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": doc("雪夜里，贾宝玉独自走过大观园。") } }),
        );

        let hits = call(&engine, "search.query", json!({ "q": "林黛玉" }));
        assert_eq!(hits.as_array().unwrap().len(), 1);
        assert_eq!(hits[0]["id"], page["id"]);
        assert_eq!(hits[0]["title"], "红楼梦人物", "a title reads as written");
        assert_eq!(
            hits[0]["snippet"],
            "那天\u{2}林黛玉\u{3}和贾宝玉一起去了大观园，大家都很高兴。"
        );

        // Both documents, wherever in the sentence the word falls.
        let count = |q: &str| call(&engine, "search.query", json!({ "q": q })).as_array().unwrap().len();
        assert_eq!(count("大观园"), 2);
        assert_eq!(count("观"), 2);
        assert_eq!(count("贾宝玉 雪夜"), 1);
        // In the title too.
        assert_eq!(call(&engine, "search.query", json!({ "q": "人物" }))[0]["id"], page["id"]);
        // The characters must be next to each other, in this order.
        assert_eq!(count("玉黛林"), 0);
        // Punctuation in the query does not get in the way.
        assert_eq!(count("大观园，大家"), 1);
    }

    #[test]
    fn search_finds_japanese_korean_and_thai_inside_runs_of_text() {
        let (engine, _host, _dir) = project();
        let japanese = page_with(&engine, "猫", doc("吾輩は猫である。名前はまだ無い。"));
        let korean = page_with(&engine, "학교", doc("나는 학교에 간다."));
        let thai = page_with(&engine, "ภาษา", doc("ภาษาไทยเป็นภาษาที่สวยงาม"));
        let first = |q: &str| call(&engine, "search.query", json!({ "q": q }))[0]["id"].clone();
        assert_eq!(first("名前"), japanese["id"]);
        assert_eq!(first("である"), japanese["id"]);
        assert_eq!(first("학교"), korean["id"]);
        assert_eq!(first("สวยงาม"), thai["id"]);
    }

    #[test]
    fn search_finds_hebrew_and_arabic_with_or_without_vowel_marks() {
        let (engine, _host, _dir) = project();
        let marked = page_with(&engine, "Marked", doc("אמר שָׁלוֹם לכולם. كَتَبَ الْوَلَدُ رسالة."));
        let plain = page_with(&engine, "Plain", doc("מילה אחרת. ذهب الرجل إلى المدينة."));
        let first = |q: &str| call(&engine, "search.query", json!({ "q": q }))[0]["id"].clone();
        assert_eq!(first("שלום"), marked["id"]);
        assert_eq!(first("كتب"), marked["id"]);
        assert_eq!(first("שָׁלוֹם"), marked["id"]);
        assert_eq!(first("ذَهَبَ"), plain["id"]);
    }

    #[test]
    fn search_keeps_working_for_latin_text_beside_chinese() {
        let (engine, _host, _dir) = project();
        let page = page_with(&engine, "Notes", doc("我在2024年去了Paris。Ending words here."));
        let first = |q: &str| call(&engine, "search.query", json!({ "q": q }))[0]["id"].clone();
        assert_eq!(first("paris"), page["id"]);
        assert_eq!(first("2024"), page["id"]);
        assert_eq!(first("ending"), page["id"]);
    }

    #[test]
    fn a_chinese_name_is_a_mention_and_renames_inside_a_sentence() {
        let (engine, _host, _dir) = project();
        let person = page_with(&engine, "林黛玉", doc("一个人物。"));
        let short = page_with(&engine, "李白", doc("诗人。"));
        let scene = first_scene(&engine);
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": doc("那天林黛玉遇见了李白。") } }),
        );
        for page in [&person, &short] {
            let back = call(&engine, "pages.backlinks", json!({ "id": page["id"] }));
            assert_eq!(back["scenes"][0]["id"], scene["id"], "{}", page["title"]);
        }

        // Renaming everywhere uses a whole-word search, and a sentence has no word edges.
        let options = json!({ "find": "林黛玉", "replace": "林妹妹", "wholeWord": true, "caseSensitive": true });
        let preview = call(&engine, "search.replacePreview", options.clone());
        assert_eq!(preview["total"], 1);
        let mut params = options;
        params["id"] = person["id"].clone();
        params["newTitle"] = json!("林妹妹");
        params["documents"] = all_of(&preview);
        assert_eq!(call(&engine, "search.renameEverywhere", params)["replacements"], 1);
        assert_eq!(
            call(&engine, "nodes.get", json!({ "id": scene["id"] }))["content"],
            doc("那天林妹妹遇见了李白。")
        );
    }

    #[test]
    fn whole_word_search_counts_chinese_as_a_word_boundary_for_latin_names() {
        let (engine, _host, _dir) = project();
        page_with(&engine, "Notes", doc("我看到Aria走了，但Ariadne没有。Aria"));
        let total = |options: Value| call(&engine, "search.replacePreview", options)["total"].clone();
        assert_eq!(total(json!({ "find": "Aria", "wholeWord": true })), 2);
        assert_eq!(total(json!({ "find": "Aria" })), 3);
    }

    #[test]
    fn whole_word_search_counts_a_combining_accent_as_part_of_the_word() {
        let (engine, _host, _dir) = project();
        page_with(&engine, "Notes", doc("cafe\u{301} cafe"));
        let preview = call(&engine, "search.replacePreview", json!({ "find": "cafe", "wholeWord": true }));
        assert_eq!(preview["total"], 1);
        assert_eq!(preview["documents"][0]["matches"][0]["after"], "");
    }

    #[test]
    fn whole_word_search_can_match_just_after_a_near_miss() {
        let (engine, _host, _dir) = project();
        page_with(&engine, "Notes", doc("aa a a"));
        let preview = call(&engine, "search.replacePreview", json!({ "find": "a a", "wholeWord": true }));
        assert_eq!(preview["total"], 1);
        assert_eq!(preview["documents"][0]["matches"][0]["before"], "aa ");
    }

    #[test]
    fn stored_word_counts_follow_the_shared_rule() {
        let (engine, _host, _dir) = project();
        let page = page_with(&engine, "Notes", doc("我爱读书。Hello there."));
        assert_eq!(call(&engine, "pages.get", json!({ "id": page["id"] }))["wordCount"], 6);
        let scene = first_scene(&engine);
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": doc("吾輩は猫である") } }),
        );
        assert_eq!(call(&engine, "nodes.get", json!({ "id": scene["id"] }))["wordCount"], 7);
    }

    #[test]
    fn search_covers_aliases_summaries_and_infobox_values() {
        let (engine, _host, _dir) = project();
        let page = call(
            &engine,
            "pages.create",
            json!({
                "title": "Aria",
                "aliases": ["The Quillmaster"],
                "summary": "A wandering cartographer.",
                "infobox": { "fields": [{ "key": "eyes", "label": "Eyes", "kind": "text", "value": "heliotrope" }] },
            }),
        );
        for q in ["quillmaster", "cartographer", "heliotrope"] {
            assert_eq!(call(&engine, "search.query", json!({ "q": q }))[0]["id"], page["id"], "{q}");
        }
        call(
            &engine,
            "pages.update",
            json!({ "id": page["id"], "patch": { "summary": "An oboist." } }),
        );
        assert!(call(&engine, "search.query", json!({ "q": "cartographer" })).as_array().unwrap().is_empty());
        assert_eq!(call(&engine, "search.query", json!({ "q": "oboist" }))[0]["id"], page["id"]);
    }

    #[test]
    fn replaces_text_in_pages_and_scenes_and_recomputes_everything_derived() {
        let (engine, _host, _dir) = project();
        let page = page_with(&engine, "Notes", doc("Aria met Aria at dawn."));
        let scene = first_scene(&engine);
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": doc("Aria drew her bow.") } }),
        );
        let lyra = call(&engine, "pages.create", json!({ "title": "Lyra" }));

        let (preview, applied) =
            replace_all(&engine, json!({ "find": "Aria", "replace": "Lyra Moon" }));
        assert_eq!(preview["total"], 3);
        assert_eq!(preview["documents"].as_array().unwrap().len(), 2);
        let first = &preview["documents"][0]["matches"][0];
        assert_eq!(first["before"], "");
        assert_eq!(first["text"], "Aria");
        assert_eq!(first["after"], " met Aria at dawn.");
        assert_eq!(first["replacement"], "Lyra Moon");
        assert_eq!(applied["replacements"], 3);
        assert_eq!(applied["documents"].as_array().unwrap().len(), 2);

        assert_eq!(content_of(&engine, &page), doc("Lyra Moon met Lyra Moon at dawn."));
        let page_now = call(&engine, "pages.get", json!({ "id": page["id"] }));
        assert_eq!(page_now["wordCount"], 7);
        let scene_now = call(&engine, "nodes.get", json!({ "id": scene["id"] }));
        assert_eq!(scene_now["content"], doc("Lyra Moon drew her bow."));
        assert_eq!(scene_now["wordCount"], 5);

        // Search and name detection follow the new text.
        assert!(call(&engine, "search.query", json!({ "q": "Aria" })).as_array().unwrap().is_empty());
        assert!(call(&engine, "search.query", json!({ "q": "dawn" })).as_array().unwrap().len() == 1);
        let back = call(&engine, "pages.backlinks", json!({ "id": lyra["id"] }));
        assert_eq!(back["scenes"][0]["id"], scene["id"]);
    }

    #[test]
    fn each_changed_document_gets_a_checkpoint_holding_the_old_text() {
        let (engine, _host, _dir) = project();
        let page = page_with(&engine, "Notes", doc("old words here"));
        let scene = first_scene(&engine);
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": doc("old scene") } }),
        );
        replace_all(&engine, json!({ "find": "old", "replace": "new" }));
        for (kind, id, expected) in [
            ("page", &page["id"], "old words here"),
            ("node", &scene["id"], "old scene"),
        ] {
            let list = call(&engine, "revisions.list", json!({ "kind": kind, "id": id }));
            assert_eq!(list[0]["reason"], "replace", "{kind}");
            let saved = call(&engine, "revisions.get", json!({ "id": list[0]["id"] }));
            assert_eq!(saved["content"], doc(expected), "{kind}");
        }
    }

    #[test]
    fn a_replace_can_be_undone_except_where_the_text_was_edited_since() {
        let (engine, _host, _dir) = project();
        let page = page_with(&engine, "Notes", doc("old words here"));
        let other = page_with(&engine, "Other", doc("old again"));
        let scene = first_scene(&engine);
        call(&engine, "nodes.update", json!({ "id": scene["id"], "patch": { "content": doc("old scene") } }));
        let (_, applied) = replace_all(&engine, json!({ "find": "old", "replace": "new" }));
        assert_eq!(applied["undo"].as_array().unwrap().len(), 3);
        // Someone keeps writing in one of them.
        call(&engine, "pages.update", json!({ "id": other["id"], "patch": { "content": doc("new again, and more") } }));

        let undone = call(&engine, "revisions.undo", json!({ "changes": applied["undo"] }));
        assert_eq!(undone["restored"], 2);
        assert_eq!(undone["kept"][0]["title"], "Other");
        assert_eq!(content_of(&engine, &page), doc("old words here"));
        assert_eq!(call(&engine, "nodes.get", json!({ "id": scene["id"] }))["content"], doc("old scene"));
        assert_eq!(content_of(&engine, &other), doc("new again, and more"), "newer writing is not lost");
        // The replaced text is in the history, so the undo can be undone too.
        let list = call(&engine, "revisions.list", json!({ "kind": "page", "id": page["id"] }));
        assert_eq!(list[0]["reason"], "undo");
        let saved = call(&engine, "revisions.get", json!({ "id": list[0]["id"] }));
        assert_eq!(saved["content"], doc("new words here"));
        assert_eq!(call(&engine, "search.query", json!({ "q": "old" })).as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_match_can_span_marks_and_the_replacement_keeps_the_first_characters_marks() {
        let (engine, _host, _dir) = project();
        let bold = json!([{ "type": "bold" }]);
        let italic = json!([{ "type": "italic" }]);
        let page = page_with(
            &engine,
            "Notes",
            para(json!([
                { "type": "text", "text": "Say " },
                { "type": "text", "text": "Ar", "marks": bold },
                { "type": "text", "text": "ia", "marks": italic },
                { "type": "text", "text": " twice", "marks": italic },
            ])),
        );
        let (preview, _) = replace_all(&engine, json!({ "find": "Aria", "replace": "Lyra" }));
        assert_eq!(preview["total"], 1);
        assert_eq!(preview["documents"][0]["matches"][0]["text"], "Aria");
        assert_eq!(
            content_of(&engine, &page),
            para(json!([
                { "type": "text", "text": "Say " },
                { "type": "text", "text": "Lyra", "marks": bold },
                { "type": "text", "text": " twice", "marks": italic },
            ]))
        );
    }

    #[test]
    fn replacing_inside_a_link_keeps_the_link_and_its_target() {
        let (engine, _host, _dir) = project();
        let link = json!([{ "type": "wikiLink", "attrs": { "target": "Aria Vale" } }]);
        let page = page_with(
            &engine,
            "Notes",
            para(json!([{ "type": "text", "text": "the Aria of old", "marks": link }])),
        );
        replace_all(&engine, json!({ "find": "Aria", "replace": "Lyra" }));
        let content = content_of(&engine, &page);
        assert_eq!(
            content,
            para(json!([{ "type": "text", "text": "the Lyra of old", "marks": link }]))
        );
        assert_eq!(call(&engine, "pages.wanted", json!({}))[0]["title"], "Aria Vale");
    }

    #[test]
    fn neighbours_with_the_same_marks_become_one_node_and_empty_nodes_disappear() {
        let (engine, _host, _dir) = project();
        let bold = json!([{ "type": "bold" }]);
        let page = page_with(
            &engine,
            "Notes",
            para(json!([
                { "type": "text", "text": "keep " },
                { "type": "text", "text": "gone", "marks": bold },
                { "type": "text", "text": " this" },
            ])),
        );
        replace_all(&engine, json!({ "find": "gone", "replace": "" }));
        assert_eq!(content_of(&engine, &page), doc("keep  this"));
        // Replacing all of a paragraph with nothing leaves a valid empty paragraph.
        let page = page_with(&engine, "Other", doc("zzz"));
        replace_all(&engine, json!({ "find": "zzz", "replace": "" }));
        assert_eq!(
            content_of(&engine, &page),
            json!({ "type": "doc", "content": [{ "type": "paragraph" }] })
        );
    }

    #[test]
    fn a_line_break_ends_a_run_and_citations_are_searched() {
        let (engine, _host, _dir) = project();
        let page = page_with(
            &engine,
            "Notes",
            para(json!([
                { "type": "text", "text": "Silver" },
                { "type": "hardBreak" },
                { "type": "text", "text": "Vale" },
                { "type": "reference", "attrs": { "text": "See Silver Vale, p. 1" } },
            ])),
        );
        let preview = call(&engine, "search.replacePreview", json!({ "find": "SilverVale" }));
        assert_eq!(preview["total"], 0);
        let (preview, _) =
            replace_all(&engine, json!({ "find": "Silver Vale", "replace": "Argent Vale" }));
        assert_eq!(preview["total"], 1);
        assert_eq!(preview["documents"][0]["matches"][0]["block"], "reference");
        assert_eq!(
            content_of(&engine, &page)["content"][0]["content"][3]["attrs"]["text"],
            "See Argent Vale, p. 1"
        );
    }

    #[test]
    fn case_whole_word_and_regex_options() {
        let (engine, _host, _dir) = project();
        page_with(&engine, "Notes", doc("Ana ana banana C++ C++x 2024-01-15 Анна"));
        let count = |options: Value| call(&engine, "search.replacePreview", options)["total"].clone();

        assert_eq!(count(json!({ "find": "ana" })), 3);
        assert_eq!(count(json!({ "find": "ana", "caseSensitive": true })), 2);
        assert_eq!(count(json!({ "find": "ana", "wholeWord": true })), 2);
        assert_eq!(count(json!({ "find": "ana", "wholeWord": true, "caseSensitive": true })), 1);
        // Punctuation at the edge of a whole word must not stop it matching.
        assert_eq!(count(json!({ "find": "C++", "wholeWord": true })), 1);
        // A literal search does not treat these as syntax.
        assert_eq!(count(json!({ "find": "C+" })), 2);
        assert_eq!(count(json!({ "find": r"C\+\+", "regex": true })), 2);
        assert_eq!(count(json!({ "find": r"\d{4}", "regex": true })), 1);
        assert_eq!(count(json!({ "find": "анна", "wholeWord": true })), 1, "not only ASCII");
    }

    #[test]
    fn regex_replacements_can_use_captured_groups() {
        let (engine, _host, _dir) = project();
        let page = page_with(&engine, "Notes", doc("Born 2024-01-15 and C$5"));
        replace_all(
            &engine,
            json!({ "find": r"(\d+)-(\d+)-(\d+)", "replace": "$3/$2/${1}y", "regex": true }),
        );
        assert_eq!(content_of(&engine, &page), doc("Born 15/01/2024y and C$5"));
        // Outside regex mode, a dollar sign is only a dollar sign.
        replace_all(&engine, json!({ "find": "C$5", "replace": "$1" }));
        assert_eq!(content_of(&engine, &page), doc("Born 15/01/2024y and $1"));
        // A group number can run straight into text, and $$ is a dollar sign.
        replace_all(
            &engine,
            json!({ "find": r"(B)orn (\d+)", "replace": "$1rought $$$2th", "regex": true }),
        );
        assert_eq!(content_of(&engine, &page), doc("Brought $15th/01/2024y and $1"));
    }

    #[test]
    fn what_a_field_becomes_during_the_story_is_replaced_too() {
        let (engine, _host, _dir) = project();
        let page = call(
            &engine,
            "pages.create",
            json!({
                "title": "Story",
                "infobox": { "fields": [
                    { "key": "tutor", "label": "Tutor", "kind": "text", "value": "Morn", "changes": [
                        { "nodeId": "n", "value": "Aria", "note": "Aria takes over" },
                    ]},
                    { "key": "parents", "label": "Parents", "kind": "pages", "value": "Morn", "changes": [
                        { "date": "312", "value": "Aria" },
                    ]},
                ]},
            }),
        );
        let (_, applied) = replace_all(&engine, json!({ "find": "Aria", "replace": "Lyra" }));
        assert_eq!(applied["replacements"], 2);
        let stored = call(&engine, "pages.get", json!({ "id": page["id"] }));
        let change = &stored["infobox"]["fields"][0]["changes"][0];
        assert_eq!(change["value"], "Lyra");
        assert_eq!(change["note"], "Lyra takes over");
        assert_eq!(change["nodeId"], "n");
        assert_eq!(stored["infobox"]["fields"][1]["changes"][0]["value"], "Aria", "a link target is left alone");
    }

    #[test]
    fn summaries_and_infobox_text_are_replaced_but_not_link_fields() {
        let (engine, _host, _dir) = project();
        let page = call(
            &engine,
            "pages.create",
            json!({
                "title": "Story",
                "summary": "Daughter of Aria.",
                "content": doc("Aria spoke."),
                "infobox": { "fields": [
                    { "key": "note", "label": "Note", "kind": "longtext", "value": "Raised by Aria" },
                    { "key": "parents", "label": "Parents", "kind": "pages", "value": "Aria, Morn" },
                ]},
            }),
        );
        let (preview, applied) = replace_all(&engine, json!({ "find": "Aria", "replace": "Lyra" }));
        let story = preview["documents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == page["id"])
            .unwrap();
        let blocks: Vec<&str> = story["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["block"].as_str().unwrap())
            .collect();
        assert_eq!(blocks, vec!["paragraph", "summary", "infobox"]);
        assert_eq!(applied["replacements"], 3);

        let stored = call(&engine, "pages.get", json!({ "id": page["id"] }));
        assert_eq!(stored["summary"], "Daughter of Lyra.");
        assert_eq!(stored["infobox"]["fields"][0]["value"], "Raised by Lyra");
        assert_eq!(stored["infobox"]["fields"][1]["value"], "Aria, Morn", "a link target is left alone");
        assert_eq!(call(&engine, "search.query", json!({ "q": "daughter" }))[0]["id"], page["id"]);

        // The summary and infobox come back with an undo.
        let list = call(&engine, "revisions.list", json!({ "kind": "page", "id": page["id"] }));
        call(&engine, "revisions.restore", json!({ "id": list[0]["id"] }));
        let stored = call(&engine, "pages.get", json!({ "id": page["id"] }));
        assert_eq!(stored["summary"], "Daughter of Aria.");
        assert_eq!(stored["infobox"]["fields"][0]["value"], "Raised by Aria");
    }

    #[test]
    fn a_summary_changed_since_the_preview_counts_as_stale() {
        let (engine, _host, _dir) = project();
        let page = page_with(&engine, "Notes", doc("cat"));
        let options = json!({ "find": "cat", "replace": "dog" });
        let preview = call(&engine, "search.replacePreview", options.clone());
        call(&engine, "pages.update", json!({ "id": page["id"], "patch": { "summary": "A cat." } }));
        let mut params = options;
        params["documents"] = all_of(&preview);
        let err = dispatch(&engine, "search.replaceApply", params).unwrap_err();
        assert_eq!(err.code, "STALE_PREVIEW");
    }

    #[test]
    fn unticked_matches_stay_as_they_are() {
        let (engine, _host, _dir) = project();
        let page = page_with(&engine, "Notes", doc("cat cat cat"));
        let other = page_with(&engine, "Other", doc("cat"));
        let options = json!({ "find": "cat", "replace": "dog" });
        let preview = call(&engine, "search.replacePreview", options.clone());
        let notes = preview["documents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == page["id"])
            .unwrap();
        let mut params = options;
        params["documents"] = json!([
            { "kind": "page", "id": notes["id"], "hash": notes["hash"], "indexes": [0, 2] },
        ]);
        let applied = call(&engine, "search.replaceApply", params);
        assert_eq!(applied["replacements"], 2);
        assert_eq!(content_of(&engine, &page), doc("dog cat dog"));
        assert_eq!(content_of(&engine, &other), doc("cat"), "a document left out is not touched");
    }

    #[test]
    fn text_changed_since_the_preview_fails_the_whole_replace() {
        let (engine, _host, _dir) = project();
        let first = page_with(&engine, "First", doc("cat"));
        let second = page_with(&engine, "Second", doc("cat"));
        let options = json!({ "find": "cat", "replace": "dog" });
        let preview = call(&engine, "search.replacePreview", options.clone());
        call(
            &engine,
            "pages.update",
            json!({ "id": second["id"], "patch": { "content": doc("a new cat") } }),
        );
        let mut params = options;
        params["documents"] = all_of(&preview);
        let err = dispatch(&engine, "search.replaceApply", params).unwrap_err();
        assert_eq!(err.code, "STALE_PREVIEW");
        assert_eq!(content_of(&engine, &first), doc("cat"), "rolled back");
        assert_eq!(content_of(&engine, &second), doc("a new cat"));
    }

    #[test]
    fn scope_and_trash_limit_what_is_searched() {
        let (engine, _host, _dir) = project();
        page_with(&engine, "Live", doc("needle"));
        let trashed = page_with(&engine, "Gone", doc("needle"));
        call(&engine, "pages.delete", json!({ "id": trashed["id"] }));
        let scene = first_scene(&engine);
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": doc("needle") } }),
        );
        let total = |options: Value| call(&engine, "search.replacePreview", options)["total"].clone();
        assert_eq!(total(json!({ "find": "needle" })), 2);
        assert_eq!(total(json!({ "find": "needle", "scope": "pages" })), 1);
        assert_eq!(total(json!({ "find": "needle", "scope": "scenes" })), 1);

        let books = call(&engine, "books.list", json!({}));
        call(&engine, "books.delete", json!({ "id": books[0]["id"] }));
        assert_eq!(total(json!({ "find": "needle", "scope": "scenes" })), 0);
    }

    #[test]
    fn bad_patterns_are_refused_and_bad_ones_cannot_hang() {
        let (engine, _host, _dir) = project();
        let long = "a".repeat(200_000);
        page_with(&engine, "Big", doc(&long));

        let err = dispatch(&engine, "search.replacePreview", json!({ "find": "(", "regex": true })).unwrap_err();
        assert_eq!(err.code, "INVALID");
        let err = dispatch(&engine, "search.replacePreview", json!({ "find": "" })).unwrap_err();
        assert_eq!(err.code, "INVALID");
        // Compiles to far more than the size limit.
        let err = dispatch(
            &engine,
            "search.replacePreview",
            json!({ "find": "((a{100}){100}){100}", "regex": true }),
        )
        .unwrap_err();
        assert_eq!(err.code, "INVALID");

        // The classic backtracking killer finishes, because this engine does not backtrack.
        let start = Instant::now();
        let preview = call(&engine, "search.replacePreview", json!({ "find": "(a+)+$", "regex": true }));
        assert_eq!(preview["total"], 1);
        assert!(start.elapsed() < Duration::from_secs(30));
    }

    #[test]
    fn patterns_that_match_nothing_or_everything_are_handled() {
        let (engine, _host, _dir) = project();
        let page = page_with(&engine, "Big", doc(&"ab ".repeat(4000)));

        // Matches nothing at every position: not a match at all.
        let preview = call(&engine, "search.replacePreview", json!({ "find": "ж*", "regex": true }));
        assert_eq!(preview["total"], 0);

        // More matches than a preview lists: stops at the cap and says so.
        let preview = call(&engine, "search.replacePreview", json!({ "find": ".", "regex": true }));
        assert_eq!(preview["total"], MAX_MATCHES);
        assert_eq!(preview["truncated"], true);

        // Applying that preview changes exactly what it listed.
        let mut params = json!({ "find": ".", "replace": "Z", "regex": true });
        params["documents"] = all_of(&preview);
        let applied = call(&engine, "search.replaceApply", params);
        assert_eq!(applied["replacements"], MAX_MATCHES);
        let text = content_of(&engine, &page)["content"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(text.chars().filter(|c| *c == 'Z').count(), MAX_MATCHES);
        assert_eq!(text.len(), 12000);
    }

    #[test]
    fn preview_context_is_cut_on_character_boundaries() {
        let (engine, _host, _dir) = project();
        let text = format!("{}needle{}", "é".repeat(100), "ü".repeat(100));
        page_with(&engine, "Notes", doc(&text));
        let preview = call(&engine, "search.replacePreview", json!({ "find": "needle" }));
        let m = &preview["documents"][0]["matches"][0];
        assert_eq!(m["before"], format!("…{}", "é".repeat(CONTEXT_CHARS)));
        assert_eq!(m["after"], format!("{}…", "ü".repeat(CONTEXT_CHARS)));
    }

    #[test]
    fn a_preview_shortens_a_huge_match_but_applying_replaces_all_of_it() {
        let (engine, _host, _dir) = project();
        let long = "word ".repeat(2000);
        let page = page_with(&engine, "Notes", doc(&format!("<{long}>")));
        let options = json!({ "find": "<.*>", "replace": "short", "regex": true });
        let preview = call(&engine, "search.replacePreview", options.clone());
        let shown = preview["documents"][0]["matches"][0]["text"].as_str().unwrap();
        assert!(shown.chars().count() < 500);
        assert!(shown.contains('…'));
        let mut params = options;
        params["documents"] = all_of(&preview);
        call(&engine, "search.replaceApply", params);
        assert_eq!(content_of(&engine, &page), doc("short"));
    }

    #[test]
    fn replacing_tells_open_editors_to_reload() {
        let (engine, host, _dir) = project();
        let page = page_with(&engine, "Notes", doc("cat"));
        let scene = first_scene(&engine);
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": doc("cat") } }),
        );
        host.events.lock().unwrap().clear();
        replace_all(&engine, json!({ "find": "cat", "replace": "dog" }));
        let events = host.events.lock().unwrap();
        let has = |entity: String| events.iter().any(|(_, p)| p["entity"] == entity.as_str());
        assert!(has(format!("doc:page:{}", page["id"].as_str().unwrap())));
        assert!(has(format!("doc:node:{}", scene["id"].as_str().unwrap())));
        assert!(has("pageContent".to_string()));
        assert!(has("nodeContent".to_string()));
    }

    #[test]
    fn rename_everywhere_renames_relinks_and_replaces_in_one_step() {
        let (engine, _host, _dir) = project();
        let aria = page_with(&engine, "Aria", doc("Aria is the hero."));
        let link = json!([{ "type": "wikiLink", "attrs": { "target": "Aria" } }]);
        let notes = page_with(
            &engine,
            "Notes",
            para(json!([
                { "type": "text", "text": "Aria", "marks": link },
                { "type": "text", "text": " met Ariadne." },
            ])),
        );
        let options = json!({ "find": "Aria", "replace": "Lyra", "wholeWord": true, "caseSensitive": true });
        let preview = call(&engine, "search.replacePreview", options.clone());
        assert_eq!(preview["total"], 2, "not Ariadne");

        let mut params = options;
        params["id"] = aria["id"].clone();
        params["newTitle"] = json!("Lyra");
        params["documents"] = all_of(&preview);
        let result = call(&engine, "search.renameEverywhere", params);
        assert_eq!(result["replacements"], 2);
        assert_eq!(result["documentsChanged"], 2);

        let page = call(&engine, "pages.get", json!({ "id": aria["id"] }));
        assert_eq!(page["title"], "Lyra");
        assert!(page["aliases"].as_array().unwrap().is_empty(), "no alias unless asked");
        assert_eq!(page["content"], doc("Lyra is the hero."));
        let link = json!([{ "type": "wikiLink", "attrs": { "target": "Lyra" } }]);
        assert_eq!(
            content_of(&engine, &notes),
            para(json!([
                { "type": "text", "text": "Lyra", "marks": link },
                { "type": "text", "text": " met Ariadne." },
            ]))
        );
        assert!(call(&engine, "pages.wanted", json!({})).as_array().unwrap().is_empty());
    }

    #[test]
    fn a_rename_that_fails_leaves_the_text_unchanged_too() {
        let (engine, _host, _dir) = project();
        let aria = page_with(&engine, "Aria", doc("Aria is the hero."));
        call(&engine, "pages.create", json!({ "title": "Lyra" }));
        let options = json!({ "find": "Aria", "replace": "Lyra", "wholeWord": true });
        let preview = call(&engine, "search.replacePreview", options.clone());
        let mut params = options;
        params["id"] = aria["id"].clone();
        params["newTitle"] = json!("Lyra");
        params["documents"] = all_of(&preview);
        let err = dispatch(&engine, "search.renameEverywhere", params).unwrap_err();
        assert_eq!(err.code, "TITLE_EXISTS");
        assert_eq!(content_of(&engine, &aria), doc("Aria is the hero."));
    }
}
