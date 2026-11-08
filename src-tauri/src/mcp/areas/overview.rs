//! Getting up to speed: catch_me_up, and what the outside AI is allowed to do.

use serde_json::{json, Value};

use rusqlite::OptionalExtension;

use super::{empty_schema, read, Tool};
use crate::error::AppResult;
use crate::mcp::config::{PERMISSION_EDIT, PERMISSION_READ};
use crate::mcp::tools::{self, Ctx, DEFAULT_CATCH_UP_CHARS, MIN_CATCH_UP_CHARS, STATUS_HELP};

pub fn tools() -> Vec<Tool> {
    vec![
        read(
            "catch_me_up",
            format!(
                "Call this first. One call gets you up to speed on the project: its books and their structure with word counts, the story so far, the main wiki pages with their status and summaries, and the style guide. It says what was left out for size and how to read more. {STATUS_HELP}"
            ),
            json!({ "type": "object", "properties": {
                "max_chars": { "type": "integer", "description": format!("Largest result size in characters. Default {DEFAULT_CATCH_UP_CHARS}. A small local model may want less."), "minimum": MIN_CATCH_UP_CHARS },
            }}),
            tools::catch_me_up,
        ),
        read(
            "get_settings_overview",
            "What you are allowed to do here: the writer's permission level for outside tools (read only, suggest, or make changes directly), whether local-only content is shared, and the project's language. Use it to tell the writer what to change in LoreCraft if they want you to do more. You cannot change these settings yourself.",
            empty_schema(),
            settings_overview,
        ),
    ]
}

fn permission_words(permission: Option<&str>) -> &'static str {
    match permission {
        Some(PERMISSION_READ) => "Read only. You can read the lore and the book, but not suggest or make changes. The writer can allow more in LoreCraft under Settings, AI tools (MCP), What outside tools can do.",
        Some(PERMISSION_EDIT) => "Make changes directly. Your changes are made at once, through the same code as when the writer accepts a suggestion, and each one shows under Outside suggestions, Applied by outside AI, where the writer can undo it.",
        Some(_) => "Suggest changes. Your changes wait under Outside suggestions until the writer accepts or rejects each one. The writer can let you make changes directly in LoreCraft under Settings, AI tools (MCP), What outside tools can do.",
        None => "Unknown: LoreCraft is not open with this project, so you are reading the saved file and cannot change anything. Changes need LoreCraft to be open.",
    }
}

fn settings_overview(ctx: &Ctx, _args: &Value) -> AppResult<String> {
    let language: Option<String> = ctx
        .conn
        .query_row("SELECT value FROM meta WHERE key = 'language'", [], |r| r.get(0))
        .optional()?;
    let language = language.filter(|l| !l.trim().is_empty());
    let sharing = if ctx.shares_local_only {
        "Shared. The writer lets outside tools see pages and scenes marked local only."
    } else {
        "Hidden. Pages and scenes the writer marked local only do not exist for you, and you cannot change them."
    };
    Ok(format!(
        "# What you can do in {project}

Permission: {permission}

Local-only content: {sharing}

Project language: {language}

No outside tool can change these settings, AI providers or keys, spending limits, or what is local only, delete the project, or write files outside it. Only the writer can, in LoreCraft.
",
        project = if ctx.project_name.is_empty() { "this project" } else { &ctx.project_name },
        permission = permission_words(ctx.permission.as_deref()),
        language = language.as_deref().unwrap_or("not set, so write in the language the book is in"),
    ))
}
