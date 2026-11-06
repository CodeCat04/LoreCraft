fn main() {
    // tauri-build embeds the Windows icon, but its own change tracking misses the icon files,
    // so a new icon would not reach the program until something else changed. For a folder,
    // cargo looks at every file inside it.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
