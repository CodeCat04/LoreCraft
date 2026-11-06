//! The `lbasset` scheme, which is how the web view gets pictures, videos, sounds and PDFs.
//!
//! A URL names an asset by id and nothing else, so this cannot be pointed at a file. Only
//! the stored types in `SERVED_TYPES` are served, with `nosniff` so a browser never reinterprets
//! them. See `ReadableAsset` in `rpc/media.rs`.
//!
//! A response carries at most one window of a large asset. The media stack asks again from
//! where the last answer ended, so a long video never sits in memory in one piece.

use tauri::http::{header, Method, Request, Response, StatusCode};

use crate::engine::Engine;
use crate::error::AppError;
use crate::rpc::media::{ReadableAsset, CHUNK_SIZE, MAX_IMAGE_BYTES};

pub const SCHEME: &str = "lbasset";

/// The most a single range response carries.
const MAX_RANGE_BYTES: u64 = CHUNK_SIZE as u64;
/// The most a request with no range gets. Pictures can reach this. Videos always send a range.
const MAX_WHOLE_BYTES: u64 = MAX_IMAGE_BYTES;

#[derive(Debug, PartialEq, Eq)]
enum Requested {
    Whole,
    /// `bytes=a-b` or `bytes=a-`.
    From { start: u64, end: Option<u64> },
    /// `bytes=-n`
    Last(u64),
}

/// Reads a `Range` header. Anything malformed or using several ranges is treated as if the
/// header were absent, which RFC 9110 allows.
fn parse_range(value: Option<&str>) -> Requested {
    let Some(spec) = value.and_then(|v| v.trim().strip_prefix("bytes=")) else {
        return Requested::Whole;
    };
    let Some((start, end)) = spec.trim().split_once('-') else {
        return Requested::Whole;
    };
    match (start.trim(), end.trim()) {
        ("", last) => last.parse().map(Requested::Last).unwrap_or(Requested::Whole),
        (start, "") => start
            .parse()
            .map(|start| Requested::From { start, end: None })
            .unwrap_or(Requested::Whole),
        (start, end) => match (start.parse::<u64>(), end.parse::<u64>()) {
            (Ok(start), Ok(end)) if start <= end => Requested::From { start, end: Some(end) },
            _ => Requested::Whole,
        },
    }
}

fn base(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        // Relinking changes what an id means, and an asset can be removed.
        .header(header::CACHE_CONTROL, "no-cache")
        // Nothing here is a page, even if someone navigates to it.
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; sandbox")
}

fn empty(builder: tauri::http::response::Builder) -> Response<Vec<u8>> {
    builder
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn status_only(status: StatusCode) -> Response<Vec<u8>> {
    empty(base(status))
}

fn status_for(error: &AppError) -> StatusCode {
    match error.code.as_str() {
        "NOT_FOUND" | "NO_PROJECT" | "FILE_MISSING" => StatusCode::NOT_FOUND,
        "UNSUPPORTED_MEDIA" => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// Asset ids are UUIDs. Refusing anything else means nothing odd reaches a query or a path.
fn asset_id(path: &str) -> Option<&str> {
    let id = path.trim_start_matches('/');
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    valid.then_some(id)
}

/// Answers one request. Safe to run on any thread, and holds no lock while reading.
pub fn respond(engine: &Engine, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let head_only = request.method() == Method::HEAD;
    if !head_only && request.method() != Method::GET {
        return status_only(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some(id) = asset_id(request.uri().path()) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    let asset = match ReadableAsset::open(engine, id) {
        Ok(asset) => asset,
        Err(e) => return status_only(status_for(&e)),
    };
    let size = asset.size;
    let range = parse_range(request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()));

    let (start, end) = match range {
        Requested::Whole => {
            if size > MAX_WHOLE_BYTES {
                return status_only(StatusCode::PAYLOAD_TOO_LARGE);
            }
            let builder = base(StatusCode::OK)
                .header(header::CONTENT_TYPE, asset.mime.as_str())
                .header(header::CONTENT_LENGTH, size);
            if head_only || size == 0 {
                return empty(builder);
            }
            return match asset.read(0, size - 1) {
                Ok(bytes) => builder
                    .body(bytes)
                    .unwrap_or_else(|_| status_only(StatusCode::INTERNAL_SERVER_ERROR)),
                Err(e) => status_only(status_for(&e)),
            };
        }
        Requested::From { start, .. } if start >= size => return unsatisfiable(size),
        Requested::Last(0) => return unsatisfiable(size),
        _ if size == 0 => return unsatisfiable(size),
        Requested::From { start, end: None } => (start, asset.window_end(start)),
        Requested::From { start, end: Some(end) } => {
            (start, end.min(size - 1).min(start.saturating_add(MAX_RANGE_BYTES - 1)))
        }
        Requested::Last(count) => {
            let start = size - count.min(size);
            (start, (size - 1).min(start.saturating_add(MAX_RANGE_BYTES - 1)))
        }
    };

    let partial = |end: u64| {
        base(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, asset.mime.as_str())
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
            .header(header::CONTENT_LENGTH, end - start + 1)
    };
    if head_only {
        return empty(partial(end));
    }
    match asset.read(start, end) {
        // A linked file can shrink between measuring it and reading it.
        Ok(bytes) if bytes.is_empty() => unsatisfiable(size),
        Ok(bytes) => partial(start + bytes.len() as u64 - 1)
            .body(bytes)
            .unwrap_or_else(|_| status_only(StatusCode::INTERNAL_SERVER_ERROR)),
        Err(e) => status_only(status_for(&e)),
    }
}

fn unsatisfiable(size: u64) -> Response<Vec<u8>> {
    empty(base(StatusCode::RANGE_NOT_SATISFIABLE).header(header::CONTENT_RANGE, format!("bytes */{size}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::rpc::call;
    use crate::rpc::media::test_support::{png_bytes, upload, webm_bytes};
    use serde_json::json;

    fn get(engine: &Engine, id: &str, range: Option<&str>) -> Response<Vec<u8>> {
        let mut request = Request::builder().uri(format!("lbasset://localhost/{id}"));
        if let Some(range) = range {
            request = request.header("Range", range);
        }
        respond(engine, &request.body(Vec::new()).unwrap())
    }

    fn header_of<'a>(response: &'a Response<Vec<u8>>, name: header::HeaderName) -> Option<&'a str> {
        response.headers().get(name).and_then(|v| v.to_str().ok())
    }

    fn stored_png(size: usize) -> (std::sync::Arc<Engine>, crate::engine::TestDir, String, Vec<u8>) {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let bytes = png_bytes(size);
        let id = upload(&engine, "a.png", "image/png", &bytes)["id"]
            .as_str()
            .unwrap()
            .to_string();
        (engine, dir, id, bytes)
    }

    #[test]
    fn reading_a_range_header() {
        assert_eq!(parse_range(None), Requested::Whole);
        assert_eq!(parse_range(Some("bytes=0-9")), Requested::From { start: 0, end: Some(9) });
        assert_eq!(parse_range(Some("bytes=5-")), Requested::From { start: 5, end: None });
        assert_eq!(parse_range(Some("bytes=-20")), Requested::Last(20));
        assert_eq!(parse_range(Some(" bytes=1-2 ")), Requested::From { start: 1, end: Some(2) });
        // Ignored rather than refused.
        assert_eq!(parse_range(Some("bytes=9-3")), Requested::Whole);
        assert_eq!(parse_range(Some("bytes=a-b")), Requested::Whole);
        assert_eq!(parse_range(Some("bytes=0-1,5-6")), Requested::Whole);
        assert_eq!(parse_range(Some("items=0-1")), Requested::Whole);
        assert_eq!(parse_range(Some("bytes=")), Requested::Whole);
        assert_eq!(parse_range(Some("bytes=-")), Requested::Whole);
    }

    #[test]
    fn a_whole_response_has_the_right_headers() {
        let (engine, _dir, id, bytes) = stored_png(1000);
        let response = get(&engine, &id, None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), &bytes);
        assert_eq!(header_of(&response, header::CONTENT_TYPE), Some("image/png"));
        assert_eq!(header_of(&response, header::CONTENT_LENGTH), Some("1000"));
        assert_eq!(header_of(&response, header::ACCEPT_RANGES), Some("bytes"));
        assert_eq!(header_of(&response, header::X_CONTENT_TYPE_OPTIONS), Some("nosniff"));
        assert_eq!(header_of(&response, header::CONTENT_RANGE), None);
    }

    #[test]
    fn closed_open_and_suffix_ranges_return_exactly_those_bytes() {
        let (engine, _dir, id, bytes) = stored_png(1000);

        let response = get(&engine, &id, Some("bytes=10-19"));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), &bytes[10..20]);
        assert_eq!(header_of(&response, header::CONTENT_RANGE), Some("bytes 10-19/1000"));
        assert_eq!(header_of(&response, header::CONTENT_LENGTH), Some("10"));
        assert_eq!(header_of(&response, header::X_CONTENT_TYPE_OPTIONS), Some("nosniff"));

        let response = get(&engine, &id, Some("bytes=0-0"));
        assert_eq!(response.body(), &bytes[..1]);

        let response = get(&engine, &id, Some("bytes=990-"));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), &bytes[990..]);
        assert_eq!(header_of(&response, header::CONTENT_RANGE), Some("bytes 990-999/1000"));

        let response = get(&engine, &id, Some("bytes=999-"));
        assert_eq!(response.body(), &bytes[999..]);

        // An end past the last byte is clamped.
        let response = get(&engine, &id, Some("bytes=995-5000"));
        assert_eq!(response.body(), &bytes[995..]);
        assert_eq!(header_of(&response, header::CONTENT_RANGE), Some("bytes 995-999/1000"));

        let response = get(&engine, &id, Some("bytes=-7"));
        assert_eq!(response.body(), &bytes[993..]);
        assert_eq!(header_of(&response, header::CONTENT_RANGE), Some("bytes 993-999/1000"));

        // A suffix longer than the file is the whole file.
        let response = get(&engine, &id, Some("bytes=-5000"));
        assert_eq!(response.body(), &bytes);
        assert_eq!(header_of(&response, header::CONTENT_RANGE), Some("bytes 0-999/1000"));
    }

    #[test]
    fn out_of_range_requests_get_416_with_the_size() {
        let (engine, _dir, id, _bytes) = stored_png(1000);
        for range in ["bytes=1000-", "bytes=1000-1001", "bytes=5000-6000", "bytes=-0"] {
            let response = get(&engine, &id, Some(range));
            assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE, "{range}");
            assert_eq!(header_of(&response, header::CONTENT_RANGE), Some("bytes */1000"), "{range}");
            assert!(response.body().is_empty());
        }
    }

    #[test]
    fn a_malformed_range_is_ignored() {
        let (engine, _dir, id, bytes) = stored_png(100);
        for range in ["bytes=9-3", "lines=1-2", "bytes=0-1,3-4"] {
            let response = get(&engine, &id, Some(range));
            assert_eq!(response.status(), StatusCode::OK, "{range}");
            assert_eq!(response.body(), &bytes);
        }
    }

    #[test]
    fn ranges_cross_chunk_boundaries_and_large_requests_get_a_window() {
        let size = CHUNK_SIZE * 2 + 100;
        let (engine, _dir, id, bytes) = stored_png(size);
        let chunk = CHUNK_SIZE as u64;

        // Asking across a boundary returns exactly what was asked.
        let range = format!("bytes={}-{}", chunk - 3, chunk + 2);
        let response = get(&engine, &id, Some(&range));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().as_slice(), &bytes[CHUNK_SIZE - 3..=CHUNK_SIZE + 2]);

        // An open-ended request stops at the end of its chunk, so it touches only one.
        let response = get(&engine, &id, Some("bytes=10-"));
        assert_eq!(
            header_of(&response, header::CONTENT_RANGE),
            Some(format!("bytes 10-{}/{size}", chunk - 1).as_str())
        );
        assert_eq!(response.body().as_slice(), &bytes[10..CHUNK_SIZE]);

        // Following the answers walks the whole file, as a video element does.
        let mut got = Vec::new();
        let mut requests = 0;
        while got.len() < size {
            let response = get(&engine, &id, Some(&format!("bytes={}-", got.len())));
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            got.extend_from_slice(response.body());
            requests += 1;
        }
        assert_eq!(got, bytes);
        assert_eq!(requests, 3);

        // A closed range larger than the window is shortened, and says so.
        let response = get(&engine, &id, Some(&format!("bytes=0-{}", size - 1)));
        assert_eq!(response.body().len(), CHUNK_SIZE);
        assert_eq!(
            header_of(&response, header::CONTENT_RANGE),
            Some(format!("bytes 0-{}/{size}", chunk - 1).as_str())
        );
    }

    #[test]
    fn head_reports_without_a_body() {
        let (engine, _dir, id, _bytes) = stored_png(1000);
        let request = Request::builder()
            .method(Method::HEAD)
            .uri(format!("lbasset://localhost/{id}"))
            .body(Vec::new())
            .unwrap();
        let response = respond(&engine, &request);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(header_of(&response, header::CONTENT_LENGTH), Some("1000"));
        assert!(response.body().is_empty());
    }

    #[test]
    fn other_methods_and_strange_ids_are_refused() {
        let (engine, _dir, id, _bytes) = stored_png(100);
        let post = Request::builder()
            .method(Method::POST)
            .uri(format!("lbasset://localhost/{id}"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(respond(&engine, &post).status(), StatusCode::METHOD_NOT_ALLOWED);
        for path in [
            "no-such-asset",
            "",
            "..%2F..%2Fetc%2Fpasswd",
            "..%5C..%5Cwindows%5Cwin.ini",
            "C:%5CUsers%5Csecret.txt",
            "a'%20OR%20'1'='1",
            "a/b",
        ] {
            let response = get(&engine, path, None);
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[test]
    fn with_no_project_open_nothing_is_served() {
        let (engine, _host, _dir) = Engine::for_test();
        let response = get(&engine, "00000000-0000-7000-8000-000000000000", None);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn scripts_and_unknown_stored_types_are_not_served() {
        let (engine, _dir, _id, _bytes) = stored_png(10);
        for mime in ["text/html", "image/svg+xml", "application/javascript", ""] {
            let id = crate::db::new_id();
            engine
                .write(|tx| {
                    tx.execute(
                        "INSERT INTO assets (id, name, mime, kind, size, chunk_size, sha256, complete, created_at)
                         VALUES (?1, 'x', ?2, 'image', 4, 4194304, ?1, 1, 'now')",
                        rusqlite::params![id, mime],
                    )?;
                    tx.execute(
                        "INSERT INTO asset_chunks (asset_id, idx, bytes) VALUES (?1, 0, x'3C68746D')",
                        [&id],
                    )?;
                    Ok(())
                })
                .unwrap();
            let response = get(&engine, &id, None);
            assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE, "{mime}");
            assert!(response.body().is_empty());
        }
    }

    /// A project file from someone else can hold any numbers. Ones that would overflow the
    /// range arithmetic, or read a byte at a time, are refused instead of served.
    #[test]
    fn a_damaged_size_or_chunk_size_is_refused_not_served() {
        let (engine, _dir, _id, _bytes) = stored_png(10);
        let crafted = |size: i64, chunk_size: i64| {
            let id = crate::db::new_id();
            engine
                .write(|tx| {
                    tx.execute(
                        "INSERT INTO assets (id, name, mime, kind, size, chunk_size, sha256, complete, created_at)
                         VALUES (?1, 'x.png', 'image/png', 'image', ?2, ?3, ?1, 1, 'now')",
                        rusqlite::params![id, size, chunk_size],
                    )?;
                    tx.execute(
                        "INSERT INTO asset_chunks (asset_id, idx, bytes) VALUES (?1, 0, x'89504E470D0A1A0A')",
                        [&id],
                    )?;
                    Ok(())
                })
                .unwrap();
            id
        };
        let ranges = [
            None,
            Some("bytes=0-"),
            Some("bytes=18446744073709551000-"),
            Some("bytes=-5"),
            Some("bytes=9223372036854775000-9223372036854775806"),
        ];
        for (size, chunk_size) in [(-1_i64, 4_194_304_i64), (10, 0), (10, 1), (10, i64::MAX), (10, -4)] {
            let id = crafted(size, chunk_size);
            for range in ranges {
                let response = get(&engine, &id, range);
                assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE, "{size} {chunk_size} {range:?}");
                assert!(response.body().is_empty());
            }
            let read = crate::rpc::media::read_range(&engine, &id, 0, 100);
            assert!(read.is_err(), "{size} {chunk_size}");
        }
        // A size claiming more than is stored gets answers, not a crash.
        let id = crafted(i64::MAX, 4_194_304);
        assert_eq!(get(&engine, &id, None).status(), StatusCode::PAYLOAD_TOO_LARGE);
        for range in &ranges[1..] {
            let status = get(&engine, &id, *range).status();
            assert!(status != StatusCode::OK, "{range:?}");
        }
    }

    #[test]
    fn linked_files_stream_by_id_and_go_missing_cleanly() {
        let (engine, host, dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let bytes = webm_bytes(CHUNK_SIZE + 500);
        let path = dir.0.join("clip.webm");
        std::fs::write(&path, &bytes).unwrap();
        host.next_picks.lock().unwrap().push(path.clone());
        call(&engine, "files.pickOpen", json!({}));
        let id = call(&engine, "media.link", json!({ "path": path }))["id"]
            .as_str()
            .unwrap()
            .to_string();

        let response = get(&engine, &id, Some("bytes=100-"));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(header_of(&response, header::CONTENT_TYPE), Some("video/webm"));
        assert_eq!(response.body().as_slice(), &bytes[100..100 + CHUNK_SIZE]);

        let response = get(&engine, &id, Some("bytes=-10"));
        assert_eq!(response.body().as_slice(), &bytes[bytes.len() - 10..]);

        // A file that has shrunk is measured afresh.
        std::fs::write(&path, webm_bytes(64)).unwrap();
        let response = get(&engine, &id, Some("bytes=1000-"));
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(header_of(&response, header::CONTENT_RANGE), Some("bytes */64"));

        // A file swapped for something else stops being served.
        std::fs::write(&path, b"<html><script>alert(1)</script></html>").unwrap();
        assert_eq!(get(&engine, &id, None).status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

        std::fs::remove_file(&path).unwrap();
        assert_eq!(get(&engine, &id, Some("bytes=0-")).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn sound_and_pdf_are_served_as_themselves_with_nosniff() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "project.new", json!({}));
        let mut pdf = b"%PDF-1.4
".to_vec();
        pdf.resize(300, b' ');
        let mut mp3 = b"ID3      ".to_vec();
        mp3.resize(300, 0);
        for (name, mime, bytes) in [("a.pdf", "application/pdf", pdf), ("a.mp3", "audio/mpeg", mp3)] {
            let id = upload(&engine, name, mime, &bytes)["id"].as_str().unwrap().to_string();
            let response = get(&engine, &id, None);
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(header_of(&response, header::CONTENT_TYPE), Some(mime));
            assert_eq!(header_of(&response, header::X_CONTENT_TYPE_OPTIONS), Some("nosniff"));
            assert_eq!(response.body(), &bytes);
            let range = get(&engine, &id, Some("bytes=0-9"));
            assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        }
    }
}
