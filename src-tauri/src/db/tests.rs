//! Upgrades of the file format, refusing files from newer versions, the reasons a file cannot
//! open, and the sample projects in `testdata/projects`, which every later version must open.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Value};

use super::*;
use crate::engine::{Engine, TestDir};
use crate::rpc::{call, dispatch};

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn foreign_keys_on(conn: &Connection) -> bool {
    conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap()
}

/// A working copy at the current schema, holding a book whose scenes have everything that can
/// hang from a node: cast, threads, a comment and an idea.
fn manuscript_db(dir: &TestDir) -> Connection {
    let mut conn = open_working(&dir.0.join("working.db")).unwrap();
    // These tests add their own second migration, so the schema stops at the first.
    migrate_with(&mut conn, &MIGRATIONS[..1]).unwrap();
    conn.execute_batch(
        "INSERT INTO books (id, title, created_at, updated_at) VALUES ('b1', 'The Tide Road', 'x', 'x');
         INSERT INTO nodes (id, book_id, parent_id, kind, title, position, content, content_text, created_at, updated_at) VALUES
           ('c1', 'b1', NULL, 'chapter', 'Chapter 1', 0, '', '', 'x', 'x'),
           ('s1', 'b1', 'c1', 'scene', 'Low water', 0, '{\"type\":\"doc\"}', 'The boats sat in the mud.', 'x', 'x'),
           ('s2', 'b1', 'c1', 'scene', 'High water', 1, '{\"type\":\"doc\"}', 'The sea came back.', 'x', 'x');
         INSERT INTO threads (id, name) VALUES ('t1', 'The missing boat');
         INSERT INTO node_threads (node_id, thread_id) VALUES ('s1', 't1'), ('s2', 't1');
         INSERT INTO node_cast (node_id, page_id) VALUES ('s1', 'p1'), ('s2', 'p1');
         INSERT INTO comments (id, source_kind, source_id, body, created_at, updated_at)
           VALUES ('m1', 'node', 's1', 'Too slow here?', 'x', 'x');
         INSERT INTO ideas (id, text, source_kind, source_id, created_at, updated_at)
           VALUES ('i1', 'She hides the key', 'node', 's2', 'x', 'x');",
    )
    .unwrap();
    conn
}

/// Everything in `manuscript_db`, as counts.
fn manuscript_counts(conn: &Connection) -> Vec<i64> {
    [
        "SELECT COUNT(*) FROM books",
        "SELECT COUNT(*) FROM nodes WHERE kind = 'scene'",
        "SELECT COUNT(*) FROM node_cast",
        "SELECT COUNT(*) FROM node_threads",
        "SELECT COUNT(*) FROM comments",
        "SELECT COUNT(*) FROM ideas WHERE source_id = 's2'",
    ]
    .iter()
    .map(|sql| count(conn, sql))
    .collect()
}

/// A migration that rebuilds `table` the way SQLite documents for changes ALTER TABLE cannot
/// make: a new table, the rows copied across, the old one dropped and the new one renamed, then
/// its indexes and triggers made again. It adds a column on the way.
fn rebuild_migration(conn: &Connection, table: &str) -> String {
    let create: String = conn
        .query_row("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1", [table], |r| r.get(0))
        .unwrap();
    let create = create.replacen(&format!("CREATE TABLE {table} ("), &format!("CREATE TABLE {table}_new ("), 1);
    assert!(create.contains(&format!("{table}_new")), "{create}");
    let mut stmt = conn
        .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ?1 AND type IN ('index', 'trigger') AND sql IS NOT NULL")
        .unwrap();
    let extras: Vec<String> = stmt.query_map([table], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    format!(
        "{create};
         ALTER TABLE {table}_new ADD COLUMN upgrade_note TEXT NOT NULL DEFAULT '';
         INSERT INTO {table}_new SELECT *, '' FROM {table};
         DROP TABLE {table};
         ALTER TABLE {table}_new RENAME TO {table};
         {};",
        extras.join(";\n")
    )
}

/// How upgrades ran before: in a transaction with foreign keys still on.
fn run_the_old_way(conn: &mut Connection, sql: &str) {
    assert!(foreign_keys_on(conn));
    let tx = conn.transaction().unwrap();
    tx.execute_batch(sql).unwrap();
    tx.commit().unwrap();
}

#[test]
fn an_upgrade_that_rebuilds_nodes_keeps_everything_that_hangs_from_them() {
    let dir = TestDir::new();
    let mut conn = manuscript_db(&dir);
    let before = manuscript_counts(&conn);
    let rebuild = rebuild_migration(&conn, "nodes");

    // The danger: with foreign keys on, dropping the old table takes the cast and threads with it.
    {
        let control = TestDir::new();
        let mut old_way = manuscript_db(&control);
        run_the_old_way(&mut old_way, &rebuild);
        assert_eq!(count(&old_way, "SELECT COUNT(*) FROM node_cast"), 0);
        assert_eq!(count(&old_way, "SELECT COUNT(*) FROM node_threads"), 0);
    }

    migrate_with(&mut conn, &[MIGRATIONS[0], &rebuild]).unwrap();
    assert_eq!(manuscript_counts(&conn), before);
    assert_eq!(count(&conn, "PRAGMA user_version"), 2);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM nodes WHERE upgrade_note = ''"), 3);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM pragma_foreign_key_check"), 0);
    assert!(foreign_keys_on(&conn), "foreign keys are back on after the upgrade");
    // Its triggers are back: purging a scene still takes its comment with it.
    conn.execute("DELETE FROM nodes WHERE id = 's1'", []).unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM comments"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM node_cast"), 1, "and the cascade works again");
}

#[test]
fn an_upgrade_that_rebuilds_books_keeps_every_scene() {
    let dir = TestDir::new();
    let mut conn = manuscript_db(&dir);
    let before = manuscript_counts(&conn);
    let rebuild = rebuild_migration(&conn, "books");

    {
        let control = TestDir::new();
        let mut old_way = manuscript_db(&control);
        run_the_old_way(&mut old_way, &rebuild);
        assert_eq!(count(&old_way, "SELECT COUNT(*) FROM nodes"), 0, "every scene went with its book");
        assert_eq!(count(&old_way, "SELECT COUNT(*) FROM comments"), 0, "and their comments");
    }

    migrate_with(&mut conn, &[MIGRATIONS[0], &rebuild]).unwrap();
    assert_eq!(manuscript_counts(&conn), before);
    let text: String = conn
        .query_row("SELECT content_text FROM nodes WHERE id = 's1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(text, "The boats sat in the mud.");
    assert!(foreign_keys_on(&conn));
}

/// What a failed upgrade must leave: the database exactly as it was, at its old version, with
/// foreign keys on.
fn assert_unchanged(conn: &Connection, before: &[i64]) {
    assert_eq!(count(conn, "PRAGMA user_version"), 1);
    assert_eq!(manuscript_counts(conn), before);
    assert!(foreign_keys_on(conn));
}

#[test]
fn an_upgrade_that_leaves_rows_pointing_at_nothing_rolls_back() {
    let dir = TestDir::new();
    let mut conn = manuscript_db(&dir);
    let before = manuscript_counts(&conn);
    let error = migrate_with(&mut conn, &[MIGRATIONS[0], "DELETE FROM books;"]).unwrap_err();
    assert_eq!(error.code, "UPGRADE_FAILED");
    assert!(error.message.contains("The file has not changed."), "{}", error.message);
    assert!(error.message.contains("nodes"), "{}", error.message);
    assert_unchanged(&conn, &before);
}

#[test]
fn an_upgrade_that_fails_part_way_changes_nothing() {
    let dir = TestDir::new();
    let mut conn = manuscript_db(&dir);
    let before = manuscript_counts(&conn);
    let steps = [
        MIGRATIONS[0],
        "CREATE TABLE upgrade_probe (x TEXT); DELETE FROM node_cast;",
        "CREATE TABLE broken (",
    ];
    let error = migrate_with(&mut conn, &steps).unwrap_err();
    assert_eq!(error.code, "UPGRADE_FAILED");
    assert!(error.message.contains("migration 3"), "{}", error.message);
    assert_unchanged(&conn, &before);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'upgrade_probe'"), 0);
}

#[test]
fn an_upgrade_that_fails_the_integrity_check_rolls_back() {
    let dir = TestDir::new();
    let mut conn = manuscript_db(&dir);
    let before = manuscript_counts(&conn);
    let bad = "PRAGMA ignore_check_constraints = ON;
               CREATE TABLE upgrade_probe (x INTEGER CHECK (x > 0));
               INSERT INTO upgrade_probe VALUES (-1);
               PRAGMA ignore_check_constraints = OFF;";
    let error = migrate_with(&mut conn, &[MIGRATIONS[0], bad]).unwrap_err();
    assert_eq!(error.code, "UPGRADE_FAILED");
    assert!(error.message.contains("integrity"), "{}", error.message);
    assert_unchanged(&conn, &before);
}

#[test]
fn an_upgrade_inside_a_transaction_is_refused_rather_than_run_with_foreign_keys_on() {
    let dir = TestDir::new();
    let mut conn = manuscript_db(&dir);
    let before = manuscript_counts(&conn);
    let rebuild = rebuild_migration(&conn, "books");
    conn.execute_batch("BEGIN").unwrap();
    let error = upgrade(&mut conn, 1, &[MIGRATIONS[0], &rebuild]).unwrap_err();
    conn.execute_batch("ROLLBACK").unwrap();
    assert_eq!(error.code, "UPGRADE_FAILED");
    assert_unchanged(&conn, &before);
}

// ---------------------------------------------------------------------------
// Which versions can read a file
// ---------------------------------------------------------------------------

#[test]
fn this_version_can_read_what_it_writes() {
    let minimum = parse_version(MIN_READER_VERSION).unwrap();
    assert!(minimum <= this_version(), "MIN_READER_VERSION is newer than the app");
    assert_eq!(MIN_READER_VERSION, "0.1.0");
}

#[test]
fn versions_read_the_way_people_write_them() {
    assert_eq!(parse_version("0.3"), Some(semver::Version::new(0, 3, 0)));
    assert_eq!(parse_version(" 2 "), Some(semver::Version::new(2, 0, 0)));
    assert_eq!(parse_version("1.2.3-beta.1").unwrap().to_string(), "1.2.3-beta.1");
    assert_eq!(parse_version("next"), None);
    assert_eq!(version_for_people(&semver::Version::new(0, 3, 0)), "0.3");
    assert_eq!(version_for_people(&semver::Version::new(0, 3, 1)), "0.3.1");
}

fn meta(conn: &Connection, key: &str) -> Option<String> {
    meta_value(conn, key).unwrap()
}

#[test]
fn every_project_records_the_versions_that_can_read_it() {
    let (engine, _host, dir) = Engine::for_test();
    call(&engine, "project.new", json!({ "name": "World" }));
    let (minimum, written) = engine
        .read(|c| Ok((meta(c, META_MIN_READER), meta(c, META_WRITTEN_BY))))
        .unwrap();
    assert_eq!(minimum.as_deref(), Some("0.1.0"));
    assert_eq!(written.as_deref(), Some(APP_VERSION));
    assert!(!engine.status().dirty, "recording them is not an edit");

    let file = dir.0.join("world.lorecraft");
    engine.allow_path(&file);
    call(&engine, "project.saveAs", json!({ "path": file }));
    let saved = Connection::open(&file).unwrap();
    assert_eq!(meta(&saved, META_MIN_READER).as_deref(), Some("0.1.0"));
    assert_eq!(meta(&saved, META_WRITTEN_BY).as_deref(), Some(APP_VERSION));
}

#[test]
fn a_minimum_another_version_raised_is_kept() {
    let dir = TestDir::new();
    let conn = manuscript_db(&dir);
    conn.execute("UPDATE meta SET value = '9.0.0' WHERE key = ?1", [META_MIN_READER]).unwrap();
    conn.execute("UPDATE meta SET value = '0.0.1' WHERE key = ?1", [META_WRITTEN_BY]).unwrap();
    record_versions(&conn).unwrap();
    assert_eq!(meta(&conn, META_MIN_READER).as_deref(), Some("9.0.0"));
    assert_eq!(meta(&conn, META_WRITTEN_BY).as_deref(), Some(APP_VERSION));
    // A lower one, or nonsense, is raised to ours.
    conn.execute("UPDATE meta SET value = '0.0.5' WHERE key = ?1", [META_MIN_READER]).unwrap();
    record_versions(&conn).unwrap();
    assert_eq!(meta(&conn, META_MIN_READER).as_deref(), Some(MIN_READER_VERSION));
}

/// A saved project, changed by `edit` the way a newer version might have left it.
fn saved_project(dir: &TestDir, name: &str, edit: &str) -> PathBuf {
    let (engine, _host, _engine_dir) = Engine::for_test();
    call(&engine, "project.new", json!({ "name": "Future" }));
    call(&engine, "pages.create", json!({ "title": "Aria" }));
    let file = dir.0.join(name);
    engine.allow_path(&file);
    call(&engine, "project.saveAs", json!({ "path": file }));
    call(&engine, "project.close", json!({}));
    Connection::open(&file).unwrap().execute_batch(edit).unwrap();
    file
}

/// Opening `file` fails with `code`, opens no project, leaves no session behind and does not
/// change the file. Returns the message.
fn refused(file: &Path, code: &str) -> String {
    let bytes = std::fs::read(file).unwrap();
    let (engine, _host, _dir) = Engine::for_test();
    let error = dispatch(&engine, "project.open", json!({ "path": file })).unwrap_err();
    assert_eq!(error.code, code, "{}", error.message);
    assert!(!engine.status().open);
    let sessions = engine.paths.sessions();
    let left = std::fs::read_dir(&sessions).map(|d| d.count()).unwrap_or(0);
    assert_eq!(left, 0, "no session is left behind");
    assert_eq!(std::fs::read(file).unwrap(), bytes, "the file is untouched");
    error.message
}

#[test]
fn a_file_that_needs_a_newer_lorecraft_is_refused_naming_the_version() {
    let dir = TestDir::new();
    let file = saved_project(
        &dir,
        "future.lorecraft",
        "UPDATE meta SET value = '99.0.0' WHERE key = 'min_reader_version';
         UPDATE meta SET value = '99.0.2' WHERE key = 'written_by_version';",
    );
    let message = refused(&file, "TOO_NEW");
    assert_eq!(
        message,
        "This project was saved by LoreCraft 99.0.2, which added things this version can't read. Update LoreCraft to 99.0 or later to open it."
    );
    assert_eq!(validate_project_file(&file).unwrap_err().code, "TOO_NEW");

    // The working copy is refused too, as when recovering one a newer version left behind.
    let copy = dir.0.join("copy.db");
    std::fs::copy(&file, &copy).unwrap();
    let mut conn = open_working(&copy).unwrap();
    assert_eq!(migrate(&mut conn).unwrap_err().code, "TOO_NEW");
}

#[test]
fn a_file_with_a_newer_schema_is_refused() {
    let dir = TestDir::new();
    let newer = format!("PRAGMA user_version = {};", schema_version() + 1);
    let file = saved_project(
        &dir,
        "schema.lorecraft",
        &format!("{newer} UPDATE meta SET value = '99.0.0' WHERE key = 'written_by_version';"),
    );
    assert_eq!(
        refused(&file, "TOO_NEW"),
        "This project was saved by LoreCraft 99.0, a newer version than this one. Update LoreCraft to open it."
    );
    // A build of this same version can have a newer schema. It is not named as newer.
    let same = saved_project(&dir, "same.lorecraft", &newer);
    assert_eq!(
        refused(&same, "TOO_NEW"),
        "This project was saved by a newer version of LoreCraft. Update LoreCraft to open it."
    );

    let copy = dir.0.join("copy.db");
    std::fs::copy(&file, &copy).unwrap();
    let mut conn = open_working(&copy).unwrap();
    assert_eq!(migrate(&mut conn).unwrap_err().code, "TOO_NEW");
}

#[test]
fn a_minimum_that_is_not_a_version_is_refused() {
    let dir = TestDir::new();
    let file = saved_project(&dir, "odd.lorecraft", "UPDATE meta SET value = 'next' WHERE key = 'min_reader_version';");
    assert_eq!(
        refused(&file, "TOO_NEW"),
        "This project was saved by a newer version of LoreCraft. Update LoreCraft to open it."
    );
}

#[test]
fn a_file_from_before_versions_were_recorded_opens_and_gets_them_at_the_next_save() {
    let dir = TestDir::new();
    let file = saved_project(
        &dir,
        "older.lorecraft",
        "DELETE FROM meta WHERE key IN ('min_reader_version', 'written_by_version');",
    );
    let bytes = std::fs::read(&file).unwrap();
    let (engine, _host, _engine_dir) = Engine::for_test();
    call(&engine, "project.open", json!({ "path": file }));
    let minimum = engine.read(|c| Ok(meta(c, META_MIN_READER))).unwrap();
    assert_eq!(minimum.as_deref(), Some(MIN_READER_VERSION));
    assert!(!engine.status().dirty, "recording them is not an edit");
    assert_eq!(std::fs::read(&file).unwrap(), bytes, "the file changes only when saved");
    call(&engine, "pages.create", json!({ "title": "Bran" }));
    call(&engine, "project.save", json!({}));
    let saved = Connection::open(&file).unwrap();
    assert_eq!(meta(&saved, META_WRITTEN_BY).as_deref(), Some(APP_VERSION));
}

// ---------------------------------------------------------------------------
// Why a file cannot open
// ---------------------------------------------------------------------------

fn plain_project(dir: &TestDir) -> PathBuf {
    saved_project(dir, "plain.lorecraft", "")
}

#[test]
fn another_programs_database_is_not_a_project() {
    let dir = TestDir::new();
    let file = dir.0.join("other.lorecraft");
    Connection::open(&file).unwrap().execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (1);").unwrap();
    let message = refused(&file, "NOT_A_PROJECT");
    assert_eq!(message, "other.lorecraft is not a LoreCraft project.");
    let text = dir.0.join("notes.lorecraft");
    std::fs::write(&text, "Chapter one, in plain text.").unwrap();
    refused(&text, "NOT_A_PROJECT");
}

#[test]
fn a_damaged_project_says_it_is_damaged() {
    let dir = TestDir::new();
    let good = std::fs::read(plain_project(&dir)).unwrap();
    assert!(good.len() > 8192);

    // Cut off part way, as an interrupted copy or sync leaves it.
    let cut = dir.0.join("cut.lorecraft");
    std::fs::write(&cut, &good[..good.len() / 2]).unwrap();
    // Wiped to zeros, as a crash during a sync can leave it.
    let zeros = dir.0.join("zeros.lorecraft");
    std::fs::write(&zeros, vec![0u8; good.len()]).unwrap();
    // A sound header in front of a schema that is not.
    let scrambled = dir.0.join("scrambled.lorecraft");
    let mut bytes = good.clone();
    let page_size = usize::from(u16::from_be_bytes([bytes[16], bytes[17]]));
    for (i, b) in bytes[100..page_size].iter_mut().enumerate() {
        *b = (i * 7 + 3) as u8;
    }
    std::fs::write(&scrambled, &bytes).unwrap();

    for file in [&cut, &zeros, &scrambled] {
        let message = refused(file, "CORRUPT");
        assert!(message.ends_with("is damaged, so LoreCraft can't open it. An earlier save may be in Backups."), "{message}");
    }
    // Zeros under another name are just not a project.
    let other = dir.0.join("zeros.bin");
    std::fs::write(&other, vec![0u8; 4096]).unwrap();
    assert_eq!(validate_project_file(&other).unwrap_err().code, "NOT_A_PROJECT");
}

#[cfg(windows)]
#[test]
fn a_project_another_program_holds_open_says_so() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = TestDir::new();
    let file = plain_project(&dir);
    let bytes = std::fs::read(&file).unwrap();
    let (engine, _host, _engine_dir) = Engine::for_test();
    {
        // As antivirus or a sync tool can, while it works on the file.
        let _held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&file).unwrap();
        let error = dispatch(&engine, "project.open", json!({ "path": file })).unwrap_err();
        assert_eq!(error.code, "FILE_LOCKED");
        assert_eq!(
            error.message,
            "plain.lorecraft is in use by another program, such as antivirus or OneDrive. Wait a moment, then try again."
        );
        assert!(!engine.status().open);
    }
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    // Once the other program lets go, it opens.
    call(&engine, "project.open", json!({ "path": file }));
    assert!(engine.status().open);
}

#[test]
fn read_errors_say_what_to_do() {
    use std::io::{Error, ErrorKind};
    let code = |error: Error, online_only: bool| describe_read_error("world.lorecraft", &error, online_only).code;
    if cfg!(windows) {
        // ERROR_CLOUD_FILE_PROVIDER_NOT_RUNNING, ERROR_CLOUD_FILE_NETWORK_UNAVAILABLE and
        // ERROR_CLOUD_FILE_PROVIDER_TERMINATED, the usual OneDrive ones.
        for cloud in [362, 388, 404] {
            assert_eq!(code(Error::from_raw_os_error(cloud), false), "ONLINE_ONLY");
        }
        assert_eq!(code(Error::from_raw_os_error(32), false), "FILE_LOCKED");
        assert_eq!(code(Error::from_raw_os_error(33), false), "FILE_LOCKED");
        assert_eq!(code(Error::from_raw_os_error(206), false), "PATH_TOO_LONG");
        // Access denied on an online-only file is a download that failed.
        assert_eq!(code(Error::from_raw_os_error(5), true), "ONLINE_ONLY");
        assert_eq!(code(Error::from_raw_os_error(5), false), "NO_PERMISSION");
    }
    assert_eq!(code(Error::from(ErrorKind::PermissionDenied), false), "NO_PERMISSION");
    assert_eq!(code(Error::from(ErrorKind::NotFound), false), "NOT_FOUND");
    assert_eq!(code(Error::other("disk on fire"), false), "CANNOT_READ");
    let message = describe_read_error("world.lorecraft", &Error::from_raw_os_error(362), true).message;
    assert!(message.starts_with("world.lorecraft is stored online only"), "{message}");
}

/// A folder path well past Windows' 260 characters.
fn long_folder(dir: &TestDir) -> PathBuf {
    let mut folder = dir.0.clone();
    while folder.as_os_str().len() < 320 {
        folder.push("a folder with quite a long name");
    }
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

#[test]
fn short_paths_go_to_sqlite_as_they_are() {
    let short = Path::new(r"C:\Users\someone\world.lorecraft");
    assert_eq!(sqlite_path(short), short);
    if cfg!(windows) {
        let long = PathBuf::from(format!(r"C:\{}\world.lorecraft", "x".repeat(300)));
        assert_eq!(sqlite_path(&long), PathBuf::from(format!(r"\\?\C:\{}\world.lorecraft", "x".repeat(300))));
        let shared = PathBuf::from(format!(r"\\server\share\{}\w.lorecraft", "x".repeat(300)));
        assert_eq!(sqlite_path(&shared), PathBuf::from(format!(r"\\?\UNC\server\share\{}\w.lorecraft", "x".repeat(300))));
        let already = PathBuf::from(format!(r"\\?\C:\{}\w.lorecraft", "x".repeat(300)));
        assert_eq!(sqlite_path(&already), already);
    }
}

#[test]
fn a_project_deep_in_folders_opens_and_saves() {
    let dir = TestDir::new();
    let file = long_folder(&dir).join("deep.lorecraft");
    std::fs::copy(plain_project(&dir), &file).unwrap();
    assert!(file.as_os_str().len() > 300);
    validate_project_file(&file).unwrap();

    let (engine, _host, _engine_dir) = Engine::for_test();
    call(&engine, "project.open", json!({ "path": file }));
    assert_eq!(call(&engine, "pages.getByTitle", json!({ "title": "Aria" }))["title"], "Aria");

    // And saves back to where it came from.
    call(&engine, "pages.create", json!({ "title": "Bran" }));
    call(&engine, "project.save", json!({}));
    call(&engine, "project.close", json!({}));
    call(&engine, "project.open", json!({ "path": file }));
    assert_eq!(call(&engine, "pages.getByTitle", json!({ "title": "Bran" }))["title"], "Bran");
}

// ---------------------------------------------------------------------------
// Sample projects
// ---------------------------------------------------------------------------

/// Made by `make_sample_project` with LoreCraft 0.1.0. Never made again: it stands for the files
/// people already have. A release that changes the format adds its own sample beside it.
const SAMPLES: &[&str] = &["sample-0.1.0.lorecraft"];

fn sample_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata").join("projects").join(name)
}

/// A real 1 by 1 PNG.
const PICTURE: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

fn picture() -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(PICTURE).unwrap()
}

fn text(words: &str) -> Value {
    json!({ "type": "text", "text": words })
}

fn paragraph(content: Vec<Value>) -> Value {
    json!({ "type": "paragraph", "content": content })
}

fn linked(words: &str, target: &str) -> Value {
    json!({ "type": "text", "text": words, "marks": [{ "type": "wikiLink", "attrs": { "target": target } }] })
}

fn commented(words: &str, comment_id: &str) -> Value {
    json!({ "type": "text", "text": words, "marks": [{ "type": "comment", "attrs": { "id": comment_id } }] })
}

/// A book's chapters in order, each with its scenes in order.
fn chapters(engine: &Engine, book_id: &str) -> Vec<(Value, Vec<Value>)> {
    let nodes = call(engine, "nodes.tree", json!({ "bookId": book_id }));
    let nodes = nodes.as_array().unwrap();
    let ordered = |kind: &str, parent: &Value| {
        let mut found: Vec<Value> = nodes
            .iter()
            .filter(|n| n["kind"] == kind && (parent.is_null() || n["parentId"] == *parent))
            .cloned()
            .collect();
        found.sort_by_key(|n| n["position"].as_i64());
        found
    };
    ordered("chapter", &Value::Null)
        .into_iter()
        .map(|chapter| {
            let scenes = ordered("scene", &chapter["id"]);
            (chapter, scenes)
        })
        .collect()
}

fn page_id(engine: &Engine, title: &str) -> String {
    call(engine, "pages.getByTitle", json!({ "title": title }))["id"].as_str().unwrap().to_string()
}

fn set_infobox(engine: &Engine, id: &str, infobox: Value) {
    call(engine, "pages.update", json!({ "id": id, "patch": { "infobox": infobox }, "fromEditor": true }));
}

fn person(fields: &[(&str, &str, &str, &str)]) -> Value {
    let fields: Vec<Value> = fields
        .iter()
        .map(|(key, label, kind, value)| json!({ "key": key, "label": label, "kind": kind, "value": value }))
        .collect();
    json!({ "fields": fields })
}

/// Writes `testdata/projects/sample-<this version>.lorecraft` through the same calls the UI
/// makes, when `LORECRAFT_MAKE_SAMPLE` is set. It never replaces a sample, because each must stay
/// as the version it is named for wrote it. Add the new file to `SAMPLES`, and commit it with
/// `git add -f`, because `*.lorecraft` is ignored.
#[test]
#[ignore = "writes a sample project into the source tree"]
fn make_sample_project() {
    let target = sample_path(&format!("sample-{APP_VERSION}.lorecraft"));
    if std::env::var_os("LORECRAFT_MAKE_SAMPLE").is_none() || target.exists() {
        eprintln!("Set LORECRAFT_MAKE_SAMPLE to make {}, which must not exist yet.", target.display());
        return;
    }
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    let (engine, _host, _dir) = Engine::for_test();
    call(&engine, "project.new", json!({ "name": "Saltmarsh" }));

    // A page type of the writer's own.
    let ship_type = json!([{
        "type": "ship", "label": "Ship", "plural": "Ships", "description": "A vessel and who sails it.",
        "fields": [
            { "key": "captain", "label": "Captain", "kind": "page", "value": "" },
            { "key": "launched", "label": "Launched", "kind": "date", "value": "" },
        ],
        "sections": ["History", "Crew"],
    }]);
    call(&engine, "project.setMeta", json!({ "key": "pageTypes", "value": ship_type.to_string() }));

    // A picture, uploaded as the UI uploads it.
    let bytes = picture();
    let begun = call(&engine, "media.uploadBegin", json!({ "name": "harbour.png", "mime": "image/png", "size": bytes.len() }));
    let upload = begun["id"].as_str().unwrap().to_string();
    crate::rpc::media::upload_chunk(&engine, &upload, 0, &bytes).unwrap();
    let asset = call(
        &engine,
        "media.uploadFinish",
        json!({ "id": upload, "sha256": crate::rpc::media::test_support::sha(&bytes), "width": 1, "height": 1 }),
    );
    let asset_id = asset["id"].as_str().unwrap().to_string();

    // Three characters, a family.
    let family = [
        ("born", "Born", "date", ""),
        ("parents", "Parents", "pages", ""),
        ("spouse", "Spouse", "pages", ""),
        ("children", "Children", "pages", ""),
    ];
    for title in ["Aria Vell", "Bran Vell", "Cara Vell"] {
        call(&engine, "pages.create", json!({ "title": title, "pageType": "character", "infobox": person(&family) }));
    }
    let aria = page_id(&engine, "Aria Vell");
    let cara = page_id(&engine, "Cara Vell");
    let mut aria_box = person(&[
        ("born", "Born", "date", "Spring 1171"),
        ("parents", "Parents", "pages", ""),
        ("spouse", "Spouse", "pages", "Bran Vell"),
        ("children", "Children", "pages", ""),
    ]);
    aria_box["imageAssetId"] = json!(asset_id);
    aria_box["caption"] = json!("Aria on the harbour wall");
    set_infobox(&engine, &aria, aria_box);
    set_infobox(
        &engine,
        &cara,
        person(&[
            ("born", "Born", "date", "Autumn 1196"),
            ("parents", "Parents", "pages", "Aria Vell, Bran Vell"),
            ("spouse", "Spouse", "pages", ""),
            ("children", "Children", "pages", ""),
        ]),
    );

    // Aria's article: links, a figure with the picture, and a comment on a stretch of text.
    let note = call(
        &engine,
        "comments.add",
        json!({ "sourceKind": "page", "sourceId": aria, "body": "Check her age against the war.", "quote": "harbourmaster" }),
    );
    let note_id = note["id"].as_str().unwrap().to_string();
    let article = json!({ "type": "doc", "content": [
        { "type": "heading", "attrs": { "level": 2 }, "content": [text("Early life")] },
        paragraph(vec![text("Aria was the "), commented("harbourmaster", &note_id), text(" of Saltmarsh, and married "), linked("Bran", "Bran Vell"), text(".")]),
        { "type": "figure", "attrs": { "kind": "picture", "align": "right", "width": 40, "description": "A stone harbour wall at low tide" }, "content": [
            { "type": "image", "attrs": { "assetId": asset_id, "width": 1, "height": 1 } },
            { "type": "figcaption", "content": [text("The harbour of "), linked("Saltmarsh", "Saltmarsh")] },
        ]},
        paragraph(vec![text("She captained "), linked("The Gull", "The Gull"), text(" for twenty years.")]),
    ]});
    call(&engine, "pages.update", json!({ "id": aria, "patch": { "content": article, "summary": "Harbourmaster of Saltmarsh." } }));

    // A page of the writer's own type.
    call(
        &engine,
        "pages.create",
        json!({ "title": "The Gull", "pageType": "ship", "infobox": person(&[
            ("captain", "Captain", "page", "Aria Vell"),
            ("launched", "Launched", "date", "1190"),
        ]), "content": { "type": "doc", "content": [paragraph(vec![text("A fishing boat with a red sail.")])] } }),
    );

    // The book: two chapters of scenes, with a to-do on one of them.
    let book = &call(&engine, "books.list", json!({}))[0];
    let book_id = book["id"].as_str().unwrap().to_string();
    call(&engine, "books.update", json!({ "id": book_id, "patch": { "title": "The Tide Road" } }));
    let outline = chapters(&engine, &book_id);
    let chapter_one = outline[0].0["id"].as_str().unwrap().to_string();
    let scene_one = outline[0].1[0]["id"].as_str().unwrap().to_string();
    call(&engine, "nodes.update", json!({ "id": chapter_one, "patch": { "title": "Low Water" } }));
    let todo = call(
        &engine,
        "comments.add",
        json!({ "sourceKind": "node", "sourceId": scene_one, "body": "Say what she saw.", "quote": "mud", "isTodo": true }),
    );
    let todo_id = todo["id"].as_str().unwrap().to_string();
    call(
        &engine,
        "nodes.update",
        json!({ "id": scene_one, "patch": { "title": "The Boats", "content": { "type": "doc", "content": [
            paragraph(vec![linked("Aria", "Aria Vell"), text(" watched the boats settle into the "), commented("mud", &todo_id), text(".")]),
        ]}}}),
    );
    call(&engine, "nodes.setCast", json!({ "id": scene_one, "pageIds": [aria] }));
    let scene_two = call(
        &engine,
        "nodes.create",
        json!({ "bookId": book_id, "parentId": chapter_one, "kind": "scene", "title": "The Key",
                "content": { "type": "doc", "content": [paragraph(vec![text("Cara found the key under a stone.")])] } }),
    );
    assert!(scene_two["id"].is_string());
    let chapter_two = call(&engine, "nodes.create", json!({ "bookId": book_id, "kind": "chapter", "title": "High Water" }));
    call(
        &engine,
        "nodes.create",
        json!({ "bookId": book_id, "parentId": chapter_two["id"], "kind": "scene", "title": "The Return",
                "content": { "type": "doc", "content": [paragraph(vec![text("The sea came back before dawn.")])] } }),
    );

    engine.allow_path(&target);
    call(&engine, "project.saveAs", json!({ "path": target }));
    let size = std::fs::metadata(&target).unwrap().len();
    assert!(size < 500 * 1024, "the sample is {size} bytes");
}

/// Opens a copy of a sample, never the sample itself.
fn open_sample(engine: &Engine, name: &str, dir: &TestDir) -> PathBuf {
    let copy = dir.0.join(name);
    std::fs::copy(sample_path(name), &copy).unwrap();
    call(engine, "project.open", json!({ "path": copy }));
    copy
}

fn infobox_value(page: &Value, key: &str) -> String {
    page["infobox"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["key"] == key)
        .map(|f| f["value"].as_str().unwrap().to_string())
        .unwrap_or_default()
}

/// Every node in a document, depth first.
fn nodes_of(doc: &Value) -> Vec<&Value> {
    let mut found = vec![doc];
    if let Some(children) = doc["content"].as_array() {
        for child in children {
            found.extend(nodes_of(child));
        }
    }
    found
}

fn has_mark(doc: &Value, kind: &str) -> bool {
    nodes_of(doc).iter().any(|n| {
        n["marks"].as_array().is_some_and(|marks| marks.iter().any(|m| m["type"] == kind))
    })
}

/// What `make_sample_project` put in, read back through the calls the UI makes.
fn check_sample_content(engine: &Engine) {
    let aria = call(engine, "pages.getByTitle", json!({ "title": "Aria Vell" }));
    assert_eq!(aria["pageType"], "character");
    assert_eq!(aria["summary"], "Harbourmaster of Saltmarsh.");
    assert_eq!(infobox_value(&aria, "born"), "Spring 1171");
    assert_eq!(infobox_value(&aria, "spouse"), "Bran Vell");
    assert_eq!(infobox_value(&aria, "children"), "Cara Vell", "filled in by the family sync");
    assert_eq!(aria["infobox"]["caption"], "Aria on the harbour wall");
    let asset_id = aria["infobox"]["imageAssetId"].as_str().unwrap().to_string();

    // The figure, with its picture, and the marks around it.
    let doc = &aria["content"];
    let figure = nodes_of(doc).into_iter().find(|n| n["type"] == "figure").expect("a figure");
    assert_eq!(figure["attrs"]["kind"], "picture");
    assert_eq!(figure["attrs"]["description"], "A stone harbour wall at low tide");
    assert_eq!(figure["content"][0]["type"], "image");
    assert_eq!(figure["content"][0]["attrs"]["assetId"], asset_id);
    assert_eq!(figure["content"][1]["type"], "figcaption");
    assert!(has_mark(doc, "wikiLink") && has_mark(doc, "comment"));
    let found = call(engine, "search.query", json!({ "q": "harbourmaster" }));
    assert!(found.to_string().contains("Aria Vell"), "the search index came along: {found}");

    // The picture's bytes.
    let info = call(engine, "media.get", json!({ "id": asset_id }));
    assert_eq!(info["mime"], "image/png");
    let stored: Vec<u8> = engine
        .read(|c| Ok(c.query_row("SELECT bytes FROM asset_chunks WHERE asset_id = ?1 AND idx = 0", [&asset_id], |r| r.get(0))?))
        .unwrap();
    assert_eq!(stored, picture());

    // The family, as relationships.
    let relations = call(engine, "extras.relationshipList", json!({}));
    let pairs: Vec<(String, String, String)> = relations
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let field = |k: &str| r[k].as_str().unwrap().to_string();
            (field("fromTitle"), field("kind"), field("toTitle"))
        })
        .collect();
    for parent in ["Aria Vell", "Bran Vell"] {
        assert!(pairs.iter().any(|(from, _, to)| from == parent && to == "Cara Vell"), "{pairs:?}");
    }
    assert!(pairs.iter().any(|(from, _, to)| from == "Aria Vell" && to == "Bran Vell" || from == "Bran Vell" && to == "Aria Vell"), "{pairs:?}");

    // The writer's own page type, and a page of it.
    let types: Value = serde_json::from_str(call(engine, "project.getMeta", json!({ "key": "pageTypes" })).as_str().unwrap()).unwrap();
    assert_eq!(types[0]["type"], "ship");
    assert_eq!(types[0]["fields"][0]["key"], "captain");
    let gull = call(engine, "pages.getByTitle", json!({ "title": "The Gull" }));
    assert_eq!(gull["pageType"], "ship");
    assert_eq!(infobox_value(&gull, "captain"), "Aria Vell");

    // The book.
    let books = call(engine, "books.list", json!({}));
    assert_eq!(books.as_array().unwrap().len(), 1);
    assert_eq!(books[0]["title"], "The Tide Road");
    let outline = chapters(engine, books[0]["id"].as_str().unwrap());
    let title = |node: &Value| node["title"].as_str().unwrap().to_string();
    let titles: Vec<(String, Vec<String>)> = outline
        .iter()
        .map(|(chapter, scenes)| (title(chapter), scenes.iter().map(title).collect()))
        .collect();
    assert_eq!(
        titles,
        [
            ("Low Water".to_string(), vec!["The Boats".to_string(), "The Key".to_string()]),
            ("High Water".to_string(), vec!["The Return".to_string()]),
        ]
    );
    let boats = call(engine, "nodes.get", json!({ "id": outline[0].1[0]["id"] }));
    assert!(has_mark(&boats["content"], "comment"));
    assert_eq!(call(engine, "nodes.cast", json!({ "id": boats["id"] })).as_array().unwrap().len(), 1);

    // The comments, one a to-do on a scene.
    let comments = call(engine, "comments.list", json!(null));
    let mut bodies: Vec<(String, bool)> = comments
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["body"].as_str().unwrap().to_string(), c["isTodo"].as_bool().unwrap()))
        .collect();
    bodies.sort();
    assert_eq!(
        bodies,
        [("Check her age against the war.".to_string(), false), ("Say what she saw.".to_string(), true)]
    );
}

#[test]
fn the_sample_projects_open_with_everything_in_them() {
    for name in SAMPLES {
        let (engine, _host, dir) = Engine::for_test();
        let copy = open_sample(&engine, name, &dir);
        let bytes = std::fs::read(sample_path(name)).unwrap();
        check_sample_content(&engine);
        assert!(!engine.status().dirty, "{name}: opening is not an edit");
        assert_eq!(std::fs::read(&copy).unwrap(), bytes, "{name}: opening does not touch the file");

        // Saved by this version, it opens again with the same content.
        let resaved = dir.0.join(format!("resaved-{name}"));
        engine.allow_path(&resaved);
        call(&engine, "project.saveAs", json!({ "path": resaved }));
        call(&engine, "project.close", json!({}));
        call(&engine, "project.open", json!({ "path": resaved }));
        check_sample_content(&engine);
    }
}

/// The schema as SQLite stores it, minus what SQLite names itself.
fn schema_of(conn: &Connection) -> Vec<(String, String, String)> {
    let mut stmt = conn
        .prepare("SELECT type, name, IFNULL(sql, '') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .unwrap();
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    rows.map(Result::unwrap).collect()
}

/// Upgrading an old file must give exactly the schema a new project gets. This fails when an
/// earlier migration is edited, which files people already have would never see: change the
/// schema with a new migration instead.
#[test]
fn the_sample_projects_upgrade_to_the_schema_of_a_new_project() {
    let dir = TestDir::new();
    let mut fresh = open_working(&dir.0.join("fresh.db")).unwrap();
    migrate(&mut fresh).unwrap();
    let expected = schema_of(&fresh);
    for name in SAMPLES {
        let copy = dir.0.join(name);
        std::fs::copy(sample_path(name), &copy).unwrap();
        let mut conn = open_working(&copy).unwrap();
        migrate(&mut conn).unwrap();
        let upgraded = schema_of(&conn);
        let differ: Vec<_> = expected
            .iter()
            .filter(|row| !upgraded.contains(row))
            .chain(upgraded.iter().filter(|row| !expected.contains(row)))
            .collect();
        assert!(
            differ.is_empty(),
            "{name} upgrades to a schema unlike a new project's. Change the schema with a new migration in src-tauri/migrations, not by editing an earlier one. Differences: {differ:#?}"
        );
        assert_eq!(meta(&conn, META_MIN_READER).as_deref(), Some(MIN_READER_VERSION));
    }
}

#[test]
fn chats_from_before_versions_become_one_line() {
    let dir = TestDir::new();
    let mut conn = open_working(&dir.0.join("working.db")).unwrap();
    migrate_with(&mut conn, &MIGRATIONS[..3]).unwrap();
    conn.execute_batch(
        "INSERT INTO ai_conversations (id, title, context, created_at, updated_at) VALUES ('c1', 'Chat', '{}', 'x', 'x'), ('c2', 'Other', '{}', 'x', 'x');
         INSERT INTO ai_messages (id, conversation_id, role, content, created_at) VALUES
           ('m3', 'c1', 'user', '[]', '2026-01-02'),
           ('m1', 'c1', 'user', '[]', '2026-01-01'),
           ('m2', 'c1', 'assistant', '[]', '2026-01-01'),
           ('n1', 'c2', 'user', '[]', '2026-01-01');",
    )
    .unwrap();
    migrate_with(&mut conn, MIGRATIONS).unwrap();
    let parent = |id: &str| -> Option<String> {
        conn.query_row("SELECT parent_id FROM ai_messages WHERE id = ?1", [id], |r| r.get(0)).unwrap()
    };
    assert_eq!(parent("m1"), None);
    assert_eq!(parent("m2").as_deref(), Some("m1"), "a tie in time goes by id");
    assert_eq!(parent("m3").as_deref(), Some("m2"));
    assert_eq!(parent("n1"), None, "each chat is its own line");
}
