//! What the MCP server keeps in the data folder, apart from the app's other settings so
//! the token never reaches the UI at startup.
//!
//! - `mcp-settings.json`: on or off, permission level, local-only sharing, port and token.
//! - `mcp.json`: where the running app listens. It exists only while the app serves, and a
//!   crash can leave it behind, so a reader treats it as stale if nothing answers.
//!
//! Both are readable only by the user where the OS allows it. On Windows the data folder
//! is inside the user's profile, whose permissions already keep other users out.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db;
use crate::error::AppResult;
use crate::paths::Paths;

/// Tauri's bundle identifier, which names the data folder. A test checks it against
/// `tauri.conf.json`, because the `--mcp` path runs without Tauri.
pub const APP_IDENTIFIER: &str = "com.codecat04.lorecraft";

pub const PERMISSION_READ: &str = "read";
pub const PERMISSION_SUGGEST: &str = "suggest";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpSettings {
    pub enabled: bool,
    /// `read` or `suggest`.
    pub permission: String,
    /// Shows pages and scenes marked local only to outside tools.
    pub share_local_only: bool,
    pub token: String,
    /// The port to ask for. Kept so a client's saved address goes on working.
    pub port: u16,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            permission: PERMISSION_SUGGEST.to_string(),
            share_local_only: false,
            token: String::new(),
            port: 0,
        }
    }
}

/// The running app's address, for the stdio bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

/// The folder the app itself uses, worked out without Tauri running.
pub fn default_data_root() -> Option<PathBuf> {
    Some(dirs::data_local_dir()?.join(APP_IDENTIFIER))
}

fn settings_path(paths: &Paths) -> PathBuf {
    paths.root.join("mcp-settings.json")
}

fn discovery_path(paths: &Paths) -> PathBuf {
    paths.root.join("mcp.json")
}

/// Anything unreadable counts as never turned on.
pub fn load(paths: &Paths) -> McpSettings {
    fs::read(settings_path(paths))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn store(paths: &Paths, settings: &McpSettings) -> AppResult<()> {
    write_private(&settings_path(paths), &serde_json::to_vec_pretty(settings)?)
}

pub fn write_discovery(paths: &Paths, discovery: &Discovery) -> AppResult<()> {
    write_private(&discovery_path(paths), &serde_json::to_vec_pretty(discovery)?)
}

pub fn read_discovery(paths: &Paths) -> Option<Discovery> {
    serde_json::from_slice(&fs::read(discovery_path(paths)).ok()?).ok()
}

pub fn remove_discovery(paths: &Paths) {
    let _ = fs::remove_file(discovery_path(paths));
}

/// Written whole, so a reader never sees half a file, and private from the first byte.
fn write_private(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", db::new_id()));
    let result = (|| -> AppResult<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 256 random bits from the OS, as text that is safe in a header.
pub fn new_token() -> AppResult<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|e| crate::error::AppError::internal(format!("No random numbers: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Compares two secrets in time that does not depend on where they first differ.
pub fn same_secret(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |diff, (x, y)| diff | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_identifier_matches_the_app_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APP_IDENTIFIER);
    }

    #[test]
    fn it_starts_off_and_a_damaged_file_stays_off() {
        let dir = crate::engine::TestDir::new();
        let paths = Paths::at(&dir.0);
        assert!(!load(&paths).enabled);
        fs::write(settings_path(&paths), b"{ not json").unwrap();
        assert!(!load(&paths).enabled);
        assert_eq!(load(&paths).permission, PERMISSION_SUGGEST);
    }

    #[test]
    fn settings_round_trip_and_tokens_differ() {
        let dir = crate::engine::TestDir::new();
        let paths = Paths::at(&dir.0);
        let token = new_token().unwrap();
        assert_eq!(token.len(), 64);
        assert_ne!(token, new_token().unwrap());
        store(
            &paths,
            &McpSettings {
                enabled: true,
                token: token.clone(),
                ..Default::default()
            },
        )
        .unwrap();
        let back = load(&paths);
        assert!(back.enabled);
        assert_eq!(back.token, token);
    }

    #[test]
    fn secrets_compare_exactly() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "abcd"));
        assert!(!same_secret("", "a"));
    }
}
