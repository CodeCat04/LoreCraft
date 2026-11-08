//! Reading the book: outline, scenes, chapters, the timeline and consistency findings.

use serde_json::json;

use super::{empty_schema, read, Tool};
use crate::mcp::tools::{self, DEFAULT_CHAPTER_CHARS};

pub fn tools() -> Vec<Tool> {
    vec![
        read(
            "get_outline",
            "The manuscript's structure: books, parts, chapters and scenes in reading order, with ids, status, word counts, point of view, story dates and synopses. Use the ids with get_scene and get_chapter.",
            json!({ "type": "object", "properties": {
                "book": { "type": "string", "description": "A book's title or id. Default all books." },
            }}),
            tools::get_outline,
        ),
        read(
            "get_scene",
            "Read one scene of the manuscript as plain text, with its chapter, status, point of view, location, cast, story date and synopsis. Figures appear as lines such as [Figure 2: label (description)]. Scene titles can repeat, so prefer an id from get_outline.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The scene id. Used instead of the title." },
                "title": { "type": "string", "description": "The scene title." },
            }}),
            tools::get_scene,
        ),
        read(
            "get_chapter",
            "Read a whole chapter or part, scene by scene, as plain text, within a size limit. It says which scenes did not fit.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The chapter id. Used instead of the title." },
                "title": { "type": "string", "description": "The chapter title." },
                "max_chars": { "type": "integer", "description": format!("Largest result size in characters. Default {DEFAULT_CHAPTER_CHARS}."), "minimum": 1000 },
            }}),
            tools::get_chapter,
        ),
        read(
            "get_timeline",
            "The in-world timeline: scenes that have a story date, in reading order, and wiki pages with dates such as births, deaths and events. Dates are free text as the writer entered them.",
            empty_schema(),
            |ctx, _| tools::get_timeline(ctx),
        ),
        read(
            "list_findings",
            "Consistency findings: contradictions and other problems found in the lore and the book, with their evidence.",
            json!({ "type": "object", "properties": {
                "status": { "type": "string", "enum": ["open", "fixed", "intentional", "ignored", "all"], "description": "Default open." },
                "limit": { "type": "integer", "description": "Most findings to return. Default 100.", "minimum": 1, "maximum": 1000 },
            }}),
            tools::list_findings,
        ),
    ]
}
