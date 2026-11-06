//! Version history for pages and scenes. Each revision is a full copy.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use chrono::Datelike;
use sha2::{Digest, Sha256};

use super::family::{self, FamilyReport};
use super::{ok, pages, parse, unknown};
use crate::content;
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::indexing::{self, MentionMatcher, KIND_NODE, KIND_PAGE};

/// While someone keeps typing, record at most one automatic revision this often.
const AUTO_INTERVAL_MINUTES: i64 = 10;

/// How long history is kept. Stored per project in `meta`, under `RETENTION_KEY`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Retention {
    /// False keeps every revision for ever.
    pub enabled: bool,
    /// Every revision younger than this is kept.
    pub keep_all_days: i64,
    /// Older than `keep_all_days` and younger than this, the newest one of each day is kept.
    /// Older still, the newest one of each week.
    pub daily_for_days: i64,
    /// The newest this many of each page or scene are always kept, however old.
    pub keep_latest: i64,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            enabled: true,
            keep_all_days: 14,
            daily_for_days: 90,
            keep_latest: 10,
        }
    }
}

const RETENTION_KEY: &str = "revision_retention";

/// Snapshots taken before a change that touches more than the writer's own typing. They
/// are what makes an import, merge, split or restore undoable, so age never removes them.
const KEPT_REASONS: &[&str] = &["import", "merge", "unmerge", "split", "split-off", "restore", "manual"];

pub fn retention(conn: &Connection) -> AppResult<Retention> {
    let stored: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [RETENTION_KEY], |r| r.get(0))
        .optional()?;
    Ok(stored
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

fn set_retention(conn: &Connection, value: Retention) -> AppResult<Retention> {
    let clean = Retention {
        enabled: value.enabled,
        keep_all_days: value.keep_all_days.clamp(1, 3650),
        daily_for_days: value.daily_for_days.clamp(value.keep_all_days.clamp(1, 3650), 36500),
        keep_latest: value.keep_latest.clamp(1, 1000),
    };
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params![RETENTION_KEY, serde_json::to_string(&clean).map_err(|e| AppError::internal(e.to_string()))?],
    )?;
    Ok(clean)
}

/// Thins out the old history of one page or scene, as `retention` says. Returns how many
/// revisions went.
pub fn prune(conn: &Connection, kind: &str, id: &str, now: chrono::DateTime<chrono::Utc>) -> AppResult<usize> {
    let policy = retention(conn)?;
    if !policy.enabled {
        return Ok(0);
    }
    let rows: Vec<(String, String, String)> = {
        let mut stmt = conn.prepare_cached(
            "SELECT id, reason, created_at FROM revisions WHERE entity_kind = ?1 AND entity_id = ?2
             ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt.query_map(params![kind, id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    if rows.len() as i64 <= policy.keep_latest {
        return Ok(0);
    }
    let mut seen_buckets = std::collections::HashSet::new();
    let mut doomed = Vec::new();
    for (index, (revision, reason, created)) in rows.iter().enumerate() {
        let Some(at) = chrono::DateTime::parse_from_rfc3339(created).ok() else {
            continue; // A time we cannot read is kept.
        };
        let age_days = now.signed_duration_since(at).num_days();
        // Newest first, so the first revision of each bucket is the one kept.
        let bucket = if age_days < policy.keep_all_days {
            None
        } else if age_days < policy.daily_for_days {
            Some(("day", at.date_naive().to_string()))
        } else {
            let week = at.date_naive().iso_week();
            Some(("week", format!("{}-{}", week.year(), week.week())))
        };
        let first_of_bucket = match &bucket {
            None => true,
            Some(key) => seen_buckets.insert(key.clone()),
        };
        let protected = (index as i64) < policy.keep_latest || KEPT_REASONS.contains(&reason.as_str());
        if !first_of_bucket && !protected {
            doomed.push(revision.clone());
        }
    }
    let mut delete = conn.prepare_cached("DELETE FROM revisions WHERE id = ?1")?;
    for revision in &doomed {
        delete.execute([revision])?;
    }
    Ok(doomed.len())
}

fn table_for(kind: &str) -> AppResult<&'static str> {
    match kind {
        KIND_PAGE => Ok("pages"),
        KIND_NODE => Ok("nodes"),
        _ => Err(AppError::invalid(format!("Unknown entity kind: {kind}"))),
    }
}

pub fn hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// What a page's revision keeps besides its text, since a reader sees those as part
/// of the article. Returns the JSON to store and a string that identifies its state.
fn page_extra(conn: &Connection, id: &str) -> AppResult<(String, String)> {
    let (infobox, summary): (String, String) = conn.query_row(
        "SELECT infobox, summary FROM pages WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let identity = format!("\u{0}{infobox}\u{0}{summary}");
    let extra = json!({
        "infobox": serde_json::from_str::<Value>(&infobox).unwrap_or(Value::Null),
        "summary": summary,
    });
    Ok((extra.to_string(), identity))
}

/// What a scene's revision keeps besides its text: the synopsis, which the AI can write.
/// An empty synopsis adds nothing to the identity, so older revisions still match.
fn node_extra(conn: &Connection, id: &str) -> AppResult<(String, String)> {
    let synopsis: String =
        conn.query_row("SELECT synopsis FROM nodes WHERE id = ?1", [id], |r| r.get(0))?;
    let identity = if synopsis.is_empty() {
        String::new()
    } else {
        format!("\u{0}{synopsis}")
    };
    Ok((json!({ "synopsis": synopsis }).to_string(), identity))
}

/// Stores the entity's current state unless the latest revision already matches.
/// Returns the new revision's id if one was written.
pub fn checkpoint(conn: &Connection, kind: &str, id: &str, reason: &str) -> AppResult<Option<String>> {
    let table = table_for(kind)?;
    let row: Option<(String, String, String, i64)> = conn
        .query_row(
            &format!("SELECT title, content, content_text, word_count FROM {table} WHERE id = ?1"),
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((title, doc, text, words)) = row else {
        return Err(AppError::not_found("That item"));
    };
    if doc.is_empty() {
        return Ok(None); // Parts and chapters have no prose.
    }
    let (extra, identity) = if kind == KIND_PAGE {
        page_extra(conn, id)?
    } else {
        node_extra(conn, id)?
    };
    let content_hash = hash(&format!("{doc}{identity}"));
    let latest: Option<String> = conn
        .query_row(
            "SELECT content_hash FROM revisions WHERE entity_kind = ?1 AND entity_id = ?2
             ORDER BY created_at DESC, id DESC LIMIT 1",
            params![kind, id],
            |r| r.get(0),
        )
        .optional()?;
    if latest.as_deref() == Some(content_hash.as_str()) {
        return Ok(None);
    }
    let revision_id = db::new_id();
    conn.execute(
        "INSERT INTO revisions (id, entity_kind, entity_id, title, content, content_text,
                                content_hash, extra, reason, word_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            revision_id,
            kind,
            id,
            title,
            doc,
            text,
            content_hash,
            extra,
            reason,
            words,
            db::now()
        ],
    )?;
    prune(conn, kind, id, chrono::Utc::now())?;
    Ok(Some(revision_id))
}

/// Called before content is overwritten, so a long editing session still leaves
/// points to return to.
pub fn auto_checkpoint(conn: &Connection, kind: &str, id: &str) -> AppResult<()> {
    let latest: Option<String> = conn
        .query_row(
            "SELECT created_at FROM revisions WHERE entity_kind = ?1 AND entity_id = ?2
             ORDER BY created_at DESC LIMIT 1",
            params![kind, id],
            |r| r.get(0),
        )
        .optional()?;
    let due = match latest
        .as_deref()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
    {
        Some(at) => chrono::Utc::now().signed_duration_since(at).num_minutes() >= AUTO_INTERVAL_MINUTES,
        None => true,
    };
    if due {
        checkpoint(conn, kind, id, "auto")?;
    }
    Ok(())
}

/// Records every page and scene that differs from its latest revision. Runs on save.
/// `checkpoint` compares content hashes, because timestamps cannot tell us this: an
/// automatic checkpoint is written during an edit, so it can carry a later time than
/// the edit's `updated_at` while holding the older text.
pub fn checkpoint_changed(conn: &Connection) -> AppResult<()> {
    let mut targets: Vec<(&str, String)> = Vec::new();
    for (kind, table, extra) in [
        (KIND_PAGE, "pages", ""),
        (KIND_NODE, "nodes", "AND kind = 'scene'"),
    ] {
        let sql = format!("SELECT id FROM {table} WHERE deleted_at IS NULL {extra}");
        let mut stmt = conn.prepare(&sql)?;
        for id in stmt.query_map([], |r| r.get::<_, String>(0))? {
            targets.push((kind, id?));
        }
    }
    for (kind, id) in targets {
        checkpoint(conn, kind, &id, "save")?;
    }
    Ok(())
}

/// Puts an entity back as a revision holds it, after saving its current state with `reason`.
fn restore_as(conn: &Connection, revision_id: &str, reason: &str) -> AppResult<(String, String, FamilyReport)> {
    let row: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT entity_kind, entity_id, content, extra FROM revisions WHERE id = ?1",
            [revision_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((kind, id, doc_text, extra)) = row else {
        return Err(AppError::not_found("That revision"));
    };
    let table = table_for(&kind)?;
    let deleted: Option<String> = conn
        .query_row(
            &format!("SELECT deleted_at FROM {table} WHERE id = ?1"),
            [&id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("That item"))?;
    if deleted.is_some() {
        return Err(AppError::invalid("Restore it from the trash first."));
    }
    // Restoring must itself be undoable.
    checkpoint(conn, &kind, &id, reason)?;
    let now = db::now();
    let mut report = FamilyReport::default();
    if kind == KIND_PAGE {
        let before: String =
            conn.query_row("SELECT infobox FROM pages WHERE id = ?1", [&id], |r| r.get(0))?;
        conn.execute(
            "UPDATE pages SET content = ?1, updated_at = ?2 WHERE id = ?3",
            params![doc_text, now, id],
        )?;
        // A revision that does not hold these leaves the current ones in place.
        let extra: Value = serde_json::from_str(&extra).unwrap_or(Value::Null);
        if let Some(infobox) = extra.get("infobox").filter(|v| v.is_object()) {
            conn.execute(
                "UPDATE pages SET infobox = ?1 WHERE id = ?2",
                params![infobox.to_string(), id],
            )?;
        }
        if let Some(summary) = extra.get("summary").and_then(Value::as_str) {
            conn.execute(
                "UPDATE pages SET summary = ?1 WHERE id = ?2",
                params![summary, id],
            )?;
        }
        let matcher = MentionMatcher::build(conn)?;
        pages::reindex_page(conn, &matcher, &id)?;
        // An old infobox can say different things about other pages.
        let before = serde_json::from_str(&before).unwrap_or(Value::Null);
        report = family::after_infobox_save(conn, &id, &before, &[])?;
    } else {
        let doc: Value = serde_json::from_str(&doc_text)?;
        let extracted = content::extract(&doc);
        let title: String = conn.query_row(
            &format!("SELECT title FROM {table} WHERE id = ?1"),
            [&id],
            |r| r.get(0),
        )?;
        conn.execute(
            &format!(
                "UPDATE {table} SET content = ?1, content_text = ?2, word_count = ?3, updated_at = ?4
                 WHERE id = ?5"
            ),
            params![doc_text, extracted.text, extracted.word_count, now, id],
        )?;
        // An older revision does not hold the synopsis, so it leaves the current one.
        let extra: Value = serde_json::from_str(&extra).unwrap_or(Value::Null);
        if let Some(synopsis) = extra.get("synopsis").and_then(Value::as_str) {
            conn.execute(
                "UPDATE nodes SET synopsis = ?1 WHERE id = ?2",
                params![synopsis, id],
            )?;
        }
        indexing::sync_entity(conn, &kind, &id, &title, &extracted)?;
    }
    Ok((kind, id, report))
}

/// What identifies a live entity's state, as a revision would record it. None if it is
/// missing or in the trash. Undo compares this to tell whether it was edited since.
pub fn state_hash(conn: &Connection, kind: &str, id: &str) -> AppResult<Option<String>> {
    let table = table_for(kind)?;
    let doc: Option<String> = conn
        .query_row(
            &format!("SELECT content FROM {table} WHERE id = ?1 AND deleted_at IS NULL"),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(doc) = doc else {
        return Ok(None);
    };
    let (_, identity) = if kind == KIND_PAGE {
        page_extra(conn, id)?
    } else {
        node_extra(conn, id)?
    };
    Ok(Some(hash(&format!("{doc}{identity}"))))
}

/// One document a bulk change wrote: the revision holding it as it was, and its state hash
/// straight after the change.
#[derive(Debug, Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BulkChange {
    pub kind: String,
    pub id: String,
    pub revision_id: Option<String>,
    pub after: Option<String>,
}

/// Something a bulk change made, which undoing it moves to the trash.
#[derive(Debug, Deserialize, serde::Serialize, Clone)]
pub struct BulkItem {
    /// `page`, `node` or `book`.
    pub kind: String,
    pub id: String,
}

#[derive(Default)]
struct UndoOutcome {
    restored: Vec<(String, String)>,
    /// Edited since the change, so left as they are. (kind, id, title)
    kept: Vec<(String, String, String)>,
    trashed: usize,
    /// Pages and scenes moved to the trash. (kind, id)
    gone: Vec<(String, String)>,
    family: Vec<FamilyReport>,
}

fn title_of(conn: &Connection, kind: &str, id: &str) -> AppResult<String> {
    let table = table_for(kind)?;
    Ok(conn
        .query_row(&format!("SELECT title FROM {table} WHERE id = ?1"), [id], |r| r.get(0))
        .optional()?
        .unwrap_or_default())
}

/// Takes back a bulk change: each document goes back to its revision from before, unless it
/// was edited since, and what the change made goes to the trash. The current text of each is
/// saved to its history first, so the undo can itself be undone.
fn undo_bulk(conn: &Connection, changes: &[BulkChange], created: &[BulkItem], removed: &[BulkItem]) -> AppResult<UndoOutcome> {
    let mut outcome = UndoOutcome::default();
    for change in changes {
        let (Some(revision), Some(after)) = (&change.revision_id, &change.after) else {
            continue;
        };
        match state_hash(conn, &change.kind, &change.id)? {
            Some(now) if now == *after => {
                let (kind, id, report) = restore_as(conn, revision, "undo")?;
                outcome.family.push(report);
                outcome.restored.push((kind, id));
            }
            Some(_) => {
                let title = title_of(conn, &change.kind, &change.id)?;
                outcome.kept.push((change.kind.clone(), change.id.clone(), title));
            }
            None => {}
        }
    }
    let now = db::now();
    for item in created {
        let trashed = match item.kind.as_str() {
            KIND_PAGE => {
                let n = conn.execute(
                    "UPDATE pages SET deleted_at = ?1, updated_at = ?1
                     WHERE id = ?2 AND deleted_at IS NULL AND is_home = 0",
                    params![now, item.id],
                )?;
                if n > 0 {
                    indexing::remove_entity(conn, KIND_PAGE, &item.id)?;
                }
                n
            }
            KIND_NODE => {
                let live = conn
                    .query_row("SELECT 1 FROM nodes WHERE id = ?1 AND deleted_at IS NULL", [&item.id], |_| Ok(()))
                    .optional()?;
                if live.is_some() {
                    super::manuscript::delete_node(conn, &item.id)?;
                }
                usize::from(live.is_some())
            }
            "book" => {
                let n = conn.execute(
                    "UPDATE books SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                    params![now, item.id],
                )?;
                if n > 0 {
                    let mut stmt = conn.prepare("SELECT id FROM nodes WHERE book_id = ?1")?;
                    let ids: Vec<String> =
                        stmt.query_map([&item.id], |r| r.get(0))?.collect::<Result<_, _>>()?;
                    for id in ids {
                        indexing::remove_entity(conn, KIND_NODE, &id)?;
                    }
                }
                n
            }
            _ => 0,
        };
        outcome.trashed += trashed;
        if trashed > 0 && item.kind != "book" {
            // An editor open on it finds out that it has gone.
            outcome.gone.push((item.kind.clone(), item.id.clone()));
        }
    }
    for item in removed.iter().filter(|item| item.kind == KIND_NODE) {
        super::manuscript::restore_from_trash(conn, &item.id)?;
    }
    if created.iter().any(|item| item.kind == KIND_PAGE) {
        indexing::rebuild_mentions(conn)?;
    }
    Ok(outcome)
}

/// The id of a revision that holds the entity as it is now: a new one, or the latest if it
/// already matches. Undo needs this even when nothing new had to be stored.
pub fn snapshot(conn: &Connection, kind: &str, id: &str, reason: &str) -> AppResult<Option<String>> {
    if let Some(made) = checkpoint(conn, kind, id, reason)? {
        return Ok(Some(made));
    }
    Ok(conn
        .query_row(
            "SELECT id FROM revisions WHERE entity_kind = ?1 AND entity_id = ?2
             ORDER BY created_at DESC, id DESC LIMIT 1",
            params![kind, id],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "list" => {
            #[derive(Deserialize)]
            struct P {
                kind: String,
                id: String,
            }
            let p: P = parse(params)?;
            engine.read(|c| {
                let mut stmt = c.prepare(
                    "SELECT id, title, reason, word_count, created_at FROM revisions
                     WHERE entity_kind = ?1 AND entity_id = ?2
                     ORDER BY created_at DESC, id DESC",
                )?;
                let rows = stmt.query_map(params![p.kind, p.id], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "title": r.get::<_, String>(1)?,
                        "reason": r.get::<_, String>(2)?,
                        "wordCount": r.get::<_, i64>(3)?,
                        "createdAt": r.get::<_, String>(4)?,
                    }))
                })?;
                Ok(Value::Array(rows.collect::<Result<_, _>>()?))
            })
        }
        "get" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
            }
            let p: P = parse(params)?;
            engine.read(|c| {
                let row = c
                    .query_row(
                        "SELECT id, entity_kind, entity_id, title, content, content_text, reason,
                                word_count, created_at, extra FROM revisions WHERE id = ?1",
                        [&p.id],
                        |r| {
                            Ok(json!({
                                "id": r.get::<_, String>(0)?,
                                "entityKind": r.get::<_, String>(1)?,
                                "entityId": r.get::<_, String>(2)?,
                                "title": r.get::<_, String>(3)?,
                                "content": serde_json::from_str::<Value>(&r.get::<_, String>(4)?)
                                    .unwrap_or(Value::Null),
                                "contentText": r.get::<_, String>(5)?,
                                "reason": r.get::<_, String>(6)?,
                                "wordCount": r.get::<_, i64>(7)?,
                                "createdAt": r.get::<_, String>(8)?,
                                "extra": serde_json::from_str::<Value>(&r.get::<_, String>(9)?)
                                    .unwrap_or(Value::Null),
                            }))
                        },
                    )
                    .optional()?;
                row.ok_or_else(|| AppError::not_found("That revision"))
            })
        }
        "retention" => engine.read(|c| ok(retention(c)?)),
        "setRetention" => {
            let value: Retention = parse(params)?;
            ok(engine.write(|tx| set_retention(tx, value))?)
        }
        "checkpoint" => {
            #[derive(Deserialize)]
            struct P {
                kind: String,
                id: String,
                reason: Option<String>,
            }
            let p: P = parse(params)?;
            let revision = engine.write(|tx| {
                checkpoint(tx, &p.kind, &p.id, p.reason.as_deref().unwrap_or("manual"))
            })?;
            ok(revision)
        }
        "restore" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
            }
            let p: P = parse(params)?;
            let (kind, id, family_report) = engine.write(|tx| restore_as(tx, &p.id, "restore"))?;
            family::announce(engine, &family_report);
            if kind == KIND_PAGE {
                // The summary came back too, and hover cards show it.
                engine.notify("pages");
            } else {
                // So did the synopsis and the word count, which the binder shows.
                engine.notify("nodes");
            }
            pages::notify_replaced(engine, &[(kind.clone(), id.clone())]);
            ok(json!({ "kind": kind, "id": id }))
        }
        // Takes back a project-wide replace or an import, from what its result listed.
        "undo" => {
            #[derive(Deserialize)]
            struct P {
                #[serde(default)]
                changes: Vec<BulkChange>,
                #[serde(default)]
                created: Vec<BulkItem>,
                #[serde(default)]
                removed: Vec<BulkItem>,
            }
            let p: P = parse(params)?;
            let outcome = engine.write(|tx| undo_bulk(tx, &p.changes, &p.created, &p.removed))?;
            for report in &outcome.family {
                family::announce(engine, report);
            }
            engine.notify("pages");
            engine.notify("nodes");
            engine.notify("books");
            pages::notify_replaced(engine, outcome.restored.iter().chain(&outcome.gone));
            let kept: Vec<Value> = outcome
                .kept
                .iter()
                .map(|(kind, id, title)| json!({ "kind": kind, "id": id, "title": title }))
                .collect();
            ok(json!({
                "restored": outcome.restored.len(),
                "trashed": outcome.trashed,
                "kept": kept,
            }))
        }
        _ => Err(unknown(&format!("revisions.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use crate::engine::{Engine, TestHost};
    use crate::rpc::{call, dispatch};
    use serde_json::{json, Value};

    fn doc(text: &str) -> Value {
        json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": text }] }
        ]})
    }

    #[test]
    fn restoring_returns_old_text_and_can_itself_be_undone() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "A" }));
        let id = &page["id"];
        call(&engine, "pages.update", json!({ "id": id, "patch": { "content": doc("first") } }));
        let first = call(&engine, "revisions.checkpoint", json!({ "kind": "page", "id": id }));
        call(&engine, "pages.update", json!({ "id": id, "patch": { "content": doc("second") } }));

        call(&engine, "revisions.restore", json!({ "id": first }));
        assert_eq!(call(&engine, "pages.get", json!({ "id": id }))["content"], doc("first"));

        let list = call(&engine, "revisions.list", json!({ "kind": "page", "id": id }));
        let newest = &list[0];
        assert_eq!(newest["reason"], "restore");
        let saved = call(&engine, "revisions.get", json!({ "id": newest["id"] }));
        assert_eq!(saved["content"], doc("second"));
    }

    fn replaced_events(host: &TestHost, id: &Value) -> usize {
        let wanted = format!("doc:page:{}", id.as_str().unwrap());
        host.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, payload)| payload["entity"] == wanted.as_str())
            .count()
    }

    #[test]
    fn restoring_tells_an_open_editor_to_reload() {
        let (engine, host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "A" }));
        let id = &page["id"];
        call(&engine, "pages.update", json!({ "id": id, "fromEditor": true, "patch": { "content": doc("first") } }));
        let first = call(&engine, "revisions.checkpoint", json!({ "kind": "page", "id": id }));
        call(&engine, "pages.update", json!({ "id": id, "fromEditor": true, "patch": { "content": doc("second") } }));
        assert_eq!(replaced_events(&host, id), 0, "an editor's own saves do not reload it");
        call(&engine, "revisions.restore", json!({ "id": first }));
        assert_eq!(replaced_events(&host, id), 1);
    }

    #[test]
    fn writes_from_outside_the_editor_also_reload_it() {
        let (engine, host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "A" }));
        call(&engine, "pages.update", json!({ "id": page["id"], "patch": { "content": doc("from AI") } }));
        assert_eq!(replaced_events(&host, &page["id"]), 1);
    }

    #[test]
    fn revisions_keep_the_infobox_and_summary() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "A" }));
        let id = &page["id"];
        let infobox = |v: &str| json!({ "fields": [{ "key": "born", "label": "Born", "kind": "date", "value": v }] });
        call(&engine, "pages.update", json!({ "id": id, "patch": { "infobox": infobox("Year 1"), "summary": "old" } }));
        let first = call(&engine, "revisions.checkpoint", json!({ "kind": "page", "id": id }));
        assert!(first.is_string());

        call(&engine, "pages.update", json!({ "id": id, "patch": { "infobox": infobox("Year 2"), "summary": "new" } }));
        // The text is the same, but the page is not.
        let second = call(&engine, "revisions.checkpoint", json!({ "kind": "page", "id": id }));
        assert!(second.is_string(), "a change to the infobox alone is recorded");

        let saved = call(&engine, "revisions.get", json!({ "id": first }));
        assert_eq!(saved["extra"]["infobox"]["fields"][0]["value"], "Year 1");
        call(&engine, "revisions.restore", json!({ "id": first }));
        let restored = call(&engine, "pages.get", json!({ "id": id }));
        assert_eq!(restored["infobox"]["fields"][0]["value"], "Year 1");
        assert_eq!(restored["summary"], "old");
    }

    #[test]
    fn restoring_brings_back_links_search_and_word_count() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "A" }));
        let id = &page["id"];
        let linked = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [
            { "type": "text", "text": "zebrafinch", "marks": [{ "type": "wikiLink", "attrs": { "target": "Elsewhere" } }] }
        ]}]});
        call(&engine, "pages.update", json!({ "id": id, "patch": { "content": linked } }));
        let first = call(&engine, "revisions.checkpoint", json!({ "kind": "page", "id": id }));
        call(&engine, "pages.update", json!({ "id": id, "patch": { "content": doc("two words") } }));
        assert!(call(&engine, "pages.wanted", json!({})).as_array().unwrap().is_empty());

        call(&engine, "revisions.restore", json!({ "id": first }));
        assert_eq!(call(&engine, "pages.wanted", json!({}))[0]["title"], "Elsewhere");
        assert_eq!(call(&engine, "search.query", json!({ "q": "zebrafinch" })).as_array().unwrap().len(), 1);
        assert_eq!(call(&engine, "pages.get", json!({ "id": id }))["wordCount"], 1);
    }

    #[test]
    fn a_page_in_the_trash_cannot_be_restored_to_a_revision() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "A" }));
        let id = &page["id"];
        call(&engine, "pages.update", json!({ "id": id, "patch": { "content": doc("first") } }));
        let first = call(&engine, "revisions.checkpoint", json!({ "kind": "page", "id": id }));
        call(&engine, "pages.delete", json!({ "id": id }));
        let err = dispatch(&engine, "revisions.restore", json!({ "id": first })).unwrap_err();
        assert_eq!(err.code, "INVALID");
        assert!(call(&engine, "search.query", json!({ "q": "first" })).as_array().unwrap().is_empty());
    }

    #[test]
    fn an_ai_summary_or_infobox_is_saved_to_history_first() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "A" }));
        let id = &page["id"];
        call(&engine, "pages.update", json!({ "id": id, "patch": { "summary": "Mine." } }));
        call(&engine, "pages.update", json!({ "id": id, "snapshot": "ai", "patch": { "summary": "The model's." } }));
        let list = call(&engine, "revisions.list", json!({ "kind": "page", "id": id }));
        assert_eq!(list[0]["reason"], "ai");
        let saved = call(&engine, "revisions.get", json!({ "id": list[0]["id"] }));
        assert_eq!(saved["extra"]["summary"], "Mine.");

        let before = call(&engine, "pages.get", json!({ "id": id }))["infobox"].clone();
        let infobox = json!({ "fields": [{ "key": "born", "label": "Born", "kind": "date", "value": "Year 9" }] });
        call(&engine, "pages.update", json!({ "id": id, "snapshot": "ai", "patch": { "infobox": infobox } }));
        let list = call(&engine, "revisions.list", json!({ "kind": "page", "id": id }));
        assert_eq!(list[0]["reason"], "ai");
        let saved = call(&engine, "revisions.get", json!({ "id": list[0]["id"] }));
        assert_eq!(saved["extra"]["summary"], "The model's.");
        call(&engine, "revisions.restore", json!({ "id": list[0]["id"] }));
        assert_eq!(call(&engine, "pages.get", json!({ "id": id }))["infobox"], before);
    }

    #[test]
    fn identical_content_is_not_stored_twice() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "A" }));
        let id = &page["id"];
        let one = call(&engine, "revisions.checkpoint", json!({ "kind": "page", "id": id }));
        let two = call(&engine, "revisions.checkpoint", json!({ "kind": "page", "id": id }));
        assert!(one.is_string());
        assert!(two.is_null());
    }

    #[test]
    fn saving_records_history_for_edited_items() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "A" }));
        let target = dir.0.join("h.lorecraft");
        engine.allow_path(&target);
        call(&engine, "pages.update", json!({ "id": page["id"], "patch": { "content": doc("v1") } }));
        call(&engine, "project.saveAs", json!({ "path": target }));
        let list = call(&engine, "revisions.list", json!({ "kind": "page", "id": page["id"] }));
        let saved = call(&engine, "revisions.get", json!({ "id": list[0]["id"] }));
        assert_eq!(saved["content"], doc("v1"));
        assert_eq!(saved["reason"], "save");
    }

    #[test]
    fn old_history_is_thinned_but_recent_latest_and_marked_snapshots_stay() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "Thin" }));
        let id = page["id"].as_str().unwrap().to_string();
        let now = chrono::DateTime::parse_from_rfc3339("2026-06-17T12:00:00Z").unwrap().to_utc();
        engine
            .write(|tx| {
                tx.execute("DELETE FROM revisions", []).unwrap();
                // 30 revisions a day apart at noon, and two each on days 40 and 200.
                let mut add = |n: usize, days: i64, hours: i64, reason: &str| {
                    let at = now - chrono::Duration::days(days) - chrono::Duration::hours(hours);
                    tx.execute(
                        "INSERT INTO revisions (id, entity_kind, entity_id, title, content, content_text,
                                                content_hash, reason, created_at)
                         VALUES (?1, 'page', ?2, 'Thin', '{}', '', ?1, ?3, ?4)",
                        rusqlite::params![format!("r{n:03}"), id, reason, at.to_rfc3339()],
                    )
                    .unwrap();
                };
                for d in 0..30 {
                    add(d, d as i64, 0, "auto");
                }
                add(100, 40, 1, "auto");
                add(101, 40, 2, "auto");
                add(102, 200, 1, "auto");
                add(103, 200, 2, "import");
                add(104, 200, 3, "auto");
                Ok(())
            })
            .unwrap();
        let gone = engine.write(|tx| super::prune(tx, "page", &id, now)).unwrap();
        let left: Vec<String> = engine
            .read(|c| {
                let mut stmt = c.prepare("SELECT id FROM revisions WHERE entity_id = ?1 ORDER BY id")?;
                let rows = stmt.query_map([&id], |r| r.get(0))?;
                Ok(rows.collect::<Result<_, _>>()?)
            })
            .unwrap();
        for d in 0..30 {
            assert!(left.contains(&format!("r{d:03}")), "one a day for 30 days is all kept: r{d:03}");
        }
        assert!(left.contains(&"r100".to_string()) && !left.contains(&"r101".to_string()), "one per day after two weeks");
        assert!(left.contains(&"r102".to_string()) && left.contains(&"r103".to_string()), "an import snapshot is never dropped");
        assert!(!left.contains(&"r104".to_string()), "one per week after 90 days");
        assert_eq!(gone, 2);

        call(&engine, "revisions.setRetention", json!({ "enabled": false }));
        assert_eq!(call(&engine, "revisions.retention", json!({}))["enabled"], false);
        assert_eq!(engine.write(|tx| super::prune(tx, "page", &id, now + chrono::Duration::days(999))).unwrap(), 0);
    }

    #[test]
    fn the_newest_revisions_are_kept_however_old() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "Old" }));
        let id = page["id"].as_str().unwrap().to_string();
        let now = chrono::Utc::now();
        engine
            .write(|tx| {
                for n in 0..12 {
                    let at = now - chrono::Duration::days(500) - chrono::Duration::minutes(n);
                    tx.execute(
                        "INSERT INTO revisions (id, entity_kind, entity_id, title, content, content_text,
                                                content_hash, reason, created_at)
                         VALUES (?1, 'page', ?2, 'Old', '{}', '', ?1, 'auto', ?3)",
                        rusqlite::params![format!("o{n:02}"), id, at.to_rfc3339()],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        assert_eq!(engine.write(|tx| super::prune(tx, "page", &id, now)).unwrap(), 2, "ten newest stay");
    }
}
