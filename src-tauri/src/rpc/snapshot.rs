//! Reads the whole project at once, for exporters and consistency checks.

use rusqlite::Connection;
use serde_json::{json, Value};

use super::{canvas, manuscript, pages, unknown};
use crate::engine::Engine;
use crate::error::AppResult;

fn ids(conn: &Connection, sql: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn rows_to_json(
    conn: &Connection,
    sql: &str,
    row: impl FnMut(&rusqlite::Row) -> rusqlite::Result<Value>,
) -> AppResult<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn build(conn: &Connection) -> AppResult<Value> {
    let mut meta = serde_json::Map::new();
    {
        let mut stmt = conn.prepare("SELECT key, value FROM meta ORDER BY key")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (key, value) = row?;
            // The search index's own bookkeeping, which means nothing outside this file.
            if key == "names_stamp" {
                continue;
            }
            meta.insert(key, Value::String(value));
        }
    }

    let page_ids = ids(
        conn,
        "SELECT id FROM pages WHERE deleted_at IS NULL ORDER BY title_key",
    )?;
    let mut pages_out = Vec::with_capacity(page_ids.len());
    for id in page_ids {
        pages_out.push(pages::get_page(conn, &id)?);
    }

    let mut books_out = Vec::new();
    for book_id in ids(
        conn,
        "SELECT id FROM books WHERE deleted_at IS NULL ORDER BY position, created_at",
    )? {
        let book: Value = conn.query_row(
            "SELECT id, title, subtitle, author, position, target_words, created_at, updated_at,
                    publishing
             FROM books WHERE id = ?1",
            [&book_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "subtitle": r.get::<_, String>(2)?,
                    "author": r.get::<_, String>(3)?,
                    "position": r.get::<_, i64>(4)?,
                    "targetWords": r.get::<_, i64>(5)?,
                    "createdAt": r.get::<_, String>(6)?,
                    "updatedAt": r.get::<_, String>(7)?,
                    "publishing": serde_json::from_str::<Value>(&r.get::<_, String>(8)?)
                        .unwrap_or_else(|_| json!({})),
                }))
            },
        )?;
        books_out.push(book);
    }

    let node_ids = ids(
        conn,
        "SELECT n.id FROM nodes n JOIN books b ON b.id = n.book_id
         WHERE n.deleted_at IS NULL AND b.deleted_at IS NULL
         ORDER BY b.position, n.position, n.created_at",
    )?;
    let mut nodes_out = Vec::with_capacity(node_ids.len());
    for id in node_ids {
        let mut node = serde_json::to_value(manuscript::get_node(conn, &id)?)?;
        node["castPageIds"] = json!(manuscript::cast_of(conn, &id)?);
        nodes_out.push(node);
    }

    let relationships = rows_to_json(
        conn,
        "SELECT from_page_id, to_page_id, kind, note, created_at FROM relationships
         ORDER BY created_at, id",
        |r| {
            Ok(json!({
                "fromPageId": r.get::<_, String>(0)?,
                "toPageId": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?,
                "note": r.get::<_, String>(3)?,
                "createdAt": r.get::<_, String>(4)?,
            }))
        },
    )?;

    let mentions = rows_to_json(
        conn,
        "SELECT source_kind, source_id, page_id, count FROM mentions",
        |r| {
            Ok(json!({
                "sourceKind": r.get::<_, String>(0)?,
                "sourceId": r.get::<_, String>(1)?,
                "pageId": r.get::<_, String>(2)?,
                "count": r.get::<_, i64>(3)?,
            }))
        },
    )?;

    // Bytes stay out of this: read them a piece at a time with `readAssetChunks`.
    let assets = rows_to_json(
        conn,
        "SELECT id, name, mime, width, height, created_at, size FROM assets
         WHERE complete = 1
         ORDER BY created_at, id",
        |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "mime": r.get::<_, String>(2)?,
                "width": r.get::<_, Option<i64>>(3)?,
                "height": r.get::<_, Option<i64>>(4)?,
                "createdAt": r.get::<_, String>(5)?,
                "size": r.get::<_, i64>(6)?,
            }))
        },
    )?;

    let mut maps = Vec::new();
    for map_id in ids(
        conn,
        "SELECT id FROM maps WHERE deleted_at IS NULL ORDER BY created_at, id",
    )? {
        let mut stmt = conn.prepare(
            "SELECT page_id, label, x, y, created_at FROM map_pins WHERE map_id = ?1
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map([&map_id], |r| {
            Ok(json!({
                "pageId": r.get::<_, Option<String>>(0)?,
                "label": r.get::<_, String>(1)?,
                "x": r.get::<_, f64>(2)?,
                "y": r.get::<_, f64>(3)?,
                "createdAt": r.get::<_, String>(4)?,
            }))
        })?;
        let pins: Vec<Value> = rows.collect::<Result<_, _>>()?;
        let map: Value = conn.query_row(
            "SELECT id, title, asset_id, created_at, updated_at FROM maps WHERE id = ?1",
            [&map_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "assetId": r.get::<_, Option<String>>(2)?,
                    "createdAt": r.get::<_, String>(3)?,
                    "updatedAt": r.get::<_, String>(4)?,
                    "pins": pins,
                }))
            },
        )?;
        maps.push(map);
    }

    let dictionary = ids(conn, "SELECT word FROM dictionary ORDER BY word_key")?;

    let writing_log = rows_to_json(
        conn,
        "SELECT day, book_id, words_added, words_removed FROM writing_log ORDER BY day, book_id",
        |r| {
            Ok(json!({
                "day": r.get::<_, String>(0)?,
                "bookId": r.get::<_, String>(1)?,
                "wordsAdded": r.get::<_, i64>(2)?,
                "wordsRemoved": r.get::<_, i64>(3)?,
            }))
        },
    )?;

    // Built-in prompts belong to the app, not to this project's data.
    let prompts = rows_to_json(
        conn,
        "SELECT name, description, template, scope, position FROM prompts WHERE builtin = 0
         ORDER BY position, name",
        |r| {
            Ok(json!({
                "name": r.get::<_, String>(0)?,
                "description": r.get::<_, String>(1)?,
                "template": r.get::<_, String>(2)?,
                "scope": r.get::<_, String>(3)?,
                "position": r.get::<_, i64>(4)?,
            }))
        },
    )?;

    let threads = rows_to_json(
        conn,
        "SELECT id, name, color, description, position FROM threads ORDER BY position, name",
        |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "color": r.get::<_, String>(2)?,
                "description": r.get::<_, String>(3)?,
                "position": r.get::<_, i64>(4)?,
            }))
        },
    )?;

    let node_threads = rows_to_json(
        conn,
        "SELECT t.node_id, t.thread_id FROM node_threads t
         JOIN nodes n ON n.id = t.node_id JOIN threads h ON h.id = t.thread_id
         WHERE n.deleted_at IS NULL
         ORDER BY t.node_id, h.position, h.name",
        |r| {
            Ok(json!({
                "nodeId": r.get::<_, String>(0)?,
                "threadId": r.get::<_, String>(1)?,
            }))
        },
    )?;

    let mut canvases = Vec::new();
    for summary in canvas::list_canvases(conn, false)? {
        canvases.push(canvas::get_canvas(conn, &summary.id)?);
    }

    let mut snapshot = json!({
        "meta": meta,
        "pages": pages_out,
        "books": books_out,
        "nodes": nodes_out,
        "relationships": relationships,
        "mentions": mentions,
        "assets": assets,
        "maps": maps,
        "dictionary": dictionary,
        "writingLog": writing_log,
        "prompts": prompts,
        "threads": threads,
        "nodeThreads": node_threads,
        "canvases": canvases,
    });
    // Comments are notes to the writer, so they stay out of everything made from this.
    for list in ["pages", "nodes"] {
        if let Some(items) = snapshot.get_mut(list).and_then(Value::as_array_mut) {
            for content in items.iter_mut().filter_map(|item| item.get_mut("content")) {
                crate::content::strip_comment_marks(content);
            }
        }
    }
    Ok(snapshot)
}

pub fn handle(engine: &Engine, action: &str, _params: Value) -> AppResult<Value> {
    match action {
        "get" => engine.read(build),
        _ => Err(unknown(&format!("snapshot.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use crate::engine::Engine;
    use crate::rpc::call;
    use serde_json::json;

    #[test]
    fn snapshot_holds_everything_a_new_project_contains() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "S" }));
        let snap = call(&engine, "snapshot.get", json!({}));
        assert_eq!(snap["meta"]["name"], "S");
        assert_eq!(snap["pages"][0]["title"], "Main Page");
        assert_eq!(snap["books"].as_array().unwrap().len(), 1);
        assert!(snap["books"][0]["createdAt"].is_string());
        assert_eq!(snap["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(snap["assets"], json!([]));
        assert_eq!(snap["maps"], json!([]));
        assert_eq!(snap["dictionary"], json!([]));
        assert_eq!(snap["prompts"], json!([]));
        assert_eq!(snap["threads"], json!([]));
        assert_eq!(snap["nodeThreads"], json!([]));
        assert_eq!(snap["canvases"], json!([]));
    }

    #[test]
    fn snapshot_holds_canvases_but_not_trashed_ones() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let data = json!({ "nodes": [{ "id": "a", "type": "text", "text": "Hi" }], "edges": [] });
        call(&engine, "canvases.create", json!({ "title": "Kept", "data": data }));
        let gone = call(&engine, "canvases.create", json!({ "title": "Gone" }));
        call(&engine, "canvases.trash", json!({ "id": gone["id"] }));
        let snap = call(&engine, "snapshot.get", json!({}));
        assert_eq!(snap["canvases"].as_array().unwrap().len(), 1);
        assert_eq!(snap["canvases"][0]["title"], "Kept");
        assert_eq!(snap["canvases"][0]["data"], data);
    }

    #[test]
    fn image_bytes_are_not_part_of_the_snapshot() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let added = crate::rpc::media::test_support::upload(
            &engine,
            "a.png",
            "image/png",
            &crate::rpc::media::test_support::png_bytes(64),
        );
        let snap = call(&engine, "snapshot.get", json!({}));
        assert_eq!(snap["assets"][0]["id"], added["id"]);
        assert_eq!(snap["assets"][0]["size"], 64);
        assert!(snap["assets"][0].get("base64").is_none());
    }
}
