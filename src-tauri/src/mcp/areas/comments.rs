//! Comments on pages and scenes: reading them, adding one on a quoted passage, and marking
//! one resolved or open again.
//!
//! A comment's words live in the `comments` table, and its place is a `comment` mark in the
//! document (see `crate::rpc::comments`). The app adds and removes both with its own
//! comment code (`src/notes/api.ts`), so the mark appears in an open editor. The app has no
//! replies, so there is no reply tool.

use std::collections::HashMap;

use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use super::{read, write, Tool};
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{check_size, optional, reason, required};
use crate::mcp::text::{closest_passage, cut, doc_to_text, find_all, needle_for, normalize_with_map};
use crate::mcp::tools::{resolve_page, resolve_scene_id, Ctx};
use crate::mcp::write::{Draft, WriteCx};
use crate::rpc::{manuscript, pages};

/// As `MAX_BODY_CHARS` in `rpc::comments`.
const MAX_BODY: usize = 20_000;

fn target_schema() -> Value {
    json!({ "type": "string", "enum": ["page", "scene"], "description": "A wiki page or a scene. Default page." })
}

pub fn tools() -> Vec<Tool> {
    vec![
        read(
            "list_comments",
            "The comments on a wiki page or a scene: each one's id, author, words, the passage it is on, and whether it is resolved or a to-do. Changes nothing.",
            json!({ "type": "object", "properties": {
                "target": target_schema(),
                "id": { "type": "string", "description": "The page or scene id. Used instead of the title." },
                "title": { "type": "string", "description": "The page or scene title." },
            } }),
            list_comments,
        ),
        write(
            "add_comment",
            "Add a comment to a wiki page or scene, on a quoted passage. It changes no text: the passage is marked, and the comment shows in the margin. Quote a few exact words, as get_page or get_scene shows them. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "target": target_schema(),
                "id": { "type": "string", "description": "The page or scene id. Used instead of the title." },
                "title": { "type": "string", "description": "The page or scene title." },
                "quote": { "type": "string", "description": "The words to comment on, copied exactly." },
                "text": { "type": "string", "description": "The comment." },
                "todo": { "type": "boolean", "description": "True to make it a to-do the writer can tick." },
            }, "required": ["quote", "text"] }),
            add_comment,
        ),
        write(
            "resolve_comment",
            "Mark a comment resolved, or open again with resolved: false. It changes no text. Get the id from list_comments. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "comment_id": { "type": "string", "description": "The comment's id, from list_comments." },
                "resolved": { "type": "boolean", "description": "True (default) to resolve it, false to open it again." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["comment_id"] }),
            resolve_comment,
        ),
    ]
}

/// The page or scene named, as `(kind, id, title, document)`. Hidden ones do not exist.
fn target(ctx: &Ctx, args: &Value) -> AppResult<(&'static str, String, String, Value)> {
    match optional(args, "target") {
        "" | "page" => {
            let id = resolve_page(ctx, args)?;
            let page = pages::get_page(ctx.conn, &id)?;
            Ok(("page", id, page.meta.title.clone(), page.content))
        }
        "scene" | "node" => {
            let (id, title) = resolve_scene_id(ctx, args)?;
            let node = manuscript::get_node(ctx.conn, &id)?;
            Ok(("node", id, title, node.content))
        }
        other => Err(AppError::invalid(format!("target must be page or scene, not {other}."))),
    }
}

/// Comment id -> the words its mark covers now.
fn marked_text(doc: &Value, out: &mut HashMap<String, String>) {
    if let Some(marks) = doc.get("marks").and_then(Value::as_array) {
        for mark in marks.iter().filter(|m| m["type"] == "comment") {
            if let Some(id) = mark.pointer("/attrs/id").and_then(Value::as_str) {
                out.entry(id.to_string()).or_default().push_str(doc["text"].as_str().unwrap_or(""));
            }
        }
    }
    for child in doc.get("content").and_then(Value::as_array).into_iter().flatten() {
        marked_text(child, out);
    }
}

fn yes(args: &Value, name: &str, default: bool) -> bool {
    match args.get(name) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" => true,
            "false" | "no" => false,
            _ => default,
        },
        _ => default,
    }
}

fn list_comments(ctx: &Ctx, args: &Value) -> AppResult<String> {
    let (kind, id, title, doc) = target(ctx, args)?;
    let mut stmt = ctx.conn.prepare(
        "SELECT id, author, body, quote, is_todo, done, resolved, created_at FROM comments
          WHERE source_kind = ?1 AND source_id = ?2 ORDER BY created_at, id",
    )?;
    let rows: Vec<(String, String, String, String, bool, bool, bool, String)> = stmt
        .query_map([kind, id.as_str()], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get::<_, i64>(4)? != 0,
                r.get::<_, i64>(5)? != 0,
                r.get::<_, i64>(6)? != 0,
                r.get(7)?,
            ))
        })?
        .collect::<Result<_, _>>()?;
    let what = if kind == "page" { "page" } else { "scene" };
    if rows.is_empty() {
        return Ok(format!("The {what} \"{title}\" has no comments."));
    }
    let mut marked = HashMap::new();
    marked_text(&doc, &mut marked);
    let mut out = format!("# Comments on the {what} \"{title}\" ({})\n", rows.len());
    for (cid, author, body, quote, is_todo, done, resolved, created) in rows {
        let author = match author.as_str() {
            "you" => "the writer".to_string(),
            "ai" => "LoreCraft's AI".to_string(),
            other => other.to_string(),
        };
        let mut state = Vec::new();
        if resolved {
            state.push("resolved");
        } else {
            state.push("open");
        }
        if is_todo {
            state.push(if done { "to-do, done" } else { "to-do" });
        }
        let on = match marked.get(&cid) {
            Some(text) if !text.trim().is_empty() => format!("On: \"{}\"", cut(text.trim(), 300)),
            _ if !quote.trim().is_empty() => format!("Was on: \"{}\" (that text has gone)", cut(quote.trim(), 300)),
            _ => "On the whole document".to_string(),
        };
        out.push_str(&format!(
            "\n## Comment {cid}\nBy {author}, {}. {}.\n{on}\n{}\n",
            created.get(..10).unwrap_or(&created),
            state.join(", "),
            body.trim()
        ));
    }
    Ok(out)
}

fn add_comment(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let quote = required(args, "quote")?.trim().to_string();
    let body = required(args, "text")?.trim().to_string();
    check_size("The quote", &quote)?;
    if body.is_empty() {
        return Err(AppError::invalid("The comment is empty."));
    }
    if body.chars().count() > MAX_BODY {
        return Err(AppError::invalid("That comment is too long."));
    }
    let (kind, id, title, doc) = cx.read(|ctx| target(ctx, args))?;
    let text = doc_to_text(&doc);
    let hay = normalize_with_map(&text);
    let needle = needle_for(&quote, &hay.text);
    if needle.is_empty() {
        return Err(AppError::invalid("The quote is empty. Copy a few words of the text."));
    }
    if find_all(&hay.text, &needle).is_empty() {
        let hint = closest_passage(&text, &quote)
            .map(|p| format!(" The closest passage is: \"{p}\"."))
            .unwrap_or_default();
        let read = if kind == "page" { "get_page" } else { "get_scene" };
        return Err(AppError::new(
            "QUOTE_NOT_FOUND",
            format!("That quote is not in \"{title}\".{hint} Read the current text with {read} and copy it exactly."),
        ));
    }
    let payload = json!({
        "sourceKind": kind,
        "sourceId": id,
        "quote": quote,
        "body": body,
        "isTodo": yes(args, "todo", false),
        "reason": reason(args),
    });
    Ok(Draft::new("addComment", title.clone(), payload)
        .target(kind, id)
        .suggested(format!(
            "Suggested a comment on \"{title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("added a comment on \"{title}\".")))
}

fn resolve_comment(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let comment_id = required(args, "comment_id")?.trim().to_string();
    let resolved = yes(args, "resolved", true);
    let (kind, source_id, before, title) = cx.read(|ctx| {
        let found: Option<(String, String, bool)> = ctx
            .conn
            .query_row(
                "SELECT source_kind, source_id, resolved FROM comments WHERE id = ?1",
                [&comment_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
            )
            .optional()?;
        let missing = || AppError::not_found(format!("A comment with id {comment_id}"));
        let (kind, source_id, before) = found.ok_or_else(missing)?;
        // A comment on something hidden is hidden too, and so is one in the trash.
        let hidden = if kind == "page" { ctx.page_hidden(&source_id) } else { ctx.node_hidden(&source_id) };
        let sql = if kind == "page" {
            "SELECT title FROM pages WHERE id = ?1 AND deleted_at IS NULL"
        } else {
            "SELECT title FROM nodes WHERE id = ?1 AND deleted_at IS NULL"
        };
        let title: Option<String> = ctx.conn.query_row(sql, [&source_id], |r| r.get(0)).optional()?;
        match title {
            Some(title) if !hidden => Ok((kind, source_id, before, title)),
            _ => Err(missing()),
        }
    })?;
    if before == resolved {
        return Err(AppError::invalid(if resolved {
            "That comment is already resolved."
        } else {
            "That comment is already open."
        }));
    }
    let payload = json!({
        "commentId": comment_id,
        "resolved": resolved,
        "before": before,
        "reason": reason(args),
    });
    let (verb, done) = if resolved { ("resolve", "resolved") } else { ("reopen", "opened again") };
    Ok(Draft::new("resolveComment", title.clone(), payload)
        .target(kind.as_str(), source_id)
        .suggested(format!(
            "Suggested to {verb} a comment on \"{title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("{done} a comment on \"{title}\".")))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{json, Map, Value};

    use crate::engine::Engine;
    use crate::mcp::config::PERMISSION_EDIT;
    use crate::mcp::suggest::{self, call, call_as, STATUS_APPLIED, STATUS_APPLYING, STATUS_AUTO, STATUS_PENDING};
    use crate::mcp::tools::Ctx;
    use crate::mcp::write::Waits;
    use crate::rpc::call as rpc;

    fn project() -> (Arc<Engine>, crate::engine::TestDir, String, String) {
        let (engine, _host, dir) = Engine::for_test();
        rpc(&engine, "project.new", json!({ "name": "Ashfall" }));
        let page = rpc(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "content": { "type": "doc", "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "She said \u{201C}no\u{201D} twice. The gate is old." }] },
            ]}}),
        )["id"]
            .as_str()
            .unwrap()
            .to_string();
        let books = rpc(&engine, "books.list", json!({}));
        let tree = rpc(&engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        rpc(
            &engine,
            "nodes.update",
            json!({ "id": scene, "patch": { "title": "At the gate", "content": { "type": "doc", "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "Rain fell on the old gate." }] },
            ]} } }),
        );
        (engine, dir, page, scene)
    }

    fn pending(engine: &Engine) -> Vec<Value> {
        engine.read(|c| suggest::list(c, STATUS_PENDING)).unwrap()
    }

    fn read_tool(engine: &Engine, args: Value, share: bool) -> crate::error::AppResult<String> {
        engine.read(|conn| {
            let ctx = Ctx::new(conn, "Ashfall".into(), true, share)?;
            crate::mcp::tools::call(&ctx, "list_comments", &args)
        })
    }

    fn hide(engine: &Engine, table: &str, id: &str) {
        engine
            .write(|tx| {
                tx.execute(&format!("UPDATE {table} SET local_only = 1 WHERE id = ?1"), [id])?;
                Ok(())
            })
            .unwrap();
    }

    fn comment(engine: &Engine, kind: &str, id: &str) -> String {
        rpc(engine, "comments.add", json!({ "sourceKind": kind, "sourceId": id, "body": "Check this.", "quote": "old" }))["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn quick() -> Waits {
        Waits { claim: Duration::from_millis(600), apply: Duration::from_millis(1500), poll: Duration::from_millis(20) }
    }

    /// Plays the app's window: picks up the change and marks it applied.
    fn window(engine: &Arc<Engine>) -> std::thread::JoinHandle<()> {
        let engine = engine.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(15));
                let waiting = engine.read(|c| suggest::list(c, STATUS_AUTO)).unwrap();
                if let Some(row) = waiting.first() {
                    let id = row["id"].as_str().unwrap().to_string();
                    assert!(engine.write(|tx| suggest::resolve(tx, &id, STATUS_APPLYING)).unwrap());
                    let mut extra = Map::new();
                    extra.insert("undo".into(), json!({ "commentId": "c1", "updatedAt": "u1" }));
                    assert!(engine.write(|tx| suggest::resolve_with(tx, &id, STATUS_APPLIED, &extra)).unwrap());
                    return;
                }
            }
        })
    }

    #[test]
    fn list_comments_shows_each_with_its_passage_and_state() {
        let (engine, _dir, page, scene) = project();
        assert!(read_tool(&engine, json!({ "title": "Aria" }), false).unwrap().contains("no comments"));
        let id = comment(&engine, "page", &page);
        rpc(&engine, "comments.update", json!({ "id": id, "patch": { "resolved": true } }));
        let text = read_tool(&engine, json!({ "title": "Aria" }), false).unwrap();
        assert!(text.contains(&id) && text.contains("Check this.") && text.contains("resolved"), "{text}");
        comment(&engine, "node", &scene);
        let text = read_tool(&engine, json!({ "target": "scene", "title": "At the gate" }), false).unwrap();
        assert!(text.contains("Comments on the scene \"At the gate\" (1)"), "{text}");
        // Missing and hidden targets do not exist.
        assert_eq!(read_tool(&engine, json!({ "title": "Nobody" }), false).unwrap_err().code, "NOT_FOUND");
        hide(&engine, "pages", &page);
        assert_eq!(read_tool(&engine, json!({ "title": "Aria" }), false).unwrap_err().code, "NOT_FOUND");
        assert!(read_tool(&engine, json!({ "title": "Aria" }), true).is_ok());
    }

    #[test]
    fn add_comment_is_suggested_on_a_quote_that_exists() {
        let (engine, _dir, page, scene) = project();
        let args = json!({ "title": "Aria", "quote": "said \"no\" twice", "text": "Too abrupt?" });
        let said = call(&engine, "Claude Code", "add_comment", &args, false).unwrap();
        assert!(said.contains("Nothing has changed yet"), "{said}");
        let rows = pending(&engine);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["kind"], "addComment");
        assert_eq!(rows[0]["targetKind"], "page");
        assert_eq!(rows[0]["targetId"], page.as_str());
        assert_eq!(rows[0]["payload"]["body"], "Too abrupt?");
        assert_eq!(rows[0]["payload"]["sourceKind"], "page");
        // Nothing is stored until the app applies it.
        assert!(rpc(&engine, "comments.list", json!({})).as_array().unwrap().is_empty());
        let on_scene = json!({ "target": "scene", "id": scene, "quote": "old gate", "text": "Which gate?", "todo": true });
        call(&engine, "c", "add_comment", &on_scene, false).unwrap();
        let rows = pending(&engine);
        assert_eq!(rows[1]["targetKind"], "node");
        assert_eq!(rows[1]["payload"]["isTodo"], true);
    }

    #[test]
    fn add_comment_refuses_a_missing_target_quote_or_hidden_page() {
        let (engine, _dir, page, scene) = project();
        let missing = call(&engine, "c", "add_comment", &json!({ "title": "Nobody", "quote": "x", "text": "y" }), false);
        assert_eq!(missing.unwrap_err().code, "NOT_FOUND");
        let wrong = call(&engine, "c", "add_comment", &json!({ "title": "Aria", "quote": "the gate is new", "text": "y" }), false).unwrap_err();
        assert_eq!(wrong.code, "QUOTE_NOT_FOUND");
        assert!(call(&engine, "c", "add_comment", &json!({ "title": "Aria", "quote": "old", "text": "  " }), false).is_err());
        hide(&engine, "pages", &page);
        let hidden = call(&engine, "c", "add_comment", &json!({ "title": "Aria", "quote": "old", "text": "y" }), false);
        assert_eq!(hidden.unwrap_err().code, "NOT_FOUND");
        hide(&engine, "nodes", &scene);
        let hidden = call(&engine, "c", "add_comment", &json!({ "target": "scene", "id": scene, "quote": "old", "text": "y" }), false);
        assert_eq!(hidden.unwrap_err().code, "NOT_FOUND");
        // Shared, it works.
        assert!(call(&engine, "c", "add_comment", &json!({ "title": "Aria", "quote": "old", "text": "y" }), true).is_ok());
        assert_eq!(pending(&engine).len(), 1);
    }

    #[test]
    fn add_comment_at_the_edit_level_waits_for_the_window() {
        let (engine, _dir, _page, _scene) = project();
        let helper = window(&engine);
        let args = json!({ "title": "Aria", "quote": "The gate is old.", "text": "Say how old." });
        let said = call_as(&engine, "c", "add_comment", &args, false, PERMISSION_EDIT, quick()).unwrap();
        helper.join().unwrap();
        assert_eq!(said, "Done: added a comment on \"Aria\".");
        assert!(pending(&engine).is_empty());
        let applied = engine.read(|c| suggest::list(c, STATUS_APPLIED)).unwrap();
        assert_eq!(applied[0]["kind"], "addComment");
    }

    #[test]
    fn resolve_comment_keeps_the_old_state_and_refuses_what_it_cannot_see() {
        let (engine, _dir, page, scene) = project();
        let id = comment(&engine, "page", &page);
        let said = call(&engine, "c", "resolve_comment", &json!({ "comment_id": id }), false).unwrap();
        assert!(said.contains("Nothing has changed yet"), "{said}");
        let row = pending(&engine).pop().unwrap();
        assert_eq!(row["kind"], "resolveComment");
        assert_eq!(row["title"], "Aria");
        assert_eq!(row["payload"]["resolved"], true);
        assert_eq!(row["payload"]["before"], false);
        // Still open until the app applies it, so reopening it would change nothing.
        let again = call(&engine, "c", "resolve_comment", &json!({ "comment_id": id, "resolved": false }), false);
        assert_eq!(again.unwrap_err().code, "INVALID");
        let missing = call(&engine, "c", "resolve_comment", &json!({ "comment_id": "nope" }), false);
        assert_eq!(missing.unwrap_err().code, "NOT_FOUND");
        let on_scene = comment(&engine, "node", &scene);
        hide(&engine, "nodes", &scene);
        let hidden = call(&engine, "c", "resolve_comment", &json!({ "comment_id": on_scene }), false);
        assert_eq!(hidden.unwrap_err().code, "NOT_FOUND");
        assert!(call(&engine, "c", "resolve_comment", &json!({ "comment_id": on_scene }), true).is_ok());
    }
}
