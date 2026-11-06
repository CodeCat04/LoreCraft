//! `lorecraft.exe --mcp [--project "<path>"]`: a stdio MCP server, handled before Tauri
//! starts, so no window opens and no second binary needs packaging.
//!
//! Stdout belongs to the protocol. Nothing else may ever write to it, and stderr carries
//! any problem. A release build uses the Windows GUI subsystem, which has no console but
//! still inherits the pipes a parent process hands it, so this works there too.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use rmcp::ServiceExt;

use super::config;
use super::server::{LorebookServer, StdioBackend};
use crate::paths::Paths;

pub fn wants_mcp(args: &[OsString]) -> bool {
    args.iter().skip(1).any(|a| a == "--mcp")
}

/// The file after `--project`, or from `--project=file`.
pub fn project_from(args: &[OsString]) -> Option<PathBuf> {
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        if arg == "--project" {
            return iter.next().map(PathBuf::from);
        }
        if let Some(value) = arg.to_str().and_then(|a| a.strip_prefix("--project=")) {
            return Some(PathBuf::from(value));
        }
    }
    None
}

/// Runs until the client closes stdin. Returns the process's exit code.
pub fn run(args: &[OsString]) -> i32 {
    let root = config::default_data_root().unwrap_or_else(|| PathBuf::from("."));
    // A portable copy's MCP server reads the same `data` folder as its app.
    let paths = match Paths::resolve(root) {
        Ok(paths) => paths,
        Err(e) => {
            eprintln!("lorecraft: {e}");
            return 1;
        }
    };
    let backend = match StdioBackend::new(paths, project_from(args)) {
        Ok(backend) => Arc::new(backend),
        Err(e) => {
            eprintln!("lorecraft: {e}");
            return 1;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("lorecraft: could not start: {e}");
            return 1;
        }
    };
    let code = runtime.block_on(async {
        match LorebookServer::over_stdio(backend.clone())
            .serve(rmcp::transport::stdio())
            .await
        {
            Ok(service) => {
                let _ = service.waiting().await;
                backend.close().await;
                0
            }
            Err(e) => {
                eprintln!("lorecraft: {e}");
                1
            }
        }
    });
    // Not a normal runtime shutdown: stdin's blocking read could hold it open forever.
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        std::iter::once("lorecraft.exe")
            .chain(list.iter().copied())
            .map(OsString::from)
            .collect()
    }

    #[test]
    fn reads_the_flags_in_either_form() {
        assert!(wants_mcp(&args(&["--mcp"])));
        assert!(!wants_mcp(&args(&["book.lorecraft"])));
        assert!(!wants_mcp(&[OsString::from("--mcp")]));
        assert_eq!(project_from(&args(&["--mcp"])), None);
        assert_eq!(
            project_from(&args(&["--mcp", "--project", "C:\\a b\\c.lorecraft"])),
            Some(PathBuf::from("C:\\a b\\c.lorecraft"))
        );
        assert_eq!(
            project_from(&args(&["--project=c.lorecraft", "--mcp"])),
            Some(PathBuf::from("c.lorecraft"))
        );
    }
}
