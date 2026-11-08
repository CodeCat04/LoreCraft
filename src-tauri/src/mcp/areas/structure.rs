//! The manuscript's structure and its books: book settings, moving, renaming, status, the
//! trash, splitting and merging scenes, chapter details and plot threads. Each write tool
//! builds a draft that the app applies with its own stores (`src/mcp/kinds/structure.tsx`),
//! with the old values kept so Undo can put them back.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::{empty_schema, read, write, Tool};
use crate::content::title_key;
use crate::error::{AppError, AppResult};
use crate::mcp::limits::check_meta_key;
use crate::mcp::suggest::{check_size, label, node_ref, optional, reading_order, reason, resolve_book, MAX_LABEL, MAX_TEXT};
use crate::mcp::text::{cut, doc_to_text, find_all, needle_for, normalize_with_map};
use crate::mcp::tools::{resolve_node, Ctx};
use crate::mcp::write::{Draft, WriteCx};
use crate::rpc::manuscript::{self, NodeMeta, NODE_STATUSES};

/// Project meta the Book settings dialog writes besides the book row.
const VOICE_KEY: &str = "books.voice";
const STYLE_KEY: &str = "writingStyles.choices";
/// As `POV_OPTIONS` and `TENSE_OPTIONS` in `src/write/bookVoice.ts`.
const POVS: [&str; 6] = ["first", "second", "close-third", "distant-third", "omniscient", "multiple"];
const TENSES: [&str; 2] = ["past", "present"];
const ANY_NODE: [&str; 3] = ["scene", "chapter", "part"];

fn id_or_title(noun: &str) -> Value {
    json!({
        "id": { "type": "string", "description": format!("The {noun} id from get_outline. Used instead of the title.") },
        "title": { "type": "string", "description": format!("The {noun} title.") },
    })
}

fn schema(noun: &str, extra: Value, required: &[&str]) -> Value {
    let mut props = id_or_title(noun).as_object().cloned().unwrap_or_default();
    if let Some(more) = extra.as_object() {
        props.extend(more.clone());
    }
    props.insert("reason".into(), json!({ "type": "string", "description": "A short note to the writer saying why." }));
    json!({ "type": "object", "properties": props, "required": required })
}

fn book_fields() -> Value {
    json!({
        "subtitle": { "type": "string" },
        "author": { "type": "string" },
        "target_words": { "type": "integer", "minimum": 0, "description": "The book's word goal. 0 means none." },
        "pov": { "type": "string", "enum": ["", "first", "second", "close-third", "distant-third", "omniscient", "multiple"], "description": "The book's point of view. Empty clears it." },
        "tense": { "type": "string", "enum": ["", "past", "present"], "description": "Empty clears it." },
        "style": { "type": "string", "description": "The book's default writing style, by name or id. Empty means the same as the project." },
        "reason": { "type": "string", "description": "A short note to the writer saying why." },
    })
}

fn with(mut base: Value, extra: Value) -> Value {
    if let (Some(map), Some(more)) = (base.as_object_mut(), extra.as_object()) {
        map.extend(more.clone());
    }
    base
}

pub fn tools() -> Vec<Tool> {
    vec![
        read(
            "get_book_settings",
            "A book's settings: title, subtitle, author, word goal, point of view, tense and default writing style, with its word count. Changes nothing.",
            json!({ "type": "object", "properties": {
                "book": { "type": "string", "description": "A book's title or id. Default the only book." },
            }}),
            get_book_settings,
        ),
        read(
            "get_threads",
            "The plot threads, with their ids, descriptions and the scenes in each, in reading order. Changes nothing.",
            empty_schema(),
            |ctx, _| get_threads(ctx),
        ),
        write(
            "create_book",
            "Create a new book, with a first chapter and scene, and its settings. Depending on the writer's setting, it waits for them to accept it, or is created at once and can be undone. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": with(json!({ "title": { "type": "string", "description": "The new book's title." } }), book_fields()), "required": ["title"] }),
            create_book,
        ),
        write(
            "update_book",
            "Change a book's settings: title, subtitle, author, word goal, point of view, tense or default writing style. Give only the fields to change. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": with(json!({
                "book": { "type": "string", "description": "A book's title or id. Default the only book." },
                "new_title": { "type": "string", "description": "A new title for the book." },
            }), book_fields()) }),
            update_book,
        ),
        write(
            "move_node",
            "Move a scene, chapter or part: before or after another one, or into a chapter or part at a position. Scenes go in chapters, chapters in parts or at the top, parts at the top. Needs LoreCraft to be open with this project.",
            schema("scene, chapter or part", json!({
                "before": { "type": "string", "description": "Put it just before this node (id or title)." },
                "after": { "type": "string", "description": "Put it just after this node (id or title)." },
                "into": { "type": "string", "description": "A chapter or part (id or title) to move it into, or \"book\" for the book's top level." },
                "position": { "type": "integer", "minimum": 1, "description": "With into: its place there, from 1. Default the end." },
            }), &[]),
            move_node,
        ),
        write(
            "rename_node",
            "Rename a scene, chapter or part. Needs LoreCraft to be open with this project.",
            schema("scene, chapter or part", json!({ "new_title": { "type": "string" } }), &["new_title"]),
            rename_node,
        ),
        write(
            "set_node_status",
            "Set the status of a scene, chapter or part. Needs LoreCraft to be open with this project.",
            schema("scene, chapter or part", json!({ "status": { "type": "string", "enum": NODE_STATUSES } }), &["status"]),
            set_node_status,
        ),
        write(
            "set_chapter_details",
            "Change a chapter's or part's details: synopsis, notes or word goal. Give only the fields to change. For scenes, use propose_scene_details. Needs LoreCraft to be open with this project.",
            schema("chapter or part", json!({
                "synopsis": { "type": "string" },
                "notes": { "type": "string", "description": "Replaces the notes." },
                "target_words": { "type": "integer", "minimum": 0, "description": "Its word goal. 0 means none." },
            }), &[]),
            set_chapter_details,
        ),
        write(
            "trash_node",
            "Move a scene, chapter or part to the manuscript's trash, with what is inside it. The writer can restore it from there. Needs LoreCraft to be open with this project.",
            schema("scene, chapter or part", json!({}), &[]),
            trash_node,
        ),
        write(
            "restore_node",
            "Bring a scene, chapter or part back from the manuscript's trash. Give its id or title. Needs LoreCraft to be open with this project.",
            schema("trashed scene, chapter or part", json!({}), &[]),
            restore_node,
        ),
        write(
            "split_scene",
            "Cut a scene in two. The new scene starts at the quoted words, or just after them with position after. It keeps the scene's details. Needs LoreCraft to be open with this project.",
            schema("scene", json!({
                "quote": { "type": "string", "description": "A few exact words of the scene, unique in it." },
                "position": { "type": "string", "enum": ["before", "after"], "description": "Cut before the quote (default) or after it." },
                "new_title": { "type": "string", "description": "The second scene's title. Default the title with (continued)." },
            }), &["quote"]),
            split_scene,
        ),
        write(
            "merge_scenes",
            "Join two neighbouring scenes: the second scene's text goes onto the end of the first, and the second goes to the trash. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "first": { "type": "string", "description": "The first scene's id or title." },
                "second": { "type": "string", "description": "The scene straight after it, by id or title." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["first", "second"] }),
            merge_scenes,
        ),
        write(
            "create_thread",
            "Create a plot thread. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "name": { "type": "string" },
                "description": { "type": "string" },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["name"] }),
            create_thread,
        ),
        write(
            "rename_thread",
            "Rename a plot thread, or change its description. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "thread": { "type": "string", "description": "The thread's id or name." },
                "new_name": { "type": "string" },
                "description": { "type": "string", "description": "Replaces the description." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["thread"] }),
            rename_thread,
        ),
        write(
            "delete_thread",
            "Delete a plot thread. Its scenes stay as they are; they just leave the thread. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "thread": { "type": "string", "description": "The thread's id or name." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["thread"] }),
            delete_thread,
        ),
        write(
            "add_scene_to_thread",
            "Add a scene to a plot thread. Needs LoreCraft to be open with this project.",
            thread_link_schema(),
            |cx, args| link_scene(cx, args, true),
        ),
        write(
            "remove_scene_from_thread",
            "Take a scene out of a plot thread. The scene itself is not changed. Needs LoreCraft to be open with this project.",
            thread_link_schema(),
            |cx, args| link_scene(cx, args, false),
        ),
    ]
}

fn thread_link_schema() -> Value {
    json!({ "type": "object", "properties": {
        "thread": { "type": "string", "description": "The thread's id or name." },
        "scene": { "type": "string", "description": "The scene's id or title." },
        "reason": { "type": "string", "description": "A short note to the writer saying why." },
    }, "required": ["thread", "scene"] })
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

fn meta_json(conn: &Connection, key: &str) -> AppResult<Value> {
    let stored: Option<String> =
        conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?;
    Ok(stored
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({})))
}

/// The settings the Book settings dialog shows, as the app stores them.
fn book_settings(conn: &Connection, book_id: &str) -> AppResult<Value> {
    let (title, subtitle, author, target): (String, String, String, i64) = conn.query_row(
        "SELECT title, subtitle, author, target_words FROM books WHERE id = ?1",
        [book_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let voice = &meta_json(conn, VOICE_KEY)?[book_id];
    let known = |value: &Value, list: &[&str]| {
        value.as_str().filter(|v| list.contains(v)).unwrap_or("").to_string()
    };
    let style = &meta_json(conn, STYLE_KEY)?["books"][book_id];
    Ok(json!({
        "title": title,
        "subtitle": subtitle,
        "author": author,
        "targetWords": target,
        "pov": known(&voice["pov"], &POVS),
        "tense": known(&voice["tense"], &TENSES),
        "style": style["styleId"].as_str().unwrap_or(""),
        "styleName": style["name"].as_str().unwrap_or(""),
    }))
}

fn book_title(conn: &Connection, book_id: &str) -> AppResult<String> {
    Ok(conn.query_row("SELECT title FROM books WHERE id = ?1", [book_id], |r| r.get(0))?)
}

/// True if anything under this node, or the node, is local only.
fn holds_local_only(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "WITH RECURSIVE tree(id) AS (
           SELECT ?1 UNION ALL SELECT n.id FROM nodes n JOIN tree t ON n.parent_id = t.id
         ) SELECT EXISTS (SELECT 1 FROM nodes WHERE id IN (SELECT id FROM tree) AND local_only != 0)",
        [id],
        |r| r.get::<_, bool>(0),
    )?)
}

fn refuse_private(ctx: &Ctx, node: &NodeMeta, what: &str) -> AppResult<()> {
    if !ctx.shares_local_only && holds_local_only(ctx.conn, &node.id)? {
        return Err(AppError::new(
            "NOT_ALLOWED",
            format!("\"{}\" holds scenes the writer keeps local only, so outside tools cannot {what} it.", node.title),
        ));
    }
    Ok(())
}

/// The node named by `id` or `title`.
fn target(ctx: &Ctx, args: &Value, kinds: &[&str]) -> AppResult<NodeMeta> {
    Ok(resolve_node(ctx, args, kinds)?.meta)
}

fn noun(kind: &str) -> &str {
    match kind {
        "part" => "part",
        "chapter" => "chapter",
        _ => "scene",
    }
}

/// Every scene of a book in reading order, hidden ones included, as the app merges them.
fn all_scenes(conn: &Connection, book_id: &str) -> AppResult<Vec<NodeMeta>> {
    let all = manuscript::tree(conn, book_id)?;
    fn walk(all: &[NodeMeta], parent: Option<&str>, out: &mut Vec<NodeMeta>) {
        for node in all.iter().filter(|n| n.parent_id.as_deref() == parent) {
            if node.kind == "scene" {
                out.push(node.clone());
            }
            walk(all, Some(&node.id), out);
        }
    }
    let mut out = Vec::new();
    walk(&all, None, &mut out);
    Ok(out)
}

fn siblings(conn: &Connection, book_id: &str, parent: Option<&str>) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM nodes WHERE book_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL
         ORDER BY position, created_at",
    )?;
    let rows = stmt.query_map(params![book_id, parent], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn nothing_changes() -> AppError {
    AppError::invalid("Nothing would change. Give at least one value that differs from what is there now.")
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

fn get_book_settings(ctx: &Ctx, args: &Value) -> AppResult<String> {
    let (book_id, _) = resolve_book(ctx, optional(args, "book"))?;
    let s = book_settings(ctx.conn, &book_id)?;
    let scenes: Vec<NodeMeta> = reading_order(ctx, &book_id)?.into_iter().filter(|n| n.kind == "scene").collect();
    let words: i64 = scenes.iter().map(|n| n.word_count).sum();
    let or_none = |v: &Value| match v.as_str() {
        Some("") | None => "(not set)".to_string(),
        Some(v) => v.to_string(),
    };
    let style = match (s["style"].as_str(), s["styleName"].as_str()) {
        (Some(""), _) | (None, _) => "(same as the project)".to_string(),
        (Some(id), Some(name)) if !name.is_empty() => format!("{name} ({id})"),
        (Some(id), _) => id.to_string(),
    };
    Ok(format!(
        "# {}\nId: {book_id}\nSubtitle: {}\nAuthor: {}\nWord goal: {}\nWords so far: {words} in {} scenes\nPoint of view: {}\nTense: {}\nWriting style: {style}\n",
        s["title"].as_str().unwrap_or(""),
        or_none(&s["subtitle"]),
        or_none(&s["author"]),
        match s["targetWords"].as_i64() { Some(n) if n > 0 => n.to_string(), _ => "(none)".into() },
        scenes.len(),
        or_none(&s["pov"]),
        or_none(&s["tense"]),
    ))
}

fn get_threads(ctx: &Ctx) -> AppResult<String> {
    let mut stmt = ctx.conn.prepare("SELECT id, name, description FROM threads ORDER BY position, name")?;
    let threads: Vec<(String, String, String)> =
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
    if threads.is_empty() {
        return Ok("There are no plot threads yet. Use create_thread to add one.".into());
    }
    let mut order: Vec<(NodeMeta, String)> = Vec::new();
    let mut books = ctx.conn.prepare("SELECT id, title FROM books WHERE deleted_at IS NULL ORDER BY position, created_at")?;
    let list: Vec<(String, String)> = books.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    for (book_id, title) in list {
        for node in reading_order(ctx, &book_id)?.into_iter().filter(|n| n.kind == "scene") {
            order.push((node, title.clone()));
        }
    }
    let mut out = String::from("# Plot threads\n");
    for (id, name, description) in threads {
        out.push_str(&format!("\n## {name}\nId: {id}\n"));
        if !description.trim().is_empty() {
            out.push_str(&format!("Description: {}\n", description.trim()));
        }
        let mut links = ctx.conn.prepare("SELECT node_id FROM node_threads WHERE thread_id = ?1")?;
        let linked: Vec<String> = links.query_map([&id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        let scenes: Vec<String> = order
            .iter()
            .filter(|(n, _)| linked.contains(&n.id))
            .map(|(n, book)| format!("- {} (id {}, in {book})", n.title, n.id))
            .collect();
        if scenes.is_empty() {
            out.push_str("No scenes yet.\n");
        } else {
            out.push_str("Scenes:\n");
            out.push_str(&scenes.join("\n"));
            out.push('\n');
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

/// The book fields the arguments set, checked. `before` leaves out those already so.
fn book_changes(args: &Value, before: Option<&Value>) -> AppResult<Map<String, Value>> {
    let mut changes = Map::new();
    let mut put = |key: &str, value: Value| {
        if before.is_none_or(|b| b[key] != value) {
            changes.insert(key.into(), value);
        }
    };
    for (arg, key) in [("subtitle", "subtitle"), ("author", "author")] {
        if let Some(v) = args.get(arg).and_then(Value::as_str) {
            if v.len() > MAX_LABEL * 2 {
                return Err(AppError::invalid(format!("{arg} is too long.")));
            }
            put(key, json!(v.trim()));
        }
    }
    if let Some(v) = args.get("target_words") {
        let n = v.as_i64().filter(|n| (0..=100_000_000).contains(n))
            .ok_or_else(|| AppError::invalid("target_words must be a whole number, 0 or more."))?;
        put("targetWords", json!(n));
    }
    for (arg, list) in [("pov", &POVS[..]), ("tense", &TENSES[..])] {
        if let Some(v) = args.get(arg).and_then(Value::as_str).map(str::trim) {
            if !v.is_empty() && !list.contains(&v) {
                return Err(AppError::invalid(format!("{arg} must be one of {}, or empty.", list.join(", "))));
            }
            put(arg, json!(v));
        }
    }
    if let Some(v) = args.get("style").and_then(Value::as_str).map(str::trim) {
        if v.len() > MAX_LABEL {
            return Err(AppError::invalid("style is too long."));
        }
        if before.is_none_or(|b| b["style"].as_str() != Some(v) && !b["styleName"].as_str().is_some_and(|n| !n.is_empty() && title_key(n) == title_key(v))) {
            changes.insert("style".into(), json!(v));
        }
    }
    check_meta_key(VOICE_KEY)?;
    check_meta_key(STYLE_KEY)?;
    Ok(changes)
}

fn create_book(_cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let title = label(args, "title", "The book")?;
    let changes = book_changes(args, None)?;
    let payload = json!({ "title": title, "changes": changes, "reason": reason(args) });
    Ok(Draft::new("bookCreate", title.clone(), payload)
        .suggested(format!(
            "Suggested a new book \"{title}\" (suggestion {{id}}). It does not exist yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("created the book \"{title}\".")))
}

fn update_book(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let (book_id, title, payload) = cx.read(|ctx| {
        let (book_id, title) = resolve_book(ctx, optional(args, "book"))?;
        let before = book_settings(ctx.conn, &book_id)?;
        let mut changes = book_changes(args, Some(&before))?;
        if args.get("new_title").and_then(Value::as_str).is_some() {
            let new_title = label(args, "new_title", "The book")?;
            if new_title != title {
                changes.insert("title".into(), json!(new_title));
            }
        }
        if changes.is_empty() {
            return Err(nothing_changes());
        }
        Ok((book_id, title, json!({ "changes": changes, "before": before, "reason": reason(args) })))
    })?;
    Ok(Draft::new("bookSettings", title.clone(), payload)
        .target("book", book_id)
        .done(format!("changed the settings of the book \"{title}\".")))
}

// ---------------------------------------------------------------------------
// Moving, renaming, status and details
// ---------------------------------------------------------------------------

fn fits(kind: &str, parent_kind: Option<&str>) -> bool {
    match kind {
        "part" => parent_kind.is_none(),
        "chapter" => matches!(parent_kind, None | Some("part")),
        _ => parent_kind == Some("chapter"),
    }
}

fn move_node(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let (id, title, payload) = cx.read(|ctx| {
        let conn = ctx.conn;
        let node = target(ctx, args, &ANY_NODE)?;
        refuse_private(ctx, &node, "move")?;
        let (before, after, into) = (optional(args, "before"), optional(args, "after"), optional(args, "into"));
        let given = [before, after, into].iter().filter(|v| !v.is_empty()).count();
        if given != 1 {
            return Err(AppError::invalid("Give exactly one of before, after or into."));
        }
        let mut to = Map::new();
        let parent: Option<NodeMeta> = if !into.is_empty() {
            if into.eq_ignore_ascii_case("book") {
                None
            } else {
                Some(node_ref(ctx, into, &["chapter", "part"])?.meta)
            }
        } else {
            let anchor = node_ref(ctx, if before.is_empty() { after } else { before }, &ANY_NODE)?.meta;
            if anchor.id == node.id {
                return Err(AppError::invalid("A node cannot go before or after itself."));
            }
            to.insert(if before.is_empty() { "afterId" } else { "beforeId" }.into(), json!(anchor.id));
            to.insert("anchorTitle".into(), json!(anchor.title));
            anchor.parent_id.as_deref().map(|p| manuscript::get_node(conn, p)).transpose()?.map(|n| n.meta)
        };
        if let Some(p) = &parent {
            if p.book_id != node.book_id {
                return Err(AppError::invalid("A node can only move within its own book."));
            }
            let mut up = Some(p.clone());
            while let Some(n) = up {
                if n.id == node.id {
                    return Err(AppError::invalid("A node cannot go inside itself."));
                }
                up = n.parent_id.as_deref().map(|id| manuscript::get_node(conn, id)).transpose()?.map(|n| n.meta);
            }
        }
        let parent_kind = parent.as_ref().map(|p| p.kind.as_str());
        if !fits(&node.kind, parent_kind) {
            return Err(AppError::invalid(format!(
                "A {} cannot go {}. Scenes go in chapters, chapters in parts or at the top, parts at the top.",
                noun(&node.kind),
                parent_kind.map_or("at the book's top level".to_string(), |k| format!("in a {k}")),
            )));
        }
        let parent_id = parent.as_ref().map(|p| p.id.clone());
        if !into.is_empty() {
            if let Some(n) = args.get("position") {
                let n = n.as_u64().filter(|n| *n >= 1).ok_or_else(|| AppError::invalid("position counts from 1."))?;
                to.insert("index".into(), json!(n - 1));
            }
        }
        to.insert("parentId".into(), json!(parent_id));
        to.insert("parentTitle".into(), json!(parent.as_ref().map(|p| p.title.clone())));
        let mut old = siblings(conn, &node.book_id, node.parent_id.as_deref())?;
        let index = old.iter().position(|s| s == &node.id).unwrap_or(0);
        old.retain(|s| s != &node.id);
        let from_title = match &node.parent_id {
            Some(p) => Some(manuscript::get_node(conn, p)?.meta.title),
            None => None,
        };
        let from = json!({ "parentId": node.parent_id, "parentTitle": from_title, "index": index });
        Ok((
            node.id.clone(),
            node.title.clone(),
            json!({ "kind": node.kind, "bookId": node.book_id, "from": from, "to": to, "reason": reason(args) }),
        ))
    })?;
    Ok(Draft::new("nodeMove", title.clone(), payload)
        .target("node", id)
        .done(format!("moved \"{title}\".")))
}

/// A change to a node's own fields, with the old values kept.
fn node_details(node: &manuscript::Node, changes: Map<String, Value>, args: &Value) -> AppResult<Draft> {
    if changes.is_empty() {
        return Err(nothing_changes());
    }
    let m = &node.meta;
    let before = json!({
        "title": m.title, "status": m.status, "synopsis": m.synopsis,
        "notes": node.notes, "targetWords": m.target_words,
    });
    let title = m.title.clone();
    let what = noun(&m.kind);
    Ok(Draft::new("nodeDetails", title.clone(), json!({ "kind": m.kind, "changes": changes, "before": before, "reason": reason(args) }))
        .target("node", m.id.clone())
        .done(format!("changed the {what} \"{title}\".")))
}

fn rename_node(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let new_title = label(args, "new_title", "It")?;
    cx.read(|ctx| {
        let node = resolve_node(ctx, args, &ANY_NODE)?;
        let mut changes = Map::new();
        if new_title != node.meta.title {
            changes.insert("title".into(), json!(new_title));
        }
        node_details(&node, changes, args)
    })
}

fn set_node_status(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let status = optional(args, "status");
    if !NODE_STATUSES.contains(&status) {
        return Err(AppError::invalid(format!("status must be one of {}.", NODE_STATUSES.join(", "))));
    }
    cx.read(|ctx| {
        let node = resolve_node(ctx, args, &ANY_NODE)?;
        let mut changes = Map::new();
        if status != node.meta.status {
            changes.insert("status".into(), json!(status));
        }
        node_details(&node, changes, args)
    })
}

fn set_chapter_details(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    cx.read(|ctx| {
        let node = resolve_node(ctx, args, &["chapter", "part"])?;
        let mut changes = Map::new();
        if let Some(v) = args.get("synopsis").and_then(Value::as_str) {
            check_size("synopsis", v)?;
            let v = cut(v.trim(), 4000);
            if v != node.meta.synopsis {
                changes.insert("synopsis".into(), json!(v));
            }
        }
        if let Some(v) = args.get("notes").and_then(Value::as_str) {
            check_size("notes", v)?;
            let v = cut(v.trim(), MAX_TEXT);
            if v != node.notes {
                changes.insert("notes".into(), json!(v));
            }
        }
        if let Some(v) = args.get("target_words") {
            let n = v.as_i64().filter(|n| (0..=100_000_000).contains(n))
                .ok_or_else(|| AppError::invalid("target_words must be a whole number, 0 or more."))?;
            if n != node.meta.target_words {
                changes.insert("targetWords".into(), json!(n));
            }
        }
        node_details(&node, changes, args)
    })
}

// ---------------------------------------------------------------------------
// The trash
// ---------------------------------------------------------------------------

fn trash_node(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let node = cx.read(|ctx| {
        let node = target(ctx, args, &ANY_NODE)?;
        refuse_private(ctx, &node, "move to the trash")?;
        Ok(node)
    })?;
    let title = node.title.clone();
    Ok(Draft::new("nodeTrash", title.clone(), json!({ "op": "trash", "kind": node.kind, "bookId": node.book_id, "reason": reason(args) }))
        .target("node", node.id)
        .done(format!("moved \"{title}\" to the trash. The writer can restore it from there.")))
}

/// A node in the trash, by id or title, unless hidden.
fn in_trash(ctx: &Ctx, args: &Value) -> AppResult<NodeMeta> {
    let id = optional(args, "id");
    let title = optional(args, "title");
    if id.is_empty() && title.is_empty() {
        return Err(AppError::invalid("Give the id or title of something in the trash."));
    }
    let mut stmt = ctx.conn.prepare(
        "SELECT n.id FROM nodes n JOIN books b ON b.id = n.book_id
         WHERE n.deleted_at IS NOT NULL AND b.deleted_at IS NULL ORDER BY n.deleted_at DESC",
    )?;
    let ids: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut found = Vec::new();
    for candidate in ids {
        if ctx.node_hidden(&candidate) {
            continue;
        }
        let node = manuscript::get_node(ctx.conn, &candidate)?.meta;
        if (!id.is_empty() && node.id == id) || (id.is_empty() && title_key(&node.title) == title_key(title)) {
            found.push(node);
        }
    }
    match found.len() {
        0 => Err(AppError::not_found("That item in the manuscript's trash")),
        1 => Ok(found.remove(0)),
        _ => Err(AppError::invalid(format!(
            "More than one item in the trash is called \"{title}\". Use an id: {}",
            found.iter().map(|n| n.id.as_str()).collect::<Vec<_>>().join(", ")
        ))),
    }
}

fn restore_node(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let node = cx.read(|ctx| {
        let node = in_trash(ctx, args)?;
        refuse_private(ctx, &node, "restore")?;
        if let Some(parent) = &node.parent_id {
            if manuscript::get_node(ctx.conn, parent)?.meta.deleted_at.is_some() {
                return Err(AppError::invalid("What held it is in the trash too. Restore that first."));
            }
        }
        Ok(node)
    })?;
    let title = node.title.clone();
    Ok(Draft::new("nodeTrash", title.clone(), json!({ "op": "restore", "kind": node.kind, "bookId": node.book_id, "reason": reason(args) }))
        .target("node", node.id)
        .done(format!("brought \"{title}\" back from the trash.")))
}

// ---------------------------------------------------------------------------
// Splitting and merging
// ---------------------------------------------------------------------------

fn split_scene(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let quote = optional(args, "quote");
    check_size("The quote", quote)?;
    let position = match optional(args, "position") {
        "" | "before" => "before",
        "after" => "after",
        _ => return Err(AppError::invalid("position must be before or after.")),
    };
    let new_title = match optional(args, "new_title") {
        "" => None,
        _ => Some(label(args, "new_title", "The new scene")?),
    };
    let (node, text) = cx.read(|ctx| {
        let node = resolve_node(ctx, args, &["scene"])?;
        let text = doc_to_text(&node.content);
        Ok((node.meta, text))
    })?;
    let hay = normalize_with_map(&text);
    let needle = needle_for(quote, &hay.text);
    if needle.is_empty() {
        return Err(AppError::invalid("The quote is empty. Copy a few words of the scene."));
    }
    let found = find_all(&hay.text, &needle);
    let title = node.title.clone();
    match found.len() {
        0 => return Err(AppError::new("QUOTE_NOT_FOUND", format!("The quote is not in \"{title}\". Read it with get_scene and copy a few words exactly."))),
        1 => {}
        n => return Err(AppError::new("QUOTE_NOT_UNIQUE", format!("The quote appears {n} times in \"{title}\". Quote more words so it is unique."))),
    }
    let at = if position == "before" { found[0] } else { found[0] + needle.len() };
    if hay.text[..at].trim().is_empty() || hay.text[at..].trim().is_empty() {
        return Err(AppError::invalid("That point is at the very start or end of the scene, so one half would be empty."));
    }
    Ok(Draft::new("sceneSplit", title.clone(), json!({
        "quote": quote, "position": position, "newTitle": new_title, "reason": reason(args),
    }))
    .target("node", node.id)
    .done(format!("split the scene \"{title}\" in two.")))
}

fn merge_scenes(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let (first, second) = cx.read(|ctx| {
        let first = node_ref(ctx, optional(args, "first"), &["scene"])?.meta;
        let second = node_ref(ctx, optional(args, "second"), &["scene"])?.meta;
        let order = all_scenes(ctx.conn, &first.book_id)?;
        let at = order.iter().position(|n| n.id == first.id);
        if at.and_then(|at| order.get(at + 1)).map(|n| n.id.as_str()) != Some(second.id.as_str()) {
            return Err(AppError::invalid(format!(
                "\"{}\" does not come straight after \"{}\". Only neighbouring scenes can be merged.",
                second.title, first.title
            )));
        }
        Ok((first, second))
    })?;
    let title = first.title.clone();
    Ok(Draft::new("sceneMerge", title.clone(), json!({
        "nextId": second.id, "nextTitle": second.title, "reason": reason(args),
    }))
    .target("node", first.id)
    .done(format!("merged \"{}\" into \"{title}\". The old scene is in the trash.", second.title)))
}

// ---------------------------------------------------------------------------
// Plot threads
// ---------------------------------------------------------------------------

struct Thread {
    id: String,
    name: String,
    color: String,
    description: String,
    position: i64,
}

fn find_thread(conn: &Connection, wanted: &str) -> AppResult<Thread> {
    if wanted.is_empty() {
        return Err(AppError::invalid("Give the thread's id or name."));
    }
    let mut stmt = conn.prepare("SELECT id, name, color, description, position FROM threads ORDER BY position")?;
    let all: Vec<Thread> = stmt
        .query_map([], |r| Ok(Thread { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, description: r.get(3)?, position: r.get(4)? }))?
        .collect::<Result<_, _>>()?;
    if let Some(i) = all.iter().position(|t| t.id == wanted) {
        return Ok(all.into_iter().nth(i).unwrap());
    }
    let mut named: Vec<Thread> = all.into_iter().filter(|t| title_key(&t.name) == title_key(wanted)).collect();
    match named.len() {
        0 => Err(AppError::not_found(format!("A plot thread called \"{wanted}\". See get_threads"))),
        1 => Ok(named.remove(0)),
        _ => Err(AppError::invalid(format!("More than one thread is called \"{wanted}\". Use an id from get_threads."))),
    }
}

fn thread_name(args: &Value, key: &str) -> AppResult<String> {
    let name = optional(args, key).split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(AppError::invalid("A thread needs a name."));
    }
    if name.len() > MAX_LABEL {
        return Err(AppError::invalid("That name is too long."));
    }
    Ok(name)
}

fn create_thread(_cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let name = thread_name(args, "name")?;
    let description = cut(optional(args, "description"), 4000).to_string();
    Ok(Draft::new("thread", name.clone(), json!({ "op": "create", "name": name, "description": description, "reason": reason(args) }))
        .done(format!("created the plot thread \"{name}\".")))
}

fn rename_thread(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let thread = cx.read(|ctx| find_thread(ctx.conn, optional(args, "thread")))?;
    let mut changes = Map::new();
    if args.get("new_name").and_then(Value::as_str).is_some() {
        let name = thread_name(args, "new_name")?;
        if name != thread.name {
            changes.insert("name".into(), json!(name));
        }
    }
    if let Some(d) = args.get("description").and_then(Value::as_str) {
        let d = cut(d.trim(), 4000);
        if d != thread.description {
            changes.insert("description".into(), json!(d));
        }
    }
    if changes.is_empty() {
        return Err(nothing_changes());
    }
    let before = json!({ "name": thread.name, "description": thread.description });
    let name = thread.name.clone();
    Ok(Draft::new("thread", name.clone(), json!({ "op": "update", "changes": changes, "before": before, "reason": reason(args) }))
        .target("meta", thread.id)
        .done(format!("changed the plot thread \"{name}\".")))
}

fn delete_thread(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let (thread, links) = cx.read(|ctx| {
        let thread = find_thread(ctx.conn, optional(args, "thread"))?;
        let mut stmt = ctx.conn.prepare("SELECT node_id FROM node_threads WHERE thread_id = ?1")?;
        let links: Vec<String> = stmt.query_map([&thread.id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok((thread, links))
    })?;
    let name = thread.name.clone();
    let before = json!({ "name": thread.name, "color": thread.color, "description": thread.description, "position": thread.position, "sceneIds": links });
    Ok(Draft::new("thread", name.clone(), json!({ "op": "delete", "before": before, "reason": reason(args) }))
        .target("meta", thread.id)
        .done(format!("deleted the plot thread \"{name}\". Its scenes are unchanged.")))
}

fn link_scene(cx: &WriteCx, args: &Value, on: bool) -> AppResult<Draft> {
    let (thread, scene) = cx.read(|ctx| {
        let thread = find_thread(ctx.conn, optional(args, "thread"))?;
        let scene = node_ref(ctx, optional(args, "scene"), &["scene"])?.meta;
        let linked: bool = ctx.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM node_threads WHERE node_id = ?1 AND thread_id = ?2)",
            params![scene.id, thread.id],
            |r| r.get(0),
        )?;
        if linked == on {
            return Err(AppError::invalid(if on { "That scene is already in that thread." } else { "That scene is not in that thread." }));
        }
        Ok((thread, scene))
    })?;
    let title = format!("{} / {}", thread.name, scene.title);
    let done = if on {
        format!("added \"{}\" to the thread \"{}\".", scene.title, thread.name)
    } else {
        format!("took \"{}\" out of the thread \"{}\".", scene.title, thread.name)
    };
    let book = cx.read(|ctx| book_title(ctx.conn, &scene.book_id))?;
    Ok(Draft::new("thread", title, json!({
        "op": "link", "on": on, "threadId": thread.id, "threadName": thread.name,
        "nodeId": scene.id, "sceneTitle": scene.title, "bookTitle": book, "reason": reason(args),
    }))
    .target("node", scene.id.clone())
    .done(done))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::mcp::config::PERMISSION_EDIT;
    use crate::mcp::suggest::{call, call_as, list, resolve, resolve_with, STATUS_APPLIED, STATUS_APPLYING, STATUS_AUTO, STATUS_PENDING};
    use crate::mcp::write::Waits;
    use crate::rpc::call as rpc;
    use std::sync::Arc;
    use std::time::Duration;

    struct P {
        engine: Arc<Engine>,
        _dir: crate::engine::TestDir,
        book: String,
        chapter: String,
        s1: String,
        s2: String,
        secret: String,
    }

    fn doc(text: &str) -> Value {
        json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }] })
    }

    /// Book One: Chapter 1 with Scene 1 ("The gate is old. Rain fell.") and Scene 2; Chapter 2
    /// with a local-only scene, Secret.
    fn project() -> P {
        let (engine, _host, dir) = Engine::for_test();
        rpc(&engine, "project.new", json!({ "name": "Ashfall" }));
        let book = rpc(&engine, "books.list", json!({}))[0]["id"].as_str().unwrap().to_string();
        let tree = rpc(&engine, "nodes.tree", json!({ "bookId": book }));
        let id_of = |kind: &str| tree.as_array().unwrap().iter().find(|n| n["kind"] == kind).unwrap()["id"].as_str().unwrap().to_string();
        let chapter = id_of("chapter");
        let s1 = id_of("scene");
        rpc(&engine, "nodes.update", json!({ "id": s1, "patch": { "content": doc("The gate is old. Rain fell.") } }));
        let make = |parent: Option<&str>, kind: &str, title: &str| {
            rpc(&engine, "nodes.create", json!({ "bookId": book, "parentId": parent, "kind": kind, "title": title }))["id"].as_str().unwrap().to_string()
        };
        let s2 = make(Some(&chapter), "scene", "Scene 2");
        let ch2 = make(None, "chapter", "Chapter 2");
        let secret = make(Some(&ch2), "scene", "Secret");
        engine.write(|tx| {
            tx.execute("UPDATE nodes SET local_only = 1 WHERE id = ?1", [&secret])?;
            tx.execute("INSERT INTO threads (id, name, description) VALUES ('t1', 'The succession', 'Who rules.')", [])?;
            Ok(())
        }).unwrap();
        P { engine, _dir: dir, book, chapter, s1, s2, secret }
    }

    fn pending(p: &P) -> Vec<Value> {
        p.engine.read(|c| list(c, STATUS_PENDING)).unwrap()
    }

    fn suggest(p: &P, tool: &str, args: Value) -> Value {
        let said = call(&p.engine, "c", tool, &args, false).unwrap_or_else(|e| panic!("{tool}: {}", e.message));
        assert!(said.contains("suggestion"), "{said}");
        pending(p).into_iter().last().unwrap()
    }

    fn fails(p: &P, tool: &str, args: Value) -> String {
        let err = call(&p.engine, "c", tool, &args, false).unwrap_err();
        assert!(pending(p).is_empty(), "{tool} stored something");
        err.message
    }

    #[test]
    fn reads_book_settings_and_threads() {
        let p = project();
        p.engine.write(|tx| {
            tx.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('books.voice', ?1)", [json!({ p.book.clone(): { "pov": "first", "tense": "past" } }).to_string()])?;
            tx.execute("INSERT INTO node_threads (node_id, thread_id) VALUES (?1, 't1'), (?2, 't1')", params![p.s1, p.secret])?;
            Ok(())
        }).unwrap();
        let read = |name: &str, args: Value| {
            p.engine.read(|c| {
                let ctx = Ctx::new(c, String::new(), true, false)?;
                crate::mcp::tools::call(&ctx, name, &args)
            }).unwrap()
        };
        let settings = read("get_book_settings", json!({}));
        assert!(settings.contains("Point of view: first") && settings.contains("Tense: past"), "{settings}");
        let threads = read("get_threads", json!({}));
        assert!(threads.contains("The succession") && threads.contains("Scene 1"), "{threads}");
        assert!(!threads.contains("Secret"), "{threads}");
    }

    #[test]
    fn create_and_update_book_queue_with_old_values() {
        let p = project();
        let row = suggest(&p, "create_book", json!({ "title": "Book Two", "pov": "first", "target_words": 80000 }));
        assert_eq!(row["kind"], "bookCreate");
        assert_eq!(row["payload"]["changes"]["pov"], "first");
        assert_eq!(rpc(&p.engine, "books.list", json!({})).as_array().unwrap().len(), 1);
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();

        let row = suggest(&p, "update_book", json!({ "new_title": "The Ash", "tense": "present", "style": "Plain" }));
        assert_eq!(row["kind"], "bookSettings");
        assert_eq!(row["targetId"], Value::String(p.book.clone()));
        assert_eq!(row["payload"]["changes"]["title"], "The Ash");
        assert_eq!(row["payload"]["before"]["title"], "Book One");
        assert_eq!(row["payload"]["before"]["tense"], "");
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();

        assert!(fails(&p, "update_book", json!({ "book": "Nope", "author": "x" })).contains("Nope"));
        assert!(fails(&p, "update_book", json!({ "new_title": "Book One" })).contains("Nothing would change"));
        assert!(fails(&p, "update_book", json!({ "pov": "fourth" })).contains("pov"));
        assert!(fails(&p, "create_book", json!({ "title": "  " })).contains("title"));
    }

    #[test]
    fn move_node_finds_its_place_and_keeps_where_it_was() {
        let p = project();
        let row = suggest(&p, "move_node", json!({ "id": p.s2, "before": p.s1 }));
        assert_eq!(row["kind"], "nodeMove");
        assert_eq!(row["payload"]["from"]["index"], 1);
        assert_eq!(row["payload"]["to"]["beforeId"], Value::String(p.s1.clone()));
        assert_eq!(row["payload"]["to"]["parentId"], Value::String(p.chapter.clone()));
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();
        let row = suggest(&p, "move_node", json!({ "title": "Chapter 1", "into": "book", "position": 2 }));
        assert_eq!(row["payload"]["to"]["index"], 1);
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();

        assert!(fails(&p, "move_node", json!({ "id": "nope", "before": p.s1 })).contains("id"));
        assert!(fails(&p, "move_node", json!({ "id": p.s1, "into": "book" })).contains("cannot go"));
        assert!(fails(&p, "move_node", json!({ "id": p.secret, "before": p.s1 })).contains("id"));
        // Chapter 2 holds a local-only scene.
        assert!(fails(&p, "move_node", json!({ "title": "Chapter 2", "into": "book", "position": 1 })).contains("local only"));
        assert!(fails(&p, "move_node", json!({ "id": p.s1, "before": p.secret })).contains(&p.secret));
    }

    #[test]
    fn rename_status_and_chapter_details_keep_the_old_values() {
        let p = project();
        let row = suggest(&p, "rename_node", json!({ "id": p.chapter, "new_title": "Opening" }));
        assert_eq!(row["kind"], "nodeDetails");
        assert_eq!(row["payload"]["changes"]["title"], "Opening");
        assert_eq!(row["payload"]["before"]["title"], "Chapter 1");
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();
        let row = suggest(&p, "set_node_status", json!({ "title": "Chapter 1", "status": "final" }));
        assert_eq!(row["payload"]["changes"]["status"], "final");
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();
        let row = suggest(&p, "set_chapter_details", json!({ "id": p.chapter, "synopsis": "It begins.", "target_words": 5000 }));
        assert_eq!(row["payload"]["changes"]["targetWords"], 5000);
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();

        assert!(fails(&p, "rename_node", json!({ "id": "nope", "new_title": "x" })).contains("id"));
        assert!(fails(&p, "rename_node", json!({ "id": p.secret, "new_title": "x" })).contains("id"));
        assert!(fails(&p, "set_node_status", json!({ "id": p.secret, "status": "final" })).contains("id"));
        assert!(fails(&p, "set_node_status", json!({ "id": p.s1, "status": "done" })).contains("status"));
        assert!(fails(&p, "set_chapter_details", json!({ "id": p.s1, "synopsis": "x" })).contains("id"));
        // Shared, the local-only scene can be renamed.
        let said = call(&p.engine, "c", "rename_node", &json!({ "id": p.secret, "new_title": "Open" }), true).unwrap();
        assert!(said.contains("suggestion"), "{said}");
    }

    #[test]
    fn trash_and_restore_never_purge() {
        let p = project();
        let row = suggest(&p, "trash_node", json!({ "id": p.s2 }));
        assert_eq!((row["kind"].as_str(), row["payload"]["op"].as_str()), (Some("nodeTrash"), Some("trash")));
        assert!(rpc(&p.engine, "nodes.get", json!({ "id": p.s2 }))["deletedAt"].is_null());
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();
        assert!(fails(&p, "trash_node", json!({ "title": "Chapter 2" })).contains("local only"));
        assert!(fails(&p, "trash_node", json!({ "id": p.secret })).contains("id"));
        assert!(fails(&p, "trash_node", json!({ "id": "nope" })).contains("id"));

        rpc(&p.engine, "nodes.delete", json!({ "id": p.s2 }));
        rpc(&p.engine, "nodes.delete", json!({ "id": p.secret }));
        let row = suggest(&p, "restore_node", json!({ "title": "Scene 2" }));
        assert_eq!(row["payload"]["op"], "restore");
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();
        assert!(fails(&p, "restore_node", json!({ "id": p.secret })).contains("trash"));
        assert!(fails(&p, "restore_node", json!({ "title": "Scene 1" })).contains("trash"));
    }

    #[test]
    fn split_and_merge_check_their_scenes() {
        let p = project();
        let row = suggest(&p, "split_scene", json!({ "id": p.s1, "quote": "Rain fell" }));
        assert_eq!(row["kind"], "sceneSplit");
        assert_eq!(row["payload"]["position"], "before");
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();
        assert!(fails(&p, "split_scene", json!({ "id": p.s1, "quote": "Snow" })).contains("not in"));
        assert!(fails(&p, "split_scene", json!({ "id": p.s1, "quote": "The gate" })).contains("start or end"));
        assert!(fails(&p, "split_scene", json!({ "id": p.secret, "quote": "x" })).contains("id"));

        let row = suggest(&p, "merge_scenes", json!({ "first": p.s1, "second": "Scene 2" }));
        assert_eq!(row["payload"]["nextId"], Value::String(p.s2.clone()));
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();
        assert!(fails(&p, "merge_scenes", json!({ "first": p.s2, "second": p.s1 })).contains("straight after"));
        assert!(fails(&p, "merge_scenes", json!({ "first": p.s2, "second": p.secret })).contains(&p.secret));
        assert!(fails(&p, "merge_scenes", json!({ "first": "nope", "second": p.s1 })).contains("nope"));
    }

    #[test]
    fn threads_are_created_renamed_deleted_and_linked() {
        let p = project();
        let row = suggest(&p, "create_thread", json!({ "name": "The war", "description": "Who wins." }));
        assert_eq!(row["payload"]["op"], "create");
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();
        let row = suggest(&p, "rename_thread", json!({ "thread": "the succession", "new_name": "The crown" }));
        assert_eq!(row["payload"]["before"]["name"], "The succession");
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();
        p.engine.write(|tx| {
            tx.execute("INSERT INTO node_threads (node_id, thread_id) VALUES (?1, 't1')", [&p.s1])?;
            Ok(())
        }).unwrap();
        let row = suggest(&p, "delete_thread", json!({ "thread": "t1" }));
        assert_eq!(row["payload"]["before"]["sceneIds"], json!([p.s1]));
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();
        let row = suggest(&p, "add_scene_to_thread", json!({ "thread": "t1", "scene": p.s2 }));
        assert_eq!((row["payload"]["on"].as_bool(), row["payload"]["nodeId"].as_str()), (Some(true), Some(p.s2.as_str())));
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();
        let row = suggest(&p, "remove_scene_from_thread", json!({ "thread": "t1", "scene": p.s1 }));
        assert_eq!(row["payload"]["on"], false);
        p.engine.write(|tx| resolve(tx, row["id"].as_str().unwrap(), "rejected")).unwrap();

        assert!(fails(&p, "add_scene_to_thread", json!({ "thread": "t1", "scene": p.s1 })).contains("already"));
        assert!(fails(&p, "add_scene_to_thread", json!({ "thread": "t1", "scene": p.secret })).contains(&p.secret));
        assert!(fails(&p, "delete_thread", json!({ "thread": "Nope" })).contains("Nope"));
        assert!(fails(&p, "rename_thread", json!({ "thread": "t1", "new_name": "The succession" })).contains("Nothing"));
    }

    #[test]
    fn at_the_edit_level_a_move_waits_for_the_window() {
        let p = project();
        let engine = p.engine.clone();
        let window = std::thread::spawn(move || {
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(15));
                let waiting = engine.read(|c| list(c, STATUS_AUTO)).unwrap();
                if let Some(row) = waiting.first() {
                    let id = row["id"].as_str().unwrap().to_string();
                    assert!(engine.write(|tx| resolve(tx, &id, STATUS_APPLYING)).unwrap());
                    let mut extra = Map::new();
                    extra.insert("undo".into(), json!({ "index": 0 }));
                    assert!(engine.write(|tx| resolve_with(tx, &id, STATUS_APPLIED, &extra)).unwrap());
                    return;
                }
            }
        });
        let waits = Waits { claim: Duration::from_millis(600), apply: Duration::from_millis(1500), poll: Duration::from_millis(20) };
        let said = call_as(&p.engine, "c", "move_node", &json!({ "id": p.s2, "before": p.s1 }), false, PERMISSION_EDIT, waits).unwrap();
        window.join().unwrap();
        assert!(said.starts_with("Done: moved \"Scene 2\""), "{said}");
        assert_eq!(p.engine.read(|c| list(c, STATUS_APPLIED)).unwrap().len(), 1);
        // Nothing waits for the window, so a later change goes back to the writer.
        let said = call_as(&p.engine, "c", "trash_node", &json!({ "id": p.s2 }), false, PERMISSION_EDIT, waits).unwrap();
        assert!(said.contains("did not respond"), "{said}");
        assert_eq!(pending(&p).len(), 1);
    }
}
