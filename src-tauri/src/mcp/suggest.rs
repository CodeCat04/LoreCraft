//! Suggestions from outside tools. Nothing here touches a document: a suggestion is one
//! row in `proposals`, and the writer accepts or rejects it in the app. Accepting runs in
//! `src/mcp/apply.ts`, where the editor's schema and Markdown parser live.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::text::{cut, doc_to_text, normalize_quote};
use super::tools::{resolve_page, resolve_scene_id, Ctx};
use crate::content::title_key;
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::rpc::{manuscript, pages};

pub const STATUS_PENDING: &str = "pending";
pub const NEEDS_APP: &str = "Suggestions need LoreCraft to be open with this project, so the writer can review them. Open it there and try again. Reading works from the last saved file in the meantime.";
pub const READ_ONLY: &str = "The writer has set outside tools to read only, so suggestions are turned off. They can allow them in LoreCraft under Settings, AI tools (MCP).";

/// A client that keeps proposing should not bury the writer.
const MAX_PENDING: i64 = 500;
const MAX_TEXT: usize = 500_000;
const MAX_LABEL: usize = 200;
/// An idea is a note, not a chapter.
const MAX_IDEA_CHARS: usize = 4000;

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

pub fn list(conn: &Connection, status: &str) -> AppResult<Vec<Value>> {
    if !has_table(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT id, client, kind, target_kind, target_id, title, payload, status, created_at
         FROM proposals WHERE status = ?1 ORDER BY created_at, id",
    )?;
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

/// Marks a suggestion as dealt with. Returns false if it already was.
pub fn resolve(conn: &Connection, id: &str, status: &str) -> AppResult<bool> {
    if !matches!(status, "accepted" | "rejected") {
        return Err(AppError::invalid("A suggestion is accepted or rejected."));
    }
    if !has_table(conn)? {
        return Err(AppError::not_found("That suggestion"));
    }
    let changed = conn.execute(
        "UPDATE proposals SET status = ?1 WHERE id = ?2 AND status = ?3",
        params![status, id, STATUS_PENDING],
    )?;
    Ok(changed > 0)
}

fn required<'a>(args: &'a Value, name: &str) -> AppResult<&'a str> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::invalid(format!("{name} is required.")))
}

fn optional<'a>(args: &'a Value, name: &str) -> &'a str {
    args.get(name).and_then(Value::as_str).unwrap_or("").trim()
}

fn check_size(name: &str, text: &str) -> AppResult<()> {
    if text.len() > MAX_TEXT {
        return Err(AppError::invalid(format!(
            "{name} is too long. Suggest a smaller change."
        )));
    }
    Ok(())
}

fn string_list(args: &Value, name: &str) -> Vec<String> {
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

struct Row {
    kind: &'static str,
    target_kind: Option<String>,
    target_id: Option<String>,
    title: String,
    payload: Value,
}

fn insert(engine: &Engine, client: &str, row: Row) -> AppResult<String> {
    let id = db::new_id();
    engine.write(|tx| {
        tx.execute_batch(TABLE)?;
        if pending_count(tx)? >= MAX_PENDING {
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
                row.kind,
                row.target_kind,
                row.target_id,
                row.title,
                row.payload.to_string(),
                STATUS_PENDING,
                db::now(),
            ],
        )?;
        Ok(())
    })?;
    engine.notify("proposals");
    Ok(id)
}

fn propose_edit(engine: &Engine, client: &str, args: &Value, share: bool) -> AppResult<String> {
    let quote = required(args, "quote")?;
    let replacement = required(args, "replacement")?;
    check_size("The quote", quote)?;
    check_size("The replacement", replacement)?;
    let needle = normalize_quote(quote);
    if needle.is_empty() {
        return Err(AppError::invalid("The quote is empty. Copy the text to replace."));
    }
    if needle == normalize_quote(replacement) {
        return Err(AppError::invalid("The replacement is the same as the quote."));
    }
    let target = required(args, "target")?;
    let (kind, id, title, text) = engine.read(|conn| {
        let ctx = Ctx::new(conn, String::new(), true, share)?;
        match target {
            "page" => {
                let id = resolve_page(&ctx, args)?;
                let page = pages::get_page(conn, &id)?;
                Ok(("page", id, page.meta.title.clone(), doc_to_text(&page.content)))
            }
            "scene" | "node" => {
                let (id, title) = resolve_scene_id(&ctx, args)?;
                let node = manuscript::get_node(conn, &id)?;
                Ok(("node", id, title, doc_to_text(&node.content)))
            }
            other => Err(AppError::invalid(format!(
                "target must be page or scene, not {other}."
            ))),
        }
    })?;
    let read_with = if kind == "page" { "get_page" } else { "get_scene" };
    match normalize_quote(&text).matches(&needle).count() {
        0 => {
            return Err(AppError::new(
                "QUOTE_NOT_FOUND",
                format!(
                    "That quote is not in \"{title}\". Read the current text with {read_with} and copy it exactly."
                ),
            ))
        }
        1 => {}
        n => {
            return Err(AppError::new(
                "QUOTE_NOT_UNIQUE",
                format!(
                    "That text appears {n} times in \"{title}\". Quote more of the words around it so it is unique."
                ),
            ))
        }
    }
    let proposal = insert(
        engine,
        client,
        Row {
            kind: "edit",
            target_kind: Some(kind.to_string()),
            target_id: Some(id),
            title: title.clone(),
            payload: json!({
                "quote": quote,
                "replacement": replacement,
                "reason": cut(optional(args, "reason"), 2000),
            }),
        },
    )?;
    Ok(format!(
        "Suggested a change to \"{title}\" (suggestion {proposal}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
    ))
}

/// Accepts an object of label to text, or an array of `{ label, value }`.
fn infobox_fields(args: &Value) -> Vec<Value> {
    let clean = |label: &str, value: &str| -> Option<Value> {
        let label = cut(label.trim(), MAX_LABEL);
        let value = cut(value.trim(), 4000);
        (!label.is_empty() && !value.is_empty()).then(|| json!({ "label": label, "value": value }))
    };
    match args.get("infobox") {
        Some(Value::Object(map)) => map
            .iter()
            .filter_map(|(label, value)| clean(label, value.as_str()?))
            .collect(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                clean(item.get("label")?.as_str()?, item.get("value")?.as_str()?)
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn propose_new_page(engine: &Engine, client: &str, args: &Value) -> AppResult<String> {
    let title = required(args, "title")?.split_whitespace().collect::<Vec<_>>().join(" ");
    if title_key(&title).is_empty() {
        return Err(AppError::invalid("The page needs a title."));
    }
    if title.len() > MAX_LABEL {
        return Err(AppError::invalid("That title is too long."));
    }
    let body = required(args, "body")?;
    check_size("The body", body)?;
    let existing = engine.read(|conn| pages::resolve_title(conn, &title))?;
    if existing.is_some() {
        // A hidden page gets the same answer, since the title cannot be used either way.
        return Err(AppError::new(
            "TITLE_TAKEN",
            format!(
                "A page called \"{title}\" already exists, or that name is an alias of one. Use propose_edit to change it, or choose another title."
            ),
        ));
    }
    let page_type = cut(optional(args, "type"), MAX_LABEL);
    let mut payload = Map::new();
    payload.insert("title".into(), json!(title));
    payload.insert(
        "pageType".into(),
        json!(if page_type.is_empty() { "article" } else { page_type }),
    );
    payload.insert("body".into(), json!(body));
    payload.insert("summary".into(), json!(cut(optional(args, "summary"), 2000)));
    payload.insert("infobox".into(), Value::Array(infobox_fields(args)));
    payload.insert("aliases".into(), json!(string_list(args, "aliases")));
    payload.insert("categories".into(), json!(string_list(args, "categories")));
    payload.insert("reason".into(), json!(cut(optional(args, "reason"), 2000)));
    let proposal = insert(
        engine,
        client,
        Row {
            kind: "newPage",
            target_kind: None,
            target_id: None,
            title: title.clone(),
            payload: Value::Object(payload),
        },
    )?;
    Ok(format!(
        "Suggested a new page \"{title}\" (suggestion {proposal}). It does not exist yet: the writer reviews it in LoreCraft under Outside suggestions, and it starts as a draft."
    ))
}

/// An idea goes straight to the inbox, which is the writer's own list to review. It names
/// the tool it came from, so the writer knows it was not theirs. Since nobody approves it
/// first, a tool can add only short ones, and only so many while they wait.
fn add_idea(engine: &Engine, client: &str, args: &Value) -> AppResult<String> {
    let text = required(args, "text")?.trim();
    if text.is_empty() {
        return Err(AppError::invalid("The idea is empty."));
    }
    if text.chars().count() > MAX_IDEA_CHARS {
        return Err(AppError::invalid(
            "That is too long for an idea. Keep it to a short note, or suggest a page with propose_new_page.",
        ));
    }
    let waiting: i64 = engine.read(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM ideas WHERE status = 'open' AND text LIKE '%' || char(10) || '(From %)'",
            [],
            |r| r.get(0),
        )?)
    })?;
    if waiting >= MAX_PENDING {
        return Err(AppError::new(
            "TOO_MANY",
            "Too many ideas from outside tools are waiting in the writer's inbox. Ask them to go through those first.",
        ));
    }
    crate::rpc::ideas::handle(
        engine,
        "add",
        json!({ "text": format!("{text}\n\n(From {})", cut(client, MAX_LABEL)) }),
    )?;
    Ok("Added to the writer's idea inbox.".to_string())
}

pub fn call(
    engine: &Engine,
    client: &str,
    name: &str,
    args: &Value,
    share: bool,
) -> AppResult<String> {
    match name {
        "propose_edit" => propose_edit(engine, client, args, share),
        "propose_new_page" => propose_new_page(engine, client, args),
        "add_idea" => add_idea(engine, client, args),
        _ => Err(AppError::invalid(format!("There is no tool named {name}."))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::call as rpc;
    use std::sync::Arc;

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
}
