//! LoreCraft's native side. See docs/ARCHITECTURE.md.

pub mod ai;
pub mod content;
pub mod db;
pub mod embeddings;
pub mod engine;
pub mod error;
pub mod indexing;
pub mod logs;
pub mod mcp;
pub mod media_protocol;
pub mod paths;
pub mod rpc;
pub mod session;
pub mod updates;

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, Theme, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use engine::{Engine, Host, PickOptions};
use error::{AppError, AppResult};

/// If the UI has crashed it cannot answer a close request. After this long the app
/// exits anyway. Nothing is lost: the session stays on disk for recovery.
const CLOSE_FAILSAFE: Duration = Duration::from_secs(6);
/// If the UI never reports ready, show the window anyway so the problem is visible.
const SHOW_FAILSAFE: Duration = Duration::from_secs(8);
/// The window PDFs are laid out in. It is never shown.
const PRINT_WINDOW: &str = "print";
/// Long, because laying out a whole book happens inside one command.
#[cfg(any(windows, target_os = "linux"))]
const PRINT_COMMAND_TIMEOUT: Duration = Duration::from_secs(15 * 60);

struct TauriHost {
    app: AppHandle,
}

impl TauriHost {
    fn dialog_for(
        &self,
        options: &PickOptions,
    ) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
        let mut dialog = self.app.dialog().file();
        if let Some(window) = self.app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        if let Some(title) = &options.title {
            dialog = dialog.set_title(title);
        }
        if let Some(name) = &options.default_name {
            dialog = dialog.set_file_name(name);
        }
        for filter in &options.filters {
            let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&filter.name, &extensions);
        }
        dialog
    }
}

fn to_path(file: tauri_plugin_dialog::FilePath) -> Option<PathBuf> {
    file.into_path().ok()
}

impl Host for TauriHost {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.app.emit(event, payload);
    }

    fn set_title(&self, title: &str) {
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.set_title(title);
        }
    }

    fn pick_save(&self, options: PickOptions) -> Option<PathBuf> {
        self.dialog_for(&options)
            .blocking_save_file()
            .and_then(to_path)
    }

    fn pick_open(&self, options: PickOptions) -> Vec<PathBuf> {
        let dialog = self.dialog_for(&options);
        if options.multiple {
            dialog
                .blocking_pick_files()
                .unwrap_or_default()
                .into_iter()
                .filter_map(to_path)
                .collect()
        } else {
            dialog
                .blocking_pick_file()
                .and_then(to_path)
                .into_iter()
                .collect()
        }
    }

    fn pick_folder(&self, options: PickOptions) -> Option<PathBuf> {
        self.dialog_for(&options)
            .blocking_pick_folder()
            .and_then(to_path)
    }

    fn show_window(&self) {
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.show();
            if !paths::is_e2e() {
                let _ = window.set_focus();
            }
        }
    }

    fn set_theme(&self, dark: bool) {
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.set_theme(Some(if dark { Theme::Dark } else { Theme::Light }));
        }
    }

    fn open_url(&self, url: &str) -> AppResult<()> {
        if paths::is_e2e() {
            rpc::media::note_e2e_opened(url);
            return Ok(());
        }
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| AppError::internal(e.to_string()))
    }

    fn open_folder(&self, path: &Path) -> AppResult<()> {
        if paths::is_e2e() {
            rpc::media::note_e2e_opened(&path.to_string_lossy());
            return Ok(());
        }
        self.app
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| AppError::internal(e.to_string()))
    }

    fn quit(&self) {
        self.app.exit(0);
    }

    /// PDFs use WebView2's DevTools commands on Windows, and WebKitGTK's print operation on
    /// Linux (see `rpc::print_linux` and `rpc::print_stamp`). A test can turn PDFs off to see
    /// what people without them see.
    fn supports_pdf(&self) -> bool {
        cfg!(any(windows, target_os = "linux")) && !(paths::is_e2e() && std::env::var_os("LORECRAFT_E2E_NO_PDF").is_some())
    }

    #[cfg(any(windows, target_os = "linux"))]
    fn print_window_open(&self) -> AppResult<()> {
        // The last PDF's window may still be on its way out, and labels must be unique.
        for _ in 0..20 {
            if self.app.get_webview_window(PRINT_WINDOW).is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let mut builder =
            WebviewWindowBuilder::new(&self.app, PRINT_WINDOW, WebviewUrl::App("print.html".into()))
                .title("LoreCraft")
                .visible(false)
                .skip_taskbar(true)
                .on_navigation(navigation_guard(PRINT_WINDOW, dev_url(&self.app)));
        // WebView2 needs every window in one process to share a data folder.
        if let Some(dir) = self.app.try_state::<Arc<Engine>>().and_then(|e| e.paths.webview()) {
            builder = builder.data_directory(dir);
        }
        builder
            .build()
            .map(|_| ())
            .map_err(|e| AppError::internal(e.to_string()))
    }

    #[cfg(any(windows, target_os = "linux"))]
    fn print_window_close(&self) {
        if let Some(window) = self.app.get_webview_window(PRINT_WINDOW) {
            // Not `close`: that would ask the person about saving their project.
            let _ = window.destroy();
        }
    }

    #[cfg(windows)]
    fn print_devtools(&self, method: &str, params: &Value) -> AppResult<Value> {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;

        let window = self
            .app
            .get_webview_window(PRINT_WINDOW)
            .ok_or_else(|| AppError::internal("The print window has closed."))?;
        let (send, receive) = std::sync::mpsc::channel::<Result<String, String>>();
        let method = HSTRING::from(method);
        let params = HSTRING::from(params.to_string());
        window
            .with_webview(move |webview| {
                let done = send.clone();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result, json| {
                        let _ = done.send(result.map(|()| json).map_err(|e| e.to_string()));
                        Ok(())
                    },
                ));
                // SAFETY: this closure runs on the thread that owns the webview, and the
                // COM calls use interfaces wry keeps alive for the window's lifetime.
                let sent = unsafe {
                    webview.controller().CoreWebView2().and_then(|core| {
                        core.CallDevToolsProtocolMethod(&method, &params, &handler)
                    })
                };
                if let Err(e) = sent {
                    let _ = send.send(Err(e.to_string()));
                }
            })
            .map_err(|e| AppError::internal(e.to_string()))?;
        let json = receive
            .recv_timeout(PRINT_COMMAND_TIMEOUT)
            .map_err(|_| AppError::new("PRINT_FAILED", "The browser engine stopped responding."))?
            .map_err(|e| AppError::new("PRINT_FAILED", e))?;
        Ok(serde_json::from_str(&json)?)
    }

    #[cfg(target_os = "linux")]
    fn print_native(&self, sheet: &rpc::print::Sheet) -> AppResult<Vec<u8>> {
        let window = self
            .app
            .get_webview_window(PRINT_WINDOW)
            .ok_or_else(|| AppError::internal("The print window has closed."))?;
        let out = std::env::temp_dir().join(format!("lorecraft-print-{}.pdf", db::new_id()));
        let (send, receive) = std::sync::mpsc::channel::<Result<(), String>>();
        let sheet = *sheet;
        let target = out.clone();
        window
            .with_webview(move |webview| rpc::print_linux::print(&webview.inner(), &sheet, &target, send))
            .map_err(|e| AppError::internal(e.to_string()))?;
        let outcome = receive
            .recv_timeout(PRINT_COMMAND_TIMEOUT)
            .map_err(|_| AppError::new("PRINT_FAILED", "The browser engine stopped responding."))
            .and_then(|r| r.map_err(|e| AppError::new("PRINT_FAILED", e)))
            .and_then(|()| Ok(std::fs::read(&out)?));
        let _ = std::fs::remove_file(&out);
        outcome
    }
}

#[tauri::command]
async fn rpc(
    engine: State<'_, Arc<Engine>>,
    method: String,
    params: Option<Value>,
) -> Result<Value, AppError> {
    let engine = engine.inner().clone();
    let name = method.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        rpc::dispatch(&engine, &method, params.unwrap_or(Value::Null))
    })
    .await
    .unwrap_or_else(|e| Err(AppError::internal(e.to_string())));
    if let Err(error) = &outcome {
        logs::rpc_failed(&name, error);
    }
    outcome
}

fn is_project_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(session::is_project_extension)
}

/// One chunk of an upload, as raw bytes rather than JSON, so a large video is not
/// base64-encoded on its way here. The UI sends `x-asset-id` and `x-chunk-index` headers.
#[tauri::command]
async fn media_upload_chunk(
    engine: State<'_, Arc<Engine>>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, AppError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::invalid("A chunk must be sent as raw bytes."));
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| AppError::invalid(format!("A chunk needs the {name} header.")))
    };
    let id = header("x-asset-id")?;
    let index: u64 = header("x-chunk-index")?
        .parse()
        .map_err(|_| AppError::invalid("That is not a chunk index."))?;
    let bytes = bytes.clone();
    let engine = engine.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        rpc::media::upload_chunk(&engine, &id, index, &bytes)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

/// Part of an asset's bytes, returned raw. See `readAssetChunks` in `src/lib/assets.ts`.
#[tauri::command]
async fn media_read(
    engine: State<'_, Arc<Engine>>,
    id: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, AppError> {
    let engine = engine.inner().clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        rpc::media::read_range(&engine, &id, offset, length)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// A `.lorecraft` path among the launch arguments, from double-clicking a file.
fn project_arg(args: impl IntoIterator<Item = String>) -> Option<PathBuf> {
    args.into_iter().skip(1).map(PathBuf::from).find(|p| is_project_file(p))
}

/// A file macOS asked to open before the engine existed. It can arrive before `setup` runs.
#[cfg(target_os = "macos")]
static OPENED_EARLY: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// macOS gives a double-clicked file to the running app as an event, not as an argument.
/// Early in startup the UI is not listening yet, so it also collects `startup_file`.
#[cfg(target_os = "macos")]
fn open_from_finder(app: &AppHandle, urls: &[tauri::Url]) {
    let Some(path) = urls
        .iter()
        .filter_map(|url| url.to_file_path().ok())
        .find(|p| is_project_file(p))
    else {
        return;
    };
    match app.try_state::<Arc<Engine>>() {
        Some(engine) => {
            *engine.startup_file.lock().unwrap_or_else(|e| e.into_inner()) = Some(path.clone());
            let _ = app.emit("app://open-file", path);
        }
        None => *OPENED_EARLY.lock().unwrap_or_else(|e| e.into_inner()) = Some(path),
    }
}

/// The app's own pages: the bundled frontend, or the dev server under `tauri dev`.
fn is_app_page(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    let bundled = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        // How Windows and Android serve the bundled frontend.
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    bundled || dev_url.is_some_and(|dev| dev.origin() == url.origin())
}

/// Only `tauri dev` loads from the dev server, so a release build never trusts that address.
fn dev_url(app: &AppHandle) -> Option<tauri::Url> {
    if cfg!(dev) {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

/// Nothing may take a window away from the app: not a link in model output or lore, a
/// meta refresh, a form or a dropped file. A page from elsewhere could pose as LoreCraft,
/// and the screen it replaced can hold typing not yet saved. The UI opens web links in the
/// browser itself (`app.openExternal`). The log names only the scheme, never the address.
fn navigation_guard(
    window: &'static str,
    dev_url: Option<tauri::Url>,
) -> impl Fn(&tauri::Url) -> bool + Send + 'static {
    move |url| {
        let allowed = is_app_page(url, dev_url.as_ref());
        if !allowed {
            // A made-up scheme could be a word from the story, so only common ones are named.
            let scheme = match url.scheme() {
                known @ ("http" | "https" | "file" | "data" | "blob" | "about" | "javascript"
                | "mailto" | "ftp") => known,
                _ => "other",
            };
            logs::warn(
                "window.navigation_blocked",
                &[("window", window), ("scheme", scheme)],
                None,
            );
        }
        allowed
    }
}

/// Shows why LoreCraft cannot start, before it has a window of its own.
fn show_startup_error(message: &str) {
    eprintln!("{message}");
    #[cfg(windows)]
    if !paths::is_e2e() {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        // SAFETY: both strings outlive the call, and no owner window is needed.
        unsafe {
            MessageBoxW(
                None,
                &HSTRING::from(message),
                &HSTRING::from("LoreCraft cannot start"),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}

fn build_window(app: &AppHandle, webview_dir: Option<PathBuf>) -> tauri::Result<()> {
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .on_navigation(navigation_guard("main", dev_url(app)))
        .title("LoreCraft")
        .inner_size(1400.0, 900.0)
        .min_inner_size(720.0, 480.0)
        .theme(Some(Theme::Dark))
        .background_color(tauri::webview::Color(16, 20, 24, 255))
        // The native handler swallows HTML5 drag events on Windows. Turning it off keeps
        // dragging inside the editor working, and file drops arrive as ordinary DOM drops.
        .disable_drag_drop_handler()
        .visible(false);
    if let Some(dir) = webview_dir {
        // A portable copy keeps WebView2's files in its own data folder too.
        builder = builder.data_directory(dir);
    }
    if paths::is_e2e() {
        // Keeps test runs from covering the screen or taking focus.
        builder = builder.position(-3000.0, 40.0).focused(false);
    }
    builder.build()?;
    Ok(())
}

/// Test only: `--e2e-print <job.json> <out.pdf>` makes one PDF through the real print window,
/// prints the outcome as JSON, and quits, exiting 1 on failure. The job holds `print.pdf`'s
/// parameters without `path`. This lets a headless run (`xvfb-run` on Linux) check PDFs.
fn e2e_print(app: &AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    let Some(at) = args.iter().position(|a| a == "--e2e-print") else { return };
    let (Some(job), Some(out)) = (args.get(at + 1).cloned(), args.get(at + 2).cloned()) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let engine = app.state::<Arc<Engine>>().inner().clone();
        let out = PathBuf::from(out);
        engine.allow_path(&out);
        let outcome = std::fs::read_to_string(&job)
            .map_err(AppError::from)
            .and_then(|text| Ok(serde_json::from_str::<Value>(&text)?))
            .and_then(|mut params| {
                params["path"] = Value::from(out.to_string_lossy().to_string());
                rpc::dispatch(&engine, "print.pdf", params)
            });
        let code = match outcome {
            Ok(value) => {
                println!("{value}");
                0
            }
            Err(error) => {
                println!("{}", serde_json::json!({ "error": error.code, "message": error.message }));
                1
            }
        };
        app.exit(code);
    });
}

pub fn run() {
    logs::install_panic_hook();
    let e2e = paths::is_e2e();
    let mut builder = tauri::Builder::default();
    if !e2e {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = project_arg(args) {
                let _ = app.emit("app://open-file", path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .with_denylist(&[PRINT_WINDOW])
                .build(),
        );
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            rpc,
            ai::ai_stream,
            ai::ai_cancel,
            media_upload_chunk,
            media_read
        ])
        .register_asynchronous_uri_scheme_protocol(
            media_protocol::SCHEME,
            |ctx, request, responder| {
                let engine = ctx.app_handle().state::<Arc<Engine>>().inner().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    responder.respond(media_protocol::respond(&engine, &request));
                });
            },
        )
        .setup(|app| {
            let default_root = app.path().app_local_data_dir()?;
            let paths = match paths::Paths::resolve(default_root) {
                Ok(paths) => paths,
                Err(message) => {
                    // No log or window yet: the data folder is what failed.
                    show_startup_error(&message);
                    std::process::exit(1);
                }
            };
            let webview_dir = paths.webview();
            logs::init(&paths);
            logs::info(
                "app.start",
                &[
                    ("version", env!("CARGO_PKG_VERSION")),
                    ("os", std::env::consts::OS),
                    ("arch", std::env::consts::ARCH),
                ],
            );
            let host = Arc::new(TauriHost {
                app: app.handle().clone(),
            });
            let engine = Arc::new(Engine::new(paths, host)?);
            let startup_file = project_arg(std::env::args());
            #[cfg(target_os = "macos")]
            let startup_file =
                startup_file.or_else(|| OPENED_EARLY.lock().unwrap_or_else(|e| e.into_inner()).take());
            *engine
                .startup_file
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = startup_file;
            mcp::attach(&engine);
            app.manage(engine);
            build_window(app.handle(), webview_dir)?;
            if paths::is_e2e() {
                e2e_print(app.handle());
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(SHOW_FAILSAFE);
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let engine = app.state::<Arc<Engine>>().inner().clone();
                engine.close_acknowledged.store(false, Ordering::SeqCst);
                let _ = app.emit("app://close-requested", ());
                std::thread::spawn(move || {
                    std::thread::sleep(CLOSE_FAILSAFE);
                    if !engine.close_acknowledged.load(Ordering::SeqCst) {
                        app.exit(0);
                    }
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while starting LoreCraft")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                open_from_finder(app, urls);
            }
            // Outside tools learn the app has gone from the address file disappearing.
            if let tauri::RunEvent::Exit = event {
                if let Some(engine) = app.try_state::<Arc<Engine>>() {
                    mcp::stop(&engine);
                }
            }
        });
}

#[cfg(test)]
mod navigation_tests {
    use super::*;

    fn url(text: &str) -> tauri::Url {
        tauri::Url::parse(text).unwrap()
    }

    #[test]
    fn only_the_apps_own_pages_may_load_in_a_window() {
        for own in [
            "http://tauri.localhost/",
            "http://tauri.localhost/print.html",
            "https://tauri.localhost/index.html#/wiki",
            "tauri://localhost/",
        ] {
            assert!(is_app_page(&url(own), None), "{own}");
        }
        for elsewhere in [
            "https://evil.example/",
            "http://tauri.localhost.evil.example/",
            "https://evil.example/tauri.localhost",
            // A picture or video, opened as a page.
            "http://lbasset.localhost/0195",
            "file:///C:/Users/someone/secret.txt",
            "file://attacker.example/share/x.html",
            "about:blank",
            "data:text/html,<p>Hi</p>",
            "javascript:alert(1)",
            "http://localhost:1420/",
        ] {
            assert!(!is_app_page(&url(elsewhere), None), "{elsewhere}");
        }
    }

    #[test]
    fn the_dev_server_counts_only_when_it_is_the_one_in_use() {
        let dev = url("http://localhost:1420/");
        assert!(is_app_page(&url("http://localhost:1420/index.html"), Some(&dev)));
        assert!(!is_app_page(&url("http://localhost:1421/"), Some(&dev)));
        assert!(!is_app_page(&url("https://localhost:1420/"), Some(&dev)));
        assert!(!is_app_page(&url("http://127.0.0.1:1420/"), Some(&dev)));
    }

    /// The other half of keeping lore and model output inert: no inline script, nothing
    /// fetched from the network, no frames, and no form that could send text anywhere.
    #[test]
    fn the_content_security_policy_stays_strict() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = &config["app"]["security"]["csp"];
        assert_eq!(csp["script-src"], "'self'");
        assert_eq!(csp["object-src"], "'none'");
        // Frames may show web pages, and only that: canvas web cards and YouTube embeds.
        // Each is a sandboxed iframe with no top navigation and no popups (src/canvas/cards.tsx),
        // loaded only when the writer asks. `navigation_guard` still covers the main window,
        // and WebView2 reports only main-frame navigations to it.
        assert_eq!(csp["frame-src"], "https: http:");
        assert_eq!(csp["form-action"], "'none'");
        assert_eq!(csp["base-uri"], "'none'");
        assert_eq!(csp["connect-src"], "ipc: http://ipc.localhost");
        for (directive, value) in csp.as_object().unwrap() {
            let value = value.as_str().unwrap();
            assert!(!value.contains("unsafe-eval"), "{directive}");
            if directive != "frame-src" {
                assert!(!value.contains("https:") && !value.contains('*'), "{directive}: {value}");
            }
        }
    }

    #[test]
    fn a_refused_page_is_logged_by_scheme_only() {
        let guard = navigation_guard("main", None);
        let lines = logs::capture(|| {
            assert!(!guard(&url("https://evil.example/Vaelthrix?key=sk-ant-secret")));
            assert!(guard(&url("http://tauri.localhost/")));
            // A link in the story can make up its own scheme.
            assert!(!guard(&url("ashmoor:burned")));
        });
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("window.navigation_blocked window=main scheme=https"), "{}", lines[0]);
        assert!(lines[1].contains("window.navigation_blocked window=main scheme=other"), "{}", lines[1]);
        for word in ["evil", "Vaelthrix", "secret", "ashmoor", "burned"] {
            assert!(!lines.concat().contains(word), "{lines:?}");
        }
    }
}
