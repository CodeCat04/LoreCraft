// Keeps a console window from opening on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--mcp` is a command-line server for AI tools. It runs instead of the app.
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if lorecraft_lib::mcp::cli::wants_mcp(&args) {
        std::process::exit(lorecraft_lib::mcp::cli::run(&args));
    }
    lorecraft_lib::run();
}
