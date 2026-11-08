//! The prompt library: the writer's saved prompts for the AI menus and the chat. Tools can
//! read every prompt, and add, change or delete the writer's own. The built-in ones stay as
//! they are: the writer can change those in the app, and Restore puts them back.
//!
//! The app applies each change through the library's own RPCs (`src/ai/api.ts`, as
//! `src/ai/PromptLibrary.tsx` does), so the menus update.

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};

use super::{read, write, Tool};
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{check_size, optional, reason, required, MAX_LABEL};
use crate::mcp::text::cut;
use crate::mcp::tools::Ctx;
use crate::mcp::write::{Draft, WriteCx};

/// As `PROMPT_SCOPES` and `PROMPT_ACTIONS` in `rpc::ai`.
const SCOPES: &[&str] = &["selection", "page", "scene", "chat"];
const ACTIONS: &[&str] = &["replace", "insert", "chat", "metadata"];
const MAX_TEMPLATE: usize = 20_000;
const MAX_DESCRIPTION: usize = 500;

const BUILT_IN: &str = "That is one of LoreCraft's built-in prompts, which outside tools cannot change or delete. The writer can edit it in the prompt library, and Restore puts back the original. To make your own version, use create_prompt.";

fn fields_schema(required_fields: &[&str], with_id: bool) -> Value {
    let mut properties = Map::new();
    if with_id {
        properties.insert("id".into(), json!({ "type": "string", "description": "The prompt's id, from list_prompts." }));
    }
    properties.insert("name".into(), json!({ "type": "string", "description": "The name shown in the menu." }));
    properties.insert("description".into(), json!({ "type": "string", "description": "A short line saying what it does." }));
    properties.insert("template".into(), json!({ "type": "string", "description": "The prompt text. {{page}} stands for the page or scene text, {{selection}} for the selected text." }));
    properties.insert("scope".into(), json!({ "type": "string", "enum": SCOPES, "description": "Where it shows: selection (the selection menu), page, scene or chat." }));
    properties.insert("action".into(), json!({ "type": "string", "enum": ACTIONS, "description": "What the answer does: replace the text, insert after it, chat, or fill in metadata. Default replace, or chat for the chat scope." }));
    properties.insert("reason".into(), json!({ "type": "string", "description": "A short note to the writer saying why." }));
    json!({ "type": "object", "properties": properties, "required": required_fields })
}

pub fn tools() -> Vec<Tool> {
    vec![
        read(
            "list_prompts",
            "The prompt library: the saved prompts in the AI menus and the chat, built-in and the writer's own, with each one's id, name, scope, action and text. Changes nothing.",
            json!({ "type": "object", "properties": {
                "scope": { "type": "string", "enum": SCOPES, "description": "Only prompts for this place. Leave out for all." },
            } }),
            list_prompts,
        ),
        write(
            "create_prompt",
            "Add a prompt of the writer's own to the prompt library, so it shows in the AI menus or the chat. Needs LoreCraft to be open with this project.",
            fields_schema(&["name", "template", "scope"], false),
            create_prompt,
        ),
        write(
            "update_prompt",
            "Change one of the writer's own prompts in the prompt library. Fields you leave out stay as they are. Built-in prompts cannot be changed. Needs LoreCraft to be open with this project.",
            fields_schema(&["id"], true),
            update_prompt,
        ),
        write(
            "delete_prompt",
            "Delete one of the writer's own prompts from the prompt library. The writer can undo it. Built-in prompts cannot be deleted. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "The prompt's id, from list_prompts." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }, "required": ["id"] }),
            delete_prompt,
        ),
    ]
}

/// One prompt, as stored.
struct Prompt {
    id: String,
    name: String,
    description: String,
    template: String,
    scope: String,
    action: String,
    builtin: bool,
}

impl Prompt {
    fn fields(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "template": self.template,
            "scope": self.scope,
            "action": self.action,
        })
    }
}

fn has_prompts(ctx: &Ctx) -> AppResult<bool> {
    Ok(ctx
        .conn
        .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prompts'", [], |_| Ok(()))
        .optional()?
        .is_some())
}

const COLS: &str = "id, name, description, template, scope, action, builtin";

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Prompt> {
    Ok(Prompt {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        template: r.get(3)?,
        scope: r.get(4)?,
        action: r.get(5)?,
        builtin: r.get::<_, i64>(6)? != 0,
    })
}

fn find_prompt(ctx: &Ctx, id: &str) -> AppResult<Prompt> {
    let not_found = || AppError::not_found("A prompt with that id (see list_prompts)");
    // A built-in the app has not stored yet is still a built-in.
    if id.starts_with("builtin:") {
        return Err(AppError::new("NOT_ALLOWED", BUILT_IN));
    }
    if id.is_empty() || !has_prompts(ctx)? {
        return Err(not_found());
    }
    let prompt = ctx
        .conn
        .query_row(&format!("SELECT {COLS} FROM prompts WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(not_found)?;
    if prompt.builtin {
        return Err(AppError::new("NOT_ALLOWED", BUILT_IN));
    }
    Ok(prompt)
}

fn list_prompts(ctx: &Ctx, args: &Value) -> AppResult<String> {
    let scope = optional(args, "scope");
    if !scope.is_empty() && !SCOPES.contains(&scope) {
        return Err(AppError::invalid("scope must be selection, page, scene or chat."));
    }
    if !has_prompts(ctx)? {
        return Ok("The prompt library is empty. LoreCraft adds its built-in prompts when the writer opens it.".to_string());
    }
    let mut stmt = ctx.conn.prepare(&format!(
        "SELECT {COLS} FROM prompts WHERE (?1 = '' OR scope = ?1) ORDER BY builtin DESC, position, name"
    ))?;
    let prompts: Vec<Prompt> = stmt.query_map([scope], from_row)?.collect::<Result<_, _>>()?;
    if prompts.is_empty() {
        return Ok("No prompts for that scope.".to_string());
    }
    let mut out = String::from("The prompt library. Built-in prompts cannot be changed by outside tools; the writer's own can.\n");
    for p in prompts {
        out.push_str(&format!(
            "\n## {} (id {})\n{}. Scope {}, action {}.{}\n{}\n",
            p.name,
            p.id,
            if p.builtin { "Built-in" } else { "The writer's own" },
            p.scope,
            p.action,
            if p.description.trim().is_empty() { String::new() } else { format!(" {}", p.description.trim()) },
            cut(p.template.trim(), 4000)
        ));
    }
    Ok(out)
}

/// The fields given, checked. `base` fills in what is left out.
fn fields(args: &Value, base: Option<&Prompt>) -> AppResult<Value> {
    let pick = |name: &str, old: Option<&String>| -> String {
        match args.get(name).and_then(Value::as_str) {
            Some(v) => v.trim().to_string(),
            None => old.cloned().unwrap_or_default(),
        }
    };
    let name = pick("name", base.map(|p| &p.name)).split_whitespace().collect::<Vec<_>>().join(" ");
    let description = pick("description", base.map(|p| &p.description));
    let template = match args.get("template").and_then(Value::as_str) {
        Some(v) => v.to_string(),
        None => base.map(|p| p.template.clone()).unwrap_or_default(),
    };
    let scope = pick("scope", base.map(|p| &p.scope));
    if name.is_empty() {
        return Err(AppError::invalid("A prompt needs a name."));
    }
    if name.len() > MAX_LABEL {
        return Err(AppError::invalid("That name is too long."));
    }
    if description.chars().count() > MAX_DESCRIPTION {
        return Err(AppError::invalid("That description is too long. Keep it to a line."));
    }
    if template.trim().is_empty() {
        return Err(AppError::invalid("A prompt needs some text."));
    }
    check_size("The template", &template)?;
    if template.chars().count() > MAX_TEMPLATE {
        return Err(AppError::invalid("That prompt is too long."));
    }
    if !SCOPES.contains(&scope.as_str()) {
        return Err(AppError::invalid("scope must be selection, page, scene or chat."));
    }
    let given_action = optional(args, "action");
    let action = if !given_action.is_empty() {
        given_action.to_string()
    } else if let Some(p) = base.filter(|p| p.scope == scope) {
        p.action.clone()
    } else if scope == "chat" {
        "chat".to_string()
    } else {
        "replace".to_string()
    };
    if !ACTIONS.contains(&action.as_str()) {
        return Err(AppError::invalid("action must be replace, insert, chat or metadata."));
    }
    Ok(json!({ "name": name, "description": description, "template": template, "scope": scope, "action": action }))
}

fn create_prompt(_cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    required(args, "name")?;
    required(args, "template")?;
    required(args, "scope")?;
    let fields = fields(args, None)?;
    let name = fields["name"].as_str().unwrap_or_default().to_string();
    let payload = json!({ "fields": fields, "reason": reason(args) });
    Ok(Draft::new("newPrompt", name.clone(), payload)
        .suggested(format!(
            "Suggested a new prompt \"{name}\" (suggestion {{id}}). It does not exist yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("added the prompt \"{name}\" to the prompt library.")))
}

fn update_prompt(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let prompt = cx.read(|ctx| find_prompt(ctx, required(args, "id")?.trim()))?;
    let fields = fields(args, Some(&prompt))?;
    let before = prompt.fields();
    if fields == before {
        return Err(AppError::invalid("Nothing would change. The prompt already says that."));
    }
    let payload = json!({ "fields": fields, "before": before, "reason": reason(args) });
    Ok(Draft::new("updatePrompt", prompt.name.clone(), payload)
        .target("prompt", prompt.id)
        .suggested(format!(
            "Suggested a change to the prompt \"{}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions.",
            prompt.name
        ))
        .done(format!("changed the prompt \"{}\".", prompt.name)))
}

fn delete_prompt(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let prompt = cx.read(|ctx| find_prompt(ctx, required(args, "id")?.trim()))?;
    // The whole prompt stays here, so Undo can make it again.
    let payload = json!({ "before": prompt.fields(), "reason": reason(args) });
    Ok(Draft::new("deletePrompt", prompt.name.clone(), payload)
        .target("prompt", prompt.id)
        .suggested(format!(
            "Suggested deleting the prompt \"{}\" (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions.",
            prompt.name
        ))
        .done(format!("deleted the prompt \"{}\". The writer can undo it under Outside suggestions.", prompt.name)))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{json, Map, Value};

    use crate::engine::Engine;
    use crate::mcp::config::PERMISSION_EDIT;
    use crate::mcp::suggest::{self, call, call_as, STATUS_APPLIED, STATUS_APPLYING, STATUS_AUTO, STATUS_PENDING};
    use crate::mcp::write::Waits;
    use crate::rpc::call as rpc;

    fn project() -> (Arc<Engine>, crate::engine::TestDir, String) {
        let (engine, _host, dir) = Engine::for_test();
        rpc(&engine, "project.new", json!({ "name": "Prompts" }));
        let mine = rpc(&engine, "ai.savePrompt", json!({ "name": "Darker", "template": "Make this darker.", "scope": "selection" }));
        (engine, dir, mine["id"].as_str().unwrap().to_string())
    }

    fn pending(engine: &Engine) -> Vec<Value> {
        engine.read(|c| suggest::list(c, STATUS_PENDING)).unwrap()
    }

    fn quick() -> Waits {
        Waits { claim: Duration::from_millis(600), apply: Duration::from_millis(1500), poll: Duration::from_millis(20) }
    }

    fn window(engine: &Arc<Engine>) -> std::thread::JoinHandle<Option<Value>> {
        let engine = engine.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(15));
                let waiting = engine.read(|c| suggest::list(c, STATUS_AUTO)).unwrap();
                if let Some(row) = waiting.first() {
                    let id = row["id"].as_str().unwrap().to_string();
                    assert!(engine.write(|tx| suggest::resolve(tx, &id, STATUS_APPLYING)).unwrap());
                    let mut extra = Map::new();
                    extra.insert("undo".into(), json!({ "id": "p2" }));
                    assert!(engine.write(|tx| suggest::resolve_with(tx, &id, STATUS_APPLIED, &extra)).unwrap());
                    return Some(row.clone());
                }
            }
            None
        })
    }

    #[test]
    fn list_prompts_shows_built_in_and_own() {
        let (engine, _dir, mine) = project();
        let text = engine
            .read(|conn| {
                let ctx = crate::mcp::tools::Ctx::new(conn, "Prompts".into(), true, false)?;
                crate::mcp::tools::call(&ctx, "list_prompts", &json!({}))
            })
            .unwrap();
        assert!(text.contains("builtin:rewrite") && text.contains("Built-in"), "{text}");
        assert!(text.contains(&mine) && text.contains("Make this darker."), "{text}");
        let chat = engine
            .read(|conn| {
                let ctx = crate::mcp::tools::Ctx::new(conn, "Prompts".into(), true, false)?;
                crate::mcp::tools::call(&ctx, "list_prompts", &json!({ "scope": "chat" }))
            })
            .unwrap();
        assert!(!chat.contains("Darker"), "{chat}");
    }

    #[test]
    fn create_prompt_queues_and_checks_its_fields() {
        let (engine, _dir, _mine) = project();
        let args = json!({ "name": "Brighter", "template": "Make this brighter.", "scope": "selection" });
        let said = call(&engine, "c", "create_prompt", &args, false).unwrap();
        assert!(said.contains("does not exist yet"), "{said}");
        let p = &pending(&engine)[0];
        assert_eq!(p["kind"], "newPrompt");
        assert_eq!(p["payload"]["fields"]["action"], "replace");
        assert!(call(&engine, "c", "create_prompt", &json!({ "name": "x", "template": "y", "scope": "nowhere" }), false).is_err());
        assert!(call(&engine, "c", "create_prompt", &json!({ "name": "x", "template": " ", "scope": "chat" }), false).is_err());
        // Nothing was made yet.
        let all = rpc(&engine, "ai.listPrompts", json!({}));
        assert!(!all.as_array().unwrap().iter().any(|p| p["name"] == "Brighter"));
    }

    #[test]
    fn create_prompt_at_the_edit_level_is_applied_by_the_app() {
        let (engine, _dir, _mine) = project();
        let helper = window(&engine);
        let args = json!({ "name": "Brighter", "template": "Make this brighter.", "scope": "chat" });
        let said = call_as(&engine, "c", "create_prompt", &args, false, PERMISSION_EDIT, quick()).unwrap();
        let row = helper.join().unwrap().expect("picked up");
        assert!(said.starts_with("Done: "), "{said}");
        assert_eq!(row["title"], "Brighter");
        assert_eq!(row["payload"]["fields"]["action"], "chat");
    }

    #[test]
    fn update_prompt_keeps_the_old_fields_and_refuses_built_ins() {
        let (engine, _dir, mine) = project();
        call(&engine, "c", "update_prompt", &json!({ "id": mine, "template": "Make this much darker." }), false).unwrap();
        let p = &pending(&engine)[0];
        assert_eq!(p["kind"], "updatePrompt");
        assert_eq!(p["targetId"], mine);
        assert_eq!(p["payload"]["fields"]["name"], "Darker");
        assert_eq!(p["payload"]["fields"]["template"], "Make this much darker.");
        assert_eq!(p["payload"]["before"]["template"], "Make this darker.");
        assert!(call(&engine, "c", "update_prompt", &json!({ "id": mine, "name": "Darker" }), false).is_err());
        assert_eq!(call(&engine, "c", "update_prompt", &json!({ "id": "nope", "name": "x" }), false).unwrap_err().code, "NOT_FOUND");
        let refused = call(&engine, "c", "update_prompt", &json!({ "id": "builtin:rewrite", "name": "x" }), false).unwrap_err();
        assert_eq!(refused.code, "NOT_ALLOWED");
        assert!(refused.message.contains("Restore"), "{}", refused.message);
    }

    #[test]
    fn delete_prompt_keeps_the_whole_prompt_and_refuses_built_ins() {
        let (engine, _dir, mine) = project();
        let said = call(&engine, "c", "delete_prompt", &json!({ "id": mine }), false).unwrap();
        assert!(said.contains("Nothing has changed yet"), "{said}");
        let p = &pending(&engine)[0];
        assert_eq!(p["kind"], "deletePrompt");
        assert_eq!(p["payload"]["before"]["template"], "Make this darker.");
        assert_eq!(call(&engine, "c", "delete_prompt", &json!({ "id": "nope" }), false).unwrap_err().code, "NOT_FOUND");
        assert_eq!(call(&engine, "c", "delete_prompt", &json!({ "id": "builtin:tighten" }), false).unwrap_err().code, "NOT_ALLOWED");
        assert!(rpc(&engine, "ai.listPrompts", json!({})).as_array().unwrap().iter().any(|p| p["id"] == mine.as_str()));
    }
}
