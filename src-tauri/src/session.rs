//! Working copies, saving and crash recovery. See docs/ARCHITECTURE.md.
//!
//! The rule that keeps work safe: the user's file changes only in one atomic
//! rename at the end of a verified save, and every edit before that is durable in
//! a working copy that survives a crash. Unsaved work is never deleted: a working copy
//! the writer chose not to save moves into the backups instead.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db;
use crate::error::{AppError, AppResult};
use crate::paths::Paths;

const WORKING_DB: &str = "working.db";
const SESSION_JSON: &str = "session.json";
const SESSION_LOCK: &str = "session.lock";
/// Summaries waiting for the next save, one file per project, in the data folder.
const PENDING_SUMMARIES: &str = "pending-summaries";

pub const PROJECT_EXTENSION: &str = "lorecraft";
/// Projects saved before the app was renamed LoreCraft. They still open, and keep their name.
pub const LEGACY_PROJECT_EXTENSION: &str = "lorebook";

/// Whether a file extension is one of a LoreCraft project.
pub fn is_project_extension(ext: &std::ffi::OsStr) -> bool {
    ext.eq_ignore_ascii_case(PROJECT_EXTENSION) || ext.eq_ignore_ascii_case(LEGACY_PROJECT_EXTENSION)
}

/// How much disk one project's backups may use, unless settings say otherwise.
pub const DEFAULT_BACKUP_BUDGET: u64 = 5 * 1024 * 1024 * 1024;
/// How many backups a project keeps, unless settings say otherwise.
pub const DEFAULT_BACKUPS_TO_KEEP: usize = 10;

/// How many backups to keep for a project, and how much disk they may use together.
#[derive(Debug, Clone, Copy)]
pub struct BackupPolicy {
    pub keep: usize,
    pub budget_bytes: u64,
}

impl Default for BackupPolicy {
    fn default() -> Self {
        Self {
            keep: DEFAULT_BACKUPS_TO_KEEP,
            budget_bytes: DEFAULT_BACKUP_BUDGET,
        }
    }
}

// ---- Kinds of backup ---------------------------------------------------------
//
// Backups are named `<project>-<yyyymmdd>-<hhmmss>-<ms><mark>.lorecraft`. The mark says why
// the backup was made, and decides how long it stays.

/// What a restore replaced. Saves prune it like any other.
pub const BEFORE_RESTORE_MARK: &str = "-before-restore";
/// A working copy the writer chose not to save. It has its own allowance.
pub const DISCARDED_MARK: &str = "-discarded";
/// The file as it was before this version of LoreCraft upgraded it, followed by that
/// version. Never pruned, and not counted against the budget.
pub const BEFORE_UPGRADE_MARK: &str = "-before-upgrade-";
/// How long changes the writer chose not to save stay among the backups.
pub const DISCARDED_KEEP_DAYS: u64 = 14;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupKind {
    /// The previous file, kept by a save.
    Save,
    BeforeRestore,
    Discarded,
    /// Holds the LoreCraft version that did the upgrade.
    BeforeUpgrade(String),
}

fn all_digits(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|b| b.is_ascii_digit())
}

/// The project's name from `<name>-<yyyymmdd>-<hhmmss>-<ms>`, if the time is there.
pub fn strip_backup_time(text: &str) -> Option<&str> {
    let mut parts = text.rsplitn(4, '-');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(ms), Some(time), Some(day), Some(name))
            if all_digits(ms, 3) && all_digits(time, 6) && all_digits(day, 8) && !name.is_empty() =>
        {
            Some(name)
        }
        _ => None,
    }
}

/// Splits a backup's file stem into the part before its mark, and its kind. A mark only
/// counts right after the time, so a project's own name cannot pass for one.
pub fn backup_kind(stem: &str) -> (&str, BackupKind) {
    let timed = |rest: &str| strip_backup_time(rest).is_some();
    if let Some((rest, version)) = stem.rsplit_once(BEFORE_UPGRADE_MARK) {
        if timed(rest) && !version.is_empty() {
            return (rest, BackupKind::BeforeUpgrade(version.to_string()));
        }
    }
    if let Some(rest) = stem.strip_suffix(DISCARDED_MARK).filter(|r| timed(r)) {
        return (rest, BackupKind::Discarded);
    }
    if let Some(rest) = stem.strip_suffix(BEFORE_RESTORE_MARK).filter(|r| timed(r)) {
        return (rest, BackupKind::BeforeRestore);
    }
    (stem, BackupKind::Save)
}

/// A project or file name made safe to start a backup's file name.
pub fn backup_base_name(origin: Option<&Path>, name: &str) -> String {
    let base: String = origin
        .map(display_name_for)
        .unwrap_or_else(|| name.to_string())
        .chars()
        .map(|c| if c.is_alphanumeric() || " _-()".contains(c) { c } else { '_' })
        .collect();
    if base.trim().is_empty() {
        "Untitled".to_string()
    } else {
        base
    }
}

/// The project's id, which names its backups folder.
pub fn project_id_of(conn: &Connection) -> String {
    conn.query_row("SELECT value FROM meta WHERE key = 'project_id'", [], |r| r.get(0))
        .unwrap_or_else(|_| UNKNOWN_PROJECT.to_string())
}

/// The folder for backups of projects with no usable id.
pub const UNKNOWN_PROJECT: &str = "unknown";

/// A project's backups folder. The id comes from the file, which can come from anyone, so
/// one that could lead out of the backups folder is not used.
pub fn backups_folder(paths: &Paths, project_id: &str) -> PathBuf {
    let safe = !project_id.is_empty()
        && project_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    paths
        .backups()
        .join(if safe { project_id } else { UNKNOWN_PROJECT })
}

/// A new backup's path in `folder`, named for now. Never one that exists already.
pub fn new_backup_path(folder: &Path, base: &str, mark: &str) -> PathBuf {
    loop {
        let path = folder.join(format!(
            "{base}-{}{mark}.{PROJECT_EXTENSION}",
            chrono::Local::now().format("%Y%m%d-%H%M%S-%3f")
        ));
        if !path.exists() {
            return path;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Clears a read-only mark. A copy of a read-only file is read-only too, which would stop
/// SQLite writing to a working copy and stop old backups from being pruned.
fn make_writable(path: &Path) -> std::io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    if !permissions.readonly() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(permissions.mode() | 0o200);
    }
    #[cfg(not(unix))]
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    fs::set_permissions(path, permissions)
}

/// What a save has to tell the user about.
#[derive(Debug, Default)]
pub struct SaveReport {
    /// The size of the previous file, if it was too large to back up within the budget.
    pub backup_skipped: Option<u64>,
}

/// Enough to notice that someone else changed a file after we opened it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStamp {
    pub len: u64,
    pub modified: Option<SystemTime>,
}

pub fn stamp(path: &Path) -> Option<FileStamp> {
    let meta = fs::metadata(path).ok()?;
    Some(FileStamp {
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    id: String,
    name: String,
    origin: Option<PathBuf>,
    dirty: bool,
    updated_at: String,
}

/// An interrupted session with unsaved work.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recoverable {
    pub session_id: String,
    pub name: String,
    pub origin: Option<PathBuf>,
    pub updated_at: String,
}

pub struct Session {
    pub id: String,
    pub dir: PathBuf,
    pub conn: Connection,
    pub origin: Option<PathBuf>,
    pub origin_stamp: Option<FileStamp>,
    pub dirty: bool,
    /// Summaries were made since the last save. These do not make the project dirty.
    pub quiet_changes: bool,
    pub name: String,
    /// Held for the session's lifetime. The OS releases it if the process dies,
    /// which is how the next launch recognises an orphan.
    _lock: File,
}

/// Writes a small file so that it is either the old version or the new one, never half of
/// each: a temporary file, flushed to disk, then renamed over the old one.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension(format!("tmp-{}", db::new_id()));
    let result = (|| -> AppResult<()> {
        let mut f = File::create(&tmp)?;
        std::io::Write::write_all(&mut f, bytes)?;
        f.sync_all()?;
        drop(f);
        Ok(replace_file(&tmp, path)?)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// How long the final replace keeps trying. OneDrive and antivirus can hold a file for
/// several seconds after it changes.
const REPLACE_WINDOW: Duration = Duration::from_secs(20);

#[cfg(test)]
thread_local! {
    /// Lets a test fail a replace quickly.
    static TEST_REPLACE_WINDOW: std::cell::Cell<Option<Duration>> = const { std::cell::Cell::new(None) };
}

/// Shortens the replace window on this thread, or with `None` puts it back.
#[cfg(test)]
pub fn set_test_replace_window(window: Option<Duration>) {
    TEST_REPLACE_WINDOW.with(|w| w.set(window));
}

fn replace_window() -> Duration {
    #[cfg(test)]
    if let Some(window) = TEST_REPLACE_WINDOW.with(|w| w.get()) {
        return window;
    }
    REPLACE_WINDOW
}

/// The waits between attempts to replace a file: short at first, then up to two seconds,
/// for as long as `window` allows.
fn replace_delays(window: Duration) -> Vec<Duration> {
    let mut delays = Vec::new();
    let mut total = Duration::ZERO;
    let mut next = Duration::from_millis(50);
    while total + next <= window {
        delays.push(next);
        total += next;
        next = (next * 2).min(Duration::from_secs(2));
    }
    delays
}

/// Errors that mean another program has the file open for a moment.
fn is_transient(error: &std::io::Error) -> bool {
    if cfg!(windows) {
        // Access denied, sharing violation, lock violation.
        matches!(error.raw_os_error(), Some(5 | 32 | 33))
    } else {
        matches!(error.raw_os_error(), Some(16)) // EBUSY
    }
}

fn is_read_only(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().readonly())
}

/// Renames `from` over `to`, retrying while another program holds `to` for a moment.
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    replace_file_within(from, to, replace_window())
}

fn replace_file_within(from: &Path, to: &Path, window: Duration) -> std::io::Result<()> {
    let started = Instant::now();
    let mut delays = replace_delays(window).into_iter();
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            // Waiting never helps a file marked read-only.
            Err(e) if !is_transient(&e) || is_read_only(to) => return Err(e),
            Err(e) => match delays.next() {
                Some(delay) if started.elapsed() + delay <= window => std::thread::sleep(delay),
                _ => return Err(e),
            },
        }
    }
}

/// Refuses, before any work, a save that can only fail: over a folder, or over a file
/// marked read-only, which Windows will not let anything replace.
fn check_replaceable(target: &Path) -> AppResult<()> {
    match fs::metadata(target) {
        Ok(meta) if meta.is_dir() => Err(AppError::new(
            "SAVE_FAILED",
            format!(
                "{} is a folder, so LoreCraft cannot save over it. Your work is safe in LoreCraft. Use Save As to choose another name.",
                target.display()
            ),
        )),
        Ok(meta) if meta.permissions().readonly() => Err(AppError::read_only(target)),
        _ => Ok(()),
    }
}

/// The temporary file a save writes beside its target. The name is short, so a target near
/// the longest path Windows allows can still be saved, and `is_own_temp_name` knows it.
fn temp_name() -> String {
    let id = db::new_id().replace('-', "");
    format!(".lc-{}.saving", &id[id.len() - 8..])
}

/// A save's temporary file. It is held open for the whole save, so another window's
/// `remove_stale_temp_files` can tell it is in use, and removed on drop unless kept.
struct TempFile {
    path: PathBuf,
    handle: Option<File>,
}

impl TempFile {
    fn create(folder: &Path) -> AppResult<TempFile> {
        let mut attempts = 0;
        loop {
            let path = folder.join(temp_name());
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(handle) => {
                    return Ok(TempFile {
                        path,
                        handle: Some(handle),
                    })
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempts < 10 => attempts += 1,
                Err(e) => return Err(e.into()),
            }
        }
    }

    /// Stops it being removed on drop, because it is now the target or a kept copy.
    fn keep(mut self) {
        self.handle = None;
        self.path = PathBuf::new();
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        self.handle = None;
        if !self.path.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Whether a file name is one LoreCraft gives its temporary files beside a project: today's
/// `.lc-<8 hex>.saving`, and the longer `.<file>.<uuid>.saving` and `<file>.tmp-<uuid>` of
/// earlier versions.
fn is_own_temp_name(name: &str) -> bool {
    let is_uuid = |text: &str| text.len() == 36 && uuid::Uuid::parse_str(text).is_ok();
    if let Some(id) = name.strip_prefix(".lc-").and_then(|r| r.strip_suffix(".saving")) {
        return id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit());
    }
    if let Some(rest) = name.strip_prefix('.').and_then(|r| r.strip_suffix(".saving")) {
        return rest.rsplit_once('.').is_some_and(|(file, id)| !file.is_empty() && is_uuid(id));
    }
    name.rsplit_once(".tmp-").is_some_and(|(file, id)| !file.is_empty() && is_uuid(id))
}

/// Whether a save may still be writing this file.
#[cfg(windows)]
fn in_use(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    // A running save holds its file open, so asking for it with no sharing fails.
    OpenOptions::new().read(true).share_mode(0).open(path).is_err()
}

#[cfg(not(windows))]
fn in_use(path: &Path) -> bool {
    // Without sharing modes to ask, anything changed in the last hour may be a save under way.
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|time| time.elapsed().map_or(true, |age| age < Duration::from_secs(3600)))
        .unwrap_or(true)
}

/// Removes what interrupted saves left in `folder`: temporary files as large as the project.
/// Only LoreCraft's own names, and only files no save is using. Returns how many went.
pub fn remove_stale_temp_files(folder: &Path) -> usize {
    let Ok(entries) = fs::read_dir(folder) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let own = name.to_str().is_some_and(is_own_temp_name);
        if !own || !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        if !in_use(&path) && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub fn display_name_for(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".to_string())
}

impl Session {
    fn prepare_dir(paths: &Paths) -> AppResult<(String, PathBuf, File)> {
        let id = db::new_id();
        let dir = paths.sessions().join(&id);
        fs::create_dir_all(&dir)?;
        let lock = take_lock(&dir)?
            .ok_or_else(|| AppError::internal("A new session folder was already locked."))?;
        Ok((id, dir, lock))
    }

    /// A new project with no file yet. The caller seeds its content.
    pub fn create_new(paths: &Paths, name: &str) -> AppResult<Session> {
        let (id, dir, lock) = Self::prepare_dir(paths)?;
        let mut conn = db::open_working(&dir.join(WORKING_DB))?;
        db::migrate(&mut conn)?;
        let session = Session {
            id,
            dir,
            conn,
            origin: None,
            origin_stamp: None,
            dirty: false,
            quiet_changes: false,
            name: name.to_string(),
            _lock: lock,
        };
        session.persist()?;
        Ok(session)
    }

    /// Opens a copy of `path`. The file itself is not touched, even by upgrades.
    pub fn open_file(paths: &Paths, path: &Path) -> AppResult<Session> {
        if !path.exists() {
            return Err(AppError::not_found(path.display().to_string()));
        }
        db::validate_project_file(path)?;
        if let Some(folder) = path.parent() {
            remove_stale_temp_files(folder);
        }
        let origin_stamp = stamp(path);
        let (id, dir, lock) = Self::prepare_dir(paths)?;
        let setup = (|| -> AppResult<Connection> {
            fs::copy(path, dir.join(WORKING_DB))?;
            // The copy keeps a read-only mark, and SQLite cannot write to it then.
            make_writable(&dir.join(WORKING_DB))?;
            let mut conn = db::open_working(&dir.join(WORKING_DB))?;
            let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
            if check != "ok" {
                // The check's own words mean nothing to a writer, so the message says what to do.
                crate::logs::warn("project_check_failed", &[], Some(&check));
                let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
                return Err(AppError::damaged(&name));
            }
            db::migrate(&mut conn)?;
            Ok(conn)
        })();
        let conn = match setup {
            Ok(conn) => conn,
            Err(e) => {
                drop(lock);
                let _ = fs::remove_dir_all(&dir);
                return Err(e);
            }
        };
        let mut session = Session {
            id,
            dir,
            conn,
            origin: Some(path.to_path_buf()),
            origin_stamp,
            dirty: false,
            quiet_changes: false,
            name: display_name_for(path),
            _lock: lock,
        };
        session.persist()?;
        session.restore_pending_summaries();
        Ok(session)
    }

    /// Takes over an orphaned session found by `list_recoverable`.
    pub fn recover(paths: &Paths, session_id: &str) -> AppResult<Session> {
        let dir = session_dir(paths, session_id)?;
        let lock = take_lock(&dir)?.ok_or_else(|| {
            AppError::new("SESSION_BUSY", "That session is open in another window.")
        })?;
        let file = read_session_file(&dir)
            .ok_or_else(|| AppError::not_found("The recovery information"))?;
        let mut conn = db::open_working(&dir.join(WORKING_DB))?;
        db::migrate(&mut conn)?;
        let origin_stamp = file.origin.as_deref().and_then(stamp);
        let session = Session {
            id: file.id,
            dir,
            conn,
            origin: file.origin,
            origin_stamp,
            dirty: true,
            quiet_changes: false,
            name: file.name,
            _lock: lock,
        };
        session.persist()?;
        Ok(session)
    }

    fn persist(&self) -> AppResult<()> {
        let file = SessionFile {
            id: self.id.clone(),
            name: self.name.clone(),
            origin: self.origin.clone(),
            dirty: self.dirty,
            updated_at: db::now(),
        };
        write_atomic(
            &self.dir.join(SESSION_JSON),
            &serde_json::to_vec_pretty(&file)?,
        )
    }

    /// Recorded before the edit commits, so a crash can never leave an edit that
    /// the next launch believes was saved.
    pub fn set_dirty(&mut self, dirty: bool) -> AppResult<()> {
        if self.dirty != dirty {
            self.dirty = dirty;
            self.persist()?;
        }
        Ok(())
    }

    pub fn origin_changed_on_disk(&self) -> bool {
        match (&self.origin, &self.origin_stamp) {
            // A deleted file is not a conflict, saving simply recreates it.
            (Some(path), Some(known)) => stamp(path).is_some_and(|now| &now != known),
            _ => false,
        }
    }

    /// Writes the project to `target`. Either the whole save succeeds or `target`
    /// keeps its previous contents. `on_backup` runs before the previous file is copied
    /// to the backups, which can take a while.
    pub fn save_to(
        &mut self,
        paths: &Paths,
        target: &Path,
        backups: BackupPolicy,
        on_backup: &dyn Fn(),
    ) -> AppResult<SaveReport> {
        let mut report = SaveReport::default();
        let parent = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| AppError::invalid("The save location has no folder."))?;
        fs::create_dir_all(parent)?;
        check_replaceable(target)?;

        // Removed again when this goes out of scope, unless the save keeps it.
        let tmp = TempFile::create(parent)?;
        self.write_verified_copy(&tmp.path)?;

        if target.exists() {
            let upgrading = self.upgrades(target);
            // A failed backup must not block the save that protects new work.
            match self.backup_existing(paths, target, backups, upgrading, on_backup) {
                Ok(skipped) => report.backup_skipped = skipped,
                Err(e) => crate::logs::error("save.backup_failed", &[("code", e.code.as_str())], Some(&e.message)),
            }
        }

        if let Err(error) = replace_file(&tmp.path, target) {
            return Err(keep_verified_copy(tmp, target, &error));
        }
        tmp.keep();

        self.origin = Some(target.to_path_buf());
        self.origin_stamp = stamp(target);
        self.name = display_name_for(target);
        self.dirty = false;
        self.quiet_changes = false;
        // They are in the file now.
        if let Some(pending) = self.pending_summaries_file() {
            let _ = fs::remove_file(pending);
        }
        self.persist()?;
        Ok(report)
    }

    fn pending_summaries_file(&self) -> Option<PathBuf> {
        // The working copy sits at <data>/sessions/<id>.
        let root = self.dir.parent()?.parent()?;
        let project_id: String = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'project_id'", [], |r| r.get(0))
            .ok()?;
        // It becomes a file name, and a project file can come from anywhere.
        let safe = !project_id.is_empty()
            && project_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        safe.then(|| root.join(PENDING_SUMMARIES).join(format!("{project_id}.json")))
    }

    /// Summaries are made in the background without marking the project as changed, so that
    /// someone who has saved is not told they have unsaved work. The project file changes
    /// only when the writer saves, so on closing they wait beside it in the data folder, and
    /// reach the file with the next save. If this fails they are simply made again, so it
    /// never stops the close. Only machine-made ones wait: a summary the writer edited is an
    /// ordinary edit, saved or discarded with the rest.
    fn stash_pending_summaries(&self) {
        if !self.quiet_changes || self.origin.is_none() {
            return;
        }
        let Some(file) = self.pending_summaries_file() else { return };
        let stashed = (|| -> AppResult<()> {
            let mut stmt = self.conn.prepare(
                "SELECT entity_kind, entity_id, content_hash, summary, model, updated_at
                 FROM summaries WHERE edited = 0",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(json!({
                    "kind": r.get::<_, String>(0)?,
                    "id": r.get::<_, String>(1)?,
                    "hash": r.get::<_, String>(2)?,
                    "summary": r.get::<_, String>(3)?,
                    "model": r.get::<_, String>(4)?,
                    "updatedAt": r.get::<_, String>(5)?,
                }))
            })?;
            let rows: Vec<Value> = rows.collect::<Result<_, _>>()?;
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent)?;
            }
            write_atomic(&file, &serde_json::to_vec(&rows)?)
        })();
        if let Err(e) = stashed {
            crate::logs::warn("summaries_not_kept", &[], Some(&e.to_string()));
        }
    }

    /// Brings back summaries stashed when this project last closed. Each is tied to the hash
    /// of the text it describes, so one that no longer applies is simply made again.
    fn restore_pending_summaries(&mut self) {
        let Some(file) = self.pending_summaries_file() else { return };
        let Ok(bytes) = fs::read(&file) else { return };
        let Ok(rows) = serde_json::from_slice::<Vec<Value>>(&bytes) else { return };
        let restored = (|| -> AppResult<usize> {
            let tx = self.conn.transaction()?;
            let mut count = 0;
            for row in &rows {
                let field = |name: &str| row[name].as_str().unwrap_or_default().to_string();
                count += tx.execute(
                    "INSERT INTO summaries
                       (entity_kind, entity_id, content_hash, summary, edited, model, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
                     ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
                       content_hash = excluded.content_hash, summary = excluded.summary,
                       model = excluded.model, updated_at = excluded.updated_at
                     WHERE summaries.edited = 0 AND excluded.updated_at > summaries.updated_at",
                    rusqlite::params![
                        field("kind"),
                        field("id"),
                        field("hash"),
                        field("summary"),
                        field("model"),
                        field("updatedAt")
                    ],
                )?;
            }
            tx.commit()?;
            Ok(count)
        })();
        match restored {
            Ok(count) => self.quiet_changes = count > 0,
            Err(e) => crate::logs::warn("summaries_not_restored", &[], Some(&e.to_string())),
        }
    }

    /// Writes a checked, self-contained copy of the database to `tmp`.
    pub fn write_verified_copy(&self, tmp: &Path) -> AppResult<()> {
        write_verified_copy_of(&self.conn, tmp)
    }

    /// Writes a copy of the project to `path` without changing the session, the same safe
    /// way a save does.
    pub fn write_copy_to(&self, path: &Path) -> AppResult<()> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| AppError::invalid("The location has no folder."))?;
        check_replaceable(path)?;
        let tmp = TempFile::create(parent)?;
        self.write_verified_copy(&tmp.path)?;
        if let Err(error) = replace_file(&tmp.path, path) {
            return Err(keep_verified_copy(tmp, path, &error));
        }
        tmp.keep();
        Ok(())
    }

    /// Whether saving over `target` upgrades it: its schema is older than the working copy's.
    /// The file is only read.
    fn upgrades(&self, target: &Path) -> bool {
        let version = |conn: &Connection| conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).ok();
        let file = Connection::open_with_flags(
            target,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        );
        match (file.ok().as_ref().and_then(version), version(&self.conn)) {
            (Some(theirs), Some(ours)) => theirs < ours,
            _ => false,
        }
    }

    /// Copies the previous file to the backups. Returns its size if it is too large to
    /// keep within the budget, in which case the older backups stay as they are. A file
    /// this save upgrades is always kept, marked with this version, and never pruned,
    /// because older versions of LoreCraft cannot open what replaces it.
    fn backup_existing(
        &self,
        paths: &Paths,
        target: &Path,
        policy: BackupPolicy,
        upgrading: bool,
        on_backup: &dyn Fn(),
    ) -> AppResult<Option<u64>> {
        if !upgrading {
            if policy.keep == 0 {
                return Ok(None);
            }
            let size = fs::metadata(target)?.len();
            if size > policy.budget_bytes {
                return Ok(Some(size));
            }
        }
        let dir = backups_folder(paths, &project_id_of(&self.conn));
        fs::create_dir_all(&dir)?;
        let mark = if upgrading {
            format!("{BEFORE_UPGRADE_MARK}{}", env!("CARGO_PKG_VERSION"))
        } else {
            String::new()
        };
        let backup = new_backup_path(&dir, &display_name_for(target), &mark);
        on_backup();
        fs::copy(target, &backup)?;
        make_writable(&backup)?;
        if policy.keep > 0 {
            prune_backups(&dir, policy)?;
        }
        Ok(None)
    }

    /// Ends the session. Unsaved work is never deleted: it moves into the backups as changes
    /// the writer chose not to save. A session with nothing unsaved is simply removed.
    pub fn close_and_remove(self) -> AppResult<()> {
        self.close_keeping_unsaved(BackupPolicy::default())
    }

    /// `close_and_remove`, with the budget from the writer's settings.
    pub fn close_keeping_unsaved(self, policy: BackupPolicy) -> AppResult<()> {
        if !self.dirty {
            return self.close_without_keeping();
        }
        self.stash_pending_summaries();
        let root = self.dir.parent().and_then(Path::parent).map(Paths::at);
        let project_id = project_id_of(&self.conn);
        let base = backup_base_name(self.origin.as_deref(), &self.name);
        let Session {
            dir, conn, _lock, ..
        } = self;
        let Some(paths) = root else {
            return Err(AppError::internal("The working copy is not in a data folder."));
        };
        match keep_as_discarded(conn, &dir, &backups_folder(&paths, &project_id), &base) {
            Ok(_) => {
                drop(_lock);
                remove_dir_with_retry(&dir);
                prune_discarded_everywhere(&paths, policy);
            }
            // The folder stays as it is, and the next launch offers it for recovery.
            Err(e) => crate::logs::error("close.keep_failed", &[("code", e.code.as_str())], Some(&e.message)),
        }
        Ok(())
    }

    /// Ends the session and deletes its working copy, unsaved or not. Only for a session
    /// whose state is kept elsewhere: saved, kept as a backup, or itself a copy of one.
    pub fn close_without_keeping(self) -> AppResult<()> {
        self.stash_pending_summaries();
        let Session {
            dir, conn, _lock, ..
        } = self;
        conn.close().map_err(|(_, e)| AppError::from(e))?;
        drop(_lock);
        remove_dir_with_retry(&dir);
        Ok(())
    }
}

/// Writes a checked, self-contained copy of a database to `tmp`.
fn write_verified_copy_of(conn: &Connection, tmp: &Path) -> AppResult<()> {
    let tmp = &db::sqlite_path(tmp); // So SQLite can write beside a file deep in folders.
    let tmp_str = tmp
        .to_str()
        .ok_or_else(|| AppError::invalid("The save path is not valid text."))?;
    conn.execute("VACUUM INTO ?1", [tmp_str])?;
    {
        // A single file with no WAL sidecar, so it can be copied around freely.
        let check = Connection::open(tmp)?;
        check.pragma_update_and_check(None, "journal_mode", "DELETE", |_| Ok(()))?;
        let result: String = check.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if result != "ok" {
            return Err(AppError::new(
                "SAVE_FAILED",
                format!("The saved copy failed its check: {result}"),
            ));
        }
    }
    OpenOptions::new().write(true).open(tmp)?.sync_all()?;
    Ok(())
}

/// The final replace failed, though the new version is written and checked. Rather than
/// throw it away, it stays beside the target under a name the writer can open, and the
/// error says where.
fn keep_verified_copy(tmp: TempFile, target: &Path, error: &std::io::Error) -> AppError {
    if is_read_only(target) {
        return AppError::read_only(target);
    }
    let visible = target.with_file_name(format!(
        "{} (copy {}).{PROJECT_EXTENSION}",
        display_name_for(target),
        chrono::Local::now().format("%Y-%m-%d %H.%M.%S")
    ));
    let mut kept = tmp.path.clone();
    if !visible.exists() && fs::rename(&tmp.path, &visible).is_ok() {
        kept = visible;
    }
    tmp.keep();
    AppError::save_kept_copy(target, &kept, error)
}

/// Folds the write-ahead log into the database file and turns it off, so that one file holds
/// every committed edit and can be moved. False if another connection stopped it.
fn settle_wal(conn: &Connection) -> bool {
    for attempt in 0..5u64 {
        let mode: Option<String> = conn
            .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
            .ok();
        if mode.is_some_and(|m| m.eq_ignore_ascii_case("delete")) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50 * (attempt + 1)));
    }
    false
}

/// Moves a working copy, whose folder is `dir`, into `folder` as changes the writer chose
/// not to save. Takes the connection to close it first. Returns where it went.
fn keep_as_discarded(conn: Connection, dir: &Path, folder: &Path, base: &str) -> AppResult<PathBuf> {
    fs::create_dir_all(folder)?;
    let kept = new_backup_path(folder, base, DISCARDED_MARK);
    let working = dir.join(WORKING_DB);
    if settle_wal(&conn) {
        conn.close().map_err(|(_, e)| AppError::from(e))?;
        make_writable(&working)?;
        if replace_file_within(&working, &kept, Duration::from_secs(2)).is_err() {
            let copied = fs::copy(&working, &kept)
                .and_then(|_| OpenOptions::new().write(true).open(&kept)?.sync_all());
            if let Err(e) = copied {
                let _ = fs::remove_file(&kept);
                return Err(e.into());
            }
        }
    } else {
        // Something still reads the log, so copy through SQLite, which sees all of it.
        let tmp = dir.join("discarded.tmp");
        let copied = write_verified_copy_of(&conn, &tmp).and_then(|()| Ok(fs::rename(&tmp, &kept)?));
        let _ = conn.close();
        if let Err(e) = copied {
            let _ = fs::remove_file(&tmp);
            // A file SQLite cannot copy, perhaps damaged, is still the writer's, so it is kept
            // as it is. Not while edits wait in the log, which moving it would leave behind.
            let wal = dir.join(format!("{WORKING_DB}-wal"));
            let log_waiting = fs::metadata(&wal).is_ok_and(|m| m.len() > 0);
            if log_waiting || replace_file_within(&working, &kept, Duration::from_secs(2)).is_err() {
                return Err(e);
            }
        }
    }
    // Its fourteen days start now, not at the last edit.
    if let Ok(file) = OpenOptions::new().write(true).open(&kept) {
        let _ = file.set_modified(SystemTime::now());
    }
    Ok(kept)
}

/// A backup file in a project's folder, with what pruning needs to know.
struct BackupEntry {
    modified: SystemTime,
    path: PathBuf,
    len: u64,
}

/// The project files in a backups folder, sorted into ordinary backups and discarded
/// working copies. Backups from before an upgrade are left out, because they always stay.
fn backup_entries(dir: &Path) -> AppResult<(Vec<BackupEntry>, Vec<BackupEntry>)> {
    let mut saves = Vec::new();
    let mut discarded = Vec::new();
    for entry in fs::read_dir(dir)?.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() || !path.extension().is_some_and(is_project_extension) {
            continue;
        }
        let Ok(modified) = meta.modified() else { continue };
        let found = BackupEntry {
            modified,
            path,
            len: meta.len(),
        };
        match backup_kind(&display_name_for(&found.path)).1 {
            BackupKind::BeforeUpgrade(_) => {}
            BackupKind::Discarded => discarded.push(found),
            BackupKind::Save | BackupKind::BeforeRestore => saves.push(found),
        }
    }
    // Newest first. The name holds the time of the backup, which settles equal timestamps.
    for list in [&mut saves, &mut discarded] {
        list.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.path.cmp(&a.path)));
    }
    Ok((saves, discarded))
}

/// Removes the oldest backups until the rest fit the policy. The newest always stays.
/// Discarded working copies have their own allowance, and backups from before an upgrade
/// are never removed.
fn prune_backups(dir: &Path, policy: BackupPolicy) -> AppResult<()> {
    let (saves, discarded) = backup_entries(dir)?;
    let mut total = 0u64;
    let mut over = false;
    for (index, entry) in saves.into_iter().enumerate() {
        total = total.saturating_add(entry.len);
        over = over || index >= policy.keep || (index > 0 && total > policy.budget_bytes);
        if over {
            let _ = fs::remove_file(entry.path);
        }
    }
    prune_discarded(discarded, policy.budget_bytes);
    Ok(())
}

/// Discarded working copies stay for `DISCARDED_KEEP_DAYS`, within a budget of their own.
fn prune_discarded(discarded: Vec<BackupEntry>, budget_bytes: u64) {
    let max_age = Duration::from_secs(DISCARDED_KEEP_DAYS * 24 * 60 * 60);
    let mut total = 0u64;
    for (index, entry) in discarded.into_iter().enumerate() {
        total = total.saturating_add(entry.len);
        let expired = entry.modified.elapsed().is_ok_and(|age| age > max_age);
        if expired || (index > 0 && total > budget_bytes) {
            let _ = fs::remove_file(entry.path);
        }
    }
}

/// Lets discarded working copies expire in every project's folder, including projects that
/// were never saved and so are never pruned by a save.
pub fn prune_discarded_everywhere(paths: &Paths, policy: BackupPolicy) {
    let Ok(folders) = fs::read_dir(paths.backups()) else { return };
    for folder in folders.filter_map(Result::ok) {
        if let Ok((_, discarded)) = backup_entries(&folder.path()) {
            prune_discarded(discarded, policy.budget_bytes);
        }
    }
}

fn remove_dir_with_retry(dir: &Path) {
    for attempt in 0..10u64 {
        if fs::remove_dir_all(dir).is_ok() || !dir.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50 * (attempt + 1)));
    }
}

/// Session ids become folder names, so reject anything that could leave the
/// sessions folder.
fn session_dir(paths: &Paths, session_id: &str) -> AppResult<PathBuf> {
    let safe = !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !safe {
        return Err(AppError::invalid("Invalid session id."));
    }
    let dir = paths.sessions().join(session_id);
    if !dir.is_dir() {
        return Err(AppError::not_found("That session"));
    }
    Ok(dir)
}

fn take_lock(dir: &Path) -> AppResult<Option<File>> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(SESSION_LOCK))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => Err(e.into()),
    }
}

fn read_session_file(dir: &Path) -> Option<SessionFile> {
    serde_json::from_slice(&fs::read(dir.join(SESSION_JSON)).ok()?).ok()
}

/// Finds interrupted sessions. Orphans with no unsaved work are removed. A folder
/// we cannot interpret is left alone rather than deleted, in case it holds work.
pub fn list_recoverable(paths: &Paths) -> AppResult<Vec<Recoverable>> {
    let root = paths.sessions();
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    for entry in fs::read_dir(root)?.filter_map(Result::ok) {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(Some(lock)) = take_lock(&dir) else {
            continue; // Live in another process.
        };
        let file = read_session_file(&dir);
        match file {
            Some(file) if file.dirty => {
                found.push(Recoverable {
                    session_id: file.id,
                    name: file.name,
                    origin: file.origin,
                    updated_at: file.updated_at,
                });
                drop(lock);
            }
            Some(_) => {
                drop(lock);
                remove_dir_with_retry(&dir);
            }
            None => {
                // Interrupted while the folder was being created, or unreadable.
                let has_data = dir.join(WORKING_DB).exists();
                drop(lock);
                if !has_data {
                    remove_dir_with_retry(&dir);
                }
            }
        }
    }
    found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(found)
}

/// The writer turned down recovering this work. It moves into the backups as changes they
/// chose not to save, so a wrong click can be undone. If that fails, nothing is removed.
pub fn discard_recoverable(paths: &Paths, session_id: &str, policy: BackupPolicy) -> AppResult<()> {
    let dir = session_dir(paths, session_id)?;
    let lock = take_lock(&dir)?;
    if lock.is_none() {
        return Err(AppError::new(
            "SESSION_BUSY",
            "That session is open in another window.",
        ));
    }
    let working = dir.join(WORKING_DB);
    if working.is_file() {
        let file = read_session_file(&dir);
        let name = file.as_ref().map_or_else(|| "Untitled".to_string(), |f| f.name.clone());
        let base = backup_base_name(file.as_ref().and_then(|f| f.origin.as_deref()), &name);
        // Opening replays any log the crash left, so the moved file holds every edit.
        let conn = Connection::open(&working)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        let folder = backups_folder(paths, &project_id_of(&conn));
        keep_as_discarded(conn, &dir, &folder, &base)?;
    }
    drop(lock);
    remove_dir_with_retry(&dir);
    prune_discarded_everywhere(paths, policy);
    Ok(())
}

/// Ensures a chosen path ends in `.lorecraft`.
pub fn with_project_extension(path: PathBuf) -> PathBuf {
    let has_ext = path
        .extension()
        .is_some_and(is_project_extension);
    if has_ext {
        path
    } else {
        let mut os = path.into_os_string();
        os.push(".");
        os.push(PROJECT_EXTENSION);
        PathBuf::from(os)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_replace_keeps_trying_for_about_twenty_seconds_and_starts_quickly() {
        let delays = replace_delays(REPLACE_WINDOW);
        let total: Duration = delays.iter().sum();
        assert!(total >= Duration::from_secs(18) && total <= REPLACE_WINDOW, "{total:?}");
        assert_eq!(delays[0], Duration::from_millis(50));
        assert!(delays.windows(2).all(|w| w[1] >= w[0]), "it backs off");
        assert!(delays.iter().all(|d| *d <= Duration::from_secs(2)));
    }

    #[test]
    fn the_temporary_name_is_short_and_known_again() {
        let name = temp_name();
        assert!(name.len() <= 20, "{name}");
        assert!(is_own_temp_name(&name), "{name}");
        assert_ne!(temp_name(), temp_name());
        assert!(!is_own_temp_name("world.lorecraft"));
        assert!(!is_own_temp_name(".lc-12345678.saving.bak"));
    }

    #[test]
    fn a_folder_or_a_read_only_file_is_refused_before_any_work() {
        let dir = crate::engine::TestDir::new();
        let folder = dir.0.join("folder.lorecraft");
        fs::create_dir(&folder).unwrap();
        assert_eq!(check_replaceable(&folder).unwrap_err().code, "SAVE_FAILED");
        let file = dir.0.join("file.lorecraft");
        fs::write(&file, b"x").unwrap();
        assert!(check_replaceable(&file).is_ok());
        assert!(check_replaceable(&dir.0.join("missing.lorecraft")).is_ok());
        let mut permissions = fs::metadata(&file).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&file, permissions).unwrap();
        assert_eq!(check_replaceable(&file).unwrap_err().code, "READ_ONLY");
        make_writable(&file).unwrap();
        assert!(check_replaceable(&file).is_ok());
    }

    #[test]
    fn backup_base_names_are_safe_file_names() {
        assert_eq!(backup_base_name(None, "My/World: Two?"), "My_World_ Two_");
        assert_eq!(backup_base_name(Some(Path::new("C:/x/Saga.lorecraft")), "ignored"), "Saga");
        assert_eq!(backup_base_name(None, "   "), "Untitled");
        let paths = Paths::at(Path::new("data"));
        assert_eq!(backups_folder(&paths, "..\\..\\Desktop"), paths.backups().join(UNKNOWN_PROJECT));
        assert_eq!(backups_folder(&paths, "abc-123"), paths.backups().join("abc-123"));
    }
}
