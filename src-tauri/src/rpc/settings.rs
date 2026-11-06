//! App-wide settings, as one JSON document. Its shape and defaults are defined in
//! `src/lib/settings.ts`. Rust reads the few fields it needs by name.
//!
//! The file is written the way a save is: a temporary file, flushed to disk, then renamed
//! over `settings.json`. The version it replaces is kept as `settings.json.bak`. A file that
//! cannot be read is never overwritten: it is kept as `settings.broken-<date>.json`, the
//! backup is used instead, and the writer is told at startup.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{parse, unknown};
use crate::engine::Engine;
use crate::error::AppResult;
use crate::paths::Paths;
use crate::session::write_atomic;

/// The shape of the settings document, stored in it as `version`. Raise it when a change
/// needs old settings converted.
pub const SETTINGS_VERSION: u64 = 1;

/// What loading had to do about an unreadable settings file, per data folder, until the
/// UI asks for it.
static LOAD_REPORTS: LazyLock<Mutex<HashMap<PathBuf, Value>>> = LazyLock::new(Default::default);

fn backup_file(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

/// A settings document, if the bytes are one.
fn parse_settings(bytes: &[u8]) -> Option<Value> {
    serde_json::from_slice::<Value>(bytes).ok().filter(Value::is_object)
}

/// `Ok(None)` when there is no file, which is a first run. `Err` when there is one that
/// cannot be read as settings.
fn read_settings(path: &Path) -> Result<Option<Value>, ()> {
    match std::fs::read(path) {
        Ok(bytes) => parse_settings(&bytes).map(Some).ok_or(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

fn with_version(mut settings: Value) -> Value {
    if let Some(map) = settings.as_object_mut() {
        // A newer version's number stays, so its settings are not mistaken for ours.
        let known = map.get("version").and_then(Value::as_u64).unwrap_or(0);
        if known < SETTINGS_VERSION {
            map.insert("version".to_string(), json!(SETTINGS_VERSION));
        }
    }
    settings
}

pub fn load(paths: &Paths) -> Value {
    let path = paths.settings_file();
    let settings = match read_settings(&path) {
        Ok(found) => found.unwrap_or_else(|| json!({})),
        Err(()) => recover(paths, &path),
    };
    with_version(settings)
}

/// Sets the unreadable file aside, where nothing overwrites it, and goes back to the backup.
fn recover(paths: &Paths, path: &Path) -> Value {
    let broken = paths.root.join(format!(
        "settings.broken-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    let kept = std::fs::rename(path, &broken).is_ok() || std::fs::copy(path, &broken).is_ok();
    let backup = read_settings(&backup_file(path)).ok().flatten();
    let report = json!({
        "restored": backup.is_some(),
        "brokenFile": kept.then_some(&broken),
    });
    LOAD_REPORTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(paths.root.clone(), report);
    let settings = backup.unwrap_or_else(|| json!({}));
    // Written back now, so the next launch starts from it even if nothing changes first.
    if kept {
        let _ = store(paths, &with_version(settings.clone()));
    }
    settings
}

/// What `load` had to do about an unreadable settings file, once. Null if nothing.
pub fn take_load_report(paths: &Paths) -> Value {
    LOAD_REPORTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&paths.root)
        .unwrap_or(Value::Null)
}

fn store(paths: &Paths, value: &Value) -> AppResult<()> {
    let path = paths.settings_file();
    // The version being replaced becomes the backup, but only one that reads back, so a
    // damaged file can never replace a good backup. A backup that cannot be written does
    // not stop the change.
    if let Ok(current) = std::fs::read(&path) {
        if parse_settings(&current).is_some() {
            let _ = write_atomic(&backup_file(&path), &current);
        }
    }
    write_atomic(&path, &serde_json::to_vec_pretty(value)?)
}

/// Objects merge key by key. A `null` removes a key. Anything else replaces.
pub fn deep_merge(base: &mut Value, patch: &Value) {
    match (base.as_object_mut(), patch.as_object()) {
        (Some(base_map), Some(patch_map)) => {
            for (key, value) in patch_map {
                if value.is_null() {
                    base_map.remove(key);
                } else {
                    deep_merge(base_map.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        _ => *base = patch.clone(),
    }
}

pub fn update(engine: &Engine, patch: &Value) -> AppResult<Value> {
    let mut settings = engine.settings();
    let mut next = settings.clone();
    deep_merge(&mut next, patch);
    let next = with_version(next);
    // Only what reached the disk is kept, so memory and file never disagree.
    store(&engine.paths, &next)?;
    *settings = next;
    Ok(settings.clone())
}

const MAX_RECENT: usize = 20;

pub fn remember_recent(engine: &Engine, path: &std::path::Path, name: &str) -> AppResult<()> {
    let path_text = path.to_string_lossy().to_string();
    let mut recent: Vec<Value> = engine
        .settings()
        .get("recent")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    recent.retain(|r| r.get("path").and_then(Value::as_str) != Some(path_text.as_str()));
    recent.insert(
        0,
        json!({ "path": path_text, "name": name, "openedAt": crate::db::now() }),
    );
    recent.truncate(MAX_RECENT);
    update(engine, &json!({ "recent": recent }))?;
    engine.notify("recent");
    Ok(())
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "get" => Ok(engine.settings().clone()),
        // Asked once at startup, so the writer hears if their settings file was unreadable.
        "takeLoadReport" => Ok(take_load_report(&engine.paths)),
        "update" => {
            #[derive(Deserialize)]
            struct P {
                patch: Value,
            }
            let p: P = parse(params)?;
            update(engine, &p.patch)
        }
        "removeRecent" => {
            #[derive(Deserialize)]
            struct P {
                path: String,
            }
            let p: P = parse(params)?;
            let mut recent: Vec<Value> = engine
                .settings()
                .get("recent")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            recent.retain(|r| r.get("path").and_then(Value::as_str) != Some(p.path.as_str()));
            update(engine, &json!({ "recent": recent }))
        }
        _ => Err(unknown(&format!("settings.{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_combines_objects_replaces_values_and_removes_nulls() {
        let mut base = json!({ "a": { "x": 1, "y": 2 }, "b": [1], "c": 3 });
        deep_merge(&mut base, &json!({ "a": { "y": 9 }, "b": [2, 3], "c": null }));
        assert_eq!(base, json!({ "a": { "x": 1, "y": 9 }, "b": [2, 3] }));
    }
}

#[cfg(test)]
mod safety_tests {
    use super::*;
    use std::sync::Arc;

    fn restart(dir: &crate::engine::TestDir) -> Arc<Engine> {
        let host = Arc::new(crate::engine::TestHost::default());
        Arc::new(Engine::new(Paths::at(&dir.0), host).unwrap())
    }

    fn read(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn broken_files(dir: &crate::engine::TestDir) -> Vec<PathBuf> {
        std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("settings.broken-"))
            .collect()
    }

    #[test]
    fn settings_are_replaced_whole_with_the_previous_version_kept_and_a_version() {
        let (engine, _host, dir) = Engine::for_test();
        update(&engine, &json!({ "theme": "first" })).unwrap();
        update(&engine, &json!({ "theme": "second" })).unwrap();
        let file = engine.paths.settings_file();
        assert_eq!(read(&file)["theme"], "second");
        assert_eq!(read(&file)["version"], SETTINGS_VERSION);
        assert_eq!(read(&backup_file(&file))["theme"], "first");
        let leftovers = std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains("tmp"))
            .count();
        assert_eq!(leftovers, 0);
        assert_eq!(engine.settings()["version"], SETTINGS_VERSION);
    }

    #[test]
    fn an_unreadable_settings_file_is_kept_aside_and_the_backup_used() {
        let (engine, _host, dir) = Engine::for_test();
        update(&engine, &json!({ "theme": "kept", "recent": [{ "path": "a.lorecraft" }] })).unwrap();
        update(&engine, &json!({ "theme": "latest" })).unwrap();
        let file = engine.paths.settings_file();
        std::fs::write(&file, b"{ \"theme\": \"half-writ").unwrap();

        let restarted = restart(&dir);
        assert_eq!(restarted.settings()["theme"], "kept", "the backup, not the defaults");
        let broken = broken_files(&dir);
        assert_eq!(broken.len(), 1);
        assert_eq!(std::fs::read(&broken[0]).unwrap(), b"{ \"theme\": \"half-writ");
        let report = take_load_report(&restarted.paths);
        assert_eq!(report["restored"], true);
        assert_eq!(report["brokenFile"], json!(broken[0]));
        assert!(take_load_report(&restarted.paths).is_null(), "told once");

        // The next change starts from the backup and leaves the broken file alone.
        update(&restarted, &json!({ "fontSize": 3 })).unwrap();
        let now = read(&file);
        assert_eq!(now["theme"], "kept");
        assert_eq!(now["fontSize"], 3);
        assert_eq!(now["recent"][0]["path"], "a.lorecraft");
        assert_eq!(std::fs::read(&broken[0]).unwrap(), b"{ \"theme\": \"half-writ");
        assert_eq!(read(&backup_file(&file))["theme"], "kept");
    }

    #[test]
    fn with_no_backup_the_defaults_are_used_and_the_unreadable_file_still_kept() {
        let (_engine, _host, dir) = Engine::for_test();
        let file = dir.0.join("settings.json");
        std::fs::write(&file, b"[1, 2").unwrap();
        let restarted = restart(&dir);
        assert_eq!(restarted.settings().get("theme"), None);
        assert_eq!(broken_files(&dir).len(), 1);
        assert_eq!(take_load_report(&restarted.paths)["restored"], false);
    }

    #[test]
    fn a_first_run_has_nothing_to_report() {
        let (engine, _host, _dir) = Engine::for_test();
        assert!(take_load_report(&engine.paths).is_null());
        assert_eq!(engine.settings()["version"], SETTINGS_VERSION);
    }
}
