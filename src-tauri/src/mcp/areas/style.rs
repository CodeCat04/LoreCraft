//! The style guide: reading it, and set_style_guide.
//!
//! The guide is the writer's own rules, kept as fields in project meta `writingStyles.guide`
//! (see `src/writingStyles/store.ts`). The app also keeps a plain copy, `styleGuide.text`,
//! which get_style_guide reads. A change goes through the app's own `saveGuide`, so both
//! stay in step and the Style guide screen shows it.

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use super::{empty_schema, read, write, Tool};
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{optional, reason};
use crate::mcp::tools::{self, Ctx};
use crate::mcp::write::{Draft, WriteCx};

pub const GUIDE_KEY: &str = "writingStyles.guide";
/// The guide's fields, as `GUIDE_FIELDS` in `src/writingStyles/guide.ts` names them.
pub const FIELDS: &[(&str, &str)] = &[
    ("tense", "Tense, such as Past tense."),
    ("pov", "Point of view, such as Third person limited."),
    ("distance", "Narrative distance."),
    ("spelling", "Spelling, such as UK English."),
    ("dialogue", "Dialogue punctuation."),
    ("content", "Content and tone, such as how dark it gets."),
    ("voice", "Voice notes: anything else about how the book should sound."),
    ("avoid", "Words and phrases to avoid, one per line."),
    ("prefer", "Words and phrases to prefer, one per line."),
    ("sample", "A short sample of the writer's prose to match."),
];
const MAX_FIELD: usize = 20_000;
/// Fields with one answer, which append replaces like any other.
const CHOICES: &[&str] = &["tense", "pov", "distance", "spelling", "dialogue"];

pub fn tools() -> Vec<Tool> {
    let mut properties = Map::new();
    properties.insert(
        "text".into(),
        json!({ "type": "string", "description": "Free-form rules for how to write. They go in the guide's voice notes." }),
    );
    for (name, about) in FIELDS {
        properties.insert((*name).into(), json!({ "type": "string", "description": about }));
    }
    properties.insert(
        "mode".into(),
        json!({ "type": "string", "enum": ["replace", "append"], "description": "replace (default) sets each field you give; append adds your text after what each longer field already says. Tense, pov, distance, spelling and dialogue are always replaced." }),
    );
    properties.insert("reason".into(), json!({ "type": "string", "description": "A short note to the writer saying why." }));
    vec![
        read(
            "get_style_guide",
            "The project's style guide: tense, point of view, voice, words to avoid. Follow it when writing or suggesting text. Empty if the writer has not set one.",
            empty_schema(),
            get_style_guide,
        ),
        write(
            "set_style_guide",
            "Change the project's style guide, the writer's own rules that every AI follows. Give text for free-form rules, or any of the named fields. mode replace sets them; append adds to what is there. Fields you leave out stay as they are. At the edit level the change is made at once and the writer can undo it; otherwise the writer reviews it under Outside suggestions. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": properties }),
            set_style_guide,
        ),
    ]
}

fn get_style_guide(ctx: &Ctx, _args: &Value) -> AppResult<String> {
    Ok(tools::style_guide(ctx.conn)?.unwrap_or_else(|| "This project has no style guide yet.".to_string()))
}

/// The project's own fields, as stored. Missing or damaged reads as empty.
pub fn project_guide(ctx: &Ctx) -> AppResult<Map<String, Value>> {
    let stored: Option<String> = ctx
        .conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [GUIDE_KEY], |r| r.get(0))
        .optional()?;
    let parsed: Value = stored.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    Ok(parsed["project"].as_object().cloned().unwrap_or_default())
}

fn set_style_guide(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let mode = match optional(args, "mode") {
        "" | "replace" => "replace",
        "append" => "append",
        other => return Err(AppError::invalid(format!("mode must be replace or append, not {other}."))),
    };
    let mut given: Vec<(&str, String)> = Vec::new();
    if let Some(text) = args.get("text").and_then(Value::as_str) {
        given.push(("voice", text.trim().to_string()));
    }
    for (name, _) in FIELDS {
        if let Some(value) = args.get(*name).and_then(Value::as_str) {
            if *name == "voice" && !given.is_empty() {
                // text and voice both name the voice notes, so they go in together.
                let joined = format!("{}\n\n{}", given[0].1, value.trim());
                given[0].1 = joined.trim().to_string();
            } else {
                given.push((name, value.trim().to_string()));
            }
        }
    }
    if given.is_empty() {
        return Err(AppError::invalid("Give text, or at least one field of the style guide."));
    }
    let current = cx.read(project_guide)?;
    let mut changes = Map::new();
    let mut before = Map::new();
    for (name, value) in given {
        let old = current.get(name).and_then(Value::as_str).unwrap_or("").to_string();
        let new = if mode == "append" && !CHOICES.contains(&name) && !old.trim().is_empty() && !value.is_empty() {
            format!("{}\n{}", old.trim_end(), value)
        } else {
            value
        };
        if new.chars().count() > MAX_FIELD {
            return Err(AppError::invalid(format!("{name} is too long for the style guide.")));
        }
        if new != old {
            changes.insert(name.into(), json!(new));
            before.insert(name.into(), json!(old));
        }
    }
    if changes.is_empty() {
        return Err(AppError::invalid("Nothing would change. The style guide already says that."));
    }
    let payload = json!({
        "metaKey": GUIDE_KEY,
        "mode": mode,
        "changes": changes,
        "before": before,
        "reason": reason(args),
    });
    Ok(Draft::new("styleGuide", "Style guide", payload)
        .target("meta", GUIDE_KEY)
        .suggested("Suggested a change to the style guide (suggestion {id}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions.")
        .done("the style guide is changed. Every AI in LoreCraft now follows it, and the writer can undo it under Outside suggestions."))
}
