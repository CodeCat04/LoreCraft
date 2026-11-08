//! The MCP server, which lets AI tools outside the app read the lore and the book and
//! propose changes. See docs/MCP.md.
//!
//! `areas` declares every tool. `tools` and `text` read a project through any
//! `&Connection`, `write` is the one path a change takes, `suggest` stores it, `limits` holds
//! what no tool may do, `server` speaks the protocol, `http` listens inside the app, and `cli`
//! is `lorecraft.exe --mcp` over stdio.

pub mod areas;
pub mod cli;
pub mod config;
pub mod http;
pub mod limits;
pub mod server;
pub mod suggest;
pub mod text;
pub mod tools;
pub mod write;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::db;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::paths::Paths;
use config::{Discovery, McpSettings, PERMISSION_EDIT, PERMISSION_READ, PERMISSION_SUGGEST};

/// Enough to answer "what has it been doing". It is kept in memory only.
const ACTIVITY_KEPT: usize = 100;
/// A client with no open session stays on the list for this long after its last call.
const CLIENT_FORGOTTEN_AFTER: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientEntry {
    pub name: String,
    pub version: String,
    pub connected: bool,
    pub first_seen: String,
    pub last_seen: String,
    #[serde(skip)]
    open_sessions: u32,
    #[serde(skip)]
    seen: Option<Instant>,
}

/// One tool call. It holds names only: never arguments, never results, never any text
/// from the project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub at: String,
    pub client: String,
    pub tool: String,
    pub ok: bool,
}

/// The MCP side of the engine.
pub struct McpState {
    engine: Mutex<Weak<Engine>>,
    settings: Mutex<McpSettings>,
    running: Mutex<Option<http::Running>>,
    clients: Mutex<Vec<ClientEntry>>,
    activity: Mutex<VecDeque<ActivityEntry>>,
    error: Mutex<Option<String>>,
}

fn relock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl McpState {
    pub fn new(paths: &Paths) -> Self {
        Self {
            engine: Mutex::new(Weak::new()),
            settings: Mutex::new(config::load(paths)),
            running: Mutex::new(None),
            clients: Mutex::new(Vec::new()),
            activity: Mutex::new(VecDeque::new()),
            error: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> McpSettings {
        relock(&self.settings).clone()
    }

    pub fn port(&self) -> Option<u16> {
        relock(&self.running).as_ref().map(|r| r.port)
    }

    pub fn record_error(&self, message: String) {
        *relock(&self.error) = Some(message);
    }

    pub fn client_opened(&self, name: &str, version: &str) {
        let now = db::now();
        let mut clients = relock(&self.clients);
        if let Some(entry) = clients
            .iter_mut()
            .find(|c| c.name == name && c.version == version)
        {
            entry.open_sessions += 1;
            entry.connected = true;
            entry.last_seen = now;
            entry.seen = Some(Instant::now());
        } else {
            clients.push(ClientEntry {
                name: name.to_string(),
                version: version.to_string(),
                connected: true,
                first_seen: now.clone(),
                last_seen: now,
                open_sessions: 1,
                seen: Some(Instant::now()),
            });
        }
    }

    pub fn client_closed(&self, name: &str, version: &str) {
        let mut clients = relock(&self.clients);
        if let Some(entry) = clients
            .iter_mut()
            .find(|c| c.name == name && c.version == version)
        {
            entry.open_sessions = entry.open_sessions.saturating_sub(1);
            entry.connected = entry.open_sessions > 0;
        }
    }

    fn log_call(&self, client: &str, tool: &str, ok: bool) {
        let now = db::now();
        {
            let mut clients = relock(&self.clients);
            if let Some(entry) = clients.iter_mut().find(|c| c.name == client) {
                entry.last_seen = now.clone();
                entry.seen = Some(Instant::now());
            }
        }
        let mut activity = relock(&self.activity);
        activity.push_front(ActivityEntry {
            at: now,
            client: client.to_string(),
            tool: tool.to_string(),
            ok,
        });
        activity.truncate(ACTIVITY_KEPT);
    }

    fn current_clients(&self) -> Vec<ClientEntry> {
        let mut clients = relock(&self.clients);
        clients.retain(|c| {
            c.open_sessions > 0 || c.seen.is_some_and(|at| at.elapsed() < CLIENT_FORGOTTEN_AFTER)
        });
        clients.clone()
    }

    fn activity(&self) -> Vec<ActivityEntry> {
        relock(&self.activity).iter().cloned().collect()
    }
}

/// Gives the MCP side a way back to its engine and starts it if the writer has it on.
pub fn attach(engine: &Arc<Engine>) {
    *relock(&engine.mcp.engine) = Arc::downgrade(engine);
    sync(engine);
}

/// Stops listening and removes the address. Runs when the app exits.
pub fn stop(engine: &Engine) {
    let running = relock(&engine.mcp.running).take();
    config::remove_discovery(&engine.paths);
    if let Some(running) = running {
        running.stop();
    }
}

/// Makes what is running match the setting.
fn sync(engine: &Engine) {
    let settings = engine.mcp.settings();
    if !settings.enabled {
        stop(engine);
        return;
    }
    let mut running = relock(&engine.mcp.running);
    if running.is_some() {
        return;
    }
    let Some(strong) = relock(&engine.mcp.engine).upgrade() else {
        return;
    };
    *relock(&engine.mcp.error) = None;
    match http::start(strong, settings.port) {
        Ok(server) => {
            let port = server.port;
            *running = Some(server);
            drop(running);
            announce(engine, port, &settings.token);
            if settings.port != port {
                let _ = remember_port(engine, port);
            }
        }
        Err(e) => engine.mcp.record_error(e.message),
    }
}

fn announce(engine: &Engine, port: u16, token: &str) {
    let written = config::write_discovery(
        &engine.paths,
        &Discovery {
            port,
            token: token.to_string(),
            pid: std::process::id(),
        },
    );
    if let Err(e) = written {
        engine
            .mcp
            .record_error(format!("Could not write mcp.json: {}", e.message));
    }
}

fn remember_port(engine: &Engine, port: u16) -> AppResult<()> {
    let mut settings = relock(&engine.mcp.settings);
    settings.port = port;
    config::store(&engine.paths, &settings)
}

/// Applies a change from the Settings tab.
pub fn update(
    engine: &Engine,
    enabled: Option<bool>,
    permission: Option<String>,
    share_local_only: Option<bool>,
) -> AppResult<()> {
    {
        let mut settings = relock(&engine.mcp.settings);
        if let Some(enabled) = enabled {
            settings.enabled = enabled;
            if enabled && settings.token.is_empty() {
                settings.token = config::new_token()?;
            }
        }
        if let Some(permission) = permission {
            if ![PERMISSION_READ, PERMISSION_SUGGEST, PERMISSION_EDIT].contains(&permission.as_str()) {
                return Err(AppError::invalid("Permission must be read, suggest or edit."));
            }
            settings.permission = permission;
        }
        if let Some(share) = share_local_only {
            settings.share_local_only = share;
        }
        config::store(&engine.paths, &settings)?;
    }
    sync(engine);
    Ok(())
}

/// Replaces the token. Clients using the old one are refused from their next request.
pub fn rotate_token(engine: &Engine) -> AppResult<()> {
    let token = config::new_token()?;
    {
        let mut settings = relock(&engine.mcp.settings);
        settings.token = token.clone();
        config::store(&engine.paths, &settings)?;
    }
    if let Some(port) = engine.mcp.port() {
        announce(engine, port, &token);
    }
    Ok(())
}

/// Reads the live project on behalf of a client.
pub fn read_live<T>(
    engine: &Engine,
    f: impl FnOnce(&tools::Ctx) -> AppResult<T>,
) -> AppResult<T> {
    let settings = engine.mcp.settings();
    let name = engine.status().name;
    engine
        .read(|conn| {
            let mut ctx = tools::Ctx::new(conn, name, true, settings.share_local_only)?;
            ctx.permission = Some(settings.permission.clone());
            f(&ctx)
        })
        .map_err(|e| {
            if e.code == "NO_PROJECT" {
                AppError::new(
                    "NO_PROJECT",
                    "LoreCraft is running but has no project open. Open one there and try again.",
                )
            } else {
                e
            }
        })
}

/// One tool call from a client inside the app.
pub fn call_live(engine: &Engine, client: &str, name: &str, args: &Value) -> AppResult<String> {
    let outcome = (|| {
        if tools::is_suggestion(name) {
            let settings = engine.mcp.settings();
            if settings.permission == PERMISSION_READ {
                return Err(AppError::new("READ_ONLY", suggest::READ_ONLY));
            }
            suggest::call_as(
                engine,
                client,
                name,
                args,
                settings.share_local_only,
                &settings.permission,
                write::Waits::default(),
            ).map_err(|e| {
                if e.code == "NO_PROJECT" {
                    AppError::new(
                        "NO_PROJECT",
                        "LoreCraft is running but has no project open. Open one there and try again.",
                    )
                } else {
                    e
                }
            })
        } else {
            read_live(engine, |ctx| tools::call(ctx, name, args))
        }
    })();
    engine.mcp.log_call(client, name, outcome.is_ok());
    engine.notify("mcp");
    outcome
}

/// What the Settings tab shows. It holds the token because the tab offers it to copy.
pub fn status(engine: &Engine) -> Value {
    let settings = engine.mcp.settings();
    let port = engine.mcp.port();
    let project = engine.status();
    serde_json::json!({
        "enabled": settings.enabled,
        "running": port.is_some(),
        "port": port,
        "url": port.map(|p| format!("http://127.0.0.1:{p}/mcp")),
        "token": settings.token,
        "permission": settings.permission,
        "shareLocalOnly": settings.share_local_only,
        "exePath": std::env::current_exe().ok(),
        "projectPath": project.path,
        "projectName": project.name,
        "projectOpen": project.open,
        "clients": engine.mcp.current_clients(),
        "activity": engine.mcp.activity(),
        "error": relock(&engine.mcp.error).clone(),
    })
}
