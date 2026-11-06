use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use crate::error::{AppError, AppResult};

/// "LORE" in ASCII, stored in the SQLite header so we can recognise our files.
pub const APPLICATION_ID: i64 = 0x4C4F_5245;

const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_init.sql"),
    include_str!("../migrations/002_index_keys.sql"),
    include_str!("../migrations/003_canvases.sql"),
];

/// The oldest LoreCraft that can read what this version writes. Every project stores it in
/// `meta` as `min_reader_version`, and an older version refuses the file. Raise it in a release
/// that stores anything an older version would misread: see "Upgrades" in docs/ARCHITECTURE.md.
/// It can never be newer than this version.
pub const MIN_READER_VERSION: &str = "0.1.0";

/// This version. Every project stores the last one that wrote it as `written_by_version`.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub const META_MIN_READER: &str = "min_reader_version";
pub const META_WRITTEN_BY: &str = "written_by_version";

pub fn schema_version() -> i64 {
    MIGRATIONS.len() as i64
}

/// Opens a working copy. `synchronous=FULL` means a committed edit survives a
/// power cut as well as a crash, which is the promise the app makes.
pub fn open_working(path: &Path) -> AppResult<Connection> {
    let conn = open_sqlite(path, OpenFlags::default())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA foreign_keys = ON;",
    )?;
    Ok(conn)
}

/// Opens a database with SQLite's long-path support, so a file deep in folders opens like any
/// other.
pub fn open_sqlite(path: &Path, flags: OpenFlags) -> rusqlite::Result<Connection> {
    let path = sqlite_path(path);
    if cfg!(windows) {
        Connection::open_with_flags_and_vfs(&path, flags, "win32-longpath")
    } else {
        Connection::open_with_flags(&path, flags)
    }
}

/// The name to give SQLite for `path`. Rust reaches long paths on Windows by itself, but SQLite
/// hands names straight to Windows, which stops at 260 characters unless a name has the `\\?\`
/// form. A shorter name is returned as it was.
pub fn sqlite_path(path: &Path) -> PathBuf {
    // Leaves room for the "-journal" SQLite adds to the name.
    const LONGEST_PLAIN: usize = 240;
    if cfg!(windows) && path.as_os_str().len() > LONGEST_PLAIN {
        if let Ok(full) = std::path::absolute(path) {
            return verbatim(&full);
        }
    }
    path.to_path_buf()
}

/// `C:\a\b` becomes `\\?\C:\a\b` and `\\server\share\b` becomes `\\?\UNC\server\share\b`.
/// `full` must be absolute and normalized, because Windows takes the `\\?\` form literally.
fn verbatim(full: &Path) -> PathBuf {
    let Some(text) = full.to_str() else {
        return full.to_path_buf();
    };
    if text.starts_with(r"\\?\") || text.starts_with(r"\\.\") {
        full.to_path_buf()
    } else if let Some(rest) = text.strip_prefix(r"\\") {
        PathBuf::from(format!(r"\\?\UNC\{rest}"))
    } else {
        PathBuf::from(format!(r"\\?\{text}"))
    }
}

/// Applies any migrations this database has not seen, then records which versions can read it.
/// Refuses files from a newer app version, because writing to them could destroy data we do not
/// understand.
pub fn migrate(conn: &mut Connection) -> AppResult<()> {
    migrate_with(conn, MIGRATIONS)
}

fn migrate_with(conn: &mut Connection, migrations: &[&str]) -> AppResult<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    check_readable(conn, current, migrations.len() as i64)?;
    if current < migrations.len() as i64 {
        upgrade(conn, current.max(0) as usize, migrations)?;
    }
    let tx = conn.transaction()?;
    keep_only_own_triggers(&tx)?;
    record_versions(&tx)?;
    tx.commit()?;
    conn.pragma_update(None, "application_id", APPLICATION_ID)?;
    Ok(())
}

/// Runs the pending migrations in one transaction, with foreign keys off as SQLite asks for
/// schema changes. With them on, dropping `books` or `nodes` to rebuild it would delete every
/// scene that hangs from it. The pragma does nothing inside a transaction, so it is set around
/// one. Before committing, no row may point at a row that is gone, beyond what was already
/// there, and the database must pass an integrity check. Anything else rolls it all back.
fn upgrade(conn: &mut Connection, from: usize, migrations: &[&str]) -> AppResult<()> {
    conn.execute_batch("PRAGMA foreign_keys = OFF")?;
    let still_on: bool = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    let outcome = if still_on {
        Err(upgrade_failed("foreign keys could not be turned off", None))
    } else {
        run_migrations(conn, from, migrations)
    };
    // A migration must not leave the connection looser than it found it, failed or not.
    let restored = conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA ignore_check_constraints = OFF;
         PRAGMA writable_schema = OFF;",
    );
    outcome?;
    restored?;
    Ok(())
}

fn run_migrations(conn: &mut Connection, from: usize, migrations: &[&str]) -> AppResult<()> {
    // Dropping the transaction without committing rolls everything back.
    let tx = conn.transaction()?;
    let before = dangling_references(&tx)?;
    for (index, sql) in migrations.iter().enumerate().skip(from) {
        let step = index + 1;
        tx.execute_batch(sql)
            .map_err(|e| upgrade_failed(&format!("migration {step} failed"), Some(&e.to_string())))?;
        tx.pragma_update(None, "user_version", step as i64)?;
    }
    let after = dangling_references(&tx)?;
    let broken: Vec<String> = after
        .iter()
        .filter(|(pair, count)| **count > before.get(*pair).copied().unwrap_or(0))
        .map(|((table, parent), count)| format!("{count} in {table} point at missing {parent}"))
        .collect();
    if !broken.is_empty() {
        return Err(upgrade_failed("foreign key check failed", Some(&broken.join(", "))));
    }
    let integrity = integrity_problems(&tx)?;
    if !integrity.is_empty() {
        return Err(upgrade_failed("integrity check failed", Some(&integrity.join("; "))));
    }
    tx.commit()?;
    Ok(())
}

/// Rows that point at a row that is not there, per table and the table they point at.
fn dangling_references(conn: &Connection) -> AppResult<BTreeMap<(String, String), u64>> {
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let mut rows = stmt.query([])?;
    let mut found = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let table: String = row.get(0)?;
        let parent: String = row.get(2)?;
        *found.entry((table, parent)).or_insert(0) += 1;
    }
    Ok(found)
}

/// What `PRAGMA integrity_check` found, or nothing when the database is sound.
fn integrity_problems(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("PRAGMA integrity_check(20)")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let found: Vec<String> = rows.collect::<rusqlite::Result<_>>()?;
    Ok(if found == ["ok"] { Vec::new() } else { found })
}

fn upgrade_failed(step: &str, detail: Option<&str>) -> AppError {
    crate::logs::error("project.upgrade_failed", &[], Some(&format!("{step}: {}", detail.unwrap_or(""))));
    let mut error = AppError::upgrade_failed();
    if let Some(detail) = detail {
        error.message = format!("{} ({step}: {detail})", error.message);
    } else {
        error.message = format!("{} ({step})", error.message);
    }
    error
}

// ---------------------------------------------------------------------------
// Which versions can read a file
// ---------------------------------------------------------------------------

fn meta_value(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let has_meta: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta')",
        [],
        |r| r.get(0),
    )?;
    if !has_meta {
        return Ok(None);
    }
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

/// Reads "0.3.1" or "1.0.0-beta.2", and "0.3" or "1" as a person might write them. Stored
/// text can come from anywhere.
fn parse_version(text: &str) -> Option<semver::Version> {
    let text = text.trim();
    semver::Version::parse(text).ok().or_else(|| {
        let numbers: Vec<u64> = text.split('.').map(|part| part.parse().ok()).collect::<Option<_>>()?;
        match numbers[..] {
            [major] => Some(semver::Version::new(major, 0, 0)),
            [major, minor] => Some(semver::Version::new(major, minor, 0)),
            _ => None,
        }
    })
}

fn this_version() -> semver::Version {
    semver::Version::parse(APP_VERSION).expect("the package version is semver")
}

/// "0.3.0" reads as "0.3", the way people say it.
fn version_for_people(version: &semver::Version) -> String {
    if version.patch == 0 && version.pre.is_empty() {
        format!("{}.{}", version.major, version.minor)
    } else {
        version.to_string()
    }
}

/// Refuses a file that needs a newer LoreCraft: its minimum reader version is newer than this
/// version, or is not a version at all, or its schema is newer than ours.
fn check_readable(conn: &Connection, schema: i64, latest: i64) -> AppResult<()> {
    // Named only when it is newer, as a build of this same version can carry a newer schema.
    let written_by = meta_value(conn, META_WRITTEN_BY)?
        .and_then(|v| parse_version(&v))
        .filter(|v| *v > this_version())
        .map(|v| version_for_people(&v));
    if let Some(needed) = meta_value(conn, META_MIN_READER)? {
        match parse_version(&needed) {
            Some(needed) if needed <= this_version() => {}
            Some(needed) => return Err(AppError::too_new(written_by.as_deref(), &version_for_people(&needed))),
            None => return Err(AppError::too_new_schema(written_by.as_deref())),
        }
    }
    if schema > latest {
        return Err(AppError::too_new_schema(written_by.as_deref()));
    }
    Ok(())
}

/// Keeps a minimum another version raised, because only that version knows why.
fn record_versions(conn: &Connection) -> AppResult<()> {
    let ours = parse_version(MIN_READER_VERSION).expect("MIN_READER_VERSION is a version");
    let minimum = match meta_value(conn, META_MIN_READER)? {
        Some(kept) if parse_version(&kept).is_some_and(|v| v > ours) => kept,
        _ => MIN_READER_VERSION.to_string(),
    };
    for (key, value) in [(META_MIN_READER, minimum.as_str()), (META_WRITTEN_BY, APP_VERSION)] {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value",
            [key, value],
        )?;
    }
    Ok(())
}

/// The schema's own triggers, as name and SQL, from a database made by the migrations.
static OWN_TRIGGERS: std::sync::LazyLock<Vec<(String, String)>> = std::sync::LazyLock::new(|| {
    let read = || -> rusqlite::Result<Vec<(String, String)>> {
        let conn = Connection::open_in_memory()?;
        for sql in MIGRATIONS {
            conn.execute_batch(sql)?;
        }
        let mut stmt = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    };
    read().expect("the migrations run on an empty database")
});

/// A project file can come from someone else, and a trigger in it runs on the writer's own
/// edits: it could rewrite or delete text as it is saved. So a file keeps exactly the
/// schema's triggers, whatever it arrived with. Returns how many were taken out.
pub fn keep_only_own_triggers(conn: &Connection) -> AppResult<usize> {
    let found: Vec<(String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let own = &*OWN_TRIGGERS;
    let mut removed = 0;
    for (name, sql) in &found {
        let is_own = own.iter().any(|(n, s)| n == name && Some(s) == sql.as_ref());
        if !is_own {
            conn.execute_batch(&format!("DROP TRIGGER IF EXISTS \"{}\"", name.replace('"', "\"\"")))?;
            removed += 1;
        }
    }
    for (name, sql) in own {
        let present = found.iter().any(|(n, s)| n == name && s.as_ref() == Some(sql));
        if !present {
            conn.execute_batch(sql)?;
        }
    }
    Ok(removed)
}

// ---------------------------------------------------------------------------
// Checking a file before it opens
// ---------------------------------------------------------------------------

const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

/// Checks that a file is a LoreCraft project this version can read, before we copy or open it
/// for real. It is only read. Each reason it cannot open has its own code and message: a file
/// in use by another program, one online only that could not be downloaded, a damaged one, one
/// that is not a project, and one that needs a newer LoreCraft.
pub fn validate_project_file(path: &Path) -> AppResult<()> {
    let name = file_label(path);
    let (header, len) = read_header(path)?;
    if !header.starts_with(SQLITE_MAGIC) {
        let wiped = header.iter().all(|&b| b == 0);
        let named_as_project = path
            .extension()
            .is_some_and(crate::session::is_project_extension);
        return Err(if wiped && named_as_project {
            AppError::damaged(&name)
        } else {
            AppError::not_a_project(&name)
        });
    }
    if is_truncated(&header, len) {
        return Err(AppError::damaged(&name));
    }
    let conn = open_sqlite(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| sqlite_problem(path, e))?;
    let read = |sql: &str| -> AppResult<i64> {
        conn.query_row(sql, [], |r| r.get(0)).map_err(|e| sqlite_problem(path, e))
    };
    if read("PRAGMA application_id")? != APPLICATION_ID {
        return Err(AppError::not_a_project(&name));
    }
    // Reading the schema finds a damaged one now, rather than halfway through opening.
    read("SELECT COUNT(*) FROM sqlite_master")?;
    let schema = read("PRAGMA user_version")?;
    check_readable(&conn, schema, schema_version()).map_err(|e| match e.code.as_str() {
        "DATABASE" => AppError::damaged(&name),
        _ => e,
    })
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

/// The first 100 bytes, which is SQLite's header, and the file's length.
fn read_header(path: &Path) -> AppResult<(Vec<u8>, u64)> {
    let mut file = std::fs::File::open(path).map_err(|e| read_problem(path, &e))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut header = Vec::with_capacity(100);
    file.by_ref()
        .take(100)
        .read_to_end(&mut header)
        .map_err(|e| read_problem(path, &e))?;
    Ok((header, len))
}

/// A file shorter than its header says, as a copy or a sync cut off part way leaves it.
fn is_truncated(header: &[u8], len: u64) -> bool {
    if header.len() < 100 {
        return true;
    }
    let be32 = |at: usize| u32::from_be_bytes([header[at], header[at + 1], header[at + 2], header[at + 3]]);
    let page_size = match u16::from_be_bytes([header[16], header[17]]) {
        1 => 65_536,
        size => u64::from(size),
    };
    // SQLite trusts the page count only when the file's change counter matches it.
    let pages = u64::from(be32(28));
    let trusted = be32(24) == be32(92);
    trusted && pages > 0 && len < pages * page_size
}

fn read_problem(path: &Path, error: &std::io::Error) -> AppError {
    describe_read_error(&file_label(path), error, is_online_only(path))
}

/// Why reading failed, in words that say what to do.
fn describe_read_error(name: &str, error: &std::io::Error, online_only: bool) -> AppError {
    use std::io::ErrorKind;
    let os = if cfg!(windows) { error.raw_os_error() } else { None };
    match os {
        // ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION.
        Some(32 | 33) => AppError::file_locked(name),
        // ERROR_FILENAME_EXCED_RANGE.
        Some(206) => AppError::path_too_long(name),
        Some(code) if is_cloud_error(code) => AppError::online_only(name),
        _ if online_only => AppError::online_only(name),
        _ if error.kind() == ErrorKind::NotFound => AppError::not_found(name),
        _ if error.kind() == ErrorKind::PermissionDenied => AppError::no_permission(name),
        _ => AppError::cannot_read(name, &error.to_string()),
    }
}

/// The ERROR_CLOUD_FILE_* codes, and the virtualization ones beside them, which is what Windows
/// gives when an online-only file (OneDrive, for one) cannot be downloaded.
fn is_cloud_error(code: i32) -> bool {
    matches!(code, 358 | 362..=366 | 369..=372 | 374..=383 | 385..=398 | 404)
}

/// A OneDrive file kept online only, which Windows downloads when it is read.
#[cfg(windows)]
fn is_online_only(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
    const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
    const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    let placeholder = FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
    std::fs::metadata(path).is_ok_and(|m| m.file_attributes() & placeholder != 0)
}

#[cfg(not(windows))]
fn is_online_only(_path: &Path) -> bool {
    false
}

/// What SQLite's error means for someone opening the file.
fn sqlite_problem(path: &Path, error: rusqlite::Error) -> AppError {
    use rusqlite::ErrorCode;
    let name = file_label(path);
    match error.sqlite_error_code() {
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => AppError::damaged(&name),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => AppError::file_locked(&name),
        Some(ErrorCode::CannotOpen | ErrorCode::SystemIoFailure | ErrorCode::PermissionDenied) => {
            // Reading it again, without SQLite, says why.
            let mut byte = [0u8; 1];
            match std::fs::File::open(path).and_then(|mut f| f.read(&mut byte)) {
                Err(e) => read_problem(path, &e),
                Ok(_) if is_online_only(path) => AppError::online_only(&name),
                Ok(_) => AppError::cannot_read(&name, &error.to_string()),
            }
        }
        _ => AppError::cannot_read(&name, &error.to_string()),
    }
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn local_day() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[cfg(test)]
mod tests;
