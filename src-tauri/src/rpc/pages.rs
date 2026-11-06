//! The wiki backend.

use std::collections::HashMap;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{family, ok, parse, project::doc_or_empty, revisions, unknown};
use crate::content::{self, title_key, Extracted};
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::indexing::{self, MentionMatcher, KIND_NODE, KIND_PAGE};

pub(crate) const STATUSES: [&str; 4] = ["canon", "draft", "idea", "retconned"];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    pub id: String,
    pub title: String,
    pub page_type: String,
    pub status: String,
    pub summary: String,
    pub word_count: i64,
    pub is_home: bool,
    pub local_only: bool,
    pub reveal_node_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub aliases: Vec<String>,
    pub categories: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    #[serde(flatten)]
    pub meta: PageMeta,
    pub content: Value,
    pub infobox: Value,
    pub notes: Value,
}

const META_COLS: &str = "id, title, page_type, status, summary, word_count, is_home, \
                         reveal_node_id, created_at, updated_at, deleted_at, local_only";

fn meta_from_row(r: &Row) -> rusqlite::Result<PageMeta> {
    Ok(PageMeta {
        id: r.get(0)?,
        title: r.get(1)?,
        page_type: r.get(2)?,
        status: r.get(3)?,
        summary: r.get(4)?,
        word_count: r.get(5)?,
        is_home: r.get::<_, i64>(6)? != 0,
        local_only: r.get::<_, i64>(11)? != 0,
        reveal_node_id: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        deleted_at: r.get(10)?,
        aliases: Vec::new(),
        categories: Vec::new(),
    })
}

fn string_column(conn: &Connection, sql: &str, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map([id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn fill_tags(conn: &Connection, meta: &mut PageMeta) -> AppResult<()> {
    meta.aliases = string_column(
        conn,
        "SELECT alias FROM page_aliases WHERE page_id = ?1 ORDER BY alias",
        &meta.id,
    )?;
    meta.categories = string_column(
        conn,
        "SELECT category FROM page_categories WHERE page_id = ?1 ORDER BY category",
        &meta.id,
    )?;
    Ok(())
}

fn parse_json(text: &str, fallback: Value) -> Value {
    serde_json::from_str(text).unwrap_or(fallback)
}

/// A page's metadata, without reading its document. This is what the hot paths need.
fn get_meta(conn: &Connection, id: &str) -> AppResult<PageMeta> {
    let sql = format!("SELECT {META_COLS} FROM pages WHERE id = ?1");
    let mut meta = conn
        .query_row(&sql, [id], meta_from_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("That page"))?;
    fill_tags(conn, &mut meta)?;
    Ok(meta)
}

pub fn get_page(conn: &Connection, id: &str) -> AppResult<Page> {
    let sql = format!("SELECT {META_COLS}, content, infobox, notes FROM pages WHERE id = ?1");
    let row = conn
        .query_row(&sql, [id], |r| {
            Ok((
                meta_from_row(r)?,
                r.get::<_, String>(12)?,
                r.get::<_, String>(13)?,
                r.get::<_, String>(14)?,
            ))
        })
        .optional()?;
    let Some((mut meta, content, infobox, notes)) = row else {
        return Err(AppError::not_found("That page"));
    };
    fill_tags(conn, &mut meta)?;
    Ok(Page {
        meta,
        content: parse_json(&content, content::empty_doc()),
        infobox: parse_json(&infobox, json!({ "fields": [] })),
        notes: if notes.is_empty() {
            Value::Null
        } else {
            parse_json(&notes, Value::Null)
        },
    })
}

// ---- Infoboxes -------------------------------------------------------------

fn infobox_fields(infobox: &Value) -> impl Iterator<Item = &Value> {
    infobox
        .get("fields")
        .and_then(Value::as_array)
        .map(|fields| fields.iter())
        .into_iter()
        .flatten()
}

fn field_str<'a>(field: &'a Value, name: &str) -> &'a str {
    field.get(name).and_then(Value::as_str).unwrap_or("")
}

/// What a field becomes during the story. See `FieldChange` in `src/lib/facts.ts`.
fn field_changes(field: &Value) -> impl Iterator<Item = &Value> {
    field
        .get("changes")
        .and_then(Value::as_array)
        .map(|changes| changes.iter())
        .into_iter()
        .flatten()
}

/// Titles an infobox points at. `page` holds one title and `pages` a comma-separated
/// list, so a red link in an infobox is as wanted as one in the article.
pub fn infobox_targets(infobox: &Value) -> Vec<String> {
    let mut targets = Vec::new();
    for field in infobox_fields(infobox) {
        // A value a field takes on later in the story is as much a link as its first.
        let later = field_changes(field).map(|change| field_str(change, "value"));
        for value in std::iter::once(field_str(field, "value")).chain(later) {
            match field_str(field, "kind") {
                "page" => targets.push(value.trim().to_string()),
                "pages" => targets.extend(value.split(',').map(|t| t.trim().to_string())),
                _ => {}
            }
        }
    }
    targets.retain(|t| !t.is_empty());
    targets
}

/// Points an infobox's page fields at a new title. Returns whether anything changed.
fn rewrite_infobox_targets(infobox: &mut Value, old_key: &str, new_title: &str) -> bool {
    let Some(fields) = infobox.get_mut("fields").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for field in fields {
        let kind = field_str(field, "kind").to_string();
        changed |= rewrite_target(field, &kind, old_key, new_title);
        if let Some(later) = field.get_mut("changes").and_then(Value::as_array_mut) {
            for change in later {
                changed |= rewrite_target(change, &kind, old_key, new_title);
            }
        }
    }
    changed
}

/// Rewrites one `value`, in a field or in a change to it, if it points at the old title.
fn rewrite_target(holder: &mut Value, kind: &str, old_key: &str, new_title: &str) -> bool {
    let value = field_str(holder, "value").to_string();
    let rewritten = match kind {
        "page" if title_key(&value) == old_key => new_title.to_string(),
        "pages" if value.split(',').any(|t| title_key(t) == old_key) => value
            .split(',')
            .map(|t| {
                if title_key(t) == old_key {
                    new_title
                } else {
                    t.trim()
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
        _ => return false,
    };
    holder["value"] = json!(rewritten);
    true
}

/// Moves changes to infobox fields from one scene to another, for when its text moves there.
pub fn repoint_change_scenes(conn: &Connection, from: &str, to: &str) -> AppResult<()> {
    let mut stmt = conn.prepare("SELECT id, infobox FROM pages WHERE instr(infobox, ?1) > 0")?;
    let rows = stmt.query_map([from], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let holders: Vec<(String, String)> = rows.collect::<Result<_, _>>()?;
    for (id, text) in holders {
        let mut infobox = parse_json(&text, json!({ "fields": [] }));
        let mut moved = false;
        let fields = infobox.get_mut("fields").and_then(Value::as_array_mut);
        for field in fields.into_iter().flatten() {
            let changes = field.get_mut("changes").and_then(Value::as_array_mut);
            for change in changes.into_iter().flatten() {
                if change.get("nodeId").and_then(Value::as_str) == Some(from) {
                    change["nodeId"] = json!(to);
                    moved = true;
                }
            }
        }
        if moved {
            conn.execute("UPDATE pages SET infobox = ?1 WHERE id = ?2", params![infobox.to_string(), id])?;
        }
    }
    Ok(())
}

/// What a page contributes to the link graph and name detection: the article, plus
/// links in its infobox. Infobox text does not count towards the word count.
pub fn extract_page(doc: &Value, infobox: &Value) -> Extracted {
    let mut extracted = content::extract(doc);
    for target in infobox_targets(infobox) {
        extracted.links.entry(title_key(&target)).or_insert(target);
    }
    extracted
}

/// The search index also covers what a reader sees around the article, so looking up
/// an alias or an infobox value finds the page.
fn search_body(
    conn: &Connection,
    id: &str,
    text: &str,
    summary: &str,
    infobox: &Value,
) -> AppResult<String> {
    let aliases = string_column(
        conn,
        "SELECT alias FROM page_aliases WHERE page_id = ?1 ORDER BY alias",
        id,
    )?;
    let mut body = String::with_capacity(text.len() + summary.len() + 64);
    body.push_str(text);
    let mut add = |line: &str| {
        if !line.is_empty() {
            body.push('\n');
            body.push_str(line);
        }
    };
    add(summary);
    add(&aliases.join(", "));
    for field in infobox_fields(infobox) {
        let later = field_changes(field).map(|change| field_str(change, "value"));
        for value in std::iter::once(field_str(field, "value")).chain(later) {
            if !value.is_empty() {
                add(&format!("{}: {value}", field_str(field, "label")));
            }
        }
    }
    Ok(body)
}

/// Recomputes everything derived from a stored page. Callers that change several
/// pages build one matcher and pass it in, since building it reads every name.
pub fn reindex_page(conn: &Connection, matcher: &MentionMatcher, id: &str) -> AppResult<()> {
    let (title, doc, infobox, summary): (String, String, String, String) = conn.query_row(
        "SELECT title, content, infobox, summary FROM pages WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let doc = parse_json(&doc, content::empty_doc());
    let infobox = parse_json(&infobox, json!({ "fields": [] }));
    let extracted = extract_page(&doc, &infobox);
    conn.execute(
        "UPDATE pages SET content_text = ?1, word_count = ?2 WHERE id = ?3",
        params![extracted.text, extracted.word_count, id],
    )?;
    let body = search_body(conn, id, &extracted.text, &summary, &infobox)?;
    indexing::sync_with(conn, matcher, KIND_PAGE, id, &title, &extracted, &body)
}

/// Rewrites only a page's search entry, after a change that leaves its text alone.
fn reindex_search(conn: &Connection, id: &str) -> AppResult<()> {
    let (title, text, infobox, summary): (String, String, String, String) = conn.query_row(
        "SELECT title, content_text, infobox, summary FROM pages WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let infobox = parse_json(&infobox, json!({ "fields": [] }));
    let body = search_body(conn, id, &text, &summary, &infobox)?;
    indexing::write_search(conn, KIND_PAGE, id, &title, &body)
}

/// Finds a live page by title or alias.
pub fn resolve_title(conn: &Connection, title: &str) -> AppResult<Option<String>> {
    let key = title_key(title);
    let by_title = conn
        .query_row(
            "SELECT id FROM pages WHERE title_key = ?1 AND deleted_at IS NULL",
            [&key],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    if by_title.is_some() {
        return Ok(by_title);
    }
    Ok(conn
        .query_row(
            "SELECT a.page_id FROM page_aliases a JOIN pages p ON p.id = a.page_id
             WHERE a.alias_key = ?1 AND p.deleted_at IS NULL
             ORDER BY p.title LIMIT 1",
            [&key],
            |r| r.get::<_, String>(0),
        )
        .optional()?)
}

fn check_status(status: &str) -> AppResult<()> {
    if STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(AppError::invalid(format!("Unknown status: {status}")))
    }
}

fn clean_title(title: &str) -> AppResult<String> {
    let cleaned = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return Err(AppError::invalid("A page needs a title."));
    }
    Ok(cleaned)
}

fn title_taken(conn: &Connection, key: &str, except: Option<&str>) -> AppResult<bool> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM pages WHERE title_key = ?1 AND deleted_at IS NULL",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(existing.is_some_and(|id| Some(id.as_str()) != except))
}

fn set_aliases(conn: &Connection, page_id: &str, aliases: &[String]) -> AppResult<()> {
    let own_key: String =
        conn.query_row("SELECT title_key FROM pages WHERE id = ?1", [page_id], |r| r.get(0))?;
    conn.execute("DELETE FROM page_aliases WHERE page_id = ?1", [page_id])?;
    for alias in aliases {
        let cleaned = alias.split_whitespace().collect::<Vec<_>>().join(" ");
        let key = title_key(&cleaned);
        // A page's own title as an alias would only be noise.
        if cleaned.is_empty() || key == own_key {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO page_aliases (page_id, alias, alias_key) VALUES (?1, ?2, ?3)",
            params![page_id, cleaned, key],
        )?;
    }
    Ok(())
}

fn set_categories(conn: &Connection, page_id: &str, categories: &[String]) -> AppResult<()> {
    conn.execute("DELETE FROM page_categories WHERE page_id = ?1", [page_id])?;
    for category in categories {
        let cleaned = category.split_whitespace().collect::<Vec<_>>().join(" ");
        if cleaned.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO page_categories (page_id, category) VALUES (?1, ?2)",
            params![page_id, cleaned],
        )?;
    }
    Ok(())
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateInput {
    pub title: String,
    pub page_type: Option<String>,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub content: Option<Value>,
    pub infobox: Option<Value>,
    pub aliases: Vec<String>,
    pub categories: Vec<String>,
}

/// Inserts a page. Shared by `pages.create`, seeding and import.
pub fn create_page(conn: &Connection, input: CreateInput) -> AppResult<String> {
    let title = clean_title(&input.title)?;
    let key = title_key(&title);
    if title_taken(conn, &key, None)? {
        return Err(AppError::new(
            "TITLE_EXISTS",
            format!("A page called \"{title}\" already exists."),
        ));
    }
    let status = input.status.unwrap_or_else(|| "draft".to_string());
    check_status(&status)?;
    let doc = doc_or_empty(input.content);
    let infobox = input.infobox.unwrap_or_else(|| json!({ "fields": [] }));
    let extracted = extract_page(&doc, &infobox);
    let summary = input.summary.unwrap_or_default();
    let now = db::now();
    let id = db::new_id();
    conn.execute(
        "INSERT INTO pages (id, title, title_key, page_type, status, summary, content,
                            content_text, infobox, word_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            id,
            title,
            key,
            input.page_type.unwrap_or_else(|| "article".to_string()),
            status,
            summary,
            doc.to_string(),
            extracted.text,
            infobox.to_string(),
            extracted.word_count,
            now,
        ],
    )?;
    set_aliases(conn, &id, &input.aliases)?;
    set_categories(conn, &id, &input.categories)?;
    // A new name can appear in text that already exists, so every mention is recomputed.
    let matcher = MentionMatcher::build(conn)?;
    let body = search_body(conn, &id, &extracted.text, &summary, &infobox)?;
    indexing::sync_with(conn, &matcher, KIND_PAGE, &id, &title, &extracted, &body)?;
    indexing::refresh_mentions_of(conn, &matcher, &[&id])?;
    Ok(id)
}

/// What a new project's main page says.
pub(crate) fn seed_home_doc(project_name: &str) -> Value {
    json!({
        "type": "doc",
        "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "text": "Welcome to " },
                { "type": "text", "text": project_name, "marks": [{ "type": "bold" }] },
                { "type": "text", "text": ". This is your main page. Edit it into a front door for your world." }
            ]},
            { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Getting started" }] },
            { "type": "bulletList", "content": [
                { "type": "listItem", "content": [{ "type": "paragraph", "content": [
                    { "type": "text", "text": "Press Ctrl+N to create a page, or type [[ in the editor to link to one. Links to pages that do not exist yet appear in red. Click one to create it." }
                ]}]},
                { "type": "listItem", "content": [{ "type": "paragraph", "content": [
                    { "type": "text", "text": "Open Write to draft your novel in books, chapters and scenes." }
                ]}]},
                { "type": "listItem", "content": [{ "type": "paragraph", "content": [
                    { "type": "text", "text": "Select any text and choose Ask AI, or press Ctrl+Shift+A to open the AI pane." }
                ]}]}
            ]}
        ]
    })
}

pub fn seed_home(conn: &Connection, project_name: &str) -> AppResult<()> {
    let body = seed_home_doc(project_name);
    let id = create_page(
        conn,
        CreateInput {
            title: "Main Page".to_string(),
            page_type: Some("home".to_string()),
            status: Some("canon".to_string()),
            content: Some(body),
            ..Default::default()
        },
    )?;
    conn.execute("UPDATE pages SET is_home = 1 WHERE id = ?1", [&id])?;
    Ok(())
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Patch {
    page_type: Option<String>,
    status: Option<String>,
    summary: Option<String>,
    content: Option<Value>,
    infobox: Option<Value>,
    notes: Option<Value>,
    aliases: Option<Vec<String>>,
    categories: Option<Vec<String>>,
    /// `null` is not distinguishable here, so an empty string clears it.
    reveal_node_id: Option<String>,
    local_only: Option<bool>,
}

struct UpdateOutcome {
    meta: PageMeta,
    /// Something `pages.titles` returns has changed.
    titles_changed: bool,
    content_changed: bool,
}

fn update_page(conn: &Connection, id: &str, patch: Patch) -> AppResult<UpdateOutcome> {
    let current: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT title, page_type, status, summary FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((title, page_type, status, summary)) = current else {
        return Err(AppError::not_found("That page"));
    };
    let mut titles_changed = false;

    if patch.content.is_some() || patch.infobox.is_some() {
        revisions::auto_checkpoint(conn, KIND_PAGE, id)?;
    }
    if let Some(value) = patch.page_type.as_ref().filter(|v| **v != page_type) {
        conn.execute("UPDATE pages SET page_type = ?1 WHERE id = ?2", params![value, id])?;
        titles_changed = true;
    }
    if let Some(value) = patch.status.as_ref().filter(|v| **v != status) {
        check_status(value)?;
        conn.execute("UPDATE pages SET status = ?1 WHERE id = ?2", params![value, id])?;
        titles_changed = true;
    }
    let summary_changed = patch.summary.as_ref().is_some_and(|v| *v != summary);
    if let Some(value) = patch.summary.as_ref().filter(|_| summary_changed) {
        conn.execute("UPDATE pages SET summary = ?1 WHERE id = ?2", params![value, id])?;
        titles_changed = true;
    }
    if let Some(value) = &patch.notes {
        let text = if value.is_null() {
            String::new()
        } else {
            value.to_string()
        };
        conn.execute("UPDATE pages SET notes = ?1 WHERE id = ?2", params![text, id])?;
    }
    if let Some(value) = &patch.reveal_node_id {
        let stored = if value.is_empty() { None } else { Some(value) };
        conn.execute(
            "UPDATE pages SET reveal_node_id = ?1 WHERE id = ?2",
            params![stored, id],
        )?;
    }
    if let Some(value) = patch.local_only {
        conn.execute("UPDATE pages SET local_only = ?1 WHERE id = ?2", params![value as i64, id])?;
        titles_changed = true;
    }
    if let Some(aliases) = &patch.aliases {
        set_aliases(conn, id, aliases)?;
        titles_changed = true;
    }
    if let Some(categories) = &patch.categories {
        set_categories(conn, id, categories)?;
    }

    // Links come from the article and the infobox, so a change to either rewrites them.
    if patch.content.is_some() || patch.infobox.is_some() {
        let stored_doc;
        let doc = match &patch.content {
            Some(doc) => doc,
            None => {
                let text: String =
                    conn.query_row("SELECT content FROM pages WHERE id = ?1", [id], |r| r.get(0))?;
                stored_doc = parse_json(&text, content::empty_doc());
                &stored_doc
            }
        };
        let stored_infobox;
        let infobox = match &patch.infobox {
            Some(infobox) => infobox,
            None => {
                let text: String =
                    conn.query_row("SELECT infobox FROM pages WHERE id = ?1", [id], |r| r.get(0))?;
                stored_infobox = parse_json(&text, json!({ "fields": [] }));
                &stored_infobox
            }
        };
        let extracted = extract_page(doc, infobox);
        if patch.content.is_some() {
            conn.execute(
                "UPDATE pages SET content = ?1, content_text = ?2, word_count = ?3 WHERE id = ?4",
                params![doc.to_string(), extracted.text, extracted.word_count, id],
            )?;
        }
        if patch.infobox.is_some() {
            conn.execute(
                "UPDATE pages SET infobox = ?1 WHERE id = ?2",
                params![infobox.to_string(), id],
            )?;
        }
        let summary_now = patch.summary.as_deref().unwrap_or(&summary);
        let body = search_body(conn, id, &extracted.text, summary_now, infobox)?;
        let matcher = MentionMatcher::build(conn)?;
        indexing::sync_with(conn, &matcher, KIND_PAGE, id, &title, &extracted, &body)?;
    } else if summary_changed || patch.aliases.is_some() {
        reindex_search(conn, id)?;
    }
    if patch.aliases.is_some() {
        let matcher = MentionMatcher::build(conn)?;
        indexing::refresh_mentions_of(conn, &matcher, &[id])?;
    }
    conn.execute(
        "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
        params![db::now(), id],
    )?;
    Ok(UpdateOutcome {
        meta: get_meta(conn, id)?,
        titles_changed,
        content_changed: patch.content.is_some(),
    })
}

/// Applies a patch written as JSON, as `pages.update` does. Used by import.
pub(crate) fn patch_page(conn: &Connection, id: &str, patch: Value) -> AppResult<()> {
    update_page(conn, id, parse(patch)?).map(|_| ())
}

/// Tells open editors that documents changed underneath them, so they reload instead
/// of writing their older copy back. An editor listens for `doc:<kind>:<id>`.
pub fn notify_replaced<'a>(
    engine: &Engine,
    documents: impl IntoIterator<Item = &'a (String, String)>,
) {
    let (mut pages, mut nodes) = (false, false);
    for (kind, id) in documents {
        engine.notify(&format!("doc:{kind}:{id}"));
        pages |= kind == KIND_PAGE;
        nodes |= kind == KIND_NODE;
    }
    if pages {
        engine.notify("pageContent");
    }
    if nodes {
        engine.notify("nodeContent");
        engine.notify("nodes");
    }
}

fn sources_linking_to(conn: &Connection, kind: &str, key: &str) -> AppResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT source_id FROM links WHERE source_kind = ?1 AND target_key = ?2")?;
    let rows = stmt.query_map(params![kind, key], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Points every link and infobox field at the new title. Returns the documents changed.
fn rewrite_links(
    conn: &Connection,
    matcher: &MentionMatcher,
    old_key: &str,
    new_title: &str,
) -> AppResult<Vec<(String, String)>> {
    let mut changed = Vec::new();
    for id in sources_linking_to(conn, KIND_PAGE, old_key)? {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT content, infobox FROM pages WHERE id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((text, infobox_text)) = row else {
            continue;
        };
        let mut doc = parse_json(&text, content::empty_doc());
        let mut infobox = parse_json(&infobox_text, json!({ "fields": [] }));
        let doc_changed = content::rewrite_link_targets(&mut doc, old_key, new_title) > 0;
        let infobox_changed = rewrite_infobox_targets(&mut infobox, old_key, new_title);
        if !doc_changed && !infobox_changed {
            continue;
        }
        conn.execute(
            "UPDATE pages SET content = ?1, infobox = ?2 WHERE id = ?3",
            params![doc.to_string(), infobox.to_string(), id],
        )?;
        reindex_page(conn, matcher, &id)?;
        changed.push((KIND_PAGE.to_string(), id));
    }
    for id in sources_linking_to(conn, KIND_NODE, old_key)? {
        let row: Option<(String, String)> = conn
            .query_row("SELECT title, content FROM nodes WHERE id = ?1", [&id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let Some((title, text)) = row else {
            continue;
        };
        let Ok(mut doc) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if content::rewrite_link_targets(&mut doc, old_key, new_title) == 0 {
            continue;
        }
        let extracted = content::extract(&doc);
        conn.execute(
            "UPDATE nodes SET content = ?1, content_text = ?2 WHERE id = ?3",
            params![doc.to_string(), extracted.text, id],
        )?;
        indexing::sync_with(conn, matcher, KIND_NODE, &id, &title, &extracted, &extracted.text)?;
        changed.push((KIND_NODE.to_string(), id));
    }
    Ok(changed)
}

fn check_new_title(conn: &Connection, id: &str, new_title: &str) -> AppResult<(String, String)> {
    let cleaned = clean_title(new_title)?;
    let key = title_key(&cleaned);
    if title_taken(conn, &key, Some(id))? {
        return Err(AppError::new(
            "TITLE_EXISTS",
            format!("A page called \"{cleaned}\" already exists."),
        ));
    }
    Ok((cleaned, key))
}

/// Says what a rename would touch, without changing anything.
fn rename_preview(conn: &Connection, id: &str, new_title: &str) -> AppResult<Value> {
    let (cleaned, new_key) = check_new_title(conn, id, new_title)?;
    let old_key: String = conn
        .query_row(
            "SELECT title_key FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("That page"))?;
    let mut documents = Vec::new();
    if old_key != new_key {
        let mut stmt = conn.prepare(
            "SELECT 'page', p.id, p.title FROM links l JOIN pages p ON p.id = l.source_id
             WHERE l.source_kind = 'page' AND l.target_key = ?1 AND p.deleted_at IS NULL
             UNION ALL
             SELECT 'node', n.id, n.title FROM links l JOIN nodes n ON n.id = l.source_id
             WHERE l.source_kind = 'node' AND l.target_key = ?1 AND n.deleted_at IS NULL
             ORDER BY 3",
        )?;
        let rows = stmt.query_map([&old_key], |r| {
            Ok(json!({
                "kind": r.get::<_, String>(0)?,
                "id": r.get::<_, String>(1)?,
                "title": r.get::<_, String>(2)?,
            }))
        })?;
        for row in rows {
            documents.push(row?);
        }
    }
    Ok(json!({ "newTitle": cleaned, "documents": documents }))
}

/// Renames a page. Returns the documents whose content changed.
pub fn rename_page(
    conn: &Connection,
    id: &str,
    new_title: &str,
    update_links: bool,
    keep_alias: bool,
) -> AppResult<Vec<(String, String)>> {
    let (new_title, new_key) = check_new_title(conn, id, new_title)?;
    let (old_title, old_key): (String, String) = conn
        .query_row(
            "SELECT title, title_key FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("That page"))?;

    conn.execute(
        "UPDATE pages SET title = ?1, title_key = ?2, updated_at = ?3 WHERE id = ?4",
        params![new_title, new_key, db::now(), id],
    )?;
    // An old alias equal to the new title would only be noise.
    conn.execute(
        "DELETE FROM page_aliases WHERE page_id = ?1 AND alias_key = ?2",
        params![id, new_key],
    )?;
    if keep_alias && old_key != new_key {
        conn.execute(
            "INSERT OR IGNORE INTO page_aliases (page_id, alias, alias_key) VALUES (?1, ?2, ?3)",
            params![id, old_title, old_key],
        )?;
    }
    let matcher = MentionMatcher::build(conn)?;
    let changed = if update_links && old_key != new_key {
        rewrite_links(conn, &matcher, &old_key, &new_title)?
    } else {
        Vec::new()
    };
    reindex_search(conn, id)?;
    indexing::refresh_mentions_of(conn, &matcher, &[id])?;
    Ok(changed)
}

fn delete_page(conn: &Connection, id: &str) -> AppResult<()> {
    let is_home: i64 = conn
        .query_row("SELECT is_home FROM pages WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::not_found("That page"))?;
    if is_home != 0 {
        return Err(AppError::invalid("The main page cannot be deleted."));
    }
    let now = db::now();
    conn.execute(
        "UPDATE pages SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    indexing::remove_entity(conn, KIND_PAGE, id)?;
    let matcher = MentionMatcher::build(conn)?;
    indexing::refresh_mentions_of(conn, &matcher, &[id])
}

fn restore_page(conn: &Connection, id: &str) -> AppResult<()> {
    let (title, key): (String, String) = conn
        .query_row(
            "SELECT title, title_key FROM pages WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("That page"))?;
    if title_taken(conn, &key, Some(id))? {
        return Err(AppError::new(
            "TITLE_EXISTS",
            format!("A page called \"{title}\" now exists. Rename it before restoring this one."),
        ));
    }
    conn.execute(
        "UPDATE pages SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
        params![db::now(), id],
    )?;
    let matcher = MentionMatcher::build(conn)?;
    reindex_page(conn, &matcher, id)?;
    indexing::refresh_mentions_of(conn, &matcher, &[id])
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ListFilter {
    page_type: Option<String>,
    status: Option<String>,
    category: Option<String>,
    deleted: bool,
    /// Only pages with fewer words than this.
    under_words: Option<i64>,
    /// Leaves out the main page, which is not part of the world's content.
    exclude_home: bool,
    /// title | updated | created | words | fewestWords
    sort: Option<String>,
    limit: Option<i64>,
    /// An infobox field, by its key or label, ignoring case. Used with `field_value`.
    field: Option<String>,
    /// The field's value at the start of the story, ignoring case. A field that holds
    /// several page titles matches when any of them does.
    field_value: Option<String>,
}

/// Whether an infobox holds `field` with `value` before any change in the story.
pub(crate) fn infobox_matches(infobox: &Value, field: &str, value: &str) -> bool {
    let field = field.trim().to_lowercase();
    let value = value.trim().to_lowercase();
    let Some(fields) = infobox.get("fields").and_then(Value::as_array) else {
        return false;
    };
    fields.iter().any(|f| {
        let text = |name: &str| f.get(name).and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
        if text("key") != field && text("label") != field {
            return false;
        }
        let held = text("value");
        held == value || held.split(',').any(|part| part.trim() == value)
    })
}

/// One query per table instead of two per page, since lists can hold every page.
fn fill_tags_of_all(conn: &Connection, pages: &mut [PageMeta]) -> AppResult<()> {
    let load = |sql: &str| -> AppResult<HashMap<String, Vec<String>>> {
        let mut stmt = conn.prepare_cached(sql)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for row in rows {
            let (page_id, value) = row?;
            map.entry(page_id).or_default().push(value);
        }
        Ok(map)
    };
    let mut aliases = load("SELECT page_id, alias FROM page_aliases ORDER BY alias")?;
    let mut categories = load("SELECT page_id, category FROM page_categories ORDER BY category")?;
    for page in pages {
        page.aliases = aliases.remove(&page.id).unwrap_or_default();
        page.categories = categories.remove(&page.id).unwrap_or_default();
    }
    Ok(())
}

pub(crate) fn list_pages(conn: &Connection, filter: ListFilter) -> AppResult<Vec<PageMeta>> {
    let mut sql = format!("SELECT {META_COLS} FROM pages WHERE ");
    let mut args: Vec<String> = Vec::new();
    sql.push_str(if filter.deleted {
        "deleted_at IS NOT NULL"
    } else {
        "deleted_at IS NULL"
    });
    if let Some(value) = filter.page_type {
        sql.push_str(" AND page_type = ?");
        args.push(value);
    }
    if let Some(value) = filter.status {
        sql.push_str(" AND status = ?");
        args.push(value);
    }
    if let Some(value) = filter.category {
        sql.push_str(" AND id IN (SELECT page_id FROM page_categories WHERE category = ?)");
        args.push(value);
    }
    if let Some(words) = filter.under_words {
        sql.push_str(&format!(" AND word_count < {words}"));
    }
    if filter.exclude_home {
        sql.push_str(" AND is_home = 0");
    }
    sql.push_str(match filter.sort.as_deref() {
        Some("updated") => " ORDER BY updated_at DESC",
        Some("created") => " ORDER BY created_at DESC",
        Some("words") => " ORDER BY word_count DESC, title_key",
        Some("fewestWords") => " ORDER BY word_count, title_key",
        _ => " ORDER BY title_key",
    });
    let by_field = match (&filter.field, &filter.field_value) {
        (Some(f), Some(v)) if !f.trim().is_empty() && !v.trim().is_empty() => Some((f.clone(), v.clone())),
        _ => None,
    };
    if let (Some(limit), None) = (filter.limit, &by_field) {
        sql.push_str(&format!(" LIMIT {}", limit.max(0)));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), meta_from_row)?;
    let mut pages: Vec<PageMeta> = rows.collect::<Result<_, _>>()?;
    if let Some((field, value)) = by_field {
        let mut infobox = conn.prepare_cached("SELECT infobox FROM pages WHERE id = ?1")?;
        let mut kept = Vec::new();
        for page in pages {
            let text: String = infobox.query_row([&page.id], |r| r.get(0))?;
            let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if infobox_matches(&parsed, &field, &value) {
                kept.push(page);
            }
        }
        if let Some(limit) = filter.limit {
            kept.truncate(limit.max(0) as usize);
        }
        pages = kept;
    }
    fill_tags_of_all(conn, &mut pages)?;
    Ok(pages)
}

/// Everything the editor needs to resolve links and detect names. Kept small
/// because the UI holds it in memory.
fn titles(conn: &Connection) -> AppResult<Value> {
    let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt =
            conn.prepare_cached("SELECT page_id, alias FROM page_aliases ORDER BY alias")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (page_id, alias) = row?;
            aliases.entry(page_id).or_default().push(alias);
        }
    }
    let mut stmt = conn.prepare_cached(
        "SELECT id, title, page_type, status, summary, local_only FROM pages
         WHERE deleted_at IS NULL ORDER BY title_key",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)? != 0,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title, page_type, status, summary, local_only) = row?;
        let names = aliases.remove(&id).unwrap_or_default();
        out.push(json!({
            "id": id, "title": title, "pageType": page_type,
            "status": status, "summary": summary, "aliases": names, "localOnly": local_only,
        }));
    }
    Ok(Value::Array(out))
}

pub(crate) fn backlinks(conn: &Connection, id: &str) -> AppResult<Value> {
    let (title_key_value,): (String,) = conn
        .query_row("SELECT title_key FROM pages WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?,))
        })
        .optional()?
        .ok_or_else(|| AppError::not_found("That page"))?;
    let mut keys = vec![title_key_value];
    {
        let mut stmt = conn.prepare("SELECT alias_key FROM page_aliases WHERE page_id = ?1")?;
        for key in stmt.query_map([id], |r| r.get::<_, String>(0))? {
            keys.push(key?);
        }
    }
    let placeholders = vec!["?"; keys.len()].join(",");

    let mut pages = Vec::new();
    {
        let sql = format!(
            "SELECT DISTINCT p.id, p.title, p.status FROM links l JOIN pages p ON p.id = l.source_id
             WHERE l.source_kind = 'page' AND p.deleted_at IS NULL AND p.id != ?
               AND l.target_key IN ({placeholders}) ORDER BY p.title_key"
        );
        let mut args = vec![id.to_string()];
        args.extend(keys.iter().cloned());
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "status": r.get::<_, String>(2)?,
            }))
        })?;
        for row in rows {
            pages.push(row?);
        }
    }

    // A scene counts if it names the page or links to it under any label.
    let mut scenes: Vec<Value> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT n.id, n.title, n.book_id, m.count FROM mentions m
             JOIN nodes n ON n.id = m.source_id
             WHERE m.source_kind = 'node' AND m.page_id = ?1 AND n.deleted_at IS NULL
             ORDER BY n.book_id, n.position",
        )?;
        let rows = stmt.query_map([id], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "bookId": r.get::<_, String>(2)?,
                "count": r.get::<_, i64>(3)?,
            }))
        })?;
        for row in rows {
            scenes.push(row?);
        }

        let sql = format!(
            "SELECT DISTINCT n.id, n.title, n.book_id FROM links l JOIN nodes n ON n.id = l.source_id
             WHERE l.source_kind = 'node' AND n.deleted_at IS NULL
               AND l.target_key IN ({placeholders}) ORDER BY n.book_id, n.position"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(keys.iter()), |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "bookId": r.get::<_, String>(2)?,
                "count": 1,
            }))
        })?;
        for row in rows {
            let row = row?;
            if !scenes.iter().any(|s| s["id"] == row["id"]) {
                scenes.push(row);
            }
        }
    }
    Ok(json!({ "pages": pages, "scenes": scenes }))
}

/// What points at a title with no page behind it, for the "create this page" screen.
fn links_to(conn: &Connection, title: &str) -> AppResult<Value> {
    let key = title_key(title);
    let mut pages = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT p.id, p.title, p.status FROM links l JOIN pages p ON p.id = l.source_id
             WHERE l.source_kind = 'page' AND l.target_key = ?1 AND p.deleted_at IS NULL
             ORDER BY p.title_key",
        )?;
        let rows = stmt.query_map([&key], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "status": r.get::<_, String>(2)?,
            }))
        })?;
        for row in rows {
            pages.push(row?);
        }
    }
    let mut scenes = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT n.id, n.title, n.book_id FROM links l JOIN nodes n ON n.id = l.source_id
             WHERE l.source_kind = 'node' AND l.target_key = ?1 AND n.deleted_at IS NULL
             ORDER BY n.book_id, n.position",
        )?;
        let rows = stmt.query_map([&key], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "bookId": r.get::<_, String>(2)?,
                "count": 1,
            }))
        })?;
        for row in rows {
            scenes.push(row?);
        }
    }
    let trashed: Option<String> = conn
        .query_row(
            "SELECT id FROM pages WHERE title_key = ?1 AND deleted_at IS NOT NULL
             ORDER BY deleted_at DESC LIMIT 1",
            [&key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(json!({ "pages": pages, "scenes": scenes, "trashedId": trashed }))
}

/// Link targets with no page behind them, most wanted first.
fn wanted(conn: &Connection) -> AppResult<Value> {
    let mut stmt = conn.prepare(
        "SELECT l.target_key, MIN(l.target_title), COUNT(*) FROM links l
         WHERE l.target_key NOT IN (SELECT title_key FROM pages WHERE deleted_at IS NULL)
           AND l.target_key NOT IN (
             SELECT a.alias_key FROM page_aliases a JOIN pages p ON p.id = a.page_id
             WHERE p.deleted_at IS NULL)
         GROUP BY l.target_key ORDER BY COUNT(*) DESC, l.target_key",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(json!({
            "key": r.get::<_, String>(0)?,
            "title": r.get::<_, String>(1)?,
            "count": r.get::<_, i64>(2)?,
        }))
    })?;
    Ok(Value::Array(rows.collect::<Result<_, _>>()?))
}

/// Pages no other page links to.
fn orphans(conn: &Connection) -> AppResult<Vec<PageMeta>> {
    let sql = format!(
        "SELECT {META_COLS} FROM pages p WHERE p.deleted_at IS NULL AND p.is_home = 0
           AND p.title_key NOT IN (
             SELECT l.target_key FROM links l JOIN pages s ON s.id = l.source_id
             WHERE l.source_kind = 'page' AND s.id != p.id AND s.deleted_at IS NULL)
           AND NOT EXISTS (
             SELECT 1 FROM page_aliases a JOIN links l ON l.target_key = a.alias_key
             WHERE a.page_id = p.id AND l.source_kind = 'page' AND l.source_id != p.id)
         ORDER BY p.title_key"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], meta_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ---- First appearance -------------------------------------------------------

/// Every scene in reading order: books in order, each book's tree depth first.
struct ReadingOrder {
    /// scene id -> (position, book id, the titles that lead to it)
    scenes: HashMap<String, (usize, String, Vec<String>)>,
    in_order: Vec<String>,
}

fn reading_order(conn: &Connection) -> AppResult<ReadingOrder> {
    struct Row_ {
        id: String,
        kind: String,
        title: String,
    }
    let mut children: HashMap<(String, Option<String>), Vec<Row_>> = HashMap::new();
    let mut books: Vec<(String, String)> = Vec::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT id, title FROM books WHERE deleted_at IS NULL ORDER BY position, created_at",
        )?;
        for row in stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))? {
            books.push(row?);
        }
        let mut stmt = conn.prepare_cached(
            "SELECT id, book_id, parent_id, kind, title FROM nodes
             WHERE deleted_at IS NULL ORDER BY position",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                Row_ {
                    id: r.get(0)?,
                    kind: r.get(3)?,
                    title: r.get(4)?,
                },
            ))
        })?;
        for row in rows {
            let (book, parent, node) = row?;
            children.entry((book, parent)).or_default().push(node);
        }
    }
    let mut order = ReadingOrder {
        scenes: HashMap::new(),
        in_order: Vec::new(),
    };
    fn walk(
        book: &str,
        parent: Option<String>,
        path: &mut Vec<String>,
        children: &HashMap<(String, Option<String>), Vec<Row_>>,
        order: &mut ReadingOrder,
    ) {
        let Some(nodes) = children.get(&(book.to_string(), parent)) else {
            return;
        };
        for node in nodes {
            path.push(node.title.clone());
            if node.kind == "scene" {
                let position = order.in_order.len();
                order.in_order.push(node.id.clone());
                order
                    .scenes
                    .insert(node.id.clone(), (position, book.to_string(), path.clone()));
            }
            walk(book, Some(node.id.clone()), path, children, order);
            path.pop();
        }
    }
    for (book, title) in &books {
        let mut path = vec![title.clone()];
        walk(book, None, &mut path, &children, &mut order);
    }
    Ok(order)
}

fn scene_label(path: &[String]) -> String {
    let parts: Vec<&str> = path.iter().map(|p| p.trim()).filter(|p| !p.is_empty()).collect();
    parts.join(", ")
}

/// The first scene in reading order that names a page, links to it, has it in the cast,
/// is told from its point of view or takes place there. Null if none does.
fn first_appearance(conn: &Connection, id: &str) -> AppResult<Value> {
    let (key,): (String,) = conn
        .query_row("SELECT title_key FROM pages WHERE id = ?1", [id], |r| Ok((r.get(0)?,)))
        .optional()?
        .ok_or_else(|| AppError::not_found("That page"))?;
    let mut keys = vec![key];
    keys.extend(string_column(
        conn,
        "SELECT alias_key FROM page_aliases WHERE page_id = ?1",
        id,
    )?);
    let placeholders = vec!["?"; keys.len()].join(",");
    let mut sources: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT source_id FROM mentions WHERE source_kind = 'node' AND page_id = ?1
             UNION SELECT node_id FROM node_cast WHERE page_id = ?1
             UNION SELECT id FROM nodes WHERE pov_page_id = ?1 OR location_page_id = ?1",
        )?;
        for row in stmt.query_map([id], |r| r.get::<_, String>(0))? {
            sources.push(row?);
        }
        let sql = format!(
            "SELECT source_id FROM links WHERE source_kind = 'node' AND target_key IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql)?;
        for row in stmt.query_map(params_from_iter(keys.iter()), |r| r.get::<_, String>(0))? {
            sources.push(row?);
        }
    }
    if sources.is_empty() {
        return Ok(Value::Null);
    }
    let order = reading_order(conn)?;
    let first = sources
        .iter()
        .filter_map(|source| order.scenes.get(source).map(|scene| (scene.0, source, scene)))
        .min_by_key(|(position, _, _)| *position);
    Ok(match first {
        Some((_, source, (_, book, path))) => json!({
            "nodeId": source,
            "bookId": book,
            "label": scene_label(path),
        }),
        None => Value::Null,
    })
}

/// Page id -> the scene it first appears in, for every page, in one pass over the tables.
pub fn first_appearances(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let order = reading_order(conn)?;
    let mut best: HashMap<String, (usize, String)> = HashMap::new();
    for sql in [
        "SELECT page_id, source_id FROM mentions WHERE source_kind = 'node'",
        "SELECT page_id, node_id FROM node_cast",
        "SELECT pov_page_id, id FROM nodes WHERE pov_page_id IS NOT NULL",
        "SELECT location_page_id, id FROM nodes WHERE location_page_id IS NOT NULL",
        "SELECT p.id, l.source_id FROM links l JOIN pages p ON p.title_key = l.target_key
         WHERE l.source_kind = 'node' AND p.deleted_at IS NULL",
        "SELECT a.page_id, l.source_id FROM links l JOIN page_aliases a ON a.alias_key = l.target_key
         WHERE l.source_kind = 'node'",
    ] {
        let mut stmt = conn.prepare_cached(sql)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (page, scene) = row?;
            let Some((position, _, _)) = order.scenes.get(&scene) else {
                continue;
            };
            let entry = best.entry(page).or_insert((*position, scene.clone()));
            if *position < entry.0 {
                *entry = (*position, scene);
            }
        }
    }
    Ok(best.into_iter().map(|(page, (_, scene))| (page, scene)).collect())
}

/// Every scene in reading order, for choosing a point in the story.
fn scene_options(conn: &Connection) -> AppResult<Value> {
    let order = reading_order(conn)?;
    let options: Vec<Value> = order
        .in_order
        .iter()
        .map(|id| json!({ "id": id, "label": scene_label(&order.scenes[id].2) }))
        .collect();
    Ok(Value::Array(options))
}

// ---- Lists that fill themselves in --------------------------------------------

/// The pages whose infobox names this page, grouped by field and page type. Only pages
/// already known to link here are read, so this stays fast however large the project is.
fn infobox_links(conn: &Connection, id: &str) -> AppResult<Value> {
    let (key,): (String,) = conn
        .query_row("SELECT title_key FROM pages WHERE id = ?1", [id], |r| Ok((r.get(0)?,)))
        .optional()?
        .ok_or_else(|| AppError::not_found("That page"))?;
    let mut keys = vec![key];
    keys.extend(string_column(
        conn,
        "SELECT alias_key FROM page_aliases WHERE page_id = ?1",
        id,
    )?);
    let placeholders = vec!["?"; keys.len()].join(",");
    let sql = format!(
        "SELECT DISTINCT p.id, p.title, p.status, p.page_type, p.infobox, p.title_key
         FROM links l JOIN pages p ON p.id = l.source_id
         WHERE l.source_kind = 'page' AND p.deleted_at IS NULL AND p.id != ?
           AND l.target_key IN ({placeholders}) ORDER BY p.title_key"
    );
    let mut args = vec![id.to_string()];
    args.extend(keys.iter().cloned());
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    // (label, page type) -> field key and pages, kept in a stable order for display.
    let mut groups: std::collections::BTreeMap<(String, String), (String, Vec<Value>)> =
        std::collections::BTreeMap::new();
    for row in rows {
        let (page_id, title, status, page_type, infobox) = row?;
        let infobox = parse_json(&infobox, json!({ "fields": [] }));
        for field in infobox_fields(&infobox) {
            let value = field_str(field, "value");
            let names_this_page = match field_str(field, "kind") {
                "page" => keys.contains(&title_key(value)),
                "pages" => value.split(',').any(|t| keys.contains(&title_key(t))),
                _ => false,
            };
            if !names_this_page {
                continue;
            }
            let label = field_str(field, "label").to_string();
            let group = groups
                .entry((label, page_type.clone()))
                .or_insert_with(|| (field_str(field, "key").to_string(), Vec::new()));
            if !group.1.iter().any(|p| p["id"] == page_id.as_str()) {
                group.1.push(json!({ "id": page_id, "title": title, "status": status }));
            }
        }
    }
    let out: Vec<Value> = groups
        .into_iter()
        .map(|((label, page_type), (key, pages))| {
            json!({ "label": label, "key": key, "pageType": page_type, "pages": pages })
        })
        .collect();
    Ok(Value::Array(out))
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    #[derive(Deserialize)]
    struct IdParam {
        id: String,
    }
    match action {
        "list" => {
            let filter: ListFilter = parse(params)?;
            ok(engine.read(|c| list_pages(c, filter))?)
        }
        "titles" => engine.read(titles),
        "get" => {
            let p: IdParam = parse(params)?;
            ok(engine.read(|c| get_page(c, &p.id))?)
        }
        "getByTitle" => {
            #[derive(Deserialize)]
            struct P {
                title: String,
            }
            let p: P = parse(params)?;
            engine.read(|c| match resolve_title(c, &p.title)? {
                Some(id) => ok(get_page(c, &id)?),
                None => Ok(Value::Null),
            })
        }
        "home" => engine.read(|c| {
            let id: Option<String> = c
                .query_row(
                    "SELECT id FROM pages WHERE is_home = 1 AND deleted_at IS NULL LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            match id {
                Some(id) => ok(get_page(c, &id)?),
                None => Ok(Value::Null),
            }
        }),
        "create" => {
            let input: CreateInput = parse(params)?;
            let (page, family_report) = engine.write(|tx| {
                let id = create_page(tx, input)?;
                let report = family::after_page_created(tx, &id)?;
                Ok((get_page(tx, &id)?, report))
            })?;
            engine.notify("pages");
            family::announce(engine, &family_report);
            ok(page)
        }
        "update" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                id: String,
                patch: Patch,
                /// The write comes from the open editor, which already shows it.
                #[serde(default)]
                from_editor: bool,
                /// Saves the page to its history first, with this reason, as before a change
                /// the AI wrote and the writer accepted.
                #[serde(default)]
                snapshot: Option<String>,
            }
            let mut p: P = parse(params)?;
            // Family fields the writer is still typing in, which is not stored.
            let typing = p.patch.infobox.as_mut().map(family::take_typing).unwrap_or_default();
            let (outcome, family_report) = engine.write(|tx| {
                if let Some(reason) = p.snapshot.as_deref().filter(|r| !r.is_empty()) {
                    revisions::checkpoint(tx, KIND_PAGE, &p.id, reason)?;
                }
                // A saved infobox can say something about other pages too.
                let before = match p.patch.infobox {
                    Some(_) => Some(get_page(tx, &p.id)?.infobox),
                    None => None,
                };
                let outcome = update_page(tx, &p.id, p.patch)?;
                let report = match before {
                    Some(before) => family::after_infobox_save(tx, &p.id, &before, &typing)?,
                    None => family::FamilyReport::default(),
                };
                Ok((outcome, report))
            })?;
            family::announce(engine, &family_report);
            if outcome.titles_changed {
                engine.notify("pages");
            }
            if outcome.content_changed || !outcome.titles_changed {
                engine.notify("pageContent");
            }
            if !p.from_editor {
                notify_replaced(engine, &[(KIND_PAGE.to_string(), p.id)]);
            }
            ok(outcome.meta)
        }
        "rename" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                id: String,
                new_title: String,
                #[serde(default = "yes")]
                update_links: bool,
                #[serde(default = "yes")]
                keep_alias: bool,
            }
            fn yes() -> bool {
                true
            }
            let p: P = parse(params)?;
            let (changed, family_report) = engine.write(|tx| {
                let changed = rename_page(tx, &p.id, &p.new_title, p.update_links, p.keep_alias)?;
                Ok((changed, family::after_page_renamed(tx, &p.id)?))
            })?;
            engine.notify("pages");
            notify_replaced(engine, &changed);
            family::announce(engine, &family_report);
            Ok(json!({ "documentsChanged": changed.len() }))
        }
        "settleFamily" => {
            // The writer left a family field, so what it says now is kept in step.
            let p: IdParam = parse(params)?;
            let report = engine.write(|tx| family::settle(tx, &p.id))?;
            family::announce(engine, &report);
            ok(true)
        }
        "renamePreview" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                id: String,
                new_title: String,
            }
            let p: P = parse(params)?;
            engine.read(|c| rename_preview(c, &p.id, &p.new_title))
        }
        "delete" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| delete_page(tx, &p.id))?;
            engine.notify("pages");
            notify_replaced(engine, &[(KIND_PAGE.to_string(), p.id)]);
            ok(true)
        }
        "restore" => {
            let p: IdParam = parse(params)?;
            let family_report = engine.write(|tx| {
                restore_page(tx, &p.id)?;
                family::after_page_restored(tx, &p.id)
            })?;
            engine.notify("pages");
            notify_replaced(engine, &[(KIND_PAGE.to_string(), p.id)]);
            family::announce(engine, &family_report);
            ok(true)
        }
        "purge" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| {
                let deleted: Option<Option<String>> = tx
                    .query_row("SELECT deleted_at FROM pages WHERE id = ?1", [&p.id], |r| {
                        r.get(0)
                    })
                    .optional()?;
                match deleted {
                    Some(Some(_)) => {}
                    Some(None) => {
                        return Err(AppError::invalid("Move a page to the trash first."))
                    }
                    None => return Err(AppError::not_found("That page")),
                }
                tx.execute("DELETE FROM pages WHERE id = ?1", [&p.id])?;
                tx.execute(
                    "DELETE FROM revisions WHERE entity_kind = 'page' AND entity_id = ?1",
                    [&p.id],
                )?;
                Ok(())
            })?;
            engine.notify("pages");
            ok(true)
        }
        "backlinks" => {
            let p: IdParam = parse(params)?;
            engine.read(|c| backlinks(c, &p.id))
        }
        "firstAppearance" => {
            let p: IdParam = parse(params)?;
            engine.read(|c| first_appearance(c, &p.id))
        }
        "firstAppearances" => ok(engine.read(first_appearances)?),
        "sceneOptions" => engine.read(scene_options),
        "infoboxLinks" => {
            let p: IdParam = parse(params)?;
            engine.read(|c| infobox_links(c, &p.id))
        }
        "linksTo" => {
            #[derive(Deserialize)]
            struct P {
                title: String,
            }
            let p: P = parse(params)?;
            engine.read(|c| links_to(c, &p.title))
        }
        "wanted" => engine.read(wanted),
        "orphans" => ok(engine.read(orphans)?),
        "random" => {
            #[derive(Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct P {
                /// The page being read, so the command always goes somewhere new.
                except_id: Option<String>,
            }
            let p: P = parse(params)?;
            engine.read(|c| {
                let id: Option<String> = c
                    .query_row(
                        "SELECT id FROM pages WHERE deleted_at IS NULL AND is_home = 0
                           AND id != COALESCE(?1, '')
                         ORDER BY RANDOM() LIMIT 1",
                        [&p.except_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                ok(id)
            })
        }
        "categories" => engine.read(|c| {
            let mut stmt = c.prepare(
                "SELECT pc.category, COUNT(*) FROM page_categories pc
                 JOIN pages p ON p.id = pc.page_id WHERE p.deleted_at IS NULL
                 GROUP BY pc.category ORDER BY pc.category",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(json!({ "name": r.get::<_, String>(0)?, "count": r.get::<_, i64>(1)? }))
            })?;
            Ok(Value::Array(rows.collect::<Result<_, _>>()?))
        }),
        _ => Err(unknown(&format!("pages.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{call, dispatch};

    fn project() -> (std::sync::Arc<Engine>, crate::engine::TestDir) {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "T" }));
        (engine, dir)
    }

    fn linked_doc(text: &str, target: &str) -> Value {
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [
            { "type": "text", "text": text, "marks": [{ "type": "wikiLink", "attrs": { "target": target } }] }
        ]}]})
    }

    #[test]
    fn a_new_project_has_a_main_page_that_cannot_be_deleted() {
        let (engine, _dir) = project();
        let home = call(&engine, "pages.home", json!({}));
        assert_eq!(home["title"], "Main Page");
        let err = dispatch(&engine, "pages.delete", json!({ "id": home["id"] })).unwrap_err();
        assert_eq!(err.code, "INVALID");
    }

    #[test]
    fn titles_are_unique_ignoring_case_and_spacing() {
        let (engine, _dir) = project();
        call(&engine, "pages.create", json!({ "title": "Silver Vale" }));
        let err = dispatch(&engine, "pages.create", json!({ "title": " silver_vale " })).unwrap_err();
        assert_eq!(err.code, "TITLE_EXISTS");
    }

    #[test]
    fn deleted_titles_can_be_reused_but_block_restore() {
        let (engine, _dir) = project();
        let first = call(&engine, "pages.create", json!({ "title": "Aria" }));
        call(&engine, "pages.delete", json!({ "id": first["id"] }));
        call(&engine, "pages.create", json!({ "title": "Aria" }));
        let err = dispatch(&engine, "pages.restore", json!({ "id": first["id"] })).unwrap_err();
        assert_eq!(err.code, "TITLE_EXISTS");
    }

    #[test]
    fn red_links_become_wanted_then_resolve_when_the_page_appears() {
        let (engine, _dir) = project();
        let source = call(&engine, "pages.create", json!({ "title": "Aria" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": source["id"], "patch": { "content": linked_doc("the Vale", "Silver Vale") } }),
        );
        let wanted = call(&engine, "pages.wanted", json!({}));
        assert_eq!(wanted[0]["title"], "Silver Vale");
        assert_eq!(wanted[0]["count"], 1);

        let target = call(&engine, "pages.create", json!({ "title": "Silver Vale" }));
        assert!(call(&engine, "pages.wanted", json!({})).as_array().unwrap().is_empty());
        let back = call(&engine, "pages.backlinks", json!({ "id": target["id"] }));
        assert_eq!(back["pages"][0]["title"], "Aria");
    }

    #[test]
    fn renaming_updates_links_and_keeps_the_old_name_as_an_alias() {
        let (engine, _dir) = project();
        let target = call(&engine, "pages.create", json!({ "title": "Silver Vale" }));
        let source = call(&engine, "pages.create", json!({ "title": "Aria" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": source["id"], "patch": { "content": linked_doc("the Vale", "silver vale") } }),
        );
        let result = call(
            &engine,
            "pages.rename",
            json!({ "id": target["id"], "newTitle": "Argent Vale" }),
        );
        assert_eq!(result["documentsChanged"], 1);

        let source = call(&engine, "pages.get", json!({ "id": source["id"] }));
        assert_eq!(
            source["content"]["content"][0]["content"][0]["marks"][0]["attrs"]["target"],
            "Argent Vale"
        );
        let by_old_name = call(&engine, "pages.getByTitle", json!({ "title": "Silver Vale" }));
        assert_eq!(by_old_name["title"], "Argent Vale");
    }

    #[test]
    fn aliases_resolve_and_count_as_backlinks() {
        let (engine, _dir) = project();
        let target = call(
            &engine,
            "pages.create",
            json!({ "title": "Aria Vale", "aliases": ["The Ranger"] }),
        );
        let source = call(&engine, "pages.create", json!({ "title": "Story" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": source["id"], "patch": { "content": linked_doc("she", "the ranger") } }),
        );
        let back = call(&engine, "pages.backlinks", json!({ "id": target["id"] }));
        assert_eq!(back["pages"][0]["title"], "Story");
        assert!(call(&engine, "pages.wanted", json!({})).as_array().unwrap().is_empty());
    }

    #[test]
    fn deleting_hides_a_page_and_restoring_brings_back_its_links_and_search() {
        let (engine, _dir) = project();
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": page["id"], "patch": { "content": linked_doc("zebrafinch", "Elsewhere") } }),
        );
        let found = call(&engine, "search.query", json!({ "q": "zebrafinch" }));
        assert_eq!(found.as_array().unwrap().len(), 1);

        call(&engine, "pages.delete", json!({ "id": page["id"] }));
        assert!(call(&engine, "search.query", json!({ "q": "zebrafinch" })).as_array().unwrap().is_empty());
        assert!(call(&engine, "pages.wanted", json!({})).as_array().unwrap().is_empty());
        assert_eq!(call(&engine, "pages.list", json!({ "deleted": true })).as_array().unwrap().len(), 1);

        call(&engine, "pages.restore", json!({ "id": page["id"] }));
        assert_eq!(call(&engine, "search.query", json!({ "q": "zebrafinch" })).as_array().unwrap().len(), 1);
        assert_eq!(call(&engine, "pages.wanted", json!({})).as_array().unwrap().len(), 1);
    }

    #[test]
    fn creating_a_page_detects_it_in_existing_scenes() {
        let (engine, _dir) = project();
        let books = call(&engine, "books.list", json!({}));
        let tree = call(&engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        let scene = tree
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["kind"] == "scene")
            .unwrap()
            .clone();
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": { "type": "doc", "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "Aria drew her bow." }] }
            ]}}}),
        );
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        let back = call(&engine, "pages.backlinks", json!({ "id": page["id"] }));
        assert_eq!(back["scenes"][0]["id"], scene["id"]);
        assert_eq!(back["scenes"][0]["count"], 1);
    }

    fn infobox_with(kind: &str, value: &str) -> Value {
        json!({ "fields": [{ "key": "parents", "label": "Parents", "kind": kind, "value": value }] })
    }

    #[test]
    fn a_new_project_main_page_is_canon() {
        let (engine, _dir) = project();
        assert_eq!(call(&engine, "pages.home", json!({}))["status"], "canon");
    }

    #[test]
    fn infobox_page_fields_count_as_links() {
        let (engine, _dir) = project();
        let source = call(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "infobox": infobox_with("pages", "Morn, Silver Vale ,") }),
        );
        let mut wanted: Vec<String> = call(&engine, "pages.wanted", json!({}))
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["title"].as_str().unwrap().to_string())
            .collect();
        wanted.sort();
        assert_eq!(wanted, vec!["Morn", "Silver Vale"]);

        let target = call(&engine, "pages.create", json!({ "title": "Morn" }));
        let back = call(&engine, "pages.backlinks", json!({ "id": target["id"] }));
        assert_eq!(back["pages"][0]["id"], source["id"]);
        let orphans = call(&engine, "pages.orphans", json!({}));
        assert!(!orphans.as_array().unwrap().iter().any(|p| p["title"] == "Morn"));

        // A plain text field holds no link, and editing the infobox alone updates links.
        call(
            &engine,
            "pages.update",
            json!({ "id": source["id"], "patch": { "infobox": infobox_with("text", "Morn") } }),
        );
        assert!(call(&engine, "pages.wanted", json!({})).as_array().unwrap().is_empty());
        let back = call(&engine, "pages.backlinks", json!({ "id": target["id"] }));
        assert!(back["pages"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_page_field_counts_as_a_link_in_every_value_it_takes_during_the_story() {
        let (engine, _dir) = project();
        let source = call(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "infobox": { "fields": [{
                "key": "liege", "label": "Liege", "kind": "page", "value": "Morn",
                "changes": [{ "date": "312", "value": "Queen Vess" }],
            }] } }),
        );
        let wanted = call(&engine, "pages.wanted", json!({}));
        let titles: Vec<&str> = wanted.as_array().unwrap().iter().map(|w| w["title"].as_str().unwrap()).collect();
        assert!(titles.contains(&"Morn"));
        assert!(titles.contains(&"Queen Vess"), "a later value is linked too: {titles:?}");

        let vess = call(&engine, "pages.create", json!({ "title": "Queen Vess" }));
        call(&engine, "pages.rename", json!({ "id": vess["id"], "newTitle": "Empress Vess" }));
        let page = call(&engine, "pages.get", json!({ "id": source["id"] }));
        let field = &page["infobox"]["fields"][0];
        assert_eq!(field["changes"][0]["value"], "Empress Vess");
        assert_eq!(field["value"], "Morn", "the starting value is left alone");
        assert_eq!(field["changes"][0]["date"], "312", "what else a change holds is kept");
    }

    #[test]
    fn search_finds_a_value_a_field_only_takes_later() {
        let (engine, _dir) = project();
        call(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "infobox": { "fields": [{
                "key": "hair", "label": "Hair", "kind": "text", "value": "blonde",
                "changes": [{ "nodeId": "n", "value": "heliotrope" }],
            }] } }),
        );
        let hits = call(&engine, "search.query", json!({ "q": "heliotrope" }));
        assert_eq!(hits.as_array().unwrap().len(), 1);
    }

    #[test]
    fn editing_the_text_keeps_links_from_the_infobox() {
        let (engine, _dir) = project();
        let source = call(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "infobox": infobox_with("page", "Morn") }),
        );
        call(
            &engine,
            "pages.update",
            json!({ "id": source["id"], "patch": { "content": linked_doc("x", "Elsewhere") } }),
        );
        assert_eq!(call(&engine, "pages.wanted", json!({})).as_array().unwrap().len(), 2);
    }

    #[test]
    fn renaming_rewrites_infobox_fields_and_a_preview_counts_documents() {
        let (engine, _dir) = project();
        let target = call(&engine, "pages.create", json!({ "title": "Morn" }));
        let by_infobox = call(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "infobox": infobox_with("pages", "Morn, Silver Vale") }),
        );
        let by_text = call(&engine, "pages.create", json!({ "title": "Story" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": by_text["id"], "patch": { "content": linked_doc("him", "morn") } }),
        );
        call(&engine, "pages.create", json!({ "title": "Taken" }));

        let preview = call(
            &engine,
            "pages.renamePreview",
            json!({ "id": target["id"], "newTitle": "  Morning  Star " }),
        );
        assert_eq!(preview["newTitle"], "Morning Star");
        assert_eq!(preview["documents"].as_array().unwrap().len(), 2);
        let err = dispatch(
            &engine,
            "pages.renamePreview",
            json!({ "id": target["id"], "newTitle": "taken" }),
        )
        .unwrap_err();
        assert_eq!(err.code, "TITLE_EXISTS");
        // A preview changes nothing.
        assert_eq!(call(&engine, "pages.get", json!({ "id": target["id"] }))["title"], "Morn");

        let result = call(
            &engine,
            "pages.rename",
            json!({ "id": target["id"], "newTitle": "Morning Star" }),
        );
        assert_eq!(result["documentsChanged"], 2);
        let page = call(&engine, "pages.get", json!({ "id": by_infobox["id"] }));
        assert_eq!(page["infobox"]["fields"][0]["value"], "Morning Star, Silver Vale");
        let back = call(&engine, "pages.backlinks", json!({ "id": target["id"] }));
        assert_eq!(back["pages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn changing_only_the_case_of_a_title_touches_no_other_document() {
        let (engine, _dir) = project();
        let target = call(&engine, "pages.create", json!({ "title": "aria vale" }));
        let source = call(&engine, "pages.create", json!({ "title": "Story" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": source["id"], "patch": { "content": linked_doc("her", "aria vale") } }),
        );
        let preview = call(
            &engine,
            "pages.renamePreview",
            json!({ "id": target["id"], "newTitle": "Aria Vale" }),
        );
        assert!(preview["documents"].as_array().unwrap().is_empty());
        let result = call(
            &engine,
            "pages.rename",
            json!({ "id": target["id"], "newTitle": "Aria Vale" }),
        );
        assert_eq!(result["documentsChanged"], 0);
        let page = call(&engine, "pages.get", json!({ "id": target["id"] }));
        assert_eq!(page["title"], "Aria Vale");
        assert!(page["aliases"].as_array().unwrap().is_empty());
    }

    #[test]
    fn renaming_without_an_alias_or_links_leaves_links_red() {
        let (engine, _dir) = project();
        let target = call(&engine, "pages.create", json!({ "title": "Morn" }));
        let source = call(&engine, "pages.create", json!({ "title": "Story" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": source["id"], "patch": { "content": linked_doc("him", "Morn") } }),
        );
        call(
            &engine,
            "pages.rename",
            json!({ "id": target["id"], "newTitle": "Dawn", "updateLinks": false, "keepAlias": false }),
        );
        assert_eq!(call(&engine, "pages.wanted", json!({}))[0]["title"], "Morn");
    }

    #[test]
    fn a_page_cannot_have_its_own_title_as_an_alias() {
        let (engine, _dir) = project();
        let page = call(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "aliases": ["aria", "The Ranger", "  "] }),
        );
        assert_eq!(page["aliases"], json!(["The Ranger"]));
        call(
            &engine,
            "pages.update",
            json!({ "id": page["id"], "patch": { "aliases": ["ARIA", "Ranger"] } }),
        );
        let page = call(&engine, "pages.get", json!({ "id": page["id"] }));
        assert_eq!(page["aliases"], json!(["Ranger"]));
    }

    fn entity_events(host: &crate::engine::TestHost) -> Vec<String> {
        host.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(event, _)| event == "data://changed")
            .map(|(_, p)| p["entity"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn what_changed_decides_which_data_events_fire() {
        let (engine, host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        let update = |patch: Value| {
            host.events.lock().unwrap().clear();
            call(
                &engine,
                "pages.update",
                json!({ "id": page["id"], "fromEditor": true, "patch": patch }),
            );
            entity_events(&host)
        };
        // Saving text must not refresh the title list.
        assert_eq!(update(json!({ "content": linked_doc("a", "B") })), vec!["pageContent"]);
        // Hover cards and link colors show these, so the title list must refresh.
        assert_eq!(update(json!({ "summary": "New" })), vec!["pages"]);
        assert_eq!(update(json!({ "status": "canon" })), vec!["pages"]);
        assert_eq!(update(json!({ "pageType": "character" })), vec!["pages"]);
        assert_eq!(update(json!({ "aliases": ["A"] })), vec!["pages"]);
        // Sending the same value again is not a change.
        assert_eq!(update(json!({ "summary": "New" })), vec!["pageContent"]);
        assert_eq!(update(json!({ "categories": ["People"] })), vec!["pageContent"]);
        assert_eq!(
            update(json!({ "summary": "Newer", "content": linked_doc("b", "C") })),
            vec!["pages", "pageContent"],
        );
    }

    #[test]
    fn trashing_and_restoring_tell_an_open_view_to_reload() {
        let (engine, host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        let reload = format!("doc:page:{}", page["id"].as_str().unwrap());
        for method in ["pages.delete", "pages.restore"] {
            host.events.lock().unwrap().clear();
            call(&engine, method, json!({ "id": page["id"] }));
            assert!(entity_events(&host).contains(&reload), "{method}");
        }
    }

    #[test]
    fn links_to_lists_what_points_at_a_missing_title() {
        let (engine, _dir) = project();
        let source = call(&engine, "pages.create", json!({ "title": "Story" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": source["id"], "patch": { "content": linked_doc("x", "Silver Vale") } }),
        );
        let books = call(&engine, "books.list", json!({}));
        let tree = call(&engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap().clone();
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": linked_doc("y", "silver_vale") } }),
        );
        let links = call(&engine, "pages.linksTo", json!({ "title": "SILVER VALE" }));
        assert_eq!(links["pages"][0]["id"], source["id"]);
        assert_eq!(links["scenes"][0]["id"], scene["id"]);
        assert!(links["trashedId"].is_null());

        let trashed = call(&engine, "pages.create", json!({ "title": "Silver Vale" }));
        call(&engine, "pages.delete", json!({ "id": trashed["id"] }));
        let links = call(&engine, "pages.linksTo", json!({ "title": "Silver Vale" }));
        assert_eq!(links["trashedId"], trashed["id"]);
    }

    #[test]
    fn a_scene_that_links_without_naming_the_page_is_a_backlink() {
        let (engine, _dir) = project();
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        let books = call(&engine, "books.list", json!({}));
        let tree = call(&engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap().clone();
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": linked_doc("she", "Aria") } }),
        );
        let back = call(&engine, "pages.backlinks", json!({ "id": page["id"] }));
        assert_eq!(back["scenes"][0]["id"], scene["id"]);
        assert_eq!(back["scenes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn lists_filter_by_word_count_and_leave_out_the_main_page() {
        let (engine, _dir) = project();
        let short = call(&engine, "pages.create", json!({ "title": "Short" }));
        let long = call(&engine, "pages.create", json!({ "title": "Long" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": long["id"], "patch": { "content": linked_doc("one two three", "X") } }),
        );
        let list = call(
            &engine,
            "pages.list",
            json!({ "underWords": 2, "excludeHome": true, "sort": "fewestWords" }),
        );
        let ids: Vec<&Value> = list.as_array().unwrap().iter().map(|p| &p["id"]).collect();
        assert_eq!(ids, vec![&short["id"]]);
        let list = call(&engine, "pages.list", json!({ "excludeHome": true, "sort": "fewestWords" }));
        assert_eq!(list[0]["id"], short["id"]);
        assert_eq!(list[1]["id"], long["id"]);
    }

    #[test]
    fn lists_filter_by_an_infobox_field_at_the_start_of_the_story() {
        let (engine, _dir) = project();
        let fields = |home: &str| json!({ "fields": [
            { "key": "home", "label": "Home", "kind": "pages", "value": home,
              "changes": [{ "value": "Elsewhere" }] }
        ] });
        let a = call(&engine, "pages.create", json!({ "title": "Ash", "infobox": fields("Cray Landing") }));
        call(&engine, "pages.create", json!({ "title": "Bea", "infobox": fields("Elsewhere") }));
        let c = call(&engine, "pages.create", json!({ "title": "Cy", "infobox": fields("Mor, cray landing") }));
        call(&engine, "pages.create", json!({ "title": "Dee" }));
        let list = call(&engine, "pages.list", json!({ "field": "HOME", "fieldValue": "Cray Landing", "limit": 5 }));
        let ids: Vec<&Value> = list.as_array().unwrap().iter().map(|p| &p["id"]).collect();
        assert_eq!(ids, vec![&a["id"], &c["id"]]);
        let none = call(&engine, "pages.list", json!({ "field": "home", "fieldValue": "Mor Hill" }));
        assert_eq!(none.as_array().unwrap().len(), 0);
        let one = call(&engine, "pages.list", json!({ "field": "home", "fieldValue": "cray landing", "limit": 1 }));
        assert_eq!(one.as_array().unwrap().len(), 1);
    }

    #[test]
    fn lists_include_each_pages_aliases_and_categories() {
        let (engine, _dir) = project();
        call(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "aliases": ["B", "A"], "categories": ["People", "Heroes"] }),
        );
        call(&engine, "pages.create", json!({ "title": "Bare" }));
        let list = call(&engine, "pages.list", json!({ "excludeHome": true }));
        assert_eq!(list[0]["aliases"], json!(["A", "B"]));
        assert_eq!(list[0]["categories"], json!(["Heroes", "People"]));
        assert_eq!(list[1]["aliases"], json!([]));
        let titles = call(&engine, "pages.titles", json!({}));
        let aria = titles.as_array().unwrap().iter().find(|t| t["title"] == "Aria").unwrap();
        assert_eq!(aria["aliases"], json!(["A", "B"]));
    }

    #[test]
    fn random_avoids_the_current_page_and_the_main_page() {
        let (engine, _dir) = project();
        assert!(call(&engine, "pages.random", json!({})).is_null());
        let a = call(&engine, "pages.create", json!({ "title": "A" }));
        let b = call(&engine, "pages.create", json!({ "title": "B" }));
        assert_eq!(call(&engine, "pages.random", json!({ "exceptId": a["id"] })), b["id"]);
        assert_eq!(call(&engine, "pages.random", json!({ "exceptId": b["id"] })), a["id"]);
        assert!(call(&engine, "pages.random", json!({})).is_string());
    }

    /// Run with `cargo test measure_hot_paths -- --ignored --nocapture` to see real numbers.
    #[test]
    #[ignore]
    fn measure_hot_paths_with_500_pages() {
        use std::time::Instant;
        let (engine, _dir) = project();
        let paragraph = "The river runs past the old keep and on through the silver vale. ".repeat(10);
        let body = |n: usize| {
            json!({ "type": "doc", "content": (0..30).map(|i| json!({
                "type": "paragraph",
                "content": [{ "type": "text", "text": format!("{i} {n} {paragraph}") }],
            })).collect::<Vec<_>>() })
        };
        let start = Instant::now();
        let mut last = Value::Null;
        for n in 0..500 {
            last = call(
                &engine,
                "pages.create",
                json!({
                    "title": format!("Page number {n}"),
                    "aliases": [format!("Alias {n}")],
                    "content": body(n),
                }),
            );
        }
        println!("create 500 pages: {:?}", start.elapsed());

        let time = |label: &str, f: &mut dyn FnMut()| {
            let start = Instant::now();
            for _ in 0..20 {
                f();
            }
            println!("{label}: {:?} each", start.elapsed() / 20);
        };
        time("pages.update content", &mut || {
            call(
                &engine,
                "pages.update",
                json!({ "id": last["id"], "fromEditor": true, "patch": { "content": body(1) } }),
            );
        });
        time("pages.update summary", &mut || {
            call(
                &engine,
                "pages.update",
                json!({ "id": last["id"], "fromEditor": true, "patch": { "summary": "x" } }),
            );
        });
        time("pages.titles", &mut || {
            call(&engine, "pages.titles", json!({}));
        });
        time("pages.list", &mut || {
            call(&engine, "pages.list", json!({}));
        });
        time("pages.firstAppearance", &mut || {
            call(&engine, "pages.firstAppearance", json!({ "id": last["id"] }));
        });
        time("pages.firstAppearances", &mut || {
            call(&engine, "pages.firstAppearances", json!({}));
        });
        time("pages.infoboxLinks", &mut || {
            call(&engine, "pages.infoboxLinks", json!({ "id": last["id"] }));
        });
        time("pages.create", &mut || {
            let page = call(&engine, "pages.create", json!({ "title": "Temp" }));
            call(&engine, "pages.delete", json!({ "id": page["id"] }));
            call(&engine, "pages.purge", json!({ "id": page["id"] }));
        });
    }

    /// A second chapter and scene after the new project's first ones, with their ids.
    fn two_scenes(engine: &Engine) -> (Value, Value, Value) {
        let books = call(engine, "books.list", json!({}));
        let book = books[0]["id"].clone();
        let tree = call(engine, "nodes.tree", json!({ "bookId": book }));
        let first = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap().clone();
        let chapter = call(
            engine,
            "nodes.create",
            json!({ "bookId": book, "kind": "chapter", "title": "Chapter 2" }),
        );
        let second = call(
            engine,
            "nodes.create",
            json!({ "bookId": book, "parentId": chapter["id"], "kind": "scene", "title": "Scene 9" }),
        );
        (book, first, second)
    }

    fn scene_text(text: &str) -> Value {
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }] })
    }

    #[test]
    fn first_appearance_follows_reading_order_not_edit_order() {
        let (engine, _dir) = project();
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        assert!(call(&engine, "pages.firstAppearance", json!({ "id": page["id"] })).is_null());

        let (book, first, second) = two_scenes(&engine);
        call(&engine, "nodes.update", json!({ "id": second["id"], "patch": { "content": scene_text("Aria sang.") } }));
        let found = call(&engine, "pages.firstAppearance", json!({ "id": page["id"] }));
        assert_eq!(found["nodeId"], second["id"]);
        assert_eq!(found["bookId"], book);
        assert!(found["label"].as_str().unwrap().ends_with("Chapter 2, Scene 9"), "{found}");

        call(&engine, "nodes.update", json!({ "id": first["id"], "patch": { "content": scene_text("Aria slept.") } }));
        let found = call(&engine, "pages.firstAppearance", json!({ "id": page["id"] }));
        assert_eq!(found["nodeId"], first["id"]);
        let all = call(&engine, "pages.firstAppearances", json!({}));
        assert_eq!(all[page["id"].as_str().unwrap()], first["id"]);

        // A deleted scene no longer counts, so the next one takes over.
        call(&engine, "nodes.delete", json!({ "id": first["id"] }));
        let found = call(&engine, "pages.firstAppearance", json!({ "id": page["id"] }));
        assert_eq!(found["nodeId"], second["id"]);
    }

    #[test]
    fn links_under_any_label_and_aliases_count_as_appearing() {
        let (engine, _dir) = project();
        let page = call(&engine, "pages.create", json!({ "title": "Aria", "aliases": ["The Ranger"] }));
        let (_book, first, second) = two_scenes(&engine);
        call(&engine, "nodes.update", json!({ "id": second["id"], "patch": { "content": linked_doc("she", "Aria") } }));
        assert_eq!(call(&engine, "pages.firstAppearance", json!({ "id": page["id"] }))["nodeId"], second["id"]);
        call(&engine, "nodes.update", json!({ "id": first["id"], "patch": { "content": linked_doc("that one", "the ranger") } }));
        assert_eq!(call(&engine, "pages.firstAppearance", json!({ "id": page["id"] }))["nodeId"], first["id"]);
        let all = call(&engine, "pages.firstAppearances", json!({}));
        assert_eq!(all[page["id"].as_str().unwrap()], first["id"]);
    }

    #[test]
    fn books_keep_their_order_and_scene_options_list_every_scene() {
        let (engine, _dir) = project();
        let (_book, first, second) = two_scenes(&engine);
        let options = call(&engine, "pages.sceneOptions", json!({}));
        let ids: Vec<&Value> = options.as_array().unwrap().iter().map(|o| &o["id"]).collect();
        assert_eq!(ids, vec![&first["id"], &second["id"]]);
        assert!(options[1]["label"].as_str().unwrap().ends_with("Chapter 2, Scene 9"));

        // A scene in a later book comes after, however recently it was written.
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        let other = call(&engine, "books.create", json!({ "title": "Book Two" }));
        let tree = call(&engine, "nodes.tree", json!({ "bookId": other["id"] }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").cloned().unwrap_or_else(|| {
            call(&engine, "nodes.create", json!({ "bookId": other["id"], "kind": "scene", "title": "Opening" }))
        });
        call(&engine, "nodes.update", json!({ "id": scene["id"], "patch": { "content": scene_text("Aria again.") } }));
        call(&engine, "nodes.update", json!({ "id": second["id"], "patch": { "content": scene_text("Aria early.") } }));
        assert_eq!(call(&engine, "pages.firstAppearance", json!({ "id": page["id"] }))["nodeId"], second["id"]);
    }

    #[test]
    fn infobox_links_group_by_field_and_type_and_ignore_links_in_the_text() {
        let (engine, _dir) = project();
        let guard = call(&engine, "pages.create", json!({ "title": "Silver Guard", "aliases": ["The Guard"] }));
        let field = |key: &str, label: &str, kind: &str, value: &str| {
            json!({ "fields": [{ "key": key, "label": label, "kind": kind, "value": value }] })
        };
        for (title, kind, infobox) in [
            ("Aria", "character", field("affiliation", "Affiliation", "pages", "Silver Guard, Others")),
            ("Bram", "character", field("affiliation", "Affiliation", "page", "the guard")),
            ("Keep", "place", field("affiliation", "Controlled by", "pages", "Silver Guard")),
            ("Plain", "character", field("note", "Note", "text", "Silver Guard")),
        ] {
            call(&engine, "pages.create", json!({ "title": title, "pageType": kind, "infobox": infobox }));
        }
        let mentioned = call(&engine, "pages.create", json!({ "title": "Mentions", "content": linked_doc("x", "Silver Guard") }));
        assert!(mentioned["id"].is_string());

        let groups = call(&engine, "pages.infoboxLinks", json!({ "id": guard["id"] }));
        let summary: Vec<(String, String, Vec<String>)> = groups
            .as_array()
            .unwrap()
            .iter()
            .map(|g| {
                (
                    g["label"].as_str().unwrap().to_string(),
                    g["pageType"].as_str().unwrap().to_string(),
                    g["pages"].as_array().unwrap().iter().map(|p| p["title"].as_str().unwrap().to_string()).collect(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("Affiliation".to_string(), "character".to_string(), vec!["Aria".to_string(), "Bram".to_string()]),
                ("Controlled by".to_string(), "place".to_string(), vec!["Keep".to_string()]),
            ],
        );
        // A page in the trash no longer counts.
        let aria = call(&engine, "pages.getByTitle", json!({ "title": "Aria" }));
        call(&engine, "pages.delete", json!({ "id": aria["id"] }));
        let groups = call(&engine, "pages.infoboxLinks", json!({ "id": guard["id"] }));
        assert_eq!(groups[0]["pages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn orphans_exclude_linked_pages() {
        let (engine, _dir) = project();
        let a = call(&engine, "pages.create", json!({ "title": "A page" }));
        call(&engine, "pages.create", json!({ "title": "B page" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": a["id"], "patch": { "content": linked_doc("to b", "B page") } }),
        );
        let orphans = call(&engine, "pages.orphans", json!({}));
        let names: Vec<&str> = orphans.as_array().unwrap().iter().map(|p| p["title"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["A page"]);
    }
}
