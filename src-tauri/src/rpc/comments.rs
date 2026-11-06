//! Comments and to-dos attached to text. Their words live in this table. The anchor is a
//! `comment` mark in the stored document, so it moves with the text as the text is edited.
//! Whether a comment still has its text is worked out from the document each time it is
//! read, so it cannot drift, and a comment whose text has gone stays listed.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ok, parse, unknown};
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};

const MAX_BODY_CHARS: usize = 20_000;
const MAX_AUTHOR_CHARS: usize = 80;
const MAX_QUOTE_CHARS: usize = 2_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    id: String,
    source_kind: String,
    source_id: String,
    body: String,
    author: String,
    is_todo: bool,
    done: bool,
    resolved: bool,
    /// The words it is attached to now or, once they have gone, the words it was last known by.
    quote: String,
    /// Its mark is still in the stored document.
    anchored: bool,
    created_at: String,
    updated_at: String,
    /// Where it is, for lists: the page title, or the scene's title and place in the book.
    source_title: String,
    book_id: Option<String>,
    book_title: String,
    chapter_title: String,
}

const SELECT: &str = "SELECT c.id, c.source_kind, c.source_id, c.body, c.author, c.is_todo, c.done,
         c.resolved, c.quote, c.created_at, c.updated_at,
         COALESCE(p.title, n.title, ''), n.book_id, COALESCE(b.title, ''), COALESCE(ch.title, '')
       FROM comments c
       LEFT JOIN pages p ON c.source_kind = 'page' AND p.id = c.source_id AND p.deleted_at IS NULL
       LEFT JOIN nodes n ON c.source_kind = 'node' AND n.id = c.source_id AND n.deleted_at IS NULL
       LEFT JOIN books b ON b.id = n.book_id AND b.deleted_at IS NULL
       LEFT JOIN nodes ch ON ch.id = n.parent_id";

/// A comment whose document is in the trash is out of sight until that document comes back.
const IN_SIGHT: &str = "(p.id IS NOT NULL OR b.id IS NOT NULL)";

fn read_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Comment> {
    Ok(Comment {
        id: r.get(0)?,
        source_kind: r.get(1)?,
        source_id: r.get(2)?,
        body: r.get(3)?,
        author: r.get(4)?,
        is_todo: r.get::<_, i64>(5)? != 0,
        done: r.get::<_, i64>(6)? != 0,
        resolved: r.get::<_, i64>(7)? != 0,
        quote: r.get(8)?,
        anchored: false,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
        source_title: r.get(11)?,
        book_id: r.get(12)?,
        book_title: r.get(13)?,
        chapter_title: r.get(14)?,
    })
}

/// Comment id -> the words its mark covers, in document order.
fn anchored_text(doc: &Value) -> HashMap<String, String> {
    fn walk(node: &Value, out: &mut HashMap<String, String>) {
        if let Some(marks) = node.get("marks").and_then(Value::as_array) {
            for mark in marks {
                if mark.get("type").and_then(Value::as_str) != Some("comment") {
                    continue;
                }
                if let Some(id) = mark.pointer("/attrs/id").and_then(Value::as_str) {
                    let text = node.get("text").and_then(Value::as_str).unwrap_or("");
                    out.entry(id.to_string()).or_default().push_str(text);
                }
            }
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            for child in children {
                walk(child, out);
            }
        }
    }
    let mut out = HashMap::new();
    walk(doc, &mut out);
    out
}

fn stored_anchors(conn: &Connection, kind: &str, id: &str) -> AppResult<HashMap<String, String>> {
    let sql = if kind == "page" {
        "SELECT content FROM pages WHERE id = ?1"
    } else {
        "SELECT content FROM nodes WHERE id = ?1"
    };
    let content: Option<String> = conn.query_row(sql, [id], |r| r.get(0)).optional()?;
    Ok(content
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|doc| anchored_text(&doc))
        .unwrap_or_default())
}

/// Reads each document once, however many comments it has.
fn fill_anchors(conn: &Connection, comments: &mut [Comment]) -> AppResult<()> {
    let mut docs: HashMap<(String, String), HashMap<String, String>> = HashMap::new();
    for comment in comments.iter_mut() {
        let key = (comment.source_kind.clone(), comment.source_id.clone());
        if !docs.contains_key(&key) {
            let anchors = stored_anchors(conn, &key.0, &key.1)?;
            docs.insert(key.clone(), anchors);
        }
        if let Some(text) = docs.get(&key).and_then(|anchors| anchors.get(&comment.id)) {
            comment.anchored = true;
            if !text.trim().is_empty() {
                comment.quote = text.clone();
            }
        }
    }
    Ok(())
}

fn get_comment(conn: &Connection, id: &str) -> AppResult<Comment> {
    let sql = format!("{SELECT} WHERE c.id = ?1");
    let comment = conn
        .query_row(&sql, [id], read_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("That comment"))?;
    let mut one = [comment];
    fill_anchors(conn, &mut one)?;
    let [comment] = one;
    Ok(comment)
}

fn list(conn: &Connection, kind: Option<&str>, id: Option<&str>) -> AppResult<Vec<Comment>> {
    let mut comments = if let (Some(kind), Some(id)) = (kind, id) {
        let sql = format!(
            "{SELECT} WHERE c.source_kind = ?1 AND c.source_id = ?2 ORDER BY c.created_at, c.id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![kind, id], read_row)?;
        rows.collect::<Result<Vec<_>, _>>()?
    } else {
        let sql = format!("{SELECT} WHERE {IN_SIGHT} ORDER BY c.created_at DESC, c.id");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], read_row)?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    fill_anchors(conn, &mut comments)?;
    Ok(comments)
}

fn check_kind(kind: &str) -> AppResult<()> {
    if kind == "page" || kind == "node" {
        Ok(())
    } else {
        Err(AppError::invalid(format!("Unknown kind of document: {kind}")))
    }
}

fn check_source(conn: &Connection, kind: &str, id: &str) -> AppResult<()> {
    check_kind(kind)?;
    let sql = if kind == "page" {
        "SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL"
    } else {
        "SELECT 1 FROM nodes WHERE id = ?1 AND deleted_at IS NULL"
    };
    let found: Option<i64> = conn.query_row(sql, [id], |r| r.get(0)).optional()?;
    if found.is_none() {
        return Err(AppError::not_found(if kind == "page" {
            "That page"
        } else {
            "That scene"
        }));
    }
    Ok(())
}

fn clean_body(body: &str) -> AppResult<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::invalid("A comment needs some words."));
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(AppError::invalid("That comment is too long."));
    }
    Ok(body.to_string())
}

fn clean_quote(quote: &str) -> String {
    quote.trim().chars().take(MAX_QUOTE_CHARS).collect()
}

fn clean_author(author: &str) -> String {
    let author: String = author.trim().chars().take(MAX_AUTHOR_CHARS).collect();
    if author.is_empty() {
        "you".to_string()
    } else {
        author
    }
}

/// Keeps comments with their text when it has moved to another document. Called whenever a
/// document is written, inside that write.
pub fn follow_text(
    conn: &Connection,
    kind: &str,
    id: &str,
    comments: &BTreeSet<String>,
) -> AppResult<()> {
    if comments.is_empty() {
        return Ok(());
    }
    let mut update = conn.prepare_cached(
        "UPDATE comments SET source_kind = ?1, source_id = ?2
          WHERE id = ?3 AND (source_kind <> ?1 OR source_id <> ?2)",
    )?;
    for comment in comments {
        update.execute(params![kind, id, comment])?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddInput {
    source_kind: String,
    source_id: String,
    body: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    is_todo: bool,
    #[serde(default)]
    quote: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Patch {
    body: Option<String>,
    is_todo: Option<bool>,
    done: Option<bool>,
    resolved: Option<bool>,
    quote: Option<String>,
}

fn add(conn: &Connection, input: AddInput) -> AppResult<String> {
    check_source(conn, &input.source_kind, &input.source_id)?;
    let id = db::new_id();
    let now = db::now();
    conn.execute(
        "INSERT INTO comments (id, source_kind, source_id, body, author, quote, is_todo,
                               created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            id,
            input.source_kind,
            input.source_id,
            clean_body(&input.body)?,
            clean_author(&input.author),
            clean_quote(&input.quote),
            input.is_todo as i64,
            now,
        ],
    )?;
    Ok(id)
}

fn update(conn: &Connection, id: &str, patch: Patch) -> AppResult<()> {
    let found: Option<i64> = conn
        .query_row("SELECT 1 FROM comments WHERE id = ?1", [id], |r| r.get(0))
        .optional()?;
    if found.is_none() {
        return Err(AppError::not_found("That comment"));
    }
    let now = db::now();
    if let Some(body) = &patch.body {
        conn.execute(
            "UPDATE comments SET body = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, clean_body(body)?, now],
        )?;
    }
    if let Some(is_todo) = patch.is_todo {
        // A comment that stops being a to-do has nothing left to be done.
        conn.execute(
            "UPDATE comments SET is_todo = ?2, done = CASE WHEN ?2 THEN done ELSE 0 END,
                    updated_at = ?3 WHERE id = ?1",
            params![id, is_todo as i64, now],
        )?;
    }
    if let Some(done) = patch.done {
        // Ticking something makes it a to-do, if it was not already.
        conn.execute(
            "UPDATE comments SET done = ?2, is_todo = CASE WHEN ?2 THEN 1 ELSE is_todo END,
                    updated_at = ?3 WHERE id = ?1",
            params![id, done as i64, now],
        )?;
    }
    if let Some(resolved) = patch.resolved {
        conn.execute(
            "UPDATE comments SET resolved = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, resolved as i64, now],
        )?;
    }
    if let Some(quote) = &patch.quote {
        conn.execute(
            "UPDATE comments SET quote = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, clean_quote(quote), now],
        )?;
    }
    Ok(())
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        // Every comment in the project, or those of one document.
        "list" => {
            #[derive(Default, Deserialize)]
            #[serde(rename_all = "camelCase", default)]
            struct P {
                source_kind: Option<String>,
                source_id: Option<String>,
            }
            let p: P = parse(params)?;
            if let Some(kind) = &p.source_kind {
                check_kind(kind)?;
            }
            ok(engine.read(|c| list(c, p.source_kind.as_deref(), p.source_id.as_deref()))?)
        }
        "get" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
            }
            let p: P = parse(params)?;
            ok(engine.read(|c| get_comment(c, &p.id))?)
        }
        "add" => {
            let input: AddInput = parse(params)?;
            let comment = engine.write(|tx| {
                let id = add(tx, input)?;
                get_comment(tx, &id)
            })?;
            engine.notify("comments");
            ok(comment)
        }
        "update" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                patch: Patch,
            }
            let p: P = parse(params)?;
            let comment = engine.write(|tx| {
                update(tx, &p.id, p.patch)?;
                get_comment(tx, &p.id)
            })?;
            engine.notify("comments");
            ok(comment)
        }
        "delete" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
            }
            let p: P = parse(params)?;
            engine.write(|tx| {
                tx.execute("DELETE FROM comments WHERE id = ?1", [&p.id])?;
                Ok(())
            })?;
            engine.notify("comments");
            ok(true)
        }
        _ => Err(unknown(&format!("comments.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::{call, dispatch};
    use crate::engine::Engine;

    fn doc_with(marked: &str, id: &str) -> serde_json::Value {
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [
            { "type": "text", "text": "Before " },
            { "type": "text", "text": marked, "marks": [{ "type": "comment", "attrs": { "id": id } }] },
            { "type": "text", "text": " after." }
        ] }] })
    }

    fn plain_doc(text: &str) -> serde_json::Value {
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [
            { "type": "text", "text": text }
        ] }] })
    }

    fn engine_with_page() -> (std::sync::Arc<Engine>, crate::engine::TestDir, String) {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "World" }));
        let page = call(&engine, "pages.create", json!({ "title": "Mara" }));
        let id = page["id"].as_str().unwrap().to_string();
        (engine, dir, id)
    }

    fn add(engine: &Engine, kind: &str, id: &str, extra: serde_json::Value) -> serde_json::Value {
        let mut params = json!({ "sourceKind": kind, "sourceId": id, "body": "Check this" });
        for (key, value) in extra.as_object().unwrap() {
            params[key] = value.clone();
        }
        call(engine, "comments.add", params)
    }

    #[test]
    fn adds_lists_and_defaults_the_author() {
        let (engine, _dir, page) = engine_with_page();
        let comment = add(&engine, "page", &page, json!({ "quote": "  the gate " }));
        assert_eq!(comment["author"], "you");
        assert_eq!(comment["isTodo"], false);
        assert_eq!(comment["done"], false);
        assert_eq!(comment["resolved"], false);
        assert_eq!(comment["anchored"], false);
        assert_eq!(comment["quote"], "the gate");
        assert_eq!(comment["sourceTitle"], "Mara");

        let by_ai = add(&engine, "page", &page, json!({ "author": "ai", "isTodo": true }));
        assert_eq!(by_ai["author"], "ai");
        assert_eq!(by_ai["isTodo"], true);

        let all = call(&engine, "comments.list", json!(null));
        assert_eq!(all.as_array().unwrap().len(), 2);
        let here = call(&engine, "comments.list", json!({ "sourceKind": "page", "sourceId": page }));
        assert_eq!(here.as_array().unwrap().len(), 2);
        let elsewhere = call(&engine, "comments.list", json!({ "sourceKind": "page", "sourceId": "nope" }));
        assert!(elsewhere.as_array().unwrap().is_empty());
    }

    #[test]
    fn refuses_what_it_cannot_store() {
        let (engine, _dir, page) = engine_with_page();
        let empty = dispatch(
            &engine,
            "comments.add",
            json!({ "sourceKind": "page", "sourceId": page, "body": "   " }),
        );
        assert!(empty.is_err());
        let missing = dispatch(
            &engine,
            "comments.add",
            json!({ "sourceKind": "page", "sourceId": "nope", "body": "x" }),
        );
        assert_eq!(missing.unwrap_err().code, "NOT_FOUND");
        let odd = dispatch(
            &engine,
            "comments.add",
            json!({ "sourceKind": "book", "sourceId": page, "body": "x" }),
        );
        assert!(odd.is_err());
        let gone = dispatch(&engine, "comments.update", json!({ "id": "nope", "patch": { "done": true } }));
        assert_eq!(gone.unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn follows_the_mark_and_keeps_a_comment_whose_text_goes() {
        let (engine, _dir, page) = engine_with_page();
        let comment = add(&engine, "page", &page, json!({ "quote": "old gate" }));
        let id = comment["id"].as_str().unwrap();

        call(&engine, "pages.update", json!({ "id": page, "patch": { "content": doc_with("new gate", id) } }));
        let found = call(&engine, "comments.get", json!({ "id": id }));
        assert_eq!(found["anchored"], true);
        assert_eq!(found["quote"], "new gate", "shows the words as they are now");

        call(&engine, "pages.update", json!({ "id": page, "patch": { "content": plain_doc("Nothing here.") } }));
        let found = call(&engine, "comments.get", json!({ "id": id }));
        assert_eq!(found["anchored"], false, "the text has gone");
        assert_eq!(found["quote"], "old gate", "the words it was first attached to");
        let all = call(&engine, "comments.list", json!(null));
        assert_eq!(all.as_array().unwrap().len(), 1, "it stays listed");

        let text = call(&engine, "pages.get", json!({ "id": page }));
        assert_eq!(text["wordCount"], 2);
    }

    #[test]
    fn changes_each_field_and_deletes() {
        let (engine, _dir, page) = engine_with_page();
        let comment = add(&engine, "page", &page, json!({}));
        let id = comment["id"].as_str().unwrap();
        let update = |patch: serde_json::Value| call(&engine, "comments.update", json!({ "id": id, "patch": patch }));

        assert_eq!(update(json!({ "body": "Edited" }))["body"], "Edited");
        let ticked = update(json!({ "done": true }));
        assert_eq!(ticked["done"], true);
        assert_eq!(ticked["isTodo"], true, "ticking makes it a to-do");
        let plain = update(json!({ "isTodo": false }));
        assert_eq!(plain["isTodo"], false);
        assert_eq!(plain["done"], false, "only a to-do can be done");
        assert_eq!(update(json!({ "resolved": true }))["resolved"], true);
        assert_eq!(update(json!({ "resolved": false }))["resolved"], false);

        call(&engine, "comments.delete", json!({ "id": id }));
        assert!(call(&engine, "comments.list", json!(null)).as_array().unwrap().is_empty());
    }

    #[test]
    fn writing_comments_marks_the_project_changed_and_announces_it() {
        let (engine, host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "World" }));
        let page = call(&engine, "pages.create", json!({ "title": "Mara" }));
        host.events.lock().unwrap().clear();
        let id = page["id"].as_str().unwrap();
        add(&engine, "page", id, json!({}));
        let events = host.events.lock().unwrap();
        assert!(events.iter().any(|(name, payload)| name == "data://changed" && payload["entity"] == "comments"));
        assert!(engine.status().dirty);
    }

    #[test]
    fn trash_hides_them_a_restore_brings_them_back_and_a_purge_removes_them() {
        let (engine, _dir, page) = engine_with_page();
        add(&engine, "page", &page, json!({}));
        call(&engine, "pages.delete", json!({ "id": page }));
        assert!(call(&engine, "comments.list", json!(null)).as_array().unwrap().is_empty());
        call(&engine, "pages.restore", json!({ "id": page }));
        assert_eq!(call(&engine, "comments.list", json!(null)).as_array().unwrap().len(), 1);
        call(&engine, "pages.delete", json!({ "id": page }));
        call(&engine, "pages.purge", json!({ "id": page }));
        call(&engine, "pages.create", json!({ "title": "Mara again" }));
        assert!(call(&engine, "comments.list", json!(null)).as_array().unwrap().is_empty());
        let left: i64 = engine
            .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM comments", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(left, 0, "purging removes the row, not just the listing");
    }

    #[test]
    fn scenes_report_their_place_and_comments_follow_text_that_moves() {
        let (engine, _dir, _page) = engine_with_page();
        let book = call(&engine, "books.create", json!({ "title": "Book One" }));
        let book_id = book["id"].as_str().unwrap();
        let chapter = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book_id, "kind": "chapter", "title": "Chapter One" }),
        );
        let first = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book_id, "parentId": chapter["id"], "kind": "scene", "title": "Arrival" }),
        );
        let second = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book_id, "parentId": chapter["id"], "kind": "scene", "title": "Departure" }),
        );
        let first_id = first["id"].as_str().unwrap();
        let comment = add(&engine, "node", first_id, json!({ "isTodo": true }));
        let id = comment["id"].as_str().unwrap();
        assert_eq!(comment["sourceTitle"], "Arrival");
        assert_eq!(comment["bookTitle"], "Book One");
        assert_eq!(comment["chapterTitle"], "Chapter One");
        assert_eq!(comment["bookId"], book_id);

        call(&engine, "nodes.update", json!({ "id": first_id, "patch": { "content": doc_with("the marked words", id) } }));
        assert_eq!(call(&engine, "comments.get", json!({ "id": id }))["anchored"], true);

        // Splitting a scene moves its text to another document.
        call(&engine, "nodes.update", json!({ "id": first_id, "patch": { "content": plain_doc("Left behind.") } }));
        call(&engine, "nodes.update", json!({ "id": second["id"], "patch": { "content": doc_with("the marked words", id) } }));
        let moved = call(&engine, "comments.get", json!({ "id": id }));
        assert_eq!(moved["sourceId"], second["id"]);
        assert_eq!(moved["sourceTitle"], "Departure");
        assert_eq!(moved["anchored"], true);
    }

    #[test]
    fn comments_follow_their_text_through_a_split_and_a_merge() {
        let (engine, _dir, _page) = engine_with_page();
        let book = call(&engine, "books.create", json!({ "title": "Book One" }));
        let book_id = book["id"].as_str().unwrap();
        let chapter = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book_id, "kind": "chapter", "title": "Chapter One" }),
        );
        let scene = call(
            &engine,
            "nodes.create",
            json!({ "bookId": book_id, "parentId": chapter["id"], "kind": "scene", "title": "Arrival" }),
        );
        let scene_id = scene["id"].as_str().unwrap().to_string();
        let comment = add(&engine, "node", &scene_id, json!({ "quote": "the marked words" }));
        let id = comment["id"].as_str().unwrap();
        call(&engine, "nodes.update", json!({ "id": scene_id, "patch": { "content": doc_with("the marked words", id) } }));

        let made = call(
            &engine,
            "nodes.split",
            json!({ "id": scene_id, "before": plain_doc("Left behind."), "after": doc_with("the marked words", id) }),
        );
        let moved = call(&engine, "comments.get", json!({ "id": id }));
        assert_eq!(moved["sourceId"], made["id"], "it goes with the second half");
        assert_eq!(moved["anchored"], true);

        call(&engine, "nodes.merge", json!({ "id": scene_id }));
        let back = call(&engine, "comments.get", json!({ "id": id }));
        assert_eq!(back["sourceId"], scene_id, "and comes back when they are joined");
        assert_eq!(back["anchored"], true);
        assert_eq!(back["quote"], "the marked words");
    }

    #[test]
    fn unknown_action_is_an_error() {
        let (engine, _dir, _page) = engine_with_page();
        assert_eq!(dispatch(&engine, "comments.nope", json!(null)).unwrap_err().code, "UNKNOWN_METHOD");
    }
}
