//! Vectors already computed, in the app data folder, keyed only by model and text hash.
//!
//! Indexing never marks a project as changed, so a project that is opened, indexed and
//! closed with nothing to save would otherwise lose that work with its working copy. This
//! keeps it: the next open finds the vectors here and embeds nothing again. It holds no
//! text, and deleting it costs only time.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::error::AppResult;
use crate::paths::Paths;

/// About 600 MB. The oldest vectors go first.
const MAX_ROWS: i64 = 400_000;

pub struct VectorCache {
    conn: Mutex<Connection>,
}

impl VectorCache {
    pub fn open(paths: &Paths) -> AppResult<Self> {
        if cfg!(test) {
            // An engine's state outlives its test, and an open file could not be cleaned up.
            return Self::setup(Connection::open_in_memory()?);
        }
        let dir = paths.root.join("embeddings");
        std::fs::create_dir_all(&dir)?;
        Self::open_at(&dir.join("vectors.db"))
    }

    fn open_at(path: &Path) -> AppResult<Self> {
        Self::setup(Connection::open(path)?)
    }

    fn setup(conn: Connection) -> AppResult<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // Losing the newest rows in a power cut only means embedding them again.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS vectors (
               id     INTEGER PRIMARY KEY,
               model  TEXT NOT NULL,
               hash   TEXT NOT NULL,
               vector BLOB NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS vectors_key ON vectors(model, hash);",
        )?;
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM vectors", [], |r| r.get(0))?;
        if total > MAX_ROWS {
            conn.execute(
                "DELETE FROM vectors WHERE id IN (SELECT id FROM vectors ORDER BY id LIMIT ?1)",
                [total - MAX_ROWS],
            )?;
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get_many(&self, model: &str, hashes: &[&str]) -> AppResult<HashMap<String, Vec<u8>>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached("SELECT vector FROM vectors WHERE model = ?1 AND hash = ?2")?;
        let mut found = HashMap::new();
        for hash in hashes {
            let mut rows = stmt.query(params![model, hash])?;
            if let Some(row) = rows.next()? {
                found.insert((*hash).to_string(), row.get::<_, Vec<u8>>(0)?);
            }
        }
        Ok(found)
    }

    pub fn put_many(&self, model: &str, rows: &[(&str, &[u8])]) -> AppResult<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached("INSERT OR REPLACE INTO vectors (model, hash, vector) VALUES (?1, ?2, ?3)")?;
            for (hash, vector) in rows {
                stmt.execute(params![model, hash, vector])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}
