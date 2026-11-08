//! New scenes and chapters, and a scene's details.

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use super::{write, Tool};
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{check_size, label, node_ref, optional, page_ref, reading_order, reason, resolve_book, scene_people, string_list, MAX_LABEL, MAX_TEXT};
use crate::mcp::text::cut;
use crate::mcp::tools::resolve_scene_id;
use crate::mcp::write::{Draft, WriteCx};
use crate::rpc::manuscript;

pub fn tools() -> Vec<Tool> {
    vec![
        write(
            "propose_new_scene",
            "Suggest a new scene, with its text. It goes after the scene you name, or at the end of a chapter, or at the end of the book. Pages for pov, location and cast are named by title. Depending on the writer's setting, it waits for them to accept it, or is created at once. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "title": { "type": "string", "description": "The new scene's title." },
                "after": { "type": "string", "description": "A scene id or title to put it after." },
                "chapter": { "type": "string", "description": "A chapter id or title. Without after, the scene goes at its end." },
                "book": { "type": "string", "description": "A book title or id. Without after or chapter, it goes in the book's last chapter." },
                "text": { "type": "string", "description": "The scene text, as Markdown. A blank line starts a new paragraph." },
                "synopsis": { "type": "string", "description": "One or two sentences." },
                "pov": { "type": "string", "description": "The point-of-view character's page title." },
                "location": { "type": "string", "description": "The place's page title." },
                "cast": { "type": "array", "items": { "type": "string" }, "description": "Page titles of the characters in it." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["title"] }),
            propose_new_scene,
        ),
        write(
            "propose_new_chapter",
            "Suggest a new chapter with its first scene. It goes after the chapter you name, or at the end of the book. text is the first scene's text. Depending on the writer's setting, it waits for them to accept it, or is created at once. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "title": { "type": "string", "description": "The new chapter's title." },
                "after": { "type": "string", "description": "A chapter id or title to put it after." },
                "book": { "type": "string", "description": "A book title or id. Without after, it goes at the book's end." },
                "synopsis": { "type": "string", "description": "The chapter's synopsis." },
                "scene_title": { "type": "string", "description": "The first scene's title. Default the chapter title." },
                "scene_synopsis": { "type": "string", "description": "The first scene's synopsis." },
                "text": { "type": "string", "description": "The first scene's text, as Markdown." },
                "pov": { "type": "string", "description": "The first scene's point-of-view page title." },
                "location": { "type": "string", "description": "The first scene's place page title." },
                "cast": { "type": "array", "items": { "type": "string" }, "description": "Page titles of the characters in the first scene." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["title"] }),
            propose_new_chapter,
        ),
        write(
            "propose_scene_details",
            "Suggest changes to a scene's details: title, synopsis, point of view, location, cast, status, story date or notes. Give only the fields to change. An empty pov or location clears it. cast replaces the whole list. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The scene id. Used instead of the title." },
                "title": { "type": "string", "description": "The scene title, to find it." },
                "new_title": { "type": "string", "description": "A new title for the scene." },
                "synopsis": { "type": "string" },
                "pov": { "type": "string", "description": "A page title." },
                "location": { "type": "string", "description": "A page title." },
                "cast": { "type": "array", "items": { "type": "string" }, "description": "Page titles." },
                "status": { "type": "string", "enum": ["idea", "outline", "draft", "revised", "final"] },
                "story_date": { "type": "string", "description": "The in-world date, as free text." },
                "notes": { "type": "string", "description": "The scene's notes. Replaces them." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }}),
            propose_scene_details,
        ),
    ]
}

fn propose_new_scene(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let title = label(args, "title", "The scene")?;
    let text = optional(args, "text");
    check_size("The text", text)?;
    let (payload, chapter_id, chapter_title) = cx.read(|ctx| {
        let conn = ctx.conn;
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
    Ok(Draft::new("newScene", title.clone(), Value::Object(payload))
        .target("node", chapter_id)
        .suggested(format!(
            "Suggested a new scene \"{title}\" in \"{chapter_title}\" (suggestion {{id}}). It does not exist yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("added the scene \"{title}\" to \"{chapter_title}\".")))
}

fn propose_new_chapter(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let title = label(args, "title", "The chapter")?;
    let text = optional(args, "text");
    check_size("The text", text)?;
    let scene_title = match optional(args, "scene_title") {
        "" => title.clone(),
        _ => label(args, "scene_title", "The scene")?,
    };
    let (payload, book_id) = cx.read(|ctx| {
        let conn = ctx.conn;
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
    Ok(Draft::new("newChapter", title.clone(), Value::Object(payload))
        .target("book", book_id)
        .suggested(format!(
            "Suggested a new chapter \"{title}\" (suggestion {{id}}). It does not exist yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("added the chapter \"{title}\".")))
}

fn propose_scene_details(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let (id, title, payload) = cx.read(|ctx| {
        let conn = ctx.conn;
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
    Ok(Draft::new("sceneDetails", title.clone(), payload)
        .target("node", id)
        .done(format!("changed the details of the scene \"{title}\".")))
}
