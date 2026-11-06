//! Bulk import. One normalized payload, one transaction: a failure leaves the project
//! exactly as it was. `preview` runs the same code and rolls it back, so what it reports
//! cannot drift from what `apply` does.
//!
//! The UI turns files into this payload (Markdown into ProseMirror and so on), see
//! `src/exporters/import/`. The file format people write is in docs/IMPORT_FORMAT.md.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::manuscript::{self, CreateNode, NODE_STATUSES};
use super::media::{self, AssetBody, Sniffed, WholeAsset};
use super::pages::{self, CreateInput, STATUSES};
use super::{canvas, ok, revisions, unknown};
use crate::content::{self, title_key};
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::indexing::{self, KIND_NODE, KIND_PAGE};

/// Everything that can be stored in a document. Must match `src/editor/schema.ts`.
const NODE_TYPES: [&str; 20] = [
    "doc",
    "paragraph",
    "text",
    "heading",
    "blockquote",
    "bulletList",
    "orderedList",
    "listItem",
    "codeBlock",
    "horizontalRule",
    "hardBreak",
    "image",
    "video",
    "figure",
    "figcaption",
    "table",
    "tableRow",
    "tableHeader",
    "tableCell",
    "reference",
];
const MARK_TYPES: [&str; 7] = [
    "bold", "italic", "underline", "strike", "code", "link", "wikiLink",
];
const FIELD_KINDS: [&str; 6] = ["text", "longtext", "date", "number", "page", "pages"];

/// Meta keys that describe this project rather than its content. The version keys matter
/// most: a newer version's minimum reader version, copied in, would make this version refuse
/// the project after its next save.
const RESERVED_META: [&str; 7] = [
    "app",
    "project_id",
    "name",
    "created_at",
    "min_reader_version",
    "written_by_version",
    "names_stamp",
];

/// Meta a project keeps about its own scenes, by id, which mean nothing in another project.
fn reserved_meta(key: &str) -> bool {
    RESERVED_META.contains(&key) || manuscript::SCENE_META_PREFIXES.iter().any(|p| key.starts_with(p))
}

const STARTER_PAGE_TITLE: &str = "Main Page";
const STARTER_BOOK_TITLE: &str = "Book One";

#[derive(Debug, Clone, Copy, PartialEq)]
enum Policy {
    Skip,
    Rename,
    Overwrite,
}

/// Something wrong with one item. An error refuses the whole import. A warning does
/// not: that one reference or value is dropped and the rest goes ahead.
#[derive(Debug, Clone, Serialize)]
struct Problem {
    severity: &'static str,
    item: String,
    field: String,
    message: String,
}

/// What happens to one page or book.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemOutcome {
    kind: &'static str,
    source: String,
    title: String,
    /// create, rename, overwrite, skip, or for a book also extend.
    action: &'static str,
    final_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    /// How many chapters and scenes a book brings. Zero for pages.
    chapters: usize,
    scenes: usize,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    pages_created: usize,
    pages_renamed: usize,
    pages_overwritten: usize,
    pages_skipped: usize,
    books_created: usize,
    books_renamed: usize,
    books_overwritten: usize,
    books_skipped: usize,
    books_extended: usize,
    nodes_created: usize,
    nodes_updated: usize,
    nodes_removed: usize,
    assets_created: usize,
    assets_reused: usize,
    relationships_created: usize,
    relationships_skipped: usize,
    maps_created: usize,
    maps_overwritten: usize,
    maps_skipped: usize,
    dictionary_added: usize,
    prompts_created: usize,
    canvases_created: usize,
    canvases_overwritten: usize,
    canvases_skipped: usize,
    threads_created: usize,
    revisions_taken: usize,
}

#[derive(Debug, Default, Serialize)]
struct Report {
    applied: bool,
    counts: Counts,
    items: Vec<ItemOutcome>,
    problems: Vec<Problem>,
    notes: Vec<String>,
    /// What `revisions.undo` needs to take the import back.
    undo: UndoPlan,
}

/// The pages and scenes an import overwrote, what it made, and the scenes it put in the trash.
#[derive(Debug, Default, Serialize)]
struct UndoPlan {
    changes: Vec<revisions::BulkChange>,
    created: Vec<revisions::BulkItem>,
    removed: Vec<revisions::BulkItem>,
    /// Everything made, including what is inside something made, which is not listed.
    #[serde(skip)]
    made_ids: HashSet<String>,
}

// ---------------------------------------------------------------------------
// Reading the payload. Nothing is written until all of it has been read, and every
// problem names the item and the field.
// ---------------------------------------------------------------------------

struct PageItem {
    label: String,
    local_id: Option<String>,
    title: String,
    page_type: Option<String>,
    status: Option<String>,
    summary: Option<String>,
    aliases: Option<Vec<String>>,
    categories: Option<Vec<String>>,
    infobox: Option<Value>,
    content: Option<Value>,
    notes: Option<Value>,
    is_home: bool,
    reveal_node: Option<String>,
    /// Marks the page local only. False leaves it as it is.
    local_only: bool,
    created_at: Option<String>,
    updated_at: Option<String>,
}

struct NodeItem {
    label: String,
    local_id: Option<String>,
    kind: String,
    title: String,
    status: Option<String>,
    synopsis: Option<String>,
    notes: Option<String>,
    story_date: Option<String>,
    target_words: Option<i64>,
    pov: Option<String>,
    /// A page title or alias, like `pov`.
    location: Option<String>,
    /// Page titles or aliases. Absent leaves an existing scene's cast alone.
    cast: Option<Vec<String>>,
    /// Thread ids from the file, or names. Absent leaves an existing scene's threads alone.
    threads: Option<Vec<String>>,
    content: Option<Value>,
    /// Marks the node local only. False leaves it as it is.
    local_only: bool,
    created_at: Option<String>,
    updated_at: Option<String>,
    children: Vec<NodeItem>,
}

struct ThreadItem {
    local_id: Option<String>,
    name: String,
    color: Option<String>,
    description: Option<String>,
    position: Option<i64>,
}

struct WritingDay {
    day: String,
    words_added: i64,
    words_removed: i64,
}

struct BookItem {
    label: String,
    title: String,
    subtitle: Option<String>,
    author: Option<String>,
    target_words: Option<i64>,
    created_at: Option<String>,
    updated_at: Option<String>,
    /// Cover, series, ISBN, front and back matter. `BookPublishing` in src/lib/types.ts.
    publishing: Option<Value>,
    /// Set to add these children to an existing book instead of making a new one.
    into_book: Option<String>,
    into_parent: Option<String>,
    writing_log: Vec<WritingDay>,
    children: Vec<NodeItem>,
}

struct RelationshipItem {
    label: String,
    from: String,
    to: String,
    kind: String,
    note: String,
    created_at: Option<String>,
}

struct AssetItem {
    key: String,
    name: String,
    found: Sniffed,
    body: AssetBody,
    width: Option<i64>,
    height: Option<i64>,
    created_at: Option<String>,
}

struct PinItem {
    page: Option<String>,
    label: String,
    x: f64,
    y: f64,
    created_at: Option<String>,
}

struct MapItem {
    label: String,
    title: String,
    asset: Option<String>,
    pins: Vec<PinItem>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

struct PromptItem {
    name: String,
    description: String,
    template: String,
    scope: String,
    position: i64,
}

struct CanvasItem {
    title: String,
    data: Value,
    created_at: Option<String>,
    updated_at: Option<String>,
}

struct Prepared {
    policy: Policy,
    pages: Vec<PageItem>,
    threads: Vec<ThreadItem>,
    books: Vec<BookItem>,
    relationships: Vec<RelationshipItem>,
    assets: Vec<AssetItem>,
    maps: Vec<MapItem>,
    dictionary: Vec<String>,
    prompts: Vec<PromptItem>,
    canvases: Vec<CanvasItem>,
    meta: Vec<(String, String)>,
    problems: Vec<Problem>,
}

/// One item's fields. Anything of the wrong type is recorded as a problem.
struct Item<'v, 'p> {
    label: String,
    fields: &'v Map<String, Value>,
    problems: &'p mut Vec<Problem>,
}

impl<'v, 'p> Item<'v, 'p> {
    fn new(label: String, value: &'v Value, problems: &'p mut Vec<Problem>) -> Option<Self> {
        match value.as_object() {
            Some(fields) => Some(Self { label, fields, problems }),
            None => {
                problems.push(Problem {
                    severity: "error",
                    item: label,
                    field: String::new(),
                    message: "must be an object".to_string(),
                });
                None
            }
        }
    }

    fn report(&mut self, severity: &'static str, field: &str, message: impl Into<String>) {
        self.problems.push(Problem {
            severity,
            item: self.label.clone(),
            field: field.to_string(),
            message: message.into(),
        });
    }

    fn error(&mut self, field: &str, message: impl Into<String>) {
        self.report("error", field, message);
    }

    fn warn(&mut self, field: &str, message: impl Into<String>) {
        self.report("warning", field, message);
    }

    fn value(&self, field: &str) -> Option<&'v Value> {
        self.fields.get(field).filter(|v| !v.is_null())
    }

    fn string(&mut self, field: &str) -> Option<String> {
        match self.value(field) {
            None => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => {
                self.error(field, "must be text");
                None
            }
        }
    }

    fn strings(&mut self, field: &str) -> Option<Vec<String>> {
        match self.value(field) {
            None => None,
            Some(Value::Array(items)) => {
                let mut out = Vec::with_capacity(items.len());
                for (i, value) in items.iter().enumerate() {
                    match value.as_str() {
                        Some(s) => out.push(s.to_string()),
                        None => self.error(&format!("{field}[{i}]"), "must be text"),
                    }
                }
                Some(out)
            }
            Some(_) => {
                self.error(field, "must be a list of text");
                None
            }
        }
    }

    fn integer(&mut self, field: &str) -> Option<i64> {
        let value = self.value(field)?;
        let number = value.as_i64();
        if number.is_none() {
            self.error(field, "must be a whole number");
        }
        number
    }

    fn boolean(&mut self, field: &str) -> bool {
        match self.value(field) {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => {
                self.error(field, "must be true or false");
                false
            }
        }
    }

    /// `localOnly`: whether to mark this as never going to a cloud AI. An import can set
    /// the mark but never clears it, since clearing it by mistake would send private text
    /// to a cloud provider. The writer removes it in the app.
    fn local_only(&mut self) -> bool {
        self.boolean("localOnly")
    }

    /// A bad time is not worth refusing an import over, so it only warns.
    fn timestamp(&mut self, field: &str) -> Option<String> {
        let text = self.string(field)?;
        if chrono::DateTime::parse_from_rfc3339(&text).is_ok() {
            Some(text)
        } else {
            self.warn(field, format!("\"{text}\" is not an RFC 3339 time, so it was ignored"));
            None
        }
    }

    fn doc(&mut self, field: &str) -> Option<Value> {
        let value = self.value(field)?;
        match check_doc(value) {
            Ok(()) => Some(value.clone()),
            Err(message) => {
                self.error(field, message);
                None
            }
        }
    }

    fn list(&mut self, field: &str) -> &'v [Value] {
        match self.value(field) {
            None => &[],
            Some(Value::Array(items)) => items,
            Some(_) => {
                self.error(field, "must be a list");
                &[]
            }
        }
    }
}

fn check_doc(doc: &Value) -> Result<(), String> {
    if doc.get("type").and_then(Value::as_str) != Some("doc") {
        return Err("must be a ProseMirror document with type \"doc\"".to_string());
    }
    check_node(doc)
}

fn check_node(node: &Value) -> Result<(), String> {
    let object = node.as_object().ok_or("every node must be an object")?;
    let node_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or("every node needs a type")?;
    if !NODE_TYPES.contains(&node_type) {
        return Err(format!("has an unknown node type \"{node_type}\""));
    }
    if node_type == "text" && !object.get("text").is_some_and(Value::is_string) {
        return Err("has a text node with no text".to_string());
    }
    if let Some(marks) = object.get("marks") {
        let marks = marks.as_array().ok_or("marks must be a list")?;
        for mark in marks {
            let mark_type = mark
                .get("type")
                .and_then(Value::as_str)
                .ok_or("every mark needs a type")?;
            if !MARK_TYPES.contains(&mark_type) {
                return Err(format!("has an unknown mark type \"{mark_type}\""));
            }
        }
    }
    if let Some(children) = object.get("content") {
        let children = children.as_array().ok_or("content must be a list")?;
        for child in children {
            check_node(child)?;
        }
    }
    Ok(())
}

fn clean_name(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `source` is where the item came from, when the UI knows, such as a file in a folder.
fn label_for(value: &Value, fallback: String) -> String {
    let source = value.get("source").and_then(Value::as_str).unwrap_or("");
    let title = value.get("title").and_then(Value::as_str).unwrap_or("");
    match (source.is_empty(), title.is_empty()) {
        (false, _) => source.to_string(),
        (true, false) => format!("{fallback} \"{title}\""),
        (true, true) => fallback,
    }
}

fn read_infobox(item: &mut Item) -> Option<Value> {
    let value = item.value("infobox")?;
    let Some(object) = value.as_object() else {
        item.error("infobox", "must be an object");
        return None;
    };
    // Anything else stored in an infobox comes through, so that nothing is lost by a round
    // trip if the wiki adds to it later.
    let mut out = object.clone();
    for name in ["imageAssetId", "caption"] {
        match object.get(name) {
            None | Some(Value::String(_)) => {}
            Some(Value::Null) => {
                out.remove(name);
            }
            Some(_) => {
                out.remove(name);
                item.error(&format!("infobox.{name}"), "must be text");
            }
        }
    }
    let mut fields = Vec::new();
    match object.get("fields") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            for (i, field) in list.iter().enumerate() {
                let at = format!("infobox.fields[{i}]");
                let Some(field) = field.as_object() else {
                    item.error(&at, "must be an object");
                    continue;
                };
                let key = field.get("key").and_then(Value::as_str).unwrap_or("").trim();
                if key.is_empty() {
                    item.error(&format!("{at}.key"), "is required");
                    continue;
                }
                let text = match field.get("value") {
                    None | Some(Value::Null) => String::new(),
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Number(n)) => n.to_string(),
                    Some(Value::Bool(b)) => b.to_string(),
                    Some(_) => {
                        item.error(&format!("{at}.value"), "must be text");
                        continue;
                    }
                };
                let kind = field.get("kind").and_then(Value::as_str).unwrap_or("text");
                if !FIELD_KINDS.contains(&kind) {
                    item.error(
                        &format!("{at}.kind"),
                        format!("\"{kind}\" is not one of {}", FIELD_KINDS.join(", ")),
                    );
                    continue;
                }
                let label = field.get("label").and_then(Value::as_str).unwrap_or(key).to_string();
                let mut kept = field.clone();
                kept.insert("key".to_string(), json!(key));
                kept.insert("label".to_string(), json!(label));
                kept.insert("kind".to_string(), json!(kind));
                kept.insert("value".to_string(), json!(text));
                fields.push(Value::Object(kept));
            }
        }
        Some(_) => item.error("infobox.fields", "must be a list"),
    }
    out.insert("fields".to_string(), Value::Array(fields));
    Some(Value::Object(out))
}

fn read_pages(root: &Map<String, Value>, problems: &mut Vec<Problem>) -> Vec<PageItem> {
    let mut out = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    let list = root.get("pages").and_then(Value::as_array);
    for (index, value) in list.into_iter().flatten().enumerate() {
        let label = label_for(value, format!("pages[{index}]"));
        let Some(mut item) = Item::new(label, value, problems) else {
            continue;
        };
        let before = item.problems.len();
        let title = clean_name(&item.string("title").unwrap_or_default());
        if title.is_empty() {
            item.error("title", "is required");
            continue;
        }
        let key = title_key(&title);
        if let Some(first) = seen.get(&key) {
            let message = format!("is the same title as {first}");
            item.error("title", message);
            continue;
        }
        let status = item.string("status");
        if let Some(status) = &status {
            if !STATUSES.contains(&status.as_str()) {
                let message = format!("\"{status}\" is not one of {}", STATUSES.join(", "));
                item.error("status", message);
            }
        }
        let page = PageItem {
            local_id: item.string("id"),
            page_type: item.string("pageType"),
            status,
            summary: item.string("summary"),
            aliases: item.strings("aliases"),
            categories: item.strings("categories"),
            infobox: read_infobox(&mut item),
            content: item.doc("content"),
            notes: item.doc("notes"),
            is_home: item.boolean("isHome"),
            reveal_node: item.string("revealNodeId"),
            local_only: item.local_only(),
            created_at: item.timestamp("createdAt"),
            updated_at: item.timestamp("updatedAt"),
            label: item.label.clone(),
            title,
        };
        let failed = item.problems[before..].iter().any(|p| p.severity == "error");
        seen.insert(key, page.label.clone());
        if !failed {
            out.push(page);
        }
    }
    out
}

fn placement_allowed(parent_kind: Option<&str>, kind: &str) -> bool {
    match kind {
        "part" => parent_kind.is_none(),
        "chapter" => matches!(parent_kind, None | Some("part")),
        "scene" => parent_kind == Some("chapter"),
        _ => false,
    }
}

/// `any_parent` is for children going into an existing node. The database knows what
/// that node is, so `create_node` checks the placement when it runs.
fn read_nodes(
    item: &mut Item,
    path: &str,
    parent_kind: Option<&str>,
    any_parent: bool,
    list: &[Value],
) -> Vec<NodeItem> {
    let mut out = Vec::with_capacity(list.len());
    for (index, value) in list.iter().enumerate() {
        let at = format!("{path}[{index}]");
        let Some(fields) = value.as_object() else {
            item.error(&at, "must be an object");
            continue;
        };
        let before = item.problems.len();
        let book_label = item.label.clone();
        let mut child = Item {
            label: label_for(value, format!("{book_label} {at}")),
            fields,
            problems: &mut *item.problems,
        };
        let kind = child.string("kind").unwrap_or_default();
        if !["part", "chapter", "scene"].contains(&kind.as_str()) {
            let message = format!("\"{kind}\" is not one of part, chapter, scene");
            child.error("kind", message);
            continue;
        }
        if !any_parent && !placement_allowed(parent_kind, &kind) {
            let inside = parent_kind.map_or("the top level of a book".to_string(), |k| format!("a {k}"));
            child.error("kind", format!("a {kind} cannot go inside {inside}"));
            continue;
        }
        let status = child.string("status");
        if let Some(status) = &status {
            if !NODE_STATUSES.contains(&status.as_str()) {
                let message = format!("\"{status}\" is not one of {}", NODE_STATUSES.join(", "));
                child.error("status", message);
            }
        }
        let content = child.doc("content");
        if content.is_some() && kind != "scene" {
            child.error("content", format!("only scenes hold text, and this is a {kind}"));
        }
        let child_list = child.list("children");
        if kind == "scene" && !child_list.is_empty() {
            child.error("children", "a scene cannot contain anything");
        }
        let mut node = NodeItem {
            label: child.label.clone(),
            local_id: child.string("id"),
            title: child.string("title").unwrap_or_default(),
            status,
            synopsis: child.string("synopsis"),
            notes: child.string("notes"),
            story_date: child.string("storyDate"),
            target_words: child.integer("targetWords"),
            pov: child.string("pov"),
            location: child.string("location"),
            cast: child.strings("cast"),
            threads: child.strings("threads"),
            content,
            local_only: child.local_only(),
            created_at: child.timestamp("createdAt"),
            updated_at: child.timestamp("updatedAt"),
            kind: kind.clone(),
            children: Vec::new(),
        };
        let failed = child.problems[before..].iter().any(|p| p.severity == "error");
        if kind != "scene" {
            let child_path = format!("{at}.children");
            node.children = read_nodes(item, &child_path, Some(&kind), false, child_list);
        }
        if !failed {
            out.push(node);
        }
    }
    out
}

fn read_books(root: &Map<String, Value>, problems: &mut Vec<Problem>) -> Vec<BookItem> {
    let mut out = Vec::new();
    let list = root.get("books").and_then(Value::as_array);
    for (index, value) in list.into_iter().flatten().enumerate() {
        let label = label_for(value, format!("books[{index}]"));
        let Some(mut item) = Item::new(label, value, problems) else {
            continue;
        };
        let into_book = item.string("intoBookId");
        let title = clean_name(&item.string("title").unwrap_or_default());
        if title.is_empty() && into_book.is_none() {
            item.error("title", "is required");
            continue;
        }
        let into_parent = item.string("intoParentId");
        let children = item.list("children");
        let nodes = read_nodes(&mut item, "children", None, into_parent.is_some(), children);
        let mut writing_log = Vec::new();
        for (i, day) in item.list("writingLog").iter().enumerate() {
            let Some(day_text) = day.get("day").and_then(Value::as_str) else {
                item.error(&format!("writingLog[{i}].day"), "is required");
                continue;
            };
            writing_log.push(WritingDay {
                day: day_text.to_string(),
                words_added: day.get("wordsAdded").and_then(Value::as_i64).unwrap_or(0),
                words_removed: day.get("wordsRemoved").and_then(Value::as_i64).unwrap_or(0),
            });
        }
        let publishing = value.get("publishing").filter(|v| !v.is_null()).cloned();
        if publishing.as_ref().is_some_and(|v| !v.is_object()) {
            item.error("publishing", "must be an object");
            continue;
        }
        out.push(BookItem {
            subtitle: item.string("subtitle"),
            author: item.string("author"),
            target_words: item.integer("targetWords"),
            publishing,
            created_at: item.timestamp("createdAt"),
            updated_at: item.timestamp("updatedAt"),
            label: item.label.clone(),
            title,
            into_book,
            into_parent,
            writing_log,
            children: nodes,
        });
    }
    out
}

fn read_relationships(root: &Map<String, Value>, problems: &mut Vec<Problem>) -> Vec<RelationshipItem> {
    let mut out = Vec::new();
    let list = root.get("relationships").and_then(Value::as_array);
    for (index, value) in list.into_iter().flatten().enumerate() {
        let label = format!("relationships[{index}]");
        let Some(mut item) = Item::new(label, value, problems) else {
            continue;
        };
        let from = item.string("from").unwrap_or_default();
        let to = item.string("to").unwrap_or_default();
        if from.trim().is_empty() {
            item.error("from", "is required");
        }
        if to.trim().is_empty() {
            item.error("to", "is required");
        }
        out.push(RelationshipItem {
            kind: item.string("kind").unwrap_or_else(|| "related".to_string()),
            note: item.string("note").unwrap_or_default(),
            created_at: item.timestamp("createdAt"),
            label: item.label.clone(),
            from,
            to,
        });
    }
    out
}

fn read_asset_body(engine: &Engine, item: &mut Item) -> Option<AssetBody> {
    if let Some(text) = item.string("base64") {
        return match base64::engine::general_purpose::STANDARD.decode(text.as_bytes()) {
            Ok(bytes) => Some(AssetBody::Bytes(bytes)),
            Err(e) => {
                item.error("base64", format!("is not valid base64: {e}"));
                None
            }
        };
    }
    let Some(path) = item.string("path") else {
        item.error("base64", "is required");
        return None;
    };
    let path = PathBuf::from(path);
    if let Err(e) = engine.check_allowed(&path) {
        item.error("path", e.message);
        return None;
    }
    if let Err(e) = std::fs::metadata(&path) {
        item.error("path", format!("could not be read: {e}"));
        return None;
    }
    Some(AssetBody::File(path))
}

fn read_assets(engine: &Engine, root: &Map<String, Value>, problems: &mut Vec<Problem>) -> Vec<AssetItem> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let list = root.get("assets").and_then(Value::as_array);
    for (index, value) in list.into_iter().flatten().enumerate() {
        let label = match value.get("name").and_then(Value::as_str) {
            Some(name) => format!("assets[{index}] \"{name}\""),
            None => format!("assets[{index}]"),
        };
        let Some(mut item) = Item::new(label, value, problems) else {
            continue;
        };
        let key = item.string("id").unwrap_or_default();
        if key.is_empty() {
            item.error("id", "is required");
            continue;
        }
        if !seen.insert(key.clone()) {
            let message = format!("\"{key}\" is used by another asset");
            item.error("id", message);
            continue;
        }
        let mime = item.string("mime").unwrap_or_default();
        // SVG is refused, as everywhere: it can carry scripts.
        if !media::accepts_type(&mime) {
            item.error("mime", format!("\"{mime}\" is not one of {}", media::accepted_types()));
            continue;
        }
        let Some(body) = read_asset_body(engine, &mut item) else {
            continue;
        };
        let found = match media::check_body(&mime, &body) {
            Ok(found) => found,
            Err(why) => {
                item.warn("", format!("{why}, so it was left out"));
                continue;
            }
        };
        out.push(AssetItem {
            name: item.string("name").unwrap_or_else(|| key.clone()),
            width: item.integer("width"),
            height: item.integer("height"),
            created_at: item.timestamp("createdAt"),
            key,
            found,
            body,
        });
    }
    out
}

fn read_maps(root: &Map<String, Value>, problems: &mut Vec<Problem>) -> Vec<MapItem> {
    let mut out = Vec::new();
    let list = root.get("maps").and_then(Value::as_array);
    for (index, value) in list.into_iter().flatten().enumerate() {
        let label = label_for(value, format!("maps[{index}]"));
        let Some(mut item) = Item::new(label, value, problems) else {
            continue;
        };
        let title = clean_name(&item.string("title").unwrap_or_default());
        if title.is_empty() {
            item.error("title", "is required");
            continue;
        }
        let mut pins = Vec::new();
        for (i, pin) in item.list("pins").iter().enumerate() {
            let x = pin.get("x").and_then(Value::as_f64);
            let y = pin.get("y").and_then(Value::as_f64);
            let (Some(x), Some(y)) = (x, y) else {
                item.error(&format!("pins[{i}]"), "needs x and y between 0 and 1");
                continue;
            };
            if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
                item.error(&format!("pins[{i}]"), "needs x and y between 0 and 1");
                continue;
            }
            pins.push(PinItem {
                page: pin.get("page").and_then(Value::as_str).map(str::to_string),
                label: pin.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
                x,
                y,
                created_at: pin.get("createdAt").and_then(Value::as_str).map(str::to_string),
            });
        }
        out.push(MapItem {
            asset: item.string("assetId"),
            created_at: item.timestamp("createdAt"),
            updated_at: item.timestamp("updatedAt"),
            label: item.label.clone(),
            title,
            pins,
        });
    }
    out
}

fn read_threads(root: &Map<String, Value>, problems: &mut Vec<Problem>) -> Vec<ThreadItem> {
    let mut out = Vec::new();
    let list = root.get("threads").and_then(Value::as_array);
    for (index, value) in list.into_iter().flatten().enumerate() {
        let label = label_for(value, format!("threads[{index}]"));
        let Some(mut item) = Item::new(label, value, problems) else {
            continue;
        };
        let name = item.string("name").unwrap_or_default().trim().to_string();
        if name.is_empty() {
            item.error("name", "is required");
            continue;
        }
        out.push(ThreadItem {
            local_id: item.string("id"),
            color: item.string("color"),
            description: item.string("description"),
            position: item.integer("position"),
            name,
        });
    }
    out
}

fn read_prompts(root: &Map<String, Value>, problems: &mut Vec<Problem>) -> Vec<PromptItem> {
    let mut out = Vec::new();
    let list = root.get("prompts").and_then(Value::as_array);
    for (index, value) in list.into_iter().flatten().enumerate() {
        let label = format!("prompts[{index}]");
        let Some(mut item) = Item::new(label, value, problems) else {
            continue;
        };
        let name = item.string("name").unwrap_or_default();
        let template = item.string("template").unwrap_or_default();
        if name.trim().is_empty() {
            item.error("name", "is required");
        }
        if template.is_empty() {
            item.error("template", "is required");
        }
        out.push(PromptItem {
            description: item.string("description").unwrap_or_default(),
            scope: item.string("scope").unwrap_or_else(|| "selection".to_string()),
            position: item.integer("position").unwrap_or(0),
            name,
            template,
        });
    }
    out
}

/// Canvases from a project export. An export from before canvases has none.
fn read_canvases(root: &Map<String, Value>, problems: &mut Vec<Problem>) -> Vec<CanvasItem> {
    let mut out = Vec::new();
    let list = root.get("canvases").and_then(Value::as_array);
    for (index, value) in list.into_iter().flatten().enumerate() {
        let label = label_for(value, format!("canvases[{index}]"));
        let Some(mut item) = Item::new(label, value, problems) else {
            continue;
        };
        let title = clean_name(&item.string("title").unwrap_or_default());
        if title.is_empty() {
            item.error("title", "is required");
            continue;
        }
        let data = item.value("data").cloned().unwrap_or_else(canvas::empty_data);
        if let Err(e) = canvas::check_data(&data) {
            item.error("data", e.message);
            continue;
        }
        out.push(CanvasItem {
            created_at: item.timestamp("createdAt"),
            updated_at: item.timestamp("updatedAt"),
            title,
            data,
        });
    }
    out
}

fn prepare(engine: &Engine, params: &Value) -> AppResult<Prepared> {
    let Some(root) = params.as_object() else {
        return Err(AppError::invalid("The import payload must be an object."));
    };
    let policy = match root.get("policy").and_then(Value::as_str).unwrap_or("skip") {
        "skip" => Policy::Skip,
        "rename" => Policy::Rename,
        "overwrite" => Policy::Overwrite,
        other => {
            return Err(AppError::invalid(format!(
                "\"{other}\" is not a conflict policy. Use skip, rename or overwrite."
            )))
        }
    };
    let mut problems = Vec::new();
    for field in ["pages", "books", "relationships", "assets", "maps", "prompts", "dictionary", "threads", "canvases"] {
        if root.get(field).is_some_and(|v| !v.is_array() && !v.is_null()) {
            problems.push(Problem {
                severity: "error",
                item: "the import".to_string(),
                field: field.to_string(),
                message: "must be a list".to_string(),
            });
        }
    }
    let pages = read_pages(root, &mut problems);
    let threads = read_threads(root, &mut problems);
    let books = read_books(root, &mut problems);
    let relationships = read_relationships(root, &mut problems);
    let assets = read_assets(engine, root, &mut problems);
    let maps = read_maps(root, &mut problems);
    let prompts = read_prompts(root, &mut problems);
    let canvases = read_canvases(root, &mut problems);
    let dictionary = root
        .get("dictionary")
        .and_then(Value::as_array)
        .map(|words| words.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let meta = root
        .get("meta")
        .and_then(Value::as_object)
        .map(|meta| {
            meta.iter()
                .filter(|(key, _)| !reserved_meta(key))
                .filter_map(|(key, value)| value.as_str().map(|v| (key.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Ok(Prepared {
        policy,
        pages,
        threads,
        books,
        relationships,
        assets,
        maps,
        dictionary,
        prompts,
        canvases,
        meta,
        problems,
    })
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

/// Whether an infobox has a fact that changes at a scene, which it names by id.
fn names_scenes(infobox: &Value) -> bool {
    let fields = infobox.get("fields").and_then(Value::as_array);
    fields.into_iter().flatten().any(|field| {
        let changes = field.get("changes").and_then(Value::as_array);
        changes.into_iter().flatten().any(|change| change.get("nodeId").is_some_and(Value::is_string))
    })
}

/// The first free "Name (2)", "Name (3)" and so on, which is then taken.
fn free_name(taken: &mut HashSet<String>, name: &str) -> String {
    let mut n = 2;
    loop {
        let candidate = format!("{name} ({n})");
        if taken.insert(title_key(&candidate)) {
            return candidate;
        }
        n += 1;
    }
}

fn string_set(conn: &Connection, sql: &str) -> AppResult<HashSet<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Points links and images in a document at their final targets.
fn rewrite_doc(
    node: &mut Value,
    links: &HashMap<String, String>,
    assets: &HashMap<String, String>,
    missing_assets: &mut Vec<String>,
) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    if matches!(object.get("type").and_then(Value::as_str), Some("image" | "video")) {
        if let Some(attrs) = object.get_mut("attrs").and_then(Value::as_object_mut) {
            let current = attrs.get("assetId").and_then(Value::as_str).map(str::to_string);
            if let Some(current) = current {
                match assets.get(&current) {
                    Some(real) => {
                        attrs.insert("assetId".to_string(), json!(real));
                    }
                    None => missing_assets.push(current),
                }
            }
        }
    }
    if !links.is_empty() {
        if let Some(marks) = object.get_mut("marks").and_then(Value::as_array_mut) {
            for mark in marks {
                if mark.get("type").and_then(Value::as_str) != Some("wikiLink") {
                    continue;
                }
                let key = mark
                    .pointer("/attrs/target")
                    .and_then(Value::as_str)
                    .map(title_key)
                    .unwrap_or_default();
                if let Some(title) = links.get(&key) {
                    mark["attrs"]["target"] = json!(title);
                }
            }
        }
    }
    if let Some(children) = object.get_mut("content").and_then(Value::as_array_mut) {
        for child in children {
            rewrite_doc(child, links, assets, missing_assets);
        }
    }
}

/// The page every new project starts with, if it still says what it started out saying.
/// The text is what counts: showing a page can save it again with no change in wording.
fn untouched_starter_page(conn: &Connection) -> AppResult<Option<String>> {
    let page: Option<(String, String)> = conn
        .query_row(
            "SELECT id, content_text FROM pages WHERE is_home = 1 AND deleted_at IS NULL AND title = ?1",
            [STARTER_PAGE_TITLE],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((id, text)) = page else {
        return Ok(None);
    };
    let name: String = conn
        .query_row("SELECT value FROM meta WHERE key = 'name'", [], |r| r.get(0))
        .optional()?
        .unwrap_or_default();
    let starter = content::extract(&pages::seed_home_doc(&name));
    Ok((text == starter.text).then_some(id))
}

/// The empty book every new project starts with, if it is still the only book and
/// nobody has touched it.
fn untouched_starter_book(conn: &Connection) -> AppResult<Option<String>> {
    let live_books: i64 = conn.query_row(
        "SELECT COUNT(*) FROM books WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )?;
    if live_books != 1 {
        return Ok(None);
    }
    let book: Option<String> = conn
        .query_row(
            "SELECT id FROM books WHERE deleted_at IS NULL AND title = ?1
               AND created_at = updated_at",
            [STARTER_BOOK_TITLE],
            |r| r.get(0),
        )
        .optional()?;
    let Some(book) = book else {
        return Ok(None);
    };
    let (nodes, untouched): (i64, i64) = conn.query_row(
        "SELECT COUNT(*),
                SUM(word_count = 0
                    AND ((kind = 'chapter' AND title = 'Chapter 1')
                         OR (kind = 'scene' AND title = 'Scene 1')))
         FROM nodes WHERE book_id = ?1",
        [&book],
        |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
    )?;
    Ok((nodes == 2 && untouched == 2).then_some(book))
}

fn remove_starter_page(conn: &Connection, id: &str) -> AppResult<()> {
    indexing::remove_entity(conn, KIND_PAGE, id)?;
    conn.execute(
        "DELETE FROM revisions WHERE entity_kind = 'page' AND entity_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM pages WHERE id = ?1", [id])?;
    Ok(())
}

fn remove_starter_book(conn: &Connection, id: &str) -> AppResult<()> {
    let nodes: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM nodes WHERE book_id = ?1")?;
        let rows = stmt.query_map([id], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for node in &nodes {
        indexing::remove_entity(conn, KIND_NODE, node)?;
        conn.execute(
            "DELETE FROM revisions WHERE entity_kind = 'node' AND entity_id = ?1",
            [node],
        )?;
    }
    conn.execute("DELETE FROM writing_log WHERE book_id = ?1", [id])?;
    conn.execute("DELETE FROM books WHERE id = ?1", [id])?;
    Ok(())
}

fn count_nodes(nodes: &[NodeItem]) -> (usize, usize) {
    let mut chapters = 0;
    let mut scenes = 0;
    for node in nodes {
        match node.kind.as_str() {
            "chapter" => chapters += 1,
            "scene" => scenes += 1,
            _ => {}
        }
        let (c, s) = count_nodes(&node.children);
        chapters += c;
        scenes += s;
    }
    (chapters, scenes)
}

/// Everything one run needs as it goes.
struct Run<'a> {
    conn: &'a Connection,
    policy: Policy,
    dry_run: bool,
    report: Report,
    /// In-file ids, title keys and alias keys of imported pages -> real page id.
    page_refs: HashMap<String, String>,
    /// In-file id -> real node id.
    node_refs: HashMap<String, String>,
    /// In-file id, or the key of a name -> real thread id.
    thread_refs: HashMap<String, String>,
    /// Titles changed by the rename policy: old title key -> final title.
    renamed: HashMap<String, String>,
    /// Asset key in the file, or the id of one already in the project -> real id.
    asset_refs: HashMap<String, String>,
    /// (item label, page id, node reference). Spoiler settings wait for the books.
    pending_reveals: Vec<(String, String, String)>,
    /// (item label, page id) of pages whose infobox has facts that change at a scene.
    pending_changes: Vec<(String, String)>,
}

impl Run<'_> {
    fn warn(&mut self, item: &str, field: &str, message: impl Into<String>) {
        self.report.problems.push(Problem {
            severity: "warning",
            item: item.to_string(),
            field: field.to_string(),
            message: message.into(),
        });
    }

    fn finish_doc(&mut self, doc: &mut Value, item: &str, field: &str) {
        let mut missing = Vec::new();
        rewrite_doc(doc, &self.renamed, &self.asset_refs, &mut missing);
        missing.sort();
        missing.dedup();
        for id in missing {
            self.warn(item, field, format!("a picture or video refers to an asset that does not exist: {id}"));
        }
    }

    /// Infobox pictures and page references follow the same changes as documents.
    fn finish_infobox(&mut self, infobox: &mut Value, item: &str) {
        let image = infobox.get("imageAssetId").and_then(Value::as_str).map(str::to_string);
        if let Some(image) = image {
            match self.asset_refs.get(&image) {
                Some(real) => infobox["imageAssetId"] = json!(real),
                None => self.warn(
                    item,
                    "infobox.imageAssetId",
                    format!("refers to an asset that does not exist: {image}"),
                ),
            }
        }
        if self.renamed.is_empty() {
            return;
        }
        if let Some(fields) = infobox.get_mut("fields").and_then(Value::as_array_mut) {
            for field in fields {
                let kind = field.get("kind").and_then(Value::as_str).unwrap_or("");
                if kind != "page" && kind != "pages" {
                    continue;
                }
                let renamed = &self.renamed;
                let rename = |holder: &mut Value| {
                    let value = holder.get("value").and_then(Value::as_str).unwrap_or("");
                    let names: Vec<String> = value
                        .split(',')
                        .map(|name| {
                            let name = name.trim();
                            renamed.get(&title_key(name)).cloned().unwrap_or_else(|| name.to_string())
                        })
                        .collect();
                    holder["value"] = json!(names.join(", "));
                };
                rename(field);
                if let Some(changes) = field.get_mut("changes").and_then(Value::as_array_mut) {
                    changes.iter_mut().for_each(rename);
                }
            }
        }
    }

    /// A page named in the file: an in-file id, then a title or alias from the file,
    /// then anything already in the project.
    fn resolve_page(&self, name: &str) -> AppResult<Option<String>> {
        if let Some(id) = self.page_refs.get(name) {
            return Ok(Some(id.clone()));
        }
        if let Some(id) = self.page_refs.get(&title_key(name)) {
            return Ok(Some(id.clone()));
        }
        pages::resolve_title(self.conn, name)
    }

    fn take_checkpoint(&mut self, kind: &str, id: &str) -> AppResult<()> {
        if revisions::checkpoint(self.conn, kind, id, "import")?.is_some() {
            self.report.counts.revisions_taken += 1;
        }
        // The revision that holds it as it was, for undoing the import. The state it ends in
        // is added once the whole import is written. A second write keeps the first.
        if self.report.undo.changes.iter().any(|c| c.kind == kind && c.id == id) {
            return Ok(());
        }
        let revision = revisions::snapshot(self.conn, kind, id, "import")?;
        self.report.undo.changes.push(revisions::BulkChange {
            kind: kind.to_string(),
            id: id.to_string(),
            revision_id: revision,
            after: None,
        });
        Ok(())
    }

    /// Notes something the import made, for undoing it. A node inside something the import
    /// also made goes to the trash with it, so only the outermost is listed.
    fn made(&mut self, kind: &str, id: &str) {
        self.report.undo.made_ids.insert(id.to_string());
        self.report.undo.created.push(revisions::BulkItem {
            kind: kind.to_string(),
            id: id.to_string(),
        });
    }

    /// The state each overwritten document ended in, so undo can tell if it was edited since.
    fn finish_undo(&mut self) -> AppResult<()> {
        for change in &mut self.report.undo.changes {
            change.after = revisions::state_hash(self.conn, &change.kind, &change.id)?;
        }
        Ok(())
    }

    fn write_assets(&mut self, assets: &[AssetItem]) -> AppResult<()> {
        // Documents may point at images already in the project.
        for id in string_set(self.conn, "SELECT id FROM assets WHERE complete = 1")? {
            self.asset_refs.insert(id.clone(), id);
        }
        for asset in assets {
            let sha256 = asset.body.sha256()?;
            if let Some(id) = media::identical_asset(self.conn, &sha256)? {
                self.asset_refs.insert(asset.key.clone(), id);
                self.report.counts.assets_reused += 1;
                continue;
            }
            // Keeping the key as the id means documents need no change. A key already
            // in use here belongs to some other image.
            let id = if self.asset_refs.contains_key(&asset.key) {
                db::new_id()
            } else {
                asset.key.clone()
            };
            media::store_whole(
                self.conn,
                &WholeAsset {
                    id: &id,
                    name: &asset.name,
                    found: asset.found,
                    sha256: &sha256,
                    width: asset.width,
                    height: asset.height,
                    created_at: &asset.created_at.clone().unwrap_or_else(db::now),
                },
                &asset.body,
                // A preview needs the row for references, and rolls back anyway.
                !self.dry_run,
            )?;
            self.asset_refs.insert(asset.key.clone(), id);
            self.report.counts.assets_created += 1;
        }
        Ok(())
    }

    /// Which imported page becomes the main page, if any. A project that is still as
    /// it was created has nothing worth keeping on its front page, so an imported front
    /// page simply takes over.
    fn settle_home(&mut self, items: &[PageItem]) -> AppResult<Option<usize>> {
        let first_home = items.iter().position(|p| p.is_home);
        for extra in items.iter().filter(|p| p.is_home).skip(1) {
            let label = extra.label.clone();
            self.warn(&label, "isHome", "Only one page can be the main page, so this stays an ordinary page.");
        }
        if let Some(starter) = untouched_starter_page(self.conn)? {
            let starter_key = title_key(STARTER_PAGE_TITLE);
            let taker = first_home.or_else(|| items.iter().position(|p| title_key(&p.title) == starter_key));
            if taker.is_some() {
                remove_starter_page(self.conn, &starter)?;
                self.report
                    .notes
                    .push("The imported main page takes the place of the empty starter page.".to_string());
            }
            return Ok(taker);
        }
        if let Some(index) = first_home {
            let home_key: Option<String> = self
                .conn
                .query_row(
                    "SELECT title_key FROM pages WHERE is_home = 1 AND deleted_at IS NULL",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            if home_key.as_deref() != Some(title_key(&items[index].title).as_str()) {
                let label = items[index].label.clone();
                self.warn(&label, "isHome", "This project already has a main page, so this stays an ordinary page.");
            }
        }
        Ok(None)
    }

    fn create_page(&mut self, item: &mut PageItem, title: &str) -> AppResult<String> {
        let mut content = item.content.take();
        if let Some(doc) = &mut content {
            self.finish_doc(doc, &item.label, "content");
        }
        let mut notes = item.notes.take();
        if let Some(doc) = &mut notes {
            self.finish_doc(doc, &item.label, "notes");
        }
        let mut infobox = item.infobox.take();
        if let Some(value) = &mut infobox {
            self.finish_infobox(value, &item.label);
        }
        let id = pages::create_page(
            self.conn,
            CreateInput {
                title: title.to_string(),
                page_type: item.page_type.clone(),
                status: item.status.clone(),
                summary: item.summary.clone(),
                content,
                infobox,
                aliases: item.aliases.clone().unwrap_or_default(),
                categories: item.categories.clone().unwrap_or_default(),
            },
        )?;
        self.conn.execute(
            "UPDATE pages SET notes = ?1, created_at = COALESCE(?2, created_at),
                              updated_at = COALESCE(?3, updated_at) WHERE id = ?4",
            params![
                notes.map(|n| n.to_string()).unwrap_or_default(),
                item.created_at,
                item.updated_at,
                id
            ],
        )?;
        if item.local_only {
            self.conn.execute("UPDATE pages SET local_only = 1 WHERE id = ?1", [&id])?;
        }
        self.made(KIND_PAGE, &id);
        Ok(id)
    }

    /// Replaces what the file provides and leaves the rest. History is saved first.
    fn overwrite_page(&mut self, id: &str, item: &mut PageItem) -> AppResult<()> {
        self.take_checkpoint(KIND_PAGE, id)?;
        let mut patch = Map::new();
        if let Some(mut doc) = item.content.take() {
            self.finish_doc(&mut doc, &item.label, "content");
            patch.insert("content".to_string(), doc);
        }
        if let Some(mut doc) = item.notes.take() {
            self.finish_doc(&mut doc, &item.label, "notes");
            patch.insert("notes".to_string(), doc);
        }
        if let Some(mut value) = item.infobox.take() {
            self.finish_infobox(&mut value, &item.label);
            patch.insert("infobox".to_string(), value);
        }
        if let Some(value) = &item.page_type {
            patch.insert("pageType".to_string(), json!(value));
        }
        if let Some(value) = &item.status {
            patch.insert("status".to_string(), json!(value));
        }
        if let Some(value) = &item.summary {
            patch.insert("summary".to_string(), json!(value));
        }
        if let Some(value) = &item.aliases {
            patch.insert("aliases".to_string(), json!(value));
        }
        if let Some(value) = &item.categories {
            patch.insert("categories".to_string(), json!(value));
        }
        // Only ever set: see `Item::local_only`.
        if item.local_only {
            patch.insert("localOnly".to_string(), json!(true));
        }
        pages::patch_page(self.conn, id, Value::Object(patch))
    }

    fn write_pages(&mut self, mut items: Vec<PageItem>) -> AppResult<()> {
        let home_index = self.settle_home(&items)?;
        let existing = string_set(
            self.conn,
            "SELECT title_key FROM pages WHERE deleted_at IS NULL",
        )?;
        let mut taken = existing.clone();
        taken.extend(items.iter().map(|p| title_key(&p.title)));

        // Decide every rename first, because each one changes links in other documents.
        let mut final_titles = Vec::with_capacity(items.len());
        for item in &items {
            let key = title_key(&item.title);
            if existing.contains(&key) && self.policy == Policy::Rename {
                let renamed = free_name(&mut taken, &item.title);
                self.renamed.insert(key, renamed.clone());
                final_titles.push(renamed);
            } else {
                final_titles.push(item.title.clone());
            }
        }

        for (index, item) in items.iter_mut().enumerate() {
            let key = title_key(&item.title);
            let final_title = std::mem::take(&mut final_titles[index]);
            let changes_at_scenes = item.infobox.as_ref().is_some_and(names_scenes);
            let (action, id) = if existing.contains(&key) {
                let conflict = pages::resolve_title(self.conn, &key)?
                    .ok_or_else(|| AppError::internal("A page disappeared during an import."))?;
                match self.policy {
                    Policy::Skip => {
                        self.report.counts.pages_skipped += 1;
                        ("skip", conflict)
                    }
                    Policy::Overwrite => {
                        self.overwrite_page(&conflict, item)?;
                        self.report.counts.pages_overwritten += 1;
                        ("overwrite", conflict)
                    }
                    Policy::Rename => {
                        let id = self.create_page(item, &final_title)?;
                        self.report.counts.pages_renamed += 1;
                        ("rename", id)
                    }
                }
            } else {
                let id = self.create_page(item, &final_title)?;
                self.report.counts.pages_created += 1;
                ("create", id)
            };
            if home_index == Some(index) {
                self.conn.execute("UPDATE pages SET is_home = 1 WHERE id = ?1", [&id])?;
            }
            if let Some(local) = &item.local_id {
                self.page_refs.insert(local.clone(), id.clone());
            }
            for alias in item.aliases.iter().flatten() {
                self.page_refs
                    .entry(title_key(alias))
                    .or_insert_with(|| id.clone());
            }
            // A title outranks someone else's alias, as it does everywhere else.
            self.page_refs.insert(key, id.clone());
            if action != "skip" {
                if let Some(target) = item.reveal_node.take() {
                    self.pending_reveals.push((item.label.clone(), id.clone(), target));
                }
                if changes_at_scenes {
                    self.pending_changes.push((item.label.clone(), id.clone()));
                }
            }
            self.report.items.push(ItemOutcome {
                kind: "page",
                source: item.label.clone(),
                title: item.title.clone(),
                action,
                final_title,
                id: (!self.dry_run).then_some(id),
                chapters: 0,
                scenes: 0,
            });
        }
        Ok(())
    }

    /// A thread with the same name as one already here is that thread, so that importing
    /// into a project with the same threads does not double them. Overwriting replaces its
    /// details. Two threads in one file may share a name, and stay two.
    fn write_threads(&mut self, items: Vec<ThreadItem>) -> AppResult<()> {
        let existing: HashMap<String, String> = {
            let mut stmt = self.conn.prepare("SELECT name, id FROM threads ORDER BY position DESC")?;
            let rows = stmt.query_map([], |r| Ok((title_key(&r.get::<_, String>(0)?), r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        for item in items {
            let key = title_key(&item.name);
            let id = match existing.get(&key) {
                Some(id) => {
                    if self.policy == Policy::Overwrite {
                        self.conn.execute(
                            "UPDATE threads SET name = ?1, color = COALESCE(?2, color),
                                                description = COALESCE(?3, description) WHERE id = ?4",
                            params![item.name, item.color, item.description, id],
                        )?;
                    }
                    id.clone()
                }
                None => self.create_thread(&item)?,
            };
            if let Some(local) = &item.local_id {
                self.thread_refs.insert(local.clone(), id.clone());
            }
            self.thread_refs.entry(key).or_insert(id);
        }
        Ok(())
    }

    /// Keeps the file's id when it is free, so an export and its re-import agree.
    fn create_thread(&mut self, item: &ThreadItem) -> AppResult<String> {
        let wanted = item.local_id.as_deref().filter(|id| !id.trim().is_empty());
        let taken = match wanted {
            Some(id) => self
                .conn
                .query_row("SELECT 1 FROM threads WHERE id = ?1", [id], |_| Ok(()))
                .optional()?
                .is_some(),
            None => true,
        };
        let id = match wanted {
            Some(id) if !taken => id.to_string(),
            _ => db::new_id(),
        };
        self.conn.execute(
            "INSERT INTO threads (id, name, color, description, position)
             SELECT ?1, ?2, ?3, ?4, COALESCE(?5, (SELECT COALESCE(MAX(position) + 1, 0) FROM threads))",
            params![
                id,
                item.name,
                item.color.as_deref().unwrap_or("accent"),
                item.description.as_deref().unwrap_or(""),
                item.position
            ],
        )?;
        self.report.counts.threads_created += 1;
        Ok(id)
    }

    /// A thread the file names but does not describe is made, since the name says enough.
    fn thread_for(&mut self, reference: &str) -> AppResult<Option<String>> {
        let name = reference.trim();
        if name.is_empty() {
            return Ok(None);
        }
        if let Some(id) = self.thread_refs.get(name) {
            return Ok(Some(id.clone()));
        }
        let key = title_key(name);
        if let Some(id) = self.thread_refs.get(&key) {
            return Ok(Some(id.clone()));
        }
        let existing: Option<String> = {
            let mut stmt = self.conn.prepare("SELECT id, name FROM threads ORDER BY position")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut found = None;
            for row in rows {
                let (id, thread_name) = row?;
                if title_key(&thread_name) == key {
                    found = Some(id);
                    break;
                }
            }
            found
        };
        let id = match existing {
            Some(id) => id,
            None => self.create_thread(&ThreadItem {
                local_id: None,
                name: name.to_string(),
                color: None,
                description: None,
                position: None,
            })?,
        };
        self.thread_refs.insert(key, id.clone());
        Ok(Some(id))
    }

    /// What a scene points at: where it happens, who is there, and the threads it carries.
    fn write_scene_links(&mut self, id: &str, item: &NodeItem) -> AppResult<()> {
        if item.kind != "scene" {
            return Ok(());
        }
        if let Some(name) = &item.location {
            match self.resolve_page(name)? {
                Some(page) => {
                    self.conn.execute(
                        "UPDATE nodes SET location_page_id = ?1 WHERE id = ?2",
                        params![page, id],
                    )?;
                }
                None => {
                    let message = format!("no page is called \"{name}\", so the location was left empty");
                    self.warn(&item.label, "location", message);
                }
            }
        }
        if let Some(names) = &item.cast {
            self.conn.execute("DELETE FROM node_cast WHERE node_id = ?1", [id])?;
            for name in names {
                match self.resolve_page(name)? {
                    Some(page) => {
                        self.conn.execute(
                            "INSERT OR IGNORE INTO node_cast (node_id, page_id) VALUES (?1, ?2)",
                            params![id, page],
                        )?;
                    }
                    None => {
                        let message = format!("no page is called \"{name}\", so it was left out of the cast");
                        self.warn(&item.label, "cast", message);
                    }
                }
            }
        }
        if let Some(references) = &item.threads {
            self.conn.execute("DELETE FROM node_threads WHERE node_id = ?1", [id])?;
            for reference in references {
                if let Some(thread) = self.thread_for(reference)? {
                    self.conn.execute(
                        "INSERT OR IGNORE INTO node_threads (node_id, thread_id) VALUES (?1, ?2)",
                        params![id, thread],
                    )?;
                }
            }
        }
        Ok(())
    }

    fn pov_for(&mut self, item: &NodeItem) -> AppResult<Option<String>> {
        let Some(name) = &item.pov else {
            return Ok(None);
        };
        let found = self.resolve_page(name)?;
        if found.is_none() {
            let message = format!("no page is called \"{name}\", so the point of view was left empty");
            self.warn(&item.label, "pov", message);
        }
        Ok(found)
    }

    fn create_node_tree(
        &mut self,
        book_id: &str,
        parent_id: Option<&str>,
        mut item: NodeItem,
    ) -> AppResult<String> {
        let mut content = item.content.take();
        if let Some(doc) = &mut content {
            self.finish_doc(doc, &item.label, "content");
        }
        let id = manuscript::create_node(
            self.conn,
            CreateNode {
                book_id: book_id.to_string(),
                parent_id: parent_id.map(str::to_string),
                kind: item.kind.clone(),
                title: item.title.clone(),
                after_id: None,
                content,
                synopsis: item.synopsis.clone(),
                status: item.status.clone(),
            },
        )?;
        if self.report.undo.made_ids.contains(parent_id.unwrap_or(book_id)) {
            self.report.undo.made_ids.insert(id.clone());
        } else {
            self.made(KIND_NODE, &id);
        }
        let pov = self.pov_for(&item)?;
        self.conn.execute(
            "UPDATE nodes SET pov_page_id = ?1, notes = COALESCE(?2, notes),
                              target_words = COALESCE(?3, target_words),
                              story_date = COALESCE(?4, story_date),
                              created_at = COALESCE(?5, created_at),
                              updated_at = COALESCE(?6, updated_at)
             WHERE id = ?7",
            params![
                pov,
                item.notes,
                item.target_words,
                item.story_date,
                item.created_at,
                item.updated_at,
                id
            ],
        )?;
        if item.local_only {
            self.conn.execute("UPDATE nodes SET local_only = 1 WHERE id = ?1", [&id])?;
        }
        self.write_scene_links(&id, &item)?;
        self.report.counts.nodes_created += 1;
        if let Some(local) = &item.local_id {
            self.node_refs.insert(local.clone(), id.clone());
        }
        for child in std::mem::take(&mut item.children) {
            self.create_node_tree(book_id, Some(&id), child)?;
        }
        Ok(id)
    }

    /// Replaces what the file provides in an existing node. Word progress is not
    /// touched: importing text is not writing it today.
    fn update_node(&mut self, id: &str, item: &mut NodeItem) -> AppResult<()> {
        if item.kind == "scene" {
            self.take_checkpoint(KIND_NODE, id)?;
        }
        if let Some(mut doc) = item.content.take() {
            self.finish_doc(&mut doc, &item.label, "content");
            let extracted = content::extract(&doc);
            self.conn.execute(
                "UPDATE nodes SET content = ?1, content_text = ?2, word_count = ?3 WHERE id = ?4",
                params![doc.to_string(), extracted.text, extracted.word_count, id],
            )?;
            indexing::sync_entity(self.conn, KIND_NODE, id, &item.title, &extracted)?;
        }
        let pov = self.pov_for(item)?;
        self.conn.execute(
            "UPDATE nodes SET status = COALESCE(?1, status), synopsis = COALESCE(?2, synopsis),
                              notes = COALESCE(?3, notes), story_date = COALESCE(?4, story_date),
                              target_words = COALESCE(?5, target_words),
                              pov_page_id = COALESCE(?6, pov_page_id), updated_at = ?7
             WHERE id = ?8",
            params![
                item.status,
                item.synopsis,
                item.notes,
                item.story_date,
                item.target_words,
                pov,
                db::now(),
                id
            ],
        )?;
        // Only ever set: see `Item::local_only`.
        if item.local_only {
            self.conn.execute("UPDATE nodes SET local_only = 1 WHERE id = ?1", [id])?;
        }
        self.write_scene_links(id, item)?;
        self.report.counts.nodes_updated += 1;
        if let Some(local) = &item.local_id {
            self.node_refs.insert(local.clone(), id.to_string());
        }
        Ok(())
    }

    /// Makes one level of a book match the file. Items with the same kind and title
    /// are updated in place, so their history stays with them. New ones are created,
    /// and anything the file no longer has goes to the trash.
    fn overwrite_children(
        &mut self,
        book_id: &str,
        parent_id: Option<&str>,
        items: Vec<NodeItem>,
    ) -> AppResult<()> {
        let existing: Vec<(String, String, String)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, kind, title FROM nodes
                 WHERE book_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL
                 ORDER BY position, created_at",
            )?;
            let rows = stmt.query_map(params![book_id, parent_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(2)?))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let mut used = vec![false; existing.len()];
        let mut order = Vec::with_capacity(items.len());
        for mut item in items {
            let key = title_key(&item.title);
            let found = existing.iter().enumerate().position(|(i, (_, kind, title))| {
                !used[i] && *kind == item.kind && title_key(title) == key
            });
            let id = match found {
                Some(index) => {
                    used[index] = true;
                    let id = existing[index].0.clone();
                    self.update_node(&id, &mut item)?;
                    let children = std::mem::take(&mut item.children);
                    self.overwrite_children(book_id, Some(&id), children)?;
                    id
                }
                None => self.create_node_tree(book_id, parent_id, item)?,
            };
            order.push(id);
        }
        for (index, (id, _, _)) in existing.iter().enumerate() {
            if !used[index] {
                manuscript::delete_node(self.conn, id)?;
                self.report.counts.nodes_removed += 1;
                self.report.undo.removed.push(revisions::BulkItem {
                    kind: KIND_NODE.to_string(),
                    id: id.clone(),
                });
            }
        }
        manuscript::write_positions(self.conn, &order)
    }

    /// The cover and any pictures in front and back matter follow the file's assets, and
    /// links follow any pages the rename policy changed.
    fn finish_publishing(&mut self, publishing: &mut Value, item: &str) {
        let cover = publishing.get("coverAssetId").and_then(Value::as_str).map(str::to_string);
        if let Some(cover) = cover {
            match self.asset_refs.get(&cover) {
                Some(real) => publishing["coverAssetId"] = json!(real),
                None => {
                    self.warn(
                        item,
                        "publishing.coverAssetId",
                        format!("refers to an asset that does not exist: {cover}"),
                    );
                    if let Some(object) = publishing.as_object_mut() {
                        object.remove("coverAssetId");
                    }
                }
            }
        }
        for name in ["copyright", "dedication", "epigraph", "acknowledgments", "aboutAuthor"] {
            if let Some(doc) = publishing.pointer_mut(&format!("/{name}/content")) {
                if doc.is_object() {
                    self.finish_doc(doc, item, &format!("publishing.{name}.content"));
                }
            }
        }
    }

    fn set_book_fields(&mut self, id: &str, book: &BookItem, created: bool) -> AppResult<()> {
        if let Some(publishing) = &book.publishing {
            let mut publishing = publishing.clone();
            self.finish_publishing(&mut publishing, &book.label);
            self.conn.execute(
                "UPDATE books SET publishing = ?1 WHERE id = ?2",
                params![publishing.to_string(), id],
            )?;
        }
        self.conn.execute(
            "UPDATE books SET subtitle = COALESCE(?1, subtitle), author = COALESCE(?2, author),
                              target_words = COALESCE(?3, target_words) WHERE id = ?4",
            params![book.subtitle, book.author, book.target_words, id],
        )?;
        let updated = if created { book.updated_at.clone() } else { Some(db::now()) };
        self.conn.execute(
            "UPDATE books SET created_at = COALESCE(?1, created_at),
                              updated_at = COALESCE(?2, updated_at) WHERE id = ?3",
            params![if created { book.created_at.clone() } else { None }, updated, id],
        )?;
        for day in &book.writing_log {
            self.conn.execute(
                "INSERT OR IGNORE INTO writing_log (day, book_id, words_added, words_removed)
                 VALUES (?1, ?2, ?3, ?4)",
                params![day.day, id, day.words_added, day.words_removed],
            )?;
        }
        Ok(())
    }

    fn create_book(&mut self, book: &mut BookItem, title: &str) -> AppResult<String> {
        let id = manuscript::create_book(self.conn, title)?;
        self.made("book", &id);
        for child in std::mem::take(&mut book.children) {
            self.create_node_tree(&id, None, child)?;
        }
        self.set_book_fields(&id, book, true)?;
        Ok(id)
    }

    fn write_books(&mut self, items: Vec<BookItem>) -> AppResult<()> {
        if items.iter().any(|b| b.into_book.is_none()) {
            if let Some(starter) = untouched_starter_book(self.conn)? {
                remove_starter_book(self.conn, &starter)?;
                self.report
                    .notes
                    .push("The imported books take the place of the empty starter book.".to_string());
            }
        }
        let existing: HashMap<String, String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT title, id FROM books WHERE deleted_at IS NULL ORDER BY position")?;
            let rows = stmt.query_map([], |r| Ok((title_key(&r.get::<_, String>(0)?), r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut taken: HashSet<String> = existing.keys().cloned().collect();
        taken.extend(items.iter().map(|b| title_key(&b.title)));

        for mut book in items {
            let (chapters, scenes) = count_nodes(&book.children);
            let key = title_key(&book.title);
            let mut final_title = book.title.clone();
            let (action, id): (&'static str, String) = if let Some(target) = book.into_book.clone() {
                let title: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT title FROM books WHERE id = ?1 AND deleted_at IS NULL",
                        [&target],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(title) = title else {
                    return Err(AppError::not_found("The book to add to"));
                };
                final_title = title;
                for child in std::mem::take(&mut book.children) {
                    self.create_node_tree(&target, book.into_parent.as_deref(), child)?;
                }
                self.report.counts.books_extended += 1;
                ("extend", target)
            } else {
                match (existing.get(&key).cloned(), self.policy) {
                    (None, _) => {
                        let id = self.create_book(&mut book, &final_title)?;
                        self.report.counts.books_created += 1;
                        ("create", id)
                    }
                    (Some(id), Policy::Skip) => {
                        self.report.counts.books_skipped += 1;
                        ("skip", id)
                    }
                    (Some(_), Policy::Rename) => {
                        final_title = free_name(&mut taken, &book.title);
                        let id = self.create_book(&mut book, &final_title)?;
                        self.report.counts.books_renamed += 1;
                        ("rename", id)
                    }
                    (Some(id), Policy::Overwrite) => {
                        let children = std::mem::take(&mut book.children);
                        self.overwrite_children(&id, None, children)?;
                        self.set_book_fields(&id, &book, false)?;
                        self.report.counts.books_overwritten += 1;
                        ("overwrite", id)
                    }
                }
            };
            self.report.items.push(ItemOutcome {
                kind: "book",
                source: book.label.clone(),
                title: book.title.clone(),
                action,
                final_title,
                id: (!self.dry_run).then_some(id),
                chapters,
                scenes,
            });
        }
        Ok(())
    }

    /// A scene named in the file: its id in the file, then one already in the project.
    fn resolve_node(&self, target: &str) -> AppResult<Option<String>> {
        if let Some(id) = self.node_refs.get(target) {
            return Ok(Some(id.clone()));
        }
        Ok(self
            .conn
            .query_row(
                "SELECT id FROM nodes WHERE id = ?1 AND deleted_at IS NULL",
                [target],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    }

    /// Facts in an infobox can change at a scene, and by now that scene has its real id.
    fn apply_field_changes(&mut self) -> AppResult<()> {
        for (label, page_id) in std::mem::take(&mut self.pending_changes) {
            let stored: String =
                self.conn.query_row("SELECT infobox FROM pages WHERE id = ?1", [&page_id], |r| r.get(0))?;
            let Ok(mut infobox) = serde_json::from_str::<Value>(&stored) else {
                continue;
            };
            let mut missing = Vec::new();
            let fields = infobox.get_mut("fields").and_then(Value::as_array_mut);
            for (f, field) in fields.into_iter().flatten().enumerate() {
                let changes = field.get_mut("changes").and_then(Value::as_array_mut);
                for (c, change) in changes.into_iter().flatten().enumerate() {
                    let Some(target) = change.get("nodeId").and_then(Value::as_str).map(str::to_string) else {
                        continue;
                    };
                    match self.resolve_node(&target)? {
                        Some(real) => change["nodeId"] = json!(real),
                        None => {
                            change["nodeId"] = Value::Null;
                            missing.push((format!("infobox.fields[{f}].changes[{c}].nodeId"), target));
                        }
                    }
                }
            }
            self.conn.execute(
                "UPDATE pages SET infobox = ?1 WHERE id = ?2",
                params![infobox.to_string(), page_id],
            )?;
            for (field, target) in missing {
                self.warn(&label, &field, format!("no scene has the id \"{target}\", so this change no longer names one"));
            }
        }
        Ok(())
    }

    fn apply_reveals(&mut self) -> AppResult<()> {
        for (label, page_id, target) in std::mem::take(&mut self.pending_reveals) {
            let node = self.resolve_node(&target)?;
            match node {
                Some(node) => {
                    self.conn.execute(
                        "UPDATE pages SET reveal_node_id = ?1 WHERE id = ?2",
                        params![node, page_id],
                    )?;
                }
                None => self.warn(
                    &label,
                    "revealNodeId",
                    format!("no scene or chapter has the id \"{target}\", so it was left empty"),
                ),
            }
        }
        Ok(())
    }

    fn write_relationships(&mut self, items: Vec<RelationshipItem>) -> AppResult<()> {
        for item in items {
            let from = self.resolve_page(&item.from)?;
            let to = self.resolve_page(&item.to)?;
            let (Some(from), Some(to)) = (&from, &to) else {
                let (field, name) = if from.is_none() { ("from", &item.from) } else { ("to", &item.to) };
                let message = format!("no page is called \"{name}\", so this relationship was left out");
                self.warn(&item.label, field, message);
                self.report.counts.relationships_skipped += 1;
                continue;
            };
            let existing: Option<String> = self
                .conn
                .query_row(
                    "SELECT id FROM relationships
                     WHERE from_page_id = ?1 AND to_page_id = ?2 AND kind = ?3",
                    params![from, to, item.kind],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(id) = existing {
                if self.policy == Policy::Overwrite {
                    self.conn.execute(
                        "UPDATE relationships SET note = ?1 WHERE id = ?2",
                        params![item.note, id],
                    )?;
                }
                self.report.counts.relationships_skipped += 1;
                continue;
            }
            self.conn.execute(
                "INSERT INTO relationships (id, from_page_id, to_page_id, kind, note, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    db::new_id(),
                    from,
                    to,
                    item.kind,
                    item.note,
                    item.created_at.unwrap_or_else(db::now),
                ],
            )?;
            self.report.counts.relationships_created += 1;
        }
        Ok(())
    }

    fn write_pins(&mut self, map_id: &str, item: &MapItem) -> AppResult<()> {
        for pin in &item.pins {
            let page = match &pin.page {
                Some(name) => {
                    let found = self.resolve_page(name)?;
                    if found.is_none() {
                        let message = format!("no page is called \"{name}\", so this pin links to nothing");
                        self.warn(&item.label, "pins", message);
                    }
                    found
                }
                None => None,
            };
            self.conn.execute(
                "INSERT INTO map_pins (id, map_id, page_id, label, x, y, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    db::new_id(),
                    map_id,
                    page,
                    pin.label,
                    pin.x,
                    pin.y,
                    pin.created_at.clone().unwrap_or_else(db::now),
                ],
            )?;
        }
        Ok(())
    }

    fn write_maps(&mut self, items: Vec<MapItem>) -> AppResult<()> {
        let mut existing: HashMap<String, String> = {
            let mut stmt = self.conn.prepare("SELECT title, id FROM maps WHERE deleted_at IS NULL")?;
            let rows = stmt.query_map([], |r| Ok((title_key(&r.get::<_, String>(0)?), r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut taken: HashSet<String> = existing.keys().cloned().collect();
        taken.extend(items.iter().map(|m| title_key(&m.title)));
        for item in items {
            let asset = match &item.asset {
                Some(key) => {
                    let real = self.asset_refs.get(key).cloned();
                    if real.is_none() {
                        let message = format!("refers to an asset that does not exist: {key}");
                        self.warn(&item.label, "assetId", message);
                    }
                    real
                }
                None => None,
            };
            let key = title_key(&item.title);
            match (existing.get(&key).cloned(), self.policy) {
                (Some(_), Policy::Skip) => {
                    self.report.counts.maps_skipped += 1;
                }
                (Some(id), Policy::Overwrite) => {
                    self.conn.execute("DELETE FROM map_pins WHERE map_id = ?1", [&id])?;
                    self.conn.execute(
                        "UPDATE maps SET asset_id = COALESCE(?1, asset_id), updated_at = ?2 WHERE id = ?3",
                        params![asset, db::now(), id],
                    )?;
                    self.write_pins(&id, &item)?;
                    self.report.counts.maps_overwritten += 1;
                }
                (conflict, _) => {
                    let title = if conflict.is_some() {
                        free_name(&mut taken, &item.title)
                    } else {
                        item.title.clone()
                    };
                    let id = db::new_id();
                    let now = db::now();
                    self.conn.execute(
                        "INSERT INTO maps (id, title, asset_id, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            id,
                            title,
                            asset,
                            item.created_at.clone().unwrap_or_else(|| now.clone()),
                            item.updated_at.clone().unwrap_or(now),
                        ],
                    )?;
                    self.write_pins(&id, &item)?;
                    existing.insert(key, id);
                    self.report.counts.maps_created += 1;
                }
            }
        }
        Ok(())
    }

    /// A card's `lorecraft:<kind>/<id>` link follows the page, scene or asset to its new id.
    fn relink_canvas(&self, data: &mut Value) {
        let Some(nodes) = data.get_mut("nodes").and_then(Value::as_array_mut) else {
            return;
        };
        for node in nodes {
            let Some(file) = node.get("file").and_then(Value::as_str) else {
                continue;
            };
            let Some((kind, id)) = file.strip_prefix("lorecraft:").and_then(|rest| rest.split_once('/')) else {
                continue;
            };
            let real = match kind {
                "page" => self.page_refs.get(id),
                "scene" | "node" => self.node_refs.get(id),
                "asset" => self.asset_refs.get(id),
                _ => None,
            };
            if let Some(real) = real {
                let relinked = format!("lorecraft:{kind}/{real}");
                node["file"] = json!(relinked);
            }
        }
    }

    fn write_canvases(&mut self, items: Vec<CanvasItem>) -> AppResult<()> {
        let mut existing: HashMap<String, String> = {
            let mut stmt = self.conn.prepare("SELECT title_key, id FROM canvases WHERE deleted_at IS NULL")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut taken: HashSet<String> = existing.keys().cloned().collect();
        taken.extend(items.iter().map(|c| title_key(&c.title)));
        for mut item in items {
            self.relink_canvas(&mut item.data);
            let data = canvas::check_data(&item.data)?;
            let key = title_key(&item.title);
            match (existing.get(&key).cloned(), self.policy) {
                (Some(_), Policy::Skip) => self.report.counts.canvases_skipped += 1,
                (Some(id), Policy::Overwrite) => {
                    self.conn.execute(
                        "UPDATE canvases SET data = ?1, updated_at = ?2 WHERE id = ?3",
                        params![data, db::now(), id],
                    )?;
                    self.report.counts.canvases_overwritten += 1;
                }
                (conflict, _) => {
                    let title = if conflict.is_some() {
                        free_name(&mut taken, &item.title)
                    } else {
                        item.title.clone()
                    };
                    let id = canvas::insert(
                        self.conn,
                        &title,
                        &data,
                        item.created_at.as_deref(),
                        item.updated_at.as_deref(),
                    )?;
                    existing.insert(key, id);
                    self.report.counts.canvases_created += 1;
                }
            }
        }
        Ok(())
    }

    fn write_small_tables(
        &mut self,
        dictionary: Vec<String>,
        prompts: Vec<PromptItem>,
        meta: Vec<(String, String)>,
    ) -> AppResult<()> {
        for word in dictionary {
            let cleaned = word.trim();
            if cleaned.is_empty() {
                continue;
            }
            self.report.counts.dictionary_added += self.conn.execute(
                "INSERT OR IGNORE INTO dictionary (word_key, word) VALUES (?1, ?2)",
                params![title_key(cleaned), cleaned],
            )?;
        }
        for prompt in prompts {
            let existing: Option<String> = self
                .conn
                .query_row(
                    "SELECT id FROM prompts WHERE name = ?1 AND builtin = 0",
                    [&prompt.name],
                    |r| r.get(0),
                )
                .optional()?;
            let now = db::now();
            match existing {
                Some(id) => {
                    if self.policy == Policy::Overwrite {
                        self.conn.execute(
                            "UPDATE prompts SET description = ?1, template = ?2, scope = ?3,
                                                updated_at = ?4 WHERE id = ?5",
                            params![prompt.description, prompt.template, prompt.scope, now, id],
                        )?;
                    }
                }
                None => {
                    self.conn.execute(
                        "INSERT INTO prompts (id, name, description, template, scope, builtin,
                                              position, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?7)",
                        params![
                            db::new_id(),
                            prompt.name,
                            prompt.description,
                            prompt.template,
                            prompt.scope,
                            prompt.position,
                            now,
                        ],
                    )?;
                    self.report.counts.prompts_created += 1;
                }
            }
        }
        for (key, value) in meta {
            let sql = if self.policy == Policy::Overwrite {
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            } else {
                "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, ?2)"
            };
            self.conn.execute(sql, params![key, value])?;
        }
        Ok(())
    }
}

fn run(conn: &Connection, prepared: Prepared, dry_run: bool) -> AppResult<Report> {
    let Prepared {
        policy,
        pages,
        threads,
        books,
        relationships,
        assets,
        maps,
        dictionary,
        prompts,
        canvases,
        meta,
        problems,
    } = prepared;
    let mut run = Run {
        conn,
        policy,
        dry_run,
        report: Report {
            problems,
            ..Default::default()
        },
        page_refs: HashMap::new(),
        node_refs: HashMap::new(),
        thread_refs: HashMap::new(),
        renamed: HashMap::new(),
        asset_refs: HashMap::new(),
        pending_reveals: Vec::new(),
        pending_changes: Vec::new(),
    };
    // Names and text arrive throughout, so mentions are worked out once at the end.
    indexing::defer_mentions(conn, || {
        run.write_assets(&assets)?;
        run.write_pages(pages)?;
        run.write_threads(threads)?;
        run.write_books(books)?;
        run.apply_reveals()?;
        run.apply_field_changes()?;
        run.write_relationships(relationships)?;
        run.write_maps(maps)?;
        run.write_canvases(canvases)?;
        run.write_small_tables(dictionary, prompts, meta)
    })?;
    if dry_run {
        // Nothing a preview wrote outlives it.
        run.report.undo = UndoPlan::default();
    } else {
        run.finish_undo()?;
    }
    run.report.applied = !dry_run;
    Ok(run.report)
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "preview" => {
            let prepared = prepare(engine, &params)?;
            // A read as far as the project's saved state goes: nothing outlives the rollback,
            // so it neither takes the write path nor marks the project as changed.
            let report = engine.read(|conn| {
                let tx = conn.unchecked_transaction()?;
                let report = run(&tx, prepared, true);
                tx.rollback()?;
                report
            })?;
            ok(report)
        }
        "apply" => {
            let prepared = prepare(engine, &params)?;
            if prepared.problems.iter().any(|p| p.severity == "error") {
                return ok(Report {
                    problems: prepared.problems,
                    ..Default::default()
                });
            }
            let report = engine.write(|tx| run(tx, prepared, false))?;
            engine.notify("all");
            ok(report)
        }
        _ => Err(unknown(&format!("import.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{call, dispatch};
    use std::sync::Arc;

    fn project() -> (Arc<Engine>, crate::engine::TestDir) {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "T" }));
        (engine, dir)
    }

    fn doc(text: &str) -> Value {
        json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": text }] }
        ]})
    }

    fn linked(label: &str, target: &str) -> Value {
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [
            { "type": "text", "text": label, "marks": [{ "type": "wikiLink", "attrs": { "target": target } }] }
        ]}]})
    }

    fn apply(engine: &Engine, payload: Value) -> Value {
        call(engine, "import.apply", payload)
    }

    /// Bytes that really do start like a PNG, with something to tell them apart.
    fn png(extra: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(extra);
        bytes
    }

    fn mp4(extra: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0, 0, 0, 16];
        bytes.extend_from_slice(b"ftypisom");
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(extra);
        bytes
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn stored(engine: &Engine, id: &str) -> Vec<u8> {
        media::read_range(engine, id, 0, 1024 * 1024).unwrap()
    }

    fn titles(engine: &Engine) -> Vec<String> {
        call(engine, "pages.titles", json!({}))
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["title"].as_str().unwrap().to_string())
            .collect()
    }

    fn page(engine: &Engine, title: &str) -> Value {
        call(engine, "pages.getByTitle", json!({ "title": title }))
    }

    fn make_existing_page(engine: &Engine, title: &str, text: &str) -> Value {
        let created = call(engine, "pages.create", json!({ "title": title, "categories": ["Old"] }));
        call(
            engine,
            "pages.update",
            json!({ "id": created["id"], "patch": { "content": doc(text) } }),
        );
        created
    }

    /// Everything a person can see in a project, for comparing before and after.
    fn fingerprint(engine: &Engine) -> Value {
        let mut snap = call(engine, "snapshot.get", json!({}));
        snap.as_object_mut().unwrap().remove("meta");
        snap
    }

    fn world() -> Value {
        json!({
            "policy": "skip",
            "pages": [
                {
                    "id": "aria",
                    "title": "Aria Vale",
                    "pageType": "character",
                    "status": "canon",
                    "summary": "A ranger of the north.",
                    "aliases": ["The Ranger"],
                    "categories": ["Rangers", "Characters"],
                    "infobox": { "caption": "Aria", "fields": [
                        { "key": "born", "label": "Born", "kind": "date", "value": "1204" },
                        { "key": "location", "kind": "page", "value": "Silver Vale" }
                    ]},
                    "content": linked("the Vale", "Silver Vale"),
                    "notes": doc("Check her age."),
                    "createdAt": "2020-01-02T03:04:05.000Z",
                    "updatedAt": "2021-01-02T03:04:05.000Z",
                    "revealNodeId": "s1"
                },
                { "id": "vale", "title": "Silver Vale", "pageType": "place", "content": doc("A cold valley.") }
            ],
            "books": [
                {
                    "title": "The Silver Road",
                    "subtitle": "Book One of the Vale",
                    "author": "A. Writer",
                    "targetWords": 90000,
                    "children": [
                        { "kind": "part", "title": "Part One", "children": [
                            { "kind": "chapter", "title": "Arrival", "synopsis": "She comes home.", "children": [
                                {
                                    "id": "s1",
                                    "kind": "scene",
                                    "title": "The Gate",
                                    "status": "revised",
                                    "pov": "The Ranger",
                                    "storyDate": "1 Frost 1220",
                                    "notes": "Tighten this.",
                                    "targetWords": 1500,
                                    "content": doc("Aria Vale rode to the gate.")
                                }
                            ]}
                        ]},
                        { "kind": "chapter", "title": "Interlude", "children": [
                            { "kind": "scene", "title": "Empty" }
                        ]}
                    ]
                }
            ],
            "relationships": [
                { "from": "aria", "to": "Silver Vale", "kind": "born in", "note": "North side." }
            ]
        })
    }

    #[test]
    fn a_small_world_arrives_with_everything_in_place() {
        let (engine, _dir) = project();
        let report = apply(&engine, world());
        assert_eq!(report["applied"], true);
        assert_eq!(report["counts"]["pagesCreated"], 2);
        assert_eq!(report["counts"]["booksCreated"], 1);
        assert_eq!(report["counts"]["nodesCreated"], 5);
        assert_eq!(report["counts"]["relationshipsCreated"], 1);

        let aria = page(&engine, "the ranger");
        assert_eq!(aria["title"], "Aria Vale");
        assert_eq!(aria["status"], "canon");
        assert_eq!(aria["pageType"], "character");
        assert_eq!(aria["categories"], json!(["Characters", "Rangers"]));
        assert_eq!(aria["infobox"]["fields"][1]["label"], "location");
        assert_eq!(aria["notes"], doc("Check her age."));
        assert_eq!(aria["createdAt"], "2020-01-02T03:04:05.000Z");
        assert_eq!(aria["updatedAt"], "2021-01-02T03:04:05.000Z");

        // Indexes are right: search, backlinks and mentions all work.
        let found = call(&engine, "search.query", json!({ "q": "valley" }));
        assert_eq!(found.as_array().unwrap().len(), 1);
        let vale = page(&engine, "Silver Vale");
        let back = call(&engine, "pages.backlinks", json!({ "id": vale["id"] }));
        assert_eq!(back["pages"][0]["title"], "Aria Vale");
        let back = call(&engine, "pages.backlinks", json!({ "id": aria["id"] }));
        assert_eq!(back["scenes"][0]["title"], "The Gate");

        let books = call(&engine, "books.list", json!({}));
        assert_eq!(books.as_array().unwrap().len(), 1, "the empty starter book is replaced");
        assert_eq!(books[0]["title"], "The Silver Road");
        assert_eq!(books[0]["author"], "A. Writer");
        assert_eq!(books[0]["targetWords"], 90000);
        let tree = call(&engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["title"] == "The Gate").unwrap();
        assert_eq!(scene["povPageId"], aria["id"]);
        assert_eq!(scene["status"], "revised");
        assert_eq!(scene["storyDate"], "1 Frost 1220");
        assert_eq!(scene["targetWords"], 1500);
        assert_eq!(scene["wordCount"], 6);
        assert_eq!(aria["revealNodeId"], scene["id"]);

        let snap = call(&engine, "snapshot.get", json!({}));
        assert_eq!(snap["relationships"][0]["fromPageId"], aria["id"]);
        assert_eq!(snap["relationships"][0]["kind"], "born in");

        assert_eq!(
            titles(&engine),
            vec!["Aria Vale", "Main Page", "Silver Vale"],
            "a main page not in the file stays"
        );
    }

    #[test]
    fn canvases_arrive_with_their_cards_pointing_at_the_imported_pages() {
        let (engine, _dir) = project();
        let data = json!({
            "nodes": [
                { "id": "a", "type": "file", "file": "lorecraft:page/in-file-aria" },
                { "id": "b", "type": "file", "file": "lorecraft:page/unknown" },
                { "id": "c", "type": "text", "text": "Note" }
            ],
            "edges": []
        });
        let report = apply(&engine, json!({
            "pages": [{ "id": "in-file-aria", "title": "Aria", "content": doc("Hi") }],
            "canvases": [{ "title": "Plot", "data": data }],
        }));
        assert_eq!(report["counts"]["canvasesCreated"], 1);
        let aria = page(&engine, "Aria");
        let snap = call(&engine, "snapshot.get", json!({}));
        let nodes = &snap["canvases"][0]["data"]["nodes"];
        assert_eq!(nodes[0]["file"], format!("lorecraft:page/{}", aria["id"].as_str().unwrap()));
        assert_eq!(nodes[1]["file"], "lorecraft:page/unknown", "an unknown link is kept as it was");

        // Again with the same title: skip leaves one, rename makes a second.
        let again = apply(&engine, json!({ "canvases": [{ "title": "Plot", "data": data }] }));
        assert_eq!(again["counts"]["canvasesSkipped"], 1);
        let renamed = apply(&engine, json!({ "policy": "rename", "canvases": [{ "title": "Plot" }] }));
        assert_eq!(renamed["counts"]["canvasesCreated"], 1);
        assert_eq!(call(&engine, "canvases.list", json!({})).as_array().unwrap().len(), 2);

        // A file from before canvases has none, and a bad one is refused.
        let old = apply(&engine, json!({ "pages": [] }));
        assert_eq!(old["counts"]["canvasesCreated"], 0);
        let bad = apply(&engine, json!({ "canvases": [{ "title": "X", "data": { "nodes": 1 } }] }));
        assert_eq!(bad["applied"], false);
    }

    #[test]
    fn an_infobox_keeps_whatever_else_it_holds() {
        let (engine, _dir) = project();
        apply(
            &engine,
            json!({ "pages": [{ "title": "A", "infobox": {
                "template": "hero",
                "fields": [{ "key": "born", "value": 1204, "pinned": true }]
            }}]}),
        );
        let infobox = page(&engine, "A")["infobox"].clone();
        assert_eq!(infobox["template"], "hero");
        assert_eq!(infobox["fields"][0], json!({ "key": "born", "label": "born", "kind": "text", "value": "1204", "pinned": true }));
    }

    #[test]
    fn publishing_details_arrive_with_their_cover_and_pictures_found() {
        let (engine, _dir) = project();
        let report = apply(
            &engine,
            json!({
                "assets": [{ "id": "cover-in-file", "name": "c.png", "mime": "image/png", "base64": b64(&png(&[4])) }],
                "books": [{
                    "title": "Published",
                    "publishing": {
                        "coverAssetId": "cover-in-file",
                        "isbn": "9781234567897",
                        "dedication": { "include": true, "content": { "type": "doc", "content": [{
                            "type": "image", "attrs": { "assetId": "cover-in-file" }
                        }] } }
                    }
                }, {
                    "title": "Lost cover",
                    "publishing": { "coverAssetId": "nowhere" }
                }]
            }),
        );
        assert!(report["problems"].as_array().unwrap().iter().any(|p| p["field"] == "publishing.coverAssetId"));
        let books = call(&engine, "books.list", json!({}));
        let book = books.as_array().unwrap().iter().find(|b| b["title"] == "Published").unwrap();
        let cover = book["publishing"]["coverAssetId"].as_str().unwrap();
        assert_eq!(book["publishing"]["isbn"], "9781234567897");
        assert_eq!(book["publishing"]["dedication"]["content"]["content"][0]["attrs"]["assetId"], cover);
        let lost = books.as_array().unwrap().iter().find(|b| b["title"] == "Lost cover").unwrap();
        assert!(lost["publishing"].get("coverAssetId").is_none());

        let snapshot = call(&engine, "snapshot.get", json!({}));
        let same = snapshot["books"].as_array().unwrap().iter().find(|b| b["title"] == "Published").unwrap();
        assert_eq!(same["publishing"]["isbn"], "9781234567897");
        assert!(snapshot["assets"].as_array().unwrap().iter().any(|a| a["id"] == cover));
    }

    #[test]
    fn a_scene_keeps_its_location_cast_and_threads() {
        let (engine, _dir) = project();
        let report = apply(
            &engine,
            json!({
                "threads": [
                    { "id": "t-main", "name": "The Long Road", "color": "green", "description": "Home again.", "position": 3 },
                    { "name": "Rivals" }
                ],
                "pages": [
                    { "title": "Aria Vale", "aliases": ["The Ranger"] },
                    { "title": "Dorn" },
                    { "title": "Silver Gate" }
                ],
                "books": [{ "title": "B", "children": [{ "kind": "chapter", "title": "C", "children": [{
                    "kind": "scene",
                    "title": "S",
                    "location": "Silver Gate",
                    "cast": ["The Ranger", "Dorn", "Nobody"],
                    "threads": ["t-main", "rivals", "A Thread Only Named Here"]
                }, {
                    "kind": "scene",
                    "title": "T",
                    "location": "Nowhere",
                    "threads": ["t-main"]
                }] }] }]
            }),
        );
        assert_eq!(report["counts"]["threadsCreated"], 3);
        let problems = report["problems"].as_array().unwrap();
        assert!(problems.iter().any(|p| p["field"] == "cast" && p["message"].as_str().unwrap().contains("Nobody")));
        assert!(problems.iter().any(|p| p["field"] == "location" && p["message"].as_str().unwrap().contains("Nowhere")));

        let snap = call(&engine, "snapshot.get", json!({}));
        let threads = snap["threads"].as_array().unwrap();
        let main = threads.iter().find(|t| t["name"] == "The Long Road").unwrap();
        assert_eq!(main["id"], "t-main", "the file's id is kept while it is free");
        assert_eq!(main["color"], "green");
        assert_eq!(main["description"], "Home again.");
        assert_eq!(main["position"], 3);
        let rivals = threads.iter().find(|t| t["name"] == "Rivals").unwrap();
        assert_eq!(threads.len(), 3);

        let page_id = |title: &str| page(&engine, title)["id"].clone();
        let scene = snap["nodes"].as_array().unwrap().iter().find(|n| n["title"] == "S").unwrap();
        assert_eq!(scene["locationPageId"], page_id("Silver Gate"));
        let mut cast: Vec<_> = scene["castPageIds"].as_array().unwrap().clone().into_iter().map(|v| v.as_str().unwrap().to_string()).collect();
        cast.sort();
        let mut expected = vec![page_id("Aria Vale").as_str().unwrap().to_string(), page_id("Dorn").as_str().unwrap().to_string()];
        expected.sort();
        assert_eq!(cast, expected);
        let links: Vec<_> = snap["nodeThreads"].as_array().unwrap().iter().filter(|l| l["nodeId"] == scene["id"]).map(|l| l["threadId"].clone()).collect();
        assert_eq!(links.len(), 3);
        assert!(links.contains(&main["id"]));
        assert!(links.contains(&rivals["id"]));
    }

    #[test]
    fn threads_follow_the_conflict_policy_and_never_double() {
        let (engine, _dir) = project();
        call(&engine, "threads.create", json!({ "name": "The Long Road", "color": "red", "description": "Old words." }));
        let payload = |policy: &str| json!({
            "policy": policy,
            "threads": [{ "id": "elsewhere", "name": "the long road", "color": "green", "description": "New words." }],
            "books": [{ "title": "B", "children": [{ "kind": "chapter", "title": "C", "children": [
                { "kind": "scene", "title": "S", "threads": ["elsewhere"] }
            ] }] }]
        });
        let report = apply(&engine, payload("skip"));
        assert_eq!(report["counts"]["threadsCreated"], 0);
        let snap = call(&engine, "snapshot.get", json!({}));
        assert_eq!(snap["threads"].as_array().unwrap().len(), 1);
        assert_eq!(snap["threads"][0]["color"], "red", "skip leaves what is here");
        assert_eq!(snap["nodeThreads"][0]["threadId"], snap["threads"][0]["id"], "and the scene joins the thread already here");

        apply(&engine, payload("overwrite"));
        let snap = call(&engine, "snapshot.get", json!({}));
        assert_eq!(snap["threads"].as_array().unwrap().len(), 1);
        assert_eq!(snap["threads"][0]["color"], "green");
        assert_eq!(snap["threads"][0]["description"], "New words.");
        assert_eq!(snap["nodeThreads"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn an_import_can_be_undone_from_what_it_reports() {
        let (engine, _dir) = project();
        let old = make_existing_page(&engine, "Aria", "Old life.");
        let edited = make_existing_page(&engine, "Gate", "Old gate.");
        let book = |scenes: Value| json!({ "title": "B", "children": [{ "kind": "chapter", "title": "C", "children": scenes }] });
        apply(&engine, json!({ "books": [book(json!([
            { "kind": "scene", "title": "S", "content": doc("First draft.") },
            { "kind": "scene", "title": "Gone", "content": doc("Cut later.") },
        ]))] }));
        let report = apply(&engine, json!({
            "policy": "overwrite",
            "pages": [
                { "title": "Aria", "content": doc("New life.") },
                { "title": "Gate", "content": doc("New gate.") },
                { "title": "Brand new", "content": doc("Fresh.") },
            ],
            "books": [book(json!([
                { "kind": "scene", "title": "S", "content": doc("Second draft.") },
                { "kind": "scene", "title": "Added", "content": doc("More.") },
            ]))],
        }));
        let undo = report["undo"].clone();
        assert_eq!(undo["changes"].as_array().unwrap().len(), 3, "{undo}");
        // The writer keeps working on one page after the import.
        call(&engine, "pages.update", json!({ "id": edited["id"], "patch": { "content": doc("New gate, mine.") } }));

        let undone = call(&engine, "revisions.undo", undo);
        assert_eq!(undone["restored"], 2);
        assert_eq!(undone["kept"][0]["title"], "Gate");
        assert_eq!(call(&engine, "pages.get", json!({ "id": old["id"] }))["content"], doc("Old life."));
        assert_eq!(call(&engine, "pages.get", json!({ "id": edited["id"] }))["content"], doc("New gate, mine."));
        let snap = call(&engine, "snapshot.get", json!({}));
        let live = |title: &str| snap["nodes"].as_array().unwrap().iter().find(|n| n["title"] == title).cloned();
        assert_eq!(live("S").unwrap()["content"], doc("First draft."));
        assert!(live("Added").is_none(), "what the import made is in the trash");
        assert!(live("Gone").is_some(), "what it removed is back");
        assert!(snap["pages"].as_array().unwrap().iter().all(|p| p["title"] != "Brand new"));
        let trash = call(&engine, "pages.list", json!({ "deleted": true }));
        assert!(trash.as_array().unwrap().iter().any(|p| p["title"] == "Brand new"));
    }

    #[test]
    fn overwriting_a_scene_leaves_its_links_unless_the_file_has_them() {
        let (engine, _dir) = project();
        let scene = |extra: Value| {
            let mut fields = json!({ "kind": "scene", "title": "S" });
            fields.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            json!({
                "policy": "overwrite",
                "books": [{ "title": "B", "children": [{ "kind": "chapter", "title": "C", "children": [fields] }] }]
            })
        };
        apply(&engine, json!({ "pages": [{ "title": "Aria" }, { "title": "Gate" }] }));
        apply(&engine, scene(json!({ "location": "Gate", "cast": ["Aria"], "threads": ["Road"] })));
        apply(&engine, scene(json!({ "synopsis": "No links here." })));
        let snap = call(&engine, "snapshot.get", json!({}));
        let node = snap["nodes"].as_array().unwrap().iter().find(|n| n["title"] == "S").unwrap();
        assert!(node["locationPageId"].is_string());
        assert_eq!(node["castPageIds"].as_array().unwrap().len(), 1);
        assert_eq!(snap["nodeThreads"].as_array().unwrap().len(), 1);

        apply(&engine, scene(json!({ "cast": [], "threads": [] })));
        let snap = call(&engine, "snapshot.get", json!({}));
        let node = snap["nodes"].as_array().unwrap().iter().find(|n| n["title"] == "S").unwrap();
        assert_eq!(node["castPageIds"], json!([]), "an empty list clears them");
        assert_eq!(snap["nodeThreads"], json!([]));
    }

    #[test]
    fn a_fact_that_changes_at_a_scene_follows_that_scene() {
        let (engine, _dir) = project();
        let report = apply(
            &engine,
            json!({
                "pages": [{ "title": "Aria", "infobox": { "fields": [{
                    "key": "hair",
                    "label": "Hair",
                    "kind": "text",
                    "value": "Red",
                    "changes": [
                        { "nodeId": "scene-in-file", "value": "Grey", "note": "The long night." },
                        { "date": "Year 12", "value": "White" },
                        { "nodeId": "gone", "date": "Year 9", "value": "Black" }
                    ]
                }] } }],
                "books": [{ "title": "B", "children": [{ "kind": "chapter", "title": "C", "children": [
                    { "kind": "scene", "id": "scene-in-file", "title": "S" }
                ] }] }]
            }),
        );
        assert!(report["problems"].as_array().unwrap().iter().any(|p| p["field"] == "infobox.fields[0].changes[2].nodeId"));
        let snap = call(&engine, "snapshot.get", json!({}));
        let scene = snap["nodes"].as_array().unwrap().iter().find(|n| n["title"] == "S").unwrap();
        assert_ne!(scene["id"], "scene-in-file");
        let changes = page(&engine, "Aria")["infobox"]["fields"][0]["changes"].clone();
        assert_eq!(changes[0]["nodeId"], scene["id"]);
        assert_eq!(changes[0]["note"], "The long night.");
        assert_eq!(changes[1], json!({ "date": "Year 12", "value": "White" }));
        assert_eq!(changes[2]["nodeId"], Value::Null, "a scene that is gone is not pointed at");
        assert_eq!(changes[2]["date"], "Year 9");
    }

    #[test]
    fn a_book_keeps_its_publishing_details() {
        let (engine, _dir) = project();
        let id = call(&engine, "books.list", json!({}))[0]["id"].as_str().unwrap().to_string();
        call(&engine, "books.update", json!({ "id": id, "patch": { "publishing": { "series": "The Vale", "seriesNumber": "2" } } }));
        assert_eq!(call(&engine, "books.list", json!({}))[0]["publishing"]["series"], "The Vale");
        let refused = dispatch(&engine, "books.update", json!({ "id": id, "patch": { "publishing": "words" } }));
        assert_eq!(refused.unwrap_err().code, "INVALID");
    }

    #[test]
    fn preview_reports_what_apply_will_do_and_writes_nothing() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "T" }));
        make_existing_page(&engine, "Aria Vale", "Old text.");
        let target = dir.0.join("p.lorecraft");
        engine.allow_path(&target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        assert!(!engine.status().dirty);
        let before = fingerprint(&engine);

        let mut payload = world();
        payload["policy"] = json!("overwrite");
        let preview = call(&engine, "import.preview", payload.clone());
        assert_eq!(preview["applied"], false);
        assert_eq!(preview["counts"]["pagesOverwritten"], 1);
        assert_eq!(preview["counts"]["pagesCreated"], 1);
        assert_eq!(preview["items"][0]["action"], "overwrite");
        assert!(preview["items"][0].get("id").is_none(), "a dry run has no real ids");

        assert_eq!(fingerprint(&engine), before);
        assert!(!engine.status().dirty, "a preview changes nothing");

        let applied = apply(&engine, payload);
        assert_eq!(applied["counts"], preview["counts"]);
        assert_eq!(applied["applied"], true);
        assert!(engine.status().dirty);
    }

    #[test]
    fn the_skip_policy_leaves_existing_pages_alone() {
        let (engine, _dir) = project();
        make_existing_page(&engine, "aria vale", "Old text.");
        let report = apply(&engine, world());
        assert_eq!(report["counts"]["pagesSkipped"], 1);
        assert_eq!(report["counts"]["pagesCreated"], 1);
        assert_eq!(report["items"][0]["action"], "skip");
        let aria = page(&engine, "Aria Vale");
        assert_eq!(aria["content"], doc("Old text."));
        assert_eq!(aria["categories"], json!(["Old"]));
        // Skipped pages still count for references from the rest of the file.
        let snap = call(&engine, "snapshot.get", json!({}));
        assert_eq!(snap["relationships"][0]["fromPageId"], aria["id"]);
    }

    #[test]
    fn the_rename_policy_adds_a_suffix_and_links_in_the_file_follow_it() {
        let (engine, _dir) = project();
        make_existing_page(&engine, "Silver Vale", "Someone else's valley.");
        make_existing_page(&engine, "Silver Vale (2)", "Taken as well.");
        let mut payload = world();
        payload["policy"] = json!("rename");
        let report = apply(&engine, payload);
        assert_eq!(report["counts"]["pagesRenamed"], 1);
        assert_eq!(report["items"][1]["action"], "rename");
        assert_eq!(report["items"][1]["finalTitle"], "Silver Vale (3)");

        assert_eq!(page(&engine, "Silver Vale")["content"], doc("Someone else's valley."));
        assert_eq!(page(&engine, "Silver Vale (3)")["content"], doc("A cold valley."));
        let aria = page(&engine, "Aria Vale");
        assert_eq!(
            aria["content"]["content"][0]["content"][0]["marks"][0]["attrs"]["target"],
            "Silver Vale (3)",
            "the imported link goes to the imported page"
        );
        assert_eq!(aria["infobox"]["fields"][1]["value"], "Silver Vale (3)");
    }

    #[test]
    fn the_overwrite_policy_keeps_the_page_and_saves_history_first() {
        let (engine, _dir) = project();
        let existing = make_existing_page(&engine, "Aria Vale", "Old text.");
        let mut payload = world();
        payload["policy"] = json!("overwrite");
        // A file need not mention everything. What it leaves out stays.
        payload["pages"][0].as_object_mut().unwrap().remove("categories");
        let report = apply(&engine, payload);
        assert_eq!(report["counts"]["pagesOverwritten"], 1);
        assert_eq!(report["counts"]["revisionsTaken"], 1);

        let aria = page(&engine, "Aria Vale");
        assert_eq!(aria["id"], existing["id"], "the same page, so its links and history stay");
        assert_eq!(aria["status"], "canon");
        assert_eq!(aria["categories"], json!(["Old"]));
        let text = aria["content"]["content"][0]["content"][0]["text"].clone();
        assert_eq!(text, "the Vale");

        let history = call(&engine, "revisions.list", json!({ "kind": "page", "id": aria["id"] }));
        assert_eq!(history[0]["reason"], "import");
        let saved = call(&engine, "revisions.get", json!({ "id": history[0]["id"] }));
        assert_eq!(saved["content"], doc("Old text."));
    }

    #[test]
    fn importing_the_same_file_again_changes_nothing_under_skip_or_overwrite() {
        let (engine, _dir) = project();
        apply(&engine, world());
        let before = fingerprint(&engine);
        let mut skip = world();
        skip["policy"] = json!("skip");
        let report = apply(&engine, skip);
        assert_eq!(report["counts"]["pagesCreated"], 0);
        assert_eq!(report["counts"]["booksSkipped"], 1);
        assert_eq!(report["counts"]["relationshipsCreated"], 0);
        assert_eq!(fingerprint(&engine), before);

        let mut overwrite = world();
        overwrite["policy"] = json!("overwrite");
        let report = apply(&engine, overwrite);
        assert_eq!(report["counts"]["booksOverwritten"], 1);
        assert_eq!(report["counts"]["nodesCreated"], 0);
        assert_eq!(report["counts"]["nodesUpdated"], 5);
        assert_eq!(report["counts"]["nodesRemoved"], 0);
        let after = fingerprint(&engine);
        assert_eq!(after["pages"].as_array().unwrap().len(), before["pages"].as_array().unwrap().len());
        assert_eq!(after["nodes"].as_array().unwrap().len(), before["nodes"].as_array().unwrap().len());
        let ids = |v: &Value| -> Vec<Value> { v["nodes"].as_array().unwrap().iter().map(|n| n["id"].clone()).collect() };
        assert_eq!(ids(&after), ids(&before), "scenes keep their identity");
        assert_eq!(after["relationships"], before["relationships"]);
    }

    #[test]
    fn overwriting_a_book_updates_matching_scenes_and_trashes_the_rest() {
        let (engine, _dir) = project();
        apply(&engine, world());
        let books = call(&engine, "books.list", json!({}));
        let book = books[0]["id"].clone();
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let gate = tree.as_array().unwrap().iter().find(|n| n["title"] == "The Gate").unwrap().clone();
        let empty = tree.as_array().unwrap().iter().find(|n| n["title"] == "Empty").unwrap().clone();

        let report = apply(
            &engine,
            json!({
                "policy": "overwrite",
                "books": [{ "title": "the silver road", "children": [
                    { "kind": "part", "title": "Part One", "children": [
                        { "kind": "chapter", "title": "Arrival", "children": [
                            { "kind": "scene", "title": "New Scene", "content": doc("First now.") },
                            { "kind": "scene", "title": "The Gate", "content": doc("Rewritten.") }
                        ]}
                    ]}
                ]}]
            }),
        );
        assert_eq!(report["counts"]["booksOverwritten"], 1);
        assert_eq!(report["counts"]["nodesRemoved"], 1, "the interlude went away");
        assert_eq!(report["counts"]["revisionsTaken"], 1);

        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let list = tree.as_array().unwrap();
        let gate_now = list.iter().find(|n| n["id"] == gate["id"]).unwrap();
        assert_eq!(gate_now["position"], 1, "the file's order wins");
        assert_eq!(call(&engine, "nodes.get", json!({ "id": gate["id"] }))["content"], doc("Rewritten."));
        assert!(!list.iter().any(|n| n["id"] == empty["id"]));
        let trash = call(&engine, "nodes.trash", json!({ "bookId": book }));
        assert!(trash.as_array().unwrap().iter().any(|n| n["title"] == "Empty"));

        let history = call(&engine, "revisions.list", json!({ "kind": "node", "id": gate["id"] }));
        assert_eq!(history[0]["reason"], "import");
        let saved = call(&engine, "revisions.get", json!({ "id": history[0]["id"] }));
        assert_eq!(saved["contentText"], "Aria Vale rode to the gate.");
    }

    #[test]
    fn an_invalid_item_refuses_the_whole_import_and_names_the_item_and_field() {
        let (engine, _dir) = project();
        let before = fingerprint(&engine);
        let mut payload = world();
        payload["pages"][1]["status"] = json!("published");
        payload["books"][0]["children"][1]["kind"] = json!("scene");
        let report = apply(&engine, payload.clone());
        assert_eq!(report["applied"], false);
        let problems = report["problems"].as_array().unwrap();
        let status = problems.iter().find(|p| p["field"] == "status").unwrap();
        assert_eq!(status["severity"], "error");
        assert_eq!(status["item"], "pages[1] \"Silver Vale\"");
        assert!(status["message"].as_str().unwrap().contains("published"));
        let kind = problems.iter().find(|p| p["field"] == "kind").unwrap();
        assert!(kind["item"].as_str().unwrap().contains("children[1]"), "{kind}");
        assert!(kind["message"].as_str().unwrap().contains("a scene cannot go inside"));

        assert_eq!(fingerprint(&engine), before);
        assert!(call(&engine, "pages.getByTitle", json!({ "title": "Aria Vale" })).is_null());

        // A preview shows the same problems, and what the valid part would do.
        let preview = call(&engine, "import.preview", payload);
        assert_eq!(preview["counts"]["pagesCreated"], 1);
        assert!(preview["problems"].as_array().unwrap().iter().any(|p| p["field"] == "status"));
    }

    #[test]
    fn bad_values_of_every_kind_are_reported_by_field() {
        let (engine, _dir) = project();
        let report = apply(
            &engine,
            json!({
                "pages": [
                    { "title": "" },
                    { "title": 5 },
                    { "title": "Bad Types", "aliases": "not a list", "categories": [1], "isHome": "yes" },
                    { "title": "Bad Doc", "content": { "type": "doc", "content": [{ "type": "hologram" }] } },
                    { "title": "Not Doc", "content": "plain text is for the UI to convert" },
                    { "title": "Bad Mark", "content": { "type": "doc", "content": [{ "type": "paragraph", "content": [
                        { "type": "text", "text": "x", "marks": [{ "type": "glitter" }] }
                    ]}]}},
                    { "title": "Bad Box", "infobox": { "fields": [{ "value": "no key" }, { "key": "k", "kind": "colour" }] } },
                    { "title": "Twice" },
                    { "title": "twice" }
                ],
                "books": [
                    { "children": [] },
                    { "title": "B", "children": [{ "kind": "scene", "title": "Loose" }, { "kind": "volume" }] },
                    { "title": "C", "children": [{ "kind": "chapter", "content": doc("Chapters hold no text."), "children": [
                        { "kind": "scene", "children": [{ "kind": "scene" }] }
                    ]}] }
                ],
                "relationships": [{ "from": "", "to": "X" }],
                "assets": [{ "id": "a", "mime": "image/svg+xml", "base64": "AAEC" }, { "id": "b", "mime": "image/png", "base64": "%%%" }],
                "maps": [{ "title": "M", "pins": [{ "x": 2, "y": 0 }] }]
            }),
        );
        assert_eq!(report["applied"], false);
        let has = |item: &str, field: &str| -> bool {
            report["problems"].as_array().unwrap().iter().any(|p| {
                p["severity"] == "error"
                    && p["item"].as_str().unwrap().contains(item)
                    && p["field"].as_str().unwrap() == field
            })
        };
        assert!(has("pages[0]", "title"));
        assert!(has("pages[1]", "title"));
        assert!(has("Bad Types", "aliases"));
        assert!(has("Bad Types", "categories[0]"));
        assert!(has("Bad Types", "isHome"));
        assert!(has("Bad Doc", "content"));
        assert!(has("Not Doc", "content"));
        assert!(has("Bad Mark", "content"));
        assert!(has("Bad Box", "infobox.fields[0].key"));
        assert!(has("Bad Box", "infobox.fields[1].kind"));
        assert!(has("pages[8]", "title"), "a repeated title names the later page");
        assert!(has("books[0]", "title"));
        assert!(has("children[0]", "kind"), "a scene at the top level");
        assert!(has("children[1]", "kind"), "an unknown kind");
        assert!(has("children[0]", "content"), "a chapter holding text");
        assert!(has("children[0]", "children"), "a scene holding a scene");
        assert!(has("relationships[0]", "from"));
        assert!(has("assets[0]", "mime"));
        assert!(has("assets[1]", "base64"));
        assert!(has("maps[0]", "pins[0]"));
        assert!(!call(&engine, "pages.titles", json!({})).as_array().unwrap().iter().any(|p| p["title"] == "Twice"));
    }

    #[test]
    fn a_failure_partway_through_rolls_everything_back() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "T" }));
        make_existing_page(&engine, "Aria Vale", "Old text.");
        let target = dir.0.join("r.lorecraft");
        engine.allow_path(&target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        // Valid to the validator, so the failure comes from the database partway through
        // writing, after every page and an overwrite have already happened.
        engine
            .read(|c| {
                c.execute_batch(
                    "CREATE TEMP TRIGGER boom BEFORE INSERT ON nodes WHEN NEW.title = 'The Gate'
                     BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;",
                )?;
                Ok(())
            })
            .unwrap();
        let before = fingerprint(&engine);
        let revisions_before = call(
            &engine,
            "revisions.list",
            json!({ "kind": "page", "id": before["pages"][0]["id"] }),
        );

        let mut payload = world();
        payload["policy"] = json!("overwrite");
        let error = dispatch(&engine, "import.apply", payload).unwrap_err();
        assert!(error.message.contains("simulated failure"), "{error}");

        assert_eq!(fingerprint(&engine), before, "nothing changed");
        assert!(call(&engine, "pages.getByTitle", json!({ "title": "Silver Vale" })).is_null());
        assert_eq!(page(&engine, "Aria Vale")["content"], doc("Old text."));
        let revisions_after = call(
            &engine,
            "revisions.list",
            json!({ "kind": "page", "id": before["pages"][0]["id"] }),
        );
        assert_eq!(revisions_after, revisions_before, "the checkpoint went too");
        assert!(call(&engine, "search.query", json!({ "q": "valley" })).as_array().unwrap().is_empty());
        assert!(!engine.status().dirty, "a failed import does not dirty a clean project");
    }

    #[test]
    fn problems_with_references_warn_and_the_rest_goes_ahead() {
        let (engine, _dir) = project();
        let report = apply(
            &engine,
            json!({
                "pages": [{
                    "title": "Lonely",
                    "revealNodeId": "no-such-node",
                    "createdAt": "last Tuesday",
                    "content": { "type": "doc", "content": [{ "type": "image", "attrs": { "assetId": "ghost", "alt": "x" } }] },
                    "infobox": { "imageAssetId": "ghost2", "fields": [] }
                }],
                "books": [{ "title": "B", "children": [{ "kind": "chapter", "title": "C", "children": [
                    { "kind": "scene", "title": "S", "pov": "Nobody" }
                ]}] }],
                "relationships": [{ "from": "Lonely", "to": "Nobody" }]
            }),
        );
        assert_eq!(report["applied"], true);
        assert_eq!(report["counts"]["pagesCreated"], 1);
        assert_eq!(report["counts"]["relationshipsSkipped"], 1);
        let fields: Vec<&str> = report["problems"]
            .as_array()
            .unwrap()
            .iter()
            .inspect(|p| assert_eq!(p["severity"], "warning"))
            .map(|p| p["field"].as_str().unwrap())
            .collect();
        for expected in ["revealNodeId", "createdAt", "content", "infobox.imageAssetId", "pov", "to"] {
            assert!(fields.contains(&expected), "{expected} in {fields:?}");
        }
    }

    #[test]
    fn assets_keep_their_ids_are_not_duplicated_and_can_come_from_a_chosen_folder() {
        let (engine, _dir) = project();
        let image = json!({ "type": "doc", "content": [{ "type": "image", "attrs": { "assetId": "pic", "alt": "A map" } }] });
        let payload = json!({
            "assets": [{ "id": "pic", "name": "map.png", "mime": "image/png", "base64": b64(&png(&[1])), "width": 10, "height": 20 }],
            "pages": [{ "title": "With Image", "content": image, "infobox": { "imageAssetId": "pic", "fields": [] } }]
        });
        let report = apply(&engine, payload.clone());
        assert_eq!(report["counts"]["assetsCreated"], 1);
        assert_eq!(stored(&engine, "pic"), png(&[1]));
        let info = call(&engine, "media.get", json!({ "id": "pic" }));
        assert_eq!(info["width"], 10);
        assert_eq!(info["mime"], "image/png");
        assert_eq!(info["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(page(&engine, "With Image")["infobox"]["imageAssetId"], "pic");

        // The same bytes under another key are reused, and the document follows.
        let image2 = json!({ "type": "doc", "content": [{ "type": "image", "attrs": { "assetId": "other", "alt": "" } }] });
        let report = apply(
            &engine,
            json!({
                "assets": [{ "id": "other", "name": "copy.png", "mime": "image/png", "base64": b64(&png(&[1])) }],
                "pages": [{ "title": "Copy", "content": image2 }]
            }),
        );
        assert_eq!(report["counts"]["assetsReused"], 1);
        assert_eq!(report["counts"]["assetsCreated"], 0);
        assert_eq!(page(&engine, "Copy")["content"]["content"][0]["attrs"]["assetId"], "pic");

        // Different bytes under a key that is taken get a new id.
        let image3 = json!({ "type": "doc", "content": [{ "type": "image", "attrs": { "assetId": "pic", "alt": "" } }] });
        apply(
            &engine,
            json!({
                "assets": [{ "id": "pic", "name": "new.png", "mime": "image/png", "base64": b64(&png(&[2])) }],
                "pages": [{ "title": "New Pic", "content": image3 }]
            }),
        );
        let new_id = page(&engine, "New Pic")["content"]["content"][0]["attrs"]["assetId"].clone();
        assert_ne!(new_id, "pic");
        assert_eq!(stored(&engine, new_id.as_str().unwrap()), png(&[2]));
        assert_eq!(stored(&engine, "pic"), png(&[1]));
    }

    #[test]
    fn asset_files_must_be_inside_a_folder_the_user_chose() {
        let (engine, host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let folder = dir.0.join("vault");
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("pic.png");
        std::fs::write(&file, png(&[1, 2, 3])).unwrap();
        let payload = json!({
            "assets": [{ "id": "k", "name": "pic.png", "mime": "image/png", "path": file }],
            "pages": [{ "title": "P" }]
        });
        let refused = apply(&engine, payload.clone());
        assert_eq!(refused["applied"], false);
        assert_eq!(refused["problems"][0]["field"], "path");

        host.next_picks.lock().unwrap().push(folder);
        dispatch(&engine, "files.pickFolder", json!({})).unwrap();
        let accepted = apply(&engine, payload);
        assert_eq!(accepted["applied"], true);
        assert_eq!(stored(&engine, "k"), png(&[1, 2, 3]));
    }

    #[test]
    fn videos_of_any_size_come_in_but_impostors_and_vast_pictures_stay_out() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let folder = dir.0.join("vault");
        std::fs::create_dir_all(&folder).unwrap();
        engine.allow_path(&folder);

        // Past one chunk, and past what the import would once have taken, read from disk.
        let film_size = 2 * media::CHUNK_SIZE as u64 + 5;
        let film = folder.join("film.mp4");
        std::fs::write(&film, mp4(&[1, 2, 3])).unwrap();
        std::fs::OpenOptions::new().write(true).open(&film).unwrap().set_len(film_size).unwrap();

        let vast = folder.join("vast.png");
        std::fs::write(&vast, png(&[1])).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&vast)
            .unwrap()
            .set_len(media::MAX_IMAGE_BYTES + 1)
            .unwrap();

        let page_with = |id: &str| {
            json!({ "type": "figure", "attrs": { "kind": "video", "align": "full" }, "content": [
                { "type": "video", "attrs": { "assetId": id } },
                { "type": "figcaption" }
            ]})
        };
        let report = apply(
            &engine,
            json!({
                "assets": [
                    { "id": "clip", "name": "clip.mp4", "mime": "video/mp4", "base64": b64(&mp4(&[9])) },
                    { "id": "film", "name": "film.mp4", "mime": "video/mp4", "path": film },
                    { "id": "vast", "name": "vast.png", "mime": "image/png", "path": vast },
                    { "id": "fake", "name": "fake.png", "mime": "image/png", "base64": b64(b"<html><script></script></html>") },
                    { "id": "lie", "name": "lie.png", "mime": "image/png", "base64": b64(&mp4(&[1])) }
                ],
                "pages": [{ "title": "With Video", "content": { "type": "doc", "content": [
                    page_with("clip"), page_with("film"), page_with("vast")
                ]}}]
            }),
        );
        assert_eq!(report["applied"], true, "{report}");
        assert_eq!(report["counts"]["assetsCreated"], 2);
        let problems = report["problems"].as_array().unwrap();
        let about = |name: &str| problems.iter().any(|p| p["item"].as_str().unwrap().contains(name));
        assert!(about("vast.png") && about("fake.png") && about("lie.png"), "{problems:?}");
        assert!(!about("film.mp4"), "{problems:?}");
        assert_eq!(stored(&engine, "clip"), mp4(&[9]));

        let info = call(&engine, "media.get", json!({ "id": "film" }));
        assert_eq!(info["size"], film_size);
        assert_eq!(info["kind"], "video");
        let chunks: i64 = engine
            .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM asset_chunks WHERE asset_id = 'film'", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(chunks, 3);
        assert_eq!(&stored(&engine, "film")[..15], &mp4(&[1, 2, 3])[..15]);
    }

    #[test]
    fn a_preview_stores_no_bytes_and_leaves_nothing_behind() {
        let (engine, _dir) = project();
        let report = call(
            &engine,
            "import.preview",
            json!({
                "assets": [{ "id": "p", "name": "p.png", "mime": "image/png", "base64": b64(&png(&[7])) }],
                "pages": [{ "title": "P" }]
            }),
        );
        assert_eq!(report["counts"]["assetsCreated"], 1);
        assert_eq!(call(&engine, "media.list", json!({})).as_array().unwrap().len(), 0);
    }

    #[test]
    fn scenes_can_be_added_to_an_existing_chapter() {
        let (engine, _dir) = project();
        let books = call(&engine, "books.list", json!({}));
        let book = books[0]["id"].clone();
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let chapter = tree.as_array().unwrap().iter().find(|n| n["kind"] == "chapter").unwrap().clone();
        let report = apply(
            &engine,
            json!({ "books": [{
                "intoBookId": book,
                "intoParentId": chapter["id"],
                "children": [{ "kind": "scene", "title": "Pasted", "content": doc("Words.") }]
            }]}),
        );
        assert_eq!(report["counts"]["booksExtended"], 1);
        assert_eq!(report["counts"]["nodesCreated"], 1);
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let list = tree.as_array().unwrap();
        assert!(list.iter().any(|n| n["title"] == "Pasted" && n["parentId"] == chapter["id"]));
        assert_eq!(call(&engine, "books.list", json!({})).as_array().unwrap().len(), 1);

        // A scene cannot go straight into a part, however it arrives.
        let part = call(&engine, "nodes.create", json!({ "bookId": book, "kind": "part", "title": "P" }));
        let err = dispatch(
            &engine,
            "import.apply",
            json!({ "books": [{ "intoBookId": book, "intoParentId": part["id"], "children": [{ "kind": "scene" }] }] }),
        )
        .unwrap_err();
        assert_eq!(err.code, "BAD_PLACEMENT");
        assert!(!call(&engine, "nodes.tree", json!({ "bookId": book })).as_array().unwrap().iter().any(|n| n["kind"] == "scene" && n["parentId"] == part["id"]));
    }

    #[test]
    fn a_new_project_gives_way_to_an_imported_main_page_and_book() {
        let (engine, _dir) = project();
        let starter = call(&engine, "pages.home", json!({}));
        let report = apply(
            &engine,
            json!({
                "pages": [{ "title": "Welcome to the Vale", "isHome": true, "content": doc("Front door.") }],
                "books": [{ "title": "Real Book" }]
            }),
        );
        assert_eq!(report["notes"].as_array().unwrap().len(), 2);
        let home = call(&engine, "pages.home", json!({}));
        assert_eq!(home["title"], "Welcome to the Vale");
        assert_ne!(home["id"], starter["id"]);
        assert_eq!(titles(&engine), vec!["Welcome to the Vale"]);
        let books = call(&engine, "books.list", json!({}));
        assert_eq!(books.as_array().unwrap().len(), 1);
        assert_eq!(books[0]["title"], "Real Book");
        assert_eq!(books[0]["position"], 0);
    }

    #[test]
    fn showing_the_starter_page_does_not_make_it_the_writers_own() {
        let (engine, _dir) = project();
        // Opening a page can save it again, with the same words and an empty last paragraph.
        let home = call(&engine, "pages.home", json!({}));
        let mut content = home["content"].clone();
        content["content"].as_array_mut().unwrap().push(json!({ "type": "paragraph" }));
        call(&engine, "pages.update", json!({ "id": home["id"], "patch": { "content": content } }));
        let books = call(&engine, "books.list", json!({}));
        let tree = call(&engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap().clone();
        call(&engine, "nodes.update", json!({ "id": scene["id"], "patch": { "content": { "type": "doc", "content": [{ "type": "paragraph" }] } } }));

        apply(&engine, json!({ "pages": [{ "title": "Front Door", "isHome": true }], "books": [{ "title": "Mine" }] }));
        assert_eq!(call(&engine, "pages.home", json!({}))["title"], "Front Door");
        let books = call(&engine, "books.list", json!({}));
        assert_eq!(books.as_array().unwrap().len(), 1);
        assert_eq!(books[0]["title"], "Mine");
    }

    #[test]
    fn a_page_titled_main_page_takes_over_from_the_starter_page() {
        let (engine, _dir) = project();
        apply(&engine, json!({ "pages": [{ "title": "main page", "content": doc("Mine.") }] }));
        let home = call(&engine, "pages.home", json!({}));
        assert_eq!(home["title"], "main page");
        assert_eq!(home["content"], doc("Mine."));
    }

    #[test]
    fn an_edited_main_page_and_book_are_never_replaced() {
        let (engine, _dir) = project();
        let home = call(&engine, "pages.home", json!({}));
        call(&engine, "pages.update", json!({ "id": home["id"], "patch": { "content": doc("My own words.") } }));
        let books = call(&engine, "books.list", json!({}));
        let tree = call(&engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap().clone();
        call(&engine, "nodes.update", json!({ "id": scene["id"], "patch": { "content": doc("Once upon a time.") } }));

        let report = apply(
            &engine,
            json!({
                "pages": [{ "title": "Other Home", "isHome": true }],
                "books": [{ "title": "Second Book" }]
            }),
        );
        let home_now = call(&engine, "pages.home", json!({}));
        assert_eq!(home_now["id"], home["id"]);
        assert_eq!(home_now["content"], doc("My own words."));
        assert!(page(&engine, "Other Home")["isHome"] == false);
        assert_eq!(report["problems"][0]["field"], "isHome");
        let books = call(&engine, "books.list", json!({}));
        assert_eq!(books.as_array().unwrap().len(), 2);
        assert_eq!(books[0]["title"], "Book One");
    }

    #[test]
    fn maps_prompts_dictionary_and_meta_come_across() {
        let (engine, _dir) = project();
        let report = apply(
            &engine,
            json!({
                "pages": [{ "title": "Keep" }],
                "assets": [{ "id": "m", "name": "m.png", "mime": "image/png", "base64": b64(&png(&[3])) }],
                "maps": [{ "title": "The North", "assetId": "m", "pins": [
                    { "page": "Keep", "label": "Keep", "x": 0.25, "y": 0.5 },
                    { "label": "Unnamed", "x": 0, "y": 1 }
                ]}],
                "dictionary": ["Aelindor", "  ", "aelindor"],
                "prompts": [{ "name": "Tone", "template": "Rewrite: {{text}}", "scope": "selection" }],
                "meta": { "wiki.theme": "ash", "name": "Not this", "project_id": "nor this" }
            }),
        );
        assert_eq!(report["counts"]["mapsCreated"], 1);
        assert_eq!(report["counts"]["dictionaryAdded"], 1);
        assert_eq!(report["counts"]["promptsCreated"], 1);
        let snap = call(&engine, "snapshot.get", json!({}));
        assert_eq!(snap["maps"][0]["title"], "The North");
        assert_eq!(snap["maps"][0]["assetId"], "m");
        assert_eq!(snap["maps"][0]["pins"].as_array().unwrap().len(), 2);
        assert_eq!(snap["maps"][0]["pins"][0]["pageId"], page(&engine, "Keep")["id"]);
        assert_eq!(snap["dictionary"], json!(["Aelindor"]));
        assert_eq!(snap["prompts"][0]["name"], "Tone");
        assert_eq!(snap["meta"]["wiki.theme"], "ash");
        assert_eq!(snap["meta"]["name"], "T");
        assert_ne!(snap["meta"]["project_id"], "nor this");

        // Importing again changes nothing, and overwriting replaces the pins.
        let again = apply(
            &engine,
            json!({ "policy": "overwrite", "maps": [{ "title": "The North", "pins": [{ "label": "Only", "x": 0.5, "y": 0.5 }] }] }),
        );
        assert_eq!(again["counts"]["mapsOverwritten"], 1);
        let snap = call(&engine, "snapshot.get", json!({}));
        assert_eq!(snap["maps"][0]["pins"].as_array().unwrap().len(), 1);
        assert_eq!(snap["maps"][0]["assetId"], "m", "left out, so left alone");
    }

    #[test]
    fn version_keys_and_scene_records_from_another_project_stay_out() {
        let (engine, _dir) = project();
        let before = call(&engine, "snapshot.get", json!({}))["meta"].clone();
        apply(
            &engine,
            json!({
                "pages": [{ "title": "Keep" }],
                "meta": {
                    "wiki.theme": "ash",
                    "min_reader_version": "99.0.0",
                    "written_by_version": "99.0.0",
                    "mergedInto:some-scene": "{\"into\":\"another\"}",
                    "splitFrom:some-scene": "{\"from\":\"another\"}",
                }
            }),
        );
        let meta = call(&engine, "snapshot.get", json!({}))["meta"].clone();
        assert_eq!(meta["wiki.theme"], "ash", "other settings still come across");
        // A newer version's minimum would make this version refuse the project once saved.
        assert_eq!(meta["min_reader_version"], before["min_reader_version"]);
        assert_eq!(meta["written_by_version"], before["written_by_version"]);
        assert!(meta.get("mergedInto:some-scene").is_none());
        assert!(meta.get("splitFrom:some-scene").is_none());
    }

    #[test]
    fn the_writing_log_stays_with_its_book_and_import_is_not_counted_as_writing() {
        let (engine, _dir) = project();
        apply(
            &engine,
            json!({ "books": [{
                "title": "Logged",
                "writingLog": [{ "day": "2024-03-01", "wordsAdded": 500, "wordsRemoved": 20 }],
                "children": [{ "kind": "chapter", "title": "C", "children": [
                    { "kind": "scene", "title": "S", "content": doc("Ten thousand imaginary words here.") }
                ]}]
            }]}),
        );
        let books = call(&engine, "books.list", json!({}));
        let stats = call(&engine, "nodes.stats", json!({ "bookId": books[0]["id"] }));
        assert_eq!(stats["words"], 5);
        assert_eq!(stats["writtenToday"], 0);
        assert_eq!(stats["days"][0]["day"], "2024-03-01");
        assert_eq!(stats["days"][0]["added"], 500);
    }

    #[test]
    fn mentions_cover_names_and_text_from_the_same_file() {
        let (engine, _dir) = project();
        // The scene comes after the page in processing, and the page text mentions a
        // page created after it, so only a rebuild at the end gets both right.
        apply(
            &engine,
            json!({
                "pages": [
                    { "title": "Alpha", "content": doc("Alpha knows Omega well.") },
                    { "title": "Omega", "content": doc("Nothing here.") }
                ],
                "books": [{ "title": "B", "children": [{ "kind": "chapter", "title": "C", "children": [
                    { "kind": "scene", "title": "S", "content": doc("Omega spoke.") }
                ]}]}]
            }),
        );
        let omega = page(&engine, "Omega");
        let back = call(&engine, "pages.backlinks", json!({ "id": omega["id"] }));
        assert_eq!(back["scenes"][0]["title"], "S");
        let snap = call(&engine, "snapshot.get", json!({}));
        let page_mentions = snap["mentions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["pageId"] == omega["id"] && m["sourceKind"] == "page")
            .count();
        assert_eq!(page_mentions, 1);
    }

    #[test]
    fn large_imports_finish_in_reasonable_time() {
        let (engine, _dir) = project();
        let pages: Vec<Value> = (0..2000)
            .map(|i| json!({ "title": format!("Page {i}"), "content": doc(&format!("Page {} mentions Page {}. Lorem ipsum dolor sit amet.", i, (i + 1) % 2000)) }))
            .collect();
        let start = std::time::Instant::now();
        let report = apply(&engine, json!({ "pages": pages }));
        let elapsed = start.elapsed();
        assert_eq!(report["counts"]["pagesCreated"], 2000);
        // Far slower than expected, but well under what a page-by-page rebuild would take.
        assert!(elapsed.as_secs() < 60, "took {elapsed:?}");
        eprintln!("imported 2000 pages in {elapsed:?}");
    }

    #[test]
    fn local_only_marks_come_back_and_an_import_never_clears_one() {
        let (engine, _dir) = project();
        let marked = |chapter_local: bool, scene_local: bool, page_local: bool| {
            json!({
                "pages": [{ "title": "Secret Mill", "localOnly": page_local, "content": doc("The vault.") }],
                "books": [{ "title": "Private Road", "children": [
                    { "kind": "chapter", "title": "Hidden", "localOnly": chapter_local, "children": [
                        { "kind": "scene", "title": "Quiet", "localOnly": scene_local, "content": doc("Shh.") },
                        { "kind": "scene", "title": "Open", "content": doc("Hello.") }
                    ]}
                ]}]
            })
        };
        let report = apply(&engine, marked(true, true, true));
        assert_eq!(report["applied"], true, "{report}");
        assert!(report["problems"].as_array().unwrap().is_empty(), "{report}");
        assert_eq!(page(&engine, "Secret Mill")["localOnly"], true);
        let book = call(&engine, "books.list", json!({})).as_array().unwrap().iter().find(|b| b["title"] == "Private Road").unwrap()["id"].clone();
        let flags = |engine: &Engine| -> HashMap<String, bool> {
            let tree = call(engine, "nodes.tree", json!({ "bookId": book }));
            tree.as_array().unwrap().iter().map(|n| {
                let full = call(engine, "nodes.get", json!({ "id": n["id"] }));
                (n["title"].as_str().unwrap().to_string(), full["localOnly"] == true)
            }).collect()
        };
        let now = flags(&engine);
        assert_eq!((now["Hidden"], now["Quiet"], now["Open"]), (true, true, false));

        // Overwriting with a file that says otherwise keeps the marks: clearing one by mistake
        // would send private text to a cloud AI.
        let mut again = marked(false, false, false);
        again["policy"] = json!("overwrite");
        assert_eq!(apply(&engine, again)["applied"], true);
        assert_eq!(page(&engine, "Secret Mill")["localOnly"], true);
        let now = flags(&engine);
        assert_eq!((now["Hidden"], now["Quiet"], now["Open"]), (true, true, false));

        // And it can add a mark to something that has none.
        let mut add = marked(false, false, false);
        add["policy"] = json!("overwrite");
        add["books"][0]["children"][0]["children"][1]["localOnly"] = json!(true);
        assert_eq!(apply(&engine, add)["applied"], true);
        assert!(flags(&engine)["Open"]);

        let mut wrong = marked(false, false, false);
        wrong["pages"][0]["localOnly"] = json!("yes");
        let report = apply(&engine, wrong);
        assert_eq!(report["applied"], false);
        assert_eq!(report["problems"][0]["field"], "localOnly");
    }

    #[test]
    fn nothing_is_read_without_a_project() {
        let (engine, _host, _dir) = Engine::for_test();
        assert_eq!(dispatch(&engine, "import.apply", json!({ "pages": [{ "title": "X" }] })).unwrap_err().code, "NO_PROJECT");
        assert_eq!(dispatch(&engine, "import.preview", json!({})).unwrap_err().code, "NO_PROJECT");
        assert_eq!(dispatch(&engine, "import.nope", json!({})).unwrap_err().code, "UNKNOWN_METHOD");
        let (engine, _dir) = project();
        assert_eq!(dispatch(&engine, "import.apply", json!({ "policy": "merge" })).unwrap_err().code, "INVALID");
        assert_eq!(dispatch(&engine, "import.apply", json!([])).unwrap_err().code, "INVALID");
    }
}
