//! Suggestions from outside tools, as rows in `proposals`, and the helpers write tools share.
//! Nothing here touches a document. The app applies a suggestion when the writer accepts it,
//! or at once at the edit level, with the code in `src/mcp/kinds/`. See `super::write`.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::areas::{self, Handler};
use super::config::PERMISSION_SUGGEST;
use super::limits;
use super::text::cut;
use super::tools::{resolve_node, resolve_page, Ctx};
use super::write::{self, Draft, WriteCx};
use crate::content::title_key;
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::rpc::manuscript;

pub const STATUS_PENDING: &str = "pending";
/// Stored at the edit level, for the app's window to pick up and apply.
pub const STATUS_AUTO: &str = "auto";
/// The window has picked it up and is applying it.
pub const STATUS_APPLYING: &str = "applying";
/// Applied at the edit level. It shows under Applied by outside AI, with Undo.
pub const STATUS_APPLIED: &str = "applied";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_UNDONE: &str = "undone";

pub const NEEDS_APP: &str = "Changes need LoreCraft to be open with this project, so the writer can see them. Open it there and try again. Reading works from the last saved file in the meantime.";
pub const READ_ONLY: &str = "The writer has set outside tools to read only, so changes and suggestions are turned off. They can allow them in LoreCraft under Settings, AI tools (MCP).";

/// A client that keeps proposing should not bury the writer.
pub const MAX_PENDING: i64 = 500;
pub const MAX_TEXT: usize = 500_000;
pub const MAX_LABEL: usize = 200;

/// Projects made before this table existed have no row to read, and gain it on first use.
const TABLE: &str = "CREATE TABLE IF NOT EXISTS proposals (
  id          TEXT PRIMARY KEY,
  client      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  target_kind TEXT,
  target_id   TEXT,
  title       TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status, created_at);";

fn has_table(conn: &Connection) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'proposals'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// What waits for the writer. The badge shows this, so changes already made never count.
pub fn pending_count(conn: &Connection) -> AppResult<i64> {
    if !has_table(conn)? {
        return Ok(0);
    }
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM proposals WHERE status = ?1",
        [STATUS_PENDING],
        |r| r.get(0),
    )?)
}

/// What counts against the cap: waiting for the writer, or for the window.
fn open_count(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM proposals WHERE status IN (?1, ?2, ?3)",
        [STATUS_PENDING, STATUS_AUTO, STATUS_APPLYING],
        |r| r.get(0),
    )?)
}

/// Oldest first, except applied changes, which come newest first and at most `limit`.
pub fn list(conn: &Connection, status: &str) -> AppResult<Vec<Value>> {
    if !has_table(conn)? {
        return Ok(Vec::new());
    }
    let order = if status == STATUS_APPLIED { "created_at DESC, id DESC LIMIT 200" } else { "created_at, id" };
    let mut stmt = conn.prepare(&format!(
        "SELECT id, client, kind, target_kind, target_id, title, payload, status, created_at
         FROM proposals WHERE status = ?1 ORDER BY {order}"
    ))?;
    let rows = stmt.query_map([status], |r| {
        let payload: String = r.get(6)?;
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "client": r.get::<_, String>(1)?,
            "kind": r.get::<_, String>(2)?,
            "targetKind": r.get::<_, Option<String>>(3)?,
            "targetId": r.get::<_, Option<String>>(4)?,
            "title": r.get::<_, String>(5)?,
            "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null),
            "status": r.get::<_, String>(7)?,
            "createdAt": r.get::<_, String>(8)?,
        }))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A suggestion's status and payload, for a call waiting on it.
pub fn status_of(conn: &Connection, id: &str) -> AppResult<Option<(String, Value)>> {
    if !has_table(conn)? {
        return Ok(None);
    }
    Ok(conn
        .query_row("SELECT status, payload FROM proposals WHERE id = ?1", [id], |r| {
            let payload: String = r.get(1)?;
            Ok((r.get(0)?, serde_json::from_str(&payload).unwrap_or(Value::Null)))
        })
        .optional()?)
}

/// The step each status may take, and from where.
fn from_status(status: &str) -> Option<&'static str> {
    match status {
        "accepted" | "rejected" => Some(STATUS_PENDING),
        STATUS_APPLYING => Some(STATUS_AUTO),
        STATUS_APPLIED | STATUS_FAILED => Some(STATUS_APPLYING),
        STATUS_UNDONE => Some(STATUS_APPLIED),
        _ => None,
    }
}

/// Marks a suggestion as dealt with. Returns false if it already was.
pub fn resolve(conn: &Connection, id: &str, status: &str) -> AppResult<bool> {
    resolve_with(conn, id, status, &Map::new())
}

/// Moves a suggestion on, merging `extra` into its payload: `undo` for an applied change,
/// `error` for a failed one. Returns false if it was not where that step starts.
pub fn resolve_with(conn: &Connection, id: &str, status: &str, extra: &Map<String, Value>) -> AppResult<bool> {
    let Some(from) = from_status(status) else {
        return Err(AppError::invalid("A suggestion is accepted, rejected, applied, failed or undone."));
    };
    if !has_table(conn)? {
        return Err(AppError::not_found("That suggestion"));
    }
    let Some((now, mut payload)) = status_of(conn, id)? else {
        return Ok(false);
    };
    if now != from {
        return Ok(false);
    }
    if let Value::Object(map) = &mut payload {
        for (key, value) in extra {
            if matches!(key.as_str(), "undo" | "error") {
                map.insert(key.clone(), value.clone());
            }
        }
    }
    let changed = conn.execute(
        "UPDATE proposals SET status = ?1, payload = ?2 WHERE id = ?3 AND status = ?4",
        params![status, payload.to_string(), id, from],
    )?;
    Ok(changed > 0)
}

/// The window did not pick it up in time, so it waits for the writer instead.
pub fn back_to_pending(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn.execute(
        "UPDATE proposals SET status = ?1 WHERE id = ?2 AND status = ?3",
        params![STATUS_PENDING, id, STATUS_AUTO],
    )? > 0)
}

pub fn required<'a>(args: &'a Value, name: &str) -> AppResult<&'a str> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::invalid(format!("{name} is required.")))
}

pub fn optional<'a>(args: &'a Value, name: &str) -> &'a str {
    args.get(name).and_then(Value::as_str).unwrap_or("").trim()
}

pub fn check_size(name: &str, text: &str) -> AppResult<()> {
    if text.len() > MAX_TEXT {
        return Err(AppError::invalid(format!(
            "{name} is too long. Suggest a smaller change."
        )));
    }
    Ok(())
}

pub fn string_list(args: &Value, name: &str) -> Vec<String> {
    args.get(name)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|s| cut(s.trim(), MAX_LABEL).to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// The note to the writer saying why, cut to size.
pub fn reason(args: &Value) -> Value {
    json!(cut(optional(args, "reason"), 2000))
}

/// Stores a draft with the given status. The cap counts what waits for the writer or the
/// window, so a client that keeps calling cannot bury either.
pub fn insert(engine: &Engine, client: &str, draft: &Draft, status: &str) -> AppResult<String> {
    let id = db::new_id();
    engine.write(|tx| {
        tx.execute_batch(TABLE)?;
        if open_count(tx)? >= MAX_PENDING {
            return Err(AppError::new(
                "TOO_MANY",
                "Too many suggestions are waiting for the writer. Ask them to review the ones in Outside suggestions first.",
            ));
        }
        tx.execute(
            "INSERT INTO proposals (id, client, kind, target_kind, target_id, title, payload, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                cut(client, MAX_LABEL),
                draft.kind,
                draft.target_kind,
                draft.target_id,
                draft.title,
                draft.payload.to_string(),
                status,
                db::now(),
            ],
        )?;
        Ok(())
    })?;
    engine.notify("proposals");
    Ok(id)
}

// ---------------------------------------------------------------------------
// Helpers for write tools: books, parts, chapters, scenes and pages by name
// ---------------------------------------------------------------------------

pub fn resolve_book(ctx: &Ctx, wanted: &str) -> AppResult<(String, String)> {
    let mut stmt = ctx
        .conn
        .prepare("SELECT id, title FROM books WHERE deleted_at IS NULL ORDER BY position, created_at")?;
    let books: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    if wanted.is_empty() {
        return match books.len() {
            0 => Err(AppError::not_found("A book")),
            1 => Ok(books[0].clone()),
            _ => Err(AppError::invalid(format!(
                "This project has more than one book. Give book: {}",
                books.iter().map(|(_, t)| format!("\"{t}\"")).collect::<Vec<_>>().join(", ")
            ))),
        };
    }
    books
        .iter()
        .find(|(id, title)| id == wanted || title_key(title) == title_key(wanted))
        .cloned()
        .ok_or_else(|| AppError::not_found(format!("A book called \"{wanted}\"")))
}

/// A part, chapter or scene by id, or else by title.
pub fn node_ref(ctx: &Ctx, value: &str, kinds: &[&str]) -> AppResult<manuscript::Node> {
    resolve_node(ctx, &json!({ "id": value }), kinds)
        .or_else(|_| resolve_node(ctx, &json!({ "title": value }), kinds))
}

/// The book's parts, chapters and scenes in reading order, leaving out what is hidden.
pub fn reading_order(ctx: &Ctx, book_id: &str) -> AppResult<Vec<manuscript::NodeMeta>> {
    let all = manuscript::tree(ctx.conn, book_id)?;
    fn walk(all: &[manuscript::NodeMeta], parent: Option<&str>, out: &mut Vec<manuscript::NodeMeta>) {
        for node in all.iter().filter(|n| n.parent_id.as_deref() == parent) {
            out.push(node.clone());
            walk(all, Some(&node.id), out);
        }
    }
    let mut out = Vec::new();
    walk(&all, None, &mut out);
    out.retain(|n| !ctx.node_hidden(&n.id));
    Ok(out)
}

/// A page named by title or alias, or by id, as `{ id, title }`.
pub fn page_ref(ctx: &Ctx, value: &str) -> AppResult<Value> {
    let id = resolve_page(ctx, &json!({ "title": value }))
        .or_else(|_| resolve_page(ctx, &json!({ "id": value })))?;
    let title: String = ctx
        .conn
        .query_row("SELECT title FROM pages WHERE id = ?1", [&id], |r| r.get(0))?;
    Ok(json!({ "id": id, "title": title }))
}

/// POV, location and cast for a new scene. Absent fields are left out.
pub fn scene_people(ctx: &Ctx, args: &Value, payload: &mut Map<String, Value>) -> AppResult<()> {
    for (arg, key) in [("pov", "pov"), ("location", "location")] {
        let value = optional(args, arg);
        if !value.is_empty() {
            payload.insert(key.into(), page_ref(ctx, value)?);
        }
    }
    let cast = string_list(args, "cast")
        .iter()
        .map(|name| page_ref(ctx, name))
        .collect::<AppResult<Vec<_>>>()?;
    payload.insert("cast".into(), Value::Array(cast));
    Ok(())
}

pub fn label(args: &Value, name: &str, what: &str) -> AppResult<String> {
    let value = optional(args, name).split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        return Err(AppError::invalid(format!("{what} needs a title.")));
    }
    if value.len() > MAX_LABEL {
        return Err(AppError::invalid("That title is too long."));
    }
    Ok(value)
}

/// Runs a write tool at the suggest level, as before the edit level existed.
pub fn call(engine: &Engine, client: &str, name: &str, args: &Value, share: bool) -> AppResult<String> {
    call_as(engine, client, name, args, share, PERMISSION_SUGGEST, write::Waits::default())
}

/// Runs a write tool: checks the hard limits, lets its handler build a draft, and submits it.
pub fn call_as(
    engine: &Engine,
    client: &str,
    name: &str,
    args: &Value,
    share: bool,
    permission: &str,
    waits: write::Waits,
) -> AppResult<String> {
    limits::check_args(args)?;
    match areas::find(name).map(|t| t.handler) {
        Some(Handler::Write(build)) => {
            let draft = build(&WriteCx::new(engine, client, share), args)?;
            write::submit(engine, client, draft, permission, waits)
        }
        Some(Handler::Direct(run)) => run(engine, client, args),
        _ => Err(AppError::invalid(format!("There is no tool named {name}."))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::areas::lore_edits::MAX_IDEA_CHARS;
    use crate::mcp::config::{PERMISSION_EDIT, PERMISSION_READ};
    use crate::mcp::write::Waits;
    use crate::rpc::call as rpc;
    use std::sync::Arc;
    use std::time::Duration;

    fn quick() -> Waits {
        Waits {
            claim: Duration::from_millis(600),
            apply: Duration::from_millis(1500),
            poll: Duration::from_millis(20),
        }
    }

    /// Plays the app's window: picks up each change and marks it applied, or failed.
    fn window(engine: &Arc<Engine>, fail: Option<&'static str>) -> std::thread::JoinHandle<()> {
        let engine = engine.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(15));
                let waiting = engine.read(|c| list(c, STATUS_AUTO)).unwrap();
                if let Some(row) = waiting.first() {
                    let id = row["id"].as_str().unwrap().to_string();
                    assert!(engine.write(|tx| resolve(tx, &id, STATUS_APPLYING)).unwrap());
                    let mut extra = Map::new();
                    let status = match fail {
                        Some(reason) => {
                            extra.insert("error".into(), json!(reason));
                            STATUS_FAILED
                        }
                        None => {
                            extra.insert("undo".into(), json!({ "revision": "r1" }));
                            STATUS_APPLIED
                        }
                    };
                    assert!(engine.write(|tx| resolve_with(tx, &id, status, &extra)).unwrap());
                    return;
                }
            }
        })
    }

    #[test]
    fn at_the_edit_level_a_change_waits_for_the_window_and_says_done() {
        let (engine, _dir, _id) = project();
        let helper = window(&engine, None);
        let args = json!({ "target": "page", "title": "Aria", "quote": "She said \"no\" twice.", "replacement": "She refused." });
        let said = call_as(&engine, "c", "propose_edit", &args, false, PERMISSION_EDIT, quick()).unwrap();
        helper.join().unwrap();
        assert!(said.starts_with("Done: "), "{said}");
        // A change already made never counts on the badge, and shows with its undo.
        assert_eq!(engine.read(pending_count).unwrap(), 0);
        let applied = engine.read(|c| list(c, STATUS_APPLIED)).unwrap();
        assert_eq!(applied.len(), 1);
        assert_eq!(applied[0]["payload"]["undo"]["revision"], "r1");
        let id = applied[0]["id"].as_str().unwrap();
        assert!(engine.write(|tx| resolve(tx, id, STATUS_UNDONE)).unwrap());
        assert!(!engine.write(|tx| resolve(tx, id, STATUS_UNDONE)).unwrap(), "undone only once");
    }

    #[test]
    fn at_the_edit_level_a_failure_comes_back_as_the_real_error() {
        let (engine, _dir, _id) = project();
        let helper = window(&engine, Some("The quoted text is no longer there."));
        let args = json!({ "target": "page", "title": "Aria", "quote": "She said", "replacement": "New" });
        let err = call_as(&engine, "c", "propose_edit", &args, false, PERMISSION_EDIT, quick()).unwrap_err();
        helper.join().unwrap();
        assert_eq!(err.code, "NOT_APPLIED");
        assert!(err.message.contains("no longer there"), "{}", err.message);
        assert_eq!(engine.read(pending_count).unwrap(), 0);
    }

    #[test]
    fn with_no_window_the_change_waits_as_a_normal_suggestion() {
        let (engine, _dir, _id) = project();
        let args = json!({ "target": "page", "title": "Aria", "quote": "She said", "replacement": "New" });
        let said = call_as(&engine, "c", "propose_edit", &args, false, PERMISSION_EDIT, quick()).unwrap();
        assert!(said.contains("did not respond"), "{said}");
        assert_eq!(engine.read(pending_count).unwrap(), 1);
        // A window that wakes up late finds nothing to pick up.
        let id = engine.read(|c| list(c, STATUS_PENDING)).unwrap()[0]["id"].as_str().unwrap().to_string();
        assert!(!engine.write(|tx| resolve(tx, &id, STATUS_APPLYING)).unwrap());
    }

    #[test]
    fn the_suggest_level_still_only_queues() {
        let (engine, _dir, _id) = project();
        let args = json!({ "target": "page", "title": "Aria", "quote": "She said", "replacement": "New" });
        let said = call_as(&engine, "c", "propose_edit", &args, false, "suggest", quick()).unwrap();
        assert!(said.contains("Nothing has changed yet"), "{said}");
        assert!(engine.read(|c| list(c, STATUS_AUTO)).unwrap().is_empty());
        assert_eq!(engine.read(pending_count).unwrap(), 1);
    }

    #[test]
    fn statuses_only_move_forward() {
        let (engine, _dir, _id) = project();
        call(&engine, "c", "propose_new_page", &json!({ "title": "Gate", "body": "x" }), false).unwrap();
        let id = engine.read(|c| list(c, STATUS_PENDING)).unwrap()[0]["id"].as_str().unwrap().to_string();
        // A suggestion waiting for the writer cannot be applied, failed or undone behind them.
        for status in [STATUS_APPLYING, STATUS_APPLIED, STATUS_FAILED, STATUS_UNDONE] {
            assert!(!engine.write(|tx| resolve(tx, &id, status)).unwrap(), "{status}");
        }
        assert!(engine.write(|tx| resolve(tx, &id, "bogus")).is_err());
        assert!(engine.write(|tx| resolve(tx, &id, "accepted")).unwrap());
    }

    #[test]
    fn the_cap_counts_changes_waiting_for_the_window() {
        let (engine, _dir, _id) = project();
        engine
            .write(|tx| {
                tx.execute_batch(TABLE)?;
                for n in 0..MAX_PENDING {
                    tx.execute(
                        "INSERT INTO proposals (id, client, kind, title, payload, status, created_at) VALUES (?1, 'c', 'edit', '', '{}', ?2, 'now')",
                        params![db::new_id(), if n % 2 == 0 { STATUS_AUTO } else { STATUS_PENDING }],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        let refused = call(&engine, "c", "propose_new_page", &json!({ "title": "Gate", "body": "x" }), false).unwrap_err();
        assert_eq!(refused.code, "TOO_MANY");
    }

    #[test]
    fn hard_limits_hold_for_every_write_tool() {
        let (engine, _dir, _id) = project();
        for tool in areas::all().iter().filter(|t| t.writes()) {
            for key in ["local_only", "permission", "api_key", "provider"] {
                let refused = call_as(&engine, "c", tool.name, &json!({ key: true, "title": "x" }), true, PERMISSION_EDIT, quick()).unwrap_err();
                assert_eq!(refused.code, "NOT_ALLOWED", "{} {key}", tool.name);
            }
        }
        // No tool is named for settings, providers, keys, limits, or deleting the project.
        for tool in areas::all() {
            for word in ["permission", "setting_", "provider", "api_key", "spending", "local_only", "delete_project"] {
                assert!(!tool.name.contains(word) || tool.name == "get_settings_overview", "{}", tool.name);
            }
        }
        assert_eq!(engine.read(pending_count).unwrap(), 0);
    }

    #[test]
    fn set_style_guide_replaces_or_appends_and_keeps_the_old_text() {
        let (engine, _dir, _id) = project();
        rpc(
            &engine,
            "project.setMeta",
            json!({ "key": "writingStyles.guide", "value": "{\"project\":{\"tense\":\"Past tense\",\"voice\":\"Wry.\"}}" }),
        );
        call(&engine, "c", "set_style_guide", &json!({ "text": "Short sentences.", "mode": "append", "tense": "Present tense" }), false).unwrap();
        let p = last(&engine);
        assert_eq!(p["kind"], "styleGuide");
        assert_eq!(p["targetKind"], "meta");
        assert_eq!(p["payload"]["changes"]["voice"], "Wry.\nShort sentences.");
        assert_eq!(p["payload"]["changes"]["tense"], "Present tense");
        assert_eq!(p["payload"]["before"]["voice"], "Wry.");
        assert_eq!(p["payload"]["before"]["tense"], "Past tense");
        call(&engine, "c", "set_style_guide", &json!({ "voice": "Plain." }), false).unwrap();
        assert_eq!(last(&engine)["payload"]["changes"]["voice"], "Plain.");
        let same = call(&engine, "c", "set_style_guide", &json!({ "tense": "Past tense" }), false).unwrap_err();
        assert_eq!(same.code, "INVALID");
        assert_eq!(call(&engine, "c", "set_style_guide", &json!({}), false).unwrap_err().code, "INVALID");
        assert_eq!(call(&engine, "c", "set_style_guide", &json!({ "text": "x", "mode": "merge" }), false).unwrap_err().code, "INVALID");
    }

    #[test]
    fn the_settings_overview_says_what_is_allowed() {
        let (engine, _dir, _id) = project();
        rpc(&engine, "project.setMeta", json!({ "key": "language", "value": "fr" }));
        let overview = |permission: &str, share: bool| {
            engine
                .read(|conn| {
                    let mut ctx = Ctx::new(conn, "Ashfall".into(), true, share)?;
                    ctx.permission = Some(permission.to_string());
                    crate::mcp::tools::call(&ctx, "get_settings_overview", &json!({}))
                })
                .unwrap()
        };
        let text = overview(PERMISSION_EDIT, false);
        assert!(text.contains("Make changes directly"), "{text}");
        assert!(text.contains("Hidden."), "{text}");
        assert!(text.contains("Project language: fr"), "{text}");
        assert!(overview(PERMISSION_READ, true).contains("Read only"));
        assert!(overview("suggest", true).contains("Shared."));
    }

    fn project() -> (Arc<Engine>, crate::engine::TestDir, String) {
        let (engine, _host, dir) = Engine::for_test();
        rpc(&engine, "project.new", json!({ "name": "Ashfall" }));
        let made = rpc(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "content": { "type": "doc", "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "She said \u{201C}no\u{201D} twice. The gate is old. The gate is old." }] },
            ]}}),
        );
        let id = made["id"].as_str().unwrap().to_string();
        (engine, dir, id)
    }

    #[test]
    fn an_edit_is_stored_and_the_document_stays_the_same() {
        let (engine, _dir, id) = project();
        let before = rpc(&engine, "pages.get", json!({ "id": id }))["content"].clone();
        let said = call(
            &engine,
            "Test client",
            "propose_edit",
            &json!({ "target": "page", "title": "Aria", "quote": "She said \"no\" twice.", "replacement": "She refused." }),
            false,
        )
        .unwrap();
        assert!(said.contains("Nothing has changed yet"), "{said}");
        assert_eq!(rpc(&engine, "pages.get", json!({ "id": id }))["content"], before);
        let waiting = engine.read(|c| list(c, STATUS_PENDING)).unwrap();
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0]["client"], "Test client");
        assert_eq!(waiting[0]["targetKind"], "page");
        assert_eq!(waiting[0]["targetId"], Value::String(id));
        assert_eq!(waiting[0]["payload"]["replacement"], "She refused.");
        assert_eq!(engine.read(pending_count).unwrap(), 1);
        let proposal = waiting[0]["id"].as_str().unwrap();
        assert!(engine.write(|tx| resolve(tx, proposal, "rejected")).unwrap());
        assert!(!engine.write(|tx| resolve(tx, proposal, "accepted")).unwrap());
        assert_eq!(engine.read(pending_count).unwrap(), 0);
    }

    #[test]
    fn a_quote_must_exist_and_be_unique() {
        let (engine, _dir, _id) = project();
        let args = |quote: &str| json!({ "target": "page", "title": "Aria", "quote": quote, "replacement": "New" });
        let missing = call(&engine, "c", "propose_edit", &args("not there"), false).unwrap_err();
        assert_eq!(missing.code, "QUOTE_NOT_FOUND");
        let repeated = call(&engine, "c", "propose_edit", &args("The gate is old."), false).unwrap_err();
        assert_eq!(repeated.code, "QUOTE_NOT_UNIQUE");
        assert_eq!(engine.read(pending_count).unwrap(), 0);
    }

    #[test]
    fn a_local_only_target_does_not_exist_for_a_suggestion() {
        let (engine, _dir, id) = project();
        engine
            .write(|tx| {
                tx.execute("UPDATE pages SET local_only = 1 WHERE id = ?1", [&id])?;
                Ok(())
            })
            .unwrap();
        let args = json!({ "target": "page", "id": id, "quote": "She said", "replacement": "New" });
        let refused = call(&engine, "c", "propose_edit", &args, false).unwrap_err();
        assert_eq!(refused.code, "NOT_FOUND");
        assert!(call(&engine, "c", "propose_edit", &args, true).is_ok());
    }

    #[test]
    fn a_new_page_needs_a_free_title_and_starts_nothing_until_accepted() {
        let (engine, _dir, _id) = project();
        let taken = call(
            &engine,
            "c",
            "propose_new_page",
            &json!({ "title": "aria", "body": "x" }),
            false,
        )
        .unwrap_err();
        assert_eq!(taken.code, "TITLE_TAKEN");
        call(
            &engine,
            "c",
            "propose_new_page",
            &json!({ "title": "The Gate", "type": "place", "body": "An old *gate*.", "infobox": { "Built": "Year 12" }, "aliases": ["Old Gate"] }),
            false,
        )
        .unwrap();
        let none = rpc(&engine, "pages.getByTitle", json!({ "title": "The Gate" }));
        assert!(none.is_null());
        let waiting = engine.read(|c| list(c, STATUS_PENDING)).unwrap();
        assert_eq!(waiting[0]["kind"], "newPage");
        assert_eq!(waiting[0]["payload"]["infobox"][0]["label"], "Built");
    }

    #[test]
    fn an_idea_lands_in_the_inbox_naming_its_tool() {
        let (engine, _dir, _id) = project();
        let said = call(&engine, "Claude Code", "add_idea", &json!({ "text": "What if the gate remembers?" }), false).unwrap();
        assert!(said.contains("idea inbox"), "{said}");
        let ideas = rpc(&engine, "ideas.list", json!({}));
        let text = ideas[0]["text"].as_str().unwrap();
        assert!(text.contains("What if the gate remembers?"), "{text}");
        assert!(text.contains("From Claude Code"), "{text}");
        assert!(call(&engine, "c", "add_idea", &json!({ "text": "  " }), false).is_err());
    }

    /// Nobody approves an idea before it lands, so a tool cannot bury the writer in them.
    #[test]
    fn a_tool_cannot_flood_the_inbox() {
        let (engine, _dir, _id) = project();
        let long = "word ".repeat(MAX_IDEA_CHARS);
        let refused = call(&engine, "c", "add_idea", &json!({ "text": long }), false).unwrap_err();
        assert_eq!(refused.code, "INVALID");
        engine
            .write(|tx| {
                for n in 0..MAX_PENDING {
                    tx.execute(
                        "INSERT INTO ideas (id, text, status, created_at, updated_at) VALUES (?1, ?2, 'open', 'now', 'now')",
                        params![db::new_id(), format!("Idea {n}\n\n(From c)")],
                    )?;
                }
                // The writer's own ideas do not count against a tool.
                tx.execute(
                    "INSERT INTO ideas (id, text, status, created_at, updated_at) VALUES (?1, 'Mine', 'open', 'now', 'now')",
                    [db::new_id()],
                )?;
                Ok(())
            })
            .unwrap();
        let refused = call(&engine, "c", "add_idea", &json!({ "text": "One more" }), false).unwrap_err();
        assert_eq!(refused.code, "TOO_MANY");
        engine
            .write(|tx| {
                tx.execute("UPDATE ideas SET status = 'done' WHERE text LIKE 'Idea 1%'", [])?;
                Ok(())
            })
            .unwrap();
        assert!(call(&engine, "c", "add_idea", &json!({ "text": "One more" }), false).is_ok());
    }

    #[test]
    fn a_project_from_before_the_table_still_works() {
        let (engine, _dir, _id) = project();
        engine
            .write(|tx| {
                tx.execute_batch("DROP TABLE proposals")?;
                Ok(())
            })
            .unwrap();
        assert_eq!(engine.read(pending_count).unwrap(), 0);
        assert!(engine.read(|c| list(c, STATUS_PENDING)).unwrap().is_empty());
        call(
            &engine,
            "c",
            "propose_new_page",
            &json!({ "title": "The Gate", "body": "x" }),
            false,
        )
        .unwrap();
        assert_eq!(engine.read(pending_count).unwrap(), 1);
    }

    // -----------------------------------------------------------------------
    // Writing in the book
    // -----------------------------------------------------------------------

    struct Book {
        engine: Arc<Engine>,
        _dir: crate::engine::TestDir,
        scene: String,
        chapter: String,
    }

    fn paragraphs(texts: &[&str]) -> Value {
        json!({ "type": "doc", "content": texts.iter().map(|t| json!({ "type": "paragraph", "content": [{ "type": "text", "text": t }] })).collect::<Vec<_>>() })
    }

    fn book(texts: &[&str]) -> Book {
        let (engine, dir, _page) = project();
        rpc(&engine, "pages.create", json!({ "title": "Bren" }));
        rpc(&engine, "pages.create", json!({ "title": "The Keep" }));
        let books = rpc(&engine, "books.list", json!({}));
        let tree = rpc(&engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        let nodes = tree.as_array().unwrap();
        let scene = nodes.iter().find(|n| n["kind"] == "scene").unwrap();
        let scene_id = scene["id"].as_str().unwrap().to_string();
        let chapter = scene["parentId"].as_str().unwrap().to_string();
        let content = if texts.is_empty() { json!({ "type": "doc", "content": [{ "type": "paragraph" }] }) } else { paragraphs(texts) };
        rpc(&engine, "nodes.update", json!({ "id": scene_id, "patch": { "title": "At the gate", "content": content } }));
        Book { engine, _dir: dir, scene: scene_id, chapter }
    }

    fn hide(engine: &Engine, id: &str) {
        engine
            .write(|tx| {
                tx.execute("UPDATE nodes SET local_only = 1 WHERE id = ?1", [id])?;
                Ok(())
            })
            .unwrap();
    }

    fn last(engine: &Engine) -> Value {
        engine.read(|c| list(c, STATUS_PENDING)).unwrap().pop().unwrap()
    }

    const SCENE: [&str; 4] = [
        "Rain fell on the old gate.",
        "Aria waited by the river until dusk.",
        "Bren came late \u{2014} as always.",
        "The gate is old. The gate is old.",
    ];

    #[test]
    fn an_insert_goes_at_an_end_or_beside_a_quote() {
        let b = book(&SCENE);
        let at_end = json!({ "id": b.scene, "at": "end", "text": "Night came.\n\nThen morning." });
        assert!(call(&b.engine, "c", "propose_insert", &at_end, false).unwrap().contains("Nothing has changed yet"));
        let p = last(&b.engine);
        assert_eq!(p["kind"], "insert");
        assert_eq!(p["targetKind"], "node");
        assert_eq!(p["payload"]["at"], "end");
        // A dash typed as two hyphens still finds the em dash.
        let after = json!({ "id": b.scene, "after_quote": "came late -- as always.", "text": "He shrugged." });
        call(&b.engine, "c", "propose_insert", &after, false).unwrap();
        assert_eq!(last(&b.engine)["payload"]["at"], "after");
        let both = json!({ "id": b.scene, "at": "start", "after_quote": "Rain", "text": "x" });
        assert_eq!(call(&b.engine, "c", "propose_insert", &both, false).unwrap_err().code, "INVALID");
    }

    #[test]
    fn an_insert_works_on_an_empty_scene() {
        let b = book(&[]);
        call(&b.engine, "c", "propose_insert", &json!({ "id": b.scene, "at": "start", "text": "It begins." }), false).unwrap();
        let missing = call(&b.engine, "c", "propose_insert", &json!({ "id": b.scene, "after_quote": "anything", "text": "x" }), false).unwrap_err();
        assert_eq!(missing.code, "QUOTE_NOT_FOUND");
    }

    #[test]
    fn an_insert_anchor_must_exist_and_be_unique() {
        let b = book(&SCENE);
        let missing = call(&b.engine, "c", "propose_insert", &json!({ "id": b.scene, "after_quote": "Aria waited at the river till dusk.", "text": "x" }), false).unwrap_err();
        assert_eq!(missing.code, "QUOTE_NOT_FOUND");
        assert!(missing.message.contains("closest passage is: \"Aria waited by the river"), "{}", missing.message);
        let repeated = call(&b.engine, "c", "propose_insert", &json!({ "id": b.scene, "before_quote": "The gate is old.", "text": "x" }), false).unwrap_err();
        assert_eq!(repeated.code, "QUOTE_NOT_UNIQUE");
        assert_eq!(b.engine.read(pending_count).unwrap(), 0);
    }

    #[test]
    fn a_range_rewrite_needs_both_anchors_in_order() {
        let b = book(&SCENE);
        let args = json!({ "id": b.scene, "from_quote": "Aria waited", "to_quote": "as always.", "replacement": "Aria left early.\n\nBren never came." });
        call(&b.engine, "c", "propose_rewrite", &args, false).unwrap();
        let p = last(&b.engine);
        assert_eq!(p["kind"], "rewrite");
        assert_eq!(p["payload"]["mode"], "range");
        assert_eq!(p["payload"]["original"], "Aria waited by the river until dusk.\n\nBren came late \u{2014} as always.");
        // The end must come after the start.
        let backwards = json!({ "id": b.scene, "from_quote": "Bren came", "to_quote": "Rain fell", "replacement": "x" });
        let err = call(&b.engine, "c", "propose_rewrite", &backwards, false).unwrap_err();
        assert_eq!(err.code, "QUOTE_NOT_FOUND");
        assert!(err.message.contains("to_quote"), "{}", err.message);
        let ambiguous = json!({ "id": b.scene, "from_quote": "The gate is old.", "to_quote": "old.", "replacement": "x" });
        assert_eq!(call(&b.engine, "c", "propose_rewrite", &ambiguous, false).unwrap_err().code, "QUOTE_NOT_UNIQUE");
        // A closing anchor that repeats is fine when only one comes after the start.
        let after_start = json!({ "id": b.scene, "from_quote": "Bren came", "to_quote": "old gate", "replacement": "x" });
        assert_eq!(call(&b.engine, "c", "propose_rewrite", &after_start, false).unwrap_err().code, "QUOTE_NOT_FOUND");
        // propose_edit takes the same anchors.
        let through_edit = json!({ "target": "scene", "id": b.scene, "from_quote": "*Rain* fell", "to_quote": "until dusk.", "replacement": "Snow." });
        call(&b.engine, "c", "propose_edit", &through_edit, false).unwrap();
        assert_eq!(last(&b.engine)["kind"], "rewrite");
    }

    #[test]
    fn a_whole_rewrite_keeps_what_it_replaces() {
        let b = book(&SCENE);
        let words = "word ".repeat(10_000);
        call(&b.engine, "c", "propose_rewrite", &json!({ "id": b.scene, "whole": true, "replacement": words }), false).unwrap();
        let p = last(&b.engine);
        assert_eq!(p["payload"]["mode"], "whole");
        assert!(p["payload"]["original"].as_str().unwrap().starts_with("Rain fell"));
        let same = json!({ "id": b.scene, "whole": true, "replacement": SCENE.join("\n\n") });
        assert_eq!(call(&b.engine, "c", "propose_rewrite", &same, false).unwrap_err().code, "INVALID");
    }

    #[test]
    fn writing_in_a_local_only_scene_is_refused() {
        let b = book(&SCENE);
        hide(&b.engine, &b.chapter);
        let tries = [
            ("propose_insert", json!({ "id": b.scene, "at": "end", "text": "x" })),
            ("propose_rewrite", json!({ "id": b.scene, "whole": true, "replacement": "x" })),
            ("propose_scene_details", json!({ "id": b.scene, "synopsis": "x" })),
            ("propose_new_scene", json!({ "title": "x", "after": b.scene })),
            ("propose_new_scene", json!({ "title": "x", "chapter": b.chapter })),
            ("propose_new_chapter", json!({ "title": "x", "after": b.chapter })),
        ];
        for (tool, args) in &tries {
            assert_eq!(call(&b.engine, "c", tool, args, false).unwrap_err().code, "NOT_FOUND", "{tool}");
        }
        // The book has no other chapter for a new scene to go in.
        assert_eq!(call(&b.engine, "c", "propose_new_scene", &json!({ "title": "x" }), false).unwrap_err().code, "NOT_FOUND");
        assert_eq!(b.engine.read(pending_count).unwrap(), 0);
        assert!(call(&b.engine, "c", "propose_insert", &tries[0].1, true).is_ok());
    }

    #[test]
    fn a_new_scene_finds_its_place_and_people() {
        let b = book(&SCENE);
        let args = json!({ "title": "The river", "after": "At the gate", "text": "Water.", "pov": "aria", "location": "The Keep", "cast": ["Bren", "Aria"] });
        call(&b.engine, "c", "propose_new_scene", &args, false).unwrap();
        let p = last(&b.engine);
        assert_eq!(p["kind"], "newScene");
        assert_eq!(p["payload"]["chapterId"], Value::String(b.chapter.clone()));
        assert_eq!(p["payload"]["afterId"], Value::String(b.scene.clone()));
        assert_eq!(p["payload"]["pov"]["title"], "Aria");
        assert_eq!(p["payload"]["cast"][0]["title"], "Bren");
        // With nothing said, it goes at the end of the book's last chapter.
        call(&b.engine, "c", "propose_new_scene", &json!({ "title": "Coda" }), false).unwrap();
        let p = last(&b.engine);
        assert_eq!(p["payload"]["chapterId"], Value::String(b.chapter.clone()));
        assert!(p["payload"].get("afterId").is_none());
        let unknown = call(&b.engine, "c", "propose_new_scene", &json!({ "title": "x", "pov": "Nobody" }), false).unwrap_err();
        assert_eq!(unknown.code, "NOT_FOUND");
        let no_place = call(&b.engine, "c", "propose_new_scene", &json!({ "title": "x", "after": "No such scene" }), false).unwrap_err();
        assert_eq!(no_place.code, "NOT_FOUND");
        assert_eq!(call(&b.engine, "c", "propose_new_scene", &json!({ "title": " " }), false).unwrap_err().code, "INVALID");
    }

    #[test]
    fn a_new_chapter_carries_its_first_scene() {
        let b = book(&SCENE);
        let args = json!({ "title": "Two", "after": b.chapter, "text": "It went on.", "scene_title": "Morning", "cast": ["Bren"] });
        assert!(call(&b.engine, "c", "propose_new_chapter", &args, false).unwrap().contains("new chapter \"Two\""));
        let p = last(&b.engine);
        assert_eq!(p["kind"], "newChapter");
        assert_eq!(p["targetKind"], "book");
        assert_eq!(p["payload"]["afterId"], Value::String(b.chapter.clone()));
        assert_eq!(p["payload"]["scene"]["title"], "Morning");
        assert_eq!(p["payload"]["scene"]["text"], "It went on.");
        call(&b.engine, "c", "propose_new_chapter", &json!({ "title": "Three" }), false).unwrap();
        assert_eq!(last(&b.engine)["payload"]["scene"]["title"], "Three");
        let wrong_book = call(&b.engine, "c", "propose_new_chapter", &json!({ "title": "x", "book": "Nope" }), false).unwrap_err();
        assert_eq!(wrong_book.code, "NOT_FOUND");
    }

    #[test]
    fn scene_details_list_only_what_changes() {
        let b = book(&SCENE);
        let args = json!({ "id": b.scene, "synopsis": "Aria waits.", "pov": "Aria", "cast": ["Bren"], "status": "revised", "story_date": "Spring 412", "notes": "Check the tides.", "new_title": "The wait" });
        call(&b.engine, "c", "propose_scene_details", &args, false).unwrap();
        let p = last(&b.engine);
        assert_eq!(p["kind"], "sceneDetails");
        let changes = &p["payload"]["changes"];
        assert_eq!(changes["synopsis"], "Aria waits.");
        assert_eq!(changes["pov"]["title"], "Aria");
        assert_eq!(changes["cast"][0]["title"], "Bren");
        assert_eq!(changes["status"], "revised");
        assert_eq!(changes["storyDate"], "Spring 412");
        assert_eq!(changes["title"], "The wait");
        assert_eq!(p["payload"]["before"]["title"], "At the gate");
        // Nothing to change, a bad status, or an unknown page are refused.
        let same = json!({ "id": b.scene, "new_title": "At the gate", "pov": "" });
        assert_eq!(call(&b.engine, "c", "propose_scene_details", &same, false).unwrap_err().code, "INVALID");
        let bad = json!({ "id": b.scene, "status": "done" });
        assert_eq!(call(&b.engine, "c", "propose_scene_details", &bad, false).unwrap_err().code, "INVALID");
        let unknown = json!({ "id": b.scene, "location": "Atlantis" });
        assert_eq!(call(&b.engine, "c", "propose_scene_details", &unknown, false).unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn a_missing_quote_names_the_closest_passage() {
        let b = book(&SCENE);
        let args = json!({ "target": "scene", "id": b.scene, "quote": "Aria waited near the river until dusk", "replacement": "x" });
        let err = call(&b.engine, "c", "propose_edit", &args, false).unwrap_err();
        assert_eq!(err.code, "QUOTE_NOT_FOUND");
        assert!(err.message.contains("is not in \"At the gate\""), "{}", err.message);
        assert!(err.message.contains("Aria waited by the river until dusk."), "{}", err.message);
        // Forgiving matching: curly quotes, dashes and emphasis markers.
        let loose = json!({ "target": "scene", "id": b.scene, "quote": "Bren came *late* - as always", "replacement": "Bren came early" });
        call(&b.engine, "c", "propose_edit", &loose, false).unwrap();
    }
}
