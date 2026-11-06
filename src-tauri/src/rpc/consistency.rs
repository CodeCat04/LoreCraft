//! Consistency findings and the claims cache. The checks run in the UI, where the lore and
//! the models are. This stores what they found and what the writer decided about it.
//!
//! A finding is identified by its `fingerprint`, so running a check again updates the same
//! row. The writer's decisions survive that: `intentional` and `ignored` stay as they are.
//! Open findings a run no longer reports get closed, and a closed one that comes back opens
//! again.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{ok, parse, unknown};
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};

const SOURCES: [&str; 2] = ["rule", "ai"];
const SEVERITIES: [&str; 3] = ["info", "warning", "error"];
const STATUSES: [&str; 4] = ["open", "fixed", "intentional", "ignored"];

const FINDING_COLS: &str =
    "id, source, rule, severity, status, title, detail, evidence, fingerprint, created_at, updated_at, resolved_at";

fn finding_from_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let evidence: String = r.get(7)?;
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "source": r.get::<_, String>(1)?,
        "rule": r.get::<_, String>(2)?,
        "severity": r.get::<_, String>(3)?,
        "status": r.get::<_, String>(4)?,
        "title": r.get::<_, String>(5)?,
        "detail": r.get::<_, String>(6)?,
        "evidence": serde_json::from_str::<Value>(&evidence).unwrap_or_else(|_| json!([])),
        "fingerprint": r.get::<_, String>(8)?,
        "createdAt": r.get::<_, String>(9)?,
        "updatedAt": r.get::<_, String>(10)?,
        "resolvedAt": r.get::<_, Option<String>>(11)?,
    }))
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ListParams {
    status: Option<String>,
    source: Option<String>,
    rule: Option<String>,
}

fn list(conn: &Connection, filter: &ListParams) -> AppResult<Vec<Value>> {
    let sql = format!(
        "SELECT {FINDING_COLS} FROM findings
         WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR source = ?2) AND (?3 IS NULL OR rule = ?3)
         ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, rule, title, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![filter.status, filter.source, filter.rule], finding_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ---------------------------------------------------------------------------
// Storing a run's results
// ---------------------------------------------------------------------------

fn default_severity() -> String {
    "warning".to_string()
}

fn empty_list() -> Value {
    json!([])
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FindingInput {
    source: String,
    rule: String,
    #[serde(default = "default_severity")]
    severity: String,
    title: String,
    #[serde(default)]
    detail: String,
    #[serde(default = "empty_list")]
    evidence: Value,
    fingerprint: String,
}

/// Which open findings this run looked at, so that those it did not report have gone away.
/// A run over one scene says nothing about the findings of another.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloseScope {
    source: String,
    /// Only these rules. Every rule of the source if left out.
    rules: Option<Vec<String>>,
    /// Only findings that cite one of these pages or scenes. All of them if left out.
    source_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertParams {
    findings: Vec<FindingInput>,
    close: Option<CloseScope>,
}

fn check_finding(finding: &FindingInput) -> AppResult<()> {
    if !SOURCES.contains(&finding.source.as_str()) {
        return Err(AppError::invalid(format!("Unknown finding source: {}", finding.source)));
    }
    if !SEVERITIES.contains(&finding.severity.as_str()) {
        return Err(AppError::invalid(format!("Unknown severity: {}", finding.severity)));
    }
    if finding.fingerprint.trim().is_empty() {
        return Err(AppError::invalid("A finding needs a fingerprint."));
    }
    if finding.rule.trim().is_empty() || finding.title.trim().is_empty() {
        return Err(AppError::invalid("A finding needs a rule and a title."));
    }
    if !finding.evidence.is_array() {
        return Err(AppError::invalid("A finding's evidence must be a list."));
    }
    Ok(())
}

struct Existing {
    id: String,
    source: String,
    rule: String,
    severity: String,
    status: String,
    title: String,
    detail: String,
    evidence: Value,
}

fn existing_rows(conn: &Connection) -> AppResult<HashMap<String, Existing>> {
    let mut stmt = conn.prepare(
        "SELECT fingerprint, id, source, rule, severity, status, title, detail, evidence FROM findings",
    )?;
    let rows = stmt.query_map([], |r| {
        let evidence: String = r.get(8)?;
        Ok((
            r.get::<_, String>(0)?,
            Existing {
                id: r.get(1)?,
                source: r.get(2)?,
                rule: r.get(3)?,
                severity: r.get(4)?,
                status: r.get(5)?,
                title: r.get(6)?,
                detail: r.get(7)?,
                evidence: serde_json::from_str(&evidence).unwrap_or_else(|_| json!([])),
            },
        ))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn evidence_cites(evidence: &Value, ids: &[String]) -> bool {
    evidence.as_array().is_some_and(|items| {
        items.iter().any(|item| {
            item.get("sourceId")
                .and_then(Value::as_str)
                .is_some_and(|id| ids.iter().any(|wanted| wanted == id))
        })
    })
}

#[derive(Default)]
struct Plan {
    add: Vec<FindingInput>,
    /// Row id, new content, new status.
    change: Vec<(String, FindingInput, String)>,
    close: Vec<String>,
    unchanged: usize,
    /// Reported again, and left as the writer decided.
    decisions_kept: usize,
    reopened: usize,
}

impl Plan {
    fn is_empty(&self) -> bool {
        self.add.is_empty() && self.change.is_empty() && self.close.is_empty()
    }
}

fn plan_upsert(conn: &Connection, input: &UpsertParams) -> AppResult<Plan> {
    let existing = existing_rows(conn)?;
    let mut plan = Plan::default();
    let mut reported: HashSet<&str> = HashSet::new();

    for finding in &input.findings {
        // A run can reach the same finding twice. The first one stands.
        if !reported.insert(finding.fingerprint.as_str()) {
            continue;
        }
        let Some(row) = existing.get(&finding.fingerprint) else {
            plan.add.push(finding.clone());
            continue;
        };
        let status = if row.status == "fixed" { "open" } else { row.status.as_str() };
        if row.status == "fixed" {
            plan.reopened += 1;
        }
        if row.status == "intentional" || row.status == "ignored" {
            plan.decisions_kept += 1;
        }
        let same = row.source == finding.source
            && row.rule == finding.rule
            && row.severity == finding.severity
            && row.title == finding.title
            && row.detail == finding.detail
            && row.evidence == finding.evidence
            && row.status == status;
        if same {
            plan.unchanged += 1;
        } else {
            plan.change.push((row.id.clone(), finding.clone(), status.to_string()));
        }
    }

    if let Some(scope) = &input.close {
        for (fingerprint, row) in &existing {
            let in_scope = row.status == "open"
                && row.source == scope.source
                && scope.rules.as_ref().is_none_or(|rules| rules.contains(&row.rule))
                && scope.source_ids.as_ref().is_none_or(|ids| evidence_cites(&row.evidence, ids));
            if in_scope && !reported.contains(fingerprint.as_str()) {
                plan.close.push(row.id.clone());
            }
        }
    }
    Ok(plan)
}

fn apply_plan(conn: &Connection, plan: &Plan) -> AppResult<()> {
    let now = db::now();
    for finding in &plan.add {
        conn.execute(
            "INSERT INTO findings
               (id, source, rule, severity, status, title, detail, evidence, fingerprint, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                db::new_id(),
                finding.source,
                finding.rule,
                finding.severity,
                finding.title,
                finding.detail,
                finding.evidence.to_string(),
                finding.fingerprint,
                now,
            ],
        )?;
    }
    for (id, finding, status) in &plan.change {
        conn.execute(
            "UPDATE findings
                SET source = ?2, rule = ?3, severity = ?4, title = ?5, detail = ?6, evidence = ?7,
                    status = ?8, updated_at = ?9,
                    resolved_at = CASE WHEN ?8 = 'open' THEN NULL ELSE resolved_at END
              WHERE id = ?1",
            params![
                id,
                finding.source,
                finding.rule,
                finding.severity,
                finding.title,
                finding.detail,
                finding.evidence.to_string(),
                status,
                now,
            ],
        )?;
    }
    for id in &plan.close {
        conn.execute(
            "UPDATE findings SET status = 'fixed', resolved_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
    }
    Ok(())
}

fn upsert(engine: &Engine, input: UpsertParams) -> AppResult<Value> {
    for finding in &input.findings {
        check_finding(finding)?;
    }
    // An unchanged rerun writes nothing, so opening this screen does not mark the project
    // as having unsaved changes.
    let plan = engine.read(|conn| plan_upsert(conn, &input))?;
    if plan.is_empty() {
        return ok(summary(&plan));
    }
    let plan = engine.write(|tx| {
        let plan = plan_upsert(tx, &input)?;
        apply_plan(tx, &plan)?;
        Ok(plan)
    })?;
    engine.notify("findings");
    ok(summary(&plan))
}

fn summary(plan: &Plan) -> Value {
    json!({
        "added": plan.add.len(),
        "updated": plan.change.len(),
        "reopened": plan.reopened,
        "closed": plan.close.len(),
        "unchanged": plan.unchanged,
        "decisionsKept": plan.decisions_kept,
    })
}

// ---------------------------------------------------------------------------
// The writer's decisions
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SetStatusParams {
    id: String,
    status: String,
}

fn set_status(engine: &Engine, input: SetStatusParams) -> AppResult<Value> {
    if !STATUSES.contains(&input.status.as_str()) {
        return Err(AppError::invalid(format!("Unknown status: {}", input.status)));
    }
    let finding = engine.write(|tx| {
        let now = db::now();
        let changed = tx.execute(
            "UPDATE findings
                SET status = ?2, updated_at = ?3,
                    resolved_at = CASE WHEN ?2 = 'open' THEN NULL ELSE ?3 END
              WHERE id = ?1",
            params![input.id, input.status, now],
        )?;
        if changed == 0 {
            return Err(AppError::not_found("That finding"));
        }
        let sql = format!("SELECT {FINDING_COLS} FROM findings WHERE id = ?1");
        Ok(tx.query_row(&sql, [&input.id], finding_from_row)?)
    })?;
    engine.notify("findings");
    Ok(finding)
}

// ---------------------------------------------------------------------------
// Claims cache
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimsKey {
    source_kind: String,
    source_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimsPut {
    source_kind: String,
    source_id: String,
    content_hash: String,
    claims: Value,
    #[serde(default)]
    model: String,
}

fn claims_get(conn: &Connection, key: &ClaimsKey) -> AppResult<Value> {
    let row = conn
        .query_row(
            "SELECT content_hash, claims, model, created_at FROM claims_cache
              WHERE source_kind = ?1 AND source_id = ?2",
            params![key.source_kind, key.source_id],
            |r| {
                let claims: String = r.get(1)?;
                Ok(json!({
                    "sourceKind": key.source_kind,
                    "sourceId": key.source_id,
                    "contentHash": r.get::<_, String>(0)?,
                    "claims": serde_json::from_str::<Value>(&claims).unwrap_or(Value::Null),
                    "model": r.get::<_, String>(2)?,
                    "createdAt": r.get::<_, String>(3)?,
                }))
            },
        )
        .optional()?;
    Ok(row.unwrap_or(Value::Null))
}

fn claims_put(engine: &Engine, input: ClaimsPut) -> AppResult<Value> {
    if input.source_kind != "page" && input.source_kind != "node" {
        return Err(AppError::invalid(format!("Unknown source kind: {}", input.source_kind)));
    }
    engine.write(|tx| {
        tx.execute(
            "INSERT INTO claims_cache (source_kind, source_id, content_hash, claims, model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (source_kind, source_id) DO UPDATE SET
               content_hash = excluded.content_hash, claims = excluded.claims,
               model = excluded.model, created_at = excluded.created_at",
            params![
                input.source_kind,
                input.source_id,
                input.content_hash,
                input.claims.to_string(),
                input.model,
                db::now(),
            ],
        )?;
        Ok(())
    })?;
    ok(true)
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "list" => {
            let filter: ListParams = parse(params)?;
            ok(engine.read(|conn| list(conn, &filter))?)
        }
        "upsert" => upsert(engine, parse(params)?),
        "setStatus" => set_status(engine, parse(params)?),
        "claimsGet" => {
            let key: ClaimsKey = parse(params)?;
            engine.read(|conn| claims_get(conn, &key))
        }
        "claimsPut" => claims_put(engine, parse(params)?),
        _ => Err(unknown(&format!("consistency.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use crate::engine::Engine;
    use crate::rpc::{call, dispatch};
    use serde_json::{json, Value};

    fn finding(fingerprint: &str) -> Value {
        json!({
            "source": "rule",
            "rule": "date-order",
            "severity": "error",
            "title": format!("Finding {fingerprint}"),
            "detail": "Why it matters",
            "evidence": [{ "sourceKind": "page", "sourceId": "page-1", "title": "Aria", "quote": "Died: 300" }],
            "fingerprint": fingerprint,
        })
    }

    fn ai_finding(fingerprint: &str, source_id: &str) -> Value {
        json!({
            "source": "ai",
            "rule": "contradicts-lore",
            "title": format!("Finding {fingerprint}"),
            "evidence": [{ "sourceKind": "node", "sourceId": source_id, "title": "Scene", "quote": "her blue eyes" }],
            "fingerprint": fingerprint,
        })
    }

    fn opened() -> (std::sync::Arc<Engine>, std::sync::Arc<crate::engine::TestHost>, impl Sized) {
        let (engine, host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "C" }));
        (engine, host, dir)
    }

    fn all(engine: &Engine) -> Vec<Value> {
        call(engine, "consistency.list", json!({})).as_array().unwrap().clone()
    }

    fn status_of(engine: &Engine, fingerprint: &str) -> String {
        all(engine)
            .iter()
            .find(|f| f["fingerprint"] == fingerprint)
            .map(|f| f["status"].as_str().unwrap().to_string())
            .unwrap_or_else(|| panic!("no finding {fingerprint}"))
    }

    fn id_of(engine: &Engine, fingerprint: &str) -> String {
        all(engine)
            .iter()
            .find(|f| f["fingerprint"] == fingerprint)
            .map(|f| f["id"].as_str().unwrap().to_string())
            .unwrap_or_else(|| panic!("no finding {fingerprint}"))
    }

    #[test]
    fn stores_a_finding_with_its_evidence() {
        let (engine, _host, _dir) = opened();
        let result = call(&engine, "consistency.upsert", json!({ "findings": [finding("a")] }));
        assert_eq!(result["added"], 1);
        let stored = all(&engine);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0]["status"], "open");
        assert_eq!(stored[0]["severity"], "error");
        assert_eq!(stored[0]["evidence"][0]["quote"], "Died: 300");
        assert!(stored[0]["resolvedAt"].is_null());
    }

    #[test]
    fn the_same_fingerprint_updates_the_same_row() {
        let (engine, _host, _dir) = opened();
        call(&engine, "consistency.upsert", json!({ "findings": [finding("a")] }));
        let id = id_of(&engine, "a");
        let mut changed = finding("a");
        changed["title"] = json!("A better title");
        let result = call(&engine, "consistency.upsert", json!({ "findings": [changed] }));
        assert_eq!(result["updated"], 1);
        let stored = all(&engine);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0]["id"], id.as_str());
        assert_eq!(stored[0]["title"], "A better title");
    }

    #[test]
    fn a_rerun_keeps_the_writers_decisions() {
        let (engine, _host, _dir) = opened();
        call(&engine, "consistency.upsert", json!({ "findings": [finding("a"), finding("b"), finding("c")] }));
        call(&engine, "consistency.setStatus", json!({ "id": id_of(&engine, "a"), "status": "intentional" }));
        call(&engine, "consistency.setStatus", json!({ "id": id_of(&engine, "b"), "status": "ignored" }));

        let result = call(
            &engine,
            "consistency.upsert",
            json!({ "findings": [finding("a"), finding("b"), finding("c")], "close": { "source": "rule" } }),
        );
        assert_eq!(result["decisionsKept"], 2);
        assert_eq!(status_of(&engine, "a"), "intentional");
        assert_eq!(status_of(&engine, "b"), "ignored");
        assert_eq!(status_of(&engine, "c"), "open");

        // Not reported at all, and still as the writer left them.
        call(&engine, "consistency.upsert", json!({ "findings": [], "close": { "source": "rule" } }));
        assert_eq!(status_of(&engine, "a"), "intentional");
        assert_eq!(status_of(&engine, "b"), "ignored");
    }

    #[test]
    fn findings_that_no_longer_occur_are_closed_and_can_come_back() {
        let (engine, _host, _dir) = opened();
        call(&engine, "consistency.upsert", json!({ "findings": [finding("a"), finding("b")] }));

        let result = call(
            &engine,
            "consistency.upsert",
            json!({ "findings": [finding("a")], "close": { "source": "rule" } }),
        );
        assert_eq!(result["closed"], 1);
        assert_eq!(status_of(&engine, "a"), "open");
        assert_eq!(status_of(&engine, "b"), "fixed");
        let closed = all(&engine).into_iter().find(|f| f["fingerprint"] == "b").unwrap();
        assert!(closed["resolvedAt"].is_string());

        let result = call(
            &engine,
            "consistency.upsert",
            json!({ "findings": [finding("a"), finding("b")], "close": { "source": "rule" } }),
        );
        assert_eq!(result["reopened"], 1);
        assert_eq!(status_of(&engine, "b"), "open");
        let back = all(&engine).into_iter().find(|f| f["fingerprint"] == "b").unwrap();
        assert!(back["resolvedAt"].is_null());
    }

    #[test]
    fn closing_stays_inside_what_the_run_looked_at() {
        let (engine, _host, _dir) = opened();
        call(
            &engine,
            "consistency.upsert",
            json!({ "findings": [finding("rule"), ai_finding("one", "scene-1"), ai_finding("two", "scene-2")] }),
        );
        // An AI run over one scene closes nothing about another scene, or from the rules.
        call(
            &engine,
            "consistency.upsert",
            json!({ "findings": [], "close": { "source": "ai", "sourceIds": ["scene-1"] } }),
        );
        assert_eq!(status_of(&engine, "one"), "fixed");
        assert_eq!(status_of(&engine, "two"), "open");
        assert_eq!(status_of(&engine, "rule"), "open");

        // Rule checks only close the rules they ran.
        call(
            &engine,
            "consistency.upsert",
            json!({ "findings": [], "close": { "source": "rule", "rules": ["other-rule"] } }),
        );
        assert_eq!(status_of(&engine, "rule"), "open");
    }

    #[test]
    fn an_unchanged_rerun_does_not_mark_the_project_changed() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "C" }));
        call(&engine, "consistency.upsert", json!({ "findings": [finding("a")] }));
        let target = dir.0.join("c.lorecraft");
        engine.allow_path(&target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        assert!(!engine.status().dirty);

        let result = call(
            &engine,
            "consistency.upsert",
            json!({ "findings": [finding("a")], "close": { "source": "rule" } }),
        );
        assert_eq!(result["unchanged"], 1);
        assert_eq!(result["added"], 0);
        assert_eq!(result["updated"], 0);
        assert_eq!(result["closed"], 0);
        assert!(!engine.status().dirty, "nothing changed, so there is nothing to save");

        // A finding persists with the project.
        call(&engine, "project.close", json!({}));
        call(&engine, "project.open", json!({ "path": target }));
        assert_eq!(all(&engine).len(), 1);
    }

    #[test]
    fn status_filter_and_order() {
        let (engine, _host, _dir) = opened();
        let mut info = finding("info");
        info["severity"] = json!("info");
        call(&engine, "consistency.upsert", json!({ "findings": [info, finding("err")] }));
        let stored = all(&engine);
        assert_eq!(stored[0]["fingerprint"], "err");
        assert_eq!(stored[1]["fingerprint"], "info");
        call(&engine, "consistency.setStatus", json!({ "id": id_of(&engine, "info"), "status": "ignored" }));
        let open = call(&engine, "consistency.list", json!({ "status": "open" }));
        assert_eq!(open.as_array().unwrap().len(), 1);
        assert_eq!(open[0]["fingerprint"], "err");
    }

    #[test]
    fn setting_a_status_records_when_and_reopening_clears_it() {
        let (engine, _host, _dir) = opened();
        call(&engine, "consistency.upsert", json!({ "findings": [finding("a")] }));
        let id = id_of(&engine, "a");
        let done = call(&engine, "consistency.setStatus", json!({ "id": id, "status": "fixed" }));
        assert_eq!(done["status"], "fixed");
        assert!(done["resolvedAt"].is_string());
        let back = call(&engine, "consistency.setStatus", json!({ "id": id, "status": "open" }));
        assert_eq!(back["status"], "open");
        assert!(back["resolvedAt"].is_null());
    }

    #[test]
    fn bad_input_is_refused() {
        let (engine, _host, _dir) = opened();
        let mut bad = finding("a");
        bad["severity"] = json!("catastrophic");
        assert!(dispatch(&engine, "consistency.upsert", json!({ "findings": [bad] })).is_err());
        let mut bad = finding("a");
        bad["fingerprint"] = json!(" ");
        assert!(dispatch(&engine, "consistency.upsert", json!({ "findings": [bad] })).is_err());
        let mut bad = finding("a");
        bad["evidence"] = json!("not a list");
        assert!(dispatch(&engine, "consistency.upsert", json!({ "findings": [bad] })).is_err());
        call(&engine, "consistency.upsert", json!({ "findings": [finding("a")] }));
        let id = id_of(&engine, "a");
        assert!(dispatch(&engine, "consistency.setStatus", json!({ "id": id, "status": "maybe" })).is_err());
        assert!(dispatch(&engine, "consistency.setStatus", json!({ "id": "nope", "status": "fixed" })).is_err());
        assert!(dispatch(&engine, "consistency.nope", json!({})).is_err());
    }

    #[test]
    fn the_claims_cache_round_trips_and_replaces() {
        let (engine, _host, _dir) = opened();
        let key = json!({ "sourceKind": "node", "sourceId": "scene-1" });
        assert!(call(&engine, "consistency.claimsGet", key.clone()).is_null());
        call(
            &engine,
            "consistency.claimsPut",
            json!({
                "sourceKind": "node", "sourceId": "scene-1", "contentHash": "h1",
                "claims": [{ "subject": "Aria", "quote": "green eyes" }], "model": "m",
            }),
        );
        let cached = call(&engine, "consistency.claimsGet", key.clone());
        assert_eq!(cached["contentHash"], "h1");
        assert_eq!(cached["claims"][0]["subject"], "Aria");
        assert_eq!(cached["model"], "m");
        call(
            &engine,
            "consistency.claimsPut",
            json!({ "sourceKind": "node", "sourceId": "scene-1", "contentHash": "h2", "claims": [], "model": "m" }),
        );
        let cached = call(&engine, "consistency.claimsGet", key);
        assert_eq!(cached["contentHash"], "h2");
        assert_eq!(cached["claims"], json!([]));
        assert!(dispatch(
            &engine,
            "consistency.claimsPut",
            json!({ "sourceKind": "elsewhere", "sourceId": "x", "contentHash": "h", "claims": [] }),
        )
        .is_err());
    }
}
