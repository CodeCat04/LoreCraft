//! Suggestions from outside tools. Nothing here touches a document: a suggestion is one
//! row in `proposals`, and the writer accepts or rejects it in the app. Accepting runs in
//! `src/mcp/apply.ts`, where the editor's schema and Markdown parser live.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::text::{
    closest_passage, cut, doc_to_text, find_all, needle_for, normalize_quote, normalize_with_map,
    Normalized,
};
use super::tools::{resolve_node, resolve_page, resolve_scene_id, Ctx};
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

/// A page or scene a suggestion changes, as the client may see it.
struct Target {
    kind: &'static str,
    id: String,
    title: String,
    text: String,
}

impl Target {
    fn read_with(&self) -> &'static str {
        if self.kind == "page" {
            "get_page"
        } else {
            "get_scene"
        }
    }
}

fn load_target(engine: &Engine, args: &Value, share: bool, default: &str) -> AppResult<Target> {
    let target = args
        .get("target")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(default);
    engine.read(|conn| {
        let ctx = Ctx::new(conn, String::new(), true, share)?;
        match target {
            "page" => {
                let id = resolve_page(&ctx, args)?;
                let page = pages::get_page(conn, &id)?;
                Ok(Target {
                    kind: "page",
                    id,
                    title: page.meta.title.clone(),
                    text: doc_to_text(&page.content),
                })
            }
            "scene" | "node" => {
                let (id, title) = resolve_scene_id(&ctx, args)?;
                let node = manuscript::get_node(conn, &id)?;
                Ok(Target {
                    kind: "node",
                    id,
                    title,
                    text: doc_to_text(&node.content),
                })
            }
            other => Err(AppError::invalid(format!(
                "target must be page or scene, not {other}."
            ))),
        }
    })
}

/// Where a quote is in the text, as a range of the normalized text. `after` limits the
/// search to matches that start and end no earlier than that range, for a closing anchor.
fn locate(
    target: &Target,
    hay: &Normalized,
    quote: &str,
    what: &str,
    after: Option<(usize, usize)>,
) -> AppResult<(usize, usize)> {
    check_size(what, quote)?;
    let needle = needle_for(quote, &hay.text);
    let title = &target.title;
    if needle.is_empty() {
        return Err(AppError::invalid(format!(
            "{what} is empty. Copy a few words of the text."
        )));
    }
    let found: Vec<usize> = find_all(&hay.text, &needle)
        .into_iter()
        .filter(|&at| after.is_none_or(|(start, end)| at >= start && at + needle.len() >= end))
        .collect();
    match found.len() {
        0 => {
            let place = if after.is_some() { " after the start" } else { "" };
            let hint = closest_passage(&target.text, quote)
                .map(|p| format!(" The closest passage is: \"{p}\"."))
                .unwrap_or_default();
            Err(AppError::new(
                "QUOTE_NOT_FOUND",
                format!(
                    "{what} is not in \"{title}\"{place}.{hint} Read the current text with {} and copy it exactly.",
                    target.read_with()
                ),
            ))
        }
        1 => Ok((found[0], found[0] + needle.len())),
        n => Err(AppError::new(
            "QUOTE_NOT_UNIQUE",
            format!(
                "{what} appears {n} times in \"{title}\". Quote more of the words around it so it is unique."
            ),
        )),
    }
}

fn reason(args: &Value) -> Value {
    json!(cut(optional(args, "reason"), 2000))
}

fn suggested(title: &str, proposal: &str) -> String {
    format!(
        "Suggested a change to \"{title}\" (suggestion {proposal}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
    )
}

fn store(engine: &Engine, client: &str, target: Target, kind: &'static str, payload: Value) -> AppResult<String> {
    let proposal = insert(
        engine,
        client,
        Row {
            kind,
            target_kind: Some(target.kind.to_string()),
            target_id: Some(target.id),
            title: target.title.clone(),
            payload,
        },
    )?;
    Ok(suggested(&target.title, &proposal))
}

fn wants_whole(args: &Value) -> bool {
    match args.get("whole") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.trim().eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn propose_edit(engine: &Engine, client: &str, args: &Value, share: bool) -> AppResult<String> {
    if args.get("quote").is_none() && (args.get("from_quote").is_some() || wants_whole(args)) {
        return propose_rewrite(engine, client, args, share);
    }
    let quote = required(args, "quote")?;
    let replacement = required(args, "replacement")?;
    check_size("The quote", quote)?;
    check_size("The replacement", replacement)?;
    if normalize_quote(quote).is_empty() {
        return Err(AppError::invalid("The quote is empty. Copy the text to replace."));
    }
    if normalize_quote(quote) == normalize_quote(replacement) {
        return Err(AppError::invalid("The replacement is the same as the quote."));
    }
    required(args, "target")?;
    let target = load_target(engine, args, share, "")?;
    let hay = normalize_with_map(&target.text);
    locate(&target, &hay, quote, "That quote", None)?;
    let payload = json!({ "quote": quote, "replacement": replacement, "reason": reason(args) });
    store(engine, client, target, "edit", payload)
}

/// Rewrites a stretch given by its first and last words, or the whole scene.
fn propose_rewrite(engine: &Engine, client: &str, args: &Value, share: bool) -> AppResult<String> {
    let replacement = args
        .get("replacement")
        .or_else(|| args.get("text"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::invalid("replacement is required."))?;
    check_size("The replacement", replacement)?;
    let target = load_target(engine, args, share, "scene")?;
    let payload = if wants_whole(args) {
        if normalize_quote(replacement).is_empty() {
            return Err(AppError::invalid(
                "The replacement is empty. A whole rewrite needs the new text.",
            ));
        }
        if normalize_quote(&target.text) == normalize_quote(replacement) {
            return Err(AppError::invalid("The replacement is the same as the text."));
        }
        json!({ "mode": "whole", "replacement": replacement, "original": target.text, "reason": reason(args) })
    } else {
        let from_quote = required(args, "from_quote")?;
        let to_quote = required(args, "to_quote")?;
        let hay = normalize_with_map(&target.text);
        let start = locate(&target, &hay, from_quote, "from_quote", None)?;
        let end = locate(&target, &hay, to_quote, "to_quote", Some(start))?;
        let (from, to) = hay.original(start.0, end.1);
        let original = &target.text[from..to];
        if normalize_quote(original) == normalize_quote(replacement) {
            return Err(AppError::invalid("The replacement is the same as the text."));
        }
        json!({
            "mode": "range",
            "fromQuote": from_quote,
            "toQuote": to_quote,
            "replacement": replacement,
            "original": original,
            "reason": reason(args),
        })
    };
    store(engine, client, target, "rewrite", payload)
}

/// Adds text at the start or end, or next to a quote. Works on an empty scene too.
fn propose_insert(engine: &Engine, client: &str, args: &Value, share: bool) -> AppResult<String> {
    let text = required(args, "text")?;
    check_size("The text", text)?;
    if normalize_quote(text).is_empty() {
        return Err(AppError::invalid("The text is empty."));
    }
    let target = load_target(engine, args, share, "scene")?;
    let after = optional(args, "after_quote");
    let before = optional(args, "before_quote");
    let at = optional(args, "at");
    let (at, quote) = match (at, after.is_empty(), before.is_empty()) {
        ("start" | "end", true, true) => (at, ""),
        ("", false, true) => ("after", after),
        ("", true, false) => ("before", before),
        ("", true, true) => {
            return Err(AppError::invalid(
                "Say where: at start or end, or give after_quote or before_quote.",
            ))
        }
        _ => {
            return Err(AppError::invalid(
                "Give only one of at (start or end), after_quote or before_quote.",
            ))
        }
    };
    if !quote.is_empty() {
        let hay = normalize_with_map(&target.text);
        let name = if at == "after" { "after_quote" } else { "before_quote" };
        locate(&target, &hay, quote, name, None)?;
    }
    let payload = json!({ "at": at, "quote": quote, "text": text, "reason": reason(args) });
    store(engine, client, target, "insert", payload)
}

// ---------------------------------------------------------------------------
// New scenes and chapters, and a scene's details
// ---------------------------------------------------------------------------

fn resolve_book(ctx: &Ctx, wanted: &str) -> AppResult<(String, String)> {
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
fn node_ref(ctx: &Ctx, value: &str, kinds: &[&str]) -> AppResult<manuscript::Node> {
    resolve_node(ctx, &json!({ "id": value }), kinds)
        .or_else(|_| resolve_node(ctx, &json!({ "title": value }), kinds))
}

/// The book's parts, chapters and scenes in reading order, leaving out what is hidden.
fn reading_order(ctx: &Ctx, book_id: &str) -> AppResult<Vec<manuscript::NodeMeta>> {
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
fn page_ref(ctx: &Ctx, value: &str) -> AppResult<Value> {
    let id = resolve_page(ctx, &json!({ "title": value }))
        .or_else(|_| resolve_page(ctx, &json!({ "id": value })))?;
    let title: String = ctx
        .conn
        .query_row("SELECT title FROM pages WHERE id = ?1", [&id], |r| r.get(0))?;
    Ok(json!({ "id": id, "title": title }))
}

/// POV, location and cast for a new scene. Absent fields are left out.
fn scene_people(ctx: &Ctx, args: &Value, payload: &mut Map<String, Value>) -> AppResult<()> {
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

fn label(args: &Value, name: &str, what: &str) -> AppResult<String> {
    let value = optional(args, name).split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        return Err(AppError::invalid(format!("{what} needs a title.")));
    }
    if value.len() > MAX_LABEL {
        return Err(AppError::invalid("That title is too long."));
    }
    Ok(value)
}

fn propose_new_scene(engine: &Engine, client: &str, args: &Value, share: bool) -> AppResult<String> {
    let title = label(args, "title", "The scene")?;
    let text = optional(args, "text");
    check_size("The text", text)?;
    let (payload, chapter_id, chapter_title) = engine.read(|conn| {
        let ctx = Ctx::new(conn, String::new(), true, share)?;
        let after = optional(args, "after");
        let chapter_arg = optional(args, "chapter");
        let (chapter, after) = if !after.is_empty() {
            let scene = node_ref(&ctx, after, &["scene"])?;
            let parent = scene.meta.parent_id.clone().unwrap_or_default();
            (node_ref(&ctx, &parent, &["chapter"])?, Some(scene))
        } else if !chapter_arg.is_empty() {
            (node_ref(&ctx, chapter_arg, &["chapter"])?, None)
        } else {
            let (book_id, book_title) = resolve_book(&ctx, optional(args, "book"))?;
            let last = reading_order(&ctx, &book_id)?
                .into_iter()
                .filter(|n| n.kind == "chapter")
                .last()
                .ok_or_else(|| {
                    AppError::not_found(format!(
                        "A chapter in \"{book_title}\" to add the scene to. Use propose_new_chapter first"
                    ))
                })?;
            (manuscript::get_node(conn, &last.id)?, None)
        };
        let book_title: String = conn.query_row(
            "SELECT title FROM books WHERE id = ?1",
            [&chapter.meta.book_id],
            |r| r.get(0),
        )?;
        let mut payload = Map::new();
        payload.insert("bookId".into(), json!(chapter.meta.book_id));
        payload.insert("bookTitle".into(), json!(book_title));
        payload.insert("chapterId".into(), json!(chapter.meta.id));
        payload.insert("chapterTitle".into(), json!(chapter.meta.title));
        if let Some(after) = &after {
            payload.insert("afterId".into(), json!(after.meta.id));
            payload.insert("afterTitle".into(), json!(after.meta.title));
        }
        payload.insert("title".into(), json!(title));
        payload.insert("synopsis".into(), json!(cut(optional(args, "synopsis"), 4000)));
        scene_people(&ctx, args, &mut payload)?;
        payload.insert("text".into(), json!(text));
        payload.insert("reason".into(), reason(args));
        Ok((payload, chapter.meta.id.clone(), chapter.meta.title.clone()))
    })?;
    let proposal = insert(
        engine,
        client,
        Row {
            kind: "newScene",
            target_kind: Some("node".into()),
            target_id: Some(chapter_id),
            title: title.clone(),
            payload: Value::Object(payload),
        },
    )?;
    Ok(format!(
        "Suggested a new scene \"{title}\" in \"{chapter_title}\" (suggestion {proposal}). It does not exist yet: the writer reviews it in LoreCraft under Outside suggestions."
    ))
}

fn propose_new_chapter(engine: &Engine, client: &str, args: &Value, share: bool) -> AppResult<String> {
    let title = label(args, "title", "The chapter")?;
    let text = optional(args, "text");
    check_size("The text", text)?;
    let scene_title = match optional(args, "scene_title") {
        "" => title.clone(),
        _ => label(args, "scene_title", "The scene")?,
    };
    let (payload, book_id) = engine.read(|conn| {
        let ctx = Ctx::new(conn, String::new(), true, share)?;
        let after = optional(args, "after");
        let mut payload = Map::new();
        let book_id = if !after.is_empty() {
            let chapter = node_ref(&ctx, after, &["chapter"])?;
            payload.insert("parentId".into(), json!(chapter.meta.parent_id));
            payload.insert("afterId".into(), json!(chapter.meta.id));
            payload.insert("afterTitle".into(), json!(chapter.meta.title));
            chapter.meta.book_id
        } else {
            let (book_id, _) = resolve_book(&ctx, optional(args, "book"))?;
            // A book in parts gains the chapter at the end of its last part.
            let top = reading_order(&ctx, &book_id)?
                .into_iter()
                .filter(|n| n.parent_id.is_none())
                .last();
            let part = top.filter(|n| n.kind == "part").map(|n| n.id);
            payload.insert("parentId".into(), json!(part));
            book_id
        };
        let book_title: String =
            conn.query_row("SELECT title FROM books WHERE id = ?1", [&book_id], |r| r.get(0))?;
        payload.insert("bookId".into(), json!(book_id));
        payload.insert("bookTitle".into(), json!(book_title));
        payload.insert("title".into(), json!(title));
        payload.insert("synopsis".into(), json!(cut(optional(args, "synopsis"), 4000)));
        let mut scene = Map::new();
        scene.insert("title".into(), json!(scene_title));
        scene.insert("synopsis".into(), json!(cut(optional(args, "scene_synopsis"), 4000)));
        scene_people(&ctx, args, &mut scene)?;
        scene.insert("text".into(), json!(text));
        payload.insert("scene".into(), Value::Object(scene));
        payload.insert("reason".into(), reason(args));
        Ok((payload, book_id))
    })?;
    let proposal = insert(
        engine,
        client,
        Row {
            kind: "newChapter",
            target_kind: Some("book".into()),
            target_id: Some(book_id),
            title: title.clone(),
            payload: Value::Object(payload),
        },
    )?;
    Ok(format!(
        "Suggested a new chapter \"{title}\" (suggestion {proposal}). It does not exist yet: the writer reviews it in LoreCraft under Outside suggestions."
    ))
}

fn propose_scene_details(engine: &Engine, client: &str, args: &Value, share: bool) -> AppResult<String> {
    let (id, title, payload) = engine.read(|conn| {
        let ctx = Ctx::new(conn, String::new(), true, share)?;
        let (id, title) = resolve_scene_id(&ctx, args)?;
        let node = manuscript::get_node(conn, &id)?;
        let page_title = |id: Option<&str>| -> AppResult<Value> {
            Ok(match id {
                Some(id) if !id.is_empty() => {
                    let title: Option<String> = conn
                        .query_row("SELECT title FROM pages WHERE id = ?1", [id], |r| r.get(0))
                        .optional()?;
                    json!({ "id": id, "title": title.unwrap_or_default() })
                }
                _ => Value::Null,
            })
        };
        let location: Option<String> = conn.query_row(
            "SELECT location_page_id FROM nodes WHERE id = ?1",
            [&id],
            |r| r.get(0),
        )?;
        let cast_ids = manuscript::cast_of(conn, &id)?;
        let cast_before = cast_ids
            .iter()
            .map(|c| page_title(Some(c)))
            .collect::<AppResult<Vec<_>>>()?;
        let before = json!({
            "title": node.meta.title,
            "synopsis": node.meta.synopsis,
            "status": node.meta.status,
            "storyDate": node.meta.story_date,
            "notes": node.notes,
            "pov": page_title(node.meta.pov_page_id.as_deref())?,
            "location": page_title(location.as_deref())?,
            "cast": cast_before,
        });
        let mut changes = Map::new();
        let mut text_field = |arg: &str, key: &str, limit: usize| -> AppResult<()> {
            if let Some(value) = args.get(arg).and_then(Value::as_str) {
                check_size(arg, value)?;
                let value = cut(value.trim(), limit);
                if before[key].as_str() != Some(value) {
                    changes.insert(key.into(), json!(value));
                }
            }
            Ok(())
        };
        text_field("synopsis", "synopsis", 4000)?;
        text_field("story_date", "storyDate", MAX_LABEL)?;
        text_field("notes", "notes", MAX_TEXT)?;
        if args.get("new_title").and_then(Value::as_str).is_some() {
            let new_title = label(args, "new_title", "The scene")?;
            if new_title != node.meta.title {
                changes.insert("title".into(), json!(new_title));
            }
        }
        if let Some(status) = args.get("status").and_then(Value::as_str).map(str::trim) {
            if !manuscript::NODE_STATUSES.contains(&status) {
                return Err(AppError::invalid(format!(
                    "status must be one of {}.",
                    manuscript::NODE_STATUSES.join(", ")
                )));
            }
            if status != node.meta.status {
                changes.insert("status".into(), json!(status));
            }
        }
        for key in ["pov", "location"] {
            if let Some(value) = args.get(key).and_then(Value::as_str).map(str::trim) {
                let chosen = if value.is_empty() { Value::Null } else { page_ref(&ctx, value)? };
                if chosen.get("id") != before[key].get("id") {
                    changes.insert(key.into(), chosen);
                }
            }
        }
        if args.get("cast").is_some() {
            let mut cast = string_list(args, "cast")
                .iter()
                .map(|name| page_ref(&ctx, name))
                .collect::<AppResult<Vec<_>>>()?;
            // Pages this client cannot see stay in the cast it never saw them in.
            for (index, page) in cast_ids.iter().enumerate() {
                if ctx.page_hidden(page) {
                    cast.push(cast_before[index].clone());
                }
            }
            let ids = |list: &[Value]| {
                let mut ids: Vec<String> =
                    list.iter().filter_map(|p| p["id"].as_str().map(String::from)).collect();
                ids.sort();
                ids.dedup();
                ids
            };
            if ids(&cast) != ids(&cast_before) {
                changes.insert("cast".into(), Value::Array(cast));
            }
        }
        if changes.is_empty() {
            return Err(AppError::invalid(
                "Nothing would change. Give at least one detail that differs from the scene's now.",
            ));
        }
        Ok((
            id,
            title,
            json!({ "changes": changes, "before": before, "reason": reason(args) }),
        ))
    })?;
    store(
        engine,
        client,
        Target { kind: "node", id, title, text: String::new() },
        "sceneDetails",
        payload,
    )
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
        "propose_rewrite" => propose_rewrite(engine, client, args, share),
        "propose_insert" => propose_insert(engine, client, args, share),
        "propose_new_scene" => propose_new_scene(engine, client, args, share),
        "propose_new_chapter" => propose_new_chapter(engine, client, args, share),
        "propose_scene_details" => propose_scene_details(engine, client, args, share),
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
