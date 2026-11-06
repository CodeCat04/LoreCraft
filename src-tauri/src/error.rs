use serde::Serialize;

pub type AppResult<T> = Result<T, AppError>;

/// An error the UI can act on. `code` is stable, `message` is for people.
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    /// Bad parameters from the caller.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID", message)
    }

    pub fn not_found(what: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", format!("{} was not found.", what.into()))
    }

    pub fn no_project() -> Self {
        Self::new("NO_PROJECT", "No project is open.")
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message)
    }
}

// ---- Saving and recovery ------------------------------------------------------
// Errors from `session.rs` that tell the writer what happened to their file, and what to do.
impl AppError {
    /// The file to save over is marked read-only, so nothing can replace it.
    pub fn read_only(path: &std::path::Path) -> Self {
        Self::new(
            "READ_ONLY",
            format!(
                "{} is read-only, so LoreCraft cannot save over it. Your work is safe in LoreCraft. Use Save As to save it under another name, or clear Read-only in the file's properties and save again.",
                path.display()
            ),
        )
    }

    /// The final step of a save could not replace the file, but the new version was written
    /// and checked, and is kept at `kept`.
    pub fn save_kept_copy(target: &std::path::Path, kept: &std::path::Path, error: &std::io::Error) -> Self {
        Self::new(
            "SAVE_FAILED",
            format!(
                "Could not replace {}: {error}. Another program, such as OneDrive or antivirus, may be using it. LoreCraft saved a complete copy of your project as {}. Your work is also still safe in LoreCraft, so you can try saving again or use Save As.",
                target.display(),
                kept.display()
            ),
        )
    }
}

// ---- Opening and upgrading a project file -----------------------------------
// Each reason a file cannot open has its own code, so its message can say what to do.
// `name` is the file's name. See `db::validate_project_file` and `db::migrate`.
impl AppError {
    pub fn path_too_long(name: &str) -> Self {
        Self::new(
            "PATH_TOO_LONG",
            format!("The folder path of {name} is too long for Windows. Move the file to a folder with a shorter path, then try again."),
        )
    }

    pub fn file_locked(name: &str) -> Self {
        Self::new(
            "FILE_LOCKED",
            format!("{name} is in use by another program, such as antivirus or OneDrive. Wait a moment, then try again."),
        )
    }

    pub fn online_only(name: &str) -> Self {
        Self::new(
            "ONLINE_ONLY",
            format!("{name} is stored online only, and it could not be downloaded. Check that OneDrive is running and you are online, then try again."),
        )
    }

    pub fn no_permission(name: &str) -> Self {
        Self::new(
            "NO_PERMISSION",
            format!("LoreCraft is not allowed to read {name}. Check the file's permissions, then try again."),
        )
    }

    pub fn cannot_read(name: &str, reason: &str) -> Self {
        Self::new("CANNOT_READ", format!("LoreCraft could not read {name}: {reason}"))
    }

    pub fn damaged(name: &str) -> Self {
        Self::new(
            "CORRUPT",
            format!("{name} is damaged, so LoreCraft can't open it. An earlier save may be in Backups."),
        )
    }

    pub fn not_a_project(name: &str) -> Self {
        Self::new("NOT_A_PROJECT", format!("{name} is not a LoreCraft project."))
    }

    /// The file's minimum reader version is newer than this app.
    pub fn too_new(saved_by: Option<&str>, needed: &str) -> Self {
        let message = match saved_by {
            Some(by) => format!("This project was saved by LoreCraft {by}, which added things this version can't read. Update LoreCraft to {needed} or later to open it."),
            None => format!("This project needs LoreCraft {needed} or later, which added things this version can't read. Update LoreCraft to open it."),
        };
        Self::new("TOO_NEW", message)
    }

    /// The file's schema is newer than this app's.
    pub fn too_new_schema(saved_by: Option<&str>) -> Self {
        let message = match saved_by {
            Some(by) => format!("This project was saved by LoreCraft {by}, a newer version than this one. Update LoreCraft to open it."),
            None => "This project was saved by a newer version of LoreCraft. Update LoreCraft to open it.".to_string(),
        };
        Self::new("TOO_NEW", message)
    }

    /// An upgrade to this version's format failed and was rolled back.
    pub fn upgrade_failed() -> Self {
        Self::new(
            "UPGRADE_FAILED",
            "LoreCraft could not upgrade this project to the current version, so it did not open it. The file has not changed.",
        )
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new("DATABASE", e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::new("IO", e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::new("JSON", e.to_string())
    }
}
