//! The media library: what pictures and videos there are, and their labels.
//!
//! A label and a description (alt text) belong to the asset, as the library sets them. A
//! figure's own caption is left as it is. An asset used only in local-only pages or scenes
//! is not there for the client, and its uses there are never listed.

use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use super::{read, write, Tool};
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{optional, reason, required, MAX_LABEL};
use crate::mcp::tools::Ctx;
use crate::mcp::write::{Draft, WriteCx};

pub const MAX_DESCRIPTION: usize = 2000;

pub fn tools() -> Vec<Tool> {
    vec![
        read(
            "list_media",
            "List the project's pictures, videos and other media: each one's id, kind, label, description (alt text) and the pages, scenes, maps and canvases that use it.",
            json!({ "type": "object", "properties": {
                "kind": { "type": "string", "enum": ["image", "video", "audio", "pdf"], "description": "Only this kind." },
                "unlabelled": { "type": "boolean", "description": "Only those with no label or no description." },
                "limit": { "type": "integer", "description": "At most this many. Default 100." },
            }}),
            list_media,
        ),
        write(
            "label_media",
            "Set a picture or video's label and description (alt text) in the media library. Give either or both; the other stays. Figures that have their own caption keep it. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The media id, from list_media." },
                "label": { "type": "string", "description": "A short label, such as \"Map of the north\"." },
                "description": { "type": "string", "description": "What it shows, for someone who cannot see it." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["id"] }),
            label_media,
        ),
    ]
}

struct Item {
    id: String,
    name: String,
    kind: String,
    label: String,
    description: String,
}

fn has_assets(ctx: &Ctx) -> AppResult<bool> {
    Ok(ctx
        .conn
        .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets'", [], |_| Ok(()))
        .optional()?
        .is_some())
}

fn strings(ctx: &Ctx, sql: &str, id: &str) -> AppResult<Vec<(String, String)>> {
    let mut stmt = ctx.conn.prepare(sql)?;
    let rows = stmt.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Where an asset is used, as the client may see it, and whether a hidden page or scene uses it.
fn uses_of(ctx: &Ctx, id: &str) -> AppResult<(Vec<String>, bool)> {
    let mut out = Vec::new();
    let mut hidden = false;
    for (page, title) in strings(
        ctx,
        "SELECT id, title FROM pages WHERE deleted_at IS NULL AND (instr(content, ?1) > 0 OR instr(infobox, ?1) > 0) ORDER BY title_key",
        id,
    )? {
        if ctx.page_hidden(&page) {
            hidden = true;
        } else {
            out.push(format!("page \"{title}\""));
        }
    }
    for (node, title) in strings(
        ctx,
        "SELECT id, title FROM nodes WHERE deleted_at IS NULL AND instr(content, ?1) > 0 ORDER BY book_id, position",
        id,
    )? {
        if ctx.node_hidden(&node) {
            hidden = true;
        } else {
            out.push(format!("scene \"{title}\""));
        }
    }
    for (_, title) in strings(ctx, "SELECT id, title FROM maps WHERE deleted_at IS NULL AND asset_id = ?1 ORDER BY title", id)? {
        out.push(format!("map \"{title}\""));
    }
    if super::canvas::has_canvases(ctx)? {
        let card = format!("lorecraft:asset/{id}");
        for (_, title) in strings(ctx, "SELECT id, title FROM canvases WHERE deleted_at IS NULL AND instr(data, ?1) > 0 ORDER BY title_key", &card)? {
            out.push(format!("canvas \"{title}\""));
        }
    }
    Ok((out, hidden))
}

fn items(ctx: &Ctx, id: Option<&str>) -> AppResult<Vec<Item>> {
    if !has_assets(ctx)? {
        return Ok(Vec::new());
    }
    let mut stmt = ctx.conn.prepare(
        "SELECT id, name, kind, label, description FROM assets
         WHERE complete = 1 AND (?1 IS NULL OR id = ?1) ORDER BY created_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([id], |r| {
        Ok(Item { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, label: r.get(3)?, description: r.get(4)? })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn kind_word(kind: &str) -> &str {
    match kind {
        "image" => "picture",
        "video" => "video",
        "audio" => "sound",
        "pdf" => "PDF",
        _ => "file",
    }
}

fn list_media(ctx: &Ctx, args: &Value) -> AppResult<String> {
    let kind = optional(args, "kind").trim();
    let unlabelled = args.get("unlabelled").and_then(Value::as_bool) == Some(true);
    let limit = crate::mcp::tools::arg_usize(args, "limit").unwrap_or(100).clamp(1, 1000);
    let mut out = String::new();
    let mut count = 0;
    let mut more = false;
    for item in items(ctx, None)? {
        if (!kind.is_empty() && item.kind != kind) || (unlabelled && !item.label.is_empty() && !item.description.is_empty()) {
            continue;
        }
        let (uses, hidden) = uses_of(ctx, &item.id)?;
        // Used only where the client may not look: as if it were not there.
        if hidden && uses.is_empty() {
            continue;
        }
        if count == limit {
            more = true;
            break;
        }
        count += 1;
        out.push_str(&format!("- {} {} (id {}), file {}\n", kind_word(&item.kind), quoted(&item.label), item.id, item.name));
        out.push_str(&format!(
            "  Description: {}\n",
            if item.description.trim().is_empty() { "(none)".to_string() } else { item.description.trim().to_string() }
        ));
        out.push_str(&format!("  Used in: {}\n", if uses.is_empty() { "nothing".to_string() } else { uses.join(", ") }));
    }
    if count == 0 {
        return Ok("There is no media to list.".to_string());
    }
    let noun = if count == 1 { "item" } else { "items" };
    let mut head = format!("{count} media {noun}:\n");
    if more {
        out.push_str("(More not shown. Raise limit to see them.)\n");
    }
    head.push_str(&out);
    Ok(head)
}

fn quoted(label: &str) -> String {
    if label.trim().is_empty() {
        "with no label".to_string()
    } else {
        format!("\"{}\"", label.trim())
    }
}

fn clean(value: &str, max: usize, what: &str) -> AppResult<String> {
    let value = value.trim().to_string();
    if value.chars().count() > max {
        return Err(AppError::invalid(format!("That {what} is too long. Keep it under {max} characters.")));
    }
    Ok(value)
}

fn label_media(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let id = required(args, "id")?.trim().to_string();
    let label = args.get("label").and_then(Value::as_str).map(|l| clean(&l.split_whitespace().collect::<Vec<_>>().join(" "), MAX_LABEL, "label")).transpose()?;
    let description = args.get("description").and_then(Value::as_str).map(|d| clean(d, MAX_DESCRIPTION, "description")).transpose()?;
    if label.is_none() && description.is_none() {
        return Err(AppError::invalid("Give a label, a description or both."));
    }
    let item = cx.read(|ctx| {
        let item = items(ctx, Some(&id))?.pop().ok_or_else(|| AppError::not_found("That picture or video"))?;
        let (uses, hidden) = uses_of(ctx, &id)?;
        if hidden && uses.is_empty() {
            return Err(AppError::not_found("That picture or video"));
        }
        Ok(item)
    })?;
    let label = label.unwrap_or_else(|| item.label.clone());
    let description = description.unwrap_or_else(|| item.description.clone());
    if label == item.label && description == item.description {
        return Err(AppError::invalid("Nothing would change."));
    }
    let title = if label.is_empty() { item.name.clone() } else { label.clone() };
    let payload = json!({
        "assetId": item.id,
        "name": item.name,
        "mediaKind": item.kind,
        "label": label,
        "description": description,
        "before": { "label": item.label, "description": item.description },
        "reason": reason(args),
    });
    Ok(Draft::new("mediaLabel", title.clone(), payload).done(format!("labelled the {} \"{title}\".", kind_word(&item.kind))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Engine, TestDir};
    use crate::mcp::config::PERMISSION_EDIT;
    use crate::mcp::suggest::{self, call, call_as, STATUS_APPLIED, STATUS_APPLYING, STATUS_AUTO, STATUS_PENDING};
    use crate::mcp::write::Waits;
    use crate::rpc::call as rpc;
    use serde_json::Map;
    use std::sync::Arc;
    use std::time::Duration;

    struct Project {
        engine: Arc<Engine>,
        _dir: TestDir,
    }

    fn figure(id: &str) -> Value {
        json!({ "type": "doc", "content": [{ "type": "figure", "attrs": { "assetId": id }, "content": [{ "type": "image", "attrs": { "assetId": id } }] }] })
    }

    /// Three pictures: one used in a page, one only in a local-only page, one unused.
    fn project() -> Project {
        let (engine, _host, dir) = Engine::for_test();
        rpc(&engine, "project.new", json!({ "name": "Ashfall" }));
        engine
            .write(|tx| {
                for (id, name) in [("img-open", "north.png"), ("img-secret", "twist.png"), ("img-free", "spare.png")] {
                    tx.execute(
                        "INSERT INTO assets (id, name, mime, kind, size, chunk_size, complete, created_at, label)
                         VALUES (?1, ?2, 'image/png', 'image', 10, 10, 1, '2026-01-01', '')",
                        [id, name],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        rpc(&engine, "pages.create", json!({ "title": "The North", "content": figure("img-open") }));
        let secret = rpc(&engine, "pages.create", json!({ "title": "Twist", "content": figure("img-secret") }))["id"].as_str().unwrap().to_string();
        rpc(&engine, "pages.update", json!({ "id": secret, "patch": { "localOnly": true } }));
        Project { engine, _dir: dir }
    }

    fn list(p: &Project, args: Value, share: bool) -> String {
        p.engine.read(|conn| list_media(&Ctx::new(conn, "Ashfall".into(), true, share)?, &args)).unwrap()
    }

    #[test]
    fn list_media_names_uses_and_hides_what_only_local_only_pages_use() {
        let p = project();
        let out = list(&p, json!({}), false);
        assert!(out.starts_with("2 media items"), "{out}");
        assert!(out.contains("img-open") && out.contains("page \"The North\""), "{out}");
        assert!(out.contains("img-free") && out.contains("Used in: nothing"), "{out}");
        assert!(!out.contains("img-secret") && !out.contains("Twist"), "{out}");
        assert!(list(&p, json!({}), true).contains("img-secret"));
        assert_eq!(list(&p, json!({ "kind": "video" }), false), "There is no media to list.");
    }

    #[test]
    fn label_media_keeps_the_old_words_and_queues_at_the_suggest_level() {
        let p = project();
        let said = call(&p.engine, "c", "label_media", &json!({ "id": "img-open", "label": "Map of the north", "description": "A hand-drawn map." }), false).unwrap();
        assert!(said.contains("Nothing has changed yet"), "{said}");
        let row = p.engine.read(|c| suggest::list(c, STATUS_PENDING)).unwrap().pop().unwrap();
        assert_eq!(row["kind"], "mediaLabel");
        assert_eq!(row["payload"]["assetId"], "img-open");
        assert_eq!(row["payload"]["label"], "Map of the north");
        assert_eq!(row["payload"]["before"]["label"], "");
        // Nothing has changed in the library.
        let label: String = p.engine.read(|c| Ok(c.query_row("SELECT label FROM assets WHERE id = 'img-open'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(label, "");
        assert_eq!(call(&p.engine, "c", "label_media", &json!({ "id": "img-open" }), false).unwrap_err().code, "INVALID");
    }

    #[test]
    fn label_media_refuses_missing_and_local_only_media() {
        let p = project();
        assert_eq!(call(&p.engine, "c", "label_media", &json!({ "id": "nope", "label": "x" }), false).unwrap_err().code, "NOT_FOUND");
        assert_eq!(call(&p.engine, "c", "label_media", &json!({ "id": "img-secret", "label": "x" }), false).unwrap_err().code, "NOT_FOUND");
        assert!(call(&p.engine, "c", "label_media", &json!({ "id": "img-secret", "label": "x" }), true).is_ok());
        assert_eq!(p.engine.read(suggest::pending_count).unwrap(), 1);
    }

    #[test]
    fn at_the_edit_level_labelling_says_done() {
        let p = project();
        let engine = p.engine.clone();
        let helper = std::thread::spawn(move || {
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(15));
                if let Some(row) = engine.read(|c| suggest::list(c, STATUS_AUTO)).unwrap().first() {
                    let id = row["id"].as_str().unwrap().to_string();
                    engine.write(|tx| suggest::resolve(tx, &id, STATUS_APPLYING)).unwrap();
                    engine.write(|tx| suggest::resolve_with(tx, &id, STATUS_APPLIED, &Map::new())).unwrap();
                    return;
                }
            }
        });
        let waits = Waits { claim: Duration::from_millis(600), apply: Duration::from_millis(1500), poll: Duration::from_millis(20) };
        let said = call_as(&p.engine, "c", "label_media", &json!({ "id": "img-free", "description": "Spare." }), false, PERMISSION_EDIT, waits).unwrap();
        helper.join().unwrap();
        assert_eq!(said, "Done: labelled the picture \"spare.png\".");
    }
}
