//! AI conversations, prompts, usage, keys, and asking a provider what it offers.
//! Keys go in here and never come back out: only whether one exists can be read.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{ok, parse, unknown};
use crate::ai::profile::Profile;
use crate::ai::{discover, keys, models};
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};

// ---- Conversations ----------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Conversation {
    id: String,
    title: String,
    context: Value,
    created_at: String,
    updated_at: String,
    /// The last message of the version on screen. None means the newest one.
    leaf_id: Option<String>,
}

fn conversation_from_row(r: &Row) -> rusqlite::Result<Conversation> {
    let context: String = r.get(2)?;
    Ok(Conversation {
        id: r.get(0)?,
        title: r.get(1)?,
        context: serde_json::from_str(&context).unwrap_or_else(|_| json!({})),
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
        leaf_id: r.get(5)?,
    })
}

const CONVERSATION_COLS: &str = "id, title, context, created_at, updated_at, leaf_id";

/// Tells a field that was left out from one set to null, so `"parentId": null` can mean
/// "the first message" while leaving it out means "after the last one".
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

/// A message of this conversation, or an error saying it is not one.
fn message_in(conn: &Connection, conversation_id: &str, id: &str) -> AppResult<StoredMessage> {
    let message = get_message(conn, id)?;
    if message.conversation_id != conversation_id {
        return Err(AppError::invalid("That message belongs to another conversation."));
    }
    Ok(message)
}

/// What a new message follows when the caller does not say: the end of the version on screen,
/// or else the newest message.
fn default_parent(conn: &Connection, conversation: &Conversation) -> AppResult<Option<String>> {
    if let Some(leaf) = &conversation.leaf_id {
        if message_in(conn, &conversation.id, leaf).is_ok() {
            return Ok(Some(leaf.clone()));
        }
    }
    Ok(list_messages(conn, &conversation.id)?.pop().map(|m| m.id))
}

fn get_conversation(conn: &Connection, id: &str) -> AppResult<Conversation> {
    conn.query_row(
        &format!("SELECT {CONVERSATION_COLS} FROM ai_conversations WHERE id = ?1"),
        [id],
        conversation_from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("That conversation"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredMessage {
    id: String,
    conversation_id: String,
    role: String,
    content: Value,
    profile_id: Option<String>,
    model: Option<String>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    created_at: String,
    /// The message this one follows. None for the first message of a conversation.
    parent_id: Option<String>,
}

const MESSAGE_COLS: &str =
    "id, conversation_id, role, content, profile_id, model, input_tokens, output_tokens, created_at, parent_id";

fn message_from_row(r: &Row) -> rusqlite::Result<StoredMessage> {
    let content: String = r.get(3)?;
    Ok(StoredMessage {
        id: r.get(0)?,
        conversation_id: r.get(1)?,
        role: r.get(2)?,
        // Kept as written, since replaying it to a provider depends on exact content.
        content: serde_json::from_str(&content).unwrap_or_else(|_| json!([])),
        profile_id: r.get(4)?,
        model: r.get(5)?,
        input_tokens: r.get(6)?,
        output_tokens: r.get(7)?,
        created_at: r.get(8)?,
        parent_id: r.get(9)?,
    })
}

fn list_messages(conn: &Connection, conversation_id: &str) -> AppResult<Vec<StoredMessage>> {
    // Ids are time-ordered, which breaks ties within one millisecond.
    let mut stmt = conn.prepare(&format!(
        "SELECT {MESSAGE_COLS} FROM ai_messages WHERE conversation_id = ?1 ORDER BY created_at, id"
    ))?;
    let rows = stmt.query_map([conversation_id], message_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn get_message(conn: &Connection, id: &str) -> AppResult<StoredMessage> {
    conn.query_row(
        &format!("SELECT {MESSAGE_COLS} FROM ai_messages WHERE id = ?1"),
        [id],
        message_from_row,
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("That message"))
}

// ---- Prompts ----------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Prompt {
    id: String,
    name: String,
    description: String,
    template: String,
    scope: String,
    action: String,
    builtin: bool,
    position: i64,
}

fn prompt_from_row(r: &Row) -> rusqlite::Result<Prompt> {
    Ok(Prompt {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        template: r.get(3)?,
        scope: r.get(4)?,
        action: r.get(5)?,
        builtin: r.get::<_, i64>(6)? != 0,
        position: r.get(7)?,
    })
}

const PROMPT_COLS: &str = "id, name, description, template, scope, action, builtin, position";

/// The built-in prompts: id, name, description, scope, action, template.
const BUILTIN_PROMPTS: &[(&str, &str, &str, &str, &str, &str)] = &[
    ("builtin:rewrite", "Rewrite", "Say the same thing a better way", "selection", "replace",
     "Rewrite this passage. Keep its meaning, facts and point of view, and make it read better."),
    ("builtin:tighten", "Tighten", "Cut what is not doing any work", "selection", "replace",
     "Tighten this passage. Cut filler and repetition, keep every fact and the author's voice."),
    ("builtin:expand", "Expand", "Add detail and depth", "selection", "replace",
     "Expand this passage with more detail and depth, keeping its voice, tense and point of view. Do not invent facts that contradict the lore."),
    ("builtin:grammar", "Fix grammar", "Correct mistakes only", "selection", "replace",
     "Correct spelling, grammar and punctuation in this passage. Change nothing else, and leave style choices alone."),
    ("builtin:vivid", "More vivid", "Stronger imagery and detail", "selection", "replace",
     "Make this passage more vivid, with concrete sensory detail and stronger verbs. Keep the events, facts and point of view the same."),
    ("builtin:continue", "Continue", "Write what comes next", "selection", "insert",
     "Continue from the end of this passage with what comes next, in the same voice, tense and point of view."),
    ("builtin:show", "Show, don't tell", "Turn statements into scene", "selection", "replace",
     "Rewrite this passage to show rather than tell, through action, dialogue and detail. Keep the same events."),
    ("builtin:dialogue", "Sharpen dialogue", "Make speech sound like people", "selection", "replace",
     "Sharpen the dialogue in this passage so each speaker sounds distinct and natural. Keep what happens the same."),
    ("builtin:flesh-out", "Flesh out this page", "Write the article from what is known", "page", "replace",
     "Write this wiki page as a full encyclopedia-style article, using what the lore establishes. Keep everything already in its text, and use [[Page Title]] links for other pages. Where you add something the lore does not establish, mark it with \"(to confirm)\" so the author can decide. Its summary and infobox fields are stored apart from the article, so use them but do not list them."),
    ("builtin:summary", "Write a summary", "A short description for this page", "page", "metadata",
     "Write a one or two sentence summary of this wiki page, suitable for a hover card. Reply with only the summary."),
    ("builtin:infobox", "Suggest infobox fields", "Facts for the side panel", "page", "metadata",
     "Suggest infobox fields for this wiki page. Take values only from what the lore establishes. If it says little, suggest the fields a page like this usually has, and leave their values empty for the writer to fill in."),
    ("builtin:scene-continue", "Continue writing", "Write what comes next in this scene", "scene", "insert",
     "Continue this scene from where it stops, in the same voice, tense and point of view."),
    ("builtin:synopsis", "Describe this scene's synopsis", "A short summary of what happens", "scene", "metadata",
     "Write a synopsis of this scene in two or three sentences: who is there, what happens and what changes. Reply with only the synopsis."),
    ("builtin:next", "What could happen next?", "Ideas for the following scene", "scene", "chat",
     "Suggest three different directions the story could take after this scene, each consistent with the lore. Scene so far:\n\n{{page}}"),
    ("builtin:plot-holes", "Find plot holes", "Check a scene against the lore", "chat", "chat",
     "Check this against the canon lore and point out anything that contradicts it, quoting both sides:\n\n{{page}}"),
    ("builtin:names", "Suggest names", "Names that fit this world", "chat", "chat",
     "Suggest ten names that fit this world for: "),
];

/// Adds any built-in prompt this project does not have yet. Runs on read and does not
/// mark the project dirty: if the user never saves, the next open simply adds them again.
fn seed_prompts(conn: &Connection) -> AppResult<()> {
    let now = db::now();
    let mut stmt = conn.prepare_cached(
        "INSERT OR IGNORE INTO prompts (id, name, description, template, scope, action, builtin, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?8)",
    )?;
    for (position, (id, name, description, scope, action, template)) in BUILTIN_PROMPTS.iter().enumerate() {
        stmt.execute(params![id, name, description, template, scope, action, position as i64, now])?;
    }
    Ok(())
}

fn list_prompts(conn: &Connection, scope: Option<&str>) -> AppResult<Vec<Prompt>> {
    seed_prompts(conn)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {PROMPT_COLS} FROM prompts WHERE (?1 IS NULL OR scope = ?1) ORDER BY builtin DESC, position, name"
    ))?;
    let rows = stmt.query_map([scope], prompt_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

const PROMPT_SCOPES: [&str; 4] = ["selection", "page", "scene", "chat"];
const PROMPT_ACTIONS: [&str; 4] = ["replace", "insert", "chat", "metadata"];

// ---- Dispatch ---------------------------------------------------------------

fn load_profile(engine: &Engine, profile_id: &str) -> AppResult<(Profile, Option<String>)> {
    let profile = {
        let settings = engine.settings();
        Profile::from_settings(&settings, profile_id).map_err(|e| AppError::new(&e.code, e.message))?
    };
    let key = keys::get(&engine.paths, profile_id)?;
    Ok((profile, key))
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    #[derive(Deserialize)]
    struct IdParam {
        id: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProfileParam {
        profile_id: String,
    }
    match action {
        // ---- Keys. There is deliberately no way to read one back. ------------
        "setKey" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                profile_id: String,
                key: String,
            }
            let p: P = parse(params)?;
            keys::set(&engine.paths, &p.profile_id, &p.key)?;
            ok(true)
        }
        "hasKey" => {
            let p: ProfileParam = parse(params)?;
            ok(keys::has(&engine.paths, &p.profile_id)?)
        }
        "deleteKey" => {
            let p: ProfileParam = parse(params)?;
            keys::delete(&engine.paths, &p.profile_id)?;
            ok(true)
        }

        // ---- Provider questions. These run on the blocking pool. --------------
        "listModels" => {
            let p: ProfileParam = parse(params)?;
            let (profile, key) = load_profile(engine, &p.profile_id)?;
            let models = tauri::async_runtime::block_on(models::list(&profile, key.as_deref()))
                .map_err(|e| AppError::new(&e.code, e.message))?;
            ok(models)
        }
        "testConnection" => {
            let p: ProfileParam = parse(params)?;
            let (profile, key) = load_profile(engine, &p.profile_id)?;
            Ok(tauri::async_runtime::block_on(models::test_connection(&profile, key.as_deref())))
        }
        "imageSupport" => {
            let p: ProfileParam = parse(params)?;
            let (profile, key) = load_profile(engine, &p.profile_id)?;
            let (supported, source) = tauri::async_runtime::block_on(models::image_support(&profile, key.as_deref()));
            Ok(json!({ "supported": supported, "source": source }))
        }
        // Takes no address, so it can only ever look at this computer's own common ports.
        "findLocalServers" => ok(tauri::async_runtime::block_on(discover::find(&discover::COMMON_PORTS))),

        // ---- Conversations ----------------------------------------------------
        "listConversations" => engine.read(|c| {
            let mut stmt = c.prepare(&format!(
                "SELECT {CONVERSATION_COLS} FROM ai_conversations ORDER BY updated_at DESC, id DESC"
            ))?;
            let rows = stmt.query_map([], conversation_from_row)?;
            let list: Vec<Conversation> = rows.collect::<Result<_, _>>()?;
            ok(list)
        }),
        "createConversation" => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct P {
                title: String,
                context: Option<Value>,
            }
            let p: P = parse(params)?;
            let conversation = engine.write(|tx| {
                let id = db::new_id();
                let now = db::now();
                tx.execute(
                    "INSERT INTO ai_conversations (id, title, context, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![id, p.title, p.context.unwrap_or_else(|| json!({})).to_string(), now],
                )?;
                get_conversation(tx, &id)
            })?;
            engine.notify("ai");
            ok(conversation)
        }
        "getConversation" => {
            let p: IdParam = parse(params)?;
            engine.read(|c| {
                let conversation = get_conversation(c, &p.id)?;
                let messages = list_messages(c, &p.id)?;
                ok(json!({ "conversation": conversation, "messages": messages }))
            })
        }
        "updateConversation" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                title: Option<String>,
                context: Option<Value>,
                /// Which version to show, by its last message.
                #[serde(rename = "leafId")]
                leaf_id: Option<String>,
            }
            let p: P = parse(params)?;
            let conversation = engine.write(|tx| {
                get_conversation(tx, &p.id)?;
                if let Some(leaf) = &p.leaf_id {
                    message_in(tx, &p.id, leaf)?;
                    tx.execute("UPDATE ai_conversations SET leaf_id = ?1 WHERE id = ?2", params![leaf, p.id])?;
                    // Looking at another version is not a change to the chat, so it keeps its place.
                    if p.title.is_none() && p.context.is_none() {
                        return get_conversation(tx, &p.id);
                    }
                }
                if let Some(title) = &p.title {
                    tx.execute("UPDATE ai_conversations SET title = ?1 WHERE id = ?2", params![title, p.id])?;
                }
                if let Some(context) = &p.context {
                    tx.execute(
                        "UPDATE ai_conversations SET context = ?1 WHERE id = ?2",
                        params![context.to_string(), p.id],
                    )?;
                }
                tx.execute(
                    "UPDATE ai_conversations SET updated_at = ?1 WHERE id = ?2",
                    params![db::now(), p.id],
                )?;
                get_conversation(tx, &p.id)
            })?;
            engine.notify("ai");
            ok(conversation)
        }
        "deleteConversation" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| {
                tx.execute("DELETE FROM ai_conversations WHERE id = ?1", [&p.id])?;
                Ok(())
            })?;
            engine.notify("ai");
            ok(true)
        }

        // ---- Messages ---------------------------------------------------------
        "addMessage" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                conversation_id: String,
                role: String,
                content: Value,
                profile_id: Option<String>,
                model: Option<String>,
                input_tokens: Option<i64>,
                output_tokens: Option<i64>,
                /// The message this follows. Null for the first one; left out for after the
                /// end of the version on screen.
                #[serde(default, deserialize_with = "present")]
                parent_id: Option<Option<String>>,
            }
            let p: P = parse(params)?;
            if !matches!(p.role.as_str(), "user" | "assistant") {
                return Err(AppError::invalid(format!("Unknown role: {}", p.role)));
            }
            if !p.content.is_array() {
                return Err(AppError::invalid("Message content must be a list of blocks."));
            }
            let message = engine.write(|tx| {
                let conversation = get_conversation(tx, &p.conversation_id)?;
                let parent = match &p.parent_id {
                    Some(Some(parent)) => Some(message_in(tx, &conversation.id, parent)?.id),
                    Some(None) => None,
                    None => default_parent(tx, &conversation)?,
                };
                let id = db::new_id();
                let now = db::now();
                tx.execute(
                    "INSERT INTO ai_messages (id, conversation_id, role, content, profile_id, model, input_tokens, output_tokens, created_at, parent_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![id, p.conversation_id, p.role, p.content.to_string(), p.profile_id, p.model, p.input_tokens, p.output_tokens, now, parent],
                )?;
                // What was just added is what the conversation shows.
                tx.execute(
                    "UPDATE ai_conversations SET updated_at = ?1, leaf_id = ?2 WHERE id = ?3",
                    params![now, id, p.conversation_id],
                )?;
                get_message(tx, &id)
            })?;
            engine.notify("ai");
            ok(message)
        }
        "listMessages" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                conversation_id: String,
            }
            let p: P = parse(params)?;
            ok(engine.read(|c| list_messages(c, &p.conversation_id))?)
        }
        // Removes this message and everything that follows it, for retrying. Other versions
        // stay. A later request never replays what is removed, so what remains is still
        // append-only.
        "deleteMessagesFrom" => {
            let p: IdParam = parse(params)?;
            let removed = engine.write(|tx| {
                let message = get_message(tx, &p.id)?;
                let conversation = get_conversation(tx, &message.conversation_id)?;
                let mut doomed = vec![message.id.clone()];
                let mut index = 0;
                while index < doomed.len() {
                    let mut stmt = tx.prepare("SELECT id FROM ai_messages WHERE parent_id = ?1")?;
                    let children: Vec<String> = stmt.query_map([&doomed[index]], |r| r.get(0))?.collect::<Result<_, _>>()?;
                    doomed.extend(children);
                    index += 1;
                }
                let mut removed = 0;
                for id in &doomed {
                    removed += tx.execute("DELETE FROM ai_messages WHERE id = ?1", [id])?;
                }
                // The version on screen ends where the removed part began.
                if conversation.leaf_id.as_ref().is_some_and(|leaf| doomed.contains(leaf)) {
                    tx.execute(
                        "UPDATE ai_conversations SET leaf_id = ?1 WHERE id = ?2",
                        params![message.parent_id, conversation.id],
                    )?;
                }
                Ok(removed)
            })?;
            engine.notify("ai");
            ok(removed)
        }

        // ---- Prompts ----------------------------------------------------------
        "listPrompts" => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct P {
                scope: Option<String>,
            }
            let p: P = parse(params)?;
            ok(engine.read(|c| list_prompts(c, p.scope.as_deref()))?)
        }
        "savePrompt" => {
            #[derive(Deserialize)]
            struct P {
                id: Option<String>,
                name: String,
                #[serde(default)]
                description: String,
                template: String,
                scope: String,
                #[serde(default)]
                action: Option<String>,
            }
            let p: P = parse(params)?;
            if p.name.trim().is_empty() {
                return Err(AppError::invalid("A prompt needs a name."));
            }
            if p.template.trim().is_empty() {
                return Err(AppError::invalid("A prompt needs some text."));
            }
            if !PROMPT_SCOPES.contains(&p.scope.as_str()) {
                return Err(AppError::invalid(format!("Unknown prompt scope: {}", p.scope)));
            }
            let action = p.action.unwrap_or_else(|| if p.scope == "chat" { "chat" } else { "replace" }.to_string());
            if !PROMPT_ACTIONS.contains(&action.as_str()) {
                return Err(AppError::invalid(format!("Unknown prompt action: {action}")));
            }
            let saved = engine.write(|tx| {
                seed_prompts(tx)?;
                let now = db::now();
                let id = match &p.id {
                    Some(id) => {
                        let changed = tx.execute(
                            "UPDATE prompts SET name = ?1, description = ?2, template = ?3, scope = ?4, action = ?5, updated_at = ?6 WHERE id = ?7",
                            params![p.name.trim(), p.description, p.template, p.scope, action, now, id],
                        )?;
                        if changed == 0 {
                            return Err(AppError::not_found("That prompt"));
                        }
                        id.clone()
                    }
                    None => {
                        let id = db::new_id();
                        let position: i64 = tx.query_row("SELECT COALESCE(MAX(position) + 1, 0) FROM prompts", [], |r| r.get(0))?;
                        tx.execute(
                            "INSERT INTO prompts (id, name, description, template, scope, action, builtin, position, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?8)",
                            params![id, p.name.trim(), p.description, p.template, p.scope, action, position, now],
                        )?;
                        id
                    }
                };
                tx.query_row(
                    &format!("SELECT {PROMPT_COLS} FROM prompts WHERE id = ?1"),
                    [&id],
                    prompt_from_row,
                )
                .map_err(AppError::from)
            })?;
            engine.notify("ai");
            ok(saved)
        }
        // A built-in can be edited but not lost, so deleting one restores its original text.
        "deletePrompt" => {
            let p: IdParam = parse(params)?;
            engine.write(|tx| {
                if let Some((_, name, description, scope, action, template)) =
                    BUILTIN_PROMPTS.iter().find(|(id, ..)| *id == p.id)
                {
                    tx.execute(
                        "UPDATE prompts SET name = ?1, description = ?2, template = ?3, scope = ?4, action = ?5, updated_at = ?6 WHERE id = ?7",
                        params![name, description, template, scope, action, db::now(), p.id],
                    )?;
                } else {
                    tx.execute("DELETE FROM prompts WHERE id = ?1", [&p.id])?;
                }
                Ok(())
            })?;
            engine.notify("ai");
            ok(true)
        }

        // ---- Usage ------------------------------------------------------------
        "recordUsage" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                profile_id: String,
                model: String,
                task: String,
                input_tokens: i64,
                output_tokens: i64,
                #[serde(default)]
                cost_usd: f64,
            }
            let p: P = parse(params)?;
            engine.write(|tx| {
                tx.execute(
                    "INSERT INTO ai_usage (id, day, profile_id, model, task, input_tokens, output_tokens, cost_usd, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![db::new_id(), db::local_day(), p.profile_id, p.model, p.task, p.input_tokens, p.output_tokens, p.cost_usd, db::now()],
                )?;
                Ok(())
            })?;
            engine.notify("aiUsage");
            ok(true)
        }
        "usageTotals" => engine.read(|c| {
            let (input, output, cost, requests): (i64, i64, f64, i64) = c.query_row(
                "SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cost_usd), 0), COUNT(*) FROM ai_usage",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?;
            let mut stmt = c.prepare(
                "SELECT profile_id, model, SUM(input_tokens), SUM(output_tokens), SUM(cost_usd), COUNT(*)
                 FROM ai_usage GROUP BY profile_id, model ORDER BY SUM(cost_usd) DESC, profile_id, model",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(json!({
                    "profileId": r.get::<_, String>(0)?,
                    "model": r.get::<_, String>(1)?,
                    "inputTokens": r.get::<_, i64>(2)?,
                    "outputTokens": r.get::<_, i64>(3)?,
                    "costUsd": r.get::<_, f64>(4)?,
                    "requests": r.get::<_, i64>(5)?,
                }))
            })?;
            let by_model: Vec<Value> = rows.collect::<Result<_, _>>()?;
            ok(json!({
                "inputTokens": input,
                "outputTokens": output,
                "costUsd": cost,
                "requests": requests,
                "byModel": by_model,
            }))
        }),
        _ => Err(unknown(&format!("ai.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::TestDir;
    use crate::rpc::{call, dispatch};
    use std::sync::Arc;

    fn project() -> (Arc<Engine>, TestDir) {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "T" }));
        (engine, dir)
    }

    #[test]
    fn keys_can_be_set_checked_and_deleted_but_never_read() {
        let (engine, _dir) = project();
        assert_eq!(call(&engine, "ai.hasKey", json!({ "profileId": "p" })), false);
        assert_eq!(call(&engine, "ai.setKey", json!({ "profileId": "p", "key": "sk-secret" })), true);
        assert_eq!(call(&engine, "ai.hasKey", json!({ "profileId": "p" })), true);
        // No action hands a key back, and settings do not hold it.
        assert!(dispatch(&engine, "ai.getKey", json!({ "profileId": "p" })).is_err());
        assert!(!call(&engine, "settings.get", json!({})).to_string().contains("sk-secret"));
        assert_eq!(call(&engine, "ai.deleteKey", json!({ "profileId": "p" })), true);
        assert_eq!(call(&engine, "ai.hasKey", json!({ "profileId": "p" })), false);
        assert_eq!(dispatch(&engine, "ai.setKey", json!({ "profileId": "p", "key": " " })).unwrap_err().code, "INVALID");
    }

    #[test]
    fn conversations_store_messages_in_order_with_blocks_intact() {
        let (engine, _dir) = project();
        let conv = call(&engine, "ai.createConversation", json!({ "title": "Chat", "context": { "pinned": ["a"] } }));
        let id = conv["id"].as_str().unwrap();
        assert_eq!(conv["context"]["pinned"][0], "a");

        let blocks = json!([
            { "type": "thinking", "text": "t", "provider": "anthropic", "raw": { "type": "thinking", "thinking": "t", "signature": "SIG" } },
            { "type": "toolCall", "id": "1", "name": "n", "input": { "z": 1, "a": 2 }, "provider": "anthropic", "raw": { "type": "tool_use", "input": { "z": 1, "a": 2 } } },
        ]);
        for n in 0..5 {
            call(&engine, "ai.addMessage", json!({ "conversationId": id, "role": "user", "content": [{ "type": "text", "text": format!("q{n}") }] }));
        }
        let answer = call(&engine, "ai.addMessage", json!({
            "conversationId": id, "role": "assistant", "content": blocks,
            "profileId": "p", "model": "m", "inputTokens": 3, "outputTokens": 4,
        }));
        assert_eq!(answer["inputTokens"], 3);

        let got = call(&engine, "ai.getConversation", json!({ "id": id }));
        let messages = got["messages"].as_array().unwrap();
        let texts: Vec<&str> = messages[..5].iter().map(|m| m["content"][0]["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["q0", "q1", "q2", "q3", "q4"]);
        // Replaying depends on this coming back exactly as it went in, key order included.
        assert_eq!(messages[5]["content"], blocks);
        assert_eq!(messages[5]["content"][1]["input"].to_string(), "{\"z\":1,\"a\":2}");
        assert_eq!(call(&engine, "ai.listConversations", json!({})).as_array().unwrap().len(), 1);
    }

    #[test]
    fn retrying_removes_a_message_and_everything_after_it() {
        let (engine, _dir) = project();
        let conv = call(&engine, "ai.createConversation", json!({}));
        let id = conv["id"].as_str().unwrap();
        let add = |role: &str, text: &str| {
            call(&engine, "ai.addMessage", json!({ "conversationId": id, "role": role, "content": [{ "type": "text", "text": text }] }))
        };
        add("user", "one");
        let second = add("assistant", "two");
        add("user", "three");
        add("assistant", "four");
        assert_eq!(call(&engine, "ai.deleteMessagesFrom", json!({ "id": second["id"] })), 3);
        let left = call(&engine, "ai.listMessages", json!({ "conversationId": id }));
        assert_eq!(left.as_array().unwrap().len(), 1);
        assert_eq!(left[0]["content"][0]["text"], "one");
    }

    #[test]
    fn edits_and_regenerations_are_kept_as_versions() {
        let (engine, _dir) = project();
        let conv = call(&engine, "ai.createConversation", json!({}));
        let id = conv["id"].as_str().unwrap();
        let add = |role: &str, text: &str, parent: Option<Value>| {
            let mut input = json!({ "conversationId": id, "role": role, "content": [{ "type": "text", "text": text }] });
            if let Some(parent) = parent {
                input["parentId"] = parent;
            }
            call(&engine, "ai.addMessage", input)
        };
        let question = add("user", "q", None);
        assert_eq!(question["parentId"], Value::Null);
        let first = add("assistant", "a1", None);
        assert_eq!(first["parentId"], question["id"]);
        // Asked again: another reply to the same question.
        let second = add("assistant", "a2", Some(question["id"].clone()));
        assert_eq!(second["parentId"], question["id"]);
        // Edited: another first message, with no parent.
        let edited = add("user", "q edited", Some(Value::Null));
        assert_eq!(edited["parentId"], Value::Null);
        let reply = add("assistant", "a3", None);
        assert_eq!(reply["parentId"], edited["id"], "a new message follows the last one added");

        let got = call(&engine, "ai.getConversation", json!({ "id": id }));
        assert_eq!(got["messages"].as_array().unwrap().len(), 5, "every version is kept");
        assert_eq!(got["conversation"]["leafId"], reply["id"]);

        // Showing another version is remembered, and does not move the chat up the list.
        let updated = got["conversation"]["updatedAt"].clone();
        let shown = call(&engine, "ai.updateConversation", json!({ "id": id, "leafId": first["id"] }));
        assert_eq!(shown["leafId"], first["id"]);
        assert_eq!(shown["updatedAt"], updated);
        let after_first = add("user", "follow-up", None);
        assert_eq!(after_first["parentId"], first["id"]);

        // Removing one version leaves the others, and the view ends where it was cut.
        assert_eq!(call(&engine, "ai.deleteMessagesFrom", json!({ "id": first["id"] })), 2);
        let got = call(&engine, "ai.getConversation", json!({ "id": id }));
        let texts: Vec<&str> = got["messages"].as_array().unwrap().iter().map(|m| m["content"][0]["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["q", "a2", "q edited", "a3"]);
        assert_eq!(got["conversation"]["leafId"], question["id"]);
    }

    #[test]
    fn a_version_cannot_follow_a_message_from_another_chat() {
        let (engine, _dir) = project();
        let one = call(&engine, "ai.createConversation", json!({}));
        let two = call(&engine, "ai.createConversation", json!({}));
        let there = call(&engine, "ai.addMessage", json!({ "conversationId": one["id"], "role": "user", "content": [] }));
        let error = dispatch(&engine, "ai.addMessage", json!({ "conversationId": two["id"], "role": "user", "content": [], "parentId": there["id"] })).unwrap_err();
        assert_eq!(error.code, "INVALID");
        assert_eq!(dispatch(&engine, "ai.updateConversation", json!({ "id": two["id"], "leafId": there["id"] })).unwrap_err().code, "INVALID");
        assert_eq!(dispatch(&engine, "ai.addMessage", json!({ "conversationId": two["id"], "role": "user", "content": [], "parentId": "nope" })).unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn deleting_a_conversation_removes_its_messages() {
        let (engine, _dir) = project();
        let conv = call(&engine, "ai.createConversation", json!({}));
        call(&engine, "ai.addMessage", json!({ "conversationId": conv["id"], "role": "user", "content": [] }));
        call(&engine, "ai.deleteConversation", json!({ "id": conv["id"] }));
        assert!(call(&engine, "ai.listConversations", json!({})).as_array().unwrap().is_empty());
        assert!(call(&engine, "ai.listMessages", json!({ "conversationId": conv["id"] })).as_array().unwrap().is_empty());
        assert_eq!(dispatch(&engine, "ai.getConversation", json!({ "id": conv["id"] })).unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn bad_messages_are_refused() {
        let (engine, _dir) = project();
        let conv = call(&engine, "ai.createConversation", json!({}));
        assert_eq!(dispatch(&engine, "ai.addMessage", json!({ "conversationId": conv["id"], "role": "system", "content": [] })).unwrap_err().code, "INVALID");
        assert_eq!(dispatch(&engine, "ai.addMessage", json!({ "conversationId": conv["id"], "role": "user", "content": "text" })).unwrap_err().code, "INVALID");
        assert_eq!(dispatch(&engine, "ai.addMessage", json!({ "conversationId": "nope", "role": "user", "content": [] })).unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn built_in_prompts_appear_without_dirtying_the_project() {
        let (engine, dir) = project();
        let target = dir.0.join("p.lorecraft");
        engine.allow_path(&target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        assert!(!engine.status().dirty);
        let prompts = call(&engine, "ai.listPrompts", json!({}));
        assert!(prompts.as_array().unwrap().len() >= 12);
        assert!(!engine.status().dirty, "reading prompts is not an edit");

        for scope in PROMPT_SCOPES {
            let list = call(&engine, "ai.listPrompts", json!({ "scope": scope }));
            assert!(!list.as_array().unwrap().is_empty(), "{scope}");
        }
        let selection = call(&engine, "ai.listPrompts", json!({ "scope": "selection" }));
        let names: Vec<&str> = selection.as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
        for quick in ["Rewrite", "Tighten", "Expand", "Fix grammar", "More vivid", "Continue"] {
            assert!(names.contains(&quick), "{quick} must be there");
        }
        let continue_prompt = selection.as_array().unwrap().iter().find(|p| p["name"] == "Continue").unwrap();
        assert_eq!(continue_prompt["action"], "insert");
    }

    #[test]
    fn prompts_can_be_added_edited_and_deleted_and_built_ins_can_be_restored() {
        let (engine, _dir) = project();
        let mine = call(&engine, "ai.savePrompt", json!({ "name": " Mine ", "template": "Do it to {{selection}}", "scope": "selection" }));
        assert_eq!(mine["name"], "Mine");
        assert_eq!(mine["builtin"], false);
        assert_eq!(mine["action"], "replace");
        let edited = call(&engine, "ai.savePrompt", json!({ "id": mine["id"], "name": "Mine 2", "template": "x", "scope": "chat", "action": "chat" }));
        assert_eq!(edited["name"], "Mine 2");
        assert_eq!(edited["id"], mine["id"]);
        call(&engine, "ai.deletePrompt", json!({ "id": mine["id"] }));
        let gone = call(&engine, "ai.listPrompts", json!({}));
        assert!(!gone.as_array().unwrap().iter().any(|p| p["id"] == mine["id"]));

        // Built-ins can be changed, and deleting one puts it back.
        call(&engine, "ai.savePrompt", json!({ "id": "builtin:rewrite", "name": "Rewrite", "template": "My way", "scope": "selection" }));
        let changed = call(&engine, "ai.listPrompts", json!({ "scope": "selection" }));
        assert_eq!(changed[0]["template"], "My way");
        assert_eq!(changed[0]["builtin"], true);
        call(&engine, "ai.deletePrompt", json!({ "id": "builtin:rewrite" }));
        let restored = call(&engine, "ai.listPrompts", json!({ "scope": "selection" }));
        assert!(restored[0]["template"].as_str().unwrap().starts_with("Rewrite this passage"));

        assert_eq!(dispatch(&engine, "ai.savePrompt", json!({ "name": "", "template": "x", "scope": "chat" })).unwrap_err().code, "INVALID");
        assert_eq!(dispatch(&engine, "ai.savePrompt", json!({ "name": "x", "template": "", "scope": "chat" })).unwrap_err().code, "INVALID");
        assert_eq!(dispatch(&engine, "ai.savePrompt", json!({ "name": "x", "template": "y", "scope": "nope" })).unwrap_err().code, "INVALID");
        assert_eq!(dispatch(&engine, "ai.savePrompt", json!({ "id": "missing", "name": "x", "template": "y", "scope": "chat" })).unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn usage_adds_up_for_the_project() {
        let (engine, _dir) = project();
        let empty = call(&engine, "ai.usageTotals", json!({}));
        assert_eq!(empty["requests"], 0);
        call(&engine, "ai.recordUsage", json!({ "profileId": "c", "model": "claude-opus-5-5", "task": "chat", "inputTokens": 100, "outputTokens": 10, "costUsd": 0.5 }));
        call(&engine, "ai.recordUsage", json!({ "profileId": "c", "model": "claude-opus-5-5", "task": "rewrite", "inputTokens": 50, "outputTokens": 5, "costUsd": 0.25 }));
        call(&engine, "ai.recordUsage", json!({ "profileId": "local", "model": "q", "task": "chat", "inputTokens": 1000, "outputTokens": 100 }));
        let totals = call(&engine, "ai.usageTotals", json!({}));
        assert_eq!(totals["inputTokens"], 1150);
        assert_eq!(totals["outputTokens"], 115);
        assert_eq!(totals["costUsd"], 0.75);
        assert_eq!(totals["requests"], 3);
        assert_eq!(totals["byModel"][0]["model"], "claude-opus-5-5");
        assert_eq!(totals["byModel"][0]["inputTokens"], 150);
    }

    #[test]
    fn ai_data_lives_in_the_project_file_and_needs_a_project() {
        let (engine, _host, _dir) = Engine::for_test();
        assert_eq!(dispatch(&engine, "ai.listConversations", json!({})).unwrap_err().code, "NO_PROJECT");
        // Keys and connection tests belong to the app, not to a project.
        assert_eq!(call(&engine, "ai.hasKey", json!({ "profileId": "x" })), false);
    }

    #[test]
    fn unknown_actions_are_refused() {
        let (engine, _dir) = project();
        assert_eq!(dispatch(&engine, "ai.nope", json!({})).unwrap_err().code, "UNKNOWN_METHOD");
    }

    #[test]
    fn list_models_and_test_connection_work_through_dispatch() {
        use crate::ai::transport::tests::{json_reply, serve};
        let (engine, _dir) = project();
        let server = serve(vec![
            json_reply("200 OK", "", "{\"data\":[{\"id\":\"m1\",\"max_model_len\":8192}]}"),
            json_reply("200 OK", "", "{\"data\":[{\"id\":\"m1\"}]}"),
        ]);
        call(&engine, "settings.update", json!({ "patch": { "ai": { "profiles": [
            { "id": "p", "kind": "openai-compatible", "baseUrl": server.url, "model": "m1" }
        ]}}}));
        let list = call(&engine, "ai.listModels", json!({ "profileId": "p" }));
        assert_eq!(list[0], json!({ "id": "m1", "contextTokens": 8192 }));
        let test = call(&engine, "ai.testConnection", json!({ "profileId": "p" }));
        assert_eq!(test["ok"], true);
        assert_eq!(dispatch(&engine, "ai.listModels", json!({ "profileId": "gone" })).unwrap_err().code, "NO_PROFILE");
    }

    #[test]
    fn finding_local_servers_needs_no_project_and_takes_no_address() {
        let (engine, _host, _dir) = Engine::for_test();
        // What it finds depends on this computer. That it answers, and takes no say in where
        // it looks, does not. A given address is ignored, so nothing else could be reached.
        let found = call(&engine, "ai.findLocalServers", json!({ "host": "example.com", "ports": [80] }));
        for server in found.as_array().unwrap() {
            assert!(server["baseUrl"].as_str().unwrap().starts_with("http://127.0.0.1:"), "{server}");
            assert!(discover::COMMON_PORTS.contains(&(server["port"].as_u64().unwrap() as u16)), "{server}");
        }
    }

    #[test]
    fn image_support_answers_through_dispatch() {
        use crate::ai::transport::tests::{json_reply, serve};
        let (engine, _dir) = project();
        let server = serve(vec![json_reply("200 OK", "", "{\"modalities\":{\"vision\":true}}")]);
        call(&engine, "settings.update", json!({ "patch": { "ai": { "profiles": [
            { "id": "p", "kind": "openai-compatible", "baseUrl": server.url },
            { "id": "c", "kind": "anthropic", "baseUrl": "https://api.anthropic.com" },
            { "id": "off", "kind": "anthropic", "baseUrl": "https://api.anthropic.com", "supportsImages": false },
        ]}}}));
        assert_eq!(call(&engine, "ai.imageSupport", json!({ "profileId": "p" })), json!({ "supported": true, "source": "detected" }));
        assert_eq!(call(&engine, "ai.imageSupport", json!({ "profileId": "c" })), json!({ "supported": true, "source": "default" }));
        assert_eq!(call(&engine, "ai.imageSupport", json!({ "profileId": "off" })), json!({ "supported": false, "source": "setting" }));
    }
}
