//! Finding the nearest passages, and merging them with keyword results.
//!
//! The search itself is a comparison with every vector, which is fast enough for any book:
//! see `searching_100k_chunks` in `rpc/embeddings.rs` for the measurement. The vectors are
//! kept in memory between searches and reloaded when rows change. How well it finds things in
//! a whole book is measured in `bench.rs`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::Ordering;

use lorecraft_minilm::score_all;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{from_blob, provider_for, shared, Config, Provider, Shared};
use crate::engine::Engine;
use crate::error::AppResult;
use crate::indexing::KIND_PAGE;

/// Below this, a passage has nothing to do with the question. With the built-in model,
/// unrelated text scores around zero, and "the knight at the gate" scores 0.27 against
/// "Aria guarded the northern door". Scores are measured from the middle of the project (see
/// `Centering`), and in a whole book in `bench.rs` the tenth scene found for a question still
/// scored 0.2 on average. OpenAI's models run a little higher, which only means a few more
/// weak results at the end of a list.
const MIN_SCORE: f32 = 0.15;
/// How many keyword results to weigh. The constant is the usual one for rank fusion.
const KEYWORD_POOL: i64 = 50;
const FUSION_K: f64 = 60.0;
const RECENT_QUERIES: usize = 32;
const LOAD_PAGE: i64 = 5000;

/// How many passages the average passage counts for, against nothing. A project of a few
/// passages has no meaningful average, so this keeps centering out of the way until there is one.
const CENTERING_PRIOR: f32 = 100.0;

/// Scores measured from the middle of the project rather than from nothing.
///
/// Every passage of one book has much in common: its people, its places, its way of putting
/// things. To a small model that is meaning too, so in a whole book every passage is about as
/// close to any question as the one that answers it. Taking the average passage away from each
/// passage and from the question leaves what each says that the rest of the book does not.
pub struct Centering {
    mean: Vec<f32>,
    mean_squared: f32,
    /// For each row, its dot product with the mean and its length once the mean is gone.
    rows: Vec<(f32, f32)>,
}

impl Centering {
    pub fn of(vectors: &[f32], dimensions: usize) -> Self {
        let count = if dimensions == 0 { 0 } else { vectors.len() / dimensions };
        let mut mean = vec![0.0_f32; dimensions];
        for row in vectors.chunks_exact(dimensions.max(1)) {
            for (total, value) in mean.iter_mut().zip(row) {
                *total += value;
            }
        }
        let scale = 1.0 / (count as f32 + CENTERING_PRIOR);
        for value in &mut mean {
            *value *= scale;
        }
        let mean_squared = mean.iter().map(|v| v * v).sum::<f32>();
        let mut with_mean = Vec::new();
        score_all(&mean, vectors, &mut with_mean);
        let rows = with_mean
            .into_iter()
            .map(|m| (m, (1.0 - 2.0 * m + mean_squared).max(1e-6).sqrt()))
            .collect();
        Self { mean, mean_squared, rows }
    }

    /// Turns plain cosines, as `score_all` gives them, into cosines from the middle.
    pub fn adjust(&self, query: &[f32], scores: &mut [f32]) {
        let with_mean: f32 = query.iter().zip(&self.mean).map(|(a, b)| a * b).sum();
        let query_length = (1.0 - 2.0 * with_mean + self.mean_squared).max(1e-6).sqrt();
        for (score, (row_with_mean, row_length)) in scores.iter_mut().zip(&self.rows) {
            *score = (*score - row_with_mean - with_mean + self.mean_squared) / (query_length * row_length);
        }
    }
}

#[derive(Default)]
pub struct Memory {
    session: String,
    model: String,
    generation: u64,
    loaded: bool,
    dimensions: usize,
    vectors: Vec<f32>,
    /// One per row of `vectors`.
    rows: Vec<RowInfo>,
    centering: Option<Centering>,
    scores: Vec<f32>,
}

struct RowInfo {
    is_page: bool,
    id: String,
    chunk: i64,
}

impl Memory {
    fn load(&mut self, engine: &Engine, shared: &Shared, model: &str) -> AppResult<()> {
        let session = engine.session().as_ref().map(|s| s.id.clone()).unwrap_or_default();
        // Read this first, so that rows changing during the load cause another next time.
        let generation = shared.generation.load(Ordering::SeqCst);
        if self.loaded && self.session == session && self.model == model && self.generation == generation {
            return Ok(());
        }
        self.vectors.clear();
        self.rows.clear();
        self.centering = None;
        self.dimensions = 0;
        let mut after = 0_i64;
        // In pages, so a huge index never holds up the writer for long.
        loop {
            let mut last = None;
            engine.read(|conn| {
                let mut stmt = conn.prepare_cached(
                    "SELECT rowid, entity_kind, entity_id, chunk_index, vector FROM embeddings
                     WHERE model = ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3",
                )?;
                let mut rows = stmt.query(params![model, after, LOAD_PAGE])?;
                while let Some(row) = rows.next()? {
                    last = Some(row.get::<_, i64>(0)?);
                    let vector = from_blob(row.get_ref(4)?.as_blob().unwrap_or(&[]));
                    if self.dimensions == 0 {
                        self.dimensions = vector.len();
                    }
                    if vector.len() != self.dimensions || vector.is_empty() {
                        continue;
                    }
                    self.vectors.extend_from_slice(&vector);
                    self.rows.push(RowInfo {
                        is_page: row.get_ref(1)?.as_str().unwrap_or("") == KIND_PAGE,
                        id: row.get(2)?,
                        chunk: row.get(3)?,
                    });
                }
                Ok(())
            })?;
            match last {
                Some(id) => after = id,
                None => break,
            }
        }
        self.centering = Some(Centering::of(&self.vectors, self.dimensions));
        self.session = session;
        self.model = model.to_string();
        self.generation = generation;
        self.loaded = true;
        Ok(())
    }
}

/// Query vectors already computed, since one search can run several times.
#[derive(Default)]
pub struct RecentQueries {
    entries: VecDeque<(String, String, Vec<f32>)>,
}

fn query_vector(shared: &Shared, provider: &dyn Provider, q: &str) -> AppResult<Vec<f32>> {
    let model = provider.model_id();
    {
        let recent = shared.queries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, _, vector)) = recent.entries.iter().find(|(m, text, _)| *m == model && text == q) {
            return Ok(vector.clone());
        }
    }
    let vector = provider.embed(&[q.to_string()])?.into_iter().next().unwrap_or_default();
    let mut recent = shared.queries.lock().unwrap_or_else(|e| e.into_inner());
    recent.entries.push_back((model, q.to_string(), vector.clone()));
    if recent.entries.len() > RECENT_QUERIES {
        recent.entries.pop_front();
    }
    Ok(vector)
}

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchParams {
    pub q: String,
    pub limit: Option<usize>,
    /// `page`, `node`. Empty or absent means both.
    pub kinds: Option<Vec<String>>,
    /// How many passages one document may contribute. One unless asked for more.
    pub per_doc: Option<usize>,
    /// Leaves out local-only documents, for results that are going on to a cloud model.
    pub exclude_local_only: bool,
}

#[derive(Debug, Clone)]
pub struct Hit {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub book_id: Option<String>,
    pub snippet: String,
    pub score: f32,
}

impl Hit {
    fn to_json(&self) -> Value {
        json!({
            "kind": self.kind,
            "id": self.id,
            "title": self.title,
            "bookId": self.book_id,
            "snippet": self.snippet,
            "score": self.score,
        })
    }
}

/// A document's title and book if it is live, and allowed. Results come from an index that
/// may be a moment behind, so this is checked at the last moment.
fn document_info(conn: &rusqlite::Connection, is_page: bool, id: &str, exclude_local_only: bool) -> AppResult<Option<(String, Option<String>)>> {
    use rusqlite::OptionalExtension;
    let sql = if is_page {
        "SELECT title, NULL, local_only FROM pages WHERE id = ?1 AND deleted_at IS NULL"
    } else {
        "SELECT n.title, n.book_id, n.local_only FROM nodes n JOIN books b ON b.id = n.book_id
          WHERE n.id = ?1 AND n.deleted_at IS NULL AND b.deleted_at IS NULL"
    };
    let found: Option<(String, Option<String>, i64)> =
        conn.query_row(sql, [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
    Ok(found.filter(|(_, _, local_only)| !(exclude_local_only && *local_only != 0)).map(|(title, book, _)| (title, book)))
}

/// The passages nearest in meaning, best first.
pub fn search(engine: &Engine, params: &SearchParams) -> AppResult<Vec<Hit>> {
    let q = params.q.trim();
    let config = Config::of(engine);
    if q.is_empty() || !config.enabled {
        return Ok(Vec::new());
    }
    let provider = match provider_for(engine, &config) {
        Ok(provider) => provider,
        Err(e) if e.code == "NOT_SET_UP" => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let shared = shared(engine);
    let model = provider.model_id();
    // Nothing indexed yet means nothing to find, so the provider is not bothered.
    let any: bool = engine.read(|conn| {
        Ok(conn.query_row("SELECT EXISTS (SELECT 1 FROM embeddings WHERE model = ?1)", [&model], |r| r.get(0))?)
    })?;
    if !any {
        return Ok(Vec::new());
    }
    let query = query_vector(&shared, provider.as_ref(), q)?;
    let limit = params.limit.unwrap_or(20).clamp(1, 200);
    let per_doc = params.per_doc.unwrap_or(1).max(1);
    let want_kind = |is_page: bool| match &params.kinds {
        Some(kinds) if !kinds.is_empty() => kinds.iter().any(|k| (k == KIND_PAGE) == is_page),
        _ => true,
    };

    let mut memory = shared.memory.lock().unwrap_or_else(|e| e.into_inner());
    memory.load(engine, &shared, &model)?;
    if query.len() != memory.dimensions {
        return Ok(Vec::new());
    }
    let Memory { vectors, rows, scores, centering, .. } = &mut *memory;
    score_all(&query, vectors, scores);
    if let Some(centering) = centering {
        centering.adjust(&query, scores);
    }
    let mut order: Vec<usize> = (0..rows.len())
        .filter(|&i| scores[i] >= MIN_SCORE && want_kind(rows[i].is_page))
        .collect();
    order.sort_unstable_by(|&a, &b| scores[b].total_cmp(&scores[a]));

    engine.read(|conn| {
        let mut hits = Vec::new();
        let mut per_document: HashMap<&str, usize> = HashMap::new();
        let mut known: HashMap<&str, Option<(String, Option<String>)>> = HashMap::new();
        let mut snippet = conn.prepare_cached(
            "SELECT snippet FROM embeddings WHERE entity_kind = ?1 AND entity_id = ?2 AND chunk_index = ?3",
        )?;
        for i in order {
            let row = &rows[i];
            let count = per_document.entry(row.id.as_str()).or_insert(0);
            if *count >= per_doc {
                continue;
            }
            let info = match known.get(row.id.as_str()) {
                Some(info) => info.clone(),
                None => {
                    let info = document_info(conn, row.is_page, &row.id, params.exclude_local_only)?;
                    known.insert(row.id.as_str(), info.clone());
                    info
                }
            };
            let Some((title, book_id)) = info else { continue };
            *count += 1;
            let kind = if row.is_page { "page" } else { "node" };
            let text: String = snippet.query_row(params![kind, row.id, row.chunk], |r| r.get(0)).unwrap_or_default();
            hits.push(Hit { kind: kind.to_string(), id: row.id.clone(), title, book_id, snippet: text, score: scores[i] });
            if hits.len() >= limit {
                break;
            }
        }
        Ok(hits)
    })
}

/// Keyword and meaning results merged by reciprocal rank fusion, one entry per document, so
/// something found both ways rises above something found one way. With no index, or if the
/// model cannot be reached, this is simply the keyword results.
pub fn hybrid(engine: &Engine, params: &SearchParams) -> AppResult<Value> {
    let limit = params.limit.unwrap_or(20).clamp(1, 200);
    let kinds = params.kinds.clone().unwrap_or_default();
    let keyword_kind = if kinds.len() == 1 { Some(kinds[0].clone()) } else { None };
    let keyword = crate::rpc::dispatch(engine, "search.query", json!({ "q": params.q, "kind": keyword_kind, "limit": KEYWORD_POOL }))?;
    let keyword = keyword.as_array().cloned().unwrap_or_default();

    let meaning_params = SearchParams { limit: Some(limit.max(20)), ..params.clone() };
    let (meaning, problem) = match search(engine, &meaning_params) {
        Ok(hits) => (hits, None),
        Err(e) => (Vec::new(), Some(e.message)),
    };

    struct Merged {
        value: Value,
        score: f64,
        keyword: bool,
        meaning: bool,
    }
    let mut merged: HashMap<(String, String), Merged> = HashMap::new();
    let mut hidden: HashSet<String> = HashSet::new();
    for (rank, hit) in keyword.iter().enumerate() {
        let kind = hit["kind"].as_str().unwrap_or("").to_string();
        let id = hit["id"].as_str().unwrap_or("").to_string();
        if params.exclude_local_only {
            let is_page = kind == KIND_PAGE;
            let allowed = engine.read(|conn| document_info(conn, is_page, &id, true))?;
            if allowed.is_none() {
                hidden.insert(id);
                continue;
            }
        }
        merged.insert(
            (kind, id),
            Merged { value: hit.clone(), score: 1.0 / (FUSION_K + rank as f64 + 1.0), keyword: true, meaning: false },
        );
    }
    for (rank, hit) in meaning.iter().enumerate() {
        let entry = merged.entry((hit.kind.clone(), hit.id.clone())).or_insert_with(|| Merged {
            value: hit.to_json(),
            score: 0.0,
            keyword: false,
            meaning: false,
        });
        entry.score += 1.0 / (FUSION_K + rank as f64 + 1.0);
        entry.meaning = true;
        // The passage says more than a line around a keyword.
        entry.value["snippet"] = json!(hit.snippet);
        entry.value["meaningScore"] = json!(hit.score);
    }
    let mut results: Vec<Merged> = merged.into_values().collect();
    results.sort_by(|a, b| b.score.total_cmp(&a.score));
    results.truncate(limit);
    let results: Vec<Value> = results
        .into_iter()
        .map(|entry| {
            let mut value = entry.value;
            value["score"] = json!(entry.score);
            value["matchedBy"] = match (entry.keyword, entry.meaning) {
                (true, true) => json!(["keyword", "meaning"]),
                (true, false) => json!(["keyword"]),
                _ => json!(["meaning"]),
            };
            value
        })
        .collect();
    Ok(json!({ "results": results, "problem": problem }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(mut v: Vec<f32>) -> Vec<f32> {
        crate::embeddings::normalize(&mut v);
        v
    }

    fn scores_for(query: &[f32], vectors: &[f32], centering: Option<&Centering>) -> Vec<f32> {
        let mut scores = Vec::new();
        score_all(query, vectors, &mut scores);
        if let Some(centering) = centering {
            centering.adjust(query, &mut scores);
        }
        scores
    }

    #[test]
    fn centering_looks_past_what_every_passage_has_in_common() {
        // Three hundred passages much like each other, and one that answers the question.
        let mut vectors = Vec::new();
        for i in 0..300 {
            vectors.extend(unit(vec![1.0, 0.1 * ((i % 7) as f32 - 3.0), 0.0]));
        }
        vectors.extend(unit(vec![0.6, 0.0, 0.8]));
        let query = unit(vec![0.95, 0.0, 0.4]);
        let best = |scores: &[f32]| (0..scores.len()).max_by(|&a, &b| scores[a].total_cmp(&scores[b])).unwrap();
        assert_ne!(best(&scores_for(&query, &vectors, None)), 300, "the plain cosine prefers the crowd");
        let centering = Centering::of(&vectors, 3);
        assert_eq!(best(&scores_for(&query, &vectors, Some(&centering))), 300);
    }

    #[test]
    fn a_small_project_is_scored_almost_as_before() {
        let vectors: Vec<f32> = [unit(vec![1.0, 0.2, 0.0]), unit(vec![0.0, 1.0, 0.3])].concat();
        let query = unit(vec![0.7, 0.7, 0.1]);
        let plain = scores_for(&query, &vectors, None);
        let centered = scores_for(&query, &vectors, Some(&Centering::of(&vectors, 3)));
        for (a, b) in plain.iter().zip(&centered) {
            assert!((a - b).abs() < 0.03, "{a} against {b}");
        }
    }
}
