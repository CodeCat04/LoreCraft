use std::path::{Path, PathBuf};

/// Everything LoreCraft stores outside the user's project files.
#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
    /// True when the data sits in a `data` folder beside a portable copy of the program.
    pub portable: bool,
}

/// The file beside the program that turns on portable mode.
pub const PORTABLE_MARKER: &str = "portable";
/// The folder beside the program that holds a portable copy's data.
pub const PORTABLE_DATA: &str = "data";

impl Paths {
    /// Where the data goes, in this order: `LORECRAFT_DATA_DIR` (so tests stay isolated),
    /// then a `data` folder beside the program when a `portable` file sits there, then the
    /// OS default. A portable data folder that cannot be written is an error, never a
    /// silent move to AppData.
    pub fn resolve(default_root: PathBuf) -> Result<Self, String> {
        Self::choose(
            std::env::var_os("LORECRAFT_DATA_DIR").map(PathBuf::from),
            exe_dir().as_deref(),
            default_root,
        )
    }

    pub fn choose(
        env_dir: Option<PathBuf>,
        exe_dir: Option<&Path>,
        default_root: PathBuf,
    ) -> Result<Self, String> {
        if let Some(root) = env_dir {
            return Ok(Self { root, portable: false });
        }
        if let Some(dir) = exe_dir.filter(|dir| dir.join(PORTABLE_MARKER).is_file()) {
            let root = dir.join(PORTABLE_DATA);
            check_writable(&root).map_err(|error| unwritable_message(&root, &error))?;
            return Ok(Self { root, portable: true });
        }
        Ok(Self { root: default_root, portable: false })
    }

    pub fn at(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            portable: false,
        }
    }

    /// WebView2's own files. Set only for a portable copy, so an installed one keeps the
    /// default place.
    pub fn webview(&self) -> Option<PathBuf> {
        self.portable.then(|| self.root.join("webview"))
    }

    pub fn sessions(&self) -> PathBuf {
        self.root.join("sessions")
    }

    pub fn backups(&self) -> PathBuf {
        self.root.join("backups")
    }

    pub fn settings_file(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

fn check_writable(root: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    let probe = root.join(".write-test");
    std::fs::write(&probe, b"ok")?;
    std::fs::remove_file(&probe)
}

fn unwritable_message(root: &Path, error: &std::io::Error) -> String {
    format!(
        "LoreCraft is set up to run portable, but it cannot write to its data folder:\n{}\n\n({error})\n\n\
         Move the LoreCraft folder somewhere you can write to, such as Documents or a USB drive \
         that is not locked. Or delete the file named \"portable\" beside lorecraft.exe to keep \
         the data in your user profile instead.",
        root.display()
    )
}

/// True when this process runs under the end-to-end test harness. The harness always gives
/// the app a data folder of its own, so the test hooks (a plain-text key file among them)
/// never apply to a writer's real data, even if `LORECRAFT_E2E` is left set by mistake.
/// The portable test runs a throwaway unzipped copy without that override, and says so
/// with a second variable.
pub fn is_e2e() -> bool {
    std::env::var_os("LORECRAFT_E2E").is_some()
        && (std::env::var_os("LORECRAFT_DATA_DIR").is_some()
            || std::env::var_os("LORECRAFT_E2E_PORTABLE").is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::TestDir;

    fn appdata(dir: &TestDir) -> PathBuf {
        dir.0.join("appdata")
    }

    #[test]
    fn without_the_marker_the_os_default_is_used() {
        let dir = TestDir::new();
        let paths = Paths::choose(None, Some(&dir.0), appdata(&dir)).unwrap();
        assert_eq!(paths.root, appdata(&dir));
        assert!(!paths.portable);
        assert_eq!(paths.webview(), None);
        assert!(!dir.0.join("data").exists());
    }

    #[test]
    fn the_marker_keeps_everything_beside_the_program() {
        let dir = TestDir::new();
        std::fs::write(dir.0.join("portable"), "").unwrap();
        let paths = Paths::choose(None, Some(&dir.0), appdata(&dir)).unwrap();
        assert!(paths.portable);
        assert_eq!(paths.root, dir.0.join("data"));
        assert!(paths.root.is_dir());
        assert!(!paths.root.join(".write-test").exists(), "the probe is cleaned up");
        for inside in [
            paths.sessions(),
            paths.backups(),
            paths.settings_file(),
            paths.logs(),
            paths.webview().unwrap(),
        ] {
            assert!(inside.starts_with(dir.0.join("data")), "{}", inside.display());
        }
        assert!(!appdata(&dir).exists());
    }

    #[test]
    fn a_folder_named_portable_is_not_the_marker() {
        let dir = TestDir::new();
        std::fs::create_dir(dir.0.join("portable")).unwrap();
        let paths = Paths::choose(None, Some(&dir.0), appdata(&dir)).unwrap();
        assert!(!paths.portable);
    }

    #[test]
    fn the_environment_wins_over_the_marker() {
        let dir = TestDir::new();
        std::fs::write(dir.0.join("portable"), "").unwrap();
        let paths = Paths::choose(Some(dir.0.join("env")), Some(&dir.0), appdata(&dir)).unwrap();
        assert_eq!(paths.root, dir.0.join("env"));
        assert!(!paths.portable);
        assert!(!dir.0.join("data").exists());
    }

    #[test]
    fn an_unwritable_portable_folder_is_an_error_not_a_fallback() {
        let dir = TestDir::new();
        std::fs::write(dir.0.join("portable"), "").unwrap();
        // A file where the data folder should be cannot be written into, like a locked drive.
        std::fs::write(dir.0.join("data"), "in the way").unwrap();
        let error = Paths::choose(None, Some(&dir.0), appdata(&dir)).unwrap_err();
        assert!(error.contains("cannot write"), "{error}");
        assert!(error.contains(&*dir.0.join("data").to_string_lossy()), "{error}");
        assert!(!appdata(&dir).exists());
    }
}
