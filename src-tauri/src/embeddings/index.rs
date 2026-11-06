//! Keeping the index in step with the text, one small step at a time.
//!
//! The UI calls `step` in a loop while there is work, which is what makes this background
//! work: each call runs on the blocking pool, holds the project's lock only for short reads
//! and writes and never while a model runs, and the loop stops the moment the writer stops it.
//!
//! **Saving.** Index rows are written to the working copy without marking the project as
//! changed, because nothing the writer made has changed. The rows therefore reach the file
//! with the next real save and are kept there, including through Save As, so the index
//! travels with the project. That costs about 2 KB per passage in the file, or 9 MB for a
//! 100,000-word book of 4,700 passages, which `VACUUM INTO` copies quickly. A project closed with
//! nothing to save loses those rows along with its working copy, so every vector is also
//! kept in `cache`, and the next open restores them without embedding anything again.

use std::collections::{HashMap, HashSet, VecDeque};

use rusqlite::{params, Connection, Transaction};
use serde_json::Value;

use super::chunk::{chunk_document, Chunk};
use super::{provider_for, shared, status, to_blob, write_quiet, Config, Provider, Shared};
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::indexing::KIND_PAGE;

type DocKey = (String, String);

/// One passage waiting for its vector.
pub struct Item {
    kind: String,
    id: String,
    index: i64,
    hash: String,
    text: String,
    snippet: String,
}

/// Where indexing has got to. Kept in memory, because the rows themselves are the record of
/// what is done: after a restart, a scan works out the rest.
#[derive(Default)]
pub struct Work {
    session: String,
    model: String,
    pub scanned: bool,
    fingerprint: String,
    /// What each document looked like when it was last read.
    seen: HashMap<DocKey, String>,
    todo: VecDeque<Item>,
    in_flight: usize,
    /// Rows for the current model.
    pub indexed: usize,
    /// Local-only documents left out because the provider is a cloud one.
    pub skipped: HashSet<DocKey>,
    /// The session the writer stopped indexing in. Another project starts running again.
    paused_in: String,
    pub failed: Option<String>,
    /// Passages actually sent to a model since the app started.
    pub embedded: u64,
    busy: bool,
}

impl Work {
    pub fn is_indexing(&self) -> bool {
        !self.todo.is_empty() || self.in_flight > 0
    }

    pub fn pending(&self) -> usize {
        self.todo.len() + self.in_flight
    }

    pub fn reset(&mut self) {
        let (paused_in, embedded) = (std::mem::take(&mut self.paused_in), self.embedded);
        *self = Work { paused_in, embedded, ..Work::default() };
    }

    pub fn is_paused_in(&self, session: &str) -> bool {
        !self.paused_in.is_empty() && self.paused_in == session
    }
}

fn lock_work(shared: &Shared) -> std::sync::MutexGuard<'_, Work> {
    shared.work.lock().unwrap_or_else(|e| e.into_inner())
}

/// Changes when any page or scene does, cheaply enough to ask before every step.
fn fingerprint(conn: &Connection) -> AppResult<String> {
    Ok(conn.query_row(
        "SELECT (SELECT COUNT(*) || '|' || COALESCE(MAX(updated_at), '') || '|' || COALESCE(SUM(local_only), 0)
                   FROM pages WHERE deleted_at IS NULL)
             || '#' ||
                (SELECT COUNT(*) || '|' || COALESCE(MAX(n.updated_at), '') || '|' || COALESCE(SUM(n.local_only), 0)
                   FROM nodes n JOIN books b ON b.id = n.book_id
                  WHERE n.kind = 'scene' AND n.deleted_at IS NULL AND b.deleted_at IS NULL)",
        [],
        |r| r.get(0),
    )?)
}

struct DocStamp {
    key: DocKey,
    stamp: String,
    local_only: bool,
}

fn list_documents(conn: &Connection) -> AppResult<Vec<DocStamp>> {
    let mut stmt = conn.prepare(
        "SELECT 'page', id, updated_at, local_only FROM pages WHERE deleted_at IS NULL
         UNION ALL
         SELECT 'node', n.id, n.updated_at, n.local_only FROM nodes n JOIN books b ON b.id = n.book_id
          WHERE n.kind = 'scene' AND n.deleted_at IS NULL AND b.deleted_at IS NULL",
    )?;
    let rows = stmt.query_map([], |r| {
        let updated: String = r.get(2)?;
        let local_only: bool = r.get::<_, i64>(3)? != 0;
        Ok(DocStamp {
            key: (r.get(0)?, r.get(1)?),
            stamp: format!("{updated}|{local_only}"),
            local_only,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The infobox as text, leaving out fields that only hold links to other pages.
fn infobox_lines(infobox: &str) -> String {
    let parsed: Value = serde_json::from_str(infobox).unwrap_or(Value::Null);
    let mut out = String::new();
    for field in parsed.get("fields").and_then(Value::as_array).into_iter().flatten() {
        let value = field.get("value").and_then(Value::as_str).unwrap_or("").trim();
        let label = field.get("label").and_then(Value::as_str).unwrap_or("").trim();
        if !value.is_empty() {
            out.push_str(&format!("{label}: {value}\n"));
        }
    }
    out
}

/// The chunks of one document, read fresh.
fn read_chunks(conn: &Connection, key: &DocKey) -> AppResult<Vec<Chunk>> {
    if key.0 == KIND_PAGE {
        let (title, summary, infobox, text): (String, String, String, String) = conn.query_row(
            "SELECT title, summary, infobox, content_text FROM pages WHERE id = ?1",
            [&key.1],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let body = format!("{summary}\n{}{text}", infobox_lines(&infobox));
        Ok(chunk_document(Some(&title), &body))
    } else {
        let (synopsis, text): (String, String) = conn.query_row(
            "SELECT synopsis, content_text FROM nodes WHERE id = ?1",
            [&key.1],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(chunk_document(None, &format!("{synopsis}\n{text}")))
    }
}

fn existing_hashes(conn: &Connection, key: &DocKey, model: &str) -> AppResult<HashMap<i64, String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT chunk_index, content_hash FROM embeddings WHERE entity_kind = ?1 AND entity_id = ?2 AND model = ?3",
    )?;
    let rows = stmt.query_map(params![key.0, key.1, model], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn vector_for_hash(conn: &Connection, key: &DocKey, model: &str, hash: &str) -> AppResult<Option<Vec<u8>>> {
    let mut stmt = conn.prepare_cached(
        "SELECT vector FROM embeddings WHERE entity_kind = ?1 AND entity_id = ?2 AND model = ?3 AND content_hash = ?4 LIMIT 1",
    )?;
    let mut rows = stmt.query(params![key.0, key.1, model, hash])?;
    Ok(match rows.next()? {
        Some(row) => Some(row.get(0)?),
        None => None,
    })
}

struct Row {
    kind: String,
    id: String,
    index: i64,
    hash: String,
    vector: Vec<u8>,
    snippet: String,
}

/// Writes waiting to go, so a scan of many documents is a few commits rather than thousands.
#[derive(Default)]
struct Pending {
    forget_docs: Vec<DocKey>,
    forget_rows: Vec<(DocKey, i64)>,
    rows: Vec<Row>,
}

impl Pending {
    fn is_empty(&self) -> bool {
        self.forget_docs.is_empty() && self.forget_rows.is_empty() && self.rows.is_empty()
    }

    fn apply(&mut self, tx: &Transaction, model: &str) -> AppResult<()> {
        {
            let mut forget = tx.prepare_cached("DELETE FROM embeddings WHERE entity_kind = ?1 AND entity_id = ?2")?;
            for key in &self.forget_docs {
                forget.execute(params![key.0, key.1])?;
            }
            let mut forget_row =
                tx.prepare_cached("DELETE FROM embeddings WHERE entity_kind = ?1 AND entity_id = ?2 AND chunk_index = ?3")?;
            for (key, index) in &self.forget_rows {
                forget_row.execute(params![key.0, key.1, index])?;
            }
            let mut insert = tx.prepare_cached(
                "INSERT OR REPLACE INTO embeddings (entity_kind, entity_id, chunk_index, content_hash, model, vector, snippet)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for row in &self.rows {
                insert.execute(params![row.kind, row.id, row.index, row.hash, model, row.vector, row.snippet])?;
            }
        }
        *self = Pending::default();
        Ok(())
    }

    fn flush(&mut self, engine: &Engine, shared: &Shared, session: &str, model: &str) -> AppResult<()> {
        if self.is_empty() {
            return Ok(());
        }
        same_session_write(engine, session, |tx| self.apply(tx, model))?;
        shared.touched();
        Ok(())
    }
}

/// A write that is dropped if another project was opened in the meantime.
fn same_session_write(engine: &Engine, session: &str, f: impl FnOnce(&Transaction) -> AppResult<()>) -> AppResult<()> {
    let still_open = engine.session().as_ref().is_some_and(|s| s.id == session);
    if !still_open {
        return Ok(());
    }
    write_quiet(engine, f)
}

/// Compares every changed document with what is indexed. Reuses any vector whose text has
/// not changed, even if it moved, and queues the rest.
fn scan(engine: &Engine, shared: &Shared, work: &mut Work, provider: &dyn Provider, session: &str) -> AppResult<()> {
    let model = provider.model_id();
    let current = engine.read(fingerprint)?;
    if work.scanned && current == work.fingerprint {
        return Ok(());
    }
    if work.seen.is_empty() {
        // The first look at this project. Rows from another model cannot be compared.
        write_quiet(engine, |tx| {
            tx.execute("DELETE FROM embeddings WHERE model <> ?1", [&model])?;
            Ok(())
        })?;
        shared.touched();
    }
    let documents = engine.read(list_documents)?;
    let live: HashSet<DocKey> = documents.iter().map(|d| d.key.clone()).collect();
    let anything_removed = !work.scanned || work.seen.keys().any(|key| !live.contains(key));
    work.seen.retain(|key, _| live.contains(key));
    work.skipped.retain(|key| live.contains(key));

    let cache = shared.cache(engine);
    let cloud = provider.is_cloud();
    let mut pending = Pending::default();
    let mut changed: HashSet<DocKey> = HashSet::new();
    let mut queue: Vec<Item> = Vec::new();
    for document in documents {
        if work.seen.get(&document.key) == Some(&document.stamp) {
            continue;
        }
        changed.insert(document.key.clone());
        if cloud && document.local_only {
            // Never sent, and nothing it was sent for earlier stays searchable either.
            pending.forget_docs.push(document.key.clone());
            work.skipped.insert(document.key.clone());
            work.seen.insert(document.key, document.stamp);
            continue;
        }
        work.skipped.remove(&document.key);
        let key = document.key.clone();
        let (chunks, existing) = engine.read(|conn| Ok((read_chunks(conn, &key)?, existing_hashes(conn, &key, &model)?)))?;

        // Rows that hold the right text in the right place need nothing.
        let needed: Vec<(i64, &Chunk)> = chunks
            .iter()
            .enumerate()
            .map(|(i, chunk)| (i as i64, chunk))
            .filter(|(i, chunk)| existing.get(i) != Some(&chunk.hash))
            .collect();
        for index in existing.keys() {
            if *index >= chunks.len() as i64 {
                pending.forget_rows.push((key.clone(), *index));
            }
        }
        if !needed.is_empty() {
            let hashes: Vec<&str> = needed.iter().map(|(_, chunk)| chunk.hash.as_str()).collect();
            let cached = match cache {
                Some(cache) => cache.get_many(&model, &hashes).unwrap_or_default(),
                None => HashMap::new(),
            };
            for (index, chunk) in needed {
                let reused = match cached.get(&chunk.hash) {
                    Some(vector) => Some(vector.clone()),
                    None if existing.values().any(|hash| hash == &chunk.hash) => {
                        engine.read(|conn| vector_for_hash(conn, &key, &model, &chunk.hash))?
                    }
                    None => None,
                };
                match reused {
                    Some(vector) => pending.rows.push(Row {
                        kind: key.0.clone(),
                        id: key.1.clone(),
                        index,
                        hash: chunk.hash.clone(),
                        vector,
                        snippet: chunk.snippet.clone(),
                    }),
                    None => {
                        // Its old row, if any, describes text that is gone.
                        if existing.contains_key(&index) {
                            pending.forget_rows.push((key.clone(), index));
                        }
                        queue.push(Item {
                            kind: key.0.clone(),
                            id: key.1.clone(),
                            index,
                            hash: chunk.hash.clone(),
                            text: chunk.text.clone(),
                            snippet: chunk.snippet.clone(),
                        });
                    }
                }
            }
        }
        work.seen.insert(document.key, document.stamp);
        if pending.rows.len() + pending.forget_rows.len() >= 256 {
            pending.flush(engine, shared, session, &model)?;
        }
    }
    pending.flush(engine, shared, session, &model)?;
    work.todo.retain(|item| live.contains(&(item.kind.clone(), item.id.clone())) && !changed.contains(&(item.kind.clone(), item.id.clone())));
    work.todo.extend(queue);
    if anything_removed {
        write_quiet(engine, |tx| {
            tx.execute_batch(
                "DELETE FROM embeddings WHERE entity_kind = 'page' AND entity_id NOT IN
                   (SELECT id FROM pages WHERE deleted_at IS NULL);
                 DELETE FROM embeddings WHERE entity_kind = 'node' AND entity_id NOT IN
                   (SELECT n.id FROM nodes n JOIN books b ON b.id = n.book_id
                     WHERE n.kind = 'scene' AND n.deleted_at IS NULL AND b.deleted_at IS NULL);",
            )?;
            Ok(())
        })?;
        shared.touched();
    }
    work.indexed = engine.read(|conn| {
        Ok(conn.query_row("SELECT COUNT(*) FROM embeddings WHERE model = ?1", [&model], |r| r.get::<_, i64>(0))? as usize)
    })?;
    work.fingerprint = current;
    work.scanned = true;
    Ok(())
}

/// Does one batch of whatever is waiting, and returns the status.
pub fn step(engine: &Engine) -> AppResult<Value> {
    let config = Config::of(engine);
    let shared = shared(engine);
    if !config.enabled {
        // Turned off, so the model's memory goes back.
        *shared.builtin.lock().unwrap_or_else(|e| e.into_inner()) = None;
        return Ok(status(engine));
    }
    let Some(session) = engine.session().as_ref().map(|s| s.id.clone()) else {
        return Ok(status(engine));
    };
    let provider = match provider_for(engine, &config) {
        Ok(provider) => provider,
        Err(e) if e.code == "NOT_SET_UP" => return Ok(status(engine)),
        Err(e) => {
            lock_work(&shared).failed = Some(e.message);
            return Ok(status(engine));
        }
    };
    let model = provider.model_id();
    let batch: Vec<Item> = {
        let mut work = lock_work(&shared);
        if work.session != session || work.model != model {
            work.reset();
            work.session = session.clone();
            work.model = model.clone();
        }
        if work.busy || work.is_paused_in(&session) {
            drop(work);
            return Ok(status(engine));
        }
        if let Err(e) = scan(engine, &shared, &mut work, provider.as_ref(), &session) {
            work.failed = Some(e.message);
            drop(work);
            return Ok(status(engine));
        }
        work.failed = None;
        let count = provider.batch_size().min(work.todo.len());
        let batch: Vec<Item> = work.todo.drain(..count).collect();
        work.in_flight = batch.len();
        work.busy = !batch.is_empty();
        batch
    };
    if batch.is_empty() {
        return Ok(status(engine));
    }

    // No lock of any kind is held here, so typing and saving carry on.
    let texts: Vec<String> = batch.iter().map(|item| item.text.clone()).collect();
    let outcome = provider.embed(&texts).and_then(|vectors| {
        if vectors.len() == batch.len() {
            Ok(vectors)
        } else {
            Err(AppError::new("BAD_REQUEST", "The model did not embed every passage."))
        }
    });

    let mut work = lock_work(&shared);
    work.busy = false;
    work.in_flight = 0;
    let vectors = match outcome {
        Ok(vectors) => vectors,
        Err(e) => {
            work.failed = Some(e.message);
            // Back to the front, to try again later.
            for item in batch.into_iter().rev() {
                work.todo.push_front(item);
            }
            drop(work);
            return Ok(status(engine));
        }
    };
    work.embedded += batch.len() as u64;
    let blobs: Vec<Vec<u8>> = vectors.iter().map(|v| to_blob(v)).collect();
    if let Some(cache) = shared.cache(engine) {
        let rows: Vec<(&str, &[u8])> = batch.iter().zip(&blobs).map(|(item, blob)| (item.hash.as_str(), blob.as_slice())).collect();
        if let Err(e) = cache.put_many(&model, &rows) {
            eprintln!("lorecraft: could not cache embeddings: {e}");
        }
    }
    let mut pending = Pending::default();
    let wrote = batch.len();
    for (item, vector) in batch.into_iter().zip(blobs) {
        pending.rows.push(Row { kind: item.kind, id: item.id, index: item.index, hash: item.hash, vector, snippet: item.snippet });
    }
    match pending.flush(engine, &shared, &session, &model) {
        Ok(()) => work.indexed += wrote,
        // The project may have closed between the two. The next step starts over.
        Err(e) if e.code == "NO_PROJECT" => work.reset(),
        Err(e) => work.failed = Some(e.message),
    }
    drop(work);
    Ok(status(engine))
}

/// Stops indexing until `resume`. Whatever is in flight finishes and is kept.
pub fn pause(engine: &Engine) {
    let session = engine.session().as_ref().map(|s| s.id.clone()).unwrap_or_default();
    lock_work(&shared(engine)).paused_in = session;
}

pub fn resume(engine: &Engine) {
    let shared = shared(engine);
    let mut work = lock_work(&shared);
    work.paused_in.clear();
    work.failed = None;
    shared.download.lock().unwrap_or_else(|e| e.into_inner()).failed = None;
}

/// Empties the index and starts it again.
pub fn clear(engine: &Engine) -> AppResult<()> {
    let shared = shared(engine);
    write_quiet(engine, |tx| {
        tx.execute("DELETE FROM embeddings", [])?;
        Ok(())
    })?;
    let mut work = lock_work(&shared);
    work.reset();
    work.failed = None;
    shared.touched();
    Ok(())
}

#[cfg(test)]
pub fn row_count(engine: &Engine) -> AppResult<i64> {
    engine.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))?))
}

/// Used by a provider check: one short text, with nothing kept.
pub fn check_provider(engine: &Engine, config: &Config) -> AppResult<usize> {
    let provider = provider_for(engine, config)?;
    let vectors = provider.embed(&["A short test of this model.".to_string()])?;
    let first = vectors.first().ok_or_else(|| AppError::new("BAD_REQUEST", "The model sent nothing back."))?;
    Ok(first.len())
}
