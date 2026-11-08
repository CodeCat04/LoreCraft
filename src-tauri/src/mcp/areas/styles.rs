//! Writing styles: the built-in library, the writer's own styles, and which one applies to
//! the project, a book or a scene.
//!
//! The library is TypeScript data, so the server reads a copy of it from
//! `styles_library.json`, which a test in `src/mcp/kinds/stylesCatalog.test.ts` keeps in
//! step. The writer's own styles live in the app settings, which only the running app has:
//! `Ctx::custom_styles` carries them, and a saved file read without the app has none. The
//! choices live in project meta `writingStyles.choices` (see `src/writingStyles/store.ts`).
//! Every change goes through the app's style store, so the Writing styles screen shows it.

use std::sync::LazyLock;

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use super::{read, write, Tool};
use crate::content::title_key;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{optional, reason, resolve_book, MAX_LABEL};
use crate::mcp::text::cut;
use crate::mcp::tools::{resolve_scene_id, Ctx};
use crate::mcp::write::{Draft, WriteCx};

pub const CHOICES_KEY: &str = "writingStyles.choices";

/// The traits a style is built from, in the order prompts list them, with their labels.
const TRAITS: &[(&str, &str)] = &[
    ("narration", "Narration"),
    ("sentences", "Sentences"),
    ("diction", "Word choice"),
    ("dialogue", "Dialogue"),
    ("description", "Description"),
    ("pacing", "Pacing"),
    ("signature", "Signature moves"),
    ("avoid", "Avoid"),
];
const WEIGHTS: &[&str] = &["mostly", "some", "touch"];
const MAX_PROMPT: usize = 20_000;

/// Closing sentences, as `src/writingStyles/prompt.ts` writes them.
const CLOSING_START: &str = "Write original prose in this manner.";
const CLOSING_END: &str = "If the writer's lore defines a fact, the lore wins over style.";

static LIBRARY: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str::<Vec<Value>>(include_str!("styles_library.json")).unwrap_or_default()
});

/// The writer's own styles, from the app settings, for `Ctx::custom_styles`.
pub fn custom_styles(engine: &Engine) -> Value {
    engine.settings()["writingStyles"]["custom"].clone()
}

fn customs(ctx: &Ctx) -> Vec<Value> {
    ctx.custom_styles
        .as_ref()
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").trim().to_string()
}

/// The prompt a custom style gives the AI, as `buildStylePrompt` builds it.
fn custom_prompt(style: &Value) -> String {
    let middle = if style["namesAuthors"].as_bool() == Some(true) {
        "Do not reuse the text, characters, settings or invented terms of any author this style draws on, and never name them in the story text."
    } else {
        "Do not reuse text, characters, settings or invented terms from any published work."
    };
    let closing = format!("{CLOSING_START} {middle} {CLOSING_END}");
    let mut body = text(style, "promptOverride");
    while let Some(start) = body.find(CLOSING_START) {
        let Some(end) = body[start..].find(CLOSING_END) else { break };
        body.replace_range(start..start + end + CLOSING_END.len(), "");
    }
    let body = body.replace(CLOSING_END, "").trim().to_string();
    if !body.is_empty() {
        return format!("{body}\n\n{closing}");
    }
    let mut lines: Vec<String> = TRAITS
        .iter()
        .filter_map(|(key, label)| {
            let t = text(&style["traits"], key);
            (!t.is_empty()).then(|| format!("{label}: {t}"))
        })
        .collect();
    let priority = text(style, "priority");
    if !priority.is_empty() {
        lines.push(format!("Priority: {priority}"));
    }
    let name = text(style, "name");
    let opening = format!(
        "Write in this style: {}. Follow these instructions in all the prose you write.",
        name.trim_end_matches(|c: char| c == '.' || c.is_whitespace())
    );
    if lines.is_empty() {
        return format!("{opening}\n\n{closing}");
    }
    format!("{opening}\n\n{}\n\n{closing}", lines.join("\n"))
}

/// A style by id or name: the library first, then the writer's own.
fn find_style(ctx: &Ctx, wanted: &str) -> Option<Value> {
    let key = title_key(wanted);
    let customs = customs(ctx);
    let all = || LIBRARY.iter().chain(customs.iter());
    all()
        .find(|s| s["id"].as_str() == Some(wanted))
        .or_else(|| all().find(|s| title_key(s["name"].as_str().unwrap_or("")) == key))
        .map(|s| {
            let mut s = s.clone();
            if s["kind"].is_null() {
                s["kind"] = json!("custom");
            }
            s
        })
}

fn style_arg(ctx: &Ctx, args: &Value, name: &str) -> AppResult<Value> {
    let wanted = optional(args, name);
    if wanted.is_empty() {
        return Err(AppError::invalid(format!("{name} is required: a style's id or name. list_writing_styles shows them.")));
    }
    find_style(ctx, wanted).ok_or_else(|| {
        if ctx.custom_styles.is_none() {
            AppError::not_found(format!("A style called \"{wanted}\" (the writer's own styles show only while LoreCraft is open)"))
        } else {
            AppError::not_found(format!("A style called \"{wanted}\""))
        }
    })
}

/// One of the writer's own styles, refusing a built-in one.
fn custom_arg(ctx: &Ctx, args: &Value) -> AppResult<Value> {
    let style = style_arg(ctx, args, "style")?;
    if style["kind"] != "custom" {
        return Err(AppError::new(
            "NOT_ALLOWED",
            format!(
                "\"{}\" is a built-in style, which cannot be changed. Make your own with create_writing_style instead.",
                text(&style, "name")
            ),
        ));
    }
    Ok(style)
}

fn choices(ctx: &Ctx) -> AppResult<Value> {
    let stored: Option<String> = ctx
        .conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [CHOICES_KEY], |r| r.get(0))
        .optional()?;
    Ok(stored.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({})))
}

/// A choice's style name, even for a custom style not on this computer.
fn choice_name(ctx: &Ctx, choice: &Value) -> Option<String> {
    let id = choice["styleId"].as_str()?;
    Some(
        find_style(ctx, id)
            .map(|s| text(&s, "name"))
            .or_else(|| choice["name"].as_str().map(str::to_string))
            .unwrap_or_else(|| id.to_string()),
    )
}

fn first_sentence(text: &str) -> String {
    let end = text.find(". ").map(|i| i + 1).unwrap_or(text.len());
    cut(&text[..end], 160).to_string()
}

pub fn tools() -> Vec<Tool> {
    let traits: Map<String, Value> = TRAITS
        .iter()
        .map(|(k, label)| ((*k).to_string(), json!({ "type": "string", "description": label })))
        .collect();
    let style_fields = |extra: Value| {
        let mut props = json!({
            "description": { "type": "string", "description": "Two to four sentences on how it is written. Shown first in the app." },
            "prompt": { "type": "string", "description": "The instructions given to the AI, as free text. It replaces the prompt built from traits." },
            "traits": { "type": "object", "description": "Craft instructions by area, used when there is no prompt.", "properties": traits.clone() },
            "genres": { "type": "array", "items": { "type": "string" }, "description": "Genre ids, such as fantasy or crime." },
            "reason": { "type": "string", "description": "A short note to the writer saying why." },
        });
        if let (Some(map), Some(more)) = (props.as_object_mut(), extra.as_object()) {
            map.extend(more.clone());
        }
        props
    };
    vec![
        read(
            "list_writing_styles",
            "The writing styles: the built-in library (authors and techniques) and the writer's own, with ids, and which style the project and each book use. Filter with query or kind.",
            json!({ "type": "object", "properties": {
                "query": { "type": "string", "description": "Words to look for in a name, genre or description." },
                "kind": { "type": "string", "enum": ["author", "technique", "custom"], "description": "Only this kind." },
            } }),
            list_writing_styles,
        ),
        read(
            "get_writing_style",
            "One writing style in full: its description and the prompt the AI is given.",
            json!({ "type": "object", "properties": {
                "style": { "type": "string", "description": "The style's id or name." },
            }, "required": ["style"] }),
            get_writing_style,
        ),
        write(
            "create_writing_style",
            "Create one of the writer's own writing styles, from a name with a prompt or traits, or as a blend of two or three existing styles. It changes no text. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": style_fields(json!({
                "name": { "type": "string", "description": "The new style's name." },
                "blend": { "type": "array", "description": "Two or three styles to blend, instead of a prompt.", "items": { "type": "object", "properties": {
                    "style": { "type": "string", "description": "A style id or name." },
                    "weight": { "type": "string", "enum": WEIGHTS, "description": "How much of it: mostly, some (default) or touch." },
                }, "required": ["style"] } },
            })), "required": ["name"] }),
            create_writing_style,
        ),
        write(
            "update_writing_style",
            "Change one of the writer's own writing styles: its name, description, prompt, traits or genres. Built-in styles cannot be changed. Fields you leave out stay as they are. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": style_fields(json!({
                "style": { "type": "string", "description": "The custom style's id or name." },
                "name": { "type": "string", "description": "A new name." },
            })), "required": ["style"] }),
            update_writing_style,
        ),
        write(
            "delete_writing_style",
            "Delete one of the writer's own writing styles. Built-in styles cannot be deleted. Projects that use it keep their own copy, and the writer can undo it. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "style": { "type": "string", "description": "The custom style's id or name." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["style"] }),
            delete_writing_style,
        ),
        write(
            "set_default_style",
            "Set the writing style the AI uses by default for the whole project, one book or one scene. A scene's choice wins over its book's, and a book's over the project's. Give no style to clear the choice, so the wider one applies. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "scope": { "type": "string", "enum": ["project", "book", "scene"], "description": "Where it applies. Default: scene if you give a scene, book if you give a book, else project." },
                "book": { "type": "string", "description": "The book's title, for scope book." },
                "scene": { "type": "string", "description": "The scene's title or id, for scope scene." },
                "style": { "type": "string", "description": "The style's id or name. Leave out, or give none, to clear." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            } }),
            set_default_style,
        ),
    ]
}

fn list_writing_styles(ctx: &Ctx, args: &Value) -> AppResult<String> {
    let query = optional(args, "query").to_lowercase();
    let kind = optional(args, "kind");
    let mut out = String::new();
    let chosen = choices(ctx)?;
    match choice_name(ctx, &chosen["project"]) {
        Some(name) => out.push_str(&format!("Project default style: {name}.\n")),
        None => out.push_str("The project has no default style.\n"),
    }
    if let Some(books) = chosen["books"].as_object() {
        for (book_id, choice) in books {
            let title: Option<String> = ctx
                .conn
                .query_row("SELECT title FROM books WHERE id = ?1 AND deleted_at IS NULL", [book_id], |r| r.get(0))
                .optional()?;
            if let (Some(title), Some(name)) = (title, choice_name(ctx, choice)) {
                out.push_str(&format!("Book \"{title}\": {name}.\n"));
            }
        }
    }
    let scenes = chosen["scenes"]
        .as_object()
        .map(|s| s.keys().filter(|id| !ctx.node_hidden(id)).count())
        .unwrap_or(0);
    if scenes > 0 {
        out.push_str(&format!("{scenes} scene(s) choose their own style.\n"));
    }
    let matches = |s: &Value| {
        (kind.is_empty() || s["kind"].as_str().unwrap_or("custom") == kind)
            && (query.is_empty()
                || [text(s, "name"), text(s, "summary"), s["genres"].to_string()]
                    .iter()
                    .any(|t| t.to_lowercase().contains(&query)))
    };
    let line = |s: &Value, kind: &str| {
        let genres: Vec<&str> = s["genres"].as_array().map(|g| g.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let genres = if genres.is_empty() { String::new() } else { format!(", {}", genres.join(", ")) };
        format!("- {} (id {}; {kind}{genres}): {}\n", text(s, "name"), text(s, "id"), first_sentence(&text(s, "summary")))
    };
    out.push_str("\nThe writer's own styles:\n");
    match &ctx.custom_styles {
        None => out.push_str("They show only while LoreCraft is open.\n"),
        Some(_) => {
            let mine: Vec<Value> = customs(ctx).into_iter().filter(|s| matches(s)).collect();
            if mine.is_empty() {
                out.push_str("None.\n");
            }
            for s in &mine {
                out.push_str(&line(s, "custom"));
            }
        }
    }
    if kind != "custom" {
        out.push_str("\nBuilt-in styles (they cannot be changed):\n");
        let found: Vec<&Value> = LIBRARY.iter().filter(|s| matches(s)).collect();
        if found.is_empty() {
            out.push_str("None match.\n");
        }
        for s in found {
            out.push_str(&line(s, s["kind"].as_str().unwrap_or("")));
        }
    }
    out.push_str("\nget_writing_style shows one in full. set_default_style chooses one for the project, a book or a scene.");
    Ok(out)
}

fn get_writing_style(ctx: &Ctx, args: &Value) -> AppResult<String> {
    let style = style_arg(ctx, args, "style")?;
    let kind = style["kind"].as_str().unwrap_or("custom");
    let prompt = if kind == "custom" { custom_prompt(&style) } else { text(&style, "prompt") };
    let mut out = format!("{} (id {}; {}).\n", text(&style, "name"), text(&style, "id"), match kind {
        "author" => "built-in, in the manner of an author",
        "technique" => "built-in technique",
        _ => "the writer's own style",
    });
    let genres: Vec<&str> = style["genres"].as_array().map(|g| g.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    if !genres.is_empty() {
        out.push_str(&format!("Genres: {}.\n", genres.join(", ")));
    }
    let summary = text(&style, "summary");
    if !summary.is_empty() {
        out.push_str(&format!("\nDescription:\n{summary}\n"));
    }
    out.push_str(&format!("\nPrompt given to the AI:\n{prompt}"));
    Ok(out)
}

/// Name, description, prompt, traits and genres from the arguments, as given.
fn style_changes(args: &Value) -> AppResult<Map<String, Value>> {
    let mut changes = Map::new();
    if let Some(name) = args.get("name").and_then(Value::as_str) {
        let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
        if name.is_empty() || name.len() > MAX_LABEL {
            return Err(AppError::invalid("A style needs a name of up to 200 characters."));
        }
        changes.insert("name".into(), json!(name));
    }
    if let Some(d) = args.get("description").and_then(Value::as_str) {
        changes.insert("summary".into(), json!(cut(d.trim(), 4000)));
    }
    if let Some(p) = args.get("prompt").and_then(Value::as_str) {
        if p.chars().count() > MAX_PROMPT {
            return Err(AppError::invalid("That prompt is too long for a style."));
        }
        changes.insert("promptOverride".into(), json!(p.trim()));
    }
    if let Some(traits) = args.get("traits").and_then(Value::as_object) {
        let mut out = Map::new();
        for (key, value) in traits {
            if !TRAITS.iter().any(|(k, _)| k == key) {
                let names: Vec<&str> = TRAITS.iter().map(|(k, _)| *k).collect();
                return Err(AppError::invalid(format!("{key} is not a trait. Use {}.", names.join(", "))));
            }
            out.insert(key.clone(), json!(cut(value.as_str().unwrap_or("").trim(), 4000)));
        }
        changes.insert("traits".into(), Value::Object(out));
    }
    if args.get("genres").is_some() {
        changes.insert("genres".into(), json!(crate::mcp::suggest::string_list(args, "genres")));
    }
    Ok(changes)
}

fn create_writing_style(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let changes = style_changes(args)?;
    let Some(name) = changes.get("name").and_then(Value::as_str).map(str::to_string) else {
        return Err(AppError::invalid("A style needs a name."));
    };
    let blend = args.get("blend").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut payload = Map::new();
    payload.insert("name".into(), json!(name));
    payload.insert("reason".into(), reason(args));
    cx.read(|ctx| {
        if customs(ctx).iter().any(|s| title_key(&text(s, "name")) == title_key(&name)) {
            return Err(AppError::new(
                "TITLE_TAKEN",
                format!("The writer already has a style called \"{name}\". Use update_writing_style to change it, or choose another name."),
            ));
        }
        if blend.is_empty() {
            return Ok(());
        }
        if !(2..=3).contains(&blend.len()) {
            return Err(AppError::invalid("A blend takes two or three styles."));
        }
        let mut parts = Vec::new();
        for part in &blend {
            let wanted = part.as_str().map(|s| json!({ "style": s })).unwrap_or_else(|| part.clone());
            let style = style_arg(ctx, &wanted, "style")?;
            let weight = match optional(&wanted, "weight") {
                "" => "some",
                w if WEIGHTS.contains(&w) => w,
                w => return Err(AppError::invalid(format!("weight must be mostly, some or touch, not {w}."))),
            };
            parts.push(json!({ "styleId": text(&style, "id"), "name": text(&style, "name"), "weight": weight }));
        }
        payload.insert("blend".into(), Value::Array(parts));
        Ok(())
    })?;
    if blend.is_empty() {
        let has_prompt = changes.get("promptOverride").and_then(Value::as_str).is_some_and(|p| !p.is_empty());
        let has_traits = changes
            .get("traits")
            .and_then(Value::as_object)
            .is_some_and(|t| t.values().any(|v| v.as_str().is_some_and(|s| !s.is_empty())));
        if !has_prompt && !has_traits {
            return Err(AppError::invalid("Give a prompt, some traits, or a blend of styles."));
        }
    }
    for (key, value) in changes {
        if key != "name" {
            payload.insert(key, value);
        }
    }
    Ok(Draft::new("newWritingStyle", name.clone(), Value::Object(payload))
        .suggested(format!("Suggested a new writing style \"{name}\" (suggestion {{id}}). It does not exist yet: the writer reviews it in LoreCraft under Outside suggestions."))
        .done(format!("created the writing style \"{name}\". It is in Writing styles, under the writer's own styles.")))
}

fn update_writing_style(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let changes = style_changes(args)?;
    let before = cx.read(|ctx| custom_arg(ctx, args))?;
    let id = text(&before, "id");
    let title = text(&before, "name");
    let mut real = Map::new();
    for (key, value) in changes {
        let old = if key == "traits" {
            // Traits merge, so only the ones given change.
            let mut merged = before["traits"].as_object().cloned().unwrap_or_default();
            merged.extend(value.as_object().cloned().unwrap_or_default());
            if Value::Object(merged.clone()) != before["traits"] {
                real.insert(key, Value::Object(merged));
            }
            continue;
        } else {
            before.get(&key).cloned().unwrap_or(Value::Null)
        };
        let unchanged = old == value || (old.is_null() && value.as_str() == Some(""));
        if !unchanged {
            real.insert(key, value);
        }
    }
    if real.is_empty() {
        return Err(AppError::invalid("Nothing would change. Give a new name, description, prompt, traits or genres."));
    }
    let payload = json!({ "id": id, "changes": real, "before": before, "reason": reason(args) });
    Ok(Draft::new("writingStyle", title.clone(), payload)
        .suggested(format!("Suggested a change to the writing style \"{title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."))
        .done(format!("changed the writing style \"{title}\".")))
}

fn delete_writing_style(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let before = cx.read(|ctx| custom_arg(ctx, args))?;
    let id = text(&before, "id");
    let title = text(&before, "name");
    let payload = json!({ "id": id, "before": before, "reason": reason(args) });
    Ok(Draft::new("deleteWritingStyle", title.clone(), payload)
        .suggested(format!("Suggested deleting the writing style \"{title}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."))
        .done(format!("deleted the writing style \"{title}\". Projects that use it keep their own copy, and the writer can undo it.")))
}

fn set_default_style(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let scope = match optional(args, "scope") {
        "" if !optional(args, "scene").is_empty() => "scene",
        "" if !optional(args, "book").is_empty() => "book",
        "" => "project",
        s @ ("project" | "book" | "scene") => s,
        other => return Err(AppError::invalid(format!("scope must be project, book or scene, not {other}."))),
    };
    let wanted = optional(args, "style");
    let clear = wanted.is_empty() || wanted.eq_ignore_ascii_case("none");
    let (target_kind, target_id, place, scope_value, style, before) = cx.read(|ctx| {
        let chosen = choices(ctx)?;
        let (target_kind, target_id, place, scope_value, before) = match scope {
            "project" => ("meta", CHOICES_KEY.to_string(), "the project".to_string(), json!({ "kind": "project" }), chosen["project"].clone()),
            "book" => {
                let (id, title) = resolve_book(ctx, optional(args, "book"))?;
                let before = chosen["books"][&id].clone();
                ("book", id.clone(), format!("the book \"{title}\""), json!({ "kind": "book", "bookId": id }), before)
            }
            _ => {
                let scene = optional(args, "scene");
                if scene.is_empty() {
                    return Err(AppError::invalid("Give the scene's title or id."));
                }
                let (id, title) = resolve_scene_id(ctx, &json!({ "id": scene }))
                    .or_else(|_| resolve_scene_id(ctx, &json!({ "title": scene })))?;
                let before = chosen["scenes"][&id].clone();
                ("node", id.clone(), format!("the scene \"{title}\""), json!({ "kind": "scene", "nodeId": id }), before)
            }
        };
        let style = if clear { None } else { Some(style_arg(ctx, args, "style")?) };
        Ok((target_kind, target_id, place, scope_value, style, before))
    })?;
    let style_id = style.as_ref().map(|s| text(s, "id"));
    let before_id = before["styleId"].as_str().map(str::to_string);
    if style_id == before_id {
        return Err(AppError::invalid(format!("Nothing would change: {place} already uses that.")));
    }
    let style_name = style.as_ref().map(|s| text(s, "name"));
    let payload = json!({
        "metaKey": CHOICES_KEY,
        "scope": scope_value,
        "place": place,
        "styleId": style_id,
        "styleName": style_name,
        "before": before_id,
        "reason": reason(args),
    });
    let title = format!("Default style for {place}");
    let done = match &style_name {
        Some(name) => format!("{place} now uses the style \"{name}\" by default."),
        None => format!("{place} no longer has its own style, so the wider choice applies."),
    };
    Ok(Draft::new("defaultStyle", title, payload)
        .target(target_kind, target_id)
        .suggested(format!("Suggested a default style for {place} (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."))
        .done(done))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::config::PERMISSION_EDIT;
    use crate::mcp::suggest::{self, call, call_as, resolve, resolve_with, STATUS_APPLIED, STATUS_APPLYING, STATUS_AUTO};
    use crate::mcp::write::Waits;
    use crate::rpc::call as rpc;
    use std::sync::Arc;
    use std::time::Duration;

    fn project() -> (Arc<Engine>, crate::engine::TestDir, String) {
        let (engine, _host, dir) = Engine::for_test();
        rpc(&engine, "project.new", json!({ "name": "Ashfall" }));
        engine.settings()["writingStyles"] = json!({ "custom": [{
            "id": "custom-1", "kind": "custom", "name": "Ashen voice", "genres": [], "summary": "Spare and cold.",
            "traits": { "narration": "Close third.", "sentences": "Short.", "diction": "", "dialogue": "", "description": "", "pacing": "", "signature": "", "avoid": "" },
        }], "favorites": [] });
        let books = rpc(&engine, "books.list", json!({}));
        let tree = rpc(&engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap()["id"].as_str().unwrap().to_string();
        rpc(&engine, "nodes.update", json!({ "id": scene, "patch": { "title": "At the gate" } }));
        (engine, dir, scene)
    }

    fn read_tool(engine: &Engine, name: &str, args: Value) -> AppResult<String> {
        let customs = custom_styles(engine);
        engine.read(|conn| {
            let mut ctx = Ctx::new(conn, "Ashfall".into(), true, false)?;
            ctx.custom_styles = Some(customs);
            crate::mcp::tools::call(&ctx, name, &args)
        })
    }

    fn last(engine: &Engine) -> Value {
        engine.read(|c| suggest::list(c, "pending")).unwrap().pop().unwrap()
    }

    fn quick() -> Waits {
        Waits { claim: Duration::from_millis(600), apply: Duration::from_millis(1500), poll: Duration::from_millis(20) }
    }

    fn window(engine: &Arc<Engine>) -> std::thread::JoinHandle<()> {
        let engine = engine.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(15));
                let waiting = engine.read(|c| suggest::list(c, STATUS_AUTO)).unwrap();
                if let Some(row) = waiting.first() {
                    let id = row["id"].as_str().unwrap().to_string();
                    assert!(engine.write(|tx| resolve(tx, &id, STATUS_APPLYING)).unwrap());
                    assert!(engine.write(|tx| resolve_with(tx, &id, STATUS_APPLIED, &Map::new())).unwrap());
                    return;
                }
            }
        })
    }

    #[test]
    fn the_library_copy_loads() {
        assert!(LIBRARY.len() > 100);
        assert!(LIBRARY.iter().all(|s| s["prompt"].as_str().is_some_and(|p| p.contains(CLOSING_END))));
    }

    #[test]
    fn lists_built_in_and_custom_styles_and_shows_one() {
        let (engine, _dir, _scene) = project();
        let list = read_tool(&engine, "list_writing_styles", json!({})).unwrap();
        assert!(list.contains("Agatha Christie (id agatha-christie; author"), "{list}");
        assert!(list.contains("Ashen voice (id custom-1; custom)"), "{list}");
        assert!(list.contains("no default style"), "{list}");
        let mine = read_tool(&engine, "list_writing_styles", json!({ "kind": "custom" })).unwrap();
        assert!(!mine.contains("Agatha"), "{mine}");
        let one = read_tool(&engine, "get_writing_style", json!({ "style": "agatha-christie" })).unwrap();
        assert!(one.contains("Write in the manner of Agatha Christie."), "{one}");
        let own = read_tool(&engine, "get_writing_style", json!({ "style": "ashen voice" })).unwrap();
        assert!(own.contains("Write in this style: Ashen voice.") && own.contains("Narration: Close third."), "{own}");
        assert_eq!(read_tool(&engine, "get_writing_style", json!({ "style": "Nobody" })).unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn create_queues_a_style_or_a_blend() {
        let (engine, _dir, _scene) = project();
        let said = call(&engine, "c", "create_writing_style", &json!({ "name": "Glass", "prompt": "Bright and brittle." }), false).unwrap();
        assert!(said.contains("does not exist yet"), "{said}");
        let p = last(&engine);
        assert_eq!(p["kind"], "newWritingStyle");
        assert_eq!(p["payload"]["promptOverride"], "Bright and brittle.");
        call(&engine, "c", "create_writing_style", &json!({ "name": "Mix", "blend": [{ "style": "Agatha Christie", "weight": "mostly" }, "custom-1"] }), false).unwrap();
        let p = last(&engine);
        assert_eq!(p["payload"]["blend"][1]["styleId"], "custom-1");
        assert_eq!(p["payload"]["blend"][1]["weight"], "some");
        let missing = call(&engine, "c", "create_writing_style", &json!({ "name": "Mix 2", "blend": ["agatha-christie", "nobody"] }), false).unwrap_err();
        assert_eq!(missing.code, "NOT_FOUND");
        let taken = call(&engine, "c", "create_writing_style", &json!({ "name": "ashen voice", "prompt": "x" }), false).unwrap_err();
        assert_eq!(taken.code, "TITLE_TAKEN");
        assert!(call(&engine, "c", "create_writing_style", &json!({ "name": "Empty" }), false).is_err());
    }

    #[test]
    fn only_custom_styles_change_or_go_and_the_old_one_is_kept() {
        let (engine, _dir, _scene) = project();
        call(&engine, "c", "update_writing_style", &json!({ "style": "Ashen voice", "traits": { "sentences": "Very short." } }), false).unwrap();
        let p = last(&engine);
        assert_eq!(p["kind"], "writingStyle");
        assert_eq!(p["payload"]["changes"]["traits"]["sentences"], "Very short.");
        assert_eq!(p["payload"]["changes"]["traits"]["narration"], "Close third.");
        assert_eq!(p["payload"]["before"]["traits"]["sentences"], "Short.");
        call(&engine, "c", "delete_writing_style", &json!({ "style": "custom-1" }), false).unwrap();
        let p = last(&engine);
        assert_eq!(p["kind"], "deleteWritingStyle");
        assert_eq!(p["payload"]["before"]["name"], "Ashen voice");
        for tool in ["update_writing_style", "delete_writing_style"] {
            let built_in = call(&engine, "c", tool, &json!({ "style": "agatha-christie", "name": "Mine" }), false).unwrap_err();
            assert_eq!(built_in.code, "NOT_ALLOWED", "{tool}");
            let missing = call(&engine, "c", tool, &json!({ "style": "Nobody", "name": "Mine" }), false).unwrap_err();
            assert_eq!(missing.code, "NOT_FOUND", "{tool}");
        }
        let same = call(&engine, "c", "update_writing_style", &json!({ "style": "custom-1", "name": "Ashen voice" }), false).unwrap_err();
        assert_eq!(same.code, "INVALID");
    }

    #[test]
    fn a_default_style_names_its_scope_and_keeps_the_old_choice() {
        let (engine, _dir, scene) = project();
        rpc(&engine, "project.setMeta", json!({ "key": CHOICES_KEY, "value": "{\"project\":{\"styleId\":\"custom-1\"}}" }));
        call(&engine, "c", "set_default_style", &json!({ "style": "Agatha Christie" }), false).unwrap();
        let p = last(&engine);
        assert_eq!(p["kind"], "defaultStyle");
        assert_eq!(p["targetKind"], "meta");
        assert_eq!(p["payload"]["styleId"], "agatha-christie");
        assert_eq!(p["payload"]["before"], "custom-1");
        call(&engine, "c", "set_default_style", &json!({ "scene": "At the gate", "style": "custom-1" }), false).unwrap();
        let p = last(&engine);
        assert_eq!(p["targetKind"], "node");
        assert_eq!(p["payload"]["scope"]["nodeId"], scene.as_str());
        assert!(p["payload"]["before"].is_null());
        call(&engine, "c", "set_default_style", &json!({ "scope": "book", "style": "custom-1" }), false).unwrap();
        assert_eq!(last(&engine)["targetKind"], "book");
        let missing = call(&engine, "c", "set_default_style", &json!({ "scene": "Nowhere", "style": "custom-1" }), false).unwrap_err();
        assert_eq!(missing.code, "NOT_FOUND");
        let same = call(&engine, "c", "set_default_style", &json!({ "style": "custom-1" }), false).unwrap_err();
        assert_eq!(same.code, "INVALID");
    }

    #[test]
    fn a_local_only_scene_cannot_get_a_style() {
        let (engine, _dir, scene) = project();
        engine
            .write(|tx| {
                tx.execute("UPDATE nodes SET local_only = 1 WHERE id = ?1", [&scene])?;
                Ok(())
            })
            .unwrap();
        let hidden = call(&engine, "c", "set_default_style", &json!({ "scene": scene, "style": "custom-1" }), false).unwrap_err();
        assert_eq!(hidden.code, "NOT_FOUND");
        assert!(call(&engine, "c", "set_default_style", &json!({ "scene": scene, "style": "custom-1" }), true).is_ok());
    }

    #[test]
    fn the_style_guide_shows_each_field_and_voice_stays_its_own_field() {
        let (engine, _dir, _scene) = project();
        call(&engine, "c", "set_style_guide", &json!({ "tense": "Past tense", "voice": "Wry." }), false).unwrap();
        let p = last(&engine);
        assert_eq!(p["payload"]["changes"]["tense"], "Past tense");
        assert_eq!(p["payload"]["changes"]["voice"], "Wry.");
        assert!(read_tool(&engine, "get_style_guide", json!({})).unwrap().contains("no style guide yet"));
        rpc(&engine, "project.setMeta", json!({ "key": "writingStyles.guide", "value": "{\"project\":{\"tense\":\"Past tense\",\"avoid\":\"suddenly\"}}" }));
        let guide = read_tool(&engine, "get_style_guide", json!({})).unwrap();
        assert!(guide.contains("## tense (Tense)\nPast tense"), "{guide}");
        assert!(guide.contains("## avoid (Words and phrases to avoid)\nsuddenly"), "{guide}");
        assert!(!guide.contains("## pov"), "{guide}");
    }

    #[test]
    fn at_the_edit_level_a_style_change_says_done() {
        let (engine, _dir, _scene) = project();
        let helper = window(&engine);
        let said = call_as(&engine, "c", "create_writing_style", &json!({ "name": "Glass", "prompt": "Bright." }), false, PERMISSION_EDIT, quick()).unwrap();
        helper.join().unwrap();
        assert!(said.starts_with("Done: created the writing style"), "{said}");
        assert_eq!(engine.read(suggest::pending_count).unwrap(), 0);
    }
}
