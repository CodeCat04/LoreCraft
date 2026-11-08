//! Changing the wiki: a page's details and infobox, renaming, the trash, Talk notes,
//! relationships and map pins. Each tool returns a `Draft` with the old values, so the app
//! can undo it. Plus a few reads that help find what to change.
//!
//! A local-only page is hidden unless the writer shares it, and even then these tools
//! refuse to rename, trash or change it.

use std::collections::BTreeMap;

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use super::{read, write, Tool};
use crate::content::title_key;
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{check_size, optional, reason, required, string_list, MAX_LABEL};
use crate::mcp::text::cut;
use crate::mcp::tools::{resolve_page, Ctx};
use crate::mcp::write::{Draft, WriteCx};
use crate::rpc::pages;

const FIELD_KINDS: [&str; 6] = ["text", "longtext", "date", "number", "page", "pages"];
const MAX_VALUE: usize = 4000;
const MAX_NOTE: usize = 20_000;

fn page_arg() -> Value {
    json!({ "type": "string", "description": "The page title or an alias." })
}

fn id_arg() -> Value {
    json!({ "type": "string", "description": "The page id, if known. Used instead of the title." })
}

pub fn tools() -> Vec<Tool> {
    vec![
        write(
            "update_page",
            "Change a wiki page's summary, status, page type, aliases or categories. Give only what should change. Aliases and categories can be set as a whole list, or have names added or removed. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "title": page_arg(), "id": id_arg(),
                "summary": { "type": "string", "description": "The new one-line summary." },
                "status": { "type": "string", "enum": pages::STATUSES, "description": "canon, draft, idea or retconned." },
                "page_type": { "type": "string", "description": "The page type, such as character or place. See list_page_types." },
                "aliases": { "type": "array", "items": { "type": "string" }, "description": "Replaces all the aliases." },
                "add_aliases": { "type": "array", "items": { "type": "string" } },
                "remove_aliases": { "type": "array", "items": { "type": "string" } },
                "categories": { "type": "array", "items": { "type": "string" }, "description": "Replaces all the categories." },
                "add_categories": { "type": "array", "items": { "type": "string" } },
                "remove_categories": { "type": "array", "items": { "type": "string" } },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }}),
            update_page,
        ),
        write(
            "set_infobox_fields",
            "Set, rename or remove fields in a page's infobox. Fields are matched by label or key, ignoring case. A field keeps its place; new ones go at the end. kind can be text, longtext, date, number, page (one page title) or pages (titles separated by commas). Date fields are what the timeline shows, and the parents, spouse and children fields are kept in step with family relationships. With replace_all, the infobox becomes exactly the fields given. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "title": page_arg(), "id": id_arg(),
                "fields": { "type": "array", "description": "The fields to change.", "items": { "type": "object", "properties": {
                    "label": { "type": "string", "description": "The field's label or key, such as Born." },
                    "value": { "type": "string", "description": "The new value. Leave out to keep it." },
                    "kind": { "type": "string", "enum": FIELD_KINDS },
                    "new_label": { "type": "string", "description": "Renames the field." },
                    "remove": { "type": "boolean", "description": "Removes the field." },
                }, "required": ["label"] } },
                "replace_all": { "type": "boolean", "description": "Make the infobox exactly these fields, in this order. Default false." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["fields"] }),
            set_infobox_fields,
        ),
        write(
            "rename_page",
            "Rename a wiki page. By default, links to it in other pages and scenes are changed to the new title, and the old title is kept as an alias. Says how many documents have links that will change. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "title": page_arg(), "id": id_arg(),
                "new_title": { "type": "string", "description": "The new title." },
                "update_links": { "type": "boolean", "description": "Change links to the new title. Default true." },
                "keep_alias": { "type": "boolean", "description": "Keep the old title as an alias. Default true." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["new_title"] }),
            rename_page,
        ),
        write(
            "trash_page",
            "Move a wiki page to the trash. It can be restored with restore_page; nothing is deleted for good. The main page cannot be trashed. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "title": page_arg(), "id": id_arg(),
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }}),
            trash_page,
        ),
        write(
            "restore_page",
            "Bring a wiki page back from the trash. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "title": { "type": "string", "description": "The trashed page's title." },
                "id": { "type": "string", "description": "The trashed page's id." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }}),
            restore_page,
        ),
        write(
            "add_talk_note",
            "Add a note to the end of a page's Talk tab, the writer's notes about the page. It does not change the article. The note is Markdown. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "title": page_arg(), "id": id_arg(),
                "text": { "type": "string", "description": "The note, as Markdown." },
            }, "required": ["text"] }),
            add_talk_note,
        ),
        write(
            "add_relationship",
            "Record a relationship between two wiki pages, such as ally, rival, parent of or member of. It shows on both pages and in the graph. A parent of or spouse relationship also fills in the family fields of both infoboxes. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "from": { "type": "string", "description": "The first page's title." },
                "to": { "type": "string", "description": "The second page's title." },
                "kind": { "type": "string", "description": "How from relates to to, such as parent of, spouse, ally or located in." },
                "note": { "type": "string", "description": "A short note about it." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["from", "to", "kind"] }),
            add_relationship,
        ),
        write(
            "remove_relationship",
            "Remove a recorded relationship between two wiki pages, in either direction. Give kind when they have more than one. Family fields follow. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "from": { "type": "string", "description": "One page's title." },
                "to": { "type": "string", "description": "The other page's title." },
                "kind": { "type": "string", "description": "The relationship's kind, if they have more than one." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["from", "to"] }),
            remove_relationship,
        ),
        write(
            "add_map_pin",
            "Put a pin on one of the writer's maps, for a page or as a plain label. x and y run from 0 (left, top) to 1 (right, bottom). See list_maps. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "map": { "type": "string", "description": "The map's title or id." },
                "page": { "type": "string", "description": "The page the pin stands for." },
                "label": { "type": "string", "description": "A label, for a pin with no page." },
                "x": { "type": "number", "minimum": 0, "maximum": 1 },
                "y": { "type": "number", "minimum": 0, "maximum": 1 },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["map", "x", "y"] }),
            add_map_pin,
        ),
        write(
            "move_map_pin",
            "Move a pin on a map. Name it by pin id, or by map and page or label. x and y run from 0 to 1. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "pin": { "type": "string", "description": "The pin id, from list_maps." },
                "map": { "type": "string", "description": "The map's title or id." },
                "page": { "type": "string", "description": "The pinned page's title." },
                "label": { "type": "string", "description": "The pin's label." },
                "x": { "type": "number", "minimum": 0, "maximum": 1 },
                "y": { "type": "number", "minimum": 0, "maximum": 1 },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["x", "y"] }),
            move_map_pin,
        ),
        write(
            "remove_map_pin",
            "Take a pin off a map. Name it by pin id, or by map and page or label. The page itself is not changed. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "pin": { "type": "string", "description": "The pin id, from list_maps." },
                "map": { "type": "string", "description": "The map's title or id." },
                "page": { "type": "string", "description": "The pinned page's title." },
                "label": { "type": "string", "description": "The pin's label." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }}),
            remove_map_pin,
        ),
        read(
            "list_categories",
            "List the wiki's categories and how many pages are in each.",
            json!({ "type": "object", "properties": {} }),
            list_categories,
        ),
        read(
            "list_page_types",
            "List the page types in use and the writer's own types, with the infobox fields each one uses (label, key and kind).",
            json!({ "type": "object", "properties": {} }),
            list_page_types,
        ),
        read(
            "get_page_history",
            "List the saved versions of a wiki page in its History tab, newest first, with when and why each was saved.",
            json!({ "type": "object", "properties": {
                "title": page_arg(), "id": id_arg(),
                "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Default 30." },
            }}),
            get_page_history,
        ),
        read(
            "list_maps",
            "List the writer's maps with their pins: each pin's id, page or label, and position from 0 to 1.",
            json!({ "type": "object", "properties": {
                "map": { "type": "string", "description": "Only this map, by title or id." },
            }}),
            list_maps,
        ),
    ]
}

// ---------------------------------------------------------------------------
// Finding pages
// ---------------------------------------------------------------------------

pub const LOCAL_ONLY: &str = "That page is local only, so outside tools cannot change, rename or trash it. The writer can change it in LoreCraft.";

fn refuse_local_only(ctx: &Ctx, id: &str) -> AppResult<()> {
    let local: i64 = ctx
        .conn
        .query_row("SELECT local_only FROM pages WHERE id = ?1", [id], |r| r.get(0))?;
    if local != 0 {
        return Err(AppError::new("NOT_ALLOWED", LOCAL_ONLY));
    }
    Ok(())
}

/// A live page this client may change: found by id, title or alias, and not local only.
fn changeable_page(ctx: &Ctx, args: &Value) -> AppResult<pages::Page> {
    let id = resolve_page(ctx, args)?;
    refuse_local_only(ctx, &id)?;
    pages::get_page(ctx.conn, &id)
}

/// A page named by title, alias or id, for the far end of a relationship or a pin.
fn named_page(ctx: &Ctx, value: &str) -> AppResult<(String, String)> {
    let id = resolve_page(ctx, &json!({ "title": value }))
        .or_else(|_| resolve_page(ctx, &json!({ "id": value })))?;
    refuse_local_only(ctx, &id)?;
    let title: String = ctx.conn.query_row("SELECT title FROM pages WHERE id = ?1", [&id], |r| r.get(0))?;
    Ok((id, title))
}

// ---------------------------------------------------------------------------
// update_page
// ---------------------------------------------------------------------------

fn clean(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A list after `set`, `add_` and `remove_`, compared ignoring case. None if not mentioned.
fn edited_list(args: &Value, name: &str, before: &[String]) -> Option<Vec<String>> {
    let set = args.get(name).is_some();
    let add = string_list(args, &format!("add_{name}"));
    let remove = string_list(args, &format!("remove_{name}"));
    if !set && add.is_empty() && remove.is_empty() {
        return None;
    }
    let mut list: Vec<String> = if set { string_list(args, name) } else { before.to_vec() };
    list.extend(add);
    let removed: Vec<String> = remove.iter().map(|r| title_key(r)).collect();
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for item in list.iter().map(|s| clean(s)) {
        let key = title_key(&item);
        if item.is_empty() || removed.contains(&key) || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(item);
    }
    Some(out)
}

fn same_list(a: &[String], b: &[String]) -> bool {
    let sorted = |list: &[String]| {
        let mut keys: Vec<String> = list.iter().map(|s| title_key(s)).collect();
        keys.sort();
        keys
    };
    sorted(a) == sorted(b)
}

fn update_page(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let page = cx.read(|ctx| changeable_page(ctx, args))?;
    let meta = &page.meta;
    let mut changes = Map::new();
    if let Some(summary) = args.get("summary").and_then(Value::as_str) {
        let summary = cut(summary.trim(), 2000);
        if summary != meta.summary {
            changes.insert("summary".into(), json!(summary));
        }
    }
    if let Some(status) = args.get("status").and_then(Value::as_str).map(str::trim) {
        if !pages::STATUSES.contains(&status) {
            return Err(AppError::invalid("status must be canon, draft, idea or retconned."));
        }
        if status != meta.status {
            changes.insert("status".into(), json!(status));
        }
    }
    if let Some(page_type) = args.get("page_type").and_then(Value::as_str) {
        let page_type = cut(&clean(page_type), MAX_LABEL).to_lowercase();
        if page_type.is_empty() {
            return Err(AppError::invalid("page_type cannot be empty."));
        }
        if page_type != meta.page_type {
            changes.insert("pageType".into(), json!(page_type));
        }
    }
    if let Some(aliases) = edited_list(args, "aliases", &meta.aliases) {
        let own = title_key(&meta.title);
        let aliases: Vec<String> = aliases.into_iter().filter(|a| title_key(a) != own).collect();
        if !same_list(&aliases, &meta.aliases) {
            changes.insert("aliases".into(), json!(aliases));
        }
    }
    if let Some(categories) = edited_list(args, "categories", &meta.categories) {
        if !same_list(&categories, &meta.categories) {
            changes.insert("categories".into(), json!(categories));
        }
    }
    if changes.is_empty() {
        return Err(AppError::invalid("Nothing would change. Give at least one detail that differs from the page's now."));
    }
    let before = json!({
        "summary": meta.summary, "status": meta.status, "pageType": meta.page_type,
        "aliases": meta.aliases, "categories": meta.categories,
    });
    let title = meta.title.clone();
    Ok(Draft::new("pageUpdate", title.clone(), json!({ "changes": changes, "before": before, "reason": reason(args) }))
        .target("page", meta.id.clone())
        .done(format!("changed the details of \"{title}\".")))
}

// ---------------------------------------------------------------------------
// set_infobox_fields
// ---------------------------------------------------------------------------

/// The same key the infobox editor makes from a label (`keyFromLabel` in TypeScript).
fn key_from_label(label: &str, taken: &[String]) -> String {
    let mut base = String::new();
    for c in label.to_lowercase().chars() {
        if c.is_alphanumeric() {
            base.push(c);
        } else if !base.ends_with('_') {
            base.push('_');
        }
    }
    let base = base.trim_matches('_').to_string();
    let base = if base.is_empty() { "field".to_string() } else { base };
    if !taken.contains(&base) {
        return base;
    }
    let mut n = 2;
    while taken.contains(&format!("{base}_{n}")) {
        n += 1;
    }
    format!("{base}_{n}")
}

fn field_text<'a>(field: &'a Value, name: &str) -> &'a str {
    field.get(name).and_then(Value::as_str).unwrap_or("")
}

fn matches_field(field: &Value, wanted: &str) -> bool {
    let wanted = wanted.trim().to_lowercase();
    field_text(field, "label").trim().to_lowercase() == wanted || field_text(field, "key").to_lowercase() == wanted
}

fn field_kind(item: &Value) -> AppResult<Option<String>> {
    match item.get("kind").and_then(Value::as_str).map(str::trim) {
        None | Some("") => Ok(None),
        Some(kind) if FIELD_KINDS.contains(&kind) => Ok(Some(kind.to_string())),
        Some(_) => Err(AppError::invalid(format!("kind must be one of {}.", FIELD_KINDS.join(", ")))),
    }
}

/// Builds the new field list. Existing fields keep their key, place and story changes.
pub(crate) fn edit_fields(before: &[Value], items: &[Value], replace_all: bool) -> AppResult<Vec<Value>> {
    let mut fields: Vec<Value> = if replace_all { Vec::new() } else { before.to_vec() };
    for item in items {
        let wanted = item.get("label").or(item.get("key")).and_then(Value::as_str).map(str::trim).unwrap_or("");
        if wanted.is_empty() {
            return Err(AppError::invalid("Each field needs a label."));
        }
        let wanted = cut(wanted, MAX_LABEL).to_string();
        let remove = item.get("remove").and_then(Value::as_bool).unwrap_or(false);
        let kind = field_kind(item)?;
        let value = item.get("value").map(|v| match v {
            Value::String(s) => cut(s.trim(), MAX_VALUE).to_string(),
            Value::Null => String::new(),
            other => cut(&other.to_string(), MAX_VALUE).to_string(),
        });
        let new_label = item.get("new_label").and_then(Value::as_str).map(clean).filter(|l| !l.is_empty());
        let at = fields.iter().position(|f| matches_field(f, &wanted));
        if remove {
            match at {
                Some(index) => {
                    fields.remove(index);
                }
                None if replace_all => {}
                None => return Err(AppError::not_found(format!("A field called \"{wanted}\" in this infobox"))),
            }
            continue;
        }
        let index = match at {
            Some(index) => index,
            None => {
                // A field from before, carried over by replace_all, keeps its key and changes.
                let old = before.iter().find(|f| matches_field(f, &wanted)).cloned();
                let field = old.unwrap_or_else(|| {
                    let taken: Vec<String> = fields.iter().map(|f| field_text(f, "key").to_string()).collect();
                    json!({ "key": key_from_label(&wanted, &taken), "label": wanted, "kind": "text", "value": "" })
                });
                fields.push(field);
                fields.len() - 1
            }
        };
        let field = &mut fields[index];
        if let Some(kind) = kind {
            field["kind"] = json!(kind);
        }
        if let Some(value) = value {
            field["value"] = json!(value);
        }
        if let Some(label) = new_label {
            field["label"] = json!(cut(&label, MAX_LABEL));
        }
    }
    Ok(fields)
}

fn set_infobox_fields(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let items = args
        .get("fields")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| AppError::invalid("Give at least one field."))?;
    if items.len() > 200 {
        return Err(AppError::invalid("That is too many fields at once."));
    }
    let replace_all = args.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
    let page = cx.read(|ctx| changeable_page(ctx, args))?;
    let before: Vec<Value> = page.infobox.get("fields").and_then(Value::as_array).cloned().unwrap_or_default();
    let fields = edit_fields(&before, items, replace_all)?;
    if fields == before {
        return Err(AppError::invalid("Nothing would change. The infobox already says that."));
    }
    let title = page.meta.title.clone();
    Ok(Draft::new("infoboxFields", title.clone(), json!({ "fields": fields, "before": before, "reason": reason(args) }))
        .target("page", page.meta.id.clone())
        .done(format!("changed the infobox of \"{title}\".")))
}

// ---------------------------------------------------------------------------
// rename_page
// ---------------------------------------------------------------------------

fn flag(args: &Value, name: &str) -> bool {
    args.get(name).and_then(Value::as_bool).unwrap_or(true)
}

fn rename_page(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let new_title = clean(required(args, "new_title")?);
    if title_key(&new_title).is_empty() {
        return Err(AppError::invalid("The page needs a title."));
    }
    if new_title.len() > MAX_LABEL {
        return Err(AppError::invalid("That title is too long."));
    }
    let page = cx.read(|ctx| changeable_page(ctx, args))?;
    let old_title = page.meta.title.clone();
    if new_title == old_title {
        return Err(AppError::invalid("The page already has that title."));
    }
    let update_links = flag(args, "update_links");
    let keep_alias = flag(args, "keep_alias");
    // The app's own preview: it refuses a title in use, and lists what links here.
    let preview = pages::handle(cx.engine, "renamePreview", json!({ "id": page.meta.id, "newTitle": new_title }))?;
    let documents = preview["documents"].as_array().cloned().unwrap_or_default();
    // Titles of local-only documents stay out of what a client hears.
    let shown: Vec<Value> = cx.read(|ctx| {
        Ok(documents
            .iter()
            .filter(|d| {
                let id = d["id"].as_str().unwrap_or("");
                if d["kind"] == "page" { !ctx.page_hidden(id) } else { !ctx.node_hidden(id) }
            })
            .map(|d| d["title"].clone())
            .collect())
    })?;
    let count = if update_links { documents.len() } else { 0 };
    let links = match count {
        0 => "No links need to change".to_string(),
        1 => "Links in 1 document will change".to_string(),
        n => format!("Links in {n} documents will change"),
    };
    let payload = json!({
        "oldTitle": old_title, "newTitle": new_title, "updateLinks": update_links, "keepAlias": keep_alias,
        "documents": count, "linking": shown, "reason": reason(args),
    });
    Ok(Draft::new("pageRename", old_title.clone(), payload)
        .target("page", page.meta.id.clone())
        .suggested(format!(
            "Suggested renaming \"{old_title}\" to \"{new_title}\" (suggestion {{id}}). {links} once the writer accepts it under Outside suggestions. Nothing has changed yet."
        ))
        .done(format!("renamed \"{old_title}\" to \"{new_title}\". {}.", match count {
            0 => "No links needed to change".to_string(),
            1 => "Links in 1 document were updated".to_string(),
            n => format!("Links in {n} documents were updated"),
        })))
}

// ---------------------------------------------------------------------------
// The trash
// ---------------------------------------------------------------------------

fn trash_page(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let page = cx.read(|ctx| changeable_page(ctx, args))?;
    if page.meta.is_home {
        return Err(AppError::invalid("The main page cannot be moved to the trash."));
    }
    let title = page.meta.title.clone();
    Ok(Draft::new("pageTrash", title.clone(), json!({ "action": "trash", "reason": reason(args) }))
        .target("page", page.meta.id.clone())
        .suggested(format!(
            "Suggested moving \"{title}\" to the trash (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("moved \"{title}\" to the trash. restore_page brings it back.")))
}

fn restore_page(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let (id, title) = cx.read(|ctx| {
        let found: Option<(String, String)> = match (optional(args, "id"), optional(args, "title")) {
            ("", "") => return Err(AppError::invalid("Give a page title or id.")),
            (id, _) if !id.is_empty() => ctx
                .conn
                .query_row("SELECT id, title FROM pages WHERE id = ?1 AND deleted_at IS NOT NULL", [id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?,
            (_, title) => ctx
                .conn
                .query_row(
                    "SELECT id, title FROM pages WHERE title_key = ?1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1",
                    [title_key(title)],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?,
        };
        let named = match optional(args, "title") { "" => optional(args, "id"), title => title };
        let what = format!("A page in the trash called \"{named}\"");
        match found {
            Some((id, title)) if !ctx.page_hidden(&id) => {
                refuse_local_only(ctx, &id)?;
                Ok((id, title))
            }
            _ => Err(AppError::not_found(what)),
        }
    })?;
    Ok(Draft::new("pageTrash", title.clone(), json!({ "action": "restore", "reason": reason(args) }))
        .target("page", id)
        .suggested(format!(
            "Suggested restoring \"{title}\" from the trash (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("restored \"{title}\" from the trash.")))
}

// ---------------------------------------------------------------------------
// Talk
// ---------------------------------------------------------------------------

fn add_talk_note(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let text = required(args, "text")?.trim();
    if text.is_empty() {
        return Err(AppError::invalid("The note is empty."));
    }
    check_size("The note", text)?;
    if text.chars().count() > MAX_NOTE {
        return Err(AppError::invalid("That note is too long for the Talk tab."));
    }
    let page = cx.read(|ctx| changeable_page(ctx, args))?;
    let title = page.meta.title.clone();
    Ok(Draft::new("talkNote", title.clone(), json!({ "text": text, "before": page.notes }))
        .target("page", page.meta.id.clone())
        .suggested(format!(
            "Suggested a note on the Talk tab of \"{title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("added a note to the Talk tab of \"{title}\".")))
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

fn add_relationship(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let kind = clean(required(args, "kind")?);
    if kind.is_empty() || kind.chars().count() > 60 {
        return Err(AppError::invalid("Give a short kind, such as ally or parent of."));
    }
    let note = cut(optional(args, "note"), 2000).to_string();
    let ((from_id, from), (to_id, to)) = cx.read(|ctx| {
        Ok((named_page(ctx, required(args, "from")?)?, named_page(ctx, required(args, "to")?)?))
    })?;
    if from_id == to_id {
        return Err(AppError::invalid("A page cannot have a relationship with itself."));
    }
    let title = format!("{from} {kind} {to}");
    let payload = json!({
        "action": "add", "fromPageId": from_id, "fromTitle": from, "toPageId": to_id, "toTitle": to,
        "kind": kind, "note": note, "reason": reason(args),
    });
    Ok(Draft::new("relationship", title.clone(), payload)
        .target("page", from_id)
        .suggested(format!(
            "Suggested the relationship \"{title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("recorded that {title}.")))
}

fn remove_relationship(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let kind = clean(optional(args, "kind")).to_lowercase();
    let (row, from, to) = cx.read(|ctx| {
        let (a, from) = named_page(ctx, required(args, "from")?)?;
        let (b, to) = named_page(ctx, required(args, "to")?)?;
        let mut stmt = ctx.conn.prepare(
            "SELECT id, from_page_id, to_page_id, kind, note FROM relationships
             WHERE (from_page_id = ?1 AND to_page_id = ?2) OR (from_page_id = ?2 AND to_page_id = ?1)
             ORDER BY created_at",
        )?;
        let rows: Vec<Value> = stmt
            .query_map([&a, &b], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "fromPageId": r.get::<_, String>(1)?,
                    "toPageId": r.get::<_, String>(2)?, "kind": r.get::<_, String>(3)?, "note": r.get::<_, String>(4)?,
                }))
            })?
            .collect::<Result<_, _>>()?;
        // A kind can be said from either side: "child of" finds a stored "parent of".
        let matching: Vec<Value> = rows
            .iter()
            .filter(|r| {
                let stored = r["kind"].as_str().unwrap_or("").to_lowercase();
                kind.is_empty() || stored == kind || (stored == "parent of" && kind == "child of")
            })
            .cloned()
            .collect();
        let row = match matching.len() {
            0 => return Err(AppError::not_found(format!("A relationship between \"{from}\" and \"{to}\""))),
            1 => matching[0].clone(),
            _ => {
                let kinds: Vec<&str> = matching.iter().filter_map(|r| r["kind"].as_str()).collect();
                return Err(AppError::invalid(format!(
                    "\"{from}\" and \"{to}\" have more than one relationship ({}). Say which with kind.",
                    kinds.join(", ")
                )));
            }
        };
        let title_of = |id: &str| -> AppResult<String> {
            Ok(ctx.conn.query_row("SELECT title FROM pages WHERE id = ?1", [id], |r| r.get(0))?)
        };
        let from = title_of(row["fromPageId"].as_str().unwrap_or(""))?;
        let to = title_of(row["toPageId"].as_str().unwrap_or(""))?;
        Ok((row, from, to))
    })?;
    let kind = row["kind"].as_str().unwrap_or("").to_string();
    let title = format!("{from} {kind} {to}");
    let mut payload = row.as_object().cloned().unwrap_or_default();
    payload.insert("action".into(), json!("remove"));
    payload.insert("fromTitle".into(), json!(from));
    payload.insert("toTitle".into(), json!(to));
    payload.insert("reason".into(), reason(args));
    let from_id = payload["fromPageId"].clone();
    Ok(Draft::new("relationship", title.clone(), Value::Object(payload))
        .target("page", from_id.as_str().unwrap_or(""))
        .suggested(format!(
            "Suggested removing the relationship \"{title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("removed the relationship \"{title}\".")))
}

// ---------------------------------------------------------------------------
// Map pins
// ---------------------------------------------------------------------------

fn fraction(args: &Value, name: &str) -> AppResult<f64> {
    let value = args
        .get(name)
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
        .ok_or_else(|| AppError::invalid(format!("{name} is required, from 0 to 1.")))?;
    if !(0.0..=1.0).contains(&value) {
        return Err(AppError::invalid(format!("{name} must be from 0 to 1.")));
    }
    Ok(value)
}

fn find_map(ctx: &Ctx, wanted: &str) -> AppResult<(String, String)> {
    let wanted = wanted.trim();
    if wanted.is_empty() {
        return Err(AppError::invalid("Give a map title or id. See list_maps."));
    }
    ctx.conn
        .query_row(
            "SELECT id, title FROM maps WHERE deleted_at IS NULL AND (id = ?1 OR lower(title) = lower(?1))
             ORDER BY id = ?1 DESC LIMIT 1",
            [wanted],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found(format!("A map called \"{wanted}\"")))
}

/// A pin as a client may see it: on a live map, and not standing for a hidden page.
fn find_pin(ctx: &Ctx, args: &Value) -> AppResult<Value> {
    let row = |r: &rusqlite::Row| -> rusqlite::Result<Value> {
        Ok(json!({
            "id": r.get::<_, String>(0)?, "mapId": r.get::<_, String>(1)?, "mapTitle": r.get::<_, String>(2)?,
            "pageId": r.get::<_, Option<String>>(3)?, "label": r.get::<_, String>(4)?,
            "x": r.get::<_, f64>(5)?, "y": r.get::<_, f64>(6)?,
        }))
    };
    const SELECT: &str = "SELECT pin.id, pin.map_id, m.title, pin.page_id, pin.label, pin.x, pin.y
         FROM map_pins pin JOIN maps m ON m.id = pin.map_id AND m.deleted_at IS NULL";
    let pin = optional(args, "pin");
    let found = if !pin.is_empty() {
        ctx.conn.query_row(&format!("{SELECT} WHERE pin.id = ?1"), [pin], row).optional()?
    } else {
        let (map_id, _) = find_map(ctx, optional(args, "map"))?;
        let page = optional(args, "page");
        let label = optional(args, "label");
        if !page.is_empty() {
            let (page_id, _) = named_page(ctx, page)?;
            ctx.conn
                .query_row(&format!("{SELECT} WHERE pin.map_id = ?1 AND pin.page_id = ?2 ORDER BY pin.created_at LIMIT 1"), [&map_id, &page_id], row)
                .optional()?
        } else if !label.is_empty() {
            ctx.conn
                .query_row(&format!("{SELECT} WHERE pin.map_id = ?1 AND lower(pin.label) = lower(?2) ORDER BY pin.created_at LIMIT 1"), [&map_id, label], row)
                .optional()?
        } else {
            return Err(AppError::invalid("Name the pin by its id, or by map and page or label."));
        }
    };
    let found = found.ok_or_else(|| AppError::not_found("That pin"))?;
    if let Some(page) = found["pageId"].as_str() {
        if ctx.page_hidden(page) {
            return Err(AppError::not_found("That pin"));
        }
        refuse_local_only(ctx, page)?;
    }
    Ok(found)
}

fn pin_name(pin: &Value, page_title: Option<&str>) -> String {
    page_title.map(str::to_string).unwrap_or_else(|| pin["label"].as_str().unwrap_or("").to_string())
}

fn add_map_pin(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let x = fraction(args, "x")?;
    let y = fraction(args, "y")?;
    let label = cut(&clean(optional(args, "label")), MAX_LABEL).to_string();
    let (map_id, map_title, page) = cx.read(|ctx| {
        let (map_id, map_title) = find_map(ctx, optional(args, "map"))?;
        let page = match optional(args, "page") {
            "" => None,
            name => Some(named_page(ctx, name)?),
        };
        Ok((map_id, map_title, page))
    })?;
    if page.is_none() && label.is_empty() {
        return Err(AppError::invalid("A pin needs a page or a label."));
    }
    let name = page.as_ref().map(|(_, t)| t.clone()).unwrap_or_else(|| label.clone());
    let title = format!("{name} on {map_title}");
    let payload = json!({
        "action": "add", "mapId": map_id, "mapTitle": map_title, "pageId": page.as_ref().map(|(id, _)| id),
        "pageTitle": page.as_ref().map(|(_, t)| t), "label": label, "x": x, "y": y, "reason": reason(args),
    });
    Ok(Draft::new("mapPin", title.clone(), payload)
        .suggested(format!("Suggested a pin for {title} (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."))
        .done(format!("pinned {title}.")))
}

fn pin_draft(cx: &WriteCx, args: &Value, action: &str) -> AppResult<Draft> {
    let (pin, page_title) = cx.read(|ctx| {
        let pin = find_pin(ctx, args)?;
        let page_title: Option<String> = match pin["pageId"].as_str() {
            Some(id) => ctx.conn.query_row("SELECT title FROM pages WHERE id = ?1", [id], |r| r.get(0)).optional()?,
            None => None,
        };
        Ok((pin, page_title))
    })?;
    let mut payload = pin.as_object().cloned().unwrap_or_default();
    payload.insert("action".into(), json!(action));
    payload.insert("pinId".into(), pin["id"].clone());
    payload.insert("pageTitle".into(), json!(page_title));
    payload.insert("before".into(), json!({ "x": pin["x"], "y": pin["y"] }));
    payload.insert("reason".into(), reason(args));
    if action == "move" {
        let x = fraction(args, "x")?;
        let y = fraction(args, "y")?;
        if pin["x"].as_f64() == Some(x) && pin["y"].as_f64() == Some(y) {
            return Err(AppError::invalid("The pin is already there."));
        }
        payload.insert("x".into(), json!(x));
        payload.insert("y".into(), json!(y));
    }
    let title = format!("{} on {}", pin_name(&pin, page_title.as_deref()), pin["mapTitle"].as_str().unwrap_or(""));
    let (said, done) = if action == "move" {
        (format!("Suggested moving the pin for {title}"), format!("moved the pin for {title}."))
    } else {
        (format!("Suggested removing the pin for {title}"), format!("removed the pin for {title}."))
    };
    Ok(Draft::new("mapPin", title, Value::Object(payload))
        .suggested(format!("{said} (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."))
        .done(done))
}

fn move_map_pin(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    fraction(args, "x")?;
    fraction(args, "y")?;
    pin_draft(cx, args, "move")
}

fn remove_map_pin(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    pin_draft(cx, args, "remove")
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// Live pages this client can see, as SQL. Hidden ones are filtered in Rust.
fn visible_pages(ctx: &Ctx) -> AppResult<Vec<(String, String, String)>> {
    let mut stmt = ctx.conn.prepare("SELECT id, page_type, infobox FROM pages WHERE deleted_at IS NULL")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    let all: Vec<(String, String, String)> = rows.collect::<Result<_, _>>()?;
    Ok(all.into_iter().filter(|(id, _, _)| !ctx.page_hidden(id)).collect())
}

fn list_categories(ctx: &Ctx, _args: &Value) -> AppResult<String> {
    let mut stmt = ctx.conn.prepare(
        "SELECT pc.page_id, pc.category FROM page_categories pc JOIN pages p ON p.id = pc.page_id
         WHERE p.deleted_at IS NULL",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut counts: BTreeMap<String, (String, usize)> = BTreeMap::new();
    for row in rows {
        let (page, category) = row?;
        if ctx.page_hidden(&page) {
            continue;
        }
        counts.entry(category.to_lowercase()).or_insert((category, 0)).1 += 1;
    }
    if counts.is_empty() {
        return Ok("The wiki has no categories yet. update_page can add some.".to_string());
    }
    let lines: Vec<String> = counts
        .values()
        .map(|(name, n)| format!("- {name}: {n} page{}", if *n == 1 { "" } else { "s" }))
        .collect();
    Ok(format!("{} categories:\n{}", counts.len(), lines.join("\n")))
}

fn list_page_types(ctx: &Ctx, _args: &Value) -> AppResult<String> {
    // type -> (pages, field key -> (label, kind, uses))
    let mut types: BTreeMap<String, (usize, BTreeMap<String, (String, String, usize)>)> = BTreeMap::new();
    for builtin in ["article", "character", "place", "faction", "item", "event", "concept", "species", "culture", "organization"] {
        types.entry(builtin.to_string()).or_default();
    }
    let custom: Option<String> = ctx
        .conn
        .query_row("SELECT value FROM meta WHERE key = 'pageTypes'", [], |r| r.get(0))
        .optional()?;
    let custom: Vec<Value> = custom.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default();
    let mut labels = BTreeMap::new();
    for item in &custom {
        let Some(name) = item["type"].as_str().map(str::trim).filter(|t| !t.is_empty()) else { continue };
        labels.insert(name.to_string(), item["label"].as_str().unwrap_or(name).to_string());
        let entry = types.entry(name.to_string()).or_default();
        for field in item["fields"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let key = field_text(field, "key").to_string();
            if !key.is_empty() {
                entry.1.entry(key).or_insert((field_text(field, "label").to_string(), field_text(field, "kind").to_string(), 0));
            }
        }
    }
    for (_, page_type, infobox) in visible_pages(ctx)? {
        let entry = types.entry(page_type).or_default();
        entry.0 += 1;
        let infobox: Value = serde_json::from_str(&infobox).unwrap_or(Value::Null);
        for field in infobox["fields"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let key = field_text(field, "key").to_string();
            if key.is_empty() {
                continue;
            }
            let kind = match field_text(field, "kind") { "" => "text", k => k }.to_string();
            entry.1.entry(key).or_insert((field_text(field, "label").to_string(), kind, 0)).2 += 1;
        }
    }
    let mut out = vec!["Page types, with the infobox fields their pages use (label [key, kind]):".to_string()];
    for (name, (count, fields)) in &types {
        let own = labels.get(name).map(|l| format!(" (the writer's own type, \"{l}\")")).unwrap_or_default();
        out.push(format!("- {name}{own}: {count} page{}", if *count == 1 { "" } else { "s" }));
        let list: Vec<String> = fields
            .iter()
            .map(|(key, (label, kind, _))| format!("{} [{key}, {}]", if label.is_empty() { key } else { label }, if kind.is_empty() { "text" } else { kind }))
            .collect();
        if !list.is_empty() {
            out.push(format!("  Fields: {}", list.join("; ")));
        }
    }
    out.push("Field kinds: text, longtext, date, number, page (one title), pages (titles with commas).".to_string());
    Ok(out.join("\n"))
}

fn get_page_history(ctx: &Ctx, args: &Value) -> AppResult<String> {
    let id = resolve_page(ctx, args)?;
    let title: String = ctx.conn.query_row("SELECT title FROM pages WHERE id = ?1", [&id], |r| r.get(0))?;
    let limit = crate::mcp::tools::arg_usize(args, "limit").unwrap_or(30).clamp(1, 200) as i64;
    let mut stmt = ctx.conn.prepare(
        "SELECT id, reason, word_count, created_at FROM revisions WHERE entity_kind = 'page' AND entity_id = ?1
         ORDER BY created_at DESC, id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![id, limit], |r| {
        Ok(format!(
            "- {} ({} words){}  [revision {}]",
            r.get::<_, String>(3)?,
            r.get::<_, i64>(2)?,
            match r.get::<_, String>(1)?.as_str() {
                "" => String::new(),
                reason => format!(", saved for: {reason}"),
            },
            r.get::<_, String>(0)?,
        ))
    })?;
    let lines: Vec<String> = rows.collect::<Result<_, _>>()?;
    if lines.is_empty() {
        return Ok(format!("\"{title}\" has no saved versions yet."));
    }
    Ok(format!("History of \"{title}\", newest first:\n{}", lines.join("\n")))
}

fn list_maps(ctx: &Ctx, args: &Value) -> AppResult<String> {
    let maps: Vec<(String, String)> = match optional(args, "map") {
        "" => {
            let mut stmt = ctx.conn.prepare("SELECT id, title FROM maps WHERE deleted_at IS NULL ORDER BY lower(title)")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        }
        wanted => vec![find_map(ctx, wanted)?],
    };
    if maps.is_empty() {
        return Ok("The writer has no maps yet. Maps are made in LoreCraft from a picture.".to_string());
    }
    let mut out = Vec::new();
    for (map_id, map_title) in maps {
        out.push(format!("Map \"{map_title}\" (id {map_id}):"));
        let mut stmt = ctx.conn.prepare(
            "SELECT pin.id, pin.page_id, p.title, pin.label, pin.x, pin.y FROM map_pins pin
             LEFT JOIN pages p ON p.id = pin.page_id AND p.deleted_at IS NULL
             WHERE pin.map_id = ?1 ORDER BY pin.created_at, pin.id",
        )?;
        let rows = stmt.query_map([&map_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, f64>(4)?,
                r.get::<_, f64>(5)?,
            ))
        })?;
        let mut any = false;
        for row in rows {
            let (pin, page_id, page_title, label, x, y) = row?;
            if page_id.as_deref().is_some_and(|id| ctx.page_hidden(id)) {
                continue;
            }
            let name = match (page_title, label.is_empty()) {
                (Some(title), _) => format!("page \"{title}\""),
                (None, false) => format!("label \"{label}\""),
                (None, true) => "a page in the trash".to_string(),
            };
            out.push(format!("- {name} at x {x:.3}, y {y:.3} (pin {pin})"));
            any = true;
        }
        if !any {
            out.push("- no pins".to_string());
        }
    }
    Ok(out.join("\n"))
}

// The wiki tools: each queues a change with its old values, finds nothing it cannot see,
// refuses local-only pages, and at the edit level waits for the window.
#[cfg(test)]
mod tests {

    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{json, Map, Value};

    use super::edit_fields;
    use crate::engine::Engine;
    use crate::mcp::config::PERMISSION_EDIT;
    use crate::mcp::suggest::{self, call, call_as, STATUS_APPLIED, STATUS_APPLYING, STATUS_AUTO};
    use crate::mcp::write::Waits;
    use crate::rpc::call as rpc;

    struct World {
        engine: Arc<Engine>,
        _dir: crate::engine::TestDir,
        aria: String,
        secret: String,
        map: String,
    }

    fn world() -> World {
        let (engine, _host, dir) = Engine::for_test();
        rpc(&engine, "project.new", json!({ "name": "Ashfall" }));
        let aria = rpc(
            &engine,
            "pages.create",
            json!({ "title": "Aria", "pageType": "character", "summary": "A smith.", "aliases": ["Ari"], "categories": ["People"],
                    "infobox": { "fields": [
                        { "key": "born", "label": "Born", "kind": "date", "value": "312" },
                        { "key": "occupation", "label": "Occupation", "kind": "text", "value": "Smith" },
                    ]}}),
        )["id"]
            .as_str()
            .unwrap()
            .to_string();
        rpc(&engine, "pages.create", json!({ "title": "Gate", "pageType": "place" }));
        let secret = rpc(&engine, "pages.create", json!({ "title": "Secret", "categories": ["Hidden things"] }))["id"]
            .as_str()
            .unwrap()
            .to_string();
        rpc(&engine, "pages.update", json!({ "id": secret, "patch": { "localOnly": true } }));
        let map = crate::db::new_id();
        let gate = rpc(&engine, "pages.getByTitle", json!({ "title": "Gate" }))["id"].as_str().unwrap().to_string();
        engine
            .write(|tx| {
                tx.execute("INSERT INTO maps (id, title, created_at, updated_at) VALUES (?1, 'Vale', 'now', 'now')", [&map])?;
                tx.execute(
                    "INSERT INTO map_pins (id, map_id, page_id, label, x, y, created_at) VALUES ('pin1', ?1, ?2, '', 0.5, 0.5, 'now')",
                    [&map, &gate],
                )?;
                tx.execute(
                    "INSERT INTO map_pins (id, map_id, page_id, label, x, y, created_at) VALUES ('pin2', ?1, ?2, '', 0.1, 0.1, 'now')",
                    [&map, &secret],
                )?;
                Ok(())
            })
            .unwrap();
        World { engine, _dir: dir, aria, secret, map }
    }

    fn pending(engine: &Engine) -> Vec<Value> {
        engine.read(|c| suggest::list(c, "pending")).unwrap()
    }

    /// Runs a tool at the suggest level and returns the one row it stored.
    fn queued(w: &World, tool: &str, args: Value) -> Value {
        let said = call(&w.engine, "c", tool, &args, false).unwrap_or_else(|e| panic!("{tool}: {}", e.message));
        assert!(said.contains("(suggestion "), "{tool}: {said}");
        let rows = pending(&w.engine);
        assert_eq!(rows.len(), 1, "{tool}");
        rows[0].clone()
    }

    fn fails(w: &World, tool: &str, args: Value, share: bool) -> String {
        let err = call(&w.engine, "c", tool, &args, share).unwrap_err();
        assert!(pending(&w.engine).is_empty(), "{tool} stored something");
        err.code
    }

    #[test]
    fn update_page_keeps_old_values_and_only_what_changes() {
        let w = world();
        let row = queued(
            &w,
            "update_page",
            json!({ "title": "Ari", "status": "canon", "summary": "A smith.", "add_aliases": ["The Smith"], "remove_categories": ["people"], "add_categories": ["Smiths"] }),
        );
        assert_eq!(row["kind"], "pageUpdate");
        assert_eq!(row["targetId"], w.aria);
        let changes = &row["payload"]["changes"];
        assert_eq!(changes["status"], "canon");
        assert!(changes.get("summary").is_none(), "unchanged fields are left out");
        assert_eq!(changes["aliases"], json!(["Ari", "The Smith"]));
        assert_eq!(changes["categories"], json!(["Smiths"]));
        assert_eq!(row["payload"]["before"]["status"], "draft");
        assert_eq!(row["payload"]["before"]["categories"], json!(["People"]));
        // Nothing changed in the page itself.
        assert_eq!(rpc(&w.engine, "pages.get", json!({ "id": w.aria }))["status"], "draft");
    }

    #[test]
    fn update_page_refuses_bad_and_empty_changes() {
        let w = world();
        assert_eq!(fails(&w, "update_page", json!({ "title": "Aria", "status": "maybe" }), false), "INVALID");
        assert_eq!(fails(&w, "update_page", json!({ "title": "Aria", "summary": "A smith." }), false), "INVALID");
        assert_eq!(fails(&w, "update_page", json!({ "title": "Nobody", "status": "canon" }), false), "NOT_FOUND");
        // The local-only flag can never be set from outside.
        assert_eq!(fails(&w, "update_page", json!({ "title": "Aria", "localOnly": false }), false), "NOT_ALLOWED");
    }

    #[test]
    fn local_only_pages_are_hidden_and_refused_even_when_shared() {
        let w = world();
        let cases = [
            ("update_page", json!({ "title": "Secret", "status": "canon" })),
            ("set_infobox_fields", json!({ "title": "Secret", "fields": [{ "label": "Age", "value": "3" }] })),
            ("rename_page", json!({ "title": "Secret", "new_title": "Open" })),
            ("trash_page", json!({ "title": "Secret" })),
            ("add_talk_note", json!({ "title": "Secret", "text": "Hm." })),
            ("add_relationship", json!({ "from": "Aria", "to": "Secret", "kind": "ally" })),
            ("add_map_pin", json!({ "map": "Vale", "page": "Secret", "x": 0.2, "y": 0.2 })),
            ("move_map_pin", json!({ "pin": "pin2", "x": 0.2, "y": 0.2 })),
            ("remove_map_pin", json!({ "pin": "pin2" })),
        ];
        for (tool, args) in cases {
            assert_eq!(fails(&w, tool, args.clone(), false), "NOT_FOUND", "{tool} hidden");
            assert_eq!(fails(&w, tool, args, true), "NOT_ALLOWED", "{tool} shared");
        }
        // Trashed, it still cannot come back through a tool.
        rpc(&w.engine, "pages.delete", json!({ "id": w.secret }));
        assert_eq!(fails(&w, "restore_page", json!({ "title": "Secret" }), false), "NOT_FOUND");
        assert_eq!(fails(&w, "restore_page", json!({ "id": w.secret }), true), "NOT_ALLOWED");
    }

    #[test]
    fn infobox_fields_keep_their_place_key_and_changes() {
        let before = vec![
            json!({ "key": "born", "label": "Born", "kind": "date", "value": "312", "changes": [{ "value": "313" }] }),
            json!({ "key": "occupation", "label": "Occupation", "kind": "text", "value": "Smith" }),
        ];
        let items = vec![
            json!({ "label": "born", "new_label": "Birth year", "value": "311" }),
            json!({ "label": "Occupation", "remove": true }),
            json!({ "label": "Home town", "value": "Gate", "kind": "page" }),
        ];
        let fields = edit_fields(&before, &items, false).unwrap();
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0]["key"], "born");
        assert_eq!(fields[0]["label"], "Birth year");
        assert_eq!(fields[0]["value"], "311");
        assert_eq!(fields[0]["changes"][0]["value"], "313");
        assert_eq!(fields[1], json!({ "key": "home_town", "label": "Home town", "kind": "page", "value": "Gate" }));
        // replace_all keeps only what is given, in that order, with old keys.
        let all = edit_fields(&before, &[json!({ "label": "Occupation" }), json!({ "label": "Born", "value": "1" })], true).unwrap();
        assert_eq!(all.iter().map(|f| f["key"].clone()).collect::<Vec<_>>(), vec![json!("occupation"), json!("born")]);
        assert!(edit_fields(&before, &[json!({ "label": "Nope", "remove": true })], false).is_err());
        assert!(edit_fields(&before, &[json!({ "label": "Born", "kind": "colour" })], false).is_err());
    }

    #[test]
    fn set_infobox_fields_queues_the_whole_list_and_the_old_one() {
        let w = world();
        let row = queued(&w, "set_infobox_fields", json!({ "title": "Aria", "fields": [{ "label": "Born", "value": "300" }] }));
        assert_eq!(row["kind"], "infoboxFields");
        assert_eq!(row["payload"]["fields"][0]["value"], "300");
        assert_eq!(row["payload"]["before"][0]["value"], "312");
        assert_eq!(row["payload"]["fields"].as_array().unwrap().len(), 2);
        let w = world();
        assert_eq!(fails(&w, "set_infobox_fields", json!({ "title": "Aria", "fields": [{ "label": "Born", "value": "312" }] }), false), "INVALID");
        assert_eq!(fails(&w, "set_infobox_fields", json!({ "title": "Nobody", "fields": [{ "label": "Born" }] }), false), "NOT_FOUND");
    }

    #[test]
    fn rename_page_reports_the_links_that_will_change() {
        let w = world();
        rpc(
            &w.engine,
            "pages.update",
            json!({ "id": w.secret, "patch": { "content": { "type": "doc", "content": [{ "type": "paragraph", "content": [
                { "type": "text", "text": "Aria", "marks": [{ "type": "wikiLink", "attrs": { "target": "Aria" } }] }] }] } } }),
        );
        let gate = rpc(&w.engine, "pages.getByTitle", json!({ "title": "Gate" }))["id"].as_str().unwrap().to_string();
        rpc(
            &w.engine,
            "pages.update",
            json!({ "id": gate, "patch": { "content": { "type": "doc", "content": [{ "type": "paragraph", "content": [
                { "type": "text", "text": "Aria", "marks": [{ "type": "wikiLink", "attrs": { "target": "Aria" } }] }] }] } } }),
        );
        let said = call(&w.engine, "c", "rename_page", &json!({ "title": "Aria", "new_title": "Aria Vale" }), false).unwrap();
        let row = &pending(&w.engine)[0];
        assert_eq!(row["kind"], "pageRename");
        assert_eq!(row["payload"]["oldTitle"], "Aria");
        assert_eq!(row["payload"]["newTitle"], "Aria Vale");
        let count = row["payload"]["documents"].as_u64().unwrap();
        assert!(said.contains(&format!("{count} document")), "{said}");
        // A hidden page that links here is counted but never named.
        let named: Vec<&str> = row["payload"]["linking"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(!named.contains(&"Secret"), "{named:?}");
        let w = world();
        assert_eq!(fails(&w, "rename_page", json!({ "title": "Aria", "new_title": "Gate" }), false), "TITLE_EXISTS");
        assert_eq!(fails(&w, "rename_page", json!({ "title": "Nobody", "new_title": "X" }), false), "NOT_FOUND");
    }

    #[test]
    fn trash_and_restore_never_purge() {
        let w = world();
        let row = queued(&w, "trash_page", json!({ "title": "Gate" }));
        assert_eq!((row["kind"].as_str(), row["payload"]["action"].as_str()), (Some("pageTrash"), Some("trash")));
        let home = rpc(&w.engine, "pages.home", json!({}))["title"].as_str().unwrap().to_string();
        let w = world();
        assert_eq!(fails(&w, "trash_page", json!({ "title": home }), false), "INVALID");
        assert_eq!(fails(&w, "restore_page", json!({ "title": "Gate" }), false), "NOT_FOUND", "a live page is not in the trash");
        let gate = rpc(&w.engine, "pages.getByTitle", json!({ "title": "Gate" }))["id"].as_str().unwrap().to_string();
        rpc(&w.engine, "pages.delete", json!({ "id": gate }));
        let row = queued(&w, "restore_page", json!({ "title": "gate" }));
        assert_eq!(row["payload"]["action"], "restore");
        assert_eq!(row["targetId"], gate);
    }

    #[test]
    fn talk_notes_keep_the_notes_before() {
        let w = world();
        let row = queued(&w, "add_talk_note", json!({ "title": "Aria", "text": "Check her age." }));
        assert_eq!(row["kind"], "talkNote");
        assert_eq!(row["payload"]["text"], "Check her age.");
        assert!(row["payload"]["before"].is_null());
        assert_eq!(fails(&w_fresh(), "add_talk_note", json!({ "title": "Aria", "text": "  " }), false), "INVALID");
        assert_eq!(fails(&w_fresh(), "add_talk_note", json!({ "title": "Nobody", "text": "x" }), false), "NOT_FOUND");
    }

    fn w_fresh() -> World {
        world()
    }

    #[test]
    fn relationships_are_added_and_found_from_either_side() {
        let w = world();
        let row = queued(&w, "add_relationship", json!({ "from": "Aria", "to": "Gate", "kind": "located in" }));
        assert_eq!(row["kind"], "relationship");
        assert_eq!(row["payload"]["action"], "add");
        assert_eq!(row["payload"]["toTitle"], "Gate");
        let w = world();
        let gate = rpc(&w.engine, "pages.getByTitle", json!({ "title": "Gate" }))["id"].as_str().unwrap().to_string();
        rpc(&w.engine, "extras.relationshipAdd", json!({ "fromPageId": w.aria, "toPageId": gate, "kind": "located in" }));
        let row = queued(&w, "remove_relationship", json!({ "from": "Gate", "to": "Aria" }));
        assert_eq!(row["payload"]["action"], "remove");
        assert_eq!(row["payload"]["kind"], "located in");
        assert_eq!(row["payload"]["fromPageId"], w.aria);
        let w = world();
        assert_eq!(fails(&w, "remove_relationship", json!({ "from": "Gate", "to": "Aria" }), false), "NOT_FOUND");
        assert_eq!(fails(&w, "add_relationship", json!({ "from": "Aria", "to": "Aria", "kind": "ally" }), false), "INVALID");
        assert_eq!(fails(&w, "add_relationship", json!({ "from": "Aria", "to": "Nobody", "kind": "ally" }), false), "NOT_FOUND");
    }

    #[test]
    fn map_pins_are_added_moved_and_removed() {
        let w = world();
        let row = queued(&w, "add_map_pin", json!({ "map": "vale", "label": "Old mill", "x": 0.3, "y": 0.4 }));
        assert_eq!(row["kind"], "mapPin");
        assert_eq!(row["payload"]["mapId"], w.map);
        assert_eq!(row["payload"]["label"], "Old mill");
        let w = world();
        let row = queued(&w, "move_map_pin", json!({ "map": "Vale", "page": "Gate", "x": 0.9, "y": 0.8 }));
        assert_eq!(row["payload"]["pinId"], "pin1");
        assert_eq!(row["payload"]["before"], json!({ "x": 0.5, "y": 0.5 }));
        assert_eq!(row["payload"]["x"], 0.9);
        let w = world();
        let row = queued(&w, "remove_map_pin", json!({ "pin": "pin1" }));
        assert_eq!(row["payload"]["action"], "remove");
        assert_eq!(row["payload"]["pageTitle"], "Gate");
        let w = world();
        assert_eq!(fails(&w, "add_map_pin", json!({ "map": "Vale", "page": "Gate", "x": 2, "y": 0 }), false), "INVALID");
        assert_eq!(fails(&w, "add_map_pin", json!({ "map": "Nowhere", "label": "x", "x": 0, "y": 0 }), false), "NOT_FOUND");
        assert_eq!(fails(&w, "move_map_pin", json!({ "pin": "nope", "x": 0, "y": 0 }), false), "NOT_FOUND");
        assert_eq!(fails(&w, "remove_map_pin", json!({ "pin": "nope" }), false), "NOT_FOUND");
    }

    #[test]
    fn reads_leave_out_local_only_pages() {
        let w = world();
        let read = |tool: &str, args: Value| {
            w.engine
                .read(|c| {
                    let ctx = crate::mcp::tools::Ctx::new(c, "Ashfall".into(), true, false)?;
                    let tool = crate::mcp::areas::find(tool).unwrap();
                    match tool.handler {
                        crate::mcp::areas::Handler::Read(f) => f(&ctx, &args),
                        _ => unreachable!(),
                    }
                })
                .unwrap()
        };
        let categories = read("list_categories", json!({}));
        assert!(categories.contains("People: 1 page"), "{categories}");
        assert!(!categories.contains("Hidden things"), "{categories}");
        let types = read("list_page_types", json!({}));
        assert!(types.contains("character: 1 page"), "{types}");
        assert!(types.contains("Born [born, date]"), "{types}");
        let maps = read("list_maps", json!({}));
        assert!(maps.contains("page \"Gate\""), "{maps}");
        assert!(!maps.contains("Secret") && !maps.contains("pin2"), "{maps}");
        rpc(&w.engine, "revisions.checkpoint", json!({ "kind": "page", "id": w.aria, "reason": "test" }));
        let history = read("get_page_history", json!({ "title": "Aria" }));
        assert!(history.contains("History of \"Aria\""), "{history}");
    }

    // ---- The edit level ------------------------------------------------------------

    fn quick() -> Waits {
        Waits { claim: Duration::from_millis(800), apply: Duration::from_millis(2000), poll: Duration::from_millis(20) }
    }

    /// Plays the app's window: picks up the change and marks it applied.
    fn window(engine: &Arc<Engine>) -> std::thread::JoinHandle<Option<Value>> {
        let engine = engine.clone();
        std::thread::spawn(move || {
            for _ in 0..150 {
                std::thread::sleep(Duration::from_millis(15));
                let waiting = engine.read(|c| suggest::list(c, STATUS_AUTO)).unwrap();
                if let Some(row) = waiting.first() {
                    let id = row["id"].as_str().unwrap().to_string();
                    assert!(engine.write(|tx| suggest::resolve(tx, &id, STATUS_APPLYING)).unwrap());
                    assert!(engine.write(|tx| suggest::resolve_with(tx, &id, STATUS_APPLIED, &Map::new())).unwrap());
                    return Some(row.clone());
                }
            }
            None
        })
    }

    #[test]
    fn at_the_edit_level_each_tool_waits_for_the_window_and_says_done() {
        let cases = [
            ("update_page", json!({ "title": "Aria", "status": "canon" }), "pageUpdate"),
            ("set_infobox_fields", json!({ "title": "Aria", "fields": [{ "label": "Born", "value": "1" }] }), "infoboxFields"),
            ("rename_page", json!({ "title": "Aria", "new_title": "Aria Vale" }), "pageRename"),
            ("trash_page", json!({ "title": "Gate" }), "pageTrash"),
            ("add_talk_note", json!({ "title": "Aria", "text": "Hm." }), "talkNote"),
            ("add_relationship", json!({ "from": "Aria", "to": "Gate", "kind": "ally" }), "relationship"),
            ("add_map_pin", json!({ "map": "Vale", "page": "Aria", "x": 0.1, "y": 0.2 }), "mapPin"),
            ("move_map_pin", json!({ "pin": "pin1", "x": 0.1, "y": 0.2 }), "mapPin"),
            ("remove_map_pin", json!({ "pin": "pin1" }), "mapPin"),
        ];
        for (tool, args, kind) in cases {
            let w = world();
            let helper = window(&w.engine);
            let said = call_as(&w.engine, "c", tool, &args, false, PERMISSION_EDIT, quick()).unwrap();
            let row = helper.join().unwrap().unwrap_or_else(|| panic!("{tool}: the window saw nothing"));
            assert!(said.starts_with("Done: "), "{tool}: {said}");
            assert_eq!(row["kind"], kind, "{tool}");
            assert!(pending(&w.engine).is_empty(), "{tool}");
        }
    }
}
