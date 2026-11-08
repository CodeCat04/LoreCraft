//! New wiki pages, and ideas for the writer's inbox.

use serde_json::{json, Map, Value};

use super::{direct, write, Tool};

/// An idea is a note, not a chapter.
pub const MAX_IDEA_CHARS: usize = 4000;
use crate::content::title_key;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{check_size, optional, required, string_list, MAX_LABEL, MAX_PENDING};
use crate::mcp::text::cut;
use crate::mcp::write::{Draft, WriteCx};
use crate::rpc::pages;

pub fn tools() -> Vec<Tool> {
    vec![
        direct(
            "add_idea",
            "Leave a short idea in the writer's idea inbox, such as a plot possibility or a question to settle. It changes no page or scene, and the writer decides what to do with it. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "text": { "type": "string", "description": "The idea, in a sentence or a short paragraph." },
            }, "required": ["text"] }),
            add_idea,
        ),
        write(
            "propose_new_page",
            "Suggest a new wiki page. Depending on the writer's setting, it waits for them under Outside suggestions, or is created at once. It starts as a draft. The body is Markdown and can use [[Page title]] links. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "title": { "type": "string", "description": "The new page's title." },
                "type": { "type": "string", "description": "The page type, such as article, character or place. Default article." },
                "body": { "type": "string", "description": "The page text, as Markdown." },
                "summary": { "type": "string", "description": "One or two sentences, shown on hover cards and in lists." },
                "infobox": { "type": "object", "description": "Infobox fields as label and text, such as {\"Born\": \"412 AE\"}.", "additionalProperties": { "type": "string" } },
                "aliases": { "type": "array", "items": { "type": "string" }, "description": "Other names for the page." },
                "categories": { "type": "array", "items": { "type": "string" }, "description": "Categories to put the page in." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["title", "body"] }),
            propose_new_page,
        ),
    ]
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

fn propose_new_page(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let title = required(args, "title")?.split_whitespace().collect::<Vec<_>>().join(" ");
    if title_key(&title).is_empty() {
        return Err(AppError::invalid("The page needs a title."));
    }
    if title.len() > MAX_LABEL {
        return Err(AppError::invalid("That title is too long."));
    }
    let body = required(args, "body")?;
    check_size("The body", body)?;
    let existing = cx.read(|ctx| pages::resolve_title(ctx.conn, &title))?;
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
    Ok(Draft::new("newPage", title.clone(), Value::Object(payload))
        .suggested(format!(
            "Suggested a new page \"{title}\" (suggestion {{id}}). It does not exist yet: the writer reviews it in LoreCraft under Outside suggestions, and it starts as a draft."
        ))
        .done(format!("created the page \"{title}\" as a draft.")))
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
