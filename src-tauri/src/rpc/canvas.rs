//! Canvases: free boards of cards and arrows, stored whole as JSON Canvas
//! (`{"nodes": [...], "edges": [...]}`). Cards name pages, scenes and assets by
//! `lorecraft:<kind>/<id>` strings, so nothing here depends on those rows existing.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{ok, parse, unknown};
use crate::content::title_key;
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};

/// The most a canvas may hold once written out, so one board cannot swell the project.
pub const MAX_DATA_BYTES: usize = 32 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 300;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

impl CanvasSummary {
    fn from_row(row: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            title: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            deleted_at: row.get(4)?,
        })
    }
}

/// Every canvas, by title. Trashed ones only when asked for.
pub fn list_canvases(conn: &Connection, include_deleted: bool) -> AppResult<Vec<CanvasSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at, deleted_at FROM canvases
         WHERE ?1 OR deleted_at IS NULL ORDER BY title_key, id",
    )?;
    let rows = stmt.query_map([include_deleted], CanvasSummary::from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// One canvas with its data parsed, trashed or not.
pub fn get_canvas(conn: &Connection, id: &str) -> AppResult<Value> {
    let row = conn
        .query_row(
            "SELECT id, title, data, created_at, updated_at, deleted_at FROM canvases WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("That canvas"))?;
    let (id, title, data, created_at, updated_at, deleted_at) = row;
    let data: Value = serde_json::from_str(&data).unwrap_or_else(|_| empty_data());
    Ok(json!({
        "id": id,
        "title": title,
        "data": data,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "deletedAt": deleted_at,
    }))
}

pub fn empty_data() -> Value {
    json!({ "nodes": [], "edges": [] })
}

/// Checks the shape and size, and returns the compact text to store.
pub fn check_data(data: &Value) -> AppResult<String> {
    let well_formed = data.as_object().is_some_and(|o| {
        o.get("nodes").is_some_and(Value::is_array) && o.get("edges").is_some_and(Value::is_array)
    });
    if !well_formed {
        return Err(AppError::invalid("A canvas needs a list of nodes and a list of edges."));
    }
    let text = serde_json::to_string(data)?;
    if text.len() > MAX_DATA_BYTES {
        return Err(AppError::invalid("That canvas is too large to save. The limit is 32 MB."));
    }
    Ok(text)
}

pub fn clean_title(title: &str) -> AppResult<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::invalid("A canvas needs a title."));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(AppError::invalid("That title is too long."));
    }
    Ok(title.to_string())
}

/// Adds a canvas row. Used by `canvases.create` and by imports.
pub fn insert(
    conn: &Connection,
    title: &str,
    data: &str,
    created_at: Option<&str>,
    updated_at: Option<&str>,
) -> AppResult<String> {
    let id = db::new_id();
    let now = db::now();
    conn.execute(
        "INSERT INTO canvases (id, title, title_key, data, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id,
            title,
            title_key(title),
            data,
            created_at.unwrap_or(&now),
            updated_at.unwrap_or(&now)
        ],
    )?;
    Ok(id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    #[serde(default)]
    include_deleted: bool,
}

#[derive(Deserialize)]
struct IdParams {
    id: String,
}

#[derive(Deserialize)]
struct CreateParams {
    title: String,
    data: Option<Value>,
}

#[derive(Deserialize)]
struct UpdateParams {
    id: String,
    data: Value,
}

#[derive(Deserialize)]
struct RenameParams {
    id: String,
    title: String,
}

fn create(engine: &Engine, params: Value) -> AppResult<Value> {
    let p: CreateParams = parse(params)?;
    let title = clean_title(&p.title)?;
    let data = check_data(&p.data.unwrap_or_else(empty_data))?;
    let canvas = engine.write(|tx| {
        let id = insert(tx, &title, &data, None, None)?;
        get_canvas(tx, &id)
    })?;
    engine.notify("canvases");
    ok(canvas)
}

fn update(engine: &Engine, params: Value) -> AppResult<Value> {
    let p: UpdateParams = parse(params)?;
    let data = check_data(&p.data)?;
    let now = db::now();
    engine.write(|tx| {
        let changed = tx.execute(
            "UPDATE canvases SET data = ?2, updated_at = ?3 WHERE id = ?1",
            params![p.id, data, now],
        )?;
        if changed == 0 {
            return Err(AppError::not_found("That canvas"));
        }
        Ok(())
    })?;
    engine.notify("canvases");
    ok(json!({ "updatedAt": now }))
}

/// Runs one change on a canvas: NOT_FOUND when there is no such canvas, INVALID with
/// `refused` when it exists but the change does not apply.
fn change(
    engine: &Engine,
    id: &str,
    refused: &str,
    run: impl FnOnce(&Connection, &str) -> rusqlite::Result<usize>,
) -> AppResult<Value> {
    engine.write(|tx| {
        let exists = tx
            .query_row("SELECT 1 FROM canvases WHERE id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some();
        if !exists {
            return Err(AppError::not_found("That canvas"));
        }
        if run(tx, &db::now())? == 0 {
            return Err(AppError::invalid(refused.to_string()));
        }
        Ok(())
    })?;
    engine.notify("canvases");
    ok(true)
}

fn rename(engine: &Engine, params: Value) -> AppResult<Value> {
    let p: RenameParams = parse(params)?;
    let title = clean_title(&p.title)?;
    change(engine, &p.id, "That canvas could not be renamed.", |tx, now| {
        tx.execute(
            "UPDATE canvases SET title = ?2, title_key = ?3, updated_at = ?4 WHERE id = ?1",
            params![p.id, title, title_key(&title), now],
        )
    })
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "list" => {
            let p: ListParams = parse(params)?;
            ok(engine.read(|conn| list_canvases(conn, p.include_deleted))?)
        }
        "get" => {
            let p: IdParams = parse(params)?;
            ok(engine.read(|conn| get_canvas(conn, &p.id))?)
        }
        "create" => create(engine, params),
        "update" => update(engine, params),
        "rename" => rename(engine, params),
        "trash" => {
            let p: IdParams = parse(params)?;
            change(engine, &p.id, "That canvas is already in the trash.", |tx, now| {
                tx.execute(
                    "UPDATE canvases SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
                    params![p.id, now],
                )
            })
        }
        "restore" => {
            let p: IdParams = parse(params)?;
            change(engine, &p.id, "That canvas is not in the trash.", |tx, now| {
                tx.execute(
                    "UPDATE canvases SET deleted_at = NULL, updated_at = ?2
                     WHERE id = ?1 AND deleted_at IS NOT NULL",
                    params![p.id, now],
                )
            })
        }
        "purge" => {
            let p: IdParams = parse(params)?;
            change(engine, &p.id, "Only a canvas in the trash can be deleted for good.", |tx, _| {
                tx.execute("DELETE FROM canvases WHERE id = ?1 AND deleted_at IS NOT NULL", [&p.id])
            })
        }
        _ => Err(unknown(&format!("canvases.{action}"))),
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
        call(&engine, "project.new", json!({ "name": "Boards" }));
        (engine, host, dir)
    }

    fn board() -> Value {
        json!({
            "nodes": [
                { "id": "a", "type": "text", "text": "The siege", "x": 0, "y": 0, "width": 200, "height": 80 },
                { "id": "b", "type": "file", "file": "lorecraft:page/p1", "x": 300, "y": 0, "width": 200, "height": 80 }
            ],
            "edges": [{ "id": "e", "fromNode": "a", "toNode": "b" }]
        })
    }

    #[test]
    fn creates_gets_updates_and_lists_by_title() {
        let (engine, _host, _dir) = start();
        let made = call(&engine, "canvases.create", json!({ "title": "  Zeal plot " }));
        assert_eq!(made["title"], "Zeal plot");
        assert_eq!(made["data"], json!({ "nodes": [], "edges": [] }));
        assert!(made["deletedAt"].is_null());
        let id = made["id"].as_str().unwrap().to_string();
        call(&engine, "canvases.create", json!({ "title": "apples", "data": board() }));

        let updated = call(&engine, "canvases.update", json!({ "id": id, "data": board() }));
        assert!(updated["updatedAt"].is_string());
        let got = call(&engine, "canvases.get", json!({ "id": id }));
        assert_eq!(got["data"], board());

        let list = call(&engine, "canvases.list", Value::Null);
        let titles: Vec<_> = list.as_array().unwrap().iter().map(|c| c["title"].clone()).collect();
        assert_eq!(titles, vec![json!("apples"), json!("Zeal plot")]);
        assert!(list[0].get("data").is_none(), "lists stay light");
    }

    #[test]
    fn renames_trashes_restores_and_purges() {
        let (engine, host, _dir) = start();
        let id = call(&engine, "canvases.create", json!({ "title": "One" }))["id"].clone();
        call(&engine, "canvases.rename", json!({ "id": id, "title": "Two" }));
        assert_eq!(call(&engine, "canvases.get", json!({ "id": id }))["title"], "Two");

        assert!(dispatch(&engine, "canvases.purge", json!({ "id": id })).is_err(), "not in the trash yet");
        call(&engine, "canvases.trash", json!({ "id": id }));
        assert_eq!(call(&engine, "canvases.list", json!({})), json!([]));
        let all = call(&engine, "canvases.list", json!({ "includeDeleted": true }));
        assert!(all[0]["deletedAt"].is_string());

        call(&engine, "canvases.restore", json!({ "id": id }));
        assert_eq!(call(&engine, "canvases.list", json!({})).as_array().unwrap().len(), 1);

        call(&engine, "canvases.trash", json!({ "id": id }));
        call(&engine, "canvases.purge", json!({ "id": id }));
        let gone = dispatch(&engine, "canvases.get", json!({ "id": id })).unwrap_err();
        assert_eq!(gone.code, "NOT_FOUND");

        let told = host
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, payload)| name == "data://changed" && payload["entity"] == "canvases")
            .count();
        assert_eq!(told, 6, "create, rename, trash, restore, trash and purge each tell the UI");
    }

    #[test]
    fn turns_away_what_it_cannot_store() {
        let (engine, _host, _dir) = start();
        let id = call(&engine, "canvases.create", json!({ "title": "Real" }))["id"].clone();
        for (method, params) in [
            ("canvases.create", json!({ "title": "   " })),
            ("canvases.create", json!({ "title": "x", "data": [] })),
            ("canvases.update", json!({ "id": id, "data": { "nodes": [] } })),
            ("canvases.update", json!({ "id": id, "data": { "nodes": {}, "edges": [] } })),
            ("canvases.update", json!({ "id": id, "data": "text" })),
            ("canvases.update", json!({ "id": "nothing", "data": { "nodes": [], "edges": [] } })),
            ("canvases.rename", json!({ "id": id, "title": " " })),
            ("canvases.restore", json!({ "id": id })),
            ("canvases.trash", json!({ "id": "nothing" })),
        ] {
            let err = dispatch(&engine, method, params.clone()).unwrap_err();
            assert!(err.code == "INVALID" || err.code == "NOT_FOUND", "{method} {params}: {}", err.code);
        }
        let huge = "x".repeat(super::MAX_DATA_BYTES);
        let err = dispatch(
            &engine,
            "canvases.update",
            json!({ "id": id, "data": { "nodes": [{ "text": huge }], "edges": [] } }),
        )
        .unwrap_err();
        assert_eq!(err.code, "INVALID");
        assert_eq!(call(&engine, "canvases.get", json!({ "id": id }))["data"]["nodes"], json!([]));
    }

    #[test]
    fn purging_a_page_leaves_canvases_that_point_at_it() {
        let (engine, _host, _dir) = start();
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        let pid = page["id"].as_str().unwrap();
        let data = json!({ "nodes": [{ "id": "n", "type": "file", "file": format!("lorecraft:page/{pid}") }], "edges": [] });
        let id = call(&engine, "canvases.create", json!({ "title": "B", "data": data }))["id"].clone();
        call(&engine, "pages.delete", json!({ "id": pid }));
        call(&engine, "pages.purge", json!({ "id": pid }));
        assert_eq!(call(&engine, "canvases.get", json!({ "id": id }))["data"], data);
    }
}
