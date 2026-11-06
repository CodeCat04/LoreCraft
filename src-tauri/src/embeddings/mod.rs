//! Search by meaning. Pages and scenes are split into passages, each passage becomes a
//! vector, and a search looks for the nearest vectors, so "the knight at the gate" finds
//! "Aria guarded the northern door".
//!
//! Where a vector comes from is behind `Provider`: the built-in model (`builtin`), a
//! provider profile (`remote`), or a deterministic stand-in in tests (`fake`).
//!
//! The index is derived data, so writing it does not count as an edit. See `index` for what
//! that means for saving, and `cache` for why nothing is lost by it.

#[cfg(test)]
mod bench;
pub mod builtin;
pub mod cache;
pub mod chunk;
pub mod fake;
pub mod index;
pub mod remote;
pub mod search;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::{Transaction, TransactionBehavior};
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::paths;

/// Turns text into vectors. Every vector has length 1, so a dot product is a cosine.
pub trait Provider: Send + Sync {
    /// Names the vector space, and is stored with each vector. Changing it re-indexes.
    fn model_id(&self) -> String;
    /// Local-only text is never given to a provider that says yes here.
    fn is_cloud(&self) -> bool;
    /// How many passages to hand over at once.
    fn batch_size(&self) -> usize;
    fn embed(&self, texts: &[String]) -> AppResult<Vec<Vec<f32>>>;
}

pub fn normalize(vector: &mut [f32]) {
    let length = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if length > 0.0 {
        for value in vector {
            *value /= length;
        }
    }
}

pub fn to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|v| v.to_le_bytes()).collect()
}

pub fn from_blob(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

// ---- Settings ---------------------------------------------------------------

/// `settings.ai.embeddings`. Its shape and defaults are in `src/lib/settings.ts`.
#[derive(Debug, Clone, Default)]
pub struct Config {
    pub enabled: bool,
    /// `builtin`, `profile`, or in tests `fake`.
    pub source: String,
    pub profile_id: String,
    pub model: String,
    /// Tests only: makes the stand-in say it is a cloud provider.
    pub fake_cloud: bool,
}

impl Config {
    pub fn read(settings: &Value) -> Self {
        let section = settings.pointer("/ai/embeddings");
        let text = |key: &str| section.and_then(|s| s.get(key)).and_then(Value::as_str).unwrap_or("").to_string();
        let flag = |key: &str| section.and_then(|s| s.get(key)).and_then(Value::as_bool).unwrap_or(false);
        let source = text("source");
        Self {
            enabled: flag("enabled"),
            source: if source.is_empty() { "builtin".to_string() } else { source },
            profile_id: text("profileId"),
            model: text("model"),
            fake_cloud: flag("fakeCloud"),
        }
    }

    pub fn of(engine: &Engine) -> Self {
        Self::read(&engine.settings())
    }

    /// What to show the writer as the model's name.
    pub fn display_model(&self) -> String {
        match self.source.as_str() {
            "builtin" => builtin::MODEL_NAME.to_string(),
            "fake" => fake::MODEL.to_string(),
            _ => self.model.trim().to_string(),
        }
    }
}

/// The provider the settings ask for.
pub fn provider_for(engine: &Engine, config: &Config) -> AppResult<Arc<dyn Provider>> {
    match config.source.as_str() {
        "builtin" => Ok(Arc::new(builtin::provider(engine)?)),
        "profile" => Ok(Arc::new(remote::provider(engine, config)?)),
        "fake" if cfg!(test) || paths::is_e2e() => Ok(Arc::new(fake::FakeProvider {
            cloud: config.fake_cloud,
            model: if config.model.is_empty() { fake::MODEL.to_string() } else { format!("fake:{}", config.model) },
        })),
        other => Err(AppError::invalid(format!("Unknown embeddings source: {other}"))),
    }
}

// ---- State that lives as long as the app --------------------------------------

/// Everything kept in memory between calls, one per data folder.
#[derive(Default)]
pub struct Shared {
    pub work: Mutex<index::Work>,
    pub download: Mutex<builtin::DownloadState>,
    pub cancel_download: AtomicBool,
    pub builtin: Mutex<Option<Arc<builtin::Loaded>>>,
    pub cache: OnceLock<Option<cache::VectorCache>>,
    pub memory: Mutex<search::Memory>,
    pub queries: Mutex<search::RecentQueries>,
    /// Changes whenever rows change, so the vectors in memory know when they are stale.
    pub generation: AtomicU64,
}

impl Shared {
    pub fn cache(&self, engine: &Engine) -> Option<&cache::VectorCache> {
        self.cache
            .get_or_init(|| match cache::VectorCache::open(&engine.paths) {
                Ok(cache) => Some(cache),
                Err(e) => {
                    // Slower, but everything still works without it.
                    eprintln!("lorecraft: no embeddings cache: {e}");
                    None
                }
            })
            .as_ref()
    }

    pub fn touched(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// The engine's state. `dispatch` only has a `&Engine`, and this keeps the core struct out of
/// it, as `ai::registry` does for streams.
pub fn shared(engine: &Engine) -> Arc<Shared> {
    static ALL: OnceLock<Mutex<HashMap<PathBuf, Arc<Shared>>>> = OnceLock::new();
    let mut all = ALL.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner());
    all.entry(engine.paths.root.clone()).or_default().clone()
}

/// One transaction on the working copy that does not mark the project as changed. Only for
/// the index, which is derived from what is already there.
pub fn write_quiet<T>(engine: &Engine, f: impl FnOnce(&Transaction) -> AppResult<T>) -> AppResult<T> {
    let mut guard = engine.session();
    let session = guard.as_mut().ok_or_else(AppError::no_project)?;
    let tx = session.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let value = f(&tx)?;
    tx.commit()?;
    Ok(value)
}

// ---- Status -----------------------------------------------------------------

/// Everything the status bar and settings show.
pub fn status(engine: &Engine) -> Value {
    let config = Config::of(engine);
    let shared = shared(engine);
    let work = shared.work.lock().unwrap_or_else(|e| e.into_inner());
    let download = shared.download.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let session = engine.session().as_ref().map(|s| s.id.clone());
    let open = session.is_some();
    let builtin_present = builtin::is_present(&engine.paths.root);

    let source_problem = match config.source.as_str() {
        "builtin" if !builtin_present => Some(String::new()),
        "profile" if config.model.trim().is_empty() => Some("Enter the name of an embeddings model.".to_string()),
        _ => None,
    };
    let state = if !config.enabled {
        "off"
    } else if config.source == "builtin" && download.running {
        "downloading"
    } else if config.source == "builtin" && download.failed.is_some() && !builtin_present {
        "failed"
    } else if source_problem.is_some() {
        "notSetUp"
    } else if !open {
        "noProject"
    } else if work.failed.is_some() {
        "failed"
    } else if session.as_deref().is_some_and(|id| work.is_paused_in(id)) {
        "paused"
    } else if work.is_indexing() {
        "indexing"
    } else if work.scanned {
        "ready"
    } else {
        "indexing"
    };
    let message = match state {
        "failed" if config.source == "builtin" && download.failed.is_some() && !builtin_present => download.failed.clone(),
        "failed" => work.failed.clone(),
        "notSetUp" => source_problem.filter(|m| !m.is_empty()),
        _ => None,
    };
    let is_cloud = match config.source.as_str() {
        "profile" => {
            let settings = engine.settings();
            crate::ai::profile::Profile::from_settings(&settings, &config.profile_id).is_ok_and(|p| remote::profile_is_cloud(&p))
        }
        "fake" => config.fake_cloud,
        _ => false,
    };
    // Turned off, an index stays in the project until the writer removes it, so say it is there.
    let leftover = if state == "off" && open {
        engine.read(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get::<_, i64>(0))?)).unwrap_or(0)
    } else {
        0
    };
    json!({
        "state": state,
        "leftoverPassages": leftover,
        "source": config.source,
        "model": config.display_model(),
        "isCloud": is_cloud,
        "done": work.indexed,
        "total": work.indexed + work.pending(),
        "skippedLocalOnly": work.skipped.len(),
        "embedded": work.embedded,
        "downloaded": download.got,
        "downloadTotal": if download.total > 0 { download.total } else { builtin::total_bytes() },
        "builtinPresent": builtin_present,
        "message": message,
    })
}
