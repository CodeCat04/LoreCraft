//! The idea inbox: reading it, adding to it, editing and finishing ideas, and turning one
//! into a wiki page. The app applies each change through the inbox's own RPCs
//! (`src/mcp/kinds/ideas.tsx`), so the Inbox screen and its count update.
//!
//! `add_idea` is special: below the edit level it still lands in the inbox at once, since the
//! inbox is the writer's own list to review. At the edit level it is applied like any other
//! change, so it shows under Applied by outside AI with Undo.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::lore_edits::MAX_IDEA_CHARS;
use super::{read, write, Tool};
use crate::content::title_key;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{optional, reason, required, MAX_LABEL, MAX_PENDING};
use crate::mcp::text::cut;
use crate::mcp::tools::Ctx;
use crate::mcp::write::{Draft, WriteCx};
use crate::rpc::pages;

const STATUSES: &[&str] = &["open", "done"];
/// The longest page title made from an idea, as `titleFromIdea` in `src/inbox/ideaToPage.ts`.
const MAX_TITLE_CHARS: usize = 80;

pub fn tools() -> Vec<Tool> {
    vec![
        read(
            "list_ideas",
            "The writer's idea inbox: quick notes waiting to be dealt with, newest first, each with its id, status (open or done) and where it was captured. Changes nothing.",
            json!({ "type": "object", "properties": {
                "status": { "type": "string", "enum": ["open", "done"], "description": "Only ideas with this status. Leave out for all." },
            } }),
            list_ideas,
        ),
        write(
            "add_idea",
            "Leave a short idea in the writer's idea inbox, such as a plot possibility or a question to settle. It changes no page or scene, and the writer decides what to do with it. At the edit level the writer can undo it. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "text": { "type": "string", "description": "The idea, in a sentence or a short paragraph." },
            }, "required": ["text"] }),
            add_idea,
        ),
        write(
            "update_idea",
            "Change the text of an idea in the inbox. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The idea's id, from list_ideas." },
                "text": { "type": "string", "description": "The idea's new text." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["id", "text"] }),
            update_idea,
        ),
        write(
            "resolve_idea",
            "Mark an idea in the inbox as done, or open it again. It changes nothing else. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The idea's id, from list_ideas." },
                "status": { "type": "string", "enum": ["done", "open"], "description": "done (default) or open." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["id"] }),
            resolve_idea,
        ),
        write(
            "idea_to_page",
            "Turn an idea into a new wiki page, the way the Inbox does: the page starts with status idea and the idea's text, and the idea is marked done. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The idea's id, from list_ideas." },
                "title": { "type": "string", "description": "The page title. Default: the idea's first line." },
                "type": { "type": "string", "description": "The page type, such as article, character or place. Default article." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["id"] }),
            idea_to_page,
        ),
    ]
}

/// One idea as a tool sees it.
struct Found {
    id: String,
    text: String,
    status: String,
}

fn has_ideas(conn: &Connection) -> AppResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ideas'", [], |_| Ok(()))
        .optional()?
        .is_some())
}

/// An idea captured in a local-only page or scene is local only too, unless shared.
fn hidden(ctx: &Ctx, kind: Option<&str>, id: Option<&str>) -> bool {
    match (kind, id) {
        (Some("page"), Some(id)) => ctx.page_hidden(id),
        (Some("node"), Some(id)) => ctx.node_hidden(id),
        _ => false,
    }
}

fn find_idea(ctx: &Ctx, id: &str) -> AppResult<Found> {
    let not_found = || AppError::not_found("An idea with that id (see list_ideas)");
    if id.is_empty() || !has_ideas(ctx.conn)? {
        return Err(not_found());
    }
    let row: Option<(String, String, Option<String>, Option<String>)> = ctx
        .conn
        .query_row(
            "SELECT text, status, source_kind, source_id FROM ideas WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    match row {
        Some((text, status, kind, source)) if !hidden(ctx, kind.as_deref(), source.as_deref()) => {
            Ok(Found { id: id.to_string(), text, status })
        }
        _ => Err(not_found()),
    }
}

/// A short name for the list: the idea's first line.
fn idea_title(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or("").trim();
    let short = cut(line, 60);
    if short.len() < line.len() {
        format!("Idea: {}…", short.trim_end())
    } else {
        format!("Idea: {short}")
    }
}

fn check_text(text: &str) -> AppResult<String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::invalid("The idea is empty."));
    }
    if text.chars().count() > MAX_IDEA_CHARS {
        return Err(AppError::invalid(
            "That is too long for an idea. Keep it to a short note, or suggest a page with propose_new_page.",
        ));
    }
    Ok(text.to_string())
}

fn list_ideas(ctx: &Ctx, args: &Value) -> AppResult<String> {
    let status = optional(args, "status");
    if !status.is_empty() && !STATUSES.contains(&status) {
        return Err(AppError::invalid("status must be open or done."));
    }
    if !has_ideas(ctx.conn)? {
        return Ok("The idea inbox is empty.".to_string());
    }
    let mut stmt = ctx.conn.prepare(
        "SELECT i.id, i.text, i.status, i.source_kind, i.source_id,
                CASE i.source_kind
                  WHEN 'page' THEN (SELECT p.title FROM pages p WHERE p.id = i.source_id AND p.deleted_at IS NULL)
                  WHEN 'node' THEN (SELECT n.title FROM nodes n WHERE n.id = i.source_id AND n.deleted_at IS NULL)
                END
           FROM ideas i
          WHERE (?1 = '' OR i.status = ?1)
          ORDER BY i.created_at DESC, i.id DESC",
    )?;
    type Row = (String, String, String, Option<String>, Option<String>, Option<String>);
    let rows: Vec<Row> = stmt
        .query_map([status], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<Result<_, _>>()?;
    let mut out = String::new();
    for (id, text, status, kind, source, title) in rows {
        if hidden(ctx, kind.as_deref(), source.as_deref()) {
            continue;
        }
        let from = match (kind.as_deref(), title) {
            (Some("page"), Some(t)) => format!(" Captured on the page \"{t}\"."),
            (Some("node"), Some(t)) => format!(" Captured in the scene \"{}\".", if t.is_empty() { "Untitled" } else { &t }),
            _ => String::new(),
        };
        out.push_str(&format!("- id {id} ({status}).{from}\n  {}\n", cut(text.trim(), 4000).replace('\n', "\n  ")));
    }
    if out.is_empty() {
        return Ok(if status.is_empty() {
            "The idea inbox is empty.".to_string()
        } else {
            format!("No {status} ideas.")
        });
    }
    Ok(format!("The writer's idea inbox, newest first:\n{out}"))
}

/// Ideas from outside tools that still wait, so a tool cannot bury the writer in them.
fn waiting_from_tools(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM ideas WHERE status = 'open' AND text LIKE '%' || char(10) || '(From %)'",
        [],
        |r| r.get(0),
    )?)
}

/// An idea names the tool it came from, so the writer knows it was not theirs. Since nobody
/// approves it first below the edit level, a tool can add only short ones, and only so many
/// while they wait.
fn add_idea(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let text = check_text(required(args, "text")?)?;
    if cx.read(|ctx| waiting_from_tools(ctx.conn))? >= MAX_PENDING {
        return Err(AppError::new(
            "TOO_MANY",
            "Too many ideas from outside tools are waiting in the writer's inbox. Ask them to go through those first.",
        ));
    }
    let full = format!("{text}\n\n(From {})", cut(cx.client, MAX_LABEL));
    Ok(Draft::new("addIdea", idea_title(&text), json!({ "text": full }))
        .done("added to the writer's idea inbox. The writer can undo it under Outside suggestions.")
        .at_once(add_at_once))
}

/// Below the edit level: straight into the inbox, as before.
fn add_at_once(engine: &Engine, _client: &str, payload: &Value) -> AppResult<String> {
    crate::rpc::ideas::handle(engine, "add", json!({ "text": payload["text"] }))?;
    Ok("Added to the writer's idea inbox.".to_string())
}

fn update_idea(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let text = check_text(required(args, "text")?)?;
    let idea = cx.read(|ctx| find_idea(ctx, optional(args, "id")))?;
    if idea.text.trim() == text {
        return Err(AppError::invalid("Nothing would change. The idea already says that."));
    }
    let title = idea_title(&idea.text);
    let payload = json!({ "text": text, "before": idea.text, "reason": reason(args) });
    Ok(Draft::new("updateIdea", title.clone(), payload)
        .target("idea", idea.id)
        .suggested(format!(
            "Suggested a change to the idea \"{title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done("changed the idea's text."))
}

fn resolve_idea(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let status = match optional(args, "status") {
        "" | "done" => "done",
        "open" => "open",
        other => return Err(AppError::invalid(format!("status must be done or open, not {other}."))),
    };
    let idea = cx.read(|ctx| find_idea(ctx, optional(args, "id")))?;
    if idea.status == status {
        return Err(AppError::invalid(format!("Nothing would change. The idea is already {status}.")));
    }
    let title = idea_title(&idea.text);
    let payload = json!({ "status": status, "before": idea.status, "reason": reason(args) });
    let done = if status == "done" { "marked the idea as done." } else { "opened the idea again." };
    Ok(Draft::new("resolveIdea", title.clone(), payload)
        .target("idea", idea.id)
        .suggested(format!(
            "Suggested marking the idea \"{title}\" as {status} (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(done))
}

/// The first line, cut at a word if it is long, without the punctuation that ends a sentence.
fn title_from_idea(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or("").trim();
    let mut title = line.to_string();
    if title.chars().count() > MAX_TITLE_CHARS {
        let head: String = title.chars().take(MAX_TITLE_CHARS + 1).collect();
        title = match head.rfind(' ') {
            Some(space) if space > 0 => head[..space].to_string(),
            _ => title.chars().take(MAX_TITLE_CHARS).collect(),
        };
    }
    title
        .trim_end_matches(|c: char| c.is_whitespace() || ".,;:!?…—–-".contains(c))
        .to_string()
}

fn idea_to_page(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let idea = cx.read(|ctx| find_idea(ctx, optional(args, "id")))?;
    let given = optional(args, "title").split_whitespace().collect::<Vec<_>>().join(" ");
    let title = if given.is_empty() { title_from_idea(&idea.text) } else { given };
    if title_key(&title).is_empty() {
        return Err(AppError::invalid("The page needs a title. Give one."));
    }
    if title.len() > MAX_LABEL {
        return Err(AppError::invalid("That title is too long."));
    }
    if cx.read(|ctx| pages::resolve_title(ctx.conn, &title))?.is_some() {
        return Err(AppError::new(
            "TITLE_TAKEN",
            format!("A page called \"{title}\" already exists, or that name is an alias of one. Give another title."),
        ));
    }
    let page_type = cut(optional(args, "type"), MAX_LABEL);
    let payload = json!({
        "title": title,
        "pageType": if page_type.is_empty() { "article" } else { page_type },
        "text": idea.text,
        "before": idea.status,
        "reason": reason(args),
    });
    Ok(Draft::new("ideaToPage", title.clone(), payload)
        .target("idea", idea.id)
        .suggested(format!(
            "Suggested turning an idea into the page \"{title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("created the page \"{title}\" from the idea, with status idea, and marked the idea as done.")))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{json, Map, Value};

    use crate::engine::Engine;
    use crate::mcp::config::PERMISSION_EDIT;
    use crate::mcp::suggest::{self, call, call_as, STATUS_APPLIED, STATUS_APPLYING, STATUS_AUTO, STATUS_PENDING};
    use crate::mcp::write::Waits;
    use crate::rpc::call as rpc;

    fn project() -> (Arc<Engine>, crate::engine::TestDir) {
        let (engine, _host, dir) = Engine::for_test();
        rpc(&engine, "project.new", json!({ "name": "Inbox" }));
        (engine, dir)
    }

    fn idea(engine: &Engine, text: &str, source: Option<(&str, &str)>) -> String {
        let mut params = json!({ "text": text });
        if let Some((kind, id)) = source {
            params["sourceKind"] = json!(kind);
            params["sourceId"] = json!(id);
        }
        rpc(engine, "ideas.add", params)["id"].as_str().unwrap().to_string()
    }

    /// A page marked local only, and an idea captured on it.
    fn hidden_idea(engine: &Engine) -> String {
        let page = rpc(engine, "pages.create", json!({ "title": "Secret" }))["id"].as_str().unwrap().to_string();
        engine.write(|tx| Ok(tx.execute("UPDATE pages SET local_only = 1 WHERE id = ?1", [&page])?)).unwrap();
        idea(engine, "Hidden thought", Some(("page", &page)))
    }

    fn pending(engine: &Engine) -> Vec<Value> {
        engine.read(|c| suggest::list(c, STATUS_PENDING)).unwrap()
    }

    fn read_tool(engine: &Engine, name: &str, args: Value, share: bool) -> String {
        engine
            .read(|conn| {
                let ctx = crate::mcp::tools::Ctx::new(conn, "Inbox".into(), true, share)?;
                crate::mcp::tools::call(&ctx, name, &args)
            })
            .unwrap()
    }

    fn quick() -> Waits {
        Waits { claim: Duration::from_millis(600), apply: Duration::from_millis(1500), poll: Duration::from_millis(20) }
    }

    /// Plays the app's window: picks up one change and marks it applied.
    fn window(engine: &Arc<Engine>) -> std::thread::JoinHandle<Option<Value>> {
        let engine = engine.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(15));
                let waiting = engine.read(|c| suggest::list(c, STATUS_AUTO)).unwrap();
                if let Some(row) = waiting.first() {
                    let id = row["id"].as_str().unwrap().to_string();
                    assert!(engine.write(|tx| suggest::resolve(tx, &id, STATUS_APPLYING)).unwrap());
                    let mut extra = Map::new();
                    extra.insert("undo".into(), json!({ "id": "x" }));
                    assert!(engine.write(|tx| suggest::resolve_with(tx, &id, STATUS_APPLIED, &extra)).unwrap());
                    return Some(row.clone());
                }
            }
            None
        })
    }

    #[test]
    fn list_ideas_shows_ids_and_status_and_hides_local_only() {
        let (engine, _dir) = project();
        let open = idea(&engine, "What if the gate remembers?", None);
        let done = idea(&engine, "Rename the river", None);
        rpc(&engine, "ideas.update", json!({ "id": done, "status": "done" }));
        hidden_idea(&engine);
        let all = read_tool(&engine, "list_ideas", json!({}), false);
        assert!(all.contains(&open) && all.contains("(open)") && all.contains("(done)"), "{all}");
        assert!(!all.contains("Hidden thought"), "{all}");
        let only_open = read_tool(&engine, "list_ideas", json!({ "status": "open" }), false);
        assert!(!only_open.contains("Rename the river"), "{only_open}");
        assert!(read_tool(&engine, "list_ideas", json!({}), true).contains("Hidden thought"));
    }

    #[test]
    fn add_idea_lands_at_once_below_the_edit_level() {
        let (engine, _dir) = project();
        let said = call(&engine, "Claude Code", "add_idea", &json!({ "text": "A new moon" }), false).unwrap();
        assert!(said.contains("idea inbox"), "{said}");
        assert!(pending(&engine).is_empty());
        let ideas = rpc(&engine, "ideas.list", json!({}));
        assert!(ideas[0]["text"].as_str().unwrap().contains("(From Claude Code)"));
    }

    #[test]
    fn add_idea_at_the_edit_level_is_applied_by_the_app_with_undo() {
        let (engine, _dir) = project();
        let helper = window(&engine);
        let said = call_as(&engine, "Claude Code", "add_idea", &json!({ "text": "A new moon" }), false, PERMISSION_EDIT, quick()).unwrap();
        let row = helper.join().unwrap().expect("the window picked it up");
        assert!(said.starts_with("Done: "), "{said}");
        assert_eq!(row["kind"], "addIdea");
        assert_eq!(row["title"], "Idea: A new moon");
        assert_eq!(row["payload"]["text"], "A new moon\n\n(From Claude Code)");
        // Rust left the adding to the app.
        assert_eq!(rpc(&engine, "ideas.list", json!({})).as_array().unwrap().len(), 0);
    }

    #[test]
    fn update_idea_queues_with_the_old_text() {
        let (engine, _dir) = project();
        let id = idea(&engine, "Old thought", None);
        let said = call(&engine, "c", "update_idea", &json!({ "id": id, "text": "New thought" }), false).unwrap();
        assert!(said.contains("Nothing has changed yet"), "{said}");
        let p = &pending(&engine)[0];
        assert_eq!(p["kind"], "updateIdea");
        assert_eq!(p["targetKind"], "idea");
        assert_eq!(p["targetId"], id);
        assert_eq!(p["payload"]["before"], "Old thought");
        assert_eq!(rpc(&engine, "ideas.list", json!({}))[0]["text"], "Old thought");
        assert_eq!(call(&engine, "c", "update_idea", &json!({ "id": "nope", "text": "x" }), false).unwrap_err().code, "NOT_FOUND");
        assert!(call(&engine, "c", "update_idea", &json!({ "id": id, "text": "Old thought" }), false).is_err());
        let hidden = hidden_idea(&engine);
        assert_eq!(call(&engine, "c", "update_idea", &json!({ "id": hidden, "text": "x" }), false).unwrap_err().code, "NOT_FOUND");
        assert!(call(&engine, "c", "update_idea", &json!({ "id": hidden, "text": "x" }), true).is_ok());
    }

    #[test]
    fn resolve_idea_queues_and_refuses_what_would_not_change() {
        let (engine, _dir) = project();
        let id = idea(&engine, "Settle the calendar", None);
        call(&engine, "c", "resolve_idea", &json!({ "id": id }), false).unwrap();
        let p = &pending(&engine)[0];
        assert_eq!(p["kind"], "resolveIdea");
        assert_eq!(p["payload"]["status"], "done");
        assert_eq!(p["payload"]["before"], "open");
        assert!(call(&engine, "c", "resolve_idea", &json!({ "id": id, "status": "open" }), false).is_err());
        assert!(call(&engine, "c", "resolve_idea", &json!({ "id": id, "status": "archived" }), false).is_err());
        assert_eq!(call(&engine, "c", "resolve_idea", &json!({ "id": "nope" }), false).unwrap_err().code, "NOT_FOUND");
        let hidden = hidden_idea(&engine);
        assert_eq!(call(&engine, "c", "resolve_idea", &json!({ "id": hidden }), false).unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn idea_to_page_queues_a_page_named_from_the_first_line() {
        let (engine, _dir) = project();
        let id = idea(&engine, "The Salt Road.\nA trade route through the marsh.", None);
        let said = call(&engine, "c", "idea_to_page", &json!({ "id": id, "type": "place" }), false).unwrap();
        assert!(said.contains("The Salt Road"), "{said}");
        let p = &pending(&engine)[0];
        assert_eq!(p["kind"], "ideaToPage");
        assert_eq!(p["title"], "The Salt Road");
        assert_eq!(p["payload"]["pageType"], "place");
        assert_eq!(p["payload"]["before"], "open");
        rpc(&engine, "pages.create", json!({ "title": "Taken" }));
        let taken = call(&engine, "c", "idea_to_page", &json!({ "id": id, "title": "Taken" }), false).unwrap_err();
        assert_eq!(taken.code, "TITLE_TAKEN");
        assert_eq!(call(&engine, "c", "idea_to_page", &json!({ "id": "nope" }), false).unwrap_err().code, "NOT_FOUND");
        let hidden = hidden_idea(&engine);
        assert_eq!(call(&engine, "c", "idea_to_page", &json!({ "id": hidden }), false).unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn titles_come_from_the_first_line_like_the_inbox() {
        assert_eq!(super::title_from_idea("  A storm is coming!  \nmore"), "A storm is coming");
        let long = "word ".repeat(30);
        assert!(super::title_from_idea(&long).chars().count() <= super::MAX_TITLE_CHARS);
    }
}
