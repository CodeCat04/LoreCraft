//! The novel backend: books and their part > chapter > scene trees.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{ok, parse, revisions, unknown};
use crate::content;
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::indexing::{self, KIND_NODE};

pub(crate) const NODE_STATUSES: [&str; 5] = ["idea", "outline", "draft", "revised", "final"];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub author: String,
    pub position: i64,
    pub target_words: i64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    /// Cover, series, ISBN, front and back matter. `BookPublishing` in src/lib/types.ts.
    pub publishing: Value,
}

const BOOK_COLS: &str =
    "id, title, subtitle, author, position, target_words, created_at, updated_at, deleted_at, publishing";

fn book_from_row(r: &Row) -> rusqlite::Result<Book> {
    Ok(Book {
        id: r.get(0)?,
        title: r.get(1)?,
        subtitle: r.get(2)?,
        author: r.get(3)?,
        position: r.get(4)?,
        target_words: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        deleted_at: r.get(8)?,
        publishing: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or_else(|_| json!({})),
    })
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NodeMeta {
    pub id: String,
    pub book_id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub position: i64,
    pub status: String,
    pub pov_page_id: Option<String>,
    pub synopsis: String,
    pub word_count: i64,
    pub target_words: i64,
    pub story_date: String,
    pub local_only: bool,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub location_page_id: Option<String>,
}

const NODE_COLS: &str = "id, book_id, parent_id, kind, title, position, status, pov_page_id, \
                         synopsis, word_count, target_words, story_date, created_at, updated_at, deleted_at, \
                         location_page_id, local_only";

fn node_from_row(r: &Row) -> rusqlite::Result<NodeMeta> {
    Ok(NodeMeta {
        id: r.get(0)?,
        book_id: r.get(1)?,
        parent_id: r.get(2)?,
        kind: r.get(3)?,
        title: r.get(4)?,
        position: r.get(5)?,
        status: r.get(6)?,
        pov_page_id: r.get(7)?,
        synopsis: r.get(8)?,
        word_count: r.get(9)?,
        target_words: r.get(10)?,
        story_date: r.get(11)?,
        local_only: r.get::<_, i64>(16)? != 0,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
        deleted_at: r.get(14)?,
        location_page_id: r.get(15)?,
    })
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    #[serde(flatten)]
    pub meta: NodeMeta,
    pub content: Value,
    pub notes: String,
}

pub fn get_node(conn: &Connection, id: &str) -> AppResult<Node> {
    let sql = format!("SELECT {NODE_COLS}, content, notes FROM nodes WHERE id = ?1");
    let row = conn
        .query_row(&sql, [id], |r| {
            Ok((
                node_from_row(r)?,
                r.get::<_, String>(17)?,
                r.get::<_, String>(18)?,
            ))
        })
        .optional()?;
    let Some((meta, content_text, notes)) = row else {
        return Err(AppError::not_found("That item"));
    };
    let doc = if content_text.is_empty() {
        content::empty_doc()
    } else {
        serde_json::from_str(&content_text).unwrap_or_else(|_| content::empty_doc())
    };
    Ok(Node {
        meta,
        content: doc,
        notes,
    })
}

fn node_meta(conn: &Connection, id: &str) -> AppResult<NodeMeta> {
    let sql = format!("SELECT {NODE_COLS} FROM nodes WHERE id = ?1");
    conn.query_row(&sql, [id], node_from_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("That item"))
}

pub(crate) fn tree(conn: &Connection, book_id: &str) -> AppResult<Vec<NodeMeta>> {
    let sql = format!(
        "SELECT {NODE_COLS} FROM nodes WHERE book_id = ?1 AND deleted_at IS NULL
         ORDER BY position, created_at"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([book_id], node_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn check_status(status: &str) -> AppResult<()> {
    if NODE_STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(AppError::invalid(format!("Unknown status: {status}")))
    }
}

/// Enforces the tree's shape: parts at the top, chapters at the top or in a part,
/// scenes in chapters. The parent must be a live node of the same book.
fn check_placement(
    conn: &Connection,
    book_id: &str,
    kind: &str,
    parent_id: Option<&str>,
) -> AppResult<()> {
    let parent = parent_id.map(|id| node_meta(conn, id)).transpose()?;
    if let Some(parent) = &parent {
        if parent.book_id != book_id || parent.deleted_at.is_some() {
            return Err(AppError::new("BAD_PLACEMENT", "That place is not in this book."));
        }
    }
    let parent_kind = parent.map(|p| p.kind);
    let allowed = match kind {
        "part" => parent_kind.is_none(),
        "chapter" => matches!(parent_kind.as_deref(), None | Some("part")),
        "scene" => parent_kind.as_deref() == Some("chapter"),
        _ => return Err(AppError::invalid(format!("Unknown node kind: {kind}"))),
    };
    if allowed {
        Ok(())
    } else {
        Err(AppError::new(
            "BAD_PLACEMENT",
            format!(
                "A {kind} cannot go inside {}.",
                parent_kind.map_or("the book's top level".to_string(), |k| format!("a {k}"))
            ),
        ))
    }
}

fn siblings(conn: &Connection, book_id: &str, parent_id: Option<&str>) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM nodes WHERE book_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL
         ORDER BY position, created_at",
    )?;
    let rows = stmt.query_map(params![book_id, parent_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub(crate) fn write_positions(conn: &Connection, ids: &[String]) -> AppResult<()> {
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE nodes SET position = ?1 WHERE id = ?2",
            params![index as i64, id],
        )?;
    }
    Ok(())
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateNode {
    pub book_id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub title: String,
    /// Insert after this sibling. Absent means at the end.
    pub after_id: Option<String>,
    pub content: Option<Value>,
    pub synopsis: Option<String>,
    pub status: Option<String>,
}

pub fn create_node(conn: &Connection, input: CreateNode) -> AppResult<String> {
    check_placement(conn, &input.book_id, &input.kind, input.parent_id.as_deref())?;
    if let Some(status) = &input.status {
        check_status(status)?;
    }
    let id = db::new_id();
    let now = db::now();
    let doc = if input.kind == "scene" {
        Some(input.content.unwrap_or_else(content::empty_doc))
    } else {
        None
    };
    let extracted = doc.as_ref().map(content::extract);
    conn.execute(
        "INSERT INTO nodes (id, book_id, parent_id, kind, title, position, status, synopsis,
                            content, content_text, word_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        params![
            id,
            input.book_id,
            input.parent_id,
            input.kind,
            input.title,
            i64::MAX,
            input.status.unwrap_or_else(|| "draft".to_string()),
            input.synopsis.unwrap_or_default(),
            doc.as_ref().map(Value::to_string).unwrap_or_default(),
            extracted.as_ref().map(|e| e.text.clone()).unwrap_or_default(),
            extracted.as_ref().map_or(0, |e| e.word_count),
            now,
        ],
    )?;
    let mut order = siblings(conn, &input.book_id, input.parent_id.as_deref())?;
    order.retain(|other| other != &id);
    let index = input
        .after_id
        .as_ref()
        .and_then(|after| order.iter().position(|other| other == after))
        .map_or(order.len(), |i| i + 1);
    order.insert(index, id.clone());
    write_positions(conn, &order)?;
    if let Some(extracted) = &extracted {
        indexing::sync_entity(conn, KIND_NODE, &id, &input.title, extracted)?;
    }
    Ok(id)
}

pub fn seed_first_book(conn: &Connection) -> AppResult<()> {
    let book_id = create_book(conn, "Book One")?;
    let chapter = create_node(
        conn,
        CreateNode {
            book_id: book_id.clone(),
            kind: "chapter".to_string(),
            title: "Chapter 1".to_string(),
            ..Default::default()
        },
    )?;
    create_node(
        conn,
        CreateNode {
            book_id,
            parent_id: Some(chapter),
            kind: "scene".to_string(),
            title: "Scene 1".to_string(),
            ..Default::default()
        },
    )?;
    Ok(())
}

pub fn create_book(conn: &Connection, title: &str) -> AppResult<String> {
    let id = db::new_id();
    let now = db::now();
    let position: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM books",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO books (id, title, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, title, position, now],
    )?;
    Ok(id)
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct NodePatch {
    title: Option<String>,
    status: Option<String>,
    /// An empty string clears it.
    pov_page_id: Option<String>,
    /// An empty string clears it.
    location_page_id: Option<String>,
    synopsis: Option<String>,
    notes: Option<String>,
    content: Option<Value>,
    target_words: Option<i64>,
    story_date: Option<String>,
    local_only: Option<bool>,
}

/// One save that changes at least this many words is a cut or a paste, not typing.
const BULK_WORDS: i64 = 20;
/// Moved text can gain or lose a word at the edges of the selection.
const MOVE_TOLERANCE: i64 = 2;
/// The two halves of a move happen close together. Further apart, they are unrelated.
const MOVE_WINDOW_MINUTES: i64 = 15;
const LAST_BULK_KEY: &str = "write.lastBulkEdit";

fn split_delta(delta: i64) -> (i64, i64) {
    if delta > 0 {
        (delta, 0)
    } else {
        (0, -delta)
    }
}

/// Finds the other half of a move: the last bulk edit, if it went the opposite way by
/// about the same amount, today and within the last few minutes. Otherwise this edit
/// becomes the last one.
fn other_half_of_move(
    conn: &Connection,
    book_id: &str,
    day: &str,
    delta: i64,
) -> AppResult<Option<(String, i64)>> {
    let stored: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [LAST_BULK_KEY], |r| r.get(0))
        .optional()?;
    let last = stored.and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let now = chrono::Utc::now();
    let earlier = last.as_ref().and_then(|v| {
        let their_delta = v["delta"].as_i64()?;
        let at = chrono::DateTime::parse_from_rfc3339(v["at"].as_str()?).ok()?;
        let recent = now.signed_duration_since(at).num_minutes() < MOVE_WINDOW_MINUTES;
        let same_day = v["day"].as_str() == Some(day);
        let opposite = their_delta.signum() == -delta.signum();
        let close = (their_delta.abs() - delta.abs()).abs() <= MOVE_TOLERANCE;
        (recent && same_day && opposite && close)
            .then(|| (v["book"].as_str().unwrap_or(book_id).to_string(), their_delta))
    });
    if earlier.is_some() {
        conn.execute("DELETE FROM meta WHERE key = ?1", [LAST_BULK_KEY])?;
    } else {
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
            params![
                LAST_BULK_KEY,
                json!({ "book": book_id, "day": day, "delta": delta, "at": db::now() }).to_string()
            ],
        )?;
    }
    Ok(earlier)
}

/// Adds to the day's progress. Cutting a passage from one scene and pasting it into
/// another is not new writing, so a bulk edit that cancels the previous one takes that
/// one back out of the log and records nothing itself.
fn record_words(conn: &Connection, book_id: &str, delta: i64) -> AppResult<()> {
    if delta == 0 {
        return Ok(());
    }
    let day = db::local_day();
    if delta.abs() >= BULK_WORDS {
        if let Some((book, earlier)) = other_half_of_move(conn, book_id, &day, delta)? {
            let (added, removed) = split_delta(earlier);
            conn.execute(
                "UPDATE writing_log
                 SET words_added = MAX(0, words_added - ?1),
                     words_removed = MAX(0, words_removed - ?2)
                 WHERE day = ?3 AND book_id = ?4",
                params![added, removed, day, book],
            )?;
            return Ok(());
        }
    }
    let (added, removed) = split_delta(delta);
    conn.execute(
        "INSERT INTO writing_log (day, book_id, words_added, words_removed)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(day, book_id) DO UPDATE SET
           words_added = words_added + excluded.words_added,
           words_removed = words_removed + excluded.words_removed",
        params![day, book_id, added, removed],
    )?;
    Ok(())
}

fn update_node(conn: &Connection, id: &str, patch: NodePatch) -> AppResult<NodeMeta> {
    let current = node_meta(conn, id)?;
    if current.deleted_at.is_some() {
        return Err(AppError::not_found("That item"));
    }
    if let Some(value) = &patch.title {
        conn.execute("UPDATE nodes SET title = ?1 WHERE id = ?2", params![value, id])?;
    }
    if let Some(value) = &patch.status {
        check_status(value)?;
        conn.execute("UPDATE nodes SET status = ?1 WHERE id = ?2", params![value, id])?;
    }
    if let Some(value) = &patch.pov_page_id {
        let stored = if value.is_empty() { None } else { Some(value) };
        conn.execute(
            "UPDATE nodes SET pov_page_id = ?1 WHERE id = ?2",
            params![stored, id],
        )?;
    }
    if let Some(value) = &patch.location_page_id {
        let stored = if value.is_empty() { None } else { Some(value) };
        conn.execute(
            "UPDATE nodes SET location_page_id = ?1 WHERE id = ?2",
            params![stored, id],
        )?;
    }
    if let Some(value) = &patch.synopsis {
        conn.execute("UPDATE nodes SET synopsis = ?1 WHERE id = ?2", params![value, id])?;
    }
    if let Some(value) = &patch.notes {
        conn.execute("UPDATE nodes SET notes = ?1 WHERE id = ?2", params![value, id])?;
    }
    if let Some(value) = patch.target_words {
        conn.execute(
            "UPDATE nodes SET target_words = ?1 WHERE id = ?2",
            params![value.max(0), id],
        )?;
    }
    if let Some(value) = &patch.story_date {
        conn.execute(
            "UPDATE nodes SET story_date = ?1 WHERE id = ?2",
            params![value, id],
        )?;
    }

    if let Some(value) = patch.local_only {
        conn.execute("UPDATE nodes SET local_only = ?1 WHERE id = ?2", params![value as i64, id])?;
    }

    let title = patch.title.clone().unwrap_or_else(|| current.title.clone());
    if let Some(doc) = &patch.content {
        if current.kind != "scene" {
            return Err(AppError::invalid("Only scenes hold text."));
        }
        revisions::auto_checkpoint(conn, KIND_NODE, id)?;
        let extracted = content::extract(doc);
        conn.execute(
            "UPDATE nodes SET content = ?1, content_text = ?2, word_count = ?3 WHERE id = ?4",
            params![doc.to_string(), extracted.text, extracted.word_count, id],
        )?;
        record_words(conn, &current.book_id, extracted.word_count - current.word_count)?;
        indexing::sync_entity(conn, KIND_NODE, id, &title, &extracted)?;
    } else if patch.title.is_some() && current.kind == "scene" {
        let text: String =
            conn.query_row("SELECT content_text FROM nodes WHERE id = ?1", [id], |r| r.get(0))?;
        indexing::write_search(conn, KIND_NODE, id, &title, &text)?;
    }
    conn.execute(
        "UPDATE nodes SET updated_at = ?1 WHERE id = ?2",
        params![db::now(), id],
    )?;
    node_meta(conn, id)
}

fn is_descendant(conn: &Connection, candidate: &str, ancestor: &str) -> AppResult<bool> {
    let mut cursor = Some(candidate.to_string());
    while let Some(id) = cursor {
        if id == ancestor {
            return Ok(true);
        }
        cursor = conn
            .query_row("SELECT parent_id FROM nodes WHERE id = ?1", [&id], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten();
    }
    Ok(false)
}

fn move_node(
    conn: &Connection,
    id: &str,
    parent_id: Option<&str>,
    index: Option<usize>,
) -> AppResult<()> {
    let node = node_meta(conn, id)?;
    if node.deleted_at.is_some() {
        return Err(AppError::not_found("That item"));
    }
    if let Some(parent) = parent_id {
        if is_descendant(conn, parent, id)? {
            return Err(AppError::new(
                "BAD_PLACEMENT",
                "An item cannot be moved inside itself.",
            ));
        }
    }
    check_placement(conn, &node.book_id, &node.kind, parent_id)?;
    let mut old_order = siblings(conn, &node.book_id, node.parent_id.as_deref())?;
    old_order.retain(|other| other != id);
    write_positions(conn, &old_order)?;

    conn.execute(
        "UPDATE nodes SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![parent_id, db::now(), id],
    )?;
    let mut order = siblings(conn, &node.book_id, parent_id)?;
    order.retain(|other| other != id);
    let at = index.unwrap_or(order.len()).min(order.len());
    order.insert(at, id.to_string());
    write_positions(conn, &order)
}

fn descendants(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE tree(id) AS (
           SELECT ?1
           UNION ALL
           SELECT n.id FROM nodes n JOIN tree t ON n.parent_id = t.id
         )
         SELECT id FROM tree",
    )?;
    let rows = stmt.query_map([id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub(crate) fn delete_node(conn: &Connection, id: &str) -> AppResult<()> {
    let node = node_meta(conn, id)?;
    let now = db::now();
    for target in descendants(conn, id)? {
        conn.execute(
            "UPDATE nodes SET deleted_at = ?1, updated_at = ?1
             WHERE id = ?2 AND deleted_at IS NULL",
            params![now, target],
        )?;
        indexing::remove_entity(conn, KIND_NODE, &target)?;
    }
    let order = siblings(conn, &node.book_id, node.parent_id.as_deref())?;
    write_positions(conn, &order)
}

/// Deletes a node in the trash for good, with everything inside it, its saved versions
/// and the records of where its text went. It can't be undone.
fn purge_node(conn: &Connection, id: &str) -> AppResult<()> {
    if node_meta(conn, id)?.deleted_at.is_none() {
        return Err(AppError::invalid("Move it to the trash first."));
    }
    let targets = descendants(conn, id)?;
    for target in &targets {
        for table in ["revisions", "summaries", "embeddings"] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE entity_kind = ?1 AND entity_id = ?2"),
                params![KIND_NODE, target],
            )?;
        }
        for prefix in SCENE_META_PREFIXES {
            conn.execute("DELETE FROM meta WHERE key = ?1", [format!("{prefix}{target}")])?;
        }
        // Records on other scenes that point at this one can no longer be used.
        conn.execute(
            "DELETE FROM meta WHERE (key LIKE 'splitFrom:%' OR key LIKE 'mergedInto:%')
             AND json_valid(value)
             AND (json_extract(value, '$.from') = ?1 OR json_extract(value, '$.into') = ?1)",
            [target],
        )?;
        conn.execute("DELETE FROM node_cast WHERE node_id = ?1", [target])?;
        conn.execute("DELETE FROM node_threads WHERE node_id = ?1", [target])?;
        indexing::remove_entity(conn, KIND_NODE, target)?;
    }
    for target in targets.iter().rev() {
        conn.execute("DELETE FROM nodes WHERE id = ?1", [target])?;
    }
    Ok(())
}

/// Brings back a node that a bulk change put in the trash, as undoing an import does. One
/// whose parent is gone too stays there, since it comes back with that parent.
pub(crate) fn restore_from_trash(conn: &Connection, id: &str) -> AppResult<()> {
    let node = node_meta(conn, id)?;
    if let Some(parent) = &node.parent_id {
        if node_meta(conn, parent)?.deleted_at.is_some() {
            return Ok(());
        }
    }
    restore_node(conn, id)
}

/// Restores a node and whatever was deleted along with it, not items the user
/// had deleted earlier on their own.
fn restore_node(conn: &Connection, id: &str) -> AppResult<()> {
    let node = node_meta(conn, id)?;
    let Some(deleted_at) = node.deleted_at else {
        return Ok(());
    };
    if let Some(parent) = &node.parent_id {
        if node_meta(conn, parent)?.deleted_at.is_some() {
            return Err(AppError::new(
                "BAD_PLACEMENT",
                "Restore the item that contained this one first.",
            ));
        }
    }
    for target in descendants(conn, id)? {
        let row = node_meta(conn, &target)?;
        if row.deleted_at.as_deref() != Some(deleted_at.as_str()) {
            continue;
        }
        conn.execute(
            "UPDATE nodes SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
            params![db::now(), target],
        )?;
        if row.kind == "scene" {
            let doc = get_node(conn, &target)?.content;
            let extracted = content::extract(&doc);
            indexing::sync_entity(conn, KIND_NODE, &target, &row.title, &extracted)?;
        }
    }
    // Its old position may now belong to another sibling, so put it back in order.
    let mut order = siblings(conn, &node.book_id, node.parent_id.as_deref())?;
    order.retain(|other| other != id);
    let at = usize::try_from(node.position).unwrap_or(0).min(order.len());
    order.insert(at, id.to_string());
    write_positions(conn, &order)
}

/// The pages for the characters in a scene, in title order.
pub fn cast_of(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT c.page_id FROM node_cast c JOIN pages p ON p.id = c.page_id
         WHERE c.node_id = ?1 AND p.deleted_at IS NULL
         ORDER BY p.title_key",
    )?;
    let rows = stmt.query_map([id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn set_cast(conn: &Connection, id: &str, page_ids: &[String]) -> AppResult<()> {
    let node = node_meta(conn, id)?;
    if node.deleted_at.is_some() || node.kind != "scene" {
        return Err(AppError::invalid("Only scenes have a cast."));
    }
    conn.execute("DELETE FROM node_cast WHERE node_id = ?1", [id])?;
    for page_id in page_ids {
        conn.execute(
            "INSERT OR IGNORE INTO node_cast (node_id, page_id)
             SELECT ?1, id FROM pages WHERE id = ?2 AND deleted_at IS NULL",
            params![id, page_id],
        )?;
    }
    conn.execute(
        "UPDATE nodes SET updated_at = ?1 WHERE id = ?2",
        params![db::now(), id],
    )?;
    Ok(())
}

/// Live scenes of a book in reading order.
fn scenes_in_order(conn: &Connection, book_id: &str) -> AppResult<Vec<NodeMeta>> {
    fn walk(nodes: &[NodeMeta], parent: Option<&str>, out: &mut Vec<NodeMeta>) {
        for node in nodes.iter().filter(|n| n.parent_id.as_deref() == parent) {
            if node.kind == "scene" {
                out.push(node.clone());
            } else {
                walk(nodes, Some(&node.id), out);
            }
        }
    }
    let nodes = tree(conn, book_id)?;
    let mut out = Vec::new();
    walk(&nodes, None, &mut out);
    Ok(out)
}

/// Replaces a scene's text without counting it as writing, because the words are only
/// moving between scenes.
fn write_moved_text(conn: &Connection, id: &str, title: &str, doc: &Value) -> AppResult<()> {
    let extracted = content::extract(doc);
    conn.execute(
        "UPDATE nodes SET content = ?1, content_text = ?2, word_count = ?3, updated_at = ?4
         WHERE id = ?5",
        params![doc.to_string(), extracted.text, extracted.word_count, db::now(), id],
    )?;
    indexing::sync_entity(conn, KIND_NODE, id, title, &extracted)
}

fn live_scene(conn: &Connection, id: &str) -> AppResult<NodeMeta> {
    let node = node_meta(conn, id)?;
    if node.deleted_at.is_some() {
        return Err(AppError::not_found("That scene"));
    }
    if node.kind != "scene" {
        return Err(AppError::invalid("Only scenes hold text."));
    }
    Ok(node)
}

/// Meta keys that remember where a scene's text went, so undoing a split or restoring a
/// merged scene from the trash gives the text back once, not twice.
const SPLIT_KEY: &str = "splitFrom:";
const MERGED_KEY: &str = "mergedInto:";
/// They name this project's scenes, so an import never brings them from another project.
pub(crate) const SCENE_META_PREFIXES: [&str; 2] = [SPLIT_KEY, MERGED_KEY];

fn meta_json(conn: &Connection, key: &str) -> AppResult<Option<Value>> {
    let text: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()?;
    Ok(text.and_then(|t| serde_json::from_str(&t).ok()))
}

fn set_meta_json(conn: &Connection, key: &str, value: &Value) -> AppResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params![key, value.to_string()],
    )?;
    Ok(())
}

fn content_hash(conn: &Connection, id: &str) -> AppResult<String> {
    let text: String = conn.query_row("SELECT content FROM nodes WHERE id = ?1", [id], |r| r.get(0))?;
    Ok(revisions::hash(&text))
}

/// The text of a scene before it was split, if `second` was split off `first` and neither
/// has changed since. Merging them back then gives back exactly what was there, even a
/// paragraph the split cut in two.
fn unsplit_text(conn: &Connection, first: &str, second: &str) -> AppResult<Option<Value>> {
    let Some(record) = meta_json(conn, &format!("{SPLIT_KEY}{second}"))? else {
        return Ok(None);
    };
    let unchanged = record["from"].as_str() == Some(first)
        && record["before"].as_str() == Some(content_hash(conn, first)?.as_str())
        && record["after"].as_str() == Some(content_hash(conn, second)?.as_str());
    let Some(revision) = record["revision"].as_str().filter(|_| unchanged) else {
        return Ok(None);
    };
    let text: Option<String> = conn
        .query_row("SELECT content FROM revisions WHERE id = ?1", [revision], |r| r.get(0))
        .optional()?;
    Ok(text.and_then(|t| serde_json::from_str(&t).ok()))
}

/// Before a merged-away scene comes back from the trash, takes its text back out of the
/// scene it was merged into, so its words are not in two places. The details the merge
/// joined go back too, unless they were edited since. Returns the scene whose text changed.
/// Fails with `MERGED_TEXT_CHANGED` when that text is no longer there as it was, unless
/// `force`, which restores the scene and leaves the other alone.
fn unmerge(conn: &Connection, id: &str, force: bool) -> AppResult<Option<String>> {
    let key = format!("{MERGED_KEY}{id}");
    let Some(record) = meta_json(conn, &key)? else {
        return Ok(None);
    };
    conn.execute("DELETE FROM meta WHERE key = ?1", [&key])?;
    let Some(into) = record["into"].as_str() else {
        return Ok(None);
    };
    let kept = match get_node(conn, into) {
        Ok(node) if node.meta.deleted_at.is_none() && node.meta.kind == "scene" => node,
        // The other scene is gone too, so nothing would be repeated.
        _ => return Ok(None),
    };
    let blocks = |doc: &Value| doc["content"].as_array().cloned().unwrap_or_default();
    let ours: Vec<Value> = blocks(&get_node(conn, id)?.content)
        .into_iter()
        .skip_while(is_empty_paragraph)
        .collect();
    let mut held = blocks(&kept.content);
    // From the end, since the merge put it there and later writing usually follows it.
    let found = (!ours.is_empty() && held.len() >= ours.len())
        .then(|| (0..=held.len() - ours.len()).rev().find(|&at| held[at..at + ours.len()] == ours[..]))
        .flatten();
    if found.is_none() && !ours.is_empty() {
        if force {
            return Ok(None);
        }
        return Err(AppError::new(
            "MERGED_TEXT_CHANGED",
            "This scene was merged into another one, which has changed since.",
        ));
    }
    revisions::checkpoint(conn, KIND_NODE, into, "unmerge")?;
    if let Some(at) = found {
        held.drain(at..at + ours.len());
        let doc = if held.is_empty() {
            content::empty_doc()
        } else {
            json!({ "type": "doc", "content": held })
        };
        write_moved_text(conn, into, &kept.meta.title, &doc)?;
    }
    let back = |field: &str, current: &str| -> Option<String> {
        let pair = record[field].as_array()?;
        (pair.get(1)?.as_str()? == current).then(|| pair.first()?.as_str().map(str::to_string))?
    };
    if let Some(synopsis) = back("synopsis", &kept.meta.synopsis) {
        conn.execute("UPDATE nodes SET synopsis = ?1 WHERE id = ?2", params![synopsis, into])?;
    }
    if let Some(notes) = back("notes", &kept.notes) {
        conn.execute("UPDATE nodes SET notes = ?1 WHERE id = ?2", params![notes, into])?;
    }
    let target = record["targetWords"].as_array();
    if let Some([before, after]) = target.map(Vec::as_slice) {
        if after.as_i64() == Some(kept.meta.target_words) {
            conn.execute(
                "UPDATE nodes SET target_words = ?1 WHERE id = ?2",
                params![before.as_i64().unwrap_or(0), into],
            )?;
        }
    }
    Ok(Some(into.to_string()))
}

/// Splits a scene in two. The caller cuts the document, since only the editor knows where
/// the cursor is. The new scene comes straight after and starts out with the same details.
fn split_scene(
    conn: &Connection,
    id: &str,
    before: &Value,
    after: &Value,
    title: Option<String>,
) -> AppResult<NodeMeta> {
    let node = live_scene(conn, id)?;
    if before["type"] != "doc" || after["type"] != "doc" {
        return Err(AppError::invalid("A split needs two documents."));
    }
    let whole = revisions::snapshot(conn, KIND_NODE, id, "split")?;
    write_moved_text(conn, id, &node.title, before)?;
    let new_id = create_node(
        conn,
        CreateNode {
            book_id: node.book_id.clone(),
            parent_id: node.parent_id.clone(),
            kind: "scene".to_string(),
            title: title.unwrap_or_else(|| {
                if node.title.trim().is_empty() {
                    String::new()
                } else {
                    format!("{} (continued)", node.title)
                }
            }),
            after_id: Some(id.to_string()),
            content: Some(after.clone()),
            synopsis: None,
            status: Some(node.status.clone()),
        },
    )?;
    conn.execute(
        // Local-only comes along, or half of a private scene could reach a cloud AI.
        "UPDATE nodes SET pov_page_id = ?1, location_page_id = ?2, story_date = ?3, local_only = ?4
         WHERE id = ?5",
        params![node.pov_page_id, node.location_page_id, node.story_date, node.local_only as i64, new_id],
    )?;
    conn.execute(
        "INSERT INTO node_cast (node_id, page_id) SELECT ?1, page_id FROM node_cast WHERE node_id = ?2",
        params![new_id, id],
    )?;
    conn.execute(
        "INSERT INTO node_threads (node_id, thread_id)
         SELECT ?1, thread_id FROM node_threads WHERE node_id = ?2",
        params![new_id, id],
    )?;
    // The new half starts its own history, and merging it back while neither half has
    // changed gives back the text exactly as it was.
    revisions::checkpoint(conn, KIND_NODE, &new_id, "split-off")?;
    if let Some(revision) = whole {
        let record = json!({
            "from": id,
            "revision": revision,
            "before": content_hash(conn, id)?,
            "after": content_hash(conn, &new_id)?,
        });
        set_meta_json(conn, &format!("{SPLIT_KEY}{new_id}"), &record)?;
    }
    node_meta(conn, &new_id)
}

fn is_empty_paragraph(block: &Value) -> bool {
    block["type"] == "paragraph" && block["content"].as_array().is_none_or(Vec::is_empty)
}

/// Both documents' blocks, one after the other, without the blank paragraphs at the join.
fn joined_docs(first: &Value, second: &Value) -> Value {
    let blocks = |doc: &Value| doc["content"].as_array().cloned().unwrap_or_default();
    let mut joined = blocks(first);
    while joined.last().is_some_and(is_empty_paragraph) {
        joined.pop();
    }
    joined.extend(blocks(second).into_iter().skip_while(is_empty_paragraph));
    if joined.is_empty() {
        return content::empty_doc();
    }
    json!({ "type": "doc", "content": joined })
}

/// Text from two fields on one subject, with a blank line between them if both have some.
fn joined_text(first: &str, second: &str) -> String {
    match (first.trim().is_empty(), second.trim().is_empty()) {
        (_, true) => first.to_string(),
        (true, false) => second.to_string(),
        (false, false) => format!("{first}\n\n{second}"),
    }
}

/// Moves the next scene in reading order onto the end of this one, and puts it in the
/// trash. Both are checkpointed first, so either can be brought back as it was.
fn merge_scene(conn: &Connection, id: &str) -> AppResult<NodeMeta> {
    let node = live_scene(conn, id)?;
    let order = scenes_in_order(conn, &node.book_id)?;
    let at = order.iter().position(|n| n.id == id);
    let Some(next) = at.and_then(|at| order.get(at + 1)) else {
        return Err(AppError::new("NO_NEXT_SCENE", "This is the last scene in the book."));
    };
    revisions::checkpoint(conn, KIND_NODE, id, "merge")?;
    revisions::checkpoint(conn, KIND_NODE, &next.id, "merge")?;
    let first = get_node(conn, id)?;
    let second = get_node(conn, &next.id)?;
    let joined = match unsplit_text(conn, id, &next.id)? {
        Some(whole) => whole,
        None => joined_docs(&first.content, &second.content),
    };
    write_moved_text(conn, id, &node.title, &joined)?;
    let synopsis = joined_text(&first.meta.synopsis, &second.meta.synopsis);
    let notes = joined_text(&first.notes, &second.notes);
    let target_words = first.meta.target_words + second.meta.target_words;
    conn.execute(
        "UPDATE nodes SET synopsis = ?1, notes = ?2, target_words = ?3 WHERE id = ?4",
        params![synopsis, notes, target_words, id],
    )?;
    // What restoring the other scene from the trash needs to take back out of this one.
    let record = json!({
        "into": id,
        "synopsis": [first.meta.synopsis, synopsis],
        "notes": [first.notes, notes],
        "targetWords": [first.meta.target_words, target_words],
    });
    set_meta_json(conn, &format!("{MERGED_KEY}{}", next.id), &record)?;
    conn.execute("DELETE FROM meta WHERE key = ?1", [format!("{SPLIT_KEY}{}", next.id)])?;
    // The joined text holds both, so it is as private as the more private of the two.
    if second.meta.local_only {
        conn.execute("UPDATE nodes SET local_only = 1 WHERE id = ?1", [id])?;
    }
    conn.execute(
        "INSERT OR IGNORE INTO node_cast (node_id, page_id)
         SELECT ?1, page_id FROM node_cast WHERE node_id = ?2",
        params![id, next.id],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO node_threads (node_id, thread_id)
         SELECT ?1, thread_id FROM node_threads WHERE node_id = ?2",
        params![id, next.id],
    )?;
    super::pages::repoint_change_scenes(conn, &next.id, id)?;
    delete_node(conn, &next.id)?;
    node_meta(conn, id)
}

/// Which pages each scene of a book names or lists in its cast, for the presence chart.
fn presence(conn: &Connection, book_id: &str) -> AppResult<Value> {
    let mut stmt = conn.prepare(
        "SELECT m.source_id, m.page_id, m.count FROM mentions m
         JOIN nodes n ON n.id = m.source_id
         WHERE m.source_kind = ?1 AND n.book_id = ?2 AND n.deleted_at IS NULL",
    )?;
    let named = stmt.query_map(params![KIND_NODE, book_id], |r| {
        Ok(json!({
            "nodeId": r.get::<_, String>(0)?,
            "pageId": r.get::<_, String>(1)?,
            "count": r.get::<_, i64>(2)?,
        }))
    })?;
    let mentions: Vec<Value> = named.collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare(
        "SELECT c.node_id, c.page_id FROM node_cast c
         JOIN nodes n ON n.id = c.node_id
         WHERE n.book_id = ?1 AND n.deleted_at IS NULL",
    )?;
    let listed = stmt.query_map([book_id], |r| {
        Ok(json!({ "nodeId": r.get::<_, String>(0)?, "pageId": r.get::<_, String>(1)? }))
    })?;
    let cast: Vec<Value> = listed.collect::<Result<_, _>>()?;
    Ok(json!({ "mentions": mentions, "cast": cast }))
}

fn thread_from_row(r: &Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "name": r.get::<_, String>(1)?,
        "color": r.get::<_, String>(2)?,
        "description": r.get::<_, String>(3)?,
        "position": r.get::<_, i64>(4)?,
    }))
}

const THREAD_COLS: &str = "id, name, color, description, position";

/// Plot threads, which belong to the project, and which scenes they run through.
pub fn handle_threads(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    #[derive(Deserialize)]
    struct IdParam {
        id: String,
    }
    match action {
        "list" => engine.read(|c| {
            let sql = format!("SELECT {THREAD_COLS} FROM threads ORDER BY position, name");
            let mut stmt = c.prepare(&sql)?;
            let rows = stmt.query_map([], thread_from_row)?;
            Ok(Value::Array(rows.collect::<Result<_, _>>()?))
        }),
        "create" => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct P {
                name: String,
                color: Option<String>,
                description: String,
            }
            let p: P = parse(params)?;
            let name = p.name.trim().to_string();
            if name.is_empty() {
                return Err(AppError::invalid("A thread needs a name."));
            }
            let thread = engine.write(|tx| {
                let id = db::new_id();
                tx.execute(
                    "INSERT INTO threads (id, name, color, description, position)
                     SELECT ?1, ?2, ?3, ?4, COALESCE(MAX(position) + 1, 0) FROM threads",
                    params![id, name, p.color.as_deref().unwrap_or("accent"), p.description],
                )?;
                let sql = format!("SELECT {THREAD_COLS} FROM threads WHERE id = ?1");
                Ok(tx.query_row(&sql, [&id], thread_from_row)?)
            })?;
            engine.notify("threads");
            Ok(thread)
        }
        "update" => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct Patch {
                name: Option<String>,
                color: Option<String>,
                description: Option<String>,
            }
            #[derive(Deserialize)]
            struct P {
                id: String,
                patch: Patch,
            }
            let p: P = parse(params)?;
            engine.write(|tx| {
                if let Some(name) = &p.patch.name {
                    let name = name.trim();
                    if name.is_empty() {
                        return Err(AppError::invalid("A thread needs a name."));
                    }
                    tx.execute("UPDATE threads SET name = ?1 WHERE id = ?2", params![name, p.id])?;
                }
                if let Some(color) = &p.patch.color {
                    tx.execute("UPDATE threads SET color = ?1 WHERE id = ?2", params![color, p.id])?;
                }
                if let Some(text) = &p.patch.description {
                    tx.execute(
                        "UPDATE threads SET description = ?1 WHERE id = ?2",
                        params![text, p.id],
                    )?;
                }
                Ok(())
            })?;
            engine.notify("threads");
            ok(true)
        }
        "delete" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| {
                tx.execute("DELETE FROM threads WHERE id = ?1", [&p.id])?;
                Ok(())
            })?;
            engine.notify("threads");
            ok(true)
        }
        "reorder" => {
            #[derive(Deserialize)]
            struct P {
                ids: Vec<String>,
            }
            let p: P = parse(params)?;
            engine.write(|tx| {
                for (index, id) in p.ids.iter().enumerate() {
                    tx.execute(
                        "UPDATE threads SET position = ?1 WHERE id = ?2",
                        params![index as i64, id],
                    )?;
                }
                Ok(())
            })?;
            engine.notify("threads");
            ok(true)
        }
        "links" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                book_id: String,
            }
            let p: P = parse(params)?;
            engine.read(|c| {
                let mut stmt = c.prepare(
                    "SELECT t.node_id, t.thread_id FROM node_threads t
                     JOIN nodes n ON n.id = t.node_id
                     WHERE n.book_id = ?1 AND n.deleted_at IS NULL",
                )?;
                let rows = stmt.query_map([&p.book_id], |r| {
                    Ok(json!({
                        "nodeId": r.get::<_, String>(0)?,
                        "threadId": r.get::<_, String>(1)?,
                    }))
                })?;
                Ok(Value::Array(rows.collect::<Result<_, _>>()?))
            })
        }
        "setLink" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                node_id: String,
                thread_id: String,
                on: bool,
            }
            let p: P = parse(params)?;
            engine.write(|tx| {
                let node = live_scene(tx, &p.node_id)?;
                if p.on {
                    tx.execute(
                        "INSERT OR IGNORE INTO node_threads (node_id, thread_id) VALUES (?1, ?2)",
                        params![node.id, p.thread_id],
                    )?;
                } else {
                    tx.execute(
                        "DELETE FROM node_threads WHERE node_id = ?1 AND thread_id = ?2",
                        params![node.id, p.thread_id],
                    )?;
                }
                Ok(())
            })?;
            engine.notify("threads");
            ok(true)
        }
        _ => Err(unknown(&format!("threads.{action}"))),
    }
}

/// The wiki pages named in a scene, most mentioned first.
fn mentions(conn: &Connection, id: &str) -> AppResult<Value> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, p.page_type, p.status, m.count
         FROM mentions m JOIN pages p ON p.id = m.page_id
         WHERE m.source_kind = ?1 AND m.source_id = ?2 AND p.deleted_at IS NULL
         ORDER BY m.count DESC, p.title_key",
    )?;
    let rows = stmt.query_map(params![KIND_NODE, id], |r| {
        Ok(json!({
            "pageId": r.get::<_, String>(0)?,
            "title": r.get::<_, String>(1)?,
            "pageType": r.get::<_, String>(2)?,
            "status": r.get::<_, String>(3)?,
            "count": r.get::<_, i64>(4)?,
        }))
    })?;
    Ok(Value::Array(rows.collect::<Result<_, _>>()?))
}

fn stats(conn: &Connection, book_id: &str) -> AppResult<Value> {
    let words: i64 = conn.query_row(
        "SELECT COALESCE(SUM(word_count), 0) FROM nodes
         WHERE book_id = ?1 AND deleted_at IS NULL AND kind = 'scene'",
        [book_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT day, words_added, words_removed FROM writing_log
         WHERE book_id = ?1 ORDER BY day DESC LIMIT 400",
    )?;
    let rows = stmt.query_map([book_id], |r| {
        Ok(json!({
            "day": r.get::<_, String>(0)?,
            "added": r.get::<_, i64>(1)?,
            "removed": r.get::<_, i64>(2)?,
        }))
    })?;
    let days: Vec<Value> = rows.collect::<Result<_, _>>()?;
    let today = db::local_day();
    let written_today = days
        .iter()
        .find(|d| d["day"] == json!(today))
        .and_then(|d| d["added"].as_i64())
        .unwrap_or(0);
    Ok(json!({ "words": words, "writtenToday": written_today, "days": days }))
}

pub fn handle_books(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    #[derive(Deserialize)]
    struct IdParam {
        id: String,
    }
    match action {
        "list" => engine.read(|c| {
            let sql = format!(
                "SELECT {BOOK_COLS} FROM books WHERE deleted_at IS NULL ORDER BY position, created_at"
            );
            let mut stmt = c.prepare(&sql)?;
            let rows = stmt.query_map([], book_from_row)?;
            let books: Vec<Book> = rows.collect::<Result<_, _>>()?;
            ok(books)
        }),
        "trash" => engine.read(|c| {
            let sql = format!(
                "SELECT {BOOK_COLS} FROM books WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
            );
            let mut stmt = c.prepare(&sql)?;
            let rows = stmt.query_map([], book_from_row)?;
            let books: Vec<Book> = rows.collect::<Result<_, _>>()?;
            ok(books)
        }),
        "create" => {
            #[derive(Deserialize)]
            struct P {
                title: String,
            }
            let p: P = parse(params)?;
            let id = engine.write(|tx| {
                let id = create_book(tx, &p.title)?;
                let chapter = create_node(
                    tx,
                    CreateNode {
                        book_id: id.clone(),
                        kind: "chapter".to_string(),
                        title: "Chapter 1".to_string(),
                        ..Default::default()
                    },
                )?;
                create_node(
                    tx,
                    CreateNode {
                        book_id: id.clone(),
                        parent_id: Some(chapter),
                        kind: "scene".to_string(),
                        title: "Scene 1".to_string(),
                        ..Default::default()
                    },
                )?;
                Ok(id)
            })?;
            engine.notify("books");
            ok(json!({ "id": id }))
        }
        "update" => {
            #[derive(Deserialize, Default)]
            #[serde(rename_all = "camelCase", default)]
            struct Patch {
                title: Option<String>,
                subtitle: Option<String>,
                author: Option<String>,
                target_words: Option<i64>,
                publishing: Option<Value>,
            }
            #[derive(Deserialize)]
            struct P {
                id: String,
                patch: Patch,
            }
            let p: P = parse(params)?;
            if p.patch.publishing.as_ref().is_some_and(|v| !v.is_object()) {
                return Err(AppError::invalid("A book's publishing details must be an object."));
            }
            engine.write(|tx| {
                if let Some(v) = &p.patch.publishing {
                    tx.execute(
                        "UPDATE books SET publishing = ?1 WHERE id = ?2",
                        params![v.to_string(), p.id],
                    )?;
                }
                if let Some(v) = &p.patch.title {
                    tx.execute("UPDATE books SET title = ?1 WHERE id = ?2", params![v, p.id])?;
                }
                if let Some(v) = &p.patch.subtitle {
                    tx.execute("UPDATE books SET subtitle = ?1 WHERE id = ?2", params![v, p.id])?;
                }
                if let Some(v) = &p.patch.author {
                    tx.execute("UPDATE books SET author = ?1 WHERE id = ?2", params![v, p.id])?;
                }
                if let Some(v) = p.patch.target_words {
                    tx.execute(
                        "UPDATE books SET target_words = ?1 WHERE id = ?2",
                        params![v.max(0), p.id],
                    )?;
                }
                tx.execute(
                    "UPDATE books SET updated_at = ?1 WHERE id = ?2",
                    params![db::now(), p.id],
                )?;
                Ok(())
            })?;
            engine.notify("books");
            ok(true)
        }
        "delete" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| {
                let now = db::now();
                tx.execute(
                    "UPDATE books SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
                    params![now, p.id],
                )?;
                // A deleted book's scenes must not appear in search.
                let mut stmt = tx.prepare("SELECT id FROM nodes WHERE book_id = ?1")?;
                let ids: Vec<String> = stmt
                    .query_map([&p.id], |r| r.get(0))?
                    .collect::<Result<_, _>>()?;
                for id in ids {
                    indexing::remove_entity(tx, KIND_NODE, &id)?;
                }
                Ok(())
            })?;
            engine.notify("books");
            ok(true)
        }
        "restore" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| {
                tx.execute(
                    "UPDATE books SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
                    params![db::now(), p.id],
                )?;
                for node in tree(tx, &p.id)? {
                    if node.kind == "scene" {
                        let doc = get_node(tx, &node.id)?.content;
                        let extracted = content::extract(&doc);
                        indexing::sync_entity(tx, KIND_NODE, &node.id, &node.title, &extracted)?;
                    }
                }
                Ok(())
            })?;
            engine.notify("books");
            ok(true)
        }
        "reorder" => {
            #[derive(Deserialize)]
            struct P {
                ids: Vec<String>,
            }
            let p: P = parse(params)?;
            engine.write(|tx| {
                for (index, id) in p.ids.iter().enumerate() {
                    tx.execute(
                        "UPDATE books SET position = ?1 WHERE id = ?2",
                        params![index as i64, id],
                    )?;
                }
                Ok(())
            })?;
            engine.notify("books");
            ok(true)
        }
        _ => Err(unknown(&format!("books.{action}"))),
    }
}

pub fn handle_nodes(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    #[derive(Deserialize)]
    struct IdParam {
        id: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BookParam {
        book_id: String,
    }
    match action {
        "tree" => {
            let p: BookParam = parse(params)?;
            ok(engine.read(|c| tree(c, &p.book_id))?)
        }
        "get" => {
            let p: IdParam = parse(params)?;
            ok(engine.read(|c| get_node(c, &p.id))?)
        }
        "create" => {
            let input: CreateNode = parse(params)?;
            let meta = engine.write(|tx| {
                let id = create_node(tx, input)?;
                node_meta(tx, &id)
            })?;
            engine.notify("nodes");
            ok(meta)
        }
        "update" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                patch: NodePatch,
                /// Saves the scene to its history first, with this reason, as before a
                /// synopsis the AI wrote and the writer accepted.
                #[serde(default)]
                snapshot: Option<String>,
            }
            let p: P = parse(params)?;
            let structural = p.patch.content.is_none();
            let meta = engine.write(|tx| {
                if let Some(reason) = p.snapshot.as_deref().filter(|r| !r.is_empty()) {
                    revisions::checkpoint(tx, KIND_NODE, &p.id, reason)?;
                }
                update_node(tx, &p.id, p.patch)
            })?;
            engine.notify(if structural { "nodes" } else { "nodeContent" });
            ok(meta)
        }
        "move" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                id: String,
                parent_id: Option<String>,
                index: Option<usize>,
            }
            let p: P = parse(params)?;
            engine.write(|tx| move_node(tx, &p.id, p.parent_id.as_deref(), p.index))?;
            engine.notify("nodes");
            ok(true)
        }
        "delete" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| delete_node(tx, &p.id))?;
            engine.notify("nodes");
            ok(true)
        }
        "restore" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                /// Restores a merged-away scene even if its text can no longer be taken
                /// back out of the scene it went into.
                #[serde(default)]
                force: bool,
            }
            let p: P = parse(params)?;
            let changed = engine.write(|tx| {
                let node = node_meta(tx, &p.id)?;
                let changed = if node.deleted_at.is_some() && node.kind == "scene" {
                    unmerge(tx, &p.id, p.force)?
                } else {
                    None
                };
                restore_node(tx, &p.id)?;
                Ok(changed)
            })?;
            engine.notify("nodes");
            if let Some(into) = changed {
                super::pages::notify_replaced(engine, &[(KIND_NODE.to_string(), into)]);
            }
            ok(true)
        }
        "trash" => {
            let p: BookParam = parse(params)?;
            engine.read(|c| {
                let sql = format!(
                    "SELECT {NODE_COLS} FROM nodes WHERE book_id = ?1 AND deleted_at IS NOT NULL
                     ORDER BY deleted_at DESC"
                );
                let mut stmt = c.prepare(&sql)?;
                let rows = stmt.query_map([&p.book_id], node_from_row)?;
                let nodes: Vec<NodeMeta> = rows.collect::<Result<_, _>>()?;
                ok(nodes)
            })
        }
        "purge" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| purge_node(tx, &p.id))?;
            engine.notify("nodes");
            ok(true)
        }
        "emptyTrash" => {
            let p: BookParam = parse(params)?;
            engine.write(|tx| {
                // Only the top of each deleted branch; purging it takes the rest.
                let ids: Vec<String> = {
                    let mut stmt = tx.prepare(
                        "SELECT n.id FROM nodes n LEFT JOIN nodes parent ON parent.id = n.parent_id
                         WHERE n.book_id = ?1 AND n.deleted_at IS NOT NULL
                           AND (parent.id IS NULL OR parent.deleted_at IS NULL)",
                    )?;
                    let rows = stmt.query_map([&p.book_id], |r| r.get(0))?;
                    rows.collect::<Result<_, _>>()?
                };
                for id in &ids {
                    purge_node(tx, id)?;
                }
                Ok(())
            })?;
            engine.notify("nodes");
            ok(true)
        }
        "stats" => {
            let p: BookParam = parse(params)?;
            engine.read(|c| stats(c, &p.book_id))
        }
        "mentions" => {
            let p: IdParam = parse(params)?;
            engine.read(|c| mentions(c, &p.id))
        }
        "presence" => {
            let p: BookParam = parse(params)?;
            engine.read(|c| presence(c, &p.book_id))
        }
        "cast" => {
            let p: IdParam = parse(params)?;
            ok(engine.read(|c| cast_of(c, &p.id))?)
        }
        "setCast" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                id: String,
                page_ids: Vec<String>,
            }
            let p: P = parse(params)?;
            engine.write(|tx| set_cast(tx, &p.id, &p.page_ids))?;
            engine.notify("nodes");
            ok(true)
        }
        "split" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                before: Value,
                after: Value,
                title: Option<String>,
            }
            let p: P = parse(params)?;
            let meta = engine.write(|tx| split_scene(tx, &p.id, &p.before, &p.after, p.title.clone()))?;
            engine.notify("nodes");
            ok(meta)
        }
        "merge" => {
            let p: IdParam = parse(params)?;
            let meta = engine.write(|tx| merge_scene(tx, &p.id))?;
            engine.notify("nodes");
            ok(meta)
        }
        _ => Err(unknown(&format!("nodes.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{call, dispatch};
    use std::sync::Arc;

    fn project() -> (Arc<Engine>, crate::engine::TestDir, String) {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let books = call(&engine, "books.list", json!({}));
        let book = books[0]["id"].as_str().unwrap().to_string();
        (engine, dir, book)
    }

    fn doc(text: &str) -> Value {
        json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": text }] }
        ]})
    }

    fn titles_under(engine: &Engine, book: &str, parent: &Value) -> Vec<String> {
        call(engine, "nodes.tree", json!({ "bookId": book }))
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| &n["parentId"] == parent)
            .map(|n| n["title"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn a_new_project_starts_with_one_book_chapter_and_scene() {
        let (engine, _dir, book) = project();
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let kinds: Vec<&str> = tree.as_array().unwrap().iter().map(|n| n["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds.len(), 2);
        assert!(kinds.contains(&"chapter") && kinds.contains(&"scene"));
    }

    #[test]
    fn the_tree_refuses_invalid_placement() {
        let (engine, _dir, book) = project();
        let err = dispatch(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "kind": "scene", "title": "Loose" }),
        )
        .unwrap_err();
        assert_eq!(err.code, "BAD_PLACEMENT");

        let part = call(&engine, "nodes.create", json!({ "bookId": book, "kind": "part", "title": "P" }));
        let err = dispatch(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "parentId": part["id"], "kind": "part", "title": "Nested" }),
        )
        .unwrap_err();
        assert_eq!(err.code, "BAD_PLACEMENT");

        let ch = call(&engine, "nodes.create", json!({ "bookId": book, "parentId": part["id"], "kind": "chapter", "title": "C" }));
        let err = dispatch(&engine, "nodes.move", json!({ "id": part["id"], "parentId": ch["id"] })).unwrap_err();
        assert_eq!(err.code, "BAD_PLACEMENT");
    }

    #[test]
    fn nodes_insert_after_a_sibling_and_move_between_chapters() {
        let (engine, _dir, book) = project();
        let c1 = call(&engine, "nodes.create", json!({ "bookId": book, "kind": "chapter", "title": "C1" }));
        let c2 = call(&engine, "nodes.create", json!({ "bookId": book, "kind": "chapter", "title": "C2" }));
        let a = call(&engine, "nodes.create", json!({ "bookId": book, "parentId": c1["id"], "kind": "scene", "title": "A" }));
        call(&engine, "nodes.create", json!({ "bookId": book, "parentId": c1["id"], "kind": "scene", "title": "C" }));
        call(&engine, "nodes.create", json!({ "bookId": book, "parentId": c1["id"], "kind": "scene", "title": "B", "afterId": a["id"] }));
        assert_eq!(titles_under(&engine, &book, &c1["id"]), ["A", "B", "C"]);

        call(&engine, "nodes.move", json!({ "id": a["id"], "parentId": c2["id"], "index": 0 }));
        assert_eq!(titles_under(&engine, &book, &c1["id"]), ["B", "C"]);
        assert_eq!(titles_under(&engine, &book, &c2["id"]), ["A"]);

        // Reordering within the same parent, to the front.
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let c = tree.as_array().unwrap().iter().find(|n| n["title"] == "C").unwrap();
        call(&engine, "nodes.move", json!({ "id": c["id"], "parentId": c1["id"], "index": 0 }));
        assert_eq!(titles_under(&engine, &book, &c1["id"]), ["C", "B"]);
    }

    #[test]
    fn deleting_a_chapter_takes_its_scenes_and_restoring_brings_them_back() {
        let (engine, _dir, book) = project();
        let ch = call(&engine, "nodes.create", json!({ "bookId": book, "kind": "chapter", "title": "C" }));
        let s1 = call(&engine, "nodes.create", json!({ "bookId": book, "parentId": ch["id"], "kind": "scene", "title": "S1" }));
        let s2 = call(&engine, "nodes.create", json!({ "bookId": book, "parentId": ch["id"], "kind": "scene", "title": "S2" }));
        call(&engine, "nodes.update", json!({ "id": s1["id"], "patch": { "content": doc("xylophone") } }));

        // S2 is deleted on its own first, so restoring the chapter must not revive it.
        call(&engine, "nodes.delete", json!({ "id": s2["id"] }));
        std::thread::sleep(std::time::Duration::from_millis(5));
        call(&engine, "nodes.delete", json!({ "id": ch["id"] }));
        assert!(call(&engine, "search.query", json!({ "q": "xylophone" })).as_array().unwrap().is_empty());

        call(&engine, "nodes.restore", json!({ "id": ch["id"] }));
        assert_eq!(titles_under(&engine, &book, &ch["id"]), ["S1"]);
        assert_eq!(call(&engine, "search.query", json!({ "q": "xylophone" })).as_array().unwrap().len(), 1);
    }

    #[test]
    fn word_counts_and_daily_progress_follow_edits() {
        let (engine, _dir, book) = project();
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap().clone();
        call(&engine, "nodes.update", json!({ "id": scene["id"], "patch": { "content": doc("one two three four") } }));
        call(&engine, "nodes.update", json!({ "id": scene["id"], "patch": { "content": doc("one two") } }));
        let stats = call(&engine, "nodes.stats", json!({ "bookId": book }));
        assert_eq!(stats["words"], 2);
        assert_eq!(stats["writtenToday"], 4);
        assert_eq!(stats["days"][0]["removed"], 2);
    }

    #[test]
    fn only_scenes_hold_text() {
        let (engine, _dir, book) = project();
        let ch = call(&engine, "nodes.create", json!({ "bookId": book, "kind": "chapter", "title": "C" }));
        let err = dispatch(&engine, "nodes.update", json!({ "id": ch["id"], "patch": { "content": doc("x") } })).unwrap_err();
        assert_eq!(err.code, "INVALID");
    }

    #[test]
    fn a_failed_write_does_not_mark_a_clean_project_dirty() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let target = dir.0.join("x.lorecraft");
        engine.allow_path(&target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        assert!(!engine.status().dirty);
        assert!(dispatch(&engine, "nodes.update", json!({ "id": "missing", "patch": { "title": "x" } })).is_err());
        assert!(!engine.status().dirty);
    }

    fn scene_id(engine: &Engine, book: &str) -> Value {
        let tree = call(engine, "nodes.tree", json!({ "bookId": book }));
        tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap()["id"].clone()
    }

    fn words(count: usize) -> String {
        vec!["word"; count].join(" ")
    }

    #[test]
    fn placement_is_limited_to_live_nodes_of_the_same_book() {
        let (engine, _dir, book) = project();
        let other = call(&engine, "books.create", json!({ "title": "Other" }));
        let scene = scene_id(&engine, &book);
        let elsewhere = call(&engine, "nodes.tree", json!({ "bookId": other["id"] }));
        let foreign = elsewhere.as_array().unwrap().iter().find(|n| n["kind"] == "chapter").unwrap();

        let err = dispatch(&engine, "nodes.move", json!({ "id": scene, "parentId": foreign["id"] })).unwrap_err();
        assert_eq!(err.code, "BAD_PLACEMENT");
        let err = dispatch(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "parentId": foreign["id"], "kind": "scene", "title": "Stray" }),
        )
        .unwrap_err();
        assert_eq!(err.code, "BAD_PLACEMENT");

        let gone = call(&engine, "nodes.create", json!({ "bookId": book, "kind": "chapter", "title": "Gone" }));
        call(&engine, "nodes.delete", json!({ "id": gone["id"] }));
        let err = dispatch(&engine, "nodes.move", json!({ "id": scene, "parentId": gone["id"] })).unwrap_err();
        assert_eq!(err.code, "BAD_PLACEMENT");
    }

    #[test]
    fn a_new_node_refuses_an_unknown_status() {
        let (engine, _dir, book) = project();
        let err = dispatch(
            &engine,
            "nodes.create",
            json!({ "bookId": book, "kind": "chapter", "title": "C", "status": "nonsense" }),
        )
        .unwrap_err();
        assert_eq!(err.code, "INVALID");
    }

    #[test]
    fn a_restored_node_returns_to_its_place_among_its_siblings() {
        let (engine, _dir, book) = project();
        let ch = call(&engine, "nodes.create", json!({ "bookId": book, "kind": "chapter", "title": "C" }));
        let add = |title: &str| {
            call(&engine, "nodes.create", json!({ "bookId": book, "parentId": ch["id"], "kind": "scene", "title": title }))
        };
        let (a, b, c, d) = (add("A"), add("B"), add("C"), add("D"));
        // B ends up after C, so creation order no longer matches reading order.
        call(&engine, "nodes.move", json!({ "id": b["id"], "parentId": ch["id"], "index": 2 }));
        assert_eq!(titles_under(&engine, &book, &ch["id"]), ["A", "C", "B", "D"]);

        call(&engine, "nodes.delete", json!({ "id": c["id"] }));
        assert_eq!(titles_under(&engine, &book, &ch["id"]), ["A", "B", "D"]);
        call(&engine, "nodes.restore", json!({ "id": c["id"] }));
        assert_eq!(titles_under(&engine, &book, &ch["id"]), ["A", "C", "B", "D"]);

        // Restoring an earlier sibling leaves the rest in order.
        call(&engine, "nodes.delete", json!({ "id": a["id"] }));
        call(&engine, "nodes.delete", json!({ "id": d["id"] }));
        call(&engine, "nodes.restore", json!({ "id": a["id"] }));
        assert_eq!(titles_under(&engine, &book, &ch["id"]), ["A", "C", "B"]);
    }

    #[test]
    fn restoring_a_child_of_a_deleted_chapter_explains_itself() {
        let (engine, _dir, book) = project();
        let ch = call(&engine, "nodes.create", json!({ "bookId": book, "kind": "chapter", "title": "C" }));
        let s = call(&engine, "nodes.create", json!({ "bookId": book, "parentId": ch["id"], "kind": "scene", "title": "S" }));
        call(&engine, "nodes.delete", json!({ "id": s["id"] }));
        std::thread::sleep(std::time::Duration::from_millis(5));
        call(&engine, "nodes.delete", json!({ "id": ch["id"] }));
        let err = dispatch(&engine, "nodes.restore", json!({ "id": s["id"] })).unwrap_err();
        assert_eq!(err.code, "BAD_PLACEMENT");
        let trash = call(&engine, "nodes.trash", json!({ "bookId": book }));
        assert_eq!(trash.as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_scene_lists_the_pages_it_names_most_mentioned_first() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book);
        let aria = call(&engine, "pages.create", json!({ "title": "Aria Vale", "aliases": ["Aria"] }));
        let keep = call(&engine, "pages.create", json!({ "title": "Silver Keep" }));
        let unused = call(&engine, "pages.create", json!({ "title": "Nowhere" }));
        call(&engine, "nodes.update", json!({ "id": scene, "patch": { "content": doc("Aria rode to Silver Keep. Aria Vale slept.") } }));

        let list = call(&engine, "nodes.mentions", json!({ "id": scene }));
        let list = list.as_array().unwrap();
        assert_eq!(list.len(), 2, "{list:?}");
        assert_eq!(list[0]["pageId"], aria["id"]);
        assert_eq!(list[0]["title"], "Aria Vale");
        assert_eq!(list[0]["count"], 2);
        assert_eq!(list[1]["pageId"], keep["id"]);
        assert!(list.iter().all(|m| m["pageId"] != unused["id"]));

        // Deleting the page takes it off the list, and new text is picked up.
        call(&engine, "pages.delete", json!({ "id": keep["id"] }));
        assert_eq!(call(&engine, "nodes.mentions", json!({ "id": scene })).as_array().unwrap().len(), 1);
        call(&engine, "nodes.update", json!({ "id": scene, "patch": { "content": doc("Nowhere at all.") } }));
        let list = call(&engine, "nodes.mentions", json!({ "id": scene }));
        assert_eq!(list[0]["pageId"], unused["id"]);
        assert_eq!(list.as_array().unwrap().len(), 1);
    }

    #[test]
    fn moving_a_passage_between_scenes_is_not_new_writing() {
        let (engine, _dir, book) = project();
        let a = scene_id(&engine, &book);
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let chapter = tree.as_array().unwrap().iter().find(|n| n["kind"] == "chapter").unwrap()["id"].clone();
        let b = call(&engine, "nodes.create", json!({ "bookId": book, "parentId": chapter, "kind": "scene", "title": "B" }))["id"].clone();
        call(&engine, "nodes.update", json!({ "id": a, "patch": { "content": doc(&words(100)) } }));
        let before = call(&engine, "nodes.stats", json!({ "bookId": book }));
        assert_eq!(before["writtenToday"], 100);

        // Cut from A, paste into B.
        call(&engine, "nodes.update", json!({ "id": a, "patch": { "content": doc(&words(60)) } }));
        call(&engine, "nodes.update", json!({ "id": b, "patch": { "content": doc(&words(40)) } }));
        let after = call(&engine, "nodes.stats", json!({ "bookId": book }));
        assert_eq!(after["writtenToday"], 100, "the paste is not new writing");
        assert_eq!(after["days"][0]["removed"], 0, "and the cut is not a removal");
        assert_eq!(after["words"], 100);

        // Pasting first and then deleting the original is the same move.
        call(&engine, "nodes.update", json!({ "id": b, "patch": { "content": doc(&words(70)) } }));
        call(&engine, "nodes.update", json!({ "id": a, "patch": { "content": doc(&words(30)) } }));
        let after = call(&engine, "nodes.stats", json!({ "bookId": book }));
        assert_eq!(after["writtenToday"], 100);
        assert_eq!(after["days"][0]["removed"], 0);
    }

    #[test]
    fn a_paste_and_a_deletion_far_apart_are_not_a_move() {
        let (engine, _dir, book) = project();
        let a = scene_id(&engine, &book);
        call(&engine, "nodes.update", json!({ "id": a, "patch": { "content": doc(&words(300)) } }));

        // The paste was a long time ago, as far as the deletion can tell.
        engine
            .write(|tx| {
                let stored: String =
                    tx.query_row("SELECT value FROM meta WHERE key = ?1", [LAST_BULK_KEY], |r| r.get(0))?;
                let mut value: Value = serde_json::from_str(&stored)?;
                let long_ago = chrono::Utc::now() - chrono::Duration::minutes(MOVE_WINDOW_MINUTES + 1);
                value["at"] = json!(long_ago.to_rfc3339());
                tx.execute(
                    "UPDATE meta SET value = ?1 WHERE key = ?2",
                    params![value.to_string(), LAST_BULK_KEY],
                )?;
                Ok(())
            })
            .unwrap();

        call(&engine, "nodes.update", json!({ "id": a, "patch": { "content": doc(&words(1)) } }));
        let stats = call(&engine, "nodes.stats", json!({ "bookId": book }));
        assert_eq!(stats["writtenToday"], 300);
        assert_eq!(stats["days"][0]["removed"], 299);
    }

    #[test]
    fn real_writing_and_real_deletions_still_count() {
        let (engine, _dir, book) = project();
        let a = scene_id(&engine, &book);
        call(&engine, "nodes.update", json!({ "id": a, "patch": { "content": doc(&words(100)) } }));
        // A big deletion stays a deletion when nothing of that size comes back.
        call(&engine, "nodes.update", json!({ "id": a, "patch": { "content": doc(&words(50)) } }));
        call(&engine, "nodes.update", json!({ "id": a, "patch": { "content": doc(&words(55)) } }));
        let stats = call(&engine, "nodes.stats", json!({ "bookId": book }));
        assert_eq!(stats["writtenToday"], 105);
        assert_eq!(stats["days"][0]["removed"], 50);

        // A paste of a different size counts as writing.
        call(&engine, "nodes.update", json!({ "id": a, "patch": { "content": doc(&words(155)) } }));
        let stats = call(&engine, "nodes.stats", json!({ "bookId": book }));
        assert_eq!(stats["writtenToday"], 205);
    }

    #[test]
    fn local_only_survives_splitting_and_merging() {
        let (engine, _dir, book) = project();
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap().clone();
        call(&engine, "nodes.update", json!({ "id": scene["id"], "patch": { "localOnly": true } }));
        let half = call(
            &engine,
            "nodes.split",
            json!({ "id": scene["id"], "before": doc("One."), "after": doc("Two.") }),
        );
        assert_eq!(half["localOnly"], true, "the new half stays private");

        let chapter = scene["parentId"].clone();
        let open = call(&engine, "nodes.create", json!({ "bookId": book, "parentId": chapter, "kind": "scene", "title": "Open", "afterId": scene["id"] }));
        assert_eq!(open["localOnly"], false);
        let merged = call(&engine, "nodes.merge", json!({ "id": open["id"] }));
        assert_eq!(merged["localOnly"], true, "joined with a private scene, it is private");
    }

    #[test]
    fn splitting_an_untitled_scene_leaves_both_halves_untitled() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book);
        call(&engine, "nodes.update", json!({ "id": scene, "patch": { "title": "" } }));
        let made = call(&engine, "nodes.split", json!({ "id": scene, "before": doc("one"), "after": doc("two") }));
        assert_eq!(made["title"], "");
    }

    #[test]
    fn a_split_makes_two_scenes_in_one_step_and_leaves_a_way_back() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book);
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let chapter = tree.as_array().unwrap().iter().find(|n| n["kind"] == "chapter").unwrap()["id"].clone();
        let aria = call(&engine, "pages.create", json!({ "title": "Aria", "pageType": "character" }));
        let keep = call(&engine, "pages.create", json!({ "title": "The Keep", "pageType": "place" }));
        let thread = call(&engine, "threads.create", json!({ "name": "The ford" }));
        call(&engine, "nodes.update", json!({ "id": scene, "patch": {
            "title": "Arrival", "status": "revised", "povPageId": aria["id"], "locationPageId": keep["id"],
            "storyDate": "312", "content": doc("one two three four"),
        }}));
        call(&engine, "nodes.setCast", json!({ "id": scene, "pageIds": [aria["id"]] }));
        call(&engine, "threads.setLink", json!({ "nodeId": scene, "threadId": thread["id"], "on": true }));
        let later = call(&engine, "nodes.create", json!({ "bookId": book, "parentId": chapter, "kind": "scene", "title": "Later" }));
        let written = call(&engine, "nodes.stats", json!({ "bookId": book }))["writtenToday"].clone();

        let made = call(&engine, "nodes.split", json!({ "id": scene, "before": doc("one two"), "after": doc("three four") }));
        assert_eq!(made["title"], "Arrival (continued)");
        assert_eq!(made["wordCount"], 2);
        assert_eq!(made["status"], "revised");
        assert_eq!(made["povPageId"], aria["id"]);
        assert_eq!(made["locationPageId"], keep["id"]);
        assert_eq!(made["storyDate"], "312");
        assert_eq!(call(&engine, "nodes.cast", json!({ "id": made["id"] })), json!([aria["id"]]));
        let links = call(&engine, "threads.links", json!({ "bookId": book }));
        assert_eq!(links.as_array().unwrap().len(), 2);

        assert_eq!(titles_under(&engine, &book, &chapter), ["Arrival", "Arrival (continued)", "Later"]);
        let first = call(&engine, "nodes.get", json!({ "id": scene }));
        assert_eq!(first["content"], doc("one two"));
        assert_eq!(first["wordCount"], 2);
        assert_eq!(call(&engine, "nodes.get", json!({ "id": made["id"] }))["content"], doc("three four"));
        assert_eq!(later["id"], call(&engine, "nodes.tree", json!({ "bookId": book })).as_array().unwrap()
            .iter().find(|n| n["title"] == "Later").unwrap()["id"]);

        // The words only moved, so nothing new was written.
        assert_eq!(call(&engine, "nodes.stats", json!({ "bookId": book }))["writtenToday"], written);
        assert_eq!(call(&engine, "nodes.stats", json!({ "bookId": book }))["words"], 4);

        // The whole text is in the history, and each half is found by search.
        let history = call(&engine, "revisions.list", json!({ "kind": "node", "id": scene }));
        assert_eq!(history[0]["reason"], "split");
        let saved = call(&engine, "revisions.get", json!({ "id": history[0]["id"] }));
        assert_eq!(saved["content"], doc("one two three four"));
        assert_eq!(call(&engine, "search.query", json!({ "q": "four" }))[0]["id"], made["id"]);
    }

    #[test]
    fn a_split_refuses_what_is_not_a_scene_and_changes_nothing() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book);
        call(&engine, "nodes.update", json!({ "id": scene, "patch": { "content": doc("kept whole") } }));
        let err = dispatch(&engine, "nodes.split", json!({ "id": scene, "before": {}, "after": doc("x") })).unwrap_err();
        assert_eq!(err.code, "INVALID");
        assert_eq!(call(&engine, "nodes.get", json!({ "id": scene }))["content"], doc("kept whole"));
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let chapter = tree.as_array().unwrap().iter().find(|n| n["kind"] == "chapter").unwrap()["id"].clone();
        let err = dispatch(&engine, "nodes.split", json!({ "id": chapter, "before": doc("a"), "after": doc("b") })).unwrap_err();
        assert_eq!(err.code, "INVALID");
    }

    #[test]
    fn a_merge_moves_changes_to_infobox_fields_with_the_text() {
        let (engine, _dir, book) = project();
        let chapter = call(&engine, "nodes.create", json!({ "bookId": book, "kind": "chapter", "title": "C" }));
        let scene = |title: &str| {
            call(&engine, "nodes.create", json!({ "bookId": book, "parentId": chapter["id"], "kind": "scene", "title": title }))
        };
        let first = scene("A");
        let second = scene("B");
        let third = scene("C");
        let page = call(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "infobox": { "fields": [{
                "key": "hair", "label": "Hair", "kind": "text", "value": "blonde",
                "changes": [
                    { "nodeId": second["id"], "value": "black" },
                    { "nodeId": third["id"], "value": "grey" },
                ],
            }]}}),
        );
        call(&engine, "nodes.merge", json!({ "id": first["id"] }));
        let stored = call(&engine, "pages.get", json!({ "id": page["id"] }));
        let changes = &stored["infobox"]["fields"][0]["changes"];
        assert_eq!(changes[0]["nodeId"], first["id"], "it follows the text");
        assert_eq!(changes[0]["value"], "black");
        assert_eq!(changes[1]["nodeId"], third["id"], "another scene's is left alone");
    }

    #[test]
    fn a_merge_joins_the_next_scene_and_can_be_undone_from_history_and_trash() {
        let (engine, _dir, book) = project();
        let a = scene_id(&engine, &book);
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let c1 = tree.as_array().unwrap().iter().find(|n| n["kind"] == "chapter").unwrap()["id"].clone();
        let aria = call(&engine, "pages.create", json!({ "title": "Aria", "pageType": "character" }));
        let tomas = call(&engine, "pages.create", json!({ "title": "Tomas", "pageType": "character" }));
        let b = call(&engine, "nodes.create", json!({ "bookId": book, "parentId": c1, "kind": "scene", "title": "B" }))["id"].clone();
        let c2 = call(&engine, "nodes.create", json!({ "bookId": book, "kind": "chapter", "title": "C2" }))["id"].clone();
        let c = call(&engine, "nodes.create", json!({ "bookId": book, "parentId": c2, "kind": "scene", "title": "C" }))["id"].clone();
        call(&engine, "nodes.update", json!({ "id": a, "patch": {
            "synopsis": "First.", "notes": "Note A", "targetWords": 100,
            "content": { "type": "doc", "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "one two" }] },
                { "type": "paragraph" },
            ] },
        }}));
        call(&engine, "nodes.update", json!({ "id": b, "patch": {
            "synopsis": "Second.", "notes": "Note B", "targetWords": 50, "content": doc("three"),
        }}));
        call(&engine, "nodes.update", json!({ "id": c, "patch": { "content": doc("four") } }));
        call(&engine, "nodes.setCast", json!({ "id": a, "pageIds": [aria["id"]] }));
        call(&engine, "nodes.setCast", json!({ "id": b, "pageIds": [aria["id"], tomas["id"]] }));

        let merged = call(&engine, "nodes.merge", json!({ "id": a }));
        assert_eq!(merged["wordCount"], 3);
        assert_eq!(merged["synopsis"], "First.\n\nSecond.");
        assert_eq!(merged["targetWords"], 150);
        let stored = call(&engine, "nodes.get", json!({ "id": a }));
        assert_eq!(stored["notes"], "Note A\n\nNote B");
        assert_eq!(stored["content"], json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "one two" }] },
            { "type": "paragraph", "content": [{ "type": "text", "text": "three" }] },
        ]}), "the blank line at the join is gone");
        assert_eq!(call(&engine, "nodes.cast", json!({ "id": a })).as_array().unwrap().len(), 2);

        // The second scene is in the trash with its text, and its text is findable only once.
        let trash = call(&engine, "nodes.trash", json!({ "bookId": book }));
        assert_eq!(trash[0]["id"], b);
        assert_eq!(call(&engine, "search.query", json!({ "q": "three" })).as_array().unwrap().len(), 1);
        let first_history = call(&engine, "revisions.list", json!({ "kind": "node", "id": a }));
        assert_eq!(first_history[0]["reason"], "merge");
        let saved = call(&engine, "revisions.get", json!({ "id": first_history[0]["id"] }));
        assert_eq!(saved["wordCount"], 2);
        let second_history = call(&engine, "revisions.list", json!({ "kind": "node", "id": b }));
        assert_eq!(second_history[0]["reason"], "merge");

        // "Next" means next in reading order, which can be in the next chapter.
        let merged = call(&engine, "nodes.merge", json!({ "id": a }));
        assert_eq!(merged["wordCount"], 4);
        let err = dispatch(&engine, "nodes.merge", json!({ "id": a })).unwrap_err();
        assert_eq!(err.code, "NO_NEXT_SCENE");
    }

    fn paragraphs(texts: &[&str]) -> Value {
        let blocks: Vec<Value> = texts
            .iter()
            .map(|t| json!({ "type": "paragraph", "content": [{ "type": "text", "text": t }] }))
            .collect();
        json!({ "type": "doc", "content": blocks })
    }

    fn two_scenes(engine: &Engine, book: &str) -> (Value, Value) {
        let a = scene_id(engine, book);
        let tree = call(engine, "nodes.tree", json!({ "bookId": book }));
        let chapter = tree.as_array().unwrap().iter().find(|n| n["kind"] == "chapter").unwrap()["id"].clone();
        let b = call(engine, "nodes.create", json!({ "bookId": book, "parentId": chapter, "kind": "scene", "title": "B", "afterId": a }))["id"].clone();
        call(engine, "nodes.update", json!({ "id": a, "patch": {
            "synopsis": "First.", "notes": "Note A", "targetWords": 100, "content": paragraphs(&["alpha one"]),
        }}));
        call(engine, "nodes.update", json!({ "id": b, "patch": {
            "synopsis": "Second.", "notes": "Note B", "targetWords": 50, "content": paragraphs(&["bravo two", "bravo three"]),
        }}));
        (a, b)
    }

    #[test]
    fn restoring_a_merged_scene_takes_its_text_back_out_of_the_other() {
        let (engine, _dir, book) = project();
        let (a, b) = two_scenes(&engine, &book);
        call(&engine, "nodes.merge", json!({ "id": a }));
        assert_eq!(call(&engine, "nodes.get", json!({ "id": a }))["content"], paragraphs(&["alpha one", "bravo two", "bravo three"]));
        // Writing after the merge, outside the merged text, is kept.
        call(&engine, "nodes.update", json!({ "id": a, "patch": {
            "content": paragraphs(&["alpha one", "bravo two", "bravo three", "charlie later"]),
        }}));

        call(&engine, "nodes.restore", json!({ "id": b }));
        let kept = call(&engine, "nodes.get", json!({ "id": a }));
        assert_eq!(kept["content"], paragraphs(&["alpha one", "charlie later"]));
        assert_eq!(kept["synopsis"], "First.");
        assert_eq!(kept["notes"], "Note A");
        assert_eq!(kept["targetWords"], 100);
        let back = call(&engine, "nodes.get", json!({ "id": b }));
        assert_eq!(back["content"], paragraphs(&["bravo two", "bravo three"]));
        assert!(back["deletedAt"].is_null());
        // Its words are in one place only.
        assert_eq!(call(&engine, "search.query", json!({ "q": "bravo" })).as_array().unwrap().len(), 1);
        // And the merged text is in the other scene's history.
        let history = call(&engine, "revisions.list", json!({ "kind": "node", "id": a }));
        assert_eq!(history[0]["reason"], "unmerge");
        let saved = call(&engine, "revisions.get", json!({ "id": history[0]["id"] }));
        assert_eq!(saved["content"], paragraphs(&["alpha one", "bravo two", "bravo three", "charlie later"]));
    }

    #[test]
    fn restoring_a_merged_scene_whose_text_was_edited_asks_first() {
        let (engine, _dir, book) = project();
        let (a, b) = two_scenes(&engine, &book);
        call(&engine, "nodes.merge", json!({ "id": a }));
        let edited = paragraphs(&["alpha one", "bravo two, edited", "bravo three"]);
        call(&engine, "nodes.update", json!({ "id": a, "patch": { "content": edited } }));

        let err = dispatch(&engine, "nodes.restore", json!({ "id": b })).unwrap_err();
        assert_eq!(err.code, "MERGED_TEXT_CHANGED");
        assert!(!call(&engine, "nodes.get", json!({ "id": b }))["deletedAt"].is_null(), "nothing happened");

        call(&engine, "nodes.restore", json!({ "id": b, "force": true }));
        assert!(call(&engine, "nodes.get", json!({ "id": b }))["deletedAt"].is_null());
        assert_eq!(call(&engine, "nodes.get", json!({ "id": a }))["content"], edited, "the other scene is left alone");
    }

    #[test]
    fn merging_a_split_back_gives_the_text_back_exactly() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book);
        let whole = paragraphs(&["one two three", "four"]);
        call(&engine, "nodes.update", json!({ "id": scene, "patch": { "content": whole } }));
        // Cut inside the first paragraph.
        let made = call(&engine, "nodes.split", json!({
            "id": scene, "before": paragraphs(&["one tw"]), "after": paragraphs(&["o three", "four"]),
        }));
        // Both halves have history: the whole text before, and where the new one came from.
        let history = call(&engine, "revisions.list", json!({ "kind": "node", "id": scene }));
        assert_eq!(history[0]["reason"], "split");
        let started = call(&engine, "revisions.list", json!({ "kind": "node", "id": made["id"] }));
        assert_eq!(started[0]["reason"], "split-off");

        call(&engine, "nodes.merge", json!({ "id": scene }));
        assert_eq!(call(&engine, "nodes.get", json!({ "id": scene }))["content"], whole);
        assert_eq!(call(&engine, "nodes.stats", json!({ "bookId": book }))["words"], 4);
    }

    #[test]
    fn merging_halves_changed_since_the_split_keeps_every_word() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book);
        call(&engine, "nodes.update", json!({ "id": scene, "patch": { "content": paragraphs(&["one two"]) } }));
        let made = call(&engine, "nodes.split", json!({
            "id": scene, "before": paragraphs(&["one"]), "after": paragraphs(&["two"]),
        }));
        call(&engine, "nodes.update", json!({ "id": made["id"], "patch": { "content": paragraphs(&["two more"]) } }));
        call(&engine, "nodes.merge", json!({ "id": scene }));
        assert_eq!(call(&engine, "nodes.get", json!({ "id": scene }))["content"], paragraphs(&["one", "two more"]));
    }

    #[test]
    fn an_ai_synopsis_is_saved_to_history_first_and_can_be_restored() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book);
        call(&engine, "nodes.update", json!({ "id": scene, "patch": { "synopsis": "Mine.", "content": doc("text") } }));
        call(&engine, "nodes.update", json!({ "id": scene, "snapshot": "ai", "patch": { "synopsis": "The model's." } }));
        let history = call(&engine, "revisions.list", json!({ "kind": "node", "id": scene }));
        assert_eq!(history[0]["reason"], "ai");
        call(&engine, "revisions.restore", json!({ "id": history[0]["id"] }));
        assert_eq!(call(&engine, "nodes.get", json!({ "id": scene }))["synopsis"], "Mine.");
    }

    #[test]
    fn location_and_cast_are_stored_and_reach_the_snapshot() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book);
        let keep = call(&engine, "pages.create", json!({ "title": "The Keep", "pageType": "place" }));
        let zed = call(&engine, "pages.create", json!({ "title": "Zed", "pageType": "character" }));
        let aria = call(&engine, "pages.create", json!({ "title": "Aria", "pageType": "character" }));

        let meta = call(&engine, "nodes.update", json!({ "id": scene, "patch": { "locationPageId": keep["id"] } }));
        assert_eq!(meta["locationPageId"], keep["id"]);
        call(&engine, "nodes.setCast", json!({ "id": scene, "pageIds": [zed["id"], aria["id"], aria["id"], "no-such-page"] }));
        assert_eq!(call(&engine, "nodes.cast", json!({ "id": scene })), json!([aria["id"], zed["id"]]));

        let snap = call(&engine, "snapshot.get", json!({}));
        let node = snap["nodes"].as_array().unwrap().iter().find(|n| n["id"] == scene).unwrap();
        assert_eq!(node["locationPageId"], keep["id"]);
        assert_eq!(node["castPageIds"], json!([aria["id"], zed["id"]]));
        let chapter = snap["nodes"].as_array().unwrap().iter().find(|n| n["kind"] == "chapter").unwrap();
        assert_eq!(chapter["locationPageId"], Value::Null);
        assert_eq!(chapter["castPageIds"], json!([]));

        // A deleted page drops off the cast, and an empty string clears the location.
        call(&engine, "pages.delete", json!({ "id": zed["id"] }));
        assert_eq!(call(&engine, "nodes.cast", json!({ "id": scene })), json!([aria["id"]]));
        let meta = call(&engine, "nodes.update", json!({ "id": scene, "patch": { "locationPageId": "" } }));
        assert_eq!(meta["locationPageId"], Value::Null);
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let chapter_id = tree.as_array().unwrap().iter().find(|n| n["kind"] == "chapter").unwrap()["id"].clone();
        assert_eq!(dispatch(&engine, "nodes.setCast", json!({ "id": chapter_id, "pageIds": [] })).unwrap_err().code, "INVALID");
    }

    #[test]
    fn threads_can_be_managed_and_linked_to_scenes() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book);
        let one = call(&engine, "threads.create", json!({ "name": " The heir ", "color": "success" }));
        let two = call(&engine, "threads.create", json!({ "name": "The war", "description": "It spreads" }));
        assert_eq!(one["name"], "The heir");
        assert_eq!(two["color"], "accent");
        assert_eq!(two["position"], 1);
        assert_eq!(dispatch(&engine, "threads.create", json!({ "name": "  " })).unwrap_err().code, "INVALID");

        call(&engine, "threads.update", json!({ "id": one["id"], "patch": { "name": "The true heir", "color": "warning" } }));
        call(&engine, "threads.reorder", json!({ "ids": [two["id"], one["id"]] }));
        let list = call(&engine, "threads.list", json!({}));
        assert_eq!(list[0]["id"], two["id"]);
        assert_eq!(list[1]["name"], "The true heir");
        assert_eq!(list[1]["color"], "warning");

        call(&engine, "threads.setLink", json!({ "nodeId": scene, "threadId": one["id"], "on": true }));
        call(&engine, "threads.setLink", json!({ "nodeId": scene, "threadId": one["id"], "on": true }));
        call(&engine, "threads.setLink", json!({ "nodeId": scene, "threadId": two["id"], "on": true }));
        assert_eq!(call(&engine, "threads.links", json!({ "bookId": book })).as_array().unwrap().len(), 2);
        call(&engine, "threads.setLink", json!({ "nodeId": scene, "threadId": two["id"], "on": false }));
        assert_eq!(call(&engine, "threads.links", json!({ "bookId": book })).as_array().unwrap().len(), 1);

        // Deleting a thread takes its links, and a deleted scene's links stop showing.
        call(&engine, "threads.setLink", json!({ "nodeId": scene, "threadId": two["id"], "on": true }));
        call(&engine, "threads.delete", json!({ "id": one["id"] }));
        let links = call(&engine, "threads.links", json!({ "bookId": book }));
        assert_eq!(links.as_array().unwrap().len(), 1);
        assert_eq!(links[0]["threadId"], two["id"]);
        call(&engine, "nodes.delete", json!({ "id": scene }));
        assert!(call(&engine, "threads.links", json!({ "bookId": book })).as_array().unwrap().is_empty());
    }

    #[test]
    fn presence_lists_who_each_scene_names_and_casts() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book);
        let aria = call(&engine, "pages.create", json!({ "title": "Aria Vale", "pageType": "character" }));
        let tomas = call(&engine, "pages.create", json!({ "title": "Tomas Reed", "pageType": "character" }));
        call(&engine, "nodes.update", json!({ "id": scene, "patch": { "content": doc("Aria Vale met Aria Vale.") } }));
        call(&engine, "nodes.setCast", json!({ "id": scene, "pageIds": [tomas["id"]] }));
        let found = call(&engine, "nodes.presence", json!({ "bookId": book }));
        assert_eq!(found["mentions"], json!([{ "nodeId": scene, "pageId": aria["id"], "count": 2 }]));
        assert_eq!(found["cast"], json!([{ "nodeId": scene, "pageId": tomas["id"] }]));
    }

    #[test]
    fn a_deleted_book_stays_out_of_mentions_when_names_change() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book);
        let page = call(&engine, "pages.create", json!({ "title": "Aria Vale" }));
        call(&engine, "nodes.update", json!({ "id": scene, "patch": { "content": doc("Aria Vale rode out.") } }));
        let scenes_naming_her = |engine: &Engine| {
            call(engine, "pages.backlinks", json!({ "id": page["id"] }))["scenes"].as_array().unwrap().len()
        };
        assert_eq!(scenes_naming_her(&engine), 1);

        call(&engine, "books.delete", json!({ "id": book }));
        assert_eq!(scenes_naming_her(&engine), 0);
        // Any new page makes every mention get worked out again.
        call(&engine, "pages.create", json!({ "title": "Another Page" }));
        assert_eq!(scenes_naming_her(&engine), 0);

        call(&engine, "books.restore", json!({ "id": book }));
        assert_eq!(scenes_naming_her(&engine), 1);
    }

    #[test]
    fn deleted_books_leave_search_and_return_on_restore() {
        let (engine, _dir, book) = project();
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap().clone();
        call(&engine, "nodes.update", json!({ "id": scene["id"], "patch": { "content": doc("quokka") } }));
        call(&engine, "books.delete", json!({ "id": book }));
        assert!(call(&engine, "search.query", json!({ "q": "quokka" })).as_array().unwrap().is_empty());
        call(&engine, "books.restore", json!({ "id": book }));
        assert_eq!(call(&engine, "search.query", json!({ "q": "quokka" })).as_array().unwrap().len(), 1);
    }

    fn is_live(engine: &Engine, id: &str) -> bool {
        engine.read(|c| Ok(node_meta(c, id).is_ok_and(|n| n.deleted_at.is_none()))).unwrap()
    }

    #[test]
    fn purging_a_trashed_scene_removes_it_its_history_and_merge_records() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book).as_str().unwrap().to_string();
        call(&engine, "nodes.update", json!({ "id": scene, "patch": { "content": doc("quokka") }, "snapshot": "manual" }));
        engine.write(|tx| set_meta_json(tx, &format!("{MERGED_KEY}{scene}"), &json!({ "into": "x" }))).unwrap();
        engine.write(|tx| set_meta_json(tx, "splitFrom:other", &json!({ "from": scene }))).unwrap();
        assert!(is_live(&engine, &scene));
        call(&engine, "nodes.delete", json!({ "id": scene }));
        call(&engine, "nodes.purge", json!({ "id": scene }));
        let left: i64 = engine
            .read(|c| {
                Ok(c.query_row(
                    "SELECT (SELECT COUNT(*) FROM nodes WHERE id = ?1)
                          + (SELECT COUNT(*) FROM revisions WHERE entity_id = ?1)
                          + (SELECT COUNT(*) FROM meta WHERE key LIKE 'mergedInto:%' OR key LIKE 'splitFrom:%')",
                    [&scene],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(left, 0);
        assert!(call(&engine, "nodes.trash", json!({ "bookId": book })).as_array().unwrap().is_empty());
    }

    #[test]
    fn emptying_the_trash_keeps_live_scenes_and_a_live_scene_cannot_be_purged() {
        let (engine, _dir, book) = project();
        let scene = scene_id(&engine, &book).as_str().unwrap().to_string();
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let chapter = tree.as_array().unwrap().iter().find(|n| n["kind"] == "chapter").unwrap()["id"].clone();
        let gone = call(&engine, "nodes.create", json!({ "bookId": book, "parentId": chapter, "kind": "scene", "title": "Gone" }));
        assert!(handle_nodes(&engine, "purge", json!({ "id": gone["id"] })).is_err());
        call(&engine, "nodes.delete", json!({ "id": gone["id"] }));
        call(&engine, "nodes.delete", json!({ "id": chapter }));
        call(&engine, "nodes.emptyTrash", json!({ "bookId": book }));
        assert!(call(&engine, "nodes.trash", json!({ "bookId": book })).as_array().unwrap().is_empty());
        assert!(engine.read(|c| Ok(node_meta(c, &scene).is_err())).unwrap());
        let other = call(&engine, "books.create", json!({ "title": "Other" }));
        let kept = scene_id(&engine, other["id"].as_str().unwrap()).as_str().unwrap().to_string();
        assert!(is_live(&engine, &kept));
    }
}
