//! Consistency checks: running the rule checks, and deciding about findings.
//!
//! The rule checks run in the app (`src/consistency/rules`), so a run is a change the app
//! applies like any other. AI checks are left to the writer: they use the writer's AI, and
//! a cloud one costs money, so the app asks before each run. A finding quoting a local-only
//! page or scene does not exist for the client, as in `list_findings`.

use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use super::{write, Tool};
use crate::error::{AppError, AppResult};
use crate::mcp::suggest::{optional, reason};
use crate::mcp::tools::Ctx;
use crate::mcp::write::{Draft, WriteCx};

pub fn tools() -> Vec<Tool> {
    let finding = |verb: &str| {
        json!({ "type": "object", "properties": {
            "id": { "type": "string", "description": format!("The finding's id, from list_findings. The finding to {verb}.") },
            "title": { "type": "string", "description": "The finding's title, if there is no id." },
            "reason": { "type": "string", "description": "A short note to the writer saying why." },
        }})
    };
    let mut dismiss = finding("dismiss");
    dismiss["properties"]["why"] = json!({
        "type": "string", "enum": ["ignored", "intentional"],
        "description": "ignored (not a problem worth fixing, the default) or intentional (the writer meant it).",
    });
    vec![
        write(
            "run_consistency_check",
            "Run LoreCraft's rule checks: dates in the wrong order, characters after their death, look-alike names, broken links and the like. It updates the findings list and returns a summary; read the findings with list_findings. AI checks are not run: they use the writer's AI, so the writer starts them in the app. Needs LoreCraft to be open with this project.",
            json!({ "type": "object", "properties": {
                "ai": { "type": "boolean", "description": "Ask for the AI checks too. They are not run from here; the answer says how the writer can run them." },
                "reason": { "type": "string", "description": "A short note to the writer saying why." },
            }}),
            run_consistency_check,
        ),
        write(
            "dismiss_finding",
            "Dismiss an open consistency finding, as ignored or intentional. It changes only the finding's status, and a later run keeps the decision. Needs LoreCraft to be open with this project.",
            dismiss,
            dismiss_finding,
        ),
        write(
            "resolve_finding",
            "Mark a consistency finding as fixed. It changes only the finding's status; fix the text itself with the propose_ tools. Needs LoreCraft to be open with this project.",
            finding("mark as fixed"),
            resolve_finding,
        ),
    ]
}

fn run_consistency_check(_cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    if args.get("ai").and_then(Value::as_bool) == Some(true) {
        return Err(AppError::invalid(
            "AI checks use the writer's own AI and may cost them money, so only the writer can start them, in LoreCraft under Consistency. Run this without ai for the rule checks.",
        ));
    }
    let payload = json!({ "checks": "rules", "reason": reason(args) });
    Ok(Draft::new("consistencyRun", "Rule checks", payload)
        .suggested("Suggested running the rule checks (suggestion {id}). Nothing has run yet: the writer reviews it in LoreCraft under Outside suggestions.")
        .done("ran the rule checks."))
}

/// A visible finding by id, or else by title, as (id, title, status).
fn find_finding(ctx: &Ctx, args: &Value) -> AppResult<(String, String, String)> {
    let id = optional(args, "id").trim();
    let title = optional(args, "title").trim();
    if id.is_empty() && title.is_empty() {
        return Err(AppError::invalid("Give a finding id or title, from list_findings."));
    }
    let has_table = ctx
        .conn
        .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'findings'", [], |_| Ok(()))
        .optional()?
        .is_some();
    let missing = || AppError::not_found(if id.is_empty() { format!("A finding called \"{title}\"") } else { "That finding".to_string() });
    if !has_table {
        return Err(missing());
    }
    let mut stmt = ctx.conn.prepare(
        "SELECT id, title, status, evidence FROM findings
         WHERE (?1 != '' AND id = ?1) OR (?1 = '' AND lower(title) = lower(?2))
         ORDER BY status = 'open' DESC, updated_at DESC",
    )?;
    let rows = stmt.query_map([id, title], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
    })?;
    let mut found = Vec::new();
    for row in rows {
        let (id, title, status, evidence) = row?;
        if !touches_hidden(ctx, &evidence) {
            found.push((id, title, status));
        }
    }
    match found.len() {
        0 => Err(missing()),
        1 => Ok(found.remove(0)),
        _ => Err(AppError::invalid(format!(
            "More than one finding is called \"{title}\". Use an id: {}.",
            found.iter().take(8).map(|f| f.0.as_str()).collect::<Vec<_>>().join(", ")
        ))),
    }
}

/// A finding quotes its sources, so one built on something hidden stays hidden.
fn touches_hidden(ctx: &Ctx, evidence: &str) -> bool {
    let evidence: Value = serde_json::from_str(evidence).unwrap_or_else(|_| json!([]));
    evidence.as_array().map(Vec::as_slice).unwrap_or(&[]).iter().any(|item| {
        let id = item["sourceId"].as_str().unwrap_or("");
        if item["sourceKind"].as_str() == Some("node") {
            ctx.node_hidden(id)
        } else {
            ctx.page_hidden(id)
        }
    })
}

fn set_status(cx: &WriteCx, args: &Value, status: &str) -> AppResult<Draft> {
    let (id, title, before) = cx.read(|ctx| find_finding(ctx, args))?;
    if before == status {
        return Err(AppError::invalid(format!("That finding is already {status}.")));
    }
    let payload = json!({ "findingId": id, "status": status, "before": before, "reason": reason(args) });
    let what = match status {
        "fixed" => "marked as fixed",
        "intentional" => "marked as intentional",
        _ => "dismissed",
    };
    Ok(Draft::new("findingStatus", title.clone(), payload)
        .suggested(format!(
            "Suggested that the finding \"{title}\" be {what} (suggestion {{id}}). Nothing has changed yet: the writer reviews it in LoreCraft under Outside suggestions."
        ))
        .done(format!("{what} the finding \"{title}\".")))
}

fn dismiss_finding(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    let why = match optional(args, "why").trim() {
        "" | "ignored" | "ignore" => "ignored",
        "intentional" => "intentional",
        other => return Err(AppError::invalid(format!("\"{other}\" is not a reason. Use ignored or intentional."))),
    };
    set_status(cx, args, why)
}

fn resolve_finding(cx: &WriteCx, args: &Value) -> AppResult<Draft> {
    set_status(cx, args, "fixed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Engine, TestDir};
    use crate::mcp::config::PERMISSION_EDIT;
    use crate::mcp::suggest::{self, call, call_as, STATUS_APPLIED, STATUS_APPLYING, STATUS_AUTO, STATUS_PENDING};
    use crate::mcp::write::Waits;
    use crate::rpc::call as rpc;
    use serde_json::Map;
    use std::sync::Arc;
    use std::time::Duration;

    fn quick() -> Waits {
        Waits { claim: Duration::from_millis(600), apply: Duration::from_millis(1500), poll: Duration::from_millis(20) }
    }

    fn window(engine: &Arc<Engine>, report: &'static str) -> std::thread::JoinHandle<()> {
        let engine = engine.clone();
        std::thread::spawn(move || {
            for _ in 0..100 {
                std::thread::sleep(Duration::from_millis(15));
                let waiting = engine.read(|c| suggest::list(c, STATUS_AUTO)).unwrap();
                if let Some(row) = waiting.first() {
                    let id = row["id"].as_str().unwrap().to_string();
                    assert!(engine.write(|tx| suggest::resolve(tx, &id, STATUS_APPLYING)).unwrap());
                    let mut extra = Map::new();
                    extra.insert("undo".into(), json!({ "report": report }));
                    assert!(engine.write(|tx| suggest::resolve_with(tx, &id, STATUS_APPLIED, &extra)).unwrap());
                    return;
                }
            }
        })
    }

    struct Project {
        engine: Arc<Engine>,
        _dir: TestDir,
        open: String,
        secret: String,
    }

    fn project() -> Project {
        let (engine, _host, dir) = Engine::for_test();
        rpc(&engine, "project.new", json!({ "name": "Ashfall" }));
        let page = rpc(&engine, "pages.create", json!({ "title": "Aria" }))["id"].as_str().unwrap().to_string();
        let hidden = rpc(&engine, "pages.create", json!({ "title": "Twist" }))["id"].as_str().unwrap().to_string();
        rpc(&engine, "pages.update", json!({ "id": hidden, "patch": { "localOnly": true } }));
        let finding = |fp: &str, title: &str, source: &str| {
            json!({
                "source": "rule", "rule": "date-order", "severity": "error", "title": title, "detail": "",
                "evidence": [{ "sourceKind": "page", "sourceId": source, "title": "x", "quote": "Died: 300" }],
                "fingerprint": fp,
            })
        };
        rpc(&engine, "consistency.upsert", json!({ "findings": [finding("f1", "Aria dies twice", &page), finding("f2", "Secret dates", &hidden)] }));
        let all = rpc(&engine, "consistency.list", json!({}));
        let id_of = |title: &str| all.as_array().unwrap().iter().find(|f| f["title"] == title).unwrap()["id"].as_str().unwrap().to_string();
        Project { open: id_of("Aria dies twice"), secret: id_of("Secret dates"), engine, _dir: dir }
    }

    fn last(engine: &Engine) -> Value {
        engine.read(|c| suggest::list(c, STATUS_PENDING)).unwrap().pop().unwrap()
    }

    #[test]
    fn a_run_queues_at_the_suggest_level_and_ai_checks_are_left_to_the_writer() {
        let p = project();
        let said = call(&p.engine, "c", "run_consistency_check", &json!({}), false).unwrap();
        assert!(said.contains("Nothing has run yet"), "{said}");
        assert_eq!(last(&p.engine)["kind"], "consistencyRun");
        let ai = call(&p.engine, "c", "run_consistency_check", &json!({ "ai": true }), false).unwrap_err();
        assert_eq!(ai.code, "INVALID");
        assert_eq!(p.engine.read(suggest::pending_count).unwrap(), 1);
    }

    #[test]
    fn at_the_edit_level_a_run_returns_the_app_summary() {
        let p = project();
        let helper = window(&p.engine, "2 open findings: 1 error, 1 warning.");
        let said = call_as(&p.engine, "c", "run_consistency_check", &json!({}), false, PERMISSION_EDIT, quick()).unwrap();
        helper.join().unwrap();
        assert_eq!(said, "Done: ran the rule checks. 2 open findings: 1 error, 1 warning.");
    }

    #[test]
    fn dismiss_and_resolve_keep_the_old_status() {
        let p = project();
        call(&p.engine, "c", "dismiss_finding", &json!({ "id": p.open }), false).unwrap();
        let row = last(&p.engine);
        assert_eq!(row["kind"], "findingStatus");
        assert_eq!(row["payload"]["findingId"], p.open);
        assert_eq!(row["payload"]["status"], "ignored");
        assert_eq!(row["payload"]["before"], "open");
        call(&p.engine, "c", "dismiss_finding", &json!({ "title": "aria DIES twice", "why": "intentional" }), false).unwrap();
        assert_eq!(last(&p.engine)["payload"]["status"], "intentional");
        call(&p.engine, "c", "resolve_finding", &json!({ "id": p.open }), false).unwrap();
        assert_eq!(last(&p.engine)["payload"]["status"], "fixed");
        // Nothing changed yet.
        let all = rpc(&p.engine, "consistency.list", json!({}));
        assert!(all.as_array().unwrap().iter().all(|f| f["status"] == "open"));
        assert_eq!(call(&p.engine, "c", "dismiss_finding", &json!({ "id": p.open, "why": "bored" }), false).unwrap_err().code, "INVALID");
    }

    #[test]
    fn missing_and_local_only_findings_are_not_found() {
        let p = project();
        for args in [json!({ "id": "nope" }), json!({ "title": "Nope" }), json!({ "id": p.secret }), json!({ "title": "Secret dates" })] {
            assert_eq!(call(&p.engine, "c", "dismiss_finding", &args, false).unwrap_err().code, "NOT_FOUND", "{args}");
            assert_eq!(call(&p.engine, "c", "resolve_finding", &args, false).unwrap_err().code, "NOT_FOUND", "{args}");
        }
        assert_eq!(call(&p.engine, "c", "resolve_finding", &json!({}), false).unwrap_err().code, "INVALID");
        // Shared, it is there.
        assert!(call(&p.engine, "c", "resolve_finding", &json!({ "id": p.secret }), true).is_ok());
    }

    #[test]
    fn at_the_edit_level_dismissing_says_done() {
        let p = project();
        let helper = window(&p.engine, "");
        let said = call_as(&p.engine, "c", "dismiss_finding", &json!({ "id": p.open }), false, PERMISSION_EDIT, quick()).unwrap();
        helper.join().unwrap();
        assert_eq!(said, "Done: dismissed the finding \"Aria dies twice\".");
    }
}
