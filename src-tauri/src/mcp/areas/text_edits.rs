//! Changes to the text of a page or scene: propose_edit, propose_rewrite, propose_insert.
//! Each quotes the text as the client read it. The app finds the quotes again when it
//! applies the change (`src/mcp/kinds/text.tsx`), so a stale quote is refused there too.

use serde_json::{json, Value};

use super::{write, Tool};
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{check_size, optional, reason, required};
use crate::mcp::text::{closest_passage, doc_to_text, find_all, needle_for, normalize_quote, normalize_with_map, Normalized};
use crate::mcp::tools::{resolve_page, resolve_scene_id};
use crate::mcp::write::{Draft, WriteCx};
use crate::rpc::{manuscript, pages};

pub fn tools() -> Vec<Tool> {
    vec![
        write(
            "propose_edit",
            "Suggest replacing a short part of a wiki page or scene. Depending on the writer's setting, it waits for them under Outside suggestions, or is made at once and can be undone, so ask for what you think is right. Quote the existing text as get_page or get_scene shows it, with enough words to be unique. Curly quotes, dashes and line breaks need not match. The replacement can use Markdown such as *italic* and [[Page title]] links. Figures cannot be changed. For many paragraphs, use propose_rewrite. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "target": { "type": "string", "enum": ["page", "scene"], "description": "What to change." },
                "id": { "type": "string", "description": "The page or scene id. Used instead of the title." },
                "title": { "type": "string", "description": "The page or scene title." },
                "quote": { "type": "string", "description": "The existing text to replace, copied exactly." },
                "replacement": { "type": "string", "description": "The new text. Empty removes the quoted text." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["target", "quote", "replacement"] }),
            propose_edit,
        ),
        write(
            "propose_rewrite",
            "Suggest rewriting a long stretch of a scene, or the whole scene. Give from_quote and to_quote: a few unique words where the stretch starts and where it ends, both included. Or give whole: true to replace the entire scene. The replacement is Markdown; a blank line starts a new paragraph. The writer can review it paragraph by paragraph. Figures stay where they are. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The scene id, from get_outline. Used instead of the title." },
                "title": { "type": "string", "description": "The scene title." },
                "target": { "type": "string", "enum": ["scene", "page"], "description": "Default scene." },
                "from_quote": { "type": "string", "description": "The first words of the stretch, copied exactly. Must be unique." },
                "to_quote": { "type": "string", "description": "The last words of the stretch, copied exactly. Must be unique after from_quote." },
                "whole": { "type": "boolean", "description": "True to replace the whole scene. No quotes needed." },
                "replacement": { "type": "string", "description": "The new text, as Markdown." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["replacement"] }),
            propose_rewrite,
        ),
        write(
            "propose_insert",
            "Suggest adding new text to a scene: at the start or end, or right after or before a quote. Works on an empty scene. The text is Markdown; a blank line starts a new paragraph. If the quote ends a paragraph, the text comes as new paragraphs after it. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The scene id, from get_outline. Used instead of the title." },
                "title": { "type": "string", "description": "The scene title." },
                "target": { "type": "string", "enum": ["scene", "page"], "description": "Default scene." },
                "at": { "type": "string", "enum": ["start", "end"], "description": "Add at the start or the end." },
                "after_quote": { "type": "string", "description": "Add right after these words, copied exactly." },
                "before_quote": { "type": "string", "description": "Add right before these words, copied exactly." },
                "text": { "type": "string", "description": "The new text, as Markdown." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["text"] }),
            propose_insert,
        ),
    ]
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

fn load_target(cx: &WriteCx, args: &Value, default: &str) -> AppResult<Target> {
    let target = args
        .get("target")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(default);
    cx.read(|ctx| {
        let conn = ctx.conn;
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


fn store(target: Target, kind: &'static str, payload: Value) -> Draft {
    let title = target.title.clone();
    Draft::new(kind, title, payload).target(target.kind, target.id)
}

fn wants_whole(args: &Value) -> bool {
    match args.get("whole") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.trim().eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn propose_edit(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    if args.get("quote").is_none() && (args.get("from_quote").is_some() || wants_whole(args)) {
        return propose_rewrite(cx, args);
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
    let target = load_target(cx, args, "")?;
    let hay = normalize_with_map(&target.text);
    locate(&target, &hay, quote, "That quote", None)?;
    let payload = json!({ "quote": quote, "replacement": replacement, "reason": reason(args) });
    Ok(store(target, "edit", payload))
}

/// Rewrites a stretch given by its first and last words, or the whole scene.
fn propose_rewrite(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let replacement = args
        .get("replacement")
        .or_else(|| args.get("text"))
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::invalid("replacement is required."))?;
    check_size("The replacement", replacement)?;
    let target = load_target(cx, args, "scene")?;
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
    Ok(store(target, "rewrite", payload))
}

/// Adds text at the start or end, or next to a quote. Works on an empty scene too.
fn propose_insert(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let text = required(args, "text")?;
    check_size("The text", text)?;
    if normalize_quote(text).is_empty() {
        return Err(AppError::invalid("The text is empty."));
    }
    let target = load_target(cx, args, "scene")?;
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
    Ok(store(target, "insert", payload))
}
