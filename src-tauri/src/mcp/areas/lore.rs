//! Reading the wiki: search, pages, lists and relationships.

use serde_json::json;

use super::{read, Tool};
use crate::mcp::tools::{self, STATUS_HELP};

pub fn tools() -> Vec<Tool> {
    vec![
        read(
            "search_lore",
            "Full-text search across the wiki pages and manuscript scenes. Returns titles, ids, each page's status, and a short excerpt. Use it to find where something is mentioned.",
            json!({ "type": "object", "properties": {
                "query": { "type": "string", "description": "Words to look for." },
                "kind": { "type": "string", "enum": ["all", "page", "scene"], "description": "Limit results to pages or scenes. Default all." },
                "limit": { "type": "integer", "description": "Most results to return. Default 20.", "minimum": 1, "maximum": 100 },
            }, "required": ["query"] }),
            tools::search_lore,
        ),
        read(
            "get_page",
            format!(
                "Read one wiki page by title or alias: its status, aliases, categories, infobox, plain text, and what links to it. Figures appear as lines such as [Figure 2: label (description)]. {STATUS_HELP}"
            ),
            json!({ "type": "object", "properties": {
                "title": { "type": "string", "description": "The page title or an alias." },
                "id": { "type": "string", "description": "The page id, if known. Used instead of the title." },
            }}),
            tools::get_page_text,
        ),
        read(
            "list_pages",
            format!(
                "List wiki pages with their status and summary, optionally filtered. Use it to see what exists. {STATUS_HELP}"
            ),
            json!({ "type": "object", "properties": {
                "status": { "type": "string", "enum": ["canon", "draft", "idea", "retconned"], "description": "Only pages with this status." },
                "type": { "type": "string", "description": "Only pages of this type, such as character or place." },
                "category": { "type": "string", "description": "Only pages in this category." },
                "sort": { "type": "string", "enum": ["title", "updated", "created", "words"], "description": "Default title." },
                "limit": { "type": "integer", "description": "Most pages to return. Default 200.", "minimum": 1, "maximum": 2000 },
            }}),
            tools::list_pages,
        ),
        read(
            "get_relationships",
            "Relationships between wiki pages as the writer recorded them, such as family, allies and rivals. Give a page to see only its relationships.",
            json!({ "type": "object", "properties": {
                "page": { "type": "string", "description": "A page title or alias. Default all relationships." },
            }}),
            tools::get_relationships,
        ),
    ]
}
