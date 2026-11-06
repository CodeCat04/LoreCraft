//! The idea inbox: quick notes captured from anywhere, each remembering where the writer
//! was. Adding goes through `ideas.add`, so tools outside the UI can use it the same way.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ok, parse, unknown};
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};

const STATUS_OPEN: &str = "open";
const STATUS_DONE: &str = "done";
const MAX_TEXT_CHARS: usize = 20_000;

/// Each row with what the UI needs to show and reach its source. A source in the trash, or
/// gone, has no title, so the UI can say so without another trip.
const SELECT: &str = "
    SELECT i.id, i.text, i.source_kind, i.source_id, i.status, i.created_at, i.updated_at,
           CASE i.source_kind
             WHEN 'page' THEN (SELECT p.title FROM pages p WHERE p.id = i.source_id AND p.deleted_at IS NULL)
             WHEN 'node' THEN (SELECT n.title FROM nodes n WHERE n.id = i.source_id AND n.deleted_at IS NULL)
           END,
           CASE i.source_kind
             WHEN 'node' THEN (SELECT n.book_id FROM nodes n WHERE n.id = i.source_id AND n.deleted_at IS NULL)
           END
      FROM ideas i";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Idea {
    id: String,
    text: String,
    source_kind: Option<String>,
    source_id: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
    /// `None` when there is no source, or it has been deleted.
    source_title: Option<String>,
    source_book_id: Option<String>,
}

impl Idea {
    fn from_row(row: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            text: row.get(1)?,
            source_kind: row.get(2)?,
            source_id: row.get(3)?,
            status: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
            source_title: row.get(7)?,
            source_book_id: row.get(8)?,
        })
    }
}

fn get(conn: &Connection, id: &str) -> AppResult<Idea> {
    conn.query_row(&format!("{SELECT} WHERE i.id = ?1"), [id], Idea::from_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("That idea"))
}

/// Keeps what was typed, line breaks included, without the blank edges.
fn clean_text(text: &str) -> AppResult<String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::invalid("An idea needs some text."));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(AppError::invalid("That idea is too long for the inbox."));
    }
    Ok(text.to_string())
}

fn check_status(status: &str) -> AppResult<()> {
    if status == STATUS_OPEN || status == STATUS_DONE {
        Ok(())
    } else {
        Err(AppError::invalid(format!("Unknown status: {status}")))
    }
}

/// Both parts or neither, so a row cannot half say where it came from.
fn clean_source(kind: Option<String>, id: Option<String>) -> AppResult<(Option<String>, Option<String>)> {
    let kind = kind.filter(|k| !k.is_empty());
    let id = id.filter(|i| !i.is_empty());
    match (kind, id) {
        (None, None) => Ok((None, None)),
        (Some(kind), Some(id)) if kind == "page" || kind == "node" => Ok((Some(kind), Some(id))),
        (Some(kind), Some(_)) => Err(AppError::invalid(format!("Unknown source kind: {kind}"))),
        _ => Err(AppError::invalid("A source needs both a kind and an id.")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddParams {
    text: String,
    source_kind: Option<String>,
    source_id: Option<String>,
}

fn add(engine: &Engine, params: Value) -> AppResult<Value> {
    let p: AddParams = parse(params)?;
    let text = clean_text(&p.text)?;
    let (source_kind, source_id) = clean_source(p.source_kind, p.source_id)?;
    let idea = engine.write(|tx| {
        let id = db::new_id();
        let now = db::now();
        tx.execute(
            "INSERT INTO ideas (id, text, source_kind, source_id, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, text, source_kind, source_id, STATUS_OPEN, now],
        )?;
        get(tx, &id)
    })?;
    engine.notify("ideas");
    ok(idea)
}

#[derive(Deserialize)]
struct ListParams {
    /// Leave out for every idea.
    status: Option<String>,
}

fn list(engine: &Engine, params: Value) -> AppResult<Value> {
    let p: ListParams = parse(params)?;
    if let Some(status) = &p.status {
        check_status(status)?;
    }
    let ideas = engine.read(|conn| {
        // The newest first, since what was just captured is what is on the writer's mind.
        let mut stmt = conn.prepare(&format!(
            "{SELECT} WHERE (?1 IS NULL OR i.status = ?1) ORDER BY i.created_at DESC, i.id DESC"
        ))?;
        let rows = stmt.query_map([&p.status], Idea::from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })?;
    ok(ideas)
}

#[derive(Serialize)]
struct Counts {
    open: i64,
    done: i64,
}

fn count(engine: &Engine) -> AppResult<Value> {
    let counts = engine.read(|conn| {
        let of = |status: &str| -> rusqlite::Result<i64> {
            conn.query_row("SELECT COUNT(*) FROM ideas WHERE status = ?1", [status], |r| r.get(0))
        };
        Ok(Counts { open: of(STATUS_OPEN)?, done: of(STATUS_DONE)? })
    })?;
    ok(counts)
}

#[derive(Deserialize)]
struct UpdateParams {
    id: String,
    text: Option<String>,
    status: Option<String>,
}

fn update(engine: &Engine, params: Value) -> AppResult<Value> {
    let p: UpdateParams = parse(params)?;
    let text = p.text.as_deref().map(clean_text).transpose()?;
    if let Some(status) = &p.status {
        check_status(status)?;
    }
    let idea = engine.write(|tx| {
        let changed = tx.execute(
            "UPDATE ideas SET text = COALESCE(?2, text), status = COALESCE(?3, status), updated_at = ?4
             WHERE id = ?1",
            params![p.id, text, p.status, db::now()],
        )?;
        if changed == 0 {
            return Err(AppError::not_found("That idea"));
        }
        get(tx, &p.id)
    })?;
    engine.notify("ideas");
    ok(idea)
}

#[derive(Deserialize)]
struct IdParams {
    id: String,
}

fn delete(engine: &Engine, params: Value) -> AppResult<Value> {
    let p: IdParams = parse(params)?;
    engine.write(|tx| {
        let changed = tx.execute("DELETE FROM ideas WHERE id = ?1", [&p.id])?;
        if changed == 0 {
            return Err(AppError::not_found("That idea"));
        }
        Ok(())
    })?;
    engine.notify("ideas");
    ok(true)
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "add" => add(engine, params),
        "list" => list(engine, params),
        "count" => count(engine),
        "update" => update(engine, params),
        "delete" => delete(engine, params),
        _ => Err(unknown(&format!("ideas.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::engine::{Engine, TestDir, TestHost};
    use crate::rpc::{call, dispatch};
    use serde_json::{json, Value};

    fn start() -> (Arc<Engine>, Arc<TestHost>, TestDir) {
        let (engine, host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "Inbox" }));
        (engine, host, dir)
    }

    fn scene(engine: &Engine) -> Value {
        let book = call(engine, "books.create", json!({ "title": "Book" }));
        let book_id = book["id"].as_str().unwrap();
        let chapter = call(engine, "nodes.create", json!({ "bookId": book_id, "kind": "chapter", "title": "One" }));
        call(engine, "nodes.create", json!({
            "bookId": book_id, "parentId": chapter["id"], "kind": "scene", "title": "The gate",
        }))
    }

    #[test]
    fn adds_lists_and_counts_with_the_newest_first() {
        let (engine, _host, _dir) = start();
        let first = call(&engine, "ideas.add", json!({ "text": "  A guild of smugglers  " }));
        assert_eq!(first["text"], "A guild of smugglers", "blank edges go");
        assert_eq!(first["status"], "open");
        assert!(first["sourceKind"].is_null());
        call(&engine, "ideas.add", json!({ "text": "Bram lied\nabout the map" }));

        let all = call(&engine, "ideas.list", Value::Null);
        assert_eq!(all[0]["text"], "Bram lied\nabout the map", "line breaks stay, and the newest is first");
        assert_eq!(all[1]["text"], "A guild of smugglers");
        assert_eq!(call(&engine, "ideas.count", Value::Null), json!({ "open": 2, "done": 0 }));
    }

    #[test]
    fn remembers_where_it_was_captured() {
        let (engine, _host, _dir) = start();
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        let node = scene(&engine);

        let on_page = call(&engine, "ideas.add", json!({
            "text": "From a page", "sourceKind": "page", "sourceId": page["id"],
        }));
        assert_eq!(on_page["sourceKind"], "page");
        assert_eq!(on_page["sourceId"], page["id"]);
        assert_eq!(on_page["sourceTitle"], "Aria");
        assert!(on_page["sourceBookId"].is_null());

        let on_scene = call(&engine, "ideas.add", json!({
            "text": "From a scene", "sourceKind": "node", "sourceId": node["id"],
        }));
        assert_eq!(on_scene["sourceTitle"], "The gate");
        assert_eq!(on_scene["sourceBookId"], node["bookId"]);
    }

    #[test]
    fn a_source_in_the_trash_has_no_title_and_a_purged_one_is_forgotten() {
        let (engine, _host, _dir) = start();
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        let id = page["id"].as_str().unwrap();
        call(&engine, "ideas.add", json!({ "text": "Idea", "sourceKind": "page", "sourceId": id }));

        call(&engine, "pages.delete", json!({ "id": id }));
        let trashed = call(&engine, "ideas.list", Value::Null);
        assert!(trashed[0]["sourceTitle"].is_null());
        assert_eq!(trashed[0]["sourceId"], id, "restoring the page brings the link back");

        call(&engine, "pages.restore", json!({ "id": id }));
        assert_eq!(call(&engine, "ideas.list", Value::Null)[0]["sourceTitle"], "Aria");

        call(&engine, "pages.delete", json!({ "id": id }));
        call(&engine, "pages.purge", json!({ "id": id }));
        let purged = call(&engine, "ideas.list", Value::Null);
        assert_eq!(purged[0]["text"], "Idea", "the idea itself is kept");
        assert!(purged[0]["sourceKind"].is_null());
        assert!(purged[0]["sourceId"].is_null());
    }

    #[test]
    fn edits_finishes_reopens_and_deletes() {
        let (engine, _host, _dir) = start();
        let idea = call(&engine, "ideas.add", json!({ "text": "First" }));
        let id = idea["id"].as_str().unwrap();

        let edited = call(&engine, "ideas.update", json!({ "id": id, "text": "Second" }));
        assert_eq!(edited["text"], "Second");
        assert_eq!(edited["status"], "open", "a field left out stays as it was");

        let done = call(&engine, "ideas.update", json!({ "id": id, "status": "done" }));
        assert_eq!(done["text"], "Second");
        assert_eq!(done["status"], "done");
        assert_eq!(call(&engine, "ideas.count", Value::Null), json!({ "open": 0, "done": 1 }));
        assert_eq!(call(&engine, "ideas.list", json!({ "status": "open" })), json!([]));
        assert_eq!(call(&engine, "ideas.list", json!({ "status": "done" }))[0]["id"], id);

        call(&engine, "ideas.update", json!({ "id": id, "status": "open" }));
        assert_eq!(call(&engine, "ideas.count", Value::Null), json!({ "open": 1, "done": 0 }));

        assert_eq!(call(&engine, "ideas.delete", json!({ "id": id })), json!(true));
        assert_eq!(call(&engine, "ideas.list", Value::Null), json!([]));
    }

    #[test]
    fn turns_away_what_it_cannot_store() {
        let (engine, _host, _dir) = start();
        let id = call(&engine, "ideas.add", json!({ "text": "Real" }))["id"].clone();
        for (method, params) in [
            ("ideas.add", json!({ "text": "   " })),
            ("ideas.add", json!({ "text": "x".repeat(20_001) })),
            ("ideas.add", json!({ "text": "x", "sourceKind": "map", "sourceId": "m" })),
            ("ideas.add", json!({ "text": "x", "sourceKind": "page" })),
            ("ideas.add", json!({ "text": "x", "sourceId": "p" })),
            ("ideas.list", json!({ "status": "archived" })),
            ("ideas.update", json!({ "id": id, "text": "" })),
            ("ideas.update", json!({ "id": id, "status": "archived" })),
            ("ideas.update", json!({ "id": "nothing", "text": "x" })),
            ("ideas.delete", json!({ "id": "nothing" })),
        ] {
            assert!(dispatch(&engine, method, params.clone()).is_err(), "{method} {params}");
        }
        assert!(dispatch(&engine, "ideas.nothing", Value::Null).is_err());
    }

    #[test]
    fn tells_the_ui_when_ideas_change() {
        let (engine, host, _dir) = start();
        let id = call(&engine, "ideas.add", json!({ "text": "One" }))["id"].clone();
        call(&engine, "ideas.update", json!({ "id": id, "status": "done" }));
        call(&engine, "ideas.delete", json!({ "id": id }));
        let told = host.events.lock().unwrap().iter().filter(|(name, payload)| {
            name == "data://changed" && payload["entity"] == "ideas"
        }).count();
        assert_eq!(told, 3);
    }
}
