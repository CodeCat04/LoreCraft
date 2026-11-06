//! Project lifecycle: new, open, save, close, recovery and backups.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{ok, parse, revisions, settings, unknown};
use crate::content;
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::paths::Paths;
use crate::session::{self, project_id_of, BackupKind, BackupPolicy, SaveReport, Session};

fn backup_policy(engine: &Engine) -> BackupPolicy {
    let settings = engine.settings();
    let number = |pointer: &str| settings.pointer(pointer).and_then(Value::as_u64);
    BackupPolicy {
        keep: number("/save/backupsToKeep").map_or(session::DEFAULT_BACKUPS_TO_KEEP, |n| n as usize),
        budget_bytes: number("/save/backupBudgetBytes").unwrap_or(session::DEFAULT_BACKUP_BUDGET),
    }
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "status" => ok(engine.status()),
        "new" => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct P {
                name: Option<String>,
            }
            let p: P = parse(params)?;
            new_project(engine, p.name.as_deref().unwrap_or("Untitled"))
        }
        "open" => {
            #[derive(Deserialize)]
            struct P {
                path: PathBuf,
            }
            let p: P = parse(params)?;
            open(engine, p.path)
        }
        "save" => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct P {
                force: bool,
            }
            let p: P = parse(params)?;
            save(engine, p.force)
        }
        "saveAs" => {
            #[derive(Deserialize)]
            struct P {
                path: PathBuf,
            }
            let p: P = parse(params)?;
            engine.check_allowed(&p.path)?;
            save_as(engine, p.path)
        }
        "exportCopy" => {
            #[derive(Deserialize)]
            struct P {
                path: PathBuf,
            }
            let p: P = parse(params)?;
            engine.check_allowed(&p.path)?;
            export_copy(engine, p.path)
        }
        "close" => {
            // After "Don't save", the unsaved work moves into the backups, never away.
            let policy = backup_policy(engine);
            let taken = engine.session().take();
            if let Some(session) = taken {
                session.close_keeping_unsaved(policy)?;
            }
            engine.publish_status(&None);
            ok(engine.status())
        }
        "listRecoverable" => ok(session::list_recoverable(&engine.paths)?),
        "recover" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                session_id: String,
            }
            let p: P = parse(params)?;
            refuse_if_open(engine)?;
            let session = Session::recover(&engine.paths, &p.session_id)?;
            install(engine, session)
        }
        "discardRecovery" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                session_id: String,
            }
            let p: P = parse(params)?;
            session::discard_recoverable(&engine.paths, &p.session_id, backup_policy(engine))?;
            ok(true)
        }
        "listBackups" => {
            #[derive(Deserialize, Default)]
            #[serde(default)]
            struct P {
                all: bool,
            }
            let p: P = parse(params)?;
            ok(list_backups(engine, p.all)?)
        }
        "openBackup" => {
            #[derive(Deserialize)]
            struct P {
                path: PathBuf,
            }
            let p: P = parse(params)?;
            open_backup(engine, &p.path)
        }
        "restoreBackup" => {
            #[derive(Deserialize)]
            struct P {
                path: PathBuf,
            }
            let p: P = parse(params)?;
            restore_backup(engine, &p.path)
        }
        "deleteBackup" => {
            #[derive(Deserialize)]
            struct P {
                path: PathBuf,
            }
            let p: P = parse(params)?;
            let path = backup_file(&engine.paths, &p.path)?;
            fs::remove_file(&path)?;
            ok(true)
        }
        "getMeta" => {
            #[derive(Deserialize)]
            struct P {
                key: String,
            }
            let p: P = parse(params)?;
            let value: Option<String> = engine.read(|c| {
                Ok(c.query_row("SELECT value FROM meta WHERE key = ?1", [&p.key], |r| {
                    r.get(0)
                })
                .ok())
            })?;
            ok(value)
        }
        "setMeta" => {
            #[derive(Deserialize)]
            struct P {
                key: String,
                value: String,
            }
            let p: P = parse(params)?;
            engine.write(|tx| {
                tx.execute(
                    "INSERT INTO meta (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![p.key, p.value],
                )?;
                Ok(())
            })?;
            engine.notify("meta");
            ok(true)
        }
        _ => Err(unknown(&format!("project.{action}"))),
    }
}

/// Replacing a session with unsaved work would throw that work away, so the UI
/// must save or discard first. This guards against a UI bug doing it silently.
fn refuse_if_open(engine: &Engine) -> AppResult<()> {
    let guard = engine.session();
    if guard.as_ref().is_some_and(|s| s.dirty) {
        return Err(AppError::new(
            "UNSAVED_WORK",
            "The open project has unsaved work. Save or discard it first.",
        ));
    }
    Ok(())
}

fn install(engine: &Engine, session: Session) -> AppResult<Value> {
    super::media::remove_incomplete(&session.conn)?;
    let previous = {
        let mut guard = engine.session();
        let previous = guard.replace(session);
        engine.publish_status(&guard);
        previous
    };
    if let Some(previous) = previous {
        let _ = previous.close_and_remove();
    }
    engine.notify("all");
    ok(engine.status())
}

fn new_project(engine: &Engine, name: &str) -> AppResult<Value> {
    refuse_if_open(engine)?;
    let mut session = Session::create_new(&engine.paths, name)?;
    seed(&mut session, name)?;
    install(engine, session)
}

fn seed(session: &mut Session, name: &str) -> AppResult<()> {
    let tx = session.conn.transaction()?;
    let now = db::now();
    for (key, value) in [
        ("app", "lorebook"),
        ("project_id", db::new_id().as_str()),
        ("name", name),
        ("created_at", now.as_str()),
    ] {
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }
    super::pages::seed_home(&tx, name)?;
    super::manuscript::seed_first_book(&tx)?;
    tx.commit()?;
    Ok(())
}

fn open(engine: &Engine, path: PathBuf) -> AppResult<Value> {
    refuse_if_open(engine)?;
    let session = Session::open_file(&engine.paths, &path)?;
    settings::remember_recent(engine, &path, &session.name)?;
    install(engine, session)
}

/// Records history for anything edited since its last revision, so every explicit
/// save is a point the user can return to.
fn checkpoint_all(session: &mut Session) -> AppResult<()> {
    let tx = session.conn.transaction()?;
    revisions::checkpoint_changed(&tx)?;
    tx.commit()?;
    Ok(())
}

/// Tells the UI when the previous version was too large to back up.
fn report_save(engine: &Engine, report: &SaveReport) {
    if let Some(size) = report.backup_skipped {
        engine
            .host
            .emit("project://backup-skipped", json!({ "size": size }));
    }
}

fn save(engine: &Engine, force: bool) -> AppResult<Value> {
    let backups = backup_policy(engine);
    let (path, name) = {
        let mut guard = engine.session();
        let session = guard.as_mut().ok_or_else(AppError::no_project)?;
        let Some(path) = session.origin.clone() else {
            return Err(AppError::new(
                "NEEDS_PATH",
                "This project has not been saved yet.",
            ));
        };
        if !force && session.origin_changed_on_disk() {
            return Err(AppError::new(
                "EXTERNAL_CHANGE",
                format!("{} was changed by another program.", path.display()),
            ));
        }
        let activity = engine.begin_save(session);
        checkpoint_all(session)?;
        let report = session.save_to(&engine.paths, &path, backups, &|| activity.phase("backup"))?;
        report_save(engine, &report);
        let name = session.name.clone();
        engine.publish_status(&guard);
        (path, name)
    };
    settings::remember_recent(engine, &path, &name)?;
    ok(engine.status())
}

fn save_as(engine: &Engine, path: PathBuf) -> AppResult<Value> {
    let path = session::with_project_extension(path);
    let backups = backup_policy(engine);
    let name = {
        let mut guard = engine.session();
        let session = guard.as_mut().ok_or_else(AppError::no_project)?;
        let activity = engine.begin_save(session);
        checkpoint_all(session)?;
        let report = session.save_to(&engine.paths, &path, backups, &|| activity.phase("backup"))?;
        report_save(engine, &report);
        let name = session.name.clone();
        engine.publish_status(&guard);
        name
    };
    settings::remember_recent(engine, &path, &name)?;
    ok(engine.status())
}

/// Writes a copy without changing the open project or its saved state.
fn export_copy(engine: &Engine, path: PathBuf) -> AppResult<Value> {
    let guard = engine.session();
    let session = guard.as_ref().ok_or_else(AppError::no_project)?;
    let _activity = engine.begin_save(session);
    session.write_copy_to(&path)?;
    ok(json!({ "path": path }))
}

// ---- Backups ---------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Backup {
    /// Pass this back to `openBackup` or `restoreBackup`.
    path: PathBuf,
    /// The project's name when the backup was taken.
    name: String,
    project_id: String,
    /// When this version was written, as RFC 3339.
    saved_at: String,
    size: u64,
    /// Taken automatically, just before a restore replaced this version.
    before_restore: bool,
    /// `save`, `beforeRestore`, `discarded` (changes the writer chose not to save) or
    /// `beforeUpgrade` (the file before a newer LoreCraft changed its format).
    kind: &'static str,
    /// For `beforeUpgrade`, the LoreCraft version that did the upgrade.
    upgrade_version: Option<String>,
    /// For `discarded`, when it will be removed, as RFC 3339.
    keep_until: Option<String>,
    /// Belongs to the open project, so it can be restored.
    is_current: bool,
}

/// Backups are named `<project>-<yyyymmdd>-<hhmmss>-<ms>`, perhaps with a mark after.
/// Returns the project's name and the kind of backup.
fn read_backup_name(path: &Path) -> (String, BackupKind) {
    let stem = session::display_name_for(path);
    let (rest, kind) = session::backup_kind(&stem);
    let name = session::strip_backup_time(rest).unwrap_or(rest);
    (name.to_string(), kind)
}

/// The open project's backups, newest first. With no project open, or when asked for
/// `all`, every project's, because a lost or damaged file is when these matter most.
fn list_backups(engine: &Engine, all: bool) -> AppResult<Vec<Backup>> {
    let current = engine.read(|conn| Ok(project_id_of(conn))).ok();
    let root = engine.paths.backups();
    let mut found = Vec::new();
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    for folder in fs::read_dir(&root)?.filter_map(Result::ok) {
        let project_id = folder.file_name().to_string_lossy().to_string();
        let is_current = current.as_deref() == Some(project_id.as_str());
        if current.is_some() && !is_current && !all {
            continue;
        }
        if !folder.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        // One unreadable folder should not hide every other project's backups.
        let Ok(files) = fs::read_dir(folder.path()) else {
            continue;
        };
        for file in files.filter_map(Result::ok) {
            let path = file.path();
            let is_project = path
                .extension()
                .is_some_and(session::is_project_extension);
            let Ok(meta) = file.metadata() else { continue };
            if !is_project || !meta.is_file() {
                continue;
            }
            let Ok(modified) = meta.modified() else {
                continue;
            };
            let (name, kind) = read_backup_name(&path);
            let time = |at: std::time::SystemTime| {
                chrono::DateTime::<chrono::Utc>::from(at).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            };
            let keep_for = std::time::Duration::from_secs(session::DISCARDED_KEEP_DAYS * 24 * 60 * 60);
            found.push((
                modified,
                Backup {
                    path,
                    name,
                    project_id: project_id.clone(),
                    saved_at: time(modified),
                    size: meta.len(),
                    before_restore: kind == BackupKind::BeforeRestore,
                    kind: match kind {
                        BackupKind::Save => "save",
                        BackupKind::BeforeRestore => "beforeRestore",
                        BackupKind::Discarded => "discarded",
                        BackupKind::BeforeUpgrade(_) => "beforeUpgrade",
                    },
                    keep_until: (kind == BackupKind::Discarded).then(|| time(modified + keep_for)),
                    upgrade_version: match kind {
                        BackupKind::BeforeUpgrade(version) => Some(version),
                        _ => None,
                    },
                    is_current,
                },
            ));
        }
    }
    found.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    Ok(found.into_iter().map(|(_, backup)| backup).collect())
}

/// A path from the UI, as long as it really is a project file in the backups folder.
/// Canonical paths have `..` and links resolved, so neither can lead out of the folder.
fn backup_file(paths: &Paths, requested: &Path) -> AppResult<PathBuf> {
    let refused = || {
        AppError::new(
            "PATH_NOT_ALLOWED",
            "That backup no longer exists, or is not in the backups folder.",
        )
    };
    let root = fs::canonicalize(paths.backups()).map_err(|_| refused())?;
    let resolved = fs::canonicalize(requested).map_err(|_| refused())?;
    let is_project = resolved
        .extension()
        .is_some_and(session::is_project_extension);
    if !resolved.starts_with(&root) || !is_project || !resolved.is_file() {
        return Err(refused());
    }
    Ok(resolved)
}

/// Opens a backup as a new project that has no file. Saving it always asks where, so it
/// cannot overwrite anything, and the backup itself is only ever read.
fn open_backup(engine: &Engine, requested: &Path) -> AppResult<Value> {
    let path = backup_file(&engine.paths, requested)?;
    refuse_if_open(engine)?;
    let (name, _) = read_backup_name(&path);
    let mut copy = Session::open_file(&engine.paths, &path)?;
    copy.origin = None;
    copy.origin_stamp = None;
    copy.name = format!("{name} (backup copy)");
    // Its own identity, so its backups never count against the original's rolling limit.
    let prepared = copy
        .conn
        .execute(
            "INSERT INTO meta (key, value) VALUES ('project_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [db::new_id()],
        )
        .map_err(AppError::from)
        // Never saved, so it counts as unsaved work: closing asks, and a crash keeps it.
        .and_then(|_| copy.set_dirty(true));
    if let Err(e) = prepared {
        // Only a copy of the backup, which is still there.
        let _ = copy.close_without_keeping();
        return Err(e);
    }
    install(engine, copy)
}

/// Writes the session's current state, unsaved work included, into the backups folder.
fn keep_current_state(paths: &Paths, session: &Session, project_id: &str) -> AppResult<()> {
    let dir = session::backups_folder(paths, project_id);
    fs::create_dir_all(&dir)?;
    let base = session::backup_base_name(session.origin.as_deref(), &session.name);
    let kept = session::new_backup_path(&dir, &base, session::BEFORE_RESTORE_MARK);
    // Written beside the working copy, so the backups folder never holds a partial file.
    let tmp = session.dir.join(format!("{}.tmp", db::new_id()));
    let result = session
        .write_verified_copy(&tmp)
        .and_then(|()| Ok(fs::rename(&tmp, kept)?));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Puts the open project back to a backup of itself. The current state goes into the
/// backups folder first, and the project's file changes only at the next save, like any
/// other edit. The lock is held throughout, so no write can land between those steps.
fn restore_backup(engine: &Engine, requested: &Path) -> AppResult<Value> {
    let path = backup_file(&engine.paths, requested)?;
    let previous = {
        let mut guard = engine.session();
        let current = guard.as_ref().ok_or_else(AppError::no_project)?;
        let project_id = project_id_of(&current.conn);
        let owner = path.parent().and_then(Path::file_name);
        if owner != Some(std::ffi::OsStr::new(&project_id)) {
            return Err(AppError::new(
                "OTHER_PROJECT",
                "That backup belongs to another project. Open it as a copy instead.",
            ));
        }
        // A damaged backup fails here, while nothing has changed.
        let mut restored = Session::open_file(&engine.paths, &path)?;
        restored.origin = current.origin.clone();
        restored.origin_stamp = current.origin_stamp.clone();
        restored.name = current.name.clone();
        let prepared = restored
            .set_dirty(true)
            .and_then(|()| keep_current_state(&engine.paths, current, &project_id));
        if let Err(e) = prepared {
            // Only a copy of the backup, which is still there.
            let _ = restored.close_without_keeping();
            return Err(e);
        }
        let previous = guard.replace(restored);
        engine.publish_status(&guard);
        previous
    };
    if let Some(previous) = previous {
        // Its state, unsaved work included, is the backup kept above.
        let _ = previous.close_without_keeping();
    }
    engine.notify("all");
    ok(engine.status())
}

/// Shared default body for new documents.
pub fn doc_or_empty(doc: Option<Value>) -> Value {
    doc.filter(|d| d.is_object())
        .unwrap_or_else(content::empty_doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{call, dispatch};
    use rusqlite::Connection;

    fn allow(engine: &Engine, path: &std::path::Path) {
        engine.allow_path(path);
    }

    /// Reads a page's text straight from a saved file, bypassing the engine.
    fn text_in_file(path: &std::path::Path, title: &str) -> Option<String> {
        let conn = Connection::open(path).unwrap();
        conn.query_row(
            "SELECT content_text FROM pages WHERE title = ?1",
            [title],
            |r| r.get(0),
        )
        .ok()
    }

    fn doc(text: &str) -> Value {
        json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": text }] }
        ]})
    }

    /// A file from someone else can carry SQL triggers, which would run on the writer's own
    /// edits. Opening it keeps exactly the schema's triggers.
    #[test]
    fn a_trigger_planted_in_a_project_file_never_runs_on_the_writers_edits() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "Gift" }));
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        let target = dir.0.join("gift.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        call(&engine, "project.close", json!({}));
        {
            let conn = Connection::open(&target).unwrap();
            conn.execute_batch(
                "CREATE TRIGGER wipe AFTER UPDATE ON pages BEGIN
                   UPDATE pages SET content = '{\"type\":\"doc\",\"content\":[]}', content_text = '' WHERE id = NEW.id;
                 END;
                 DROP TRIGGER pages_purge_comments;
                 CREATE TRIGGER pages_purge_comments BEFORE DELETE ON pages BEGIN DELETE FROM pages; END;",
            )
            .unwrap();
        }

        call(&engine, "project.open", json!({ "path": target }));
        call(&engine, "pages.update", json!({ "id": page["id"], "patch": { "content": doc("Words worth keeping.") } }));
        let found = call(&engine, "pages.get", json!({ "id": page["id"] }));
        assert_eq!(found["content"], doc("Words worth keeping."));

        let triggers: Vec<(String, String)> = engine
            .read(|conn| {
                let mut stmt = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                Ok(rows.collect::<rusqlite::Result<_>>()?)
            })
            .unwrap();
        let names: Vec<&str> = triggers.iter().map(|(n, _)| n.as_str()).collect();
        assert!(!names.contains(&"wipe"), "{names:?}");
        let purge = triggers.iter().find(|(n, _)| n == "pages_purge_comments").expect("the schema's own is back");
        assert!(!purge.1.contains("DELETE FROM pages;"), "{}", purge.1);
        // The file itself is untouched until the writer saves.
        let file = Connection::open(&target).unwrap();
        let planted: i64 = file
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'wipe'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(planted, 1);
    }

    #[test]
    fn saving_writes_a_project_that_reopens_with_its_data() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "My World" }));
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": page["id"], "patch": { "content": doc("A ranger.") } }),
        );
        assert!(engine.status().dirty);

        let target = dir.0.join("world.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        assert!(!engine.status().dirty);
        assert_eq!(engine.status().name, "world");
        assert_eq!(text_in_file(&target, "Aria").as_deref(), Some("A ranger."));

        call(&engine, "project.close", json!({}));
        assert!(!engine.status().open);

        call(&engine, "project.open", json!({ "path": target }));
        let found = call(&engine, "pages.getByTitle", json!({ "title": "aria" }));
        assert_eq!(found["title"], "Aria");
        assert_eq!(found["content"], doc("A ranger."));
    }

    #[test]
    fn projects_saved_before_the_rename_still_open_and_keep_their_name() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        call(&engine, "pages.create", json!({ "title": "Old Page" }));
        let old = dir.0.join("older.lorebook");
        allow(&engine, &old);
        call(&engine, "project.saveAs", json!({ "path": old }));
        assert!(old.exists(), "a chosen .lorebook name is kept, not given a second extension");
        call(&engine, "project.close", json!({}));
        call(&engine, "project.open", json!({ "path": old }));
        assert_eq!(call(&engine, "pages.getByTitle", json!({ "title": "Old Page" }))["title"], "Old Page");
        assert_eq!(
            crate::session::with_project_extension(dir.0.join("new")),
            dir.0.join("new.lorecraft")
        );
    }

    #[test]
    fn saved_files_are_single_self_contained_databases() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let target = dir.0.join("one.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));

        assert!(!dir.0.join("one.lorecraft-wal").exists());
        let conn = Connection::open(&target).unwrap();
        let app_id: i64 = conn
            .query_row("PRAGMA application_id", [], |r| r.get(0))
            .unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(app_id, db::APPLICATION_ID);
        assert_eq!(version, db::schema_version());
        assert_eq!(mode.to_lowercase(), "delete");
    }

    #[test]
    fn edits_do_not_touch_the_file_until_saved() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let page = call(&engine, "pages.create", json!({ "title": "Aria" }));
        let target = dir.0.join("w.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        let before = std::fs::read(&target).unwrap();

        call(
            &engine,
            "pages.update",
            json!({ "id": page["id"], "patch": { "content": doc("Changed.") } }),
        );
        assert!(engine.status().dirty);
        assert_eq!(std::fs::read(&target).unwrap(), before);

        call(&engine, "project.save", json!({}));
        assert_eq!(text_in_file(&target, "Aria").as_deref(), Some("Changed."));
    }

    #[test]
    fn a_crash_leaves_unsaved_work_recoverable() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "Crashy" }));
        let target = dir.0.join("c.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        let page = call(&engine, "pages.create", json!({ "title": "Unsaved Page" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": page["id"], "patch": { "content": doc("Precious.") } }),
        );

        // A crash: the OS releases the lock and nothing gets to clean up.
        let session = engine.session().take().unwrap();
        drop(session);

        let (restarted, _host2) = {
            let host = std::sync::Arc::new(crate::engine::TestHost::default());
            let paths = crate::paths::Paths::at(&dir.0);
            (
                Engine::new(paths, host.clone()).unwrap(),
                host,
            )
        };
        let list = call(&restarted, "project.listRecoverable", json!({}));
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["name"], "c");
        assert_eq!(list[0]["origin"], json!(target));
        // The saved file still has no sign of the unsaved page.
        assert!(text_in_file(&target, "Unsaved Page").is_none());

        call(
            &restarted,
            "project.recover",
            json!({ "sessionId": list[0]["sessionId"] }),
        );
        assert!(restarted.status().dirty);
        let found = call(&restarted, "pages.getByTitle", json!({ "title": "Unsaved Page" }));
        assert_eq!(found["content"], doc("Precious."));

        call(&restarted, "project.save", json!({}));
        assert_eq!(
            text_in_file(&target, "Unsaved Page").as_deref(),
            Some("Precious.")
        );
    }

    #[test]
    fn clean_orphans_are_removed_and_discard_moves_dirty_ones_to_the_backups() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        drop(engine.session().take());
        let list = call(&engine, "project.listRecoverable", json!({}));
        assert!(list.as_array().unwrap().is_empty(), "nothing was edited");

        call(&engine, "project.new", json!({}));
        call(&engine, "pages.create", json!({ "title": "X" }));
        drop(engine.session().take());
        let list = call(&engine, "project.listRecoverable", json!({}));
        assert_eq!(list.as_array().unwrap().len(), 1);
        call(
            &engine,
            "project.discardRecovery",
            json!({ "sessionId": list[0]["sessionId"] }),
        );
        let list = call(&engine, "project.listRecoverable", json!({}));
        assert!(list.as_array().unwrap().is_empty());
        let sessions = std::fs::read_dir(dir.0.join("sessions")).unwrap().count();
        assert_eq!(sessions, 0);
        let kept = backups(&engine);
        assert_eq!(kept.len(), 1, "the discarded work is among the backups");
        assert_eq!(kept[0]["kind"], "discarded");
        assert!(text_in_file(Path::new(kept[0]["path"].as_str().unwrap()), "X").is_some());
    }

    fn discarded(engine: &Engine) -> Vec<Value> {
        backups(engine).into_iter().filter(|b| b["kind"] == "discarded").collect()
    }

    fn sessions_left(dir: &crate::engine::TestDir) -> usize {
        std::fs::read_dir(dir.0.join("sessions")).map_or(0, |d| d.count())
    }

    #[test]
    fn dont_save_keeps_the_work_among_the_backups_and_restore_brings_it_back() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "Draft" }));
        let target = dir.0.join("draft.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        let page = call(&engine, "pages.create", json!({ "title": "Second thoughts" }));
        call(&engine, "pages.update", json!({ "id": page["id"], "patch": { "content": doc("Days of work.") } }));
        let saved = std::fs::read(&target).unwrap();

        // "Don't save".
        call(&engine, "project.close", json!({}));
        assert!(!engine.status().open);
        assert_eq!(std::fs::read(&target).unwrap(), saved, "the file is untouched");
        assert_eq!(sessions_left(&dir), 0);

        call(&engine, "project.open", json!({ "path": target }));
        assert!(!has_page(&engine, "Second thoughts"));
        let kept = discarded(&engine);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["name"], "draft");
        assert_eq!(kept[0]["isCurrent"], true);
        let saved_at = chrono::DateTime::parse_from_rfc3339(kept[0]["savedAt"].as_str().unwrap()).unwrap();
        let until = chrono::DateTime::parse_from_rfc3339(kept[0]["keepUntil"].as_str().unwrap()).unwrap();
        assert_eq!((until - saved_at).num_days(), 14);
        assert!((chrono::Utc::now() - saved_at.to_utc()).num_minutes() < 5, "dated when discarded");

        call(&engine, "project.restoreBackup", json!({ "path": kept[0]["path"] }));
        let found = call(&engine, "pages.getByTitle", json!({ "title": "Second thoughts" }));
        assert_eq!(found["content"], doc("Days of work."));
        assert_eq!(engine.status().path, Some(target.clone()));
        assert!(engine.status().dirty, "the file changes only when saved");
        call(&engine, "project.save", json!({}));
        assert_eq!(text_in_file(&target, "Second thoughts").as_deref(), Some("Days of work."));
    }

    #[test]
    fn a_never_saved_project_closed_without_saving_can_be_opened_again() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "Lost World" }));
        call(&engine, "pages.create", json!({ "title": "Only here" }));
        call(&engine, "project.close", json!({}));
        assert_eq!(sessions_left(&dir), 0);

        let kept = discarded(&engine);
        assert_eq!(kept.len(), 1, "with nothing open, every project's show");
        assert_eq!(kept[0]["name"], "Lost World");
        call(&engine, "project.openBackup", json!({ "path": kept[0]["path"] }));
        assert!(has_page(&engine, "Only here"));
        assert_eq!(engine.status().name, "Lost World (backup copy)");
    }

    #[test]
    fn closing_with_nothing_unsaved_keeps_nothing() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let target = dir.0.join("clean.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        call(&engine, "project.close", json!({}));
        assert_eq!(sessions_left(&dir), 0);
        assert!(backups(&engine).is_empty());
    }

    #[test]
    fn discarding_a_crashed_session_keeps_every_edit_among_the_backups() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "Crashy" }));
        let target = dir.0.join("crashy.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        let page = call(&engine, "pages.create", json!({ "title": "Unsaved Page" }));
        call(&engine, "pages.update", json!({ "id": page["id"], "patch": { "content": doc("Precious.") } }));
        // A crash: the edits are still in the write-ahead log beside the working copy.
        drop(engine.session().take());

        let list = call(&engine, "project.listRecoverable", json!({}));
        call(&engine, "project.discardRecovery", json!({ "sessionId": list[0]["sessionId"] }));
        assert!(call(&engine, "project.listRecoverable", json!({})).as_array().unwrap().is_empty());
        assert_eq!(sessions_left(&dir), 0);

        let kept = discarded(&engine);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["name"], "crashy");
        let file = Path::new(kept[0]["path"].as_str().unwrap());
        assert_eq!(text_in_file(file, "Unsaved Page").as_deref(), Some("Precious."));
        assert!(!file.with_extension("lorecraft-wal").exists(), "one file holds it all");

        call(&engine, "project.open", json!({ "path": target }));
        call(&engine, "project.restoreBackup", json!({ "path": kept[0]["path"] }));
        assert!(has_page(&engine, "Unsaved Page"));
    }

    #[test]
    fn a_damaged_crashed_session_can_still_be_discarded_and_is_kept_as_it_was() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({ "name": "Broken" }));
        call(&engine, "pages.create", json!({ "title": "X" }));
        let folder = engine.session().as_ref().unwrap().dir.clone();
        drop(engine.session().take());
        std::fs::write(folder.join("working.db"), b"not a database at all").unwrap();

        let list = call(&engine, "project.listRecoverable", json!({}));
        call(&engine, "project.discardRecovery", json!({ "sessionId": list[0]["sessionId"] }));
        assert_eq!(sessions_left(&dir), 0, "it is no longer offered");
        let kept = discarded(&engine);
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read(kept[0]["path"].as_str().unwrap()).unwrap(), b"not a database at all");
    }

    #[test]
    fn discarded_work_expires_after_fourteen_days_without_pushing_out_backups() {
        let (engine, _host, dir) = Engine::for_test();
        crate::rpc::settings::update(&engine, &json!({ "save": { "backupsToKeep": 2 } })).unwrap();
        let target = project_with_backups(&engine, &dir, 3);
        for title in ["Gone soon", "Kept a while"] {
            call(&engine, "pages.create", json!({ "title": title }));
            call(&engine, "project.close", json!({}));
            call(&engine, "project.open", json!({ "path": target }));
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let kinds = |engine: &Engine| {
            let list = backups(engine);
            let count = |kind: &str| list.iter().filter(|b| b["kind"] == kind).count();
            (count("save"), count("discarded"))
        };
        assert_eq!(kinds(&engine), (2, 2), "discarded work does not count against the backups");

        // The older discard is now fifteen days old, and the next save lets it go.
        let oldest = discarded(&engine).last().unwrap()["path"].as_str().unwrap().to_string();
        let file = std::fs::OpenOptions::new().write(true).open(&oldest).unwrap();
        file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(15 * 24 * 60 * 60)).unwrap();
        drop(file);
        call(&engine, "pages.create", json!({ "title": "More" }));
        call(&engine, "project.save", json!({}));
        assert_eq!(kinds(&engine), (2, 1));
        assert!(!Path::new(&oldest).exists());
        assert!(text_in_file(Path::new(discarded(&engine)[0]["path"].as_str().unwrap()), "Kept a while").is_some());
    }

    #[test]
    fn saving_over_an_older_format_keeps_the_old_file_for_good() {
        let (engine, _host, dir) = Engine::for_test();
        crate::rpc::settings::update(&engine, &json!({ "save": { "backupsToKeep": 1 } })).unwrap();
        call(&engine, "project.new", json!({}));
        let target = dir.0.join("old.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        call(&engine, "pages.create", json!({ "title": "Written in the old days" }));
        call(&engine, "project.save", json!({}));
        // The file on disk is in an older format than the open working copy.
        Connection::open(&target).unwrap().pragma_update(None, "user_version", 0).unwrap();

        call(&engine, "pages.create", json!({ "title": "New" }));
        call(&engine, "project.save", json!({ "force": true }));
        for i in 0..3 {
            call(&engine, "pages.create", json!({ "title": format!("Later {i}") }));
            call(&engine, "project.save", json!({}));
        }
        let list = backups(&engine);
        let upgrades: Vec<&Value> = list.iter().filter(|b| b["kind"] == "beforeUpgrade").collect();
        assert_eq!(upgrades.len(), 1, "never pruned: {list:?}");
        assert_eq!(upgrades[0]["upgradeVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(list.iter().filter(|b| b["kind"] == "save").count(), 1, "nor counted against the others");
        let old = Connection::open(upgrades[0]["path"].as_str().unwrap()).unwrap();
        let version: i64 = old.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 0, "the file as it was");
        assert!(text_in_file(Path::new(upgrades[0]["path"].as_str().unwrap()), "Written in the old days").is_some());
        // The saved file is in the current format.
        let saved: i64 = Connection::open(&target).unwrap().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(saved, db::schema_version());
    }

    #[test]
    fn an_upgrade_is_kept_even_with_backups_turned_off() {
        let (engine, _host, dir) = Engine::for_test();
        crate::rpc::settings::update(&engine, &json!({ "save": { "backupsToKeep": 0 } })).unwrap();
        call(&engine, "project.new", json!({}));
        let target = dir.0.join("off.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        Connection::open(&target).unwrap().pragma_update(None, "user_version", 0).unwrap();
        call(&engine, "project.save", json!({ "force": true }));
        call(&engine, "project.save", json!({}));
        let list = backups(&engine);
        assert_eq!(list.len(), 1, "{list:?}");
        assert_eq!(list[0]["kind"], "beforeUpgrade");
    }

    fn set_read_only(path: &Path, read_only: bool) {
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(read_only);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    #[test]
    fn a_read_only_file_opens_and_saving_over_it_says_so_plainly() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let target = dir.0.join("locked.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        call(&engine, "project.close", json!({}));
        set_read_only(&target, true);
        let before = std::fs::read(&target).unwrap();

        call(&engine, "project.open", json!({ "path": target }));
        call(&engine, "pages.create", json!({ "title": "Edited anyway" }));
        let error = dispatch(&engine, "project.save", json!({})).unwrap_err();
        assert_eq!(error.code, "READ_ONLY");
        assert!(error.message.contains("is read-only"), "{}", error.message);
        assert!(!error.message.contains("another program"), "{}", error.message);
        assert!(engine.status().dirty);
        assert_eq!(std::fs::read(&target).unwrap(), before);
        let leftovers = std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".saving"))
            .count();
        assert_eq!(leftovers, 0, "it stopped before writing anything");

        set_read_only(&target, false);
        call(&engine, "project.save", json!({}));
        assert!(text_in_file(&target, "Edited anyway").is_some());
    }

    #[cfg(windows)]
    #[test]
    fn a_save_that_cannot_replace_the_file_keeps_its_checked_copy_and_says_where() {
        use std::os::windows::fs::OpenOptionsExt;
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let target = dir.0.join("held.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        call(&engine, "pages.create", json!({ "title": "Precious" }));
        // Another program has the file open and shares nothing.
        let holder = std::fs::OpenOptions::new().read(true).share_mode(0).open(&target).unwrap();
        session::set_test_replace_window(Some(std::time::Duration::from_millis(300)));
        let error = dispatch(&engine, "project.save", json!({})).unwrap_err();
        session::set_test_replace_window(None);
        drop(holder);

        assert_eq!(error.code, "SAVE_FAILED");
        let kept: Vec<PathBuf> = std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.to_string_lossy().contains("held (copy "))
            .collect();
        assert_eq!(kept.len(), 1, "{}", error.message);
        assert!(error.message.contains(&*kept[0].to_string_lossy()), "{}", error.message);
        assert!(text_in_file(&kept[0], "Precious").is_some(), "a complete, checked copy");
        assert!(text_in_file(&target, "Precious").is_none(), "the file is as it was");
        assert!(engine.status().dirty, "and the work is still unsaved in LoreCraft");
    }

    #[test]
    fn opening_removes_what_interrupted_saves_left_and_nothing_else() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let target = dir.0.join("tidy.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        call(&engine, "project.close", json!({}));
        let stale = [
            ".lc-0a1b2c3d.saving".to_string(),
            format!(".tidy.lorecraft.{}.saving", db::new_id()),
            format!("copy.tmp-{}", db::new_id()),
        ];
        let others = [".lc-nothex12.saving", "draft.saving", ".lc-0a1b2c3d.saving.txt", "notes.tmp-1"];
        for name in stale.iter().map(String::as_str).chain(others) {
            let path = dir.0.join(name);
            std::fs::write(&path, b"leftover").unwrap();
            // Without Windows sharing modes, a recent file might be a save under way, so
            // only old ones count as left over. These were left by a crash two hours ago.
            #[cfg(not(windows))]
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(7200))
                .unwrap();
        }
        // A save in another window holds its file open.
        let busy = dir.0.join(".lc-11112222.saving");
        std::fs::write(&busy, b"in use").unwrap();
        let handle = std::fs::File::open(&busy).unwrap();

        call(&engine, "project.open", json!({ "path": target }));
        for name in &stale {
            assert!(!dir.0.join(name).exists(), "{name} was left over");
        }
        for name in others {
            assert!(dir.0.join(name).exists(), "{name} is not ours");
        }
        #[cfg(windows)]
        assert!(busy.exists(), "a save under way keeps its file");
        drop(handle);
    }

    #[cfg(windows)]
    #[test]
    fn a_path_near_the_length_limit_still_saves() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let name = "a-long-project-name.lorecraft";
        // Short of the 260 characters Windows allows, but not by the old temporary name's 45.
        let mut folder = dir.0.clone();
        while folder.to_string_lossy().len() + 1 + name.len() < 245 {
            folder.push("f");
        }
        std::fs::create_dir_all(&folder).unwrap();
        let target = folder.join(name);
        allow(&engine, &target);
        call(&engine, "pages.create", json!({ "title": "Far away" }));
        call(&engine, "project.saveAs", json!({ "path": target }));
        assert!(text_in_file(&target, "Far away").is_some());
        call(&engine, "pages.create", json!({ "title": "Further" }));
        call(&engine, "project.save", json!({}));
        assert!(text_in_file(&target, "Further").is_some());
    }

    #[test]
    fn a_live_session_is_not_offered_for_recovery() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        call(&engine, "pages.create", json!({ "title": "X" }));
        let list = call(&engine, "project.listRecoverable", json!({}));
        assert!(list.as_array().unwrap().is_empty());
        assert!(engine.status().open);
    }

    #[test]
    fn saving_over_an_externally_changed_file_asks_first() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let target = dir.0.join("e.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));

        // Someone else replaces the file, with different content and size.
        let copy = dir.0.join("copy.lorecraft");
        allow(&engine, &copy);
        call(&engine, "pages.create", json!({ "title": "Elsewhere" }));
        call(&engine, "project.exportCopy", json!({ "path": copy }));
        std::fs::copy(&copy, &target).unwrap();

        let err = dispatch(&engine, "project.save", json!({})).unwrap_err();
        assert_eq!(err.code, "EXTERNAL_CHANGE");
        call(&engine, "project.save", json!({ "force": true }));
        assert!(!engine.status().dirty);
    }

    #[test]
    fn unsaved_work_blocks_replacing_the_session() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        call(&engine, "pages.create", json!({ "title": "X" }));
        let err = dispatch(&engine, "project.new", json!({})).unwrap_err();
        assert_eq!(err.code, "UNSAVED_WORK");
    }

    #[test]
    fn opening_a_non_project_fails_clearly_and_leaves_no_session() {
        let (engine, _host, dir) = Engine::for_test();
        let bad = dir.0.join("bad.lorecraft");
        std::fs::write(&bad, b"not a database").unwrap();
        let err = dispatch(&engine, "project.open", json!({ "path": bad })).unwrap_err();
        assert_eq!(err.code, "NOT_A_PROJECT");
        assert!(!engine.status().open);
        assert_eq!(std::fs::read(&bad).unwrap(), b"not a database");
    }

    #[test]
    fn saves_keep_rolling_backups_of_the_previous_file() {
        let (engine, _host, dir) = Engine::for_test();
        crate::rpc::settings::update(&engine, &json!({ "save": { "backupsToKeep": 2 } })).unwrap();
        call(&engine, "project.new", json!({}));
        let target = dir.0.join("b.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        for i in 0..4 {
            call(&engine, "pages.create", json!({ "title": format!("P{i}") }));
            call(&engine, "project.save", json!({}));
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let project_dirs: Vec<_> = std::fs::read_dir(dir.0.join("backups"))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(project_dirs.len(), 1);
        let count = std::fs::read_dir(project_dirs[0].path()).unwrap().count();
        assert_eq!(count, 2);
    }

    /// A saved project with `saves` backups. The oldest has none of the V pages, and the
    /// open project has a V page for each save, the last of them not saved yet.
    fn project_with_backups(
        engine: &Engine,
        dir: &crate::engine::TestDir,
        saves: usize,
    ) -> PathBuf {
        call(engine, "project.new", json!({ "name": "History" }));
        let target = dir.0.join("history.lorecraft");
        allow(engine, &target);
        call(engine, "project.saveAs", json!({ "path": target }));
        for i in 0..saves {
            call(engine, "project.save", json!({}));
            call(engine, "pages.create", json!({ "title": format!("V{i}") }));
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        target
    }

    fn backups(engine: &Engine) -> Vec<Value> {
        call(engine, "project.listBackups", json!({}))
            .as_array()
            .unwrap()
            .clone()
    }

    fn has_page(engine: &Engine, title: &str) -> bool {
        !call(engine, "pages.getByTitle", json!({ "title": title })).is_null()
    }

    fn project_id(engine: &Engine) -> Value {
        call(engine, "project.getMeta", json!({ "key": "project_id" }))
    }

    #[test]
    fn listing_shows_this_projects_backups_newest_first_with_time_and_size() {
        let (engine, _host, dir) = Engine::for_test();
        assert!(backups(&engine).is_empty(), "no folder yet, and no error");

        project_with_backups(&engine, &dir, 3);
        let list = backups(&engine);
        assert_eq!(list.len(), 3);
        for backup in &list {
            assert_eq!(backup["name"], "history");
            assert_eq!(backup["isCurrent"], true);
            assert_eq!(backup["beforeRestore"], false);
            assert!(backup["size"].as_u64().unwrap() > 0);
            let time = backup["savedAt"].as_str().unwrap();
            assert!(chrono::DateTime::parse_from_rfc3339(time).is_ok(), "{time}");
        }
        let times: Vec<&str> = list.iter().map(|b| b["savedAt"].as_str().unwrap()).collect();
        let mut sorted = times.clone();
        sorted.sort_unstable_by(|a, b| b.cmp(a));
        assert_eq!(times, sorted);
    }

    #[test]
    fn listing_ignores_what_is_not_a_backup_and_keeps_to_the_open_project() {
        let (engine, _host, dir) = Engine::for_test();
        project_with_backups(&engine, &dir, 1);
        let chosen = PathBuf::from(backups(&engine)[0]["path"].as_str().unwrap());
        let folder = chosen.parent().unwrap().to_path_buf();
        std::fs::write(folder.join("note.txt"), "not a backup").unwrap();
        std::fs::create_dir(folder.join("folder.lorecraft")).unwrap();
        assert_eq!(backups(&engine).len(), 1);

        let other = dir.0.join("backups").join("another-project");
        std::fs::create_dir(&other).unwrap();
        std::fs::copy(&chosen, other.join("Other-20260101-120000-000.lorecraft")).unwrap();
        assert_eq!(backups(&engine).len(), 1, "another project's stays out by default");

        let everything = call(&engine, "project.listBackups", json!({ "all": true }));
        let everything = everything.as_array().unwrap();
        assert_eq!(everything.len(), 2);
        let theirs = everything.iter().find(|b| b["isCurrent"] == false).unwrap();
        assert_eq!(theirs["name"], "Other");
        assert_eq!(theirs["projectId"], "another-project");

        // Closing without saving keeps the unsaved V0 as a third.
        call(&engine, "project.close", json!({}));
        assert_eq!(backups(&engine).len(), 3, "with nothing open, all of them show");
    }

    #[test]
    fn backup_names_read_back_even_with_dashes_and_unknown_shapes() {
        let read = |name: &str| read_backup_name(Path::new(name));
        let named = |name: &str, kind: BackupKind| (name.to_string(), kind);
        assert_eq!(read("My-World-20261105-104100-123.lorecraft"), named("My-World", BackupKind::Save));
        assert_eq!(
            read("World-20261105-104100-123-before-restore.lorecraft"),
            named("World", BackupKind::BeforeRestore)
        );
        assert_eq!(read("no-timestamp.lorecraft"), named("no-timestamp", BackupKind::Save));
        assert_eq!(read("-20261105-104100-123.lorecraft"), named("-20261105-104100-123", BackupKind::Save));
        assert_eq!(
            read("My-World-20261105-104100-123-discarded.lorecraft"),
            named("My-World", BackupKind::Discarded)
        );
        assert_eq!(
            read("World-20261105-104100-123-before-upgrade-1.2.0-beta.1.lorecraft"),
            named("World", BackupKind::BeforeUpgrade("1.2.0-beta.1".to_string()))
        );
        // A mark counts only right after the time, so a name cannot pass for one.
        assert_eq!(read("Notes-discarded.lorecraft"), named("Notes-discarded", BackupKind::Save));
        assert_eq!(
            read("A-before-upgrade-x-20261105-104100-123.lorecraft"),
            named("A-before-upgrade-x", BackupKind::Save)
        );
    }

    #[test]
    fn opening_a_copy_makes_a_separate_unsaved_project_and_overwrites_nothing() {
        let (engine, _host, dir) = Engine::for_test();
        let target = project_with_backups(&engine, &dir, 2);
        call(&engine, "project.save", json!({}));
        let original_id = project_id(&engine);
        let original = std::fs::read(&target).unwrap();
        let list = backups(&engine);
        assert_eq!(list.len(), 3);
        let chosen = list.last().unwrap().clone();
        let chosen_path = PathBuf::from(chosen["path"].as_str().unwrap());
        let chosen_bytes = std::fs::read(&chosen_path).unwrap();

        let status = call(&engine, "project.openBackup", json!({ "path": chosen["path"] }));
        assert_eq!(status["name"], "history (backup copy)");
        assert!(status["path"].is_null(), "it has no file to overwrite");
        assert_eq!(status["dirty"], true, "closing it asks first, and a crash keeps it");
        assert!(!has_page(&engine, "V0"), "this is the oldest version");
        assert_ne!(project_id(&engine), original_id);

        // Saving always asks where, because there is no file.
        let error = dispatch(&engine, "project.save", json!({})).unwrap_err();
        assert_eq!(error.code, "NEEDS_PATH");

        call(&engine, "pages.create", json!({ "title": "Only in the copy" }));
        let elsewhere = dir.0.join("elsewhere.lorecraft");
        allow(&engine, &elsewhere);
        call(&engine, "project.saveAs", json!({ "path": elsewhere }));

        assert_eq!(std::fs::read(&target).unwrap(), original, "the project's file is untouched");
        assert_eq!(std::fs::read(&chosen_path).unwrap(), chosen_bytes, "the backup is untouched");
        // Only the save reaches the recent list, never the backup's own path.
        let recent = engine.settings().get("recent").cloned().unwrap().to_string();
        assert!(recent.contains("elsewhere"));
        assert!(!recent.contains(chosen_path.file_name().unwrap().to_str().unwrap()));
    }

    #[test]
    fn a_copys_backups_do_not_join_the_originals() {
        let (engine, _host, dir) = Engine::for_test();
        project_with_backups(&engine, &dir, 1);
        call(&engine, "project.save", json!({}));
        let chosen = backups(&engine)[0].clone();
        let folders = || std::fs::read_dir(dir.0.join("backups")).unwrap().count();
        assert_eq!(folders(), 1);

        call(&engine, "project.openBackup", json!({ "path": chosen["path"] }));
        assert!(backups(&engine).is_empty(), "a new project has no backups of its own");
        let elsewhere = dir.0.join("elsewhere.lorecraft");
        allow(&engine, &elsewhere);
        call(&engine, "project.saveAs", json!({ "path": elsewhere }));
        call(&engine, "project.save", json!({}));
        assert_eq!(folders(), 2);
        assert_eq!(backups(&engine).len(), 1);
    }

    #[test]
    fn opening_a_copy_will_not_replace_unsaved_work() {
        let (engine, _host, dir) = Engine::for_test();
        project_with_backups(&engine, &dir, 1);
        let chosen = backups(&engine)[0].clone();
        assert!(engine.status().dirty);
        let error = dispatch(&engine, "project.openBackup", json!({ "path": chosen["path"] })).unwrap_err();
        assert_eq!(error.code, "UNSAVED_WORK");
        assert!(has_page(&engine, "V0"), "the open project is still there");
    }

    #[test]
    fn a_copy_survives_a_crash_as_recoverable_work() {
        let (engine, _host, dir) = Engine::for_test();
        project_with_backups(&engine, &dir, 1);
        call(&engine, "project.save", json!({}));
        let chosen = backups(&engine)[0].clone();
        call(&engine, "project.openBackup", json!({ "path": chosen["path"] }));
        drop(engine.session().take());

        let list = call(&engine, "project.listRecoverable", json!({}));
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["name"], "history (backup copy)");
        assert!(list[0]["origin"].is_null());
    }

    #[test]
    fn restoring_keeps_the_current_state_as_a_backup_first() {
        let (engine, _host, dir) = Engine::for_test();
        let target = project_with_backups(&engine, &dir, 2);
        call(&engine, "pages.create", json!({ "title": "Unsaved work" }));
        let saved_file = std::fs::read(&target).unwrap();
        let id_before = project_id(&engine);
        let before = backups(&engine);
        assert_eq!(before.len(), 2);
        let oldest = before.last().unwrap().clone();

        let status = call(&engine, "project.restoreBackup", json!({ "path": oldest["path"] }));
        assert_eq!(status["name"], "history", "still the same project");
        assert_eq!(status["path"], json!(target));
        assert_eq!(status["dirty"], true, "the file changes only when saved");
        assert_eq!(std::fs::read(&target).unwrap(), saved_file);
        assert!(!has_page(&engine, "Unsaved work"));
        assert!(!has_page(&engine, "V0"));
        assert_eq!(project_id(&engine), id_before);

        // What was replaced is now the newest backup, unsaved work included.
        let after = backups(&engine);
        assert_eq!(after.len(), 3);
        assert_eq!(after[0]["beforeRestore"], true);
        assert_eq!(after[0]["name"], "history");
        let kept = text_in_file(Path::new(after[0]["path"].as_str().unwrap()), "Unsaved work");
        assert!(kept.is_some(), "the safety copy holds the unsaved page");

        // And it can be restored in its turn.
        call(&engine, "project.restoreBackup", json!({ "path": after[0]["path"] }));
        assert!(has_page(&engine, "Unsaved work"));
        assert_eq!(backups(&engine).len(), 4);

        // Saving writes the restored state to the project's own file, without asking
        // about outside changes, because the restore did not change the file.
        call(&engine, "project.restoreBackup", json!({ "path": oldest["path"] }));
        call(&engine, "project.save", json!({}));
        assert!(!engine.status().dirty);
        assert!(text_in_file(&target, "Unsaved work").is_none());
        assert!(text_in_file(&target, "V0").is_none());
    }

    #[test]
    fn restoring_refuses_another_projects_backup_and_changes_nothing() {
        let (engine, _host, dir) = Engine::for_test();
        project_with_backups(&engine, &dir, 1);
        let chosen = backups(&engine)[0].clone();
        let other = dir.0.join("backups").join("another-project");
        std::fs::create_dir(&other).unwrap();
        let foreign = other.join("Other-20260101-120000-000.lorecraft");
        std::fs::copy(chosen["path"].as_str().unwrap(), &foreign).unwrap();

        let count = backups(&engine).len();
        let error = dispatch(&engine, "project.restoreBackup", json!({ "path": foreign })).unwrap_err();
        assert_eq!(error.code, "OTHER_PROJECT");
        assert_eq!(backups(&engine).len(), count, "no safety copy was made for nothing");
        assert!(has_page(&engine, "V0"));
    }

    #[test]
    fn deletes_one_backup_and_only_from_the_backups_folder() {
        let (engine, _host, dir) = Engine::for_test();
        project_with_backups(&engine, &dir, 2);
        let before = backups(&engine);
        let chosen = before[0]["path"].as_str().unwrap().to_string();
        call(&engine, "project.deleteBackup", json!({ "path": chosen }));
        let after = backups(&engine);
        assert_eq!(after.len(), before.len() - 1);
        assert!(after.iter().all(|b| b["path"].as_str() != Some(chosen.as_str())));

        let outside = dir.0.join("not-a-backup.lorecraft");
        std::fs::write(&outside, b"x").unwrap();
        let error = dispatch(&engine, "project.deleteBackup", json!({ "path": outside })).unwrap_err();
        assert_eq!(error.code, "PATH_NOT_ALLOWED");
        assert!(outside.exists());
    }

    #[test]
    fn restoring_needs_an_open_project() {
        let (engine, _host, dir) = Engine::for_test();
        project_with_backups(&engine, &dir, 1);
        call(&engine, "project.save", json!({}));
        let chosen = backups(&engine)[0].clone();
        call(&engine, "project.close", json!({}));
        let error = dispatch(&engine, "project.restoreBackup", json!({ "path": chosen["path"] })).unwrap_err();
        assert_eq!(error.code, AppError::no_project().code);
    }

    #[test]
    fn a_damaged_backup_is_refused_and_the_project_stays_as_it_was() {
        let (engine, _host, dir) = Engine::for_test();
        project_with_backups(&engine, &dir, 1);
        let chosen = PathBuf::from(backups(&engine)[0]["path"].as_str().unwrap());
        let bad = chosen.parent().unwrap().join("broken-20260101-120000-000.lorecraft");
        std::fs::write(&bad, b"not a database").unwrap();

        let count = backups(&engine).len();
        let error = dispatch(&engine, "project.restoreBackup", json!({ "path": bad })).unwrap_err();
        assert_eq!(error.code, "NOT_A_PROJECT");
        assert_eq!(backups(&engine).len(), count);
        assert!(has_page(&engine, "V0"));
        assert_eq!(std::fs::read(&bad).unwrap(), b"not a database");
    }

    #[test]
    fn anything_outside_the_backups_folder_is_refused() {
        let (engine, _host, dir) = Engine::for_test();
        let target = project_with_backups(&engine, &dir, 1);
        call(&engine, "project.save", json!({}));
        let chosen = PathBuf::from(backups(&engine)[0]["path"].as_str().unwrap());
        let folder = chosen.parent().unwrap().to_path_buf();
        // A real project file that is simply in the wrong place.
        let outside = dir.0.join("outside.lorecraft");
        std::fs::copy(&target, &outside).unwrap();
        // Inside the folder, but not a project file.
        let not_project = folder.join("notes.txt");
        std::fs::copy(&target, &not_project).unwrap();

        let attempts: Vec<Value> = vec![
            json!(outside),
            json!(target),
            json!(folder.join("..").join("..").join("outside.lorecraft")),
            json!(dir.0.join("backups")),
            json!(folder),
            json!(not_project),
            json!(folder.join("missing.lorecraft")),
            json!("outside.lorecraft"),
            json!("..\\..\\outside.lorecraft"),
            json!(""),
        ];
        for path in attempts {
            for method in ["project.openBackup", "project.restoreBackup"] {
                let error = dispatch(&engine, method, json!({ "path": path })).unwrap_err();
                assert_eq!(error.code, "PATH_NOT_ALLOWED", "{method} {path}");
            }
        }
        assert_eq!(engine.status().path, Some(target.clone()), "still the same project");

        // A link inside the folder that leads out of it is outside too.
        let link = folder.join("link.lorecraft");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside, &link);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, &link);
        // Windows allows links only to administrators or in developer mode.
        if linked.is_ok() {
            let error = dispatch(&engine, "project.openBackup", json!({ "path": link })).unwrap_err();
            assert_eq!(error.code, "PATH_NOT_ALLOWED");
        }
    }

    #[test]
    fn a_failed_save_leaves_the_existing_file_alone() {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let target = dir.0.join("f.lorecraft");
        allow(&engine, &target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        let before = std::fs::read(&target).unwrap();
        call(&engine, "pages.create", json!({ "title": "New" }));

        // A folder cannot be replaced by the final rename, so that step fails.
        let folder = dir.0.join("taken.lorecraft");
        std::fs::create_dir(&folder).unwrap();
        allow(&engine, &folder);
        assert!(dispatch(&engine, "project.saveAs", json!({ "path": folder })).is_err());
        assert!(engine.status().dirty, "still unsaved");
        assert_eq!(std::fs::read(&target).unwrap(), before);
        let leftovers = std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".saving"))
            .count();
        assert_eq!(leftovers, 0, "temp files are cleaned up");
    }
}
