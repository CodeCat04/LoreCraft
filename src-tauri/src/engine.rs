//! Shared application state. The Tauri layer and the tests both drive this same
//! engine through `rpc::dispatch`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::Duration;

use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::paths::Paths;
use crate::session::Session;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PickOptions {
    pub title: Option<String>,
    pub default_name: Option<String>,
    pub filters: Vec<PickFilter>,
    pub multiple: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PickFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// What the engine needs from the windowing layer.
pub trait Host: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
    fn set_title(&self, title: &str);
    fn pick_save(&self, options: PickOptions) -> Option<PathBuf>;
    fn pick_open(&self, options: PickOptions) -> Vec<PathBuf>;
    fn pick_folder(&self, options: PickOptions) -> Option<PathBuf>;
    fn show_window(&self);
    fn set_theme(&self, dark: bool);
    fn open_url(&self, url: &str) -> AppResult<()>;
    /// Shows a folder in the system's file manager.
    fn open_folder(&self, _path: &Path) -> AppResult<()> {
        Ok(())
    }
    fn quit(&self);

    /// Whether this platform can make PDFs. It is asked up front, so the export screen can
    /// say so before anyone chooses where to save.
    fn supports_pdf(&self) -> bool {
        false
    }
    /// Opens the hidden window that lays out PDFs. See `rpc::print`.
    fn print_window_open(&self) -> AppResult<()> {
        Err(pdf_not_supported())
    }
    fn print_window_close(&self) {}
    /// Sends a DevTools protocol command to the print window and waits for the answer.
    fn print_devtools(&self, _method: &str, _params: &Value) -> AppResult<Value> {
        Err(pdf_not_supported())
    }
    /// Prints the print window's page to PDF with the platform's own print system, on
    /// engines without DevTools commands (WebKitGTK on Linux).
    fn print_native(&self, _sheet: &crate::rpc::print::Sheet) -> AppResult<Vec<u8>> {
        Err(pdf_not_supported())
    }
}

pub fn pdf_not_supported() -> AppError {
    AppError::new(
        "NOT_SUPPORTED",
        "PDF export works on Windows and Linux. Word and EPUB exports work here.",
    )
}

/// Stands in for the window in tests. Dialogs return whatever a test queued.
#[derive(Default)]
pub struct TestHost {
    pub events: Mutex<Vec<(String, Value)>>,
    pub next_picks: Mutex<Vec<PathBuf>>,
}

impl Host for TestHost {
    fn emit(&self, event: &str, payload: Value) {
        self.events
            .lock()
            .unwrap()
            .push((event.to_string(), payload));
    }
    fn set_title(&self, _title: &str) {}
    fn pick_save(&self, _options: PickOptions) -> Option<PathBuf> {
        self.next_picks.lock().unwrap().pop()
    }
    fn pick_open(&self, _options: PickOptions) -> Vec<PathBuf> {
        self.next_picks.lock().unwrap().pop().into_iter().collect()
    }
    fn pick_folder(&self, _options: PickOptions) -> Option<PathBuf> {
        self.next_picks.lock().unwrap().pop()
    }
    fn show_window(&self) {}
    fn set_theme(&self, _dark: bool) {}
    fn open_url(&self, _url: &str) -> AppResult<()> {
        Ok(())
    }
    fn quit(&self) {}
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub open: bool,
    pub name: String,
    pub path: Option<PathBuf>,
    pub dirty: bool,
}

pub struct Engine {
    pub paths: Paths,
    pub host: Arc<dyn Host>,
    session: Mutex<Option<Session>>,
    settings: Mutex<Value>,
    allowed_paths: Mutex<HashSet<PathBuf>>,
    /// Answers for the next file dialogs, set only by the E2E harness.
    pub e2e_picks: Mutex<Vec<PathBuf>>,
    pub startup_file: Mutex<Option<PathBuf>>,
    /// Set when the UI answers a close request, so the failsafe stands down.
    pub close_acknowledged: AtomicBool,
    /// The server for AI tools outside the app. See `crate::mcp`.
    pub mcp: crate::mcp::McpState,
    /// The working copy, while a save holds the session lock. See `working_db_path`.
    saving_db: Mutex<Option<PathBuf>>,
}

/// Tells the UI a save is running, for as long as this value lives. A large project can
/// take a while, and every other call waits behind the session lock until it ends.
pub struct SaveActivity<'a> {
    engine: &'a Engine,
}

impl SaveActivity<'_> {
    pub fn phase(&self, phase: &str) {
        self.engine
            .host
            .emit("project://saving", json!({ "active": true, "phase": phase }));
    }
}

impl Drop for SaveActivity<'_> {
    fn drop(&mut self) {
        *relock(&self.engine.saving_db) = None;
        self.engine
            .host
            .emit("project://saving", json!({ "active": false }));
    }
}

fn relock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic mid-transaction rolls that transaction back when it unwinds, so the
    // data behind a poisoned lock is still consistent.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Engine {
    pub fn new(paths: Paths, host: Arc<dyn Host>) -> AppResult<Self> {
        std::fs::create_dir_all(&paths.root)?;
        let settings = crate::rpc::settings::load(&paths);
        Ok(Self {
            mcp: crate::mcp::McpState::new(&paths),
            paths,
            host,
            session: Mutex::new(None),
            settings: Mutex::new(settings),
            allowed_paths: Mutex::new(HashSet::new()),
            e2e_picks: Mutex::new(Vec::new()),
            startup_file: Mutex::new(None),
            close_acknowledged: AtomicBool::new(false),
            saving_db: Mutex::new(None),
        })
    }

    /// An engine in its own folder. The returned guard deletes it on drop.
    pub fn for_test() -> (Arc<Self>, Arc<TestHost>, TestDir) {
        let dir = TestDir::new();
        let host = Arc::new(TestHost::default());
        let engine = Self::new(Paths::at(&dir.0), host.clone()).expect("test engine");
        (Arc::new(engine), host, dir)
    }

    // ---- Sessions -----------------------------------------------------------

    pub fn session(&self) -> MutexGuard<'_, Option<Session>> {
        relock(&self.session)
    }

    /// Runs a read against the working copy.
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self.session();
        let session = guard.as_ref().ok_or_else(AppError::no_project)?;
        f(&session.conn)
    }

    /// Runs one transaction against the working copy and marks the project dirty.
    /// A failed write rolls back and leaves the dirty state as it was.
    pub fn write<T>(&self, f: impl FnOnce(&Transaction) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self.session();
        let session = guard.as_mut().ok_or_else(AppError::no_project)?;
        let was_dirty = session.dirty;
        session.set_dirty(true)?;

        let outcome = (|| {
            let tx = session
                .conn
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let value = f(&tx)?;
            tx.commit()?;
            Ok::<T, AppError>(value)
        })();

        match outcome {
            Ok(value) => {
                if !was_dirty {
                    self.publish_status(&guard);
                }
                Ok(value)
            }
            Err(e) => {
                if !was_dirty {
                    let _ = session.set_dirty(false);
                }
                Err(e)
            }
        }
    }

    /// Marks a long save as running. Call it with the session lock held.
    pub fn begin_save(&self, session: &Session) -> SaveActivity<'_> {
        *relock(&self.saving_db) = session.conn.path().map(PathBuf::from);
        let activity = SaveActivity { engine: self };
        activity.phase("saving");
        activity
    }

    /// The working copy, for read-only connections that stream media beside the session
    /// connection (WAL allows it). A save can hold the session lock for a long time, but
    /// the open session cannot change meanwhile, so this does not wait for it.
    pub fn working_db_path(&self) -> AppResult<PathBuf> {
        loop {
            if let Some(path) = relock(&self.saving_db).clone() {
                return Ok(path);
            }
            let guard = match self.session.try_lock() {
                Ok(guard) => guard,
                Err(TryLockError::Poisoned(e)) => e.into_inner(),
                Err(TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
            };
            return guard
                .as_ref()
                .and_then(|s| s.conn.path().map(PathBuf::from))
                .ok_or_else(AppError::no_project);
        }
    }

    /// Tells the UI that data of this kind changed.
    pub fn notify(&self, entity: &str) {
        self.host.emit("data://changed", json!({ "entity": entity }));
    }

    pub fn status(&self) -> ProjectStatus {
        Self::status_of(&self.session())
    }

    fn status_of(session: &Option<Session>) -> ProjectStatus {
        match session {
            Some(s) => ProjectStatus {
                open: true,
                name: s.name.clone(),
                path: s.origin.clone(),
                dirty: s.dirty,
            },
            None => ProjectStatus {
                open: false,
                name: String::new(),
                path: None,
                dirty: false,
            },
        }
    }

    /// Sends the current status to the UI and updates the window title.
    pub fn publish_status(&self, session: &Option<Session>) {
        let status = Self::status_of(session);
        let title = if status.open {
            format!(
                "{}{} - LoreCraft",
                if status.dirty { "\u{25CF} " } else { "" },
                status.name
            )
        } else {
            "LoreCraft".to_string()
        };
        self.host.set_title(&title);
        self.host.emit(
            "project://status",
            serde_json::to_value(&status).unwrap_or(Value::Null),
        );
    }

    // ---- Settings -----------------------------------------------------------

    pub fn settings(&self) -> MutexGuard<'_, Value> {
        relock(&self.settings)
    }

    // ---- Paths the user has chosen -------------------------------------------

    /// What the E2E harness wants the next file dialog to answer, if anything.
    pub fn take_e2e_pick(&self) -> Option<PathBuf> {
        let mut picks = relock(&self.e2e_picks);
        (!picks.is_empty()).then(|| picks.remove(0))
    }

    pub fn allow_path(&self, path: &Path) {
        relock(&self.allowed_paths).insert(path.to_path_buf());
    }

    /// Files are reachable only if the user picked them, or a folder holding them.
    pub fn check_allowed(&self, path: &Path) -> AppResult<()> {
        if path.components().any(|c| c.as_os_str() == "..") {
            return Err(AppError::new(
                "PATH_NOT_ALLOWED",
                "Relative path segments are not allowed.",
            ));
        }
        let allowed = relock(&self.allowed_paths);
        if allowed.iter().any(|a| path == a || path.starts_with(a)) {
            Ok(())
        } else {
            Err(AppError::new(
                "PATH_NOT_ALLOWED",
                format!("{} was not chosen in a dialog.", path.display()),
            ))
        }
    }
}

/// A folder removed when dropped, for tests.
pub struct TestDir(pub PathBuf);

impl TestDir {
    pub fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("lorecraft-test-{}", crate::db::new_id()));
        std::fs::create_dir_all(&dir).expect("test folder");
        Self(dir)
    }
}

impl Default for TestDir {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
