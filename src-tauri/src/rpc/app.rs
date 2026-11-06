use std::sync::atomic::Ordering;

use serde::Deserialize;
use serde_json::{json, Value};

use super::{ok, parse, unknown};
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::logs;
use crate::paths;
use crate::session;
use crate::updates;

pub fn handle(engine: &Engine, action: &str, params: Value) -> AppResult<Value> {
    match action {
        "bootstrap" => bootstrap(engine),
        // For the About dialog. Unlike bootstrap, it has no side effects.
        "info" => ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "dataDir": engine.paths.root,
            "portable": engine.paths.portable,
        })),
        // The UI has painted, so the window can appear without a white flash.
        "ready" => {
            logs::info("app.ready", &[]);
            engine.host.show_window();
            ok(true)
        }
        "setTheme" => {
            #[derive(Deserialize)]
            struct P {
                dark: bool,
            }
            let p: P = parse(params)?;
            engine.host.set_theme(p.dark);
            ok(true)
        }
        "closeAck" => {
            engine.close_acknowledged.store(true, Ordering::SeqCst);
            ok(true)
        }
        "quit" => {
            let session = engine.session().take();
            if let Some(session) = session {
                // Unsaved work has been handled by the UI by this point. If
                // removal fails, the leftovers are recovered or cleaned next run.
                let _ = session.close_and_remove();
            }
            engine.host.quit();
            ok(true)
        }
        // Native dialogs cannot be driven from a test, so tests approve paths here.
        // Refused outside the test harness, so it cannot weaken the path check.
        "e2eAllowPath" => {
            if !paths::is_e2e() {
                return Err(unknown("app.e2eAllowPath"));
            }
            #[derive(Deserialize)]
            struct P {
                path: std::path::PathBuf,
            }
            let p: P = parse(params)?;
            engine.allow_path(&p.path);
            ok(true)
        }
        // Answers the next file dialog, so tests can drive the real screens that open one.
        // Refused outside the test harness.
        "e2eQueuePick" => {
            if !paths::is_e2e() {
                return Err(unknown("app.e2eQueuePick"));
            }
            #[derive(Deserialize)]
            struct P {
                path: std::path::PathBuf,
            }
            let p: P = parse(params)?;
            engine
                .e2e_picks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(p.path);
            ok(true)
        }
        "openExternal" => {
            #[derive(Deserialize)]
            struct P {
                url: String,
            }
            let p: P = parse(params)?;
            let lower = p.url.to_lowercase();
            if !(lower.starts_with("https://") || lower.starts_with("http://")) {
                return Err(AppError::invalid("Only web links can be opened."));
            }
            engine.host.open_url(&p.url)?;
            ok(true)
        }
        // Lets a test confirm that a panic reaches the log. Refused outside the harness.
        "e2ePanic" => {
            if !paths::is_e2e() {
                return Err(unknown("app.e2ePanic"));
            }
            #[derive(Deserialize)]
            struct P {
                message: String,
            }
            let p: P = parse(params)?;
            panic!("{}", p.message)
        }
        "logClientError" => {
            #[derive(Default, Deserialize)]
            #[serde(default)]
            struct P {
                origin: String,
                name: String,
                code: Option<String>,
                message: String,
                frames: Vec<String>,
            }
            let p: P = parse(params)?;
            logs::client_error(&p.origin, &p.name, p.code.as_deref(), &p.message, &p.frames);
            ok(true)
        }
        "openLogFolder" => {
            let folder = engine.paths.logs();
            std::fs::create_dir_all(&folder)?;
            engine.host.open_folder(&folder)?;
            ok(true)
        }
        "diagnostics" => ok(diagnostics(engine)),
        "checkForUpdates" => ok(updates::check()),
        _ => Err(unknown(&format!("app.{action}"))),
    }
}

/// Version and platform, for a bug report. No paths, because they tend to name the person.
fn diagnostics(engine: &Engine) -> Value {
    let os = os_info::get();
    let lines = [
        format!("LoreCraft {}", env!("CARGO_PKG_VERSION")),
        format!("Build: {}", if cfg!(debug_assertions) { "debug" } else { "release" }),
        format!("OS: {} {} ({})", os.os_type(), os.version(), std::env::consts::ARCH),
        format!("Web view: {}", tauri::webview_version().unwrap_or_else(|_| "unknown".to_string())),
        format!("PDF export: {}", if engine.host.supports_pdf() { "available" } else { "not available" }),
    ];
    json!({ "text": lines.join("\n") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{call, dispatch};

    #[test]
    fn diagnostics_name_the_version_and_platform_and_no_path() {
        let (engine, _host, dir) = Engine::for_test();
        let text = call(&engine, "app.diagnostics", json!({}))["text"].as_str().unwrap().to_string();
        assert!(text.starts_with(&format!("LoreCraft {}", env!("CARGO_PKG_VERSION"))), "{text}");
        assert!(text.contains("OS: "), "{text}");
        assert!(text.contains("PDF export: not available"), "{text}");
        assert!(!text.contains(&*dir.0.to_string_lossy()), "{text}");
        assert!(!text.contains(&*engine.paths.root.to_string_lossy()), "{text}");
    }

    #[test]
    fn the_ui_learns_up_front_whether_pdfs_can_be_made() {
        let (engine, _host, _dir) = Engine::for_test();
        let boot = call(&engine, "app.bootstrap", json!({}));
        assert_eq!(boot["platform"]["pdf"], false, "the test host has no browser engine");
        assert_eq!(boot["platform"]["os"], std::env::consts::OS);
    }

    #[test]
    fn the_test_panic_is_refused_outside_the_harness() {
        let (engine, _host, _dir) = Engine::for_test();
        let error = dispatch(&engine, "app.e2ePanic", json!({ "message": "x" })).unwrap_err();
        assert_eq!(error.code, "UNKNOWN_METHOD");
    }

    #[test]
    fn a_client_error_is_accepted_with_any_shape_and_logged_clean() {
        let (engine, _host, _dir) = Engine::for_test();
        let lines = logs::capture(|| {
            let story = "Vaelthrix burned Ashmoor";
            call(&engine, "app.logClientError", json!({ "origin": "error", "name": "TypeError", "message": story, "frames": [story], "code": story }));
            call(&engine, "app.logClientError", json!({}));
        });
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("js.uncaught origin=error name=TypeError"), "{}", lines[0]);
        assert!(!lines.concat().contains("Vaelthrix"), "{lines:?}");
    }

    #[test]
    fn the_log_folder_is_created_before_it_is_shown() {
        let (engine, _host, _dir) = Engine::for_test();
        call(&engine, "app.openLogFolder", json!({}));
        assert!(engine.paths.logs().is_dir());
    }
}

fn bootstrap(engine: &Engine) -> AppResult<Value> {
    let startup_file = engine
        .startup_file
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    let settings = engine.settings().clone();
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": engine.paths.root,
        "settings": settings,
        "recoverable": session::list_recoverable(&engine.paths)?,
        "startupFile": startup_file,
        "status": engine.status(),
        "e2e": paths::is_e2e(),
        // The first-run guide stays out of test runs, except the test that asks for it.
        "e2eGuide": std::env::var_os("LORECRAFT_E2E_GUIDE").is_some(),
        "platform": { "os": std::env::consts::OS, "pdf": engine.host.supports_pdf() },
    }))
}

#[cfg(test)]
mod platform_tests {
    use crate::engine::Engine;
    use crate::rpc::call;
    use serde_json::{json, Value};

    #[test]
    fn info_gives_the_version_and_data_folder_without_touching_anything() {
        let (engine, _host, dir) = Engine::for_test();
        *engine.startup_file.lock().unwrap() = Some(dir.0.join("waiting.lorecraft"));
        let info = call(&engine, "app.info", Value::Null);
        assert_eq!(info, json!({ "version": env!("CARGO_PKG_VERSION"), "dataDir": dir.0, "portable": false }));
        assert!(
            engine.startup_file.lock().unwrap().is_some(),
            "unlike bootstrap, it leaves the file waiting to open"
        );
    }
}
