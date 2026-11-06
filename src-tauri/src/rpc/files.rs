//! File access for the UI. Paths must come from a native dialog in this run, so
//! nothing rendered in the web view can read or write arbitrary files.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{ok, parse, unknown};
use crate::engine::{Engine, PickOptions};
use crate::error::{AppError, AppResult};

#[derive(Deserialize)]
struct PathParam {
    path: PathBuf,
}

const MAX_LIST_ENTRIES: usize = 50_000;
/// The largest file the UI may read whole. Imports read Markdown, text, JSON and Word files
/// this way, and a file picked by mistake, or made to be huge, must not take all the memory:
/// the UI receives it as base64, a third larger again, and a JavaScript string cannot hold
/// much more than this anyway. Pictures and videos come in through `media.*` instead.
pub const MAX_READ_BYTES: u64 = 256 * 1024 * 1024;

/// Reads a whole file, refusing one larger than `MAX_READ_BYTES` before reading any of it.
fn read_limited(path: &Path) -> AppResult<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let too_large = || {
        AppError::new(
            "TOO_LARGE",
            format!(
                "That file is too large to read. The most is {} MB.",
                MAX_READ_BYTES / (1024 * 1024)
            ),
        )
    };
    if file.metadata()?.len() > MAX_READ_BYTES {
        return Err(too_large());
    }
    // A file can grow while it is read, so the limit holds for what is read, too.
    let mut bytes = Vec::new();
    file.take(MAX_READ_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "pickSave" => {
            let options: PickOptions = parse(params)?;
            let picked = engine.take_e2e_pick().or_else(|| engine.host.pick_save(options));
            if let Some(path) = &picked {
                engine.allow_path(path);
            }
            ok(picked)
        }
        "pickOpen" => {
            let options: PickOptions = parse(params)?;
            let picked = match engine.take_e2e_pick() {
                Some(path) => vec![path],
                None => engine.host.pick_open(options),
            };
            for path in &picked {
                engine.allow_path(path);
            }
            ok(picked)
        }
        "pickFolder" => {
            let options: PickOptions = parse(params)?;
            let picked = engine.take_e2e_pick().or_else(|| engine.host.pick_folder(options));
            if let Some(path) = &picked {
                engine.allow_path(path);
            }
            ok(picked)
        }
        "writeBytes" => {
            #[derive(Deserialize)]
            struct P {
                path: PathBuf,
                base64: String,
            }
            let p: P = parse(params)?;
            engine.check_allowed(&p.path)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(p.base64)
                .map_err(|e| AppError::invalid(e.to_string()))?;
            write_file(&p.path, &bytes)?;
            ok(true)
        }
        "writeText" => {
            #[derive(Deserialize)]
            struct P {
                path: PathBuf,
                text: String,
            }
            let p: P = parse(params)?;
            engine.check_allowed(&p.path)?;
            write_file(&p.path, p.text.as_bytes())?;
            ok(true)
        }
        "readBytes" => {
            let p: PathParam = parse(params)?;
            engine.check_allowed(&p.path)?;
            let bytes = read_limited(&p.path)?;
            ok(json!({ "base64": base64::engine::general_purpose::STANDARD.encode(bytes) }))
        }
        "readText" => {
            let p: PathParam = parse(params)?;
            engine.check_allowed(&p.path)?;
            let bytes = read_limited(&p.path)?;
            ok(json!({ "text": String::from_utf8_lossy(&bytes) }))
        }
        "listDir" => {
            let p: PathParam = parse(params)?;
            engine.check_allowed(&p.path)?;
            let mut entries = Vec::new();
            walk(&p.path, &p.path, &mut entries)?;
            ok(entries)
        }
        "readResource" => {
            #[derive(Deserialize)]
            struct P {
                name: String,
            }
            let p: P = parse(params)?;
            let bytes = read_resource(&p.name)?;
            ok(json!({ "text": String::from_utf8_lossy(&bytes) }))
        }
        _ => Err(unknown(&format!("files.{action}"))),
    }
}

/// The license notices for everything the app is built from.
pub const LICENSES_FILE: &str = "THIRD_PARTY_LICENSES.txt";
/// One folder of spelling dictionary per language. They ship as files beside the app, not
/// inside it, because some are under the GPL.
pub const DICTIONARY_FOLDERS: &[&str] = &["en-US", "en-GB", "es", "fr", "de", "pt", "it", "ru"];
const DICTIONARY_FILES: &[&str] = &["index.aff", "index.dic", "LICENSE.txt"];

/// `bundle.resources` there says where each of these files comes from.
const TAURI_CONFIG: &str = include_str!("../../tauri.conf.json");

/// Only these bundled files can be read, by their path in the resource folder.
fn is_readable_resource(name: &str) -> bool {
    if name == LICENSES_FILE {
        return true;
    }
    name.strip_prefix("dictionaries/")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(folder, file)| {
            DICTIONARY_FOLDERS.contains(&folder) && DICTIONARY_FILES.contains(&file)
        })
}

/// Where the installer put the resources, by Tauri's own rule for each platform.
fn installed_resource_dir() -> Option<PathBuf> {
    static DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let config: Value = serde_json::from_str(TAURI_CONFIG).ok()?;
        let info = tauri::PackageInfo {
            name: config["productName"].as_str()?.to_string(),
            version: env!("CARGO_PKG_VERSION").parse().ok()?,
            authors: env!("CARGO_PKG_AUTHORS"),
            description: env!("CARGO_PKG_DESCRIPTION"),
            crate_name: env!("CARGO_PKG_NAME"),
        };
        tauri::utils::platform::resource_dir(&info, &tauri::Env::default()).ok()
    })
    .clone()
}

/// The file in the source tree that `bundle.resources` copies to this name. A debug build
/// reads from there when nothing was installed: under `tauri dev`, `app:debug`, the E2E
/// harness's copy of the exe and `cargo test`.
#[cfg(debug_assertions)]
fn resource_source(name: &str) -> Option<PathBuf> {
    let config: Value = serde_json::from_str(TAURI_CONFIG).ok()?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let resources = config["bundle"]["resources"].as_object()?;
    // A file named for itself, before a folder that would hold it.
    let exact = resources
        .iter()
        .find(|(_, target)| target.as_str() == Some(name))
        .map(|(source, _)| root.join(source));
    exact.or_else(|| {
        resources.iter().find_map(|(source, target)| {
            let target = target.as_str().filter(|target| target.ends_with('/'))?;
            Some(root.join(source).join(name.strip_prefix(target)?))
        })
    })
}

/// Reads one bundled file that the UI is allowed to see.
pub fn read_resource(name: &str) -> AppResult<Vec<u8>> {
    if !is_readable_resource(name) {
        return Err(AppError::new(
            "PATH_NOT_ALLOWED",
            "That is not one of the files that come with the app.",
        ));
    }
    let candidates = installed_resource_dir().map(|dir| dir.join(name));
    // A release build has only what was installed.
    #[cfg(debug_assertions)]
    let candidates = candidates.into_iter().chain(resource_source(name));
    match candidates.into_iter().find(|path| path.is_file()) {
        Some(path) => read_limited(&path),
        None => Err(AppError::new(
            "NOT_FOUND",
            format!("{name} is missing from this installation. Installing the app again restores it."),
        )),
    }
}

fn write_file(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension(format!("tmp-{}", crate::db::new_id()));
    let result = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(result?)
}

/// Lists files under a folder, relative to it with `/` separators. Hidden folders
/// such as `.obsidian` and `.git` are skipped.
fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> AppResult<()> {
    for entry in std::fs::read_dir(dir)?.filter_map(Result::ok) {
        if out.len() >= MAX_LIST_ENTRIES {
            return Ok(());
        }
        let path = entry.path();
        let hidden = entry.file_name().to_string_lossy().starts_with('.');
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if !hidden {
                walk(root, &path, out)?;
            }
        } else if file_type.is_file() && !hidden {
            if let Ok(relative) = path.strip_prefix(root) {
                out.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::engine::Engine;
    use crate::rpc::dispatch;
    use serde_json::json;

    #[test]
    fn writing_requires_a_path_from_a_dialog() {
        let (engine, host, dir) = Engine::for_test();
        let target = dir.0.join("out.txt");
        let refused = dispatch(
            &engine,
            "files.writeText",
            json!({ "path": target, "text": "hi" }),
        );
        assert_eq!(refused.unwrap_err().code, "PATH_NOT_ALLOWED");
        assert!(!target.exists());

        host.next_picks.lock().unwrap().push(target.clone());
        dispatch(&engine, "files.pickSave", json!({})).unwrap();
        dispatch(
            &engine,
            "files.writeText",
            json!({ "path": target, "text": "hi" }),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hi");
    }

    #[test]
    fn a_file_too_large_to_read_whole_is_refused_before_it_is_read() {
        let (engine, host, dir) = Engine::for_test();
        let huge = dir.0.join("huge.docx");
        // Sparse where the file system allows it, so the test writes almost nothing.
        let file = std::fs::File::create(&huge).unwrap();
        file.set_len(super::MAX_READ_BYTES + 1).unwrap();
        drop(file);
        let small = dir.0.join("small.md");
        std::fs::write(&small, "# Aria").unwrap();
        host.next_picks.lock().unwrap().push(dir.0.clone());
        dispatch(&engine, "files.pickFolder", json!({})).unwrap();

        for method in ["files.readBytes", "files.readText"] {
            let refused = dispatch(&engine, method, json!({ "path": huge })).unwrap_err();
            assert_eq!(refused.code, "TOO_LARGE", "{method}");
            assert!(refused.message.contains("256 MB"), "{}", refused.message);
        }
        let text = dispatch(&engine, "files.readText", json!({ "path": small })).unwrap();
        assert_eq!(text["text"], "# Aria");
    }

    #[test]
    fn the_bundled_notices_and_dictionaries_can_be_read_and_nothing_else() {
        let (engine, _host, _dir) = Engine::for_test();
        let read = |name: &str| dispatch(&engine, "files.readResource", json!({ "name": name }));

        let notices = read("THIRD_PARTY_LICENSES.txt").unwrap();
        let notices = notices["text"].as_str().unwrap();
        assert!(notices.contains("tauri"), "the Rust crates are listed");
        assert!(notices.contains("dictionary-de"), "the dictionaries are listed");

        for folder in super::DICTIONARY_FOLDERS {
            let aff = read(&format!("dictionaries/{folder}/index.aff")).unwrap();
            assert!(aff["text"].as_str().unwrap().contains("SFX"), "{folder}");
            let dic = read(&format!("dictionaries/{folder}/index.dic")).unwrap();
            assert!(dic["text"].as_str().unwrap().len() > 100_000, "{folder}");
            let license = read(&format!("dictionaries/{folder}/LICENSE.txt")).unwrap();
            assert!(license["text"].as_str().unwrap().contains("https://"), "{folder} links to its source");
        }

        for name in [
            "../Cargo.toml",
            "Cargo.toml",
            "tauri.conf.json",
            "dictionaries/de/../../Cargo.toml",
            "dictionaries/de/index.js",
            "dictionaries/xx/index.aff",
            "dictionaries/../THIRD_PARTY_LICENSES.txt",
            "/THIRD_PARTY_LICENSES.txt",
            "C:\\Windows\\win.ini",
            "",
        ] {
            assert_eq!(read(name).unwrap_err().code, "PATH_NOT_ALLOWED", "{name}");
        }
    }

    /// Whatever the UI may read must be in the installer, or it would work in development only.
    #[cfg(debug_assertions)]
    #[test]
    fn every_readable_resource_is_in_the_bundle() {
        let config: serde_json::Value = serde_json::from_str(super::TAURI_CONFIG).unwrap();
        let resources = config["bundle"]["resources"].as_object().unwrap();
        let mut names = vec![super::LICENSES_FILE.to_string()];
        for folder in super::DICTIONARY_FOLDERS {
            for file in super::DICTIONARY_FILES {
                names.push(format!("dictionaries/{folder}/{file}"));
            }
        }
        for name in names {
            let source = super::resource_source(&name).unwrap_or_else(|| panic!("{name} is not bundled"));
            assert!(source.is_file(), "{name} comes from {}, which is missing", source.display());
        }
        // The GPL dictionaries are files beside the app, never part of the web view's assets.
        for source in resources.keys() {
            assert!(!source.contains("dist"), "{source}");
        }
    }

    #[test]
    fn parent_segments_cannot_escape_a_chosen_folder() {
        let (engine, host, dir) = Engine::for_test();
        host.next_picks.lock().unwrap().push(dir.0.clone());
        dispatch(&engine, "files.pickFolder", json!({})).unwrap();
        let sneaky = dir.0.join("..").join("escaped.txt");
        let refused = dispatch(
            &engine,
            "files.writeText",
            json!({ "path": sneaky, "text": "x" }),
        );
        assert_eq!(refused.unwrap_err().code, "PATH_NOT_ALLOWED");
    }
}
