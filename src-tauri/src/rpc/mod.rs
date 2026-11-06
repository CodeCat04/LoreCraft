//! The single entry point for the UI. Each namespace is one module.

pub mod ai;
pub mod app;
pub mod canvas;
pub mod comments;
pub mod consistency;
pub mod embeddings;
pub mod extras;
pub mod family;
pub mod files;
pub mod ideas;
pub mod import;
pub mod manuscript;
pub mod mcp;
pub mod media;
pub mod pages;
pub mod print;
pub mod print_stamp;
#[cfg(target_os = "linux")]
pub mod print_linux;
pub mod project;
pub mod revisions;
pub mod search;
pub mod settings;
pub mod snapshot;
pub mod summaries;

use std::collections::HashSet;
use std::sync::Mutex;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::paths;

/// Methods that fail as if the disk were full, for end-to-end tests of what the UI does
/// when a write fails. Only `app.e2eFailWrites` fills it, and only under the E2E flag.
static FAILING_METHODS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// The E2E switch: `{ "methods": ["pages.update"] }` makes those calls fail, `[]` ends it.
fn e2e_fail_writes(enabled: bool, method: &str, params: &Value) -> Option<AppResult<Value>> {
    if !enabled {
        return None;
    }
    let mut failing = FAILING_METHODS.lock().unwrap_or_else(|e| e.into_inner());
    if method == "app.e2eFailWrites" {
        let methods: HashSet<String> = params
            .get("methods")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(|m| m.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        *failing = (!methods.is_empty()).then_some(methods);
        return Some(Ok(Value::Null));
    }
    if failing.as_ref().is_some_and(|set| set.contains(method)) {
        return Some(Err(AppError::new(
            "WRITE_FAILED",
            "There is not enough space on the disk.",
        )));
    }
    None
}

pub fn dispatch(engine: &Engine, method: &str, params: Value) -> AppResult<Value> {
    if let Some(answer) = e2e_fail_writes(paths::is_e2e(), method, &params) {
        return answer;
    }
    let (namespace, action) = method
        .split_once('.')
        .ok_or_else(|| AppError::invalid(format!("Malformed method: {method}")))?;
    match namespace {
        "app" => app::handle(engine, action, params),
        "project" => project::handle(engine, action, params),
        "settings" => settings::handle(engine, action, params),
        "files" => files::handle(engine, action, params),
        "pages" => pages::handle(engine, action, params),
        "books" => manuscript::handle_books(engine, action, params),
        "nodes" => manuscript::handle_nodes(engine, action, params),
        "threads" => manuscript::handle_threads(engine, action, params),
        "search" => search::handle(engine, action, params),
        "revisions" => revisions::handle(engine, action, params),
        "snapshot" => snapshot::handle(engine, action, params),
        "import" => import::handle(engine, action, params),
        "print" => print::handle(engine, action, params),
        "ai" => ai::handle(engine, action, params),
        "summaries" => summaries::handle(engine, action, params),
        "comments" => comments::handle(engine, action, params),
        "consistency" => consistency::handle(engine, action, params),
        "embeddings" => embeddings::handle(engine, action, params),
        "extras" => extras::handle(engine, action, params),
        "mcp" => mcp::handle(engine, action, params),
        "ideas" => ideas::handle(engine, action, params),
        "media" => media::handle(engine, action, params),
        "canvases" => canvas::handle(engine, action, params),
        _ => Err(unknown(method)),
    }
}

/// Reads typed params. `null` is accepted for handlers whose fields all default.
pub fn parse<T: DeserializeOwned>(params: Value) -> AppResult<T> {
    let params = if params.is_null() {
        Value::Object(Default::default())
    } else {
        params
    };
    serde_json::from_value(params).map_err(|e| AppError::invalid(e.to_string()))
}

pub fn ok<T: Serialize>(value: T) -> AppResult<Value> {
    Ok(serde_json::to_value(value)?)
}

pub fn unknown(method: &str) -> AppError {
    AppError::new("UNKNOWN_METHOD", format!("Unknown method: {method}"))
}

/// Builds params for tests from `json!`.
#[cfg(test)]
pub fn call(engine: &Engine, method: &str, params: Value) -> Value {
    dispatch(engine, method, params).unwrap_or_else(|e| panic!("{method} failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_write_failure_switch_works_only_under_the_e2e_flag() {
        // Outside E2E the switch is an unknown method like any other, and fails nothing.
        assert!(e2e_fail_writes(false, "app.e2eFailWrites", &json!({ "methods": ["pages.update"] })).is_none());
        assert!(e2e_fail_writes(false, "pages.update", &json!({})).is_none());

        assert!(matches!(
            e2e_fail_writes(true, "app.e2eFailWrites", &json!({ "methods": ["pages.update"] })),
            Some(Ok(_))
        ));
        let failed = e2e_fail_writes(true, "pages.update", &json!({}));
        assert!(matches!(failed, Some(Err(ref e)) if e.code == "WRITE_FAILED"));
        // Other methods carry on.
        assert!(e2e_fail_writes(true, "pages.get", &json!({})).is_none());

        assert!(matches!(e2e_fail_writes(true, "app.e2eFailWrites", &json!({ "methods": [] })), Some(Ok(_))));
        assert!(e2e_fail_writes(true, "pages.update", &json!({})).is_none());
    }
}
