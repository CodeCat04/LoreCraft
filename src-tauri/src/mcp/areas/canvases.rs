//! Reading canvases.

use serde_json::{json, Value};

use super::{empty_schema, read, Tool};
use crate::error::AppResult;
use crate::mcp::tools::{self, Ctx};

pub fn tools() -> Vec<Tool> {
    vec![
        read(
            "list_canvases",
            "List the project's canvases: free boards where the writer lays out cards, pages and scenes and links them with arrows. Returns titles and ids for get_canvas.",
            empty_schema(),
            |ctx, _| tools::list_canvases(ctx),
        ),
        read(
            "get_canvas",
            "Read one canvas by title or id: a plain outline of its cards (each text card's text and each linked page, scene or file), then its data in JSON Canvas format (nodes and edges).",
            json!({ "type": "object", "properties": {
                "title": { "type": "string", "description": "The canvas title." },
                "id": { "type": "string", "description": "The canvas id, if known. Used instead of the title." },
            }}),
            get_canvas,
        ),
    ]
}

/// The canvas as `tools::get_canvas` shows it, which leaves out cards for local-only pages and
/// scenes, with a line saying how many there are, so the client knows not to look for them.
pub(crate) fn get_canvas(ctx: &Ctx, args: &Value) -> AppResult<String> {
    let mut out = tools::get_canvas(ctx, args)?;
    if ctx.shares_local_only {
        return Ok(out);
    }
    let hidden = ctx.conn.query_row(
        "SELECT data FROM canvases WHERE deleted_at IS NULL AND (id = ?1 OR title_key = ?2) ORDER BY id = ?1 DESC, updated_at DESC",
        rusqlite::params![
            args["id"].as_str().unwrap_or("").trim(),
            crate::content::title_key(args["title"].as_str().unwrap_or(""))
        ],
        |r| r.get::<_, String>(0),
    );
    let Ok(data) = hidden else { return Ok(out) };
    let data: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
    let count = data["nodes"]
        .as_array()
        .map(|nodes| nodes.iter().filter(|n| super::canvas::card_is_hidden(ctx, n)).count())
        .unwrap_or(0);
    if count > 0 {
        let noun = if count == 1 { "1 card is hidden" } else { "cards are hidden" };
        let lead = if count == 1 { String::new() } else { format!("{count} ") };
        out.push_str(&format!(
            "

{lead}{noun}: they point at pages or scenes the writer keeps local only. Tools cannot see, change or remove them."
        ));
    }
    Ok(out)
}
