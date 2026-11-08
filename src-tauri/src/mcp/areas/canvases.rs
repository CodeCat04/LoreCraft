//! Reading canvases.

use serde_json::json;

use super::{empty_schema, read, Tool};
use crate::mcp::tools;

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
            tools::get_canvas,
        ),
    ]
}
