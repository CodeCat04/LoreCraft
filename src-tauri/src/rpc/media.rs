//! Pictures, videos, sound files and PDFs. See docs/ARCHITECTURE.md, "Media".
//!
//! Stored bytes live in `asset_chunks`, so a file can exceed SQLite's 1 GB value limit
//! and a range read touches only the chunks it needs. An upload is `uploadBegin`, then
//! raw chunks through the `media_upload_chunk` command, then `uploadFinish`. Each chunk
//! is its own short transaction, so the rest of the app can save between them.
//!
//! Reads use a read-only connection beside the session's. WAL allows that, so playing a
//! video never holds the session lock.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::Mutex;
use std::time::Duration;

use aho_corasick::AhoCorasick;
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{ok, parse, unknown};
use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::paths;

/// Bytes per row in `asset_chunks`, and the size of one upload message.
pub const CHUNK_SIZE: usize = 4 * 1024 * 1024;
/// The largest picture, which the web view asks for in one piece.
pub const MAX_IMAGE_BYTES: u64 = 256 * 1024 * 1024;
/// The largest PDF. The card reads it whole to draw its first page.
pub const MAX_PDF_BYTES: u64 = 128 * 1024 * 1024;
/// The largest sound file. It streams in ranges like a video, but nothing this long is a
/// sound a writer pins to a board.
pub const MAX_AUDIO_BYTES: u64 = 1024 * 1024 * 1024;
/// The most one `media_read` call returns.
const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;
/// Chunk sizes a stored asset may claim. Everything is written at `CHUNK_SIZE`, and this
/// leaves room to change that without old projects becoming unreadable.
const STORED_CHUNK_SIZES: std::ops::RangeInclusive<i64> = 64 * 1024..=64 * 1024 * 1024;
/// How much of a file the type check looks at.
const SNIFF_BYTES: usize = 4096;

const UNSUPPORTED: &str = "UNSUPPORTED_MEDIA";
const SUPPORTED_TEXT: &str = "LoreCraft can embed PNG, JPEG, GIF, WebP and AVIF pictures, MP4, WebM, MOV and Ogg videos, MP3, M4A, AAC, Ogg, Opus, WAV and FLAC sounds, and PDF files.";

/// The only types ever served. HTML and SVG are excluded on purpose: they can carry scripts.
const SERVED_TYPES: [&str; 16] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/ogg",
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/wav",
    "audio/flac",
    "application/pdf",
];

/// A linked file must be a video by name as well as by content.
const LINKED_EXTENSIONS: [&str; 6] = ["mp4", "m4v", "webm", "mov", "ogv", "ogg"];

// ---------------------------------------------------------------------------
// Type checks. `src/media/sniff.ts` must agree with these.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sniffed {
    pub mime: &'static str,
    pub kind: &'static str,
}

const fn image(mime: &'static str) -> Option<Sniffed> {
    Some(Sniffed { mime, kind: "image" })
}

const fn video(mime: &'static str) -> Option<Sniffed> {
    Some(Sniffed { mime, kind: "video" })
}

const fn audio(mime: &'static str) -> Option<Sniffed> {
    Some(Sniffed { mime, kind: "audio" })
}

/// The largest file of a kind, or None when only the disk limits it.
pub fn max_bytes(kind: &str) -> Option<u64> {
    match kind {
        "image" => Some(MAX_IMAGE_BYTES),
        "pdf" => Some(MAX_PDF_BYTES),
        "audio" => Some(MAX_AUDIO_BYTES),
        _ => None,
    }
}

fn kind_noun(kind: &str) -> &'static str {
    match kind {
        "image" => "picture",
        "video" => "video",
        "audio" => "sound file",
        "pdf" => "PDF",
        _ => "file",
    }
}

/// Refuses a file over its kind's limit.
fn check_size(kind: &str, size: u64) -> AppResult<()> {
    match max_bytes(kind) {
        Some(max) if size > max => Err(AppError::invalid(format!(
            "That {} is larger than {} MB.",
            kind_noun(kind),
            max / (1024 * 1024)
        ))),
        _ => Ok(()),
    }
}

fn contains(head: &[u8], needle: &[u8]) -> bool {
    head.windows(needle.len()).any(|w| w == needle)
}

/// What a file really is, from its leading bytes. None if we do not accept it.
pub fn sniff(bytes: &[u8]) -> Option<Sniffed> {
    let head = &bytes[..bytes.len().min(SNIFF_BYTES)];
    if head.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return image("image/png");
    }
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return image("image/jpeg");
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return image("image/gif");
    }
    if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
        return image("image/webp");
    }
    if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        // EBML, which is also Matroska. The document type says which.
        return if head.windows(4).any(|w| w == b"webm") {
            video("video/webm")
        } else {
            None
        };
    }
    if head.starts_with(b"%PDF-") {
        return Some(Sniffed { mime: "application/pdf", kind: "pdf" });
    }
    if head.starts_with(b"OggS") {
        // Ogg holds sound or pictures. A Theora stream makes it a video.
        let sound = [&b"OpusHead"[..], b"\x01vorbis", b"\x7fFLAC"].iter().any(|n| contains(head, n));
        return if sound && !contains(head, b"\x80theora") {
            audio("audio/ogg")
        } else {
            video("video/ogg")
        };
    }
    if head.starts_with(b"fLaC") {
        return audio("audio/flac");
    }
    if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WAVE" {
        return audio("audio/wav");
    }
    if head.starts_with(b"ID3") {
        return audio("audio/mpeg");
    }
    if head.len() >= 2 && head[0] == 0xFF {
        // MPEG audio frame sync. Layer III is MP3; layer bits 00 with this sync is AAC (ADTS).
        let b = head[1];
        if b & 0xF6 == 0xF0 {
            return audio("audio/aac");
        }
        if b & 0xE0 == 0xE0 && b & 0x18 != 0x08 && b & 0x06 == 0x02 {
            return audio("audio/mpeg");
        }
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return sniff_iso_media(head);
    }
    // QuickTime files older than the `ftyp` box start straight with one of these.
    if head.len() >= 8 && [&b"moov"[..], b"mdat", b"wide", b"free", b"skip", b"pnot"].contains(&&head[4..8]) {
        return video("video/quicktime");
    }
    None
}

/// MP4, MOV and AVIF share a container, and the brands in `ftyp` tell them apart.
fn sniff_iso_media(head: &[u8]) -> Option<Sniffed> {
    const NOT_ACCEPTED: [&[u8; 4]; 12] = [
        b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1",
        b"M4P ", b"crx ",
    ];
    let declared = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
    let end = declared.clamp(16, head.len().max(16)).min(head.len());
    let major = &head[8..12];
    let brands = head.get(16..end).unwrap_or(&[]);
    let has = |brand: &[u8]| major == brand || brands.chunks_exact(4).any(|b| b == brand);
    if has(b"avif") || has(b"avis") {
        return image("image/avif");
    }
    if major == b"qt  " {
        return video("video/quicktime");
    }
    if major == b"M4A " || major == b"M4B " {
        return audio("audio/mp4");
    }
    if major.starts_with(b"3g") || NOT_ACCEPTED.iter().any(|b| &b[..] == major) {
        return None;
    }
    video("video/mp4")
}

/// The kind a browser's reported type implies. `Ok(None)` when it says nothing useful,
/// `Err` when it names something we refuse.
fn reported_kind(reported: &str) -> Result<Option<&'static str>, ()> {
    let name = reported.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match name.as_str() {
        // Browsers call any `.ogg` sound, whatever it holds, so the bytes decide.
        "" | "application/octet-stream" | "audio/ogg" | "application/ogg" => Ok(None),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" => Ok(Some("image")),
        // Browsers report `.ogg` as audio and `.m4v` under its own name.
        "video/mp4" | "video/x-m4v" | "video/webm" | "video/quicktime" | "video/ogg" => Ok(Some("video")),
        "audio/mpeg" | "audio/mp3" | "audio/mp4" | "audio/x-m4a" | "audio/m4a" | "audio/aac"
        | "audio/x-aac" | "audio/aacp" | "audio/opus" | "audio/wav" | "audio/x-wav" | "audio/wave"
        | "audio/vnd.wave" | "audio/flac" | "audio/x-flac" => Ok(Some("audio")),
        "application/pdf" => Ok(Some("pdf")),
        _ => Err(()),
    }
}

fn refused(what: &str) -> AppError {
    AppError::new(UNSUPPORTED, format!("{what} {SUPPORTED_TEXT}"))
}

fn is_hex_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct AssetRow {
    id: String,
    name: String,
    mime: String,
    kind: String,
    size: i64,
    chunk_size: i64,
    sha256: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    duration: Option<f64>,
    complete: bool,
    external_path: Option<String>,
    created_at: String,
    label: String,
    description: String,
}

const ROW_COLUMNS: &str = "id, name, mime, kind, size, chunk_size, sha256, width, height, duration,
                           complete, external_path, created_at, label, description";

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<AssetRow> {
    Ok(AssetRow {
        id: r.get(0)?,
        name: r.get(1)?,
        mime: r.get(2)?,
        kind: r.get(3)?,
        size: r.get(4)?,
        chunk_size: r.get(5)?,
        sha256: r.get(6)?,
        width: r.get(7)?,
        height: r.get(8)?,
        duration: r.get(9)?,
        complete: r.get::<_, i64>(10)? != 0,
        external_path: r.get(11)?,
        created_at: r.get(12)?,
        label: r.get(13)?,
        description: r.get(14)?,
    })
}

fn get_row(conn: &Connection, id: &str) -> AppResult<Option<AssetRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {ROW_COLUMNS} FROM assets WHERE id = ?1"),
            [id],
            row_from,
        )
        .optional()?)
}

/// What the UI knows about an asset.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub kind: String,
    pub size: i64,
    pub sha256: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration: Option<f64>,
    /// Streamed from a file on disk rather than stored in the project.
    pub linked: bool,
    pub path: Option<String>,
    /// A linked file that cannot be reached right now.
    pub missing: bool,
    pub created_at: String,
    pub label: String,
    pub description: String,
}

fn info_of(engine: &Engine, row: AssetRow) -> AssetInfo {
    let linked = row.external_path.is_some();
    let missing = row
        .external_path
        .as_deref()
        .is_some_and(|path| !may_read_linked(engine, Path::new(path)) || !Path::new(path).is_file());
    AssetInfo {
        id: row.id,
        name: row.name,
        mime: row.mime,
        kind: row.kind,
        size: row.size,
        sha256: row.sha256,
        width: row.width,
        height: row.height,
        duration: row.duration,
        linked,
        path: row.external_path,
        missing,
        created_at: row.created_at,
        label: row.label,
        description: row.description,
    }
}

/// A connection for reading alongside the session's, which holds no lock of ours.
pub fn read_connection(engine: &Engine) -> AppResult<Connection> {
    let path = engine.working_db_path()?;
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

fn upload_begin(
    engine: &Engine,
    name: &str,
    reported: &str,
    size: u64,
) -> AppResult<Value> {
    let kind = reported_kind(reported)
        .map_err(|()| refused(&format!("{reported} files cannot be embedded.")))?;
    if size == 0 {
        return Err(AppError::invalid("That file is empty."));
    }
    if size > i64::MAX as u64 {
        return Err(AppError::invalid("That file is too large."));
    }
    if let Some(kind) = kind {
        check_size(kind, size)?;
    }
    let id = db::new_id();
    engine.write(|tx| {
        tx.execute(
            "INSERT INTO assets (id, name, mime, size, chunk_size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, reported, size as i64, CHUNK_SIZE as i64, db::now()],
        )?;
        Ok(())
    })?;
    ok(json!({ "id": id, "chunkSize": CHUNK_SIZE }))
}

/// Stores one chunk. The first is checked against the allowed types, and a refusal ends
/// the upload. Sending a chunk again replaces it, so a retry is safe.
pub fn upload_chunk(engine: &Engine, id: &str, index: u64, bytes: &[u8]) -> AppResult<Value> {
    let outcome = engine.write(|tx| {
        let row = get_row(tx, id)?
            .filter(|r| !r.complete)
            .ok_or_else(|| AppError::not_found("That upload"))?;
        let (size, chunk_size) = (row.size as u64, row.chunk_size as u64);
        let offset = index
            .checked_mul(chunk_size)
            .filter(|o| *o < size)
            .ok_or_else(|| AppError::invalid("That chunk is past the end of the file."))?;
        if bytes.len() as u64 != chunk_size.min(size - offset) {
            return Err(AppError::invalid("That chunk has the wrong size."));
        }
        if index > 0 {
            let previous: Option<i64> = tx
                .query_row(
                    "SELECT idx FROM asset_chunks WHERE asset_id = ?1 AND idx = ?2",
                    params![id, (index - 1) as i64],
                    |r| r.get(0),
                )
                .optional()?;
            if previous.is_none() {
                return Err(AppError::invalid("Chunks must arrive in order."));
            }
        } else {
            let found = sniff(bytes).ok_or_else(|| {
                refused(&format!("The contents of {} are not a supported type.", row.name))
            })?;
            match reported_kind(&row.mime) {
                Ok(Some(kind)) if kind != found.kind => {
                    return Err(refused(&format!(
                        "{} says it is a {} but its contents are a {}.",
                        row.name,
                        kind_noun(kind),
                        kind_noun(found.kind)
                    )));
                }
                _ => {}
            }
            check_size(found.kind, size)?;
            tx.execute(
                "UPDATE assets SET mime = ?1, kind = ?2 WHERE id = ?3",
                params![found.mime, found.kind, id],
            )?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO asset_chunks (asset_id, idx, bytes) VALUES (?1, ?2, ?3)",
            params![id, index as i64, bytes],
        )?;
        Ok(())
    });
    if let Err(e) = &outcome {
        if index == 0 && e.code != "NOT_FOUND" {
            discard_upload(engine, id)?;
        }
    }
    outcome?;
    ok(json!({ "index": index }))
}

fn discard_upload(engine: &Engine, id: &str) -> AppResult<()> {
    engine.write(|tx| {
        tx.execute("DELETE FROM assets WHERE id = ?1 AND complete = 0", [id])?;
        Ok(())
    })
}

/// Runs `visit` over the stored chunks in order, one short read at a time.
fn visit_chunks(
    conn: &Connection,
    row: &AssetRow,
    mut visit: impl FnMut(&[u8]) -> AppResult<()>,
) -> AppResult<u64> {
    let chunk_size = row.chunk_size.max(1) as u64;
    let count = (row.size as u64).div_ceil(chunk_size);
    let mut stmt =
        conn.prepare("SELECT bytes FROM asset_chunks WHERE asset_id = ?1 AND idx = ?2")?;
    let mut total = 0u64;
    for index in 0..count {
        let found = stmt
            .query_row(params![row.id, index as i64], |r| {
                let bytes = r.get_ref(0)?.as_blob()?;
                total += bytes.len() as u64;
                Ok(visit(bytes))
            })
            .optional()?;
        match found {
            Some(result) => result?,
            None => break,
        }
    }
    Ok(total)
}

fn hash_file(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hex(&hasher.finalize()));
        }
        hasher.update(&buffer[..read]);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishParams {
    id: String,
    /// The hash of what the UI read. Not needed when the bytes came from `source_path`.
    sha256: Option<String>,
    source_path: Option<PathBuf>,
    width: Option<i64>,
    height: Option<i64>,
    duration: Option<f64>,
}

/// Checks what was stored against what was sent. Identical content is stored once, so a
/// hash we already have returns the existing asset and drops this one.
fn upload_finish(engine: &Engine, p: FinishParams) -> AppResult<Value> {
    let expected = match (&p.sha256, &p.source_path) {
        (Some(sha), _) => {
            if !is_hex_sha256(sha) {
                return Err(AppError::invalid("That is not a SHA-256 hash."));
            }
            sha.to_ascii_lowercase()
        }
        (None, Some(path)) => {
            engine.check_allowed(path)?;
            hash_file(path)?
        }
        (None, None) => return Err(AppError::invalid("An upload needs a hash to check against.")),
    };

    let actual = (|| -> AppResult<(u64, AssetRow, String)> {
        let conn = read_connection(engine)?;
        let row = get_row(&conn, &p.id)?
            .filter(|r| !r.complete)
            .ok_or_else(|| AppError::not_found("That upload"))?;
        let mut hasher = Sha256::new();
        let total = visit_chunks(&conn, &row, |bytes| {
            hasher.update(bytes);
            Ok(())
        })?;
        Ok((total, row, hex(&hasher.finalize())))
    })();
    let (total, row, stored_hash) = actual?;
    if total != row.size as u64 {
        discard_upload(engine, &p.id)?;
        return Err(AppError::new(
            "UPLOAD_INCOMPLETE",
            format!("Only {total} of {} bytes of {} arrived.", row.size, row.name),
        ));
    }
    if stored_hash != expected {
        discard_upload(engine, &p.id)?;
        return Err(AppError::new(
            "HASH_MISMATCH",
            format!("{} did not arrive intact. Please try adding it again.", row.name),
        ));
    }

    let (kept, deduped) = engine.write(|tx| {
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM assets
                 WHERE sha256 = ?1 AND complete = 1 AND external_path IS NULL AND id <> ?2",
                params![stored_hash, p.id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            tx.execute("DELETE FROM assets WHERE id = ?1", [&p.id])?;
            tx.execute(
                "UPDATE assets SET width = COALESCE(width, ?1), height = COALESCE(height, ?2),
                                   duration = COALESCE(duration, ?3)
                 WHERE id = ?4",
                params![p.width, p.height, p.duration, existing],
            )?;
            return Ok((existing, true));
        }
        tx.execute(
            "UPDATE assets SET complete = 1, sha256 = ?1, width = ?2, height = ?3, duration = ?4
             WHERE id = ?5",
            params![stored_hash, p.width, p.height, p.duration, p.id],
        )?;
        Ok((p.id.clone(), false))
    })?;
    engine.notify("media");
    let info = get_info(engine, &kept)?;
    let mut value = serde_json::to_value(info)?;
    value["deduped"] = json!(deduped);
    Ok(value)
}

/// Removes uploads a crash or a closed project left unfinished. They can never finish,
/// because the UI that was sending them has gone. Runs as a project opens.
pub fn remove_incomplete(conn: &Connection) -> AppResult<usize> {
    Ok(conn.execute("DELETE FROM assets WHERE complete = 0", [])?)
}

// ---------------------------------------------------------------------------
// Linked files
// ---------------------------------------------------------------------------

fn has_linked_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| LINKED_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// An absolute path on a local disk, with nothing that needs resolving.
fn is_plain_local_path(path: &Path) -> bool {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    match path.components().next() {
        Some(Component::Prefix(prefix)) => {
            matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        }
        _ => true,
    }
}

/// A project file can come from someone else, so the path in it proves nothing about
/// what the user wants read. Only media extensions are ever read. A network path is
/// reached only if the user picked it in this run, because just opening one would hand
/// a stranger's server the user's Windows credentials.
fn may_read_linked(engine: &Engine, path: &Path) -> bool {
    has_linked_extension(path) && (is_plain_local_path(path) || engine.check_allowed(path).is_ok())
}

fn read_head(path: &Path) -> AppResult<Vec<u8>> {
    let mut head = Vec::with_capacity(SNIFF_BYTES);
    File::open(path)?
        .take(SNIFF_BYTES as u64)
        .read_to_end(&mut head)?;
    Ok(head)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".to_string())
}

fn path_text(path: &Path) -> AppResult<&str> {
    path.to_str()
        .ok_or_else(|| AppError::invalid("That file's path is not valid text."))
}

/// Checks a file the user picked, ready to link it.
fn inspect_video_file(engine: &Engine, path: &Path) -> AppResult<(Sniffed, u64)> {
    engine.check_allowed(path)?;
    if !has_linked_extension(path) {
        return Err(refused(&format!("{} cannot be linked.", file_name(path))));
    }
    let found = sniff(&read_head(path)?)
        .filter(|s| s.kind == "video")
        .ok_or_else(|| refused(&format!("{} is not a supported video.", file_name(path))))?;
    Ok((found, fs::metadata(path)?.len()))
}

fn link_file(engine: &Engine, path: &Path, p: &MeasureParams) -> AppResult<AssetInfo> {
    let (found, size) = inspect_video_file(engine, path)?;
    let text = path_text(path)?;
    let id = engine.write(|tx| {
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM assets WHERE external_path = ?1 AND complete = 1",
                [text],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            return Ok(existing);
        }
        let id = db::new_id();
        tx.execute(
            "INSERT INTO assets (id, name, mime, kind, size, chunk_size, width, height, duration,
                                 complete, external_path, created_at)
             VALUES (?1, ?2, ?3, 'video', ?4, 0, ?5, ?6, ?7, 1, ?8, ?9)",
            params![
                id,
                file_name(path),
                found.mime,
                size as i64,
                p.width,
                p.height,
                p.duration,
                text,
                db::now()
            ],
        )?;
        Ok(id)
    })?;
    engine.notify("media");
    get_info(engine, &id)
}

/// Points a linked asset at a new file. The asset id stays, so documents keep working.
fn relink_file(engine: &Engine, id: &str, path: &Path) -> AppResult<AssetInfo> {
    let (found, size) = inspect_video_file(engine, path)?;
    let text = path_text(path)?;
    engine.write(|tx| {
        let changed = tx.execute(
            "UPDATE assets SET name = ?1, mime = ?2, size = ?3, external_path = ?4,
                               width = NULL, height = NULL, duration = NULL
             WHERE id = ?5 AND external_path IS NOT NULL",
            params![file_name(path), found.mime, size as i64, text, id],
        )?;
        if changed == 0 {
            return Err(AppError::not_found("That linked video"));
        }
        Ok(())
    })?;
    engine.notify("media");
    get_info(engine, id)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

enum Source {
    Stored { conn: Connection, id: String, chunk_size: u64 },
    Linked(PathBuf),
}

/// An asset that is cleared to be read, with its bytes on hand.
pub struct ReadableAsset {
    pub mime: String,
    pub size: u64,
    source: Source,
}

impl ReadableAsset {
    /// Opens an asset by id. This is the only way to its bytes: nothing here takes a
    /// path from the caller, and only stored image and video types get through.
    pub fn open(engine: &Engine, id: &str) -> AppResult<Self> {
        let conn = read_connection(engine)?;
        let row = get_row(&conn, id)?
            .filter(|r| r.complete)
            .ok_or_else(|| AppError::not_found("That picture or video"))?;
        if !SERVED_TYPES.contains(&row.mime.as_str()) {
            return Err(refused(&format!("{} files cannot be shown.", row.mime)));
        }
        if let Some(path) = row.external_path {
            let path = PathBuf::from(path);
            let missing = || AppError::new("FILE_MISSING", format!("{} cannot be found.", path.display()));
            if !may_read_linked(engine, &path) {
                return Err(missing());
            }
            let head = read_head(&path).map_err(|_| missing())?;
            // The file may have been replaced since it was linked.
            if sniff(&head).map(|s| s.mime) != Some(row.mime.as_str()) {
                return Err(refused(&format!("{} has changed type.", path.display())));
            }
            let size = fs::metadata(&path).map_err(|_| missing())?.len();
            return Ok(Self {
                mime: row.mime,
                size,
                source: Source::Linked(path),
            });
        }
        // A project file can come from someone else, and these numbers decide how ranges
        // are worked out. Ones no upload or import writes would only overflow or crawl.
        if row.size < 0 || !STORED_CHUNK_SIZES.contains(&row.chunk_size) {
            return Err(refused("That picture or video is damaged, so it cannot be shown."));
        }
        Ok(Self {
            mime: row.mime,
            size: row.size as u64,
            source: Source::Stored {
                conn,
                id: row.id,
                chunk_size: row.chunk_size as u64,
            },
        })
    }

    /// The last byte worth returning for a request that starts at `start` and names no
    /// end. For stored assets that is the end of its chunk, so the next request starts
    /// on a fresh one.
    pub fn window_end(&self, start: u64) -> u64 {
        let end = match &self.source {
            Source::Stored { chunk_size, .. } => (start / chunk_size + 1) * chunk_size - 1,
            Source::Linked(_) => start + CHUNK_SIZE as u64 - 1,
        };
        end.min(self.size.saturating_sub(1))
    }

    /// Reads `start..=end`, which must be within the asset.
    pub fn read(&self, start: u64, end: u64) -> AppResult<Vec<u8>> {
        let length = (end - start + 1) as usize;
        match &self.source {
            Source::Linked(path) => {
                let mut file = File::open(path)?;
                file.seek(SeekFrom::Start(start))?;
                let mut out = Vec::with_capacity(length);
                file.take(length as u64).read_to_end(&mut out)?;
                Ok(out)
            }
            Source::Stored { conn, id, chunk_size } => {
                let mut stmt = conn.prepare_cached(
                    "SELECT substr(bytes, ?1, ?2) FROM asset_chunks WHERE asset_id = ?3 AND idx = ?4",
                )?;
                let mut out = Vec::with_capacity(length);
                for index in (start / chunk_size)..=(end / chunk_size) {
                    let chunk_start = index * chunk_size;
                    let from = start.max(chunk_start) - chunk_start;
                    let to = end.min(chunk_start + chunk_size - 1) - chunk_start;
                    let piece = stmt
                        .query_row(
                            params![(from + 1) as i64, (to - from + 1) as i64, id, index as i64],
                            |r| r.get::<_, Vec<u8>>(0),
                        )
                        .optional()?
                        .ok_or_else(|| AppError::internal("Part of that file is missing."))?;
                    out.extend_from_slice(&piece);
                }
                Ok(out)
            }
        }
    }
}

/// Reads part of an asset, for exporters. See `readAssetChunks` in `src/lib/assets.ts`.
pub fn read_range(engine: &Engine, id: &str, offset: u64, length: u64) -> AppResult<Vec<u8>> {
    let asset = ReadableAsset::open(engine, id)?;
    if length == 0 || offset >= asset.size {
        return Ok(Vec::new());
    }
    let end = (offset + length.min(MAX_READ_BYTES) - 1).min(asset.size - 1);
    asset.read(offset, end)
}

// ---------------------------------------------------------------------------
// Unused media
// ---------------------------------------------------------------------------

/// Which of `ids` the project still mentions. This searches every text column of every
/// table except the search index and the assets themselves, rather than a list of known
/// places. That covers documents, infoboxes, maps and revisions, and whatever a later
/// module adds. A false match only keeps a file, which is the safe way to be wrong.
fn referenced_ids(conn: &Connection, ids: &[String]) -> AppResult<HashSet<String>> {
    let mut found = HashSet::new();
    if ids.is_empty() {
        return Ok(found);
    }
    let matcher = AhoCorasick::new(ids).map_err(|e| AppError::internal(e.to_string()))?;
    let tables: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_fts%'
               AND name NOT IN ('assets', 'asset_chunks')",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for table in tables {
        let quoted = format!("\"{}\"", table.replace('"', "\"\""));
        let columns: Vec<String> = {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({quoted})"))?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
            rows.filter_map(Result::ok)
                .filter(|(_, kind)| kind.is_empty() || kind.eq_ignore_ascii_case("text"))
                .map(|(name, _)| format!("\"{}\"", name.replace('"', "\"\"")))
                .collect()
        };
        if columns.is_empty() {
            continue;
        }
        let mut stmt = conn.prepare(&format!("SELECT {} FROM {quoted}", columns.join(", ")))?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            for index in 0..columns.len() {
                if let ValueRef::Text(text) = row.get_ref(index)? {
                    for hit in matcher.find_iter(text) {
                        found.insert(ids[hit.pattern().as_usize()].clone());
                    }
                }
            }
        }
        if found.len() == ids.len() {
            break;
        }
    }
    Ok(found)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnusedAsset {
    id: String,
    name: String,
    mime: String,
    kind: String,
    /// What deleting it gives back. A linked file takes no room in the project.
    stored_bytes: i64,
    linked: bool,
    created_at: String,
}

fn list_unused(engine: &Engine) -> AppResult<Value> {
    let conn = read_connection(engine)?;
    let rows: Vec<AssetRow> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {ROW_COLUMNS} FROM assets WHERE complete = 1 ORDER BY size DESC"
        ))?;
        let rows = stmt.query_map([], row_from)?;
        rows.collect::<Result<_, _>>()?
    };
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let used = referenced_ids(&conn, &ids)?;
    let unused: Vec<UnusedAsset> = rows
        .into_iter()
        .filter(|r| !used.contains(&r.id))
        .map(|r| UnusedAsset {
            stored_bytes: if r.external_path.is_some() { 0 } else { r.size },
            linked: r.external_path.is_some(),
            id: r.id,
            name: r.name,
            mime: r.mime,
            kind: r.kind,
            created_at: r.created_at,
        })
        .collect();
    let total: i64 = unused.iter().map(|u| u.stored_bytes).sum();
    ok(json!({ "items": unused, "totalBytes": total }))
}

/// Deletes the given assets, as long as nothing has come to use them since they were
/// listed. Each one is its own transaction, so a large one does not stop the app.
fn remove_unused(engine: &Engine, ids: &[String]) -> AppResult<Value> {
    let mut removed = 0;
    let mut freed = 0i64;
    for id in ids {
        let size = engine.write(|tx| {
            let Some(row) = get_row(tx, id)?.filter(|r| r.complete) else {
                return Ok(None);
            };
            if referenced_ids(tx, std::slice::from_ref(id))?.contains(id) {
                return Ok(None);
            }
            tx.execute("DELETE FROM assets WHERE id = ?1", [id])?;
            Ok(Some(if row.external_path.is_some() { 0 } else { row.size }))
        })?;
        if let Some(size) = size {
            removed += 1;
            freed += size;
        }
    }
    engine.notify("media");
    ok(json!({ "removed": removed, "freedBytes": freed }))
}

/// Gives asset `id` the file of asset `with`, a fresh upload, so every figure, infobox and
/// map that shows `id` shows the new picture. `with` is used up. Its label and description
/// go only where `id` had none.
fn replace_asset(engine: &Engine, id: &str, with: &str) -> AppResult<Value> {
    if id == with {
        return ok(get_info(engine, id)?);
    }
    engine.write(|tx| {
        let old = get_row(tx, id)?
            .filter(|r| r.complete)
            .ok_or_else(|| AppError::not_found("That picture or video"))?;
        let new = get_row(tx, with)?
            .filter(|r| r.complete)
            .ok_or_else(|| AppError::not_found("The new file"))?;
        if !old.kind.is_empty() && !new.kind.is_empty() && old.kind != new.kind {
            return Err(AppError::new(
                "WRONG_KIND",
                "A picture can only be replaced by a picture, and a video by a video.",
            ));
        }
        if referenced_ids(tx, &[with.to_string()])?.contains(with) {
            return Err(AppError::new(
                "IN_USE",
                "That file is already in the project and in use. Choose another file.",
            ));
        }
        tx.execute("DELETE FROM asset_chunks WHERE asset_id = ?1", [id])?;
        tx.execute("UPDATE asset_chunks SET asset_id = ?1 WHERE asset_id = ?2", [id, with])?;
        tx.execute("DELETE FROM assets WHERE id = ?1", [with])?;
        let label = if old.label.is_empty() { new.label } else { old.label };
        let description = if old.description.is_empty() { new.description } else { old.description };
        tx.execute(
            "UPDATE assets SET name = ?1, mime = ?2, kind = ?3, size = ?4, chunk_size = ?5, sha256 = ?6,
                               width = ?7, height = ?8, duration = ?9, external_path = ?10,
                               label = ?11, description = ?12
             WHERE id = ?13",
            params![
                new.name, new.mime, new.kind, new.size, new.chunk_size, new.sha256, new.width,
                new.height, new.duration, new.external_path, label, description, id
            ],
        )?;
        Ok(())
    })?;
    engine.notify("media");
    engine.notify("pages");
    ok(get_info(engine, id)?)
}

/// Deletes an asset even while it is in use. Its figures then show that the file is missing.
fn delete_asset(engine: &Engine, id: &str) -> AppResult<Value> {
    let deleted = engine.write(|tx| Ok(tx.execute("DELETE FROM assets WHERE id = ?1", [id])?))?;
    if deleted == 0 {
        return Err(AppError::not_found("That picture or video"));
    }
    engine.notify("media");
    engine.notify("pages");
    ok(true)
}

// ---------------------------------------------------------------------------
// The library: what the documents say about each asset
// ---------------------------------------------------------------------------

fn text_of(node: &Value) -> String {
    let children = node.get("content").and_then(Value::as_array);
    children
        .into_iter()
        .flatten()
        .filter_map(|child| child.get("text").and_then(Value::as_str))
        .collect()
}

/// Calls `visit` for each asset a document shows, with the figure around it if any.
fn visit_assets(node: &Value, figure: Option<&Value>, visit: &mut dyn FnMut(&str, Option<&Value>)) {
    let kind = node.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "image" || kind == "video" {
        if let Some(id) = node.pointer("/attrs/assetId").and_then(Value::as_str) {
            visit(id, figure);
        }
        return;
    }
    let figure = if kind == "figure" { Some(node) } else { figure };
    for child in node.get("content").and_then(Value::as_array).into_iter().flatten() {
        visit_assets(child, figure, visit);
    }
}

/// What live documents show of one asset.
#[derive(Default)]
struct Shown {
    label: String,
    description: String,
    uses: usize,
}

fn note_document(doc: &Value, shown: &mut HashMap<String, Shown>) {
    let mut seen: HashSet<String> = HashSet::new();
    visit_assets(doc, None, &mut |id, figure| {
        let entry = shown.entry(id.to_string()).or_default();
        if seen.insert(id.to_string()) {
            entry.uses += 1;
        }
        let Some(figure) = figure else {
            return;
        };
        if entry.label.is_empty() {
            let caption = figure
                .get("content")
                .and_then(Value::as_array)
                .and_then(|children| children.iter().find(|c| c.get("type").and_then(Value::as_str) == Some("figcaption")));
            entry.label = caption.map(text_of).unwrap_or_default();
        }
        if entry.description.is_empty() {
            entry.description = figure
                .pointer("/attrs/description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
    });
}

/// Reads every live page, scene and map once. The filter on the text skips parsing
/// documents with no media, which is most of them.
fn scan_documents(conn: &Connection) -> AppResult<HashMap<String, Shown>> {
    let mut shown: HashMap<String, Shown> = HashMap::new();
    let parse_doc = |text: String| serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    {
        let mut stmt = conn.prepare(
            "SELECT content, infobox FROM pages
             WHERE deleted_at IS NULL AND (instr(content, 'assetId') > 0 OR instr(infobox, 'imageAssetId') > 0)
             ORDER BY title_key",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            note_document(&parse_doc(row.get(0)?), &mut shown);
            let infobox = parse_doc(row.get(1)?);
            if let Some(id) = infobox.get("imageAssetId").and_then(Value::as_str) {
                shown.entry(id.to_string()).or_default().uses += 1;
            }
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT content FROM nodes
             WHERE deleted_at IS NULL AND instr(content, 'assetId') > 0
             ORDER BY book_id, position",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            note_document(&parse_doc(row.get(0)?), &mut shown);
        }
    }
    let mut stmt = conn.prepare("SELECT asset_id FROM maps WHERE deleted_at IS NULL AND asset_id IS NOT NULL")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        shown.entry(row.get(0)?).or_default().uses += 1;
    }
    Ok(shown)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryItem {
    #[serde(flatten)]
    info: AssetInfo,
    /// How many live pages, scenes and maps show it.
    uses: usize,
    /// Whether anything at all mentions it, the same test "Remove unused media" uses.
    in_use: bool,
}

/// Every picture and video, newest first, with what the documents call it. A figure's own
/// words come first, and the label set in the library fills in when no figure has any.
fn library(engine: &Engine) -> AppResult<Value> {
    let conn = read_connection(engine)?;
    let rows: Vec<AssetRow> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {ROW_COLUMNS} FROM assets WHERE complete = 1 ORDER BY created_at DESC, id DESC"
        ))?;
        let rows = stmt.query_map([], row_from)?;
        rows.collect::<Result<_, _>>()?
    };
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let referenced = referenced_ids(&conn, &ids)?;
    let shown = scan_documents(&conn)?;
    let items: Vec<LibraryItem> = rows
        .into_iter()
        .map(|row| {
            let in_use = referenced.contains(&row.id);
            let found = shown.get(&row.id);
            let mut info = info_of(engine, row);
            let mut uses = 0;
            if let Some(found) = found {
                uses = found.uses;
                if !found.label.is_empty() {
                    info.label = found.label.clone();
                }
                if !found.description.is_empty() {
                    info.description = found.description.clone();
                }
            }
            LibraryItem { info, uses, in_use }
        })
        .collect();
    ok(json!({ "items": items }))
}

/// Every page, scene and map using an asset, with documents in full so the UI can name the
/// figures through `describeFigures`. Trashed ones are included and marked.
fn usage(engine: &Engine, id: &str) -> AppResult<Value> {
    let conn = read_connection(engine)?;
    let parse_doc = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    let mut uses: Vec<Value> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, deleted_at IS NOT NULL, instr(content, ?1) > 0, instr(infobox, ?1) > 0,
                    instr(notes, ?1) > 0, content
             FROM pages WHERE instr(content, ?1) > 0 OR instr(infobox, ?1) > 0 OR instr(notes, ?1) > 0
             ORDER BY deleted_at IS NOT NULL, title_key",
        )?;
        let mut rows = stmt.query([id])?;
        while let Some(row) = rows.next()? {
            let page_id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let deleted: bool = row.get(2)?;
            let mut push = |place: &str, content: Value| {
                uses.push(json!({
                    "kind": "page", "id": page_id, "title": title, "bookId": null,
                    "deleted": deleted, "where": place, "content": content,
                }));
            };
            if row.get::<_, bool>(3)? {
                push("content", parse_doc(&row.get::<_, String>(6)?));
            }
            if row.get::<_, bool>(4)? {
                push("infobox", Value::Null);
            }
            if row.get::<_, bool>(5)? {
                push("notes", Value::Null);
            }
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, book_id, deleted_at IS NOT NULL, content FROM nodes
             WHERE instr(content, ?1) > 0
             ORDER BY deleted_at IS NOT NULL, book_id, position",
        )?;
        let mut rows = stmt.query([id])?;
        while let Some(row) = rows.next()? {
            uses.push(json!({
                "kind": "node",
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "bookId": row.get::<_, String>(2)?,
                "deleted": row.get::<_, bool>(3)?,
                "where": "content",
                "content": parse_doc(&row.get::<_, String>(4)?),
            }));
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, deleted_at IS NOT NULL FROM maps WHERE asset_id = ?1
             ORDER BY deleted_at IS NOT NULL, title",
        )?;
        let mut rows = stmt.query([id])?;
        while let Some(row) = rows.next()? {
            uses.push(json!({
                "kind": "map",
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "bookId": null,
                "deleted": row.get::<_, bool>(2)?,
                "where": "map",
                "content": null,
            }));
        }
    }
    // Nothing to list, but something else keeps it from being unused: a saved version, say.
    let elsewhere = uses.is_empty() && referenced_ids(&conn, &[id.to_string()])?.contains(id);
    ok(json!({ "uses": uses, "elsewhere": elsewhere }))
}

// ---------------------------------------------------------------------------
// Whole files, for bulk import
// ---------------------------------------------------------------------------

/// The bytes of an asset being imported. A file stays on disk until it is written, so a
/// long video never sits in memory.
pub enum AssetBody {
    Bytes(Vec<u8>),
    File(PathBuf),
}

impl AssetBody {
    fn head(&self) -> AppResult<Vec<u8>> {
        match self {
            Self::Bytes(bytes) => Ok(bytes[..bytes.len().min(SNIFF_BYTES)].to_vec()),
            Self::File(path) => read_head(path),
        }
    }

    fn size(&self) -> AppResult<u64> {
        match self {
            Self::Bytes(bytes) => Ok(bytes.len() as u64),
            Self::File(path) => Ok(fs::metadata(path)?.len()),
        }
    }

    pub fn sha256(&self) -> AppResult<String> {
        match self {
            Self::Bytes(bytes) => Ok(hex(&Sha256::digest(bytes))),
            Self::File(path) => hash_file(path),
        }
    }

    fn write_chunks(&self, conn: &Connection, id: &str) -> AppResult<()> {
        let mut stmt =
            conn.prepare("INSERT INTO asset_chunks (asset_id, idx, bytes) VALUES (?1, ?2, ?3)")?;
        match self {
            Self::Bytes(bytes) => {
                for (index, chunk) in bytes.chunks(CHUNK_SIZE).enumerate() {
                    stmt.execute(params![id, index as i64, chunk])?;
                }
            }
            Self::File(path) => {
                let mut file = File::open(path)?;
                let mut buffer = Vec::with_capacity(CHUNK_SIZE);
                let mut index = 0i64;
                loop {
                    buffer.clear();
                    (&mut file).take(CHUNK_SIZE as u64).read_to_end(&mut buffer)?;
                    if buffer.is_empty() {
                        return Ok(());
                    }
                    stmt.execute(params![id, index, buffer])?;
                    index += 1;
                }
            }
        }
        Ok(())
    }
}

/// True if a declared type is one we accept. Unlike a browser's guess, a declared type
/// has to say something.
pub fn accepts_type(declared: &str) -> bool {
    matches!(reported_kind(declared), Ok(Some(_)))
}

/// The accepted types, for messages.
pub fn accepted_types() -> String {
    SERVED_TYPES.join(", ")
}

/// What an imported file really is, or why it will not do, as the end of a sentence
/// that starts with its name.
pub fn check_body(declared: &str, body: &AssetBody) -> Result<Sniffed, String> {
    let head = body.head().map_err(|e| format!("could not be read: {}", e.message))?;
    let found = sniff(&head).ok_or("is not really a supported picture, video, sound or PDF")?;
    if matches!(reported_kind(declared), Ok(Some(kind)) if kind != found.kind) {
        return Err(format!("says it is a {declared} but its contents are a {}", found.mime));
    }
    let size = body.size().map_err(|e| format!("could not be read: {}", e.message))?;
    if size == 0 {
        return Err("is empty".to_string());
    }
    if let Some(max) = max_bytes(found.kind).filter(|max| size > *max) {
        return Err(format!("is larger than {} MB", max / (1024 * 1024)));
    }
    Ok(found)
}

/// The asset already holding these exact bytes, if any.
pub fn identical_asset(conn: &Connection, sha256: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM assets WHERE sha256 = ?1 AND complete = 1 AND external_path IS NULL",
            [sha256],
            |r| r.get(0),
        )
        .optional()?)
}

pub struct WholeAsset<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub found: Sniffed,
    pub sha256: &'a str,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub created_at: &'a str,
}

/// Stores a whole asset inside the caller's transaction. `with_bytes` is false for an
/// import's preview, which needs the row for references and rolls back anyway.
pub fn store_whole(
    conn: &Connection,
    asset: &WholeAsset<'_>,
    body: &AssetBody,
    with_bytes: bool,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO assets (id, name, mime, kind, size, chunk_size, sha256, width, height,
                             complete, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10)",
        params![
            asset.id,
            asset.name,
            asset.found.mime,
            asset.found.kind,
            body.size()? as i64,
            CHUNK_SIZE as i64,
            asset.sha256,
            asset.width,
            asset.height,
            asset.created_at,
        ],
    )?;
    if with_bytes {
        body.write_chunks(conn, asset.id)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/// An E2E run notes the links it would open, so a test run never starts a real browser.
static E2E_OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn note_e2e_opened(url: &str) {
    E2E_OPENED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(url.to_string());
}

/// Writes a PDF or sound file to the temp folder, named by its id, for another program.
/// Only those two kinds: a copy of a picture or video has no use, and nothing else is stored.
fn copy_for_opening(engine: &Engine, id: &str) -> AppResult<PathBuf> {
    let info = get_info(engine, id)?;
    let extension = match info.mime.as_str() {
        "application/pdf" => "pdf",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/aac" => "aac",
        "audio/ogg" => "ogg",
        "audio/wav" => "wav",
        "audio/flac" => "flac",
        _ => return Err(refused("Only PDF and sound files open in another program.")),
    };
    // Ids are UUIDs, but this name becomes a path, so check.
    if !info.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::invalid("That id is not valid."));
    }
    let asset = ReadableAsset::open(engine, id)?;
    let folder = std::env::temp_dir().join("LoreCraft").join("open");
    fs::create_dir_all(&folder)?;
    let path = folder.join(format!("{}.{extension}", info.id));
    let mut out = File::create(&path)?;
    let mut start = 0;
    while start < asset.size {
        let end = (start + CHUNK_SIZE as u64 - 1).min(asset.size - 1);
        out.write_all(&asset.read(start, end)?)?;
        start = end + 1;
    }
    out.flush()?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

fn get_info(engine: &Engine, id: &str) -> AppResult<AssetInfo> {
    let conn = read_connection(engine)?;
    let row = get_row(&conn, id)?
        .filter(|r| r.complete)
        .ok_or_else(|| AppError::not_found("That picture or video"))?;
    Ok(info_of(engine, row))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct MeasureParams {
    width: Option<i64>,
    height: Option<i64>,
    duration: Option<f64>,
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    #[derive(Deserialize)]
    struct IdParam {
        id: String,
    }
    #[derive(Deserialize)]
    struct PathParam {
        path: PathBuf,
    }
    match action {
        "uploadBegin" => {
            #[derive(Deserialize)]
            struct P {
                name: String,
                #[serde(default)]
                mime: String,
                size: u64,
            }
            let p: P = parse(params)?;
            upload_begin(engine, &p.name, &p.mime, p.size)
        }
        "uploadFinish" => upload_finish(engine, parse(params)?),
        "uploadCancel" => {
            let p: IdParam = parse(params)?;
            discard_upload(engine, &p.id)?;
            ok(true)
        }
        // Embeds from a path, for files chosen in a dialog. The bytes never reach the UI.
        "uploadChunkFromPath" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                index: u64,
                path: PathBuf,
            }
            let p: P = parse(params)?;
            engine.check_allowed(&p.path)?;
            let mut file = File::open(&p.path)?;
            file.seek(SeekFrom::Start(p.index * CHUNK_SIZE as u64))?;
            let mut bytes = Vec::with_capacity(CHUNK_SIZE);
            file.take(CHUNK_SIZE as u64).read_to_end(&mut bytes)?;
            upload_chunk(engine, &p.id, p.index, &bytes)
        }
        "inspectPath" => {
            let p: PathParam = parse(params)?;
            engine.check_allowed(&p.path)?;
            let found = sniff(&read_head(&p.path)?)
                .ok_or_else(|| refused(&format!("{} is not a supported type.", file_name(&p.path))))?;
            ok(json!({
                "name": file_name(&p.path),
                "size": fs::metadata(&p.path)?.len(),
                "mime": found.mime,
                "kind": found.kind,
            }))
        }
        "get" => {
            let p: IdParam = parse(params)?;
            ok(get_info(engine, &p.id)?)
        }
        "list" => {
            let conn = read_connection(engine)?;
            let mut stmt = conn.prepare(&format!(
                "SELECT {ROW_COLUMNS} FROM assets WHERE complete = 1 ORDER BY created_at"
            ))?;
            let rows = stmt.query_map([], row_from)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(info_of(engine, row?));
            }
            ok(out)
        }
        "link" => {
            #[derive(Deserialize)]
            struct P {
                path: PathBuf,
                #[serde(flatten)]
                measure: MeasureParams,
            }
            let p: P = parse(params)?;
            ok(link_file(engine, &p.path, &p.measure)?)
        }
        "relink" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                path: PathBuf,
            }
            let p: P = parse(params)?;
            ok(relink_file(engine, &p.id, &p.path)?)
        }
        "setMeasure" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                #[serde(flatten)]
                measure: MeasureParams,
            }
            let p: P = parse(params)?;
            engine.write(|tx| {
                tx.execute(
                    "UPDATE assets SET width = COALESCE(?1, width), height = COALESCE(?2, height),
                                       duration = COALESCE(?3, duration)
                     WHERE id = ?4",
                    params![p.measure.width, p.measure.height, p.measure.duration, p.id],
                )?;
                Ok(())
            })?;
            ok(true)
        }
        // Opens a PDF or sound file in the system's own program, from a copy in the temp folder.
        "open" => {
            let p: IdParam = parse(params)?;
            let path = copy_for_opening(engine, &p.id)?;
            engine.host.open_folder(&path)?;
            ok(true)
        }
        "library" => library(engine),
        "usage" => {
            let p: IdParam = parse(params)?;
            usage(engine, &p.id)
        }
        "setLabel" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                #[serde(default)]
                label: String,
                #[serde(default)]
                description: String,
            }
            let p: P = parse(params)?;
            engine.write(|tx| {
                let changed = tx.execute(
                    "UPDATE assets SET label = ?1, description = ?2 WHERE id = ?3 AND complete = 1",
                    params![p.label, p.description, p.id],
                )?;
                if changed == 0 {
                    return Err(AppError::not_found("That picture or video"));
                }
                Ok(())
            })?;
            engine.notify("media");
            ok(true)
        }
        "replace" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                with: String,
            }
            let p: P = parse(params)?;
            replace_asset(engine, &p.id, &p.with)
        }
        "delete" => {
            let p: IdParam = parse(params)?;
            delete_asset(engine, &p.id)
        }
        "unused" => list_unused(engine),
        "removeUnused" => {
            #[derive(Deserialize)]
            struct P {
                ids: Vec<String>,
            }
            let p: P = parse(params)?;
            remove_unused(engine, &p.ids)
        }
        "e2eOpened" => {
            if !paths::is_e2e() {
                return Err(unknown("media.e2eOpened"));
            }
            ok(E2E_OPENED
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone())
        }
        _ => Err(unknown(&format!("media.{action}"))),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::rpc::call;

    /// Bytes that start like a real PNG and do not repeat.
    pub fn png_bytes(len: usize) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let mut x: u32 = 0x1234_5678;
        while bytes.len() < len {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            bytes.push((x & 0xFF) as u8);
        }
        bytes.truncate(len);
        bytes
    }

    /// The smallest bytes that pass as a WebM video, padded to `len`.
    pub fn webm_bytes(len: usize) -> Vec<u8> {
        let mut bytes = vec![0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x82, 0x84];
        bytes.extend_from_slice(b"webm");
        bytes.resize(len.max(bytes.len()), 7);
        bytes
    }

    pub fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    /// A PNG's bytes that no other call to this has returned, so storing it makes a new asset.
    pub fn unique_png() -> Vec<u8> {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let next = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut bytes = png_bytes(64);
        bytes.extend_from_slice(&next.to_be_bytes());
        bytes
    }

    /// Uploads through the same calls the UI makes and returns the finished asset.
    pub fn upload(engine: &Engine, name: &str, mime: &str, bytes: &[u8]) -> Value {
        let begun = call(
            engine,
            "media.uploadBegin",
            json!({ "name": name, "mime": mime, "size": bytes.len() }),
        );
        let id = begun["id"].as_str().unwrap();
        assert_eq!(begun["chunkSize"], CHUNK_SIZE);
        for (index, chunk) in bytes.chunks(CHUNK_SIZE).enumerate() {
            upload_chunk(engine, id, index as u64, chunk).unwrap();
        }
        call(
            engine,
            "media.uploadFinish",
            json!({ "id": id, "sha256": sha(bytes), "width": 4, "height": 3 }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::rpc::{call, dispatch};
    use crate::session::Session;

    fn count(engine: &Engine, sql: &str) -> i64 {
        engine.read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?)).unwrap()
    }

    fn new_project() -> (std::sync::Arc<Engine>, std::sync::Arc<crate::engine::TestHost>, crate::engine::TestDir) {
        let (engine, host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        (engine, host, dir)
    }

    fn read_all(engine: &Engine, id: &str, size: usize) -> Vec<u8> {
        let mut out = Vec::new();
        while out.len() < size {
            let piece = read_range(engine, id, out.len() as u64, 1024 * 1024).unwrap();
            assert!(!piece.is_empty());
            out.extend_from_slice(&piece);
        }
        out
    }

    #[test]
    fn sniffing_recognizes_each_allowed_type_and_nothing_else() {
        let ftyp = |brand: &[u8; 4], compat: &[u8; 4]| {
            let mut b = vec![0, 0, 0, 24];
            b.extend_from_slice(b"ftyp");
            b.extend_from_slice(brand);
            b.extend_from_slice(&[0, 0, 0, 0]);
            b.extend_from_slice(compat);
            b.extend_from_slice(b"isom");
            b.extend_from_slice(&[0; 8]);
            b
        };
        let mime = |bytes: &[u8]| sniff(bytes).map(|s| s.mime);
        assert_eq!(mime(&png_bytes(32)), Some("image/png"));
        assert_eq!(mime(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some("image/jpeg"));
        assert_eq!(mime(b"GIF89a....."), Some("image/gif"));
        assert_eq!(mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(mime(&ftyp(b"avif", b"mif1")), Some("image/avif"));
        assert_eq!(mime(&ftyp(b"mif1", b"avif")), Some("image/avif"));
        assert_eq!(mime(&ftyp(b"isom", b"mp42")), Some("video/mp4"));
        assert_eq!(mime(&ftyp(b"qt  ", b"qt  ")), Some("video/quicktime"));
        assert_eq!(mime(b"\0\0\0\x08wide\0\0\0\0mdat"), Some("video/quicktime"));
        assert_eq!(mime(&webm_bytes(40)), Some("video/webm"));
        assert_eq!(mime(b"OggS\0\x02\0\0\0\0"), Some("video/ogg"));

        assert_eq!(mime(&ftyp(b"heic", b"mif1")), None, "HEIC is not on the list");
        assert_eq!(mime(&ftyp(b"M4P ", b"isom")), None, "protected audio is not on the list");
        assert_eq!(mime(&ftyp(b"3gp4", b"isom")), None);
        let mut matroska = vec![0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x82, 0x88];
        matroska.extend_from_slice(b"matroska");
        assert_eq!(mime(&matroska), None);
        assert_eq!(mime(b"<!DOCTYPE html><html>"), None);
        assert_eq!(mime(b"<svg xmlns='http://www.w3.org/2000/svg'/>"), None);
        assert_eq!(mime(b""), None);
        assert_eq!(mime(b"\x89PN"), None);
    }

    #[test]
    fn sniffing_recognizes_sound_and_pdf() {
        let kind = |bytes: &[u8]| sniff(bytes).map(|s| (s.mime, s.kind));
        assert_eq!(kind(b"%PDF-1.7\n%\xE2\xE3"), Some(("application/pdf", "pdf")));
        assert_eq!(kind(b"ID3\x04\0\0\0\0\0\0"), Some(("audio/mpeg", "audio")));
        assert_eq!(kind(&[0xFF, 0xFB, 0x90, 0x64]), Some(("audio/mpeg", "audio")));
        assert_eq!(kind(&[0xFF, 0xF1, 0x50, 0x80]), Some(("audio/aac", "audio")));
        assert_eq!(kind(b"RIFF\0\0\0\0WAVEfmt "), Some(("audio/wav", "audio")));
        assert_eq!(kind(b"fLaC\0\0\0\x22"), Some(("audio/flac", "audio")));
        assert_eq!(kind(b"OggS\0\x02\0\0\0\0\0\0\0\0OpusHead"), Some(("audio/ogg", "audio")));
        assert_eq!(kind(b"OggS\0\x02\0\0\x01vorbis"), Some(("audio/ogg", "audio")));
        assert_eq!(kind(b"OggS\0\x02\0\0\x80theora..\x01vorbis"), Some(("video/ogg", "video")));
        let mut m4a = vec![0, 0, 0, 20];
        m4a.extend_from_slice(b"ftypM4A \0\0\0\0isom");
        assert_eq!(kind(&m4a), Some(("audio/mp4", "audio")));
        // JPEG's marker is not mistaken for an MPEG frame.
        assert_eq!(kind(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(("image/jpeg", "image")));
        assert_eq!(kind(&[0xFF, 0x00, 0x00]), None);
        assert_eq!(kind(b"MThd\0\0\0\x06"), None, "MIDI is not on the list");
    }

    #[test]
    fn sound_and_pdf_upload_with_their_own_limits() {
        let (engine, _host, _dir) = new_project();
        let mut pdf = b"%PDF-1.4\n".to_vec();
        pdf.resize(500, b' ');
        let asset = upload(&engine, "map.pdf", "application/pdf", &pdf);
        assert_eq!(asset["kind"], "pdf");
        assert_eq!(asset["mime"], "application/pdf");
        let mut mp3 = b"ID3\x04\0\0\0\0\0\0".to_vec();
        mp3.resize(300, 0);
        let asset = upload(&engine, "theme.mp3", "audio/mpeg", &mp3);
        assert_eq!(asset["kind"], "audio");
        // `.ogg` reported as sound but holding a video is still a video.
        let ogg = b"OggS\0\x02\0\0\0\0\0\0\0\0\x80theora".to_vec();
        assert_eq!(upload(&engine, "clip.ogg", "audio/ogg", &ogg)["kind"], "video");

        let too_big = dispatch(
            &engine,
            "media.uploadBegin",
            json!({ "name": "x.pdf", "mime": "application/pdf", "size": MAX_PDF_BYTES + 1 }),
        );
        assert!(too_big.unwrap_err().message.contains("PDF"));
        let too_big = dispatch(
            &engine,
            "media.uploadBegin",
            json!({ "name": "x.wav", "mime": "audio/wav", "size": MAX_AUDIO_BYTES + 1 }),
        );
        assert!(too_big.is_err());

        // A PDF dressed up as a sound file.
        let begun = call(
            &engine,
            "media.uploadBegin",
            json!({ "name": "x.mp3", "mime": "audio/mpeg", "size": pdf.len() }),
        );
        let err = upload_chunk(&engine, begun["id"].as_str().unwrap(), 0, &pdf).unwrap_err();
        assert_eq!(err.code, UNSUPPORTED);
    }

    #[test]
    fn opening_copies_only_pdf_and_sound_files() {
        let (engine, _host, _dir) = new_project();
        let mut pdf = b"%PDF-1.4\n".to_vec();
        pdf.resize(500, b'x');
        let id = upload(&engine, "map.pdf", "application/pdf", &pdf)["id"].as_str().unwrap().to_string();
        let path = copy_for_opening(&engine, &id).unwrap();
        assert_eq!(path.extension().unwrap(), "pdf");
        assert_eq!(fs::read(&path).unwrap(), pdf);
        assert_eq!(call(&engine, "media.open", json!({ "id": id })), json!(true));
        let png = upload(&engine, "a.png", "image/png", &png_bytes(100));
        let err = dispatch(&engine, "media.open", json!({ "id": png["id"] })).unwrap_err();
        assert_eq!(err.code, UNSUPPORTED);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn chunked_uploads_round_trip_and_split_across_rows() {
        let (engine, _host, _dir) = new_project();
        let bytes = png_bytes(2 * CHUNK_SIZE + 1234);
        let asset = upload(&engine, "big.png", "image/png", &bytes);
        let id = asset["id"].as_str().unwrap();
        assert_eq!(asset["deduped"], false);
        assert_eq!(asset["size"], bytes.len());
        assert_eq!(asset["mime"], "image/png");
        assert_eq!(asset["kind"], "image");
        assert_eq!(asset["width"], 4);
        assert_eq!(asset["sha256"], sha(&bytes));
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM asset_chunks"), 3);
        assert_eq!(
            count(&engine, "SELECT MAX(length(bytes)) FROM asset_chunks"),
            CHUNK_SIZE as i64
        );
        assert_eq!(read_all(&engine, id, bytes.len()), bytes);
        assert_eq!(call(&engine, "media.get", json!({ "id": id }))["linked"], false);
    }

    #[test]
    fn finishing_verifies_the_hash_and_the_size() {
        let (engine, _host, _dir) = new_project();
        let bytes = png_bytes(1000);
        let begun = call(
            &engine,
            "media.uploadBegin",
            json!({ "name": "a.png", "mime": "image/png", "size": 1000 }),
        );
        let id = begun["id"].as_str().unwrap();
        upload_chunk(&engine, id, 0, &bytes).unwrap();
        let wrong = dispatch(
            &engine,
            "media.uploadFinish",
            json!({ "id": id, "sha256": "0".repeat(64) }),
        );
        assert_eq!(wrong.unwrap_err().code, "HASH_MISMATCH");
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM assets"), 0, "the upload is dropped");
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM asset_chunks"), 0);

        // Declared larger than what arrives.
        let begun = call(
            &engine,
            "media.uploadBegin",
            json!({ "name": "a.png", "mime": "image/png", "size": CHUNK_SIZE + 10 }),
        );
        let id = begun["id"].as_str().unwrap();
        let first = png_bytes(CHUNK_SIZE);
        upload_chunk(&engine, id, 0, &first).unwrap();
        let short = dispatch(
            &engine,
            "media.uploadFinish",
            json!({ "id": id, "sha256": sha(&first) }),
        );
        assert_eq!(short.unwrap_err().code, "UPLOAD_INCOMPLETE");
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM assets"), 0);

        let bad_hash = dispatch(
            &engine,
            "media.uploadFinish",
            json!({ "id": "x", "sha256": "abc" }),
        );
        assert_eq!(bad_hash.unwrap_err().code, "INVALID");
    }

    #[test]
    fn chunks_must_fit_and_arrive_in_order() {
        let (engine, _host, _dir) = new_project();
        let size = CHUNK_SIZE + 10;
        let begun = call(
            &engine,
            "media.uploadBegin",
            json!({ "name": "a.png", "mime": "image/png", "size": size }),
        );
        let id = begun["id"].as_str().unwrap();
        let bytes = png_bytes(size);
        let gap = upload_chunk(&engine, id, 1, &bytes[CHUNK_SIZE..]).unwrap_err();
        assert_eq!(gap.code, "INVALID");
        upload_chunk(&engine, id, 0, &bytes[..CHUNK_SIZE]).unwrap();
        // Sending one again is allowed, so a retry after a lost reply works.
        upload_chunk(&engine, id, 0, &bytes[..CHUNK_SIZE]).unwrap();
        let wrong_size = upload_chunk(&engine, id, 1, &bytes[CHUNK_SIZE..size - 1]).unwrap_err();
        assert_eq!(wrong_size.code, "INVALID");
        let past_end = upload_chunk(&engine, id, 2, &bytes[..10]).unwrap_err();
        assert_eq!(past_end.code, "INVALID");
        upload_chunk(&engine, id, 1, &bytes[CHUNK_SIZE..]).unwrap();
        let done = call(
            &engine,
            "media.uploadFinish",
            json!({ "id": id, "sha256": sha(&bytes) }),
        );
        assert_eq!(done["size"], size);
    }

    #[test]
    fn identical_content_is_stored_once() {
        let (engine, _host, _dir) = new_project();
        let bytes = png_bytes(CHUNK_SIZE + 500);
        let first = upload(&engine, "one.png", "image/png", &bytes);
        let second = upload(&engine, "two.png", "image/png", &bytes);
        assert_eq!(first["id"], second["id"]);
        assert_eq!(second["deduped"], true);
        assert_eq!(second["name"], "one.png");
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM assets"), 1);
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM asset_chunks"), 2);
        let other = upload(&engine, "three.png", "image/png", &png_bytes(600));
        assert_ne!(other["id"], first["id"]);
    }

    #[test]
    fn unsafe_and_unknown_types_are_refused() {
        let (engine, _host, _dir) = new_project();
        for mime in ["image/svg+xml", "text/html", "audio/midi", "video/x-matroska"] {
            let result = dispatch(
                &engine,
                "media.uploadBegin",
                json!({ "name": "x", "mime": mime, "size": 10 }),
            );
            assert_eq!(result.unwrap_err().code, UNSUPPORTED, "{mime}");
        }

        // The browser's word is not enough: the bytes decide.
        for (mime, bytes) in [
            ("image/png", &b"<html><script>alert(1)</script></html>"[..]),
            ("image/png", &b"<svg xmlns='http://www.w3.org/2000/svg'/>"[..]),
            ("", &b"plain text, not a picture"[..]),
            ("application/octet-stream", &b"MZ\x90\0\x03\0\0\0"[..]),
        ] {
            let begun = call(
                &engine,
                "media.uploadBegin",
                json!({ "name": "x", "mime": mime, "size": bytes.len() }),
            );
            let err = upload_chunk(&engine, begun["id"].as_str().unwrap(), 0, bytes).unwrap_err();
            assert_eq!(err.code, UNSUPPORTED);
            assert_eq!(count(&engine, "SELECT COUNT(*) FROM assets"), 0, "refusal ends the upload");
        }

        // A video dressed up as a picture.
        let bytes = webm_bytes(64);
        let begun = call(
            &engine,
            "media.uploadBegin",
            json!({ "name": "x.png", "mime": "image/png", "size": bytes.len() }),
        );
        let err = upload_chunk(&engine, begun["id"].as_str().unwrap(), 0, &bytes).unwrap_err();
        assert_eq!(err.code, UNSUPPORTED);

        // A misnamed but allowed file is stored as what it really is.
        let bytes = png_bytes(64);
        let asset = upload(&engine, "actually-png.jpg", "image/jpeg", &bytes);
        assert_eq!(asset["mime"], "image/png");
        let asset = upload(&engine, "no-type", "", &webm_bytes(80));
        assert_eq!(asset["kind"], "video");
        assert_eq!(asset["mime"], "video/webm");

        let empty = dispatch(
            &engine,
            "media.uploadBegin",
            json!({ "name": "x.png", "mime": "image/png", "size": 0 }),
        );
        assert_eq!(empty.unwrap_err().code, "INVALID");

        let huge = dispatch(
            &engine,
            "media.uploadBegin",
            json!({ "name": "x.png", "mime": "image/png", "size": MAX_IMAGE_BYTES + 1 }),
        );
        assert_eq!(huge.unwrap_err().code, "INVALID");
    }

    #[test]
    fn cancel_and_project_open_remove_unfinished_uploads() {
        let (engine, _host, dir) = new_project();
        let bytes = png_bytes(CHUNK_SIZE + 1);
        let start = || {
            let begun = call(
                &engine,
                "media.uploadBegin",
                json!({ "name": "a.png", "mime": "image/png", "size": bytes.len() }),
            );
            let id = begun["id"].as_str().unwrap().to_string();
            upload_chunk(&engine, &id, 0, &bytes[..CHUNK_SIZE]).unwrap();
            id
        };

        let cancelled = start();
        call(&engine, "media.uploadCancel", json!({ "id": cancelled }));
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM assets"), 0);
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM asset_chunks"), 0);

        // Unfinished work does not show up as media, and cannot be read.
        let unfinished = start();
        let err = read_range(&engine, &unfinished, 0, 10).unwrap_err();
        assert_eq!(err.code, "NOT_FOUND");
        assert_eq!(call(&engine, "media.list", json!({})).as_array().unwrap().len(), 0);

        let kept = upload(&engine, "kept.png", "image/png", &png_bytes(100));
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM assets"), 2);

        // Saved with the upload half done, then reopened.
        let target = dir.0.join("half.lorecraft");
        engine.allow_path(&target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        call(&engine, "project.close", json!({}));
        call(&engine, "project.open", json!({ "path": target }));
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM assets"), 1);
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM asset_chunks"), 1);
        assert!(!engine.status().dirty, "tidying up is not an edit");
        assert_eq!(call(&engine, "media.get", json!({ "id": kept["id"] }))["name"], "kept.png");

        // Interrupted by a crash, then recovered.
        start();
        let session = engine.session().take().unwrap();
        let session_id = session.id.clone();
        drop(session);
        let list = call(&engine, "project.listRecoverable", json!({}));
        assert_eq!(list[0]["sessionId"], session_id.as_str());
        call(&engine, "project.recover", json!({ "sessionId": session_id }));
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM assets"), 1);
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM asset_chunks"), 1);
    }

    #[test]
    fn media_survives_saving_and_reopening() {
        let (engine, _host, dir) = new_project();
        let bytes = webm_bytes(CHUNK_SIZE * 2 + 99);
        let asset = upload(&engine, "clip.webm", "video/webm", &bytes);
        let id = asset["id"].as_str().unwrap();

        let target = dir.0.join("media.lorecraft");
        engine.allow_path(&target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        assert!(std::fs::metadata(&target).unwrap().len() > bytes.len() as u64);
        call(&engine, "project.close", json!({}));
        assert_eq!(read_range(&engine, id, 0, 1).unwrap_err().code, "NO_PROJECT");

        call(&engine, "project.open", json!({ "path": target }));
        let info = call(&engine, "media.get", json!({ "id": id }));
        assert_eq!(info["sha256"], sha(&bytes));
        assert_eq!(read_all(&engine, id, bytes.len()), bytes);
    }

    /// Picks the path the way a file dialog would.
    fn pick(engine: &Engine, host: &crate::engine::TestHost, path: &Path) {
        host.next_picks.lock().unwrap().push(path.to_path_buf());
        dispatch(engine, "files.pickOpen", json!({})).unwrap();
    }

    #[test]
    fn a_file_chosen_in_a_dialog_can_be_embedded_from_its_path() {
        let (engine, host, dir) = new_project();
        let bytes = webm_bytes(2 * CHUNK_SIZE + 77);
        let path = dir.0.join("chosen.webm");
        std::fs::write(&path, &bytes).unwrap();

        let refused = dispatch(&engine, "media.inspectPath", json!({ "path": path }));
        assert_eq!(refused.unwrap_err().code, "PATH_NOT_ALLOWED");

        pick(&engine, &host, &path);
        let inspected = call(&engine, "media.inspectPath", json!({ "path": path }));
        assert_eq!(inspected["name"], "chosen.webm");
        assert_eq!(inspected["kind"], "video");
        assert_eq!(inspected["size"], bytes.len());

        let begun = call(
            &engine,
            "media.uploadBegin",
            json!({ "name": "chosen.webm", "mime": "video/webm", "size": bytes.len() }),
        );
        let id = begun["id"].as_str().unwrap();
        for index in 0..3 {
            call(
                &engine,
                "media.uploadChunkFromPath",
                json!({ "id": id, "index": index, "path": path }),
            );
        }
        let done = call(
            &engine,
            "media.uploadFinish",
            json!({ "id": id, "sourcePath": path }),
        );
        assert_eq!(done["sha256"], sha(&bytes));
        assert_eq!(done["linked"], false);
        assert_eq!(read_all(&engine, id, bytes.len()), bytes);

        // A path nobody picked cannot feed an upload or vouch for one.
        let other = dir.0.join("other.webm");
        std::fs::write(&other, &bytes).unwrap();
        let begun = call(
            &engine,
            "media.uploadBegin",
            json!({ "name": "x", "mime": "", "size": bytes.len() }),
        );
        let id = begun["id"].as_str().unwrap();
        let refused = dispatch(
            &engine,
            "media.uploadChunkFromPath",
            json!({ "id": id, "index": 0, "path": other }),
        );
        assert_eq!(refused.unwrap_err().code, "PATH_NOT_ALLOWED");
        let refused = dispatch(
            &engine,
            "media.uploadFinish",
            json!({ "id": id, "sourcePath": other }),
        );
        assert_eq!(refused.unwrap_err().code, "PATH_NOT_ALLOWED");
    }

    #[test]
    fn linked_files_are_streamed_and_report_when_missing() {
        let (engine, host, dir) = new_project();
        let bytes = webm_bytes(CHUNK_SIZE + 5);
        let path = dir.0.join("linked.webm");
        std::fs::write(&path, &bytes).unwrap();

        // Only a path from a dialog can be linked.
        let refused = dispatch(&engine, "media.link", json!({ "path": path }));
        assert_eq!(refused.unwrap_err().code, "PATH_NOT_ALLOWED");

        pick(&engine, &host, &path);
        let info = call(&engine, "media.link", json!({ "path": path, "duration": 2.5 }));
        let id = info["id"].as_str().unwrap().to_string();
        assert_eq!(info["linked"], true);
        assert_eq!(info["missing"], false);
        assert_eq!(info["kind"], "video");
        assert_eq!(info["mime"], "video/webm");
        assert_eq!(info["size"], bytes.len());
        assert_eq!(info["duration"], 2.5);
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM asset_chunks"), 0, "the project stays small");
        assert_eq!(read_all(&engine, &id, bytes.len()), bytes);

        // Linking the same file again reuses the asset.
        let again = call(&engine, "media.link", json!({ "path": path }));
        assert_eq!(again["id"], id.as_str());

        // The file goes away.
        std::fs::remove_file(&path).unwrap();
        let info = call(&engine, "media.get", json!({ "id": id }));
        assert_eq!(info["missing"], true);
        assert_eq!(read_range(&engine, &id, 0, 10).unwrap_err().code, "FILE_MISSING");

        // Relink finds a new home for it under the same id.
        let moved = dir.0.join("moved.webm");
        std::fs::write(&moved, &bytes).unwrap();
        let refused = dispatch(&engine, "media.relink", json!({ "id": id, "path": moved }));
        assert_eq!(refused.unwrap_err().code, "PATH_NOT_ALLOWED");
        pick(&engine, &host, &moved);
        let info = call(&engine, "media.relink", json!({ "id": id, "path": moved }));
        assert_eq!(info["missing"], false);
        assert_eq!(info["name"], "moved.webm");
        assert_eq!(read_all(&engine, &id, bytes.len()), bytes);

        // A stored asset has nothing to relink.
        let stored = upload(&engine, "a.png", "image/png", &png_bytes(50));
        pick(&engine, &host, &moved);
        let result = dispatch(&engine, "media.relink", json!({ "id": stored["id"], "path": moved }));
        assert_eq!(result.unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn linking_refuses_anything_but_real_video_files() {
        let (engine, host, dir) = new_project();
        let cases: [(&str, Vec<u8>); 4] = [
            ("secret.txt", b"not a video".to_vec()),
            ("notes.html", b"<html></html>".to_vec()),
            ("fake.mp4", b"<html></html>".to_vec()),
            ("picture.webm", png_bytes(64)),
        ];
        for (name, bytes) in cases {
            let path = dir.0.join(name);
            std::fs::write(&path, bytes).unwrap();
            pick(&engine, &host, &path);
            let result = dispatch(&engine, "media.link", json!({ "path": path }));
            assert_eq!(result.unwrap_err().code, UNSUPPORTED, "{name}");
        }
    }

    /// Plants a row directly, as a hand-made project file could.
    fn plant_link(engine: &Engine, path: &str, mime: &str) -> String {
        let id = db::new_id();
        engine
            .write(|tx| {
                tx.execute(
                    "INSERT INTO assets (id, name, mime, kind, size, chunk_size, complete, external_path, created_at)
                     VALUES (?1, 'x', ?2, 'video', 10, 0, 1, ?3, ?4)",
                    params![id, mime, path, db::now()],
                )?;
                Ok(())
            })
            .unwrap();
        id
    }

    #[test]
    fn a_hand_made_project_cannot_read_arbitrary_files() {
        let (engine, _host, dir) = new_project();

        // A secret that is not a media file, under its own name and under a media name.
        let secret = dir.0.join("secret.txt");
        std::fs::write(&secret, b"my passwords").unwrap();
        let renamed = dir.0.join("secret.mp4");
        std::fs::write(&renamed, b"my passwords").unwrap();

        let id = plant_link(&engine, secret.to_str().unwrap(), "video/mp4");
        assert_eq!(read_range(&engine, &id, 0, 10).unwrap_err().code, "FILE_MISSING");

        let id = plant_link(&engine, renamed.to_str().unwrap(), "video/mp4");
        assert_eq!(read_range(&engine, &id, 0, 10).unwrap_err().code, UNSUPPORTED);

        let id = plant_link(&engine, "relative/clip.mp4", "video/mp4");
        assert_eq!(read_range(&engine, &id, 0, 10).unwrap_err().code, "FILE_MISSING");
        assert_eq!(call(&engine, "media.get", json!({ "id": id }))["missing"], true);

        let traversal = format!("{}/../secret.mp4", dir.0.display());
        let id = plant_link(&engine, &traversal, "video/mp4");
        assert_eq!(read_range(&engine, &id, 0, 10).unwrap_err().code, "FILE_MISSING");

        // Reaching a network path can leak credentials, so it needs a dialog first.
        if cfg!(windows) {
            let id = plant_link(&engine, r"\\attacker\share\clip.mp4", "video/mp4");
            assert_eq!(read_range(&engine, &id, 0, 10).unwrap_err().code, "FILE_MISSING");
            assert_eq!(call(&engine, "media.get", json!({ "id": id }))["missing"], true);
        }

        // A stored type outside the list is never served, whatever the row says.
        let real = dir.0.join("real.webm");
        std::fs::write(&real, webm_bytes(50)).unwrap();
        let id = plant_link(&engine, real.to_str().unwrap(), "text/html");
        assert_eq!(read_range(&engine, &id, 0, 10).unwrap_err().code, UNSUPPORTED);
    }

    fn page_with_image(engine: &Engine, title: &str, id: &str) -> Value {
        let page = call(engine, "pages.create", json!({ "title": title }));
        call(
            engine,
            "pages.update",
            json!({ "id": page["id"], "patch": { "content": {
                "type": "doc",
                "content": [{ "type": "figure", "attrs": { "kind": "picture" }, "content": [
                    { "type": "image", "attrs": { "assetId": id } },
                    { "type": "figcaption" }
                ]}]
            }}}),
        );
        page
    }

    fn unused_ids(engine: &Engine) -> Vec<String> {
        let unused = call(engine, "media.unused", json!({}));
        unused["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn unused_media_is_found_listed_and_removed_only_when_asked() {
        let (engine, host, dir) = new_project();
        let asset = |n: usize| {
            upload(&engine, &format!("{n}.png"), "image/png", &png_bytes(100 + n))["id"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let in_page = asset(1);
        let in_scene = asset(2);
        let in_infobox = asset(3);
        let in_map = asset(4);
        let in_old_revision = asset(5);
        let in_trash = asset(6);
        let unreferenced = asset(7);

        page_with_image(&engine, "In page", &in_page);

        let books = call(&engine, "books.list", json!({}));
        let tree = call(&engine, "nodes.tree", json!({ "bookId": books[0]["id"] }));
        let scene = tree
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["kind"] == "scene")
            .unwrap();
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": { "type": "doc", "content": [
                { "type": "figure", "content": [
                    { "type": "video", "attrs": { "assetId": in_scene } },
                    { "type": "figcaption" }
                ]}
            ]}}}),
        );

        let holder = call(&engine, "pages.create", json!({ "title": "Infobox" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": holder["id"], "patch": { "infobox": { "imageAssetId": in_infobox, "fields": [] }}}),
        );

        engine
            .write(|tx| {
                tx.execute(
                    "INSERT INTO maps (id, title, asset_id, created_at, updated_at)
                     VALUES ('m1', 'World', ?1, 'now', 'now')",
                    [&in_map],
                )?;
                Ok(())
            })
            .unwrap();

        // Only history still has this one. A figure removed today may be restored later.
        let page = page_with_image(&engine, "Edited", &in_old_revision);
        call(
            &engine,
            "revisions.checkpoint",
            json!({ "kind": "page", "id": page["id"], "reason": "manual" }),
        );
        call(
            &engine,
            "pages.update",
            json!({ "id": page["id"], "patch": { "content": { "type": "doc", "content": [{ "type": "paragraph" }] }}}),
        );

        // A page in the trash can come back.
        let trashed = page_with_image(&engine, "Trashed", &in_trash);
        call(&engine, "pages.delete", json!({ "id": trashed["id"] }));

        // A linked file with nothing pointing at it is listed but frees no room.
        let path = dir.0.join("loose.webm");
        std::fs::write(&path, webm_bytes(40)).unwrap();
        pick(&engine, &host, &path);
        let loose = call(&engine, "media.link", json!({ "path": path }));
        let loose = loose["id"].as_str().unwrap().to_string();

        let listed = call(&engine, "media.unused", json!({}));
        let mut ids = unused_ids(&engine);
        ids.sort();
        let mut expected = vec![unreferenced.clone(), loose.clone()];
        expected.sort();
        assert_eq!(ids, expected, "{listed}");
        let unreferenced_item = listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == unreferenced.as_str())
            .unwrap();
        assert_eq!(unreferenced_item["name"], "7.png");
        assert_eq!(unreferenced_item["storedBytes"], 107);
        assert_eq!(listed["totalBytes"], 107);
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM assets"), 8, "listing deletes nothing");

        // Asked to remove something that is in use, it refuses that one.
        let result = call(
            &engine,
            "media.removeUnused",
            json!({ "ids": [unreferenced, loose, in_page, in_map, "no-such-id"] }),
        );
        assert_eq!(result["removed"], 2);
        assert_eq!(result["freedBytes"], 107);
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM assets"), 6);
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM asset_chunks"), 6);
        assert!(unused_ids(&engine).is_empty());
    }

    #[test]
    fn replacing_keeps_every_use_and_deleting_removes_one_in_use() {
        let (engine, _host, _dir) = new_project();
        let first = unique_png();
        let old = upload(&engine, "old.png", "image/png", &first);
        let old_id = old["id"].as_str().unwrap().to_string();
        let page = page_with_image(&engine, "Harbor", &old_id);
        let second = unique_png();
        let new = upload(&engine, "new.png", "image/png", &second);
        let new_id = new["id"].as_str().unwrap().to_string();

        let replaced = call(&engine, "media.replace", json!({ "id": old_id, "with": new_id }));
        assert_eq!(replaced["id"], old_id.as_str());
        assert_eq!(replaced["name"], "new.png");
        assert_eq!(read_all(&engine, &old_id, second.len()), second);
        assert_eq!(count(&engine, "SELECT COUNT(*) FROM assets"), 1, "the upload is used up");
        let stored = call(&engine, "pages.get", json!({ "id": page["id"] }));
        assert!(stored["content"].to_string().contains(&old_id), "the page still shows it");

        // A file that is already in use elsewhere is refused, so no use is lost.
        let other = upload(&engine, "other.png", "image/png", &unique_png());
        let other_id = other["id"].as_str().unwrap().to_string();
        page_with_image(&engine, "Keep", &other_id);
        let error = dispatch(&engine, "media.replace", json!({ "id": old_id, "with": other_id })).unwrap_err();
        assert_eq!(error.code, "IN_USE");

        call(&engine, "media.delete", json!({ "id": old_id }));
        assert_eq!(count(&engine, &format!("SELECT COUNT(*) FROM assets WHERE id = '{old_id}'")), 0);
        assert_eq!(count(&engine, &format!("SELECT COUNT(*) FROM asset_chunks WHERE asset_id = '{old_id}'")), 0);
    }

    fn figure_doc(asset: &str, caption: &str) -> Value {
        json!({ "type": "doc", "content": [
            { "type": "figure", "attrs": { "kind": "picture", "description": "" }, "content": [
                { "type": "image", "attrs": { "assetId": asset } },
                { "type": "figcaption", "content": [{ "type": "text", "text": caption }] }
            ]},
            { "type": "paragraph" }
        ]})
    }

    fn library_item(engine: &Engine, id: &str) -> Value {
        let library = call(engine, "media.library", json!({}));
        library["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .unwrap()
            .clone()
    }

    #[test]
    fn the_library_says_what_documents_call_each_asset_and_where_it_is() {
        let (engine, _host, _dir) = new_project();
        let id_of = |asset: Value| asset["id"].as_str().unwrap().to_string();
        let shown = id_of(upload(&engine, "shown.png", "image/png", &png_bytes(100)));
        let spare = id_of(upload(&engine, "spare.png", "image/png", &png_bytes(101)));
        let in_map = id_of(upload(&engine, "map.png", "image/png", &png_bytes(102)));
        let history_only = id_of(upload(&engine, "old.png", "image/png", &png_bytes(103)));
        let bare = id_of(upload(&engine, "bare.png", "image/png", &png_bytes(104)));
        assert_eq!(call(&engine, "media.library", json!({}))["items"].as_array().unwrap().len(), 5);

        let aria = call(&engine, "pages.create", json!({ "title": "Aria", "content": figure_doc(&shown, "The gate") }));
        call(&engine, "pages.create", json!({ "title": "Bram", "content": figure_doc(&shown, "Another name") }));
        let holder = call(&engine, "pages.create", json!({ "title": "Holder" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": holder["id"], "patch": { "infobox": { "imageAssetId": shown, "fields": [] } } }),
        );
        call(
            &engine,
            "pages.create",
            json!({ "title": "Bare", "content": { "type": "doc", "content": [{ "type": "image", "attrs": { "assetId": bare } }] } }),
        );
        let trashed = call(&engine, "pages.create", json!({ "title": "Gone", "content": figure_doc(&shown, "Old") }));
        call(&engine, "pages.delete", json!({ "id": trashed["id"] }));

        let books = call(&engine, "books.list", json!({}));
        let book = books[0]["id"].as_str().unwrap().to_string();
        let tree = call(&engine, "nodes.tree", json!({ "bookId": book }));
        let scene = tree.as_array().unwrap().iter().find(|n| n["kind"] == "scene").unwrap().clone();
        call(
            &engine,
            "nodes.update",
            json!({ "id": scene["id"], "patch": { "content": figure_doc(&shown, "In the book") } }),
        );
        engine
            .write(|tx| {
                tx.execute(
                    "INSERT INTO maps (id, title, asset_id, created_at, updated_at) VALUES ('m1', 'World', ?1, 'now', 'now')",
                    [&in_map],
                )?;
                Ok(())
            })
            .unwrap();
        let old = call(&engine, "pages.create", json!({ "title": "Old", "content": figure_doc(&history_only, "Then") }));
        call(&engine, "revisions.checkpoint", json!({ "kind": "page", "id": old["id"], "reason": "manual" }));
        call(
            &engine,
            "pages.update",
            json!({ "id": old["id"], "patch": { "content": { "type": "doc", "content": [{ "type": "paragraph" }] } } }),
        );

        // Named from the first figure in title order, and counted once per place.
        let item = library_item(&engine, &shown);
        assert_eq!(item["label"], "The gate");
        assert_eq!(item["uses"], 4, "Aria, Bram, Holder's infobox and the scene: {item}");
        assert_eq!(item["inUse"], true);

        let item = library_item(&engine, &spare);
        assert_eq!(item["uses"], 0);
        assert_eq!(item["inUse"], false);
        assert_eq!(library_item(&engine, &in_map)["uses"], 1);
        assert_eq!(library_item(&engine, &bare)["uses"], 1);
        let item = library_item(&engine, &history_only);
        assert_eq!(item["uses"], 0);
        assert_eq!(item["inUse"], true, "a saved version can still bring it back");

        let usage = call(&engine, "media.usage", json!({ "id": shown }));
        let uses = usage["uses"].as_array().unwrap();
        let place = |title: &str, place: &str| {
            uses.iter().find(|u| u["title"] == title && u["where"] == place).unwrap_or_else(|| panic!("{title} {place}: {usage}"))
        };
        assert_eq!(place("Aria", "content")["id"], aria["id"]);
        assert_eq!(place("Aria", "content")["content"]["content"][0]["type"], "figure");
        assert_eq!(place("Aria", "content")["deleted"], false);
        assert_eq!(place("Gone", "content")["deleted"], true, "trash is listed, and marked");
        assert_eq!(place("Holder", "infobox")["content"], Value::Null);
        let scene_use = uses.iter().find(|u| u["kind"] == "node").unwrap();
        assert_eq!(scene_use["bookId"], book.as_str());
        assert_eq!(scene_use["where"], "content");
        assert_eq!(usage["elsewhere"], false);
        assert_eq!(uses.iter().position(|u| u["deleted"] == true), Some(uses.len() - 2), "{usage}");

        let usage = call(&engine, "media.usage", json!({ "id": in_map }));
        assert_eq!(usage["uses"][0]["kind"], "map");
        assert_eq!(usage["uses"][0]["id"], "m1");

        let usage = call(&engine, "media.usage", json!({ "id": history_only }));
        assert_eq!(usage["uses"].as_array().unwrap().len(), 0);
        assert_eq!(usage["elsewhere"], true);

        let usage = call(&engine, "media.usage", json!({ "id": spare }));
        assert_eq!(usage["uses"].as_array().unwrap().len(), 0);
        assert_eq!(usage["elsewhere"], false);
    }

    #[test]
    fn a_label_set_in_the_library_shows_until_a_figure_has_its_own() {
        let (engine, _host, _dir) = new_project();
        let asset = upload(&engine, "a.png", "image/png", &png_bytes(100));
        let id = asset["id"].as_str().unwrap();
        assert_eq!(asset["label"], "");

        call(&engine, "media.setLabel", json!({ "id": id, "label": "Stored", "description": "Detail" }));
        let item = library_item(&engine, id);
        assert_eq!(item["label"], "Stored");
        assert_eq!(item["description"], "Detail");

        call(&engine, "pages.create", json!({ "title": "P", "content": figure_doc(id, "Its own") }));
        let item = library_item(&engine, id);
        assert_eq!(item["label"], "Its own");
        assert_eq!(item["description"], "Detail", "that figure has no description of its own");

        let missing = dispatch(&engine, "media.setLabel", json!({ "id": "nope", "label": "x" }));
        assert_eq!(missing.unwrap_err().code, "NOT_FOUND");
    }

    #[test]
    fn five_hundred_items_are_listed_quickly() {
        let (engine, _host, _dir) = new_project();
        for n in 0..500 {
            let mut bytes = png_bytes(32);
            bytes.extend_from_slice(&(n as u32).to_be_bytes());
            let asset = upload(&engine, &format!("{n}.png"), "image/png", &bytes);
            if n % 2 == 0 {
                call(
                    &engine,
                    "pages.create",
                    json!({ "title": format!("Page {n}"), "content": figure_doc(asset["id"].as_str().unwrap(), "A label") }),
                );
            }
        }
        let start = std::time::Instant::now();
        let library = call(&engine, "media.library", json!({}));
        let elapsed = start.elapsed();
        assert_eq!(library["items"].as_array().unwrap().len(), 500);
        assert!(elapsed.as_secs_f64() < 2.0, "{elapsed:?}");
    }

    #[test]
    fn a_save_holding_the_session_lock_does_not_stop_media_reads() {
        let (engine, _host, _dir) = new_project();
        let bytes = png_bytes(2000);
        let id = upload(&engine, "a.png", "image/png", &bytes)["id"]
            .as_str()
            .unwrap()
            .to_string();

        let guard = engine.session();
        let activity = engine.begin_save(guard.as_ref().unwrap());
        let reader = {
            let engine = engine.clone();
            let id = id.clone();
            std::thread::spawn(move || read_range(&engine, &id, 0, 2000).unwrap())
        };
        let start = std::time::Instant::now();
        while !reader.is_finished() {
            assert!(
                start.elapsed() < std::time::Duration::from_secs(10),
                "the read waited for the lock"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(reader.join().unwrap(), bytes);
        drop(activity);
        drop(guard);
        assert_eq!(read_range(&engine, &id, 0, 2).unwrap(), &bytes[..2]);
    }

    #[test]
    fn saving_tells_the_ui_it_is_busy_and_when_it_ends() {
        let (engine, host, dir) = new_project();
        let target = dir.0.join("status.lorecraft");
        engine.allow_path(&target);
        host.events.lock().unwrap().clear();
        call(&engine, "project.saveAs", json!({ "path": target }));
        call(&engine, "project.save", json!({}));

        let phases: Vec<Value> = host
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(event, _)| event == "project://saving")
            .map(|(_, payload)| payload.clone())
            .collect();
        assert_eq!(
            phases,
            vec![
                json!({ "active": true, "phase": "saving" }),
                json!({ "active": false }),
                json!({ "active": true, "phase": "saving" }),
                json!({ "active": true, "phase": "backup" }),
                json!({ "active": false }),
            ]
        );
    }

    fn backups_of(dir: &Path) -> Vec<(PathBuf, u64)> {
        let root = dir.join("backups");
        let Ok(projects) = std::fs::read_dir(root) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for project in projects.filter_map(Result::ok) {
            for file in std::fs::read_dir(project.path()).unwrap().filter_map(Result::ok) {
                out.push((file.path(), file.metadata().unwrap().len()));
            }
        }
        out.sort();
        out
    }

    #[test]
    fn backups_stay_within_their_budget_and_prune_the_oldest_first() {
        let (engine, _host, dir) = new_project();
        let target = dir.0.join("b.lorecraft");
        engine.allow_path(&target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        let base = std::fs::metadata(&target).unwrap().len();
        crate::rpc::settings::update(
            &engine,
            &json!({ "save": { "backupBudgetBytes": base * 5 / 2 } }),
        )
        .unwrap();
        for i in 0..4 {
            call(&engine, "pages.create", json!({ "title": format!("P{i}") }));
            call(&engine, "project.save", json!({}));
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let backups = backups_of(&dir.0);
        let total: u64 = backups.iter().map(|b| b.1).sum();
        assert!(total <= base * 5 / 2, "{total} over budget");
        assert_eq!(backups.len(), 2, "two fit, and the rest were pruned: {backups:?}");

        // The ones left are the newest: the last save's previous file has P0, P1 and P2.
        let newest = &backups.last().unwrap().0;
        let conn = Connection::open(newest).unwrap();
        let pages: i64 = conn
            .query_row("SELECT COUNT(*) FROM pages WHERE title LIKE 'P%'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pages, 3);
    }

    #[test]
    fn a_project_over_the_budget_is_not_backed_up_and_the_ui_is_told() {
        let (engine, host, dir) = new_project();
        let target = dir.0.join("big.lorecraft");
        engine.allow_path(&target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        call(&engine, "pages.create", json!({ "title": "A" }));
        call(&engine, "project.save", json!({}));
        assert_eq!(backups_of(&dir.0).len(), 1);
        let kept = backups_of(&dir.0);

        // Now the project is larger than the whole budget.
        crate::rpc::settings::update(&engine, &json!({ "save": { "backupBudgetBytes": 10 } })).unwrap();
        host.events.lock().unwrap().clear();
        call(&engine, "pages.create", json!({ "title": "B" }));
        call(&engine, "project.save", json!({}));

        let size = std::fs::metadata(&kept[0].0).unwrap().len();
        assert_eq!(backups_of(&dir.0), kept, "nothing new, and the old backup stays");
        let warning: Vec<Value> = host
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(event, _)| event == "project://backup-skipped")
            .map(|(_, payload)| payload.clone())
            .collect();
        assert_eq!(warning.len(), 1);
        assert!(warning[0]["size"].as_u64().unwrap() >= size);
        assert!(!engine.status().dirty, "the save itself still happened");
    }

    #[test]
    fn the_newest_backup_stays_even_when_older_ones_must_go() {
        let (engine, _host, dir) = new_project();
        let target = dir.0.join("n.lorecraft");
        engine.allow_path(&target);
        call(&engine, "project.saveAs", json!({ "path": target }));
        for i in 0..3 {
            call(&engine, "pages.create", json!({ "title": format!("N{i}") }));
            call(&engine, "project.save", json!({}));
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(backups_of(&dir.0).len(), 3);

        // The next previous file fits the budget alone, but not beside the others.
        let size = std::fs::metadata(&target).unwrap().len();
        crate::rpc::settings::update(&engine, &json!({ "save": { "backupBudgetBytes": size } })).unwrap();
        call(&engine, "pages.create", json!({ "title": "Last" }));
        call(&engine, "project.save", json!({}));
        let backups = backups_of(&dir.0);
        assert_eq!(backups.len(), 1);
        let conn = Connection::open(&backups[0].0).unwrap();
        let pages: i64 = conn
            .query_row("SELECT COUNT(*) FROM pages WHERE title LIKE 'N%'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pages, 3, "the survivor is the most recent version");
    }

    #[test]
    fn the_session_is_found_by_its_real_working_copy() {
        let (engine, _host, _dir) = new_project();
        let path = engine.working_db_path().unwrap();
        assert!(path.ends_with("working.db"), "{}", path.display());
        let guard: std::sync::MutexGuard<'_, Option<Session>> = engine.session();
        assert!(guard.as_ref().unwrap().dir.join("working.db").exists());
    }
}
