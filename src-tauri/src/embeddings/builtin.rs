//! The built-in model: all-MiniLM-L6-v2, run on the CPU by the `lorecraft-minilm` crate.
//!
//! It is not in the installer. The writer agrees to a download of a known size, which comes
//! from a pinned revision and is checked against a known checksum. After that, nothing about
//! it uses the network.

use std::collections::HashMap;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use lorecraft_minilm::{Bert, Tensor, Tokenizer};
use reqwest::header::RANGE;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{shared, Provider};
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::paths;

pub const MODEL_NAME: &str = "all-MiniLM-L6-v2";
pub const MODEL_ID: &str = "builtin:all-MiniLM-L6-v2";
/// The model's own limit, including the start and end markers.
const MAX_TOKENS: usize = 256;
const DOWNLOAD_BASE: &str =
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/1110a243fdf4706b3f48f1d95db1a4f5529b4d41";
const STALL_LIMIT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy)]
pub struct FileSpec {
    pub name: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

pub const FILES: [FileSpec; 2] = [
    FileSpec {
        name: "model.safetensors",
        bytes: 90_868_376,
        sha256: "53aa51172d142c89d9012cce15ae4d6cc0ca6895895114379cacb4fab128d9db",
    },
    FileSpec {
        name: "vocab.txt",
        bytes: 231_508,
        sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
    },
];

pub fn total_bytes() -> u64 {
    FILES.iter().map(|f| f.bytes).sum()
}

pub fn model_dir(root: &Path) -> PathBuf {
    root.join("models").join(MODEL_NAME)
}

/// Whether the model has been downloaded. Each file was checked when it arrived.
pub fn is_present(root: &Path) -> bool {
    let dir = model_dir(root);
    FILES.iter().all(|f| std::fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.bytes))
}

// ---- Downloading ------------------------------------------------------------

/// How the download is going, for the status bar and settings.
#[derive(Debug, Clone, Default)]
pub struct DownloadState {
    pub running: bool,
    pub got: u64,
    pub total: u64,
    pub failed: Option<String>,
}

fn sha256_of_file(path: &Path) -> AppResult<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn cancelled_error() -> AppError {
    AppError::new("CANCELLED", "The download was stopped.")
}

async fn fetch_one(
    client: &reqwest::Client,
    base: &str,
    spec: &FileSpec,
    dir: &Path,
    report: &(dyn Fn(u64) + Sync),
    stop: &(dyn Fn() -> bool + Sync),
) -> AppResult<()> {
    let target = dir.join(spec.name);
    let partial = dir.join(format!("{}.part", spec.name));
    let mut have = std::fs::metadata(&partial).map_or(0, |m| m.len());
    if have > spec.bytes {
        std::fs::remove_file(&partial)?;
        have = 0;
    }
    let mut request = client.get(format!("{base}/{}", spec.name));
    if have > 0 {
        request = request.header(RANGE, format!("bytes={have}-"));
    }
    let unreachable = |e: reqwest::Error| {
        AppError::new(
            "DOWNLOAD_FAILED",
            format!("Could not download the model: {}. Check your internet connection and try again.", e.without_url()),
        )
    };
    let response = request.send().await.map_err(unreachable)?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new(
            "DOWNLOAD_FAILED",
            format!("The download server answered {status}. Try again later."),
        ));
    }
    // A server that ignored the range sends the whole file from the start.
    let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut file = std::fs::OpenOptions::new().create(true).write(true).truncate(false).open(&partial)?;
    if resumed {
        file.seek(std::io::SeekFrom::End(0))?;
    } else {
        file.set_len(0)?;
        have = 0;
    }
    report(have);
    let mut stream = response.bytes_stream();
    loop {
        if stop() {
            return Err(cancelled_error());
        }
        let next = tokio::time::timeout(STALL_LIMIT, stream.next())
            .await
            .map_err(|_| AppError::new("DOWNLOAD_FAILED", "The download stopped responding. Try again, and it will carry on from where it was."))?;
        let Some(piece) = next else { break };
        let piece = piece.map_err(unreachable)?;
        file.write_all(&piece)?;
        have += piece.len() as u64;
        report(have);
    }
    file.sync_all()?;
    drop(file);
    let actual = sha256_of_file(&partial)?;
    if actual != spec.sha256 || have != spec.bytes {
        std::fs::remove_file(&partial)?;
        return Err(AppError::new(
            "BAD_CHECKSUM",
            format!("{} arrived damaged, so it was deleted. Try the download again.", spec.name),
        ));
    }
    std::fs::rename(&partial, &target)?;
    Ok(())
}

/// Downloads whatever is missing. Each file appears under its real name only once its
/// checksum has passed, and an interrupted file carries on from where it stopped.
pub async fn fetch_files(
    base: &str,
    files: &[FileSpec],
    dir: &Path,
    report: &(dyn Fn(u64) + Sync),
    stop: &(dyn Fn() -> bool + Sync),
) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .user_agent(concat!("LoreCraft/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| AppError::internal(e.to_string()))?;
    let mut finished = 0;
    for spec in files {
        let target = dir.join(spec.name);
        if !std::fs::metadata(&target).is_ok_and(|m| m.len() == spec.bytes) {
            let before = finished;
            let progress = move |have: u64| report(before + have);
            fetch_one(&client, base, spec, dir, &progress, stop).await?;
        }
        finished += spec.bytes;
        report(finished);
    }
    Ok(())
}

/// The E2E tests serve the files themselves, so they run without the internet.
fn download_base() -> String {
    if paths::is_e2e() {
        if let Ok(url) = std::env::var("LORECRAFT_MODEL_URL") {
            return url;
        }
    }
    DOWNLOAD_BASE.to_string()
}

/// Runs the download to its end. Called only after the writer has agreed to it.
pub fn download(engine: &Engine) -> AppResult<()> {
    let shared = shared(engine);
    {
        let mut state = shared.download.lock().unwrap_or_else(|e| e.into_inner());
        if state.running {
            return Ok(());
        }
        *state = DownloadState { running: true, got: 0, total: total_bytes(), failed: None };
    }
    shared.cancel_download.store(false, Ordering::SeqCst);
    let dir = model_dir(&engine.paths.root);
    let report_to = shared.clone();
    let stop_on = shared.clone();
    let report = move |got: u64| {
        report_to.download.lock().unwrap_or_else(|e| e.into_inner()).got = got;
    };
    let stop = move || stop_on.cancel_download.load(Ordering::SeqCst);
    let outcome = tauri::async_runtime::block_on(fetch_files(&download_base(), &FILES, &dir, &report, &stop));
    let mut state = shared.download.lock().unwrap_or_else(|e| e.into_inner());
    state.running = false;
    match outcome {
        Ok(()) => {
            state.failed = None;
            Ok(())
        }
        // Stopping on purpose is not a failure, so it goes back to the question.
        Err(e) if e.code == "CANCELLED" => Ok(()),
        Err(e) => {
            state.failed = Some(e.message.clone());
            Err(e)
        }
    }
}

/// Deletes the downloaded model. Vectors already made from it stay, but nothing new can be
/// embedded until it is downloaded again.
pub fn remove(engine: &Engine) -> AppResult<()> {
    let shared = shared(engine);
    if shared.download.lock().unwrap_or_else(|e| e.into_inner()).running {
        return Err(AppError::invalid("The model is still downloading."));
    }
    *shared.builtin.lock().unwrap_or_else(|e| e.into_inner()) = None;
    shared.download.lock().unwrap_or_else(|e| e.into_inner()).failed = None;
    let dir = model_dir(&engine.paths.root);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

// ---- Loading ----------------------------------------------------------------

/// Reads a safetensors file: a length, a JSON table of contents, then raw little-endian data.
fn read_safetensors(path: &Path) -> AppResult<(Vec<u8>, HashMap<String, Value>, usize)> {
    let bad = || AppError::new("MODEL_DAMAGED", "The built-in model's files are damaged. Remove and download it again.");
    let bytes = std::fs::read(path)?;
    let header_len = bytes.get(..8).and_then(|b| b.try_into().ok()).map(u64::from_le_bytes).ok_or_else(bad)? as usize;
    let header = bytes.get(8..8 + header_len).ok_or_else(bad)?;
    let table: HashMap<String, Value> = serde_json::from_slice(header).map_err(|_| bad())?;
    Ok((bytes, table, 8 + header_len))
}

fn tensor_from(entry: &Value, data: &[u8]) -> Option<Tensor> {
    if entry.get("dtype")?.as_str()? != "F32" {
        return None;
    }
    let shape: Vec<usize> = entry.get("shape")?.as_array()?.iter().map(|d| d.as_u64().map(|d| d as usize)).collect::<Option<_>>()?;
    let offsets = entry.get("data_offsets")?.as_array()?;
    let (start, end) = (offsets.first()?.as_u64()? as usize, offsets.get(1)?.as_u64()? as usize);
    let raw = data.get(start..end)?;
    if raw.len() != shape.iter().product::<usize>() * 4 {
        return None;
    }
    let values = raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    Some(Tensor { shape, data: values })
}

pub struct Loaded {
    pub bert: Bert,
    pub tokenizer: Tokenizer,
}

pub fn load_from(dir: &Path) -> AppResult<Loaded> {
    let damaged = |detail: String| AppError::new("MODEL_DAMAGED", format!("The built-in model could not be read: {detail}"));
    let vocab = std::fs::read_to_string(dir.join("vocab.txt"))?;
    let tokenizer = Tokenizer::from_vocab(&vocab).map_err(damaged)?;
    let (bytes, table, offset) = read_safetensors(&dir.join("model.safetensors"))?;
    let data = &bytes[offset..];
    let bert = Bert::from_tensors(|name| tensor_from(table.get(name)?, data)).map_err(damaged)?;
    Ok(Loaded { bert, tokenizer })
}

// ---- Running ----------------------------------------------------------------

/// Indexing yields to whatever the writer is doing.
#[cfg(windows)]
fn lower_this_threads_priority() {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThread() -> *mut c_void;
        fn SetThreadPriority(thread: *mut c_void, priority: i32) -> i32;
    }
    const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
    // SAFETY: both calls act only on the calling thread, through its pseudo-handle.
    unsafe {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

#[cfg(not(windows))]
fn lower_this_threads_priority() {}

fn worker_count() -> usize {
    let cores = std::thread::available_parallelism().map_or(2, |n| n.get());
    (cores / 2).clamp(1, 4)
}

pub struct BuiltinProvider {
    loaded: Arc<Loaded>,
}

impl BuiltinProvider {
    /// A model loaded from somewhere else, for measuring.
    #[cfg(test)]
    pub fn from_loaded(loaded: Loaded) -> Self {
        Self { loaded: Arc::new(loaded) }
    }
}

/// The provider, loading the model the first time. Takes a moment, so it is kept.
pub fn provider(engine: &Engine) -> AppResult<BuiltinProvider> {
    if !is_present(&engine.paths.root) {
        return Err(AppError::new("NOT_SET_UP", "The built-in model has not been downloaded."));
    }
    let shared = shared(engine);
    let mut slot: std::sync::MutexGuard<'_, Option<Arc<Loaded>>> = shared.builtin.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(loaded) = slot.as_ref() {
        return Ok(BuiltinProvider { loaded: loaded.clone() });
    }
    let loaded = Arc::new(load_from(&model_dir(&engine.paths.root))?);
    *slot = Some(loaded.clone());
    Ok(BuiltinProvider { loaded })
}

impl Provider for BuiltinProvider {
    fn model_id(&self) -> String {
        MODEL_ID.to_string()
    }

    fn is_cloud(&self) -> bool {
        false
    }

    fn batch_size(&self) -> usize {
        worker_count() * 2
    }

    fn embed(&self, texts: &[String]) -> AppResult<Vec<Vec<f32>>> {
        let Loaded { bert, tokenizer } = &*self.loaded;
        let encode = |text: &String| bert.encode(&tokenizer.encode(text, MAX_TOKENS));
        // A search waits for this one, so it runs at normal priority and on this thread.
        if let [only] = texts {
            return Ok(vec![encode(only)]);
        }
        let next = AtomicUsize::new(0);
        let results: Vec<Mutex<Vec<f32>>> = texts.iter().map(|_| Mutex::new(Vec::new())).collect();
        std::thread::scope(|scope| {
            for _ in 0..worker_count().min(texts.len()) {
                scope.spawn(|| {
                    lower_this_threads_priority();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(text) = texts.get(i) else { break };
                        *results[i].lock().unwrap_or_else(|e| e.into_inner()) = encode(text);
                    }
                });
            }
        });
        Ok(results.into_iter().map(|m| m.into_inner().unwrap_or_else(|e| e.into_inner())).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::transport::tests::{serve, Reply};
    use crate::engine::TestDir;

    const HELLO_SHA: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    fn file_reply(status: &str, body: &str) -> Reply {
        Reply {
            head: format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()),
            pieces: vec![(0, body.to_string())],
        }
    }

    fn fetch(url: &str, spec: FileSpec, dir: &Path) -> AppResult<()> {
        tauri::async_runtime::block_on(fetch_files(url, &[spec], dir, &|_| {}, &|| false))
    }

    #[test]
    fn a_download_with_the_right_checksum_arrives_under_its_real_name() {
        let dir = TestDir::new();
        let server = serve(vec![file_reply("200 OK", "hello")]);
        let spec = FileSpec { name: "a.bin", bytes: 5, sha256: HELLO_SHA };
        fetch(&server.url, spec, &dir.0).unwrap();
        assert_eq!(std::fs::read(dir.0.join("a.bin")).unwrap(), b"hello");
        assert!(!dir.0.join("a.bin.part").exists());
    }

    #[test]
    fn a_damaged_download_is_refused_and_deleted() {
        let dir = TestDir::new();
        let server = serve(vec![file_reply("200 OK", "jello")]);
        let spec = FileSpec { name: "a.bin", bytes: 5, sha256: HELLO_SHA };
        let error = fetch(&server.url, spec, &dir.0).unwrap_err();
        assert_eq!(error.code, "BAD_CHECKSUM");
        assert!(!dir.0.join("a.bin").exists());
        assert!(!dir.0.join("a.bin.part").exists());
    }

    #[test]
    fn an_interrupted_download_carries_on_from_where_it_stopped() {
        let dir = TestDir::new();
        std::fs::write(dir.0.join("a.bin.part"), b"hel").unwrap();
        let server = serve(vec![file_reply("206 Partial Content", "lo")]);
        let spec = FileSpec { name: "a.bin", bytes: 5, sha256: HELLO_SHA };
        fetch(&server.url, spec, &dir.0).unwrap();
        assert_eq!(std::fs::read(dir.0.join("a.bin")).unwrap(), b"hello");
        assert!(server.requests.lock().unwrap()[0].to_ascii_lowercase().contains("range: bytes=3-"));
    }

    #[test]
    fn a_server_that_ignores_the_range_starts_the_file_again() {
        let dir = TestDir::new();
        std::fs::write(dir.0.join("a.bin.part"), b"xyz").unwrap();
        let server = serve(vec![file_reply("200 OK", "hello")]);
        let spec = FileSpec { name: "a.bin", bytes: 5, sha256: HELLO_SHA };
        fetch(&server.url, spec, &dir.0).unwrap();
        assert_eq!(std::fs::read(dir.0.join("a.bin")).unwrap(), b"hello");
    }

    #[test]
    fn a_server_error_is_reported_and_nothing_appears() {
        let dir = TestDir::new();
        let server = serve(vec![file_reply("503 Service Unavailable", "busy")]);
        let spec = FileSpec { name: "a.bin", bytes: 5, sha256: HELLO_SHA };
        assert_eq!(fetch(&server.url, spec, &dir.0).unwrap_err().code, "DOWNLOAD_FAILED");
        assert!(!dir.0.join("a.bin").exists());
    }

    /// Needs the real files. `LORECRAFT_MODEL_DIR=... cargo test real_model -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs the downloaded model, in LORECRAFT_MODEL_DIR"]
    fn real_model_matches_the_published_vector_and_finds_meaning() {
        let dir = std::env::var("LORECRAFT_MODEL_DIR").expect("LORECRAFT_MODEL_DIR");
        let dir = Path::new(&dir);
        for spec in FILES {
            assert_eq!(sha256_of_file(&dir.join(spec.name)).unwrap(), spec.sha256, "{}", spec.name);
        }
        let start = std::time::Instant::now();
        let loaded = load_from(dir).unwrap();
        println!("loaded in {:?}", start.elapsed());
        assert_eq!(loaded.bert.dimensions(), 384);
        let ids = loaded.tokenizer.encode("This is an example sentence", MAX_TOKENS);
        assert_eq!(ids, vec![101, 2023, 2003, 2019, 2742, 6251, 102]);
        let vector = loaded.bert.encode(&ids);
        // The values sentence-transformers publishes for this model and sentence.
        let published = [0.067_656_92, 0.063_495_97, 0.048_713_1, 0.079_304_92, 0.037_448_07, 0.002_652_78, 0.039_374_97, -0.007_098_46, 0.059_361_42, 0.031_536_94];
        for (i, want) in published.iter().enumerate() {
            assert!((vector[i] - want).abs() < 1e-4, "element {i}: {} against {want}", vector[i]);
        }

        let embed = |text: &str| loaded.bert.encode(&loaded.tokenizer.encode(text, MAX_TOKENS));
        let cosine = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        let query = embed("the knight at the gate");
        let right = embed("Aria guarded the northern door");
        let wrong = embed("The recipe calls for two cups of flour and a pinch of salt.");
        println!("related {}, unrelated {}", cosine(&query, &right), cosine(&query, &wrong));
        assert!(cosine(&query, &right) > cosine(&query, &wrong) + 0.1);

        for (query, candidates) in [
            ("the knight at the gate", vec![
                "Aria guarded the northern door.",
                "Aria guarded the northern door. All night she stood there with her spear, and nobody passed her.",
                "A sentinel stood watch at the entrance of the keep.",
                "The knight stood at the castle gate.",
                "Tomas mended a basket of plums at the mill while the bells rang. He wondered whether the letter would ever arrive.",
                "The miller sold his winter boots under the willow before the rain came. The smell of woodsmoke hung over everything.",
                "kettle near the bridge at first light. It had been a poor year for apples. The miller sold his winter boots under the willow before the rain came. The smell of woodsmoke hung over everything. Her brother mended a jar of honey in the orchard during the fair.",
                "She laughed and said it did not matter.",
            ]),
        ] {
            let q = embed(query);
            for candidate in candidates {
                println!("{:.3}  {}", cosine(&q, &embed(candidate)), candidate);
            }
        }

        let passage = "She ".to_string() + &"walked along the river and thought about the long winter ahead. ".repeat(14);
        let ids = loaded.tokenizer.encode(&passage, MAX_TOKENS);
        let start = std::time::Instant::now();
        for _ in 0..5 {
            loaded.bert.encode(&ids);
        }
        println!("{} tokens: {:?} per passage, one thread", ids.len(), start.elapsed() / 5);
    }
}
