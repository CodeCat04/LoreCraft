//! What no outside tool may do, at any permission level. Checked here in Rust, before
//! anything is stored, so a tool added later cannot get round them by mistake:
//!
//! - change MCP permissions or settings, AI providers or keys, spending limits, or which
//!   pages and scenes are local only;
//! - delete the project, or write a file outside it;
//! - read or change local-only content unless the writer shares it (see `tools::Ctx`);
//! - leave more than `suggest::MAX_PENDING` waiting (see `suggest::insert`).
//!
//! MCP settings live outside the project in `mcp-settings.json`, AI providers and keys in
//! the app settings and the OS keyring, and no tool has a way to reach either. These checks
//! cover what a tool's arguments and drafts could still name.

use serde_json::Value;

use super::write::Draft;
use crate::error::{AppError, AppResult};

pub const REFUSED: &str = "Outside tools cannot change that. LoreCraft keeps permissions, AI providers and keys, spending limits and local-only settings for the writer alone, and never lets a tool delete the project or write outside it.";

/// Keys that name a protected setting, in arguments or a draft's payload.
const FORBIDDEN_KEYS: &[&str] = &[
    "local_only",
    "localOnly",
    "share_local_only",
    "shareLocalOnly",
    "permission",
    "token",
    "api_key",
    "apiKey",
    "provider",
    "providers",
    "spending",
    "spending_limit",
    "spendingLimit",
    "limits",
];

/// Project meta that belongs to the writer's settings. A tool that writes meta must check
/// its key with `check_meta_key`.
const PROTECTED_META: &[&str] = &["ai", "mcp", "limits", "spending", "providers", "keys", "privacy", "localOnly"];

/// Kinds that would remove or move the project itself.
const FORBIDDEN_KINDS: &[&str] = &["deleteProject", "moveProject", "saveAs", "settings", "mcpSettings", "aiSettings"];

fn refused() -> AppError {
    AppError::new("NOT_ALLOWED", REFUSED)
}

fn has_forbidden_key(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.keys().any(|k| FORBIDDEN_KEYS.contains(&k.as_str())))
}

/// A tool's arguments, before its handler runs.
pub fn check_args(args: &Value) -> AppResult<()> {
    if has_forbidden_key(args) {
        return Err(refused());
    }
    Ok(())
}

/// A draft, before it is stored.
pub fn check_draft(draft: &Draft) -> AppResult<()> {
    if FORBIDDEN_KINDS.contains(&draft.kind) {
        return Err(refused());
    }
    if has_forbidden_key(&draft.payload) || has_forbidden_key(&draft.payload["changes"]) {
        return Err(refused());
    }
    if let Some(key) = draft.payload["metaKey"].as_str() {
        check_meta_key(key)?;
    }
    for name in ["path", "file", "filePath", "folder"] {
        if let Some(path) = draft.payload[name].as_str() {
            check_project_path(path)?;
        }
    }
    Ok(())
}

/// A project meta key a tool wants to write.
pub fn check_meta_key(key: &str) -> AppResult<()> {
    let head = key.split(['.', ':', '/']).next().unwrap_or("");
    if key.trim().is_empty() || PROTECTED_META.iter().any(|p| head.eq_ignore_ascii_case(p)) {
        return Err(refused());
    }
    Ok(())
}

/// A path inside the project's own storage: relative, and never climbing out.
pub fn check_project_path(path: &str) -> AppResult<()> {
    let p = path.replace('\\', "/");
    let absolute = p.starts_with('/') || p.chars().nth(1) == Some(':') || p.starts_with("//");
    if p.trim().is_empty() || absolute || p.split('/').any(|part| part == "..") {
        return Err(refused());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn protected_settings_paths_and_kinds_are_refused() {
        assert!(check_args(&json!({ "title": "x" })).is_ok());
        for key in ["local_only", "localOnly", "permission", "api_key", "provider", "spending_limit"] {
            assert_eq!(check_args(&json!({ key: true })).unwrap_err().code, "NOT_ALLOWED", "{key}");
        }
        let draft = |kind, payload| Draft::new(kind, "x", payload);
        assert!(check_draft(&draft("styleGuide", json!({ "changes": { "voice": "Wry." } }))).is_ok());
        assert!(check_draft(&draft("sceneDetails", json!({ "changes": { "localOnly": true } }))).is_err());
        assert!(check_draft(&draft("deleteProject", json!({}))).is_err());
        assert!(check_draft(&draft("meta", json!({ "metaKey": "mcp.permission" }))).is_err());
        assert!(check_draft(&draft("meta", json!({ "metaKey": "ai.providers" }))).is_err());
        assert!(check_draft(&draft("meta", json!({ "metaKey": "writingStyles.guide" }))).is_ok());
        for path in ["C:\\Windows\\x", "/etc/passwd", "../outside.txt", "media/../../x", "\\\\server\\share"] {
            assert!(check_project_path(path).is_err(), "{path}");
            assert!(check_draft(&draft("media", json!({ "path": path }))).is_err(), "{path}");
        }
        assert!(check_project_path("media/map.png").is_ok());
    }
}
